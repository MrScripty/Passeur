import { z } from "zod";
import { isAbsolute } from "node:path";
import { RuntimeIdentitySchema, RuntimeStatusSchema } from "./runtime.js";
import { SubmitRequestSchema, SubmitBatchSchema, TasksRequestSchema, WaitRequestSchema, CancelRequestSchema, AttachRequestSchema, TaskLookupSchema, TaskIdSchema, TaskObservationSchema, TaskReceiptSchema, ControlReceiptSchema, PendingInputSchema, AnnouncementReferenceSchema } from "./tasks.js";
import { AssignmentSchema, AgentCatalogRequestSchema, AgentCatalogSchema } from "./agents.js";
import { ResultRequestSchema, FinalizeRequestSchema } from "./index.js";
const absolute = z.string().min(1).max(4096).refine((s) => isAbsolute(s) && !s.includes("\0"));
export const DescriptorSchema = z.object({ protocol: z.literal(1), generation: z.string().uuid(),
  repository_id: z.string().min(1).max(256), state_root: absolute, profile_path: absolute.optional(), endpoint: absolute,
  runtime: RuntimeIdentitySchema, process: z.object({ pid: z.number().int().positive(), boot_id: z.string().min(1).max(128), started: z.string().min(1).max(128) }).strict(),
  token: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type ServiceDescriptor = z.output<typeof DescriptorSchema>;
export const ServiceStatusSchema = z.object({ schema_version: z.literal(1), generation: z.string().uuid(),
  clients: z.number().int().min(0).max(128), admission: z.enum(["open", "draining"]), repository: RuntimeStatusSchema,
}).strict();
export const FrontendStatusSchema = z.object({ schema_version: z.literal(2), frontend: RuntimeIdentitySchema,
  binding: z.object({ project_input: absolute, profile_path: absolute.optional(), state_root: absolute.optional(), expected_repository_id: z.string().optional() }).strict(),
  service: z.discriminatedUnion("state", [
    z.object({ state: z.literal("not_checked") }).strict(),
    z.object({ state: z.literal("connected"), status: ServiceStatusSchema }).strict(),
    z.object({ state: z.literal("unavailable"), code: z.string().min(1).max(128), message: z.string().min(1).max(2048) }).strict(),
  ]),
}).strict();
export type FrontendStatus = z.output<typeof FrontendStatusSchema>;
const empty = z.object({}).strict();
const claim = z.object({ task_id: TaskIdSchema, input_id: TaskIdSchema, control_generation: z.number().int().positive() }).strict();
const claimIdentity = claim.extend({ claim_id: z.string().uuid() });
const answer = claimIdentity.extend({ operation_key: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/), answer: z.string().min(1).max(16_384) });
const workId = z.string().uuid();
const operationKey = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const region = z.object({ kind: z.enum(["file", "subtree"]), path: z.string().min(1).max(4096) }).strict();
export const CoordinatedSubmitSchema = z.discriminatedUnion("kind", [
  z.object({ schema_version: z.literal(2), kind: z.literal("inline"), assignment: AssignmentSchema,
    expected_decision_identity: digest.optional() }).strict(),
  z.object({ schema_version: z.literal(2), kind: z.literal("reference"), announcement: AnnouncementReferenceSchema,
    expected_decision_identity: digest.optional() }).strict(),
]);
export const AnnouncementCreateSchema = z.object({ schema_version: z.literal(1), operation_key: operationKey,
  assignment: AssignmentSchema, readers: z.array(digest).max(16).default([]) }).strict();
export const AnnouncementInspectSchema = z.object({ schema_version: z.literal(1), id: TaskIdSchema }).strict();
export const AnnouncementWithdrawSchema = z.object({ schema_version: z.literal(1), id: TaskIdSchema,
  expected_revision: z.number().int().positive().safe(), operation_key: operationKey }).strict();
const announcementRecord = z.object({ id: TaskIdSchema, owner: digest, revision: z.number().int().positive().safe(),
  state: z.enum(["unresolved", "bound", "linked", "withdrawn"]), payload_ref: TaskIdSchema,
  payload_digest: digest, source_view: absolute, assignment_hash: digest, areas: z.array(region).max(256),
  readers: z.array(digest).max(16), task_id: TaskIdSchema.optional() }).strict();
const announcement = z.object({ schema_version: z.literal(1), record: announcementRecord,
  assignment: AssignmentSchema }).strict();
/** Every private operation is closed and decoded before the handler receives it. */
export const operationSchemas = {
  status: empty, prepare: empty, agents: AgentCatalogRequestSchema,
  submit: SubmitRequestSchema, submit_coordinated: CoordinatedSubmitSchema,
  announce: AnnouncementCreateSchema, announcement: AnnouncementInspectSchema,
  withdraw_announcement: AnnouncementWithdrawSchema, preflight: CoordinatedSubmitSchema,
  submit_batch: SubmitBatchSchema, tasks: TasksRequestSchema, wait: WaitRequestSchema,
  cancel: CancelRequestSchema, attach: AttachRequestSchema,
  input_claim: claim, input_dismiss: claimIdentity, input_answer: answer,
  retained: ResultRequestSchema, finalize: FinalizeRequestSchema,
  structural_report: z.object({ work_id: workId }).strict(),
  structural_detail: z.object({ work_id: workId, report_id: z.string().uuid(), side: z.enum(["input", "observed"]),
    start_byte: z.number().int().nonnegative().safe(), end_byte: z.number().int().nonnegative().safe() }).strict(),
  structural_refresh: z.object({ work_id: workId }).strict(),
  structural_observation_status: z.object({ work_id: workId }).strict(),
  structural_notice_pull: z.object({ cursor: z.number().int().nonnegative().safe() }).strict(),
  structural_notice_ack: z.object({ notice_id: digest }).strict(),
  structural_current: empty,
  structural_artifact_report: z.object({ artifact_id: digest }).strict(),
  structural_artifact_detail: z.object({ artifact_id: digest, side: z.enum(["input", "observed"]),
    start_byte: z.number().int().nonnegative().safe(), end_byte: z.number().int().nonnegative().safe() }).strict(),
  cleanup: z.object({ task_id: TaskIdSchema }).strict(),
  reconcile: z.object({ task_id: TaskIdSchema, owner: z.string().min(1).max(256), reason: z.string().min(1).max(2048) }).strict(),
  stop: z.object({ cancel_tasks: z.array(TaskIdSchema).max(144).default([]), operation_key: z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/) }).strict(),
} as const;
export type Operation = keyof typeof operationSchemas;
export type Arguments<K extends Operation> = z.output<(typeof operationSchemas)[K]>;
export const FailureSchema = z.object({ code: z.string().min(1).max(128), message: z.string().min(1).max(2048) }).strict();
const receipt = z.object({ kind: z.literal("accepted"), task: TaskObservationSchema }).strict();
const taskPage = z.object({ total: z.number().int().min(0), offset: z.number().int().min(0), next_offset: z.number().int().min(0).nullable(), tasks: z.array(TaskObservationSchema).max(16) }).strict();
const wait = z.object({ kind: z.enum(["changed", "terminal", "input_required", "wait_elapsed"]), task: TaskObservationSchema }).strict();
// Retained JSON is an encoded, bounded view of already-decoded store authority, not execution permission.
const retained = z.object({ task_id: TaskIdSchema, offset: z.number().int().min(0), bytes: z.number().int().min(0).max(8192), next_offset: z.number().int().min(0), eof: z.boolean(), encoding: z.enum(["utf8", "base64"]), content: z.string().max(24_576) }).strict();
export const responseSchemas = {
  status: ServiceStatusSchema, prepare: ServiceStatusSchema, agents: AgentCatalogSchema, submit: receipt,
  submit_coordinated: receipt, announce: announcement, announcement,
  withdraw_announcement: announcementRecord,
  preflight: z.object({ schema_version: z.literal(1), decision_identity: digest,
    overlaps: z.array(z.object({ kind: z.enum(["work", "announcement", "binding"]), id: TaskIdSchema,
      areas: z.array(region).max(256) }).strict()).max(256) }).strict(),
  submit_batch: z.object({ results: z.array(z.union([z.object({ request_key: z.string(), task: TaskReceiptSchema }).strict(), z.object({ request_key: z.string(), error: FailureSchema }).strict()])).max(144) }).strict(),
  tasks: taskPage, wait, cancel: ControlReceiptSchema, attach: z.object({ receipt: ControlReceiptSchema, task: TaskObservationSchema }).strict(), input_claim: PendingInputSchema,
  input_dismiss: z.object({ kind: z.literal("presentation_released") }).strict(), input_answer: ControlReceiptSchema, retained,
  structural_report: z.object({ schema_version: z.literal(1), work_id: workId,
    reports: z.array(z.object({ report_id: z.string().uuid(), path: z.string().min(1).max(4096), dialect: z.enum(["rust", "typescript", "tsx", "javascript", "jsx", "python", "lua", "kotlin", "zig", "csharp", "c", "cpp", "odin", "svelte5"]), text: z.string().max(65536) }).strict()).max(4),
    limitations: z.array(z.string().max(256)).max(16) }).strict(),
  structural_detail: z.object({ schema_version: z.literal(1), work_id: workId, report_id: z.string().uuid(), side: z.enum(["input", "observed"]),
    start_byte: z.number().int().nonnegative().safe(), end_byte: z.number().int().nonnegative().safe(),
    content_sha256: z.string().regex(/^[a-f0-9]{64}$/), text: z.string().max(8192) }).strict(),
  structural_refresh: z.object({ schema_version: z.literal(1), work_id: workId, workspace_id: z.string().min(1).max(4096),
    generation: z.number().int().nonnegative().safe(), capture_id: z.string().uuid(),
    status: z.enum(["published", "unchanged", "incomplete", "superseded"]), limitations: z.array(z.string().max(256)).max(32) }).strict(),
  structural_observation_status: z.object({ schema_version: z.literal(1), work_id: workId,
    state: z.enum(["disabled", "incomplete", "observed", "not_attached"]),
    capacity_omitted_count: z.number().int().nonnegative().safe(),
    limitations: z.array(z.string().max(256)).max(32) }).strict(),
  structural_notice_pull: z.object({ schema_version: z.literal(1), cursor: z.number().int().nonnegative().safe(), gap: z.boolean(),
    notices: z.array(z.object({ schema_version: z.literal(1), sequence: z.number().int().positive(), id: digest,
      recipient: digest, work_id: workId, work_revision: z.number().int().positive(), artifact_id: digest,
      workspace_generation: z.number().int().positive(), control_generation: z.number().int().positive().nullable(),
      materiality: digest, subject_id: digest.optional(), correspondence_state: z.enum(["overlap", "resolved"]).optional(), acknowledged: z.boolean() }).strict()).max(32),
    current: z.array(z.object({ schema_version: z.literal(1), sequence: z.number().int().positive(), id: digest,
      recipient: digest, work_id: workId, work_revision: z.number().int().positive(), artifact_id: digest,
      workspace_generation: z.number().int().positive(), control_generation: z.number().int().positive().nullable(),
      materiality: digest, subject_id: digest.optional(), correspondence_state: z.enum(["overlap", "resolved"]).optional(), acknowledged: z.boolean() }).strict()).max(32) }).strict(),
  structural_notice_ack: z.object({ schema_version: z.literal(1), sequence: z.number().int().positive(), id: digest,
    recipient: digest, work_id: workId, work_revision: z.number().int().positive(), artifact_id: digest,
    workspace_generation: z.number().int().positive(), control_generation: z.number().int().positive().nullable(),
    materiality: digest, subject_id: digest.optional(), correspondence_state: z.enum(["overlap", "resolved"]).optional(), acknowledged: z.boolean() }).strict(),
  structural_current: z.object({ schema_version: z.literal(1), reports: z.array(z.object({ id: digest,
    work_id: workId, work_revision: z.number().int().positive(), path: z.string().min(1).max(4096),
    workspace_generation: z.number().int().positive(), control_generation: z.number().int().positive().nullable(),
    materiality: digest }).strict()).max(16) }).strict(),
  structural_artifact_report: z.object({ id: digest, work_id: workId, text: z.string().max(65536) }).strict(),
  structural_artifact_detail: z.object({ id: digest, side: z.enum(["input", "observed"]), text: z.string().max(24576) }).strict(),
  finalize: z.object({ results: z.array(z.union([z.object({ task_id: TaskIdSchema, operation_key: z.string(), state: z.string(), resource_state: z.string() }).strict(), z.object({ task_id: TaskIdSchema, operation_key: z.string(), error: FailureSchema }).strict()])).max(8) }).strict(),
  cleanup: z.object({ kind: z.literal("collected") }).strict(), reconcile: z.object({ kind: z.literal("reconciled"), status: ServiceStatusSchema }).strict(),
  stop: z.object({ kind: z.literal("draining"), outstanding: z.boolean() }).strict(),
} as const;
export type Response<K extends Operation> = z.output<(typeof responseSchemas)[K]>;
