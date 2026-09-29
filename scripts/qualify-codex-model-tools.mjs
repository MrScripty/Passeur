import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, readlink, realpath, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchesNativeAttestation, profileToml, profileAvailability, effectiveConfig, selectedEnvironment } from './qualify-codex-protected-boundary.mjs';
import { CodexStdio } from '../dist/src/agents/codex/transport.js';

// Stage one discovers the installed model-tool declarations. No model call is emitted.
const VERSION = 'codex-cli 0.157.1';
const PROVIDER = 'passeur_fixture_loopback';
const PROFILE = 'passeur-boundary';
const NATIVE_ELF = '/home/jeremy/.nvm/versions/node/v24.12.0/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex';
const MAX_BODY = 262_144;
const MAX_PROJECTION = 32_768;
const DEADLINE_MS = 10_000;

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

export function providerToml(workspace, elf, port, model) {
  if (elf !== NATIVE_ELF || !Number.isInteger(port) || port < 1 || port > 65535 ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(model)) throw new Error('unverified provider configuration');
  return `model = "${model}"\nmodel_provider = "${PROVIDER}"\ndisable_response_storage = true\n` +
    profileToml(workspace, elf) +
    `[model_providers.${PROVIDER}]\nname = "Passeur fixture"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`;
}

export function threadRequest(workspace, model) {
  return { cwd: workspace, model, modelProvider: PROVIDER, permissions: PROFILE, ephemeral: true,
    allowProviderModelFallback: false };
}

export function turnRequest(threadId) {
  return { threadId, permissions: PROFILE, input: [{ type: 'text', text: 'Fixture only: wait for the synthetic provider. Do not infer a result.' }] };
}

export function selectedProfile(result) {
  const profile = result?.activePermissionProfile;
  return profile?.id === PROFILE ? PROFILE : 'unknown';
}

export function accountIsAnonymous(result) {
  return result?.account === null && result?.requiresOpenaiAuth === false;
}

export function namespaceArguments(node, script, bin, parentNetNs, model) {
  if (!node.startsWith('/') || !script.startsWith('/') || !bin.startsWith('/') || !/^net:\[\d+\]$/.test(parentNetNs) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(model)) throw new Error('invalid namespace launch');
  return ['--unshare-user', '--unshare-net', '--die-with-parent', '--ro-bind', '/', '/', '--bind', '/tmp', '/tmp',
    '--proc', '/proc', '--dev-bind', '/dev', '/dev', '--setenv',
    'PASSEUR_PARENT_NETNS', parentNetNs, '--', node, script, '--isolated', `--codex-bin=${bin}`, `--model=${model}`];
}

export async function isolatedNetwork(parentNetNs) {
  if (!/^net:\[\d+\]$/.test(parentNetNs)) return false;
  const current = await readlink('/proc/self/ns/net');
  if (current === parentNetNs) return false;
  const dev = await readFile('/proc/net/dev', 'utf8');
  const interfaces = dev.split('\n').slice(2).map(line => line.split(':')[0]?.trim()).filter(Boolean);
  return interfaces.length === 1 && interfaces[0] === 'lo';
}

export function projectSchema(schema, depth = 0) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || depth > 5) return { kind: 'unsupported' };
  const properties = schema.properties;
  if (properties !== undefined && (typeof properties !== 'object' || properties === null || Array.isArray(properties) ||
      Object.keys(properties).length > 64)) return { kind: 'unsupported' };
  const required = schema.required;
  if (required !== undefined && (!Array.isArray(required) || required.length > 64 ||
      required.some(name => typeof name !== 'string' || name.length > 80))) return { kind: 'unsupported' };
  const type = typeof schema.type === 'string' ? schema.type : Array.isArray(schema.type) && schema.type.length <= 8 &&
    schema.type.every(item => typeof item === 'string') ? [...schema.type] : 'unknown';
  const projected = { kind: 'schema', type, required: required === undefined ? null : [...required].sort(),
    additionalProperties: schema.additionalProperties === false ? false : schema.additionalProperties === true ? true : 'unknown',
    properties: [] };
  for (const [name, value] of Object.entries(properties ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (name.length > 80) return { kind: 'unsupported' };
    projected.properties.push({ name, schema: projectSchema(value, depth + 1) });
  }
  if (schema.items !== undefined) projected.items = projectSchema(schema.items, depth + 1);
  return projected;
}

