import type { LifecyclePolicy } from "../contracts/tasks.js";
import { copyFile, lstat, mkdir, readFile, readlink, readdir, realpath, rename, open, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { Delivery, WorkerStop } from "../contracts/types.js";
import type { Assignment } from "../contracts/agents.js";
import { BridgeError } from "../core/errors.js";
import { throwIfAborted } from "../core/async.js";
import { exactCommit, git, gitSterile, isAncestor, isWithin, refHead, sourceStatus, validateBranchRef, validateOid } from "./project.js";
export type Workspace = { kind: "source_read_only" | "task_worktree"; path: string; base_commit?: string; branch?: string; target_ref?: string; signal?: AbortSignal };
export type WorkspaceOptions = { signal?: AbortSignal; assertAuthority?: () => void; onIntent?: (workspace: Workspace) => Promise<void> };

export async function prepareWorkspace(root: string, request: Assignment, profile: LifecyclePolicy, projectId: string, taskId: string, options: WorkspaceOptions = {}): Promise<Workspace> {
  throwIfAborted(options.signal);
  if (request.mode === "review") return { kind: "source_read_only", path: root, ...(options.signal ? { signal: options.signal } : {}) };
  if (!profile.implementation.enabled || !profile.implementation.worktree_root) throw new BridgeError("IMPLEMENTATION_DISABLED", "Implementation workspaces are disabled in this profile");
  if (!request.target_ref || !request.base_commit) throw new BridgeError("INVALID_ASSIGNMENT", "Implementation requires base_commit and target_ref");
  await validateBranchRef(root, request.target_ref, options.signal);
  if (!await refHead(root, request.target_ref)) throw new BridgeError("TARGET_NOT_FOUND", "The intended local target branch does not exist");
  // The admitted commit owns the input; unrelated parent index/worktree bytes remain untouched.
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

/** A private common directory is presented at canonical_common_dir only inside the worker namespace. */
export type PrivateGitView = Readonly<{ private_common_dir: string; canonical_common_dir: string; admin_relative: string;
  baseline_index_sha256: string }>;
async function isolatedStoragePath(input: string, excluded: string[]): Promise<string> {
  const path = resolve(input), parent = dirname(path);
  if (await realpath(parent) !== parent || excluded.some((root) => isWithin(root, path) || isWithin(path, root))) {
    throw new BridgeError("PRIVATE_GIT_UNSAFE", "Private Git storage resolves into a protected workspace or repository");
  }
  return path;
}
async function effectiveGitConfig(workspace: string, key: string, boolean = false): Promise<string | undefined> {
  try { return (await git(workspace, ["config", ...(boolean ? ["--bool"] : []), "--get", key])).trim(); }
  catch (error) {
    if (error instanceof BridgeError && error.code === "GIT_ERROR" && error.message.includes("exited 1")) return undefined;
    throw error;
  }
}
export async function preparePrivateGitView(root: string, workspace: Workspace, privateCommonDir: string,
  assertAuthority: () => void = () => {}): Promise<PrivateGitView> {
  if (workspace.kind !== "task_worktree" || !workspace.base_commit || !workspace.branch) {
    throw new BridgeError("PRIVATE_GIT_UNAVAILABLE", "Private Git requires an owned implementation worktree");
  }
  // This controlled view copies the default hook directory. Custom hook or required signing
  // policy needs a native-qualified mapping before the worker can be allowed to commit.
  if (await effectiveGitConfig(workspace.path, "core.hooksPath") !== undefined ||
      await effectiveGitConfig(workspace.path, "commit.gpgsign", true) === "true") {
    throw new BridgeError("PRIVATE_GIT_POLICY_UNSUPPORTED", "Custom Git hooks or required commit signing cannot be preserved by this private view");
  }
  const common = await realpath((await git(workspace.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim());
  const admin = await realpath((await git(workspace.path, ["rev-parse", "--path-format=absolute", "--absolute-git-dir"])).trim());
  const adminRelative = relative(common, admin);
  if (!adminRelative.startsWith(`worktrees/`) || adminRelative.split("/").length !== 2 || !isWithin(common, admin)) {
    throw new BridgeError("PRIVATE_GIT_UNAVAILABLE", "Linked worktree has an unexpected Git administration path");
  }
  const privatePath = await isolatedStoragePath(privateCommonDir, [common, workspace.path, await realpath(root)]);
  const baselineIndex = sha256(await readFile(join(admin, "index")));
  assertAuthority();
  await mkdir(privatePath, { recursive: false, mode: 0o700 });
  if (await realpath(privatePath) !== privatePath) throw new BridgeError("PRIVATE_GIT_UNSAFE", "Created private Git directory was replaced");
  // Only the admitted commit closure is fetched. No sibling refs or canonical config are copied.
  await gitSterile(privatePath, ["init", "--bare", "-q"]);
  await gitSterile(privatePath, ["-c", "protocol.file.allow=always", "fetch", "--no-tags", "--no-write-fetch-head", root, workspace.base_commit]);
  await gitSterile(privatePath, ["config", "core.bare", "false"]);
  await gitSterile(privatePath, ["update-ref", workspace.branch, workspace.base_commit]);
  const privateAdmin = join(privatePath, adminRelative);
  assertAuthority();
  await mkdir(privateAdmin, { recursive: true, mode: 0o700 });
  for (const name of ["HEAD", "index", "commondir", "gitdir"]) {
    const source = join(admin, name);
    if (!(await lstat(source)).isFile()) throw new BridgeError("PRIVATE_GIT_UNAVAILABLE", `Unsafe linked-worktree ${name}`);
    assertAuthority();
    await copyFile(source, join(privateAdmin, name));
  }
  if ((await readFile(join(privateAdmin, "HEAD"), "utf8")).trim() !== `ref: ${workspace.branch}` ||
      (await readFile(join(privateAdmin, "commondir"), "utf8")).trim() !== "../..") {
    throw new BridgeError("PRIVATE_GIT_UNAVAILABLE", "Linked-worktree identity changed during private preparation");
  }
  const sourceHooks = join(common, "hooks"), privateHooks = join(privatePath, "hooks");
  for (const entry of await readdir(sourceHooks, { withFileTypes: true })) {
    if (!entry.isFile()) throw new BridgeError("PRIVATE_GIT_UNAVAILABLE", "Canonical hook directory contains a non-file entry");
    assertAuthority();
    await copyFile(join(sourceHooks, entry.name), join(privateHooks, entry.name));
  }
  // The private path is retained by the task resource; it is never deleted on preparation failure.
  if (sha256(await readFile(join(admin, "index"))) !== baselineIndex) {
    throw new BridgeError("HOST_INDEX_CHANGED", "Canonical task index changed during private preparation");
  }
  return { private_common_dir: privatePath, canonical_common_dir: common, admin_relative: adminRelative,
    baseline_index_sha256: baselineIndex };
}

export type PrivatePublication = Readonly<{ old_head: string; new_head: string; tree_oid: string;
  old_index_sha256: string; new_index_sha256: string; quarantine_path: string; canonical_admin_path: string }>;
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const objectFile = /^(?:[0-9a-f]{2}\/[0-9a-f]{38,62}|pack\/pack-[0-9a-f]{40,64}\.(?:pack|idx))$/;
async function copyObjectStore(source: string, destination: string, assertAuthority: () => void): Promise<void> {
  if (!(await lstat(source)).isDirectory() || await realpath(source) !== resolve(source)) {
    throw new BridgeError("PRIVATE_GIT_UNSAFE", "Private object directory was replaced");
  }
  async function visit(directory: string, prefix = ""): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      if (path === "info" && entry.isDirectory()) {
        if ((await readdir(absolute)).length) throw new BridgeError("PRIVATE_GIT_UNSAFE", "Private object store contains worker-selected object metadata");
      } else if (entry.isDirectory()) {
        if (!(/^[0-9a-f]{2}$/.test(path) || path === "pack")) throw new BridgeError("PRIVATE_GIT_UNSAFE", "Private object store contains an unexpected directory");
        assertAuthority(); await mkdir(join(destination, path), { recursive: true, mode: 0o700 });
        await visit(absolute, path);
      } else {
        if (!entry.isFile() || !objectFile.test(path) || !(await lstat(absolute)).isFile()) {
          throw new BridgeError("PRIVATE_GIT_UNSAFE", "Private object store contains a link or unexpected file");
        }
        assertAuthority(); await copyFile(absolute, join(destination, path));
      }
    }
  }
  await visit(source);
}
/** Build an inert object-only quarantine. No worker config, hooks, alternates, refs or transport are read. */
export async function preparePrivatePublication(root: string, workspace: Workspace, view: PrivateGitView,
  quarantinePath: string, workerStop: WorkerStop, assertAuthority: () => void = () => {}): Promise<PrivatePublication> {
  if (workerStop !== "confirmed") throw new BridgeError("PRIVATE_GIT_STOP_UNCONFIRMED", "Private Git cannot be inspected before confirmed native descendant stop");
  const canonicalAdmin = join(view.canonical_common_dir, view.admin_relative);
  if (workspace.kind !== "task_worktree" || !workspace.base_commit || !workspace.branch ||
      !isWithin(view.private_common_dir, join(view.private_common_dir, view.admin_relative)) ||
      await realpath(view.canonical_common_dir) !== view.canonical_common_dir ||
      await realpath(canonicalAdmin) !== canonicalAdmin ||
      (await readFile(join(workspace.path, ".git"), "utf8")).trim() !== `gitdir: ${canonicalAdmin}`) {
    throw new BridgeError("PRIVATE_GIT_UNSAFE", "Private view does not bind this linked worktree");
  }
  if (await realpath(view.private_common_dir) !== view.private_common_dir ||
      await realpath(join(view.private_common_dir, view.admin_relative)) !== join(view.private_common_dir, view.admin_relative)) {
    throw new BridgeError("PRIVATE_GIT_UNSAFE", "Private Git storage was replaced by a link");
  }
  const privateHead = (await readFile(join(view.private_common_dir, view.admin_relative, "HEAD"), "utf8")).trim();
  if (privateHead !== `ref: ${workspace.branch}`) throw new BridgeError("PRIVATE_BRANCH_CHANGED", "Private HEAD no longer selects the owned task branch");
  const privateRef = join(view.private_common_dir, workspace.branch);
  if (!(await lstat(privateRef)).isFile() || await realpath(privateRef) !== privateRef) {
    throw new BridgeError("PRIVATE_BRANCH_CHANGED", "Private branch has no plain loose ref");
  }
  const head = (await readFile(privateRef, "utf8")).trim(); validateOid(head);
  const quarantine = await isolatedStoragePath(quarantinePath, [view.private_common_dir, view.canonical_common_dir,
    workspace.path, await realpath(root)]);
  assertAuthority(); await mkdir(quarantine, { mode: 0o700 });
  if (await realpath(quarantine) !== quarantine) throw new BridgeError("PRIVATE_GIT_UNSAFE", "Created quarantine directory was replaced");
  await gitSterile(quarantine, ["init", "--bare", "-q"]);
  await copyObjectStore(join(view.private_common_dir, "objects"), join(quarantine, "objects"), assertAuthority);
  const commit = (await gitSterile(quarantine, ["rev-parse", "--verify", `${head}^{commit}`])).trim();
  const ancestor = (await gitSterile(quarantine, ["merge-base", workspace.base_commit, head])).trim();
  if (commit !== head || ancestor !== workspace.base_commit) {
    throw new BridgeError("PRIVATE_HISTORY_INVALID", "Private head does not descend from the admitted base");
  }
  const tree = (await gitSterile(quarantine, ["rev-parse", `${head}^{tree}`])).trim(); validateOid(tree);
  await gitSterile(quarantine, ["update-ref", "refs/heads/private-published", head]);
  await gitSterile(quarantine, ["symbolic-ref", "HEAD", "refs/heads/private-published"]);
  await gitSterile(quarantine, ["read-tree", head]);
  await gitSterile(quarantine, ["-c", "core.bare=false", `--work-tree=${workspace.path}`, "update-index", "--refresh"]);
  const status = await gitSterile(quarantine, ["-c", "core.bare=false", `--work-tree=${workspace.path}`, "status", "--porcelain=v1", "--untracked-files=all"]);
  if (status) throw new BridgeError("PRIVATE_WORKTREE_DIRTY", "Workspace bytes or untracked files differ from the private commit");
  const old = await refHead(root, workspace.branch);
  if (old !== workspace.base_commit) throw new BridgeError("HOST_BRANCH_CHANGED", "Canonical task branch changed before publication intent");
  const indexPath = join(canonicalAdmin, "index");
  const oldIndex = sha256(await readFile(indexPath));
  if (oldIndex !== view.baseline_index_sha256) throw new BridgeError("HOST_INDEX_CHANGED", "Canonical task index changed after private-view preparation");
  const newIndex = sha256(await readFile(join(quarantine, "index")));
  return { old_head: old, new_head: head, tree_oid: tree, old_index_sha256: oldIndex,
    new_index_sha256: newIndex, quarantine_path: quarantine, canonical_admin_path: canonicalAdmin };
}

/** Requires a previously durable task-owned intent and confirmed native descendant stop. */
export async function publishPrivateCommit(root: string, workspace: Workspace, publication: PrivatePublication,
  workerStop: WorkerStop, assertAuthority: () => void = () => {}): Promise<void> {
  if (workerStop !== "confirmed") throw new BridgeError("PRIVATE_GIT_STOP_UNCONFIRMED", "Private Git cannot be published before confirmed native descendant stop");
  if (workspace.kind !== "task_worktree" || !workspace.branch || !workspace.base_commit ||
      publication.old_head !== workspace.base_commit) throw new BridgeError("PRIVATE_PUBLICATION_INVALID", "Publication identity differs from the owned task");
  if ((await readFile(join(workspace.path, ".git"), "utf8")).trim() !== `gitdir: ${publication.canonical_admin_path}` ||
      await realpath(publication.canonical_admin_path) !== publication.canonical_admin_path) {
    throw new BridgeError("PRIVATE_PUBLICATION_CONFLICT", "Canonical linked-worktree administration changed");
  }
  const indexPath = join(publication.canonical_admin_path, "index");
  const currentHead = await refHead(root, workspace.branch);
  const currentIndex = sha256(await readFile(indexPath));
  if (currentHead === publication.new_head && currentIndex === publication.new_index_sha256) return;
  if (!((currentHead === publication.old_head && currentIndex === publication.old_index_sha256) ||
      (currentHead === publication.new_head && currentIndex === publication.old_index_sha256))) {
    throw new BridgeError("PRIVATE_PUBLICATION_CONFLICT", "Canonical branch/index diverged from the retained publication states");
  }
  const quarantine = publication.quarantine_path;
  if ((await gitSterile(quarantine, ["rev-parse", "--verify", `${publication.new_head}^{commit}`])).trim() !== publication.new_head ||
      (await gitSterile(quarantine, ["rev-parse", `${publication.new_head}^{tree}`])).trim() !== publication.tree_oid ||
      sha256(await readFile(join(quarantine, "index"))) !== publication.new_index_sha256) {
    throw new BridgeError("PRIVATE_PUBLICATION_INVALID", "Retained quarantined commit or index changed");
  }
  if (currentHead === publication.old_head) {
    assertAuthority();
    await gitSterile(root, ["-c", "protocol.file.allow=always", "fetch", "--no-tags", "--no-write-fetch-head", quarantine, publication.new_head]);
    if (await exactCommit(root, publication.new_head) !== publication.new_head) throw new BridgeError("PRIVATE_PUBLICATION_INVALID", "Exact worker commit was not imported");
  }
  const lock = `${indexPath}.lock`;
  assertAuthority();
  let handle;
  try { handle = await open(lock, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0), 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new BridgeError("PRIVATE_PUBLICATION_LOCKED", "Canonical index lock already exists; its owner is unknown");
    throw error;
  }
  const ownedLock = await handle.stat();
  try {
    await handle.writeFile(await readFile(join(quarantine, "index")));
    await handle.sync();
    if (sha256(await readFile(indexPath)) !== publication.old_index_sha256 ||
        await refHead(root, workspace.branch) !== currentHead) {
      throw new BridgeError("PRIVATE_PUBLICATION_CONFLICT", "Canonical branch/index changed before index installation");
    }
    if (currentHead === publication.old_head) {
      assertAuthority();
      await gitSterile(root, ["update-ref", workspace.branch, publication.new_head, publication.old_head]);
    }
    assertAuthority(); await handle.close();
    await rename(lock, indexPath);
  } catch (error) {
    const currentLock = await lstat(lock).catch(() => undefined);
    if (currentLock?.dev === ownedLock.dev && currentLock.ino === ownedLock.ino) await unlink(lock).catch(() => undefined);
    throw error;
  } finally { await handle.close().catch(() => undefined); }
  if (sha256(await readFile(indexPath)) !== publication.new_index_sha256) throw new BridgeError("PRIVATE_PUBLICATION_INVALID", "Installed canonical index differs from the retained intent");
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
// Read-only inventory has no task-policy dependency. Preserve the existing import surface.
export { worktreeEntries, type WorktreeEntry } from "./inventory.js";
