import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyRead, commandRequest, effectiveConfig, errorCategory, hostCanaryCheck, isNativeExecutableHeader, matchesNativeAttestation, permissionSelector, positiveCommandFailure, profileAvailability, profileToml, retainPositiveStderr, run, safeReply, selectedEnvironment } from '../../scripts/qualify-codex-protected-boundary.mjs';

const verifiedElf = '/home/jeremy/.nvm/versions/node/v24.12.0/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex';
const verifiedSha256 = '3e2584f3f3829a43a0495011a1cecb2facbe64a2403e2b682351fd9c2983f970';

test('disposable named profile denies ambient roots and command request excludes legacy sandbox policy', () => {
  const toml = profileToml('/tmp/fixture/work', verifiedElf);
  assert.match(toml, /default_permissions = "passeur-boundary"/);
  assert.match(toml, /":root" = "deny"/);
  assert.match(toml, /":slash_tmp" = "deny"/);
  assert.match(toml, /":tmpdir" = "deny"/);
  assert.match(toml, /"\/tmp\/fixture\/work" = true/);
  assert.ok(toml.includes(`${JSON.stringify(verifiedElf)} = "read"`));
  assert.equal(toml.includes(`${JSON.stringify('/home/jeremy')} = "read"`), false);
  assert.equal(toml.includes(`${JSON.stringify('/home/jeremy/.nvm/versions/node/v24.12.0/lib/node_modules/@openai')} = "read"`), false);
  assert.match(toml, /enabled = false/);
  assert.deepEqual(commandRequest(['/usr/bin/cat', 'allowed'], '/tmp/fixture/work'), {
    command: ['/usr/bin/cat', 'allowed'], cwd: '/tmp/fixture/work',
    permissionProfile: 'passeur-boundary', timeoutMs: 10_000, outputBytesCap: 4096,
  });
  assert.equal(Object.hasOwn(commandRequest(['true'], '/tmp/fixture/work'), 'sandboxPolicy'), false);
});

test('profile grant rejects broader or mismatched native executable attestation', () => {
  assert.equal(matchesNativeAttestation(verifiedElf, verifiedSha256), true);
  assert.equal(matchesNativeAttestation('/home/jeremy', verifiedSha256), false);
  assert.equal(matchesNativeAttestation(`${verifiedElf}.other`, verifiedSha256), false);
  assert.equal(matchesNativeAttestation(verifiedElf, '0'.repeat(64)), false);
  assert.throws(() => profileToml('/tmp/fixture/work', '/home/jeremy'));
  assert.throws(() => profileToml('/tmp/fixture/work', `${verifiedElf}.other`));
});

test('a protected read is accepted only when the native command denies it without returning the canary', () => {
  const canary = 'synthetic-secret-123';
  const path = '/tmp/fixture/protected/dummy-auth';
  const verified = { positive: true, before: true, after: true, path };
  assert.equal(classifyRead({ result: { exitCode: 1, stdout: '', stderr: `cat: ${path}: Permission denied\n` } }, canary, verified), 'denied');
  assert.equal(classifyRead({ result: { exitCode: 1, stdout: '', stderr: `bwrap: ${path}: Operation not permitted` } }, canary, verified), 'inconclusive');
  assert.equal(classifyRead({ result: { exitCode: 1, stdout: '', stderr: `bwrap: ${path}: EACCES` } }, canary, verified), 'inconclusive');
  assert.equal(classifyRead({ result: { exitCode: 1, stdout: '', stderr: 'Permission denied' } }, canary, verified), 'inconclusive');
  assert.equal(classifyRead({ result: { exitCode: 1, stdout: '', stderr: `cat: ${path}: No such file or directory\n` } }, canary, verified), 'hidden_denied');
  assert.equal(classifyRead({ result: { exitCode: 1, stdout: '', stderr: `bwrap: execvp ${path}: No such file or directory` } }, canary, verified), 'inconclusive');
  assert.equal(classifyRead({ result: { exitCode: 1, stdout: '', stderr: `cat: ${path}: No such file or directory` } }, canary, { ...verified, after: false }), 'inconclusive');
  assert.equal(classifyRead({ result: { exitCode: 1, stdout: '', stderr: `cat: ${path}: No such file or directory` } }, canary, { ...verified, positive: false }), 'inconclusive');
  assert.equal(classifyRead({ result: { exitCode: 0, stdout: canary, stderr: '' } }, canary, verified), 'exposed');
  assert.equal(classifyRead({ result: { exitCode: 1, stdout: '', stderr: canary } }, canary, verified), 'exposed');
  assert.equal(classifyRead({ result: { exitCode: 1, stdout: '', stderr: 'other failure' } }, canary, verified), 'inconclusive');
  assert.equal(classifyRead({ error: { code: -32602, message: 'invalid sandbox policy' } }, canary, verified), 'unsupported');
});

