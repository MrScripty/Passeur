import { readFile } from "node:fs/promises";
import { BridgeError, nativeCode } from "./errors.js";

export type ProcessIdentity = { pid: number; boot_id: string; started: string };

async function processObservation(pid: number): Promise<{ identity: ProcessIdentity; state: string }> {
  if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid < 1) {
    throw new BridgeError("SERVICE_PLATFORM_UNSUPPORTED", "Linux process identity is required");
  }
  const [boot, value] = await Promise.all([
    readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    readFile(`/proc/${pid}/stat`, "utf8"),
  ]);
  const fields = value.slice(value.lastIndexOf(")") + 2).trim().split(/\s+/);
  const state = fields[0], started = fields[19];
  if (!state || !started || !/^\d+$/.test(started) || !/^[a-f0-9-]{36}$/.test(boot.trim())) {
    throw new BridgeError("PROCESS_IDENTITY_UNAVAILABLE", "The process birth identity could not be decoded");
  }
  return { identity: { pid, boot_id: boot.trim(), started }, state };
}

/** Linux process birth evidence is not permission to signal an arbitrary PID. */
export async function processIdentity(pid = process.pid): Promise<ProcessIdentity> {
  return (await processObservation(pid)).identity;
}

export async function sameProcess(expected: ProcessIdentity): Promise<boolean> {
  try {
    const { identity: actual, state } = await processObservation(expected.pid);
    if (actual.boot_id !== expected.boot_id || actual.started !== expected.started) return false;
    // A zombie has exited and released descriptors; its unreaped PID is not a live service.
    return state !== "Z" && state !== "X";
  } catch (error) {
    if (nativeCode(error) === "ENOENT") return false;
    throw error;
  }
}
