import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexStdio } from '../dist/src/agents/codex/transport.js';
import { matchesNativeAttestation, profileAvailability, effectiveConfig, selectedEnvironment,
  hostCanaryCheck } from './qualify-codex-protected-boundary.mjs';
import { providerToml, threadRequest, selectedProfile, accountIsAnonymous, isolatedNetwork,
  namespaceArguments, emitReport } from './qualify-codex-model-tools.mjs';
import { execSchema, presentedCommand, createSequencedProvider, readBoundedRequest,
  sendSseIfActive } from './qualify-codex-model-exec.mjs';

const VERSION = 'codex-cli 0.157.1';
const MODEL = 'gpt-5.3-codex'; // Candidate for this synthetic diagnostic only.
const PROVIDER = 'passeur_fixture_loopback';
const PROFILE = 'passeur-boundary';
const MAX_OUTPUT = 16_384;
const MAX_DIAGNOSTIC = 512;
const MAX_REQUESTS = 7;
const OBSERVE_MS = 10_000;
const GUEST_HOME = '/home/jeremy';
const GUEST_CODEX_HOME = join(GUEST_HOME, 'codex');
const sha = value => createHash('sha256').update(value).digest('hex');
const validRoot = root => typeof root === 'string' &&
  /^\/tmp\/passeur-codex-model-write-stdin-[A-Za-z0-9]+$/.test(root);
