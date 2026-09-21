import { readFile, stat, lstat, realpath, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { BridgeError, nativeCode } from "../core/errors.js";

export type ProcessIdentity = { pid: number; boot_id: string; started: string };
/** Linux process birth identity is evidence, not permission to signal an arbitrary PID. */
export async function processIdentity(pid = process.pid): Promise<ProcessIdentity> {
  if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid < 1) throw new BridgeError("SERVICE_PLATFORM_UNSUPPORTED", "Linux process identity is required");
  const [boot, value] = await Promise.all([readFile("/proc/sys/kernel/random/boot_id", "utf8"), readFile(`/proc/${pid}/stat`, "utf8")]);
  const fields = value.slice(value.lastIndexOf(")") + 2).trim().split(/\s+/);
  const started = fields[19];
  if (!started || !/^\d+$/.test(started) || !/^[a-f0-9-]{36}$/.test(boot.trim())) throw new BridgeError("PROCESS_IDENTITY_UNAVAILABLE", "The process birth identity could not be decoded");
  return { pid, boot_id: boot.trim(), started };
}
export async function sameProcess(expected: ProcessIdentity): Promise<boolean> {
  try {
    const actual = await processIdentity(expected.pid);
    if (actual.boot_id !== expected.boot_id || actual.started !== expected.started) return false;
    const value = await readFile(`/proc/${expected.pid}/stat`, "utf8");
    const state = value.slice(value.lastIndexOf(")") + 2).split(/\s+/)[0];
    // A zombie has exited and released descriptors; its unreaped PID is not a live service.
    return state !== "Z" && state !== "X";
  } catch (error) { if (nativeCode(error) === "ENOENT") return false; throw error; }
}
/** Reject symlinked, foreign-owned or accessible-to-others control directories. */
export async function privateDirectory(path: string, create = false): Promise<string> {
  if (process.getuid === undefined) throw new BridgeError("SERVICE_PLATFORM_UNSUPPORTED", "Unix ownership is required");
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) throw new BridgeError("SERVICE_PATH_UNSAFE", "The service directory must be a private, user-owned, nonsymlink directory");
  const actual = await realpath(path);
  if (actual !== resolve(path)) throw new BridgeError("SERVICE_PATH_UNSAFE", "Select a canonical service path without symlink components");
  return actual;
}
export async function privateFile(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new BridgeError("SERVICE_PATH_UNSAFE", "The control file is not a private regular file owned by this user");
}
/** Called only by service-run. A boolean flag or descriptor file is not lock authority. */
export async function assertElectionGuard(path: string): Promise<void> {
  if (process.platform !== "linux") throw new BridgeError("SERVICE_PLATFORM_UNSUPPORTED", "The service requires the qualified Linux flock mechanism");
  await privateFile(path);
  const info = await stat(path, { bigint: true });
  const locks = (await readFile("/proc/locks", "utf8")).split("\n");
  // Match the actual device and inode; another lock held by this process proves nothing about this file.
  const major = (info.dev >> 8n & 0xfffn) | (info.dev >> 32n & 0xfffff000n);
  const minor = (info.dev & 0xffn) | (info.dev >> 12n & 0xffffff00n);
  const owned = locks.some((line) => {
    const fields = line.trim().split(/\s+/);
    if (fields[1] !== "FLOCK" || fields[3] !== "WRITE" || fields[4] !== String(process.pid)) return false;
    const device = fields[5]?.split(":");
    return device?.length === 3 && BigInt(`0x${device[0]}`) === major && BigInt(`0x${device[1]}`) === minor && BigInt(device[2]!) === info.ino;
  });
  if (!owned) throw new BridgeError("SERVICE_ELECTION_REQUIRED", "Start the service through the guarded launcher; no owned election lock was observed");
}
