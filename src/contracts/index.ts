import { z } from "zod";
export * from "./types.js";
const bounded = (max: number) => z.string().trim().min(1).max(max);
const oid = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i, "a full Git object ID is required");
const branch = bounded(512).startsWith("refs/heads/");
const key = bounded(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const relativePath = bounded(4096).refine((value) => !value.startsWith("/") && !value.includes("\0") && !value.split(/[\\/]/).includes(".."), "must be a project-relative path without traversal");
export const DelegateRequestSchema = z.object({
  schema_version: z.literal(2), request_key: key, mode: z.enum(["review", "implement"]),
  objective: bounded(16_384), context: z.string().max(32_768),
  acceptance_criteria: z.array(bounded(2048)).min(1).max(50),
  context_files: z.array(relativePath).max(50).optional(), allowed_paths: z.array(relativePath).max(50).optional(),
  base_commit: oid.optional(), target_ref: branch.optional(),
}).strict().superRefine((value, context) => {
  if (value.mode === "implement") for (const field of ["base_commit", "target_ref"] as const) {
    if (!value[field]) context.addIssue({ code: "custom", path: [field], message: "required for implement mode" });
  }
  if (Buffer.byteLength(JSON.stringify(value)) > 65_536) context.addIssue({ code: "custom", message: "assignment envelope exceeds 64 KiB" });
});
export const BatchRequestSchema = z.object({ schema_version: z.literal(2), assignments: z.array(DelegateRequestSchema).min(1).max(8) }).strict().superRefine((value, context) => {
  if (new Set(value.assignments.map((item) => item.request_key)).size !== value.assignments.length) context.addIssue({ code: "custom", message: "duplicate request keys in batch" });
  if (Buffer.byteLength(JSON.stringify(value)) > 262_144) context.addIssue({ code: "custom", message: "batch exceeds 256 KiB" });
});
export const ResultRequestSchema = z.object({
  task_id: z.string().uuid().optional(), request_key: key.optional(), section: z.enum(["result", "log"]).optional(),
  artifact_id: bounded(128).optional(), encoding: z.enum(["utf8", "base64"]).default("utf8"),
  offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(8192).default(8192),
}).strict().refine((value) => Number(Boolean(value.task_id)) + Number(Boolean(value.request_key)) === 1, "supply exactly one task_id or request_key")
  .refine((value) => !(value.section && value.artifact_id), "supply section or artifact_id, not both");
export const FinalizeOperationSchema = z.object({
  operation_key: key, task_id: z.string().uuid(), expected_head: oid, expected_branch_ref: branch,
  disposition: z.enum(["integrated", "retained", "archived"]), target_ref: branch.optional(), accepted_commit: oid.optional(),
  owner: bounded(256).optional(), reason: bounded(2048).optional(), next_action: bounded(2048).optional(),
  archive_authorized: z.boolean().optional(), cleanup_authorized: z.boolean().optional(),
}).strict().superRefine((value, context) => {
  if (value.disposition === "retained" && (!value.owner || !value.reason || !value.next_action)) context.addIssue({ code: "custom", message: "retention requires owner, reason and next_action" });
  if (value.disposition !== "retained" && value.cleanup_authorized !== true) context.addIssue({ code: "custom", message: "retirement requires cleanup_authorized: true" });
  if (value.disposition === "archived" && value.archive_authorized !== true) context.addIssue({ code: "custom", message: "archiving requires archive_authorized: true" });
  if (value.disposition === "integrated" && (!value.target_ref || !value.accepted_commit)) context.addIssue({ code: "custom", message: "integration evidence requires target_ref and accepted_commit" });
});
export const FinalizeRequestSchema = z.object({ schema_version: z.literal(2), operations: z.array(FinalizeOperationSchema).min(1).max(8) }).strict();
export const ProfileSchema = z.object({
  schema_version: z.literal(1), muse_bin: bounded(4096), model: bounded(256),
  review: z.object({ disable_write: z.literal(true), disable_shell: z.literal(true), sandbox_network: z.enum(["restricted", "proxy-only"]) }).strict(),
  implementation: z.object({ enabled: z.boolean(), worktree_root: bounded(4096).optional(), sandbox_network: z.enum(["restricted", "proxy-only", "enabled"]) }).strict(),
  task_timeout_ms: z.number().int().min(60_000).max(86_400_000).default(1_800_000),
  stop_grace_ms: z.number().int().min(1_000).max(120_000).default(60_000),
  max_workers: z.number().int().min(1).max(16).default(2), max_queued_tasks: z.number().int().min(0).max(128).default(8),
  subscription: z.object({ provenance: z.enum(["user_confirmed", "provider_verified", "unverified"]), verified_at: z.string().datetime().optional(), note: z.string().max(2048).optional() }).strict(),
}).strict();
