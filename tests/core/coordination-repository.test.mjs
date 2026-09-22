import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile, rename, chmod, readFile, access, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { repoFixture, CoordinationRepository, git } from '../fixtures/structural/repository-fixture.mjs';

for (const format of ['sha1', 'sha256']) {
  test(`${format}: root and linked workspace share repository but have independent stable identities`, async t => {
    const f = await repoFixture(t, { format }), linked = await f.linked();
    const a = await f.bound.repository.inspect(f.root), b = await f.bound.repository.inspect(linked);
    assert.equal(a.repository_id, f.repositoryId); assert.equal(b.repository_id, f.repositoryId);
    assert.notEqual(a.workspace_id, b.workspace_id); assert.equal(a.object_format, format);
    assert.equal(a.head_oid.length, format === 'sha1' ? 40 : 64); assert.ok(Object.isFrozen(a));
    assert.deepEqual(await f.bound.repository.inspect(f.root), a);
    assert.equal((await f.bound.repository.resolveMany([a.workspace_id, b.workspace_id])).size, 2);
  });
  test(`${format}: exact object validation rejects wrong types and preserves missing-object failures`, async t => {
    const f = await repoFixture(t, { format }), repository = f.bound.repository;
    assert.equal(await repository.commit(f.base), f.base);
    const tree = (await git(f.root, ['rev-parse', 'HEAD^{tree}'])).trim();
    const blob = (await git(f.root, ['rev-parse', 'HEAD:source.ts'])).trim();
    await git(f.root, ['tag', '-a', 'fixture-tag', '-m', 'annotated']);
    const tag = (await git(f.root, ['rev-parse', 'refs/tags/fixture-tag'])).trim();
    for (const object of [tree, blob, tag]) await assert.rejects(repository.commit(object), { code: 'COORDINATION_COMMIT_REQUIRED' });
    await assert.rejects(repository.commit('1'.repeat(f.base.length)), { code: 'COORDINATION_COMMIT_UNAVAILABLE' });
    await assert.rejects(repository.commit('1'.repeat(f.base.length === 40 ? 64 : 40)), { code: 'COORDINATION_OBJECT_FORMAT_CONFLICT' });
    await assert.rejects(repository.commit('HEAD'), { code: 'COORDINATION_INVALID' });
  });
}
test('symlink aliases resolve to the same physical work identity', async t => {
  const f = await repoFixture(t), alias = join(f.temp, 'alias'); await symlink(f.root, alias);
  assert.equal((await f.bound.repository.inspect(alias)).workspace_id, (await f.bound.repository.inspect(f.root)).workspace_id);
});
test('paths with spaces, quotes, Unicode and embedded newlines are not trimmed or shell interpreted', async t => {
  const f = await repoFixture(t, { rootName: 'repo \"名\n ' });
  const linked = await f.linked('worker name\n ');
  const observed = await f.bound.repository.inspect(linked);
  assert.equal(observed.root, linked); assert.equal(observed.common_dir, join(f.root, '.git'));
});
test('a subdirectory cannot masquerade as a whole workspace', async t => {
  const f = await repoFixture(t); await mkdir(join(f.root, 'sub'));
  await assert.rejects(f.bound.repository.inspect(join(f.root, 'sub')), { code: 'COORDINATION_WORKSPACE_UNREGISTERED' });
  await assert.rejects(CoordinationRepository.open(join(f.root, 'sub'), f.repositoryId, 64), { code: 'COORDINATION_WORKSPACE_ROOT_INVALID' });
});
test('a separate clone with the same commits is not this repository namespace', async t => {
  const f = await repoFixture(t), clone = join(f.temp, 'clone'); await git(f.temp, ['clone', '--no-local', f.root, clone]);
  await assert.rejects(f.bound.repository.inspect(clone), { code: 'COORDINATION_WORKSPACE_UNREGISTERED' });
  await assert.rejects(CoordinationRepository.open(clone, f.repositoryId, 64), { code: 'COORDINATION_BINDING_CONFLICT' });
});
test('detached worktrees have valid physical identities without inventing a branch', async t => {
  const f = await repoFixture(t), linked = await f.linked('detached', f.base, true);
  const observed = await f.bound.repository.inspect(linked);
  assert.equal(observed.head_oid, f.base); assert.ok(observed.workspace_id.startsWith('git-worktree-v1:'));
});
test('moving a workspace does not silently retarget an existing physical registration', async t => {
  const f = await repoFixture(t), linked = await f.linked(), original = await f.bound.repository.inspect(linked), moved = join(f.temp, 'moved');
  await git(f.root, ['worktree', 'move', linked, moved]);
  await assert.rejects(f.bound.repository.resolveMany([original.workspace_id]), { code: 'COORDINATION_WORKSPACE_UNAVAILABLE' });
  assert.notEqual((await f.bound.repository.inspect(moved)).workspace_id, original.workspace_id);
});
test('a replaced source root does not inherit the original work identity', async t => {
  const f = await repoFixture(t), linked = await f.linked(), first = await f.bound.repository.inspect(linked);
  const saved = join(f.temp, 'saved'); await rename(linked, saved); await mkdir(linked);
  await writeFile(join(linked, '.git'), await readFile(join(saved, '.git')));
  assert.notEqual((await f.bound.repository.inspect(linked)).workspace_id, first.workspace_id);
  await assert.rejects(f.bound.repository.resolveMany([first.workspace_id]), { code: 'COORDINATION_WORKSPACE_UNAVAILABLE' });
});
test('old unverified metadata remains unavailable as a physical-workspace capability', async t => {
  const f = await repoFixture(t);
  await assert.rejects(f.bound.repository.resolveMany(['unverified-label']), { code: 'COORDINATION_WORKSPACE_UNVERIFIED' });
});
test('selected commits must lie between the admitted input and the observed work head', async t => {
  const f = await repoFixture(t), a = await f.linked('a'), b = await f.linked('b');
  const a1 = await f.commit(a, 'a.ts', 'A1'), a2 = await f.commit(a, 'a.ts', 'A2'), b1 = await f.commit(b, 'b.ts', 'B1');
  await f.bound.repository.retainedBetween(f.base, a1, a2);
  await assert.rejects(f.bound.repository.retainedBetween(a2, a1, a2), { code: 'COORDINATION_SOURCE_LINEAGE_CONFLICT' });
  await assert.rejects(f.bound.repository.retainedBetween(f.base, b1, a2), { code: 'COORDINATION_SOURCE_LINEAGE_CONFLICT' });
});
test('direct target lookup refuses missing refs, malformed refs, aliases and stale expected heads', async t => {
  const f = await repoFixture(t), r = f.bound.repository;
  assert.equal(await r.target('refs/heads/main'), f.base);
  await git(f.root, ['branch', 'main-other']);
  await assert.rejects(r.target('refs/heads/mai'), { code: 'COORDINATION_TARGET_UNAVAILABLE' });
  await assert.rejects(r.target('refs/heads/x..y'), { code: 'COORDINATION_TARGET_INVALID' });
  await git(f.root, ['symbolic-ref', 'refs/heads/alias', 'refs/heads/main']);
  await assert.rejects(r.target('refs/heads/alias'), { code: 'COORDINATION_TARGET_SYMBOLIC' });
  const next = await f.commit(f.root, 'next.ts', 'new');
  await assert.rejects(r.target('refs/heads/main', f.base), { code: 'COORDINATION_TARGET_CHANGED' });
  assert.equal(await r.target('refs/heads/main', next), next);
});
test('explicit worktree inventory bounds are honored without mutating registrations', async t => {
  const f = await repoFixture(t, { maxWorktrees: 1 }); await f.linked();
  const prior = await git(f.root, ['worktree', 'list', '--porcelain', '-z']);
  await assert.rejects(f.bound.repository.inspect(f.root), { code: 'COORDINATION_INVENTORY_LIMIT' });
  assert.equal(await git(f.root, ['worktree', 'list', '--porcelain', '-z']), prior);
});
test('inspection preserves dirty work, index and refs and does not call configured fsmonitor or hooks', async t => {
  const f = await repoFixture(t), marker = join(f.temp, 'called'), helper = join(f.temp, 'hook.sh');
  await writeFile(helper, `#!/bin/sh\nprintf called >> '${marker}'\n`); await chmod(helper, 0o755);
  for (const name of ['pre-commit', 'post-checkout', 'post-merge']) {
    const hook = join(f.root, '.git/hooks', name); await copyFile(helper, hook); await chmod(hook, 0o755);
  }
  await git(f.root, ['config', 'core.fsmonitor', helper]);
  await writeFile(join(f.root, 'staged.ts'), 'staged'); await git(f.root, ['-c', 'core.fsmonitor=false', 'add', 'staged.ts']);
  await writeFile(join(f.root, 'source.ts'), 'dirty'); await writeFile(join(f.root, 'untracked.ts'), 'untracked');
  const index = await readFile(join(f.root, '.git/index')), refs = await git(f.root, ['for-each-ref']);
  const facts = await f.bound.repository.inspect(f.root);
  await f.bound.repository.retainedBetween(f.base, f.base, facts.head_oid); await f.bound.repository.target('refs/heads/main');
  assert.deepEqual(await readFile(join(f.root, '.git/index')), index); assert.equal(await git(f.root, ['for-each-ref']), refs);
  assert.equal(await readFile(join(f.root, 'source.ts'), 'utf8'), 'dirty'); await assert.rejects(access(marker), { code: 'ENOENT' });
  await git(f.root, ['config', '--unset', 'core.fsmonitor']);
});
test('source validation respects explicit cancellation without changing control state', async t => {
  const f = await repoFixture(t), abort = new AbortController(); abort.abort(Error('selected observation stopped'));
  const before = await f.disk(); await assert.rejects(f.bound.repository.inspect(f.root, abort.signal), /selected observation stopped/);
  assert.deepEqual(await f.disk(), before);
});
test('repository inspection remains available after the worktree that opened it is removed', async t => {
  const f = await repoFixture(t), opening = await f.linked('opening');
  const repository = await CoordinationRepository.open(opening, f.repositoryId, 64);
  await git(f.root, ['worktree', 'remove', opening]);
  assert.equal(await repository.target('refs/heads/main'), f.base);
  assert.equal((await repository.inspect(f.root)).repository_id, f.repositoryId);
});
test('an unrelated unborn worktree does not block inspection of established workspaces', async t => {
  const f = await repoFixture(t), identity = (await f.bound.repository.inspect(f.root)).workspace_id;
  await git(f.root, ['worktree', 'add', '--orphan', '-b', 'unborn', join(f.temp, 'unborn')]);
  assert.equal((await f.bound.repository.inspect(f.root)).head_oid, f.base);
  assert.equal((await f.bound.repository.resolveMany([identity])).get(identity).head_oid, f.base);
});
