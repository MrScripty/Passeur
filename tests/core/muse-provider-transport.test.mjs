import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer as createTlsServer } from 'node:https';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startProviderTransport } from '../../dist/src/muse/provider-transport.js';

const CERT = "-----BEGIN CERTIFICATE-----\nMIIDJTCCAg2gAwIBAgIUemlCZFSlCzOWt/BGL8Y7YLC1ZsowDQYJKoZIhvcNAQEL\nBQAwFjEUMBIGA1UEAwwLYXBpLm1ldGEuYWkwHhcNMjYwOTI4MjIwNTAyWhcNMzYw\nOTI1MjIwNTAyWjAWMRQwEgYDVQQDDAthcGkubWV0YS5haTCCASIwDQYJKoZIhvcN\nAQEBBQADggEPADCCAQoCggEBALB8Og7Tzngm4XZQyGEF3x/KztnwWVcP0hd96fax\niQNb/Mry3wFbfQ+D3MK23d3Si2zZue0s+f0BsOPwgPfE/DgxwDNSjvZwjgMxqAGW\n3BotuwmS38W5RsPM2ykzpDJfI+uYAxdukE4CAqg2orxRo4lT4SVFYliDrzc8hRR0\nPdyuQ75+7jrCcSbaNVVSMKYtdUt0tPj5FXKpWCqw2m65KQmXlP8xaf6lhvrm7qDH\nTYvdiQVptPZEEcwf5xwe4qIV5zZZQB/IrkM34WEe+J+eC52DckvsmO8ozrHVuPSJ\nfcmRZTTgnpVy/C9E/Jui2GfSlVf6PMJc6Pl/PM5HV0i1+L0CAwEAAaNrMGkwHQYD\nVR0OBBYEFC3NLfZJmMZn1qDyjXQcydMOOl4nMB8GA1UdIwQYMBaAFC3NLfZJmMZn\n1qDyjXQcydMOOl4nMA8GA1UdEwEB/wQFMAMBAf8wFgYDVR0RBA8wDYILYXBpLm1l\ndGEuYWkwDQYJKoZIhvcNAQELBQADggEBAIV5IPqAL7mLKS5Nd688wDUmCS1kqCdK\n7LwrR98wZoQ0nyGn+vE8kj0jDO5+QvhcL3LYTSP5vELxeR2YtXND5rDlzC/0ozR1\ne+iTNFJNmgbcBjk6B57fBTmaK9PzQacd9trfTeDKpSO4UjLrXf66l4mjJ5nnHoyb\nGCbjvZJoeyhl/jeRToL6NQNIeVqJsV+5R+aUsjK2yd65mXZFkafA5kGAIk5fgs5g\nzuzvevmGd11FCTzmgtLNLm+Br05kD6hcqe2vNNVYnQiwvhS6Gs+P9sHh1yxmveYF\ngCHi/KJ509xuACu5vqVwWcpnPTAcC+d5vqgWw86MxO+qnpjJAEq2BWg=\n-----END CERTIFICATE-----\n";
const KEY = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCwfDoO0854JuF2\nUMhhBd8fys7Z8FlXD9IXfen2sYkDW/zK8t8BW30Pg9zCtt3d0ots2bntLPn9AbDj\n8ID3xPw4McAzUo72cI4DMagBltwaLbsJkt/FuUbDzNspM6QyXyPrmAMXbpBOAgKo\nNqK8UaOJU+ElRWJYg683PIUUdD3crkO+fu46wnEm2jVVUjCmLXVLdLT4+RVyqVgq\nsNpuuSkJl5T/MWn+pYb65u6gx02L3YkFabT2RBHMH+ccHuKiFec2WUAfyK5DN+Fh\nHvifngudg3JL7JjvKM6x1bj0iX3JkWU04J6VcvwvRPybothn0pVX+jzCXOj5fzzO\nR1dItfi9AgMBAAECggEAA3xiYZ08dQa73BoClzTc8osPWT27Hpa3Ot0Of7sV551C\noKpMDkIO0WsZKkj6vNE6sdiHhBKDYx/VdjhB2ieQ3aO1o8JxqWAaiyAbWrz3sQ0b\n+K5nBggESI5H1cOb0zAqPwBtU32xZVdWLnS/POlanAhS2qk2yYkknMzMLtXZp6tc\n9buFN/Mc5k0VTvJl6nZZ0j4jI/t4alu07PiDmmmXYvpZk1ty1KzRHUstEBWKx1Zt\nmKuBI5/8dubvZenEi53DPSpfXm2kdxjQnwt2sXx6QyWuiiQdImAs+wUjHxUBQ29u\n+G5rtQoR3cm1GLUvdSM0RvxmGoS6SoPzqEPfkk89CQKBgQDWcBQ/H8hd0z1Xux2W\nE2eQAhtN/k9Q4J5A20FiuZvEqlEm2Lav9/E0fpS0u+4BzxpoiJfOFsznEKydfNG5\nrSHzholaEBnbKQyzTNPRWTzuYKW/H3EBFo93txso0vW79fPK+NyKnSuUcrbXUGCR\nnp9I5cj10uDYCHxZpStib+5SWQKBgQDSsQccoX9iiqFUOi9ZCOKO0swUaONk7atR\nCWkC8RARi1ZIhRO3plXVAo96G+8VjzFk4X2gyCzPisx74KiDt/zGJsKMvv/hRdVg\nm5cur9iipBp7mfjUfAE3U5Y5U0wVbCjcqSzz4+zKeICbhJG1ydbhpLxxl2gSs5Xd\nBbQDgHOlBQKBgCWcnQCBa5yBW6YSrNrQ5n5M0Es6yuCttTQ9ANf3JEo3cWp14n00\n6PrDJQQaXmG02LXzF2VPfHse4pfw97wwkN7s/xRr9I0LQy4D0LdMhrJtA0Vll2WQ\ndnOSC1J6xh1Ew5EbW1t4u9ca09UqRPXls5yOqVPsvAFIY785iEWIym1pAoGBAK8V\nd4B+YDpGU6yHsaL+dC8V04u+YgEUVEJCXKaaJq09qhUXqXv62ObresmRfwvec8CO\ndfRvhHVvtV/YIJFdCsyrlw6ZBlBw1NG0WlzsukzlrDA8koAZEHWmm3bF1rsSp54/\nY+DE7piOrOkPsHpt4Yifeg23MUAhRo9mVuJ2EyP1AoGABFSZOKMMjA9n8HJkUutg\ncTM7ntkYj+Syq/x9nqoNIoF+kdYqgV0DudLsMpFLb2KBm9JPpjcAM1VvEDaHr2N5\nZ1bgqHShYG5vcSWEje1gaw534e0dyty8C2qy8oAgJ8B6rtaqz+4hOrzPcoFJLXf4\nn1hW7lRBu1lKu+uIUpskp68=\n-----END PRIVATE KEY-----\n";
const lookup = (_host, options, callback) => queueMicrotask(() => options.all
  ? callback(null, [{ address: '127.0.0.1', family: 4 }])
  : callback(null, '127.0.0.1', 4));

