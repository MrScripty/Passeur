import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertHostOnlyProviderDirectory, fixtureRoute,
  startFixtureProviderTransport } from '../../scripts/qualify-muse-provider-transport.mjs';
import { startBroker } from '../../scripts/qualify-muse-credential-relay.mjs';
import { requestDecision } from '../../scripts/qualify-muse-credential-relay.mjs';
import { shellCommitCommand } from '../../scripts/qualify-muse-sandbox-transport.mjs';

function call(socketPath, path, method = 'GET', headers = {}, body) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ socketPath, path, method,
      headers: { host: 'api.meta.ai', authorization: 'Bearer passeur-disposable-dummy-key',
        'x-passeur-run': 'run_fixture', ...headers } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('end', () => resolve({ status: response.statusCode,
        body: Buffer.concat(chunks).toString() }));
      response.once('error', reject);
    });
    request.once('error', reject);
    request.end(body);
  });
}

test('fixture translation admits only observed native method and route pairs', () => {
  assert.equal(fixtureRoute('GET', '/v1/models'), '/muse-code/models');
  assert.equal(fixtureRoute('POST', '/v1/responses'), '/responses');
  for (const [method, route] of [['POST', '/v1/models'], ['GET', '/v1/responses'],
    ['GET', '/v1/models?x=1'], ['POST', 'https://evil.test/v1/responses'],
    ['POST', '/responses'], ['GET', '/muse-code/models']]) {
    assert.equal(fixtureRoute(method, route), null);
  }
});

test('built host transport sends fixed candidate route, TLS Host and host bearer only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'passeur-fixture-provider-'));
  const workspace = await mkdtemp(join(tmpdir(), 'passeur-fixture-workspace-'));
  const protectedRoot = join(root, 'protected');
  await Promise.all([mkdir(protectedRoot), mkdir(join(root, 'socket'))]);
  const f = await startFixtureProviderTransport({ workspace, protectedRoot,
    canaryToken: 'synthetic-canary', hostPort: 1, shell: true, taskCommit: true,
    adapterMode: true, guestMountSources: [workspace, join(root, 'socket')] });
  try {
    assert.equal(f.transportSocketPath.startsWith(`${join(root, 'socket')}/`), false);
    assert.deepEqual(await readdir(join(root, 'socket')), []);
    await assert.rejects(assertHostOnlyProviderDirectory(join(root, 'provider-transport'), [root,
      workspace]), /FIXTURE_PROVIDER_MOUNT_OVERLAP/);
    const catalog = await call(f.transportSocketPath, '/v1/models');
    assert.equal(catalog.status, 200);
    assert.equal(JSON.parse(catalog.body).data[0].id, 'fixture-native-shell');
    assert.deepEqual(f.seen, [{ method: 'GET', path: '/v1/models', correctBearer: true,
      dummyAbsent: true, runHeaderAbsent: true, tls: true,
      bodySha256: createHash('sha256').update('').digest('hex') }]);
    assert.equal((await call(f.transportSocketPath, '/v1/models?x=1')).status, 400);
    assert.equal(f.seen.length, 1);
  } finally { await f.close(); }
});

