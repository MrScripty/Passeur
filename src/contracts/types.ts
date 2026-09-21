/** Application contracts. Vendor SDK types stay in their runtime adapters. */
export type ExecutionStatus = "completed" | "blocked" | "failed" | "cancelled" | "timed_out" | "interrupted";
export type WorkerStop = "confirmed" | "unconfirmed" | "not_started";
export type DelegateRequest = {
  schema_version: 2;
  request_key: string;
  mode: "review" | "implement";
  objective: string;
  context: string;
  acceptance_criteria: string[];
  context_files?: string[] | undefined;
  allowed_paths?: string[] | undefined;
  base_commit?: string | undefined;
  target_ref?: string | undefined;
};
export type Profile = {
  schema_version: 1;
  muse_bin: string;
  model: string;
  review: { disable_write: true; disable_shell: true; sandbox_network: "restricted" | "proxy-only" };
  implementation: { enabled: boolean; worktree_root?: string | undefined; sandbox_network: "restricted" | "proxy-only" | "enabled" };
  task_timeout_ms: number;
  stop_grace_ms: number;
  max_workers?: number;
  max_queued_tasks?: number;
  subscription: { provenance: "user_confirmed" | "provider_verified" | "unverified"; verified_at?: string | undefined; note?: string | undefined };
};
export type Delivery = {
  status: "committed" | "no_changes_needed" | "incomplete" | "not_applicable";
  base_commit?: string;
  head_commit?: string;
  tree_oid?: string;
  branch_ref?: string;
  target_ref?: string;
  worktree_path?: string;
  commits?: string[];
  reason?: string;
};
export type Check = {
  command: string;
  cwd: string;
  exit_code: number | null;
  evidence: "runtime_observed" | "bridge_observed" | "worker_reported";
  artifact_id?: string;
};
export type DelegateResult = {
  schema_version: 2;
  task_id: string;
  request_key: string;
  execution_status: ExecutionStatus;
  worker_stop: WorkerStop;
  worker_assessment: "met" | "partial" | "unmet" | "unknown";
  summary: string;
  blockers: string[];
  questions: string[];
  error?: { code: string; message: string };
  model: { requested: string; reported?: string };
  workspace: { kind: "source_read_only" | "task_worktree"; base_commit?: string; worktree_path?: string; stale: boolean };
  delivery: Delivery;
  changed_files: string[];
  checks: Check[];
  artifacts: Array<{ id: string; kind: "report" | "diff" | "manifest" | "log"; path: string; bytes: number }>;
  output_truncated: boolean;
};
/** Legacy results remain historical, not permission to retire a workspace. */
export type LegacyResult = Omit<DelegateResult, "schema_version" | "delivery"> & { schema_version: 1 };
export type StoredResult = DelegateResult | LegacyResult | import("./agents.js").AgentResult | import("./tasks.js").LifecycleResult;
export type HistoricalRequest = (Omit<DelegateRequest, "schema_version"> & { schema_version: 1 | 2 }) | import("./agents.js").Assignment;
export type ResultRequest = {
  task_id?: string; request_key?: string; section?: "result" | "log";
  artifact_id?: string; encoding: "utf8" | "base64"; offset: number; limit: number;
};
export type FinalizeOperation = {
  operation_key: string;
  task_id: string;
  expected_head: string;
  expected_branch_ref: string;
  disposition: "integrated" | "retained" | "archived";
  target_ref?: string | undefined;
  accepted_commit?: string | undefined;
  owner?: string | undefined;
  reason?: string | undefined;
  next_action?: string | undefined;
  archive_authorized?: boolean | undefined;
  cleanup_authorized?: boolean | undefined;
};
export type ResourceRecord = {
  schema_version: 1;
  task_id: string;
  project_id: string;
  state: "creating" | "pending" | "retained" | "cleanup_pending" | "retired" | "not_applicable" | "legacy_unclassified";
  worktree_path?: string;
  branch_ref?: string;
  base_commit?: string;
  target_ref?: string;
  head_commit?: string;
  owner?: string;
  reason?: string;
  next_action?: string;
  protection_ref?: string;
  protected_commit?: string;
  disposition?: FinalizeOperation["disposition"];
  operation_key?: string;
  updated_at: string;
  artifacts_collected_at?: string;
  stop_reconciled?: { at: string; owner: string; reason: string };
};
export type FinalizeReceipt = {
  operation: FinalizeOperation;
  request_hash: string;
  state: "intent" | "cleanup_pending" | "done";
  resource: ResourceRecord;
  error?: { code: string; message: string };
  updated_at: string;
};
