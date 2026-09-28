import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, mkdir, lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { assertSocketIdentity, relaySandboxConfig, requestDecision, startBroker,
  startGuestRelay, captureFixtureProcesses, verifyFixtureStop,
  validateNativeSse, startNativeUpstream, nativeRejectionProjection,
  stageNativeRuntime, guestNativeFixture } from '../../scripts/qualify-muse-credential-relay.mjs';
import { prepareSandbox } from '../../scripts/experiment-worker-sandbox.mjs';
import { readFileCanaryFixture, shellProbeCommand } from '../../scripts/qualify-muse-sandbox-transport.mjs';

const runId = 'run_0123456789abcdef01234567';
const model = 'fixture-relay-model';
const dummy = 'passeur-disposable-dummy-key';
const REQUEST_OVERSIZE = 9_000;

function request(method, url, headers = {}) {
  const defaults = { host: '127.0.0.1:1', authorization: `Bearer ${dummy}`,
    'x-passeur-run': runId, connection: 'close' };
  const combined = { ...defaults, ...headers };
  return { method, url, headers: combined, rawHeaders: Object.entries(combined).flat() };
}
function body(value) { return Buffer.from(JSON.stringify(value)); }
const policy = { runId, model, allowedInputs: ['fixture'] };
const nativeExtras = { include: ['reasoning.encrypted_content'], instructions: 'synthetic instructions',
  max_output_tokens: 128_000, prompt_cache_key: 'x'.repeat(45), store: false, stream: true };

test('exact broker method, route, run and model are the only accepted requests', () => {
  assert.deepEqual(requestDecision(request('GET', '/muse-code/models'), Buffer.alloc(0), policy),
    { ok: true, route: 'catalog', body: Buffer.alloc(0) });
  assert.deepEqual(requestDecision(request('POST', '/responses', { 'content-type': 'application/json' }),
    body({ model, input: 'fixture', tools: [] }), policy), { ok: true, route: 'responses',
      body: body({ model, input: 'fixture', tools: [] }) });
  const duplicate = Buffer.from(`{"model":"${model}","input":"unapproved-source",` +
    '"input":"fixture","tools":[]}');
  const admitted = requestDecision(request('POST', '/responses', { 'content-type': 'application/json' }),
    duplicate, policy);
  assert.equal(admitted.ok, true);
  assert.equal(admitted.body.toString().includes('unapproved-source'), false);
  for (const [item, payload] of [
    [request('GET', '/responses'), Buffer.alloc(0)],
    [request('POST', '/muse-code/models'), body({ model, input: 'x' })],
    [request('CONNECT', '127.0.0.1:80'), Buffer.alloc(0)],
    [request('GET', 'http://127.0.0.1:9999/muse-code/models'), Buffer.alloc(0)],
    [request('GET', '/muse-code/models', { 'x-passeur-run': 'run_other' }), Buffer.alloc(0)],
    [request('POST', '/responses', { 'content-type': 'application/json' }),
      body({ model: 'other', input: 'fixture' })],
    [request('POST', '/responses', { 'content-type': 'application/json' }),
      body({ model, input: 'unapproved source' })],
    [request('POST', '/responses', { 'content-type': 'application/json' }),
      body({ model, input: 'fixture', tools: [], extra: 'source' })],
  ]) assert.equal(requestDecision(item, payload, policy).ok, false);
});

test('native read profile is separate and forwards only canonical reviewed envelope fields', () => {
  const native = { ...policy, profile: 'native-read', model: 'fixture-native-shell',
    workspace: '/tmp/native-fixture/workspace' };
  const post = request('POST', '/responses', { 'content-type': 'application/json' });
  const envelope = { model: native.model, input: 'NATIVE_READ_FILE_PROBE', ...nativeExtras, tools: [{
    type: 'namespace', name: 'muse', tools: [{ type: 'function', name: 'submit_reminder_decision',
      parameters: { type: 'object', properties: {} } }] }] };
  const accepted = requestDecision(post, body(envelope), native);
  assert.equal(accepted.ok, true);
  assert.deepEqual(JSON.parse(accepted.body), { model: native.model,
    input: envelope.input, tools: envelope.tools });
  assert.equal(requestDecision(post, body(envelope), policy).ok, false);
  const duplicate = Buffer.from(JSON.stringify(envelope).replace('"input":',
    '"unreviewed":"secret-source","input":'));
  assert.deepEqual(requestDecision(post, duplicate, native),
    { ok: false, code: 'NATIVE_TOP_LEVEL_FIELDS' });
  const invalidUtf8 = body(envelope);
  const instructionOffset = invalidUtf8.indexOf(Buffer.from(nativeExtras.instructions));
  assert.ok(instructionOffset > 0);
  for (const byte of [0xff, 0xc3]) {
    const changed = Buffer.from(invalidUtf8);
    changed[instructionOffset] = byte;
    assert.deepEqual(requestDecision(post, changed, native),
      { ok: false, code: 'BODY_INVALID' });
  }
  for (const [changed, expected] of [
    [[], 'NATIVE_ENVELOPE_TYPE'],
    [{ ...envelope, model: 'foreign' }, 'NATIVE_MODEL_INVALID'],
    [{ ...envelope, include: [] }, 'NATIVE_INCLUDE_INVALID'],
    [{ ...envelope, include: ['reasoning.encrypted_content', 'other'] }, 'NATIVE_INCLUDE_INVALID'],
    [{ ...envelope, instructions: '' }, 'NATIVE_INSTRUCTIONS_INVALID'],
    [{ ...envelope, instructions: 'x'.repeat(32_769) }, 'NATIVE_INSTRUCTIONS_INVALID'],
    [{ ...envelope, instructions: '\ud800' }, 'NATIVE_INSTRUCTIONS_INVALID'],
    [{ ...envelope, max_output_tokens: 127_999 }, 'NATIVE_OUTPUT_TOKENS_INVALID'],
    [{ ...envelope, prompt_cache_key: 'x'.repeat(44) }, 'NATIVE_CACHE_KEY_INVALID'],
    [{ ...envelope, prompt_cache_key: 'x'.repeat(44) + '\n' }, 'NATIVE_CACHE_KEY_INVALID'],
    [{ ...envelope, store: true }, 'NATIVE_MODE_INVALID'],
    [{ ...envelope, stream: false }, 'NATIVE_MODE_INVALID'],
    [{ ...envelope, input: 'child prompt without marker' }, 'NATIVE_INPUT_INVALID'],
    [{ ...envelope, input: [{ type: 'message', role: 'user', content: 'child prompt' }] },
      'NATIVE_INITIAL_CONTEXT_INVALID'],
    [{ ...envelope, previous_response_id: 'foreign' }, 'NATIVE_RESPONSE_REFERENCE_INVALID'],
    [{ ...envelope, tools: [] }, 'NATIVE_TOOLS_INVALID'],
  ]) assert.equal(requestDecision(post, body(changed), native).code, expected);
  for (const changed of [
    { ...envelope, model },
    { ...envelope, include: undefined },
    { ...envelope, extra: 'secret-source' },
    { ...envelope, previous_response_id: 'foreign' },
    { ...envelope, previous_response_id: 'resp_native_shell_1' },
    { ...envelope, input: [{ type: 'function_call_output', call_id: 'foreign', output: 'x' }] },
    { ...envelope, input: [{ type: 'message', role: 'user', content: 'x', extra: 'source' }] },
    { ...envelope, input: [{ type: 'message', role: 'user', content: 'unreviewed prompt' }] },
    { ...envelope, input: [{ type: 'function_call', id: 'foreign',
      call_id: 'call_native_read_file_1', name: 'muse.read_file', arguments: '{}' }] },
    { ...envelope, tools: [] },
    { ...envelope, tools: [...envelope.tools, ...envelope.tools] },
    { ...envelope, tools: [{ ...envelope.tools[0], tools: [
      ...envelope.tools[0].tools, { type: 'function', name: 'extra' }] }] },
    { ...envelope, tools: [{ ...envelope.tools[0], tools: [
      { ...envelope.tools[0].tools[0], source: 'unapproved' }] }] },
  ]) assert.equal(requestDecision(post, body(changed), native).ok, false);
  assert.equal(requestDecision(request('GET', '/muse-code/models'), Buffer.alloc(0), native).ok, true);
  const call = { type: 'function_call', id: 'fc_native_read_file_1',
    call_id: 'call_native_read_file_1', name: 'muse.read_file', arguments:
      JSON.stringify({ path: join(native.workspace, 'read-canary.txt'), offset: 1, limit: 20 }) };
  const exact = requestDecision(post, body({ ...envelope, input: [call] }), native);
  assert.equal(exact.ok, true);
  const smuggled = { ...call, arguments: `{"unapproved":"secret-source",` +
    `"path":"${join(native.workspace, 'read-canary.txt')}","offset":1,"limit":20}` };
  assert.equal(requestDecision(post, body({ ...envelope, input: [smuggled] }), native).ok, false);
  const duplicatePath = { ...call, arguments: `{"path":"/tmp/foreign/secret-source",` +
    `"path":"${join(native.workspace, 'read-canary.txt')}","offset":1,"limit":20}` };
  const canonical = requestDecision(post, body({ ...envelope, input: [duplicatePath] }), native);
  assert.equal(canonical.ok, true);
  assert.equal(canonical.body.toString().includes('secret-source'), false);
  assert.equal(requestDecision(post, body({ ...envelope,
    input: [{ ...call, arguments: JSON.stringify({ path: '/tmp/foreign/read-canary.txt',
      offset: 1, limit: 20 }) }] }), native).ok, false);
});

