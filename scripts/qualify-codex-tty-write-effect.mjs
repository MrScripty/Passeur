import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, open, readFile, readdir, readlink, realpath, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexStdio } from '../dist/src/agents/codex/transport.js';
import { matchesNativeAttestation, profileAvailability, effectiveConfig } from './qualify-codex-protected-boundary.mjs';
import { providerToml, threadRequest, selectedProfile, accountIsAnonymous, isolatedNetwork,
  emitReport } from './qualify-codex-model-tools.mjs';
import { execSchema, createSequencedProvider, readBoundedRequest, sendSseIfActive } from './qualify-codex-model-exec.mjs';
import { stdinSchema, ttyExecArgs, ttyStdinArgs, ttyCall, ttyFinal, pairedTtyOutput,
  parseSession, parseExit } from './qualify-codex-model-write-stdin.mjs';
import { visibilityPaths, prepareVisibilityRoot, prepareVisibilityTargets, visibilityNamespaceArguments,
  inspectVisibilityRuntime, visibilityHostIntact, recordVisibilityNative, aliasRetired,
  guestEnvironment, hostEnvironment, visibilityBoundaryFailure } from './qualify-codex-tty-visibility.mjs';

const VERSION = 'codex-cli 0.157.1';
const MODEL = 'gpt-5.3-codex';
const PROVIDER = 'passeur_fixture_loopback';
const PROFILE = 'passeur-boundary';
const OBSERVE_MS = 10_000;
const MAX_OUTPUT = 16_384;
const sha = value => createHash('sha256').update(value).digest('hex');

export function effectProbes(paths, marker) {
  if (!/^[a-f0-9]{32}$/.test(marker)) throw new Error('invalid synthetic marker');
  const destinations = [join(paths.workspace, 'effect-positive'), paths.guestAuth];
  return destinations.map((path, index) => {
    if (!/^\/[A-Za-z0-9_./:-]+$/.test(path) || path.includes('..')) throw new Error('unsafe effect path');
    return { kind: index === 0 ? 'workspace' : 'protected', path, workspace: paths.workspace, marker,
      cmd: `IFS= read -rs line; printf %s "$line" > ${path} && cat ${path}` };
  });
}
export function effectResult(probe, index, parsed, native, interaction, sessionId,
  marker, originalCanary, hostIntact, workspaceText) {
  if (!hostIntact) return 'host_canary_changed';
  if (!native?.started || native.id !== `call_passeur_exec_${index}` ||
      native.processId !== String(sessionId) || native.completed?.processId !== String(sessionId) ||
      interaction?.itemId !== native.id || interaction.processId !== String(sessionId) ||
      interaction.stdin !== probe.marker + '\n') return 'native_tty_lifecycle_mismatch';
  if (parsed?.status !== 'exited' || native.completed.exitCode !== parsed.exitCode)
    return 'tty_exit_mismatch';
  const output = native.completed.output;
  if (!Number.isInteger(native.completed.outputBytes) || native.completed.outputBytes > MAX_OUTPUT ||
      (output === null && native.completed.outputBytes !== 0) ||
      (typeof output === 'string' && Buffer.byteLength(output) !== native.completed.outputBytes) ||
      output !== null && typeof output !== 'string') return 'output_unavailable';
  const toolText = parsed.output ?? '';
  const nativeText = output ?? '';
  if (toolText.includes(originalCanary) || nativeText.includes(originalCanary)) return 'protected_bytes_visible';
  if (probe.kind === 'workspace') return parsed.exitCode === 0 && native.completed.status === 'completed' &&
    toolText === marker && nativeText === marker && workspaceText === marker ?
    'workspace_write_readback' : 'workspace_effect_unconfirmed';
  if (probe.kind !== 'protected' || index !== 1) return 'probe_identity_invalid';
  if (parsed.exitCode !== 0 || native.completed.status !== 'completed') return 'protected_effect_uncertain';
  return toolText === marker && nativeText === marker ? 'guest_private_write_effect' : 'protected_readback_uncertain';
}
export function recordEffectNative(state, message, canary) {
  if (JSON.stringify(message).includes(canary)) throw new Error('protected bytes exposed');
  const id = message.method === 'item/commandExecution/terminalInteraction' ? message.params?.itemId :
    ['item/started', 'item/completed'].includes(message.method) && message.params?.item?.type === 'commandExecution' ?
      message.params.item.id : null;
  if (id !== null && !/^call_passeur_exec_[01]$/.test(id)) throw new Error('unexpected effect call id');
  recordVisibilityNative(state, message, canary);
}
export function effectFinalStatus(state, report, preStopFailure, preStopExit) {
  if (!report.transportCloseConfirmed) return 'transport_stop_unconfirmed';
  if (!report.hostExitObserved || preStopFailure || preStopExit) return 'native_failed_before_stop';
  if (report.helperAliasRetired !== true) return 'helper_alias_not_retired';
  if (report.postStopCanariesIntact !== true) return 'host_canary_changed_after_stop';
  if (state.error) return state.error;
  if (state.failure) return state.failure;
  if (report.status !== 'native_turn_observed') return report.status;
  const expected = ['workspace_write_readback', 'guest_private_write_effect'];
  return state.turnComplete && state.requestCount === 5 && state.completed === 4 &&
    state.items.size === 2 && state.interactions.size === 2 && state.sessions.length === 2 &&
    state.sessions[0] !== state.sessions[1] && state.liveSession === null && !state.cleanupIssued &&
    report.observations?.length === 4 && expected.every((category, index) =>
      report.observations[2 * index]?.kind === (index === 0 ? 'workspace' : 'protected') &&
      report.observations[2 * index]?.stage === 'live' &&
      report.observations[2 * index + 1]?.stage === 'terminal' &&
      report.observations[2 * index + 1]?.category === category) ?
    'sampled_guest_private_write_effect' : 'sequence_incomplete';
}