export function projectTools(body, model) {
  if (!body || body.model !== model || !Array.isArray(body.tools) || body.tools.length === 0 || body.tools.length > 128) {
    return { status: 'unsupported_request_shape' };
  }
  const names = new Set();
  const tools = [];
  for (const [index, tool] of body.tools.entries()) {
    const name = tool?.name;
    if (typeof name !== 'string' || !/^[a-zA-Z_][\w.]{0,79}$/.test(name) || names.has(name)) return { status: 'unsupported_tool_identity', index };
    names.add(name);
    const parameters = projectSchema(tool.parameters);
    if (JSON.stringify(parameters).includes('"kind":"unsupported"')) return { status: 'schema_projection_incomplete', index };
    tools.push({ index, name, type: typeof tool.type === 'string' ? tool.type : 'unknown',
      schemaSha256: tool.parameters && typeof tool.parameters === 'object' ? sha(JSON.stringify(tool.parameters)) : null,
      schemaKeys: tool.parameters && typeof tool.parameters === 'object' ? Object.keys(tool.parameters).sort() : [],
      parameters,
      descriptionBytes: typeof tool.description === 'string' ? Buffer.byteLength(tool.description) : null });
    if (Buffer.byteLength(JSON.stringify(tools)) > MAX_PROJECTION) return { status: 'projection_limit', index, toolCount: body.tools.length };
  }
  return { status: 'tool_declarations_captured', tools };
}

export function inspectProviderRequest(request, body, model) {
  if (request.method !== 'POST' || request.url !== '/v1/responses') return { status: 'unexpected_destination' };
  if (Object.keys(request.headers).some(key => ['authorization', 'proxy-authorization', 'x-api-key'].includes(key))) return { status: 'unexpected_auth_header' };
  let parsed;
  try { parsed = JSON.parse(body.toString('utf8')); } catch { return { status: 'invalid_json' }; }
  return { ...projectTools(parsed, model), requestSha256: sha(body), requestBytes: body.length };
}

