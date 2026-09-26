import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { open, statfs } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DescriptorSchema, type ServiceDescriptor } from "../contracts/service.js";
import type { ResolvedBinding } from "../core/repository-runtime.js";
import { BridgeError, nativeCode } from "../core/errors.js";
import { privateDirectory, privateFile, sameProcess } from "./process.js";

export type ServicePaths = { directory: string; descriptor: string; endpoint: string; guard: string };
export function servicePaths(binding: ResolvedBinding): ServicePaths {
  const directory = join("/tmp", `passeur-${process.getuid?.() ?? "unsupported"}`);
  const digest = createHash("sha256").update(binding.storeRoot).digest("hex").slice(0, 40);
  return { directory, descriptor: join(binding.storeRoot, "service.json"), endpoint: join(directory, `${digest}.sock`), guard: join(binding.storeRoot, "service-election.lock") };
}
export async function preparePaths(binding: ResolvedBinding): Promise<ServicePaths> {
  if (process.platform !== "linux") throw new BridgeError("SERVICE_PLATFORM_UNSUPPORTED", "Shared service support is qualified for Linux local filesystems only");
  const paths = servicePaths(binding);
  await privateDirectory(binding.storeRoot, true); await privateDirectory(paths.directory, true);
  const filesystem = await statfs(binding.storeRoot);
  const local = new Set([0xef53, 0x01021994, 0x794c7630, 0x58465342, 0x9123683e]);
  if (!local.has(Number(filesystem.type) >>> 0)) throw new BridgeError("SERVICE_FILESYSTEM_UNSUPPORTED", "The service requires a qualified local ext, tmpfs, overlay, XFS or Btrfs state filesystem");
  try {
    const handle = await open(paths.guard, "wx", 0o600); await handle.close();
  } catch (error) { if (nativeCode(error) !== "EEXIST") throw error; }
  await privateFile(paths.guard);
  return paths;
}
export async function readDescriptor(binding: ResolvedBinding): Promise<ServiceDescriptor | undefined> {
  const paths = servicePaths(binding);
  try {
    await privateDirectory(binding.storeRoot); await privateDirectory(paths.directory);
    await privateFile(paths.descriptor);
    const handle = await open(paths.descriptor, "r");
    let bytes: Buffer;
    try {
      const info = await handle.stat();
      if (info.size > 16_384) throw new BridgeError("SERVICE_DESCRIPTOR_INVALID", "Descriptor exceeds its bound");
      bytes = Buffer.alloc(info.size + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== info.size) throw new BridgeError("SERVICE_DESCRIPTOR_CHANGED", "Descriptor changed during observation");
      bytes = bytes.subarray(0, bytesRead);
    } finally { await handle.close(); }
    let raw: unknown;
    try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new BridgeError("SERVICE_DESCRIPTOR_INVALID", "Descriptor is not valid JSON"); }
    const parsed = DescriptorSchema.safeParse(raw);
    if (!parsed.success) throw new BridgeError("SERVICE_DESCRIPTOR_UNSUPPORTED", "Service descriptor version or representation is unsupported");
    const value = parsed.data;
    if (value.repository_id !== binding.repositoryId || value.state_root !== binding.stateRoot || value.endpoint !== paths.endpoint) throw new BridgeError("SERVICE_BINDING_CONFLICT", "Descriptor identifies another binding; no replacement is authorized");
    return value;
  } catch (error) { if (nativeCode(error) === "ENOENT") return undefined; throw error; }
}
export type LaunchReservation = { child: ChildProcess; released: () => void; failure: Promise<never> };
/** Launch arguments contain bindings only. Control credentials never enter process arguments or environment. */
export async function launchService(binding: ResolvedBinding, exactCli: string): Promise<LaunchReservation> {
  const paths = await preparePaths(binding);
  let reject!: (error: unknown) => void;
  const failure = new Promise<never>((_yes, no) => { reject = no; }); failure.catch(() => undefined);
  // Reserve 75 for flock contention so an elected service exiting with code 1
  // remains distinguishable from a loser.
  const args = ["--nonblock", "--no-fork", "--conflict-exit-code", "75", paths.guard, process.execPath, resolve(exactCli), "service-run", "--project", binding.project,
    "--state-root", binding.stateRoot, "--expected-repository-id", binding.repositoryId,
    ...(binding.profilePath ? ["--profile", binding.profilePath] : [])];
  const child = spawn("flock", args, { stdio: ["pipe", "ignore", "ignore"], detached: true, shell: false,
    env: Object.fromEntries(["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "TMPDIR", "PASSEUR_OBSERVATION_MONITOR"].flatMap((k) => process.env[k] === undefined ? [] : [[k, process.env[k]]])) });
  child.on("error", (error) => {
    const code = nativeCode(error);
    reject(new BridgeError(code === "ENOENT" ? "SERVICE_PLATFORM_UNSUPPORTED" : "SERVICE_START_FAILED",
      "The qualified flock launcher could not be started", { cause: error, ...(code ? { native_code: code } : {}) }));
  });
  child.on("exit", (code, signal) => {
    if (code !== 75) reject(new BridgeError("SERVICE_START_FAILED", signal
      ? `Guarded service startup ended by signal ${signal}`
      : `Guarded service startup exited with code ${code}; inspect the exact installed runtime and dependencies`));
  });
  child.stdin!.on("error", () => undefined);
  child.unref();
  return { child, failure, released: () => { child.stdin?.end(); } };
}
export async function existingOwner(descriptor: ServiceDescriptor): Promise<boolean> { return sameProcess(descriptor.process); }

// Keep the existing CLI import path while sharing the actual credential owner.
export { operatorToken } from "./operator-token.js";
