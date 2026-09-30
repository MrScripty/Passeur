import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { open, statfs } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DescriptorSchema, FailureSchema, type ServiceDescriptor } from "../contracts/service.js";
import type { ResolvedBinding } from "../core/repository-runtime.js";
import { BridgeError, nativeCode, diagnosticInfo, type ErrorInfo } from "../core/errors.js";
import { privateDirectory, privateFile, sameProcess } from "./process.js";

export type ServicePaths = { directory: string; descriptor: string; endpoint: string; guard: string };
const serviceEnvironmentKeys = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "XDG_CONFIG_HOME", "XDG_STATE_HOME",
  "XDG_DATA_HOME", "XDG_CACHE_HOME", "TMPDIR", "PASSEUR_OBSERVATION_MONITOR"] as const;
export function serviceLaunchEnvironment(environment: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
  return Object.fromEntries(serviceEnvironmentKeys.flatMap((key) => environment[key] === undefined ? [] : [[key, environment[key]!]]));
}
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
export async function launchService(binding: ResolvedBinding, exactCli: string,
  environment: Readonly<Record<string, string | undefined>> = process.env): Promise<LaunchReservation> {
  const paths = await preparePaths(binding);
  let reject!: (error: unknown) => void;
  const failure = new Promise<never>((_yes, no) => { reject = no; }); failure.catch(() => undefined);
  // Reserve 75 for flock contention so an elected service exiting with code 1
  // remains distinguishable from a loser.
  const args = ["--nonblock", "--no-fork", "--conflict-exit-code", "75", paths.guard, process.execPath, resolve(exactCli), "service-run", "--project", binding.project,
    "--state-root", binding.stateRoot, "--expected-repository-id", binding.repositoryId,
    ...(binding.profilePath ? ["--profile", binding.profilePath] : [])];
  const child = spawn("flock", args, { stdio: ["pipe", "ignore", "pipe"], detached: true, shell: false,
    env: serviceLaunchEnvironment(environment) });
  const fallbackContext = { stage: "service.launch", path: resolve(exactCli),
    next_action: "Inspect the exact installed runtime and dependencies; preserve the repository state namespace." };
  // Drain stderr without retaining arbitrary output. Only complete, strict,
  // bounded CLI diagnostic lines can become a public startup failure.
  // The full UTF-8 FailureSchema maximum fits within this bound, including both
  // profile paths. The same aggregate cap still limits all retained stderr.
  const lineLimit = 65_536, captureLimit = 65_536;
  let line = Buffer.alloc(0), discardedLine = false, captured = 0;
  let diagnostic: ErrorInfo | undefined;
  const decodeLine = () => {
    if (!discardedLine && line.length) {
      try {
        const parsed = FailureSchema.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)));
        if (parsed.success) diagnostic = diagnosticInfo(new BridgeError(parsed.data.code, parsed.data.message, parsed.data));
      } catch { /* Arbitrary stderr is never projected. */ }
    }
    line = Buffer.alloc(0); discardedLine = false;
  };
  child.stderr!.on("data", (chunk: Buffer) => {
    const bytes = chunk.subarray(0, Math.max(0, captureLimit - captured)); captured += bytes.length;
    let start = 0;
    while (start < bytes.length) {
      const end = bytes.indexOf(10, start), stop = end === -1 ? bytes.length : end;
      if (!discardedLine) {
        if (line.length + stop - start > lineLimit) { discardedLine = true; line = Buffer.alloc(0); }
        else line = Buffer.concat([line, bytes.subarray(start, stop)]);
      }
      if (end === -1) break;
      decodeLine(); start = end + 1;
    }
    if (captured === captureLimit) { line = Buffer.alloc(0); discardedLine = true; }
  });
  child.on("error", (error) => {
    const code = nativeCode(error);
    reject(new BridgeError(code === "ENOENT" ? "SERVICE_PLATFORM_UNSUPPORTED" : "SERVICE_START_FAILED",
      "The qualified flock launcher could not be started", { ...fallbackContext, cause: error, ...(code ? { native_code: code } : {}) }));
  });
  // close follows exit and stderr EOF, so a final emitted diagnostic is not lost.
  child.on("close", (code, signal) => {
    decodeLine();
    if (code !== 75) reject(diagnostic ? new BridgeError(diagnostic.code, diagnostic.message, diagnostic)
      : new BridgeError("SERVICE_START_FAILED", signal
        ? `Guarded service startup ended by signal ${signal}`
        : `Guarded service startup exited with code ${code}; inspect the exact installed runtime and dependencies`, fallbackContext));
  });
  // Observing service stderr must not keep a detached frontend alive while
  // accepted work remains owned by the service after release.
  (child.stderr as import("node:net").Socket).unref();
  child.stdin!.on("error", () => undefined);
  child.unref();
  return { child, failure, released: () => { child.stdin?.end(); } };
}
export async function existingOwner(descriptor: ServiceDescriptor): Promise<boolean> { return sameProcess(descriptor.process); }

// Keep the existing CLI import path while sharing the actual credential owner.
export { operatorToken } from "./operator-token.js";