async function fixture(onUpstream = (_request, response) => response.end('ok'), extra = {}) {
  const root = await mkdtemp(join(tmpdir(), 'passeur-provider-transport-'));
  const peer = createTlsServer({ key: KEY, cert: CERT }, onUpstream);
  await new Promise(resolve => peer.listen(0, '127.0.0.1', resolve));
  const socketPath = join(root, 'relay.sock');
  const controller = new AbortController();
  const { testPeer: peerOverride, ...rest } = extra;
  const transport = await startProviderTransport({ socketPath,
    getBearer: async () => ({ value: 'synthetic-host-secret', expiresAt: Date.now() + 60_000 }),
    signal: controller.signal,
    testPeer: { port: peer.address().port, lookup, ca: CERT, ...peerOverride }, ...rest });
  return { socketPath, peer, transport, controller,
    async close() { await transport.close(); await new Promise(resolve => peer.close(resolve));
      await rm(root, { recursive: true, force: true }); } };
}

async function call(socketPath, path = '/v1/models', headers = {}, body) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ socketPath, path, method: body === undefined ? 'GET' : 'POST',
      headers: { host: 'api.meta.ai', ...headers } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('end', () => resolve({ status: response.statusCode,
        body: Buffer.concat(chunks).toString(), headers: response.headers }));
      response.once('error', reject);
    });
    request.once('error', reject);
    request.end(body);
  });
}

test('fixed route replaces guest auth and strips destination and extra headers', async () => {
  const seen = [];
  const f = await fixture((request, response) => {
    seen.push({ url: request.url, method: request.method, headers: request.headers });
    response.setHeader('content-type', 'application/json');
    response.end('{"models":[]}');
  });
  try {
    assert.equal((await call(f.socketPath, '/v1/models', {
      authorization: 'Bearer guest-secret', 'x-guest-secret': 'guest-value' })).status, 200);
    assert.equal((await call(f.socketPath, '/v1/models', { host: '127.0.0.1:1' })).status, 200);
    assert.equal((await call(f.socketPath, '/v1/responses',
      { 'content-type': 'application/json', authorization: 'Bearer guest-secret' }, '{}')).status, 200);
    assert.equal(seen.length, 3);
    assert.deepEqual(seen.map(item => [item.method, item.url]),
      [['GET', '/v1/models'], ['GET', '/v1/models'], ['POST', '/v1/responses']]);
    assert.equal(seen[0].headers.authorization, 'Bearer synthetic-host-secret');
    assert.equal(seen[0].headers['x-guest-secret'], undefined);
    assert.equal(seen[0].headers.host, 'api.meta.ai');
    for (const [path, headers] of [
      ['/v1/models?target=evil', {}], ['https://evil.test/v1/models', {}],
      ['/v1/models', { host: 'evil.test' }], ['/v1/models', { 'x-forwarded-host': 'evil.test' }],
      ['/v1/models', { 'proxy-authorization': 'Basic secret' }]
    ]) assert.equal((await call(f.socketPath, path, headers)).status, 400);
    assert.equal(seen.length, 3);
  } finally { await f.close(); }
});

