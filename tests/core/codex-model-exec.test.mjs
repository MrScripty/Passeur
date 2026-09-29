import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { connect } from 'node:net';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classify, createSequencedProvider, execSchema, finalStatus, outputForCall, probes,
  readBoundedRequest, recordNativeItem, retainProtectedWriteDiagnostic, presentedCommand, callArgs,
  sendSseIfActive, sseCall, sseFinal } from '../../scripts/qualify-codex-model-exec.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const model = 'gpt-5.3-codex';
const names = ['exec_command', 'write_stdin', 'request_user_input', 'view_image', 'get_goal', 'create_goal', 'update_goal'];

test('exact accepted inventory and schema gate the first call', () => {
  const parameters = { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'], additionalProperties: false };
  const body = { model, tools: names.map(name => ({ type: 'function', name, parameters })) };
  const digest = sha(JSON.stringify(parameters));
  assert.equal(execSchema(body, digest), 'accepted');
  assert.equal(execSchema(body), 'exec_schema_mismatch');
  assert.equal(execSchema({ ...body, model: 'other' }, digest), 'inventory_mismatch');
  assert.equal(execSchema({ ...body, tools: body.tools.slice(1) }, digest), 'inventory_mismatch');
  assert.equal(execSchema({ ...body, tools: [{ ...body.tools[0], parameters: { ...parameters, required: [] } }, ...body.tools.slice(1)] }, digest), 'exec_schema_mismatch');
});

test('version-matched SSE emits one fixed exec call, created and completed in order', () => {
  const probe = { cmd: '/usr/bin/cat allowed', workspace: '/tmp/work' };
  const events = sseCall(2, probe).trim().split('\n\n').map(frame => {
    const [event, data] = frame.split('\n'); return { event: event.slice(7), data: JSON.parse(data.slice(6)) };
  });
  assert.deepEqual(events.map(value => value.event), ['response.created', 'response.output_item.done', 'response.completed']);
  assert.equal(events[1].data.item.call_id, 'call_passeur_exec_2');
  assert.equal(events[1].data.item.name, 'exec_command');
  assert.deepEqual(JSON.parse(events[1].data.item.arguments), callArgs(probe));
  assert.deepEqual(sseFinal().trim().split('\n\n').map(frame => frame.split('\n')[0]),
    ['event: response.created', 'event: response.output_item.done', 'event: response.completed']);
});

test('probe sequence covers workspace controls, every protected route and network', () => {
  const targets = ['dummy-auth', 'oracle', 'sibling', 'common-git'].map(name => ({ name,
    path: `/tmp/${name}/canary`, link: `/tmp/work/link-${name}` }));
  const list = probes('/tmp/work', targets, 43210, 'write-marker');
  assert.equal(list.length, 27);
  assert.deepEqual(list.slice(0, 2).map(item => item.kind), ['positive_read', 'positive_write']);
  assert.equal(list.filter(item => item.kind === 'denied_read').length, 12);
  assert.equal(list.filter(item => item.kind === 'denied_write').length, 12);
  for (const item of list.filter(probe => probe.kind === 'denied_write')) {
    assert.equal(item.cmd, `printf %s write-marker | /usr/bin/tee -- ${item.path} >/dev/null`);
  }
  assert.equal(list[1].cmd, 'printf %s write-marker > /tmp/work/written');
  assert.deepEqual([...new Set(list.filter(item => item.route).map(item => item.route))], ['direct', 'symlink', 'proc']);
  assert.equal(list.at(-1).kind, 'denied_network');
  assert.equal(list.at(-1).cmd.includes('127.0.0.1:43210'), true);
  assert.equal(list[0].cmd, '/usr/bin/cat -- /tmp/work/allowed');
  assert.equal(presentedCommand(list[0].cmd), "/bin/bash -c '/usr/bin/cat -- /tmp/work/allowed'");
  assert.doesNotThrow(() => probes('/tmp/passeur-codex-model-exec-Ab1-2', targets, 43210, 'a1b2'));
  assert.throws(() => probes('/tmp/work;touch /tmp/x', targets, 43210, 'a1b2'));
});

test('continuation requires exact call, arguments, output and no foreign IDs', () => {
  const probe = { cmd: '/usr/bin/cat allowed', workspace: '/tmp/work' };
  const call = { type: 'function_call', call_id: 'call_passeur_exec_0', name: 'exec_command', arguments: JSON.stringify(callArgs(probe)) };
  const output = { type: 'function_call_output', call_id: 'call_passeur_exec_0', output: 'synthetic output' };
  const body = { input: [call, output] };
  assert.deepEqual(outputForCall(body, 0, probe), { status: 'accepted', text: 'synthetic output' });
  assert.deepEqual(outputForCall({ input: [call, { ...output, output: [{ type: 'input_text', text: 'synthetic output' }] }] }, 0, probe),
    { status: 'accepted', text: 'synthetic output' });
  assert.equal(outputForCall({ input: [call, { ...output, call_id: 'other' }] }, 0, probe).status, 'call_output_mismatch');
  assert.equal(outputForCall({ input: [{ ...call, arguments: '{}' }, output] }, 0, probe).status, 'call_output_mismatch');
  assert.equal(outputForCall({ input: [call, output, { ...call, call_id: 'call_passeur_exec_1' }] }, 0, probe).status, 'unexpected_call');
  assert.equal(outputForCall({ input: [call, { ...output, output: [{ type: 'input_text', text: 'a' }, { type: 'input_text', text: 'b' }] }] }, 0, probe).status, 'output_shape_unknown');
  assert.equal(outputForCall({ input: [call, output, call] }, 0, probe).status, 'call_output_mismatch');
  const prior = { type: 'function_call', call_id: 'call_passeur_exec_0', name: 'exec_command', arguments: JSON.stringify(callArgs({ cmd: 'prior', workspace: '/tmp/work' })) };
  const next = { type: 'function_call', call_id: 'call_passeur_exec_1', name: 'exec_command', arguments: JSON.stringify(callArgs({ cmd: 'next', workspace: '/tmp/work' })) };
  const nextOutput = { type: 'function_call_output', call_id: 'call_passeur_exec_1', output: 'done' };
  assert.equal(outputForCall({ input: [prior, next, nextOutput] }, 1, { cmd: 'next', workspace: '/tmp/work' },
    [{ cmd: 'prior', workspace: '/tmp/work' }, { cmd: 'next', workspace: '/tmp/work' }]).status, 'historical_pair_mismatch');
});

test('native command item binds exact call id and rejects duplicates and wrong turn', () => {
  const state = { probes: [{ cmd: 'fixed command' }], items: new Map(), threadId: 'thread-1', turnId: null, pendingTurnId: null };
  const params = { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'commandExecution', id: 'call_passeur_exec_0', command: presentedCommand('fixed command'), status: 'inProgress' } };
  assert.equal(recordNativeItem(state, { method: 'item/started', params }, ['synthetic-secret']), true);
  assert.equal(state.pendingTurnId, 'turn-1');
  assert.throws(() => recordNativeItem(state, { method: 'item/started', params }, []), /duplicate/);
  assert.throws(() => recordNativeItem(state, { method: 'item/completed', params: { ...params, turnId: 'turn-2' } }, []), /turn mismatch/);
  assert.throws(() => recordNativeItem(state, { method: 'item/completed', params: { ...params, item: { ...params.item, id: 'other' } } }, []), /call id mismatch/);
  const completed = { ...params, item: { ...params.item, status: 'failed', exitCode: 1, aggregatedOutput: 'denied' } };
  assert.throws(() => recordNativeItem(state, { method: 'item/completed', params: { ...completed,
    item: { ...completed.item, aggregatedOutput: 'synthetic-secret' } } }, ['synthetic-secret']), /exposed/);
  assert.equal(recordNativeItem(state, { method: 'item/completed', params: completed }, ['synthetic-secret']), true);
  assert.throws(() => recordNativeItem(state, { method: 'item/completed', params: completed }, []), /duplicate/);
  assert.equal(recordNativeItem(state, { method: 'item/started', params: { ...params,
    item: { type: 'userMessage', id: 'user-1' } } }, []), false);
  assert.throws(() => recordNativeItem(state, { method: 'item/started', params: { ...params,
    item: { type: 'fileChange', id: 'change-1' } } }, []), /unexpected native operation/);
});

