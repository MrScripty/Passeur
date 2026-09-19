import { z } from "zod";

const bounded = (max: number) => z.string().trim().min(1).max(max);
const relativePath = bounded(4096).refine(
  (value) => !value.startsWith("/") && !value.split(/[\\/]/).includes(".."),
  "must be a project-relative path without traversal",
);

export const DelegateRequestSchema = z.object({
  schema_version: z.literal(1),
  request_key: bounded(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  mode: z.enum(["review", "implement"]),
  objective: bounded(16_384),
  context: z.string().max(32_768),
  acceptance_criteria: z.array(bounded(2048)).min(1).max(50),
  context_files: z.array(relativePath).max(50).optional(),
  allowed_paths: z.array(relativePath).max(50).optional(),
  base_commit: z.string().regex(/^[0-9a-fA-F]{40,64}$/).optional(),
}).strict().superRefine((value, context) => {
  if (value.mode === "implement" && !value.base_commit) {
    context.addIssue({ code: "custom", path: ["base_commit"], message: "required for implement mode" });
  }
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 65_536) {
    context.addIssue({ code: "custom", message: "assignment envelope exceeds 64 KiB" });
  }
});

export type DelegateRequest = z.infer<typeof DelegateRequestSchema>;
export type ExecutionStatus = "completed" | "blocked" | "failed" | "cancelled" | "timed_out" | "interrupted";
export type WorkerStop = "confirmed" | "unconfirmed" | "not_started";

export type DelegateResult = {
  schema_version: 1;
  task_id: string;
  request_key: string;
  execution_status: ExecutionStatus;
  worker_stop: WorkerStop;
  worker_assessment: "met" | "partial" | "unmet" | "unknown";
  summary: string;
  blockers: string[];
  error?: { code: string; message: string };
  questions: string[];
  model: { requested: string; reported?: string };
  workspace: { kind: "source_read_only" | "task_worktree"; base_commit?: string; worktree_path?: string; stale: boolean };
  changed_files: string[];
  checks: Array<{ command: string; cwd: string; exit_code: number | null; evidence: "runtime_observed" | "bridge_observed" | "worker_reported"; artifact_id?: string }>;
  artifacts: Array<{ id: string; kind: "report" | "diff" | "manifest" | "log"; path: string; bytes: number }>;
  output_truncated: boolean;
};

export const ResultRequestSchema = z.object({
  task_id: z.string().uuid().optional(),
  request_key: bounded(128).optional(),
  section: z.enum(["result", "log"]).optional(),
  artifact_id: bounded(128).optional(),
  encoding: z.enum(["utf8", "base64"]).default("utf8"),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(24_576).default(24_576),
}).strict()
  .refine((value) => Number(Boolean(value.task_id)) + Number(Boolean(value.request_key)) === 1, "supply exactly one task_id or request_key")
  .refine((value) => !(value.section && value.artifact_id), "supply section or artifact_id, not both");

export type ResultRequest = z.infer<typeof ResultRequestSchema>;

export const ProfileSchema = z.object({
  schema_version: z.literal(1),
  muse_bin: z.string().min(1),
  model: z.string().min(1).max(256),
  review: z.object({ disable_write: z.literal(true), disable_shell: z.literal(true), sandbox_network: z.enum(["restricted", "proxy-only"]) }).strict(),
  implementation: z.object({ enabled: z.boolean(), worktree_root: z.string().min(1).optional(), sandbox_network: z.enum(["restricted", "proxy-only", "enabled"]) }).strict(),
  task_timeout_ms: z.number().int().min(60_000).max(86_400_000).default(1_800_000),
  stop_grace_ms: z.number().int().min(1_000).max(120_000).default(60_000),
  subscription: z.object({ provenance: z.enum(["user_confirmed", "provider_verified", "unverified"]), verified_at: z.string().datetime().optional(), note: z.string().max(2048).optional() }).strict(),
}).strict();

export type Profile = z.infer<typeof ProfileSchema>;
