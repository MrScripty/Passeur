import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { repoFixture, selectedFixture, A, B, C, op, key, hold, git, RepositoryCoordination, CoordinationStore, CoordinationControl } from '../fixtures/structural/repository-fixture.mjs';
import { decodeRepositoryCommand } from '../../.passeur-core/src/contracts/coordination-control.js';
const run = promisify(execFile);
const child = fileURLToPath(new URL('../fixtures/structural/bound-reopen.mjs', import.meta.url));

async function inChild(f, overrides) {
  const file = join(f.temp, `request-${key()}.json`);
  await writeFile(file, JSON.stringify({ root: f.root, state: f.state, repository_id: f.repositoryId, actor: A,
    source_view: f.root, external_roots: [...f.admittedRoots], ...overrides }));
  const { stdout } = await run(process.execPath, [child, file]); return JSON.parse(stdout);
}

test('repository decoder rejects raw physical identity and actor/source injection', async t => {
  const f = await repoFixture(t), command = f.register();
  for (const extra of [{ workspace_id: 'forged' }, { object_format: 'sha1' }, { owner_id: B.owner_id }, { source_view: f.root }]) {
    assert.throws(() => decodeRepositoryCommand({ ...command, ...extra }), { code: 'COORDINATION_INVALID' });
  }
  assert.throws(() => decodeRepositoryCommand({ ...command, kind: 'register_work' }), { code: 'COORDINATION_OPERATION_UNSUPPORTED' });
  assert.equal((await f.disk()).revision, 0);
});
test('registration derives source identity, preserves dirty work and keeps allowed input separate from current HEAD', async t => {
  const f = await repoFixture(t), next = await f.commit(f.root, 'new.ts', 'new');
  await writeFile(join(f.root, 'source.ts'), 'dirty');
  const command = f.register(), result = await f.bound.execute(f.connection(), command), work = await f.control.work(A, result.item_id);
  assert.equal(work.input_oid, f.base); assert.notEqual(work.input_oid, next);
  assert.equal(work.workspace_id, (await f.bound.repository.inspect(f.root)).workspace_id); assert.equal(work.owner, A.owner_id);
  assert.equal(await readFile(join(f.root, 'source.ts'), 'utf8'), 'dirty');
  assert.deepEqual(await f.bound.execute(f.connection(), command), result);
});
test('simultaneous parents cannot register different aliases of one workspace', async t => {
  const f = await repoFixture(t), alias = join(f.temp, 'alias'); await symlink(f.root, alias);
  const results = await Promise.allSettled([f.bound.execute(f.connection(), f.register()), f.bound.execute(f.connection(B, alias), f.register())]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'COORDINATION_WORKSPACE_HELD');
  assert.equal((await f.disk()).works.length, 1);
});
test('the resource authority can reject external enrollment before any coordination publication', async t => {
  const f = await repoFixture(t, { resourceAuthority: { async assertExternalRegistration(_actor, workspace) {
    assert.ok(workspace.workspace_id.startsWith('git-worktree-v1:'));
    const error = Error('This workspace is already owned by a managed task'); error.code = 'TASK_WORKSPACE_OWNED'; throw error;
  } } });
  await assert.rejects(f.bound.execute(f.connection(), f.register()), { code: 'TASK_WORKSPACE_OWNED' });
  assert.equal((await f.disk()).revision, 0);
});
test('a missing resource authority cannot silently grant external enrollment', async t => {
  const f = await repoFixture(t);
  await assert.rejects(RepositoryCoordination.open(f.root, f.control, {}, { max_worktrees: 64, max_source_operations: 2 }), { code: 'COORDINATION_WORKSPACE_AUTHORITY_UNAVAILABLE' });
});
test('registration refuses unavailable or non-commit bases without publishing a work record', async t => {
  const f = await repoFixture(t), tree = (await git(f.root, ['rev-parse', 'HEAD^{tree}'])).trim();
  await assert.rejects(f.bound.execute(f.connection(), f.register({ input_oid: tree })), { code: 'COORDINATION_COMMIT_REQUIRED' });
  await assert.rejects(f.bound.execute(f.connection(), f.register({ input_oid: '2'.repeat(40) })), { code: 'COORDINATION_COMMIT_UNAVAILABLE' });
  assert.equal((await f.disk()).revision, 0);
});
test('expected areas cannot direct later source analysis into Git administrative paths', async t => {
  const f = await repoFixture(t);
  await assert.rejects(f.bound.execute(f.connection(), f.register({ areas: [{ kind: 'file', path: '.git/config' }] })), { code: 'SOURCE_PATH_INVALID' });
  assert.equal((await f.disk()).revision, 0);
});
test('decoded command and actor values cannot be changed during an external authority check', async t => {
  const entered = hold(), gate = hold();
  const f = await repoFixture(t, { resourceAuthority: { async assertExternalRegistration(actor, workspace) {
    assert.ok(Object.isFrozen(actor)); assert.ok(Object.isFrozen(workspace)); entered.release(); await gate.promise;
  } } });
  const command = f.register(), connection = f.connection(), pending = f.bound.execute(connection, command);
  try { await entered.promise; command.intent = 'changed'; command.areas[0].path = 'changed.ts'; connection.owner_id = B.owner_id; }
  finally { gate.release(); }
  const result = await pending, work = await f.control.work(A, result.item_id);
  assert.equal(work.intent, 'fixture assignment'); assert.equal(work.areas[0].path, 'source.ts');
  await assert.rejects(f.control.work(B, work.id), { code: 'COORDINATION_NOT_FOUND' });
});
test('independent worktrees and different admitted bases retain their own identities', async t => {
  const f = await repoFixture(t), a = await f.linked('a'), newer = await f.commit(f.root, 'new.ts', 'next'), b = await f.linked('b', newer);
  const ar = await f.bound.execute(f.connection(A, a), f.register());
  const br = await f.bound.execute(f.connection(B, b), f.register({ input_oid: newer }));
  assert.equal((await f.control.work(A, ar.item_id)).input_oid, f.base);
  assert.equal((await f.control.work(B, br.item_id)).input_oid, newer);
});
test('two parent principals coordinate exact real Git inputs without advancing any Git ref', async t => {
  const f = await selectedFixture(t), refs = await git(f.root, ['for-each-ref']);
  const result = await f.bound.execute(f.connection(), op('begin_external_integration', f.item));
  let item = await f.control.reconciliation(A, f.item.id); assert.equal(item.external_effect, 'possible');
  assert.equal(await git(f.root, ['for-each-ref']), refs);
  await f.bound.execute(f.connection(), op('record_external_settlement', item)); item = await f.control.reconciliation(A, item.id);
  await f.bound.execute(f.connection(), op('transfer_case', item, { new_lead: B.owner_id }));
  item = await f.control.reconciliation(B, item.id); assert.equal(item.lead, B.owner_id); assert.equal(item.generation, f.item.generation + 1);
  await f.bound.execute(f.connection(B), op('release_case', item));
  assert.deepEqual(await f.bound.receipt(A, result.key), result); assert.equal(await git(f.root, ['for-each-ref']), refs);
});
test('invalid and symbolic targets cannot create independent leadership records', async t => {
  const f = await repoFixture(t);
  await assert.rejects(f.bound.execute(f.connection(), f.claim({ target: 'refs/heads/no..ref' })), { code: 'COORDINATION_TARGET_INVALID' });
  await assert.rejects(f.bound.execute(f.connection(), f.claim({ target: 'refs/heads/missing' })), { code: 'COORDINATION_TARGET_UNAVAILABLE' });
  await git(f.root, ['symbolic-ref', 'refs/heads/alias', 'refs/heads/main']);
  await assert.rejects(f.bound.execute(f.connection(), f.claim({ target: 'refs/heads/alias' })), { code: 'COORDINATION_TARGET_SYMBOLIC' });
  assert.equal((await f.disk()).cases.length, 0);
});
test('target drift refuses a new external-operation marker and preserves source/control records', async t => {
  const f = await selectedFixture(t); await f.commit(f.root, 'later.ts', 'target moved');
  const before = await f.disk();
  await assert.rejects(f.bound.execute(f.connection(), op('begin_external_integration', f.item)), { code: 'COORDINATION_TARGET_CHANGED' });
  assert.deepEqual(await f.disk(), before); assert.equal(await readFile(join(f.worker, 'worker.ts'), 'utf8'), 'export function worker(value: string) {}\n');
});
test('selecting an unrelated sibling commit cannot relabel it as this workspace result', async t => {
  const f = await selectedFixture(t), sibling = await f.linked('sibling'), other = await f.commit(sibling, 'other.ts', 'other');
  const before = await f.disk();
  await assert.rejects(f.bound.execute(f.connection(), op('select_inputs', f.item, { target_oid: f.base, inputs: [{ work_id: f.work.id, commit_oid: other }] })), { code: 'COORDINATION_SOURCE_LINEAGE_CONFLICT' });
  assert.deepEqual(await f.disk(), before);
});
test('permission checks precede source lookup for a non-lead input-selection request', async t => {
  const f = await selectedFixture(t); let lookups = 0; const target = f.bound.repository.target.bind(f.bound.repository);
  f.bound.repository.target = async (...args) => { lookups++; return target(...args); };
  await assert.rejects(f.bound.execute(f.connection(B), op('select_inputs', f.item, { target_oid: f.base, inputs: [] })), { code: 'COORDINATION_FORBIDDEN' });
  assert.equal(lookups, 0);
});
test('a sharing revocation during real Git preflight is rechecked before source-dependent publication', async t => {
  const f = await selectedFixture(t), entered = hold(), gate = hold(), target = f.bound.repository.target.bind(f.bound.repository);
  let held = false;
  f.bound.repository.target = async (...args) => { if (!held) { held = true; entered.release(); await gate.promise; } return target(...args); };
  const operation = f.bound.execute(f.connection(), op('select_inputs', f.item, { target_oid: f.base, inputs: f.item.inputs }));
  try {
    await entered.promise;
    await f.bound.execute(f.connection(), { kind: 'share_work', operation_key: key(), work_id: f.work.id, expected_revision: f.work.revision, readers: [] });
  } finally { gate.release(); }
  await assert.rejects(operation, { code: 'COORDINATION_NOT_FOUND' });
  assert.equal((await f.control.reconciliation(A, f.item.id)).revision, f.item.revision);
});
test('a case revision changing during real source inspection rejects the stale preparation', async t => {
  const f = await selectedFixture(t), entered = hold(), gate = hold(), target = f.bound.repository.target.bind(f.bound.repository); let held = false;
  f.bound.repository.target = async (...args) => { if (!held) { held = true; entered.release(); await gate.promise; } return target(...args); };
  const operation = f.bound.execute(f.connection(), op('begin_external_integration', f.item));
  try {
    await entered.promise;
    await f.control.execute(A, op('select_inputs', f.item, { target_oid: f.base, inputs: f.item.inputs }));
  } finally { gate.release(); }
  await assert.rejects(operation, { code: 'COORDINATION_STALE_REVISION' });
  assert.equal((await f.control.reconciliation(A, f.item.id)).external_effect, 'not_started');
});
test('source-operation saturation does not block work revocation, closure or receipt lookup', async t => {
  const entered = hold(), gate = hold(); let holdRegistration = false;
  const f = await repoFixture(t, { maxSourceOperations: 1, resourceAuthority: { async assertExternalRegistration() {
    if (holdRegistration) { entered.release(); await gate.promise; }
  } } });
  const first = await f.bound.execute(f.connection(), f.register({ readers: [B.owner_id] })), work = await f.control.work(A, first.item_id), secondRoot = await f.linked();
  holdRegistration = true;
  const pending = f.bound.execute(f.connection(B, secondRoot), f.register());
  try {
    await entered.promise;
    await assert.rejects(f.bound.execute(f.connection(), f.claim()), { code: 'COORDINATION_SOURCE_CAPACITY' });
    await f.bound.execute(f.connection(), { kind: 'share_work', operation_key: key(), work_id: work.id, expected_revision: 1, readers: [] });
    await f.bound.execute(f.connection(), { kind: 'close_work', operation_key: key(), work_id: work.id, expected_revision: 2 });
    assert.deepEqual(await f.bound.receipt(A, first.key), first);
  } finally { gate.release(); }
  await pending; assert.equal((await f.control.work(A, work.id)).state, 'closed');
});
test('explicit source cancellation before publication does not create a partial work registration', async t => {
  const entered = hold(), gate = hold(), abort = new AbortController();
  const f = await repoFixture(t, { resourceAuthority: { async assertExternalRegistration() { entered.release(); await gate.promise; } } });
  const pending = f.bound.execute(f.connection(), f.register(), abort.signal);
  try { await entered.promise; abort.abort(Error('observation cancelled before admission')); } finally { gate.release(); }
  await assert.rejects(pending, /observation cancelled before admission/); assert.equal((await f.disk()).revision, 0);
});
test('metadata controls and retained receipts work after the bound source checkout is lost', async t => {
  const f = await selectedFixture(t), begun = await f.bound.execute(f.connection(), op('begin_external_integration', f.item));
  const item = await f.control.reconciliation(A, f.item.id);
  await rename(f.worker, join(f.temp, 'removed-worker'));
  await assert.rejects(f.bound.execute(f.connection(), op('select_inputs', item, { target_oid: f.base, inputs: item.inputs })), { code: 'COORDINATION_EXTERNAL_EFFECT_UNRESOLVED' });
  await f.bound.execute(f.connection(A, f.worker), op('record_external_settlement', item));
  const settled = await f.control.reconciliation(A, item.id);
  await f.bound.execute(f.connection(A, f.worker), op('release_case', settled));
  assert.deepEqual(await f.bound.receipt(A, begun.key), begun); assert.equal(await f.bound.receipt(C, begun.key), undefined);
});
test('cold-process reopen recomputes the same workspace identity and preserves operation-key uniqueness', async t => {
  const f = await repoFixture(t), worker = await f.linked(), command = f.register(), result = await f.bound.execute(f.connection(A, worker), command);
  await f.bound.close();
  const replayed = await inChild(f, { mode: 'execute', source_view: worker, command });
  assert.deepEqual(replayed, result); assert.equal((await f.disk()).works.length, 1);
});
test('a lost acceptance receipt does not replay integration intent after restart or target movement', async t => {
  const f = await selectedFixture(t), command = op('begin_external_integration', f.item); await f.bound.close();
  await assert.rejects(inChild(f, { mode: 'execute', command, exit_after_acceptance: true }), error => error.code === 74);
  const after = await f.disk(), saved = after.receipts.find(r => r.key === command.operation_key);
  assert.equal(after.cases.find(c => c.id === f.item.id).external_effect, 'possible');
  await f.commit(f.root, 'later.ts', 'new target');
  const recovered = await inChild(f, { mode: 'execute', command }); assert.deepEqual(recovered, saved);
  assert.deepEqual(await f.disk(), after);
});
test('closing drains an accepted source operation and refuses new work without a task timer', async t => {
  const entered = hold(), gate = hold();
  const f = await repoFixture(t, { resourceAuthority: { async assertExternalRegistration() { entered.release(); await gate.promise; } } });
  const accepted = f.bound.execute(f.connection(), f.register()); await entered.promise;
  let closed = false; const closing = f.bound.close().then(() => { closed = true; });
  try { await assert.rejects(f.bound.execute(f.connection(), f.claim()), { code: 'COORDINATION_CLOSED' }); assert.equal(closed, false); }
  finally { gate.release(); }
  const receipt = await accepted; await closing; assert.ok(receipt.item_id); assert.equal(closed, true);
});
test('source replacement during resource authorization cannot enroll the stale physical identity', async t => {
  let replaced = false;
  const f = await repoFixture(t, { resourceAuthority: { async assertExternalRegistration(_actor, workspace) {
    if (!replaced) {
      replaced = true;
      const old = `${workspace.root}-old`; await rename(workspace.root, old); await mkdir(workspace.root);
      await writeFile(join(workspace.root, '.git'), await readFile(join(old, '.git')));
    }
  } } });
  const worker = await f.linked();
  await assert.rejects(f.bound.execute(f.connection(A, worker), f.register()), { code: 'COORDINATION_SOURCE_CHANGED' });
  assert.equal((await f.disk()).revision, 0);
});
