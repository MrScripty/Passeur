import { MuseClient, type ApprovalDecisionInput, type TurnOutcome } from "@muse-code/sdk";
import type { DelegateRequest, DelegateResult, ExecutionStatus, Profile } from "../contracts/index.js";

export type ApprovalRequest = {
  id: string;
  tool: string;
  raw_args: string;
  subject: Record<string, unknown>;
  choices: Array<{ id: string; label: string; decision: string; scope: string }>;
};
export type ApprovalDecision = { choice_id: string };
export type ApprovalHandler = (request: ApprovalRequest, signal: AbortSignal) => Promise<ApprovalDecision>;
export type WorkerRun = {
  status: ExecutionStatus; summary: string; reported_model?: string; error?: { code: string; message: string }; worker_stop: DelegateResult["worker_stop"];
  worker_assessment: DelegateResult["worker_assessment"]; blockers: string[]; questions: string[]; checks: DelegateResult["checks"];
};
export interface WorkerAdapter { run(input: { request: DelegateRequest; prompt: string; workspace: string; profile: Profile; signal: AbortSignal; approve: ApprovalHandler; onEvent: (event: unknown) => Promise<void> }): Promise<WorkerRun>; }

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
  return { status: (signal.reason as { code?: string } | undefined)?.code === "TASK_TIMEOUT" ? "timed_out" : "cancelled", summary: String(signal.reason ?? "Task cancelled"), worker_assessment: "unknown", blockers: [], questions: [], checks: [], worker_stop: workerStop };
}

function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const rejectAbort = () => reject(signal.reason ?? new Error("aborted"));
    if (signal.aborted) rejectAbort(); else signal.addEventListener("abort", rejectAbort, { once: true });
  });
}

async function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> { return Promise.race([operation, abortPromise(signal)]); }
async function settlesWithin(operation: Promise<unknown>, milliseconds: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([operation.then(() => true, () => false), new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), milliseconds); })]); }
  finally { if (timer) clearTimeout(timer); }
}

export function parseWorkerReport(text: string | undefined, workspace: string): Pick<WorkerRun, "summary" | "worker_assessment" | "blockers" | "questions" | "checks"> {
  const fallback = { summary: text ?? "No worker report was returned", worker_assessment: "unknown" as const, blockers: [] as string[], questions: [] as string[], checks: [] as DelegateResult["checks"] };
  if (!text) return fallback;
  const marker = text.match(/MUSE_BRIDGE_RESULT\s*(\{[\s\S]*\})\s*$/);
  if (!marker?.[1]) return fallback;
  try {
    const value = JSON.parse(marker[1]) as Record<string, unknown>;
    const assessment = ["met", "partial", "unmet", "unknown"].includes(String(value.assessment)) ? value.assessment as WorkerRun["worker_assessment"] : "unknown";
    return {
      summary: typeof value.summary === "string" ? value.summary.slice(0, 16_384) : fallback.summary,
      worker_assessment: assessment,
      blockers: Array.isArray(value.blockers) ? value.blockers.filter((item): item is string => typeof item === "string").slice(0, 50) : [],
      questions: Array.isArray(value.questions) ? value.questions.filter((item): item is string => typeof item === "string").slice(0, 50) : [],
      checks: Array.isArray(value.checks) ? value.checks.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const check = item as Record<string, unknown>;
        if (typeof check.command !== "string") return [];
        return [{ command: check.command.slice(0, 4096), cwd: typeof check.cwd === "string" ? check.cwd.slice(0, 4096) : workspace, exit_code: typeof check.exit_code === "number" ? check.exit_code : null, evidence: "worker_reported" as const }];
      }).slice(0, 100) : [],
    };
  } catch { return fallback; }
}

