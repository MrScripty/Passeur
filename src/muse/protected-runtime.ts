import { MuseClient, readSessionDurability, spawnMspConnection, type MuseClientSpawnOptions } from "@muse-code/sdk";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { open, readFile, readlink, readdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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

export type ProcessIdentity = Readonly<{ pid: number; parent: number; start: string; pidns: string;
  netns: string; nspid: readonly number[]; exe: string }>;
type NamespaceHandle = Readonly<{ fd: number; close: () => Promise<void> }>;
export type Captured = Readonly<{ boot: string; pidns: string; wrapperPid: number; childPid: number;
  namespaceFd: NamespaceHandle;
  identities: readonly ProcessIdentity[] }>;
type Status = Readonly<{ wrapper: number | null; child: number | null; exit: number | null;
  wrapperExit: number | null; wrapperSignal: string | null }>;

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

function parseStatus(lines: string): Status {
  let wrapper: number | null = null, child: number | null = null, exit: number | null = null;
  let wrapperExit: number | null = null, wrapperSignal: string | null = null;
  for (const line of lines.trim().split("\n")) {
    if (!line) continue;
    const event = JSON.parse(line) as Record<string, unknown>;
    if (event.kind === "wrapper") {
      if (wrapper !== null || !Number.isSafeInteger(event.pid) || Number(event.pid) < 1) invalid("duplicate or invalid wrapper PID");
      wrapper = Number(event.pid);
    } else if (Object.hasOwn(event, "child-pid")) {
      if (child !== null || !Number.isSafeInteger(event["child-pid"]) || Number(event["child-pid"]) < 1) invalid("duplicate or invalid namespace PID");
      child = Number(event["child-pid"]);
    } else if (Object.hasOwn(event, "exit-code")) {
      if (exit !== null || child === null || !Number.isSafeInteger(event["exit-code"])) invalid("invalid sandbox exit");
      exit = Number(event["exit-code"]);
    } else if (event.kind === "wrapper-exit") {
      if (wrapperExit !== null || typeof event.code !== "number" || !Number.isSafeInteger(event.code) ||
          event.signal !== null && typeof event.signal !== "string") invalid("invalid wrapper exit");
      wrapperExit = event.code; wrapperSignal = event.signal as string | null;
    } else invalid("unknown sandbox status frame");
  }
  return { wrapper, child, exit, wrapperExit, wrapperSignal };
}

async function identity(pid: number): Promise<ProcessIdentity> {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
  const parent = Number(fields[1]);
  if (["Z", "X"].includes(fields[0] ?? "") || !/^\d+$/.test(fields[19] ?? "") ||
      !Number.isSafeInteger(parent) || parent < 0) invalid("process identity is unavailable");
  const [pidns, netns, exe, status] = await Promise.all([
    readlink(`/proc/${pid}/ns/pid`), readlink(`/proc/${pid}/ns/net`),
    readlink(`/proc/${pid}/exe`), readFile(`/proc/${pid}/status`, "utf8")]);
  const nspid = /^NSpid:\s+(.+)$/m.exec(status)?.[1]?.trim().split(/\s+/).map(Number);
  if (!nspid?.length || nspid.some(value => !Number.isSafeInteger(value) || value < 1))
    invalid("process namespace identity is unavailable");
  return { pid, parent, start: fields[19]!, pidns, netns, exe, nspid };
}

async function members(pidns: string): Promise<ProcessIdentity[]> {
  const result: ProcessIdentity[] = [];
  for (const entry of await readdir("/proc")) {
    if (!/^[1-9]\d*$/.test(entry)) continue;
    let ns: string;
    try { ns = await readlink(`/proc/${entry}/ns/pid`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (ns === pidns) result.push(await identity(Number(entry)));
  }
  return result;
}

export type ProtectedObserverIO = Readonly<{
  status: (path: string) => Promise<string>;
  boot: () => Promise<string>;
  identity: (pid: number) => Promise<ProcessIdentity>;
  members: (pidns: string) => Promise<ProcessIdentity[]>;
  openNamespace: (pid: number) => Promise<NamespaceHandle>;
  heldNamespace: (fd: number) => Promise<string>;
  executable: (path: string) => Promise<Readonly<{ dev: number | bigint; ino: number | bigint }>>;
}>;
const systemObserver: ProtectedObserverIO = {
  status: path => readFile(path, "utf8"),
  boot: async () => (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
  identity, members,
  openNamespace: pid => open(`/proc/${pid}/ns/pid`, "r"),
  heldNamespace: fd => readlink(`/proc/self/fd/${fd}`),
  executable: path => stat(path),
};

export async function captureProtectedHost(statusFile: string, guestNativePath: string,
  hostNativePath: string, io: ProtectedObserverIO = systemObserver): Promise<Captured> {
  const deadline = Date.now() + 2_000;
  let status: Status;
  do {
    status = parseStatus(await io.status(statusFile).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }));
    if (status.child !== null && status.wrapper !== null) break;
    await delay(20);
  } while (Date.now() < deadline);
  if (status.child === null || status.wrapper === null) invalid("sandbox child identity was not reported");
  const boot = await io.boot();
  const child = await io.identity(status.child), wrapper = await io.identity(status.wrapper);
  if (child.pidns === wrapper.pidns) invalid("sandbox did not create a private PID namespace");
  const namespaceFd = await io.openNamespace(child.pid);
  try {
    const observed = await io.members(child.pidns);
    const init = observed.filter(member => member.nspid.at(-1) === 1);
    const staged = await io.executable(hostNativePath);
    const native = [];
    for (const member of observed) {
      if (member.exe !== guestNativePath && member.exe !== hostNativePath) continue;
      const executable = await io.executable(`/proc/${member.pid}/exe`);
      if (executable.dev === staged.dev && executable.ino === staged.ino) native.push(member);
    }
    const byPid = new Map(observed.map(member => [member.pid, member]));
    const descendsFrom = (member: ProcessIdentity, ancestor: ProcessIdentity): boolean => {
      let current = member;
      const seen = new Set<number>();
      while (current.pid !== ancestor.pid && byPid.has(current.parent) && !seen.has(current.pid)) {
        seen.add(current.pid);
        current = byPid.get(current.parent)!;
      }
      return current.pid === ancestor.pid;
    };
    if (init.length !== 1 || init[0]!.parent !== wrapper.pid ||
        child.netns === wrapper.netns || child.pidns === wrapper.pidns ||
        !descendsFrom(child, init[0]!) || native.length !== 1 ||
        !descendsFrom(native[0]!, child) || native[0]!.netns !== child.netns) {
      invalid("native process association is unknown");
    }
    return { boot, pidns: child.pidns, wrapperPid: wrapper.pid, childPid: child.pid,
      namespaceFd, identities: [wrapper, ...observed] };
  } catch (error) { await namespaceFd.close(); throw error; }
}

export async function verifyProtectedStop(captured: Captured, statusFile: string,
  io: ProtectedObserverIO = systemObserver): Promise<boolean> {
  try {
    const status = parseStatus(await io.status(statusFile));
    if (status.child !== captured.childPid || status.wrapper !== captured.wrapperPid ||
        status.exit === null || status.wrapperExit === null ||
        status.wrapperExit !== status.exit || status.wrapperSignal !== null ||
        await io.boot() !== captured.boot ||
        await io.heldNamespace(captured.namespaceFd.fd) !== captured.pidns) return false;
    for (const observed of captured.identities) {
      try { await io.identity(observed.pid); return false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; }
    }
    return (await io.members(captured.pidns)).length === 0;
  } catch { return false; }
  finally { await captured.namespaceFd.close(); }
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
