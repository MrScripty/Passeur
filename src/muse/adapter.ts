import { MuseClient, readSessionDurability, spawnMspConnection, type ApprovalDecisionInput, type MuseClientSpawnOptions, type TurnOutcome } from "@muse-code/sdk";
import { z } from "zod";
import { BridgeError, errorInfo, safeText } from "../core/errors.js";
import type { ExecutionStatus } from "../contracts/types.js";
import { settlesWithin, throwIfAborted, withAbort } from "../core/async.js";
import { parseWorkerReport } from "../agents/report.js";
import type { WorkerAdapter, WorkerRun } from "../agents/types.js";
import type { MuseOptions } from "./config.js";
export type ClientStartup = { ready: Promise<MuseClient>; close: () => Promise<unknown> };
export type ClientStarter = (options: MuseClientSpawnOptions) => ClientStartup;
function startOwnedClient(options: MuseClientSpawnOptions): ClientStartup {
  const handshake = spawnMspConnection({ command: options.museBin,
    ...(options.args ? { args: options.args } : {}), ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: options.env } : {}), ...(options.onStderr ? { onStderr: options.onStderr } : {}),
    ...(options.shutdownTimeoutMs === undefined ? {} : { shutdownTimeoutMs: options.shutdownTimeoutMs }),
  });
  const ready = handshake.initialize({ clientInfo: options.clientInfo, ...(options.capabilities ? { capabilities: options.capabilities } : {}) })
    .then((spawned) => new MuseClient(spawned.connection, { durability: readSessionDurability(spawned.initializeResult), host: spawned }));
  ready.catch(() => undefined);
  return { ready, close: () => handshake.close() };
}
function childEnvironment(): NodeJS.ProcessEnv {
  const allow = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "TMPDIR", "TERM"];
  return Object.fromEntries(allow.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]])) as NodeJS.ProcessEnv;
}
function outcomeStatus(outcome: TurnOutcome): ExecutionStatus {
  if (outcome.kind === "terminalUnknown") return "interrupted";
  if (outcome.kind === "unqueued") return "cancelled";
  if (outcome.params.terminal === "completed") return "completed";
  if (outcome.params.terminal === "cancelled") return "cancelled";
  return outcome.params.error?.kind === "authRequired" ? "blocked" : "failed";
}
function cancelledRun(signal: AbortSignal, workerStop: WorkerRun["worker_stop"]): WorkerRun {
  return { status: (signal.reason as { code?: string } | undefined)?.code === "TASK_TIMEOUT" ? "timed_out" : "cancelled",
    summary: "Task cancelled or timed out", worker_assessment: "unknown", blockers: [], questions: [], checks: [], worker_stop: workerStop };
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
    const wait = <T>(work: Promise<T>): Promise<T> => {
      native.add(work);
      void work.then(() => native.delete(work), () => native.delete(work));
      return withAbort(work, signal);
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
      client = await wait(startup.ready); startup = undefined;
      throwIfAborted(signal);
      const session = await wait(client.startSession({ workspaceRoot: input.workspace, modelId: this.options.model, approvalMode: "onRequest" }));
      const reported = session.opening?.result.session.modelId;
      if (typeof reported !== "string" || reported !== this.options.model) throw new BridgeError("MUSE_MODEL_MISMATCH", "Muse did not report the requested model");
      reportedModel = reported;
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
      const turn = await wait(session.sendUserTurn({ input: [{ type: "text", text: input.prompt }], displayText: `Passeur task ${input.task_id}` }));
      let lastText: string | undefined;
      consume = (async () => {
        for await (const item of turn.items()) {
          throwIfAborted(signal);
          if (typeof item.kind !== "string" || item.kind.length > 128) throw new BridgeError("MUSE_EVENT_INVALID", "Native item kind is invalid");
          if (item.kind === "agentMessage" && item.text) {
            if (typeof item.text !== "string" || Buffer.byteLength(item.text) > 131_072) throw new BridgeError("WORKER_REPORT_INVALID", "Native report exceeds the consumed text contract");
            lastText = item.text;
          }
          if (item.kind === "userShell" && item.commandText && item.exitCode !== undefined && item.exitCode !== null) {
            if (typeof item.commandText !== "string" || typeof item.exitCode !== "number" || !Number.isSafeInteger(item.exitCode)) throw new BridgeError("MUSE_EVENT_INVALID", "Native command evidence is invalid");
            if (checks.length < 100) checks.push({ command: safeText(item.commandText, 4096), cwd: input.workspace, exit_code: item.exitCode, evidence: "runtime_observed" });
          }
          await emit({ kind: "item", item_kind: item.kind, ...(item.status ? { status: String(item.status).slice(0, 128) } : {}) });
        }
      })().catch((error: unknown) => { consumeError = error; });
      const outcome = await wait(Promise.all([turn.completed, consume]).then(([terminal]) => terminal));
      if (consumeError) throw consumeError;
      if (eventError) throw eventError;
      const status = outcomeStatus(outcome);
      if (status === "completed") {
        const report = parseWorkerReport(lastText);
        result = { status, ...report, checks: [...checks, ...report.checks], reported_model: reported, worker_stop: stopped };
      } else result = { status, summary: `Muse execution ${status}`, worker_assessment: "unknown", blockers: [], questions: [], checks,
        reported_model: reported, worker_stop: stopped };
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
