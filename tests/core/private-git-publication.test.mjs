import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, stat, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, git } from './helpers.mjs';
import { prepareWorkspace, preparePrivateGitView, preparePrivatePublication, publishPrivateCommit, observeDelivery } from '../../.passeur-core/src/workspace/worktree.js';

test('task-private Git view starts with only its admitted branch and runs ordinary worker hooks', async (t) => {
  const f = await fixture(t), id = randomUUID();
  const workspace = await prepareWorkspace(f.root, f.implementation('private-view'), f.policy, 'fixture-project', id);
  const hook = join(f.root, '.git', 'hooks', 'pre-commit');
  await writeFile(hook, '#!/bin/sh\nprintf hook > private-hook-ran\n', { mode: 0o755 });
  const view = await preparePrivateGitView(f.root, workspace, join(f.temp, 'private-git'));
  const privateAdmin = join(view.private_common_dir, view.admin_relative);
  assert.equal((await readFile(join(privateAdmin, 'HEAD'), 'utf8')).trim(), `ref: ${workspace.branch}`);
  assert.equal((await git(f.root, 'rev-parse', workspace.branch)).trim(), f.base);
  assert.equal((await git(view.private_common_dir, 'for-each-ref', '--format=%(refname)')).trim(), workspace.branch);
  await writeFile(join(workspace.path, 'worker.txt'), 'from worker\n');
  // A native sandbox resolves the unchanged worktree .git pointer to this private admin path.
  // The environment override is a local probe of that Git metadata view.
  const { spawnSync } = await import('node:child_process');
  const command = spawnSync('git', ['-C', workspace.path, 'add', 'worker.txt'], { env: { ...process.env, GIT_DIR: privateAdmin }, encoding: 'utf8' });
  assert.equal(command.status, 0, command.stderr);
  const commit = spawnSync('git', ['-C', workspace.path, '-c', 'user.name=Worker', '-c', 'user.email=worker@example.invalid', 'commit', '-qm', 'worker commit'],
    { env: { ...process.env, GIT_DIR: privateAdmin }, encoding: 'utf8' });
  assert.equal(commit.status, 0, commit.stderr);
  assert.equal(await readFile(join(workspace.path, 'private-hook-ran'), 'utf8'), 'hook');
  assert.equal((await git(f.root, 'rev-parse', workspace.branch)).trim(), f.base);
});

test('sterile publication imports the exact worker commit and makes the canonical worktree clean', async (t) => {
  const f = await fixture(t), id = randomUUID();
  const workspace = await prepareWorkspace(f.root, f.implementation('publish'), f.policy, 'fixture-project', id);
  const view = await preparePrivateGitView(f.root, workspace, join(f.temp, 'private-git'));
  const privateAdmin = join(view.private_common_dir, view.admin_relative);
  const { spawnSync } = await import('node:child_process');
  await writeFile(join(workspace.path, 'worker.txt'), 'exact worker bytes\n');
  for (const args of [ ['add', 'worker.txt'], ['-c', 'user.name=Worker', '-c', 'user.email=worker@example.invalid', 'commit', '-qm', 'ordinary worker commit'] ]) {
    const command = spawnSync('git', ['-C', workspace.path, ...args], { env: { ...process.env, GIT_DIR: privateAdmin }, encoding: 'utf8' });
    assert.equal(command.status, 0, command.stderr);
  }
  const intent = await preparePrivatePublication(f.root, workspace, view, join(f.temp, 'quarantine'), 'confirmed');
  assert.equal((await git(f.root, 'rev-parse', workspace.branch)).trim(), f.base);
  await publishPrivateCommit(f.root, workspace, intent, 'confirmed');
  await publishPrivateCommit(f.root, workspace, intent, 'confirmed');
  assert.equal((await git(f.root, 'rev-parse', workspace.branch)).trim(), intent.new_head);
  assert.equal((await git(workspace.path, 'status', '--porcelain')), '');
  assert.equal((await observeDelivery(workspace)).status, 'committed');
  assert.equal(await readFile(join(workspace.path, 'worker.txt'), 'utf8'), 'exact worker bytes\n');
});