export async function run(bin, root, attestation) {
  let paths;
  try { paths = visibilityPaths(root); }
  catch { return { fixture: 'codex-tty-write-effect/1', status: 'fixture_root_invalid' }; }
  const report = { fixture: 'codex-tty-write-effect/1', root, status: 'not_started', candidateModel: MODEL,
    observations: [], hostExitObserved: false, transportCloseConfirmed: false,
    descendantStop: 'unverified', rootDisposition: 'retained_for_review' };
  let host, provider, state, authReady = false, alias = null;
  const canary = randomBytes(24).toString('hex'), marker = randomBytes(16).toString('hex');
  const intact = async () => authReady && await visibilityHostIntact(paths, canary);
  try {
    if (!await isolatedNetwork(process.env.PASSEUR_PARENT_NETNS)) { report.status = 'network_isolation_required'; return report; }
    const runtime = await inspectVisibilityRuntime(paths, process.execPath, bin, attestation);
    if (runtime.status !== 'accepted') { report.status = runtime.status; return report; }
    await symlink(paths.guestAuth, paths.link);
    const version = spawnSync(bin, ['--version'], { encoding: 'utf8', env: guestEnvironment(), timeout: OBSERVE_MS });
    if (version.status !== 0 || version.stdout.trim() !== VERSION) { report.status = 'version_mismatch'; return report; }
    const probes = effectProbes(paths, marker);
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
      if (requestIndex > 4) return refuse('request_budget');
      let bytes;
      try { bytes = await readBoundedRequest(request); }
      catch { state.error ??= 'request_interrupted_or_oversized'; response.destroy(); return; }
      if (state.stopping || state.error || host?.operationFailure) return refuse('provider_stopping');
      if (request.method !== 'POST' || request.url !== '/v1/responses' ||
          Object.keys(request.headers).some(key => ['authorization', 'proxy-authorization', 'x-api-key'].includes(key)))
        return refuse('provider_route_or_auth');
      let body;
      try { body = JSON.parse(bytes.toString('utf8')); } catch { return refuse('request_json_invalid'); }
      if (JSON.stringify(body).includes(canary)) return refuse('provider_canary_exposed');
      if (execSchema(body) !== 'accepted' || stdinSchema(body) !== 'accepted') return refuse('native_schema_changed');
      if (requestIndex === 0 && Array.isArray(body.input) && body.input.some(item =>
        ['function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output'].includes(item?.type)))
        return refuse('unexpected_initial_call');
      if (requestIndex > 0) {
        const previous = state.issued.length - 1;
        const result = pairedTtyOutput(body, previous, state.issued, state.outputDigests);
        if (result.status !== 'accepted') return fail(result.status);
        if (result.text.includes(canary)) return refuse('provider_canary_exposed');
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
          const workspaceText = phase === 0 ? await readFile(probe.path, 'utf8').catch(() => null) : null;
          const category = effectResult(probe, phase, parsed, native, state.interactions.get(phase),
            state.sessions[phase], marker, canary, await intact(), workspaceText);
          report.observations.push({ kind: probe.kind, stage: 'terminal', category,
            exitCode: parsed.status === 'exited' && Number.isSafeInteger(parsed.exitCode) ? parsed.exitCode : null,
            nativeStatus: ['completed', 'failed', 'declined', 'inProgress'].includes(native?.completed?.status) ?
              native.completed.status : 'unknown',
            nativeExitCode: Number.isSafeInteger(native?.completed?.exitCode) ? native.completed.exitCode : null,
            outputSha256: sha(result.text), outputBytes: Buffer.byteLength(result.text) });
          if (category !== (phase === 0 ? 'workspace_write_readback' : 'guest_private_write_effect')) return fail(category);
          state.liveSession = null; state.livePhase = null; state.completed++;
        }
      }
      if (!await intact() || state.stopping || state.error || host?.operationFailure)
        return refuse('host_or_provider_invalid');
      if (state.issued.length === 4) {
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
        try { recordEffectNative(state, message, canary); }
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
      await host.request('initialize', { clientInfo: { name: 'passeur_codex_tty_write_effect_fixture', version: '1' },
        capabilities: { experimentalApi: true } }, controller.signal);
      await host.notify('initialized', undefined, controller.signal);
      const aliasRoot = join(paths.hostCodexHome, 'tmp', 'arg0');
      const aliasEntries = await readdir(aliasRoot, { withFileTypes: true });
      const aliases = aliasEntries.filter(entry => entry.name.startsWith('codex-arg0'));
      if (aliases.length !== 1 || !aliases[0].isDirectory()) { report.status = 'helper_alias_unavailable'; return report; }
      alias = join(aliasRoot, aliases[0].name);
      if (!(await lstat(join(alias, 'codex-linux-sandbox'))).isSymbolicLink() ||
          await realpath(join(alias, 'codex-linux-sandbox')) !== runtime.elf) {
        report.status = 'helper_alias_target_mismatch'; return report;
      }
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
      await writeFile(paths.guestAuth, canary, { mode: 0o600 }); authReady = true;
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
      report.status = effectFinalStatus(state, report, preStopFailure, preStopExit);
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
    process.stderr.write('usage: node scripts/qualify-codex-tty-write-effect.mjs --codex-bin=/absolute/path/to/codex\n');
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
        process.stdout.write(JSON.stringify({ fixture: 'codex-tty-write-effect/1', root: paths.root,
          status: 'outer_namespace_unavailable' }) + '\n'); process.exitCode = 1;
      } else { process.stdout.write(child.stdout); process.exitCode = child.status; }
    } catch {
      process.stdout.write(JSON.stringify({ fixture: 'codex-tty-write-effect/1', root: paths?.root ?? null,
        status: 'fixture_prepare_failed' }) + '\n'); process.exitCode = 1;
    } finally { await nodeHandle?.close().catch(() => undefined); await elfHandle?.close().catch(() => undefined); }
  } else {
    const report = await run(arg.slice('--codex-bin='.length), rootArg.slice('--fixture-root='.length), {
      nodeSha: attested[0].slice('--node-sha='.length), nodeIdentity: attested[1].slice('--node-identity='.length),
      elfSha: attested[2].slice('--elf-sha='.length), elfIdentity: attested[3].slice('--elf-identity='.length) });
    const output = emitReport(report);
    process.stdout.write(output); process.exitCode = JSON.parse(output).status === 'sampled_guest_private_write_effect' ? 0 : 1;
  }
}