test('native cache key admits only 45 or 46 printable ASCII bytes and remains omitted', () => {
  const nativePolicy = { ...policy, profile: 'native-read', model: 'fixture-native-shell',
    workspace: '/tmp/native-fixture/workspace' };
  const post = request('POST', '/responses', { 'content-type': 'application/json' });
  const base = { model: nativePolicy.model, input: 'NATIVE_READ_FILE_PROBE', ...nativeExtras,
    tools: [{ type: 'namespace', name: 'muse', tools: [{ type: 'function',
      name: 'submit_reminder_decision', parameters: {} }] }] };
  const firstKey = 'A'.repeat(45);
  const secondKey = 'B'.repeat(46);
  const first = requestDecision(post, body({ ...base, prompt_cache_key: firstKey }), nativePolicy);
  const second = requestDecision(post, body({ ...base, prompt_cache_key: secondKey }), nativePolicy);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual(first.body, second.body);
  assert.equal(JSON.parse(second.body).prompt_cache_key, undefined);
  const validProjection = nativeRejectionProjection(body({ ...base,
    prompt_cache_key: secondKey }), { index: 1, stage: 'replay', code: 'NATIVE_REQUEST_REPLAY' });
  assert.equal(validProjection.diagnostic.violations.NATIVE_CACHE_KEY_INVALID, undefined);
  for (const key of [undefined, null, 46, '', 'x'.repeat(44), 'x'.repeat(47),
    'x'.repeat(45) + '\n', '\0' + 'x'.repeat(44), 'x'.repeat(44) + '\x7f',
    'x'.repeat(22) + '\x1f' + 'x'.repeat(22), 'x'.repeat(44) + 'é',
    'x'.repeat(44) + '😀']) {
    const payload = body({ ...base, prompt_cache_key: key });
    assert.equal(requestDecision(post, payload, nativePolicy).code,
      key === undefined ? 'NATIVE_TOP_LEVEL_FIELDS' : 'NATIVE_CACHE_KEY_INVALID');
    const projected = nativeRejectionProjection(payload,
      { index: 2, stage: 'admission', code: 'NATIVE_CACHE_KEY_INVALID' });
    assert.equal(projected.diagnostic.violations.NATIVE_CACHE_KEY_INVALID, 1);
    if (key === 'x'.repeat(45) + '\n')
      assert.equal(projected.topLevel.observedExtraFieldShapes.promptCacheKey.format, 'other');
    const artifact = `${JSON.stringify(projected)}\n`;
    if (typeof key === 'string' && key.length >= 40) assert.equal(artifact.includes(key), false);
    assert.ok(Buffer.byteLength(artifact) <= 4_096);
  }
});

test('native SSE requires complete ordered events and one completed terminal', () => {
  const frames = [
    { type: 'response.created', sequence_number: 1 },
    { type: 'response.completed', sequence_number: 2, response: { status: 'completed' } },
  ];
  const encode = values => Buffer.from(values.map(value => `data: ${JSON.stringify(value)}\n\n`).join(''));
  assert.deepEqual(validateNativeSse(encode(frames)), { events: 2 });
  for (const invalid of [encode(frames).subarray(0, -1), encode(frames.slice(0, 1)),
    encode([{ ...frames[0], type: 'response.output_item.added' }, frames[1]]),
    encode([frames[0], { ...frames[1], sequence_number: 3 }]),
    encode([frames[0], { ...frames[1], response: { status: 'in_progress' } }]),
    encode([frames[0], { ...frames[1], type: 'response.unreviewed' }]),
    Buffer.from('data: {bad}\n\n'),
    Buffer.from('data: [DONE]\n\n')]) {
    assert.throws(() => validateNativeSse(invalid), { code: 'NATIVE_STREAM_INVALID' });
  }
});

test('native rejected POST projection is bounded and contains no request values', () => {
  const secret = 'secret-source-and-dummy-bearer';
  const payload = body({ model: secret, input: Array.from({ length: 30 }, () =>
    ({ type: 'message', id: secret, content: secret, call_id: secret, arguments: secret })),
  tools: Array.from({ length: 6 }, () => ({ type: 'namespace', name: secret,
    tools: Array.from({ length: 20 }, () => ({ type: 'function', name: secret,
      description: secret, parameters: { type: 'object', description: secret } })) })),
  [secret]: secret, stream: true, store: false, reasoning: { summary: secret },
  max_output_tokens: 42, instructions: secret, prompt_cache_key: secret,
  include: ['reasoning.encrypted_content', ...Array.from({ length: 20 }, () => secret)] });
  const projection = nativeRejectionProjection(payload,
    { index: 7, stage: 'admission', code: 'NATIVE_TOOLS_INVALID' });
  const serialized = JSON.stringify(projection);
  assert.equal(serialized.includes(secret), false);
  assert.ok(Buffer.byteLength(serialized) < 4096);
  assert.equal(projection.byteCount, payload.length);
  assert.equal(projection.capturedByteCount, payload.length);
  assert.equal(projection.omittedByteCount, 0);
  assert.equal(projection.input.omittedItems, 22);
  assert.equal(projection.tools.omittedNamespaces, 4);
  assert.ok(projection.tools.toolClasses[0].omittedFunctions >= 16);
  assert.deepEqual(projection.failedPredicates, ['NATIVE_TOOLS_INVALID']);
  assert.deepEqual(projection.topLevel.recognizedExtraFieldTypes,
    { include: 'array', instructions: 'string', max_output_tokens: 'number',
      prompt_cache_key: 'string', reasoning: 'object', store: 'boolean', stream: 'boolean' });
  assert.equal(projection.topLevel.unknownFieldCount, 8);
  assert.equal(projection.topLevel.unrecognizedExtraFieldCount, 1);
  assert.deepEqual(projection.topLevel.observedExtraFieldShapes.include,
    { count: 21, members: ['reasoning.encrypted_content', ...Array(7).fill('other')],
      omittedMembers: 13 });
  assert.equal(projection.topLevel.observedExtraFieldShapes.instructions.byteCount,
    Buffer.byteLength(secret));
  assert.equal(projection.topLevel.observedExtraFieldShapes.maxOutputTokens.safePositiveValue, 42);
  assert.deepEqual(projection.topLevel.observedExtraFieldShapes.promptCacheKey,
    { byteCount: Buffer.byteLength(secret), format: 'printable_ascii' });
  assert.equal(projection.topLevel.observedExtraFieldShapes.store, false);
  assert.equal(projection.topLevel.observedExtraFieldShapes.stream, true);
  assert.deepEqual(projection.topLevel.observedExtraFieldShapes.reasoning,
    { class: 'object', memberCount: 1, moreMembers: false,
      recognizedMembers: { summary: { class: 'string', byteCount: Buffer.byteLength(secret),
        moreBytes: false } }, unknownMemberCount: 0 });
});

test('optional native reasoning has exact bounded opaque fields', () => {
  const secret = 'secret-reasoning-content-and-header';
  const nativePolicy = { ...policy, profile: 'native-read', model: 'fixture-native-shell',
    workspace: '/tmp/native-fixture/workspace' };
  const post = request('POST', '/responses', { 'content-type': 'application/json' });
  const envelope = { model: nativePolicy.model, input: 'NATIVE_READ_FILE_PROBE', ...nativeExtras,
    tools: [{ type: 'namespace', name: 'muse', tools: [{ type: 'function',
      name: 'submit_reminder_decision', parameters: { type: 'object' } }] }] };
  for (const reasoning of [{ effort: 'high', summary: 'auto' },
    { effort: '😀'.repeat(16), summary: 's'.repeat(64) }]) {
    const accepted = requestDecision(post, body({ ...envelope, reasoning }), nativePolicy);
    assert.equal(accepted.ok, true);
    assert.equal(JSON.parse(accepted.body).reasoning, undefined);
  }
  for (const reasoning of [{}, { effort: 'high' }, { effort: 'high', summary: '' },
    { effort: 'x'.repeat(65), summary: 'auto' },
    { effort: '😀'.repeat(17), summary: 'auto' },
    { effort: '\ud800', summary: 'auto' },
    { effort: 'high', summary: 'auto', [secret]: secret },
    { effort: 1, summary: 'auto' }, null, [], secret]) {
    const payload = body({ ...envelope, reasoning });
    assert.equal(requestDecision(post, payload, nativePolicy).code, 'NATIVE_REASONING_INVALID');
    const projection = nativeRejectionProjection(payload,
      { index: 1, stage: 'admission', code: 'NATIVE_REASONING_INVALID' });
    assert.equal(projection.diagnostic.violations.NATIVE_REASONING_INVALID, 1);
    assert.equal(JSON.stringify(projection).includes(secret), false);
    assert.ok(Buffer.byteLength(`${JSON.stringify(projection)}\n`) <= 4_096);
  }
  assert.equal(requestDecision(post, body({ ...envelope, [secret]: secret }), nativePolicy).code,
    'NATIVE_TOP_LEVEL_FIELDS');
});

test('aggregate transport diagnosis crosses independent reachable branches', () => {
  const secret = 'secret-metadata-key-and-reasoning';
  const nativePolicy = { ...policy, profile: 'native-read', model: 'fixture-native-shell',
    workspace: '/tmp/native-fixture/workspace' };
  const post = request('POST', '/responses', { 'content-type': 'application/json' });
  const tools = [{ type: 'namespace', name: 'muse', tools: Array.from({ length: 25 },
    (_, index) => ({ type: 'function', name: index === 1 ? 'read_file' : `native_${index}`,
      parameters: index === 13 ? { [secret]: '\ud800', minimum: secret } : {} })) }];
  const payload = body({ model: nativePolicy.model, input: 'NATIVE_READ_FILE_PROBE',
    ...nativeExtras, reasoning: { effort: secret }, tools });
  assert.equal(requestDecision(post, payload, nativePolicy).code, 'NATIVE_REASONING_INVALID');
  const projection = nativeRejectionProjection(payload,
    { index: 1, stage: 'admission', code: 'NATIVE_REASONING_INVALID' });
  assert.equal(projection.diagnostic.coverage.functions, 25);
  assert.equal(projection.diagnostic.violations.NATIVE_REASONING_INVALID, 1);
  assert.equal(projection.diagnostic.violations.SCHEMA_UNICODE, 1);
  assert.equal(projection.diagnostic.violations.SCHEMA_KEYS, undefined);
  assert.equal(projection.diagnostic.violations.SCHEMA_NUMBER, undefined);
  assert.ok(projection.diagnostic.examples.some(example =>
    example.code === 'SCHEMA_UNICODE' && example.functionIndex === 13));
  assert.equal(JSON.stringify(projection).includes(secret), false);
  assert.ok(Buffer.byteLength(`${JSON.stringify(projection)}\n`) <= 4_096);
  const invalidInput = body({ model: nativePolicy.model, input: [[[['x']]]], ...nativeExtras,
    tools, reasoning: {} });
  assert.equal(requestDecision(post, invalidInput, nativePolicy).code, 'NATIVE_REASONING_INVALID');
  const blocked = nativeRejectionProjection(invalidInput,
    { index: 2, stage: 'admission', code: 'NATIVE_REASONING_INVALID' }).diagnostic;
  assert.equal(blocked.coverage.blockedParents.initialContext, 1);
  assert.equal(blocked.coverage.unexaminedInitialContextChecks, 1);
  assert.equal(blocked.violations.SCHEMA_UNICODE, 1);
});

