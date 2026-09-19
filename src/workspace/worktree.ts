import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { DelegateRequest, Profile } from "../contracts/index.js";
import { BridgeError } from "../core/errors.js";
import { git, sourceStatus } from "./project.js";

export type Workspace = { kind: "source_read_only" | "task_worktree"; path: string; base_commit?: string; branch?: string };

export async function prepareWorkspace(root: string, request: DelegateRequest, profile: Profile, projectId: string, taskId: string): Promise<Workspace> {
  if (request.mode === "review") return { kind: "source_read_only", path: root };
  if (!profile.implementation.enabled || !profile.implementation.worktree_root) throw new BridgeError("IMPLEMENTATION_DISABLED", "Implementation workspaces are disabled in this profile");
  const status = await sourceStatus(root);
  if (status.length) throw new BridgeError("DIRTY_SOURCE", `Implementation requires a clean source checkout (${status.slice(0, 10).join(", ")})`);
  const base = await git(root, ["rev-parse", `${request.base_commit}^{commit}`]);
  if (base.toLowerCase() !== request.base_commit!.toLowerCase()) throw new BridgeError("INVALID_BASE_COMMIT", "base_commit did not resolve to the exact commit object");
  const directory = join(profile.implementation.worktree_root, projectId, taskId);
  await mkdir(join(profile.implementation.worktree_root, projectId), { recursive: true, mode: 0o700 });
  const branch = `muse-bridge/${taskId}`;
  await git(root, ["worktree", "add", "-b", branch, directory, base]);
  return { kind: "task_worktree", path: directory, base_commit: base, branch };
}

export async function changedFiles(workspace: Workspace): Promise<string[]> {
  const status = await sourceStatus(workspace.path);
  return status.map((line) => line.slice(3)).sort();
}

export async function createDiff(workspace: Workspace): Promise<string> {
  if (workspace.kind !== "task_worktree") return "";
  const tracked = await git(workspace.path, ["diff", "--binary", "--no-ext-diff", workspace.base_commit!]);
  const untracked = await git(workspace.path, ["ls-files", "--others", "--exclude-standard"]);
  return `${tracked}\n${untracked ? `\nUntracked files:\n${untracked}\n` : ""}`;
}
