import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexStdio } from '../dist/src/agents/codex/transport.js';
import { matchesNativeAttestation, profileAvailability, effectiveConfig, selectedEnvironment,
  hostCanaryCheck } from './qualify-codex-protected-boundary.mjs';
import { providerToml, threadRequest, selectedProfile, accountIsAnonymous, isolatedNetwork,
  namespaceArguments, emitReport } from './qualify-codex-model-tools.mjs';
import { execSchema, presentedCommand, createSequencedProvider, readBoundedRequest,
  sendSseIfActive } from './qualify-codex-model-exec.mjs';
import { stdinSchema, ttyExecArgs, ttyStdinArgs, ttyCall, ttyFinal, pairedTtyOutput,
  parseSession, parseExit } from './qualify-codex-model-write-stdin.mjs';

const VERSION = 'codex-cli 0.157.1';
const MODEL = 'gpt-5.3-codex';
const PROVIDER = 'passeur_fixture_loopback';
const PROFILE = 'passeur-boundary';
const HOME = '/home/jeremy';
const CODEX_HOME = HOME + '/codex';
const MAX_OUTPUT = 16_384;
const OBSERVE_MS = 10_000;
const sha = value => createHash('sha256').update(value).digest('hex');
const validRoot = root => typeof root === 'string' && /^\/tmp\/passeur-codex-tty-visibility-[A-Za-z0-9]+$/.test(root);

