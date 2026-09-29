import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer as createHttpsServer } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection, createServer as createNetServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import { classifyAuthority, createGuestConnectProxy, retireGuestConnectProxy,
  deniedAuthorityEvidence, startProtectedEgress } from '../../dist/src/agents/codex/protected-egress.js';

function connect(options, authority) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ ...options, method: 'CONNECT', path: authority,
      headers: { host: authority } });
    request.once('connect', (response, socket) => resolve({ status: response.statusCode, socket }));
    request.once('error', reject); request.end();
  });
}

test('exact authority classification refuses OAuth, malformed and unknown destinations', () => {
  const classify = authority => classifyAuthority(authority, 'accounts.fixture.invalid', 'inference.fixture.invalid');
  assert.equal(classify('accounts.fixture.invalid:443'), 'account');
  assert.equal(classify('inference.fixture.invalid:443'), 'inference');
  assert.equal(classify('auth.openai.com:443'), 'oauth_denied');
  for (const authority of ['auth.openai.com:80', 'other.invalid:443', 'accounts.fixture.invalid:444',
    'accounts.fixture.invalid:443@other.invalid', 'ACCOUNTS.fixture.invalid:443', 'accounts..fixture.invalid:443']) {
    assert.equal(classify(authority), 'unknown_denied');
  }
});

