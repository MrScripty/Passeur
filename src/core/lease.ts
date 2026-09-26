import { mkdir, lstat, link, open, readFile, readdir, realpath, rename, unlink, utimes } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { BridgeError, filesystemFailure, nativeCode } from "./errors.js";
import { processIdentity, sameProcess, type ProcessIdentity } from "./process-identity.js";

// All cooperating processes must use this policy and the same canonical state namespace.
const UPDATE_MS = 10_000;
type Ownership = { version: 1; process: ProcessIdentity; device: string; inode: string };
type AtomicOwnership = { version: 1; process: ProcessIdentity };
type LockInstance = { kind: "file" | "directory"; device: string; inode: string };

function inUse(path: string, cause?: unknown): BridgeError {
  return new BridgeError("PROJECT_IN_USE", "Repository coordination authority is held or needs explicit reconciliation", {
    cause, stage: "lease.acquire", path, native_code: "ELOCKED",
    next_action: "Use the existing coordinator or reconcile the exact lease owner before preparing this connection.",
  });
}

async function lockInstance(lockPath: string): Promise<LockInstance> {
  const info = await lstat(lockPath, { bigint: true });
  if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw inUse(lockPath);
  return { kind: info.isFile() ? "file" : "directory", device: String(info.dev), inode: String(info.ino) };
}

function sameLock(left: LockInstance, right: LockInstance): boolean {
  return left.kind === right.kind && left.device === right.device && left.inode === right.inode;
}

function ownerEvidencePath(canonicalPath: string): string { return `${canonicalPath}.owner.json`; }

function decodeProcess(raw: unknown): ProcessIdentity {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw inUse("repository lease");
  const value = raw as Record<string, unknown>;
  if (typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid < 1 ||
    typeof value.boot_id !== "string" || !/^[0-9a-f-]{36}$/.test(value.boot_id) ||
    typeof value.started !== "string" || !/^\d+$/.test(value.started)) throw inUse("repository lease");
  return { pid: value.pid, boot_id: value.boot_id, started: value.started };
}

function decodeOwnership(raw: unknown): Ownership {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw inUse("repository lease");
  const value = raw as Record<string, unknown>;
  if (value.version !== 1 || typeof value.device !== "string" || !/^\d+$/.test(value.device) ||
    typeof value.inode !== "string" || !/^\d+$/.test(value.inode) ||
    typeof value.process !== "object" || value.process === null || Array.isArray(value.process)) throw inUse("repository lease");
  return { version: 1, device: value.device, inode: value.inode, process: decodeProcess(value.process) };
}

function decodeAtomicOwnership(raw: unknown): AtomicOwnership {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw inUse("repository lease");
  const value = raw as Record<string, unknown>;
  if (value.version !== 1 || typeof value.process !== "object" || value.process === null || Array.isArray(value.process)) {
    throw inUse("repository lease");
  }
  return { version: 1, process: decodeProcess(value.process) };
}

function asError(value: unknown): Error { return value instanceof Error ? value : new Error(String(value)); }

/**
 * New leases use an atomic regular-file lock. The owner record is complete
 * before a hard link exposes `.lock`, so a process crash cannot leave an
 * ownerless new-generation lock. Legacy proper-lockfile directory locks are
 * handled by reclaimDeadOwner below.
 */
