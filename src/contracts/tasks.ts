import { z } from "zod";
import { isAbsolute } from "node:path";
import { AssignmentSchema, AgentRegistrationSchema, SafeConfigurationSchema, AgentIdSchema } from "./agents.js";
import type { DelegateResult } from "./types.js";

const key = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const path = z.string().min(1).max(4096).refine((s) => isAbsolute(s) && !s.includes("\0"), "absolute path required");
const instant = z.string().datetime();
export const TaskIdSchema = z.string().uuid();
export const LifecyclePolicySchema = z.object({
  stop_grace_ms: z.number().int().min(1000).max(120_000).default(60_000),
  max_workers: z.number().int().min(1).max(16).default(2),
  max_queued_tasks: z.number().int().min(0).max(128).default(8),
  max_clients: z.number().int().min(1).max(128).default(32),
  max_waiters: z.number().int().min(1).max(512).default(128),
  max_pending_inputs: z.number().int().min(1).max(64).default(16),
  max_control_receipts: z.number().int().min(16).max(4096).default(512),
  implementation: z.object({ enabled: z.boolean(), worktree_root: path.optional() }).strict(),
}).strict();
export type LifecyclePolicy = z.output<typeof LifecyclePolicySchema>;
export const SharedProfileSchema = z.object({
  schema_version: z.literal(3), execution: LifecyclePolicySchema,
  agents: z.array(AgentRegistrationSchema).max(32),
}).strict().refine((p) => new Set(p.agents.map((a) => a.agent_id)).size === p.agents.length, "duplicate agent IDs")
  .refine((p) => Buffer.byteLength(JSON.stringify(p)) <= 65_536, "profile exceeds 64 KiB");
export type SharedProfile = z.output<typeof SharedProfileSchema>;
export const LifecycleSnapshotSchema = z.object({
  schema_version: z.literal(2), agent_id: AgentIdSchema, adapter_id: AgentIdSchema,
  adapter_contract: z.string().min(1).max(256), configuration: SafeConfigurationSchema,
  configuration_fingerprint: hash, requested_model: z.string().min(1).max(256).optional(),
  policy: LifecyclePolicySchema,
}).strict();
export type LifecycleSnapshot = z.output<typeof LifecycleSnapshotSchema>;
export const SubmitRequestSchema = z.object({ schema_version: z.literal(1), assignment: AssignmentSchema }).strict();
export const SubmitBatchSchema = z.object({ schema_version: z.literal(1), assignments: z.array(AssignmentSchema).min(1).max(144) }).strict()
  .refine((r) => new Set(r.assignments.map((a) => a.request_key)).size === r.assignments.length, "duplicate keys")
  .refine((r) => Buffer.byteLength(JSON.stringify(r)) <= 262_144, "batch exceeds 256 KiB")
  // Reserve the worst bounded receipt/error projection before any assignment can be admitted.
  .refine((r) => r.assignments.reduce((n, a) => n + Math.max(
      Buffer.byteLength(JSON.stringify({ request_key: a.request_key, task: { schema_version: 1, task_id: "f".repeat(36), request_key: a.request_key,
        agent_id: a.agent_id, revision: Number.MAX_SAFE_INTEGER, control_generation: Number.MAX_SAFE_INTEGER, phase: "needs_attention" } })),
      Buffer.byteLength(JSON.stringify({ request_key: a.request_key, error: { code: "E".repeat(96), message: "E".repeat(128) } }))) + 1, 32) <= 18_000,
    "batch receipt would exceed its response budget; submit smaller independent batches");