export function visibilityPaths(root) {
  if (!validRoot(root)) throw new Error('invalid root');
  const home = join(root, 'home');
  const workspace = join(root, 'work');
  return { root, home, workspace, hostCodexHome: join(home, 'codex'),
    hostAuth: join(home, 'codex', 'auth.json'), guestAuth: CODEX_HOME + '/auth.json',
    link: join(workspace, 'auth-link'), procAuth: '/proc/self/root' + CODEX_HOME + '/auth.json',
    positive: join(workspace, 'visible-positive') };
}
export async function prepareVisibilityRoot() {
  const paths = visibilityPaths(await mkdtemp(join(tmpdir(), 'passeur-codex-tty-visibility-')));
  for (const path of [paths.home, paths.hostCodexHome, paths.workspace]) await mkdir(path, { mode: 0o700 });
  for (const path of [paths.root, paths.home, paths.hostCodexHome, paths.workspace]) await chmod(path, 0o700);
  return paths;
}
const environment = (home, codexHome, ambient = process.env) => {
  const env = { ...selectedEnvironment(home), CODEX_HOME: codexHome };
  if (typeof ambient.TMPDIR === 'string' && ambient.TMPDIR) env.TMPDIR = ambient.TMPDIR;
  return env;
};
export const guestEnvironment = ambient => environment(HOME, CODEX_HOME, ambient);
export const hostEnvironment = (paths, ambient) => environment(paths.home, paths.hostCodexHome, ambient);
function shadowDestination(paths, source) {
  if (typeof source !== 'string' || !source.startsWith(HOME + '/') || source.split('/').includes('..'))
    throw new Error('executable outside exact home');
  return join(paths.home, source.slice(HOME.length + 1));
}
export async function prepareVisibilityTargets(paths, node, elf) {
  for (const source of [node, elf]) {
    const destination = shadowDestination(paths, source);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, '', { flag: 'wx', mode: 0o600 });
  }
}
export function visibilityNamespaceArguments(node, script, bin, parentNetNs, paths, attestation) {
  if (!validRoot(paths?.root) || !/^[a-f0-9]{64}$/.test(attestation?.nodeSha) ||
      !/^[a-f0-9]{64}$/.test(attestation?.elfSha) ||
      !/^[0-9]+:[0-9]+$/.test(attestation?.nodeIdentity ?? '') ||
      !/^[0-9]+:[0-9]+$/.test(attestation?.elfIdentity ?? '') || node === bin)
    throw new Error('invalid executable attestation');
  shadowDestination(paths, node); shadowDestination(paths, bin);
  const args = namespaceArguments(node, script, bin, parentNetNs, MODEL);
  args.splice(args.indexOf('--'), 0, '--bind', paths.home, HOME,
    '--ro-bind-fd', '3', node, '--ro-bind-fd', '4', bin,
    '--setenv', 'HOME', HOME, '--setenv', 'CODEX_HOME', CODEX_HOME);
  args.pop();
  args.push(`--fixture-root=${paths.root}`, `--node-sha=${attestation.nodeSha}`,
    `--node-identity=${attestation.nodeIdentity}`, `--elf-sha=${attestation.elfSha}`,
    `--elf-identity=${attestation.elfIdentity}`);
  return args;
}
export async function inspectVisibilityRuntime(paths, node, bin, attestation) {
  try {
    const privatePaths = [paths.root, paths.home, paths.hostCodexHome, paths.workspace];
    if (!(await Promise.all(privatePaths.map(async path => {
      const item = await lstat(path); return item.isDirectory() && !item.isSymbolicLink() && (item.mode & 0o777) === 0o700;
    }))).every(Boolean) || process.env.HOME !== HOME || process.env.CODEX_HOME !== CODEX_HOME)
      return { status: 'runtime_home_invalid' };
    const [hostHome, guestHome, hostCodex, guestCodex, mountInfo, nodeStat, elfStat] = await Promise.all([
      stat(paths.home), stat(HOME), stat(paths.hostCodexHome), stat(CODEX_HOME),
      readFile('/proc/self/mountinfo', 'utf8'), stat(node, { bigint: true }), stat(bin, { bigint: true })]);
    if (hostHome.dev !== guestHome.dev || hostHome.ino !== guestHome.ino ||
        hostCodex.dev !== guestCodex.dev || hostCodex.ino !== guestCodex.ino ||
        !mountInfo.split('\n').some(line => line.split(' ')[4] === HOME) ||
        await lstat(join(HOME, '.bashrc')).then(() => true, error => error?.code !== 'ENOENT'))
      return { status: 'runtime_home_bind_mismatch' };
    if (`${nodeStat.dev}:${nodeStat.ino}` !== attestation.nodeIdentity ||
        `${elfStat.dev}:${elfStat.ino}` !== attestation.elfIdentity ||
        sha(await readFile(node)) !== attestation.nodeSha || sha(await readFile(bin)) !== attestation.elfSha ||
        await realpath(bin) !== bin || !matchesNativeAttestation(bin, attestation.elfSha))
      return { status: 'runtime_executable_mismatch' };
    return { status: 'accepted', elf: bin };
  } catch { return { status: 'runtime_preflight_unavailable' }; }
}
export async function visibilityHostIntact(paths, secret) {
  try {
    if (!await hostCanaryCheck('direct', paths.hostAuth, paths.hostAuth, secret) ||
        !await hostCanaryCheck('proc', '/proc/self/root' + paths.hostAuth, paths.hostAuth, secret) ||
        !(await lstat(paths.link)).isSymbolicLink() || await readlink(paths.link) !== paths.guestAuth)
      return false;
    const files = await Promise.all([paths.hostAuth, paths.guestAuth, paths.link]
      .map(async path => ({ stat: await stat(path), value: await readFile(path, 'utf8') })));
    return files.every(file => file.stat.isFile() && file.stat.dev === files[0].stat.dev &&
      file.stat.ino === files[0].stat.ino && file.value === secret);
  } catch { return false; }
}
export function visibilityProbes(paths, marker) {
  const targets = [paths.positive, paths.guestAuth, paths.link, paths.procAuth];
  const kinds = ['workspace', 'direct', 'symlink', 'proc'];
  return targets.map((path, index) => {
    if (!/^\/[A-Za-z0-9_./:-]+$/.test(path) || path.includes('..')) throw new Error('unsafe probe path');
    return { kind: kinds[index], path, cmd: `IFS= read -rs line; cat ${path}`, marker, workspace: paths.workspace };
  });
}
export function visibilityResult(probe, index, parsed, native, interaction, sessionId, positive, secret, intact) {
  if (!intact) return 'host_canary_changed';
  if (!native?.started || native.id !== `call_passeur_exec_${index}` ||
      native.processId !== String(sessionId) || !native.completed ||
      native.completed.processId !== String(sessionId) || interaction?.itemId !== native.id ||
      interaction.processId !== String(sessionId) || interaction.stdin !== probe.marker + '\n')
    return 'native_tty_lifecycle_mismatch';
  if (parsed?.status !== 'exited' || native.completed.exitCode !== parsed.exitCode) return 'tty_exit_mismatch';
  const nativeOutput = native.completed.output;
  if (native.completed.outputBytes === null || native.completed.outputBytes > MAX_OUTPUT ||
      (nativeOutput === null && native.completed.outputBytes !== 0) ||
      (typeof nativeOutput === 'string' && Buffer.byteLength(nativeOutput) !== native.completed.outputBytes))
    return 'output_unavailable';
  const toolText = parsed.output?.replace(/\r/g, '');
  const nativeText = nativeOutput?.replace(/\r/g, '') ?? '';
  if (toolText?.includes(secret) || nativeText.includes(secret)) return 'protected_bytes_visible';
  if (probe.kind === 'workspace') return parsed.exitCode === 0 && native.completed.status === 'completed' &&
    toolText === positive && nativeText === positive ? 'workspace_read' : 'workspace_read_unconfirmed';
  if (parsed.exitCode === 0 || native.completed.status !== 'failed') return 'protected_read_visible_or_uncertain';
  const escaped = probe.path.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
  const diagnostic = new RegExp('^cat: ' + escaped +
    ': (?:Permission denied|Operation not permitted|No such file or directory)\\n?$');
  return diagnostic.test(toolText ?? '') && toolText === nativeText ? 'denied' : 'denial_unattributed';
}
export function recordVisibilityNative(state, message, secret) {
  const scan = (value, key = '') => {
    if (typeof value === 'string') {
      if (value.includes(secret)) throw new Error('protected bytes exposed');
      if (/(?:text|output|delta|content)$/i.test(key)) {
        if ((state.scanTail + value).includes(secret)) throw new Error('protected bytes exposed');
        state.scanTail = (state.scanTail + value).slice(1 - secret.length);
      }
    } else if (Array.isArray(value)) value.forEach(item => scan(item, key));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([name, item]) => scan(item, name));
  };
  scan(message);
  if (message.method === 'item/commandExecution/terminalInteraction') {
    const p = message.params;
    if (p?.threadId !== state.threadId || p?.turnId !== (state.turnId ?? state.pendingTurnId) ||
        !/^call_passeur_exec_[0-3]$/.test(p.itemId) || typeof p.processId !== 'string')
      throw new Error('interaction scope invalid');
    const index = Number(p.itemId.at(-1));
    if (p.processId !== String(state.sessions[index])) throw new Error('interaction session mismatch');
    if (p.stdin === '\u0003') {
      if (!state.cleanupIssued || state.livePhase !== index || state.cleanupInteraction)
        throw new Error('cleanup interaction mismatch');
      state.cleanupInteraction = true;
    } else {
      if (p.stdin !== state.probes[index].marker + '\n' || state.interactions.has(index))
        throw new Error('interaction input mismatch');
      state.interactions.set(index, { itemId: p.itemId, processId: p.processId, stdin: p.stdin });
    }
    return;
  }
  if (!['item/started', 'item/completed'].includes(message.method)) return;
  const p = message.params, item = p?.item;
  if (!item || typeof item.type !== 'string') throw new Error('item invalid');
  if (item.type !== 'commandExecution') {
    if (['userMessage', 'agentMessage', 'reasoning'].includes(item.type)) return;
    throw new Error('unexpected operation');
  }
  if (p.threadId !== state.threadId || typeof p.turnId !== 'string') throw new Error('item scope invalid');
  if (!state.turnId) state.pendingTurnId ??= p.turnId;
  if (p.turnId !== (state.turnId ?? state.pendingTurnId)) throw new Error('item turn mismatch');
  const index = state.probes.findIndex(probe => presentedCommand(probe.cmd) === item.command);
  if (index < 0 || item.id !== `call_passeur_exec_${index}`) throw new Error('item command identity mismatch');
  const previous = state.items.get(index) ?? { id: item.id };
  if (message.method === 'item/started') {
    if (previous.started || previous.completed || ![null, undefined, ''].includes(item.aggregatedOutput))
      throw new Error('item start invalid');
    previous.started = true; previous.processId = item.processId;
  } else {
    if (!previous.started || previous.completed) throw new Error('item completion invalid');
    previous.completed = { processId: item.processId, exitCode: item.exitCode, status: item.status,
      outputBytes: typeof item.aggregatedOutput === 'string' ? Buffer.byteLength(item.aggregatedOutput) :
        item.aggregatedOutput === null ? 0 : null,
      output: typeof item.aggregatedOutput === 'string' && Buffer.byteLength(item.aggregatedOutput) <= MAX_OUTPUT ?
        item.aggregatedOutput : null };
  }
  state.items.set(index, previous);
}

