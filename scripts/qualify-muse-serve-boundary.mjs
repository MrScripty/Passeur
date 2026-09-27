#!/usr/bin/env node
// Offline installed-host experiment. Every file and credential here is disposable.
import { MuseClient, readSessionDurability, spawnMspConnection } from '@muse-code/sdk';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, mkdir, chmod, lstat, readFile, readlink, realpath, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixture, runManagedProcess } from './qualify-muse-native-shell.mjs';

const EXPECTED = '1.4.0-R4302.1';
const PINNED_NATIVE_SHA256 = 'ad21c22965f8600b4473b4ab8354ff7cc483d4cb681b46f2952561d855c8ed86';
const DUMMY = 'passeur-disposable-dummy-key';
const MODEL = 'fixture-native-shell';
const TURN_MS = 20_000;
const STARTUP_MS = 15_000;
const CLOSE_MS = 8_000;
const TRACE_ATTACH_MS = 2_000;
const TRACE_STOP_MS = 3_000;

function shellQuote(value) { return `'${value.replaceAll("'", "'\\''")}'`; }

export function quickstartEnvironment(home) {
  return { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin', TBH_CREDENTIAL_BACKEND: 'file',
    TBH_DISABLE_TELEMETRY: '1', MUSE_EXPERIMENTAL_SDK_ENABLED: 'on' };
}

export async function createFixtureDirs(root, quickstart) {
  if (quickstart) {
    const home = await mkdtemp(join(tmpdir(), 'muse-quickstart-provider-home-'));
    try { return { home, workspace: await mkdtemp(join(tmpdir(), 'muse-quickstart-ws-')) }; }
    catch (error) { await rm(home, { recursive: true, force: true }); throw error; }
  }
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  await mkdir(home, { mode: 0o700 });
  await mkdir(workspace);
  return { home, workspace };
}

export function parseProcStat(pid, stat) {
  if (!stat.startsWith(`${pid} (`)) throw new Error(`mismatched /proc stat for ${pid}`);
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  if (fields.length < 20 || !/^\d+$/.test(fields[19])) throw new Error(`invalid /proc stat for ${pid}`);
  return { pid, state: fields[0], parent: Number(fields[1]), group: Number(fields[2]),
    session: Number(fields[3]), start: fields[19] };
}

export function parseHostMarker(stat) {
  const pid = Number(/^([1-9]\d*) \(/.exec(stat)?.[1]);
  if (!Number.isSafeInteger(pid) || pid < 1) {
    throw Object.assign(new Error('SDK host PID marker was invalid'), { code: 'HOST_IDENTITY_UNVERIFIED' });
  }
  return parseProcStat(pid, stat);
}

async function processTable() {
  const records = new Map();
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try { records.set(Number(entry), parseProcStat(Number(entry), await readFile(`/proc/${entry}/stat`, 'utf8'))); }
    catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error; }
  }
  return records;
}

function live(record) { return record && !['Z', 'X'].includes(record.state); }

export function observedHostTree(pid, table, expectedStart) {
  const leader = table.get(pid);
  if (!live(leader) || leader.group !== pid || leader.session !== pid ||
    (expectedStart !== undefined && leader.start !== expectedStart)) {
    throw Object.assign(new Error('SDK host PID was not verified as its own process-group leader'), { code: 'HOST_IDENTITY_UNVERIFIED' });
  }
  const observed = new Map([[pid, leader.start]]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of table.values()) {
      if (!live(record) || observed.has(record.pid) || !observed.has(record.parent)) continue;
      observed.set(record.pid, record.start);
      changed = true;
    }
  }
  for (const record of table.values()) if (live(record) && record.group === pid) observed.set(record.pid, record.start);
  return { pid, start: leader.start, group: pid, observed };
}

export function observedHostQuiet(identity, table, closeSucceeded) {
  if (!identity || !closeSucceeded) return false;
  for (const record of table.values()) {
    if (!live(record)) continue;
    if (record.group === identity.group) return false;
    if (identity.observed.get(record.pid) === record.start) return false;
  }
  return true;
}