export function createDiscoveryProvider(observations, model) {
  let count = 0;
  return createServer(async (request, response) => {
    count++;
    if (count > 1) { observations.push({ status: 'request_budget_exceeded' }); response.writeHead(429).end(); return; }
    const chunks = []; let length = 0;
    try {
      for await (const chunk of request) {
        length += chunk.length;
        if (length > MAX_BODY) { observations.push({ status: 'request_body_limit' }); response.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
    } catch {
      observations.push({ status: 'request_interrupted' });
      response.destroy();
      return;
    }
    const result = inspectProviderRequest(request, Buffer.concat(chunks), model);
    observations.push(result);
    // Deliberately refuse continuation: the exact installed SSE/tool-call contract is not yet observed.
    response.writeHead(422, { 'content-type': 'application/json' }).end('{"error":{"message":"fixture stops after tool declaration capture"}}');
  });
}

export function discoveryStatus(observations, transportClosed, priorStatus, { preStopFailure = null, preStopExit = false, observationOutcome = null } = {}) {
  if (!transportClosed) return 'transport_stop_unconfirmed';
  if (preStopFailure || preStopExit || observationOutcome === 'native_failed') return 'native_failed_before_stop';
  if (priorStatus && !['not_started', 'tool_declarations_captured', 'provider_request_unobserved'].includes(priorStatus)) return priorStatus;
  if (observations.length !== 1) return observations.length === 0 ? 'provider_request_unobserved' : 'provider_sequence_unsupported';
  return observations[0].status === 'tool_declarations_captured' ? 'tool_declarations_captured' : observations[0].status;
}

export function emitReport(report) {
  const serialized = JSON.stringify(report);
  if (Buffer.byteLength(serialized) <= 65_536) return `${serialized}\n`;
  return `${JSON.stringify({ fixture: 'codex-model-tools/discovery-1', status: 'report_output_limit',
    root: report.root ?? null, rootDisposition: report.rootDisposition ?? null,
    reportSha256: sha(serialized), reportBytes: Buffer.byteLength(serialized) })}\n`;
}

function native(bin, cwd, env, events) {
  return new CodexStdio({ command: bin, args: ['-c', 'mcp_servers={}', '-c', 'features.apps=false',
    '-c', 'features.plugins=false', '-c', 'features.multi_agent=false', '-c', 'web_search="disabled"', 'app-server'],
  cwd, env, request: async () => { throw new Error('unexpected native server request'); }, notification: message => {
    if (events.length >= 32) throw new Error('native event limit');
    const item = message.params?.item;
    const bounded = value => typeof value === 'string' && /^[a-zA-Z0-9/_.:-]{1,128}$/.test(value) ? value : null;
    events.push({ method: bounded(message.method), threadId: bounded(message.params?.threadId),
      turnId: bounded(message.params?.turn?.id ?? message.params?.turnId),
      itemId: bounded(item?.id), itemType: bounded(item?.type) });
  } });
}

async function stop(host) {
  if (!host) return false;
  return host.close(3000);
}

function observeFirstRequest(observations, host) {
  let interval, timer;
  const observed = new Promise(resolveObservation => {
    interval = setInterval(() => { if (observations.length) resolveObservation('observed'); }, 20);
    timer = setTimeout(() => resolveObservation('observation_elapsed'), DEADLINE_MS);
  });
  return Promise.race([observed, host.failure.then(() => 'native_failed', () => 'native_failed')])
    .finally(() => { clearInterval(interval); clearTimeout(timer); });
}

export async function run(bin, model) {
  if (!await isolatedNetwork(process.env.PASSEUR_PARENT_NETNS)) return { fixture: 'codex-model-tools/discovery-1', status: 'network_isolation_required' };
  const root = await mkdtemp(join(tmpdir(), 'passeur-codex-model-tools-'));
  const home = join(root, 'home'), codexHome = join(home, 'codex'), workspace = join(root, 'work');
  const observations = [], events = [];
  const report = { fixture: 'codex-model-tools/discovery-1', root, status: 'not_started',
    provider: { id: PROVIDER, model, route: 'loopback-only', stage: 'declaration_discovery' },
    observations, events, hostExitObserved: false, descendantStop: 'unverified', rootDisposition: 'retained_for_review' };
  let host, server;
  try {
    await mkdir(codexHome, { recursive: true, mode: 0o700 }); await mkdir(workspace); await chmod(home, 0o700);
    await writeFile(join(workspace, 'allowed'), 'synthetic workspace read\n');
    const version = spawnSync(bin, ['--version'], { encoding: 'utf8', env: selectedEnvironment(home), timeout: DEADLINE_MS });
    report.observedVersion = version.status === 0 ? version.stdout.trim() : 'unavailable';
    if (report.observedVersion !== VERSION) { report.status = 'version_mismatch'; return report; }
    const elf = await realpath(bin);
    const digest = sha(await readFile(elf));
    report.nativeExecutableSha256 = digest;
    if (!matchesNativeAttestation(elf, digest)) { report.status = 'native_executable_mismatch'; return report; }
    server = createDiscoveryProvider(observations, model);
    await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
    const port = server.address().port;
    await writeFile(join(codexHome, 'config.toml'), providerToml(workspace, elf, port, model), { mode: 0o600 });
    const env = selectedEnvironment(home);
    // Do not pass through account, proxy or provider keys from the caller.
    host = native(bin, workspace, env, events);
    report.nativePid = host.pid ?? null;
    if (host.pid) {
      const runningElf = await realpath(await readlink(`/proc/${host.pid}/exe`));
      if (runningElf !== elf) { report.status = 'native_executable_mismatch'; return report; }
    }
    const controller = new AbortController();
    const observationTimer = setTimeout(() => controller.abort(), DEADLINE_MS);
    const ask = (method, params) => host.request(method, params, controller.signal);
    try {
    const initialized = await ask('initialize', { clientInfo: { name: 'passeur_codex_model_tools_fixture', version: '1' }, capabilities: { experimentalApi: true } });
    if (!initialized) { report.status = 'initialize_unsupported'; return report; }
    await host.notify('initialized', undefined, controller.signal);
    const config = await ask('config/read', { includeLayers: false, cwd: workspace });
    report.effectiveConfig = effectiveConfig(config);
    report.providerSelected = config?.config?.model_provider === PROVIDER && config?.config?.model === model;
    if (!report.effectiveConfig.valid || !report.providerSelected) { report.status = 'effective_config_unsupported'; return report; }
    const profiles = await ask('permissionProfile/list', { cwd: workspace });
    if (profileAvailability(profiles) !== 'allowed') { report.status = 'profile_unavailable'; return report; }
    const account = await ask('account/read', { refreshToken: false });
    report.anonymous = accountIsAnonymous(account);
    if (!report.anonymous) { report.status = 'account_not_anonymous'; return report; }
    // Place a synthetic auth-named canary after config/account preflight to avoid auth parser interference.
    await writeFile(join(codexHome, 'auth.json'), randomBytes(24).toString('hex'), { mode: 0o600 });
    const thread = await ask('thread/start', threadRequest(workspace, model));
    const threadId = thread?.thread?.id;
    report.activePermissionProfile = selectedProfile(thread);
    report.threadId = typeof threadId === 'string' ? threadId : null;
    if (!report.threadId || thread?.model !== model || thread?.modelProvider !== PROVIDER ||
        report.activePermissionProfile !== PROFILE) { report.status = 'thread_profile_unsupported'; return report; }
    const turn = await ask('turn/start', turnRequest(report.threadId));
    report.turnId = turn?.turn?.id ?? null;
    if (typeof report.turnId !== 'string') { report.status = 'turn_start_unsupported'; return report; }
    report.observationOutcome = await observeFirstRequest(observations, host);
    report.status = observations[0]?.status ?? 'provider_request_unobserved';
    return report;
    } finally { clearTimeout(observationTimer); }
  } catch (error) {
    report.status = 'fixture_error'; report.error = { code: typeof error?.code === 'string' ? error.code : 'UNKNOWN', stage: 'no_account_discovery' };
    return report;
  } finally {
    const preStopFailure = typeof host?.operationFailure?.code === 'string' ? host.operationFailure.code : null;
    const preStopExit = Boolean(host?.exitEvidence);
    report.transportCloseConfirmed = await stop(host);
    report.hostExitObserved = Boolean(host?.exitEvidence);
    report.nativeFailureCode = typeof host?.operationFailure?.code === 'string' ? host.operationFailure.code : null;
    if (server) {
      server.closeAllConnections();
      await new Promise(resolveClose => server.close(resolveClose));
    }
    report.status = discoveryStatus(observations, report.transportCloseConfirmed || !host, report.status,
      { preStopFailure, preStopExit, observationOutcome: report.observationOutcome });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const isolated = process.argv[2] === '--isolated';
  const binArg = process.argv[isolated ? 3 : 2];
  const modelArg = process.argv[isolated ? 4 : 3];
  const model = modelArg?.startsWith('--model=') ? modelArg.slice('--model='.length) : '';
  if (!binArg?.startsWith('--codex-bin=/') || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(model)) { process.stderr.write('usage: node scripts/qualify-codex-model-tools.mjs --codex-bin=/absolute/path/to/codex --model=operator-selected-id\n'); process.exitCode = 2; }
  else if (!isolated) {
    const parentNetNs = await readlink('/proc/self/ns/net');
    const args = namespaceArguments(process.execPath, fileURLToPath(import.meta.url), binArg.slice('--codex-bin='.length), parentNetNs, model);
    const child = spawnSync('/usr/bin/bwrap', args, { encoding: 'utf8', env: selectedEnvironment(join(tmpdir(), 'passeur-no-account-wrapper')),
      maxBuffer: 131_072 });
    if (child.status === null || child.error) {
      process.stdout.write(`${JSON.stringify({ fixture: 'codex-model-tools/discovery-1', status: 'network_namespace_unavailable' })}\n`);
      process.exitCode = 1;
    } else { process.stdout.write(child.stdout); process.exitCode = child.status; }
  }
  else {
    const report = await run(binArg.slice('--codex-bin='.length), model);
    const output = emitReport(report);
    process.stdout.write(output);
    process.exitCode = JSON.parse(output).status === 'tool_declarations_captured' ? 0 : 1;
  }
}