test('aggregate distinguishes unexamined metadata from omitted violation examples', () => {
  const secret = 'secret-metadata-content';
  const parameters = { values: Array.from({ length: 9_000 }, (_, index) =>
    index < 20 ? '\ud800' : secret) };
  const payload = body({ model: 'fixture-native-shell', input: 'NATIVE_READ_FILE_PROBE',
    ...nativeExtras, tools: [{ type: 'namespace', name: 'muse', tools: [{ type: 'function',
      name: 'submit_reminder_decision', parameters }] }] });
  assert.ok(payload.length < 262_144);
  const projection = nativeRejectionProjection(payload,
    { index: 1, stage: 'admission', code: 'NATIVE_TOOLS_INVALID' });
  assert.equal(projection.diagnostic.coverage.schemaNodes, 8_192);
  assert.ok(projection.diagnostic.coverage.unexaminedSchemaSubtrees > 0);
  assert.ok(projection.diagnostic.violations.SCHEMA_UNICODE >= 20);
  assert.ok(projection.diagnostic.violationsOmittedFromExamples > 0);
  assert.equal(JSON.stringify(projection).includes(secret), false);
  assert.ok(Buffer.byteLength(`${JSON.stringify(projection)}\n`) <= 4_096);
});

test('deep invalid input leaves independent metadata diagnosis intact', () => {
  const ordinary = JSON.stringify({ model: 'fixture-native-shell',
    input: 'NATIVE_READ_FILE_PROBE', ...nativeExtras,
    tools: [{ type: 'namespace', name: 'muse', tools: [{ type: 'function',
      name: 'submit_reminder_decision', parameters: { value: '\ud800' } }] }],
    reasoning: {} });
  const deepInput = `${'['.repeat(10_000)}"x"${']'.repeat(10_000)}`;
  const payload = Buffer.from(ordinary.replace('"input":"NATIVE_READ_FILE_PROBE"',
    `"input":${deepInput}`));
  const nativePolicy = { ...policy, profile: 'native-read', model: 'fixture-native-shell',
    workspace: '/tmp/native-fixture/workspace' };
  const post = request('POST', '/responses', { 'content-type': 'application/json' });
  assert.ok(payload.length < 262_144);
  assert.equal(requestDecision(post, payload, nativePolicy).code, 'NATIVE_REASONING_INVALID');
  const projection = nativeRejectionProjection(payload,
    { index: 1, stage: 'admission', code: 'NATIVE_REASONING_INVALID' });
  assert.equal(projection.diagnostic.coverage.blockedParents.initialContext, 1);
  assert.equal(projection.diagnostic.coverage.unexaminedInitialContextChecks, 1);
  assert.equal(projection.diagnostic.violations.SCHEMA_UNICODE, 1);
  assert.ok(Buffer.byteLength(`${JSON.stringify(projection)}\n`) <= 4_096);
});

test('maximum recognized field projection trims samples under the artifact limit', () => {
  const secret = 'secret-value-must-not-appear';
  const extraNames = ['background', 'conversation', 'include', 'instructions',
    'max_output_tokens', 'max_tool_calls', 'metadata', 'parallel_tool_calls',
    'prompt', 'prompt_cache_key', 'prompt_cache_retention', 'reasoning',
    'safety_identifier', 'service_tier', 'store', 'stream', 'stream_options',
    'temperature', 'text', 'tool_choice', 'top_logprobs', 'top_p', 'truncation', 'user'];
  const extras = Object.fromEntries(extraNames.map(name => [name, secret]));
  Object.assign(extras, { include: Array(8).fill('message.input_image.image_url'),
    instructions: secret, max_output_tokens: 256, prompt_cache_key: secret,
    store: false, stream: true });
  const payload = body({ model: 'fixture-native-shell',
    input: Array.from({ length: 8 }, () => ({ type: 'message', role: 'user', content: secret })),
    tools: Array.from({ length: 2 }, () => ({ type: 'namespace', name: secret,
      tools: Array.from({ length: 4 }, () => ({ type: 'function', name: secret,
        parameters: { type: 'object', properties: Object.fromEntries(
          Array.from({ length: 16 }, (_, i) => [`field${i}`, { type: 'string' }])) } })) })),
    ...extras });
  assert.ok(payload.length <= 262_144);
  const projection = nativeRejectionProjection(payload,
    { index: 1, stage: 'admission', code: 'NATIVE_TOP_LEVEL_FIELDS' });
  const artifact = `${JSON.stringify(projection)}\n`;
  assert.ok(Buffer.byteLength(artifact) <= 4_096);
  assert.equal(artifact.includes(secret), false);
  assert.equal(projection.topLevel.unrecognizedExtraFieldCount, 0);
  assert.ok(projection.tools.toolClasses.some(namespace => namespace.omittedFunctions > 0) ||
    projection.input.omittedItems > 0 || projection.tools.omittedNamespaces > 0);
  const nativePolicy = { ...policy, profile: 'native-read', model: 'fixture-native-shell',
    workspace: '/tmp/native-fixture/workspace' };
  assert.equal(requestDecision(request('POST', '/responses',
    { 'content-type': 'application/json' }), payload, nativePolicy).ok, false);
});

test('native tool transport retains outer function and namespace gates', () => {
  const secret = 'secret-tool-description';
  const nativePolicy = { ...policy, profile: 'native-read', model: 'fixture-native-shell',
    workspace: '/tmp/native-fixture/workspace' };
  const post = request('POST', '/responses', { 'content-type': 'application/json' });
  const valid = { type: 'function', name: 'submit_reminder_decision', parameters: {} };
  const namespace = { type: 'namespace', name: 'muse', tools: [valid] };
  const payload = tools => body({ model: nativePolicy.model, input: 'NATIVE_READ_FILE_PROBE',
    ...nativeExtras, tools });
  const cases = [
    [[], 'NAMESPACE_COUNT', null],
    [[{ ...namespace, name: secret }], 'NAMESPACE_SHAPE', null],
    [[{ ...namespace, tools: [{ ...valid, name: secret }] }], 'FUNCTION_NAME_SET', null],
    [[{ ...namespace, tools: [{ ...valid, type: secret }] }], 'FUNCTION_TYPE', 0],
    [[{ ...namespace, tools: [{ ...valid, bad: true }] }], 'FUNCTION_FIELDS', 0],
    [[{ ...namespace, tools: [{ ...valid, strict: secret }] }], 'FUNCTION_STRICT', 0],
    [[{ ...namespace, tools: [{ ...valid, description: secret.repeat(200) }] }],
      'FUNCTION_DESCRIPTION', 0],
    [[{ ...namespace, tools: [{ ...valid, parameters: null }] }], 'SCHEMA_SHAPE', 0],
    [[{ ...namespace, tools: [{ ...valid, parameters: [] }] }], 'SCHEMA_SHAPE', 0],
  ];
  for (const [tools, code, functionIndex] of cases) {
    const bytes = payload(tools);
    assert.equal(requestDecision(post, bytes, nativePolicy).code, 'NATIVE_TOOLS_INVALID');
    const projection = nativeRejectionProjection(bytes,
      { index: 1, stage: 'admission', code: 'NATIVE_TOOLS_INVALID' });
    assert.equal(projection.tools.failure.code, code);
    assert.equal(projection.tools.failure.functionIndex, functionIndex);
    assert.equal(JSON.stringify(projection).includes(secret), false);
    assert.ok(Buffer.byteLength(`${JSON.stringify(projection)}\n`) <= 4_096);
  }
  for (const description of ['😀'.repeat(512), 'x'.repeat(2_048)])
    assert.equal(requestDecision(post, payload([{ ...namespace, tools: [{ ...valid,
      description }] }]), nativePolicy).ok, true);
  for (const description of ['😀'.repeat(513), '\ud800'])
    assert.equal(requestDecision(post, payload([{ ...namespace, tools: [{ ...valid,
      description }] }]), nativePolicy).code, 'NATIVE_TOOLS_INVALID');
});

test('one-function and 25-function envelopes carry inert metadata without resolution', () => {
  const secret = 'secret-metadata-and-credential';
  const nativePolicy = { ...policy, profile: 'native-read', model: 'fixture-native-shell',
    workspace: '/tmp/native-fixture/workspace' };
  const post = request('POST', '/responses', { 'content-type': 'application/json' });
  const inert = { type: ['unreviewed', 'object', 'object', null], description: secret.repeat(200),
    minimum: secret, const: { arbitrary: [false, 4_000_000, null] },
    $ref: 'https://127.0.0.1:1/should-never-fetch', pattern: '(.*)+',
    [secret]: { nested: ['x', { $ref: '/tmp/never-read', nullable: secret }] } };
  const variants = [
    [{ type: 'namespace', name: 'muse', tools: [{ type: 'function',
      name: 'submit_reminder_decision', parameters: inert }] }],
    [{ type: 'namespace', name: 'muse', tools: Array.from({ length: 25 }, (_, index) =>
      ({ type: 'function', name: index === 1 ? 'read_file' : `native_${index}`,
        parameters: index === 13 ? inert : {} })) }],
  ];
  for (const tools of [...variants, ...variants.toReversed()]) {
    const accepted = requestDecision(post, body({ model: nativePolicy.model,
      input: 'NATIVE_READ_FILE_PROBE', ...nativeExtras, tools,
      reasoning: { effort: 'arbitrary', summary: 'opaque' } }), nativePolicy);
    assert.equal(accepted.ok, true);
    assert.deepEqual(JSON.parse(accepted.body).tools, tools);
    assert.equal(JSON.parse(accepted.body).reasoning, undefined);
  }
  const pure = body({ model: nativePolicy.model, input: 'NATIVE_READ_FILE_PROBE',
    ...nativeExtras, tools: variants[0], reasoning: { effort: secret, summary: 'auto' } });
  const projection = nativeRejectionProjection(pure,
    { index: 1, stage: 'admission', code: 'NATIVE_REASONING_INVALID' });
  assert.equal(projection.diagnostic.violations.SCHEMA_KEYS, undefined);
  assert.equal(projection.diagnostic.violations.SCHEMA_NUMBER, undefined);
  assert.equal(JSON.stringify(projection).includes(secret), false);
});