test('classification needs native start/completion, exact result and host controls', () => {
  const read = { kind: 'positive_read', cmd: '/usr/bin/cat allowed' };
  const item = { command: presentedCommand(read.cmd), status: 'completed', exitCode: 0, output: 'allowed-marker', outputBytes: 14, canaryExposed: false };
  assert.equal(classify(read, 'allowed-marker', item, ['secret-canary'], 'allowed-marker', 'write-marker', 'allowed-marker', true, true), 'positive_read');
  assert.equal(classify(read, 'allowed-marker', item, ['secret-canary'], 'allowed-marker', 'write-marker', 'allowed-marker', true, false), 'native_item_start_missing');
  assert.equal(classify(read, 'allowed-marker', { ...item, output: 'different' }, ['secret-canary'], 'allowed-marker', 'write-marker', 'allowed-marker', true, true), 'native_output_mismatch');
  assert.equal(classify(read, 'secret-canary', item, ['secret-canary'], 'allowed-marker', 'write-marker', 'allowed-marker', true, true), 'canary_exposed');
  const write = { kind: 'positive_write', cmd: 'write allowed' };
  assert.equal(classify(write, '', { ...item, command: presentedCommand(write.cmd), output: '' }, [], 'allowed-marker', 'write-marker', 'write-marker', true, true), 'positive_write');
  assert.equal(classify(write, '', { ...item, command: presentedCommand(write.cmd), output: null, outputBytes: 0 }, [], 'allowed-marker', 'write-marker', 'write-marker', true, true), 'positive_write');
  assert.equal(classify(write, '', { ...item, command: presentedCommand(write.cmd), output: '' }, [], 'allowed-marker', 'write-marker', 'other', true, true), 'positive_write_failed');
});

