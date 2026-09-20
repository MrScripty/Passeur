import { z } from "zod";

const path = z.string().min(1).max(4096);
export const RuntimeFailureSchema = z.object({
  code: z.string().min(1).max(128), message: z.string().max(2048),
  stage: z.string().max(128).optional(), path: path.optional(),
  native_code: z.string().max(64).optional(), next_action: z.string().max(1024).optional(),
}).strict();
export type RuntimeFailure = z.infer<typeof RuntimeFailureSchema>;

export const RuntimeIdentitySchema = z.object({
  package_version: z.string().min(1).max(128), build_id: z.string().min(1).max(256),
  mode: z.enum(["development", "installed"]), source_revision: z.string().max(128).optional(),
  node_version: z.string().max(128), node_executable: path,
  pid: z.number().int().positive(), started_at: z.string().datetime(),
}).strict();
export type RuntimeIdentity = z.infer<typeof RuntimeIdentitySchema>;

export const RuntimeBindingSchema = z.object({
  project_input: path, profile_path: path.optional(), state_root: path.optional(),
  expected_repository_id: z.string().min(1).max(256).optional(),
  project: path.optional(), repository_id: z.string().min(1).max(256).optional(),
  common_dir: path.optional(), store_root: path.optional(),
}).strict();
export type RuntimeBinding = z.infer<typeof RuntimeBindingSchema>;

export const RuntimeStatusSchema = z.object({
  schema_version: z.literal(1), runtime: RuntimeIdentitySchema, binding: RuntimeBindingSchema,
  coordination: z.object({
    state: z.enum(["idle", "preparing", "ready", "blocked", "frozen", "closing", "closed"]),
    authority: z.enum(["not_acquired", "held", "lost", "released"]),
    checked_at: z.string().datetime().optional(), failure: RuntimeFailureSchema.optional(),
  }).strict(),
  execution: z.object({
    profile: z.enum(["not_checked", "valid", "blocked"]),
    provider: z.literal("not_checked"),
    approval: z.enum(["not_checked", "available", "unavailable"]),
    failure: RuntimeFailureSchema.optional(),
  }).strict(),
}).strict().superRefine((value, ctx) => {
  if (value.coordination.state === "ready" && value.coordination.authority !== "held") {
    ctx.addIssue({ code: "custom", message: "Ready coordination requires held authority" });
  }
});
export type RuntimeStatus = z.infer<typeof RuntimeStatusSchema>;
export const StatusRequestSchema = z.object({}).strict();
export const PrepareRequestSchema = z.object({}).strict();

export const RuntimeManifestSchema = z.object({
  schema_version: z.literal(1), state: z.enum(["candidate", "installed"]), package_name: z.string().min(1), package_version: z.string().min(1),
  build_id: z.string().regex(/^[a-f0-9]{64}$/), source_revision: z.string().regex(/^[a-f0-9]{40,64}$/),
  source_dirty: z.boolean(), lock_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  source_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  build_node: z.string().min(1), build_typescript: z.string().min(1), build_npm: z.string().min(1),
  platform: z.string().min(1), architecture: z.string().min(1),
  cli: z.literal("dist/src/cli.js"),
  dependencies: z.array(z.object({ location: z.string().min(1), name: z.string().min(1), version: z.string().min(1) }).strict()),
  sbom: z.literal("sbom.cdx.json"),
}).strict();
export type RuntimeManifest = z.infer<typeof RuntimeManifestSchema>;
