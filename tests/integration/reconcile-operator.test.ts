import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";
import { fixture } from "../fixtures/bridge.js";
import { RepositoryRuntime, resolveRepositoryBinding } from "../../src/core/repository-runtime.js";
import { baseResult } from "../../src/core/result.js";
import { operatorToken } from "../../src/service/operator-token.js";
import { TaskStore } from "../../src/store/task-store.js";

test("an offline operator reconciles a departed task owner without gaining task control", async () => {
  const f = await fixture();
  const intent = { project: f.root, stateRoot: f.state };
  let runtime: RepositoryRuntime | undefined;
  try {
    const binding = await resolveRepositoryBinding(intent, {}, new AbortController().signal);
    const store = new TaskStore(binding.storeRoot);
    await store.initialize();
    const token = await operatorToken(binding, true);
    assert.ok(token);
    const operator = { owner_id: createHash("sha256").update(token).digest("hex"), client_id: randomUUID() };
    const record = f.admission(f.request("offline-reconcile"));
    const control = f.initial(record.task_id);
    control.phase = "active";
    control.native.state = "observed_live";
    await store.create(record, control);
    const cancelled = f.admission(f.request("cancelled-before-restart", "implement"));
    const cancelledControl = f.initial(cancelled.task_id);
    cancelledControl.phase = "finalizing";
    cancelledControl.settled_outcome = "cancelled";
    cancelledControl.native.state = "unknown";
    await store.create(cancelled, cancelledControl);
    await store.writeResult(cancelled.task_id, { ...baseResult(cancelled.task_id, cancelled.request, cancelled.execution),
      execution_status: "cancelled", worker_stop: "unconfirmed", summary: "Cancellation was recorded before stop was proven",
      native_evidence: cancelledControl.native });
    await store.writeResource(cancelled.task_id, { schema_version: 1, task_id: cancelled.task_id,
      project_id: cancelled.project_id, state: "pending", updated_at: new Date().toISOString() });
    const cancelledResultBytes = await readFile(join(store.taskDir(cancelled.task_id), "result.json"));
    runtime = new RepositoryRuntime(intent, { package_version: "fixture", build_id: "fixture", mode: "development",
      node_version: process.version, node_executable: process.execPath, pid: process.pid, started_at: new Date().toISOString() },
    { legacyRoots: async () => [] });

    await assert.rejects(runtime.reconcile(record.task_id, "operator", "Confirmed the prior worker process tree stopped", f.owner),
      { code: "COORDINATION_RECOVERY_FORBIDDEN" });
    assert.equal(await store.readResult(record.task_id), undefined);
    assert.equal((await store.readResource(record.task_id))?.stop_reconciled, undefined);

    await runtime.reconcile(record.task_id, "operator", "Confirmed the prior worker process tree stopped", operator);
    assert.equal((await store.readResource(record.task_id))?.stop_reconciled?.owner, "operator");
    assert.equal((await store.readResult(record.task_id))?.worker_stop, "unconfirmed");
    assert.equal((await store.readControl(record.task_id)).owner_id, f.owner.owner_id);
    await assert.rejects(runtime.taskObservation(record.task_id, operator), { code: "TASK_CONTROL_CONFLICT" });
    await runtime.reconcile(cancelled.task_id, "operator", "Confirmed the cancelled worker process tree stopped", operator);
    assert.deepEqual(await readFile(join(store.taskDir(cancelled.task_id), "result.json")), cancelledResultBytes);
    assert.equal((await store.readResource(cancelled.task_id))?.state, "pending");
    assert.equal((await store.readResource(cancelled.task_id))?.stop_reconciled?.owner, "operator");
    await writeFile(join(binding.storeRoot, "operator-control.token"), randomBytes(32).toString("hex"));
    await assert.rejects(runtime.reconcile(cancelled.task_id, "operator", "Stale operator identity", operator),
      { code: "COORDINATION_RECOVERY_FORBIDDEN" });
  } finally {
    await runtime?.shutdown();
    await f.dispose();
  }
});