test('protected and network denial require attributable failure and intact host control', () => {
  const probe = { kind: 'denied_read', path: '/tmp/protected/canary', cmd: "cat '/tmp/protected/canary'" };
  const item = { command: presentedCommand(probe.cmd), status: 'failed', exitCode: 1, output: `cat: ${probe.path}: Permission denied`, outputBytes: 45 };
  assert.equal(classify(probe, item.output, item, ['hidden-canary'], 'allowed', 'write', true, true, true), 'denied');
  assert.equal(classify(probe, 'Permission denied', { ...item, output: 'Permission denied' }, ['hidden-canary'], 'allowed', 'write', true, true, true), 'denial_unattributed');
  const spoofed = `unrelated native output\ncat: ${probe.path}: Permission denied`;
  assert.equal(classify(probe, spoofed, { ...item, output: 'unrelated native output' }, ['hidden-canary'], 'allowed', 'write', true, true, true), 'denial_unattributed');
  assert.equal(classify(probe, item.output, item, ['hidden-canary'], 'allowed', 'write', false, true, true), 'protected_effect_or_uncertain');
  const network = { kind: 'denied_network', cmd: 'curl localhost', port: 43210 };
  const result = { ...item, command: presentedCommand(network.cmd), exitCode: 7,
    output: 'curl: (7) Failed to connect to 127.0.0.1 port 43210 after 0 ms' };
  assert.equal(classify(network, result.output, result, [], 'allowed', 'write', true, true, true), 'denied');
  assert.equal(classify(network, 'bwrap: sandbox setup: Permission denied', { ...result, exitCode: 1,
    output: 'bwrap: sandbox setup: Permission denied' }, [], 'allowed', 'write', true, true, true), 'network_denial_unattributed');
  assert.equal(classify(network, result.output, result, [], 'allowed', 'write', false, false, true), 'network_control_or_effect_failed');
  assert.equal(classify(network, result.output, result, [], 'allowed', 'write', true, true, true, 1), 'network_control_or_effect_failed');
});

test('terminal status rejects incomplete sequence, provider fault and uncertain stop', () => {
  const state = { error: null, requestCount: 28, completed: 27, probes: Array(27) };
  assert.equal(finalStatus(state, true, null, false, true, 'native_turn_observed'), 'sampled_exec_boundary_passed');
  assert.equal(finalStatus(state, false, null, false, true, 'native_turn_observed'), 'transport_stop_unconfirmed');
  assert.equal(finalStatus(state, true, 'CODEX_PROTOCOL_INVALID', false, true, 'native_turn_observed'), 'native_failed_before_stop');
  assert.equal(finalStatus({ ...state, error: 'unexpected_call' }, true, null, false, true, 'native_turn_observed'), 'unexpected_call');
  assert.equal(finalStatus({ ...state, completed: 26 }, true, null, false, true, 'native_turn_observed'), 'sequence_incomplete');
  assert.equal(finalStatus(state, true, null, false, false, 'observation_elapsed'), 'observation_elapsed');
});

test('overlap and stop during awaited provider check cannot dispatch another SSE', async () => {
  const state = { busy: false, error: null, stopping: false };
  let release; const barrier = new Promise(resolve => { release = resolve; });
  const server = createSequencedProvider(state, async (_request, response) => {
    await barrier;
    sendSseIfActive(state, response, 'event: response.created\n\n');
  });
  const response = () => ({ status: null, writes: 0, headersSent: false,
    writeHead(code) { this.status = code; this.headersSent = true; return this; },
    end() { this.writes++; }, destroy() {} });
  const first = response(), second = response();
  server.emit('request', Readable.from([]), first);
  server.emit('request', Readable.from([]), second);
  assert.equal(second.status, 409);
  state.stopping = true; release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(first.writes, 0);
  assert.equal(state.error, 'provider_overlap_or_late_request');
});