export function ttyRuntimePaths(root) {
  if (!validRoot(root)) throw new Error('invalid fixture root');
  const home = join(root, 'home');
  return { root, home, guestHome: GUEST_HOME, hostCodexHome: join(home, 'codex'), guestCodexHome: GUEST_CODEX_HOME,
    workspace: join(root, 'work'), hostAuthPath: join(home, 'codex', 'auth.json'),
    guestAuthPath: join(GUEST_CODEX_HOME, 'auth.json') };
}
export async function prepareTtyRuntimeHome() {
  const root = await mkdtemp(join(tmpdir(), 'passeur-codex-model-write-stdin-'));
  const paths = ttyRuntimePaths(root);
  await mkdir(paths.home, { mode: 0o700 });
  await mkdir(paths.hostCodexHome, { mode: 0o700 });
  await mkdir(paths.workspace, { mode: 0o700 });
  for (const path of [root, paths.home, paths.hostCodexHome, paths.workspace]) await chmod(path, 0o700);
  return paths;
}
export function ttyHostEnvironment(home, ambient = process.env) {
  const env = selectedEnvironment(home);
  if (typeof ambient.TMPDIR === 'string' && ambient.TMPDIR.length > 0) env.TMPDIR = ambient.TMPDIR;
  return env;
}
export function ttyGuestEnvironment(ambient = process.env) {
  const env = { ...selectedEnvironment(GUEST_HOME), CODEX_HOME: GUEST_CODEX_HOME };
  if (typeof ambient.TMPDIR === 'string' && ambient.TMPDIR.length > 0) env.TMPDIR = ambient.TMPDIR;
  return env;
}
export function ttyShadowDestination(paths, sourcePath) {
  if (typeof sourcePath !== 'string' || !sourcePath.startsWith(GUEST_HOME + '/') ||
      sourcePath.split('/').includes('..')) throw new Error('runtime executable outside exact home');
  return join(paths.home, sourcePath.slice(GUEST_HOME.length + 1));
}
export async function prepareTtyExecutableTargets(paths, node, elf) {
  for (const source of [node, elf]) {
    const destination = ttyShadowDestination(paths, source);
    await mkdir(join(destination, '..'), { recursive: true, mode: 0o700 });
    await writeFile(destination, '', { flag: 'wx', mode: 0o600 });
  }
}
const validIdentity = value => typeof value === 'string' && /^[0-9]+:[0-9]+$/.test(value);
export function ttyNamespaceArguments(node, script, bin, parentNetNs, root, attestation) {
  const paths = ttyRuntimePaths(root);
  if (!/^[a-f0-9]{64}$/.test(attestation?.nodeSha) || !/^[a-f0-9]{64}$/.test(attestation?.elfSha) ||
      !validIdentity(attestation?.nodeIdentity) || !validIdentity(attestation?.elfIdentity) || node === bin)
    throw new Error('runtime executable attestation missing');
  ttyShadowDestination(paths, node); ttyShadowDestination(paths, bin);
  const args = namespaceArguments(node, script, bin, parentNetNs, MODEL);
  const separator = args.indexOf('--');
  args.splice(separator, 0, '--bind', paths.home, GUEST_HOME,
    '--ro-bind-fd', '3', node, '--ro-bind-fd', '4', bin,
    '--setenv', 'HOME', GUEST_HOME, '--setenv', 'CODEX_HOME', GUEST_CODEX_HOME);
  args.pop(); // The candidate model is pinned by this fixture.
  args.push(`--fixture-root=${root}`, `--node-sha=${attestation.nodeSha}`,
    `--node-identity=${attestation.nodeIdentity}`, `--elf-sha=${attestation.elfSha}`,
    `--elf-identity=${attestation.elfIdentity}`);
  return args;
}
export function ttyRuntimeBindingStatus({ paths, env, layoutPrivate, hostHome, guestHome, hostCodex,
  guestCodex, guestHomeLink, guestCodexLink, sentinelAbsent, mountInfo }) {
  if (!paths || !validRoot(paths.root)) return 'root_invalid';
  if (env?.HOME !== GUEST_HOME || env?.CODEX_HOME !== GUEST_CODEX_HOME) return 'environment_mismatch';
  if (!layoutPrivate || !hostHome?.isDirectory?.() || !hostCodex?.isDirectory?.()) return 'host_layout_invalid';
  if (!guestHome?.isDirectory?.() || !guestCodex?.isDirectory?.() ||
      !guestHomeLink?.isDirectory?.() || guestHomeLink.isSymbolicLink() ||
      !guestCodexLink?.isDirectory?.() || guestCodexLink.isSymbolicLink()) return 'guest_path_invalid';
  if (hostHome.dev !== guestHome.dev || hostHome.ino !== guestHome.ino ||
      hostCodex.dev !== guestCodex.dev || hostCodex.ino !== guestCodex.ino) return 'bind_identity_mismatch';
  if (typeof mountInfo !== 'string' || !mountInfo.split('\n').some(line => line.split(' ')[4] === GUEST_HOME))
    return 'bind_mount_missing';
  if (!sentinelAbsent) return 'real_home_visible';
  return 'accepted';
}
export async function inspectTtyRuntimeBinding(paths, env = process.env) {
  const privateDirectory = async path => {
    const item = await lstat(path);
    return item.isDirectory() && !item.isSymbolicLink() && (item.mode & 0o777) === 0o700;
  };
  try {
    const layoutPrivate = (await Promise.all([paths.root, paths.home, paths.hostCodexHome, paths.workspace]
      .map(privateDirectory))).every(Boolean);
    const [hostHome, guestHome, hostCodex, guestCodex, guestHomeLink, guestCodexLink, mountInfo] = await Promise.all([
      stat(paths.home), stat(GUEST_HOME), stat(paths.hostCodexHome), stat(GUEST_CODEX_HOME),
      lstat(GUEST_HOME), lstat(GUEST_CODEX_HOME), readFile('/proc/self/mountinfo', 'utf8')]);
    const sentinelAbsent = await lstat(join(GUEST_HOME, '.bashrc')).then(() => false,
      error => error?.code === 'ENOENT');
    return ttyRuntimeBindingStatus({ paths, env, layoutPrivate, hostHome, guestHome, hostCodex,
      guestCodex, guestHomeLink, guestCodexLink, sentinelAbsent, mountInfo });
  } catch { return 'bind_preflight_unavailable'; }
}
export async function inspectTtyExecutableBinds(paths, node, bin, attestation) {
  try {
    if (!/^[a-f0-9]{64}$/.test(attestation?.nodeSha) || !/^[a-f0-9]{64}$/.test(attestation?.elfSha) ||
        !validIdentity(attestation?.nodeIdentity) || !validIdentity(attestation?.elfIdentity) ||
        ttyShadowDestination(paths, node) === ttyShadowDestination(paths, bin))
      return { status: 'executable_paths_invalid' };
    const [nodeGuest, codexGuest] = await Promise.all([stat(node, { bigint: true }), stat(bin, { bigint: true })]);
    if (!nodeGuest.isFile() || !codexGuest.isFile() ||
        `${nodeGuest.dev}:${nodeGuest.ino}` !== attestation.nodeIdentity ||
        `${codexGuest.dev}:${codexGuest.ino}` !== attestation.elfIdentity)
      return { status: 'executable_bind_identity_mismatch' };
    if (sha(await readFile(node)) !== attestation.nodeSha) return { status: 'node_executable_mismatch' };
    const elf = await realpath(bin), elfSha = sha(await readFile(bin));
    if (elf !== bin || elfSha !== attestation.elfSha || !matchesNativeAttestation(elf, elfSha))
      return { status: 'native_executable_mismatch' };
    return { status: 'accepted', elf, elfSha };
  } catch { return { status: 'executable_bind_unavailable' }; }
}
export async function inspectLiveTtyAlias(hostCodexHome, elf) {
  try {
    const aliasRoot = join(hostCodexHome, 'tmp', 'arg0');
    const entries = (await readdir(aliasRoot, { withFileTypes: true }))
      .filter(entry => entry.name.startsWith('codex-arg0'));
    if (entries.length !== 1 || !entries[0].isDirectory()) return { status: 'helper_alias_missing_or_ambiguous' };
    const aliasDirectory = join(aliasRoot, entries[0].name);
    const alias = join(aliasDirectory, 'codex-linux-sandbox');
    if (!(await lstat(alias)).isSymbolicLink() || await realpath(alias) !== elf)
      return { status: 'helper_alias_target_mismatch' };
    return { status: 'accepted', aliasDirectory };
  } catch { return { status: 'helper_alias_unavailable' }; }
}
export async function ttyAliasRetired(aliasDirectory) {
  if (typeof aliasDirectory !== 'string' ||
      !/^\/tmp\/passeur-codex-model-write-stdin-[A-Za-z0-9]+\/home\/codex\/tmp\/arg0\/codex-arg0[^/]+$/.test(aliasDirectory)) return false;
  try { await lstat(aliasDirectory); return false; }
  catch (error) { return error?.code === 'ENOENT'; }
}
export async function ttyProtectedHostIntact(paths, authLink, secret) {
  try {
    if (!await hostCanaryCheck('direct', paths.hostAuthPath, paths.hostAuthPath, secret) ||
        !await hostCanaryCheck('proc', '/proc/self/root' + paths.hostAuthPath, paths.hostAuthPath, secret) ||
        !(await lstat(authLink)).isSymbolicLink() || await readlink(authLink) !== paths.guestAuthPath) return false;
    const [hostAuth, guestAuth, aliasAuth] = await Promise.all([
      stat(paths.hostAuthPath), stat(paths.guestAuthPath), stat(authLink)]);
    return hostAuth.isFile() && hostAuth.dev === guestAuth.dev && hostAuth.ino === guestAuth.ino &&
      hostAuth.dev === aliasAuth.dev && hostAuth.ino === aliasAuth.ino &&
      await readFile(paths.guestAuthPath, 'utf8') === secret && await readFile(authLink, 'utf8') === secret;
  } catch { return false; }
}
export function stdinSchema(body, expectedExecDigest) {
  if (execSchema(body, expectedExecDigest) !== 'accepted') return 'exec_schema_mismatch';
  const tool = body.tools.find(value => value.name === 'write_stdin');
  const schema = tool?.parameters;
  const expected = { session_id: 'number', chars: 'string', yield_time_ms: 'number', max_output_tokens: 'number' };
  return tool?.type === 'function' && schema?.type === 'object' && schema.additionalProperties === false &&
    JSON.stringify(schema.required) === '["session_id"]' &&
    JSON.stringify(Object.keys(schema.properties ?? {}).sort()) === JSON.stringify(Object.keys(expected).sort()) &&
    Object.keys(schema).sort().join(',') === 'additionalProperties,properties,required,type' &&
    Object.entries(expected).every(([key, type]) =>
      Object.keys(schema.properties[key] ?? {}).sort().join(',') === 'description,type' &&
      schema.properties[key].type === type && typeof schema.properties[key].description === 'string' &&
      Buffer.byteLength(schema.properties[key].description) <= 512) ? 'accepted' : 'stdin_schema_mismatch';
}
export function ttyCommand(path) {
  if (!/^[A-Za-z0-9_./:-]+$/.test(path)) throw new Error('unsafe fixture path');
  return 'IFS= read -rs line; printf %s "$line" > ' + path;
}
export function ttyProbes(workspace, authPath, positiveMarker, protectedMarker) {
  return [
    { kind: 'positive', path: join(workspace, 'tty-written'), cmd: ttyCommand(join(workspace, 'tty-written')), marker: positiveMarker, workspace },
    { kind: 'protected', path: authPath, cmd: ttyCommand(authPath), marker: protectedMarker, workspace },
  ];
}
export const ttyExecArgs = probe => ({ cmd: probe.cmd, shell: '/bin/bash', login: false, workdir: probe.workspace,
  tty: true, yield_time_ms: 1000, max_output_tokens: 1000 });