async function liveAlias(paths, elf) {
  try {
    const entries = (await readdir(join(paths.hostCodexHome, 'tmp', 'arg0'), { withFileTypes: true }))
      .filter(entry => entry.name.startsWith('codex-arg0'));
    if (entries.length !== 1 || !entries[0].isDirectory()) return null;
    const directory = join(paths.hostCodexHome, 'tmp', 'arg0', entries[0].name);
    return (await lstat(join(directory, 'codex-linux-sandbox'))).isSymbolicLink() &&
      await realpath(join(directory, 'codex-linux-sandbox')) === elf ? directory : null;
  } catch { return null; }
}
export async function aliasRetired(directory, root) {
  if (!validRoot(root) || typeof directory !== 'string' ||
      !directory.startsWith(join(root, 'home', 'codex', 'tmp', 'arg0', 'codex-arg0')) || directory.includes('/../')) return false;
  try { await lstat(directory); return false; } catch (error) { return error?.code === 'ENOENT'; }
}
export function visibilityBoundaryFailure(state) {
  for (const category of ['protected_bytes_visible', 'provider_canary_exposed'])
    if (state?.error === category || state?.failure === category) return category;
  return null;
}
export function visibilityFinalStatus(state, report, preStopFailure, preStopExit) {
  if (!report.transportCloseConfirmed) return 'transport_stop_unconfirmed';
  if (!report.hostExitObserved || preStopFailure || preStopExit) return 'native_failed_before_stop';
  if (report.helperAliasRetired !== true) return 'helper_alias_not_retired';
  if (report.postStopCanariesIntact !== true) return 'host_canary_changed_after_stop';
  if (state.error) return state.error;
  if (state.failure) return state.failure;
  if (report.status !== 'native_turn_observed') return report.status;
  const expected = ['workspace', 'direct', 'symlink', 'proc'];
  return state.turnComplete && state.requestCount === 9 && state.completed === 8 &&
    state.items.size === 4 && state.interactions.size === 4 &&
    state.sessions.length === 4 && new Set(state.sessions).size === 4 &&
    report.observations?.length === 8 && expected.every((kind, index) =>
      report.observations[2 * index]?.kind === kind && report.observations[2 * index]?.stage === 'live' &&
      report.observations[2 * index + 1]?.kind === kind && report.observations[2 * index + 1]?.stage === 'terminal' &&
      report.observations[2 * index + 1]?.category === (index === 0 ? 'workspace_read' : 'denied')) &&
    state.liveSession === null && !state.cleanupIssued ? 'sampled_tty_reads_denied' : 'sequence_incomplete';
}

