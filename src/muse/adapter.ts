import { MuseClient, readSessionDurability, spawnMspConnection, type ApprovalDecisionInput, type MuseClientSpawnOptions, type TurnOutcome } from "@muse-code/sdk";
import type { ExecutionStatus } from "../contracts/types.js";
import { settlesWithin, throwIfAborted, withAbort } from "../core/async.js";
import { parseWorkerReport } from "./report.js";
import type { WorkerAdapter, WorkerRun } from "./types.js";
export * from "./types.js";
export { parseWorkerReport } from "./report.js";
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
    summary: String(signal.reason ?? "Task cancelled"), worker_assessment: "unknown", blockers: [], questions: [], checks: [], worker_stop: workerStop };
}
export class MuseSdkAdapter implements WorkerAdapter {
  constructor(private readonly startClient: ClientStarter = startOwnedClient) {}
  async run(input: Parameters<WorkerAdapter["run"]>[0]): Promise<WorkerRun> {
    if (input.signal.aborted) return cancelledRun(input.signal, "not_started");
    const args = ["serve"];
    if (input.request.mode === "review") args.push("--disable-write", "--disable-shell", "--sandbox-network", input.profile.review.sandbox_network);
    else args.push("--sandbox-network", input.profile.implementation.sandbox_network);
    let client: MuseClient | undefined, startup: ClientStartup | undefined;
    let stopped: WorkerRun["worker_stop"] = "unconfirmed", consume: Promise<void> | undefined, consumeError: unknown, eventError: unknown;
    let cleanupDeadline = 0;
    const remaining = () => Math.max(1, cleanupDeadline - Date.now());
    const events = new Set<Promise<void>>();
    const emit = (event: unknown): Promise<void> => {
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
      startup = this.startClient({ museBin: input.profile.muse_bin, args, cwd: input.workspace, env: childEnvironment(),
        clientInfo: { name: "muse_bridge", version: "0.1.0" }, shutdownTimeoutMs: input.profile.stop_grace_ms,
        onStderr: (chunk) => { void emit({ kind: "muse_stderr", text: chunk.slice(0, 16_384) }); },
      });
      client = await withAbort(startup.ready, input.signal); startup = undefined;
      throwIfAborted(input.signal);
      const session = await withAbort(client.startSession({ workspaceRoot: input.workspace, modelId: input.profile.model, approvalMode: "onRequest" }), input.signal);
      const reported = session.opening?.result.session.modelId ?? undefined;
      if (reported !== input.profile.model) throw new Error(`Muse reported ${reported ?? "<unknown>"}; requested ${input.profile.model}`);
      session.onApproval(async (request): Promise<ApprovalDecisionInput> => {
        throwIfAborted(input.signal);
        await emit({ kind: "approval_requested", task_id: input.task_id, approval_id: request.approvalId, tool: request.toolName });
        const decision = await input.approve({ id: request.approvalId, tool: request.toolName, raw_args: request.rawArgs,
          subject: request.subject as unknown as Record<string, unknown>, workspace: input.workspace,
          ...(input.task_id ? { task_id: input.task_id } : {}),
          choices: request.availableChoices.map((choice) => ({ id: choice.choiceId, label: choice.label, decision: choice.decision, scope: choice.scope })),
        }, input.signal);
        throwIfAborted(input.signal);
        return { choiceId: decision.choice_id };
      });
      session.onApprovalError((failure) => { void emit({ kind: "approval_error", failure }); });
      throwIfAborted(input.signal);
      const turn = await withAbort(session.sendUserTurn({ input: [{ type: "text", text: input.prompt }], displayText: `Passeur task ${input.task_id ?? input.request.request_key}` }), input.signal);
      let lastText: string | undefined;
      const checks: WorkerRun["checks"] = [];
      consume = (async () => {
        for await (const item of turn.items()) {
          if (item.kind === "agentMessage" && item.text) lastText = item.text.slice(0, 131_072);
          if (item.kind === "userShell" && item.commandText && checks.length < 100) checks.push({ command: item.commandText.slice(0, 4096), cwd: input.workspace, exit_code: item.exitCode ?? null, evidence: "runtime_observed" });
          await emit({ kind: "item", item_kind: item.kind, status: item.status, text: item.text?.slice(0, 8192) });
        }
      })().catch((error) => { consumeError = error; });
      const outcome = await withAbort(Promise.all([turn.completed, consume]).then(([terminal]) => terminal), input.signal);
      if (consumeError) throw consumeError;
      if (eventError) throw eventError;
      const report = parseWorkerReport(lastText, input.workspace);
      const error = outcome.kind === "completed" ? outcome.params.error : undefined;
      result = { status: outcomeStatus(outcome), ...report, checks: [...checks, ...report.checks], reported_model: reported,
        ...(error ? { error: { code: error.kind, message: error.message } } : {}), worker_stop: stopped };
    } catch (error) {
      const summary = error instanceof Error ? error.message : String(error);
      result = input.signal.aborted ? cancelledRun(input.signal, stopped) : {
        status: "failed", summary, worker_assessment: "unknown", blockers: [], questions: [], checks: [],
        error: { code: "MUSE_RUNTIME_ERROR", message: summary }, worker_stop: stopped,
      };
    } finally {
      cleanupDeadline = Date.now() + input.profile.stop_grace_ms;
      await stop();
      if (consume && !await settlesWithin(consume, remaining())) stopped = "unconfirmed";
      if (!await settlesWithin(Promise.allSettled([...events]), remaining())) stopped = "unconfirmed";
    }
    return { ...result, worker_stop: stopped };
  }
}
