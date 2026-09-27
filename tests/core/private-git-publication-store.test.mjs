import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink, stat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { privatePublicationFixture } from './private-git-publication-fixture.mjs';
import { replayPrivatePublication } from '../../.passeur-core/src/workspace/worktree.js';
import { gitSterile } from '../../.passeur-core/src/workspace/project.js';

test('one task-owned intent is durable, immutable, and bound to admission and stopped run', async (t) => {
  const f = await privatePublicationFixture(t);
  assert.equal(await f.canonicalHead(), f.base);
  const started = await f.store.beginPrivatePublication(f.intent);
  assert.equal(started.state, 'intent');
  assert.deepEqual(await f.reopen().beginPrivatePublication(f.intent), started);
  await assert.rejects(f.store.beginPrivatePublication({ ...f.intent, operation_key: 'another-key' }), { code: 'PRIVATE_PUBLICATION_CONFLICT' });
  await assert.rejects(f.store.settlePrivatePublication(f.taskId, 'wrong-key', started.request_hash), { code: 'PRIVATE_PUBLICATION_IDENTITY' });
  await assert.rejects(replayPrivatePublication(f.reopen(), f.root, { ...f.identity, run_id: crypto.randomUUID() }, 'confirmed'), { code: 'PRIVATE_PUBLICATION_IDENTITY' });
  await assert.rejects(replayPrivatePublication(f.reopen(), f.root, f.identity, 'unconfirmed'), { code: 'PRIVATE_GIT_STOP_UNCONFIRMED' });
  assert.equal(await f.canonicalHead(), f.base);
});

test('reopened replay uses the retained candidate even after the private branch moves', async (t) => {
  const f = await privatePublicationFixture(t);
  await f.store.beginPrivatePublication(f.intent);
  await writeFile(join(f.view.private_common_dir, f.workspace.branch), f.base + '\n');
  const settled = await replayPrivatePublication(f.reopen(), f.root, f.identity, 'confirmed');
  assert.equal(settled.state, 'published');
  assert.equal(await f.canonicalHead(), f.publication.new_head);
  assert.equal(await readFile(join(f.workspace.path, 'worker.txt'), 'utf8'), 'exact worker bytes\n');
  assert.deepEqual(await replayPrivatePublication(f.reopen(), f.root, f.identity, 'confirmed'), settled);
});

test('replay refuses tampered quarantine and unknown native stop, retaining intent', async (t) => {
  const f = await privatePublicationFixture(t);
  await f.store.beginPrivatePublication(f.intent);
  const index = join(f.publication.quarantine_path, 'index');
  const original = await readFile(index);
  await writeFile(index, Buffer.from('tampered'));
  await assert.rejects(replayPrivatePublication(f.reopen(), f.root, f.identity, 'confirmed'), { code: 'PRIVATE_PUBLICATION_INVALID' });
  assert.equal((await f.reopen().readPrivatePublication(f.taskId)).state, 'intent');
  await writeFile(index, original);
  const control = await f.store.readControl(f.taskId);
  await f.store.writeControl(f.taskId, { ...control, native: { ...control.native, state: 'unknown' } });
  await assert.rejects(replayPrivatePublication(f.reopen(), f.root, f.identity, 'confirmed'), { code: 'PRIVATE_GIT_STOP_UNCONFIRMED' });
  assert.equal(await f.canonicalHead(), f.base);
});

test('unsupported retained publication schema blocks reopening', async (t) => {
  const f = await privatePublicationFixture(t);
  await f.store.beginPrivatePublication(f.intent);
  const file = join(f.state, 'tasks', f.taskId, 'private-publication.json');
  const record = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, JSON.stringify({ ...record, schema_version: 2 }));
  await assert.rejects(f.reopen().readPrivatePublication(f.taskId), { code: 'STORE_VERSION_UNSUPPORTED' });
});

test('replay refuses changed workspace bytes after intent', async (t) => {
  const f = await privatePublicationFixture(t);
  await f.store.beginPrivatePublication(f.intent);
  await writeFile(join(f.workspace.path, 'worker.txt'), 'changed after intent\n');
  await assert.rejects(replayPrivatePublication(f.reopen(), f.root, f.identity, 'confirmed'), { code: 'PRIVATE_WORKTREE_DIRTY' });
  assert.equal(await f.canonicalHead(), f.base);
  assert.equal((await f.reopen().readPrivatePublication(f.taskId)).state, 'intent');
});

