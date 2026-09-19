import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { describe, expect, it } from "vitest";
import type { DelegateRequest, DelegateResult } from "../../src/contracts/index.js";
import { cleanupTask } from "../../src/core/cleanup.js";
import { TaskStore, type StoredRequest } from "../../src/store/task-store.js";

const request: DelegateRequest = { schema_version: 1, request_key: "cleanup", mode: "review", objective: "Review", context: "Context", acceptance_criteria: ["Done"] };
async function fixture(phase: "running" | "terminal", stop: DelegateResult["worker_stop"] = "confirmed") {
  const root = await mkdtemp(join(tmpdir(), "muse-cleanup-test-")); const store = new TaskStore(root); await store.initialize(); const taskId = crypto.randomUUID();
  const record: StoredRequest = { task_id: taskId, project_id: "project", canonical_hash: "hash", accepted_at: new Date().toISOString(), deadline_at: new Date().toISOString(), request };
  await store.create(record, { phase, ...(phase === "terminal" ? { outcome: "completed" as const } : {}), updated_at: new Date().toISOString() });
  if (phase === "terminal") await store.writeResult(taskId, { schema_version: 1, task_id: taskId, request_key: request.request_key, execution_status: "completed", worker_stop: stop, worker_assessment: "met", summary: "done", blockers: [], questions: [], model: { requested: "model" }, workspace: { kind: "source_read_only", stale: false }, changed_files: [], checks: [], artifacts: [], output_truncated: false });
  return { root, store, taskId };
}

describe("cleanupTask", () => {
  it("refuses an active task", async () => { const value = await fixture("running"); await expect(cleanupTask({ store: value.store, lockPath: value.root, taskId: value.taskId, reconcile: false })).rejects.toMatchObject({ code: "TASK_ACTIVE" }); });
  it("refuses while the bridge owns the lease", async () => {
    const value = await fixture("terminal"); const release = await lockfile.lock(value.root, { realpath: false, stale: 0, retries: 0 });
    try { await expect(cleanupTask({ store: value.store, lockPath: value.root, taskId: value.taskId, reconcile: false })).rejects.toMatchObject({ code: "PROJECT_IN_USE" }); } finally { await release(); }
  });
  it("requires explicit reconciliation for unconfirmed shutdown", async () => {
    const value = await fixture("terminal", "unconfirmed");
    await expect(cleanupTask({ store: value.store, lockPath: value.root, taskId: value.taskId, reconcile: false })).rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    await cleanupTask({ store: value.store, lockPath: value.root, taskId: value.taskId, reconcile: true });
    expect(await value.store.find({ task_id: value.taskId })).toBeUndefined();
  });
});