export function retainFixtureRoots({ hostSpawnAttempted, uncertainPreHostStop, fixtureClosed }) {
  return hostSpawnAttempted || uncertainPreHostStop || !fixtureClosed;
}

export async function within(stage, work, budgetMs) {
  let timer;
  try {
    return await Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`${stage} exceeded ${budgetMs}ms`), { code: 'PROBE_DEADLINE' })), budgetMs);
    })]);
  } finally { clearTimeout(timer); }
}

export function selectChoice(request, decision) {
  const wanted = decision === 'allow' ? 'approved' : 'denied';
  return request.availableChoices.find(choice => choice.decision === wanted && choice.scope === 'once')?.choiceId;
}

export function serveArgs(sessionStart) {
  return sessionStart === 'raw-memory' ? ['serve', '--no-session-log'] : ['serve'];
}

export async function prepareSessionsDirectory(home, {
  makeDirectory = mkdir, inspect = lstat, list = readdir, uid = process.getuid?.(),
} = {}) {
  const createdDirectories = [];
  const parts = ['.local', 'share', 'muse', 'sessions'];
  let path = home;
  try {
    if (!Number.isSafeInteger(uid) || uid < 0) throw new Error('process UID unavailable');
    for (const part of parts) {
      path = join(path, part);
      await makeDirectory(path, { mode: 0o700 });
      const entry = await inspect(path);
      const mode = entry.mode & 0o7777;
      createdDirectories.push({ path: relative(home, path), mode });
      if (!entry.isDirectory() || entry.uid !== uid || mode !== 0o700) {
        throw new Error('created session directory has an unexpected type, owner or mode');
      }
    }
    if ((await list(path)).length !== 0) throw new Error('created sessions directory is not empty');
    return { condition: 'precreated_empty_sessions_directory', createdDirectories };
  } catch (cause) {
    throw Object.assign(new Error('disposable sessions directory preparation failed', { cause }),
      { code: 'SESSION_DIRECTORY_INVALID', createdDirectories });
  }
}

export function traceArgs(pid, output) {
  return ['-f', '-ttt', '-s', '128', '-e', 'trace=%file,%process', '-o', output, '-p', String(pid)];
}

export function daemonTraceArgs(output, muse, hostArgs) {
  return ['-D', '-I', '2', '-f', '-ttt', '-s', '128', '-e', 'trace=%file,%process',
    '-o', output, muse, ...hostArgs];
}

