import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, writeSync } from "node:fs";
import { TextDecoder } from "node:util";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import { BridgeError } from "../../core/errors.js";
import type { WorkerInput } from "../types.js";
import { verifyProtectedNamespaceStop, type Captured, type ProtectedObserverIO } from "../../core/protected-namespace.js";

export { captureProtectedNamespace as captureProtectedHost,
  verifyProtectedNamespaceStop as verifyProtectedStop } from "../../core/protected-namespace.js";

export async function settleProtectedStop(captured: Captured | undefined, statusFile: string,
  transportClosed: boolean, io?: ProtectedObserverIO): Promise<"confirmed" | "unconfirmed"> {
  // Audit even after a failed transport close so the held namespace descriptor is released.
  let stopped = false;
  try { stopped = captured ? await verifyProtectedNamespaceStop(captured, statusFile, io) : false; }
  catch { return "unconfirmed"; }
  return transportClosed && stopped ? "confirmed" : "unconfirmed";
}

function invalid(): never { throw new BridgeError("CODEX_PROTECTED_LAUNCH_INVALID", "Protected Codex launch identity or mount is invalid"); }
function directory(path: string): string {
  try { if (!isAbsolute(path) || realpathSync(path) !== path || !lstatSync(path).isDirectory()) invalid(); }
  catch { invalid(); }
  return path;
}
function file(path: string): string {
  try { if (!isAbsolute(path) || realpathSync(path) !== path || !lstatSync(path).isFile()) invalid(); }
  catch { invalid(); }
  return path;
}
function overlaps(a: string, b: string): boolean { return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`); }
function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}
/** The guest sees this exact policy artifact, mounted read-only over its writable home. */
export function assertProtectedHomePolicy(home: string, workspace: string, canonical: string,
  admin: string, native: string): Buffer {
  const configPath = file(join(home, "config.toml"));
  try {
    if (readdirSync(home).join("\0") !== "config.toml") invalid();
    const bytes = readFileSync(configPath);
    const parsed = parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<string, unknown>;
    if (parsed.default_permissions !== "passeur-boundary" ||
        !exactKeys(parsed.permissions, ["passeur-boundary"])) invalid();
    const profile = parsed.permissions["passeur-boundary"];
    if (!exactKeys(profile, ["workspace_roots", "filesystem", "network"]) ||
        !exactKeys(profile.workspace_roots, [workspace, canonical]) ||
        profile.workspace_roots[workspace] !== true || profile.workspace_roots[canonical] !== true ||
        !exactKeys(profile.filesystem, [":root", ":minimal", ":slash_tmp", ":tmpdir", native, admin, ":workspace_roots"]) ||
        profile.filesystem[":root"] !== "deny" || profile.filesystem[":minimal"] !== "read" ||
        profile.filesystem[":slash_tmp"] !== "deny" || profile.filesystem[":tmpdir"] !== "deny" ||
        profile.filesystem[native] !== "read" || profile.filesystem[admin] !== "write" ||
        !exactKeys(profile.filesystem[":workspace_roots"], ["."]) ||
        profile.filesystem[":workspace_roots"]["."] !== "write" ||
        !exactKeys(profile.network, ["enabled"]) || profile.network.enabled !== false) invalid();
    return bytes;
  } catch { invalid(); }
}
function snapshotPolicy(control: string, bytes: Buffer): string {
  const path = join(control, `codex-profile-${randomUUID()}.toml`);
  const fd = openSync(path, "wx", 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  if (!readFileSync(path).equals(bytes)) invalid();
  return path;
}
function parents(path: string): string[] {
  const result: string[] = [];
  for (let parent = dirname(path); parent !== "/"; parent = dirname(parent)) result.unshift(parent);
  return result;
}

/** The only mounted repository metadata is the private common dir at its canonical original path. */
export function protectedLaunch(input: WorkerInput, codexBin: string, codexHome: string,
  hostScript: string, nativeArgs: readonly string[], relay?: Readonly<{ socketPath: string; port: number }>): { command: string; args: string[]; env: NodeJS.ProcessEnv;
    statusFile: string; nativePath: string } {
  const view = input.private_git?.view;
  if (input.private_git?.schema_version !== 1 || input.private_git.mount_kind !== "canonical_common_dir" ||
      !view || input.request.mode !== "implement") invalid();
  const workspace = directory(input.workspace), home = directory(codexHome);
  const privateDir = directory(view.private_common_dir), canonical = directory(view.canonical_common_dir);
  const native = file(codexBin), host = file(hostScript), node = file(process.execPath);
  const packageJson = relay ? file(fileURLToPath(new URL("../../../../package.json", import.meta.url))) : undefined;
  const control = dirname(privateDir);
  const relayDir = relay ? directory(dirname(relay.socketPath)) : undefined;
  if (relay && (!Number.isSafeInteger(relay.port) || relay.port < 1 || relay.port > 65535 ||
      !relayDir?.startsWith("/tmp/") || !lstatSync(relay.socketPath).isSocket() ||
      realpathSync(relay.socketPath) !== relay.socketPath ||
      (lstatSync(relayDir).mode & 0o7777) !== 0o700 || lstatSync(relayDir).uid !== process.getuid?.() ||
      readdirSync(relayDir).join("\0") !== relay.socketPath.slice(relayDir.length + 1) ||
      [workspace, home, privateDir, canonical, control].some(path => overlaps(path, relayDir)))) invalid();
  const dotGit = join(workspace, ".git"), privateAdmin = join(privateDir, view.admin_relative);
  if (!workspace.startsWith("/tmp/") || !canonical.startsWith("/tmp/") || !privateDir.startsWith("/tmp/") ||
      privateDir !== join(control, "private-git") || !/^worktrees\/[A-Za-z0-9._-]+$/.test(view.admin_relative) ||
      [workspace, home, native, node, host].some(path => overlaps(path, privateDir) || overlaps(path, canonical)) ||
      [home, privateDir, canonical].some(path => overlaps(path, workspace)) || overlaps(home, control) ||
      !lstatSync(dotGit).isFile() || realpathSync(dotGit) !== dotGit ||
      !lstatSync(privateAdmin).isDirectory() || realpathSync(privateAdmin) !== privateAdmin ||
      !lstatSync(join(privateAdmin, "commondir")).isFile() ||
      realpathSync(join(privateAdmin, "commondir")) !== join(privateAdmin, "commondir") ||
      readFileSync(dotGit, "utf8").trim() !== `gitdir: ${canonical}/${view.admin_relative}` ||
      readFileSync(join(privateAdmin, "commondir"), "utf8").trim() !== "../..") invalid();
  const configSnapshot = snapshotPolicy(control, assertProtectedHomePolicy(home, workspace, canonical,
    join(canonical, view.admin_relative), native));
  // Codex's named profile starts a nested user namespace for each tool. Keep that
  // capability inside this outer task-owned PID and network namespace.
  const args = ["--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-net",
    "--die-with-parent", "--new-session", "--clearenv"];
  for (const root of ["/usr", "/bin", "/lib", "/lib64"]) if (existsSync(root)) args.push("--ro-bind", root, root);
  args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/mounts", "--dir", "/mounts/home",
    "--bind", home, "/mounts/home", "--dir", "/dev/shm", "--tmpfs", "/dev/shm");
  for (const parent of [...new Set([...parents(workspace), ...parents(canonical), ...parents(native),
    ...(relay ? [...parents(node), ...parents(host)] : [])])]) {
    if (parent !== "/tmp" && parent !== "/dev" && parent !== "/mounts" &&
        !["/usr", "/bin", "/lib", "/lib64"].some(root => parent === root || parent.startsWith(`${root}/`))) args.push("--dir", parent);
  }
  args.push("--bind", workspace, workspace, "--dir", canonical, "--bind", privateDir, canonical,
    "--ro-bind", native, native, "--ro-bind", configSnapshot, "/mounts/home/config.toml",
    "--setenv", "HOME", "/mounts/home", "--setenv", "CODEX_HOME", "/mounts/home",
    "--setenv", "TMPDIR", "/tmp", "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "LANG", "C.UTF-8",
    "--chdir", workspace);
  if (relay) {
    args.push("--ro-bind", node, node, "--ro-bind", host, host,
      "--ro-bind", packageJson!, packageJson!,
      "--dir", "/mounts/relay", "--ro-bind", relayDir!, "/mounts/relay",
      "--", node, host, "guest", Buffer.from(JSON.stringify({ native, nativeArgs,
        socketPath: `/mounts/relay/${relay.socketPath.slice(relayDir!.length + 1)}`, port: relay.port })).toString("base64url"));
  } else args.push("--", native, ...nativeArgs);
  const statusFile = join(control, `codex-protected-status-${randomUUID()}.jsonl`);
  const spec = Buffer.from(JSON.stringify({ args, statusFile })).toString("base64url");
  return { command: node, args: [host, spec], env: {}, statusFile, nativePath: native };
}