test('partial body and body limit fail without a provider response', async () => {
  const broken = Readable.from((async function* () { yield Buffer.from('{'); throw new Error('connection lost'); })());
  await assert.rejects(readBoundedRequest(broken), /connection lost/);
  const huge = Readable.from([Buffer.alloc(262_145)]);
  await assert.rejects(readBoundedRequest(huge), /request_body_limit/);
});

test('aborted partial local request settles the sequenced provider', async t => {
  const state = { busy: false, error: null, stopping: false };
  const server = createSequencedProvider(state, async (request, response) => {
    await readBoundedRequest(request);
    sendSseIfActive(state, response, 'event: response.created\n\n');
  });
  try {
    await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') { t.skip('local listen denied by current test sandbox'); return; }
    throw error;
  }
  try {
    const socket = connect(server.address().port, '127.0.0.1');
    await new Promise((resolveConnect, reject) => { socket.once('connect', resolveConnect); socket.once('error', reject); });
    socket.write('POST /v1/responses HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 100\r\n\r\n{');
    socket.destroy();
    await Promise.race([new Promise(resolveObservation => {
      const timer = setInterval(() => { if (state.error) { clearInterval(timer); resolveObservation(); } }, 10);
    }), new Promise((_, reject) => setTimeout(() => reject(new Error('partial provider request did not settle')), 1000))]);
    assert.equal(state.error, 'provider_handler_failed');
    assert.equal(state.busy, false);
  } finally {
    state.stopping = true; server.closeAllConnections();
    await new Promise(resolveClose => server.close(resolveClose));
  }
});

