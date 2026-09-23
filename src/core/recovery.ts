import { baseResult } from "./result.js";
import type { AgentResult } from "../contracts/agents.js";
import type { ResourceRecord, StoredResult } from "../contracts/types.js";
import { BridgeError } from "./errors.js";
import type { TaskStore } from "../store/task-store.js";
const now = () => new Date().toISOString();
/** Must run under the repository-owner lease, before admission. Never replays inference. */
export async function reconcileStoredTasks(store: TaskStore): Promise<void> {
  await store.quarantineIncomplete();
  for (const record of await store.list()) {
    let state = await store.readState(record.task_id);
    let saved = await store.readResult(record.task_id);
    if ("schema_version" in record && (record.schema_version === 4 || record.schema_version === 5)) {
      const control = await store.readControl(record.task_id);
      const resource = await store.readResource(record.task_id);
      if (record.schema_version === 5 && !await store.readCoordinatedLink(record.task_id)) {
        if (saved || control.native.state !== "not_started") {
          await store.freeze(`Task ${record.task_id} has native or result evidence before coordinated linkage settled`);
          continue;
        }
        // The metadata binding may have published before interruption. Preserve this accepted
        // task and its cancel intent for exact link reconciliation; never infer a native run.
        control.phase = "needs_attention";
        control.attention = "Accepted coordinated task awaits exact metadata link settlement; do not resubmit or replay native work.";
        control.revision++; control.updated_at = now(); await store.writeControl(record.task_id, control);
        continue;
      }
      if (record.schema_version === 5 && control.cancel && control.native.state === "not_started" && !saved) {
        // Link settlement can precede publication of the cancelled terminal result.
        // An exact retry may finish that never-started cancellation after reopen.
        control.phase = "needs_attention";
        control.attention = "Coordinated cancellation was accepted before native start; reconcile its exact linked terminal result.";
        control.revision++; control.updated_at = now(); await store.writeControl(record.task_id, control);
        continue;
      }
      if (saved?.schema_version === 4 && (saved.worker_stop !== "unconfirmed" || resource?.stop_reconciled) && (!control.inputs.some((i) => i.state === "delivery_unknown" || i.state === "answer_intent") || resource?.stop_reconciled)) {
        if (control.cancel && saved.execution_status === "completed") { await store.freeze(`Task ${record.task_id} has conflicting completion and cancellation evidence`); continue; }
        if (control.phase !== "terminal") {
          control.phase = "terminal"; control.outcome = saved.execution_status;
          for (const input of control.inputs) { delete input.claim; if (input.state !== "settled") input.state = "withdrawn"; }
          control.revision++; control.updated_at = now(); await store.writeControl(record.task_id, control);
        }
        continue;
      }
      if (control.phase === "terminal" && !saved) { await store.freeze(`Task ${record.task_id} lost terminal evidence`); continue; }
      const queued = control.native.state === "not_started" && (control.phase === "queued" || control.attention?.startsWith("Recovered queued")) && (!resource || resource.state === "not_applicable");
      control.phase = "needs_attention";
      control.attention = queued ? "Recovered queued work was not replayed. Explicitly cancel it before a deliberate resubmission with a new key."
        : "Service interruption left native execution or publication uncertain; verify processes and reconcile before new work.";
      for (const input of control.inputs) {
        delete input.claim;
        if (input.state === "answer_intent") input.state = "delivery_unknown";
        else if (input.state === "pending") input.state = "withdrawn";
      }
      if (!queued) control.native.state = "unknown";
      control.revision++; control.updated_at = now(); await store.writeControl(record.task_id, control);
      if (!queued) await store.freeze(`Task ${record.task_id} requires native/publication reconciliation`);
      continue;
    }
    if (!saved && state.phase !== "terminal") {
      const result: AgentResult = {
        schema_version: 3,
        identity: record.request.schema_version === 3 && record.execution?.schema_version === 1
          ? { status: "admitted", snapshot: record.execution }
          : { status: "unavailable", source_schema_version: record.request.schema_version === 1 ? 1 : 2, reason: "The historical request did not retain execution identity" },
        task_id: record.task_id, request_key: record.request.request_key,
        execution_status: "interrupted", worker_stop: state.phase === "accepted" || state.phase === "queued" ? "not_started" : "unconfirmed", worker_assessment: "unknown",
        summary: "The previous execution was interrupted. It was not replayed.", blockers: [], questions: [],
        error: { code: "INTERRUPTED_ON_RESTART", message: `Recovered phase ${state.phase}` },
        model: record.execution?.requested_model ? { requested: record.execution.requested_model } : {}, workspace: { kind: record.request.mode === "review" ? "source_read_only" : "task_worktree", stale: true },
        delivery: { status: record.request.mode === "review" ? "not_applicable" : "incomplete", reason: "Interrupted execution requires explicit reconciliation" },
        changed_files: [], checks: [], artifacts: [], output_truncated: false,
      };
      saved = result;
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
  let result = await store.readResult(taskId);
  let resource = await store.readResource(taskId);
  const request = await store.find({ task_id: taskId });
  if (request && "schema_version" in request) {
    const control = await store.readControl(taskId);
    if (!resource) resource = { schema_version: 1, task_id: taskId, project_id: request.project_id, state: request.request.mode === "implement" ? "legacy_unclassified" : "not_applicable", updated_at: now() };
    if (resource.state === "legacy_unclassified") throw new BridgeError("RESOURCE_CLASSIFICATION_REQUIRED", "Resolve the missing implementation resource intent before reconciliation");
    if (!result) {
      const priorSettlement = control.settled_outcome;
      result = { ...baseResult(taskId, request.request, request.execution), execution_status: "interrupted", worker_stop: "unconfirmed",
        summary: "Interrupted native execution; an operator separately reconciled stop evidence", native_evidence: control.native,
        ...(priorSettlement ? { error: { code: "RESULT_PUBLICATION_INTERRUPTED", message: `The saved result was missing after ${priorSettlement} settlement; operator ${owner.slice(0, 256)} classified the publication interruption.` } } : {}) };
      // This explicit recovery mutation preserves the displaced settlement in the resulting evidence.
      control.settled_outcome = "interrupted"; control.revision++; control.updated_at = now(); await store.writeControl(taskId, control);
      await store.writeResult(taskId, result);
    }
    await store.writeResource(taskId, { ...resource, stop_reconciled: { at: now(), owner, reason }, updated_at: now() });
    control.phase = "terminal"; control.outcome = result.execution_status === "timed_out" ? "interrupted" : result.execution_status;
    for (const input of control.inputs) { delete input.claim; if (input.state !== "settled") input.state = "withdrawn"; }
    control.revision++; control.updated_at = now(); await store.writeControl(taskId, control);
  }
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