test('metadata depth and global entry limits include scalars and array items', () => {
  const nativePolicy = { ...policy, profile: 'native-read', model: 'fixture-native-shell',
    workspace: '/tmp/native-fixture/workspace' };
  const post = request('POST', '/responses', { 'content-type': 'application/json' });
  const one = parameters => [{ type: 'namespace', name: 'muse', tools: [{ type: 'function',
    name: 'submit_reminder_decision', parameters }] }];
  const twentyFive = count => [{ type: 'namespace', name: 'muse',
    tools: Array.from({ length: 25 }, (_, index) => ({ type: 'function',
      name: index === 1 ? 'read_file' : `native_${index}`,
      parameters: index === 24 ? { values: Array(count).fill(null) } : {} })) }];
  const decide = tools => requestDecision(post, body({ model: nativePolicy.model,
    input: 'NATIVE_READ_FILE_PROBE', ...nativeExtras, tools }), nativePolicy);
  assert.equal(decide(one({ values: Array(8_190).fill(0) })).ok, true);
  assert.equal(decide(one({ values: Array(8_191).fill(0) })).code, 'NATIVE_TOOLS_INVALID');
  assert.equal(decide(twentyFive(8_166)).ok, true);
  assert.equal(decide(twentyFive(8_167)).code, 'NATIVE_TOOLS_INVALID');
  const over = body({ model: nativePolicy.model, input: 'NATIVE_READ_FILE_PROBE',
    ...nativeExtras, tools: twentyFive(8_167) });
  const diagnosis = nativeRejectionProjection(over,
    { index: 1, stage: 'admission', code: 'NATIVE_TOOLS_INVALID' });
  assert.equal(diagnosis.tools.failure.code, 'SCHEMA_COMPLEXITY');
  assert.equal(diagnosis.tools.failure.functionIndex, 24);
  assert.equal(diagnosis.diagnostic.coverage.schemaNodes, 8_192);
  assert.ok(diagnosis.diagnostic.coverage.unexaminedSchemaSubtrees > 0);
  assert.equal(diagnosis.diagnostic.violations.SCHEMA_COMPLEXITY, 1);
  assert.ok(Buffer.byteLength(`${JSON.stringify(diagnosis)}\n`) <= 4_096);
  const nested = levels => { let value = 'leaf';
    for (let index = 0; index < levels; index++) value = [value];
    return { value }; };
  assert.equal(decide(one(nested(15))).ok, true);
  const tooDeep = body({ model: nativePolicy.model, input: 'NATIVE_READ_FILE_PROBE',
    ...nativeExtras, tools: one(nested(16)) });
  assert.equal(requestDecision(post, tooDeep, nativePolicy).code, 'NATIVE_TOOLS_INVALID');
  assert.deepEqual(nativeRejectionProjection(tooDeep,
    { index: 1, stage: 'admission', code: 'NATIVE_TOOLS_INVALID' }).tools.failure,
  { code: 'SCHEMA_COMPLEXITY', functionIndex: 0, depth: 17 });
});

test('metadata refuses malformed Unicode and JSON numeric overflow', () => {
  const nativePolicy = { ...policy, profile: 'native-read', model: 'fixture-native-shell',
    workspace: '/tmp/native-fixture/workspace' };
  const post = request('POST', '/responses', { 'content-type': 'application/json' });
  const payload = parameters => body({ model: nativePolicy.model,
    input: 'NATIVE_READ_FILE_PROBE', ...nativeExtras,
    tools: [{ type: 'namespace', name: 'muse', tools: [{ type: 'function',
      name: 'submit_reminder_decision', parameters }] }] });
  for (const parameters of [{ x: '\ud800' }, { ['\udc00']: true }]) {
    const bytes = payload(parameters);
    assert.equal(requestDecision(post, bytes, nativePolicy).code, 'NATIVE_TOOLS_INVALID');
    const projected = nativeRejectionProjection(bytes,
      { index: 1, stage: 'admission', code: 'NATIVE_TOOLS_INVALID' });
    assert.equal(projected.tools.failure.code, 'SCHEMA_UNICODE');
    assert.ok(Buffer.byteLength(`${JSON.stringify(projected)}\n`) <= 4_096);
  }
  assert.equal(requestDecision(post, payload({ x: '😀', y: 1e100 }), nativePolicy).ok, true);
  const overflow = Buffer.from(payload({ x: 7.77 }).toString().replace('7.77', '1e999'));
  assert.equal(requestDecision(post, overflow, nativePolicy).code, 'NATIVE_TOOLS_INVALID');
  assert.equal(nativeRejectionProjection(overflow,
    { index: 1, stage: 'admission', code: 'NATIVE_TOOLS_INVALID' }).tools.failure.code,
  'SCHEMA_NONFINITE_NUMBER');
});

test('guest headers and auth cannot select upstream authority or identity', () => {
  for (const headers of [
    { authorization: 'Bearer external' }, { cookie: 'session=anything' },
    { forwarded: 'for=1.2.3.4' }, { 'x-forwarded-host': 'evil.invalid' },
    { 'proxy-authorization': 'Bearer anything' }, { upgrade: 'websocket' },
    { host: 'evil.invalid' }, { 'transfer-encoding': 'gzip' },
  ]) assert.equal(requestDecision(request('GET', '/muse-code/models', headers), Buffer.alloc(0), policy).ok, false);
  const duplicate = request('GET', '/muse-code/models');
  duplicate.rawHeaders.push('Authorization', 'Bearer second');
  assert.deepEqual(requestDecision(duplicate, Buffer.alloc(0), policy),
    { ok: false, code: 'DUPLICATE_HEADER' });
});

test('socket identity rejects replacement, symlink, wrong mode and cross-run binding', async () => {
  const expected = { dev: 4, ino: 100 };
  const entry = (dev, ino, mode, socket = true) => ({ dev, ino, mode, isSocket: () => socket });
  await assertSocketIdentity('/tmp/relay.sock', expected, async () => entry(4, 100, 0o140600));
  for (const wrong of [entry(4, 101, 0o140600), entry(5, 100, 0o140600),
    entry(4, 100, 0o140666), entry(4, 100, 0o120600, false)]) {
    await assert.rejects(assertSocketIdentity('/tmp/relay.sock', expected, async () => wrong),
      { code: 'SOCKET_REPLACED' });
  }
  assert.equal(requestDecision(request('GET', '/muse-code/models', { 'x-passeur-run': 'run_other' }),
    Buffer.alloc(0), policy).code, 'RUN_OR_HEADER_REJECTED');
});

