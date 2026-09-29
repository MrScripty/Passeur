import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { connect } from 'node:net';
import { providerToml, threadRequest, turnRequest, selectedProfile, accountIsAnonymous,
  projectTools, projectSchema, inspectProviderRequest, createDiscoveryProvider, discoveryStatus,
  emitReport, namespaceArguments, isolatedNetwork } from '../../scripts/qualify-codex-model-tools.mjs';

const elf = '/home/jeremy/.nvm/versions/node/v24.12.0/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex';
const model = 'operator-selected-model';
const sha = input => createHash('sha256').update(input).digest('hex');

test('fixture config binds one loopback provider and named permission profile', () => {
  const config = providerToml('/tmp/fixture/work', elf, 42123, model);
  assert.match(config, /model_provider = "passeur_fixture_loopback"/);
  assert.match(config, /base_url = "http:\/\/127\.0\.0\.1:42123\/v1"/);
  assert.match(config, /wire_api = "responses"/);
  assert.match(config, /requires_openai_auth = false/);
  assert.match(config, /default_permissions = "passeur-boundary"/);
  assert.match(config, /enabled = false/);
  assert.equal(config.includes('api_key'), false);
  assert.throws(() => providerToml('/tmp/fixture/work', '/usr/bin/codex', 42123, model));
});

test('thread and turn requests select one profile without legacy sandbox fields or model fallback', () => {
  assert.deepEqual(threadRequest('/tmp/work', model), { cwd: '/tmp/work', model: model,
    modelProvider: 'passeur_fixture_loopback', permissions: 'passeur-boundary', ephemeral: true,
    allowProviderModelFallback: false });
  const turn = turnRequest('thread-1');
  assert.equal(turn.permissions, 'passeur-boundary');
  assert.equal(turn.threadId, 'thread-1');
  assert.equal(Object.hasOwn(turn, 'sandboxPolicy'), false);
  assert.equal(Object.hasOwn(threadRequest('/tmp/work', model), 'sandbox'), false);
});

test('exact active profile and anonymous account are prerequisites', () => {
  assert.equal(selectedProfile({ activePermissionProfile: { id: 'passeur-boundary' } }), 'passeur-boundary');
  assert.equal(selectedProfile({ activePermissionProfile: { id: ':workspace' } }), 'unknown');
  assert.equal(selectedProfile({}), 'unknown');
  assert.equal(accountIsAnonymous({ account: null, requiresOpenaiAuth: false }), true);
  assert.equal(accountIsAnonymous({ account: { type: 'chatgpt' }, requiresOpenaiAuth: false }), false);
  assert.equal(accountIsAnonymous({ account: null, requiresOpenaiAuth: true }), false);
});

test('request projector captures exact bounded declarations without argument or description values', () => {
  const body = { model: model, tools: [{ name: 'shell_command', type: 'function',
    description: 'sensitive synthetic text', parameters: { type: 'object', properties: { command: { type: 'string' } } } }] };
  const projected = projectTools(body, model);
  assert.equal(projected.status, 'tool_declarations_captured');
  assert.deepEqual(projected.tools, [{ index: 0, name: 'shell_command', type: 'function',
    schemaSha256: sha(JSON.stringify(body.tools[0].parameters)), schemaKeys: ['properties', 'type'],
    parameters: { kind: 'schema', type: 'object', required: null, additionalProperties: 'unknown', properties: [
      { name: 'command', schema: { kind: 'schema', type: 'string', required: null, additionalProperties: 'unknown', properties: [] } }] },
    descriptionBytes: 24 }]);
  assert.equal(JSON.stringify(projected).includes('sensitive'), false);
  assert.equal(projectTools({ ...body, model: 'other' }, model).status, 'unsupported_request_shape');
  assert.equal(projectTools({ ...body, tools: [...body.tools, body.tools[0]] }, model).status, 'unsupported_tool_identity');
  assert.deepEqual(projectSchema({ type: 'object', description: 'synthetic secret', properties: { x: { type: 'integer' } } }).properties[0].name, 'x');
  assert.equal(projectTools({ model, tools: Array.from({ length: 40 }, (_, index) => ({ name: `tool_${index}`, type: 'function',
    parameters: { type: 'object', properties: Object.fromEntries(Array.from({ length: 20 }, (_, n) => [`argument_${n}`, { type: 'string' }])) } })) }, model).status, 'projection_limit');
  assert.equal(projectTools({ model, tools: [{ name: 'deep', type: 'function', parameters: { type: 'object',
    properties: { a: { type: 'object', properties: { b: { type: 'object', properties: { c: { type: 'object',
      properties: { d: { type: 'object', properties: { e: { type: 'object', properties: { f: { type: 'string' } } } } } } } } } } } } } }] }, model).status, 'schema_projection_incomplete');
});

