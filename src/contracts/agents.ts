import { z } from "zod";
import { AssignmentBodySchema, ProfileSchema } from "./index.js";
import type { DelegateRequest, DelegateResult } from "./types.js";

export const AgentIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const AssignmentSchema = AssignmentBodySchema.safeExtend({ schema_version: z.literal(3), agent_id: AgentIdSchema });
export type Assignment = z.output<typeof AssignmentSchema>;
export const AgentBatchSchema = z.object({ schema_version: z.literal(3), assignments: z.array(AssignmentSchema).min(1).max(8) }).strict()
  .refine((value) => new Set(value.assignments.map((item) => item.request_key)).size === value.assignments.length, "duplicate request keys")
  .refine((value) => Buffer.byteLength(JSON.stringify(value)) <= 262_144, "batch exceeds 256 KiB");

// Shared scheduling and workspace policy retain the established units, limits and defaults.
export const ExecutionPolicySchema = ProfileSchema.pick({ task_timeout_ms: true, stop_grace_ms: true, max_workers: true, max_queued_tasks: true })
  .extend({ implementation: ProfileSchema.shape.implementation.omit({ sandbox_network: true }) });
export type ExecutionPolicy = z.output<typeof ExecutionPolicySchema>;
export const AgentRegistrationSchema = z.object({
  agent_id: AgentIdSchema, adapter_id: AgentIdSchema, description: z.string().max(512).default(""), enabled: z.boolean().default(true),
  modes: z.array(z.enum(["review", "implement"])).min(1).max(2).optional(), options: z.unknown(),
}).strict().refine((r) => r.options !== undefined, "adapter options are required")
  .refine((r) => !r.modes || new Set(r.modes).size === r.modes.length, "duplicate modes");
export type AgentRegistration = z.output<typeof AgentRegistrationSchema>;
export const AgentProfileSchema = z.object({
  schema_version: z.literal(2), execution: ExecutionPolicySchema, agents: z.array(AgentRegistrationSchema).max(32),
}).strict().refine((p) => new Set(p.agents.map((a) => a.agent_id)).size === p.agents.length, "duplicate agent IDs")
  .refine((p) => Buffer.byteLength(JSON.stringify(p)) <= 65_536, "profile exceeds 64 KiB");
export type AgentProfile = z.output<typeof AgentProfileSchema>;

// Only adapter-selected, non-secret primitive configuration enters durable identity.
export const SafeConfigurationSchema = z.record(z.string().min(1).max(128), z.union([z.string().max(4096), z.number().finite(), z.boolean(), z.null()]))
  .refine((c) => Object.keys(c).length <= 32 && Buffer.byteLength(JSON.stringify(c)) <= 8192, "execution configuration exceeds its bound");
export const ExecutionSnapshotSchema = z.object({
  schema_version: z.literal(1), agent_id: AgentIdSchema, adapter_id: AgentIdSchema,
  adapter_contract: z.string().min(1).max(256), configuration: SafeConfigurationSchema,
  configuration_fingerprint: z.string().regex(/^[a-f0-9]{64}$/), requested_model: z.string().min(1).max(256).optional(),
  policy: ExecutionPolicySchema,
}).strict();
export type ExecutionSnapshot = z.output<typeof ExecutionSnapshotSchema>;
export type SafeConfiguration = z.output<typeof SafeConfigurationSchema>;
export const ExecutionIdentitySchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("admitted"), snapshot: ExecutionSnapshotSchema }).strict(),
  z.object({ status: z.literal("unavailable"), source_schema_version: z.union([z.literal(1), z.literal(2)]), reason: z.string().min(1).max(1024) }).strict(),
]);
export type AgentResult = Omit<DelegateResult, "schema_version" | "model"> & {
  schema_version: 3;
  identity: z.output<typeof ExecutionIdentitySchema>;
  model: { requested?: string; reported?: string };
};
export const AgentCatalogRequestSchema = z.object({ offset: z.number().int().min(0).max(32).default(0), limit: z.number().int().min(1).max(4).default(4) }).strict();
export type AgentCatalogRequest = z.output<typeof AgentCatalogRequestSchema>;
export const AgentCatalogSchema = z.object({
  schema_version: z.literal(1), checked_at: z.string().datetime(),
  configuration: z.enum(["observed", "fixed_for_runtime"]),
  total: z.number().int().min(0).max(32), offset: z.number().int().min(0).max(32), next_offset: z.number().int().min(0).max(32).nullable(),
  agents: z.array(z.object({
    agent_id: AgentIdSchema, adapter_id: AgentIdSchema, description: z.string().max(512),
    modes: z.array(z.enum(["review", "implement"])).max(2),
    state: z.enum(["configured", "disabled", "invalid", "unsupported", "unavailable"]),
    runtime_readiness: z.literal("not_checked"),
    limitation: z.string().max(512).optional(),
  }).strict()).max(4),
}).strict().refine((page) => page.offset <= page.total && page.offset + page.agents.length <= page.total &&
  (page.next_offset === null ? page.offset + page.agents.length === page.total
    : page.agents.length > 0 && page.next_offset === page.offset + page.agents.length && page.next_offset < page.total), "catalog pagination contradicts its contents");
export type AgentCatalog = z.output<typeof AgentCatalogSchema>;
export function museAssignment(request: DelegateRequest): Assignment {
  return AssignmentSchema.parse({ ...request, schema_version: 3, agent_id: "muse" });
}
