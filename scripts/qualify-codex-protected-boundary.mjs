#!/usr/bin/env node
// Installed, no-account diagnostic. A command denial is only a preliminary boundary observation.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readlink, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = 'codex-cli 0.157.1';
const NATIVE_ELF = '/home/jeremy/.nvm/versions/node/v24.12.0/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex';
const NATIVE_SHA256 = '3e2584f3f3829a43a0495011a1cecb2facbe64a2403e2b682351fd9c2983f970';
const PROFILE = 'passeur-boundary';
const COMMAND_SCHEMA_SHA256 = 'fd034b4c85d7b6f466e30a3cbb73db86be1263aca3f81b89b547f14817dfb62e';
const REQUEST_MS = 10_000;
const MAX_LINE = 1_048_576;

export function matchesNativeAttestation(path, sha256) {
  return path === NATIVE_ELF && sha256 === NATIVE_SHA256;
}

export function selectedEnvironment(home) {
  return { HOME: home, CODEX_HOME: join(home, 'codex'), PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', RUST_LOG: 'off' };
}

export function profileToml(workspace, verifiedElf) {
  if (verifiedElf !== NATIVE_ELF) throw new Error('profile requires the exact verified Codex ELF');
  return `default_permissions = "${PROFILE}"\n[permissions."${PROFILE}".workspace_roots]\n${JSON.stringify(workspace)} = true\n` +
    `[permissions."${PROFILE}".filesystem]\n":root" = "deny"\n":minimal" = "read"\n":slash_tmp" = "deny"\n":tmpdir" = "deny"\n${JSON.stringify(verifiedElf)} = "read"\n` +
    `[permissions."${PROFILE}".filesystem.":workspace_roots"]\n"." = "write"\n` +
    `[permissions."${PROFILE}".network]\nenabled = false\n`;
}

export function commandRequest(command, cwd) {
  return { command, cwd, permissionProfile: PROFILE, timeoutMs: REQUEST_MS, outputBytesCap: 4096 };
}

export function profileAvailability(result) {
  if (!Array.isArray(result?.data) || result.nextCursor !== null && result.nextCursor !== undefined) return 'unknown';
  const matches = result.data.filter(item => item?.id === PROFILE);
  if (matches.length !== 1 || typeof matches[0].allowed !== 'boolean') return 'unknown';
  return matches[0].allowed ? 'allowed' : 'disallowed';
}

export function safeReply(reply) {
  const output = reply?.result;
  if (reply?.error) return { id: reply.id, kind: 'error', code: Number.isSafeInteger(reply.error.code) ? reply.error.code : null,
    category: errorCategory(reply.error.message) };
  return { id: reply?.id, kind: 'result', exitCode: Number.isSafeInteger(output?.exitCode) ? output.exitCode : null,
    stdoutBytes: Buffer.byteLength(typeof output?.stdout === 'string' ? output.stdout : ''),
    stderrBytes: Buffer.byteLength(typeof output?.stderr === 'string' ? output.stderr : '') };
}

export function errorCategory(message) {
  if (typeof message !== 'string') return 'unknown';
  if (/cannot be combined|mutually exclusive|both.*sandboxPolicy.*permissionProfile|both.*permissionProfile.*sandboxPolicy/i.test(message)) return 'mutually_exclusive';
  if (/profile.*(not allowed|disallowed|denied|unknown|not found|invalid)/i.test(message)) return 'profile_rejected';
  if (/sandbox.*(unavailable|failed|not supported)|bubblewrap.*(unavailable|failed)/i.test(message)) return 'sandbox_unavailable';
  if (/unsupported|unknown field|invalid params|invalid request|not implemented/i.test(message)) return 'unsupported_request';
  return 'unknown';
}

export function positiveCommandFailure(reply) {
  const stderr = typeof reply?.result?.stderr === 'string' ? reply.result.stderr : '';
  const category = /sandbox|bubblewrap|bwrap|seccomp|unshare|mount namespace/i.test(stderr) ? 'sandbox_runtime'
    : /permission denied|operation not permitted|access denied|\bEACCES\b|\bEPERM\b/i.test(stderr) ? 'permission'
    : /command not found|exec format error|not executable|failed to execute/i.test(stderr) ? 'execution'
    : /no such file or directory|\bENOENT\b|path not found/i.test(stderr) ? 'missing_path'
    : 'unknown';
  return { category, stderrBytes: Buffer.byteLength(stderr), stderrSha256: createHash('sha256').update(stderr).digest('hex') };
}

export async function retainPositiveStderr(reply, root, write = writeFile) {
  if (reply?.error || typeof reply?.result?.stderr !== 'string') return undefined;
  const bytes = Buffer.from(reply.result.stderr, 'utf8').subarray(0, 256);
  const path = join(root, 'allowed-read-stderr.txt');
  await write(path, bytes, { mode: 0o600, flag: 'wx' });
  return { path, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
    category: positiveCommandFailure(reply).category };
}

export async function hostCanaryCheck(kind, path, target, canary) {
  try {
    if (await readFile(target, 'utf8') !== canary) return false;
    if (kind === 'symlink') {
      if (!(await lstat(path)).isSymbolicLink() || await readlink(path) !== target) return false;
    } else if (kind === 'proc') {
      if (path !== `/proc/self/root${target}`) return false;
    } else if (kind === 'direct' || kind === 'codex_home') {
      if (path !== target || !(await lstat(path)).isFile()) return false;
    } else return false;
    return await readFile(path, 'utf8') === canary;
  } catch { return false; }
}

export function classifyRead(reply, canary, { positive, before, after, path } = {}) {
  if (reply?.error) return 'unsupported';
  const result = reply?.result;
  if (!result || typeof result.stdout !== 'string' || typeof result.stderr !== 'string' || !Number.isSafeInteger(result.exitCode)) return 'inconclusive';
  if (result.stdout.includes(canary) || result.stderr.includes(canary)) return 'exposed';
  if (!positive || !before || !after || typeof path !== 'string') return 'inconclusive';
  const diagnostic = result.stderr.trimEnd();
  const catErrors = ['cat', '/usr/bin/cat'].map(command => `${command}: ${path}: `);
  if (result.exitCode !== 0 && catErrors.some(prefix => ['Permission denied', 'Operation not permitted', 'Access denied']
    .some(reason => diagnostic === `${prefix}${reason}`))) return 'denied';
  if (result.exitCode !== 0 && catErrors.some(prefix => ['No such file or directory', 'ENOENT']
    .some(reason => diagnostic === `${prefix}${reason}`))) return 'hidden_denied';
  return 'inconclusive';
}

export function isNativeExecutableHeader(bytes) {
  return Buffer.isBuffer(bytes) && bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
}

export function permissionSelector(value) {
  if (value === undefined) return 'absent';
  if (value === null) return 'null';
  if ([':read-only', ':workspace', ':danger-full-access'].includes(value)) return 'built-in';
  if (typeof value === 'string' && value.length > 0 && !value.startsWith(':')) return 'custom';
  return 'unknown';
}

export function effectiveConfig(result) {
  const config = result?.config;
  const features = config?.features;
  const selector = permissionSelector(config?.default_permissions);
  const legacySelector = permissionSelector(config?.permission_profile);
  const camelSelector = permissionSelector(config?.permissionProfile);
  const observation = {
    appsDisabled: features?.apps === false, pluginsDisabled: features?.plugins === false,
    multiAgentDisabled: features?.multi_agent === false, webDisabled: config?.web_search === 'disabled',
    mcpEmpty: config?.mcp_servers && typeof config.mcp_servers === 'object' && !Array.isArray(config.mcp_servers) && Object.keys(config.mcp_servers).length === 0,
    permissionSelector: selector,
    selectedProfileExact: config?.default_permissions === PROFILE,
    legacySandboxAbsent: [undefined, null].includes(config?.sandbox_mode) && [undefined, null].includes(config?.sandbox_workspace_write),
    otherSelectorAbsent: ['absent', 'null'].includes(legacySelector) && ['absent', 'null'].includes(camelSelector),
  };
  return { ...observation, valid: Object.entries(observation).every(([key, value]) => key === 'permissionSelector' || value === true) };
}

async function nativeExecutable(bin) {
  const file = await open(bin, 'r');
  try {
    const header = Buffer.alloc(4);
    const { bytesRead } = await file.read(header, 0, 4, 0);
    return bytesRead === 4 && isNativeExecutableHeader(header);
  } finally { await file.close(); }
}

async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function native(bin, cwd, env) {
  const child = spawn(bin, ['-c', 'mcp_servers={}', '-c', 'features.apps=false', '-c', 'features.plugins=false',
    '-c', 'features.multi_agent=false', '-c', 'web_search="disabled"', 'app-server'],
  { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  let sequence = 0;
  const pending = new Map();
  let buffer = Buffer.alloc(0);
  let fault;
  const fail = error => { if (fault) return; fault = error; buffer = Buffer.alloc(0); for (const item of pending.values()) item.reject(error); pending.clear(); };
  child.once('error', fail);
  child.once('exit', () => fail(new Error('native host exited before the requested response')));
  child.stderr.resume(); // Native diagnostics may contain paths or data; never retain them.
  child.stdout.on('data', chunk => {
    if (fault) return;
    if (buffer.length + chunk.length > MAX_LINE) return fail(new Error('native frame exceeded the fixture limit'));
    buffer = Buffer.concat([buffer, chunk]);
    let end;
    while ((end = buffer.indexOf(10)) >= 0) {
    const line = buffer.subarray(0, end).toString('utf8');
    buffer = buffer.subarray(end + 1);
    let message;
    try { message = JSON.parse(line); } catch { return fail(new Error('invalid native JSON frame')); }
    if (message?.id === undefined) continue;
    const item = pending.get(message.id);
    if (!item) return fail(new Error('unexpected native response ID'));
    pending.delete(message.id); item.resolve(message);
    }
  });
  child.stdout.once('close', () => fail(new Error('native output closed')));
  const request = (method, params) => {
    if (fault) return Promise.reject(fault);
    const id = ++sequence;
    return new Promise((resolveResponse, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`native ${method} observation deadline`)); }, REQUEST_MS);
      pending.set(id, { resolve: response => { clearTimeout(timer); resolveResponse(response); },
        reject: error => { clearTimeout(timer); reject(error); } });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, error => {
        if (error) { pending.delete(id); clearTimeout(timer); reject(new Error('native input write failed')); }
      });
    });
  };
  const notify = (method, params) => child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  return { child, request, notify };
}

