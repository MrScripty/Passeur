import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Region } from "../contracts/coordination-control.js";
import type { PeerResolutionChange, PeerResolutionSource } from "./peer-resolution.js";

export type PeerApplicationInput = Readonly<{
  /** A task-owned, exclusive, disposable workspace directory; never a shared source checkout. */
  workspaceRoot: string;
  scope: readonly Region[];
  sources: readonly PeerResolutionSource[];
  changes: readonly PeerResolutionChange[];
  /** Keeps the exact source tuple current for the entire callback, including all filesystem effects. */
  withCurrentSources<T>(sources: readonly PeerResolutionSource[], effect: () => Promise<T>): Promise<T>;
}>;

export type PeerApplicationResult = Readonly<{
  status: "applied" | "rejected" | "effect_unknown";
  paths: readonly string[];
  verified_after?: readonly Readonly<{ path: string; after_sha256: string | null }>[];
  reason?: "invalid_input" | "stale_source" | "preimage_changed" | "filesystem_error" | "publication_uncertain";
}>;

type Prepared = { path: string; absolute: string; before: string | null; after: Buffer | null; mode: number | null; temporary?: string };
const SHA256 = /^[a-f0-9]{64}$/;
// A single rename/unlink is the filesystem publication unit. Multiple paths require a transaction protocol.
const MAX_CHANGES = 1;
const MAX_FILE_BYTES = 1_048_576;
const MAX_TOTAL_BYTES = 4 * MAX_FILE_BYTES;

function validPath(path: unknown): path is string {
  return typeof path === "string" && path.length > 0 && Buffer.byteLength(path, "utf8") <= 4096 &&
    Buffer.from(path, "utf8").toString("utf8") === path && !path.startsWith("/") && !path.includes("\\") &&
    !/[\u0000-\u001f\u007f]/.test(path) && path.split("/").every(part => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git");
}

function inScope(path: string, scope: readonly Region[]): boolean {
  return scope.some(region => validPath(region.path) &&
    (region.kind === "file" ? path === region.path : region.kind === "subtree" && path.startsWith(`${region.path}/`)));
}

function hash(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }

function decodeChanges(input: PeerApplicationInput): Prepared[] | null {
  if (!isAbsolute(input.workspaceRoot) || !Array.isArray(input.scope) || !Array.isArray(input.sources) || !input.sources.length ||
      !Array.isArray(input.changes) || !input.changes.length || input.changes.length > MAX_CHANGES ||
      typeof input.withCurrentSources !== "function") return null;
  if (input.scope.length === 0 || input.scope.length > 256 || input.scope.some(region =>
    !region || (region.kind !== "file" && region.kind !== "subtree") || !validPath(region.path))) return null;
  if (new Set(input.scope.map(region => `${region.kind}:${region.path}`)).size !== input.scope.length) return null;
  if (input.sources.length > 64 || input.sources.some(source => !source ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(source.work_id) ||
    !Number.isSafeInteger(source.work_revision) || source.work_revision < 1 ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(source.input_oid) ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(source.selected_commit_oid))) return null;
  if (new Set(input.sources.map(source => source.work_id)).size !== input.sources.length) return null;
  const result: Prepared[] = [];
  let totalBytes = 0;
  let previous = "";
  for (const change of input.changes) {
    if (!change || !validPath(change.path) || change.path <= previous || !inScope(change.path, input.scope) ||
        (change.before_sha256 !== null && (typeof change.before_sha256 !== "string" || !SHA256.test(change.before_sha256))) ||
        (change.after_base64 !== null && (typeof change.after_base64 !== "string" ||
          change.after_base64.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(change.after_base64))) ||
        (change.before_sha256 === null && change.after_base64 === null)) return null;
    const after = change.after_base64 === null ? null : Buffer.from(change.after_base64, "base64");
    if (after && (after.length > MAX_FILE_BYTES || after.toString("base64") !== change.after_base64)) return null;
    totalBytes += after?.length ?? 0;
    if (totalBytes > MAX_TOTAL_BYTES) return null;
    const absolute = join(input.workspaceRoot, ...change.path.split("/"));
    const rel = relative(input.workspaceRoot, absolute);
    if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) return null;
    result.push({ path: change.path, absolute, before: change.before_sha256, after, mode: null });
    previous = change.path;
  }
  return result;
}

