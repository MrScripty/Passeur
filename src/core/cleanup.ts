import { rm } from "node:fs/promises";
import { join } from "node:path";
import { BridgeError } from "./errors.js";
import { TaskStore } from "../store/task-store.js";
/** Lease ownership belongs to runtime composition. Only bulky evidence is collected. */
export async function cleanupTask(options: { store: TaskStore; taskId: string; assertAuthority?: () => void }): Promise<void> {
  options.assertAuthority?.();
  const frozen = await options.store.frozenReason();
  if (frozen) throw new BridgeError("PROJECT_NEEDS_RECONCILIATION", frozen);
  const state = await options.store.readState(options.taskId);
  const result = await options.store.readResult(options.taskId);
  const resource = await options.store.readResource(options.taskId);
  if (state.phase !== "terminal" || !result) throw new BridgeError("TASK_ACTIVE", "Cleanup requires a durable terminal result");
  if (result.worker_stop === "unconfirmed" && !resource?.stop_reconciled) throw new BridgeError("RECONCILIATION_REQUIRED", "Worker shutdown is unconfirmed");
  if (!resource || !["retired", "not_applicable"].includes(resource.state)) throw new BridgeError("RESOURCE_DISPOSITION_REQUIRED", "Pending, retained, uncertain, or historical resources keep their evidence");
  options.assertAuthority?.();
  await rm(join(options.store.taskDir(options.taskId), "artifacts"), { recursive: true, force: true });
  options.assertAuthority?.();
  await rm(join(options.store.taskDir(options.taskId), "events.ndjson"), { force: true });
  await options.store.writeResource(options.taskId, { ...resource, artifacts_collected_at: new Date().toISOString(), updated_at: new Date().toISOString() });
}
