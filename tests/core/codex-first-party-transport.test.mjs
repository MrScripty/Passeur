import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer as createHttpsServer } from 'node:https';
import { createConnection } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ELF } from '../../scripts/qualify-codex-protected-worker.mjs';
import { generateCertificate } from '../../scripts/qualify-codex-subscription-transport.mjs';
import { firstPartyProfile, firstPartyRequestIdentity, firstPartyRoute,
  trackFirstPartyTlsServer } from '../../scripts/qualify-codex-first-party-transport.mjs';
import { StartupStderrDiagnostic } from '../../dist/src/agents/codex/transport.js';

test('startup stderr diagnostic classifies split chunks without retaining values', () => {
  const cases = [
    ['con', 'figuration failed secret-token-123', 'configuration_load_fallback'],
    ['authenti', 'cation failed secret-token-123', 'auth_bootstrap'],
    ['authentication rejected invalid ', 'payload secret-token-123', 'auth_bootstrap'],
    ['read-only ', 'file system secret-token-123', 'storage_environment'],
    ['unrecognized secret-token-123', '', 'other_unknown'],
    ['download failed secret-token-123', '', 'other_unknown'],
  ];
  for (const [first, second, category] of cases) {
    const diagnostic = new StartupStderrDiagnostic();
    diagnostic.accept(Buffer.from(first)); diagnostic.accept(Buffer.from(second));
    const evidence = diagnostic.finish();
    assert.equal(evidence.category, category);
    assert.equal(evidence.byteCount, Buffer.byteLength(first + second));
    assert.equal(evidence.overLimit, false);
    assert.doesNotMatch(JSON.stringify(evidence), /secret-token-123|failed|unrecognized/);
    diagnostic.accept(Buffer.from('configuration'));
    assert.deepEqual(diagnostic.finish(), evidence);
  }
});

test('startup stderr diagnostic caps over-limit input without retaining token-like bytes', () => {
  const diagnostic = new StartupStderrDiagnostic();
  diagnostic.accept(Buffer.from('x'.repeat(8190)));
  diagnostic.accept(Buffer.from('SECRET-TOKEN-LIKE-1234567890'.repeat(1000)));
  assert.deepEqual(diagnostic.finish(), { category: 'other_unknown', byteCount: 8192, overLimit: true });
  assert.doesNotMatch(JSON.stringify(diagnostic.finish()), /SECRET|TOKEN/);
});

test('first-party policy retains the installed built-in provider and default origin', () => {
  const profile = firstPartyProfile('/tmp/task', '/tmp/private', '/tmp/private/worktrees/task', ELF);
  assert.match(profile, /^model = "gpt-5\.3-codex"\nmodel_provider = "openai"/);
  assert.doesNotMatch(profile, /chatgpt_base_url|\[model_providers\.|fixture\.invalid/);
  assert.match(profile, /\[analytics\]\nenabled = false/);
  assert.throws(() => firstPartyProfile('/tmp/task', '/tmp/private', '/tmp/private/worktrees/task', '/bin/true'));
});

test('discovery only acknowledges exact known first-party account routes', () => {
  assert.equal(firstPartyRoute('GET', '/backend-api/wham/accounts/check'), 'account');
  assert.equal(firstPartyRoute('GET', '/backend-api/wham/settings/user'), 'settings');
  for (const [method, path] of [['POST', '/backend-api/wham/accounts/check'],
    ['GET', '/backend-api/wham/accounts/check?x=1'], ['GET', '/backend-api/codex/models'],
    ['GET', '/backend-api/codex/responses'], ['GET', '/backend-api/wham/accounts/check/']]) {
    assert.equal(firstPartyRoute(method, path), 'unknown');
  }
});

test('first-party HTTPS and upgrade admission requires exact SNI, Host and disposable bearer', () => {
  const request = { socket: { servername: 'chatgpt.com' },
    headers: { host: 'chatgpt.com', authorization: 'Bearer disposable-token' } };
  assert.equal(firstPartyRequestIdentity(request, 'disposable-token'), true);
  assert.equal(firstPartyRequestIdentity({ ...request, socket: { servername: 'other.invalid' } }, 'disposable-token'), false);
  assert.equal(firstPartyRequestIdentity({ ...request, socket: { servername: undefined } }, 'disposable-token'), false);
  assert.equal(firstPartyRequestIdentity({ ...request, headers: { ...request.headers, host: 'other.invalid' } }, 'disposable-token'), false);
  assert.equal(firstPartyRequestIdentity(request, 'another-token'), false);
});

test('TLS owner retires a stalled handshake and refuses a late connection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'passeur-first-party-tls-retire-'));
  const certificate = generateCertificate(root, 'chatgpt.com');
  await writeFile(certificate.ext, 'subjectAltName=DNS:chatgpt.com\nextendedKeyUsage=serverAuth\n');
  certificate.openssl('x509', '-req', '-in', certificate.csr, '-CA', certificate.ca,
    '-CAkey', certificate.caKey, '-CAcreateserial', '-days', '1', '-extfile', certificate.ext,
    '-out', certificate.cert);
  const server = createHttpsServer({ key: await readFile(certificate.key), cert: await readFile(certificate.cert) });
  const owner = trackFirstPartyTlsServer(server);
  let partial, late;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    partial = createConnection(port, '127.0.0.1'); partial.on('error', () => {});
    await new Promise(resolve => partial.once('connect', resolve));
    assert.equal(owner.active(), 1);
    const partialClosed = new Promise(resolve => partial.once('close', resolve));
    const closing = owner.close();
    late = createConnection(port, '127.0.0.1'); late.on('error', () => {});
    const lateClosed = new Promise(resolve => late.once('close', resolve));
    await Promise.all([closing, partialClosed, lateClosed]);
    assert.equal(owner.active(), 0);
    assert.equal(await owner.close(), undefined);
    assert.equal(late.destroyed, true);
  } finally {
    partial?.destroy(); late?.destroy();
    if (server.listening) await owner.close();
    await rm(root, { recursive: true, force: true });
  }
});