test('missing retained quarantine cannot be replaced by the changed private tip', async (t) => {
  const f = await privatePublicationFixture(t);
  await f.store.beginPrivatePublication(f.intent);
  await writeFile(join(f.view.private_common_dir, f.workspace.branch), f.base + '\n');
  await unlink(join(f.publication.quarantine_path, 'index'));
  await assert.rejects(replayPrivatePublication(f.reopen(), f.root, f.identity, 'confirmed'));
  assert.equal(await f.canonicalHead(), f.base);
  assert.equal((await f.reopen().readPrivatePublication(f.taskId)).state, 'intent');
});

test('hostile retained quarantine config is rejected before Git can run fsmonitor', async (t) => {
  const f = await privatePublicationFixture(t);
  await f.store.beginPrivatePublication(f.intent);
  const marker = join(f.temp, 'host-fsmonitor-ran'), hook = join(f.temp, 'host-fsmonitor');
  await writeFile(hook, `#!/bin/sh\nprintf ran > '${marker}'\n`, { mode: 0o755 });
  const config = join(f.publication.quarantine_path, 'config');
  await writeFile(config, `${await readFile(config, 'utf8')}\n[core]\n\tfsmonitor = ${hook}\n`);
  await assert.rejects(replayPrivatePublication(f.reopen(), f.root, f.identity, 'confirmed'), { code: 'PRIVATE_PUBLICATION_INVALID' });
  await assert.rejects(stat(marker), { code: 'ENOENT' });
  assert.equal(await f.canonicalHead(), f.base);
});

test('retained bare quarantine rejects a .git redirect to hostile private configuration', async (t) => {
  const f = await privatePublicationFixture(t);
  await f.store.beginPrivatePublication(f.intent);
  const marker = join(f.temp, 'redirect-fsmonitor-ran'), hook = join(f.temp, 'redirect-fsmonitor');
  await writeFile(hook, `#!/bin/sh\nprintf ran > '${marker}'\n`, { mode: 0o755 });
  const privateConfig = join(f.view.private_common_dir, 'config');
  await writeFile(privateConfig, `${await readFile(privateConfig, 'utf8')}\n[core]\n\tfsmonitor = ${hook}\n`);
  await writeFile(join(f.publication.quarantine_path, '.git'), `gitdir: ${f.view.private_common_dir}\n`);
  await assert.rejects(replayPrivatePublication(f.reopen(), f.root, f.identity, 'confirmed'), { code: 'PRIVATE_PUBLICATION_INVALID' });
  await assert.rejects(stat(marker), { code: 'ENOENT' });
  assert.equal(await f.canonicalHead(), f.base);
});

test('retained bare quarantine rejects a commondir redirect to hostile configuration', async (t) => {
  const f = await privatePublicationFixture(t);
  await f.store.beginPrivatePublication(f.intent);
  const marker = join(f.temp, 'commondir-fsmonitor-ran'), hook = join(f.temp, 'commondir-fsmonitor');
  await writeFile(hook, `#!/bin/sh\nprintf ran > '${marker}'\n`, { mode: 0o755 });
  const privateConfig = join(f.view.private_common_dir, 'config');
  await writeFile(privateConfig, `${await readFile(privateConfig, 'utf8')}\n[core]\n\tfsmonitor = ${hook}\n`);
  await writeFile(join(f.publication.quarantine_path, 'commondir'), `${f.view.private_common_dir}\n`);
  await assert.rejects(replayPrivatePublication(f.reopen(), f.root, f.identity, 'confirmed'), { code: 'PRIVATE_PUBLICATION_INVALID' });
  await assert.rejects(stat(marker), { code: 'ENOENT' });
  assert.equal(await f.canonicalHead(), f.base);
});

