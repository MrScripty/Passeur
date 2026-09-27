import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, A, B, C, key, claim, caseOp, post } from '../fixtures/structural/coordination-fixture.mjs';
import { decodeCommand, decodeControl } from '../../.passeur-core/src/contracts/coordination-control.js';
import { CoordinationControl } from '../../.passeur-core/src/coordination/control.js';
import { CoordinationStore } from '../../.passeur-core/src/store/coordination-store.js';
import { encodePeerResolutionRecord } from '../../.passeur-core/src/coordination/peer-resolution.js';
import { canonicalHash } from '../../.passeur-core/src/core/async.js';

const base = '1'.repeat(40), target = '2'.repeat(40);
const managed = (task, owner) => ({ kind: 'register_task_work', operation_key: key(), workspace_id: key(),
  input_oid: base, object_format: 'sha1', intent: `worker ${owner.owner_id[0]}`,
  areas: [{ kind: 'file', path: 'src/shared.ts' }],
  managed: { task_id: task, control_generation: 1, intent_truncated: false, areas_source: 'allowed_paths' } });
const extension = (item, workId, operationKey = key()) => ({ operation_key: operationKey, case_id: item.id,
  expected_revision: item.revision, generation: item.generation, new_work_id: workId, target_oid: target });

async function observedPair(t, principals = [A, B, C]) {
  const f = await fixture(t);
  const ids = await Promise.all(principals.map(async actor => {
    const id = key();
    await f.control.execute(actor, managed(id, actor));
    return id;
  }));
  if (principals[0].owner_id !== principals[1].owner_id) {
    for (const index of [0, 1]) await f.control.execute(principals[index], {
      kind: 'share_work', operation_key: key(), work_id: ids[index], expected_revision: 1,
      readers: [principals[1 - index].owner_id] });
  }
  const receipt = await f.control.execute(principals[0], claim({ members: [principals[1].owner_id] }), undefined, true);
  let item = await f.control.reconciliation(principals[0], receipt.item_id);
  await f.control.execute(principals[0], caseOp('select_inputs', item, { target_oid: target,
    inputs: ids.slice(0, 2).map(work_id => ({ work_id, commit_oid: base })) }), undefined, true);
  item = await f.control.reconciliation(principals[0], receipt.item_id);
  return { ...f, ids, item, principals };
}

test('observed third worker joins atomically, keeps old note audience and grants, and retries one receipt', async t => {
  const f = await observedPair(t);
  const oldNote = await f.control.execute(A, post({ kind: 'case', id: f.item.id }, { text: 'before third worker' }));
  const before = await f.disk();
  const command = extension(f.item, f.ids[2]);
  const [first, duplicate] = await Promise.all([f.control.extendObservedCase(A, command), f.control.extendObservedCase(A, command)]);
  assert.deepEqual(duplicate, first);
  const after = await f.disk();
  assert.equal(after.revision, before.revision + 1);
  const joined = await f.control.reconciliation(A, f.item.id);
  assert.equal(joined.revision, f.item.revision + 1);
  assert.equal(joined.generation, f.item.generation);
  assert.equal(joined.lead, f.item.lead);
  assert.deepEqual(joined.inputs.map(input => input.work_id), f.ids);
  assert.deepEqual(joined.delivery_pending, f.ids);
  assert.equal(joined.observed_origin, 'selected');
  assert.deepEqual(after.works, before.works, 'case visibility leaves work readers and grants unchanged');
  await f.control.work(C, f.ids[0]);
  await f.control.reconciliation(C, f.item.id);
  await assert.rejects(f.control.note(C, oldNote.item_id), { code: 'COORDINATION_NOT_FOUND' });
  assert.equal((await f.control.note(B, oldNote.item_id)).text, 'before third worker');
  assert.equal(decodeControl(after, 'coordination-fixture').schema_version, 7);
  assert.throws(() => decodeCommand({ kind: 'extend_observed_case', ...command }), { code: 'COORDINATION_OPERATION_UNSUPPORTED' });
});

test('manual and unknown-origin cases refuse internal third-worker extension', async t => {
  const f = await observedPair(t);
  const manual = await fixture(t);
  const id = key();
  await manual.control.execute(A, managed(id, A));
  const claimed = await manual.control.execute(A, claim());
  const item = await manual.control.reconciliation(A, claimed.item_id);
  await assert.rejects(manual.control.extendObservedCase(A, extension(item, id)),
    { code: 'COORDINATION_OBSERVED_ORIGIN_UNAVAILABLE' });
  assert.equal((await manual.disk()).cases[0].observed_origin, undefined);
  assert.equal(f.item.observed_origin, 'selected');
});

test('case-scoped visibility expires on work revision while historical note text stays private', async t => {
  const f = await observedPair(t);
  const note = await f.control.execute(A, post({ kind: 'case', id: f.item.id }, { text: 'old consent context' }));
  await f.control.extendObservedCase(A, extension(f.item, f.ids[2]));
  const work = await f.control.work(A, f.ids[0]);
  await f.control.execute(A, { kind: 'share_work', operation_key: key(), work_id: work.id,
    expected_revision: work.revision, readers: [B.owner_id] });
  await assert.rejects(f.control.work(C, f.ids[0]), { code: 'COORDINATION_NOT_FOUND' });
  await assert.rejects(f.control.reconciliation(C, f.item.id), { code: 'COORDINATION_NOT_FOUND' });
  await assert.rejects(f.control.note(C, note.item_id), { code: 'COORDINATION_NOT_FOUND' });
});