test('first unattributed fixed protected write retains capped native output in a private artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'passeur-codex-model-exec-diagnostic-test-'));
  const targets = ['dummy-auth', 'oracle', 'sibling', 'common-git'].map(name => ({ name,
    path: `/tmp/${name}/canary`, link: `/tmp/work/link-${name}`, secret: `${name}-secret` }));
  const writeMarker = 'syntheticwrite';
  const probe = probes('/tmp/work', targets, 43210, writeMarker)[3];
  const output = `tee: ${probe.path}: No such file or directory\nsyntheticwrite`;
  const item = { id: 'call_passeur_exec_3', started: true, completed: {
    command: presentedCommand(probe.cmd), status: 'failed', exitCode: 1,
    output, outputBytes: Buffer.byteLength(output) } };
  const checks = [];
  const args = { index: 3, probe, category: 'denial_unattributed', item, targets, writeMarker, root,
    check: async (...checkArgs) => { checks.push(checkArgs); return true; } };
  try {
    const result = await retainProtectedWriteDiagnostic(args);
    assert.deepEqual(result, { category: 'denial_unattributed',
      path: join(root, 'first-protected-write-native-output.txt'), sha256: sha(output), bytes: Buffer.byteLength(output) });
    assert.equal((await lstat(result.path)).mode & 0o777, 0o600);
    assert.equal((await readFile(result.path, 'utf8')), output);
    assert.equal(checks.length, 12);
    assert.equal(JSON.stringify(result).includes(output), false);
    assert.equal(finalStatus({ error: 'denial_unattributed' }, true, null, false, false, 'denial_unattributed'), 'denial_unattributed');
    assert.equal((await retainProtectedWriteDiagnostic({ ...args, existingArtifact: true })).category, 'diagnostic_gate_refused');
    await assert.rejects(retainProtectedWriteDiagnostic(args), { code: 'EEXIST' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('proc dummy-auth write at fixed index 7 can retain the first unattributed diagnostic', async () => {
  const targets = ['dummy-auth', 'oracle', 'sibling', 'common-git'].map(name => ({ name,
    path: `/tmp/${name}/canary`, link: `/tmp/work/link-${name}`, secret: `${name}-secret` }));
  const probe = probes('/tmp/work', targets, 43210, 'syntheticwrite')[7];
  assert.equal(probe.target, 'dummy-auth');
  assert.equal(probe.route, 'proc');
  const output = `tee: ${probe.path}: Permission denied\n`;
  const item = { id: 'call_passeur_exec_7', started: true, completed: {
    command: presentedCommand(probe.cmd), status: 'failed', exitCode: 1,
    output, outputBytes: Buffer.byteLength(output) } };
  let writes = 0;
  let recorded;
  const base = { index: 7, probe, category: 'denial_unattributed', item, targets,
    writeMarker: 'syntheticwrite', root: '/tmp/synthetic-diagnostic-root',
    check: async () => true, write: async (...args) => { writes++; recorded = args; } };
  assert.deepEqual(await retainProtectedWriteDiagnostic(base), {
    category: 'denial_unattributed', path: '/tmp/synthetic-diagnostic-root/first-protected-write-native-output.txt',
    sha256: sha(output), bytes: Buffer.byteLength(output) });
  assert.equal(writes, 1);
  assert.deepEqual(recorded[1], Buffer.from(output));
  assert.deepEqual(recorded[2], { mode: 0o600, flag: 'wx' });
  assert.equal((await retainProtectedWriteDiagnostic({ ...base, existingArtifact: true })).category, 'diagnostic_gate_refused');
  assert.equal(writes, 1);
});

test('diagnostic refuses other probes, overlength, canary exposure and changed host canary before write', async () => {
  const targets = ['dummy-auth', 'oracle', 'sibling', 'common-git'].map(name => ({ name,
    path: `/tmp/${name}/canary`, link: `/tmp/work/link-${name}`, secret: `${name}-secret` }));
  const marker = 'syntheticwrite';
  const probe = probes('/tmp/work', targets, 43210, marker)[3];
  let writes = 0;
  const itemFor = output => ({ id: 'call_passeur_exec_3', started: true, completed: {
    command: presentedCommand(probe.cmd), status: 'failed', exitCode: 1,
    output, outputBytes: Buffer.byteLength(output) } });
  const base = { index: 3, probe, category: 'denial_unattributed', item: itemFor('synthetic diagnostic'),
    targets, writeMarker: marker, root: '/tmp/synthetic-diagnostic-root',
    check: async () => true, write: async () => { writes++; } };
  assert.equal((await retainProtectedWriteDiagnostic({ ...base, index: 2 })).category, 'diagnostic_gate_refused');
  assert.equal((await retainProtectedWriteDiagnostic({ ...base, probe: { ...probe, target: 'missing' } })).category, 'diagnostic_gate_refused');
  assert.equal((await retainProtectedWriteDiagnostic({ ...base, probe: { ...probe, target: 'oracle' } })).category, 'diagnostic_gate_refused');
  assert.equal((await retainProtectedWriteDiagnostic({ ...base, probe: { ...probe, route: 'proc' } })).category, 'diagnostic_gate_refused');
  assert.equal((await retainProtectedWriteDiagnostic({ ...base, probe: { ...probe,
    cmd: probe.cmd.replace(' >/dev/null', '') } })).category, 'diagnostic_gate_refused');
  assert.equal((await retainProtectedWriteDiagnostic({ ...base, item: { ...base.item, id: 'call_passeur_exec_7' } })).category, 'diagnostic_gate_refused');
  assert.equal((await retainProtectedWriteDiagnostic({ ...base, item: { ...base.item,
    completed: { ...base.item.completed, status: 'completed' } } })).category, 'diagnostic_gate_refused');
  assert.equal((await retainProtectedWriteDiagnostic({ ...base, item: { ...base.item,
    completed: { ...base.item.completed, exitCode: 2 } } })).category, 'diagnostic_gate_refused');
  assert.equal((await retainProtectedWriteDiagnostic({ ...base, targets: targets.slice(0, 3) })).category, 'diagnostic_gate_refused');
  assert.equal((await retainProtectedWriteDiagnostic({ ...base, category: 'denied' })).category, 'diagnostic_gate_refused');
  assert.equal((await retainProtectedWriteDiagnostic({ ...base, item: { ...base.item, started: false } })).category, 'diagnostic_gate_refused');
  assert.equal((await retainProtectedWriteDiagnostic({ ...base, item: itemFor('x'.repeat(257)) })).category, 'diagnostic_overlength_or_invalid_utf8');
  assert.equal((await retainProtectedWriteDiagnostic({ ...base, item: itemFor(targets[1].secret) })).category, 'diagnostic_canary_exposed');
  assert.equal((await retainProtectedWriteDiagnostic({ ...base, item: { ...base.item,
    completed: { ...base.item.completed, canaryExposed: true } } })).category, 'diagnostic_canary_exposed');
  assert.equal((await retainProtectedWriteDiagnostic({ ...base, check: async (route, path) => !(route === 'symlink' && path === targets[2].link) })).category,
    'diagnostic_host_canary_changed');
  assert.equal(writes, 0);
});