/** Keep each parent inode open; /proc/self/fd paths resolve from that inode even if a peer renames it. */
async function anchoredParents(root: string, items: Prepared[]): Promise<{ handles: FileHandle[]; paths: Map<string, string> }> {
  const handles: FileHandle[] = [];
  const paths = new Map<string, string>();
  try {
    const rootHandle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    handles.push(rootHandle);
    paths.set("", `/proc/self/fd/${rootHandle.fd}`);
    for (const item of items) {
      const parts = item.path.split("/");
      let prefix = "";
      for (const part of parts.slice(0, -1)) {
        const next = prefix ? `${prefix}/${part}` : part;
        if (!paths.has(next)) {
          const parent = paths.get(prefix)!;
          const handle = await open(`${parent}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          handles.push(handle);
          paths.set(next, `/proc/self/fd/${handle.fd}`);
        }
        prefix = next;
      }
      item.absolute = `${paths.get(prefix)!}/${parts.at(-1)!}`;
    }
    return { handles, paths };
  } catch (error) {
    await Promise.allSettled(handles.map(handle => handle.close()));
    throw error;
  }
}

async function inspectPath(item: Prepared): Promise<"valid" | "changed"> {
  let handle: FileHandle;
  try { handle = await open(item.absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return item.before === null ? "valid" : "changed";
  }
  try {
    const stat = await handle.stat();
    if (item.before === null || !stat.isFile() || stat.size > MAX_FILE_BYTES) return "changed";
    const bytes = await handle.readFile();
    if (hash(bytes) !== item.before) return "changed";
    item.mode = stat.mode & 0o777;
    return "valid";
  } finally { await handle.close(); }
}

async function verifyAfter(items: Prepared[]): Promise<Readonly<{ path: string; after_sha256: string | null }>[]> {
  const verified = [];
  for (const item of items) {
    if (item.after === null) {
      try { await lstat(item.absolute); throw new Error("Deleted path was recreated"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      verified.push({ path: item.path, after_sha256: null });
      continue;
    }
    const handle = await open(item.absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== item.after.length) throw new Error("Applied file changed type or size");
      const actual = hash(await handle.readFile());
      if (actual !== hash(item.after)) throw new Error("Applied bytes differ from proposal");
      verified.push({ path: item.path, after_sha256: actual });
    } finally { await handle.close(); }
  }
  return verified;
}

/**
 * Applies an already agreed manifest inside the caller's source-version publication guard.
 * The guard must serialize competing source publication, and the workspace must have one writer.
 * A failed/uncertain first publication or any later error is effect_unknown; callers must inspect
 * the workspace before retrying. No automatic replay is safe after that point.
 */
export async function applyPeerResolutionChanges(input: PeerApplicationInput): Promise<PeerApplicationResult> {
  const prepared = decodeChanges(input);
  if (!prepared) return { status: "rejected", paths: [], reason: "invalid_input" };
  const paths = prepared.map(item => item.path);
  let publicationAttempted = false;
  let guardEntered = false;
  let guardRequested = false;
  let guardCalls = 0;
  let effectResult: PeerApplicationResult | undefined;
  const staged: Prepared[] = [];
  let parentHandles: FileHandle[] = [];
  try {
    const rootStat = await lstat(input.workspaceRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await realpath(input.workspaceRoot) !== resolve(input.workspaceRoot)) {
      return { status: "rejected", paths, reason: "invalid_input" };
    }
    try { parentHandles = (await anchoredParents(input.workspaceRoot, prepared)).handles; }
    catch (error) {
      if (["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        return { status: "rejected", paths, reason: "preimage_changed" };
      }
      throw error;
    }
    guardRequested = true;
    const guarded = await input.withCurrentSources(input.sources, async () => {
      if (++guardCalls !== 1) throw new Error("Source guard invoked application more than once");
      guardEntered = true;
      const effect = async (): Promise<PeerApplicationResult> => {
      for (const item of prepared) {
        if (await inspectPath(item) !== "valid") return { status: "rejected", paths, reason: "preimage_changed" } as const;
      }
      for (const item of prepared) {
        if (item.after === null) continue;
        item.temporary = `${item.absolute}.passeur-stage-${randomUUID()}`;
        staged.push(item);
        const stage = await open(item.temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, item.mode ?? 0o600);
        try {
          await stage.writeFile(item.after);
          if (item.mode !== null) await stage.chmod(item.mode);
        } finally { await stage.close(); }
      }
      for (const item of prepared) {
        if (await inspectPath(item) !== "valid") {
          return publicationAttempted
            ? { status: "effect_unknown", paths, reason: "publication_uncertain" } as const
            : { status: "rejected", paths, reason: "preimage_changed" } as const;
        }
        publicationAttempted = true;
        if (item.after === null) await unlink(item.absolute);
        else await rename(item.temporary!, item.absolute);
        delete item.temporary;
      }
      return { status: "applied", paths, verified_after: await verifyAfter(prepared) } as const;
      };
      effectResult = await effect();
      return effectResult;
    });
    if (guardCalls !== 1 || guarded !== effectResult) return { status: publicationAttempted ? "effect_unknown" : "rejected", paths,
      reason: publicationAttempted ? "publication_uncertain" : "stale_source" };
    return guarded;
  } catch (error) {
    return { status: publicationAttempted ? "effect_unknown" : "rejected", paths,
      reason: publicationAttempted ? "publication_uncertain" : guardRequested && !guardEntered ? "stale_source" : "filesystem_error" };
  } finally {
    for (const item of staged) if (item.temporary) {
      try { await unlink(item.temporary); } catch { /* A leftover stage is non-authoritative. */ }
    }
    await Promise.allSettled(parentHandles.map(handle => handle.close()));
  }
}