test('host canary provenance validates direct, symlink and proc paths around native probes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'passeur-host-canary-test-'));
  const target = join(root, 'dummy-auth'), link = join(root, 'link'), canary = 'synthetic-canary';
  try {
    await writeFile(target, canary);
    await symlink(target, link);
    assert.equal(await hostCanaryCheck('direct', target, target, canary), true);
    assert.equal(await hostCanaryCheck('symlink', link, target, canary), true);
    assert.equal(await hostCanaryCheck('proc', `/proc/self/root${target}`, target, canary), true);
    assert.equal(await hostCanaryCheck('symlink', link, join(root, 'other'), canary), false);
    assert.equal(await hostCanaryCheck('proc', `/proc/self/root${join(root, 'other')}`, target, canary), false);
    await writeFile(target, 'changed');
    assert.equal(await hostCanaryCheck('direct', target, target, canary), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('report projection never retains native output or a synthetic canary', () => {
  const secret = 'synthetic-secret-123';
  const reply = safeReply({ id: 4, result: { stdout: secret, stderr: secret, exitCode: 0 } });
  assert.deepEqual(reply, { id: 4, kind: 'result', exitCode: 0, stdoutBytes: secret.length, stderrBytes: secret.length });
  assert.equal(JSON.stringify(reply).includes(secret), false);
  const rejected = safeReply({ id: 5, error: { code: -32600, message: `Profile is not allowed: ${secret}` } });
  assert.deepEqual(rejected, { id: 5, kind: 'error', code: -32600, category: 'profile_rejected' });
  assert.equal(JSON.stringify(rejected).includes(secret), false);
});

test('native error categories are fixed and preserve unsupported policy meaning', () => {
  assert.equal(errorCategory('permissionProfile cannot be combined with sandboxPolicy'), 'mutually_exclusive');
  assert.equal(errorCategory('sandbox unavailable'), 'sandbox_unavailable');
  assert.equal(errorCategory('invalid request: unknown field readOnlyAccess'), 'unsupported_request');
  assert.equal(errorCategory('arbitrary protected path /tmp/x'), 'unknown');
});

test('positive-control failure retains only fixed stderr class, bytes and digest', () => {
  for (const [stderr, category] of [
    ['cat: allowed: Permission denied', 'permission'],
    ['cat: allowed: No such file or directory', 'missing_path'],
    ['bwrap: sandbox setup failed', 'sandbox_runtime'],
    ['command not found', 'execution'],
    ['private path /tmp/sensitive and canary-value', 'unknown'],
  ]) {
    const result = positiveCommandFailure({ result: { exitCode: 1, stdout: '', stderr } });
    assert.deepEqual(result, { category, stderrBytes: Buffer.byteLength(stderr),
      stderrSha256: createHash('sha256').update(stderr).digest('hex') });
    assert.equal(JSON.stringify(result).includes(stderr), false);
  }
  assert.equal(positiveCommandFailure({ error: { code: -32600 } }).category, 'unknown');
});

test('only a positive-control stderr can be retained as a capped private artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'passeur-positive-stderr-test-'));
  try {
    const stderr = `bwrap: ${'é'.repeat(140)} private-value`;
    const result = await retainPositiveStderr({ result: { exitCode: 1, stderr } }, root);
    const expected = Buffer.from(stderr).subarray(0, 256);
    const file = await readFile(result.path);
    assert.deepEqual(file, expected);
    assert.equal((await lstat(result.path)).mode & 0o777, 0o600);
    assert.deepEqual(result, { path: join(root, 'allowed-read-stderr.txt'),
      sha256: createHash('sha256').update(expected).digest('hex'), bytes: 256, category: 'sandbox_runtime' });
    assert.ok(Buffer.byteLength(stderr) > result.bytes);
    assert.equal(JSON.stringify(result).includes('private-value'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a native request error has no stderr artifact', async () => {
  let wrote = false;
  const retained = await retainPositiveStderr({ error: { code: -32600, message: 'private-value' } }, '/tmp/disposable',
    async () => { wrote = true; });
  assert.equal(retained, undefined);
  assert.equal(wrote, false);
});

test('native environment uses only a disposable home and fixed host program path', () => {
  const env = selectedEnvironment('/tmp/fixture/home');
  assert.deepEqual(env, { HOME: '/tmp/fixture/home', CODEX_HOME: '/tmp/fixture/home/codex',
    PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', RUST_LOG: 'off' });
});

test('a JavaScript launcher cannot be attributed as the native executable', () => {
  assert.equal(isNativeExecutableHeader(Buffer.from('#!/usr/bin/env node')), false);
  assert.equal(isNativeExecutableHeader(Buffer.from([0x7f, 0x45, 0x4c, 0x46])), true);
});

test('effective configuration evidence is value-free and rejects an unexcluded temp root or enabled tool', () => {
  const config = { config: { features: { apps: false, plugins: false, multi_agent: false },
    web_search: 'disabled', mcp_servers: {}, default_permissions: 'passeur-boundary',
    sandbox_mode: null, sandbox_workspace_write: null } };
  assert.equal(effectiveConfig(config).valid, true);
  assert.equal(effectiveConfig({ config: { ...config.config, features: { ...config.config.features, apps: true } } }).valid, false);
  assert.equal(effectiveConfig({ config: { ...config.config, sandbox_workspace_write: {} } }).valid, false);
  assert.equal(effectiveConfig({ config: { ...config.config, default_permissions: ':danger-full-access' } }).valid, false);
  assert.equal(effectiveConfig({ config: { ...config.config, default_permissions: null } }).valid, false);
  assert.equal(effectiveConfig({ config: { ...config.config, default_permissions: ':workspace' } }).permissionSelector, 'built-in');
  assert.equal(effectiveConfig({ config: { ...config.config, default_permissions: 'private-profile' } }).permissionSelector, 'custom');
  assert.equal(effectiveConfig({ config: { ...config.config, default_permissions: 42 } }).permissionSelector, 'unknown');
  assert.equal(JSON.stringify(effectiveConfig(config)).includes('dummy-auth'), false);
});

test('only the exact allowed named profile passes the native list preflight', () => {
  assert.equal(profileAvailability({ data: [{ id: 'passeur-boundary', allowed: true }], nextCursor: null }), 'allowed');
  assert.equal(profileAvailability({ data: [{ id: 'passeur-boundary', allowed: false }], nextCursor: null }), 'disallowed');
  assert.equal(profileAvailability({ data: [{ id: 'other', allowed: true }], nextCursor: null }), 'unknown');
  assert.equal(profileAvailability({ data: [{ id: 'passeur-boundary', allowed: true }], nextCursor: 'next' }), 'unknown');
  assert.equal(profileAvailability({ data: [{ id: 'passeur-boundary', allowed: true }, { id: 'passeur-boundary', allowed: true }] }), 'unknown');
});

test('permission selector classification does not retain an active profile name', () => {
  assert.equal(permissionSelector(undefined), 'absent');
  assert.equal(permissionSelector(null), 'null');
  assert.equal(permissionSelector(':read-only'), 'built-in');
  assert.equal(permissionSelector('sensitive-name'), 'custom');
  assert.equal(permissionSelector(':unknown-built-in'), 'unknown');
  assert.equal(JSON.stringify(effectiveConfig({ config: { default_permissions: 'sensitive-name' } })).includes('sensitive-name'), false);
});

test('a failed pre-host fixture retains its exact synthetic root for review', async () => {
  const result = await run('/not/a/real/native/codex');
  try {
    assert.equal(result.status, 'fixture_error');
    assert.equal(result.rootDisposition, 'retained_for_review');
    assert.equal(result.descendantStop, 'unverified');
    assert.equal(result.hostExitObserved, false);
    assert.equal((await lstat(result.root)).isDirectory(), true);
  } finally { await rm(result.root, { recursive: true, force: true }); }
});