test('relay socket is the only guest host path; network remains unshared', async () => {
  const root = await mkdtemp(join(tmpdir(), 'passeur-relay-config-'));
  try {
    const paths = Object.fromEntries(['workspace', 'runtime', 'home', 'protected', 'socket']
      .map(name => [name, join(root, name)]));
    await Promise.all(Object.values(paths).map(path => mkdir(path)));
    const config = relaySandboxConfig({ ...paths, protectedRoot: paths.protected,
      socketDirectory: paths.socket });
    assert.deepEqual(config.mounts.map(item => [item.target, item.mode]), [
      ['/mounts/runtime', 'ro'], ['/mounts/home', 'rw'], ['/mounts/relay', 'ro']]);
    assert.deepEqual(config.denied, [paths.protected]);
    const prepared = prepareSandbox(config, ['/mounts/runtime/node',
      '/mounts/runtime/qualify-muse-credential-relay.mjs', '--guest']);
    assert.ok(prepared.args.includes('--unshare-net'));
    assert.ok(prepared.args.includes('--clearenv'));
    assert.ok(prepared.args.join(' ').includes(`--ro-bind ${paths.socket} /mounts/relay`));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('native stage composes pinned diagnostic runtime without an alternate artifact path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'passeur-native-stage-contract-'));
  try {
    const runtime = await stageNativeRuntime(root, '/unused-pinned-muse', async (givenRoot, muse) => {
      assert.equal(givenRoot, root);
      assert.equal(muse, '/unused-pinned-muse');
      const path = join(givenRoot, 'runtime');
      await mkdir(path);
      return path;
    });
    assert.equal(runtime, join(root, 'runtime'));
    assert.match(await readFile(join(runtime, 'qualify-muse-credential-relay.mjs'), 'utf8'),
      /stageNativeRuntime/);
    await assert.rejects(stageNativeRuntime(root, '/unused-pinned-muse', async () => root),
      { code: 'NATIVE_RUNTIME_STAGE_INVALID' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('native guest delegates lifecycle with relay port and always closes its endpoint', async () => {
  const config = { phase: 'read-file-probe', runId, workspace: '/tmp/fixture/workspace' };
  const callerFailure = new Promise(() => undefined);
  const release = async () => 'turn';
  let closed = 0;
  const relayEvidence = { requests: 0 };
  const options = { release, callerFailure, checkLoopback: () => true,
    startRelay: async (path, id) => {
      assert.equal(path, '/mounts/relay/relay.sock');
      assert.equal(id, runId);
      relayEvidence.requests = 0;
      return { port: 43210, evidence: relayEvidence, close: async () => { closed++; } };
    },
    runLifecycle: async (guest, controls) => {
      assert.equal(guest.release, release);
      assert.equal(guest.workspace, config.workspace);
      assert.equal(controls.providerPort, 43210);
      assert.equal(controls.callerFailure, callerFailure);
      relayEvidence.requests++;
      await controls.onCandidate();
      await controls.onFinal();
      return { kind: 'native_read_file_outcome' };
    } };
  assert.deepEqual(await guestNativeFixture(config, options),
    { kind: 'native_read_file_outcome' });
  assert.equal(closed, 1);
  await assert.rejects(guestNativeFixture(config, { ...options,
    runLifecycle: async () => { throw Object.assign(new Error('runner failed'),
      { code: 'NATIVE_RUNNER_FAILED' }); } }), { code: 'NATIVE_RUNNER_FAILED' });
  assert.equal(closed, 2);
  await assert.rejects(guestNativeFixture(config, { ...options,
    runLifecycle: async (_guest, controls) => {
      relayEvidence.requests++;
      await controls.onCandidate();
      relayEvidence.requests++;
      await controls.onFinal();
    } }), { code: 'NATIVE_RELAY_AFTER_CANDIDATE' });
  assert.equal(closed, 3);
  await assert.rejects(guestNativeFixture({ ...config, phase: 'shell' }, options),
    { code: 'NATIVE_GUEST_CONFIG_INVALID' });
  assert.equal(closed, 3);
});

test('native host retains both roots and closes fixtures after a readiness failure', async () => {
  const { qualifyNativeRelay } = await import('../../scripts/qualify-muse-credential-relay.mjs');
  const closed = [];
  let aborted = 0;
  const failure = Object.assign(new Error('injected native readiness failure'),
    { code: 'NATIVE_READY_INJECTED' });
  const result = await qualifyNativeRelay({
    stagePinned: async root => {
      const runtime = join(root, 'runtime');
      await mkdir(runtime);
      return runtime;
    },
    startSentinel: async () => ({ port: 12345,
      close: async () => { closed.push('sentinel'); } }),
    startUpstream: async () => ({ origin: 'http://127.0.0.1:12346/',
      provider: { rejection: new Promise(() => undefined), requests: [], state: {},
        close: async () => { closed.push('provider'); } },
      seen: [], close: async () => { closed.push('upstream'); } }),
    startSocketBroker: async ({ socketPath }) => ({ socketPath, listening: true,
      evidence: {}, close: async function () { this.listening = false; closed.push('broker'); } }),
    probe: async () => ({ kind: 'connected' }),
    prepare: () => ({ executable: '/not-launched', args: [] }),
    checkBubblewrap: () => undefined,
    launch: () => ({ pid: 1, ready: Promise.reject(failure),
      liveStatus: Promise.resolve({ child: 2, exit: null }),
      abort: () => { aborted++; },
      finished: Promise.resolve({ code: 1, statusLines: [], output: [] }) }),
  });
  try {
    assert.equal(result.kind, 'native_synthetic_relay_error');
    assert.deepEqual(result.primary, { stage: 'guest_ready', code: 'NATIVE_READY_INJECTED' });
    assert.equal(result.stopProof.kind, 'unverified');
    assert.equal(result.hostStarted, true);
    assert.equal(aborted, 1);
    assert.deepEqual(closed, ['broker', 'upstream', 'sentinel']);
    assert.equal(result.retainedFixtures.length, 2);
    for (const path of result.retainedFixtures) assert.equal((await lstat(path)).isDirectory(), true);
  } finally {
    for (const path of result.retainedFixtures ?? []) await rm(path, { recursive: true, force: true });
  }
});

async function runInjectedNativeSuccessPath({ inspectSocket, terminalError = false,
  providerFailureAt = null, brokerFailureAt = null, stopUnverified = false,
  missingRuntime = false, freezeError = false, failureOrder = 'provider-first',
  capturePending = false } = {}) {
  const { qualifyNativeRelay } = await import('../../scripts/qualify-muse-credential-relay.mjs');
  const state = { active: 0 };
  const catalog = { method: 'GET', path: '/muse-code/models' };
  let reportRejection;
  const rejection = new Promise(resolve => { reportRejection = resolve; });
  let reportBrokerFailure;
  const brokerFailure = new Promise(resolve => { reportBrokerFailure = resolve; });
  const brokerEvidence = { accepted: 1, rejected: 0 };
  const reportBroker = () => {
    brokerEvidence.firstFailure = { code: 'NATIVE_INPUT_INVALID', stage: 'admission' };
    brokerEvidence.rejected++;
    reportBrokerFailure(brokerEvidence.firstFailure);
  };
  const report = () => {
    state.primaryCode = 'NATIVE_PROVIDER_REJECTED';
    reportRejection({ code: state.primaryCode });
  };
  let removedSocket = 0;
  const outcome = terminalError ? { kind: 'guest_transport_error', code: 'GUEST_TERMINAL_ERROR' } :
    { kind: 'native_read_file_outcome' };
  const canary = readFileCanaryFixture();
  const result = await qualifyNativeRelay({
    stagePinned: async root => { const runtime = join(root, 'runtime'); await mkdir(runtime); return runtime; },
    startSentinel: async () => ({ port: 12345, close: async () => undefined }),
    startUpstream: async () => ({ origin: 'http://127.0.0.1:12346/',
      provider: { rejection, requests: [catalog], state,
        freeze: async () => { if (freezeError) throw Object.assign(new Error('freeze failed'),
          { code: 'FREEZE_INJECTED' }); } },
      seen: [{ correctBearer: true, dummyAbsent: true }], close: async () => undefined }),
    startSocketBroker: async () => ({ listening: true, failure: brokerFailure,
      evidence: brokerEvidence,
      ...(capturePending ? { flushCapture: async () => { throw Object.assign(
        new Error('capture deadline'), { code: 'BROKER_CAPTURE_DEADLINE' }); },
      cancelCapture: code => { brokerEvidence.capture = { status: 'unverified', code }; } } : {}),
      close: async function () { this.listening = false; removedSocket++;
        if (brokerFailureAt === 'freeze') reportBroker(); } }),
    probe: async () => ({ kind: 'connected' }),
    prepare: () => ({ executable: '/not-launched', args: [] }),
    checkBubblewrap: () => undefined,
    validateReady: () => undefined,
    validateOutcome: () => 'reviewed-native-outcome',
    inspectSocket,
    inspectRetainedRoot: async path => {
      if (missingRuntime && path.startsWith('/dev/shm/'))
        throw Object.assign(new Error('runtime missing'), { code: 'ENOENT' });
      return lstat(path);
    },
    launch: (_prepared, config) => {
      const ready = { kind: 'guest_shell_ready', nativeIdentity: { pid: 123, start: '1' },
        guestNamespace: 'net:[1]', nativeNamespace: 'net:[1]',
        readCanarySha256: createHash('sha256').update(canary.content).digest('hex'),
        commandSha256: createHash('sha256').update(shellProbeCommand(config.workspace,
          config.protectedRoot, config.canaryToken)).digest('hex') };
      return { pid: 1, ready: Promise.resolve(ready),
        liveStatus: Promise.resolve({ child: 2, exit: null }),
        outcome: Promise.resolve(outcome),
        releaseTurn: () => {
          if (failureOrder === 'broker-first') {
            if (brokerFailureAt === 'terminal') reportBroker();
            if (providerFailureAt === 'terminal') report();
          } else {
            if (providerFailureAt === 'terminal') report();
            if (brokerFailureAt === 'terminal') reportBroker();
          }
        },
        releaseShutdown: () => { if (providerFailureAt === 'shutdown') report(); },
        abort: () => undefined,
        finished: Promise.resolve({ code: 0, signal: null, timedOut: false, overflow: false,
          statusClosed: true, statusLines: [JSON.stringify({ 'child-pid': 2 }),
            JSON.stringify({ 'exit-code': 0 })], output: [JSON.stringify(ready),
            JSON.stringify(outcome), JSON.stringify(outcome)] }) };
    },
    capture: async () => ({ native: { nspid: [123], netns: 'net:[1]' },
      supervisor: { netns: 'net:[1]' }, fd: { close: async () => undefined } }),
    stop: async () => stopUnverified ?
      { kind: 'unverified', code: 'INJECTED_STOP_UNVERIFIED' } :
      { kind: 'confirmed', observed: 3 },
  });
  return { result, removedSocket };
}

test('native success path retains both roots when socket remains or stat is uncertain', async () => {
  for (const [inspectSocket, code] of [
    [async () => ({ isSocket: () => true }), 'SOCKET_STILL_PRESENT'],
    [async () => { const error = new Error('inspection failed'); error.code = 'EIO'; throw error; },
      'SOCKET_INSPECTION_UNVERIFIED'],
  ]) {
    const { result, removedSocket } = await runInjectedNativeSuccessPath({ inspectSocket });
    try {
      assert.equal(result.kind, 'native_synthetic_relay_error');
      assert.deepEqual(result.primary, code === 'SOCKET_INSPECTION_UNVERIFIED' ?
        { stage: 'retirement', code, secondary: 'EIO' } : { stage: 'retirement', code });
      assert.equal(result.stopProof.kind, 'confirmed');
      assert.equal(removedSocket, 1);
      assert.equal(result.retainedFixtures.length, 2);
      for (const path of result.retainedFixtures) assert.equal((await lstat(path)).isDirectory(), true);
    } finally {
      for (const path of result.retainedFixtures ?? []) await rm(path, { recursive: true, force: true });
    }
  }
});

test('host provider rejection remains primary against native terminal and shutdown results', async () => {
  for (const [providerFailureAt, terminalError, stopUnverified, secondary] of [
    ['terminal', true, false, 'GUEST_TERMINAL_ERROR'],
    ['shutdown', false, true, 'NATIVE_RELAY_STOP_INVALID'],
    ['shutdown', false, false, undefined],
  ]) {
    const { result } = await runInjectedNativeSuccessPath({ providerFailureAt, terminalError,
      stopUnverified,
      inspectSocket: async () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); } });
    try {
      assert.equal(result.kind, 'native_synthetic_relay_error');
      assert.equal(result.primary.code, 'NATIVE_PROVIDER_REJECTED');
      assert.equal(result.primary.secondary, secondary);
      assert.equal(result.retainedFixtures.length, 2);
    } finally {
      for (const path of result.retainedFixtures ?? []) await rm(path, { recursive: true, force: true });
    }
  }
});

test('first broker refusal outranks terminal and freeze while missing runtime is reported', async () => {
  for (const [brokerFailureAt, terminalError, freezeError, secondary] of [
    ['terminal', true, false, 'GUEST_TERMINAL_ERROR'],
    ['freeze', false, true, 'FREEZE_INJECTED'],
  ]) {
    const { result } = await runInjectedNativeSuccessPath({ brokerFailureAt, terminalError,
      missingRuntime: true, freezeError, inspectSocket: async () => {
        throw Object.assign(new Error('absent'), { code: 'ENOENT' });
      } });
    try {
      assert.equal(result.kind, 'native_synthetic_relay_error');
      assert.equal(result.primary.code, 'NATIVE_INPUT_INVALID');
      assert.equal(result.primary.secondary, secondary);
      assert.deepEqual(result.broker.firstFailure,
        { code: 'NATIVE_INPUT_INVALID', stage: 'admission' });
      assert.equal(result.retainedRoots.length, 2);
      assert.deepEqual(result.retainedRoots.map(item => item.status), ['present', 'missing']);
      assert.deepEqual(result.retainedFixtures, [result.retainedRoots[0].path]);
    } finally {
      for (const item of result.retainedRoots ?? []) {
        if (item.status === 'present' || item.status === 'missing')
          await rm(item.path, { recursive: true, force: true });
      }
    }
  }
});

test('broker and provider race preserves the first observed rejection in either order', async () => {
  for (const [failureOrder, first, later] of [
    ['provider-first', 'NATIVE_PROVIDER_REJECTED', 'NATIVE_INPUT_INVALID'],
    ['broker-first', 'NATIVE_INPUT_INVALID', 'NATIVE_PROVIDER_REJECTED'],
  ]) {
    const { result } = await runInjectedNativeSuccessPath({ brokerFailureAt: 'terminal',
      providerFailureAt: 'terminal', terminalError: true, failureOrder });
    try {
      assert.equal(result.kind, 'native_synthetic_relay_error');
      assert.equal(result.primary.code, first);
      assert.equal(result.primary.source, failureOrder === 'provider-first' ? 'provider' : 'broker');
      assert.equal(result.primary[failureOrder === 'provider-first' ? 'brokerCode' : 'providerCode'], later);
      assert.equal(result.primary.secondary, 'GUEST_TERMINAL_ERROR');
      assert.equal(result.stopProof.kind, 'confirmed');
    } finally {
      for (const item of result.retainedRoots ?? [])
        await rm(item.path, { recursive: true, force: true });
    }
  }
});

test('capture timeout remains separate and unverified after first broker refusal', async () => {
  const { result } = await runInjectedNativeSuccessPath({ brokerFailureAt: 'terminal',
    terminalError: true, capturePending: true });
  try {
    assert.equal(result.primary.code, 'NATIVE_INPUT_INVALID');
    assert.deepEqual(result.broker.capture,
      { status: 'unverified', code: 'BROKER_CAPTURE_DEADLINE' });
    assert.equal(result.stopProof.kind, 'confirmed');
  } finally {
    for (const item of result.retainedRoots ?? [])
      await rm(item.path, { recursive: true, force: true });
  }
});

test('stop verification refuses incomplete status before resource retirement', async () => {
  const capture = { boot: 'boot-one',
    wrapper: { pid: 1, start: '1' }, statusChild: { pid: 2, start: '2' }, members: [], pidns: 'pid:[1]' };
  const options = { bootId: async () => 'boot-one', readStat: async () => {
    const error = new Error('gone'); error.code = 'ENOENT'; throw error;
  }, scan: async () => [] };
  await assert.rejects(verifyFixtureStop(capture, { child: 2, exit: null },
    { code: 0, signal: null, statusClosed: true, timedOut: false, overflow: false }, options),
  { code: 'STOP_STATUS_INVALID' });
  assert.deepEqual(await verifyFixtureStop(capture, { child: 2, exit: 0 },
    { code: 0, signal: null, statusClosed: true, timedOut: false, overflow: false }, options),
  { kind: 'confirmed', observed: 1 });
  await assert.rejects(verifyFixtureStop(capture, { child: 2, exit: 0 },
    { code: 0, signal: null, statusClosed: true, timedOut: false, overflow: false },
    { ...options, scan: async () => [{ pid: 3 }] }), { code: 'STOP_SURVIVOR' });
  await assert.rejects(verifyFixtureStop(capture, { child: 2, exit: 0 },
    { code: 0, signal: null, statusClosed: true, timedOut: false, overflow: false },
    { ...options, bootId: async () => 'boot-two' }), { code: 'STOP_STATUS_INVALID' });
  const reusedFields = Array(20).fill('0');
  reusedFields[0] = 'S';
  reusedFields[19] = '2';
  await assert.rejects(verifyFixtureStop(capture, { child: 2, exit: 0 },
    { code: 0, signal: null, statusClosed: true, timedOut: false, overflow: false },
    { ...options, readStat: async () => `1 (node) ${reusedFields.join(' ')}` }),
  { code: 'STOP_PID_REUSED' });
  assert.equal(typeof captureFixtureProcesses, 'function');
});

const network = process.env.PASSEUR_RELAY_NETWORK_TEST === '1';
test('host broker substitutes synthetic bearer and streams SSE without replay', { skip: !network }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'passeur-relay-network-'));
  let broker;
  let relay;
  let upstream;
  try {
    const socketDirectory = join(root, 'socket');
    await mkdir(socketDirectory);
    const seen = [];
    const bearer = 'synthetic-host-held-bearer-0123456789';
    upstream = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      seen.push({ route: request.url, bearer: request.headers.authorization, headers: request.headers,
        body: Buffer.concat(chunks).toString() });
      response.writeHead(200, { 'content-type': request.url === '/responses'
        ? 'text/event-stream' : 'application/json' });
      response.end(request.url === '/responses' ? 'data: {"type":"response.completed"}\n\n'
        : JSON.stringify({ data: [{ id: model }] }));
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    broker = await startBroker({ socketPath: join(socketDirectory, 'relay.sock'),
      upstreamOrigin: `http://127.0.0.1:${upstream.address().port}/`, runId, bearer });
    relay = await startGuestRelay(broker.socketPath, runId);
    const base = `http://127.0.0.1:${relay.port}`;
    const catalog = await fetch(`${base}/muse-code/models`, { headers: { authorization: `Bearer ${dummy}` } });
    assert.equal(catalog.status, 200);
    const response = await fetch(`${base}/responses`, { method: 'POST', headers: {
      authorization: `Bearer ${dummy}`, 'content-type': 'application/json',
    }, body: `{"model":"${model}","input":"unapproved-source","input":"fixture","tools":[]}` });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /response.completed/);
    const replay = await fetch(`${base}/responses`, { method: 'POST', headers: {
      authorization: `Bearer ${dummy}`, 'content-type': 'application/json',
    }, body: JSON.stringify({ model, input: 'fixture', tools: [] }) });
    assert.equal(replay.status, 429);
    assert.equal((await replay.json()).error.code, 'ROUTE_BUDGET');
    assert.equal(seen.length, 2);
    assert.ok(seen.every(item => item.bearer === `Bearer ${bearer}` &&
      !JSON.stringify(item.headers).includes(dummy)));
    assert.deepEqual(JSON.parse(seen[1].body), { model, input: 'fixture', tools: [] });
    assert.equal(seen[1].body.includes('unapproved-source'), false);
    assert.equal(broker.evidence.upstream, 2);
  } finally {
    if (relay) await relay.close();
    if (broker) await broker.close();
    if (upstream) await new Promise(resolveValue => upstream.close(resolveValue));
    await rm(root, { recursive: true, force: true });
  }
});

test('native broker keeps separate catalog/Responses budgets and rejects canonical replay', { skip: !network }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'passeur-native-relay-policy-'));
  let upstream;
  let broker;
  const bearer = 'synthetic-host-held-bearer-0123456789';
  const nativeBody = input => JSON.stringify({ model: 'fixture-native-shell', input,
    ...nativeExtras,
    tools: [{ type: 'namespace', name: 'muse', tools: [{ type: 'function',
      name: 'submit_reminder_decision', parameters: { type: 'object' } }] }] });
  const sendNative = (method, path, payload = '') => new Promise(resolveValue => {
    const client = httpRequest({ socketPath: broker.socketPath, method, path,
      headers: { host: '127.0.0.1:1', authorization: `Bearer ${dummy}`,
        'x-passeur-run': runId, ...(method === 'POST' ?
          { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) } },
    response => { response.resume(); response.once('end', () => resolveValue(response.statusCode)); });
    client.once('error', () => resolveValue(0));
    client.end(payload);
  });
  try {
    const seen = [];
    upstream = createServer((incoming, response) => {
      seen.push({ route: incoming.url, bearer: incoming.headers.authorization });
      incoming.resume();
      if (incoming.url === '/muse-code/models') response.writeHead(200,
        { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'fixture-native-shell' }] }));
      else response.writeHead(200, { 'content-type': 'text/event-stream' }).end([
        { type: 'response.created', sequence_number: 1 },
        { type: 'response.completed', sequence_number: 2, response: { status: 'completed' } },
      ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    broker = await startBroker({ socketPath: join(root, 'relay.sock'),
      upstreamOrigin: `http://127.0.0.1:${upstream.address().port}/`, runId, bearer,
      profile: 'native-read', workspace: join(root, 'workspace') });
    for (let i = 0; i < 4; i++) assert.equal(await sendNative('GET', '/muse-code/models'), 200);
    assert.equal(await sendNative('GET', '/muse-code/models'), 429);
    assert.equal(await sendNative('POST', '/responses', nativeBody('NATIVE_READ_FILE_PROBE: 0')), 200);
    const changedKey = 'secret-cache-key-'.padEnd(46, 'Q');
    assert.equal(await sendNative('POST', '/responses', JSON.stringify({
      ...JSON.parse(nativeBody('NATIVE_READ_FILE_PROBE: 0')),
      prompt_cache_key: changedKey })), 403);
    assert.equal(await sendNative('POST', '/responses', JSON.stringify({
      ...JSON.parse(nativeBody('NATIVE_READ_FILE_PROBE: another')),
      reasoning: { effort: 'secret-native-reasoning' } })), 403);
    for (let i = 1; i < 5; i++) assert.equal(await sendNative('POST', '/responses',
      nativeBody(`NATIVE_READ_FILE_PROBE: ${i}`)), 200);
    assert.equal(await sendNative('POST', '/responses', nativeBody('NATIVE_READ_FILE_PROBE: 5')), 429);
    assert.equal(seen.length, 9);
    assert.ok(seen.every(item => item.bearer === `Bearer ${bearer}`));
    await broker.flushCapture();
    assert.deepEqual(broker.evidence.firstFailure,
      { code: 'ROUTE_BUDGET', stage: 'budget' });
    const captured = JSON.parse(await readFile(join(root, 'first-rejected-native-post.json'), 'utf8'));
    assert.equal(captured.requestIndex, 2);
    assert.deepEqual(captured.failedPredicates, ['NATIVE_REQUEST_REPLAY']);
    assert.equal(JSON.stringify(captured).includes('NATIVE_READ_FILE_PROBE: 0'), false);
    assert.equal(JSON.stringify(captured).includes(changedKey), false);
    assert.equal(captured.diagnostic.violations.NATIVE_CACHE_KEY_INVALID, undefined);
    const later = JSON.parse(await readFile(join(root, 'rejected-native-post-3.json'), 'utf8'));
    assert.equal(later.requestIndex, 3);
    assert.deepEqual(later.failedPredicates, ['NATIVE_REASONING_INVALID']);
    assert.equal(later.diagnostic.violations.NATIVE_REASONING_INVALID, 1);
    assert.equal(JSON.stringify(later).includes('secret-native-reasoning'), false);
    assert.deepEqual(broker.evidence.additionalCaptures,
      [{ index: 3, status: 'written', path: join(root, 'rejected-native-post-3.json') }]);
  } finally {
    if (broker) await broker.close();
    if (upstream) await new Promise(resolveValue => upstream.close(resolveValue));
    await rm(root, { recursive: true, force: true });
  }
});

