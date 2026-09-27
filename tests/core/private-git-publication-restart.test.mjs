import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privatePublicationFixture } from './private-git-publication-fixture.mjs';
import { git } from './helpers.mjs';
import { replayPrivatePublication } from '../../.passeur-core/src/workspace/worktree.js';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
for (const boundary of ['intent', 'zero', 'partial', 'import', 'prepared', 'ref', 'index', 'settlement']) {
  test(`subprocess death after ${boundary} reopens the retained publication once`, async (t) => {
    const f = await privatePublicationFixture(t);
    const input = join(f.temp, `child-${boundary}.json`);
    await writeFile(input, JSON.stringify({ state: f.state, root: f.root, intent: f.intent, identity: f.identity, boundary }));
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./private-git-publication-child.mjs', import.meta.url)), input], { encoding: 'utf8' });
    assert.equal(child.status, 77, `${child.stderr}\n${child.stdout}`);
    const index = join(f.publication.canonical_admin_path, 'index');
    const head = await f.canonicalHead(), indexHash = digest(await readFile(index));
    const object = spawnSync('git', ['-C', f.root, 'cat-file', '-e', `${f.publication.new_head}^{commit}`], { encoding: 'utf8' });
    assert.equal(object.status === 0, !['intent', 'zero', 'partial'].includes(boundary), `import boundary: ${object.stderr}`);
    if (['zero', 'partial', 'prepared'].includes(boundary)) {
      const owner = JSON.parse(await readFile(join(f.publication.quarantine_path, 'index-lock-owner.json'), 'utf8'));
      assert.equal(owner.dev, undefined);
      const prepared = (await readdir(f.publication.canonical_admin_path)).filter(name => name.startsWith('index.passeur-'));
      assert.equal(prepared.length, 1);
      const bytes = await readFile(join(f.publication.canonical_admin_path, prepared[0]));
      if (boundary === 'prepared') assert.equal(digest(bytes), f.publication.new_index_sha256);
      else assert.equal(bytes.length, boundary === 'zero' ? 0 : 16);
    }
    if (['intent', 'zero', 'partial', 'import', 'prepared'].includes(boundary)) {
      assert.equal(head, f.base); assert.equal(indexHash, f.publication.old_index_sha256);
    } else if (boundary === 'ref') {
      assert.equal(head, f.publication.new_head); assert.equal(indexHash, f.publication.old_index_sha256);
    } else {
      assert.equal(head, f.publication.new_head); assert.equal(indexHash, f.publication.new_index_sha256);
    }
    assert.equal((await f.reopen().readPrivatePublication(f.taskId)).state, boundary === 'settlement' ? 'published' : 'intent');
    const result = await replayPrivatePublication(f.reopen(), f.root, f.identity, 'confirmed');
    assert.equal(result.state, 'published');
    assert.deepEqual(await replayPrivatePublication(f.reopen(), f.root, f.identity, 'confirmed'), result);
    assert.equal(await f.canonicalHead(), f.publication.new_head);
    assert.equal(digest(await readFile(index)), f.publication.new_index_sha256);
    assert.equal((await readdir(f.publication.canonical_admin_path)).filter(name => name.startsWith('index.passeur-')).length, 0);
    assert.equal((await git(f.workspace.path, 'status', '--porcelain')), '');
    assert.equal(await readFile(join(f.workspace.path, 'worker.txt'), 'utf8'), 'exact worker bytes\n');
  });
}

test('reversed and divergent ref/index combinations remain unresolved', async (t) => {
  const f = await privatePublicationFixture(t);
  await f.store.beginPrivatePublication(f.intent);
  const index = join(f.publication.canonical_admin_path, 'index');
  const oldIndex = await readFile(index), newIndex = await readFile(join(f.publication.quarantine_path, 'index'));
  await writeFile(index, newIndex);
  await assert.rejects(replayPrivatePublication(f.reopen(), f.root, f.identity, 'confirmed'), { code: 'PRIVATE_PUBLICATION_CONFLICT' });
  assert.equal(await f.canonicalHead(), f.base);
  await writeFile(index, oldIndex);
  await git(f.root, 'commit', '--allow-empty', '-qm', 'other canonical commit');
  const other = (await git(f.root, 'rev-parse', 'HEAD')).trim();
  await git(f.root, 'update-ref', f.workspace.branch, other, f.base);
  await assert.rejects(replayPrivatePublication(f.reopen(), f.root, f.identity, 'confirmed'), { code: 'PRIVATE_PUBLICATION_CONFLICT' });
  assert.equal((await f.reopen().readPrivatePublication(f.taskId)).state, 'intent');
});