export class MuseSdkAdapter implements WorkerAdapter {
  constructor(private readonly spawnClient: typeof MuseClient.spawn = MuseClient.spawn) {}
  async run(input: Parameters<WorkerAdapter["run"]>[0]): Promise<WorkerRun> {
    if (input.signal.aborted) return cancelledRun(input.signal, "not_started");
    const args = ["serve"];
    if (input.request.mode === "review") args.push("--disable-write", "--disable-shell", "--sandbox-network", input.profile.review.sandbox_network);
    else args.push("--sandbox-network", input.profile.implementation.sandbox_network);
    let client: MuseClient | undefined;
    let stopped: "confirmed" | "unconfirmed" = "unconfirmed";
    let consume: Promise<void> | undefined;
    let consumeError: unknown;
    let cleanupDeadline = 0;
    const cleanupRemaining = () => Math.max(1, cleanupDeadline - Date.now());
    const pendingEvents = new Set<Promise<void>>();
    let eventError: unknown;
    const emit = (event: unknown): Promise<void> => {
      const pending = Promise.resolve(input.onEvent(event)).catch((error) => { eventError ??= error; }).finally(() => pendingEvents.delete(pending));
      pendingEvents.add(pending);
      return pending;
    };
    const stop = async () => {
      if (!client) return;
      const owned = client; client = undefined;
      const close = Promise.resolve().then(() => owned.close());
      stopped = await settlesWithin(close, cleanupRemaining()) ? "confirmed" : "unconfirmed";
    };
    let result: WorkerRun;
    try {
      client = await this.spawnClient({
        museBin: input.profile.muse_bin,
        args,
        env: childEnvironment(),
        clientInfo: { name: "muse-bridge", version: "0.1.0" },
        shutdownTimeoutMs: input.profile.stop_grace_ms,
        onStderr: (chunk) => { void emit({ kind: "muse_stderr", text: chunk.slice(0, 16_384) }); },
      });
      if (input.signal.aborted) throw input.signal.reason;
      const session = await withAbort(client.startSession({ workspaceRoot: input.workspace, modelId: input.profile.model, approvalMode: "onRequest" }), input.signal);
      const reported = session.opening?.result.session.modelId ?? undefined;
      if (reported !== input.profile.model) throw new Error(`Muse reported model ${reported ?? "<unknown>"}; requested ${input.profile.model}`);
      session.onApproval(async (request): Promise<ApprovalDecisionInput> => {
        await emit({ kind: "approval_requested", approval_id: request.approvalId, tool: request.toolName });
        const decision = await input.approve({
          id: request.approvalId,
          tool: request.toolName,
          raw_args: request.rawArgs,
          subject: request.subject as unknown as Record<string, unknown>,
          choices: request.availableChoices.map((choice) => ({ id: choice.choiceId, label: choice.label, decision: choice.decision, scope: choice.scope })),
        }, input.signal);
        return { choiceId: decision.choice_id };
      });
      session.onApprovalError((failure) => { void emit({ kind: "approval_error", failure }); });
      if (input.signal.aborted) throw input.signal.reason;
      const turn = await withAbort(session.sendUserTurn({ input: [{ type: "text", text: input.prompt }], displayText: `Muse bridge task ${input.request.request_key}` }), input.signal);
      const texts: string[] = [];
      const checks: DelegateResult["checks"] = [];
      consume = (async () => { for await (const item of turn.items()) {
        if (item.kind === "agentMessage" && item.text) texts.push(item.text);
        if (item.kind === "userShell" && item.commandText) checks.push({ command: item.commandText, cwd: input.workspace, exit_code: item.exitCode ?? null, evidence: "runtime_observed" });
        await emit({ kind: "item", item_kind: item.kind, status: item.status, text: item.text?.slice(0, 8192) });
      } })().catch((error) => { consumeError = error; });
      const outcome = await withAbort(Promise.all([turn.completed, consume]).then(([terminal]) => terminal), input.signal);
      if (consumeError) throw consumeError;
      if (eventError) throw eventError;
      const status = outcomeStatus(outcome);
      const terminalError = outcome.kind === "completed" ? outcome.params.error : undefined;
      const report = parseWorkerReport(texts.at(-1), input.workspace);
      result = { status, ...report, checks: [...checks, ...report.checks], reported_model: reported, ...(terminalError ? { error: { code: terminalError.kind, message: terminalError.message } } : {}), worker_stop: stopped };
    } catch (error) {
      const summary = error instanceof Error ? error.message : String(error);
      result = input.signal.aborted
        ? cancelledRun(input.signal, stopped)
        : { status: "failed", summary, worker_assessment: "unknown", blockers: [], questions: [], checks: [], error: { code: "MUSE_RUNTIME_ERROR", message: summary }, worker_stop: stopped };
    } finally {
      cleanupDeadline = Date.now() + input.profile.stop_grace_ms;
      await stop();
      if (consume && !await settlesWithin(consume, cleanupRemaining())) stopped = "unconfirmed";
      if (!await settlesWithin(Promise.allSettled([...pendingEvents]), cleanupRemaining())) stopped = "unconfirmed";
    }
    return { ...result, worker_stop: stopped };
  }
}
