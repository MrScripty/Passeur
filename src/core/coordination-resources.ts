import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { BridgeError, nativeCode } from "./errors.js";
import type { WorkspaceFacts } from "../coordination/repository.js";
import { worktreeEntries } from "../workspace/inventory.js";
import { isWithin } from "../workspace/project.js";

/** TaskStore owns decoding. This consumer needs only its retained resource claim. */
export type ManagedWorkspaceClaim = Readonly<{
  task_id: string; project_id: string; state: string;
  worktree_path?: string; branch_ref?: string;
}>;
export interface ManagedResourceInventory {
  list(): Promise<ReadonlyArray<Readonly<{ task_id: string; project_id: string }>>>;
  readResource(id: string): Promise<ManagedWorkspaceClaim | undefined>;
  readState(id: string): Promise<Readonly<{ phase: string }>>;
}
export type ResourceInspectionLimits = Readonly<{ records: number; worktrees: number }>;
const uncertain = () => new BridgeError("COORDINATION_RESOURCE_UNAVAILABLE", "Managed resource ownership needs reconciliation before external registration");
const overlaps = (left: string, right: string) => isWithin(left, right) || isWithin(right, left);
const retainedResourceStates = new Set(["creating", "pending", "retained", "cleanup_pending"]);
const owned = () => new BridgeError("COORDINATION_WORKSPACE_MANAGED", "This workspace is retained by a managed task; external registration is not authorized");

/** Read-only evidence; a missing resource is not permission to enroll its surviving workspace. */
export async function assertExternalWorkspace(
  workspace: WorkspaceFacts, inventory: ManagedResourceInventory,
  limits: ResourceInspectionLimits, assertAuthority: () => void, signal?: AbortSignal,
): Promise<void> {
  for (const value of [limits.records, limits.worktrees]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 65_536) throw new BridgeError("COORDINATION_RESOURCE_LIMIT_INVALID", "Explicit resource-inspection bounds are required");
  }
  signal?.throwIfAborted(); assertAuthority();
  const tasks = await inventory.list();
  if (tasks.length > limits.records) throw new BridgeError("COORDINATION_RESOURCE_CAPACITY", "Resource inventory exceeds its selected inspection bound");
  const claims: ManagedWorkspaceClaim[] = [];
  for (const task of tasks) {
    signal?.throwIfAborted(); assertAuthority();
    if (task.project_id !== workspace.repository_id) throw uncertain();
    const claim = await inventory.readResource(task.task_id);
    if (!claim || claim.task_id !== task.task_id || claim.project_id !== task.project_id) throw uncertain();
    if (claim.state === "not_applicable") {
      if (claim.worktree_path || claim.branch_ref) throw uncertain();
      continue;
    }
    if (claim.state === "retired") {
      if ((await inventory.readState(task.task_id)).phase !== "terminal") throw uncertain();
      continue;
    }
    if (!retainedResourceStates.has(claim.state)
      || !claim.worktree_path || !isAbsolute(claim.worktree_path) || !claim.branch_ref?.startsWith("refs/heads/")) throw uncertain();
    if (overlaps(resolve(claim.worktree_path), workspace.root)) throw owned();
    claims.push(claim);
  }
  if (!claims.length) { assertAuthority(); return; }
  const entries = await worktreeEntries(workspace.common_dir, signal);
  if (entries.length > limits.worktrees) throw new BridgeError("COORDINATION_RESOURCE_CAPACITY", "Worktree inventory exceeds its selected inspection bound");
  const canonical = async (path: string): Promise<string | undefined> => {
    try { return await realpath(path); }
    catch (error) { if (nativeCode(error) === "ENOENT") return undefined; throw error; }
  };
  for (const claim of claims) {
    signal?.throwIfAborted(); assertAuthority();
    const original = await canonical(claim.worktree_path!);
    if (original && overlaps(original, workspace.root)) throw owned();
    const byBranch = entries.filter(entry => entry.branch === claim.branch_ref);
    for (const entry of byBranch) {
      const current = await canonical(entry.path);
      if (overlaps(resolve(entry.path), workspace.root) || current && overlaps(current, workspace.root)) throw owned();
    }
    // A path alone may have been reused after a move, and a branch alone may
    // have been checked out elsewhere. Unknown resource history is not a grant.
    if (!original || byBranch.length !== 1) throw uncertain();
    const entry = byBranch[0]!;
    if (entry.prunable || await canonical(entry.path) !== original) throw uncertain();
  }
  signal?.throwIfAborted(); assertAuthority();
}
