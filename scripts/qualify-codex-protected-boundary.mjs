#!/usr/bin/env node
// Installed, no-account diagnostic. A command denial is only a preliminary boundary observation.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, open, readlink, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = 'codex-cli 0.157.1';
const REQUEST_MS = 10_000;
const MAX_LINE = 1_048_576;

export function selectedEnvironment(home) {
  return { HOME: home, CODEX_HOME: join(home, 'codex'), PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', RUST_LOG: 'off' };
}

export function commandPolicy(workspace, readableRoots) {
  return { type: 'workspaceWrite', writableRoots: [workspace], networkAccess: false,
    readOnlyAccess: { type: 'restricted', includePlatformDefaults: true, readableRoots } };
}

export function safeReply(reply) {
  const output = reply?.result;
  if (reply?.error) return { id: reply.id, kind: 'error', code: Number.isSafeInteger(reply.error.code) ? reply.error.code : null };
  return { id: reply?.id, kind: 'result', exitCode: Number.isSafeInteger(output?.exitCode) ? output.exitCode : null,
    stdoutBytes: Buffer.byteLength(typeof output?.stdout === 'string' ? output.stdout : ''),
    stderrBytes: Buffer.byteLength(typeof output?.stderr === 'string' ? output.stderr : '') };
}

export function classifyRead(reply, canary) {
  if (reply?.error) return 'unsupported';
  const result = reply?.result;
  if (!result || typeof result.stdout !== 'string' || typeof result.stderr !== 'string' || !Number.isSafeInteger(result.exitCode)) return 'inconclusive';
  if (result.stdout.includes(canary) || result.stderr.includes(canary)) return 'exposed';
  if (result.exitCode !== 0 && /permission denied|operation not permitted|access denied/i.test(result.stderr)) return 'denied';
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
  const workspace = config?.sandbox_workspace_write;
  const selector = permissionSelector(config?.default_permissions);
  const legacySelector = permissionSelector(config?.permission_profile);
  const camelSelector = permissionSelector(config?.permissionProfile);
  const observation = {
    appsDisabled: features?.apps === false, pluginsDisabled: features?.plugins === false,
    multiAgentDisabled: features?.multi_agent === false, webDisabled: config?.web_search === 'disabled',
    mcpEmpty: config?.mcp_servers && typeof config.mcp_servers === 'object' && !Array.isArray(config.mcp_servers) && Object.keys(config.mcp_servers).length === 0,
    slashTmpExcluded: workspace?.exclude_slash_tmp === true,
    tmpdirExcluded: workspace?.exclude_tmpdir_env_var === true,
    permissionSelector: selector,
    profileAbsent: ['absent', 'null'].includes(selector) && ['absent', 'null'].includes(legacySelector) && ['absent', 'null'].includes(camelSelector),
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
    '-c', 'features.multi_agent=false', '-c', 'web_search="disabled"',
    '-c', 'sandbox_workspace_write.exclude_slash_tmp=true',
    '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true', 'app-server'],
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
    status: 'not_started', probes: [], hostExitObserved: false, descendantStop: 'unverified',
    unqualifiedModelSurfaces: ['model_turn_file_tools', 'model_turn_command_tools'],
    excludedClientRpcs: ['fs/readFile', 'thread/shellCommand', 'process/spawn'] };
  try {
    await Promise.all([mkdir(join(home, 'codex'), { recursive: true, mode: 0o700 }), mkdir(workspace), mkdir(protectedRoot)]);
    await chmod(home, 0o700); await chmod(protectedRoot, 0o700);
    const canary = randomBytes(24).toString('hex');
    const protectedPath = join(protectedRoot, 'dummy-auth');
    await writeFile(protectedPath, canary, { mode: 0o600 });
    await writeFile(join(workspace, 'allowed'), 'allowed fixture data\n');
    await symlink(protectedPath, join(workspace, 'protected-link'));
    const version = spawnSync(bin, ['--version'], { env: selectedEnvironment(home), encoding: 'utf8', timeout: REQUEST_MS });
    report.observedVersion = version.status === 0 ? version.stdout.trim() : 'unavailable';
    if (!await nativeExecutable(bin)) { report.status = 'native_executable_required'; return report; }
    report.nativeExecutableSha256 = await digest(bin);
    if (report.observedVersion !== VERSION) { report.status = 'version_mismatch'; return report; }
    const policy = commandPolicy(workspace, [workspace, '/usr', '/bin', '/lib', '/lib64']);
    report.policy = policy;
    host = native(bin, workspace, selectedEnvironment(home));
    report.nativePid = host.child.pid ?? null;
    if (host.child.pid) {
      try {
        report.hostExecutable = await realpath(await readlink(`/proc/${host.child.pid}/exe`));
        if (report.hostExecutable !== await realpath(bin)) { report.status = 'native_executable_mismatch'; return report; }
      } catch { report.status = 'native_executable_unverified'; return report; }
    }
    const initialized = await host.request('initialize', { clientInfo: { name: 'passeur_codex_boundary_fixture', version: '1' }, capabilities: { experimentalApi: false } });
    report.probes.push({ name: 'initialize', reply: safeReply(initialized) });
    if (initialized.error || !initialized.result) { report.status = 'native_initialize_unsupported'; return report; }
    host.notify('initialized');
    const config = await host.request('config/read', { includeLayers: false, cwd: workspace });
    const effective = effectiveConfig(config.result);
    report.probes.push({ name: 'effective_config_read', effective, reply: safeReply(config) });
    if (config.error || !effective.valid) { report.status = 'effective_config_unsupported'; return report; }
    // command/exec is the documented sandboxed native command surface. No turn or provider request is submitted.
    const allowed = await host.request('command/exec', { command: ['/usr/bin/cat', join(workspace, 'allowed')], cwd: workspace, sandboxPolicy: policy, timeoutMs: REQUEST_MS });
    report.probes.push({ name: 'allowed_read', reply: safeReply(allowed) });
    if (allowed.error || allowed.result?.exitCode !== 0 || allowed.result?.stdout !== 'allowed fixture data\n') {
      report.status = 'restricted_policy_unsupported'; return report;
    }
    for (const [name, path] of [
      ['direct_protected_read', protectedPath], ['symlink_protected_read', join(workspace, 'protected-link')],
      ['proc_protected_read', `/proc/self/root${protectedPath}`],
    ]) {
      const reply = await host.request('command/exec', { command: ['/usr/bin/cat', path], cwd: workspace, sandboxPolicy: policy, timeoutMs: REQUEST_MS });
      const observation = classifyRead(reply, canary);
      report.probes.push({ name, observation, reply: safeReply(reply) });
      if (observation !== 'denied') {
        report.status = observation === 'exposed' ? `${name}_exposed_or_implicit_temp_root` : `${name}_${observation}`;
        return report;
      }
    }
    // This command result cannot qualify the separately exposed native surfaces or a worker.
    report.status = 'whole_worker_unsupported_unchecked_surfaces';
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
      process.exitCode = report.status === 'whole_worker_unsupported_unchecked_surfaces' ? 0 : 1;
    }
  }
}