test('retained quarantine exclude cannot hide an untracked workspace file', async (t) => {
  const f = await privatePublicationFixture(t);
  await f.store.beginPrivatePublication(f.intent);
  await writeFile(join(f.workspace.path, 'hidden.txt'), 'untracked\n');
  const exclude = join(f.publication.quarantine_path, 'info', 'exclude');
  await writeFile(exclude, `${await readFile(exclude, 'utf8')}\nhidden.txt\n`);
  await assert.rejects(replayPrivatePublication(f.reopen(), f.root, f.identity, 'confirmed'), { code: 'PRIVATE_PUBLICATION_INVALID' });
  assert.equal(await f.canonicalHead(), f.base);
});

test('retained quarantine attributes cannot normalize changed workspace bytes', async (t) => {
  const f = await privatePublicationFixture(t);
  await f.store.beginPrivatePublication(f.intent);
  await writeFile(join(f.workspace.path, 'worker.txt'), 'exact worker bytes\r\n');
  await writeFile(join(f.publication.quarantine_path, 'info', 'attributes'), 'worker.txt text\n');
  await assert.rejects(replayPrivatePublication(f.reopen(), f.root, f.identity, 'confirmed'), { code: 'PRIVATE_PUBLICATION_INVALID' });
  assert.equal(await f.canonicalHead(), f.base);
});

test('sterile quarantine inspection ignores host XDG attributes and detects changed bytes', async (t) => {
  const f = await privatePublicationFixture(t);
  await f.store.beginPrivatePublication(f.intent);
  const xdg = join(f.temp, 'xdg'), attributes = join(xdg, 'git', 'attributes');
  await mkdir(join(xdg, 'git'), { recursive: true });
  await writeFile(attributes, 'worker.txt text\n');
  await writeFile(join(f.workspace.path, 'worker.txt'), 'exact worker bytes\r\n');
  const prior = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdg;
  try {
    const attr = await gitSterile(f.publication.quarantine_path, [`--git-dir=${f.publication.quarantine_path}`,
      '-c', 'core.bare=false', `--work-tree=${f.workspace.path}`, 'check-attr', 'text', '--', 'worker.txt']);
    assert.match(attr, /worker\.txt: text: unspecified/);
    await assert.rejects(replayPrivatePublication(f.reopen(), f.root, f.identity, 'confirmed'), { code: 'PRIVATE_WORKTREE_DIRTY' });
  } finally {
    if (prior === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prior;
  }
  assert.equal(await f.canonicalHead(), f.base);
});

test('sterile quarantine inspection ignores host XDG excludes and finds untracked files', async (t) => {
  const f = await privatePublicationFixture(t);
  await f.store.beginPrivatePublication(f.intent);
  const xdg = join(f.temp, 'xdg-ignore');
  await mkdir(join(xdg, 'git'), { recursive: true });
  await writeFile(join(xdg, 'git', 'ignore'), 'hidden.txt\n');
  await writeFile(join(f.workspace.path, 'hidden.txt'), 'untracked\n');
  const prior = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdg;
  try {
    const status = await gitSterile(f.publication.quarantine_path, [`--git-dir=${f.publication.quarantine_path}`,
      '-c', 'core.bare=false', `--work-tree=${f.workspace.path}`, 'status', '--porcelain=v1', '--untracked-files=all']);
    assert.match(status, /\?\? hidden\.txt/);
    await assert.rejects(replayPrivatePublication(f.reopen(), f.root, f.identity, 'confirmed'), { code: 'PRIVATE_WORKTREE_DIRTY' });
  } finally {
    if (prior === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prior;
  }
  assert.equal(await f.canonicalHead(), f.base);
});

test('replay rechecks current task resource before canonical effects', async (t) => {
  const f = await privatePublicationFixture(t);
  await f.store.beginPrivatePublication(f.intent);
  const resource = await f.store.readResource(f.taskId);
  for (const changed of [{ state: 'cleanup_pending' }, { branch_ref: 'refs/heads/other' }, { worktree_path: f.root }]) {
    await f.store.writeResource(f.taskId, { ...resource, ...changed });
    await assert.rejects(replayPrivatePublication(f.reopen(), f.root, f.identity, 'confirmed'), { code: 'PRIVATE_PUBLICATION_IDENTITY' });
    assert.equal(await f.canonicalHead(), f.base);
  }
  await f.store.writeResource(f.taskId, resource);
  assert.equal((await replayPrivatePublication(f.reopen(), f.root, f.identity, 'confirmed')).state, 'published');
});
