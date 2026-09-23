import { constants } from "node:fs";
import { lstat, open, readFile, realpath, readlink, type FileHandle } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { BridgeError, nativeCode } from "../core/errors.js";
import { throwIfAborted } from "../core/async.js";
import { gitWithoutLazyFetch } from "../workspace/project.js";
import type { ByteRange, GitSource, ObjectFormat, SourceFile, SourceReference, WorkingSource } from "./model.js";

export type CaptureOptions = Readonly<{ max_bytes: number; signal?: AbortSignal }>;
export type WorkspaceCapture = Readonly<{
  root: string; workspace_id: string; workspace_generation: number; capture_sequence: number;
  input_commit_oid?: string;
}>;
// These flags are required capabilities, not best-effort fallbacks. Source reads never invoke filters or refresh the index.
const readFlags = ["--no-optional-locks", "--literal-pathspecs", "--no-replace-objects", "-c", "core.fsmonitor=false"];
const readGit = (root: string, args: string[], signal?: AbortSignal) => gitWithoutLazyFetch(root, [...readFlags, ...args], signal);
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function validateSourcePath(path: string): void {
  if (!path.length || Buffer.byteLength(path) > 4096 || isAbsolute(path) || path.includes("\0") ||
      path.split("/").some(part => !part || part === "." || part === ".." || part === ".git") ||
      Buffer.from(path, "utf8").toString("utf8") !== path) {
    throw new BridgeError("SOURCE_PATH_INVALID", "Expected a representable Git-relative source path outside .git");
  }
}
function limit(options: CaptureOptions): void {
  // Eight MiB is the observation read ceiling, below the existing Git helper's output ceiling.
  if (!Number.isSafeInteger(options.max_bytes) || options.max_bytes < 1 || options.max_bytes > 8 * 1024 * 1024) {
    throw new BridgeError("SOURCE_LIMIT_INVALID", "Source byte budget must be between one byte and eight MiB");
  }
  throwIfAborted(options.signal);
}
function oid(value: string, format: ObjectFormat): string {
  const length = format === "sha1" ? 40 : 64;
  if (value.length !== length || !/^[0-9a-f]+$/i.test(value)) throw new BridgeError("SOURCE_OID_INVALID", "A full object ID in the repository's object format is required");
  return value.toLowerCase();
}
async function identity(root: string, signal?: AbortSignal): Promise<{ root: string; repository_id: string; object_format: ObjectFormat }> {
  const canonical = await realpath(root);
  const top = await realpath((await readGit(canonical, ["rev-parse", "--show-toplevel"], signal)).replace(/\n$/, ""));
  if (top !== canonical) throw new BridgeError("SOURCE_WORKSPACE_ROOT_INVALID", "Source paths are relative to the complete registered worktree root");
  const common = await realpath((await readGit(canonical, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal)).replace(/\n$/, ""));
  const format = (await readGit(canonical, ["rev-parse", "--show-object-format=storage"], signal)).trim();
  if (format !== "sha1" && format !== "sha256") throw new BridgeError("SOURCE_OBJECT_FORMAT_UNSUPPORTED", "Unsupported Git storage object format");
  return { root: canonical, repository_id: createHash("sha256").update(common).digest("hex").slice(0, 24), object_format: format };
}
function text(bytes: Uint8Array): string {
  try {
    const value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (value.includes("\0")) throw new Error("binary source");
    return value;
  } catch (cause) {
    throw new BridgeError("SOURCE_ENCODING_UNSUPPORTED", "Source is not supported UTF-8 text", { cause });
  }
}

