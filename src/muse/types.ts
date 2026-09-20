import type { DelegateRequest, DelegateResult, ExecutionStatus, Profile } from "../contracts/types.js";
export type ApprovalRequest = {
  id: string; tool: string; raw_args: string; subject: Record<string, unknown>;
  task_id?: string; workspace?: string;
  choices: Array<{ id: string; label: string; decision: string; scope: string }>;
};
export type ApprovalDecision = { choice_id: string };
export type ApprovalHandler = (request: ApprovalRequest, signal: AbortSignal) => Promise<ApprovalDecision>;
export type WorkerRun = {
  status: ExecutionStatus; summary: string; reported_model?: string; error?: { code: string; message: string };
  worker_stop: DelegateResult["worker_stop"]; worker_assessment: DelegateResult["worker_assessment"];
  blockers: string[]; questions: string[]; checks: DelegateResult["checks"]; no_changes_reason?: string;
};
export interface WorkerAdapter {
  run(input: {
    request: DelegateRequest; prompt: string; workspace: string; profile: Profile; signal: AbortSignal;
    task_id?: string; approve: ApprovalHandler; onEvent: (event: unknown) => Promise<void>;
  }): Promise<WorkerRun>;
}
