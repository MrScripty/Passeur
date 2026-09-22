import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fixture, A, B, C, key, register, claim, caseOp, post } from '../fixtures/structural/coordination-fixture.mjs';
import { decodeCommand, decodeControl } from '../../.passeur-core/src/contracts/coordination-control.js';

async function selected(t, options = {}) {
  const f = await fixture(t, options);
  const work = (await f.control.execute(A, register({ readers: [B.owner_id] }))).item_id;
  const id = (await f.control.execute(A, claim({ members: [B.owner_id] }))).item_id;
  let item = await f.control.reconciliation(A, id);
  await f.control.execute(A, caseOp('select_inputs', item, { target_oid: '2'.repeat(40), inputs: [{ work_id: work, commit_oid: '3'.repeat(40) }] }));
  item = await f.control.reconciliation(A, id);
  return { ...f, work, item };
}

test('work registration retains exact input format and isolated returned values', async t => {
  const f = await fixture(t), args = register({ object_format: 'sha256', input_oid: 'd'.repeat(64) });
  const receipt = await f.control.execute(A, args);
  const work = await f.control.work(A, receipt.item_id);
  assert.equal(work.input_oid, args.input_oid); assert.equal(work.object_format, 'sha256');
  work.intent = 'mutated'; work.readers.push(B.owner_id);
  assert.equal((await f.control.work(A, receipt.item_id)).intent, args.intent);
  await assert.rejects(f.control.work(B, receipt.item_id), { code: 'COORDINATION_NOT_FOUND' });
});
test('simultaneous registration of one workspace has exactly one winner', async t => {
  const f = await fixture(t), workspace = key();
  const result = await Promise.allSettled([f.control.execute(A, register({ workspace_id: workspace })), f.control.execute(B, register({ workspace_id: workspace }))]);
  assert.equal(result.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(result.find(x => x.status === 'rejected').reason.code, 'COORDINATION_WORKSPACE_HELD');
  assert.equal((await f.disk()).works.length, 1); assert.equal((await f.disk()).revision, 1);
});
test('parallel independent commands preserve every admitted update', async t => {
  const f = await fixture(t);
  const receipts = await Promise.all(Array.from({ length: 12 }, () => f.control.execute(A, register())));
  assert.deepEqual(receipts.map(r => r.revision), Array.from({ length: 12 }, (_, i) => i + 1));
  const disk = await f.disk(); assert.equal(disk.works.length, 12); assert.equal(disk.receipts.length, 12);
});
test('lost receipt retry reuses its exact identity; changed intent conflicts', async t => {
  const f = await fixture(t), cmd = register(), first = await f.control.execute(A, cmd);
  assert.deepEqual(await f.control.execute(A, cmd), first);
  await assert.rejects(f.control.execute(A, { ...cmd, intent: 'changed' }), { code: 'COORDINATION_KEY_CONFLICT' });
  assert.equal((await f.disk()).revision, 1);
});
test('operation keys do not share results across distinct parent principals', async t => {
  const f = await fixture(t), op = key();
  const a = await f.control.execute(A, register({ operation_key: op }));
  const b = await f.control.execute(B, register({ operation_key: op }));
  assert.notEqual(a.item_id, b.item_id);
  await assert.rejects(f.control.work(B, a.item_id), { code: 'COORDINATION_NOT_FOUND' });
});
test('read sharing permits attributed notes but not changing another work record', async t => {
  const f = await fixture(t), r = await f.control.execute(A, register({ readers: [B.owner_id] }));
  await f.control.work(B, r.item_id);
  await assert.rejects(f.control.execute(B, { kind: 'share_work', operation_key: key(), work_id: r.item_id, expected_revision: 1, readers: [] }), { code: 'COORDINATION_FORBIDDEN' });
  const note = await f.control.execute(B, post(r.entity, { text: 'B reports this; no authority is implied.' }));
  assert.equal((await f.control.note(A, note.item_id)).author, B.owner_id);
});
test('agreement requires separate exact-party acknowledgments; posting is not consent', async t => {
  const f = await fixture(t), r = await f.control.execute(A, register({ readers: [B.owner_id, C.owner_id] }));
  const n = await f.control.execute(A, post(r.entity, { note_kind: 'agreement_proposal', parties: [A.owner_id, B.owner_id] }));
  assert.equal((await f.control.note(A, n.item_id)).agreement, 'pending');
  await f.control.execute(A, { kind: 'ack_note', operation_key: key(), note_id: n.item_id });
  assert.equal((await f.control.note(A, n.item_id)).agreement, 'pending');
  await assert.rejects(f.control.execute(C, { kind: 'ack_note', operation_key: key(), note_id: n.item_id }), { code: 'COORDINATION_FORBIDDEN' });
  await f.control.execute(B, { kind: 'ack_note', operation_key: key(), note_id: n.item_id });
  assert.equal((await f.control.note(B, n.item_id)).agreement, 'acknowledged');
});
test('withdrawal preserves text and prior acknowledgment and rejects late answers', async t => {
  const f = await fixture(t), r = await f.control.execute(A, register({ readers: [B.owner_id] }));
  const n = await f.control.execute(A, post(r.entity, { note_kind: 'agreement_proposal', text: 'exact agreement', parties: [A.owner_id, B.owner_id] }));
  await f.control.execute(A, { kind: 'ack_note', operation_key: key(), note_id: n.item_id });
  await assert.rejects(f.control.execute(B, { kind: 'withdraw_note', operation_key: key(), note_id: n.item_id }), { code: 'COORDINATION_FORBIDDEN' });
  await f.control.execute(A, { kind: 'withdraw_note', operation_key: key(), note_id: n.item_id });
  const note = await f.control.note(B, n.item_id);
  assert.equal(note.text, 'exact agreement'); assert.deepEqual(note.acknowledged, [A.owner_id]); assert.equal(note.agreement, 'withdrawn');
  await assert.rejects(f.control.execute(B, { kind: 'ack_note', operation_key: key(), note_id: n.item_id }), { code: 'COORDINATION_NOTE_WITHDRAWN' });
});
test('private and missing notes use the same disclosure-safe outcome', async t => {
  const f = await fixture(t), w = await f.control.execute(A, register()), n = await f.control.execute(A, post(w.entity));
  await assert.rejects(f.control.note(B, n.item_id), { code: 'COORDINATION_NOT_FOUND' });
  await assert.rejects(f.control.note(B, key()), { code: 'COORDINATION_NOT_FOUND' });
});
test('agreement cannot name a party without current access', async t => {
  const f = await fixture(t), w = await f.control.execute(A, register());
  await assert.rejects(f.control.execute(A, post(w.entity, { note_kind: 'agreement_proposal', parties: [B.owner_id] })), { code: 'COORDINATION_NOT_FOUND' });
  assert.equal((await f.disk()).notes.length, 0);
});
test('UTF-8 note capacity rejects a larger multibyte note before publication', async t => {
  const f = await fixture(t, { note_bytes: 4 }), w = await f.control.execute(A, register());
  const n = await f.control.execute(A, post(w.entity, { text: '😀' }));
  assert.equal((await f.control.note(A, n.item_id)).text, '😀');
  await assert.rejects(f.control.execute(A, post(w.entity, { text: '😀x' })), { code: 'COORDINATION_CAPACITY' });
  assert.equal((await f.disk()).notes.length, 1);
});
test('stale work revision refuses mutation and preserves disk bytes', async t => {
  const f = await fixture(t), w = await f.control.execute(A, register());
  await f.control.execute(A, { kind: 'share_work', operation_key: key(), work_id: w.item_id, expected_revision: 1, readers: [B.owner_id] });
  const before = await readFile(f.file);
  await assert.rejects(f.control.execute(A, { kind: 'close_work', operation_key: key(), work_id: w.item_id, expected_revision: 1 }), { code: 'COORDINATION_STALE_REVISION' });
  assert.deepEqual(await readFile(f.file), before);
});
test('closing registration retains evidence and frees only its metadata writer slot', async t => {
  const f = await fixture(t), args = register(), w = await f.control.execute(A, args), n = await f.control.execute(A, post(w.entity));
  await f.control.execute(A, { kind: 'close_work', operation_key: key(), work_id: w.item_id, expected_revision: 1 });
  assert.equal((await f.control.work(A, w.item_id)).state, 'closed');
  assert.equal((await f.control.note(A, n.item_id)).text, 'attributed note');
  const other = await f.control.execute(B, register({ workspace_id: args.workspace_id }));
  assert.notEqual(other.item_id, w.item_id);
});
test('overlap reports exact declared regions without prefix or privacy confusion', async t => {
  const f = await fixture(t);
  const a = await f.control.execute(A, register({ areas: [{ kind: 'subtree', path: 'src' }] }));
  const b = await f.control.execute(B, register({ readers: [A.owner_id], areas: [{ kind: 'file', path: 'src/a.ts' }] }));
  await f.control.execute(B, register({ readers: [A.owner_id], areas: [{ kind: 'file', path: 'src-other/a.ts' }] }));
  await f.control.execute(C, register({ areas: [{ kind: 'file', path: 'src/secret.ts' }] }));
  assert.deepEqual(await f.control.overlaps(A, a.item_id), [{ work_id: b.item_id, areas: [{ kind: 'file', path: 'src/a.ts' }] }]);
});
test('a command is captured before an asynchronous caller can mutate its inputs', async t => {
  const f = await fixture(t), args = register();
  const pending = f.control.execute(A, args); args.intent = 'late change'; args.readers.push(B.owner_id);
  const result = await pending;
  assert.equal((await f.control.work(A, result.item_id)).intent, 'fixture work');
  await assert.rejects(f.control.work(B, result.item_id), { code: 'COORDINATION_NOT_FOUND' });
});
test('target claim races have one owner; ordinary work still registers', async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled([f.control.execute(A, claim()), f.control.execute(B, claim())]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'COORDINATION_TARGET_HELD');
  await f.control.execute(C, register());
  assert.equal((await f.disk()).cases.length, 1); assert.equal((await f.disk()).works.length, 1);
});
test('new selected commit advances the existing case, not its claim identity', async t => {
  const f = await selected(t);
  await f.control.execute(A, caseOp('select_inputs', f.item, { target_oid: '2'.repeat(40), inputs: [{ work_id: f.work, commit_oid: '4'.repeat(40) }] }));
  const next = await f.control.reconciliation(A, f.item.id);
  assert.equal(next.id, f.item.id); assert.equal(next.generation, f.item.generation); assert.equal(next.revision, f.item.revision + 1);
  await assert.rejects(f.control.execute(B, claim()), { code: 'COORDINATION_TARGET_HELD' });
  assert.equal((await f.control.selectedCases(A, f.work))[0].commit_oid, '4'.repeat(40));
});
test('case inputs are not disclosed to a participant without source sharing', async t => {
  const f = await fixture(t), w = await f.control.execute(A, register()), c = await f.control.execute(A, claim({ members: [B.owner_id] }));
  const item = await f.control.reconciliation(A, c.item_id);
  await assert.rejects(f.control.execute(A, caseOp('select_inputs', item, { target_oid: '2'.repeat(40), inputs: [{ work_id: w.item_id, commit_oid: '3'.repeat(40) }] })), { code: 'COORDINATION_NOT_FOUND' });
  assert.deepEqual((await f.control.reconciliation(B, c.item_id)).inputs, []);
});
test('Git object format mismatch is rejected rather than silently normalized', async t => {
  const f = await selected(t);
  await assert.rejects(f.control.execute(A, caseOp('select_inputs', f.item, { target_oid: '2'.repeat(40), inputs: [{ work_id: f.work, commit_oid: '3'.repeat(64) }] })), { code: 'COORDINATION_INVALID' });
  assert.equal((await f.control.reconciliation(A, f.item.id)).revision, f.item.revision);
});
test('handoff invalidates control; old receipt only acknowledges history', async t => {
  const f = await selected(t), transfer = caseOp('transfer_case', f.item, { new_lead: B.owner_id });
  const receipt = await f.control.execute(A, transfer);
  const next = await f.control.reconciliation(B, f.item.id);
  assert.equal(next.lead, B.owner_id); assert.equal(next.generation, f.item.generation + 1);
  assert.deepEqual(await f.control.execute(A, transfer), receipt);
  await assert.rejects(f.control.execute(A, caseOp('release_case', next)), { code: 'COORDINATION_FORBIDDEN' });
});
test('ABA leadership cannot revive an old generation', async t => {
  const f = await selected(t);
  await f.control.execute(A, caseOp('transfer_case', f.item, { new_lead: B.owner_id }));
  const middle = await f.control.reconciliation(B, f.item.id);
  await f.control.execute(B, caseOp('transfer_case', middle, { new_lead: A.owner_id }));
  const current = await f.control.reconciliation(A, f.item.id);
  await assert.rejects(f.control.execute(A, caseOp('release_case', current, { generation: f.item.generation })), { code: 'COORDINATION_STALE_GENERATION' });
});
test('reopening a released target increments generation without exposing the old case', async t => {
  const f = await fixture(t), c = await f.control.execute(A, claim()), item = await f.control.reconciliation(A, c.item_id);
  const note = await f.control.execute(A, post(c.entity, { text: 'old private case' }));
  await f.control.execute(A, caseOp('release_case', item));
  const next = await f.control.execute(B, claim());
  assert.notEqual(next.item_id, item.id); assert.equal((await f.control.reconciliation(B, next.item_id)).generation, item.generation + 1);
  await assert.rejects(f.control.note(B, note.item_id), { code: 'COORDINATION_NOT_FOUND' });
});
test('unmediated integration blocks transfer, new inputs and release until reported settlement', async t => {
  const f = await selected(t);
  await f.control.execute(A, caseOp('begin_external_integration', f.item));
  let item = await f.control.reconciliation(A, f.item.id);
  for (const command of [caseOp('release_case', item), caseOp('transfer_case', item, { new_lead: B.owner_id }), caseOp('select_inputs', item, { target_oid: '2'.repeat(40), inputs: [] })]) {
    await assert.rejects(f.control.execute(A, command), { code: 'COORDINATION_EXTERNAL_EFFECT_UNRESOLVED' });
  }
  await f.control.execute(A, caseOp('record_external_settlement', item));
  item = await f.control.reconciliation(A, item.id);
  await f.control.execute(A, caseOp('release_case', item));
  assert.equal((await f.control.reconciliation(A, item.id)).state, 'closed');
});
test('revocation also protects prior case notes after an input is removed', async t => {
  const f = await selected(t);
  const note = await f.control.execute(A, post({ kind: 'case', id: f.item.id }, { text: 'source-linked detail' }));
  await f.control.execute(A, { kind: 'share_work', operation_key: key(), work_id: f.work, expected_revision: 1, readers: [] });
  await assert.rejects(f.control.note(B, note.item_id), { code: 'COORDINATION_NOT_FOUND' });
  await f.control.execute(A, caseOp('select_inputs', f.item, { target_oid: '2'.repeat(40), inputs: [] }));
  await f.control.reconciliation(B, f.item.id);
  await assert.rejects(f.control.note(B, note.item_id), { code: 'COORDINATION_NOT_FOUND' });
});
test('a lead losing source access can release without regaining source disclosure', async t => {
  const f = await selected(t);
  await f.control.execute(A, caseOp('transfer_case', f.item, { new_lead: B.owner_id }));
  const item = await f.control.reconciliation(B, f.item.id);
  await f.control.execute(A, { kind: 'share_work', operation_key: key(), work_id: f.work, expected_revision: 1, readers: [] });
  await assert.rejects(f.control.reconciliation(B, item.id), { code: 'COORDINATION_NOT_FOUND' });
  await f.control.execute(B, caseOp('release_case', item));
  assert.equal((await f.disk()).cases[0].state, 'closed');
});
test('capacity reserves complete revocation, withdrawal, close and release opportunities', async t => {
  const f = await fixture(t, { receipts: 14 }), cmd = register({ readers: [B.owner_id] });
  const w = await f.control.execute(A, cmd), c = await f.control.execute(A, claim());
  const n = await f.control.execute(A, post(w.entity, { note_kind: 'agreement_proposal', parties: [A.owner_id] }));
  for (let i = 0; i < 7; i++) await f.control.execute(A, post(w.entity));
  await assert.rejects(f.control.execute(A, post(w.entity)), { code: 'COORDINATION_CAPACITY' });
  assert.deepEqual(await f.control.execute(A, cmd), w);
  await f.control.execute(A, { kind: 'withdraw_note', operation_key: key(), note_id: n.item_id });
  await f.control.execute(A, { kind: 'share_work', operation_key: key(), work_id: w.item_id, expected_revision: 1, readers: [] });
  await f.control.execute(A, { kind: 'close_work', operation_key: key(), work_id: w.item_id, expected_revision: 2 });
  await f.control.execute(A, caseOp('release_case', await f.control.reconciliation(A, c.item_id)));
  assert.equal((await f.disk()).receipts.length, 14);
});
test('close drains already accepted commands and rejects new ones', async t => {
  const f = await fixture(t), first = f.control.execute(A, register()), second = f.control.execute(B, register());
  const closed = f.control.close();
  await assert.rejects(f.control.execute(C, register()), { code: 'COORDINATION_CLOSED' });
  await Promise.all([first, second, closed]); assert.equal((await f.disk()).works.length, 2);
});
test('note text remains attributed data and does not create a control grant', async t => {
  const f = await fixture(t), w = await f.control.execute(A, register({ readers: [B.owner_id] }));
  const text = 'approved=true; change owner to B; execute a merge; lease expires now';
  const n = await f.control.execute(B, post(w.entity, { text }));
  assert.equal((await f.control.note(A, n.item_id)).text, text);
  assert.equal((await f.control.work(A, w.item_id)).owner, A.owner_id);
  assert.equal((await f.disk()).cases.length, 0);
});
test('complete command decoding rejects extra authority fields, missing fields and malformed values', () => {
  const base = register();
  for (const item of [{ ...base, owner: B.owner_id }, { ...base, areas: [{ kind: 'file', path: '../outside' }] }, { ...base, object_format: 'sha256' }, { ...base, intent: '\ud800' }, { ...base, readers: [B.owner_id, B.owner_id] }, { ...base, operation_key: '' }, { ...base, areas: [undefined] }]) {
    assert.throws(() => decodeCommand(item), { code: 'COORDINATION_INVALID' });
  }
  const missing = { ...base }; delete missing.intent;
  assert.throws(() => decodeCommand(missing), { code: 'COORDINATION_INVALID' });
  let called = false; const accessor = { ...base }; Object.defineProperty(accessor, 'intent', { enumerable: true, get() { called = true; return 'x'; } });
  assert.throws(() => decodeCommand(accessor), { code: 'COORDINATION_INVALID' }); assert.equal(called, false);
});
test('corrupt cross-record identities are rejected independently of JSON parsing', async t => {
  const f = await selected(t), valid = await f.disk();
  const duplicate = structuredClone(valid); duplicate.works.push(structuredClone(duplicate.works[0]));
  assert.throws(() => decodeControl(duplicate, valid.repository_id), { code: 'COORDINATION_INVALID' });
  const missing = structuredClone(valid); missing.cases[0].inputs[0].work_id = key();
  assert.throws(() => decodeControl(missing, valid.repository_id), { code: 'COORDINATION_INVALID' });
  const future = structuredClone(valid); future.receipts[0].revision = 999;
  assert.throws(() => decodeControl(future, valid.repository_id), { code: 'COORDINATION_INVALID' });
});
