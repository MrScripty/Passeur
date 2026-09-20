import type { Check, ExecutionStatus, WorkerStop } from "../contracts/types.js";
import type { Assignment, ExecutionPolicy, SafeConfiguration } from "../contracts/agents.js";
export type ApprovalRequest = {
  id: string; tool: string; raw_args: string; subject: Record<string, unknown>;
  task_id?: string; workspace?: string;
  choices: Array<{ id: string; label: string; decision: string; scope: string }>;
};
export type ApprovalDecision = { choice_id: string };
export type ApprovalHandler = (request: ApprovalRequest, signal: AbortSignal) => Promise<ApprovalDecision>;
export type WorkerEvent =
  | { kind: "progress"; stage: string }
  | { kind: "approval_requested"; approval_id: string; tool: string }
  | { kind: "item"; item_kind: string; status?: string }
  | { kind: "evidence_omitted"; reason: string };
export type WorkerRun = {
  status: ExecutionStatus; summary: string; reported_model?: string; error?: { code: string; message: string };
  worker_stop: WorkerStop; worker_assessment: "met" | "partial" | "unmet" | "unknown";
  blockers: string[]; questions: string[]; checks: Check[]; no_changes_reason?: string;
};
export type WorkerInput = {
  request: Assignment; prompt: string; workspace: string; policy: ExecutionPolicy; signal: AbortSignal;
  task_id: string; approve: ApprovalHandler; onEvent: (event: WorkerEvent) => Promise<void>;
};
/** run owns startup, child work, callbacks and bounded shutdown through terminal observation. */
export interface WorkerAdapter { run(input: WorkerInput): Promise<WorkerRun>; }
export type ConfiguredAdapter = {
  worker: WorkerAdapter; modes: readonly Assignment["mode"][]; contract: string;
  configuration: SafeConfiguration; requested_model?: string;
};
export type AdapterDefinition = { configure(options: unknown): ConfiguredAdapter };