export function ttyStdinArgs(sessionId, marker) {
  if (!Number.isInteger(sessionId) || sessionId <= 0 || sessionId > 2147483647 || !/^[a-f0-9]{32}$/.test(marker)) throw new Error('invalid TTY continuation');
  return { session_id: sessionId, chars: marker + '\n', yield_time_ms: 1000, max_output_tokens: 1000 };
}
export function ttyCall(index, name, args, callId) {
  const id = 'resp_passeur_tty_' + index;
  const events = [
    { type: 'response.created', response: { id } },
    { type: 'response.output_item.done', item: { type: 'function_call', call_id: callId, name, arguments: JSON.stringify(args) } },
    { type: 'response.completed', response: { id, usage: { input_tokens: 0, input_tokens_details: null,
      output_tokens: 0, output_tokens_details: null, total_tokens: 0 } } },
  ];
  return events.map(event => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n').join('');
}
export function ttyFinal() {
  const id = 'resp_passeur_tty_final';
  return [
    { type: 'response.created', response: { id } },
    { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: 'msg_passeur_tty_final',
      content: [{ type: 'output_text', text: 'Fixture complete.' }] } },
    { type: 'response.completed', response: { id, usage: { input_tokens: 0, input_tokens_details: null,
      output_tokens: 0, output_tokens_details: null, total_tokens: 0 } } },
  ].map(event => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n').join('');
}
function outputText(output) {
  const text = typeof output === 'string' ? output :
    Array.isArray(output) && output.length === 1 && output[0]?.type === 'input_text' &&
      Object.keys(output[0]).sort().join(',') === 'text,type' ? output[0].text :
    output && !Array.isArray(output) && Object.keys(output).sort().join(',') === 'content,success' &&
      typeof output.success === 'boolean' && typeof output.content === 'string' ? output.content : null;
  return typeof text === 'string' && Buffer.byteLength(text) <= MAX_OUTPUT ? text : null;
}
export function pairedTtyOutput(body, index, issued, acceptedDigests = []) {
  if (!Array.isArray(body?.input) || body.input.length > 32 ||
      body.input.some(item => !['message', 'reasoning', 'function_call', 'function_call_output'].includes(item?.type))) return { status: 'input_shape_unknown' };
  if (!issued[index]) return { status: 'unissued_call' };
  const seen = new Set(); let current = null;
  for (const item of body.input.filter(value => ['function_call', 'function_call_output'].includes(value.type))) {
    const at = issued.findIndex(value => value.callId === item.call_id);
    if (at < 0 || at > index) return { status: 'unexpected_call' };
    const key = item.type + ':' + at;
    if (seen.has(key)) return { status: 'duplicate_call_or_output' };
    seen.add(key);
    if (item.type === 'function_call' &&
        (item.name !== issued[at].name || item.arguments !== JSON.stringify(issued[at].args))) return { status: 'call_arguments_mismatch' };
    if (item.type === 'function_call_output') {
      const text = outputText(item.output);
      if (text === null) return { status: 'output_shape_unknown' };
      if (at < index && sha(text) !== acceptedDigests[at]) return { status: 'historical_output_mismatch' };
      if (at === index) current = text;
    }
  }
  for (let at = 0; at <= index; at++) if (seen.has('function_call:' + at) !== seen.has('function_call_output:' + at)) return { status: 'historical_pair_mismatch' };
  return seen.has('function_call:' + index) && seen.has('function_call_output:' + index) ?
    { status: 'accepted', text: current } : { status: 'call_output_missing' };
}
function formattedOutput(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_OUTPUT) return null;
  const match = /^(?:Chunk ID: [a-fA-F0-9]+\n)?Wall time: [0-9]+(?:\.[0-9]+)? seconds\n(?:(Process exited with code (-?[0-9]+)|Process running with session ID ([0-9]+))\n)(?:Original token count: [0-9]+\n)?Output:\n([\s\S]*)$/.exec(text);
  return match ? { exitCode: match[2] === undefined ? null : Number(match[2]),
    sessionId: match[3] === undefined ? null : Number(match[3]), output: match[4] } : null;
}
export function parseSession(text) {
  const parsed = formattedOutput(text);
  if (!parsed || parsed.exitCode !== null || parsed.sessionId === null || parsed.output !== '') return { status: 'session_output_invalid' };
  return Number.isInteger(parsed.sessionId) && parsed.sessionId > 0 && parsed.sessionId <= 2147483647 ?
    { status: 'live', sessionId: parsed.sessionId } : { status: 'session_id_invalid' };
}
export function parseExit(text) {
  const parsed = formattedOutput(text);
  return parsed && parsed.sessionId === null && Number.isInteger(parsed.exitCode) ?
    { status: 'exited', exitCode: parsed.exitCode, output: parsed.output } : { status: 'exit_output_invalid' };
}
export function firstSessionDiagnosticGate({ root, text, probe, issued, native, parsed,
  requestIndex, previous, protectedIntact, protectedValues }) {
  const outputBytes = typeof text === 'string' ? Math.min(Buffer.byteLength(text, 'utf8'), MAX_OUTPUT + 1) : null;
  const nativeOutputBytes = Number.isInteger(native?.completed?.outputBytes) && native.completed.outputBytes >= 0 ?
    Math.min(native.completed.outputBytes, MAX_OUTPUT + 1) : null;
  const rawStatus = native?.completed?.status;
  const nativeStatus = ['completed', 'failed', 'declined', 'inProgress'].includes(rawStatus) ? rawStatus :
    native?.completed ? 'other' : native?.started ? 'inProgress' : 'unknown';
  const flags = { outputBytes, nativePresent: Boolean(native), nativeStarted: native?.started === true,
    nativeCompleted: Boolean(native?.completed), nativeStatus, nativeOutputBytes };
  let category = 'eligible';
  if (requestIndex !== 1 || previous !== 0 || issued?.length !== 1 ||
      issued[0]?.name !== 'exec_command' || issued[0]?.callId !== 'call_passeur_exec_0') category = 'request_binding_mismatch';
  else if (probe?.kind !== 'positive') category = 'probe_not_positive';
  else if (JSON.stringify(issued[0]?.args) !== JSON.stringify(ttyExecArgs(probe))) category = 'call_args_mismatch';
  else if (parsed?.status !== 'session_output_invalid') category = 'parser_category_mismatch';
  else if (native?.id !== 'call_passeur_exec_0' || native.started !== true) category = 'native_item_mismatch';
  else if (native.completed?.canaryExposed === true) category = 'native_canary_exposed';
  else if (native.completed && (!Number.isInteger(native.completed.outputBytes) ||
      native.completed.outputBytes > MAX_OUTPUT ||
      (native.completed.output === null && native.completed.outputBytes !== 0) ||
      (native.completed.output !== null && typeof native.completed.output !== 'string') ||
      (typeof native.completed.output === 'string' &&
        Buffer.byteLength(native.completed.output) !== native.completed.outputBytes))) category = 'native_output_unavailable';
  else if (!protectedIntact) category = 'host_canary_not_intact';
  else if (typeof text !== 'string') category = 'output_shape_invalid';
  else if (!Array.isArray(protectedValues) || protectedValues.length !== 3) category = 'protected_values_unavailable';
  else if (protectedValues.some(value => typeof value !== 'string' || value.length === 0 || text.includes(value) ||
      (typeof native.completed?.output === 'string' && native.completed.output.includes(value)))) category = 'protected_value_present';
  else if (Buffer.from(text, 'utf8').toString('utf8') !== text) category = 'utf8_invalid';
  else if (Buffer.byteLength(text, 'utf8') > MAX_DIAGNOSTIC) category = 'output_over_limit';
  else if (typeof root !== 'string' || !/^\/tmp\/passeur-codex-model-write-stdin-[A-Za-z0-9]+$/.test(root)) category = 'root_invalid';
  return { category, ...flags };
}
export async function retainFirstSessionDiagnostic(input) {
  if (firstSessionDiagnosticGate(input).category !== 'eligible') return null;
  const { root, text } = input;
  const path = join(root, 'first-positive-exec-output.txt');
  let handle;
  try { handle = await open(path, 'wx', 0o600); await handle.writeFile(text, 'utf8'); await handle.close(); }
  catch {
    if (handle) { await handle.close().catch(() => undefined); await unlink(path).catch(() => undefined); }
    return null;
  }
  return { path, sha256: sha(text), bytes: Buffer.byteLength(text, 'utf8'), category: 'first_positive_exec_output' };
}
export function firstRejectedCallDiagnosticEligible({ root, text, probe, issued, native, parsed,
  requestIndex, previous, protectedIntact, protectedValues, itemsCount, sessions, liveSession,
  interactionsCount, requestCount, nativeEventFault }) {
  return requestIndex === 1 && previous === 0 && requestCount === 2 && nativeEventFault === false &&
    issued?.length === 1 &&
    issued[0]?.name === 'exec_command' && issued[0]?.callId === 'call_passeur_exec_0' &&
    probe?.kind === 'positive' &&
    JSON.stringify(issued[0].args) === JSON.stringify(ttyExecArgs(probe)) &&
    parsed?.status === 'session_output_invalid' && native == null && itemsCount === 0 &&
    Array.isArray(sessions) && sessions.length === 0 && liveSession === null &&
    interactionsCount === 0 && protectedIntact === true && typeof text === 'string' &&
    Buffer.from(text, 'utf8').toString('utf8') === text && Buffer.byteLength(text, 'utf8') <= MAX_DIAGNOSTIC &&
    !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text) &&
    !/(?:session|process\s+running|\bpid\b)/i.test(text.normalize('NFKC')) &&
    Array.isArray(protectedValues) && protectedValues.length === 3 &&
    protectedValues.every(value => typeof value === 'string' && value.length > 0 && !text.includes(value)) &&
    typeof root === 'string' && /^\/tmp\/passeur-codex-model-write-stdin-[A-Za-z0-9]+$/.test(root);
}
export async function retainFirstRejectedCallDiagnostic(input) {
  if (!firstRejectedCallDiagnosticEligible(input)) return null;
  const { root, text } = input;
  const path = join(root, 'first-positive-call-rejection.txt');
  let handle;
  try { handle = await open(path, 'wx', 0o600); await handle.writeFile(text, 'utf8'); await handle.close(); }
  catch {
    if (handle) { await handle.close().catch(() => undefined); await unlink(path).catch(() => undefined); }
    return null;
  }
  return { path, sha256: sha(text), bytes: Buffer.byteLength(text, 'utf8'), category: 'first_positive_call_rejection' };
}
export function rejectedArtifactStopEligible(report, state, preStopFailure, preStopExit) {
  return Boolean(state?.rejectionCandidate && report?.postStopCanariesIntact === true &&
    report.transportCloseConfirmed && report.hostExitObserved && !preStopFailure && !preStopExit &&
    state.error === 'session_output_invalid' && state.failure === 'session_output_invalid');
}
export function ttyResult(probe, index, parsed, native, interaction, sessionId, fileText, protectedIntact, outputTextValue) {
  if (!protectedIntact) return 'host_canary_changed';
  if (!native?.started || native.id !== 'call_passeur_exec_' + index ||
      native.processId !== String(sessionId) || !native.completed ||
      native.completed.processId !== String(sessionId) || !interaction ||
      interaction.itemId !== native.id || interaction.processId !== String(sessionId) ||
      interaction.stdin !== probe.marker + '\n') return 'native_tty_lifecycle_mismatch';
  if (parsed.status !== 'exited' || native.completed.exitCode !== parsed.exitCode) return 'tty_exit_mismatch';
  if (probe.kind === 'positive') return parsed.exitCode === 0 && native.completed.status === 'completed' &&
    parsed.output === '' && (native.completed.output === '' ||
      (native.completed.output === null && native.completed.outputBytes === 0)) && typeof outputTextValue === 'string' &&
    Buffer.byteLength(outputTextValue) <= MAX_OUTPUT &&
    fileText === probe.marker ? 'positive_write' : 'positive_write_failed';
  if (parsed.exitCode === 0 || native.completed.status !== 'failed') return 'protected_write_effect_or_uncertain';
  const escaped = probe.path.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
  const diagnostic = new RegExp('^(?:/bin/bash|bash): line 1: ' + escaped +
    ': (?:Permission denied|Operation not permitted|No such file or directory)$');
  const output = native.completed.output?.replace(/\r/g, '').trimEnd();
  return typeof output === 'string' && diagnostic.test(output) &&
    parsed.output?.replace(/\r/g, '').trimEnd() === output ? 'denied' : 'denial_unattributed';
}
export function protectedWriteEffectDiagnostic(probe, index, parsed, native, interaction, sessionId,
  protectedIntact, category) {
  if (category !== 'protected_write_effect_or_uncertain' || probe?.kind !== 'protected' || index !== 1 ||
      protectedIntact !== true || !Number.isInteger(sessionId) || sessionId <= 0 ||
      native?.id !== 'call_passeur_exec_1' || native.started !== true ||
      native.processId !== String(sessionId) || native.completed?.processId !== String(sessionId) ||
      interaction?.itemId !== native.id || interaction.processId !== String(sessionId) ||
      interaction.stdin !== probe.marker + '\n' || parsed?.status !== 'exited' ||
      !Number.isSafeInteger(parsed.exitCode) || !Number.isSafeInteger(native.completed.exitCode) ||
      native.completed.exitCode !== parsed.exitCode) return null;
  const escaped = probe.path.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
  const diagnostic = new RegExp('^(?:/bin/bash|bash): line 1: ' + escaped +
    ': (?:Permission denied|Operation not permitted|No such file or directory)$');
  const output = native.completed.output?.replace(/\r/g, '').trimEnd();
  const nativeCompletionStatus = ['completed', 'failed', 'declined', 'inProgress'].includes(native.completed.status) ?
    native.completed.status : 'other';
  return { category: 'protected_write_effect_or_uncertain', parsedExitCode: parsed.exitCode,
    nativeCompletionStatus, nativeExitCode: native.completed.exitCode, hostCanaryIntact: true,
    nativeDiagnosticMatched: typeof output === 'string' && diagnostic.test(output) };
}
export function ttyFinalStatus(state, closed, preStopFailure, preStopExit, priorStatus) {
  if (!closed) return 'transport_stop_unconfirmed';
  if (preStopFailure || preStopExit) return 'native_failed_before_stop';
  if (state.error) return state.error;
  if (state.failure) return state.failure;
  if (priorStatus && !['not_started', 'native_turn_observed'].includes(priorStatus)) return priorStatus;
  return state.requestCount === 5 && state.completed === 4 && state.turnComplete &&
    !state.cleanupIssued && state.liveSession === null && state.livePhase === null &&
    state.sessions.length === 2 && state.sessions[0] !== state.sessions[1] &&
    state.items.size === 2 && state.interactions.size === 2 ? 'sampled_tty_boundary_passed' : 'sequence_incomplete';
}

