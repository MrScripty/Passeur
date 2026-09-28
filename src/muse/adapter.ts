import { MuseClient, readSessionDurability, spawnMspConnection, type ApprovalDecisionInput, type MuseClientSpawnOptions, type TurnOutcome } from "@muse-code/sdk";
import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as observeAgain } from "node:timers/promises";
import { BridgeError, errorInfo, safeText } from "../core/errors.js";
import { settlesWithin, throwIfAborted, withAbort } from "../core/async.js";
import { parseWorkerMessage, finalReport } from "../agents/report.js";
import { peerOperationResultPrompt, peerProposalCorrectionPrompt, peerProposalRejection, peerSupersededPrompt, peerDeliveryPrompt, MAX_MUSE_PEER_DELIVERY_PROMPT_BYTES } from "../agents/report-format.js";
import type { WorkerAdapter, WorkerRun } from "../agents/types.js";
import type { PeerDeliveryEnvelope } from "../contracts/peer-delivery.js";
import type { MuseOptions } from "./config.js";
export type ClientStartup = {
  ready: Promise<MuseClient>; close: () => Promise<unknown>;
  /** The production starter observes host exit and connection closure independently of a turn. */
  failure?: Promise<never>;
};
export type ClientStarter = (options: MuseClientSpawnOptions) => ClientStartup;
function startOwnedClient(options: MuseClientSpawnOptions): ClientStartup {
  const handshake = spawnMspConnection({ command: options.museBin,
    ...(options.args ? { args: options.args } : {}), ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: options.env } : {}), ...(options.onStderr ? { onStderr: options.onStderr } : {}),
    ...(options.shutdownTimeoutMs === undefined ? {} : { shutdownTimeoutMs: options.shutdownTimeoutMs }),
  });
  let failed!: (error: unknown) => void;
  const failure = new Promise<never>((_resolve, reject) => { failed = reject; });
  failure.catch(() => undefined);
  const ready = handshake.initialize({ clientInfo: options.clientInfo, ...(options.capabilities ? { capabilities: options.capabilities } : {}) })
    .then((spawned) => {
      const client = new MuseClient(spawned.connection, { durability: readSessionDurability(spawned.initializeResult), host: spawned });
      // These are documented SDK lifecycle observations, not an inactivity heuristic.
      // A successful close/exit is still unexpected while an assignment owns this host.
      void client.exit.then(() => failed(new BridgeError("MUSE_HOST_EXITED", "The owned Muse host exited")),
        () => failed(new BridgeError("MUSE_HOST_EXIT_UNKNOWN", "Muse host exit observation failed")));
      void spawned.connection.closed.then(() => failed(new BridgeError("MUSE_CONNECTION_CLOSED", "Muse communication ended; descendant state is not inferred")),
        () => failed(new BridgeError("MUSE_CONNECTION_FAILED", "Muse communication failed; descendant state is not inferred")));
      return client;
    });
  ready.catch(() => undefined);
  return { ready, failure, close: () => handshake.close() };
}
function childEnvironment(): NodeJS.ProcessEnv {
  const allow = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "TMPDIR", "TERM"];
  return Object.fromEntries(allow.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]])) as NodeJS.ProcessEnv;
}
function outcomeStatus(outcome: TurnOutcome): WorkerRun["status"] {
  if (outcome.kind === "terminalUnknown") return "interrupted";
  if (outcome.kind === "unqueued") return "cancelled";
  if (outcome.params.terminal === "completed") return "completed";
  if (outcome.params.terminal === "cancelled") return "cancelled";
  return outcome.params.error?.kind === "authRequired" ? "blocked" : "failed";
}
function cancelledRun(signal: AbortSignal, workerStop: WorkerRun["worker_stop"]): WorkerRun {
  return { status: "cancelled",
    summary: "Task explicitly cancelled", worker_assessment: "unknown", blockers: [], questions: [], checks: [], worker_stop: workerStop };
}
const boundedNativeId = (value: unknown): value is string => typeof value === "string" && value.length > 0 &&
  Buffer.byteLength(value, "utf8") <= 256 && !value.includes("\0");
