import { z } from "zod";
import { isAbsolute } from "node:path";
import { RuntimeIdentitySchema, RuntimeStatusSchema } from "./runtime.js";
import { SubmitRequestSchema, SubmitBatchSchema, TasksRequestSchema, WaitRequestSchema, CancelRequestSchema, AttachRequestSchema, TaskLookupSchema, TaskIdSchema, TaskObservationSchema, TaskReceiptSchema, ControlReceiptSchema, PendingInputSchema } from "./tasks.js";
import { AgentCatalogRequestSchema, AgentCatalogSchema } from "./agents.js";
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
/** Every private operation is closed and decoded before the handler receives it. */
export const operationSchemas = {
  status: empty, prepare: empty, agents: AgentCatalogRequestSchema,
  submit: SubmitRequestSchema, submit_batch: SubmitBatchSchema, tasks: TasksRequestSchema, wait: WaitRequestSchema,
  cancel: CancelRequestSchema, attach: AttachRequestSchema,
  input_claim: claim, input_dismiss: claimIdentity, input_answer: answer,
  retained: ResultRequestSchema, finalize: FinalizeRequestSchema,
  structural_report: z.object({ work_id: workId }).strict(),
  structural_detail: z.object({ work_id: workId, report_id: z.string().uuid(), side: z.enum(["input", "observed"]),
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
  submit_batch: z.object({ results: z.array(z.union([z.object({ request_key: z.string(), task: TaskReceiptSchema }).strict(), z.object({ request_key: z.string(), error: FailureSchema }).strict()])).max(144) }).strict(),
  tasks: taskPage, wait, cancel: ControlReceiptSchema, attach: z.object({ receipt: ControlReceiptSchema, task: TaskObservationSchema }).strict(), input_claim: PendingInputSchema,
  input_dismiss: z.object({ kind: z.literal("presentation_released") }).strict(), input_answer: ControlReceiptSchema, retained,
  structural_report: z.object({ schema_version: z.literal(1), work_id: workId,
    reports: z.array(z.object({ report_id: z.string().uuid(), path: z.string().min(1).max(4096), dialect: z.enum(["rust", "typescript", "tsx"]), text: z.string().max(65536) }).strict()).max(4),
    limitations: z.array(z.string().max(256)).max(16) }).strict(),
  structural_detail: z.object({ schema_version: z.literal(1), work_id: workId, report_id: z.string().uuid(), side: z.enum(["input", "observed"]),
    start_byte: z.number().int().nonnegative().safe(), end_byte: z.number().int().nonnegative().safe(),
    content_sha256: z.string().regex(/^[a-f0-9]{64}$/), text: z.string().max(8192) }).strict(),
  finalize: z.object({ results: z.array(z.union([z.object({ task_id: TaskIdSchema, operation_key: z.string(), state: z.string(), resource_state: z.string() }).strict(), z.object({ task_id: TaskIdSchema, operation_key: z.string(), error: FailureSchema }).strict()])).max(8) }).strict(),
  cleanup: z.object({ kind: z.literal("collected") }).strict(), reconcile: z.object({ kind: z.literal("reconciled"), status: ServiceStatusSchema }).strict(),
  stop: z.object({ kind: z.literal("draining"), outstanding: z.boolean() }).strict(),
} as const;
export type Response<K extends Operation> = z.output<(typeof responseSchemas)[K]>;