/** The caller establishes access to root; exact Git objects, not the current checkout, supply the bytes. */
export async function readCommittedFile(root: string, commit: string, path: string, options: CaptureOptions): Promise<SourceFile> {
  validateSourcePath(path); limit(options);
  const repo = await identity(root, options.signal);
  const commit_oid = oid(commit, repo.object_format);
  if ((await readGit(repo.root, ["cat-file", "-t", commit_oid], options.signal)).trim() !== "commit") {
    throw new BridgeError("SOURCE_COMMIT_REQUIRED", "The input must identify a commit object, not a tag or tree");
  }
  const tree_oid = oid((await readGit(repo.root, ["rev-parse", "--verify", `${commit_oid}^{tree}`], options.signal)).trim(), repo.object_format);
  const source: GitSource = Object.freeze({ kind: "commit", repository_id: repo.repository_id,
    object_format: repo.object_format, commit_oid, tree_oid, path });
  const entries = (await readGit(repo.root, ["ls-tree", "-z", "--full-tree", commit_oid, "--", path], options.signal)).split("\0").filter(Boolean);
  if (!entries.length) return Object.freeze({ status: "absent_in_commit", source });
  if (entries.length !== 1) throw new BridgeError("SOURCE_TREE_INVALID", "Exact source lookup did not produce one tree entry");
  const entry = entries[0]!;
  const tab = entry.indexOf("\t");
  const header = /^(\d{6}) (blob|tree|commit) ([a-f0-9]+)$/.exec(entry.slice(0, tab));
  if (!header || entry.slice(tab + 1) !== path) throw new BridgeError("SOURCE_TREE_INVALID", "Tree entry cannot be represented exactly");
  const mode = header[1]!, type = header[2]!, object_oid = oid(header[3]!, repo.object_format);
  if (mode === "120000" && type === "blob") return Object.freeze({ status: "non_source", source, entry_kind: "symlink", mode, object_oid });
  if (mode === "160000" && type === "commit") return Object.freeze({ status: "non_source", source, entry_kind: "submodule", mode, object_oid });
  if (mode === "040000" && type === "tree") return Object.freeze({ status: "non_source", source, entry_kind: "directory", mode, object_oid });
  if (!['100644', '100755'].includes(mode) || type !== "blob") throw new BridgeError("SOURCE_TREE_INVALID", "Unsupported or contradictory source tree entry");
  const count = (await readGit(repo.root, ["cat-file", "-s", object_oid], options.signal)).trim();
  if (!/^\d+$/.test(count)) throw new BridgeError("SOURCE_TREE_INVALID", "Invalid Git object size");
  const size = Number(count);
  if (!Number.isSafeInteger(size) || size > options.max_bytes) throw new BridgeError("SOURCE_TOO_LARGE", "Source exceeds the admitted byte budget");
  const value = await readGit(repo.root, ["cat-file", "blob", object_oid], options.signal);
  const bytes = Buffer.from(value, "utf8");
  // The historical Git helper returns strings. Prove its UTF-8 conversion preserved the exact blob before exposing text.
  const actual = createHash(repo.object_format).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  if (bytes.length !== size || actual !== object_oid) throw new BridgeError("SOURCE_ENCODING_UNSUPPORTED", "Git source could not be represented without byte loss");
  return Object.freeze({ status: "present", source, mode, blob_oid: object_oid, content_sha256: digest(bytes),
    byte_length: bytes.length, text: text(bytes), consistency: "immutable_git_blob" });
}

function contained(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix !== ".." && !suffix.startsWith("../") && !isAbsolute(suffix);
}
async function descriptorPath(handle: FileHandle, root: string, expected?: string): Promise<void> {
  let actual: string;
  try { actual = await readlink(`/proc/self/fd/${handle.fd}`); }
  catch (cause) { throw new BridgeError("SOURCE_DESCRIPTOR_UNAVAILABLE", "The capture descriptor identity could not be established", { cause }); }
  if (actual.endsWith(" (deleted)") || !contained(root, actual) || (expected !== undefined && actual !== expected)) {
    throw new BridgeError("SOURCE_CAPTURE_MOVED", "The opened source has moved outside its verified capture identity");
  }
}

/** Linux mount identity belongs to the open descriptor, including same-device bind mounts. */
export async function sourceMountId(handle: FileHandle): Promise<string> {
  let info: string;
  try { info = await readFile(`/proc/self/fdinfo/${handle.fd}`, "utf8"); }
  catch (cause) { throw new BridgeError("SOURCE_MOUNT_ID_UNAVAILABLE", "The source descriptor mount identity could not be established", { cause }); }
  return parseSourceMountId(info);
}

export function parseSourceMountId(info: string): string {
  const ids = [...info.matchAll(/^mnt_id:[ \t]*(\d+)[ \t]*$/gm)];
  if (ids.length !== 1) throw new BridgeError("SOURCE_MOUNT_ID_UNAVAILABLE", "The source descriptor has no unique Linux mount identity");
  return ids[0]![1]!;
}

export async function assertSourceMount(handle: FileHandle, worktreeMountId: string): Promise<void> {
  if (await sourceMountId(handle) !== worktreeMountId) {
    throw new BridgeError("SOURCE_MOUNT_BOUNDARY", "Source capture cannot cross the registered worktree mount boundary");
  }
}

