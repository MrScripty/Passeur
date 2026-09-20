import type { DelegateResult, ResourceRecord, StoredResult } from "../contracts/types.js";
import { BridgeError } from "./errors.js";
import { TaskStore } from "../store/task-store.js";
const now = () => new Date().toISOString();
/** Must run under the repository-owner lease, before admission. Never replays inference. */
export async function reconcileStoredTasks(store: TaskStore, requestedModel: string): Promise<void> {
  await store.quarantineIncomplete();
  for (const record of await store.list()) {
    let state = await store.readState(record.task_id);
    let saved = await store.readResult(record.task_id);
    if (!saved && state.phase !== "terminal") {
      const result: DelegateResult = {
        schema_version: 2, task_id: record.task_id, request_key: record.request.request_key,
        execution_status: "interrupted", worker_stop: state.phase === "accepted" || state.phase === "queued" ? "not_started" : "unconfirmed", worker_assessment: "unknown",
        summary: "The previous execution was interrupted. It was not replayed.", blockers: [], questions: [],
        error: { code: "INTERRUPTED_ON_RESTART", message: `Recovered phase ${state.phase}` },
        model: { requested: requestedModel }, workspace: { kind: record.request.mode === "review" ? "source_read_only" : "task_worktree", stale: true },
        delivery: { status: record.request.mode === "review" ? "not_applicable" : "incomplete", reason: "Interrupted execution requires explicit reconciliation" },
        changed_files: [], checks: [], artifacts: [], output_truncated: false,
      };
      if (record.request.schema_version === 1) {
        const { delivery: _delivery, ...old } = result;
        saved = { ...old, schema_version: 1 };
      } else saved = result;
      await store.writeResult(record.task_id, saved);
    }
    if (!saved) { await store.freeze(`Terminal task ${record.task_id} has no result; restore its evidence before admission`); continue; }
    if (state.phase !== "terminal") {
      state = { phase: "terminal", outcome: saved.execution_status, updated_at: now(), reason: "RESULT_RECOVERED" };
      await store.writeState(record.task_id, state);
    }
    let resource = await store.readResource(record.task_id);
    if (!resource) {
      resource = { schema_version: 1, task_id: record.task_id, project_id: record.project_id,
        state: record.request.schema_version === 1 ? "legacy_unclassified" : "not_applicable", updated_at: now() };
      await store.writeResource(record.task_id, resource);
    }
    if (saved.worker_stop === "unconfirmed" && !resource.stop_reconciled) await store.freeze(`Task ${record.task_id} has unconfirmed process shutdown; offline reconciliation is required`);
  }
}
/** Explicit human assertion, recorded separately from immutable runtime evidence. Offline lease required. */
export async function acknowledgeStoppedTask(store: TaskStore, taskId: string, owner: string, reason: string): Promise<void> {
  if (!owner.trim() || !reason.trim()) throw new BridgeError("RECONCILIATION_AUTHORITY_REQUIRED", "Supply the responsible owner and reconciliation evidence");
  const result = await store.readResult(taskId);
  const resource = await store.readResource(taskId);
  if (!result || !resource || (await store.readState(taskId)).phase !== "terminal") throw new BridgeError("RESULT_NOT_READY", "Reconcile stored task state first");
  if (resource.state === "legacy_unclassified") throw new BridgeError("LEGACY_UNCLASSIFIED", "Classify historical resources explicitly before changing their authority");
  await store.writeResource(taskId, { ...resource, stop_reconciled: { at: now(), owner, reason }, updated_at: now() });
  // Never clear a quarantine or missing-result condition via a process assertion.
  const quarantined = await store.quarantineIncomplete();
  if (quarantined.length) return;
  for (const record of await store.list()) {
    const saved = await store.readResult(record.task_id);
    if (!saved || (saved.worker_stop === "unconfirmed" && !(await store.readResource(record.task_id))?.stop_reconciled)) return;
  }
  await store.acknowledgeSafety();
}
export function resourceProjection(result: StoredResult, resource?: ResourceRecord): ResourceRecord | { state: "legacy_unclassified" } {
  if (result.schema_version === 1 && !resource) return { state: "legacy_unclassified" };
  return resource ?? { state: "legacy_unclassified" };
}