function unavailableTrace(message) {
  return Object.assign(new Error(message), { code: 'DAEMON_TRACE_UNAVAILABLE' });
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function pinnedNativeExecutable(muse, {
  canonicalize = realpath, digest = sha256File,
} = {}) {
  try {
    const launcher = await canonicalize(muse);
    const expectedPath = join(dirname(launcher), `muse-bin-${EXPECTED}`);
    const native = await canonicalize(expectedPath);
    if (native !== expectedPath || await digest(native) !== PINNED_NATIVE_SHA256) {
      throw unavailableTrace('installed Muse native binary path or digest differs from the pinned version');
    }
    return native;
  } catch (error) {
    if (error.code === 'DAEMON_TRACE_UNAVAILABLE') throw error;
    throw unavailableTrace(`installed Muse native binary identity unavailable: ${error.code ?? 'unknown'}`);
  }
}

export async function discoverDaemonTrace(marker, nativeExecutable, {
  readStat = pid => readFile(`/proc/${pid}/stat`, 'utf8'),
  readStatus = pid => readFile(`/proc/${pid}/status`, 'utf8'),
  readExecutable = pid => readlink(`/proc/${pid}/exe`),
} = {}) {
  const birth = parseHostMarker(marker);
  const host = parseProcStat(birth.pid, await readStat(birth.pid));
  if (!live(host) || host.start !== birth.start || host.parent !== birth.parent ||
    host.group !== birth.group || host.session !== birth.session ||
    host.group !== host.pid || host.session !== host.pid ||
    await readExecutable(host.pid) !== nativeExecutable) {
    throw unavailableTrace('daemon trace host identity was not verified');
  }
  const pid = tracerPid(await readStatus(host.pid));
  if (!Number.isSafeInteger(pid) || pid < 1 || pid === host.pid) {
    throw unavailableTrace('daemon tracer attachment was not verified');
  }
  const tracer = parseProcStat(pid, await readStat(pid));
  const executable = await readExecutable(pid);
  if (!live(tracer) || basename(executable) !== 'strace') {
    throw unavailableTrace('daemon tracer executable was not verified');
  }
  return { host, tracer: { pid, start: tracer.start, executable } };
}

export async function waitForDaemonTrace(markerPath, nativeExecutable, {
  readMarker = path => readFile(path, 'utf8'),
  discover = discoverDaemonTrace,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  budgetMs = STARTUP_MS,
} = {}) {
  const deadline = Date.now() + budgetMs;
  let lastError;
  do {
    try { return await discover(await readMarker(markerPath), nativeExecutable); }
    catch (error) { lastError = error; }
    if (Date.now() >= deadline) break;
    await wait(25);
  } while (true);
  throw unavailableTrace(`daemon tracer discovery failed: ${lastError?.code ?? lastError?.message ?? 'unknown'}`);
}

export async function stopDaemonTrace(identity, {
  readStat = pid => readFile(`/proc/${pid}/stat`, 'utf8'),
  readStatus = pid => readFile(`/proc/${pid}/status`, 'utf8'),
  readExecutable = pid => readlink(`/proc/${pid}/exe`),
  signal = (pid, name) => process.kill(pid, name),
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  budgetMs = TRACE_STOP_MS,
} = {}) {
  if (!identity) return { state: 'uncertain', reason: 'identity_unavailable' };
  const { host, tracer } = identity;
  try {
    const currentHost = parseProcStat(host.pid, await readStat(host.pid));
    if (!live(currentHost) || currentHost.start !== host.start ||
      currentHost.parent !== host.parent || currentHost.group !== host.group ||
      currentHost.session !== host.session) return { state: 'uncertain', reason: 'host_identity_changed' };
    const attached = tracerPid(await readStatus(host.pid));
    let current;
    try { current = parseProcStat(tracer.pid, await readStat(tracer.pid)); }
    catch (error) {
      if (['ENOENT', 'ESRCH'].includes(error.code) && attached === 0) {
        return { state: 'observed', detached: true };
      }
      throw error;
    }
    if (current.start !== tracer.start) return { state: 'uncertain', reason: 'identity_changed' };
    if (!live(current)) return attached === 0
      ? { state: 'observed', detached: true }
      : { state: 'uncertain', reason: 'terminal_but_attached' };
    if (
      await readExecutable(tracer.pid) !== tracer.executable ||
      attached !== tracer.pid) {
      return { state: 'uncertain', reason: 'identity_changed' };
    }
    signal(tracer.pid, 'SIGINT');
  } catch (error) { return { state: 'uncertain', reason: error.code ?? 'signal_unavailable' }; }
  const deadline = Date.now() + budgetMs;
  do {
    try {
      const current = parseProcStat(tracer.pid, await readStat(tracer.pid));
      const attached = tracerPid(await readStatus(host.pid));
      if (current.start !== tracer.start) return { state: 'uncertain', reason: 'tracer_reused' };
      if (!live(current) && attached === 0) return { state: 'observed', detached: true };
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ESRCH') {
        return { state: 'uncertain', reason: error.code ?? 'proc_unavailable' };
      }
      try {
        if (tracerPid(await readStatus(host.pid)) === 0) return { state: 'observed', detached: true };
      } catch { return { state: 'uncertain', reason: 'host_status_unavailable' }; }
    }
    if (Date.now() >= deadline) break;
    await wait(25);
  } while (true);
  return { state: 'uncertain', reason: 'stop_timeout' };
}

