import { describe, expect, it } from "vitest";
import { BatchRequestSchema, DelegateRequestSchema, FinalizeRequestSchema, ProfileSchema } from "../../src/contracts/index.js";
import { InputRequestSchema } from "../../src/contracts/tasks.js";
const request = { schema_version: 2, request_key: "review-1", mode: "review", objective: "Review parser", context: "Bounds", acceptance_criteria: ["Report findings"] };
describe("version-2 contracts", () => {
  it("accepts independent review requests", () => { expect(DelegateRequestSchema.parse(request)).toEqual(request); });
  it("rejects earlier execution contracts and unknown fields", () => {
    expect(() => DelegateRequestSchema.parse({ ...request, schema_version: 1 })).toThrow();
    expect(() => DelegateRequestSchema.parse({ ...request, surprise: true })).toThrow();
  });
  it("requires exact base and a full target ref for implementation", () => {
    expect(() => DelegateRequestSchema.parse({ ...request, mode: "implement" })).toThrow();
    expect(() => DelegateRequestSchema.parse({ ...request, mode: "implement", base_commit: "a".repeat(41), target_ref: "main" })).toThrow();
    expect(DelegateRequestSchema.parse({ ...request, mode: "implement", base_commit: "a".repeat(40), target_ref: "refs/heads/work/topic" }).mode).toBe("implement");
  });
  it("rejects traversal, oversized envelopes, and duplicate batch keys", () => {
    expect(() => DelegateRequestSchema.parse({ ...request, context_files: ["../secret"] })).toThrow();
    expect(() => BatchRequestSchema.parse({ schema_version: 2, assignments: [request, request] })).toThrow();
    expect(() => BatchRequestSchema.parse({ schema_version: 2, assignments: Array.from({ length: 9 }, (_, i) => ({ ...request, request_key: `task-${i}` })) })).toThrow();
  });
  it("requires explicit retirement authority", () => {
    const operation = { operation_key: "archive", task_id: crypto.randomUUID(), expected_head: "a".repeat(40), expected_branch_ref: "refs/heads/muse-bridge/task", disposition: "archived" };
    expect(() => FinalizeRequestSchema.parse({ schema_version: 2, operations: [operation] })).toThrow();
    expect(FinalizeRequestSchema.parse({ schema_version: 2, operations: [{ ...operation, archive_authorized: true, cleanup_authorized: true }] }).operations).toHaveLength(1);
  });
  it("documents concurrency defaults without changing the profile version", () => {
    const profile = ProfileSchema.parse({ schema_version: 1, muse_bin: "muse", model: "model", review: { disable_write: true, disable_shell: true, sandbox_network: "restricted" }, implementation: { enabled: false, sandbox_network: "restricted" }, subscription: { provenance: "unverified" } });
    expect(profile.max_workers).toBe(2); expect(profile.max_queued_tasks).toBe(8);
  });
  it("defaults the MCP input envelope version while accepting existing explicit callers", () => {
    const request = { kind: "clarification", task_id: crypto.randomUUID(), input_id: crypto.randomUUID(),
      operation_key: "clarification-1", control_generation: 1 };
    expect(InputRequestSchema.parse(request).schema_version).toBe(1);
    expect(InputRequestSchema.parse({ ...request, schema_version: 1 }).schema_version).toBe(1);
    expect(() => InputRequestSchema.parse({ ...request, schema_version: 2 })).toThrow();
  });
});
