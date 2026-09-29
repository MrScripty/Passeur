import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, writeSync } from "node:fs";
import { TextDecoder } from "node:util";
import { performance } from "node:perf_hooks";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import { BridgeError } from "../../core/errors.js";
import type { WorkerInput } from "../types.js";
import { captureProtectedNamespace, verifyProtectedNamespaceStop, type Captured,
  type ProtectedObserverIO } from "../../core/protected-namespace.js";

export { captureProtectedNamespace as captureProtectedHost,
  verifyProtectedNamespaceStop as verifyProtectedStop } from "../../core/protected-namespace.js";

/** Native may join the sandbox just after the host reports its child PID. */
export async function captureProtectedStartup(statusFile: string, nativePath: string,
  io?: ProtectedObserverIO, networkRelation: "isolated" | "inherited" = "isolated"): Promise<Captured> {
  const deadline = performance.now() + 2_000;
  for (;;) {
    try { return await captureProtectedNamespace(statusFile, nativePath, nativePath, io, networkRelation); }
    catch (error) {
      if (!(error instanceof BridgeError) || error.code !== "PROTECTED_NAMESPACE_INVALID" ||
          error.message !== "native process association is unknown" || performance.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
}

export async function settleProtectedStop(captured: Captured | undefined, statusFile: string,
  transportClosed: boolean, io?: ProtectedObserverIO): Promise<"confirmed" | "unconfirmed"> {
  // Audit even after a failed transport close so the held namespace descriptor is released.
  let stopped = false;
  try { stopped = captured ? await verifyProtectedNamespaceStop(captured, statusFile, io) : false; }
  catch { return "unconfirmed"; }
  return transportClosed && stopped ? "confirmed" : "unconfirmed";
}

/** Marker is produced by the out-of-guest byte scanner after any stream exposure. */
export function protectedCredentialExposure(statusFile: string): boolean {
  try { readFileSync(`${statusFile}.exposure`); return true; }
  catch (error) { return !((error as NodeJS.ErrnoException).code === "ENOENT"); }
}

/** Only the out-of-guest host writes this exact marker before any Bubblewrap spawn. */
export function protectedSeedAdmissionRefused(statusFile: string): boolean {
  try { return readFileSync(statusFile, "utf8") === '{"kind":"admission","code":"CODEX_PROTECTED_AUTH_STALE"}\n'; }
  catch { return false; }
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
function publicHostFile(path: string): string {
  try {
    const resolved = realpathSync(path), info = lstatSync(resolved);
    if (!isAbsolute(resolved) || !info.isFile() || (info.mode & 0o004) === 0 ||
        (info.mode & 0o022) !== 0) invalid();
    return resolved;
  } catch { invalid(); }
}
function callerAuthFile(home: string, excluded: readonly string[]): string {
  const path = join(home, "auth.json");
  try {
    const info = lstatSync(path);
    if (realpathSync(path) !== path || !info.isFile() || info.nlink !== 1 ||
        info.uid !== process.getuid?.() || (info.mode & 0o700) !== 0o600 ||
        (info.mode & 0o077) !== 0 || excluded.some(root => overlaps(path, root))) invalid();
    return path;
  } catch { invalid(); }
}
function overlaps(a: string, b: string): boolean { return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`); }
function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}
/** A generated task policy contains no caller settings or credential material. */
export function realProtectedPolicy(workspace: string, canonical: string, admin: string, native: string): Buffer {
  const paths = [workspace, canonical, admin, native];
  if (paths.some(path => !isAbsolute(path) || path.includes("\n") || path.includes("\r") || path.includes("\0")) ||
      new Set(paths).size !== paths.length) invalid();
  const quote = (value: string) => JSON.stringify(value);
  return Buffer.from(`cli_auth_credentials_store = "file"\n` +
    `[skills]\ninclude_instructions = false\n[skills.bundled]\nenabled = false\n` +
    `[memories]\nuse_memories = false\ngenerate_memories = false\n` +
    `[permissions."passeur-boundary".workspace_roots]\n${quote(workspace)} = true\n${quote(canonical)} = true\n` +
    `[permissions."passeur-boundary".filesystem]\n":root" = "deny"\n":minimal" = "read"\n` +
    `":slash_tmp" = "deny"\n":tmpdir" = "deny"\n${quote(native)} = "read"\n${quote(admin)} = "write"\n` +
    `[permissions."passeur-boundary".filesystem.":workspace_roots"]\n"." = "write"\n` +
    `[permissions."passeur-boundary".network]\nenabled = true\n`);
}
/** The guest sees this exact policy artifact, mounted read-only over its writable home. */
export function assertProtectedHomePolicy(home: string, workspace: string, canonical: string,
  admin: string, native: string, seededPort?: number,
  tls?: Readonly<{ accountHost: string; inferenceHost: string; firstParty?: true }>): Buffer {
  const configPath = file(join(home, "config.toml"));
  try {
    if (readdirSync(home).join("\0") !== "config.toml") invalid();
    const bytes = readFileSync(configPath);
    const parsed = parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<string, unknown>;
    if (tls?.firstParty ?
        parsed.model_provider !== "openai" || parsed.chatgpt_base_url !== undefined ||
        parsed.model_providers !== undefined ||
        !exactKeys(parsed.analytics, ["enabled"]) || parsed.analytics.enabled !== false :
        tls ? parsed.chatgpt_base_url !== `https://${tls.accountHost}` ||
        !exactKeys(parsed.model_providers, ["passeur_fixture_tls"]) ||
        !exactKeys(parsed.model_providers.passeur_fixture_tls,
          ["name", "base_url", "wire_api", "requires_openai_auth"]) ||
        parsed.model_providers.passeur_fixture_tls.base_url !== `https://${tls.inferenceHost}/v1` ||
        parsed.model_providers.passeur_fixture_tls.requires_openai_auth !== true ||
        !exactKeys(parsed.analytics, ["enabled"]) || parsed.analytics.enabled !== false :
        seededPort === undefined ? parsed.chatgpt_base_url !== undefined :
        parsed.chatgpt_base_url !== `http://127.0.0.1:${seededPort}` ||
        !exactKeys(parsed.model_providers, ["passeur_fixture_loopback"]) ||
        !exactKeys(parsed.model_providers.passeur_fixture_loopback,
          ["name", "base_url", "wire_api", "requires_openai_auth"]) ||
        parsed.model_providers.passeur_fixture_loopback.base_url !== `http://127.0.0.1:${seededPort}/v1` ||
        parsed.model_providers.passeur_fixture_loopback.requires_openai_auth !== true) invalid();
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
  hostScript: string, nativeArgs: readonly string[], relay?: Readonly<{ socketPath: string; port: number;
    tlsProxy?: Readonly<{ caFile: string; accountHost: string; inferenceHost: string; firstParty?: true;
      directNoProxy?: true }> }>,
  seedFile?: string, lateExposure = false, realCallerHome = false): { command: string; args: string[]; env: NodeJS.ProcessEnv;
    statusFile: string; nativePath: string; guestStartPermit: boolean } {
  const view = input.private_git?.view;
  if (input.private_git?.schema_version !== 1 || input.private_git.mount_kind !== "canonical_common_dir" ||
      !view || input.request.mode !== "implement") invalid();
  const workspace = directory(input.workspace), home = directory(codexHome);
  const privateDir = directory(view.private_common_dir), canonical = directory(view.canonical_common_dir);
  const native = file(codexBin), host = file(hostScript), node = file(process.execPath);
  const dns = realCallerHome ? publicHostFile("/etc/resolv.conf") : undefined;
  const publicCa = realCallerHome ? publicHostFile("/etc/ssl/certs/ca-certificates.crt") : undefined;
  const egressModule = relay?.tlsProxy ? file(fileURLToPath(new URL("./protected-egress.js", import.meta.url))) : undefined;
  const packageJson = relay ? file(fileURLToPath(new URL("../../../../package.json", import.meta.url))) : undefined;
  const control = dirname(privateDir);
  if (lateExposure && !seedFile || realCallerHome && (seedFile || relay || lateExposure)) invalid();
  if (seedFile && (!isAbsolute(seedFile) || !seedFile.startsWith("/tmp/") ||
      [workspace, home, privateDir, canonical, control].some(path => overlaps(path, seedFile)) ||
      !relay)) invalid();
  const relayDir = relay ? directory(dirname(relay.socketPath)) : undefined;
  const ca = relay?.tlsProxy ? file(relay.tlsProxy.caFile) : undefined;
  if (relay?.tlsProxy && (!seedFile || !ca?.startsWith("/tmp/") ||
      !/^[a-z0-9][a-z0-9.-]{0,252}$/.test(relay.tlsProxy.accountHost) ||
      !/^[a-z0-9][a-z0-9.-]{0,252}$/.test(relay.tlsProxy.inferenceHost) ||
      (relay.tlsProxy.firstParty ?
        relay.tlsProxy.accountHost !== "chatgpt.com" || relay.tlsProxy.inferenceHost !== "chatgpt.com" :
        relay.tlsProxy.accountHost === relay.tlsProxy.inferenceHost) ||
      [relay.tlsProxy.accountHost, relay.tlsProxy.inferenceHost].includes("auth.openai.com") ||
      readFileSync(ca!).length > 65_536 || !readFileSync(ca!, "utf8").includes("-----BEGIN CERTIFICATE-----") ||
      readFileSync(ca!, "utf8").includes("PRIVATE KEY"))) invalid();
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
  const callerAuth = realCallerHome ? callerAuthFile(home, [workspace, control, privateDir, canonical]) : undefined;
  const configSnapshot = snapshotPolicy(control, realCallerHome
    ? realProtectedPolicy(workspace, canonical, join(canonical, view.admin_relative), native)
    : assertProtectedHomePolicy(home, workspace, canonical,
      join(canonical, view.admin_relative), native, seedFile && !relay?.tlsProxy ? relay?.port : undefined,
      relay?.tlsProxy));
  // Codex's named profile starts a nested user namespace for each tool. The
  // real host inherits network; the real named profile permits ordinary network.
  const args = ["--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
    ...(realCallerHome ? [] : ["--unshare-net"]), "--die-with-parent", "--new-session", "--clearenv"];
  for (const root of ["/usr", "/bin", "/lib", "/lib64"]) if (existsSync(root)) args.push("--ro-bind", root, root);
  args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/mounts", "--dir", "/mounts/home");
  if (realCallerHome) args.push("--dir", "/etc", "--dir", "/etc/ssl", "--dir", "/etc/ssl/certs",
    "--ro-bind", dns!, "/etc/resolv.conf", "--ro-bind", publicCa!, "/etc/ssl/certs/ca-certificates.crt");
  if (seedFile) args.push("--perms", "0700", "--tmpfs", "/mounts/home", "--perms", "0600", "--file", "4", "/mounts/home/auth.json");
  else if (callerAuth) args.push("--perms", "0700", "--tmpfs", "/mounts/home", "--bind-fd", "4", "/mounts/home/auth.json");
  else args.push("--bind", home, "/mounts/home");
  args.push("--dir", "/dev/shm", "--tmpfs", "/dev/shm");
  for (const parent of [...new Set([...parents(workspace), ...parents(canonical), ...parents(native),
    ...(relay ? [...parents(node), ...parents(host)] : []), ...(egressModule ? parents(egressModule) : [])])]) {
    if (parent !== "/tmp" && parent !== "/dev" && parent !== "/mounts" &&
        !["/usr", "/bin", "/lib", "/lib64"].some(root => parent === root || parent.startsWith(`${root}/`))) args.push("--dir", parent);
  }
  args.push("--bind", workspace, workspace, "--dir", canonical, "--bind", privateDir, canonical,
    "--ro-bind", native, native, "--ro-bind", configSnapshot, "/mounts/home/config.toml",
    "--setenv", "HOME", "/mounts/home", "--setenv", "CODEX_HOME", "/mounts/home",
    "--setenv", "TMPDIR", "/tmp", "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "LANG", "C.UTF-8",
    "--chdir", workspace);
  if (relay?.tlsProxy) {
    args.push("--ro-bind", ca!, "/mounts/ca.pem",
      "--setenv", "CODEX_CA_CERTIFICATE", "/mounts/ca.pem");
    if (!relay.tlsProxy.directNoProxy) args.push("--setenv", "HTTP_PROXY", `http://127.0.0.1:${relay.port}`,
      "--setenv", "HTTPS_PROXY", `http://127.0.0.1:${relay.port}`);
  }
  if (relay) {
    args.push("--ro-bind", node, node, "--ro-bind", host, host,
      ...(egressModule ? ["--ro-bind", egressModule, egressModule] : []),
      "--ro-bind", packageJson!, packageJson!,
      "--dir", "/mounts/relay", "--ro-bind", relayDir!, "/mounts/relay",
      "--", node, host, "guest", Buffer.from(JSON.stringify({ native, nativeArgs,
        socketPath: `/mounts/relay/${relay.socketPath.slice(relayDir!.length + 1)}`, port: relay.port,
        ...(relay.tlsProxy ? { tlsProxy: true } : {}),
        ...(seedFile ? { seededProbe: true } : {}), ...(lateExposure ? { lateExposure: true } : {}) })).toString("base64url"));
  } else args.push("--", native, ...nativeArgs);
  const statusFile = join(control, `codex-protected-status-${randomUUID()}.jsonl`);
  const spec = Buffer.from(JSON.stringify({ args, statusFile, ...(seedFile ? { seedFile } : {}),
    ...(callerAuth ? { callerAuthFile: callerAuth } : {}),
    ...(relay?.tlsProxy ? { tlsSeedAdmission: true } : {}) })).toString("base64url");
  return { command: node, args: [host, spec], env: {}, statusFile, nativePath: native,
    guestStartPermit: !!relay };
}
