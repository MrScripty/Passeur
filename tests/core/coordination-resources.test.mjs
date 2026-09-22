import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, symlink, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertExternalWorkspace } from '../../.passeur-core/src/core/coordination-resources.js';
import { repoFixture, CoordinationRepository, git, hold } from '../fixtures/structural/repository-fixture.mjs';

async function fixture(t) {
  const f = await repoFixture(t), repository = await CoordinationRepository.open(f.root, f.repositoryId, 64), claims = new Map();
  const inventory = { async list() { return [...claims].map(([task_id, value]) => ({ task_id, project_id: value?.project_id ?? f.repositoryId })); },
    async readResource(id) { return structuredClone(claims.get(id)); },
    async readState(id) { assert.ok(claims.has(id)); return { phase: "terminal" }; } };
  const claim = (path, branch, state = 'pending') => { const task_id = randomUUID(); claims.set(task_id,
    { task_id, project_id: f.repositoryId, state, worktree_path: path, branch_ref: branch }); return task_id; };
  const check = async (path = f.root, options = {}) => assertExternalWorkspace(await repository.inspect(path), options.inventory ?? inventory,
    options.limits ?? { records: 64, worktrees: 64 }, options.authority ?? (() => {}), options.signal);
  return { ...f, repository, claims, inventory, claim, check };
}
test('empty task inventory admits an independently verified external workspace', async t => {
  const f = await fixture(t); await f.check();
});
test('managed root is rejected even for completed retained work', async t => {
  const f = await fixture(t), worker = await f.linked('managed'); f.claim(worker, 'refs/heads/managed', 'retained');
  await assert.rejects(f.check(worker), { code: 'COORDINATION_WORKSPACE_MANAGED' });
});
test('unrelated external workspace remains usable beside a known managed worktree', async t => {
  const f = await fixture(t), worker = await f.linked('managed'); f.claim(worker, 'refs/heads/managed'); await f.check();
});
test('candidate alias resolves to the same managed physical workspace', async t => {
  const f = await fixture(t), worker = await f.linked('managed'), alias = join(f.temp, 'alias');
  f.claim(worker, 'refs/heads/managed'); await symlink(worker, alias);
  await assert.rejects(f.check(alias), { code: 'COORDINATION_WORKSPACE_MANAGED' });
});
test('recorded symlink alias cannot authorize the underlying managed directory', async t => {
  const f = await fixture(t), worker = await f.linked('managed'), alias = join(f.temp, 'alias');
  await symlink(worker, alias); f.claim(alias, 'refs/heads/managed');
  await assert.rejects(f.check(worker), { code: 'COORDINATION_WORKSPACE_MANAGED' });
});
test('moved managed worktree is located through its retained branch', async t => {
  const f = await fixture(t), worker = await f.linked('managed'), moved = join(f.temp, 'moved work');
  f.claim(worker, 'refs/heads/managed'); await git(f.root, ['worktree', 'move', worker, moved]);
  await assert.rejects(f.check(moved), { code: 'COORDINATION_WORKSPACE_MANAGED' });
  await assert.rejects(f.check(), { code: 'COORDINATION_RESOURCE_UNAVAILABLE' });
});
test('changed managed branch does not erase ownership of its original root', async t => {
  const f = await fixture(t), worker = await f.linked('managed'); f.claim(worker, 'refs/heads/managed');
  await git(worker, ['checkout', '-b', 'different']);
  await assert.rejects(f.check(worker), { code: 'COORDINATION_WORKSPACE_MANAGED' });
  await assert.rejects(f.check(), { code: 'COORDINATION_RESOURCE_UNAVAILABLE' });
});
test('losing both resource anchors produces uncertainty rather than external admission', async t => {
  const f = await fixture(t), worker = await f.linked('managed'), moved = join(f.temp, 'moved');
  f.claim(worker, 'refs/heads/managed'); await git(f.root, ['worktree', 'move', worker, moved]); await git(moved, ['checkout', '--detach']);
  await assert.rejects(f.check(), { code: 'COORDINATION_RESOURCE_UNAVAILABLE' });
});
test('missing or unclassified resource evidence never becomes an empty ownership claim', async t => {
  const f = await fixture(t), task = randomUUID(); f.claims.set(task, undefined);
  await assert.rejects(f.check(), { code: 'COORDINATION_RESOURCE_UNAVAILABLE' });
  f.claims.set(task, { task_id: task, project_id: f.repositoryId, state: 'legacy_unclassified' });
  await assert.rejects(f.check(), { code: 'COORDINATION_RESOURCE_UNAVAILABLE' });
});
test('explicit no-workspace and retired records do not retain active ownership', async t => {
  const f = await fixture(t); f.claim(f.root, 'refs/heads/main', 'retired');
  const task_id = randomUUID(); f.claims.set(task_id, { task_id, project_id: f.repositoryId, state: 'not_applicable' });
  await f.check();
});
test('cross-repository or inconsistent task/resource identity is refused', async t => {
  const f = await fixture(t), id = f.claim(f.root, 'refs/heads/main');
  f.claims.get(id).project_id = 'a'.repeat(24); await assert.rejects(f.check(), { code: 'COORDINATION_RESOURCE_UNAVAILABLE' });
  f.claims.get(id).project_id = f.repositoryId; f.claims.get(id).task_id = randomUUID();
  await assert.rejects(f.check(), { code: 'COORDINATION_RESOURCE_UNAVAILABLE' });
});
test('an excessive managed-record inventory is refused before per-record reads', async t => {
  const f = await fixture(t); let reads = 0;
  const inventory = { async list() { return [1, 2].map(() => ({ task_id: randomUUID(), project_id: f.repositoryId })); },
    async readResource() { reads++; throw new Error('must not read'); } };
  await assert.rejects(f.check(f.root, { inventory, limits: { records: 1, worktrees: 64 } }), { code: 'COORDINATION_RESOURCE_CAPACITY' }); assert.equal(reads, 0);
});
test('worktree inspection applies its own bound separately from record count', async t => {
  const f = await fixture(t), worker = await f.linked('managed'); f.claim(worker, 'refs/heads/managed');
  await assert.rejects(f.check(f.root, { limits: { records: 64, worktrees: 1 } }), { code: 'COORDINATION_RESOURCE_CAPACITY' });
});
test('ownership loss after the inventory await prevents an empty-inventory success', async t => {
  const f = await fixture(t); let owned = true;
  const inventory = { async list() { owned = false; return []; }, async readResource() { throw new Error('unexpected'); } };
  await assert.rejects(f.check(f.root, { inventory, authority() { if (!owned) throw Object.assign(new Error('lost'), { code: 'TEST_AUTHORITY_LOST' }); } }), { code: 'TEST_AUTHORITY_LOST' });
});
test('cancelled source inspection observes cancellation instead of returning permission', async t => {
  const f = await fixture(t), controller = new AbortController(); controller.abort(Object.assign(new Error('stopped'), { code: 'TEST_STOP' }));
  await assert.rejects(f.check(f.root, { signal: controller.signal }), { code: 'TEST_STOP' });
});
test('unknown resource state and incomplete creating intent require reconciliation', async t => {
  const f = await fixture(t), task_id = randomUUID();
  for (const state of ['future', 'creating']) {
    f.claims.set(task_id, { task_id, project_id: f.repositoryId, state }); await assert.rejects(f.check(), { code: 'COORDINATION_RESOURCE_UNAVAILABLE' });
  }
});