async function acquireAtomicLock(lockPath: string, owner: ProcessIdentity, onCompromised: (error: Error) => void,
  afterLink?: () => void | Promise<void>): Promise<{
  instance: LockInstance; release: () => Promise<void>;
}> {
  const temporary = `${lockPath}.candidate-${randomUUID()}`;
  let candidate: LockInstance | undefined;
  let linked = false;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify({ version: 1, process: owner } satisfies AtomicOwnership));
      await handle.sync();
    } finally { await handle.close(); }
    candidate = await lockInstance(temporary);
    try { await link(temporary, lockPath); }
    catch (error) {
      if (nativeCode(error) === "EEXIST") throw Object.assign(new Error("Repository lease is held"), { code: "ELOCKED" });
      throw error;
    }
    linked = true;
    await afterLink?.();
    const instance = await lockInstance(lockPath);
    if (!sameLock(instance, candidate)) throw inUse(lockPath);
    let closed = false;
    let compromised = false;
    let refreshing = false;
    const fail = (error: Error) => {
      if (closed || compromised) return;
      compromised = true;
      onCompromised(error);
    };
    const refresh = async () => {
      if (closed || compromised || refreshing) return;
      refreshing = true;
      try {
        const current = await lockInstance(lockPath);
        if (!sameLock(current, instance)) throw Object.assign(new Error("Repository lease generation changed"), { code: "ECOMPROMISED" });
        await utimes(lockPath, new Date(), new Date());
      } catch (error) { fail(asError(error)); }
      finally { refreshing = false; }
    };
    const heartbeat = setInterval(() => { void refresh(); }, UPDATE_MS);
    heartbeat.unref?.();
    return {
      instance,
      async release() {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        if (compromised) return;
        try {
          const current = await lockInstance(lockPath);
          if (!sameLock(current, instance)) throw Object.assign(new Error("Repository lease generation changed"), { code: "ECOMPROMISED" });
          await unlink(lockPath);
        } catch (error) {
          const failure = asError(error);
          compromised = true;
          onCompromised(failure);
          throw failure;
        }
      },
    };
  } catch (error) {
    if (linked && candidate) {
      // Keep the candidate link until this comparison: it pins the exact inode
      // created by this attempt, even if another generation now owns .lock.
      try {
        const current = await lockInstance(lockPath);
        if (sameLock(current, candidate)) await unlink(lockPath);
      } catch (cleanup) {
        if (nativeCode(cleanup) !== "ENOENT") throw cleanup;
      }
    }
    throw error;
  } finally { await unlink(temporary).catch(() => undefined); }
}

async function publishOwner(path: string, ownership: Ownership): Promise<void> {
  const temporary = `${path}.candidate-${randomUUID()}`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(ownership));
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => undefined); }
}

// This program runs under flock --no-fork. It has no project imports, so it
// works when the parent was loaded from TypeScript source by Vitest as well as
// from compiled JavaScript. Only this flock-holding process removes a lock.
const RECLAIM_WORKER = `
const fs = require('node:fs/promises');
const readline = require('node:readline');
const lockPath = process.argv[1];
process.stdout.write('ready\\n');
const lines = readline.createInterface({ input: process.stdin });
(async () => {
  for await (const line of lines) {
    let command;
    try { command = JSON.parse(line); } catch { process.stdout.write('held\\n'); return; }
    if (command === 'abort') { process.stdout.write('missing\\n'); return; }
    if (!command || !['file', 'directory'].includes(command.kind) ||
        typeof command.device !== 'string' || !/^\\d+$/.test(command.device) ||
        typeof command.inode !== 'string' || !/^\\d+$/.test(command.inode)) {
      process.stdout.write('held\\n'); return;
    }
    try {
      const info = await fs.lstat(lockPath, { bigint: true });
      const kind = info.isFile() ? 'file' : info.isDirectory() ? 'directory' : null;
      if (kind !== command.kind || String(info.dev) !== command.device || String(info.ino) !== command.inode) {
        process.stdout.write('held\\n'); return;
      }
      if (kind === 'file') await fs.unlink(lockPath);
      else await fs.rmdir(lockPath);
      process.stdout.write('reclaimed\\n');
    } catch { process.stdout.write('held\\n'); }
    return;
  }
  // EOF without a validated command cannot mutate the lock.
  process.exitCode = 72;
})().catch(() => { process.exitCode = 72; });
`;

