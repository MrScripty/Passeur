import type { LifecyclePolicy } from "../contracts/tasks.js";
import { copyFile, lstat, mkdir, readFile, readlink, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import type { Delivery } from "../contracts/types.js";
import type { Assignment } from "../contracts/agents.js";
import { BridgeError } from "../core/errors.js";
import { throwIfAborted } from "../core/async.js";
import { exactCommit, git, isAncestor, isWithin, refHead, sourceStatus, validateBranchRef } from "./project.js";
export type Workspace = { kind: "source_read_only" | "task_worktree"; path: string; base_commit?: string; branch?: string; target_ref?: string; signal?: AbortSignal };
export type WorkspaceOptions = { signal?: AbortSignal; assertAuthority?: () => void; onIntent?: (workspace: Workspace) => Promise<void> };

export async function prepareWorkspace(root: string, request: Assignment, profile: LifecyclePolicy, projectId: string, taskId: string, options: WorkspaceOptions = {}): Promise<Workspace> {
  throwIfAborted(options.signal);
  if (request.mode === "review") return { kind: "source_read_only", path: root, ...(options.signal ? { signal: options.signal } : {}) };
  if (!profile.implementation.enabled || !profile.implementation.worktree_root) throw new BridgeError("IMPLEMENTATION_DISABLED", "Implementation workspaces are disabled in this profile");
  if (!request.target_ref || !request.base_commit) throw new BridgeError("INVALID_ASSIGNMENT", "Implementation requires base_commit and target_ref");
  await validateBranchRef(root, request.target_ref, options.signal);
  if (!await refHead(root, request.target_ref)) throw new BridgeError("TARGET_NOT_FOUND", "The intended local target branch does not exist");
  const status = await sourceStatus(root, true, options.signal);
  if (status.length) throw new BridgeError("DIRTY_SOURCE", "Implementation requires a clean source checkout; Passeur will not stash or commit it");
  const base = await exactCommit(root, request.base_commit, options.signal);
  // Check lexical containment before mkdir, then resolve symlinks before creating a task.
  const sourceRoot = await realpath(root);
  const requestedRoot = resolve(profile.implementation.worktree_root);
  if (isWithin(sourceRoot, requestedRoot)) throw new BridgeError("INVALID_WORKTREE_ROOT", "Worktree root must be outside the source checkout");
  options.assertAuthority?.(); throwIfAborted(options.signal);
  await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
  const worktreeRoot = await realpath(requestedRoot);
  if (isWithin(sourceRoot, worktreeRoot)) throw new BridgeError("INVALID_WORKTREE_ROOT", "Worktree root resolves inside source checkout");
  const parent = join(worktreeRoot, projectId);
  options.assertAuthority?.(); throwIfAborted(options.signal);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if (!isWithin(worktreeRoot, await realpath(parent))) throw new BridgeError("INVALID_WORKTREE_ROOT", "Task parent escapes worktree root");
  const workspace: Workspace = { kind: "task_worktree", path: join(parent, taskId), base_commit: base, branch: `refs/heads/muse-bridge/${taskId}`, target_ref: request.target_ref, ...(options.signal ? { signal: options.signal } : {}) };
  await options.onIntent?.(workspace);
  throwIfAborted(options.signal);
  options.assertAuthority?.();
  await git(root, ["worktree", "add", "-b", workspace.branch!.slice("refs/heads/".length), workspace.path, base], options.signal);
  return workspace;
}

export async function observeDelivery(workspace: Workspace, noChangesReason?: string): Promise<Delivery> {
  if (workspace.kind === "source_read_only") return { status: "not_applicable" };
  const delivery: Delivery = {
    status: "incomplete", base_commit: workspace.base_commit!, branch_ref: workspace.branch!,
    worktree_path: workspace.path, ...(workspace.target_ref ? { target_ref: workspace.target_ref } : {}),
  };
  const head = (await git(workspace.path, ["rev-parse", "HEAD^{commit}"], workspace.signal)).trim();
  delivery.head_commit = await exactCommit(workspace.path, head, workspace.signal);
  delivery.tree_oid = (await git(workspace.path, ["rev-parse", `${head}^{tree}`], workspace.signal)).trim();
  const checkedOut = (await git(workspace.path, ["symbolic-ref", "-q", "HEAD"], workspace.signal)).trim();
  if (checkedOut !== workspace.branch || await refHead(workspace.path, workspace.branch!, workspace.signal) !== head) {
    delivery.reason = "The owned task branch no longer names the checked-out commit"; return delivery;
  }
  if (!await isAncestor(workspace.path, workspace.base_commit!, head, workspace.signal)) {
    delivery.reason = "Task history does not descend from its admitted base"; return delivery;
  }
  delivery.commits = (await git(workspace.path, ["rev-list", "--reverse", `${workspace.base_commit}..${head}`], workspace.signal)).trim().split("\n").filter(Boolean);
  if ((await sourceStatus(workspace.path, true, workspace.signal)).length) {
    delivery.reason = "Staged, unstaged, or nonignored untracked changes remain; Passeur does not create the worker's commit"; return delivery;
  }
  if (head === workspace.base_commit) {
    if (noChangesReason?.trim()) { delivery.status = "no_changes_needed"; delivery.reason = noChangesReason.trim().slice(0, 2048); }
    else delivery.reason = "No new commit and no explicit no-change explanation";
    return delivery;
  }
  delivery.status = "committed";
  return delivery;
}
export type ChangeKind = "modified" | "created" | "deleted" | "renamed";
export type WorkspaceChange = { path: string; kind: ChangeKind; old_path?: string; untracked?: boolean };
export type ManifestEntry = WorkspaceChange & { mode?: number; bytes?: number; sha256?: string; link_target?: string; artifact_path?: string; artifact_id?: string };
function parseNameStatus(output: string): WorkspaceChange[] {
  const tokens = output.split("\0").filter(Boolean), changes: WorkspaceChange[] = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++]!;
    const first = tokens[index++];
    if (first === undefined) throw new BridgeError("GIT_OUTPUT_INVALID", "Missing path in Git name-status output");
    if (status.startsWith("R") || status.startsWith("C")) {
      const path = tokens[index++];
      if (path === undefined) throw new BridgeError("GIT_OUTPUT_INVALID", "Missing rename destination");
      changes.push({ path, old_path: first, kind: "renamed" });
    } else changes.push({ path: first, kind: status.startsWith("A") ? "created" : status.startsWith("D") ? "deleted" : "modified" });
  }
  return changes;
}
export async function collectChanges(workspace: Workspace): Promise<WorkspaceChange[]> {
  if (workspace.kind === "source_read_only") {
    const tokens = await sourceStatus(workspace.path, false, workspace.signal), changes: WorkspaceChange[] = [];
    for (let index = 0; index < tokens.length;) {
      const token = tokens[index++]!, code = token.slice(0, 2), path = token.slice(3);
      if (code.includes("R") || code.includes("C")) changes.push({ path, old_path: tokens[index++]!, kind: "renamed" });
      else changes.push({ path, kind: code === "??" || code.includes("A") ? "created" : code.includes("D") ? "deleted" : "modified", ...(code === "??" ? { untracked: true } : {}) });
    }
    return changes;
  }
  const tracked = parseNameStatus(await git(workspace.path, ["diff", "--name-status", "-z", "--find-renames", workspace.base_commit!], workspace.signal));
  const known = new Set(tracked.map((change) => change.path));
  const untracked = (await git(workspace.path, ["ls-files", "--others", "--exclude-standard", "-z"], workspace.signal)).split("\0").filter(Boolean).filter((path) => !known.has(path)).map((path) => ({ path, kind: "created" as const, untracked: true }));
  return [...tracked, ...untracked];
}
export async function changedFiles(workspace: Workspace): Promise<string[]> { return (await collectChanges(workspace)).map((change) => change.path).sort(); }
export async function changedPathsForScope(workspace: Workspace): Promise<string[]> {
  return [...new Set((await collectChanges(workspace)).flatMap((change) => change.old_path ? [change.old_path, change.path] : [change.path]))].sort();
}
export async function createDiff(workspace: Workspace): Promise<string> {
  return workspace.kind !== "task_worktree" ? "" : git(workspace.path, ["diff", "--binary", "--no-ext-diff", workspace.base_commit!], workspace.signal);
}
export async function createManifest(workspace: Workspace, artifactDir: string, changes?: WorkspaceChange[], assertAuthority?: () => void): Promise<ManifestEntry[]> {
  const entries: ManifestEntry[] = [];
  let copied = 0;
  for (const change of changes ?? await collectChanges(workspace)) {
    const entry: ManifestEntry = { ...change };
    if (change.kind !== "deleted") {
      const absolute = resolve(workspace.path, change.path);
      if (!isWithin(workspace.path, absolute)) throw new BridgeError("INVALID_PATH", "Git change escapes worktree");
      const info = await lstat(absolute);
      entry.mode = info.mode & 0o7777; entry.bytes = info.size;
      if (info.isSymbolicLink()) {
        entry.link_target = await readlink(absolute);
        entry.sha256 = createHash("sha256").update(entry.link_target).digest("hex");
      } else if (info.isFile()) {
        if (!isWithin(workspace.path, await realpath(absolute))) throw new BridgeError("INVALID_PATH", "Artifact source escapes worktree");
        entry.sha256 = createHash("sha256").update(await readFile(absolute)).digest("hex");
        if (change.untracked) {
          const copy = join(artifactDir, "files", change.path);
          assertAuthority?.();
          await mkdir(dirname(copy), { recursive: true, mode: 0o700 });
          assertAuthority?.();
          await copyFile(absolute, copy);
          entry.artifact_path = relative(artifactDir, copy); entry.artifact_id = `file-${++copied}`;
        }
      }
    }
    entries.push(entry);
  }
  return entries;
}
export type WorktreeEntry = { path: string; head?: string; branch?: string; locked?: boolean; prunable?: boolean };
export async function worktreeEntries(root: string, signal?: AbortSignal): Promise<WorktreeEntry[]> {
  const tokens = (await git(root, ["worktree", "list", "--porcelain", "-z"], signal)).split("\0");
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | undefined;
  for (const token of tokens) {
    if (token.startsWith("worktree ")) { current = { path: token.slice(9) }; entries.push(current); }
    else if (current && token.startsWith("HEAD ")) current.head = token.slice(5);
    else if (current && token.startsWith("branch ")) current.branch = token.slice(7);
    else if (current && (token === "locked" || token.startsWith("locked "))) current.locked = true;
    else if (current && (token === "prunable" || token.startsWith("prunable "))) current.prunable = true;
  }
  return entries;
}