test('reusing a former managed path cannot make the moved detached workspace externally eligible', async t => {
  const f = await fixture(t), worker = await f.linked('managed'), moved = join(f.temp, 'moved');
  f.claim(worker, 'refs/heads/managed');
  await git(f.root, ['worktree', 'move', worker, moved]); await git(moved, ['checkout', '--detach']);
  await git(f.root, ['worktree', 'add', '-b', 'replacement', worker, f.base]);
  await assert.rejects(f.check(moved), { code: 'COORDINATION_RESOURCE_UNAVAILABLE' });
});

test('an independently registered nested worktree cannot borrow a managed workspace directory', async t => {
  const f = await fixture(t), worker = await f.linked('managed'), nested = join(worker, 'nested');
  f.claim(worker, 'refs/heads/managed');
  await git(f.root, ['worktree', 'add', '-b', 'nested', nested, f.base]);
  await assert.rejects(f.check(nested), { code: 'COORDINATION_WORKSPACE_MANAGED' });
});
test('a retired resource label cannot override a nonterminal task state', async t => {
  const f = await fixture(t); f.claim(f.root, 'refs/heads/main', 'retired');
  f.inventory.readState = async () => ({ phase: 'active' });
  await assert.rejects(f.check(), { code: 'COORDINATION_RESOURCE_UNAVAILABLE' });
});

test('component-boundary comparison permits a similarly named sibling workspace', async t => {
  const f = await fixture(t), worker = await f.linked('managed'), sibling = await f.linked('managed-extra');
  f.claim(worker, 'refs/heads/managed'); await f.check(sibling);
});
test('a containing external root cannot enroll over a retained nested task workspace', async t => {
  const f = await fixture(t), nested = join(f.root, 'managed');
  await git(f.root, ['worktree', 'add', '-b', 'nested-managed', nested, f.base]);
  f.claim(nested, 'refs/heads/nested-managed');
  await assert.rejects(f.check(), { code: 'COORDINATION_WORKSPACE_MANAGED' });
});
test('a no-resource disposition carrying an owned path is contradictory evidence', async t => {
  const f = await fixture(t); f.claim(f.root, 'refs/heads/main', 'not_applicable');
  await assert.rejects(f.check(), { code: 'COORDINATION_RESOURCE_UNAVAILABLE' });
});
