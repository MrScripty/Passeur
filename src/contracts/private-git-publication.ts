import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { canonicalHash } from "../core/async.js";

const path = z.string().min(1).max(4096).refine((value) => isAbsolute(value) && !value.includes("\0") &&
  !value.split(/[\\/]/).some((component) => component === "." || component === ".."));
const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const key = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const uuid = z.string().uuid();

/** Exact immutable input to one task-owned canonical Git publication. */
export const PrivatePublicationRequestSchema = z.object({
  schema_version: z.literal(1), operation_key: key, task_id: uuid, request_key: key,
  run_id: uuid, control_generation: z.number().int().positive(), source_view: path,
  workspace: z.object({ path, branch: z.string().regex(/^refs\/heads\/muse-bridge\/[0-9a-f-]+$/), base_commit: oid }).strict(),
  view: z.object({ private_common_dir: path, canonical_common_dir: path, admin_relative: z.string().regex(/^worktrees\/[A-Za-z0-9][A-Za-z0-9._-]*$/),
    baseline_index_sha256: digest }).strict(),
  publication: z.object({ old_head: oid, new_head: oid, tree_oid: oid, old_index_sha256: digest,
    new_index_sha256: digest, quarantine_config_sha256: digest, quarantine_exclude_sha256: digest,
    quarantine_path: path, canonical_admin_path: path }).strict(),
}).strict().superRefine((value, context) => {
  if (value.workspace.base_commit !== value.publication.old_head ||
      value.view.baseline_index_sha256 !== value.publication.old_index_sha256 ||
      join(value.view.canonical_common_dir, value.view.admin_relative) !== value.publication.canonical_admin_path) {
    context.addIssue({ code: "custom", message: "Private publication preconditions disagree" });
  }
});
export type PrivatePublicationRequest = z.output<typeof PrivatePublicationRequestSchema>;

export const PrivatePublicationRecordSchema = z.object({
  schema_version: z.literal(1), request: PrivatePublicationRequestSchema, request_hash: digest,
  state: z.enum(["intent", "published"]), created_at: z.string().datetime(), settled_at: z.string().datetime().optional(),
}).strict().superRefine((value, context) => {
  if (value.request_hash !== canonicalHash(value.request) || (value.state === "published") !== (value.settled_at !== undefined)) {
    context.addIssue({ code: "custom", message: "Private publication record contradicts its request or settlement" });
  }
});
export type PrivatePublicationRecord = z.output<typeof PrivatePublicationRecordSchema>;
