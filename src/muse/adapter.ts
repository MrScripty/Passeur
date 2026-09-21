import { MuseClient, readSessionDurability, spawnMspConnection, type ApprovalDecisionInput, type MuseClientSpawnOptions, type TurnOutcome } from "@muse-code/sdk";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { setTimeout as observeAgain } from "node:timers/promises";
import { BridgeError, errorInfo, safeText } from "../core/errors.js";
import { settlesWithin, throwIfAborted, withAbort } from "../core/async.js";
import { parseWorkerMessage, finalReport } from "../agents/report.js";
import type { WorkerAdapter, WorkerRun } from "../agents/types.js";
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
const approvalSchema = z.object({
  approvalId: z.string().min(1).max(256), toolName: z.string().min(1).max(256), rawArgs: z.string().max(16_384),
  subject: z.record(z.string(), z.unknown()).refine((value) => Buffer.byteLength(JSON.stringify(value)) <= 8192, "approval subject exceeds its bound"),
  availableChoices: z.array(z.object({ choiceId: z.string().min(1).max(256), label: z.string().max(512),
    decision: z.string().min(1).max(128), scope: z.string().min(1).max(128) })).min(1).max(16),
}).refine((value) => new Set(value.availableChoices.map((choice) => choice.choiceId)).size === value.availableChoices.length, "duplicate native approval choices");

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
    let nativeFailure: Promise<never> | undefined;
    const wait = <T>(work: Promise<T>): Promise<T> => {
      native.add(work);
      void work.then(() => native.delete(work), () => native.delete(work));
      return withAbort(nativeFailure ? Promise.race([work, nativeFailure]) : work, signal);
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
      const reported = session.opening?.result.session.modelId;
      if (typeof reported !== "string" || reported !== this.options.model) throw new BridgeError("MUSE_MODEL_MISMATCH", "Muse did not report the requested model");
      reportedModel = reported;
      const fold = session.fold;
      if (!fold || typeof fold.items?.list !== "function" || typeof fold.items?.isTerminalUnknown !== "function") {
        throw new BridgeError("MUSE_OBSERVATION_UNSUPPORTED", "The installed SDK cannot expose the required native item settlement evidence");
      }
      const outstanding = new Map<string, string>();
      let uncertainNoted = false;
      const observeItems = async (): Promise<boolean> => {
        if (!fold.current) {
          if (!uncertainNoted) { uncertainNoted = true; await emit({ kind: "runtime_unknown", reason: "Muse's native view has an unresolved delivery gap" }); }
          return false;
        }
        let unknown = false;
        for (const item of fold.items.list()) {
          if (typeof item.itemId !== "string" || !item.itemId || item.itemId.length > 256 || typeof item.kind !== "string" || !item.kind || item.kind.length > 128 || typeof item.status !== "string") {
            throw new BridgeError("MUSE_EVENT_INVALID", "Native item settlement identity is invalid");
          }
          if (fold.items.isTerminalUnknown(item.itemId)) { unknown = true; continue; }
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
          if (approvalIds.has(request.approvalId)) throw new BridgeError("MUSE_APPROVAL_INVALID", "Native approval ID is already outstanding");
          approvalIds.add(request.approvalId);
          try {
            await emit({ kind: "approval_requested", approval_id: request.approvalId, tool: request.toolName });
            const choices = request.availableChoices.filter((choice) => choice.scope === "once" || choice.decision.startsWith("denied"));
            if (!choices.length) throw new BridgeError("APPROVAL_UNSUPPORTED", "Muse offered no single-operation or denial decision");
            const decision = await input.approve({ id: request.approvalId, tool: request.toolName, raw_args: request.rawArgs,
              subject: request.subject, workspace: input.workspace, task_id: input.task_id,
              choices: choices.map((choice) => ({ id: choice.choiceId, label: choice.label, decision: choice.decision, scope: choice.scope })),
            }, signal);
            throwIfAborted(signal);
            if (!choices.some((choice) => choice.choiceId === decision.choice_id)) throw new BridgeError("APPROVAL_INVALID", "The decision was not offered for this native request");
            return { choiceId: decision.choice_id };
          } finally { approvalIds.delete(request.approvalId); }
        })();
        approvals.add(pending);
        void pending.then(() => approvals.delete(pending), () => approvals.delete(pending));
        return pending;
      });
      session.onApprovalError(() => { void emit({ kind: "evidence_omitted", reason: "Native approval error excluded from diagnostics" }); });
      throwIfAborted(signal);
      let prompt = input.prompt;
      while (true) {
        throwIfAborted(signal);
        // Muse's SDK owns native correlation. This ID scopes Passeur observations to this invocation.
        const turnId = randomUUID();
        await emit({ kind: "turn_started", turn_id: turnId });
        const turn = await wait(session.sendUserTurn({ input: [{ type: "text", text: prompt }], displayText: `Passeur task ${input.task_id}` }));
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
        if (consumeError) throw consumeError;
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
        await emit({ kind: "turn_settled", turn_id: turnId, terminal: status === "completed" ? "completed" : status === "cancelled" ? "cancelled" : "failed" });
        if (status !== "completed") {
          result = { status, summary: `Muse execution ${status}`, worker_assessment: "unknown", blockers: [], questions: [], checks,
            reported_model: reported, worker_stop: stopped }; break;
        }
        let message;
        try { message = parseWorkerMessage(lastText); }
        catch (error) {
          if (!(error instanceof BridgeError) || error.code !== "WORKER_MESSAGE_INVALID") throw error;
          prompt = await wait(input.input("The completed native turn has no valid assignment disposition. Supply an explicit continuation instruction, or cancel the task.", true, undefined, undefined, signal));
          await emit({ kind: "turn_settled", turn_id: turnId, terminal: "completed" });
          continue;
        }
        if (message.kind === "input_required") {
          prompt = await wait(input.input(message.question, false, undefined, undefined, signal));
          await emit({ kind: "turn_settled", turn_id: turnId, terminal: "completed" });
          continue;
        }
        if (message.kind === "blocked") {
          result = { status: "blocked", summary: message.reason, worker_assessment: "unmet", blockers: [message.reason], questions: [], checks,
            reported_model: reported, worker_stop: stopped }; break;
        }
        const report = finalReport(message);
        result = { status: "completed", ...report, checks: [...checks, ...report.checks].slice(0, 200), reported_model: reported, worker_stop: stopped }; break;
      }
    } catch (error) {
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
    return { ...result, worker_stop: stopped };
  }
}
