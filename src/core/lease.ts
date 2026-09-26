import { mkdir, lstat, open, readFile, readdir, realpath, rmdir, unlink } from "node:fs/promises";
import { BridgeError, filesystemFailure, nativeCode } from "./errors.js";
import { processIdentity, sameProcess, type ProcessIdentity } from "./process-identity.js";

// All cooperating processes must use this policy and the same canonical state namespace.
const STALE_MS = 30_000;
const UPDATE_MS = 10_000;
type Ownership = { version: 1; process: ProcessIdentity; device: string; inode: string };

function inUse(path: string, cause?: unknown): BridgeError {
  return new BridgeError("PROJECT_IN_USE", "Repository coordination authority is held or needs explicit reconciliation", {
    cause, stage: "lease.acquire", path, native_code: "ELOCKED",
    next_action: "Use the existing coordinator or reconcile the exact lease owner before preparing this connection.",
  });
}

async function lockInstance(lockPath: string): Promise<{ device: string; inode: string }> {
  const info = await lstat(lockPath, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) throw inUse(lockPath);
  return { device: String(info.dev), inode: String(info.ino) };
}

function ownerEvidencePath(canonicalPath: string): string { return `${canonicalPath}.owner.json`; }

function decodeOwnership(raw: unknown): Ownership {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw inUse("repository lease");
  const value = raw as Record<string, unknown>;
  const processValue = value.process;
  if (typeof processValue !== "object" || processValue === null || Array.isArray(processValue)) throw inUse("repository lease");
  const processRecord = processValue as Record<string, unknown>;
  if (value.version !== 1 || typeof value.device !== "string" || !/^\d+$/.test(value.device) ||
    typeof value.inode !== "string" || !/^\d+$/.test(value.inode) ||
    typeof processRecord.pid !== "number" || !Number.isSafeInteger(processRecord.pid) || processRecord.pid < 1 ||
    typeof processRecord.boot_id !== "string" || !/^[0-9a-f-]{36}$/.test(processRecord.boot_id) ||
    typeof processRecord.started !== "string" || !/^\d+$/.test(processRecord.started)) throw inUse("repository lease");
  return { version: 1, device: value.device, inode: value.inode,
    process: { pid: processRecord.pid, boot_id: processRecord.boot_id, started: processRecord.started } };
}

async function reclaimDeadOwner(lockPath: string, ownerPath: string): Promise<boolean> {
  let instance: Awaited<ReturnType<typeof lockInstance>>;
  let names: string[];
  try { instance = await lockInstance(lockPath); names = await readdir(lockPath); }
  catch (error) { if (nativeCode(error) === "ENOENT") return false; throw error; }
  if (names.length !== 0) throw inUse(lockPath);
  let record: Ownership;
  try {
    const info = await lstat(ownerPath);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 1024) {
      throw inUse(lockPath);
    }
    record = decodeOwnership(JSON.parse(await readFile(ownerPath, "utf8")));
  } catch (error) { if (nativeCode(error) === "ENOENT" || error instanceof SyntaxError) throw inUse(lockPath, error); throw error; }
  if (record.device !== instance.device || record.inode !== instance.inode) throw inUse(lockPath);
  if (await sameProcess(record.process)) throw inUse(lockPath);
  // Only one contender can remove this generation's unique record. A loser must
  // never rmdir a replacement directory, even if it appears at the same path.
  let current: Awaited<ReturnType<typeof lockInstance>>;
  try { current = await lockInstance(lockPath); }
  catch (error) { if (nativeCode(error) === "ENOENT") return false; throw error; }
  if (current.device !== instance.device || current.inode !== instance.inode) throw inUse(lockPath);
  try { await unlink(ownerPath); }
  catch (error) { if (nativeCode(error) === "ENOENT") throw inUse(lockPath, error); throw error; }
  try { await rmdir(lockPath); }
  catch (error) { if (nativeCode(error) === "ENOTEMPTY" || nativeCode(error) === "EEXIST") throw inUse(lockPath, error); if (nativeCode(error) !== "ENOENT") throw error; }
  return true;
}

export interface RepositoryLease {
  readonly state: "held" | "lost" | "released";
  assertOwned(): void;
  release(): Promise<void>;
}

type LockOptions = {
  realpath: true; stale: number; update: number; retries: 0;
  onCompromised: (error: Error) => void;
};
export type LockOperation = (path: string, options: LockOptions) => Promise<() => Promise<void>>;

