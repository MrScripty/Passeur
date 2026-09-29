import { MuseClient, readSessionDurability, spawnMspConnection, type MuseClientSpawnOptions } from "@muse-code/sdk";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { BridgeError } from "../core/errors.js";
import type { WorkerInput } from "../agents/types.js";

export type ProtectedRuntimeConfig = Readonly<{
  /** Host paths prepared by the disposable or deployed transport owner. */
  runtimeRoot: string; home: string; relayDirectory: string;
  protectedRoots: readonly string[];
  /** Exact staged executable names; this module owns the launch arguments. */
  nodeExecutable: string; museExecutable: string; hostScript: string;
  /** Transport-owned headers for a task-scoped Unix endpoint, never provider credentials. */
  relayHeaders?: Readonly<Record<string, string>>;
  onNativeNotification?: (notification: unknown) => void;
  onCapture?: (capture: Readonly<{ boot: string; pidns: string; identities: readonly ProcessIdentity[] }>) => void;
}>;

export type { ProcessIdentity, Captured, ProtectedObserverIO } from "../core/protected-namespace.js";
import { captureProtectedNamespace, verifyProtectedNamespaceStop,
  type ProcessIdentity, type Captured, type ProtectedObserverIO } from "../core/protected-namespace.js";

function invalid(message: string): never { throw new BridgeError("MUSE_PROTECTED_LAUNCH_INVALID", message); }
function source(path: string, label: string): string {
  try {
    if (!isAbsolute(path) || path !== realpathSync(path) || !lstatSync(path).isDirectory()) invalid(`${label} is not a canonical directory`);
  } catch { invalid(`${label} is not a canonical directory`); }
  return path;
}
function overlaps(a: string, b: string): boolean { return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`); }
function encoded(value: unknown): string { return Buffer.from(JSON.stringify(value)).toString("base64url"); }

/** The caller supplies only staged paths and a host-owned socket; no provider identity or credential is assumed. */
export function protectedLaunch(input: WorkerInput, config: ProtectedRuntimeConfig, museArgs: readonly string[]):
  { hostOptions: MuseClientSpawnOptions; statusFile: string; guestMuseExecutable: string } {
  const view = input.private_git?.view;
  if (input.private_git?.schema_version !== 1 || input.private_git.mount_kind !== "canonical_common_dir" || !view) {
    invalid("private Git view is required for protected launch");
  }
  if (input.request.mode !== "implement") invalid("protected private Git launch is qualified only for implementation");
  const workspace = source(input.workspace, "workspace");
  const runtime = source(config.runtimeRoot, "runtime");
  const home = source(config.home, "home");
  const relay = source(config.relayDirectory, "relay");
  const privateDir = source(view.private_common_dir, "private Git");
  const canonical = source(view.canonical_common_dir, "canonical Git");
  const control = source(dirname(privateDir), "private control");
  const denied = config.protectedRoots.map((path, index) => source(path, `protected root ${index}`));
  if (!workspace.startsWith("/tmp/") || !canonical.startsWith("/tmp/") ||
      !home.startsWith("/tmp/") || !relay.startsWith("/tmp/") ||
      !(runtime.startsWith("/tmp/") || runtime.startsWith("/dev/shm/")) ||
      privateDir !== join(control, "private-git") || !/^worktrees\/[A-Za-z0-9._-]+$/.test(view.admin_relative) ||
      !denied.includes(control) || denied.some(path => overlaps(path, workspace) || overlaps(path, canonical)) ||
      [runtime, home, relay].some(path => denied.some(root => overlaps(path, root))) ||
      [runtime, home, relay, privateDir].some(path => overlaps(path, workspace) || overlaps(path, canonical)) ||
      [runtime, home, relay].some((path, index, paths) => paths.some((other, otherIndex) => index !== otherIndex && overlaps(path, other)))) {
    invalid("protected paths overlap or do not identify a canonical private view");
  }
  const dotGit = join(workspace, ".git");
  if (!lstatSync(dotGit).isFile() || realpathSync(dotGit) !== dotGit ||
      readFileSync(dotGit, "utf8").trim() !== `gitdir: ${canonical}/${view.admin_relative}` ||
      readFileSync(join(privateDir, view.admin_relative, "commondir"), "utf8").trim() !== "../..") {
    invalid("private worktree pointer does not match the prepared view");
  }
  for (const name of [config.nodeExecutable, config.museExecutable, config.hostScript]) {
    if (!isAbsolute(name) || !name.startsWith(`${runtime}/`) || !lstatSync(name).isFile()) invalid("staged executable is outside runtime");
  }
  if (!existsSync(join(relay, "relay.sock"))) invalid("task relay socket is unavailable");
  const guestPath = (path: string): string => `/mounts/runtime/${path.slice(runtime.length + 1)}`;
  const guestSpec = { museBin: guestPath(config.museExecutable), museArgs: [...museArgs],
    relaySocket: "/mounts/relay/relay.sock", home: "/mounts/home",
    relayHeaders: config.relayHeaders ?? {} };
  const args = ["--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-net",
    "--disable-userns", "--die-with-parent", "--new-session", "--clearenv"];
  for (const root of ["/usr", "/bin", "/lib", "/lib64"]) if (existsSync(root)) args.push("--ro-bind", root, root);
  args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/mounts");
  const parents = (path: string) => { const result: string[] = []; for (let p = dirname(path); p !== "/tmp"; p = dirname(p)) result.unshift(p); return result; };
  for (const parent of [...new Set([...parents(workspace), ...parents(canonical)])]) args.push("--dir", parent);
  args.push("--bind", workspace, workspace, "--dir", canonical, "--bind", privateDir, canonical,
    "--dir", "/mounts/runtime", "--ro-bind", runtime, "/mounts/runtime",
    "--dir", "/mounts/home", "--bind", home, "/mounts/home",
    "--dir", "/mounts/relay", "--ro-bind", relay, "/mounts/relay",
    "--setenv", "HOME", "/mounts/home", "--setenv", "TMPDIR", "/tmp",
    "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "LANG", "C.UTF-8",
    "--chdir", workspace, "--", guestPath(config.nodeExecutable), guestPath(config.hostScript),
    "guest", encoded(guestSpec));
  // This journal stays outside every guest mount; native code cannot certify its own stop.
  const statusFile = join(control, `protected-status-${randomUUID()}.jsonl`);
  const hostSpec = { bwrapArgs: args, statusFile };
  return { statusFile, guestMuseExecutable: guestPath(config.museExecutable),
    hostOptions: { museBin: config.nodeExecutable,
    args: [config.hostScript, "host", encoded(hostSpec)], cwd: workspace, env: {},
    clientInfo: { name: "muse_bridge", version: "0.1.0" } } };
}

export async function captureProtectedHost(statusFile: string, guestNativePath: string,
  hostNativePath: string, io?: ProtectedObserverIO): Promise<Captured> {
  try { return await captureProtectedNamespace(statusFile, guestNativePath, hostNativePath, io); }
  catch (error) {
    if (error instanceof BridgeError && error.code === "PROTECTED_NAMESPACE_INVALID") invalid(error.message);
    throw error;
  }
}
export async function verifyProtectedStop(captured: Captured, statusFile: string,
  io?: ProtectedObserverIO): Promise<boolean> {
  return verifyProtectedNamespaceStop(captured, statusFile, io);
}

export async function acceptProtectedCapture(captured: Captured, stopRequested: boolean): Promise<Captured> {
  if (!stopRequested) return captured;
  await captured.namespaceFd.close();
  throw new BridgeError("MUSE_STOP_UNCONFIRMED", "Protected startup settled after stop began");
}

/** SDK close and observed namespace retirement are separate facts. */
export function startProtectedClient(options: MuseClientSpawnOptions, statusFile: string,
  guestNativePath: string, hostNativePath: string,
  observations: Pick<ProtectedRuntimeConfig, "onNativeNotification" | "onCapture"> = {}):
  { ready: Promise<MuseClient>; close: () => Promise<unknown>;
    failure: Promise<never>; stopProof: () => Promise<boolean> } {
  const handshake = spawnMspConnection({ command: options.museBin,
    ...(options.args ? { args: options.args } : {}), ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.onStderr ? { onStderr: options.onStderr } : {}),
    ...(options.shutdownTimeoutMs === undefined ? {} : { shutdownTimeoutMs: options.shutdownTimeoutMs }) });
  let rejectFailure!: (reason: unknown) => void;
  const failure = new Promise<never>((_resolve, reject) => { rejectFailure = reject; });
  failure.catch(() => undefined);
  let observed: Captured | undefined;
  let stopRequested = false;
  const ready = handshake.initialize({ clientInfo: options.clientInfo }).then(async spawned => {
    if (observations.onNativeNotification) {
      const register = spawned.connection.onNotification.bind(spawned.connection);
      spawned.connection.onNotification = handler => register(notification => {
        observations.onNativeNotification!(notification);
        return handler(notification);
      });
    }
    const client = new MuseClient(spawned.connection,
      { durability: readSessionDurability(spawned.initializeResult), host: spawned });
    const captured = await captureProtectedHost(statusFile, guestNativePath, hostNativePath);
    observed = await acceptProtectedCapture(captured, stopRequested);
    observations.onCapture?.({ boot: observed.boot, pidns: observed.pidns,
      identities: observed.identities });
    void client.exit.then(() => rejectFailure(new BridgeError("MUSE_HOST_EXITED", "Protected host exited")),
      () => rejectFailure(new BridgeError("MUSE_HOST_EXIT_UNKNOWN", "Protected host exit unknown")));
    void spawned.connection.closed.then(() => rejectFailure(new BridgeError("MUSE_CONNECTION_CLOSED", "Protected connection closed")),
      () => rejectFailure(new BridgeError("MUSE_CONNECTION_FAILED", "Protected connection failed")));
    return client;
  });
  ready.catch(() => undefined);
  return { ready, failure, close: () => handshake.close(),
    stopProof: async () => {
      stopRequested = true;
      await ready.catch(() => undefined);
      const captured = observed;
      observed = undefined;
      return captured ? verifyProtectedStop(captured, statusFile) : false;
    } };
}
