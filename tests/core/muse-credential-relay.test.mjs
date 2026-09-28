import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { assertSocketIdentity, relaySandboxConfig, requestDecision, startBroker,
  startGuestRelay, captureFixtureProcesses, verifyFixtureStop } from '../../scripts/qualify-muse-credential-relay.mjs';
import { prepareSandbox } from '../../scripts/experiment-worker-sandbox.mjs';

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