test('case-scoped work visibility never reveals an earlier work note', async t => {
  const f = await observedPair(t);
  const old = await f.control.execute(A, post({ kind: 'work', id: f.ids[0] }, { text: 'private work history' }));
  await f.control.extendObservedCase(A, extension(f.item, f.ids[2]));
  await f.control.work(C, f.ids[0]);
  await assert.rejects(f.control.note(C, old.item_id), { code: 'COORDINATION_NOT_FOUND' });
  assert.equal((await f.control.note(B, old.item_id)).text, 'private work history');
});

test('partial adapter observation clears only one recipient without changing case revision', async t => {
  const f = await observedPair(t);
  await f.control.extendObservedCase(A, extension(f.item, f.ids[2]));
  const joined = await f.control.reconciliation(A, f.item.id);
  const command = { operation_key: key(), case_id: joined.id, case_revision: joined.revision,
    generation: joined.generation, recipient_work_id: f.ids[0], observation_digest: 'd'.repeat(64) };
  const snapshot = await f.store.snapshot(), guard = { epoch: snapshot.epoch, revision: snapshot.revision };
  const receipt = await f.control.observeCaseDelivery(A, command, guard);
  assert.deepEqual(await f.control.observeCaseDelivery(A, command, guard), receipt);
  const current = await f.control.reconciliation(A, joined.id);
  assert.equal(current.revision, joined.revision, 'adapter receipt does not stale other queued envelopes');
  assert.deepEqual(current.delivery_pending, f.ids.slice(1));
  assert.deepEqual(current.delivery_observed, [{ work_id: f.ids[0], observation_digest: 'd'.repeat(64) }]);
  await assert.rejects(f.control.observeCaseDelivery(A, { ...command, operation_key: key(), recipient_work_id: f.ids[0] }, guard),
    { code: 'PEER_DELIVERY_STALE' });
  const disk = await f.disk();
  assert.equal(decodeControl(disk, 'coordination-fixture').cases[0].delivery_pending.length, 2);
});

test('metadata publication between evidence check and settlement leaves delivery pending', async t => {
  const f = await observedPair(t);
  await f.control.extendObservedCase(A, extension(f.item, f.ids[2]));
  const item = await f.control.reconciliation(A, f.item.id);
  const snapshot = await f.store.snapshot(), guard = { epoch: snapshot.epoch, revision: snapshot.revision };
  const work = await f.control.work(A, f.ids[0]);
  await f.control.execute(A, { kind: 'share_work', operation_key: key(), work_id: work.id,
    expected_revision: work.revision, readers: [B.owner_id] });
  await assert.rejects(f.control.observeCaseDelivery(A, { operation_key: key(), case_id: item.id,
    case_revision: item.revision, generation: item.generation, recipient_work_id: f.ids[1],
    observation_digest: 'e'.repeat(64) }, guard), { code: 'PEER_DELIVERY_STALE' });
  assert.deepEqual((await f.control.reconciliation(A, item.id)).delivery_pending, f.ids);
});

for (const [name, principals] of [['same-parent', [A, A, A]], ['mixed-parent', [A, A, C]]]) {
  test(`${name} managed tasks retain distinct selections and exact case visibility`, async t => {
    const f = await observedPair(t, principals);
    const receipt = await f.control.extendObservedCase(A, extension(f.item, f.ids[2]));
    const joined = await f.control.reconciliation(A, f.item.id);
    assert.equal(joined.inputs.length, 3);
    assert.deepEqual(new Set(joined.inputs.map(input => input.work_id)).size, 3);
    assert.deepEqual(joined.members, [...new Set(principals.map(actor => actor.owner_id))]);
    assert.deepEqual(joined.visibility_delta.map(delta => delta.added_readers),
      principals[2].owner_id === A.owner_id ? [[], [], []] : [[C.owner_id], [C.owner_id], [A.owner_id]]);
    const reopenedStore = await CoordinationStore.open(f.root, 'coordination-fixture', () => {});
    const reopened = new CoordinationControl(reopenedStore);
    try { assert.deepEqual(await reopened.extendObservedCase(A, extension(f.item, f.ids[2], receipt.key)), receipt); }
    finally { await reopened.close(); }
  });
}

for (const status of ['pending', 'effect_unknown', 'applied']) {
  test(`retained ${status} application effect blocks third-worker joining`, async t => {
    const f = await observedPair(t);
    const current = await f.store.snapshot(), next = structuredClone(current), noteId = key();
    const record = { schema_version: 1, kind: 'peer_resolution_application', case_id: f.item.id,
      case_revision: f.item.revision, case_generation: f.item.generation,
      evidence_id: 'a'.repeat(64), evidence_revision: 1,
      sources: f.ids.slice(0, 2).map(work_id => ({ work_id, work_revision: 2,
        input_oid: base, selected_commit_oid: base })), scope: [{ kind: 'file', path: 'src/shared.ts' }],
      proposal_digest: 'b'.repeat(64), application_digest: 'c'.repeat(64), status };
    next.notes.push({ id: noteId, subject: { kind: 'case', id: f.item.id }, author: A.owner_id,
      kind: 'resolution_update', text: encodePeerResolutionRecord(record), work_refs: f.ids.slice(0, 2),
      parties: [], readers: [A.owner_id, B.owner_id], acknowledged: [], withdrawn: false });
    next.revision++;
    next.receipts.push({ owner: A.owner_id, key: key(), request_hash: canonicalHash(record),
      revision: next.revision, action: 'post_note', entity: { kind: 'case', id: f.item.id },
      item_id: noteId, outcome: 'recorded' });
    await f.store.publish(current, next);
    await assert.rejects(f.control.extendObservedCase(A, extension(f.item, f.ids[2])),
      { code: 'COORDINATION_EXTERNAL_EFFECT_UNRESOLVED' });
  });
}