const nativeIdSchema = z.string().refine(boundedNativeId, "native identifier is not bounded");
const approvalSchema = z.object({
  approvalId: nativeIdSchema, sessionId: nativeIdSchema,
  turnId: nativeIdSchema, toolCallId: nativeIdSchema,
  itemId: nativeIdSchema, taskId: nativeIdSchema,
  viewCursor: nativeIdSchema,
  currentRequirementId: z.object({ approvalId: nativeIdSchema,
    sourceIndex: z.number().int().nonnegative().safe() }),
  toolName: z.string().min(1).max(256), rawArgs: z.string().max(16_384),
  subject: z.record(z.string(), z.unknown()).refine((value) => Buffer.byteLength(JSON.stringify(value)) <= 8192, "approval subject exceeds its bound"),
  availableChoices: z.array(z.object({ choiceId: z.string().min(1).max(256), label: z.string().max(512),
    decision: z.string().min(1).max(128), scope: z.string().min(1).max(128) })).min(1).max(16),
}).refine((value) => new Set(value.availableChoices.map((choice) => choice.choiceId)).size === value.availableChoices.length, "duplicate native approval choices");

function nativeStageId(approvalId: string, sourceIndex: number): string {
  return `muse-stage:${createHash("sha256").update(JSON.stringify([approvalId, sourceIndex])).digest("hex")}`;
}

function peerContinuationPrompt(envelope: PeerDeliveryEnvelope): string {
  const prompt = peerDeliveryPrompt(envelope, "muse");
  if (Buffer.byteLength(prompt, "utf8") > MAX_MUSE_PEER_DELIVERY_PROMPT_BYTES) throw new BridgeError("PEER_DELIVERY_PROMPT_CAPACITY", "Peer continuation prompt exceeds its bound");
  return prompt;
}