test('host inspection rejects unconfirmed stop and ignores worker-selected Git configuration', async (t) => {
  const f = await fixture(t), id = randomUUID();
  const workspace = await prepareWorkspace(f.root, f.implementation('hostile-private-config'), f.policy, 'fixture-project', id);
  const view = await preparePrivateGitView(f.root, workspace, join(f.temp, 'private-git'));
  const admin = join(view.private_common_dir, view.admin_relative);
  const { spawnSync } = await import('node:child_process');
  await writeFile(join(workspace.path, 'worker.txt'), 'worker\n');
  for (const args of [['add', 'worker.txt'], ['-c', 'user.name=Worker', '-c', 'user.email=worker@example.invalid', 'commit', '-qm', 'commit']]) {
    const command = spawnSync('git', ['-C', workspace.path, ...args], { env: { ...process.env, GIT_DIR: admin }, encoding: 'utf8' });
    assert.equal(command.status, 0, command.stderr);
  }
  const marker = join(f.temp, 'host-command-ran'), executable = join(f.temp, 'host-command');
  await writeFile(executable, `#!/bin/sh\nprintf ran > '${marker}'\n`, { mode: 0o755 });
  await writeFile(join(view.private_common_dir, 'config'), `[core]\n\tbare = false\n\tfsmonitor = ${executable}\n\thooksPath = ${executable}\n`);
  await assert.rejects(preparePrivatePublication(f.root, workspace, view, join(f.temp, 'not-stopped'), 'unconfirmed'), { code: 'PRIVATE_GIT_STOP_UNCONFIRMED' });
  const intent = await preparePrivatePublication(f.root, workspace, view, join(f.temp, 'quarantine'), 'confirmed');
  await assert.rejects(publishPrivateCommit(f.root, workspace, intent, 'unconfirmed'), { code: 'PRIVATE_GIT_STOP_UNCONFIRMED' });
  await publishPrivateCommit(f.root, workspace, intent, 'confirmed');
  await assert.rejects(stat(marker), { code: 'ENOENT' });
});

test('a moved canonical task branch rejects publication before index mutation', async (t) => {
  const f = await fixture(t), id = randomUUID();
  const workspace = await prepareWorkspace(f.root, f.implementation('changed-ref'), f.policy, 'fixture-project', id);
  const view = await preparePrivateGitView(f.root, workspace, join(f.temp, 'private-git'));
  const admin = join(view.private_common_dir, view.admin_relative);
  const { spawnSync } = await import('node:child_process');
  await writeFile(join(workspace.path, 'worker.txt'), 'worker\n');
  for (const args of [['add', 'worker.txt'], ['-c', 'user.name=Worker', '-c', 'user.email=worker@example.invalid', 'commit', '-qm', 'commit']]) {
    const command = spawnSync('git', ['-C', workspace.path, ...args], { env: { ...process.env, GIT_DIR: admin }, encoding: 'utf8' });
    assert.equal(command.status, 0, command.stderr);
  }
  const intent = await preparePrivatePublication(f.root, workspace, view, join(f.temp, 'quarantine'), 'confirmed');
  const canonicalIndex = (await git(workspace.path, 'rev-parse', '--path-format=absolute', '--git-path', 'index')).trim();
  const originalIndex = await readFile(canonicalIndex);
  await git(f.root, 'commit', '--allow-empty', '-qm', 'unrelated canonical commit');
  const changed = (await git(f.root, 'rev-parse', 'HEAD')).trim();
  await git(f.root, 'update-ref', workspace.branch, changed, f.base);
  await assert.rejects(publishPrivateCommit(f.root, workspace, intent, 'confirmed'), { code: 'PRIVATE_PUBLICATION_CONFLICT' });
  assert.deepEqual(await readFile(canonicalIndex), originalIndex);
  assert.equal((await git(f.root, 'rev-parse', workspace.branch)).trim(), changed);
});