test('native rejected POST capture write failure preserves refusal without forwarding',
  { skip: !network }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'passeur-native-capture-fail-'));
    let upstream;
    let broker;
    let forwarded = 0;
    try {
      upstream = createServer((_request, response) => { forwarded++; response.writeHead(200).end(); });
      upstream.listen(0, '127.0.0.1');
      await once(upstream, 'listening');
      broker = await startBroker({ socketPath: join(root, 'relay.sock'),
        upstreamOrigin: `http://127.0.0.1:${upstream.address().port}/`, runId,
        bearer: 'synthetic-host-held-bearer-0123456789', profile: 'native-read',
        workspace: join(root, 'workspace'), writeCapture: async (path, data, options) => {
          assert.equal(path, join(root, 'first-rejected-native-post.json'));
          assert.equal(options.flag, 'wx');
          assert.equal(options.mode, 0o600);
          assert.equal(data.includes('unreviewed child'), false);
          throw Object.assign(new Error('capture denied'), { code: 'EIO' });
        } });
      const status = await new Promise(resolveValue => {
        const client = httpRequest({ socketPath: broker.socketPath, method: 'POST',
          path: '/responses', headers: { host: '127.0.0.1:1', authorization: `Bearer ${dummy}`,
            'x-passeur-run': runId, 'content-type': 'application/json' } }, response => {
          response.resume(); response.once('end', () => resolveValue(response.statusCode));
        });
        client.once('error', () => resolveValue(0));
        client.end(JSON.stringify({ model: 'fixture-native-shell', input: 'unreviewed child',
          ...nativeExtras, tools: [] }));
      });
      await broker.flushCapture();
      assert.equal(status, 403);
      assert.equal(forwarded, 0);
      assert.deepEqual(broker.evidence.firstFailure,
        { code: 'NATIVE_INPUT_INVALID', stage: 'admission' });
      assert.deepEqual(broker.evidence.capture, { status: 'failed', code: 'EIO' });
      assert.equal(await lstat(join(root, 'first-rejected-native-post.json'))
        .then(() => true, () => false), false);
    } finally {
      if (broker) await broker.close();
      if (upstream) await new Promise(resolveValue => upstream.close(resolveValue));
      await rm(root, { recursive: true, force: true });
    }
  });

