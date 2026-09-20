import { z } from "zod";
import { DelegateRequestSchema, FinalizeOperationSchema } from "../contracts/index.js";
import type { FinalizeReceipt, ResourceRecord, StoredResult } from "../contracts/types.js";
import type { TaskState } from "../core/state.js";
import { BridgeError } from "../core/errors.js";
import type { StoredRequest } from "./task-store.js";

const text = z.string();
const nonempty = z.string().min(1);
const instant = z.string().datetime();
const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i);
const uuid = z.string().uuid();
const outcome = z.enum(["completed", "blocked", "failed", "cancelled", "timed_out", "interrupted"]);
const error = z.object({ code: nonempty, message: text }).strict();
// V1 did not require a target_ref. It remains history, never new execution authority.
const legacyRequest = z.object({
  schema_version: z.literal(1), request_key: nonempty, mode: z.enum(["review", "implement"]),
  objective: nonempty, context: text, acceptance_criteria: z.array(nonempty),
  context_files: z.array(text).optional(), allowed_paths: z.array(text).optional(),
  base_commit: oid.optional(), target_ref: text.optional(),
}).strict();
const requestRecord = z.object({
  task_id: uuid, project_id: nonempty, canonical_hash: nonempty,
  accepted_at: instant, deadline_at: instant,
  request: z.union([DelegateRequestSchema, legacyRequest]),
}).strict().refine((r) => Date.parse(r.deadline_at) >= Date.parse(r.accepted_at), "deadline precedes acceptance");
const taskState = z.object({
  phase: z.enum(["accepted", "queued", "preparing", "running", "awaiting_input", "stopping", "finalizing", "terminal"]),
  outcome: outcome.optional(), updated_at: instant, reason: text.optional(),
}).strict().refine((s) => (s.phase === "terminal") === (s.outcome !== undefined), "terminal phase and outcome disagree");
const delivery = z.object({
  status: z.enum(["committed", "no_changes_needed", "incomplete", "not_applicable"]),
  base_commit: oid.optional(), head_commit: oid.optional(), tree_oid: oid.optional(),
  branch_ref: text.optional(), target_ref: text.optional(), worktree_path: text.optional(),
  commits: z.array(oid).optional(), reason: text.optional(),
}).strict();
const resultFields = {
  task_id: uuid, request_key: nonempty, execution_status: outcome,
  worker_stop: z.enum(["confirmed", "unconfirmed", "not_started"]),
  worker_assessment: z.enum(["met", "partial", "unmet", "unknown"]),
  summary: text, blockers: z.array(text), questions: z.array(text), error: error.optional(),
  model: z.object({ requested: nonempty, reported: text.optional() }).strict(),
  workspace: z.object({ kind: z.enum(["source_read_only", "task_worktree"]), base_commit: oid.optional(),
    worktree_path: text.optional(), stale: z.boolean() }).strict(),
  changed_files: z.array(text),
  checks: z.array(z.object({ command: text, cwd: text, exit_code: z.number().int().nullable(),
    evidence: z.enum(["runtime_observed", "bridge_observed", "worker_reported"]), artifact_id: text.optional() }).strict()),
  artifacts: z.array(z.object({ id: nonempty, kind: z.enum(["report", "diff", "manifest", "log"]),
    path: nonempty, bytes: z.number().int().nonnegative() }).strict()),
  output_truncated: z.boolean(),
};
const storedResult = z.discriminatedUnion("schema_version", [
  z.object({ ...resultFields, schema_version: z.literal(1) }).strict(),
  z.object({ ...resultFields, schema_version: z.literal(2), delivery }).strict(),
]);
const resourceRecord = z.object({
  schema_version: z.literal(1), task_id: uuid, project_id: nonempty,
  state: z.enum(["creating", "pending", "retained", "cleanup_pending", "retired", "not_applicable", "legacy_unclassified"]),
  worktree_path: text.optional(), branch_ref: text.optional(), base_commit: oid.optional(), target_ref: text.optional(),
  head_commit: oid.optional(), owner: text.optional(), reason: text.optional(), next_action: text.optional(),
  protection_ref: text.optional(), protected_commit: oid.optional(),
  disposition: z.enum(["integrated", "retained", "archived"]).optional(), operation_key: text.optional(),
  updated_at: instant, artifacts_collected_at: instant.optional(),
  stop_reconciled: z.object({ at: instant, owner: nonempty, reason: nonempty }).strict().optional(),
}).strict();
const finalizeReceipt = z.object({
  operation: FinalizeOperationSchema, request_hash: nonempty,
  state: z.enum(["intent", "cleanup_pending", "done"]), resource: resourceRecord,
  error: error.optional(), updated_at: instant,
}).strict().refine((r) => r.operation.task_id === r.resource.task_id, "receipt task identity mismatch");
const safetyRecord = z.object({ reason: nonempty, at: instant }).strict();

function recordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function version(value: unknown, supported: readonly number[], stage: string): void {
  if (recordObject(value) && Number.isSafeInteger(value.schema_version) && Number(value.schema_version) > 0 && !supported.includes(value.schema_version as number)) {
    throw new BridgeError("STORE_VERSION_UNSUPPORTED", `Unsupported persisted version at ${stage}`, {
      stage, next_action: "Use a runtime supporting this version; retain the original records.",
    });
  }
}
function parse<S extends z.ZodType>(schema: S, value: unknown, stage: string): z.output<S> {
  const decoded = schema.safeParse(value);
  if (!decoded.success) {
    const fields = decoded.error.issues.slice(0, 5).map((issue) => issue.path.join(".") || "record");
    throw new BridgeError("STORE_CORRUPT", `Invalid persisted ${stage}: ${fields.join(", ")}`, { stage });
  }
  return decoded.data;
}
function identity(actual: string, expected: string, stage: string): void {
  if (actual !== expected) throw new BridgeError("STORE_CORRUPT", `Persisted identity mismatch at ${stage}`, { stage });
}

export function decodeRequest(value: unknown, id: string): StoredRequest {
  if (recordObject(value)) version(value.request, [1, 2], "store.request");
  const result = parse(requestRecord, value, "store.request");
  identity(result.task_id, id, "store.request");
  // Complete schema proof above; stored JSON cannot carry optional undefined properties.
  return result as StoredRequest;
}
export function decodeState(value: unknown): TaskState {
  version(value, [], "store.state");
  return parse(taskState, value, "store.state") as TaskState;
}
export function decodeResult(value: unknown, id: string): StoredResult {
  version(value, [1, 2], "store.result");
  const result = parse(storedResult, value, "store.result");
  identity(result.task_id, id, "store.result");
  return result as StoredResult;
}
export function decodeResource(value: unknown, id: string): ResourceRecord {
  version(value, [1], "store.resource");
  const result = parse(resourceRecord, value, "store.resource");
  identity(result.task_id, id, "store.resource");
  return result as ResourceRecord;
}
export function decodeReceipt(value: unknown, id: string, key?: string): FinalizeReceipt {
  version(value, [], "store.receipt");
  if (recordObject(value)) version(value.resource, [1], "store.receipt.resource");
  const result = parse(finalizeReceipt, value, "store.receipt");
  identity(result.operation.task_id, id, "store.receipt.task");
  if (key !== undefined) identity(result.operation.operation_key, key, "store.receipt.key");
  return result as FinalizeReceipt;
}
export function decodeSafety(value: unknown): { reason: string; at: string } {
  version(value, [], "store.safety");
  return parse(safetyRecord, value, "store.safety");
}
