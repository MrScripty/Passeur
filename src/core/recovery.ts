import type { DelegateResult } from "../contracts/index.js";
import { TaskStore } from "../store/task-store.js";

export async function reconcileStoredTasks(store: TaskStore, requestedModel: string): Promise<void> {
  for (const record of await store.list()) {
    const state = await store.readState(record.task_id);
    if (state.phase === "terminal") continue;
    const saved = await store.readResult(record.task_id);
    if (saved) {
      await store.writeState(record.task_id, { phase: "terminal", outcome: saved.execution_status, updated_at: new Date().toISOString(), reason: "RESULT_RECOVERED" });
      continue;
    }
    const interrupted: DelegateResult = {
      schema_version: 1, task_id: record.task_id, request_key: record.request.request_key,
      execution_status: "interrupted", worker_stop: state.phase === "accepted" ? "not_started" : "unconfirmed", worker_assessment: "unknown",
      summary: "The bridge restarted before this task recorded a terminal result. The assignment was not replayed.",
      blockers: ["Reconcile the previous worker and workspace before creating a new assignment."],
      error: { code: "INTERRUPTED_ON_RESTART", message: `Recovered incomplete task from phase ${state.phase}` }, questions: [],
      model: { requested: requestedModel }, workspace: { kind: record.request.mode === "review" ? "source_read_only" : "task_worktree", ...(record.request.base_commit ? { base_commit: record.request.base_commit } : {}), stale: true },
      changed_files: [], checks: [], artifacts: [], output_truncated: false,
    };
    await store.writeResult(record.task_id, interrupted);
    await store.writeState(record.task_id, { phase: "terminal", outcome: "interrupted", updated_at: new Date().toISOString(), reason: "INTERRUPTED_ON_RESTART" });
  }
}