test('diagnostic projection failure cannot replace first broker refusal',
  { skip: !network }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'passeur-native-diagnostic-fail-'));
    let upstream;
    let broker;
    let forwarded = 0;
    let writes = 0;
    try {
      upstream = createServer((_request, response) => {
        forwarded++; response.writeHead(200).end();
      });
      upstream.listen(0, '127.0.0.1');
      await once(upstream, 'listening');
      broker = await startBroker({ socketPath: join(root, 'relay.sock'),
        upstreamOrigin: `http://127.0.0.1:${upstream.address().port}/`, runId,
        bearer: 'synthetic-host-held-bearer-0123456789', profile: 'native-read',
        workspace: join(root, 'workspace'),
        projectCapture: () => { throw Object.assign(new Error('diagnostic failed'),
          { code: 'DIAGNOSTIC_FAILURE' }); },
        writeCapture: async () => { writes++; } });
      const status = await new Promise(resolveValue => {
        const client = httpRequest({ socketPath: broker.socketPath, method: 'POST',
          path: '/responses', headers: { host: '127.0.0.1:1', authorization: `Bearer ${dummy}`,
            'x-passeur-run': runId, 'content-type': 'application/json' } }, response => {
          response.resume(); response.once('end', () => resolveValue(response.statusCode));
        });
        client.once('error', () => resolveValue(0));
        client.end(JSON.stringify({ model: 'fixture-native-shell', input: 'unreviewed child',
          ...nativeExtras, tools: [] }));
      });
      assert.equal(status, 403);
      assert.equal(forwarded, 0);
      assert.equal(writes, 0);
      assert.deepEqual(broker.evidence.firstFailure,
        { code: 'NATIVE_INPUT_INVALID', stage: 'admission' });
      assert.deepEqual(broker.evidence.capture,
        { status: 'failed', code: 'DIAGNOSTIC_FAILURE' });
    } finally {
      if (broker) await broker.close();
      if (upstream) await new Promise(resolveValue => upstream.close(resolveValue));
      await rm(root, { recursive: true, force: true });
    }
  });

test('later pending capture stays unverified after cancellation and late writer completion',
  { skip: !network }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'passeur-native-late-capture-'));
    let upstream;
    let broker;
    let releaseWrite;
    let announceSecond;
    const secondStarted = new Promise(resolveValue => { announceSecond = resolveValue; });
    const deferred = new Promise(resolveValue => { releaseWrite = resolveValue; });
    try {
      upstream = createServer((_request, response) => response.writeHead(200).end());
      upstream.listen(0, '127.0.0.1');
      await once(upstream, 'listening');
      broker = await startBroker({ socketPath: join(root, 'relay.sock'),
        upstreamOrigin: `http://127.0.0.1:${upstream.address().port}/`, runId,
        bearer: 'synthetic-host-held-bearer-0123456789', profile: 'native-read',
        workspace: join(root, 'workspace'), writeCapture: async (path, data, options) => {
          if (path.endsWith('first-rejected-native-post.json'))
            return writeFile(path, data, options);
          announceSecond();
          await deferred;
        } });
      const send = index => new Promise(resolveValue => {
        const payload = JSON.stringify({ model: 'fixture-native-shell',
          input: 'NATIVE_READ_FILE_PROBE', ...nativeExtras, reasoning: { effort: `private-${index}` },
          tools: [{ type: 'namespace', name: 'muse', tools: [{ type: 'function',
            name: 'submit_reminder_decision', parameters: { type: 'object' } }] }] });
        const client = httpRequest({ socketPath: broker.socketPath, method: 'POST',
          path: '/responses', headers: { host: '127.0.0.1:1', authorization: `Bearer ${dummy}`,
            'x-passeur-run': runId, 'content-type': 'application/json' } }, response => {
          response.resume(); response.once('end', () => resolveValue(response.statusCode));
        });
        client.once('error', () => resolveValue(0));
        client.end(payload);
      });
      assert.equal(await send(1), 403);
      assert.equal(broker.evidence.capture.status, 'written');
      const secondResponse = send(2);
      await secondStarted;
      assert.equal(broker.evidence.additionalCaptures[0].status, 'pending');
      broker.cancelCapture('BROKER_CAPTURE_DEADLINE');
      assert.equal(broker.evidence.capture.status, 'written');
      assert.deepEqual(broker.evidence.additionalCaptures,
        [{ index: 2, status: 'unverified', code: 'BROKER_CAPTURE_DEADLINE' }]);
      releaseWrite();
      assert.equal(await secondResponse, 403);
      await broker.flushCapture();
      assert.equal(broker.evidence.additionalCaptures[0].status, 'unverified');
      assert.deepEqual(broker.evidence.firstFailure,
        { code: 'NATIVE_REASONING_INVALID', stage: 'admission' });
    } finally {
      releaseWrite?.();
      if (broker) await broker.close();
      if (upstream) await new Promise(resolveValue => upstream.close(resolveValue));
      await rm(root, { recursive: true, force: true });
    }
  });

test('oversized native POST records only bounded prefix and explicit truncation',
  { skip: !network }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'passeur-native-capture-size-'));
    let upstream;
    let broker;
    let forwarded = 0;
    try {
      upstream = createServer((_request, response) => { forwarded++; response.writeHead(200).end(); });
      upstream.listen(0, '127.0.0.1');
      await once(upstream, 'listening');
      broker = await startBroker({ socketPath: join(root, 'relay.sock'),
        upstreamOrigin: `http://127.0.0.1:${upstream.address().port}/`, runId,
        bearer: 'synthetic-host-held-bearer-0123456789', profile: 'native-read',
        workspace: join(root, 'workspace') });
      await new Promise(resolveValue => {
        const client = httpRequest({ socketPath: broker.socketPath, method: 'POST',
          path: '/responses', headers: { host: '127.0.0.1:1', authorization: `Bearer ${dummy}`,
            'x-passeur-run': runId, 'content-type': 'application/json' } }, response => {
          response.resume(); response.once('end', resolveValue);
        });
        client.once('error', resolveValue);
        client.end('x'.repeat(300_000));
      });
      await broker.flushCapture();
      const projection = JSON.parse(await readFile(join(root, 'first-rejected-native-post.json'), 'utf8'));
      assert.equal(projection.bodyComplete, false);
      assert.ok(projection.byteCount > 262_144);
      assert.equal(projection.capturedByteCount, 262_144);
      assert.equal(projection.omittedByteCount,
        projection.byteCount - projection.capturedByteCount);
      assert.equal(forwarded, 0);
    } finally {
      if (broker) await broker.close();
      if (upstream) await new Promise(resolveValue => upstream.close(resolveValue));
      await rm(root, { recursive: true, force: true });
    }
  });