test('native catalog passes broker admission and reaches TLS peer on candidate route', async () => {
  const root = await mkdtemp(join(tmpdir(), 'passeur-fixture-chain-'));
  const workspace = await mkdtemp(join(tmpdir(), 'passeur-fixture-workspace-'));
  const protectedRoot = join(root, 'protected');
  await Promise.all([mkdir(protectedRoot), mkdir(join(root, 'socket'))]);
  const f = await startFixtureProviderTransport({ workspace, protectedRoot,
    canaryToken: 'synthetic-canary', hostPort: 1, shell: true, taskCommit: true,
    adapterMode: true, guestMountSources: [workspace, join(root, 'socket')] });
  let broker;
  try {
    broker = await startBroker({ socketPath: join(root, 'socket', 'relay.sock'),
      upstreamOrigin: f.origin, transportSocketPath: f.transportSocketPath,
      runId: 'run_fixture_123', bearer: 'synthetic-broker-bearer-1234567890',
      profile: 'native-shell', workspace,
      shellCommand: shellCommitCommand(workspace, protectedRoot, 'synthetic-canary') });
    const result = await call(join(root, 'socket', 'relay.sock'), '/muse-code/models', 'GET',
      { host: '127.0.0.1:1', 'x-passeur-run': 'run_fixture_123' });
    assert.equal(result.status, 200, result.body);
    assert.equal(JSON.parse(result.body).data[0].id, 'fixture-native-shell');
    assert.equal(broker.evidence.accepted, 1);
    assert.deepEqual(f.seen.map(value => [value.method, value.path, value.tls,
      value.correctBearer, value.dummyAbsent, value.runHeaderAbsent]),
    [['GET', '/v1/models', true, true, true, true]]);
    const envelope = { model: 'fixture-native-shell',
      input: 'NATIVE_SHELL_PROBE: fixed disposable command',
      include: ['reasoning.encrypted_content'], instructions: 'synthetic instructions',
      max_output_tokens: 128_000, prompt_cache_key: 'x'.repeat(45),
      store: false, stream: true, tools: [{ type: 'namespace', name: 'muse',
        tools: [{ type: 'function', name: 'submit_reminder_decision',
          parameters: { type: 'object', properties: {} } }] }] };
    const nativeBody = JSON.stringify(envelope);
    const projected = requestDecision({ method: 'POST', url: '/responses',
      headers: { host: '127.0.0.1:1', authorization: 'Bearer passeur-disposable-dummy-key',
        'x-passeur-run': 'run_fixture_123', 'content-type': 'application/json' } },
    Buffer.from(nativeBody), { runId: 'run_fixture_123', profile: 'native-shell',
      workspace, issuedShell: null });
    assert.equal(projected.ok, true);
    const post = await call(join(root, 'socket', 'relay.sock'), '/responses', 'POST',
      { host: '127.0.0.1:1', 'x-passeur-run': 'run_fixture_123',
        'content-type': 'application/json' }, nativeBody);
    assert.equal(post.status, 502, post.body);
    assert.equal(f.seen[1].path, '/v1/responses');
    assert.equal(f.seen[1].bodySha256,
      createHash('sha256').update(projected.body).digest('hex'));
    assert.notEqual(f.seen[1].bodySha256,
      createHash('sha256').update(nativeBody).digest('hex'));
    assert.equal((await call(join(root, 'socket', 'relay.sock'),
      '/muse-code/models?x=1', 'GET',
      { host: '127.0.0.1:1', 'x-passeur-run': 'run_fixture_123' })).status, 403);
    assert.equal(f.seen.length, 2);
  } finally { await broker?.close(); await f.close(); }
});

test('fixture chain fails closed when TLS peer cannot be authenticated', async () => {
  const root = await mkdtemp(join(tmpdir(), 'passeur-fixture-bad-tls-'));
  const workspace = await mkdtemp(join(tmpdir(), 'passeur-fixture-workspace-'));
  const protectedRoot = join(root, 'protected');
  await Promise.all([mkdir(protectedRoot), mkdir(join(root, 'socket'))]);
  const f = await startFixtureProviderTransport({ workspace, protectedRoot,
    canaryToken: 'synthetic-canary', hostPort: 1, shell: true, taskCommit: true,
    adapterMode: true, guestMountSources: [workspace, join(root, 'socket')],
    testPeer: { ca: '' } });
  let broker;
  try {
    broker = await startBroker({ socketPath: join(root, 'socket', 'relay.sock'),
      upstreamOrigin: f.origin, transportSocketPath: f.transportSocketPath,
      runId: 'run_fixture_123', bearer: 'synthetic-broker-bearer-1234567890',
      profile: 'native-shell', workspace,
      shellCommand: shellCommitCommand(workspace, protectedRoot, 'synthetic-canary') });
    const result = await call(join(root, 'socket', 'relay.sock'), '/muse-code/models', 'GET',
      { host: '127.0.0.1:1', 'x-passeur-run': 'run_fixture_123' });
    assert.equal(result.status, 502);
    assert.equal(f.seen.length, 0);
    assert.equal(broker.evidence.accepted, 1);
    assert.ok(broker.evidence.firstFailure);
  } finally { await broker?.close(); await f.close(); }
});
