import type { LifecyclePolicy } from "../contracts/tasks.js";
import type { Check, ExecutionStatus, WorkerStop } from "../contracts/types.js";
import type { Assignment, SafeConfiguration } from "../contracts/agents.js";
import type { PeerDeliveryEnvelope, PeerDeliveryReceiptStatus } from "../contracts/peer-delivery.js";
import type { PeerWorkerOperationResult } from "../contracts/peer-operations.js";
import type { PeerResolutionProposal } from "../coordination/peer-resolution.js";
import type { PrivateGitView } from "../workspace/worktree.js";
/** The coordinator supplies task, run, control generation, workspace and source identity. */
export type WorkerPeerOperationRequest = Readonly<{ schema_version: 1; operation_key: string; case_id: string }> & (
  | Readonly<{ kind: "inspect" }>
  | Readonly<{ kind: "propose" | "counter_propose"; proposal: PeerResolutionProposal }>
  | Readonly<{ kind: "acknowledge" | "withdraw"; note_id: string }>
  | Readonly<{ kind: "apply"; note_id: string; expected_case_revision: number;
      expected_case_generation: number; proposal_digest: string }>
  | Readonly<{ kind: "source_detail"; work_id: string; report_id: string; side: "input" | "observed";
      start_byte: number; end_byte: number }>
  | Readonly<{ kind: "await_change"; after_case_revision: number; after_case_generation: number; after_negotiation_cursor?: string }>
);
/** Adapter calls these only between settled native turns; no model-owned route or native turn is created here. */
export type WorkerPeerPort = Readonly<{
  next: () => Promise<PeerDeliveryEnvelope | undefined>;
  delivered: (idempotencyKey: string, nativeTurnId: string, nativeSessionId: string) => Promise<PeerDeliveryReceiptStatus>;
  observed: (idempotencyKey: string, nativeTurnId: string, nativeSessionId: string) => Promise<PeerDeliveryReceiptStatus>;
  operation?: (request: WorkerPeerOperationRequest) => Promise<PeerWorkerOperationResult>;
}>;
export type ApprovalRequest = {
  id: string; tool: string; raw_args: string; subject: Record<string, unknown>;
  task_id?: string; workspace?: string;
  choices: Array<{ id: string; label: string; decision: string; scope: string }>;
};
export type ApprovalDecision = { choice_id: string };
export type ApprovalHandler = (request: ApprovalRequest, signal: AbortSignal) => Promise<ApprovalDecision>;
export type WorkerEvent =
  | { kind: "turn_started"; turn_id: string; native_session_id?: string }
  | { kind: "turn_correlated"; provisional_turn_id: string; turn_id: string; native_session_id: string }
  | { kind: "turn_settled"; turn_id: string; native_session_id?: string; terminal: "completed" | "failed" | "cancelled" }
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
  peer?: WorkerPeerPort;
  /** A controlled worker must mount this private directory at the exact canonical common-dir path. */
  private_git?: Readonly<{ schema_version: 1; mount_kind: "canonical_common_dir"; view: PrivateGitView }>;
};
/** run owns startup, child work, callbacks and bounded shutdown through terminal observation. */
export interface WorkerAdapter {
  /** Absent from installed adapters; only an explicitly qualified exact-mount worker may receive a private view. */
  private_git?: Readonly<{ schema_version: 1; mount_kind: "canonical_common_dir" }>;
  run(input: WorkerInput): Promise<WorkerRun>;
}
export type ConfiguredAdapter = {
  worker: WorkerAdapter; modes: readonly Assignment["mode"][]; contract: string;
  configuration: SafeConfiguration; requested_model?: string;
};
export type AdapterDefinition = { configure(options: unknown): ConfiguredAdapter };
