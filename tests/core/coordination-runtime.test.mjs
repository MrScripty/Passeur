import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { runtimeFixture, request, command, readRequest, key, hold, git, BridgeError } from '../fixtures/structural/runtime-fixture.mjs';

test('runtime identity/status do not prepare tasks, initialize coordination, or load an execution profile', async t => {
  const f = await runtimeFixture(t);
  // Actual service bootstrap creates its private namespace, not its task/control records.
  await mkdir(f.binding.storeRoot, { recursive: true, mode: 0o700 });
  assert.equal((await f.call(request('identity'))).parent_id, f.ordinary.owner_id);
  assert.equal((await f.call(request('status'))).state, 'not_enabled');
  assert.equal(f.counts.acquire, 0); assert.equal(f.counts.initialize, 0); assert.equal(f.counts.profile, 0);
  await assert.rejects(access(join(f.binding.storeRoot, 'coordination')), { code: 'ENOENT' });
  await assert.rejects(access(join(f.binding.storeRoot, 'operator-control.token')), { code: 'ENOENT' });
});
test('existing operator credential authorizes initialization without loading the execution profile', async t => {
  const f = await runtimeFixture(t), token = await f.token();
  const reply = await f.initialize();
  assert.equal(reply.state, 'ready'); assert.equal(f.counts.acquire, 1); assert.equal(f.counts.profile, 0);
  assert.equal(await readFile(join(f.binding.storeRoot, 'operator-control.token'), 'utf8'), token);
  assert.equal((await f.call(request('initialize', { limits: f.limits }))).epoch, reply.epoch);
  assert.equal(f.counts.recover, 1);
});
test('ordinary authenticated parent cannot initialize or manufacture approval', async t => {
  const f = await runtimeFixture(t); await f.token();
  await assert.rejects(f.call(request('initialize', { limits: f.limits }), f.ordinary), { code: 'COORDINATION_INITIALIZATION_FORBIDDEN' });
  await assert.rejects(f.call(request('initialize', { limits: f.limits, approved: true }), f.ordinary), { code: 'COORDINATION_SERVICE_INVALID' });
  await assert.rejects(access(join(f.binding.storeRoot, 'coordination')), { code: 'ENOENT' });
  assert.equal(f.counts.profile, 0);
});
test('missing credential is not created by a denied initialization request', async t => {
  const f = await runtimeFixture(t);
  await assert.rejects(f.call(request('initialize', { limits: f.limits })), { code: 'COORDINATION_INITIALIZATION_FORBIDDEN' });
  await assert.rejects(access(join(f.binding.storeRoot, 'operator-control.token')), { code: 'ENOENT' });
  assert.equal((await f.call(request('status'))).state, 'not_enabled');
});
test('malformed request and cancelled admission never acquire runtime authority', async t => {
  const f = await runtimeFixture(t), stop = new AbortController(); stop.abort(new BridgeError('TEST_ABORT', 'pre-admission'));
  await assert.rejects(f.call(request('status', { actor: f.ordinary.owner_id })), { code: 'COORDINATION_SERVICE_INVALID' });
  await assert.rejects(f.call(request('status'), f.ordinary, f.root, stop.signal), { code: 'TEST_ABORT' });
  await assert.rejects(f.call(request('identity'), f.ordinary, 'relative'), { code: 'COORDINATION_SOURCE_VIEW_INVALID' });
  assert.equal(f.counts.acquire, 0);
});
test('two runtime parents register distinct real worktrees without shared task control', async t => {
  const f = await runtimeFixture(t); await f.initialize(); const other = await f.linked('external');
  const [a, b] = await Promise.all([f.call(f.register({ readers: [f.ordinary.owner_id] })), f.call(f.register(), f.ordinary, other)]);
  assert.notEqual(a.receipt.item_id, b.receipt.item_id);
  assert.equal((await f.get('work', a.receipt.item_id, f.ordinary)).owner, f.operator.owner_id);
  await assert.rejects(f.get('work', b.receipt.item_id, f.operator), { code: 'COORDINATION_NOT_FOUND' });
  assert.equal(f.counts.profile, 0); assert.equal(f.counts.acquire, 1);
});
test('actual runtime resource inventory denies external enrollment of a managed task worktree', async t => {
  const f = await runtimeFixture(t); await f.initialize(); const worker = await f.linked('managed');
  f.managed(worker, 'refs/heads/managed');
  await assert.rejects(f.call(f.register(), f.operator, worker), { code: 'COORDINATION_WORKSPACE_MANAGED' });
  assert.equal((await f.disk()).works.length, 0);
  assert.equal((await f.call(request('status'))).state, 'ready');
});
test('runtime continues to deny a moved managed workspace through its retained branch', async t => {
  const f = await runtimeFixture(t); await f.initialize(); const worker = await f.linked('managed'), moved = join(f.temp, 'managed moved');
  f.managed(worker, 'refs/heads/managed'); await git(f.root, ['worktree', 'move', worker, moved]);
  await assert.rejects(f.call(f.register(), f.operator, moved), { code: 'COORDINATION_WORKSPACE_MANAGED' });
});
test('unresolved resource evidence refuses new registration while receipt reads remain usable', async t => {
  const f = await runtimeFixture(t); await f.initialize(); const registered = await f.call(f.register());
  const worker = await f.linked('managed'), id = f.managed(worker, 'refs/heads/managed'); f.claims.set(id, undefined);
  await assert.rejects(f.call(f.register(), f.ordinary, worker), { code: 'COORDINATION_RESOURCE_UNAVAILABLE' });
  assert.equal((await f.get('receipt', registered.receipt.key)).item_id, registered.receipt.item_id);
});
test('observer abort after admission retains the operation through publication and wakes settlement', async t => {
  const f = await runtimeFixture(t); await f.initialize(); const gate = f.gate(), entered = hold();
  f.setBeforeList(async () => { entered.release(); await gate.promise; });
  const stop = new AbortController(), req = f.register(); let notified = 0;
  f.runtime.onSettled = () => { notified++; };
  const observed = f.call(req, f.operator, f.root, stop.signal); observed.catch(() => {});
  await entered.promise; stop.abort(new BridgeError('OBSERVER_LEFT', 'fixture observer left'));
  await assert.rejects(observed, { code: 'OBSERVER_LEFT' }); assert.equal(await f.runtime.hasObligations(), true);
  gate.release(); f.setBeforeList(undefined);
  // Runtime shutdown joins the actual admitted operation, not its cancelled observer.
  await f.runtime.shutdown();
  const state = await f.disk(); assert.equal(state.works.length, 1);
  assert.equal(state.receipts.filter(r => r.key === req.command.operation_key).length, 1);
  assert.ok(notified >= 1); assert.equal(f.counts.release, 1);
});
test('shutdown retains its lease until an admitted resource inspection and command settle', async t => {
  const f = await runtimeFixture(t); await f.initialize(); const gate = f.gate(), entered = hold();
  f.setBeforeList(async () => { entered.release(); await gate.promise; });
  const operation = f.call(f.register()); await entered.promise;
  let closed = false; const closing = f.runtime.shutdown().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false); assert.equal(f.counts.release, 0);
  await assert.rejects(f.call(request('identity')), { code: 'BRIDGE_CLOSING' });
  gate.release(); assert.equal((await operation).kind, 'receipt'); await closing;
  assert.equal(f.counts.release, 1); assert.equal((await f.disk()).works.length, 1);
});
test('runtime drain refuses new work but permits case release and historical reads', async t => {
  const f = await runtimeFixture(t); await f.initialize();
  const receipt = await f.call(command({ kind: 'claim_target', operation_key: key(), target: 'refs/heads/main', members: [] }));
  const item = await f.get('case', receipt.receipt.item_id); await f.runtime.stopAdmission();
  await assert.rejects(f.call(f.register()), { code: 'COORDINATION_SERVICE_DRAINING' });
  await assert.rejects(f.call(request('initialize', { limits: f.limits })), { code: 'COORDINATION_SERVICE_DRAINING' });
  await f.call(command({ kind: 'release_case', operation_key: key(), case_id: item.id, expected_revision: item.revision, generation: item.generation }));
  assert.equal((await f.get('case', item.id)).state, 'closed'); await f.runtime.drain();
});
test('drain racing preparation prevents a not-yet-dispatched mutation', async t => {
  const f = await runtimeFixture(t), gate = f.gate(), entered = hold(); await f.token();
  f.setBeforeRecover(async () => { entered.release(); await gate.promise; });
  const init = f.call(request('initialize', { limits: f.limits })); init.catch(() => {});
  await entered.promise; await f.runtime.stopAdmission(); gate.release();
  await assert.rejects(init, { code: 'COORDINATION_SERVICE_DRAINING' });
  assert.equal((await f.call(request('status'))).state, 'not_enabled');
});
test('root lane capacity is bounded before preparation and receipt retrieval has separate capacity', async t => {
  const f = await runtimeFixture(t); await f.initialize(); const saved = await f.call(f.register()); await f.restart();
  const gate = f.gate(), entered = hold(); f.setBeforeRecover(async () => { entered.release(); await gate.promise; });
  const outstanding = Array.from({ length: 16 }, () => f.call(request('initialize', { limits: f.limits })));
  await entered.promise;
  await assert.rejects(f.call(request('identity')), { code: 'COORDINATION_SERVICE_CAPACITY' });
  assert.equal((await f.get('receipt', saved.receipt.key)).item_id, saved.receipt.item_id);
  gate.release(); assert.ok((await Promise.all(outstanding)).every(x => x.state === 'ready'));
  assert.equal((await f.call(request('identity'))).parent_id, f.operator.owner_id);
});
test('runtime holds copied actor, command and source values while preparation is suspended', async t => {
  const f = await runtimeFixture(t); await f.token(); const gate = f.gate(), entered = hold();
  f.setBeforeRecover(async () => { entered.release(); await gate.promise; });
  const actor = { ...f.operator }, init = request('initialize', { limits: { ...f.limits } });
  const promise = f.call(init, actor); await entered.promise;
  actor.owner_id = f.ordinary.owner_id; init.limits.works = 1; gate.release();
  assert.equal((await promise).limits.works, f.limits.works);
});
test('lease compromise refuses an in-flight coordination mutation without losing historical evidence', async t => {
  const f = await runtimeFixture(t); await f.initialize(); const original = await f.disk();
  const gate = f.gate(), entered = hold(); f.setBeforeList(async () => { entered.release(); await gate.promise; });
  const pending = f.call(f.register()); pending.catch(() => {}); await entered.promise;
  f.loseAuthority(); gate.release(); await assert.rejects(pending, { code: 'LEASE_NOT_HELD' });
  assert.deepEqual(await f.disk(), original); assert.equal(f.runtime.status().coordination.state, 'frozen');
  assert.equal((await f.call(request('status'))).state, 'ready');
});
test('a new runtime reopens coordination and validates the existing operator rather than resetting state', async t => {
  const f = await runtimeFixture(t); await f.initialize(); const registered = await f.call(f.register()); const before = await f.disk();
  await f.restart(); assert.equal((await f.call(request('status'))).epoch, before.epoch);
  assert.equal((await f.get('work', registered.receipt.item_id)).input_oid, f.base);
  assert.deepEqual(await f.disk(), before); assert.equal(f.counts.acquire, 1, 'readonly reopen does not acquire a new lease');
});
test('initialization rejects changed operator identity and preserves initialized bytes', async t => {
  const f = await runtimeFixture(t); await f.initialize(); const before = await f.disk();
  await writeFile(join(f.binding.storeRoot, 'operator-control.token'), 'c'.repeat(64));
  await assert.rejects(f.call(request('initialize', { limits: f.limits })), { code: 'COORDINATION_INITIALIZATION_FORBIDDEN' });
  assert.deepEqual(await f.disk(), before);
});
test('initialization failure does not poison a later authorized request', async t => {
  const f = await runtimeFixture(t);
  await assert.rejects(f.call(request('initialize', { limits: f.limits })), { code: 'COORDINATION_INITIALIZATION_FORBIDDEN' });
  assert.equal((await f.initialize()).state, 'ready'); assert.equal(f.counts.acquire, 1);
});
test('advisory settlement callback failure does not invalidate a durable command receipt', async t => {
  const f = await runtimeFixture(t); await f.initialize();
  f.runtime.onSettled = () => { throw new BridgeError('NOTICE_FAILED', 'fixture notification observer failed'); };
  const reply = await f.call(f.register()); assert.equal(reply.kind, 'receipt');
  assert.equal((await f.get('receipt', reply.receipt.key)).item_id, reply.receipt.item_id);
  assert.equal(f.runtime.status().coordination.failure.code, 'NOTICE_FAILED');
});
test('preparation error preserves its diagnostic and leaves no coordination authority', async t => {
  const f = await runtimeFixture(t); await f.token();
  f.setBeforeRecover(async () => { throw new BridgeError('RECOVERY_INCOMPLETE', 'test-owned recovery failure'); });
  await assert.rejects(f.call(request('initialize', { limits: f.limits })), { code: 'RECOVERY_INCOMPLETE' });
  assert.equal(f.counts.release, 1); assert.equal((await f.call(request('status'))).state, 'not_enabled');
});
test('closure remains usable when the registered checkout was removed', async t => {
  const f = await runtimeFixture(t); await f.initialize(); const worker = await f.linked('removed'), registered = await f.call(f.register(), f.ordinary, worker);
  const work = await f.get('work', registered.receipt.item_id, f.ordinary); await git(f.root, ['worktree', 'remove', worker]);
  await f.call(command({ kind: 'close_work', operation_key: key(), work_id: work.id, expected_revision: work.revision }), f.ordinary, worker);
  assert.equal((await f.get('work', work.id, f.ordinary)).state, 'closed');
});

test('readonly metadata access does not recreate a missing repository namespace', async t => {
  const f = await runtimeFixture(t);
  assert.equal((await f.call(request('identity'))).parent_id, f.ordinary.owner_id);
  await assert.rejects(f.call(request('status')), { code: 'PATH_NOT_FOUND' });
  await assert.rejects(access(f.binding.storeRoot), { code: 'ENOENT' });
  assert.equal(f.counts.acquire, 0);
});