test('provider rejects auth, alternate route, unknown shape and repeat request without issuing tool calls', async () => {
  const valid = Buffer.from(JSON.stringify({ model: model, tools: [{ name: 'read_file', type: 'function', parameters: { type: 'object' } }] }));
  assert.equal(inspectProviderRequest({ method: 'POST', url: '/v1/responses', headers: {} }, valid, model).status, 'tool_declarations_captured');
  assert.equal(inspectProviderRequest({ method: 'POST', url: '/v1/responses', headers: { authorization: 'Bearer fake' } }, valid, model).status, 'unexpected_auth_header');
  assert.equal(inspectProviderRequest({ method: 'POST', url: '/other', headers: {} }, valid, model).status, 'unexpected_destination');
  assert.equal(inspectProviderRequest({ method: 'POST', url: '/v1/responses', headers: {} }, Buffer.from('bad'), model).status, 'invalid_json');
  const observations = []; const server = createDiscoveryProvider(observations, model);
  const send = async () => {
    const request = Readable.from([valid]); request.method = 'POST'; request.url = '/v1/responses'; request.headers = {};
    const response = { status: null, writeHead(code) { this.status = code; return this; }, end() {} };
    server.emit('request', request, response);
    await new Promise(resolve => setImmediate(resolve));
    return response.status;
  };
  assert.equal(await send(), 422);
  assert.equal(await send(), 429);
  assert.deepEqual(observations.map(x => x.status), ['tool_declarations_captured', 'request_budget_exceeded']);
  assert.equal(discoveryStatus(observations, true, 'tool_declarations_captured'), 'provider_sequence_unsupported');
  assert.equal(discoveryStatus([observations[0]], false, 'tool_declarations_captured'), 'transport_stop_unconfirmed');
  assert.equal(discoveryStatus([observations[0]], true, 'tool_declarations_captured'), 'tool_declarations_captured');
  assert.equal(discoveryStatus([observations[0]], true, 'tool_declarations_captured', { preStopFailure: 'CODEX_PROTOCOL_INVALID' }), 'native_failed_before_stop');
  assert.equal(discoveryStatus([observations[0]], true, 'tool_declarations_captured', { preStopExit: true }), 'native_failed_before_stop');
  assert.equal(discoveryStatus([observations[0]], true, 'tool_declarations_captured', { observationOutcome: 'native_failed' }), 'native_failed_before_stop');
  const aborted = Readable.from((async function* () { yield Buffer.from('{'); throw new Error('aborted'); })());
  aborted.method = 'POST'; aborted.url = '/v1/responses'; aborted.headers = {};
  const response = { destroyed: false, destroy() { this.destroyed = true; }, writeHead() { return this; }, end() {} };
  const abortedObservations = []; createDiscoveryProvider(abortedObservations, model).emit('request', aborted, response);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(abortedObservations, [{ status: 'request_interrupted' }]);
  assert.equal(response.destroyed, true);
});

test('exact emitted report remains below the wrapper cap and retains failed root identity', () => {
  const normal = emitReport({ root: '/tmp/fixture-root', status: 'tool_declarations_captured', observations: [{ status: 'tool_declarations_captured' }] });
  assert.equal(JSON.parse(normal).status, 'tool_declarations_captured');
  const oversized = emitReport({ root: '/tmp/fixture-root', rootDisposition: 'retained_for_review', observations: ['x'.repeat(120_000)] });
  assert.ok(Buffer.byteLength(oversized) < 65_536);
  assert.deepEqual(Object.keys(JSON.parse(oversized)).sort(), ['fixture', 'reportBytes', 'reportSha256', 'root', 'rootDisposition', 'status']);
  assert.equal(JSON.parse(oversized).status, 'report_output_limit');
  assert.equal(JSON.parse(oversized).root, '/tmp/fixture-root');
});

test('outer namespace launch requires a distinct loopback-only network namespace', async () => {
  const args = namespaceArguments('/usr/bin/node', '/tmp/script.mjs', elf, 'net:[123]', model);
  assert.deepEqual(args.slice(0, 5), ['--unshare-user', '--unshare-net', '--die-with-parent', '--ro-bind', '/']);
  assert.ok(args.includes('--isolated'));
  assert.throws(() => namespaceArguments('node', '/tmp/script.mjs', elf, 'net:[123]', model));
  assert.equal(await isolatedNetwork('invalid'), false);
});

test('aborted partial local request settles and server cleanup completes', async t => {
  const observations = []; const server = createDiscoveryProvider(observations, model);
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
      const timer = setInterval(() => { if (observations.length) { clearInterval(timer); resolveObservation(); } }, 10);
    }), new Promise((_, reject) => setTimeout(() => reject(new Error('partial request did not settle')), 1000))]);
    assert.deepEqual(observations, [{ status: 'request_interrupted' }]);
  } finally {
    server.closeAllConnections();
    await new Promise(resolveClose => server.close(resolveClose));
  }
});
