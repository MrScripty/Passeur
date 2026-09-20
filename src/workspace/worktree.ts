import { copyFile, lstat, mkdir, readFile, readlink, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { DelegateRequest, Profile } from "../contracts/index.js";
import { BridgeError } from "../core/errors.js";
import { git, sourceStatus } from "./project.js";

export type Workspace = { kind: "source_read_only" | "task_worktree"; path: string; base_commit?: string; branch?: string };

export async function prepareWorkspace(root: string, request: DelegateRequest, profile: Profile, projectId: string, taskId: string): Promise<Workspace> {
  if (request.mode === "review") return { kind: "source_read_only", path: root };
  if (!profile.implementation.enabled || !profile.implementation.worktree_root) throw new BridgeError("IMPLEMENTATION_DISABLED", "Implementation workspaces are disabled in this profile");
  await mkdir(profile.implementation.worktree_root, { recursive: true, mode: 0o700 });
  const sourceRoot = await realpath(root);
  const worktreeRoot = await realpath(profile.implementation.worktree_root);
  const fromSource = relative(sourceRoot, worktreeRoot);
  if (fromSource === "" || (!fromSource.startsWith(`..${sep}`) && fromSource !== "..")) throw new BridgeError("INVALID_WORKTREE_ROOT", "Implementation worktree root must be outside the source checkout");
  const status = await sourceStatus(root);
  if (status.length) throw new BridgeError("DIRTY_SOURCE", `Implementation requires a clean source checkout (${status.slice(0, 10).join(", ")})`);
  const base = (await git(root, ["rev-parse", `${request.base_commit}^{commit}`])).trim();
  if (base.toLowerCase() !== request.base_commit!.toLowerCase()) throw new BridgeError("INVALID_BASE_COMMIT", "base_commit did not resolve to the exact commit object");
  const directory = join(profile.implementation.worktree_root, projectId, taskId);
  await mkdir(join(profile.implementation.worktree_root, projectId), { recursive: true, mode: 0o700 });
  const branch = `muse-bridge/${taskId}`;
  await git(root, ["worktree", "add", "-b", branch, directory, base]);
  return { kind: "task_worktree", path: directory, base_commit: base, branch };
}

export async function changedFiles(workspace: Workspace): Promise<string[]> {
  return (await collectChanges(workspace)).map((change) => change.path).sort();
}

export async function createDiff(workspace: Workspace): Promise<string> {
  if (workspace.kind !== "task_worktree") return "";
  return git(workspace.path, ["diff", "--binary", "--no-ext-diff", workspace.base_commit!]);
}

export type ChangeKind = "modified" | "created" | "deleted" | "renamed";
export type WorkspaceChange = { path: string; kind: ChangeKind; old_path?: string; untracked?: boolean };
export type ManifestEntry = WorkspaceChange & { mode?: number; bytes?: number; sha256?: string; link_target?: string; artifact_path?: string; artifact_id?: string };

function parseNameStatus(output: string): WorkspaceChange[] {
  const tokens = output.split("\0").filter(Boolean); const changes: WorkspaceChange[] = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++]!;
    if (status.startsWith("R") || status.startsWith("C")) { const oldPath = tokens[index++]!; const path = tokens[index++]!; changes.push({ path, old_path: oldPath, kind: "renamed" }); }
    else { const path = tokens[index++]!; changes.push({ path, kind: status.startsWith("A") ? "created" : status.startsWith("D") ? "deleted" : "modified" }); }
  }
  return changes;
}

async function collectChanges(workspace: Workspace): Promise<WorkspaceChange[]> {
  if (workspace.kind === "source_read_only") {
    const tokens = await sourceStatus(workspace.path); const changes: WorkspaceChange[] = [];
    for (let index = 0; index < tokens.length;) {
      const token = tokens[index++]!; const code = token.slice(0, 2); const path = token.slice(3);
      if (code.includes("R") || code.includes("C")) changes.push({ path, old_path: tokens[index++]!, kind: "renamed" });
      else changes.push({ path, kind: code === "??" || code.includes("A") ? "created" : code.includes("D") ? "deleted" : "modified", ...(code === "??" ? { untracked: true } : {}) });
    }
    return changes;
  }
  const tracked = parseNameStatus(await git(workspace.path, ["diff", "--name-status", "-z", "--find-renames", workspace.base_commit!]));
  const known = new Set(tracked.map((change) => change.path));
  const untracked = (await git(workspace.path, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean).filter((path) => !known.has(path)).map((path) => ({ path, kind: "created" as const, untracked: true }));
  return [...tracked, ...untracked];
}

export async function createManifest(workspace: Workspace, artifactDir: string): Promise<ManifestEntry[]> {
  const changes = await collectChanges(workspace);
  const entries: ManifestEntry[] = [];
  let copied = 0;
  for (const change of changes) {
    const entry: ManifestEntry = { ...change };
    if (change.kind !== "deleted") {
      const absolute = resolve(workspace.path, change.path);
      const info = await lstat(absolute);
      entry.mode = info.mode & 0o7777;
      entry.bytes = info.size;
      if (info.isSymbolicLink()) {
        entry.link_target = await readlink(absolute);
        entry.sha256 = createHash("sha256").update(entry.link_target).digest("hex");
      } else if (info.isFile()) {
        entry.sha256 = createHash("sha256").update(await readFile(absolute)).digest("hex");
        if (change.untracked) {
          const copy = join(artifactDir, "files", change.path);
          await mkdir(dirname(copy), { recursive: true, mode: 0o700 });
          await copyFile(absolute, copy);
          entry.artifact_path = relative(artifactDir, copy);
          entry.artifact_id = `file-${++copied}`;
        }
      }
    }
    entries.push(entry);
  }
  return entries;
}