test('first-party broker admits only exact chatgpt.com CONNECT on disposable loopback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'passeur-codex-first-party-egress-'));
  const socketPath = join(root, 'broker.sock');
  const upstream = createNetServer(socket => socket.pipe(socket));
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const port = upstream.address().port;
  const deniedCategories = [];
  const broker = await startProtectedEgress({ socketPath, accountHost: 'chatgpt.com',
    inferenceHost: 'chatgpt.com', accountPort: port, inferencePort: port, firstParty: true,
    onDeniedAuthority: category => deniedCategories.push(category) });
  try {
    const admitted = await connect({ socketPath }, 'chatgpt.com:443');
    assert.equal(admitted.status, 200);
    admitted.socket.destroy();
    for (const authority of ['chatgpt.com:444', 'other.invalid:443', 'api.openai.com:443', 'ab.chatgpt.com:443']) {
      const denied = await connect({ socketPath }, authority).catch(() => null);
      if (denied) { assert.equal(denied.status, 403); denied.socket.destroy(); }
    }
    assert.equal(broker.counts.first_party, 1);
    assert.equal(broker.counts.account, 0);
    assert.equal(broker.counts.inference, 0);
    assert.deepEqual(deniedCategories, [{ category: 'malformed' },
      { category: 'other_valid', sha256: createHash('sha256').update('other.invalid:443').digest('hex'), byteLength: 17 },
      { category: 'api_openai' }, { category: 'statsig_metrics' }]);
    assert.equal(broker.counts.unknown_denied, 4);
  } finally {
    await broker.close(); upstream.closeAllConnections?.();
    await new Promise(resolve => upstream.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('denied authority evidence never includes raw authority or arbitrary malformed input', () => {
  const tokenLike = 'tokenlikehost.invalid:443';
  const evidence = deniedAuthorityEvidence(tokenLike);
  assert.equal(evidence.category, 'other_valid');
  assert.equal(evidence.byteLength, Buffer.byteLength(tokenLike));
  assert.equal(evidence.sha256, createHash('sha256').update(tokenLike).digest('hex'));
  assert.doesNotMatch(JSON.stringify(evidence), /tokenlikehost/);
  assert.deepEqual(deniedAuthorityEvidence('TOKENLIKE.invalid:443'), { category: 'malformed' });
  assert.deepEqual(deniedAuthorityEvidence('ab.chatgpt.com:443'), { category: 'statsig_metrics' });
});

test('guest CONNECT and direct Unix clients share host authority policy; close retires live tunnel', async () => {
  const root = await mkdtemp(join(tmpdir(), 'passeur-codex-egress-'));
  const socketPath = join(root, 'broker.sock');
  const upstream = createNetServer(socket => socket.pipe(socket));
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = upstream.address().port;
  const broker = await startProtectedEgress({ socketPath, accountHost: 'accounts.fixture.invalid',
    inferenceHost: 'inference.fixture.invalid', accountPort: upstreamPort, inferencePort: upstreamPort });
  const guest = createGuestConnectProxy(socketPath);
  await new Promise(resolve => guest.listen(0, '127.0.0.1', resolve));
  try {
    assert.equal((await stat(socketPath)).mode & 0o777, 0o600);
    const guestPort = guest.address().port;
    const direct = await connect({ socketPath }, 'other.invalid:443');
    assert.equal(direct.status, 403); direct.socket.destroy();
    const admitted = await connect({ hostname: '127.0.0.1', port: guestPort }, 'accounts.fixture.invalid:443');
    assert.equal(admitted.status, 200);
    const echoed = new Promise(resolve => admitted.socket.once('data', bytes => resolve(bytes.toString('utf8'))));
    admitted.socket.write('loopback-only');
    assert.equal(await echoed, 'loopback-only');
    const guestRetired = new Promise(resolve => admitted.socket.once('close', resolve));
    const denied = await connect({ hostname: '127.0.0.1', port: guestPort }, 'auth.openai.com:443')
      .catch(() => null);
    denied?.socket.destroy();
    await broker.close();
    await guestRetired;
    assert.equal(broker.authDenied(), true);
    assert.equal(broker.active(), 0);
    assert.equal(broker.accepted(), 3);
    assert.equal(admitted.socket.destroyed, true);
    assert.deepEqual(broker.counts, { account: 1, inference: 0, first_party: 0, oauth_denied: 1,
      unknown_denied: 1, latched_denied: 0 });
    await assert.rejects(stat(socketPath));
  } finally {
    guest.closeAllConnections(); await new Promise(resolve => guest.close(resolve));
    upstream.closeAllConnections?.(); await new Promise(resolve => upstream.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('broker cancellation closes a stalled partial CONNECT before retiring socket', async () => {
  const root = await mkdtemp(join(tmpdir(), 'passeur-codex-egress-pending-'));
  const socketPath = join(root, 'broker.sock');
  const broker = await startProtectedEgress({ socketPath, accountHost: 'accounts.fixture.invalid',
    inferenceHost: 'inference.fixture.invalid', accountPort: 39174, inferencePort: 39175 });
  const pending = createConnection(socketPath);
  pending.on('error', () => {});
  try {
    await new Promise(resolve => pending.once('connect', resolve));
    pending.write('CONNECT accounts.fixture.invalid:443 HTTP/1.1\r\n');
    const retired = new Promise(resolve => pending.once('close', resolve));
    await broker.close(); await retired;
    assert.equal(broker.active(), 0);
    await assert.rejects(stat(socketPath));
  } finally { pending.destroy(); await rm(root, { recursive: true, force: true }); }
});

test('first denied OAuth latches before reply, retires active and pending tunnels, and refuses later admission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'passeur-codex-egress-latch-'));
  const socketPath = join(root, 'broker.sock');
  const upstream = createNetServer(socket => socket.pipe(socket));
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  let notified = 0;
  const broker = await startProtectedEgress({ socketPath, accountHost: 'accounts.fixture.invalid',
    inferenceHost: 'inference.fixture.invalid', accountPort: upstream.address().port,
    inferencePort: upstream.address().port, onTerminalDenial: reason => {
      assert.equal(reason, 'refresh_denied'); notified++;
    } });
  let live, pending;
  try {
    live = await connect({ socketPath }, 'accounts.fixture.invalid:443');
    assert.equal(live.status, 200);
    pending = createConnection(socketPath); pending.on('error', () => {});
    await new Promise(resolve => pending.once('connect', resolve));
    pending.write('CONNECT inference.fixture.invalid:443 HTTP/1.1\r\n');
    const liveClosed = new Promise(resolve => live.socket.once('close', resolve));
    const pendingClosed = new Promise(resolve => pending.once('close', resolve));
    await connect({ socketPath }, 'auth.openai.com:443').then(value => value.socket.destroy()).catch(() => {});
    await Promise.all([liveClosed, pendingClosed]);
    assert.equal(notified, 1);
    assert.equal(broker.authDenied(), true);
    assert.equal(broker.latchReason(), 'refresh_denied');
    assert.equal(broker.denyUnauthorizedUpstream(), 'refresh_denied');
    assert.equal(broker.counts.oauth_denied, 1);
    assert.equal(broker.counts.latched_denied, 1);
    await connect({ socketPath }, 'accounts.fixture.invalid:443').then(value => value.socket.destroy()).catch(() => {});
    assert.equal(broker.counts.account, 1);
    assert.equal(broker.counts.latched_denied, 2);
    await broker.close();
    assert.equal(broker.active(), 0);
  } finally {
    live?.socket.destroy(); pending?.destroy(); await broker.close();
    upstream.closeAllConnections?.(); await new Promise(resolve => upstream.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('trusted upstream unauthorized latch retires active and pending tunnels and keeps first reason', async () => {
  const root = await mkdtemp(join(tmpdir(), 'passeur-codex-egress-upstream-'));
  const socketPath = join(root, 'broker.sock');
  const upstream = createNetServer(socket => socket.pipe(socket));
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const reasons = [];
  const broker = await startProtectedEgress({ socketPath, accountHost: 'accounts.fixture.invalid',
    inferenceHost: 'inference.fixture.invalid', accountPort: upstream.address().port,
    inferencePort: upstream.address().port, onTerminalDenial: reason => reasons.push(reason) });
  let live, pending;
  try {
    live = await connect({ socketPath }, 'inference.fixture.invalid:443');
    assert.equal(live.status, 200);
    pending = createConnection(socketPath); pending.on('error', () => {});
    await new Promise(resolve => pending.once('connect', resolve));
    pending.write('CONNECT accounts.fixture.invalid:443 HTTP/1.1\r\n');
    const liveClosed = new Promise(resolve => live.socket.once('close', resolve));
    const pendingClosed = new Promise(resolve => pending.once('close', resolve));
    assert.equal(broker.denyUnauthorizedUpstream(), 'upstream_unauthorized');
    await Promise.all([liveClosed, pendingClosed]);
    assert.equal(broker.denyUnauthorizedUpstream(), 'upstream_unauthorized');
    await connect({ socketPath }, 'auth.openai.com:443').then(value => value.socket.destroy()).catch(() => {});
    assert.deepEqual(reasons, ['upstream_unauthorized']);
    assert.equal(broker.latchReason(), 'upstream_unauthorized');
    assert.equal(broker.counts.oauth_denied, 0);
    assert.equal(broker.counts.inference, 1);
    assert.ok(broker.counts.latched_denied >= 1);
    await broker.close();
    assert.equal(broker.active(), 0);
    await assert.rejects(stat(socketPath));
  } finally {
    live?.socket.destroy(); pending?.destroy(); await broker.close();
    upstream.closeAllConnections?.(); await new Promise(resolve => upstream.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('TLS refusal latch closes a live tunnel, rejects queued admission and preserves its reason', async () => {
  const root = await mkdtemp(join(tmpdir(), 'passeur-codex-egress-refusal-'));
  const socketPath = join(root, 'broker.sock');
  const upstream = createNetServer(socket => socket.pipe(socket));
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const reasons = [];
  const broker = await startProtectedEgress({ socketPath, accountHost: 'accounts.fixture.invalid',
    inferenceHost: 'inference.fixture.invalid', accountPort: upstream.address().port,
    inferencePort: upstream.address().port, onTerminalDenial: reason => reasons.push(reason) });
  let live, pending;
  try {
    live = await connect({ socketPath }, 'inference.fixture.invalid:443');
    assert.equal(live.status, 200);
    pending = createConnection(socketPath); pending.on('error', () => {});
    await new Promise(resolve => pending.once('connect', resolve));
    const closed = [new Promise(resolve => live.socket.once('close', resolve)),
      new Promise(resolve => pending.once('close', resolve))];
    assert.equal(broker.denyTlsRefusal(), 'tls_refused');
    pending.write('CONNECT accounts.fixture.invalid:443 HTTP/1.1\r\nHost: accounts.fixture.invalid:443\r\n\r\n');
    await Promise.all(closed);
    assert.equal(broker.denyUnauthorizedUpstream(), 'tls_refused');
    await connect({ socketPath }, 'auth.openai.com:443').then(value => value.socket.destroy()).catch(() => {});
    assert.deepEqual(reasons, ['tls_refused']);
    assert.equal(broker.counts.oauth_denied, 0);
    assert.equal(broker.counts.inference, 1);
    assert.ok(broker.counts.latched_denied >= 1);
    await broker.close();
    assert.equal(broker.active(), 0);
    await assert.rejects(stat(socketPath));
  } finally {
    live?.socket.destroy(); pending?.destroy(); await broker.close();
    upstream.closeAllConnections?.(); await new Promise(resolve => upstream.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('mismatched-host TLS session latches only after the peer closes without an HTTP request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'passeur-codex-egress-wrong-host-'));
  const key = join(root, 'peer.key'), cert = join(root, 'peer.pem'), socketPath = join(root, 'broker.sock');
  execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=accounts.fixture.invalid', '-addext', 'subjectAltName=DNS:accounts.fixture.invalid',
    '-keyout', key, '-out', cert], { stdio: 'ignore', timeout: 10_000 });
  let requests = 0, broker, peerClosed = false, peerSecure = 0, peerTlsError = 0;
  const tls = createHttpsServer({ key: await readFile(key), cert: await readFile(cert) },
    (_request, response) => { requests++; response.writeHead(200).end(); });
  const observe = socket => {
    assert.equal(socket.servername, 'inference.fixture.invalid');
    const closed = () => {
      peerClosed = true;
      if (requests === 0) broker.denyTlsRefusal();
    };
    if (socket.destroyed) closed(); else socket.once('close', closed);
  };
  tls.on('secureConnection', socket => { peerSecure++; observe(socket); });
  tls.on('tlsClientError', (_error, socket) => { peerTlsError++; observe(socket); });
  await new Promise(resolve => tls.listen(0, '127.0.0.1', resolve));
  const reasons = [];
  broker = await startProtectedEgress({ socketPath, accountHost: 'accounts.fixture.invalid',
    inferenceHost: 'inference.fixture.invalid', accountPort: tls.address().port,
    inferencePort: tls.address().port, onTerminalDenial: reason => reasons.push(reason) });
  try {
    const admitted = await connect({ socketPath }, 'inference.fixture.invalid:443');
    assert.equal(admitted.status, 200);
    const secure = tlsConnect({ socket: admitted.socket, servername: 'inference.fixture.invalid',
      ca: await readFile(cert), rejectUnauthorized: true });
    await new Promise(resolve => { secure.once('error', resolve); secure.once('close', resolve); });
    for (let i = 0; i < 20 && reasons.length === 0; i++)
      await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(peerClosed, true);
    assert.equal(peerSecure + peerTlsError, 1);
    assert.equal(requests, 0);
    assert.deepEqual(reasons, ['tls_refused']);
    assert.equal(broker.latchReason(), 'tls_refused');
    assert.equal(broker.counts.inference, 1);
    await broker.close();
    assert.equal(broker.active(), 0);
  } finally {
    await broker.close(); tls.closeAllConnections(); await new Promise(resolve => tls.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('guest proxy forwards a verified local TLS session and retires partial clients', async () => {
  const root = await mkdtemp(join(tmpdir(), 'passeur-codex-egress-tls-'));
  const key = join(root, 'peer.key'), cert = join(root, 'peer.pem'), socketPath = join(root, 'broker.sock');
  execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=accounts.fixture.invalid', '-addext', 'subjectAltName=DNS:accounts.fixture.invalid',
    '-keyout', key, '-out', cert], { stdio: 'ignore', timeout: 10_000 });
  const tls = createHttpsServer({ key: await readFile(key), cert: await readFile(cert) },
    (_request, response) => response.writeHead(200).end('fixture-only'));
  await new Promise(resolve => tls.listen(0, '127.0.0.1', resolve));
  const broker = await startProtectedEgress({ socketPath, accountHost: 'accounts.fixture.invalid',
    inferenceHost: 'inference.fixture.invalid', accountPort: tls.address().port,
    inferencePort: tls.address().port });
  const guest = createGuestConnectProxy(socketPath);
  await new Promise(resolve => guest.listen(0, '127.0.0.1', resolve));
  let partial;
  try {
    const admitted = await connect({ hostname: '127.0.0.1', port: guest.address().port },
      'accounts.fixture.invalid:443');
    assert.equal(admitted.status, 200);
    const secure = tlsConnect({ socket: admitted.socket, servername: 'accounts.fixture.invalid',
      ca: await readFile(cert), rejectUnauthorized: true });
    await new Promise((resolve, reject) => { secure.once('secureConnect', resolve); secure.once('error', reject); });
    const response = new Promise(resolve => { let output = ''; secure.on('data', chunk => output += chunk);
      secure.once('end', () => resolve(output)); });
    secure.write('GET / HTTP/1.1\r\nHost: accounts.fixture.invalid\r\nConnection: close\r\n\r\n');
    assert.match(await response, /fixture-only/);
    partial = createConnection({ host: '127.0.0.1', port: guest.address().port });
    partial.on('error', () => {});
    await new Promise(resolve => partial.once('connect', resolve));
    partial.write('CONNECT accounts.fixture.invalid:443 HTTP/1.1\r\n');
    const partialClosed = new Promise(resolve => partial.once('close', resolve));
    retireGuestConnectProxy(guest);
    await partialClosed;
    assert.equal(partial.destroyed, true);
  } finally {
    partial?.destroy(); retireGuestConnectProxy(guest);
    guest.closeAllConnections(); await new Promise(resolve => guest.close(resolve));
    await broker.close(); tls.closeAllConnections(); await new Promise(resolve => tls.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