export function recordTtyNative(state, message, secrets) {
  if (message.method === 'item/commandExecution/terminalInteraction') {
    const event = message.params;
    if (event?.threadId !== state.threadId || event?.turnId !== (state.turnId ?? state.pendingTurnId) ||
        !/^call_passeur_exec_[01]$/.test(event.itemId) || typeof event.processId !== 'string') throw new Error('terminal interaction scope invalid');
    const index = Number(event.itemId.at(-1));
    if (event.processId !== String(state.sessions[index])) throw new Error('terminal interaction identity invalid');
    if (event.stdin === '\u0003') {
      if (!state.cleanupIssued || state.livePhase !== index || state.liveSession !== state.sessions[index] ||
          state.cleanupInteraction) throw new Error('cleanup interaction identity invalid');
      state.cleanupInteraction = { itemId: event.itemId, processId: event.processId, stdin: event.stdin };
    } else {
      if (event.stdin !== state.probes[index].marker + '\n' || state.interactions.has(index))
        throw new Error('terminal interaction identity invalid');
      state.interactions.set(index, { itemId: event.itemId, processId: event.processId, stdin: event.stdin });
    }
    return true;
  }
  if (!['item/started', 'item/completed'].includes(message.method)) return false;
  const p = message.params, item = p.item;
  if (!item || typeof item.type !== 'string' || secrets.some(secret => JSON.stringify(item).includes(secret))) throw new Error('native item invalid or exposed');
  if (item.type !== 'commandExecution') {
    if (['userMessage', 'agentMessage', 'reasoning'].includes(item.type)) return false;
    throw new Error('unexpected native operation item');
  }
  if (p.threadId !== state.threadId || typeof p.turnId !== 'string') throw new Error('native item scope mismatch');
  if (!state.turnId) state.pendingTurnId ??= p.turnId;
  if (p.turnId !== (state.turnId ?? state.pendingTurnId)) throw new Error('native item turn mismatch');
  const index = state.probes.findIndex(probe => presentedCommand(probe.cmd) === item.command);
  if (index < 0) throw new Error('unexpected native command');
  if (item.id !== `call_passeur_exec_${index}`) throw new Error('native item call id mismatch');
  const previous = state.items.get(index) ?? { id: item.id };
  if (previous.id !== item.id) throw new Error('native item identity changed');
  if (message.method === 'item/started') {
    if (previous.started || previous.completed) throw new Error('duplicate native item start');
    if (item.aggregatedOutput !== null && item.aggregatedOutput !== undefined && item.aggregatedOutput !== '')
      throw new Error('unexpected native start output');
    previous.started = true;
    previous.processId = item.processId;
  } else {
    if (!previous.started || previous.completed) throw new Error('duplicate or unordered native completion');
    previous.completed = { command: item.command, status: item.status, exitCode: item.exitCode, processId: item.processId,
      outputBytes: typeof item.aggregatedOutput === 'string' ? Buffer.byteLength(item.aggregatedOutput) : item.aggregatedOutput === null ? 0 : null,
      canaryExposed: typeof item.aggregatedOutput === 'string' && secrets.some(secret => item.aggregatedOutput.includes(secret)),
      output: typeof item.aggregatedOutput === 'string' && Buffer.byteLength(item.aggregatedOutput) <= MAX_OUTPUT ? item.aggregatedOutput : null };
  }
  state.items.set(index, previous);
  return true;
}

