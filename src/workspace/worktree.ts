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

export type ManifestEntry = { path: string; kind: "modified" | "created" | "deleted" | "renamed"; mode?: number; bytes?: number; sha256?: string; link_target?: string; artifact_path?: string; artifact_id?: string };

export async function createManifest(workspace: Workspace, artifactDir: string): Promise<ManifestEntry[]> {
  const status = await sourceStatus(workspace.path);
  const entries: ManifestEntry[] = [];
  let copied = 0;
  for (const line of status) {
    const code = line.slice(0, 2);
    const raw = line.slice(3);
    const path = raw.includes(" -> ") ? raw.split(" -> ").at(-1)! : raw;
    const kind = code === "??" || code.includes("A") ? "created" : code.includes("D") ? "deleted" : code.includes("R") ? "renamed" : "modified";
    const entry: ManifestEntry = { path, kind };
    if (kind !== "deleted") {
      const absolute = resolve(workspace.path, path);
      const info = await lstat(absolute);
      entry.mode = info.mode & 0o7777;
      entry.bytes = info.size;
      if (info.isSymbolicLink()) {
        entry.link_target = await readlink(absolute);
        entry.sha256 = createHash("sha256").update(entry.link_target).digest("hex");
      } else if (info.isFile()) {
        entry.sha256 = createHash("sha256").update(await readFile(absolute)).digest("hex");
        if (code === "??") {
          const copy = join(artifactDir, "files", path);
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