export async function run(bin, root, attestation) {
  if (!validRoot(root)) return { fixture: 'codex-tty-visibility/1', status: 'fixture_root_invalid' };
  const paths = visibilityPaths(root);
  const report = { fixture: 'codex-tty-visibility/1', root, status: 'not_started', candidateModel: MODEL,
    observations: [], hostExitObserved: false, transportCloseConfirmed: false,
    descendantStop: 'unverified', rootDisposition: 'retained_for_review' };
  let host, provider, state, authReady = false, alias = null;
  const secret = randomBytes(24).toString('hex');
  const marker = randomBytes(16).toString('hex');
  const positive = randomBytes(16).toString('hex') + '\n';
  const intact = async () => authReady && await visibilityHostIntact(paths, secret);
  try {
    if (!await isolatedNetwork(process.env.PASSEUR_PARENT_NETNS)) { report.status = 'network_isolation_required'; return report; }
    const runtime = await inspectVisibilityRuntime(paths, process.execPath, bin, attestation);
    if (runtime.status !== 'accepted') { report.status = runtime.status; return report; }
    await symlink(paths.guestAuth, paths.link);
    await writeFile(paths.positive, positive, { mode: 0o600 });
    const version = spawnSync(bin, ['--version'], { encoding: 'utf8', env: guestEnvironment(), timeout: OBSERVE_MS });
    if (version.status !== 0 || version.stdout.trim() !== VERSION) { report.status = 'version_mismatch'; return report; }
    const probes = visibilityProbes(paths, marker);
    state = { probes, issued: [], outputDigests: [], sessions: [], items: new Map(), interactions: new Map(),
      requestCount: 0, completed: 0, liveSession: null, livePhase: null, cleanupIssued: false,
      cleanupInteraction: false, failure: null, error: null, turnId: null, pendingTurnId: null,
      threadId: null, turnComplete: false, busy: false, stopping: false, scanTail: '' };
    provider = createSequencedProvider(state, async (request, response) => {
      const requestIndex = state.requestCount++;
      const refuse = code => { state.error ??= code; response.writeHead(422).end(); };
      const issue = (name, args, callId) => {
        const sse = ttyCall(state.issued.length, name, args, callId);
        state.issued.push({ name, args, callId });
        if (!sendSseIfActive(state, response, sse)) refuse(state.error ?? 'provider_stopping');
      };
      const fail = code => {
        state.failure ??= code;
        if (state.liveSession && !state.items.get(state.livePhase)?.completed && !state.cleanupIssued &&
            !state.stopping && !state.error && !host?.operationFailure) {
          state.cleanupIssued = true;
          return issue('write_stdin', { session_id: state.liveSession, chars: '\u0003',
            yield_time_ms: 1000, max_output_tokens: 1000 }, 'call_passeur_cleanup');
        }
        refuse(code);
      };
      if (requestIndex > 8) return refuse('request_budget');
      let bytes;
      try { bytes = await readBoundedRequest(request); }
      catch { state.error ??= 'request_interrupted_or_oversized'; response.destroy(); return; }
      if (state.stopping || state.error || host?.operationFailure) return refuse('provider_stopping');
      if (request.method !== 'POST' || request.url !== '/v1/responses' ||
          Object.keys(request.headers).some(key => ['authorization', 'proxy-authorization', 'x-api-key'].includes(key)))
        return refuse('provider_route_or_auth');
      let body;
      try { body = JSON.parse(bytes.toString('utf8')); } catch { return refuse('request_json_invalid'); }
      if (JSON.stringify(body).includes(secret)) return refuse('provider_canary_exposed');
      if (execSchema(body) !== 'accepted' || stdinSchema(body) !== 'accepted') return refuse('native_schema_changed');
      if (requestIndex === 0 && Array.isArray(body.input) && body.input.some(item =>
        ['function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output'].includes(item?.type)))
        return refuse('unexpected_initial_call');
      if (requestIndex > 0) {
        const previous = state.issued.length - 1;
        const result = pairedTtyOutput(body, previous, state.issued, state.outputDigests);
        if (result.status !== 'accepted') return fail(result.status);
        if (result.text.includes(secret)) return refuse('provider_canary_exposed');
        state.outputDigests[previous] = sha(result.text);
        if (state.cleanupIssued) { response.writeHead(422).end(); return; }
        const phase = Math.floor(previous / 2), probe = probes[phase];
        if (previous % 2 === 0) {
          const parsed = parseSession(result.text), native = state.items.get(phase);
          if (parsed.status !== 'live' || !native?.started || native.completed ||
              native.processId !== String(parsed.sessionId) || state.sessions.includes(parsed.sessionId))
            return fail('session_or_native_mismatch');
          state.sessions[phase] = parsed.sessionId; state.liveSession = parsed.sessionId; state.livePhase = phase;
          report.observations.push({ kind: probe.kind, stage: 'live', sessionId: parsed.sessionId,
            outputSha256: sha(result.text), outputBytes: Buffer.byteLength(result.text) });
          state.completed++;
        } else {
          const parsed = parseExit(result.text), native = state.items.get(phase);
          const category = visibilityResult(probe, phase, parsed, native, state.interactions.get(phase),
            state.sessions[phase], positive, secret, await intact());
          report.observations.push({ kind: probe.kind, stage: 'terminal', category,
            exitCode: parsed.status === 'exited' && Number.isSafeInteger(parsed.exitCode) ? parsed.exitCode : null,
            nativeStatus: ['completed', 'failed', 'declined', 'inProgress'].includes(native?.completed?.status) ?
              native.completed.status : 'unknown',
            nativeExitCode: Number.isSafeInteger(native?.completed?.exitCode) ? native.completed.exitCode : null,
            outputSha256: sha(result.text), outputBytes: Buffer.byteLength(result.text) });
          if (category !== (phase === 0 ? 'workspace_read' : 'denied')) return fail(category);
          state.liveSession = null; state.livePhase = null; state.completed++;
        }
      }
      if (!await intact() || state.stopping || state.error || host?.operationFailure)
        return refuse('host_or_provider_invalid');
      if (state.issued.length === 8) {
        if (!sendSseIfActive(state, response, ttyFinal())) refuse(state.error ?? 'provider_stopping');
        return;
      }
      const phase = Math.floor(state.issued.length / 2);
      if (state.issued.length % 2 === 0)
        return issue('exec_command', ttyExecArgs(probes[phase]), `call_passeur_exec_${phase}`);
      return issue('write_stdin', ttyStdinArgs(state.sessions[phase], marker), `call_passeur_stdin_${phase}`);
    });
    await new Promise((resolveListen, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolveListen); });
    await writeFile(join(paths.hostCodexHome, 'config.toml'),
      providerToml(paths.workspace, runtime.elf, provider.address().port, MODEL), { mode: 0o600 });
    host = new CodexStdio({ command: bin,
      args: ['-c', 'mcp_servers={}', '-c', 'features.apps=false', '-c', 'features.plugins=false',
        '-c', 'features.multi_agent=false', '-c', 'web_search="disabled"', 'app-server'],
      cwd: paths.workspace, env: guestEnvironment(), request: async () => {
        state.error ??= 'unexpected_native_server_request'; throw new Error('unexpected native server request');
      }, notification: message => {
        try { recordVisibilityNative(state, message, secret); }
        catch (error) { state.error ??= error.message === 'protected bytes exposed' ?
          'protected_bytes_visible' : 'native_item_invalid'; throw error; }
        if (message.method === 'turn/completed' && message.params?.threadId === state.threadId) {
          const turn = message.params.turn;
          if (!state.turnId) state.pendingTurnId ??= turn?.id;
          if (turn?.id !== (state.turnId ?? state.pendingTurnId) || turn?.status !== 'completed' || turn?.error || state.turnComplete) {
            state.error ??= 'native_turn_invalid'; throw new Error('native turn invalid');
          }
          state.turnComplete = true;
        }
      } });
    report.nativePid = host.pid ?? null;
    if (host.pid && await realpath(await readlink('/proc/' + host.pid + '/exe')) !== runtime.elf) {
      report.status = 'native_executable_mismatch'; return report;
    }
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), OBSERVE_MS);
    try {
      await host.request('initialize', { clientInfo: { name: 'passeur_codex_tty_visibility_fixture', version: '1' },
        capabilities: { experimentalApi: true } }, controller.signal);
      await host.notify('initialized', undefined, controller.signal);
      alias = await liveAlias(paths, runtime.elf);
      if (!alias) { report.status = 'helper_alias_unavailable'; return report; }
      const config = await host.request('config/read', { includeLayers: false, cwd: paths.workspace }, controller.signal);
      if (!effectiveConfig(config).valid || config?.config?.model_provider !== PROVIDER || config?.config?.model !== MODEL) {
        report.status = 'effective_config_unsupported'; return report;
      }
      if (profileAvailability(await host.request('permissionProfile/list', { cwd: paths.workspace }, controller.signal)) !== 'allowed') {
        report.status = 'profile_unavailable'; return report;
      }
      if (!accountIsAnonymous(await host.request('account/read', { refreshToken: false }, controller.signal))) {
        report.status = 'account_not_anonymous'; return report;
      }
      await writeFile(paths.guestAuth, secret, { mode: 0o600 }); authReady = true;
      if (!await intact()) { report.status = 'host_guest_auth_mismatch'; return report; }
      const thread = await host.request('thread/start', threadRequest(paths.workspace, MODEL), controller.signal);
      if (selectedProfile(thread) !== PROFILE || thread?.model !== MODEL || thread?.modelProvider !== PROVIDER ||
          typeof thread?.thread?.id !== 'string') { report.status = 'thread_profile_unsupported'; return report; }
      state.threadId = thread.thread.id;
      const turn = await host.request('turn/start', { threadId: state.threadId, permissions: PROFILE,
        input: [{ type: 'text', text: 'Use only the exact synthetic fixture TTY calls.' }] }, controller.signal);
      state.turnId = turn?.turn?.id;
      if (typeof state.turnId !== 'string' || state.pendingTurnId && state.pendingTurnId !== state.turnId) {
        report.status = 'turn_start_unsupported'; return report;
      }
      let poll, deadline;
      await Promise.race([new Promise(resolveObservation => {
        poll = setInterval(() => { if (state.turnComplete || state.error ||
          state.failure && (!state.cleanupIssued || state.cleanupInteraction)) resolveObservation(); }, 20);
        deadline = setTimeout(resolveObservation, OBSERVE_MS);
      }), host.failure.catch(() => undefined)]).finally(() => { clearInterval(poll); clearTimeout(deadline); });
      report.status = state.error ?? state.failure ?? (state.turnComplete ? 'native_turn_observed' : 'observation_elapsed');
      return report;
    } finally { clearTimeout(timer); }
  } catch (error) {
    report.status = 'fixture_error'; report.errorCode = typeof error?.code === 'string' ? error.code : 'UNKNOWN'; return report;
  } finally {
    if (state) state.stopping = true;
    const preStopFailure = host?.operationFailure?.code ?? null, preStopExit = Boolean(host?.exitEvidence);
    report.transportCloseConfirmed = host ? await host.close(3000) : true;
    report.hostExitObserved = Boolean(host?.exitEvidence);
    report.helperAliasRetired = alias ? report.hostExitObserved && await aliasRetired(alias, root) : null;
    if (provider) { provider.closeAllConnections(); await new Promise(resolveClose => provider.close(resolveClose)); }
    report.postStopCanariesIntact = authReady ? await intact() : null;
    if (state) {
      report.primaryBoundaryFailure = visibilityBoundaryFailure(state);
      report.preStopFailureObserved = Boolean(preStopFailure);
      report.preStopExitObserved = preStopExit;
      report.status = visibilityFinalStatus(state, report, preStopFailure, preStopExit);
    }
    await writeFile(join(root, 'bounded-report.json'), emitReport(report), { mode: 0o600 });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const isolated = process.argv[2] === '--isolated';
  const arg = process.argv[isolated ? 3 : 2];
  const rootArg = isolated ? process.argv[4] : null;
  const attested = isolated ? process.argv.slice(5, 9) : [];
  if (!arg?.startsWith('--codex-bin=/') || isolated &&
      (!rootArg?.startsWith('--fixture-root=/tmp/') ||
        !/^--node-sha=[a-f0-9]{64}$/.test(attested[0] ?? '') ||
        !/^--node-identity=[0-9]+:[0-9]+$/.test(attested[1] ?? '') ||
        !/^--elf-sha=[a-f0-9]{64}$/.test(attested[2] ?? '') ||
        !/^--elf-identity=[0-9]+:[0-9]+$/.test(attested[3] ?? ''))) {
    process.stderr.write('usage: node scripts/qualify-codex-tty-visibility.mjs --codex-bin=/absolute/path/to/codex\n');
    process.exitCode = 2;
  } else if (!isolated) {
    let paths, nodeHandle, elfHandle;
    try {
      const elf = await realpath(arg.slice('--codex-bin='.length));
      const node = await realpath(process.execPath);
      nodeHandle = await open(node, 'r'); elfHandle = await open(elf, 'r');
      const [nodeStat, elfStat] = await Promise.all([nodeHandle.stat({ bigint: true }), elfHandle.stat({ bigint: true })]);
      const attestation = { nodeSha: sha(await nodeHandle.readFile()), elfSha: sha(await elfHandle.readFile()),
        nodeIdentity: `${nodeStat.dev}:${nodeStat.ino}`, elfIdentity: `${elfStat.dev}:${elfStat.ino}` };
      if (!matchesNativeAttestation(elf, attestation.elfSha)) throw new Error('native executable mismatch');
      paths = await prepareVisibilityRoot();
      await prepareVisibilityTargets(paths, node, elf);
      const args = visibilityNamespaceArguments(node, fileURLToPath(import.meta.url), elf,
        await readlink('/proc/self/ns/net'), paths, attestation);
      const child = spawnSync('/usr/bin/bwrap', args, { encoding: 'utf8', env: hostEnvironment(paths),
        maxBuffer: 131_072, stdio: ['ignore', 'pipe', 'pipe', nodeHandle.fd, elfHandle.fd] });
      if (child.status === null || child.error || !child.stdout) {
        process.stdout.write(JSON.stringify({ fixture: 'codex-tty-visibility/1', root: paths.root,
          status: 'outer_namespace_unavailable' }) + '\n'); process.exitCode = 1;
      } else { process.stdout.write(child.stdout); process.exitCode = child.status; }
    } catch {
      process.stdout.write(JSON.stringify({ fixture: 'codex-tty-visibility/1', root: paths?.root ?? null,
        status: 'fixture_prepare_failed' }) + '\n'); process.exitCode = 1;
    } finally { await nodeHandle?.close().catch(() => undefined); await elfHandle?.close().catch(() => undefined); }
  } else {
    const report = await run(arg.slice('--codex-bin='.length), rootArg.slice('--fixture-root='.length), {
      nodeSha: attested[0].slice('--node-sha='.length), nodeIdentity: attested[1].slice('--node-identity='.length),
      elfSha: attested[2].slice('--elf-sha='.length), elfIdentity: attested[3].slice('--elf-identity='.length) });
    const output = emitReport(report);
    process.stdout.write(output); process.exitCode = JSON.parse(output).status === 'sampled_tty_reads_denied' ? 0 : 1;
  }
}
