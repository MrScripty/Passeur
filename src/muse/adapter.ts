import { MuseClient, type ApprovalDecisionInput, type TurnOutcome } from "@muse-code/sdk";
import type { DelegateRequest, ExecutionStatus, Profile } from "../contracts/index.js";

export type ApprovalRequest = {
  id: string;
  tool: string;
  raw_args: string;
  subject: Record<string, unknown>;
  choices: Array<{ id: string; label: string; decision: string; scope: string }>;
};
export type ApprovalDecision = { choice_id: string };
export type ApprovalHandler = (request: ApprovalRequest, signal: AbortSignal) => Promise<ApprovalDecision>;
export type WorkerRun = { status: ExecutionStatus; summary: string; reported_model?: string; error?: { code: string; message: string }; worker_stop: "confirmed" | "unconfirmed" };
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

export class MuseSdkAdapter implements WorkerAdapter {
  async run(input: Parameters<WorkerAdapter["run"]>[0]): Promise<WorkerRun> {
    const args = ["serve"];
    if (input.request.mode === "review") args.push("--disable-write", "--disable-shell", "--sandbox-network", input.profile.review.sandbox_network);
    else args.push("--sandbox-network", input.profile.implementation.sandbox_network);
    let client: MuseClient | undefined;
    let stopped: "confirmed" | "unconfirmed" = "confirmed";
    const stop = async () => {
      if (!client) return;
      const owned = client; client = undefined;
      try { await owned.close(); } catch { stopped = "unconfirmed"; }
    };
    try {
      client = await MuseClient.spawn({
        museBin: input.profile.muse_bin,
        args,
        env: childEnvironment(),
        clientInfo: { name: "muse-bridge", version: "0.1.0" },
        shutdownTimeoutMs: input.profile.stop_grace_ms,
        onStderr: (chunk) => { void input.onEvent({ kind: "muse_stderr", text: chunk.slice(0, 16_384) }); },
      });
      const session = await client.startSession({ workspaceRoot: input.workspace, modelId: input.profile.model, approvalMode: "onRequest" });
      const reported = session.opening?.result.session.modelId ?? undefined;
      if (reported !== input.profile.model) throw new Error(`Muse reported model ${reported ?? "<unknown>"}; requested ${input.profile.model}`);
      session.onApproval(async (request): Promise<ApprovalDecisionInput> => {
        await input.onEvent({ kind: "approval_requested", approval_id: request.approvalId, tool: request.toolName });
        const decision = await input.approve({
          id: request.approvalId,
          tool: request.toolName,
          raw_args: request.rawArgs,
          subject: request.subject as unknown as Record<string, unknown>,
          choices: request.availableChoices.map((choice) => ({ id: choice.choiceId, label: choice.label, decision: choice.decision, scope: choice.scope })),
        }, input.signal);
        return { choiceId: decision.choice_id };
      });
      session.onApprovalError((failure) => { void input.onEvent({ kind: "approval_error", failure }); });
      const turn = await session.sendUserTurn({ input: [{ type: "text", text: input.prompt }], displayText: `Muse bridge task ${input.request.request_key}` });
      const texts: string[] = [];
      const consume = (async () => { for await (const item of turn.items()) { if (item.kind === "agentMessage" && item.text) texts.push(item.text); await input.onEvent({ kind: "item", item_kind: item.kind, status: item.status, text: item.text?.slice(0, 8192) }); } })();
      const abort = new Promise<never>((_, reject) => input.signal.addEventListener("abort", () => reject(input.signal.reason ?? new Error("aborted")), { once: true }));
      const outcome = await Promise.race([turn.completed, abort]);
      await consume;
      const status = outcomeStatus(outcome);
      const terminalError = outcome.kind === "completed" ? outcome.params.error : undefined;
      await stop();
      return { status, summary: texts.at(-1) ?? outcome.kind, reported_model: reported, ...(terminalError ? { error: { code: terminalError.kind, message: terminalError.message } } : {}), worker_stop: stopped };
    } catch (error) {
      await stop();
      if (input.signal.aborted) return { status: input.signal.reason?.code === "TASK_TIMEOUT" ? "timed_out" : "cancelled", summary: String(input.signal.reason ?? "Task cancelled"), worker_stop: stopped };
      return { status: "failed", summary: error instanceof Error ? error.message : String(error), error: { code: "MUSE_RUNTIME_ERROR", message: error instanceof Error ? error.message : String(error) }, worker_stop: stopped };
    }
  }
}