export const SubmissionIdentitySchema = z.object({ schema_version: z.literal(1), source_view: path, assignment: AssignmentSchema }).strict();
export type SubmissionIdentity = z.output<typeof SubmissionIdentitySchema>;
export const AnnouncementReferenceSchema = z.object({ id: TaskIdSchema, revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();
export const CoordinatedSubmissionIdentitySchema = z.object({
  schema_version: z.literal(2), source_view: path, assignment: AssignmentSchema,
  announcement: AnnouncementReferenceSchema.optional(), expected_decision_identity: hash.optional(),
}).strict();
export type CoordinatedSubmissionIdentity = z.output<typeof CoordinatedSubmissionIdentitySchema>;
export function coordinatedMaterialIdentity(value: CoordinatedSubmissionIdentity): Omit<CoordinatedSubmissionIdentity, "expected_decision_identity"> {
  const { expected_decision_identity: _gate, ...material } = value;
  return material;
}
export const CoordinatedLinkSchema = z.object({
  schema_version: z.literal(1), task_id: TaskIdSchema, request_key: key, owner_id: hash,
  intent_hash: hash, decision_identity: hash, link_hash: hash, announcement: AnnouncementReferenceSchema.optional(),
}).strict();
export type CoordinatedLink = z.output<typeof CoordinatedLinkSchema>;
export const CoordinatedLinkSettlementSchema = z.object({ schema_version: z.literal(1), link: CoordinatedLinkSchema,
  state: z.literal("settled"), settled_at: instant }).strict();
export type CoordinatedLinkSettlement = z.output<typeof CoordinatedLinkSettlementSchema>;
export const DurableRequestSchema = z.object({
  schema_version: z.literal(4), task_id: TaskIdSchema, project_id: z.string().min(1).max(256),
  canonical_hash: hash, accepted_at: instant, request: AssignmentSchema,
  source_view: path, initial_owner: hash, execution: LifecycleSnapshotSchema,
}).strict();
export type DurableRequest = z.output<typeof DurableRequestSchema>;
export const CoordinatedDurableRequestSchema = DurableRequestSchema.omit({ schema_version: true }).extend({ schema_version: z.literal(5),
  linkage: CoordinatedLinkSchema });
export type CoordinatedDurableRequest = z.output<typeof CoordinatedDurableRequestSchema>;
export type CurrentDurableRequest = DurableRequest | CoordinatedDurableRequest;
export const AnnouncementPayloadSchema = z.object({
  schema_version: z.literal(1), id: TaskIdSchema, revision: z.literal(1), owner_id: hash,
  source_view: path, assignment: AssignmentSchema, published_at: instant,
}).strict().refine((v) => Buffer.byteLength(JSON.stringify(v)) <= 262_144, "announcement exceeds 256 KiB");
export type AnnouncementPayload = z.output<typeof AnnouncementPayloadSchema>;
export const AnnouncementControlSchema = z.object({ schema_version: z.literal(1), id: TaskIdSchema,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  state: z.enum(["unresolved", "withdrawn", "linked"]),
  task_id: TaskIdSchema.optional(), updated_at: instant,
}).strict().superRefine((v,c) => {
  if ((v.state === "linked") !== (v.task_id !== undefined)) c.addIssue({ code: "custom", message: "linked announcement requires exact task" });
});
export type AnnouncementControl = z.output<typeof AnnouncementControlSchema>;
export const ApprovalDataSchema = z.object({
  id: z.string().min(1).max(256), tool: z.string().min(1).max(256), raw_args: z.string().max(16_384),
  subject: z.record(z.string(), z.unknown()).refine((v) => Buffer.byteLength(JSON.stringify(v)) <= 8192, "input subject exceeds 8 KiB"),
  task_id: z.string().optional(), workspace: z.string().optional(),
  choices: z.array(z.object({ id: z.string().min(1).max(256), label: z.string().max(512),
    decision: z.string().min(1).max(128), scope: z.string().min(1).max(128) }).strict()).min(1).max(16),
}).strict().refine((r) => new Set(r.choices.map((c) => c.id)).size === r.choices.length, "duplicate choices");
export const InputDataSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("permission"), approval: ApprovalDataSchema }).strict(),
  z.object({ kind: z.literal("clarification"), question: z.string().min(1).max(8192), choices: z.array(z.string().min(1).max(256)).min(1).max(16).optional(), attention: z.boolean().default(false) }).strict(),
]);
export type InputData = z.output<typeof InputDataSchema>;
export const PendingInputSchema = z.object({
  input_id: TaskIdSchema, native_id: z.string().min(1).max(256), run_id: TaskIdSchema, turn_id: z.string().min(1).max(256),
  data: InputDataSchema, digest: hash, revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  state: z.enum(["pending", "answer_intent", "settled", "withdrawn", "delivery_unknown"]),
  claim: z.object({ id: TaskIdSchema, client_id: TaskIdSchema, control_generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict().optional(),
  answer: z.string().max(16_384).optional(), operation_key: key.optional(),
}).strict().superRefine((v, c) => {
  if ((v.state === "answer_intent" || v.state === "settled" || v.state === "delivery_unknown") && (v.answer === undefined || !v.operation_key)) c.addIssue({ code: "custom", message: "answer state lacks intent" });
  if (v.claim && v.state !== "pending") c.addIssue({ code: "custom", message: "claim on nonpending input" });
});
export type PendingInput = z.output<typeof PendingInputSchema>;
export const NativeEvidenceSchema = z.object({
  run_id: TaskIdSchema, state: z.enum(["not_started", "observed_live", "stopped", "unknown"]),
  turn_id: z.string().min(1).max(256).optional(),
  process: z.object({ pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), boot_id: z.string().min(1).max(128), started: z.string().min(1).max(128) }).strict().optional(),
  obligations: z.array(z.object({ id: z.string().min(1).max(256), kind: z.string().min(1).max(128) }).strict()).max(256),
  coverage: z.enum(["unknown", "turn_scoped"]),
  last_observed_at: instant.optional(), limitation: z.string().max(1024).optional(),
}).strict();
export type NativeEvidence = z.output<typeof NativeEvidenceSchema>;
export const ControlReceiptSchema = z.object({
  operation_key: key, hash, kind: z.enum(["cancel", "input", "attach"]),
  outcome: z.enum(["accepted", "already_terminal", "answer_intent", "adopted"]),
  at: instant, input_id: TaskIdSchema.optional(), generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();
export type ControlReceipt = z.output<typeof ControlReceiptSchema>;
export const TaskControlSchema = z.object({
  schema_version: z.literal(2), task_id: TaskIdSchema, revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  owner_id: hash, control_generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  phase: z.enum(["queued", "starting", "active", "awaiting_input", "needs_attention", "stopping", "finalizing", "terminal"]),
  outcome: z.enum(["completed", "blocked", "failed", "cancelled", "interrupted"]).optional(),
  updated_at: instant, native: NativeEvidenceSchema,
  inputs: z.array(PendingInputSchema).max(4096), receipts: z.array(ControlReceiptSchema).max(4096),
  cancel: z.object({ reason: z.string().min(1).max(2048), at: instant, operation_key: key }).strict().optional(),
  settled_outcome: z.enum(["completed", "blocked", "failed", "cancelled", "interrupted"]).optional(),
  attention: z.string().max(2048).optional(), telemetry_omitted: z.boolean().default(false),
}).strict().superRefine((v, c) => {
  if ((v.phase === "terminal") !== (v.outcome !== undefined)) c.addIssue({ code: "custom", message: "terminal phase/outcome mismatch" });
  if (v.outcome === "completed" && v.cancel) c.addIssue({ code: "custom", message: "cancelled task cannot complete" });
  if (new Set(v.inputs.map((i) => i.input_id)).size !== v.inputs.length || new Set(v.receipts.map((r) => r.operation_key)).size !== v.receipts.length) c.addIssue({ code: "custom", message: "duplicate control identities" });
  if (v.inputs.some((i) => i.run_id !== v.native.run_id || i.revision > v.revision || i.claim && i.claim.control_generation !== v.control_generation)) c.addIssue({ code: "custom", message: "stale native or control generation" });
  if (v.phase === "terminal" && v.inputs.some((i) => i.state === "pending" || i.state === "answer_intent" || i.state === "delivery_unknown")) c.addIssue({ code: "custom", message: "terminal input obligation unresolved" });
});
export type TaskControl = z.output<typeof TaskControlSchema>;
export type LifecycleResult = Omit<DelegateResult, "schema_version" | "model" | "execution_status"> & {
  schema_version: 4; execution_status: "completed" | "blocked" | "failed" | "cancelled" | "interrupted";
  identity: { status: "admitted"; snapshot: LifecycleSnapshot }; model: { requested?: string; reported?: string };
  native_evidence: NativeEvidence;
};
export const NativeObservationSchema = NativeEvidenceSchema.omit({ obligations: true }).extend({
  obligations: NativeEvidenceSchema.shape.obligations.max(4), obligations_count: z.number().int().min(0).max(256),
  obligations_truncated: z.boolean(),
});
export const TaskObservationSchema = z.object({
  schema_version: z.literal(1), task_id: TaskIdSchema, request_key: key, agent_id: AgentIdSchema,
  source_view: path, revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), control_generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  phase: TaskControlSchema.shape.phase, outcome: TaskControlSchema.shape.outcome,
  native: NativeObservationSchema, updated_at: instant,
  inputs: z.array(z.object({ input_id: TaskIdSchema, kind: z.enum(["permission", "clarification"]), state: PendingInputSchema.shape.state, summary: z.string().max(512) }).strict()).max(8), inputs_count: z.number().int().min(0).max(4096),
  attention: z.string().max(2048).optional(), telemetry_omitted: z.boolean(),
}).strict();
export const TaskReceiptSchema = TaskObservationSchema.pick({ schema_version: true, task_id: true, request_key: true, agent_id: true, revision: true, control_generation: true, phase: true });
export type TaskObservation = z.output<typeof TaskObservationSchema>;
export function taskReceipt(value: TaskObservation): z.output<typeof TaskReceiptSchema> {
  const { schema_version, task_id, request_key, agent_id, revision, control_generation, phase } = value;
  return { schema_version, task_id, request_key, agent_id, revision, control_generation, phase };
}
export const TaskLookupSchema = z.object({ task_id: TaskIdSchema.optional(), request_key: key.optional() }).strict()
  .refine((v) => Number(!!v.task_id) + Number(!!v.request_key) === 1, "supply exactly one task identity");
export const WaitRequestSchema = z.object({ schema_version: z.literal(1), task_id: TaskIdSchema,
  after_revision: z.number().int().min(0).default(0), wait_ms: z.number().int().min(0).max(60_000).default(20_000) }).strict();
export const TasksRequestSchema = z.object({ schema_version: z.literal(1), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(16).default(8), request_key: key.optional() }).strict();
export const CancelRequestSchema = z.object({ schema_version: z.literal(1), task_id: TaskIdSchema, operation_key: key, reason: z.string().min(1).max(2048), control_generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();
export const AttachRequestSchema = z.object({ schema_version: z.literal(1), task_id: TaskIdSchema.optional(), request_key: key.optional(), operation_key: key }).strict()
  .refine((v) => Number(!!v.task_id) + Number(!!v.request_key) === 1, "supply exactly one task identity");
// MCP tool schemas require an object root. The cross-field rule forbids a model-supplied permission answer.
export const InputRequestSchema = z.object({
  schema_version: z.literal(1), kind: z.enum(["permission", "clarification"]), task_id: TaskIdSchema, input_id: TaskIdSchema,
  operation_key: key, control_generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), answer: z.string().min(1).max(16_384).optional(),
}).strict().superRefine((r, context) => {
  if (r.kind === "permission" && r.answer !== undefined) context.addIssue({ code: "custom", path: ["answer"], message: "Permission must be elicited from the human, not supplied as a tool argument" });
});