async function reclaimDeadOwner(lockPath: string, ownerPath: string, exitBeforeMutation = false): Promise<boolean> {
  // Keep the guard inode permanently: unlinking it would let waiters lock an
  // old inode while a later reclaimer locks a new one at the same pathname.
  const guard = `${lockPath}.reclaim.guard`;
  try { const handle = await open(guard, "wx", 0o600); await handle.close(); }
  catch (error) { if (nativeCode(error) !== "EEXIST") throw error; }
  const info = await lstat(guard);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw inUse(lockPath);

  const child = spawn("flock", ["--exclusive", "--no-fork", guard, process.execPath, "-e", RECLAIM_WORKER, lockPath],
    { stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.on("error", () => undefined); // A dead helper must fail closed.
  let output = "";
  let stderr = "";
  let spawnError: Error | undefined;
  let ready = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const prepared = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(0, 1024); });
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
    if (output.length > 1024) { child.kill(); return; }
    if (!ready && output.startsWith("ready\n")) { ready = true; resolveReady(); }
  });
  child.once("error", error => { spawnError = error; if (!ready) rejectReady(error); });
  const finished = new Promise<number | null>(resolve => child.once("close", (code, signal) => {
    if (!ready) rejectReady(new Error(`Repository reclaim helper exited before acquiring the guard: ${JSON.stringify({ code, signal, output, stderr })}`));
    resolve(code);
  }));
  try {
    await prepared;
    const instance = await validateDeadOwner(lockPath, ownerPath);
    if (exitBeforeMutation) child.stdin.end();
    else child.stdin.end(JSON.stringify(instance ?? "abort") + "\n");
    const code = await finished;
    if (spawnError || code !== 0) throw inUse(lockPath, spawnError ?? new Error(stderr || `Helper exited ${code}`));
    if (output === "ready\nreclaimed\n" && instance) return true;
    if (output === "ready\nmissing\n" && !instance) return false;
    throw inUse(lockPath, new Error(`Repository reclaim helper returned an invalid result: ${JSON.stringify(output)}`));
  } catch (error) {
    child.stdin.end();
    await finished;
    throw inUse(lockPath, stderr ? new Error(stderr, { cause: error }) : error);
  }
}

async function validateDeadOwner(lockPath: string, ownerPath: string): Promise<LockInstance | undefined> {
  let instance: LockInstance;
  try { instance = await lockInstance(lockPath); }
  catch (error) { if (nativeCode(error) === "ENOENT") return undefined; throw error; }

  if (instance.kind === "file") {
    const info = await lstat(lockPath);
    if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 1024) throw inUse(lockPath);
    let record: AtomicOwnership;
    try { record = decodeAtomicOwnership(JSON.parse(await readFile(lockPath, "utf8"))); }
    catch (error) { if (error instanceof SyntaxError) throw inUse(lockPath, error); throw error; }
    if (await sameProcess(record.process)) throw inUse(lockPath);
    let current: LockInstance;
    try { current = await lockInstance(lockPath); }
    catch (error) { if (nativeCode(error) === "ENOENT") return undefined; throw error; }
    if (!sameLock(current, instance)) throw inUse(lockPath);
    return instance;
  }

  const names = await readdir(lockPath);
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
  let current: LockInstance;
  try { current = await lockInstance(lockPath); }
  catch (error) { if (nativeCode(error) === "ENOENT") return undefined; throw error; }
  if (!sameLock(current, instance)) throw inUse(lockPath);
  // The sidecar may be stale after a legacy owner dies. It is deliberately
  // retained until a new owner atomically replaces it after acquiring a lock.
  return instance;
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
  /** Internal test seam; production uses the atomic compatibility lease. */
  lock?: LockOperation;
  /** Internal fault injection for crash-window regression tests. */
  faults?: { afterAtomicLink?: () => void | Promise<void>; reclaimExitBeforeMutation?: boolean };
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
  try {
    const lockOptions = { realpath: true as const, stale: options.lock ? 30_000 : Infinity, update: UPDATE_MS, retries: 0 as const, onCompromised: compromised };
    let canonicalPath: string;
    try { canonicalPath = await realpath(path); }
    catch (error) { throw filesystemFailure(error, "lease.path", path); }
    const ownerPath = ownerEvidencePath(canonicalPath);
    const lockPath = `${canonicalPath}.lock`;
    const ownerProcess = options.lock ? undefined : await processIdentity();
    const acquireProduction = async () => {
      const held = await acquireAtomicLock(lockPath, ownerProcess!, compromised, options.faults?.afterAtomicLink);
      releaseLock = held.release;
      await publishOwner(ownerPath, { version: 1, process: ownerProcess!, device: held.instance.device, inode: held.instance.inode });
    };
    if (options.lock) releaseLock = await options.lock(path, lockOptions);
    else {
      try { await acquireProduction(); }
      catch (error) {
        if (nativeCode(error) !== "ELOCKED") throw error;
        if (!await reclaimDeadOwner(lockPath, ownerPath, options.faults?.reclaimExitBeforeMutation)) throw inUse(path, error);
        await acquireProduction();
      }
    }
  } catch (error) {
    if (typeof releaseLock !== "undefined") {
      try { await releaseLock(); }
      catch (cleanup) {
        compromised(asError(cleanup));
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
      if (state === "lost") return Promise.resolve();
      releasing = (async () => {
        try {
          await releaseLock!();
          if (state === "held") state = "released";
        }
        catch (error) {
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