async function assertNoGitlink(root: string, commits: readonly string[], path: string, signal?: AbortSignal): Promise<void> {
  const parts = path.split("/");
  const ancestors = parts.map((_, index) => parts.slice(0, index + 1).join("/"));
  const inspect = async (args: string[], pattern: RegExp): Promise<void> => {
    const output = await readGit(root, args, signal);
    for (const entry of output.split("\0")) {
      if (!entry) continue;
      const tab = entry.indexOf("\t");
      const metadata = tab < 0 ? null : pattern.exec(entry.slice(0, tab));
      const entryPath = entry.slice(tab + 1);
      if (!metadata || !entryPath || entryPath.includes("\ufffd")) {
        throw new BridgeError("SOURCE_TREE_INVALID", "Git repository boundary lookup was not exact");
      }
      if (!ancestors.includes(entryPath)) continue;
      if (metadata[1] === "160000") {
        throw new BridgeError("SOURCE_REPOSITORY_BOUNDARY", "Source capture cannot enter a nested Git repository");
      }
    }
  };
  for (const commit of commits) {
    await inspect(["ls-tree", "-z", "--full-tree", commit, "--", ...ancestors], /^(\d{6}) (?:blob|tree|commit) [a-f0-9]+$/);
  }
  await inspect(["ls-files", "--stage", "-z", "--", ...ancestors], /^(\d{6}) [a-f0-9]+ [0-3]$/);
}

async function assertNoNestedMarker(handle: FileHandle): Promise<void> {
  try {
    await lstat(`/proc/self/fd/${handle.fd}/.git`);
    throw new BridgeError("SOURCE_REPOSITORY_BOUNDARY", "Source capture cannot enter a nested Git repository");
  } catch (error) {
    if (nativeCode(error) !== "ENOENT") throw error;
  }
}

