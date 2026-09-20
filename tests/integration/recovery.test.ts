import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DelegateResult } from "../../src/contracts/index.js";
import { reconcileStoredTasks } from "../../src/core/recovery.js";
import { TaskStore, type StoredRequest } from "../../src/store/task-store.js";

describe("startup recovery", () => {
  it("promotes a durable result to its matching terminal state", async () => {
    const root = await mkdtemp(join(tmpdir(), "muse-recovery-test-")); const store = new TaskStore(root); const taskId = crypto.randomUUID();
    const request = { schema_version: 1 as const, request_key: "recovery", mode: "review" as const, objective: "Review", context: "Context", acceptance_criteria: ["Done"] };
    const record: StoredRequest = { task_id: taskId, project_id: "project", canonical_hash: "hash", accepted_at: new Date().toISOString(), deadline_at: new Date().toISOString(), request };
    await store.create(record, { phase: "finalizing", updated_at: new Date().toISOString() });
    const result: DelegateResult = { schema_version: 1, task_id: taskId, request_key: request.request_key, execution_status: "completed", worker_stop: "confirmed", worker_assessment: "met", summary: "done", blockers: [], questions: [], model: { requested: "model" }, workspace: { kind: "source_read_only", stale: false }, changed_files: [], checks: [], artifacts: [], output_truncated: false };
    await store.writeResult(taskId, result); await reconcileStoredTasks(store, "model");
    expect(await store.readState(taskId)).toMatchObject({ phase: "terminal", outcome: "completed", reason: "RESULT_RECOVERED" }); expect(await store.readResult(taskId)).toEqual(result);
  });
});
