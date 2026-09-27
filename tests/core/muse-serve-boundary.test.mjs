import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { selectChoice, startRawSession, qualify, within } from '../../scripts/qualify-muse-serve-boundary.mjs';

test('approval routing selects only the offered once-only decision', () => {
  const request = { availableChoices: [
    { choiceId: 'session-allow', decision: 'approved', scope: 'session' },
    { choiceId: 'once-deny', decision: 'denied', scope: 'once' },
    { choiceId: 'once-allow', decision: 'approved', scope: 'once' },
  ] };
  assert.equal(selectChoice(request, 'allow'), 'once-allow');
  assert.equal(selectChoice(request, 'deny'), 'once-deny');
  assert.equal(selectChoice({ availableChoices: request.availableChoices.slice(0, 1) }, 'allow'), undefined);
});

test('raw session start uses the quickstart command shape without overrides', async () => {
  const calls = [];
  const started = { session: { sessionId: '0197134c-6a23-7a41-8a02-82f4a322f43f', workspaceRoot: '/tmp/disposable-workspace' } };
  const connection = { command: async (...args) => { calls.push(args); return started; } };
  assert.deepEqual(await startRawSession(connection, '/tmp/disposable-workspace'), started);
  assert.deepEqual(calls, [[
    'session/start', { workspaceRoot: '/tmp/disposable-workspace' }, { maxAttempts: 1 },
  ]]);
});

test('raw session start rejects empty or malformed IDs and a wrong workspace', async () => {
  const workspaceRoot = '/tmp/disposable-workspace';
  for (const session of [
    { sessionId: '', workspaceRoot },
    { sessionId: 'fixture', workspaceRoot },
    { sessionId: '0197134c-6a23-4a41-8a02-82f4a322f43f', workspaceRoot },
    { sessionId: '0197134c-6a23-7a41-8a02-82f4a322f43f', workspaceRoot: '/tmp/another-workspace' },
  ]) {
    await assert.rejects(startRawSession({ command: async () => ({ session }) }, workspaceRoot), {
      code: 'INVALID_SESSION_START',
    });
  }
});

test('version mismatch returns a typed result and removes its disposable HOME', async () => {
  const holder = await mkdtemp(join(tmpdir(), 'passeur-muse-version-test-'));
  try {
    const marker = join(holder, 'home-path');
    const fakeMuse = join(holder, 'muse');
    await writeFile(fakeMuse, `#!/bin/sh\nprintf '%s' "$HOME" > '${marker}'\nprintf 'muse 0.0.0\\n'\n`, { mode: 0o755 });
    const result = await qualify({ muse: fakeMuse });
    assert.equal(result.kind, 'native_version_mismatch');
    assert.equal(result.expected, '1.4.0-R4302.1');
    const home = await readFile(marker, 'utf8');
    await assert.rejects(stat(dirname(home)), { code: 'ENOENT' });
  } finally {
    await rm(holder, { recursive: true, force: true });
  }
});

test('an unverified pre-host process group retains the disposable fixture', async () => {
  const result = await qualify({ runProcess: async () => {
    throw Object.assign(new Error('group stop was not verified'), { code: 'GROUP_NOT_STOPPED' });
  } });
  try {
    assert.equal(result.kind, 'qualification_error');
    assert.equal(result.stage, 'version');
    assert.equal(result.code, 'GROUP_NOT_STOPPED');
    assert.equal(result.stopProof, 'descendants_unverified');
    assert.equal((await stat(result.retainedFixture)).isDirectory(), true);
  } finally {
    // This test's injected failure started no process, so its fixture is safe to remove.
    if (result.retainedFixture) await rm(result.retainedFixture, { recursive: true, force: true });
  }
});

test('startup deadlines produce a typed timeout without waiting for a silent promise', async () => {
  await assert.rejects(within('host initialize', new Promise(() => undefined), 5), {
    code: 'PROBE_DEADLINE', message: 'host initialize exceeded 5ms',
  });
});
