import { expect, it } from "vitest";
import { AssignmentSchema, AgentBatchSchema, AgentCatalogSchema } from "../../src/contracts/agents.js";
import { decodeRequest, decodeResult, decodeReceipt } from "../../src/store/record-codecs.js";
import { baseResult } from "../../src/core/result.js";
import { canonicalHash, stableHash } from "../../src/core/async.js";
import { fixture } from "../fixtures/bridge.js";

it("v3 assignment proof includes the selected agent and implementation base/target", () => {
  const body = { schema_version: 3, agent_id: "worker", request_key: "work", mode: "implement", objective: "Task", context: "", acceptance_criteria: ["Commit"] };
  expect(AssignmentSchema.safeParse(body).success).toBe(false);
  const request = { ...body, base_commit: "a".repeat(40), target_ref: "refs/heads/main" };
  expect(AssignmentSchema.safeParse(request).success).toBe(true);
  expect(AssignmentSchema.safeParse({ ...request, agent_id: "" }).success).toBe(false);
  expect(AgentBatchSchema.safeParse({ schema_version: 3, assignments: [request, request] }).success).toBe(false);
});
it("v3 admitted records reject altered fingerprints, deadlines and selected identities", async () => {
  const f = await fixture();
  try {
    const record = f.admission(f.request("identity"));
    expect(decodeRequest(record, record.task_id)).toEqual(record);
    for (const invalid of [
      { ...record, execution: { ...record.execution, agent_id: "different" } },
      { ...record, execution: { ...record.execution, configuration_fingerprint: "0".repeat(64) } },
      { ...record, deadline_at: record.accepted_at },
      { ...record, request: { ...record.request, objective: "Changed intent" } },
    ]) expect(() => decodeRequest(invalid, record.task_id)).toThrowError(expect.objectContaining({ code: "STORE_CORRUPT" }));
  } finally { await f.dispose(); }
});
it("real store reads bind a result to its original admission even when both shapes are valid", async () => {
  const f = await fixture();
  try {
    const assignment = f.request("cross-record"), record = f.admission(assignment);
    await f.store.create(record, { phase: "queued", updated_at: record.accepted_at });
    const result = baseResult(record.task_id, assignment, record.execution!);
    if (result.identity.status !== "admitted") throw new Error("Fixture identity is admitted");
    result.identity.snapshot.configuration = { model: "changed" };
    result.identity.snapshot.configuration_fingerprint = canonicalHash(result.identity.snapshot.configuration);
    // Standalone shape proof passes. The store must additionally reject cross-record substitution.
    expect(decodeResult(result, record.task_id).schema_version).toBe(3);
    await expect(f.store.writeResult(record.task_id, result)).rejects.toMatchObject({ code: "STORE_CORRUPT" });
    expect(await f.store.readResult(record.task_id)).toBeUndefined();
  } finally { await f.dispose(); }
});
it("historical recovery cannot invent a model or confirmed worker stop", async () => {
  const f = await fixture();
  try {
    const assignment = f.request("history"), id = crypto.randomUUID();
    const result = { ...baseResult(id, assignment, f.snapshot(assignment)), execution_status: "interrupted",
      identity: { status: "unavailable", source_schema_version: 2, reason: "Not recorded by the prior contract" }, model: {} };
    expect(decodeResult(result, id).schema_version).toBe(3);
    expect(() => decodeResult({ ...result, model: { requested: "current-model" } }, id)).toThrowError(expect.objectContaining({ code: "STORE_CORRUPT" }));
    expect(() => decodeResult({ ...result, worker_stop: "confirmed" }, id)).toThrowError(expect.objectContaining({ code: "STORE_CORRUPT" }));
  } finally { await f.dispose(); }
});
it("disposition receipts retain their legacy hash contract and reject mismatched authority", () => {
  const id = crypto.randomUUID(), now = new Date().toISOString();
  const operation = { operation_key: "retain", task_id: id, expected_head: "a".repeat(40), expected_branch_ref: "refs/heads/task",
    disposition: "retained", owner: "fixture", reason: "Further review", next_action: "Review" };
  const receipt = { operation, request_hash: stableHash(operation), state: "done",
    resource: { schema_version: 1, task_id: id, project_id: "project", state: "retained", updated_at: now }, updated_at: now };
  expect(decodeReceipt(receipt, id).state).toBe("done");
  expect(() => decodeReceipt({ ...receipt, request_hash: "incorrect" }, id)).toThrowError(expect.objectContaining({ code: "STORE_CORRUPT" }));
});
it("catalog returns a bounded view with no claim of native readiness", () => {
  expect(AgentCatalogSchema.safeParse({ schema_version: 1, checked_at: new Date().toISOString(), configuration: "observed", total: 0, offset: 0, next_offset: null, agents: [] }).success).toBe(true);
});
