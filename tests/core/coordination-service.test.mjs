import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rename, rm, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { serviceFixture, A, B, C, command, request, readRequest, caseCommand, key, hold, git, BridgeError } from '../fixtures/structural/service-fixture.mjs';

async function registered(f, fields = {}) {
  await f.initialize(); const reply = await f.call(f.registerRequest(fields));
  return f.get('work', reply.receipt.item_id);
}
async function selected(f) {
  await f.initialize(); const worker = await f.linked('worker'), head = await f.commit(worker, 'worker.ts', 'export function worker() {}');
  const r = await f.call(f.registerRequest({ readers: [B.owner_id] }), A, worker);
  const work = await f.get('work', r.receipt.item_id);
  const c = await f.call(command({ kind: 'claim_target', operation_key: key(), target: 'refs/heads/main', members: [B.owner_id] }));
  let item = await f.get('case', c.receipt.item_id);
  await f.call(caseCommand('select_inputs', item, { target_oid: f.base, inputs: [{ work_id: work.id, commit_oid: head }] }));
  item = await f.get('case', item.id); return { work, item, worker, head };
}
test('identity and status do not initialize state or invoke source/resource authorization', async t => {
  const f = await serviceFixture(t);
  assert.deepEqual(await f.call(request('identity'), B), { schema_version: 1, kind: 'identity', repository_id: f.repositoryId, parent_id: B.owner_id });
  assert.equal((await f.call(request('status'))).state, 'not_enabled');
  assert.deepEqual(await readdir(f.state), []); assert.deepEqual(f.stats(), { authorizations: 0, registrations: 0 });
});
test('explicit initialization is authorized, durable and idempotent without resetting its epoch', async t => {
  const f = await serviceFixture(t), first = await f.initialize(), second = await f.initialize();
  assert.equal(first.state, 'ready'); assert.equal(first.epoch, second.epoch); assert.equal(first.revision, 0);
  assert.deepEqual((await f.disk()).limits, f.limits);
  assert.equal((await lstat(join(f.state, 'coordination/control.json'))).mode & 0o777, 0o600);
  await assert.rejects(f.initialize(A, { ...f.limits, notes: f.limits.notes + 1 }), { code: 'COORDINATION_CONFIG_CONFLICT' });
  assert.equal((await f.disk()).epoch, first.epoch);
});
test('denied initialization neither creates authority nor grants another principal permission', async t => {
  const f = await serviceFixture(t);
  await assert.rejects(f.initialize(B), { code: 'COORDINATION_INITIALIZATION_FORBIDDEN' });
  assert.deepEqual(await readdir(f.state), []);
  await f.initialize(); await assert.rejects(f.initialize(B), { code: 'COORDINATION_INITIALIZATION_FORBIDDEN' });
});
test('initialization permission callback permits reentrant read-only status without deadlock', async t => {
  let f; f = await serviceFixture(t, { authorizeInitialization: async () => {
    assert.equal((await f.call(request('status'))).state, 'not_enabled');
  } });
  assert.equal((await f.initialize()).state, 'ready');
});
test('parallel initializations with differing limits publish one configuration and reject the other', async t => {
  const f = await serviceFixture(t), outcomes = await Promise.allSettled([f.initialize(), f.initialize(A, { ...f.limits, notes: 33 })]);
  assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(o => o.status === 'rejected').reason.code, 'COORDINATION_CONFIG_CONFLICT');
  assert.equal((await f.disk()).revision, 0);
});
test('a concurrent first status lookup cannot permanently poison explicit initialization', async t => {
  const f = await serviceFixture(t), [status, enabled] = await Promise.all([f.call(request('status')), f.initialize()]);
  assert.ok(['not_enabled', 'ready'].includes(status.state)); assert.equal(enabled.state, 'ready');
  assert.equal((await f.call(request('status'))).epoch, enabled.epoch);
});
test('authority lost while permission is pending prevents initialization', async t => {
  const entered = hold(), gate = hold(), f = await serviceFixture(t, { authorizeInitialization: async () => { entered.release(); await gate.promise; } });
  const pending = f.initialize(); await entered.promise; f.loseAuthority(); gate.release();
  await assert.rejects(pending, { code: 'LEASE_NOT_HELD' }); assert.deepEqual(await readdir(f.state), []);
});
test('aborting an initialization observer does not discard the service-owned initialization', async t => {
  const entered = hold(), gate = hold(), f = await serviceFixture(t, { authorizeInitialization: async () => { entered.release(); await gate.promise; } });
  const abort = new AbortController(), pending = f.call(request('initialize', { limits: f.limits }), A, f.root, abort.signal);
  await entered.promise; abort.abort(new BridgeError('TEST_OBSERVER_LEFT', 'Fixture observer left'));
  await assert.rejects(pending, { code: 'TEST_OBSERVER_LEFT' }); assert.equal(f.service.pendingCount, 1);
  gate.release(); await f.service.close(); assert.equal(f.service.pendingCount, 0);
  assert.ok((await f.disk()).epoch); await f.restart(); assert.equal((await f.call(request('status'))).state, 'ready');
});
test('service close waits for pending initialization and rejects new requests', async t => {
  const entered = hold(), gate = hold(), f = await serviceFixture(t, { authorizeInitialization: async () => { entered.release(); await gate.promise; } });
  const pending = f.initialize(); await entered.promise; let closed = false;
  const closing = f.service.close().then(() => { closed = true; });
  await assert.rejects(f.call(request('identity')), { code: 'COORDINATION_SERVICE_CLOSED' }); assert.equal(closed, false);
  gate.release(); await pending; await closing; assert.equal(closed, true);
});
test('a pre-cancelled request performs no initialization or source operation', async t => {
  const f = await serviceFixture(t), abort = new AbortController(); abort.abort(new BridgeError('TEST_ALREADY_ABORTED', 'No observation'));
  await assert.rejects(f.call(request('initialize', { limits: f.limits }), A, f.root, abort.signal), { code: 'TEST_ALREADY_ABORTED' });
  assert.deepEqual(await readdir(f.state), []); assert.equal(f.stats().authorizations, 0);
});
test('mutable caller objects cannot change admitted parent, scope, or initialization limits', async t => {
  const entered = hold(), gate = hold(), f = await serviceFixture(t, { authorizeInitialization: async () => { entered.release(); await gate.promise; } });
  const req = request('initialize', { limits: { ...f.limits } }), connection = f.connection(), pending = f.service.handle(connection, req);
  await entered.promise; req.limits.notes = 1; connection.owner_id = B.owner_id; gate.release();
  const reply = await pending; assert.equal(reply.limits.notes, f.limits.notes);
});
test('real repository commands register external work and return an attributed retained receipt', async t => {
  const f = await serviceFixture(t); await f.initialize(); const req = f.registerRequest({ readers: [B.owner_id] });
  const first = await f.call(req), second = await f.call(req); assert.deepEqual(second, first);
  const work = await f.get('work', first.receipt.item_id, B);
  assert.equal(work.owner, A.owner_id); assert.equal(work.input_oid, f.base); assert.match(work.workspace_id, /^git-worktree-v1:/);
  assert.deepEqual(await f.get('receipt', req.command.operation_key), first.receipt);
  assert.equal(await f.get('receipt', req.command.operation_key, B), null);
});
test('SHA-256 repository identities remain exact through the service representation', async t => {
  const f = await serviceFixture(t, { format: 'sha256' }), work = await registered(f);
  assert.equal(work.object_format, 'sha256'); assert.equal(work.input_oid.length, 64);
});
test('sharing does not confer command ownership and unauthorized reads remain indistinguishable from missing subjects', async t => {
  const f = await serviceFixture(t), work = await registered(f, { readers: [B.owner_id] });
  await assert.rejects(f.call(command({ kind: 'close_work', operation_key: key(), work_id: work.id, expected_revision: work.revision }), B), { code: 'COORDINATION_FORBIDDEN' });
  await assert.rejects(f.get('work', work.id, C), { code: 'COORDINATION_NOT_FOUND' });
  await assert.rejects(f.get('work', key(), C), { code: 'COORDINATION_NOT_FOUND' });
});
test('notes retain attributed text and exact acknowledged parties through page retrieval', async t => {
  const f = await serviceFixture(t), work = await registered(f, { readers: [B.owner_id] });
  const posted = await f.call(command({ kind: 'post_note', operation_key: key(), subject: { kind: 'work', id: work.id }, note_kind: 'agreement_proposal', text: 'Keep the written declaration stable', parties: [A.owner_id, B.owner_id] }));
  assert.equal((await f.get('note', posted.receipt.item_id, B)).agreement, 'pending');
  for (const actor of [A, B]) await f.call(command({ kind: 'ack_note', operation_key: key(), note_id: posted.receipt.item_id }), actor);
  const note = await f.get('note', posted.receipt.item_id, B); assert.equal(note.agreement, 'acknowledged'); assert.equal(note.author, A.owner_id);
});
test('UTF-8 view pages reconstruct exact Unicode and preserve cursor byte positions', async t => {
  const f = await serviceFixture(t), work = await registered(f), text = 'α😀漢字\\n'.repeat(45);
  const posted = await f.call(command({ kind: 'post_note', operation_key: key(), subject: { kind: 'work', id: work.id }, note_kind: 'statement', text, parties: [] }));
  const note = await f.get('note', posted.receipt.item_id, A, 127); assert.equal(note.text, text);
});
test('a changed selected view refuses mixed-page continuation', async t => {
  const f = await serviceFixture(t), work = await registered(f), selector = { kind: 'work', id: work.id };
  const first = await f.call(readRequest(selector, { limit: 64 }));
  await f.call(command({ kind: 'share_work', operation_key: key(), work_id: work.id, expected_revision: work.revision, readers: [B.owner_id] }));
  await assert.rejects(f.call(readRequest(selector, { offset: first.next_offset, expected_hash: first.hash })), { code: 'COORDINATION_VIEW_CHANGED' });
});
test('unrelated control changes do not invalidate a selected work view', async t => {
  const f = await serviceFixture(t), work = await registered(f), selector = { kind: 'work', id: work.id };
  const first = await f.call(readRequest(selector, { limit: 64 }));
  await f.call(command({ kind: 'post_note', operation_key: key(), subject: { kind: 'work', id: work.id }, note_kind: 'statement', text: 'Unrelated note', parties: [] }));
  const next = await f.call(readRequest(selector, { offset: first.next_offset, expected_hash: first.hash })); assert.equal(next.hash, first.hash);
});
test('every page rechecks sharing before exposing content or accepting a known view hash', async t => {
  const f = await serviceFixture(t), work = await registered(f, { readers: [B.owner_id] }), selector = { kind: 'work', id: work.id };
  const first = await f.call(readRequest(selector, { limit: 64 }), B);
  await f.call(command({ kind: 'share_work', operation_key: key(), work_id: work.id, expected_revision: work.revision, readers: [] }));
  await assert.rejects(f.call(readRequest(selector, { offset: first.next_offset, expected_hash: first.hash }), B), { code: 'COORDINATION_NOT_FOUND' });
});
test('view identities cannot be reused between otherwise authorized parents', async t => {
  const f = await serviceFixture(t), work = await registered(f, { readers: [B.owner_id] }), selector = { kind: 'work', id: work.id };
  const a = await f.call(readRequest(selector, { limit: 64 }));
  await assert.rejects(f.call(readRequest(selector, { offset: a.next_offset, expected_hash: a.hash }), B), { code: 'COORDINATION_VIEW_CHANGED' });
});
test('invalid byte boundaries and out-of-range offsets are rejected at the page owner', async t => {
  const f = await serviceFixture(t), work = await registered(f, { intent: '😀' }), selector = { kind: 'work', id: work.id };
  const all = await f.call(readRequest(selector)), bytes = Buffer.from(all.content), start = bytes.indexOf(Buffer.from('😀'));
  assert.ok(start >= 0);
  await assert.rejects(f.call(readRequest(selector, { offset: start + 1, expected_hash: all.hash })), { code: 'COORDINATION_RANGE_INVALID' });
  await assert.rejects(f.call(readRequest(selector, { offset: all.total_bytes + 1, expected_hash: all.hash })), { code: 'COORDINATION_RANGE_INVALID' });
  const eof = await f.call(readRequest(selector, { offset: all.total_bytes, expected_hash: all.hash })); assert.equal(eof.eof, true); assert.equal(eof.bytes, 0);
});
test('bounded reply pages can read a view larger than a single service message', async t => {
  const f = await serviceFixture(t), area = 'a'.repeat(4096), work = await registered(f, { intent: 'x'.repeat(3000), areas: Array.from({ length: 5 }, (_, i) => ({ kind: 'file', path: `${i}${area.slice(1)}` })) });
  const readers = Array.from({ length: 32 }, (_, i) => (i + 1).toString(16).padStart(64, '0'));
  await f.call(command({ kind: 'share_work', operation_key: key(), work_id: work.id, expected_revision: work.revision, readers }));
  const first = await f.call(readRequest({ kind: 'work', id: work.id }, { limit: 1024 }));
  assert.ok(first.total_bytes > 24_576); assert.ok(Buffer.byteLength(JSON.stringify(first)) < 24_576);
  const got = await f.get('work', work.id, A, 1024); assert.deepEqual(got.areas, work.areas); assert.deepEqual(got.readers, readers);
});
test('invalid commands do not publish control state even when the envelope is well formed', async t => {
  const f = await serviceFixture(t); await f.initialize(); const before = await f.disk();
  const req = f.registerRequest(); req.command.owner_id = B.owner_id;
  await assert.rejects(f.call(req), { code: 'COORDINATION_INVALID' }); assert.deepEqual(await f.disk(), before);
});
test('a failed initial source binding does not poison a later valid registration', async t => {
  const f = await serviceFixture(t); await f.initialize();
  await assert.rejects(f.call(f.registerRequest(), A, f.state));
  assert.equal((await f.call(f.registerRequest())).kind, 'receipt');
});
test('an unavailable source does not prevent metadata reads, release or receipt recovery on cold reopen', async t => {
  const f = await serviceFixture(t), work = await registered(f), claimed = await f.call(command({ kind: 'claim_target', operation_key: key(), target: 'refs/heads/main', members: [] }));
  const item = await f.get('case', claimed.receipt.item_id); await f.service.close();
  await rename(f.root, join(f.temp, 'removed-source')); await f.restart();
  assert.equal((await f.get('work', work.id)).id, work.id);
  await f.call(caseCommand('release_case', item)); assert.equal((await f.get('case', item.id)).state, 'closed');
  assert.deepEqual(await f.get('receipt', claimed.receipt.key), claimed.receipt);
});
test('read-only lookup distinguishes corrupt or incomplete state from never-enabled state', async t => {
  const f = await serviceFixture(t); await f.initialize();
  await writeFile(join(f.state, 'coordination/control.json'), '{bad');
  await assert.rejects(f.call(request('status')), { code: 'COORDINATION_RECORD_CORRUPT' });
  await assert.rejects(f.initialize(), { code: 'COORDINATION_RECORD_CORRUPT' });
  assert.equal(await readFile(join(f.state, 'coordination/control.json'), 'utf8'), '{bad');
});
test('an initialized directory disappearing cannot be silently recreated by this live session', async t => {
  const f = await serviceFixture(t); await f.initialize(); await rename(join(f.state, 'coordination'), join(f.state, 'preserved'));
  await assert.rejects(f.call(request('status')), { code: 'COORDINATION_STORE_INCOMPLETE' });
  await assert.rejects(f.initialize(), { code: 'COORDINATION_STORE_INCOMPLETE' });
  assert.deepEqual(await readdir(f.state), ['preserved']);
});
test('ordinary request saturation preserves explicit closure and receipt lookup capacity', async t => {
  const entered = hold(), gate = hold(); let blocking = false;
  const f = await serviceFixture(t, { serviceLimits: { ordinary_requests: 1 }, externalRegistration: async () => { if (blocking) { entered.release(); await gate.promise; } } });
  const work = await registered(f), other = await f.linked('other'); blocking = true;
  const pending = f.call(f.registerRequest(), B, other); await entered.promise;
  try {
    await assert.rejects(f.call(request('status')), { code: 'COORDINATION_SERVICE_CAPACITY' });
    const closed = await f.call(command({ kind: 'close_work', operation_key: key(), work_id: work.id, expected_revision: work.revision }));
    assert.deepEqual(await f.get('receipt', closed.receipt.key), closed.receipt);
  } finally { gate.release(); await pending; }
});
test('drain blocks new work while preserving existing release and read operations', async t => {
  const f = await serviceFixture(t), work = await registered(f); f.service.beginDrain();
  await assert.rejects(f.call(f.registerRequest()), { code: 'COORDINATION_SERVICE_DRAINING' });
  await assert.rejects(f.initialize(), { code: 'COORDINATION_SERVICE_DRAINING' });
  await f.call(command({ kind: 'close_work', operation_key: key(), work_id: work.id, expected_revision: work.revision }));
  assert.equal((await f.get('work', work.id)).state, 'closed');
});
test('a detached command continues through publication and survives service close/reopen', async t => {
  const entered = hold(), gate = hold(), f = await serviceFixture(t, { externalRegistration: async () => { entered.release(); await gate.promise; } });
  await f.initialize(); const req = f.registerRequest(), abort = new AbortController();
  const pending = f.call(req, A, f.root, abort.signal); await entered.promise; abort.abort(new BridgeError('OBSERVER_LEFT', 'Fixture left'));
  await assert.rejects(pending, { code: 'OBSERVER_LEFT' }); assert.equal(f.service.pendingCount, 1);
  let finished = false; const closing = f.service.close().then(() => { finished = true; }); assert.equal(finished, false);
  gate.release(); await closing; await f.restart();
  assert.equal((await f.get('receipt', req.command.operation_key)).action, 'register_work');
  assert.equal((await f.disk()).works.length, 1);
});
test('two parents select, hand off, and settle exact inputs without changing Git refs', async t => {
  const f = await serviceFixture(t), { item, head } = await selected(f), refs = await git(f.root, ['for-each-ref']);
  await f.call(caseCommand('begin_external_integration', item)); let current = await f.get('case', item.id);
  assert.equal(current.external_effect, 'possible'); assert.equal(current.inputs[0].commit_oid, head);
  await f.call(caseCommand('record_external_settlement', current)); current = await f.get('case', item.id);
  await f.call(caseCommand('transfer_case', current, { new_lead: B.owner_id })); current = await f.get('case', item.id, B);
  assert.equal(current.lead, B.owner_id); await f.call(caseCommand('release_case', current), B);
  assert.equal(await git(f.root, ['for-each-ref']), refs);
});
test('reopening in a fresh process reads retained command evidence without needing a checkout', async t => {
  const f = await serviceFixture(t), work = await registered(f); await f.service.close();
  await rename(f.root, join(f.temp, 'source-moved'));
  const input = join(f.temp, 'child-request.json');
  await writeFile(input, JSON.stringify({ state: f.state, repository: f.repositoryId, source: f.root, owner: A.owner_id, work: work.id }));
  const child = fileURLToPath(new URL('../fixtures/structural/service-reopen.mjs', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [child, input]); const reply = JSON.parse(stdout);
  assert.equal(reply.id, work.id); assert.equal(reply.input_oid, f.base);
});
