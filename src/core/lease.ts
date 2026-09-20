import { mkdir } from "node:fs/promises";
import { BridgeError, filesystemFailure, nativeCode } from "./errors.js";

// All cooperating processes must use this policy and the same canonical state namespace.
const STALE_MS = 30_000;
const UPDATE_MS = 10_000;

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
  let releaseLock: () => Promise<void>;
  try {
    const lock = options.lock ?? (await import("proper-lockfile")).default.lock;
    releaseLock = await lock(path, { realpath: true, stale: STALE_MS, update: UPDATE_MS, retries: 0, onCompromised: compromised });
  } catch (error) {
    if (nativeCode(error) === "ELOCKED") throw new BridgeError("PROJECT_IN_USE", "Repository coordination authority is held by another operation", {
      cause: error, stage: "lease.acquire", path, native_code: "ELOCKED",
      next_action: "Use the existing coordinator or close it safely before preparing this connection.",
    });
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
        try { await releaseLock(); if (state === "held") state = "released"; }
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
