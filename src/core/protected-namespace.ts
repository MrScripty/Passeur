import { open, readFile, readlink, readdir, stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { BridgeError } from "./errors.js";

export type ProcessIdentity = Readonly<{ pid: number; parent: number; start: string; pidns: string;
  netns: string; nspid: readonly number[]; exe: string }>;
type NamespaceHandle = Readonly<{ fd: number; close: () => Promise<void> }>;
export type Captured = Readonly<{ boot: string; pidns: string; wrapperPid: number; childPid: number; nativePid: number;
  namespaceFd: NamespaceHandle; identities: readonly ProcessIdentity[] }>;
type Status = Readonly<{ wrapper: number | null; child: number | null; exit: number | null;
  wrapperExit: number | null; wrapperSignal: string | null }>;
function observerInvalid(message: string): never { throw new BridgeError("PROTECTED_NAMESPACE_INVALID", message); }

function parseStatus(lines: string): Status {
  let wrapper: number | null = null, child: number | null = null, exit: number | null = null;
  let wrapperExit: number | null = null, wrapperSignal: string | null = null;
  for (const line of lines.trim().split("\n")) {
    if (!line) continue;
    const event = JSON.parse(line) as Record<string, unknown>;
    if (event.kind === "wrapper") {
      if (wrapper !== null || !Number.isSafeInteger(event.pid) || Number(event.pid) < 1) observerInvalid("duplicate or invalid wrapper PID");
      wrapper = Number(event.pid);
    } else if (Object.hasOwn(event, "child-pid")) {
      if (child !== null || !Number.isSafeInteger(event["child-pid"]) || Number(event["child-pid"]) < 1) observerInvalid("duplicate or invalid namespace PID");
      child = Number(event["child-pid"]);
    } else if (Object.hasOwn(event, "exit-code")) {
      if (exit !== null || child === null || !Number.isSafeInteger(event["exit-code"])) observerInvalid("invalid sandbox exit");
      exit = Number(event["exit-code"]);
    } else if (event.kind === "wrapper-exit") {
      if (wrapperExit !== null || typeof event.code !== "number" || !Number.isSafeInteger(event.code) ||
          event.signal !== null && typeof event.signal !== "string") observerInvalid("invalid wrapper exit");
      wrapperExit = event.code; wrapperSignal = event.signal as string | null;
    } else observerInvalid("unknown sandbox status frame");
  }
  return { wrapper, child, exit, wrapperExit, wrapperSignal };
}

async function identity(pid: number): Promise<ProcessIdentity> {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
  const parent = Number(fields[1]);
  if (["Z", "X"].includes(fields[0] ?? "") || !/^\d+$/.test(fields[19] ?? "") ||
      !Number.isSafeInteger(parent) || parent < 0) observerInvalid("process identity is unavailable");
  const [pidns, netns, exe, status] = await Promise.all([
    readlink(`/proc/${pid}/ns/pid`), readlink(`/proc/${pid}/ns/net`),
    readlink(`/proc/${pid}/exe`), readFile(`/proc/${pid}/status`, "utf8")]);
  const nspid = /^NSpid:\s+(.+)$/m.exec(status)?.[1]?.trim().split(/\s+/).map(Number);
  if (!nspid?.length || nspid.some(value => !Number.isSafeInteger(value) || value < 1))
    observerInvalid("process namespace identity is unavailable");
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

export async function captureProtectedNamespace(statusFile: string, guestNativePath: string,
  hostNativePath: string, io: ProtectedObserverIO = systemObserver,
  networkRelation: "isolated" | "inherited" = "isolated"): Promise<Captured> {
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
  if (status.child === null || status.wrapper === null) observerInvalid("sandbox child identity was not reported");
  const boot = await io.boot();
  const child = await io.identity(status.child), wrapper = await io.identity(status.wrapper);
  if (child.pidns === wrapper.pidns) observerInvalid("sandbox did not create a private PID namespace");
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
    const networkMatches = networkRelation === "isolated" ? child.netns !== wrapper.netns :
      networkRelation === "inherited" && child.netns === wrapper.netns;
    if (init.length !== 1 || init[0]!.parent !== wrapper.pid ||
        !networkMatches ||
        child.pidns === wrapper.pidns ||
        !descendsFrom(child, init[0]!) || native.length !== 1 ||
        !descendsFrom(native[0]!, child) || native[0]!.netns !== child.netns) {
      observerInvalid("native process association is unknown");
    }
    return { boot, pidns: child.pidns, wrapperPid: wrapper.pid, childPid: child.pid, nativePid: native[0]!.pid,
      namespaceFd, identities: [wrapper, ...observed] };
  } catch (error) { await namespaceFd.close(); throw error; }
}

export async function verifyProtectedNamespaceStop(captured: Captured, statusFile: string,
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
