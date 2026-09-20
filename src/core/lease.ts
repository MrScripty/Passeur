import lockfile from "proper-lockfile";
import { mkdir } from "node:fs/promises";
import { BridgeError } from "./errors.js";
export async function acquireRepositoryLease(path: string): Promise<() => Promise<void>> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  try {
    const release = await lockfile.lock(path, { realpath: true, stale: 30_000, update: 10_000, retries: 0 });
    let released = false;
    return async () => { if (!released) { released = true; await release(); } };
  } catch { throw new BridgeError("PROJECT_IN_USE", "Another coordinator or offline mutation owns this repository"); }
}