test('TLS identity is verified and upstream redirects are refused', async () => {
  const f = await fixture((_request, response) => {
    response.writeHead(302, { location: 'https://evil.test/steal' }).end();
  });
  try { assert.equal((await call(f.socketPath)).status, 502); }
  finally { await f.close(); }
  const g = await fixture((_request, response) => response.end('not reachable'),
    { testPeer: { ca: '' } });
  try { assert.equal((await call(g.socketPath)).status, 502); }
  finally { await g.close(); }
});

test('expired host bearer fails without contacting peer or exposing values', async () => {
  let requests = 0;
  const f = await fixture((_request, response) => { requests++; response.end('bad'); },
    { getBearer: async () => ({ value: 'sensitive-expired', expiresAt: Date.now() - 1 }) });
  try {
    const result = await call(f.socketPath);
    assert.equal(result.status, 503);
    assert.equal(result.body, '');
    assert.equal(requests, 0);
  } finally { await f.close(); }
});

test('request count, body and response bounds reject without forwarding excess data', async () => {
  let requests = 0;
  const f = await fixture((_request, response) => { requests++; response.end('ok'); });
  try {
    for (let index = 0; index < 32; index++)
      assert.equal((await call(f.socketPath)).status, 200);
    assert.equal((await call(f.socketPath)).status, 429);
    assert.equal(requests, 32);
  } finally { await f.close(); }
  const g = await fixture((_request, response) => { response.writeHead(200,
    { 'content-length': String(8 * 1024 * 1024 + 1) }).end(); });
  try {
    assert.equal((await call(g.socketPath)).status, 502);
    assert.equal((await call(g.socketPath, '/v1/models',
      { 'content-length': String(262_145) })).status, 400);
  } finally { await g.close(); }
});

test('four active streams occupy capacity until task cancellation', async () => {
  let count = 0;
  let release;
  const reached = new Promise(resolve => { release = resolve; });
  const f = await fixture((_request, response) => {
    count++;
    if (count === 4) release();
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: waiting\n\n');
  });
  try {
    const pending = Array.from({ length: 4 }, () => call(f.socketPath).catch(() => null));
    await reached;
    assert.equal((await call(f.socketPath)).status, 429);
    assert.equal(count, 4);
    f.controller.abort();
    await Promise.all(pending);
  } finally { await f.close(); }
});

test('partial upstream response does not become a completed response or replay', async () => {
  let requests = 0;
  const f = await fixture((_request, response) => {
    requests++;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: partial\n\n');
    setTimeout(() => response.socket.destroy(), 20);
  });
  try {
    await assert.rejects(call(f.socketPath));
    assert.equal(requests, 1);
  } finally { await f.close(); }
});

test('streaming response limit terminates the client stream without retry', async () => {
  let requests = 0;
  const f = await fixture((_request, response) => {
    requests++;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = Buffer.alloc(1024 * 1024, 65);
    for (let index = 0; index < 9; index++) response.write(chunk);
    response.end();
  });
  try {
    await assert.rejects(call(f.socketPath));
    assert.equal(requests, 1);
  } finally { await f.close(); }
});

test('task abort retires listener and in-flight socket', async () => {
  let arrived;
  const reached = new Promise(resolve => { arrived = resolve; });
  const f = await fixture((_request, response) => { arrived(); response.write('data: held\n\n'); });
  try {
    const pending = call(f.socketPath);
    await reached;
    f.controller.abort();
    await assert.rejects(pending);
    await assert.rejects(call(f.socketPath));
  } finally { await f.close(); }
});

test('abort during listener startup settles and leaves no reachable socket', async () => {
  const root = await mkdtemp(join(tmpdir(), 'passeur-provider-startup-'));
  const socketPath = join(root, 'relay.sock');
  const controller = new AbortController();
  try {
    const starting = startProviderTransport({ socketPath, signal: controller.signal,
      getBearer: async () => ({ value: 'synthetic-host-secret' }) });
    controller.abort();
    let timer;
    try {
      await assert.rejects(Promise.race([
        starting,
        new Promise((_resolve, reject) => { timer = setTimeout(() =>
          reject(new Error('STARTUP_DID_NOT_SETTLE')), 1000); })
      ]), { message: 'PROVIDER_TRANSPORT_LISTEN_FAILED' });
    } finally { clearTimeout(timer); }
    await assert.rejects(call(socketPath));
  } finally { await rm(root, { recursive: true, force: true }); }
});