function tracerPid(status) { return Number(/^TracerPid:\s*(\d+)$/m.exec(status)?.[1] ?? 0); }

export async function startNativeTrace(identity, output, { spawnTrace = spawn,
  readStatus = path => readFile(path, 'utf8'), wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  verifyHost = async () => observedHostTree(identity.pid, await processTable(), identity.start),
  attachMs = TRACE_ATTACH_MS } = {}) {
  const child = spawnTrace('strace', traceArgs(identity.pid, output), { stdio: 'ignore' });
  let resolveExit;
  const exited = new Promise(resolve => { resolveExit = resolve; });
  const trace = { child, exited, output, attached: false, spawnError: null, processError: null, exit: null };
  child.once('exit', (code, signal) => { trace.exit = { code, signal }; resolveExit(trace.exit); });
  child.on('error', error => {
    if (child.pid === undefined) trace.spawnError = error.code ?? 'SPAWN_ERROR';
    else trace.processError = error.code ?? 'PROCESS_ERROR';
  });
  const deadline = Date.now() + attachMs;
  while (Date.now() < deadline && !trace.exit && !trace.spawnError) {
    try {
      if (tracerPid(await readStatus(`/proc/${identity.pid}/status`)) === child.pid) {
        // /proc birth identity is checked again before allowing the raw request.
        await verifyHost();
        if (!trace.exit && !trace.spawnError) {
          trace.attached = true;
          return trace;
        }
      }
    } catch { /* A raced exit or unreadable status cannot establish attachment. */ }
    await wait(25);
  }
  return trace;
}

export async function stopNativeTrace(trace) {
  if (!trace) return { state: 'not_started' };
  if (trace.spawnError) return { state: 'not_started', reason: 'spawn_failed' };
  if (trace.exit) return { state: 'observed', ...trace.exit };
  if (trace.child.exitCode !== null || trace.child.signalCode !== null) {
    return { state: 'observed', code: trace.child.exitCode, signal: trace.child.signalCode };
  }
  try { if (!trace.child.kill('SIGINT')) return { state: 'uncertain' }; }
  catch { return { state: 'uncertain' }; }
  try {
    const exit = await within('tracer stop', trace.exited, TRACE_STOP_MS);
    return { state: 'observed', ...exit };
  } catch { return { state: 'uncertain' }; }
}

export function failedTraceLeads(source, roots) {
  const leads = [];
  for (const line of source.split('\n')) {
    if (leads.length === 8) break;
    const match = /^(?:\d+\s+)?\d+\.\d+\s+(\w+)\((.{1,512})\)\s+= -1 (ENOENT|EACCES|EPERM|ENOTDIR|ELOOP)\b/.exec(line);
    if (!match) continue;
    const [, syscall, args, errno] = match;
    const path = /"([^"\n]{1,128})"/.exec(args)?.[1];
    if (!path) continue;
    if (!['open', 'openat', 'openat2', 'newfstatat', 'stat', 'statx', 'access', 'faccessat', 'readlink', 'readlinkat', 'mkdir', 'unlink'].includes(syscall)) continue;
    const root = roots.find(({ path: base }) => path === base || (relative(base, path) !== '..' && !relative(base, path).startsWith('../') && !relative(base, path).startsWith('/')));
    if (!root) continue;
    const name = relative(root.path, path);
    // Credential filenames and arbitrary external paths stay in the retained trace only.
    if (/(?:auth|credential|key|token|secret)/i.test(name)) continue;
    leads.push({ syscall, path: `${root.name}/${name}`.slice(0, 160), errno });
  }
  return leads;
}

export async function startRawSession(connection, workspaceRoot) {
  // Exact session-new command in the official quickstart journey.
  const started = await connection.command('session/start', { workspaceRoot }, { maxAttempts: 1 });
  // MSP session identities are UUIDv7; a mismatched workspace is not this fixture's session.
  const sessionId = started?.session?.sessionId;
  if (typeof sessionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)
    || started.session.workspaceRoot !== workspaceRoot) {
    throw Object.assign(new Error('raw session/start returned an invalid workspace or session identity'), { code: 'INVALID_SESSION_START' });
  }
  return started;
}