/** Linux descriptor-anchored sampling. Captures are explicitly not atomic snapshots of a live workspace. */
export async function captureWorkingFile(workspace: WorkspaceCapture, path: string, options: CaptureOptions): Promise<SourceFile> {
  validateSourcePath(path); limit(options);
  if (process.platform !== "linux") throw new BridgeError("SOURCE_CAPTURE_UNSUPPORTED", "Descriptor-anchored source capture is qualified only for Linux");
  if (!workspace.workspace_id || !Number.isSafeInteger(workspace.workspace_generation) || workspace.workspace_generation < 1 ||
      !Number.isSafeInteger(workspace.capture_sequence) || workspace.capture_sequence < 1) {
    throw new BridgeError("SOURCE_CAPTURE_ID_INVALID", "An identified workspace generation and capture sequence are required");
  }
  const repo = await identity(workspace.root, options.signal);
  const head_anchor = oid((await readGit(repo.root, ["rev-parse", "--verify", "HEAD^{commit}"], options.signal)).trim(), repo.object_format);
  const commits = [head_anchor];
  if (workspace.input_commit_oid !== undefined) {
    const input = oid(workspace.input_commit_oid, repo.object_format);
    if ((await readGit(repo.root, ["cat-file", "-t", input], options.signal)).trim() !== "commit") {
      throw new BridgeError("SOURCE_COMMIT_REQUIRED", "The input must identify a commit object");
    }
    if (input !== head_anchor) commits.push(input);
  }
  await assertNoGitlink(repo.root, commits, path, options.signal);
  const source: WorkingSource = Object.freeze({ kind: "working_capture", repository_id: repo.repository_id,
    object_format: repo.object_format, workspace_id: workspace.workspace_id, workspace_generation: workspace.workspace_generation,
    capture_id: randomUUID(), capture_sequence: workspace.capture_sequence, head_anchor, path });
  const handles: FileHandle[] = [];
  const directories: { handle: FileHandle; expected: string; ctimeNs: bigint }[] = [];
  try {
    handles.push(await open(repo.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
    await descriptorPath(handles[0]!, repo.root, repo.root);
    const worktreeMountId = await sourceMountId(handles[0]!);
    const parts = path.split("/");
    for (let index = 0; index < parts.length - 1; index++) {
      throwIfAborted(options.signal);
      const parent = handles[handles.length - 1]!;
      const next = await open(`/proc/self/fd/${parent.fd}/${parts[index]!}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      handles.push(next);
      const expected = resolve(repo.root, ...parts.slice(0, index + 1));
      await descriptorPath(next, repo.root, expected);
      await assertSourceMount(next, worktreeMountId);
      await assertNoNestedMarker(next);
      directories.push({ handle: next, expected, ctimeNs: (await next.stat({ bigint: true })).ctimeNs });
    }
    const parent = handles[handles.length - 1]!;
    let handle: FileHandle;
    try {
      handle = await open(`/proc/self/fd/${parent.fd}/${parts[parts.length - 1]!}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (nativeCode(error) === "ELOOP") return Object.freeze({ status: "non_source", source, entry_kind: "symlink" });
      throw error;
    }
    handles.push(handle);
    await assertSourceMount(handle, worktreeMountId);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) return Object.freeze({ status: "non_source", source, entry_kind: before.isDirectory() ? "directory" : "special" });
    await descriptorPath(handle, repo.root, resolve(repo.root, path));
    if (before.size > BigInt(options.max_bytes)) throw new BridgeError("SOURCE_TOO_LARGE", "Source exceeds the admitted byte budget");
    // An extra byte detects growth beyond the budget. Identity metadata detects common concurrent-save races.
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let offset = 0;
    while (offset < bytes.length) {
      throwIfAborted(options.signal);
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    await descriptorPath(handle, repo.root, resolve(repo.root, path));
    throwIfAborted(options.signal);
    await assertNoGitlink(repo.root, commits, path, options.signal);
    if (BigInt(offset) !== before.size || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new BridgeError("SOURCE_CHANGED_DURING_CAPTURE", "Source changed during sampling; no current text observation was published");
    }
    if ((await readGit(repo.root, ["rev-parse", "--verify", "HEAD^{commit}"], options.signal)).trim() !== head_anchor) {
      throw new BridgeError("SOURCE_HEAD_CHANGED", "Workspace HEAD changed during sampling");
    }
    for (const directory of directories) {
      await descriptorPath(directory.handle, repo.root, directory.expected);
      await assertNoNestedMarker(directory.handle);
      if ((await directory.handle.stat({ bigint: true })).ctimeNs !== directory.ctimeNs) {
        throw new BridgeError("SOURCE_CAPTURE_MOVED", "An ancestor changed during source capture");
      }
    }
    await descriptorPath(handle, repo.root, resolve(repo.root, path));
    const captured = bytes.subarray(0, offset);
    return Object.freeze({ status: "present", source, mode: (before.mode & 0o111n) ? "100755" : "100644",
      content_sha256: digest(captured), byte_length: offset, text: text(captured), consistency: "sampled_file_not_atomic" });
  } catch (error) {
    if (nativeCode(error) === "ENOENT") return Object.freeze({ status: "missing_during_capture", source });
    if (nativeCode(error) === "ELOOP" || nativeCode(error) === "ENOTDIR") throw new BridgeError("SOURCE_PATH_UNSAFE", "An ancestor is not an owned non-symlink directory", { cause: error });
    throw error;
  } finally {
    const closed = await Promise.allSettled(handles.reverse().map(handle => handle.close()));
    const failed = closed.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw new BridgeError("SOURCE_CLOSE_FAILED", "Capture descriptor release failed", { cause: failed.reason });
  }
}

export function sourceReference(file: SourceFile): SourceReference {
  return Object.freeze({ source: file.source, status: file.status,
    ...(file.status === "present" ? { content_sha256: file.content_sha256, byte_length: file.byte_length, consistency: file.consistency, mode: file.mode } : {}),
    ...(file.status === "non_source" ? { entry_kind: file.entry_kind, ...(file.mode ? { mode: file.mode } : {}), ...(file.object_oid ? { object_oid: file.object_oid } : {}) } : {}) });
}

/** Slice captured UTF-8 bytes, never a subsequently modified live path. */
export function sourceExcerpt(file: SourceFile, range: ByteRange): string {
  if (file.status !== "present") throw new BridgeError("SOURCE_DETAIL_UNAVAILABLE", "This observation contains no source bytes");
  if (!Number.isSafeInteger(range.start_byte) || !Number.isSafeInteger(range.end_byte) || range.start_byte < 0 ||
      range.end_byte < range.start_byte || range.end_byte > file.byte_length) {
    throw new BridgeError("SOURCE_RANGE_INVALID", "Source excerpt range is outside the captured bytes");
  }
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.from(file.text).subarray(range.start_byte, range.end_byte)); }
  catch (cause) { throw new BridgeError("SOURCE_RANGE_INVALID", "Source excerpt splits a UTF-8 codepoint", { cause }); }
}