export async function acquireRepositoryLease(path: string, options: {
  signal?: AbortSignal;
  onCompromised: (error: BridgeError) => void;
  /** Internal test seam; production always delegates locking to proper-lockfile. */
  lock?: LockOperation;
}): Promise<RepositoryLease> {
  options.signal?.throwIfAborted();
  try { await mkdir(path, { recursive: true, mode: 0o700 }); }
  catch (error) { throw filesystemFailure(error, "lease.directory", path); }
  options.signal?.throwIfAborted();
  let state: RepositoryLease["state"] = "held";
  let lost: BridgeError | undefined;
  const compromised = (cause: Error) => {
    if (state !== "held") return;
    state = "lost";
    lost = new BridgeError("LEASE_COMPROMISED", "Repository coordination authority was lost", {
      cause, stage: "lease.heartbeat", path, native_code: nativeCode(cause) ?? "ECOMPROMISED",
      next_action: "Stop new work and reconcile retained execution evidence before another coordinator starts.",
    });
    options.onCompromised(lost);
  };
  let releaseLock: (() => Promise<void>) | undefined;
  let ownerPath: string | undefined;
  try {
    const lock = options.lock ?? (await import("proper-lockfile")).default.lock;
    const lockOptions = { realpath: true as const, stale: options.lock ? STALE_MS : Infinity, update: UPDATE_MS, retries: 0 as const, onCompromised: compromised };
    let canonicalPath: string;
    try { canonicalPath = await realpath(path); }
    catch (error) { throw filesystemFailure(error, "lease.path", path); }
    const ownerPathForBinding = ownerEvidencePath(canonicalPath);
    try { releaseLock = await lock(path, lockOptions); }
    catch (error) {
      if (options.lock || nativeCode(error) !== "ELOCKED") throw error;
      const lockPath = `${await realpath(path)}.lock`;
      if (!await reclaimDeadOwner(lockPath, ownerPathForBinding)) throw inUse(path, error);
      releaseLock = await lock(path, lockOptions);
    }
    if (!options.lock) {
      const lockPath = `${await realpath(path)}.lock`;
      const instance = await lockInstance(lockPath);
      ownerPath = ownerPathForBinding;
      await unlink(ownerPath).catch(error => { if (nativeCode(error) !== "ENOENT") throw error; });
      const handle = await open(ownerPath, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ version: 1, process: await processIdentity(), ...instance } satisfies Ownership));
        await handle.sync();
      } finally { await handle.close(); }
    }
  } catch (error) {
    if (typeof releaseLock !== "undefined") {
      try {
        if (ownerPath) await unlink(ownerPath).catch(cleanup => { if (nativeCode(cleanup) !== "ENOENT") throw cleanup; });
        await releaseLock();
      } catch (cleanup) {
        compromised(new Error("Lease ownership publication cleanup failed", { cause: cleanup }));
        throw filesystemFailure(cleanup, "lease.publication_cleanup", path);
      }
    }
    if (nativeCode(error) === "ELOCKED") throw inUse(path, error);
    if (nativeCode(error) === "ERR_MODULE_NOT_FOUND" || nativeCode(error) === "MODULE_NOT_FOUND") {
      throw new BridgeError("LEASE_DEPENDENCY_UNAVAILABLE", "The installed locking dependency could not be loaded", { cause: error, stage: "lease.load" });
    }
    throw filesystemFailure(error, "lease.acquire", path);
  }
  let releasing: Promise<void> | undefined;
  const lease: RepositoryLease = {
    get state() { return state; },
    assertOwned() {
      if (state !== "held" || releasing) throw lost ?? new BridgeError("LEASE_NOT_HELD", "Repository coordination authority is not held", { stage: "lease.authority", path });
    },
    release() {
      if (releasing) return releasing;
      if (state === "released") return Promise.resolve();
      // A compromised path may now belong to somebody else. Never unlink it.
      if (state === "lost") return Promise.resolve();
      releasing = (async () => {
        try {
          if (ownerPath) await unlink(ownerPath);
          await releaseLock!();
          if (state === "held") state = "released";
        }
        catch (error) {
          // proper-lockfile stops heartbeats before unlinking. A failed release no longer proves ownership.
          state = "lost";
          lost = filesystemFailure(error, "lease.release", path);
          options.onCompromised(lost);
          throw lost;
        }
      })();
      return releasing;
    },
  };
  if (options.signal?.aborted) {
    await lease.release();
    options.signal.throwIfAborted();
  }
  lease.assertOwned();
  return lease;
}
