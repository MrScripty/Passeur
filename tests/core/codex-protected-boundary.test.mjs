import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, rm } from 'node:fs/promises';
import { classifyRead, commandPolicy, effectiveConfig, isNativeExecutableHeader, permissionSelector, run, safeReply, selectedEnvironment } from '../../scripts/qualify-codex-protected-boundary.mjs';

test('the native command policy restricts reads and disables network', () => {
  const policy = commandPolicy('/tmp/fixture/work', ['/tmp/fixture/work', '/usr', '/bin', '/lib', '/lib64']);
  assert.deepEqual(policy, {
    type: 'workspaceWrite', writableRoots: ['/tmp/fixture/work'], networkAccess: false,
    readOnlyAccess: { type: 'restricted', includePlatformDefaults: true,
      readableRoots: ['/tmp/fixture/work', '/usr', '/bin', '/lib', '/lib64'] },
  });
  assert.equal(policy.readOnlyAccess.readableRoots.includes('/tmp/fixture/protected'), false);
});

test('a protected read is accepted only when the native command denies it without returning the canary', () => {
  const canary = 'synthetic-secret-123';
  assert.equal(classifyRead({ result: { exitCode: 1, stdout: '', stderr: 'Permission denied' } }, canary), 'denied');
  assert.equal(classifyRead({ result: { exitCode: 0, stdout: canary, stderr: '' } }, canary), 'exposed');
  assert.equal(classifyRead({ result: { exitCode: 1, stdout: '', stderr: 'other failure' } }, canary), 'inconclusive');
  assert.equal(classifyRead({ error: { code: -32602, message: 'invalid sandbox policy' } }, canary), 'unsupported');
});

test('report projection never retains native output or a synthetic canary', () => {
  const secret = 'synthetic-secret-123';
  const reply = safeReply({ id: 4, result: { stdout: secret, stderr: secret, exitCode: 0 } });
  assert.deepEqual(reply, { id: 4, kind: 'result', exitCode: 0, stdoutBytes: secret.length, stderrBytes: secret.length });
  assert.equal(JSON.stringify(reply).includes(secret), false);
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
    web_search: 'disabled', mcp_servers: {}, sandbox_workspace_write: {
      exclude_slash_tmp: true, exclude_tmpdir_env_var: true,
    } } };
  assert.equal(effectiveConfig(config).valid, true);
  assert.equal(effectiveConfig({ config: { ...config.config, features: { ...config.config.features, apps: true } } }).valid, false);
  assert.equal(effectiveConfig({ config: { ...config.config, sandbox_workspace_write: {} } }).valid, false);
  assert.equal(effectiveConfig({ config: { ...config.config, default_permissions: ':danger-full-access' } }).valid, false);
  assert.equal(effectiveConfig({ config: { ...config.config, default_permissions: null } }).valid, true);
  assert.equal(effectiveConfig({ config: { ...config.config, default_permissions: ':workspace' } }).permissionSelector, 'built-in');
  assert.equal(effectiveConfig({ config: { ...config.config, default_permissions: 'private-profile' } }).permissionSelector, 'custom');
  assert.equal(effectiveConfig({ config: { ...config.config, default_permissions: 42 } }).permissionSelector, 'unknown');
  assert.equal(JSON.stringify(effectiveConfig(config)).includes('dummy-auth'), false);
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