export class MuseSdkAdapter implements WorkerAdapter {
  constructor(private readonly options: MuseOptions, private readonly startClient: ClientStarter = startOwnedClient) {}
  async run(input: Parameters<WorkerAdapter["run"]>[0]): Promise<WorkerRun> {
    if (input.signal.aborted) return cancelledRun(input.signal, "not_started");
    const lifetime = new AbortController(), signal = AbortSignal.any([input.signal, lifetime.signal]);
    const args = ["serve"];
    if (input.request.mode === "review") args.push("--disable-write", "--disable-shell", "--sandbox-network", this.options.review.sandbox_network);
    else args.push("--sandbox-network", this.options.implementation.sandbox_network);
    let client: MuseClient | undefined, startup: ClientStartup | undefined;
    let stopped: WorkerRun["worker_stop"] = "unconfirmed", consume: Promise<void> | undefined, consumeError: unknown, eventError: unknown;
    let cleanupDeadline = 0, stderrNoted = false;
    let reportedModel: string | undefined;
    const checks: WorkerRun["checks"] = [];
    const remaining = () => Math.max(1, cleanupDeadline - Date.now());
    const events = new Set<Promise<void>>(), native = new Set<Promise<unknown>>(), approvals = new Set<Promise<ApprovalDecisionInput>>();
    const approvalIds = new Set<string>();
    let approvalStages = new Map<string, { stageId: string; sourceIndex: number;
      toolCallId: string; itemId: string; taskId: string }>();
    let seenApprovalStages = new Set<string>();
    let turnOpen = false;
    let turnCorrelation: { promise: Promise<{ sessionId: string; turnId: string }>;
      resolve: (identity: { sessionId: string; turnId: string }) => void; reject: (reason: unknown) => void } | undefined;
    let approvalFailure: Promise<never> | undefined, rejectApprovalFailure: ((reason: unknown) => void) | undefined;
    let approvalError: BridgeError | undefined;
    let nativeFailure: Promise<never> | undefined;
    const wait = <T>(work: Promise<T>): Promise<T> => {
      native.add(work);
      void work.then(() => native.delete(work), () => native.delete(work));
      return withAbort(Promise.race([work, ...(nativeFailure ? [nativeFailure] : []),
        ...(approvalFailure ? [approvalFailure] : [])]), signal);
    };
    const emit = (event: import("../agents/types.js").WorkerEvent): Promise<void> => {
      if (signal.aborted) return Promise.resolve();
      if (events.size >= 32) { eventError ??= new BridgeError("MUSE_EVENT_OVERLOAD", "The task event sink exceeded its bounded capacity"); return Promise.resolve(); }
      const pending = Promise.resolve().then(() => input.onEvent(event)).catch((error) => { eventError ??= error; }).finally(() => events.delete(pending));
      events.add(pending); return pending;
    };
    const stop = async () => {
      const owned = client ?? startup;
      client = undefined; startup = undefined;
      if (owned) stopped = await settlesWithin(Promise.resolve().then(() => owned.close()), remaining()) ? "confirmed" : "unconfirmed";
    };
    let result: WorkerRun;
    try {
      startup = this.startClient({ museBin: this.options.muse_bin, args, cwd: input.workspace, env: childEnvironment(),
        clientInfo: { name: "muse_bridge", version: "0.1.0" }, shutdownTimeoutMs: input.policy.stop_grace_ms,
        onStderr: () => { if (!stderrNoted) { stderrNoted = true; void emit({ kind: "evidence_omitted", reason: "Native stderr excluded from persisted diagnostics" }); } },
      });
      nativeFailure = startup.failure;
      client = await wait(startup.ready); startup = undefined;
      throwIfAborted(signal);
      const session = await wait(client.startSession({ workspaceRoot: input.workspace, modelId: this.options.model, approvalMode: "onRequest" }));
      if (!boundedNativeId(session.sessionId)) throw new BridgeError("MUSE_SESSION_ID_UNKNOWN", "Muse did not establish a bounded native session identity");
      const sessionId = session.sessionId;
      const turnStartedEvent = (turnId: string): import("../agents/types.js").WorkerEvent =>
        ({ kind: "turn_started", turn_id: turnId, native_session_id: sessionId });
      const turnSettledEvent = (turnId: string, terminal: "completed" | "failed" | "cancelled"): import("../agents/types.js").WorkerEvent =>
        ({ kind: "turn_settled", turn_id: turnId, native_session_id: sessionId, terminal });
      const reported = session.opening?.result.session.modelId;
      if (typeof reported !== "string" || reported !== this.options.model) throw new BridgeError("MUSE_MODEL_MISMATCH", "Muse did not report the requested model");
      reportedModel = reported;
      const fold = session.fold;
      if (!fold || typeof fold.items?.list !== "function" || typeof fold.items?.isTerminalUnknown !== "function") {
        throw new BridgeError("MUSE_OBSERVATION_UNSUPPORTED", "The installed SDK cannot expose the required native item settlement evidence");
      }
      const outstanding = new Map<string, string>();
      let uncertainNoted = false;
      let peerTurn: PeerDeliveryEnvelope | undefined;
      let peerOperations = 0;
      let pendingPeerAwait: { case_id: string; operation_key: string } | undefined;
      let peerEvidenceUnknown = false;
      const observeItems = async (): Promise<boolean> => {
        if (!fold.current) {
          if (peerTurn) peerEvidenceUnknown = true;
          if (!uncertainNoted) { uncertainNoted = true; await emit({ kind: "runtime_unknown", reason: "Muse's native view has an unresolved delivery gap" }); }
          return false;
        }
        let unknown = false;
        for (const item of fold.items.list()) {
          if (typeof item.itemId !== "string" || !item.itemId || item.itemId.length > 256 || typeof item.kind !== "string" || !item.kind || item.kind.length > 128 || typeof item.status !== "string") {
            throw new BridgeError("MUSE_EVENT_INVALID", "Native item settlement identity is invalid");
          }
          if (fold.items.isTerminalUnknown(item.itemId)) { unknown = true; if (peerTurn) peerEvidenceUnknown = true; continue; }
          if (item.status === "inProgress") {
            if (!outstanding.has(item.itemId)) {
              if (outstanding.size >= 256) throw new BridgeError("MUSE_EVENT_OVERLOAD", "Too many native item obligations");
              outstanding.set(item.itemId, item.kind);
              await emit({ kind: "operation_started", id: item.itemId, operation: item.kind });
            }
          } else if (outstanding.delete(item.itemId)) {
            // A terminal item is settled, not necessarily successful. The native turn owns success.
            await emit({ kind: "operation_finished", id: item.itemId });
          }
        }
        if (unknown && !uncertainNoted) { uncertainNoted = true; await emit({ kind: "runtime_unknown", reason: "Muse reports an item with unknown terminal state" }); }
        if (!unknown) uncertainNoted = false;
        return !unknown && outstanding.size === 0;
      };
      session.onApproval((raw): Promise<ApprovalDecisionInput> => {
        const pending = (async (): Promise<ApprovalDecisionInput> => {
          throwIfAborted(signal);
          if (approvals.size >= 16) throw new BridgeError("MUSE_APPROVAL_OVERLOAD", "Too many outstanding approval requests");
          const parsed = approvalSchema.safeParse(raw);
          if (!parsed.success) throw new BridgeError("MUSE_APPROVAL_INVALID", "Native approval fields violate the consumed contract");
          const request = parsed.data;
          const correlation = turnCorrelation;
          if (!correlation) throw new BridgeError("MUSE_APPROVAL_UNCORRELATED", "Native approval has no accepted turn");
          const stageId = nativeStageId(request.approvalId, request.currentRequirementId.sourceIndex);
          if (seenApprovalStages.has(stageId)) throw new BridgeError("MUSE_APPROVAL_INVALID", "Native approval stage was already presented");
          const prior = approvalStages.get(request.approvalId);
          if (prior && (prior.toolCallId !== request.toolCallId || prior.itemId !== request.itemId ||
              prior.taskId !== request.taskId || request.currentRequirementId.sourceIndex <= prior.sourceIndex)) {
            approvalStages.delete(request.approvalId);
            approvalError ??= new BridgeError("MUSE_APPROVAL_IDENTITY_CHANGED", "Native approval changed its stable identity or replayed a requirement");
            if (approvalIds.has(prior.stageId)) await emit({ kind: "input_withdrawn", native_id: prior.stageId });
            rejectApprovalFailure?.(approvalError);
            throw approvalError;
          }
          approvalStages.set(request.approvalId, { stageId, sourceIndex: request.currentRequirementId.sourceIndex,
            toolCallId: request.toolCallId, itemId: request.itemId, taskId: request.taskId });
          seenApprovalStages.add(stageId);
          if (prior && approvalIds.has(prior.stageId)) {
            // The SDK can deliver an updated requirement while the earlier handler still awaits a person.
            // Invalidate that handler synchronously, then durably withdraw its pending input.
            approvalError ??= new BridgeError("MUSE_APPROVAL_STAGE_SUPERSEDED", "Native approval requirement changed before the prior choice returned");
            await emit({ kind: "input_withdrawn", native_id: prior.stageId });
            rejectApprovalFailure?.(approvalError);
            throw approvalError;
          }
          const identity = await wait(correlation.promise);
          if (!turnOpen || turnCorrelation !== correlation || request.sessionId !== identity.sessionId || request.turnId !== identity.turnId ||
              request.currentRequirementId.approvalId !== request.approvalId) {
            throw new BridgeError("MUSE_APPROVAL_UNCORRELATED", "Native approval differs from the current accepted turn or requirement");
          }
          if (approvalStages.get(request.approvalId)?.stageId !== stageId) throw new BridgeError("MUSE_APPROVAL_STAGE_SUPERSEDED", "Native approval requirement changed before correlation");
          approvalIds.add(stageId);
          try {
            await emit({ kind: "approval_requested", approval_id: request.approvalId, tool: request.toolName });
            if (eventError) throw new BridgeError("MUSE_APPROVAL_OBSERVATION_FAILED", "Native approval observation could not be recorded");
            if (approvalStages.get(request.approvalId)?.stageId !== stageId) throw new BridgeError("MUSE_APPROVAL_STAGE_SUPERSEDED", "Native approval requirement changed before presentation");
            const choices = request.availableChoices.filter((choice) => choice.scope === "once" || choice.decision.startsWith("denied"));
            if (!choices.length) throw new BridgeError("APPROVAL_UNSUPPORTED", "Muse offered no single-operation or denial decision");
            const subject = { ...request.subject, native: { session_id: request.sessionId,
              turn_id: request.turnId, approval_id: request.approvalId, tool_call_id: request.toolCallId,
              item_id: request.itemId, task_id: request.taskId, view_cursor: request.viewCursor,
              current_requirement_id: request.currentRequirementId } };
            if (Buffer.byteLength(JSON.stringify(subject)) > 8192) throw new BridgeError("MUSE_APPROVAL_INVALID", "Native approval subject exceeds its bound");
            const decision = await input.approve({ id: stageId, tool: request.toolName, raw_args: request.rawArgs,
              subject, workspace: input.workspace, task_id: input.task_id,
              choices: choices.map((choice) => ({ id: choice.choiceId, label: choice.label, decision: choice.decision, scope: choice.scope })),
            }, signal);
            throwIfAborted(signal);
            if (approvalError) throw approvalError;
            if (approvalStages.get(request.approvalId)?.stageId !== stageId) throw new BridgeError("MUSE_APPROVAL_STAGE_SUPERSEDED", "Native approval requirement changed before SDK dispatch");
            if (!choices.some((choice) => choice.choiceId === decision.choice_id)) throw new BridgeError("APPROVAL_INVALID", "The decision was not offered for this native request");
            return { choiceId: decision.choice_id };
          } finally { approvalIds.delete(stageId); }
        })();
        void pending.catch((error: unknown) => {
          approvalError ??= error instanceof BridgeError ? error :
            new BridgeError("MUSE_APPROVAL_HANDLER_FAILED", "Native approval handler failed before SDK dispatch");
          rejectApprovalFailure?.(approvalError);
        });
        approvals.add(pending);
        void pending.then(() => approvals.delete(pending), () => approvals.delete(pending));
        return pending;
      });
      session.onApprovalError((failure) => {
        approvalError ??= new BridgeError(failure.kind === "submitFailed" ? "MUSE_APPROVAL_DISPATCH_UNKNOWN" :
          failure.kind === "unofferedChoice" ? "MUSE_APPROVAL_CHOICE_INVALID" : "MUSE_APPROVAL_HANDLER_FAILED",
        "Muse SDK could not complete the native approval decision");
        rejectApprovalFailure?.(approvalError);
      });
      throwIfAborted(signal);
      let prompt = input.prompt;
      while (true) {
        throwIfAborted(signal);
        if (approvalError) throw approvalError;
        peerEvidenceUnknown = false;
        seenApprovalStages = new Set();
        approvalStages = new Map();
        approvalFailure = new Promise<never>((_resolve, reject) => { rejectApprovalFailure = reject; });
        approvalFailure.catch(() => undefined);
        turnCorrelation = (() => {
          let resolve!: (identity: { sessionId: string; turnId: string }) => void;
          let reject!: (reason: unknown) => void;
          const promise = new Promise<{ sessionId: string; turnId: string }>((yes, no) => { resolve = yes; reject = no; });
          promise.catch(() => undefined);
          return { promise, resolve, reject };
        })();
        turnOpen = true;
        // Keep the provisional local observation for callbacks that race the SDK's
        // send response. A peer receipt must instead use the SDK's native turn ID.
        const localTurnId = randomUUID();
        await emit(turnStartedEvent(localTurnId));
        if (eventError) throw new BridgeError("MUSE_NATIVE_OBSERVATION_FAILED", "Provisional native turn observation could not be recorded");
        let turn;
        try {
          turn = await wait(session.sendUserTurn({ input: [{ type: "text", text: prompt }], displayText: `Passeur task ${input.task_id}` }));
          // Correlation may fail before this accepted turn is consumed; retain its terminal rejection.
          turn.completed.catch(() => undefined);
          if (!boundedNativeId(turn.turnId)) throw new BridgeError("MUSE_TURN_ID_UNKNOWN", "Muse did not establish a bounded native turn identity");
          await emit({ kind: "turn_correlated", provisional_turn_id: localTurnId, turn_id: turn.turnId, native_session_id: sessionId });
          if (eventError) throw new BridgeError("MUSE_NATIVE_CORRELATION_FAILED", "Accepted native turn identity could not be recorded");
          turnCorrelation.resolve({ sessionId, turnId: turn.turnId });
        } catch (error) { turnCorrelation.reject(error); throw error; }
        const turnId = turn.turnId;
        let supersededPeer = peerTurn ? await wait(input.peer!.delivered(peerTurn.idempotency_key, turnId, sessionId)) === "superseded" : false;
        let lastText: string | undefined;
        consumeError = undefined;
        consume = (async () => {
          for await (const item of turn.items()) {
            throwIfAborted(signal);
            if (typeof item.kind !== "string" || item.kind.length > 128) throw new BridgeError("MUSE_EVENT_INVALID", "Native item kind is invalid");
            if (item.kind === "agentMessage" && item.text) {
              if (typeof item.text !== "string" || Buffer.byteLength(item.text) > 131_072) throw new BridgeError("WORKER_MESSAGE_INVALID", "Native report exceeds the consumed text contract");
              lastText = item.text;
            }
            if (item.kind === "userShell" && item.commandText && item.exitCode !== undefined && item.exitCode !== null) {
              if (typeof item.commandText !== "string" || typeof item.exitCode !== "number" || !Number.isSafeInteger(item.exitCode)) throw new BridgeError("MUSE_EVENT_INVALID", "Native command evidence is invalid");
              if (checks.length < 100) checks.push({ command: safeText(item.commandText, 4096), cwd: input.workspace, exit_code: item.exitCode, evidence: "runtime_observed" });
            }
            await observeItems();
            await emit({ kind: "item", item_kind: item.kind, ...(item.status ? { status: String(item.status).slice(0, 128) } : {}) });
          }
        })().catch((error: unknown) => { consumeError = error; });
        const outcome = await wait(Promise.all([turn.completed, consume]).then(([terminal]) => terminal));
        turnOpen = false;
        if (consumeError) throw consumeError;
        if (approvalError) throw approvalError;
        if (eventError) throw eventError;
        const status = outcomeStatus(outcome);
        // A native turn may end before known background items settle. Snapshot checks are
        // observations only: this interval has no expiry and cannot cancel the assignment.
        if (status === "completed") while (!await observeItems()) {
          await wait(observeAgain(200, undefined, { signal }));
        }
        // Withdraw only at native turn settlement, never because presentation timed out.
        if (approvals.size) {
          for (const id of approvalIds) await emit({ kind: "input_withdrawn", native_id: id });
          await Promise.allSettled([...approvals]);
        }
        await emit(turnSettledEvent(turnId, status === "completed" ? "completed" : status === "cancelled" ? "cancelled" : "failed"));
        if (eventError) throw eventError;
        const deliveredPeer = peerTurn;
        peerTurn = undefined;
        if (status !== "completed") {
          result = { status, summary: `Muse execution ${status}`, worker_assessment: "unknown", blockers: [], questions: [], checks,
            reported_model: reported, worker_stop: stopped }; break;
        }
        let message;
        try { message = parseWorkerMessage(lastText); }
        catch (error) {
          if (!(error instanceof BridgeError) || error.code !== "WORKER_MESSAGE_INVALID") throw error;
          if (deliveredPeer) throw new BridgeError("PEER_DELIVERY_OBSERVATION_MISSING", "Peer turn did not provide an exact disposition receipt");
          prompt = await wait(input.input("The completed native turn has no valid assignment disposition. Supply an explicit continuation instruction, or cancel the task.", true, undefined, undefined, signal));
          await emit(turnSettledEvent(turnId, "completed"));
          if (eventError) throw eventError;
          continue;
        }
        if (deliveredPeer) {
          if (message.peer_observed !== deliveredPeer.idempotency_key || peerEvidenceUnknown) {
            throw new BridgeError("PEER_DELIVERY_OBSERVATION_MISSING", "Muse peer turn lacks an exact receipt or complete native evidence");
          }
          supersededPeer = await wait(input.peer!.observed(deliveredPeer.idempotency_key, turnId, sessionId!)) === "superseded" || supersededPeer;
        }
        if (supersededPeer) {
          pendingPeerAwait = undefined;
          prompt = peerSupersededPrompt();
          continue;
        }
        if (message.kind === "peer_proposal_invalid") {
          if (pendingPeerAwait) throw new BridgeError("PEER_OPERATION_PENDING", "A pending peer await requires its exact retained continuation key");
          if (++peerOperations > 64) throw new BridgeError("PEER_OPERATION_CAPACITY", "Peer operation turn limit exceeded");
          prompt = peerProposalCorrectionPrompt(message.operation_kind, "The proposal fields violate the canonical worker contract");
          continue;
        }
        if (message.kind === "peer_operation") {
          if (!input.peer?.operation) throw new BridgeError("PEER_OPERATION_UNAVAILABLE", "This task has no authorized peer operation port");
          if (pendingPeerAwait && (message.operation.kind !== "await_change" ||
              message.operation.case_id !== pendingPeerAwait.case_id || message.operation.operation_key !== pendingPeerAwait.operation_key)) {
            throw new BridgeError("PEER_OPERATION_PENDING", "A pending peer await requires its exact retained continuation key");
          }
          if (++peerOperations > 64) throw new BridgeError("PEER_OPERATION_CAPACITY", "Peer operation turn limit exceeded");
          let operationResult;
          try { operationResult = await wait(input.peer.operation(message.operation)); }
          catch (error) {
            const reason = message.operation.kind === "propose" || message.operation.kind === "counter_propose"
              ? peerProposalRejection(error) : undefined;
            if (!reason || message.operation.kind !== "propose" && message.operation.kind !== "counter_propose") throw error;
            prompt = peerProposalCorrectionPrompt(message.operation.kind, reason);
            continue;
          }
          prompt = peerOperationResultPrompt(input.task_id, message.operation, operationResult);
          pendingPeerAwait = operationResult.kind === "pending"
            ? { case_id: message.operation.case_id, operation_key: message.operation.operation_key } : undefined;
          continue;
        }
        if (pendingPeerAwait && message.kind === "final") throw new BridgeError("PEER_OPERATION_PENDING", "Pending peer change cannot be reported as completed work");
        if (message.kind === "input_required") {
          prompt = await wait(input.input(message.question, false, undefined, undefined, signal));
          await emit(turnSettledEvent(turnId, "completed"));
          if (eventError) throw eventError;
          continue;
        }
        if (message.kind === "blocked") {
          result = { status: "blocked", summary: message.reason, worker_assessment: "unmet", blockers: [message.reason], questions: [], checks,
            reported_model: reported, worker_stop: stopped }; break;
        }
        const report = finalReport(message);
        const nextPeer = input.peer ? await wait(input.peer.next()) : undefined;
        if (nextPeer) {
          peerTurn = nextPeer;
          prompt = peerContinuationPrompt(nextPeer);
          continue;
        }
        result = { status: "completed", ...report, checks: [...checks, ...report.checks].slice(0, 200), reported_model: reported, worker_stop: stopped }; break;
      }
    } catch (error) {
      turnOpen = false;
      turnCorrelation?.reject(error);
      const detail = error instanceof BridgeError ? errorInfo(error) : { code: "MUSE_RUNTIME_ERROR", message: "Muse runtime failed; native error details are excluded from persisted diagnostics" };
      result = input.signal.aborted ? { ...cancelledRun(input.signal, stopped), checks } : {
        status: "failed", summary: detail.message, worker_assessment: "unknown", blockers: [], questions: [], checks,
        error: detail, worker_stop: stopped,
      };
      if (reportedModel) result.reported_model = reportedModel;
    } finally {
      cleanupDeadline = Date.now() + input.policy.stop_grace_ms;
      lifetime.abort(new BridgeError("WORKER_STOPPING", "The worker run is closing"));
      await stop();
      if (consume && !await settlesWithin(consume, remaining())) stopped = "unconfirmed";
      if (!await settlesWithin(Promise.allSettled([...native, ...approvals, ...events]), remaining())) stopped = "unconfirmed";
    }
    if (approvalError && !input.signal.aborted && result.status === "completed") {
      const detail = errorInfo(approvalError);
      result = { status: "failed", summary: detail.message, worker_assessment: "unknown", blockers: [], questions: [],
        checks, error: detail, worker_stop: stopped, ...(reportedModel ? { reported_model: reportedModel } : {}) };
    }
    return { ...result, worker_stop: stopped };
  }
}