test('reviewed native provider handler sees only host synthetic bearer', { skip: !network }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'passeur-native-upstream-'));
  let upstream;
  let mutatedUpstream;
  let broker;
  const bearer = 'synthetic-host-held-bearer-0123456789';
  try {
    const workspace = join(root, 'workspace');
    const protectedRoot = join(root, 'protected');
    await Promise.all([workspace, protectedRoot].map(path => mkdir(path)));
    upstream = await startNativeUpstream({ bearer, workspace, protectedRoot,
      canaryToken: 'synthetic-canary-token', hostPort: 1 });
    const unauthorized = await fetch(`${upstream.origin}muse-code/models`,
      { headers: { authorization: `Bearer ${dummy}` } });
    assert.equal(unauthorized.status, 401);
    broker = await startBroker({ socketPath: join(root, 'relay.sock'),
      upstreamOrigin: upstream.origin, runId, bearer, profile: 'native-read', workspace });
    const catalog = await new Promise(resolveValue => {
      const client = httpRequest({ socketPath: broker.socketPath, path: '/muse-code/models',
        headers: { host: '127.0.0.1:1', authorization: `Bearer ${dummy}`,
          'x-passeur-run': runId } }, response => {
        response.resume(); response.once('end', () => resolveValue(response.statusCode));
      });
      client.once('error', () => resolveValue(0));
      client.end();
    });
    assert.equal(catalog, 200);
    const tools = Array.from({ length: 25 }, (_, index) => ({ type: 'function',
      name: index === 1 ? 'read_file' : `native_${index}`,
      ...(index === 1 ? { strict: false } : {}),
      parameters: index === 1 ? { type: 'object', additionalProperties: false,
        properties: { limit: { maximum: 2000, minimum: 1, type: 'integer' },
          offset: { minimum: 1, type: 'integer' }, path: { type: 'string' } },
        required: ['path'] } : { type: 'object', properties: { value: { type: 'string' } },
        required: ['value'], additionalProperties: false } }));
    const payload = JSON.stringify({ model: 'fixture-native-shell',
      input: 'NATIVE_READ_FILE_PROBE', ...nativeExtras,
      tools: [{ type: 'namespace', name: 'muse', tools }] });
    const nativeResponse = await new Promise(resolveValue => {
      const client = httpRequest({ socketPath: broker.socketPath, method: 'POST', path: '/responses',
        headers: { host: '127.0.0.1:1', authorization: `Bearer ${dummy}`,
          'x-passeur-run': runId, 'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload) } }, response => {
        let text = '';
        response.on('data', chunk => { text += chunk; });
        response.once('end', () => resolveValue({ status: response.statusCode, text }));
      });
      client.once('error', () => resolveValue({ status: 0, text: '' }));
      client.end(payload);
    });
    assert.equal(nativeResponse.status, 200);
    assert.match(nativeResponse.text, /response\.completed/);
    assert.deepEqual(upstream.seen.map(item => [item.correctBearer, item.dummyAbsent]),
      [[false, false], [true, true], [true, true]]);
    assert.equal(upstream.provider.requests.filter(item => item.method === 'GET').length, 1);
    assert.equal(upstream.provider.requests.find(item => item.method === 'POST')?.kind,
      'native_read_file_call');
    const changedTools = structuredClone(tools);
    changedTools[1].parameters.properties.path.type = 'number';
    const changedPayload = body({ model: 'fixture-native-shell',
      input: 'NATIVE_READ_FILE_PROBE', ...nativeExtras,
      tools: [{ type: 'namespace', name: 'muse', tools: changedTools }] });
    const admitted = requestDecision(request('POST', '/responses',
      { 'content-type': 'application/json' }), changedPayload,
    { ...policy, profile: 'native-read', model: 'fixture-native-shell', workspace });
    assert.equal(admitted.ok, true);
    mutatedUpstream = await startNativeUpstream({ bearer, workspace, protectedRoot,
      canaryToken: 'synthetic-canary-token', hostPort: 1 });
    const providerRefusal = await fetch(`${mutatedUpstream.origin}responses`, {
      method: 'POST', headers: { authorization: `Bearer ${bearer}`,
        'content-type': 'application/json' }, body: admitted.body });
    assert.equal(providerRefusal.status, 422);
    assert.deepEqual(await mutatedUpstream.provider.rejection,
      { kind: 'provider_rejected', code: 'NATIVE_READ_FILE_SCHEMA_INVALID' });
    assert.equal(mutatedUpstream.provider.requests.filter(item =>
      item.method === 'POST').length, 1);
  } finally {
    if (broker) await broker.close();
    if (upstream) await upstream.close();
    if (mutatedUpstream) await mutatedUpstream.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('redirect, response budget, concurrency and disconnect fail closed without replay', { skip: !network }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'passeur-relay-negatives-'));
  const socketDirectory = join(root, 'socket');
  await mkdir(socketDirectory);
  let broker;
  let upstream;
  let releaseHold;
  let enteredResolve;
  const entered = new Promise(resolveValue => { enteredResolve = resolveValue; });
  const seen = [];
  const bearer = 'synthetic-host-held-bearer-0123456789';
  const send = (input, { payload = JSON.stringify({ model, input, tools: [] }), headers = {} } = {}) => new Promise(resolveValue => {
    const client = httpRequest({ socketPath: broker.socketPath, method: 'POST', path: '/responses',
      headers: { host: '127.0.0.1:1', authorization: `Bearer ${dummy}`, 'x-passeur-run': runId,
        'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers } }, response => {
      let bodyText = '';
      response.on('data', chunk => { bodyText += chunk.toString(); });
      response.once('end', () => resolveValue({ status: response.statusCode, body: bodyText }));
      response.once('error', () => resolveValue({ status: response.statusCode, error: 'partial' }));
    });
    client.once('error', () => resolveValue({ error: 'disconnected' }));
    client.end(payload);
  });
  try {
    upstream = createServer(async (request, response) => {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const input = JSON.parse(raw).input;
      seen.push(input);
      if (input === 'redirect') {
        response.writeHead(302, { location: 'http://127.0.0.1:9/elsewhere' }).end();
      } else if (input === 'oversize') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(`data: ${'x'.repeat(256)}\n\n`);
      } else if (input === 'hold') {
        releaseHold = () => { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{}'); };
        enteredResolve();
      } else if (input === 'disconnect') {
        enteredResolve();
        setTimeout(() => { if (!response.destroyed) response.end('{}'); }, 100);
      }
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    broker = await startBroker({ socketPath: join(socketDirectory, 'relay.sock'),
      upstreamOrigin: `http://127.0.0.1:${upstream.address().port}/`, runId, bearer,
      concurrency: 1, responseLimit: 64,
      perRouteBudget: 8,
      allowedInputs: ['redirect', 'oversize', 'hold', 'second', 'disconnect'] });
    assert.equal((await send('redirect', { headers: { 'x-passeur-run': 'run_other' } })).status, 403);
    assert.equal((await send('redirect', { headers: { authorization: 'Bearer injected' } })).status, 403);
    assert.equal((await send('redirect', { payload: 'x'.repeat(REQUEST_OVERSIZE) })).status, 413);
    assert.equal(seen.length, 0);
    assert.equal((await send('redirect')).status, 502);
    const oversized = await send('oversize');
    assert.ok(['partial', 'disconnected'].includes(oversized.error) || oversized.body?.length <= 64,
      JSON.stringify(oversized));
    const held = send('hold');
    await entered;
    assert.equal((await send('second')).status, 429);
    releaseHold();
    releaseHold = undefined;
    assert.equal((await held).status, 200);
    const payload = JSON.stringify({ model, input: 'disconnect', tools: [] });
    const client = httpRequest({ socketPath: broker.socketPath, method: 'POST', path: '/responses',
      headers: { host: '127.0.0.1:1', authorization: `Bearer ${dummy}`, 'x-passeur-run': runId,
        'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } });
    client.on('error', () => undefined);
    client.end(payload);
    for (let attempt = 0; attempt < 40 && !seen.includes('disconnect'); attempt++) {
      await new Promise(resolveValue => setTimeout(resolveValue, 5));
    }
    assert.equal(seen.includes('disconnect'), true);
    client.destroy();
    for (let attempt = 0; attempt < 40 && broker.evidence.disconnected === 0; attempt++) {
      await new Promise(resolveValue => setTimeout(resolveValue, 5));
    }
    assert.ok(broker.evidence.disconnected >= 1);
    assert.deepEqual(seen, ['redirect', 'oversize', 'hold', 'disconnect']);
    assert.equal(broker.evidence.responseLimit, 1);
    assert.equal(broker.evidence.upstream, 4);
  } finally {
    if (releaseHold) releaseHold();
    if (broker) await broker.close();
    if (upstream) await new Promise(resolveValue => upstream.close(resolveValue));
    await rm(root, { recursive: true, force: true });
  }
});

test('replaced pathname survives owned listener shutdown', { skip: !network }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'passeur-relay-replacement-'));
  let upstream;
  let broker;
  try {
    upstream = createServer((_request, response) => response.end('{}'));
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const socketPath = join(root, 'relay.sock');
    broker = await startBroker({ socketPath, upstreamOrigin: `http://127.0.0.1:${upstream.address().port}/`,
      runId, bearer: 'synthetic-host-held-bearer-0123456789' });
    await rename(socketPath, join(root, 'old.sock'));
    await writeFile(socketPath, 'replacement-object');
    await assert.rejects(broker.close(), error => error.code === 'SOCKET_STOP_UNVERIFIED' &&
      error.listenerStopped === true && error.replacementPreserved === true);
    assert.equal(broker.listening, false);
    assert.equal(await readFile(socketPath, 'utf8'), 'replacement-object');
    broker = undefined;
  } finally {
    if (broker?.listening) await broker.close().catch(() => undefined);
    if (upstream) await new Promise(resolveValue => upstream.close(resolveValue));
    await rm(root, { recursive: true, force: true });
  }
});

test('whole-operation deadline stops slow upload and slow SSE without replay', { skip: !network }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'passeur-relay-deadline-'));
  let broker;
  let upstream;
  let ticker;
  let upstreamCalls = 0;
  try {
    upstream = createServer(async (request, response) => {
      upstreamCalls++;
      for await (const _chunk of request) { /* consume only the bounded fixture body */ }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      ticker = setInterval(() => { if (!response.destroyed) response.write('data: x\n\n'); }, 40);
      response.once('close', () => clearInterval(ticker));
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    broker = await startBroker({ socketPath: join(root, 'relay.sock'),
      upstreamOrigin: `http://127.0.0.1:${upstream.address().port}/`, runId,
      bearer: 'synthetic-host-held-bearer-0123456789', deadlineMs: 200 });
    const payload = JSON.stringify({ model, input: 'fixture', tools: [] });
    const headers = { host: '127.0.0.1:1', authorization: `Bearer ${dummy}`,
      'x-passeur-run': runId, 'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload) };
    const upload = await new Promise(resolveValue => {
      const client = httpRequest({ socketPath: broker.socketPath, method: 'POST',
        path: '/responses', headers }, response => {
        response.resume(); response.once('end', () => resolveValue('ended'));
      });
      client.once('error', () => resolveValue('disconnected'));
      const parts = payload.match(/.{1,8}/g);
      let index = 0;
      const sendPart = () => {
        if (index >= parts.length || client.destroyed) return;
        client.write(parts[index++]);
        setTimeout(sendPart, 40);
      };
      sendPart();
    });
    assert.equal(upload, 'disconnected');
    assert.equal(upstreamCalls, 0);
    assert.equal(broker.evidence.deadline, 1);
    const stream = await new Promise(resolveValue => {
      const client = httpRequest({ socketPath: broker.socketPath, method: 'POST',
        path: '/responses', headers }, response => {
        response.resume();
        response.once('end', () => resolveValue('ended'));
        response.once('error', () => resolveValue('disconnected'));
      });
      client.once('error', () => resolveValue('disconnected'));
      client.end(payload);
    });
    assert.equal(stream, 'disconnected');
    assert.equal(upstreamCalls, 1);
    assert.equal(broker.evidence.deadline, 2);
    assert.equal(broker.evidence.upstream, 1);
  } finally {
    if (ticker) clearInterval(ticker);
    if (broker) await broker.close();
    if (upstream) await new Promise(resolveValue => upstream.close(resolveValue));
    await rm(root, { recursive: true, force: true });
  }
});
