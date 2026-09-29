import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyRead, commandRequest, intact, requireLive, resultStatus } from
  '../../scripts/qualify-codex-real-protected-native-boundary.mjs';

test('live execution requires one exact opt-in and import performs no launch', () => {
  assert.throws(() => requireLive([]), /Explicit --live/);
  assert.throws(() => requireLive(['--live', '--extra']), /Explicit --live/);
  assert.doesNotThrow(() => requireLive(['--live']));
});

test('command/exec uses the pinned experimental permission-profile request shape', () => {
  assert.deepEqual(commandRequest('/tmp/held/file', '/tmp/work'), {
    command: ['/usr/bin/cat', '/tmp/held/file'], cwd: '/tmp/work',
    permissionProfile: 'passeur-boundary', timeoutMs: 10_000, outputBytesCap: 4096 });
  assert.equal(Object.hasOwn(commandRequest('/tmp/held/file', '/tmp/work'), 'sandboxPolicy'), false);
});

test('read classification requires exact positive content or path-specific native denial', () => {
  const path = '/tmp/held/assignment.txt', canary = 'held secret';
  assert.equal(classifyRead({ exitCode: 0, stdout: 'workspace control\n', stderr: '' }, path, '', true), 'allowed');
  for (const stderr of [`cat: ${path}: Permission denied`, `/usr/bin/cat: ${path}: No such file or directory`]) {
    assert.equal(classifyRead({ exitCode: 1, stdout: '', stderr: `${stderr}\n` }, path, canary), 'denied');
  }
  for (const result of [
    { exitCode: 1, stdout: canary, stderr: '' },
    { exitCode: 1, stdout: '', stderr: canary },
  ]) assert.equal(classifyRead(result, path, canary), 'exposed');
  for (const result of [
    { exitCode: 0, stdout: '', stderr: '' },
    { exitCode: 1, stdout: '', stderr: `cat: /tmp/other: Permission denied\n` },
    { exitCode: 1, stdout: 'partial', stderr: `cat: ${path}: Permission denied\n` },
    { exitCode: 1, stdout: '', stderr: 'unattributed error' },
    { exitCode: '1', stdout: '', stderr: `cat: ${path}: Permission denied\n` },
  ]) assert.equal(classifyRead(result, path, canary), 'uncertain');
  assert.equal(classifyRead({ exitCode: 0, stdout: 'wrong', stderr: '' }, path, '', true), 'uncertain');
});

test('held canary checks require bytes, owner-only mode and exact symlink destination', async t => {
  const root = await mkdtemp(join(tmpdir(), 'passeur-real-native-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'file'), link = join(root, 'link'), bytes = Buffer.from('synthetic value\n');
  await writeFile(file, bytes, { mode: 0o600 });
  await symlink(file, link);
  assert.equal(await intact(file, file, bytes), true);
  assert.equal(await intact(link, file, bytes, true), true);
  await writeFile(file, 'changed');
  assert.equal(await intact(file, file, bytes), false);
  await writeFile(file, bytes); await chmod(file, 0o644);
  assert.equal(await intact(file, file, bytes), false);
  await chmod(file, 0o600);
  await rm(link); await symlink(join(root, 'other'), link);
  assert.equal(await intact(link, file, bytes, true), false);
  assert.equal((await lstat(file)).isFile(), true);
  assert.deepEqual(await readFile(file), bytes);
});

test('boundary pass requires all six exact denials and independently confirmed namespace stop', () => {
  const accepted = { completed: true, preflight: true, control: 'allowed', namespaceStop: 'confirmed',
    probes: ['direct', 'symlink', 'proc'].flatMap(route => [0, 1].map(target =>
      ({ route, target, before: true, after: true, observation: 'denied' }))) };
  assert.equal(resultStatus(accepted), 'native_boundary_passed');
  for (const changed of [
    { completed: false }, { preflight: false }, { control: 'uncertain' }, { namespaceStop: 'unconfirmed' },
    { probes: accepted.probes.slice(0, 5) },
    { probes: accepted.probes.map((probe, index) => index === 3 ? { ...probe, route: 'direct' } : probe) },
    { probes: accepted.probes.map((probe, index) => index === 4 ? { ...probe, observation: 'exposed' } : probe) },
    { probes: accepted.probes.map((probe, index) => index === 2 ? { ...probe, after: false } : probe) },
  ]) assert.equal(resultStatus({ ...accepted, ...changed }), 'incomplete');
});