// The hosted run below is kept separate from the pure validators so tests can exercise refusal without native effects.

export async function run(bin, root, attestation) {
  if (!validRoot(root)) return { fixture: 'codex-model-write-stdin/1', status: 'fixture_root_invalid' };
  const paths = ttyRuntimePaths(root);
  const { hostCodexHome, guestCodexHome, workspace, guestAuthPath } = paths;
  const authLink = join(workspace, 'auth-link');
  const report = { fixture: 'codex-model-write-stdin/1', root, status: 'not_started', candidateModel: MODEL,
    calls: [], providerRequests: [], hostExitObserved: false, transportCloseConfirmed: false,
    descendantStop: 'unverified', rootDisposition: 'retained_for_review' };
  let host, provider, state, authReady = false, aliasDirectory = null;
  const authSecret = randomBytes(24).toString('hex');
  const protectedIntact = async () => authReady && await ttyProtectedHostIntact(paths, authLink, authSecret);
  try {
    if (!await isolatedNetwork(process.env.PASSEUR_PARENT_NETNS)) { report.status = 'network_isolation_required'; return report; }
    report.runtimeHomeBind = await inspectTtyRuntimeBinding(paths);
    if (report.runtimeHomeBind !== 'accepted') { report.status = 'runtime_home_bind_unsupported'; return report; }
    const executableBind = await inspectTtyExecutableBinds(paths, process.execPath, bin, attestation);
    if (executableBind.status !== 'accepted') { report.status = executableBind.status; return report; }
    const elf = executableBind.elf; report.nativeExecutableSha256 = executableBind.elfSha;
    await symlink(guestAuthPath, authLink);
    const version = spawnSync(bin, ['--version'], { encoding: 'utf8', env: ttyGuestEnvironment(), timeout: OBSERVE_MS });
    report.observedVersion = version.status === 0 ? version.stdout.trim() : 'unavailable';
    if (report.observedVersion !== VERSION) { report.status = 'version_mismatch'; return report; }
    const probes = ttyProbes(workspace, guestAuthPath, randomBytes(16).toString('hex'), randomBytes(16).toString('hex'));
    state = { probes, issued: [], outputDigests: [], sessions: [], items: new Map(), interactions: new Map(),
      requestCount: 0, completed: 0, liveSession: null, livePhase: null, cleanupIssued: false, failure: null,
      error: null, turnId: null, pendingTurnId: null, threadId: null, turnComplete: false, busy: false,
      stopping: false, nativeEventFault: false };
    provider = createSequencedProvider(state, async (request, response) => {
      const requestIndex = state.requestCount++;
      const refuse = code => { state.error ??= code; response.writeHead(422).end(); };
      const issue = (name, args, callId) => {
        const call = { name, args, callId };
        const sse = ttyCall(state.issued.length, name, args, callId);
        state.issued.push(call);
        if (!sendSseIfActive(state, response, sse)) return refuse(state.error ?? 'provider_stopping');
      };
      const fail = code => {
        state.failure ??= code;
        report.primaryFailure ??= code;
        const native = state.items.get(state.livePhase);
        if (state.liveSession && !native?.completed && !state.cleanupIssued &&
            state.issued.length < MAX_REQUESTS && !state.stopping && !host?.operationFailure && !state.error) {
          state.cleanupIssued = true;
          report.cleanup = { category: 'ctrl_c_issued', sessionId: state.liveSession };
          return issue('write_stdin', { session_id: state.liveSession, chars: '\u0003',
            yield_time_ms: 1000, max_output_tokens: 1000 }, 'call_passeur_cleanup');
        }
        return refuse(code);
      };
      if (requestIndex >= MAX_REQUESTS) return refuse('request_budget');
      let bytes;
      try { bytes = await readBoundedRequest(request); }
      catch (error) { state.error ??= error.message === 'request_body_limit' ? 'request_body_limit' : 'request_interrupted'; response.destroy(); return; }
      if (request.method !== 'POST' || request.url !== '/v1/responses' ||
          Object.keys(request.headers).some(key => ['authorization', 'proxy-authorization', 'x-api-key'].includes(key))) return refuse('provider_route_or_auth');
      let body; try { body = JSON.parse(bytes.toString('utf8')); } catch { return refuse('request_json_invalid'); }
      if (JSON.stringify(body).includes(authSecret)) return refuse('provider_canary_exposed');
      if (stdinSchema(body) !== 'accepted') return refuse('native_schema_changed');
      if (requestIndex === 0 && Array.isArray(body.input) &&
          body.input.some(item => ['function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output'].includes(item?.type))) return refuse('unexpected_initial_call');
      report.providerRequests.push({ index: requestIndex, sha256: sha(bytes), bytes: bytes.length });
      if (requestIndex > 0) {
        const previous = state.issued.length - 1;
        const result = pairedTtyOutput(body, previous, state.issued, state.outputDigests);
        if (result.status !== 'accepted') return fail(result.status);
        if (result.text.includes(authSecret)) return refuse('provider_canary_exposed');
        state.outputDigests[previous] = sha(result.text);
        if (state.cleanupIssued) {
          report.cleanup.category = state.cleanupInteraction ? 'ctrl_c_correlated' : 'ctrl_c_unconfirmed';
          response.writeHead(422).end(); return;
        }
        const phase = Math.floor(previous / 2);
        const probe = probes[phase];
        if (previous % 2 === 0) {
          const parsed = parseSession(result.text);
          if (parsed.status !== 'live') {
            if (phase === 0 && parsed.status === 'session_output_invalid') {
              const captureStateReady = !state.error && !host?.operationFailure && !state.stopping;
              const diagnosticInput = { root, text: result.text, probe, issued: state.issued,
                native: state.items.get(phase), parsed, requestIndex, previous,
                protectedIntact: captureStateReady ? await protectedIntact() : false,
                protectedValues: [authSecret, probes[0].marker, probes[1].marker] };
              const gate = firstSessionDiagnosticGate(diagnosticInput);
              report.captureRefusal = captureStateReady ? gate : { ...gate, category: 'capture_state_unavailable' };
              if (captureStateReady && gate.category === 'eligible') {
                report.diagnostic = await retainFirstSessionDiagnostic(diagnosticInput);
                if (report.diagnostic) delete report.captureRefusal;
                else report.captureRefusal.category = 'artifact_unavailable';
              }
              if (captureStateReady && gate.category === 'native_item_mismatch') {
                const rejectionInput = { ...diagnosticInput, itemsCount: state.items.size,
                  sessions: state.sessions, liveSession: state.liveSession,
                  interactionsCount: state.interactions.size, requestCount: state.requestCount,
                  nativeEventFault: state.nativeEventFault };
                if (firstRejectedCallDiagnosticEligible(rejectionInput)) state.rejectionCandidate = rejectionInput;
              }
            }
            return fail(parsed.status);
          }
          const native = state.items.get(phase);
          if (!native?.started || native.completed || native.processId !== String(parsed.sessionId) ||
              state.sessions.includes(parsed.sessionId)) return fail('session_native_mismatch');
          state.sessions[phase] = parsed.sessionId; state.liveSession = parsed.sessionId; state.livePhase = phase;
          report.calls.push({ callId: state.issued[previous].callId, tool: 'exec_command',
            category: 'live_session', sessionId: parsed.sessionId, outputSha256: sha(result.text) });
          state.completed++;
        } else {
          const parsed = parseExit(result.text);
          const native = state.items.get(phase);
          const interaction = state.interactions.get(phase);
          const fileText = probe.kind === 'positive' ? await readFile(probe.path, 'utf8').catch(() => null) : null;
          const intact = await protectedIntact();
          const category = ttyResult(probe, phase, parsed, native, interaction, state.sessions[phase],
            fileText, intact, result.text);
          report.calls.push({ callId: state.issued[previous].callId, tool: 'write_stdin',
            category, sessionId: state.sessions[phase], outputSha256: sha(result.text) });
          if (phase === 1 && category === 'protected_write_effect_or_uncertain') {
            report.protectedWriteEffectDiagnostic = protectedWriteEffectDiagnostic(probe, phase, parsed, native,
              interaction, state.sessions[phase], intact, category);
          }
          if (!['positive_write', 'denied'].includes(category)) return fail(category);
          state.liveSession = null; state.livePhase = null; state.completed++;
        }
      }
      if (!await protectedIntact()) return fail('host_canary_changed');
      if (host?.operationFailure || state.error || state.stopping) return refuse(state.error ?? 'native_observation_failed');
      if (requestIndex === 0 || requestIndex === 2) {
        const phase = requestIndex / 2;
        return issue('exec_command', ttyExecArgs(probes[phase]), 'call_passeur_exec_' + phase);
      }
      if (requestIndex === 1 || requestIndex === 3) {
        const phase = Math.floor(requestIndex / 2);
        return issue('write_stdin', ttyStdinArgs(state.sessions[phase], probes[phase].marker), 'call_passeur_stdin_' + phase);
      }
      if (requestIndex === 4) {
        if (!sendSseIfActive(state, response, ttyFinal())) return refuse(state.error ?? 'provider_stopping');
        return;
      }
      return refuse('provider_sequence_unknown');
    });
    await new Promise((resolveListen, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolveListen); });
    await writeFile(join(guestCodexHome, 'config.toml'), providerToml(workspace, elf, provider.address().port, MODEL), { mode: 0o600 });
    const events = [];
    host = new CodexStdio({ command: bin,
      args: ['-c', 'mcp_servers={}', '-c', 'features.apps=false', '-c', 'features.plugins=false',
        '-c', 'features.multi_agent=false', '-c', 'web_search="disabled"', 'app-server'],
      cwd: workspace, env: ttyGuestEnvironment(), request: async () => {
        state.nativeEventFault = true;
        state.error ??= 'unexpected_native_server_request'; throw new Error('unexpected native server request');
      }, notification: message => {
        if (events.length >= 128) { state.nativeEventFault = true; state.error ??= 'native_event_limit'; throw new Error('native event limit'); }
        if (JSON.stringify(message).includes(authSecret)) { state.nativeEventFault = true; state.error ??= 'native_canary_exposed'; throw new Error('native canary exposed'); }
        try { recordTtyNative(state, message, [authSecret]); }
        catch (error) { state.nativeEventFault = true; state.error ??= 'native_item_invalid'; throw error; }
        const p = message.params;
        if (message.method === 'turn/completed' && p?.threadId === state.threadId) {
          if (!state.turnId) state.pendingTurnId ??= p?.turn?.id;
          if (p?.turn?.id !== (state.turnId ?? state.pendingTurnId) || p?.turn?.status !== 'completed' || p?.turn?.error) {
            state.nativeEventFault = true;
            state.error ??= 'native_turn_not_completed'; throw new Error('native turn did not complete cleanly');
          }
          if (state.turnComplete) { state.nativeEventFault = true; state.error ??= 'duplicate_native_turn_completion'; throw new Error('duplicate turn completion'); }
          state.turnComplete = true;
        }
        events.push({ method: message.method });
      } });
    report.nativePid = host.pid ?? null;
    if (host.pid && await realpath(await readlink('/proc/' + host.pid + '/exe')) !== elf) { report.status = 'native_executable_mismatch'; return report; }
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), OBSERVE_MS);
    try {
      await host.request('initialize', { clientInfo: { name: 'passeur_codex_model_tty_fixture', version: '1' }, capabilities: { experimentalApi: true } }, controller.signal);
      await host.notify('initialized', undefined, controller.signal);
      const alias = await inspectLiveTtyAlias(hostCodexHome, elf);
      if (alias.status !== 'accepted') { report.status = alias.status; return report; }
      aliasDirectory = alias.aliasDirectory; report.helperAliasLive = true;
      const config = await host.request('config/read', { includeLayers: false, cwd: workspace }, controller.signal);
      if (!effectiveConfig(config).valid || config?.config?.model_provider !== PROVIDER || config?.config?.model !== MODEL) { report.status = 'effective_config_unsupported'; return report; }
      const profiles = await host.request('permissionProfile/list', { cwd: workspace }, controller.signal);
      if (profileAvailability(profiles) !== 'allowed') { report.status = 'profile_unavailable'; return report; }
      const account = await host.request('account/read', { refreshToken: false }, controller.signal);
      if (!accountIsAnonymous(account)) { report.status = 'account_not_anonymous'; return report; }
      await writeFile(guestAuthPath, authSecret, { mode: 0o600 }); authReady = true;
      if (!await protectedIntact()) { report.status = 'host_guest_auth_mismatch'; return report; }
      const thread = await host.request('thread/start', threadRequest(workspace, MODEL), controller.signal);
      if (selectedProfile(thread) !== PROFILE || thread?.model !== MODEL || thread?.modelProvider !== PROVIDER ||
          typeof thread?.thread?.id !== 'string') { report.status = 'thread_profile_unsupported'; return report; }
      state.threadId = thread.thread.id; report.threadId = state.threadId;
      const turn = await host.request('turn/start', { threadId: state.threadId, permissions: PROFILE,
        input: [{ type: 'text', text: 'Use only the exact fixture TTY calls returned by the synthetic provider.' }] }, controller.signal);
      state.turnId = turn?.turn?.id; report.turnId = state.turnId;
      if (typeof state.turnId !== 'string') { report.status = 'turn_start_unsupported'; return report; }
      if (state.pendingTurnId && state.pendingTurnId !== state.turnId) { report.status = 'turn_identity_mismatch'; return report; }
      let poll, deadline;
      await Promise.race([new Promise(resolveObservation => {
        poll = setInterval(() => { if (state.turnComplete || state.error) resolveObservation(); }, 20);
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
    report.helperAliasRetired = aliasDirectory ? report.hostExitObserved && await ttyAliasRetired(aliasDirectory) : null;
    if (aliasDirectory && !report.helperAliasRetired && state) state.error = 'helper_alias_not_retired';
    if (provider) { provider.closeAllConnections(); await new Promise(resolveClose => provider.close(resolveClose)); }
    if (state) {
      report.postStopCanariesIntact = authReady ? await protectedIntact() : null;
      if (report.postStopCanariesIntact === false) state.error ??= 'host_canary_changed_after_stop';
      if (rejectedArtifactStopEligible(report, state, preStopFailure, preStopExit)) {
        report.rejectionDiagnostic = await retainFirstRejectedCallDiagnostic({ ...state.rejectionCandidate,
          native: state.items.get(0), itemsCount: state.items.size, sessions: state.sessions,
          liveSession: state.liveSession, interactionsCount: state.interactions.size,
          requestCount: state.requestCount, nativeEventFault: state.nativeEventFault,
          protectedIntact: await protectedIntact() });
        if (report.rejectionDiagnostic === null) delete report.rejectionDiagnostic;
      }
      state.rejectionCandidate = null;
      report.status = ttyFinalStatus(state, report.transportCloseConfirmed, preStopFailure, preStopExit, report.status);
    }
    await writeFile(join(root, 'bounded-report.json'), emitReport(report), { mode: 0o600 });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const isolated = process.argv[2] === '--isolated';
  const arg = process.argv[isolated ? 3 : 2];
  const rootArg = isolated ? process.argv[4] : null;
  const nodeShaArg = isolated ? process.argv[5] : null;
  const nodeIdentityArg = isolated ? process.argv[6] : null;
  const elfShaArg = isolated ? process.argv[7] : null;
  const elfIdentityArg = isolated ? process.argv[8] : null;
  if (!arg?.startsWith('--codex-bin=/') || isolated &&
      (!rootArg?.startsWith('--fixture-root=/tmp/') || !/^--node-sha=[a-f0-9]{64}$/.test(nodeShaArg ?? '') ||
        !/^--node-identity=[0-9]+:[0-9]+$/.test(nodeIdentityArg ?? '') ||
        !/^--elf-sha=[a-f0-9]{64}$/.test(elfShaArg ?? '') ||
        !/^--elf-identity=[0-9]+:[0-9]+$/.test(elfIdentityArg ?? ''))) {
    process.stderr.write('usage: node scripts/qualify-codex-model-write-stdin.mjs --codex-bin=/absolute/path/to/codex\n');
    process.exitCode = 2;
  }
  else if (!isolated) {
    let paths, nodeHandle, elfHandle;
    try {
      const elf = await realpath(arg.slice('--codex-bin='.length));
      const node = await realpath(process.execPath);
      nodeHandle = await open(node, 'r'); elfHandle = await open(elf, 'r');
      const [nodeStat, elfStat] = await Promise.all([
        nodeHandle.stat({ bigint: true }), elfHandle.stat({ bigint: true })]);
      const attestation = { nodeSha: sha(await nodeHandle.readFile()), elfSha: sha(await elfHandle.readFile()),
        nodeIdentity: `${nodeStat.dev}:${nodeStat.ino}`, elfIdentity: `${elfStat.dev}:${elfStat.ino}` };
      if (!matchesNativeAttestation(elf, attestation.elfSha)) throw new Error('native executable mismatch');
      paths = await prepareTtyRuntimeHome();
      await prepareTtyExecutableTargets(paths, node, elf);
      const args = ttyNamespaceArguments(node, fileURLToPath(import.meta.url), elf,
        await readlink('/proc/self/ns/net'), paths.root, attestation);
      const child = spawnSync('/usr/bin/bwrap', args, { encoding: 'utf8', env: ttyHostEnvironment(paths.home),
        maxBuffer: 131_072, stdio: ['ignore', 'pipe', 'pipe', nodeHandle.fd, elfHandle.fd] });
      if (child.status === null || child.error || !child.stdout) {
        process.stdout.write(`${JSON.stringify({ fixture: 'codex-model-write-stdin/1', root: paths.root,
          status: 'outer_namespace_unavailable' })}\n`);
        process.exitCode = 1;
      } else { process.stdout.write(child.stdout); process.exitCode = child.status; }
    } catch {
      process.stdout.write(`${JSON.stringify({ fixture: 'codex-model-write-stdin/1', root: paths?.root ?? null,
        status: 'fixture_prepare_failed' })}\n`);
      process.exitCode = 1;
    } finally { await nodeHandle?.close().catch(() => undefined); await elfHandle?.close().catch(() => undefined); }
  } else {
    const report = await run(arg.slice('--codex-bin='.length), rootArg.slice('--fixture-root='.length), {
      nodeSha: nodeShaArg.slice('--node-sha='.length),
      nodeIdentity: nodeIdentityArg.slice('--node-identity='.length),
      elfSha: elfShaArg.slice('--elf-sha='.length),
      elfIdentity: elfIdentityArg.slice('--elf-identity='.length) }); const output = emitReport(report);
    process.stdout.write(output); process.exitCode = JSON.parse(output).status === 'sampled_tty_boundary_passed' ? 0 : 1;
  }
}