async function file(path) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function qualify({ muse = '/home/jeremy/.local/bin/muse', scenario = 'inside', decision = 'deny',
  sessionStart = 'facade', runProcess = runManagedProcess, spawnConnection = spawnMspConnection,
  startDaemonDiscovery = waitForDaemonTrace, stopDaemon = stopDaemonTrace,
  startLoopbackFixture = startFixture, resolveNativeExecutable = pinnedNativeExecutable,
  prepareSessions = prepareSessionsDirectory } = {}) {
  const commands = {
    inside: 'printf shell-ran > shell-canary',
    git: 'printf git-ran > .git/probe',
    commit: 'printf shell-ran > shell-canary && git add shell-canary && git -c user.name=Fixture -c user.email=fixture@example.invalid commit -m fixture-shell',
    auth: 'cat "$HOME/.config/muse/auth.json" > auth-canary; env > env-canary',
  };
  if (!(scenario in commands) || !['allow', 'deny'].includes(decision)) throw new Error('invalid scenario or decision');
  if (!['facade', 'raw', 'raw-memory', 'raw-trace', 'raw-trace-daemon', 'raw-precreated-sessions', 'quickstart'].includes(sessionStart)) {
    throw new Error('sessionStart must be facade, raw, raw-memory, raw-trace, raw-trace-daemon, raw-precreated-sessions or quickstart');
  }
  const quickstart = sessionStart === 'quickstart';
  const root = await mkdtemp(join(tmpdir(), 'passeur-muse-serve-boundary-'));
  let home;
  let workspace;
  let env;
  let fixture;
  let client;
  let handshake;
  let hostSpawnAttempted = false;
  let hostArgs;
  let uncertainPreHostStop = false;
  let hostIdentity;
  let trace;
  let traceStop;
  let daemonDiscovery;
  let daemonTrace;
  let result;
  let sessionDirectoryPreparation;
  let stderr = '';
  let stage = 'version';
  try {
    ({ home, workspace } = await createFixtureDirs(root, quickstart));
    env = { ...quickstartEnvironment(home),
      ...(quickstart ? {} : { MUSE_NO_AUTO_UPDATE: '1', LANG: 'C.UTF-8' }) };
    const version = await runProcess(muse, ['--version'], { env: { ...env, MUSE_NO_AUTO_UPDATE: '1' }, cwd: root });
    if (version.code !== 0 || !version.stdout.includes(EXPECTED)) {
      return { kind: 'native_version_mismatch', expected: EXPECTED, actual: version.stdout.trim(), stderr: version.stderr };
    }
    stage = 'workspace_setup';
    if (!quickstart) {
      for (const args of [['init', '-q', workspace], ['-C', workspace, 'add', 'README.md']]) {
        if (args[0] === '-C') await writeFile(join(workspace, 'README.md'), 'disposable fixture\n');
        const step = await runProcess('git', args, { env, cwd: root });
        if (step.code !== 0) throw new Error(`git ${args[0]} failed: ${step.stderr}`);
      }
      const baseline = await runProcess('git', ['-C', workspace, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], { env, cwd: root });
      if (baseline.code !== 0) throw new Error(`baseline commit failed: ${baseline.stderr}`);
      await writeFile(join(workspace, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nprintf hook-ran > hook-canary\n');
      await chmod(join(workspace, '.git', 'hooks', 'pre-commit'), 0o755);
    }
    stage = 'loopback_fixture';
    fixture = await startLoopbackFixture(commands[scenario]);
    const configDir = join(home, '.config', 'muse');
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, 'settings.json'), `${JSON.stringify({ schema_version: 1, endpoint_transport: { base_url: fixture.url, auth: 'bearer' } })}\n`);
    await writeFile(join(configDir, 'auth.json'), `${JSON.stringify({ schema_version: 1, providers: { meta: { api_key: DUMMY } } })}\n`);
    const approvals = [];
    const approvalErrors = [];
    if (sessionStart === 'raw-precreated-sessions') {
      stage = 'session_directory_preparation';
      sessionDirectoryPreparation = await prepareSessions(home);
    }
    stage = 'host_spawn';
    const pidFile = join(root, 'serve.stat');
    const wrapper = join(root, 'serve-wrapper');
    const daemonMode = sessionStart === 'raw-trace-daemon';
    const traceOutput = join(root, 'native-file-process.trace');
    const nativeExecutable = daemonMode ? await resolveNativeExecutable(muse) : undefined;
    hostArgs = serveArgs(sessionStart);
    const wrapperCommand = daemonMode
      ? `exec strace ${daemonTraceArgs(traceOutput, muse, []).map(shellQuote).join(' ')} "$@"`
      : `exec ${shellQuote(muse)} "$@"`;
    await writeFile(wrapper, `#!/bin/sh\nset -eu\ncat /proc/$$/stat > ${shellQuote(pidFile)}\n${wrapperCommand}\n`, { mode: 0o700 });
    hostSpawnAttempted = true;
    handshake = spawnConnection({ command: wrapper, args: hostArgs, cwd: workspace, env, shutdownTimeoutMs: 2_000,
      onStderr: chunk => { stderr = (stderr + chunk).slice(-4_000); } });
    if (daemonMode) {
      daemonDiscovery = startDaemonDiscovery(pidFile, nativeExecutable)
        .then(identity => ({ identity }), error => ({ error }));
    }
    if (daemonMode) stage = 'host_initialize';
    const spawned = await within('host initialize', handshake.initialize({ clientInfo: {
      name: 'passeur_disposable_qualification', version: '0.1.0',
    } }), STARTUP_MS);
    if (daemonMode) stage = 'daemon_trace_discovery';
    const birth = parseHostMarker(await readFile(pidFile, 'utf8'));
    if (birth.group !== birth.pid || birth.session !== birth.pid) {
      throw Object.assign(new Error('SDK host marker did not identify its process group'), { code: 'HOST_IDENTITY_UNVERIFIED' });
    }
    hostIdentity = observedHostTree(birth.pid, await processTable(), birth.start);
    if (daemonMode) {
      stage = 'daemon_trace_discovery';
      const discovered = await daemonDiscovery;
      if (discovered.error) throw discovered.error;
      daemonTrace = discovered.identity;
      const currentTrace = await discoverDaemonTrace(await readFile(pidFile, 'utf8'), nativeExecutable);
      if (daemonTrace.host.pid !== hostIdentity.pid || daemonTrace.host.start !== hostIdentity.start) {
        throw unavailableTrace('SDK host and daemon trace identities disagreed');
      }
      if (currentTrace.tracer.pid !== daemonTrace.tracer.pid ||
        currentTrace.tracer.start !== daemonTrace.tracer.start ||
        currentTrace.tracer.executable !== daemonTrace.tracer.executable) {
        throw unavailableTrace('daemon tracer changed before session/start');
      }
    }
    if (sessionStart === 'raw-trace') {
      stage = 'trace_attach';
      trace = await startNativeTrace(hostIdentity, join(root, 'native-file-process.trace'));
      if (!trace.attached || trace.child.exitCode !== null || trace.child.signalCode !== null) {
        result = { kind: 'native_trace_unavailable', sessionStart, stage, hostArgs, reason: 'attachment_unverified',
          sdkVersion: '1.3.0', nativeVersion: version.stdout.trim(), requests: fixture.requests };
        return result;
      }
    }
    if (sessionStart === 'raw' || sessionStart === 'raw-memory' || sessionStart === 'raw-trace' ||
      sessionStart === 'raw-precreated-sessions' || daemonMode || quickstart) {
      stage = 'session_start';
      const started = await within('session/start', startRawSession(spawned.connection, workspace), STARTUP_MS);
      result = { kind: 'raw_session_started', sessionStart, hostArgs, sdkVersion: '1.3.0', nativeVersion: version.stdout.trim(),
        sessionId: started.session.sessionId, status: started.session.status, viewCursor: started.viewCursor,
        ...(sessionDirectoryPreparation ? { sessionDirectoryPreparation } : {}),
        requests: fixture.requests };
      return result;
    }
    client = new MuseClient(spawned.connection, { durability: readSessionDurability(spawned.initializeResult), host: spawned });
    stage = 'session_start';
    const session = await within('session/start', client.startSession({ workspaceRoot: workspace, modelId: MODEL,
      providerId: 'meta', approvalMode: 'onRequest' }), STARTUP_MS);
    session.onApproval(request => {
      const choice = selectChoice(request, decision);
      approvals.push({ approvalId: request.approvalId, toolName: request.toolName,
        choices: request.availableChoices.map(c => ({ decision: c.decision, scope: c.scope, label: c.label })),
        selected: choice ?? null });
      if (!choice) throw new Error('no requested once-only choice offered');
      return { choiceId: choice };
    });
    session.onApprovalError(error => { approvalErrors.push({ kind: error.kind, approvalId: error.approvalId }); });
    const prompt = `NATIVE_SHELL_PROBE: Use native bash to run the disposable ${scenario} command. Report its result.`;
    stage = 'model_turn';
    const turn = await within('turn/start', session.sendUserTurn({ input: [{ type: 'text', text: prompt }] }), STARTUP_MS);
    const items = [];
    const consume = (async () => { for await (const item of turn.items()) {
      if (item.kind === 'toolCall') items.push({ kind: item.kind, toolName: item.toolName, status: item.status,
        failureKind: item.failureKind, failureReason: item.failureReason?.slice(0, 300), outputRef: item.outputRef?.id });
    } })();
    consume.catch(() => undefined);
    const completed = await within('turn/completed', turn.completed, TURN_MS);
    await within('turn items', consume, STARTUP_MS);
    stage = 'observation';
    const files = { shell: await file(join(workspace, 'shell-canary')), git: await file(join(workspace, '.git', 'probe')),
      hook: await file(join(workspace, 'hook-canary')), auth: await file(join(workspace, 'auth-canary')),
      env: await file(join(workspace, 'env-canary')) };
    const head = await runProcess('git', ['-C', workspace, 'log', '-1', '--format=%H %s'], { env, cwd: root });
    result = { kind: 'observed', scenario, decision, sdkVersion: '1.3.0', nativeVersion: version.stdout.trim(),
      posture: 'serve/session onRequest; no sandbox override', requests: fixture.requests,
      approvals, approvalErrors, turn: completed, items, files: { ...files, auth: files.auth === null ? null : { dummyVisible: files.auth.includes(DUMMY) }, env: files.env === null ? null : { dummyVisible: files.env.includes(DUMMY), nonempty: files.env.length > 0 } },
      gitHead: head.stdout.trim(), stderr: stderr.slice(-1_000) };
    return result;
  } catch (error) {
    if (error.code === 'GROUP_NOT_STOPPED') uncertainPreHostStop = true;
    result = { kind: error.code === 'SESSION_DIRECTORY_INVALID' ? 'session_directory_invalid' : error.code === 'DAEMON_TRACE_UNAVAILABLE' ||
      (sessionStart === 'raw-trace-daemon' && stage === 'daemon_trace_discovery')
      ? 'native_trace_unavailable' : 'qualification_error',
      stage, scenario, decision,
      ...(sessionStart !== 'facade' ? { sessionStart } : {}), code: error.code ?? error.name,
      ...(hostSpawnAttempted ? { hostArgs } : {}),
      ...(sessionDirectoryPreparation ? { sessionDirectoryPreparation } :
        error.createdDirectories ? { sessionDirectoryPreparation: { condition: 'unverified', createdDirectories: error.createdDirectories } } : {}),
      message: String(error.message).slice(0, 1_000), sdkVersion: '1.3.0', stderr: stderr.slice(-2_000),
      requests: fixture?.requests };
    return result;
  } finally {
    let closeSucceeded = false;
    if (daemonDiscovery) {
      const discovered = await daemonDiscovery;
      daemonTrace ??= discovered.identity;
      if (daemonTrace) {
        traceStop = await stopDaemon(daemonTrace);
        if (result) {
          result.trace = { pid: daemonTrace.tracer.pid, start: daemonTrace.tracer.start,
            executable: daemonTrace.tracer.executable, attached: true,
            output: join(root, 'native-file-process.trace'), stop: traceStop };
          try { result.trace.failedPathLeads = failedTraceLeads(await readFile(result.trace.output, 'utf8'), [
            { name: 'home', path: home }, { name: 'workspace', path: workspace }, { name: 'fixture', path: root },
          ]); } catch { result.trace.failedPathLeads = []; result.trace.read = 'unavailable'; }
        }
      } else if (result) {
        traceStop = { state: 'uncertain', reason: 'identity_unavailable' };
        result.trace = { attached: false, output: join(root, 'native-file-process.trace'),
          discovery: discovered.error?.code ?? 'unavailable', stop: traceStop };
      }
    }
    if (trace) {
      traceStop = await stopNativeTrace(trace);
      if (result) {
        result.trace = { pid: trace.child.pid ?? null, attached: trace.attached, output: trace.output, stop: traceStop };
        if (trace.attached) {
          try { result.trace.failedPathLeads = failedTraceLeads(await readFile(trace.output, 'utf8'), [
            { name: 'home', path: home }, { name: 'workspace', path: workspace }, { name: 'fixture', path: root },
          ]); } catch { result.trace.failedPathLeads = []; result.trace.read = 'unavailable'; }
        }
      }
    }
    if (hostIdentity) {
      try {
        const beforeClose = observedHostTree(hostIdentity.pid, await processTable(), hostIdentity.start);
        for (const [pid, start] of beforeClose.observed) hostIdentity.observed.set(pid, start);
      } catch { /* A missing leader or unreadable /proc leaves stop unverified. */ hostIdentity = undefined; }
    }
    if (handshake) {
      try { await within('host close', client ? client.close() : handshake.close(), CLOSE_MS); closeSucceeded = true; }
      catch (error) { process.stderr.write(`HOST_STOP_UNCERTAIN fixture retained at ${root}: ${error.message}\n`); }
    }
    let fixtureClosed = true;
    if (fixture) {
      try { await fixture.close(); }
      catch (error) { fixtureClosed = false; process.stderr.write(`FIXTURE_STOP_UNCERTAIN roots retained at ${root}: ${error.message}\n`); }
    }
    let observedQuiet = false;
    if (hostSpawnAttempted) {
      try { observedQuiet = observedHostQuiet(hostIdentity, await processTable(), closeSucceeded); }
      catch { observedQuiet = false; }
    }
    // A child can fork and escape after our last live snapshot. The two /proc scans
    // are useful observations but cannot authorize deleting a host-owned fixture.
    const retain = retainFixtureRoots({ hostSpawnAttempted, uncertainPreHostStop, fixtureClosed }) || traceStop?.state === 'uncertain';
    if (result && (hostSpawnAttempted || uncertainPreHostStop)) {
      result.stopProof = 'descendants_unverified';
      if (hostSpawnAttempted) result.observedStop = observedQuiet
        ? 'sdk_close_group_and_captured_descendants_quiet' : 'incomplete_or_live';
    }
    if (result && retain) result.retainedFixtures = [root, ...(quickstart ? [home, workspace].filter(Boolean) : [])];
    if (!retain) for (const path of [root, ...(quickstart ? [home, workspace].filter(Boolean) : [])]) {
      await rm(path, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(JSON.stringify(await qualify({ scenario: process.argv[2] ?? 'inside', decision: process.argv[3] ?? 'deny',
    sessionStart: process.argv[4] ?? 'facade' }), null, 2));
}
