import { rm } from "node:fs/promises";
import lockfile from "proper-lockfile";
import { BridgeError } from "./errors.js";
import { TaskStore } from "../store/task-store.js";

export async function cleanupTask(options: { store: TaskStore; lockPath: string; taskId: string; reconcile: boolean }): Promise<void> {
  let release: (() => Promise<void>) | undefined;
  try { release = await lockfile.lock(options.lockPath, { realpath: false, stale: 0, retries: 0 }); }
  catch { throw new BridgeError("PROJECT_IN_USE", "Cleanup is unavailable while the project bridge owns the project lease"); }
  try {
    const state = await options.store.readState(options.taskId);
    if (state.phase !== "terminal") throw new BridgeError("TASK_ACTIVE", `Task ${options.taskId} is ${state.phase}; active task records cannot be removed`);
    const result = await options.store.readResult(options.taskId);
    if (!result) throw new BridgeError("RESULT_NOT_READY", "A terminal result must be durable before cleanup");
    if (result.worker_stop === "unconfirmed" && !options.reconcile) throw new BridgeError("RECONCILIATION_REQUIRED", "Use --reconcile only after verifying that the worker and workspace are safe");
    await rm(options.store.taskDir(options.taskId), { recursive: true });
  } finally { await release(); }
}
