import { isAbsolute } from "node:path";
import { BridgeError } from "./errors.js";
import { WORK_INTENT_BYTES, MAX_REGIONS, coordinationOid, entityId, type ManagedWork, type Region } from "../contracts/coordination-control.js";
import { validateSourcePath } from "../observation/source.js";

/** TaskStore decodes these records; this read-only consumer does not own their serialization. */
export interface ManagedTaskReader {
  durableRequest(id: string): Promise<Readonly<{
    task_id: string; project_id: string;
    request: Readonly<{ mode: string; base_commit?: string | undefined; objective: string; allowed_paths?: readonly string[] | undefined }>;
  }>>;
  readResource(id: string): Promise<Readonly<{
    task_id: string; project_id: string; state: string; worktree_path?: string | undefined; branch_ref?: string | undefined; base_commit?: string | undefined;
  }> | undefined>;
}
export type ManagedTaskSource = Readonly<{
  task_id: string; root: string; branch_ref: string; input_oid: string; objective: string;
  allowed_paths: readonly string[] | undefined;
}>;

/** Resolve only an actually prepared, still-owned implementation workspace. No inferred liveness or ownership. */
export async function managedTaskSource(reader: ManagedTaskReader, repository: string, taskId: string): Promise<ManagedTaskSource> {
  const id = entityId(taskId), admission = await reader.durableRequest(id);
  if (admission.task_id !== id || admission.project_id !== repository) throw new BridgeError("COORDINATION_TASK_IDENTITY_CONFLICT", "The admitted task belongs to another identity or repository");
  if (admission.request.mode !== "implement" || !admission.request.base_commit) throw new BridgeError("COORDINATION_TASK_MODE_UNSUPPORTED", "Managed enrollment requires an implementation task with an exact input commit");
  const resource = await reader.readResource(id);
  if (!resource || resource.state === "creating") throw new BridgeError("COORDINATION_TASK_WORKSPACE_NOT_READY", "The task has no prepared workspace; observe its existing execution rather than submitting it again");
  if (resource.task_id !== id || resource.project_id !== repository || resource.base_commit !== admission.request.base_commit) {
    throw new BridgeError("COORDINATION_TASK_RESOURCE_CONFLICT", "Task resource and immutable admission disagree");
  }
  if (resource.state !== "pending" && resource.state !== "retained") throw new BridgeError("COORDINATION_TASK_RESOURCE_UNAVAILABLE", "The task resource is retiring, retired, or unclassified; it cannot supply a new selection");
  if (!resource.worktree_path || !isAbsolute(resource.worktree_path) || !resource.branch_ref?.startsWith("refs/heads/")) {
    throw new BridgeError("COORDINATION_TASK_RESOURCE_CONFLICT", "The task resource lacks its owned workspace and branch");
  }
  return Object.freeze({ task_id: id, root: resource.worktree_path, branch_ref: resource.branch_ref,
    input_oid: coordinationOid(admission.request.base_commit), objective: admission.request.objective,
    allowed_paths: admission.request.allowed_paths ? Object.freeze([...admission.request.allowed_paths]) : undefined });
}

/** Literal projection of admitted text/scope, never a generated summary or a new write grant. */
export function managedWorkProjection(source: ManagedTaskSource, generation: number): Readonly<{ intent: string; areas: Region[]; managed: ManagedWork }> {
  const text = Buffer.from(source.objective);
  if (text.toString("utf8") !== source.objective) throw new BridgeError("COORDINATION_TASK_TEXT_INVALID", "The admitted objective is not representable as UTF-8 without replacement");
  const intent = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(text.subarray(0, WORK_INTENT_BYTES), { stream: text.length > WORK_INTENT_BYTES });
  const paths = [...new Set((source.allowed_paths ?? []).map(path => path.replace(/\/$/, "")))];
  if (paths.length > MAX_REGIONS) throw new BridgeError("COORDINATION_TASK_SCOPE_UNSUPPORTED", "The admitted path scope exceeds coordination capacity; it was not silently shortened");
  for (const path of paths) validateSourcePath(path);
  return { intent, areas: paths.map(path => ({ kind: "subtree", path })), managed: {
    task_id: source.task_id, control_generation: generation, intent_truncated: text.length > Buffer.byteLength(intent),
    areas_source: source.allowed_paths === undefined ? "not_declared" : "allowed_paths",
  } };
}