test('private preparation rejects custom hooks and required signing policy', async (t) => {
  const f = await fixture(t), id = randomUUID();
  const workspace = await prepareWorkspace(f.root, f.implementation('hook-policy'), f.policy, 'fixture-project', id);
  await git(f.root, 'config', 'core.hooksPath', join(f.temp, 'custom-hooks'));
  await assert.rejects(preparePrivateGitView(f.root, workspace, join(f.temp, 'private-hooks')), { code: 'PRIVATE_GIT_POLICY_UNSUPPORTED' });
  await git(f.root, 'config', '--unset', 'core.hooksPath');
  await git(f.root, 'config', 'commit.gpgsign', 'yes');
  await assert.rejects(preparePrivateGitView(f.root, workspace, join(f.temp, 'private-signing')), { code: 'PRIVATE_GIT_POLICY_UNSUPPORTED' });
});

test('post-preparation canonical staged index is never accepted as the publication baseline', async (t) => {
  const f = await fixture(t), id = randomUUID();
  const workspace = await prepareWorkspace(f.root, f.implementation('index-race'), f.policy, 'fixture-project', id);
  const view = await preparePrivateGitView(f.root, workspace, join(f.temp, 'private-git'));
  const replacement = join(f.temp, 'replacement');
  await writeFile(replacement, 'staged without changing source\n');
  const oid = (await git(f.root, 'hash-object', '-w', replacement)).trim();
  await git(workspace.path, 'update-index', '--cacheinfo', '100644', oid, 'watched.txt');
  const index = join(view.canonical_common_dir, view.admin_relative, 'index');
  const staged = await readFile(index);
  await assert.rejects(preparePrivatePublication(f.root, workspace, view, join(f.temp, 'quarantine'), 'confirmed'), { code: 'HOST_INDEX_CHANGED' });
  assert.deepEqual(await readFile(index), staged);
  assert.equal((await git(f.root, 'rev-parse', workspace.branch)).trim(), f.base);
});

test('unknown index lock is never adopted, even when it points at a matching index', async (t) => {
  const f = await fixture(t), id = randomUUID();
  const workspace = await prepareWorkspace(f.root, f.implementation('unknown-lock'), f.policy, 'fixture-project', id);
  const view = await preparePrivateGitView(f.root, workspace, join(f.temp, 'private-git'));
  const admin = join(view.private_common_dir, view.admin_relative);
  const { spawnSync } = await import('node:child_process');
  await writeFile(join(workspace.path, 'worker.txt'), 'worker\n');
  for (const args of [['add', 'worker.txt'], ['-c', 'user.name=Worker', '-c', 'user.email=worker@example.invalid', 'commit', '-qm', 'commit']]) {
    const command = spawnSync('git', ['-C', workspace.path, ...args], { env: { ...process.env, GIT_DIR: admin }, encoding: 'utf8' });
    assert.equal(command.status, 0, command.stderr);
  }
  const intent = await preparePrivatePublication(f.root, workspace, view, join(f.temp, 'quarantine'), 'confirmed');
  const index = join(intent.canonical_admin_path, 'index'), lock = `${index}.lock`;
  const original = await readFile(index);
  await symlink(join(intent.quarantine_path, 'index'), lock);
  await assert.rejects(publishPrivateCommit(f.root, workspace, intent, 'confirmed'), { code: 'PRIVATE_PUBLICATION_LOCKED' });
  assert.deepEqual(await readFile(index), original);
  assert.equal((await git(f.root, 'rev-parse', workspace.branch)).trim(), f.base);
  await unlink(lock);
  await writeFile(lock, await readFile(join(intent.quarantine_path, 'index')));
  await assert.rejects(publishPrivateCommit(f.root, workspace, intent, 'confirmed'), { code: 'PRIVATE_PUBLICATION_LOCKED' });
});

test('symlinked parents cannot place private storage or quarantine in the worker workspace', async (t) => {
  const f = await fixture(t), id = randomUUID();
  const workspace = await prepareWorkspace(f.root, f.implementation('storage-parent'), f.policy, 'fixture-project', id);
  const link = join(f.temp, 'linked-parent');
  await symlink(workspace.path, link);
  await assert.rejects(preparePrivateGitView(f.root, workspace, join(link, 'private-git')), { code: 'PRIVATE_GIT_UNSAFE' });
  const view = await preparePrivateGitView(f.root, workspace, join(f.temp, 'private-git'));
  await assert.rejects(preparePrivatePublication(f.root, workspace, view, join(link, 'quarantine'), 'confirmed'), { code: 'PRIVATE_GIT_UNSAFE' });
});
