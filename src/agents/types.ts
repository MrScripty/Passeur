import type { LifecyclePolicy } from "../contracts/tasks.js";
import type { Check, ExecutionStatus, WorkerStop } from "../contracts/types.js";
import type { Assignment, SafeConfiguration } from "../contracts/agents.js";
export type ApprovalRequest = {
  id: string; tool: string; raw_args: string; subject: Record<string, unknown>;
  task_id?: string; workspace?: string;
  choices: Array<{ id: string; label: string; decision: string; scope: string }>;
};
export type ApprovalDecision = { choice_id: string };
export type ApprovalHandler = (request: ApprovalRequest, signal: AbortSignal) => Promise<ApprovalDecision>;
export type WorkerEvent =
  | { kind: "turn_started"; turn_id: string }
  | { kind: "turn_settled"; turn_id: string; terminal: "completed" | "failed" | "cancelled" }
  | { kind: "operation_started"; id: string; operation: string }
  | { kind: "operation_finished"; id: string }
  | { kind: "input_withdrawn"; native_id: string }
  | { kind: "process_observed"; pid: number; boot_id: string; started: string }
  | { kind: "runtime_unknown"; reason: string }

  | { kind: "progress"; stage: string }
  | { kind: "approval_requested"; approval_id: string; tool: string }
  | { kind: "item"; item_kind: string; status?: string }
  | { kind: "evidence_omitted"; reason: string };
export type WorkerRun = {
  status: Exclude<ExecutionStatus, "timed_out">; summary: string; reported_model?: string; error?: { code: string; message: string };
  worker_stop: WorkerStop; worker_assessment: "met" | "partial" | "unmet" | "unknown";
  blockers: string[]; questions: string[]; checks: Check[]; no_changes_reason?: string;
};
export type WorkerInput = {
  request: Assignment; prompt: string; workspace: string; policy: LifecyclePolicy; signal: AbortSignal;
  task_id: string; approve: ApprovalHandler; onEvent: (event: WorkerEvent) => Promise<void>;
  input: (question: string, attention?: boolean, native_id?: string, choices?: readonly string[], signal?: AbortSignal) => Promise<string>;
};
/** run owns startup, child work, callbacks and bounded shutdown through terminal observation. */
export interface WorkerAdapter { run(input: WorkerInput): Promise<WorkerRun>; }
export type ConfiguredAdapter = {
  worker: WorkerAdapter; modes: readonly Assignment["mode"][]; contract: string;
  configuration: SafeConfiguration; requested_model?: string;
};
export type AdapterDefinition = { configure(options: unknown): ConfiguredAdapter };
