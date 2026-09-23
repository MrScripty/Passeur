import { constants } from "node:fs";
import { open, opendir, readlink, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { BridgeError, nativeCode } from "../core/errors.js";
import { throwIfAborted } from "../core/async.js";
import { MAX_REGIONS, type Region } from "../contracts/coordination-control.js";
import { gitWithoutLazyFetch } from "../workspace/project.js";
import { validateSourcePath } from "./source.js";

export type SourceInventory = Readonly<{ paths: string[]; limitations: string[] }>;

const MAX_FILES = 256;
const MAX_ENTRIES = 4096;
const MAX_DEPTH = 24;
const SOURCE_EXTENSION = /\.(?:rs|ts|tsx|mts|cts)$/;
const GIT_READ_FLAGS = ["--no-optional-locks", "--literal-pathspecs", "--no-replace-objects", "-c", "core.fsmonitor=false"];

function sourcePath(path: string): boolean { return SOURCE_EXTENSION.test(path); }
function inside(root: string, actual: string): boolean {
  const suffix = relative(root, actual);
  return suffix !== ".." && !suffix.startsWith("../") && !isAbsolute(suffix);
}
function admitted(path: string, areas: readonly Region[]): boolean {
  return areas.some(area => area.path === path || (area.kind === "subtree" && path.startsWith(`${area.path}/`)));
}
async function currentDescriptorPath(handle: FileHandle, root: string): Promise<void> {
  let actual: string;
  try { actual = await readlink(`/proc/self/fd/${handle.fd}`); }
  catch (cause) { throw new BridgeError("STRUCTURAL_INVENTORY_RACE", "An inventory directory identity disappeared", { cause }); }
  if (actual.endsWith(" (deleted)") || !inside(root, actual)) {
    throw new BridgeError("STRUCTURAL_INVENTORY_RACE", "An inventory directory moved outside its registered root");
  }
}

/** Read names only. Exact bytes and path identity are checked again by source capture. */
export async function listDeclaredSourcePaths(workspaceRoot: string, inputCommitOid: string, areas: readonly Region[],
  limit: number, signal?: AbortSignal): Promise<SourceInventory> {
  if (process.platform !== "linux") throw new BridgeError("STRUCTURAL_INVENTORY_UNSUPPORTED", "Descriptor-anchored inventory is supported only on Linux");
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(inputCommitOid)) {
    throw new BridgeError("STRUCTURAL_INVENTORY_INPUT_INVALID", "Inventory requires a full immutable input commit ID");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_FILES || areas.length > MAX_REGIONS) {
    throw new BridgeError("STRUCTURAL_INVENTORY_LIMIT_INVALID", "Inventory limits or declared areas exceed admitted bounds");
  }
  for (const area of areas) {
    if (area.kind !== "file" && area.kind !== "subtree") throw new BridgeError("STRUCTURAL_INVENTORY_AREA_INVALID", "Unknown declared area kind");
    validateSourcePath(area.path);
  }
  throwIfAborted(signal);
  const root = await realpath(workspaceRoot);
  const top = await realpath((await gitWithoutLazyFetch(root, [...GIT_READ_FLAGS, "rev-parse", "--show-toplevel"], signal)).trim());
  if (top !== root) throw new BridgeError("STRUCTURAL_INVENTORY_ROOT_INVALID", "Inventory requires the registered complete worktree root");
  if ((await gitWithoutLazyFetch(root, [...GIT_READ_FLAGS, "cat-file", "-t", inputCommitOid], signal)).trim() !== "commit") {
    throw new BridgeError("STRUCTURAL_INVENTORY_INPUT_INVALID", "Inventory input is not a commit object");
  }

  const limitations = new Set<string>();
  const candidates = new Set<string>();
  const repositoryBoundaries = new Set<string>();
  const beneathBoundary = (path: string): boolean =>
    [...repositoryBoundaries].some(boundary => path === boundary || path.startsWith(`${boundary}/`));
  const blockBoundary = (path: string): void => {
    repositoryBoundaries.add(path);
    limitations.add("nested_repository_boundary");
    for (const candidate of candidates) if (candidate === path || candidate.startsWith(`${path}/`)) candidates.delete(candidate);
  };
  const add = (path: string): void => {
    if (!sourcePath(path) || !admitted(path, areas)) return;
    if (beneathBoundary(path)) { limitations.add("nested_repository_boundary"); return; }
    // The Git helper decodes stdout as UTF-8. A replacement character cannot prove the original path bytes.
    if (path.includes("\ufffd")) { limitations.add("source_path_unrepresentable"); return; }
    try { validateSourcePath(path); } catch { limitations.add("source_path_unrepresentable"); return; }
    if (candidates.has(path)) return;
    if (candidates.size < limit) { candidates.add(path); return; }
    limitations.add("source_file_inventory_limit");
    const largest = [...candidates].sort().at(-1)!;
    if (path < largest) { candidates.delete(largest); candidates.add(path); }
  };
  if (areas.length === 0) return { paths: [], limitations: [] };
  // Include every ancestor: Git pathspecs for a path inside a gitlink do not necessarily print that gitlink.
  const paths = [...new Set(areas.flatMap(area => area.path.split("/").map((_, index, parts) => parts.slice(0, index + 1).join("/"))))];
  const currentHead = (await gitWithoutLazyFetch(root, [...GIT_READ_FLAGS, "rev-parse", "--verify", "HEAD^{commit}"], signal)).trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(currentHead)) {
    throw new BridgeError("STRUCTURAL_INVENTORY_HEAD_INVALID", "Working inventory requires a full HEAD commit ID");
  }
  const tree = (commit: string) => gitWithoutLazyFetch(root,
    [...GIT_READ_FLAGS, "ls-tree", "-r", "-z", "--full-tree", commit, "--", ...paths], signal);
  let boundaryUncertain = false;
  const collectTree = (output: string, includeSource: boolean): void => {
    for (const line of output.split("\0")) {
      if (!line) continue;
      const separator = line.indexOf("\t");
      const metadata = /^(\d{6}) (blob|tree|commit) [a-f0-9]+$/.exec(line.slice(0, separator));
      if (!metadata || separator < 0) { limitations.add("tree_entry_unrepresentable"); boundaryUncertain = true; continue; }
      const path = line.slice(separator + 1);
      if (path.includes("\ufffd")) { limitations.add("tree_entry_unrepresentable"); boundaryUncertain = true; continue; }
      if (metadata[1] === "160000") blockBoundary(path);
      else if (includeSource && (metadata[1] === "100644" || metadata[1] === "100755")) add(path);
      else if (includeSource && sourcePath(path) && admitted(path, areas)) limitations.add("non_source_input_entry");
    }
  };

  // A gitlink in any relevant repository view prevents descending into another repository's bytes.
  // An incomplete boundary inventory is fail-closed: no candidate may reach source capture.
  try {
    const inputTree = await tree(inputCommitOid);
    collectTree(inputTree, false);
    collectTree(await tree(currentHead), false);
    const index = await gitWithoutLazyFetch(root, [...GIT_READ_FLAGS, "ls-files", "--stage", "-z", "--", ...paths], signal);
    for (const line of index.split("\0")) {
      if (!line) continue;
      const separator = line.indexOf("\t");
      const metadata = /^(\d{6}) [a-f0-9]+ [0-3]$/.exec(line.slice(0, separator));
      if (!metadata || separator < 0 || line.slice(separator + 1).includes("\ufffd")) {
        limitations.add("index_entry_unrepresentable"); boundaryUncertain = true; continue;
      }
      if (metadata[1] === "160000") blockBoundary(line.slice(separator + 1));
    }
    if (boundaryUncertain) return { paths: [], limitations: [...limitations].sort() };
    for (const area of areas) if (area.kind === "file") add(area.path);
    // Input-only files must remain observable after deletion, checkout changes, or a different worker base.
    collectTree(inputTree, true);
  } catch (error) {
    if (error instanceof BridgeError && error.code === "GIT_OUTPUT_LIMIT") {
      return { paths: [], limitations: [...limitations, "repository_boundary_inventory_limit"].sort() };
    }
    else throw error;
  }

  let entries = 0;
  let stopped = false;
  const handles: FileHandle[] = [];
  async function walk(handle: FileHandle, prefix: string, depth: number): Promise<void> {
    throwIfAborted(signal);
    await currentDescriptorPath(handle, root);
    if (depth > MAX_DEPTH) { limitations.add("source_inventory_depth_limit"); return; }
    const names: string[] = [];
    try {
      const directory = await opendir(`/proc/self/fd/${handle.fd}`);
      for await (const entry of directory) {
        names.push(entry.name);
        if (names.length > MAX_ENTRIES - entries) {
          limitations.add("source_inventory_entry_limit"); stopped = true; return;
        }
      }
    }
    catch (error) {
      if (["ENOENT", "ENOTDIR", "EACCES"].includes(nativeCode(error) ?? "")) { limitations.add("source_inventory_unreadable"); return; }
      throw error;
    }
    await currentDescriptorPath(handle, root);
    entries += names.length;
    if (prefix && names.includes(".git")) { blockBoundary(prefix); return; }
    for (const name of names.sort()) {
      throwIfAborted(signal);
      if (name === ".git") continue;
      const path = prefix ? `${prefix}/${name}` : name;
      if (beneathBoundary(path)) continue;
      const relevant = areas.some(area => area.path === path || area.path.startsWith(`${path}/`) ||
        (area.kind === "subtree" && path.startsWith(`${area.path}/`)));
      if (!relevant) continue;
      let child: FileHandle;
      try { child = await open(`/proc/self/fd/${handle.fd}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
      catch (error) {
        if (["ELOOP", "ENOTDIR", "ENOENT", "EACCES"].includes(nativeCode(error) ?? "")) {
          limitations.add("source_inventory_unsafe_or_changed"); continue;
        }
        throw error;
      }
      handles.push(child);
      try {
        const stat = await child.stat();
        await currentDescriptorPath(handle, root);
        await currentDescriptorPath(child, root);
        if (stat.isDirectory()) {
          if (areas.some(area => area.kind === "subtree" && (area.path === path || path.startsWith(`${area.path}/`))) ||
              areas.some(area => area.path.startsWith(`${path}/`))) await walk(child, path, depth + 1);
        } else if (stat.isFile()) add(path);
        else limitations.add("non_source_working_entry");
      } finally { await child.close(); handles.pop(); }
      if (stopped) return;
    }
  }
  const rootHandle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  handles.push(rootHandle);
  try {
    await walk(rootHandle, "", 0);
  } catch (error) {
    if (error instanceof BridgeError && error.code === "STRUCTURAL_INVENTORY_RACE") limitations.add("source_inventory_race");
    else throw error;
  } finally {
    const closed = await Promise.allSettled(handles.reverse().map(handle => handle.close()));
    if (closed.some(result => result.status === "rejected")) throw new BridgeError("STRUCTURAL_INVENTORY_CLOSE_FAILED", "Inventory descriptor release failed");
  }
  if ((await gitWithoutLazyFetch(root, [...GIT_READ_FLAGS, "rev-parse", "--verify", "HEAD^{commit}"], signal)).trim() !== currentHead) {
    return { paths: [], limitations: [...limitations, "source_inventory_head_changed"].sort() };
  }
  return { paths: [...candidates].sort(), limitations: [...limitations].sort() };
}
