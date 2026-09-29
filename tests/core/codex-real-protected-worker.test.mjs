import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EXPECTED_CONTENT, canaryFileIntact, classifyProbe, configurePrivateGitIdentity, dispositionContinuation, nativeToolEvidence, refuseProbeInput, requireLive } from '../../scripts/qualify-codex-real-protected-worker.mjs';
import { fixture, git } from './helpers.mjs';
import { preparePrivateGitView, preparePrivatePublication, prepareWorkspace } from '../../.passeur-core/src/workspace/worktree.js';

const exec = promisify(execFile);

test('the qualifier import is inert and the live gate rejects unqualified arguments', () => {
  assert.throws(() => requireLive([]), /Explicit --live/);
  assert.throws(() => requireLive(['--live', '--extra']), /Explicit --live/);
});

test('native tool evidence permits multiple ordinary tools but requires correlated completion', () => {
  const state = { operations: 5, finished: 5, overflow: false, items: [
    { id: 'user', kind: 'userMessage', finished: true },
    { id: 'command-1', kind: 'commandExecution', finished: true },
    { id: 'edit', kind: 'fileChange', finished: true },
    { id: 'command-2', kind: 'commandExecution', finished: true },
    { id: 'answer', kind: 'agentMessage', finished: true },
  ] };
  assert.deepEqual(nativeToolEvidence(state), { nativeToolObserved: true, operationsCorrelated: true });
  assert.equal(nativeToolEvidence({ ...state, finished: 4,
    items: state.items.map(item => item.id === 'edit' ? { ...item, finished: false } : item) }).operationsCorrelated, false);
  assert.equal(nativeToolEvidence({ ...state, overflow: true }).operationsCorrelated, false);
  assert.equal(nativeToolEvidence({ operations: 2, finished: 2, overflow: false,
    items: [state.items[0], state.items[4]] }).nativeToolObserved, false);
});

test('canary verification requires exact bytes, regular file and owner-only mode', async t => {
  const root = await mkdtemp(join(tmpdir(), 'passeur-canary-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'canary'), expected = Buffer.from('secret fixed bytes\n');
  await writeFile(path, expected, { mode: 0o600 });
  assert.equal(await canaryFileIntact(path, expected), true);
  await writeFile(path, Buffer.from('secret fixed bytes changed\n'));
  assert.equal(await canaryFileIntact(path, expected), false);
  await writeFile(path, expected); await chmod(path, 0o644);
  assert.equal(await canaryFileIntact(path, expected), false);
  await rm(path); await symlink(join(root, 'target'), path);
  await writeFile(join(root, 'target'), expected, { mode: 0o600 });
  assert.equal(await canaryFileIntact(path, expected), false);
});

test('ordinary code edit admits exact one-file private Git publication with hook', async t => {
  const f = await fixture(t), taskId = randomUUID();
  const hook = join(f.root, '.git', 'hooks', 'pre-commit');
  await writeFile(hook, '#!/bin/sh\nprintf hook-ran > "$(git rev-parse --git-common-dir)/hooks/hook-marker"\n');
  await chmod(hook, 0o755);
  const workspace = await prepareWorkspace(f.root, f.implementation('real-probe-publication'),
    f.policy, 'project', taskId);
  const view = await preparePrivateGitView(f.root, workspace, join(f.temp, 'private-git'));
  configurePrivateGitIdentity(f.root, view.private_common_dir);
  assert.equal((await git(f.root, '--git-dir', view.private_common_dir,
    'config', '--local', '--get', 'user.email')).trim(), 'passeur-fixture@example.invalid');
  const environment = { ...process.env, GIT_DIR: join(view.private_common_dir, view.admin_relative),
    GIT_COMMON_DIR: view.private_common_dir, GIT_WORK_TREE: workspace.path };
  await writeFile(join(workspace.path, 'quote.py'), EXPECTED_CONTENT);
  await exec('/usr/bin/git', ['add', '--', 'quote.py'], { cwd: workspace.path, env: environment });
  await exec('/usr/bin/git', ['commit', '-m', 'Add quote fee'],
  { cwd: workspace.path, env: environment });
  assert.equal((await git(f.root, 'rev-parse', workspace.branch)).trim(), f.base);
  const publication = await preparePrivatePublication(f.root, workspace, view,
    join(f.temp, 'quarantine'), 'confirmed');
  assert.equal(publication.old_head, f.base);
  assert.equal((await readFile(join(workspace.path, 'quote.py'), 'utf8')), EXPECTED_CONTENT);
  assert.equal((await git(f.root, '--git-dir', view.private_common_dir, 'diff-tree',
    '--no-commit-id', '--name-only', '-r', f.base, publication.new_head)).trim(), 'quote.py');
  assert.equal((await readFile(join(view.private_common_dir, 'hooks', 'hook-marker'), 'utf8')), 'hook-ran');
});

test('unexpected native approval or clarification has no affirmative probe answer', () => {
  for (const kind of ['approval', 'clarification']) {
    assert.throws(() => refuseProbeInput(kind), { code: 'CODEX_PROBE_INPUT_UNEXPECTED' });
  }
  for (const count of [0, 1]) assert.match(dispositionContinuation(true, count),
    /^Complete the original quote.py task if needed\. Then reply with only this exact final line and no other text: PASSEUR_MESSAGE /);
  for (const [needed, count] of [[false, 0], [true, 2], [true, -1], [true, 1.5]]) {
    assert.throws(() => dispositionContinuation(needed, count), { code: 'CODEX_PROBE_INPUT_UNEXPECTED' });
  }
});

test('completion requires correlated native effect, exact private publication and stop', () => {
  const accepted = { executionStatus: 'completed', deliveryStatus: 'committed', workerStop: 'confirmed',
    privateState: 'published', reportedModel: 'gpt-6-astra', adapterPreflightReached: true,
    processObserved: true, turnSettled: true, nativeToolObserved: true, operationsCorrelated: true,
    baseUnchanged: true,
    privateCommitExact: true, hookRan: true, canariesIntact: true, outputClean: true, noRemote: true };
  assert.equal(classifyProbe(accepted), 'probe_passed');
  for (const changed of [
    { workerStop: 'unconfirmed' }, { nativeToolObserved: false }, { operationsCorrelated: false },
    { reportedModel: 'other' }, { adapterPreflightReached: false }, { processObserved: false },
    { turnSettled: false }, { baseUnchanged: false },
    { privateState: 'prepared' }, { privateCommitExact: false },
    { hookRan: false }, { canariesIntact: false }, { outputClean: false }, { noRemote: false },
  ]) assert.equal(classifyProbe({ ...accepted, ...changed }), 'incomplete');
});
