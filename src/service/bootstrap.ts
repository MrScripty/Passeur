import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstat, open, readFile, statfs } from "node:fs/promises";
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
  const args = ["--nonblock", "--no-fork", paths.guard, process.execPath, resolve(exactCli), "service-run", "--project", binding.project,
    "--state-root", binding.stateRoot, "--expected-repository-id", binding.repositoryId,
    ...(binding.profilePath ? ["--profile", binding.profilePath] : [])];
  const child = spawn("flock", args, { stdio: ["pipe", "ignore", "ignore"], detached: true, shell: false,
    env: Object.fromEntries(["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "TMPDIR"].flatMap((k) => process.env[k] === undefined ? [] : [[k, process.env[k]]])) });
  child.on("error", () => reject(new BridgeError("SERVICE_START_FAILED", "The guarded service executable could not be launched")));
  child.on("exit", (code) => { if (code !== 0 && code !== 1) reject(new BridgeError("SERVICE_START_FAILED", "Guarded service startup exited; inspect the exact installed runtime and dependencies")); });
  child.stdin!.on("error", () => undefined);
  child.unref();
  return { child, failure, released: () => { child.stdin?.end(); } };
}
export async function existingOwner(descriptor: ServiceDescriptor): Promise<boolean> { return sameProcess(descriptor.process); }

/** Explicit operator CLI invocations share a private reconnect identity; MCP front ends do not use this file. */
export async function operatorToken(binding: ResolvedBinding, create = false): Promise<string | undefined> {
  try { await privateDirectory(binding.storeRoot, create); }
  catch (error) { if (!create && nativeCode(error) === "ENOENT") return undefined; throw error; }
  const path = join(binding.storeRoot, "operator-control.token");
  if (create) try {
    const handle = await open(path, "wx", 0o600);
    try { await handle.writeFile(randomBytes(32).toString("hex")); await handle.sync(); } finally { await handle.close(); }
  } catch (error) { if (nativeCode(error) !== "EEXIST") throw error; }
  try { await privateFile(path); }
  catch (error) { if (!create && nativeCode(error) === "ENOENT") return undefined; throw error; }
  const info = await lstat(path);
  if (info.size !== 64) throw new BridgeError("CONTROL_CREDENTIAL_INVALID", "Private operator credential has an invalid size");
  const token = await readFile(path, "utf8");
  if (!/^[a-f0-9]{64}$/.test(token)) throw new BridgeError("CONTROL_CREDENTIAL_INVALID", "Private operator credential is invalid");
  return token;
}