async function stop(nativeHost) {
  const child = nativeHost.child;
  child.stdin.end();
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  if (child.exitCode === null && child.signalCode === null) {
    await Promise.race([new Promise(resolveStop => child.once('exit', resolveStop)), new Promise(resolveStop => setTimeout(resolveStop, 3000))]);
  }
  // Parent exit, pipe closure and PGID disappearance do not prove reparented descendants stopped.
  return child.exitCode !== null || child.signalCode !== null;
}

export async function run(bin) {
  const root = await mkdtemp(join(tmpdir(), 'passeur-codex-boundary-'));
  const home = join(root, 'home'), workspace = join(root, 'work'), protectedRoot = join(root, 'protected');
  let host, hostExited = false;
  const report = { fixture: 'codex-protected-boundary/1', expectedVersion: VERSION, root,
    commandSchemaSha256: COMMAND_SCHEMA_SHA256,
    status: 'not_started', probes: [], hostExitObserved: false, descendantStop: 'unverified',
    unqualifiedModelSurfaces: ['model_turn_file_tools', 'model_turn_command_tools'],
    excludedClientRpcs: ['fs/readFile', 'thread/shellCommand', 'process/spawn'] };
  try {
    await Promise.all([mkdir(join(home, 'codex'), { recursive: true, mode: 0o700 }), mkdir(workspace), mkdir(protectedRoot)]);
    await chmod(home, 0o700); await chmod(protectedRoot, 0o700);
    const canary = randomBytes(24).toString('hex');
    const protectedPath = join(protectedRoot, 'dummy-auth');
    const authPath = join(home, 'codex', 'auth.json');
    await writeFile(protectedPath, canary, { mode: 0o600 });
    await writeFile(join(workspace, 'allowed'), 'allowed fixture data\n');
    await symlink(protectedPath, join(workspace, 'protected-link'));
    const version = spawnSync(bin, ['--version'], { env: selectedEnvironment(home), encoding: 'utf8', timeout: REQUEST_MS });
    report.observedVersion = version.status === 0 ? version.stdout.trim() : 'unavailable';
    if (!await nativeExecutable(bin)) { report.status = 'native_executable_required'; return report; }
    report.nativeExecutableSha256 = await digest(bin);
    if (report.observedVersion !== VERSION) { report.status = 'version_mismatch'; return report; }
    const verifiedElf = await realpath(bin);
    if (!matchesNativeAttestation(verifiedElf, report.nativeExecutableSha256)) {
      report.status = 'native_executable_mismatch'; return report;
    }
    await writeFile(join(home, 'codex', 'config.toml'), profileToml(workspace, verifiedElf), { mode: 0o600 });
    report.policy = { kind: 'named_permission_profile', id: PROFILE, sandboxPolicy: 'absent' };
    host = native(bin, workspace, selectedEnvironment(home));
    report.nativePid = host.child.pid ?? null;
    if (host.child.pid) {
      try {
        report.hostExecutable = await realpath(await readlink(`/proc/${host.child.pid}/exe`));
        if (report.hostExecutable !== verifiedElf) { report.status = 'native_executable_mismatch'; return report; }
      } catch { report.status = 'native_executable_unverified'; return report; }
    }
    const initialized = await host.request('initialize', { clientInfo: { name: 'passeur_codex_boundary_fixture', version: '1' }, capabilities: { experimentalApi: true } });
    report.probes.push({ name: 'initialize', reply: safeReply(initialized) });
    if (initialized.error || !initialized.result) { report.status = 'native_initialize_unsupported'; return report; }
    host.notify('initialized');
    const config = await host.request('config/read', { includeLayers: false, cwd: workspace });
    const effective = effectiveConfig(config.result);
    report.probes.push({ name: 'effective_config_read', effective, reply: safeReply(config) });
    if (config.error || !effective.valid) { report.status = 'effective_config_unsupported'; return report; }
    const profiles = await host.request('permissionProfile/list', { cwd: workspace });
    const availability = profileAvailability(profiles.result);
    report.probes.push({ name: 'permission_profile_list', availability, reply: safeReply(profiles) });
    if (profiles.error || availability !== 'allowed') { report.status = `permission_profile_${availability}`; return report; }
    // Place a synthetic auth-named file only after startup/config preflight, avoiding a login parser confound.
    await writeFile(authPath, canary, { mode: 0o600 });
    // command/exec is the documented sandboxed native command surface. No turn or provider request is submitted.
    const allowed = await host.request('command/exec', commandRequest(['/usr/bin/cat', join(workspace, 'allowed')], workspace));
    report.probes.push({ name: 'allowed_read', reply: safeReply(allowed) });
    if (allowed.error || allowed.result?.exitCode !== 0 || allowed.result?.stdout !== 'allowed fixture data\n') {
      report.probes.at(-1).failure = await retainPositiveStderr(allowed, root) ?? positiveCommandFailure(allowed);
      report.status = 'named_profile_command_unsupported'; return report;
    }
    for (const [name, kind, path, target] of [
      ['direct_protected_read', 'direct', protectedPath, protectedPath],
      ['symlink_protected_read', 'symlink', join(workspace, 'protected-link'), protectedPath],
      ['proc_protected_read', 'proc', `/proc/self/root${protectedPath}`, protectedPath],
      ['codex_home_dummy_auth_read', 'codex_home', authPath, authPath],
    ]) {
      const before = await hostCanaryCheck(kind, path, target, canary);
      if (!before) { report.probes.push({ name, provenance: kind, hostBefore: false }); report.status = `${name}_host_canary_unverified`; return report; }
      const reply = await host.request('command/exec', commandRequest(['/usr/bin/cat', path], workspace));
      const after = await hostCanaryCheck(kind, path, target, canary);
      const observation = classifyRead(reply, canary, { positive: true, before, after, path });
      report.probes.push({ name, provenance: kind, hostBefore: before, hostAfter: after, observation, reply: safeReply(reply) });
      if (!after || !['denied', 'hidden_denied'].includes(observation)) {
        report.status = `${name}_${observation}`;
        return report;
      }
    }
    // This command result cannot qualify the separately exposed native surfaces or a worker.
    report.status = 'standalone_command_policy_preliminary';
    return report;
  } catch (error) {
    report.status = 'fixture_error'; report.error = { code: typeof error?.code === 'string' ? error.code : 'UNKNOWN', stage: 'no_account_observation' };
    return report;
  } finally {
    if (host) hostExited = await stop(host);
    report.hostExitObserved = hostExited;
    // Preserve even failed/unsupported synthetic roots until a separate resource audit.
    report.rootDisposition = 'retained_for_review';
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2];
  if (!arg || !arg.startsWith('--codex-bin=')) {
    process.stderr.write('usage: node scripts/qualify-codex-protected-boundary.mjs --codex-bin=/absolute/path/to/codex\n');
    process.exitCode = 2;
  } else {
    const bin = arg.slice('--codex-bin='.length);
    if (!bin.startsWith('/')) { process.stderr.write('codex binary must be an absolute path\n'); process.exitCode = 2; }
    else {
      const report = await run(bin);
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      process.exitCode = report.status === 'standalone_command_policy_preliminary' ? 0 : 1;
    }
  }
}
