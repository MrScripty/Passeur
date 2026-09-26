import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, A, B, key, register, claim, caseOp, post, repo } from '../fixtures/structural/coordination-fixture.mjs';
import { encodePeerResolutionRecord, PEER_RESOLUTION_ACTIONS } from '../../.passeur-core/src/coordination/peer-resolution.js';
import { CoordinationStore } from '../../.passeur-core/src/store/coordination-store.js';
import { CoordinationControl } from '../../.passeur-core/src/coordination/control.js';

async function selected(t, target = 'refs/heads/main') {
  const f = await fixture(t);
  const work = (await f.control.execute(A, register({ readers: [B.owner_id] }))).item_id;
  const claimed = await f.control.execute(A, claim({ target, members: [B.owner_id] }));
  const initial = await f.control.reconciliation(A, claimed.item_id);
  await f.control.execute(A, caseOp('select_inputs', initial, {
    target_oid: '2'.repeat(40), inputs: [{ work_id: work, commit_oid: '3'.repeat(40) }],
  }));
  return { ...f, work, item: await f.control.reconciliation(A, claimed.item_id) };
}

function proposal(f, digest = 'b'.repeat(64), patch = {}) {
  return {
    schema_version: 1, kind: 'peer_resolution_proposal', case_id: f.item.id,
    case_revision: f.item.revision, case_generation: f.item.generation,
    proposal_revision: 1, evidence_id: 'a'.repeat(64), evidence_revision: 1,
    participants: [A.owner_id, B.owner_id],
    sources: [{ work_id: f.work, work_revision: 1, input_oid: '1'.repeat(40), selected_commit_oid: '3'.repeat(40) }],
    scope: [{ kind: 'file', path: 'src/quote.ts' }], action: 'propose',
    resolution_digest: digest, predecessor_digest: null, permitted_actions: [...PEER_RESOLUTION_ACTIONS],
    ...patch,
  };
}

function counter(predecessor, digest = 'c'.repeat(64), patch = {}) {
  return { ...predecessor, proposal_revision: predecessor.proposal_revision + 1,
    action: 'counter_propose', resolution_digest: digest, predecessor_digest: predecessor.resolution_digest, ...patch };
}

function application(proposed, digest = 'd'.repeat(64)) {
  return { schema_version: 1, kind: 'peer_resolution_application', case_id: proposed.case_id,
    case_revision: proposed.case_revision, case_generation: proposed.case_generation,
    evidence_id: proposed.evidence_id, evidence_revision: proposed.evidence_revision,
    sources: proposed.sources, scope: proposed.scope, proposal_digest: proposed.resolution_digest,
    application_digest: digest, status: 'applied' };
}

function verification(applied) {
  return { schema_version: 1, kind: 'peer_resolution_verification', case_id: applied.case_id,
    case_revision: applied.case_revision, case_generation: applied.case_generation,
    evidence_id: applied.evidence_id, evidence_revision: applied.evidence_revision,
    sources: applied.sources, scope: applied.scope, application_digest: applied.application_digest,
    status: 'passed' };
}

function publish(f, actor, record) {
  const isProposal = record.kind === 'peer_resolution_proposal';
  return f.control.execute(actor, post({ kind: 'case', id: record.case_id }, {
    note_kind: isProposal ? 'agreement_proposal' : 'resolution_update',
    text: encodePeerResolutionRecord(record), parties: isProposal ? [A.owner_id, B.owner_id] : [],
  }));
}

function ack(f, actor, receipt) {
  return f.control.execute(actor, { kind: 'ack_note', operation_key: key(), note_id: receipt.item_id });
}

test('a wholly unacknowledged predecessor can be countered without carrying consent', async t => {
  const f = await selected(t), first = proposal(f), next = counter(first);
  const original = await publish(f, A, first);
  const replacement = await publish(f, B, next);
  assert.deepEqual((await f.control.note(A, original.item_id)).acknowledged, []);
  assert.deepEqual((await f.control.note(A, replacement.item_id)).acknowledged, []);
  assert.equal((await f.control.note(A, replacement.item_id)).agreement, 'pending');
  await assert.rejects(publish(f, A, application(next)), { code: 'COORDINATION_NOT_ACKNOWLEDGED' });
});

test('a partially acknowledged predecessor gives no consent to its counter-proposal', async t => {
  const f = await selected(t), first = proposal(f), next = counter(first);
  const original = await publish(f, A, first);
  await ack(f, A, original);
  const replacement = await publish(f, B, next);
  assert.deepEqual((await f.control.note(A, original.item_id)).acknowledged, [A.owner_id]);
  assert.deepEqual((await f.control.note(A, replacement.item_id)).acknowledged, []);
  await assert.rejects(publish(f, A, application(next)), { code: 'COORDINATION_NOT_ACKNOWLEDGED' });
  await ack(f, B, replacement);
  assert.equal((await f.control.note(A, replacement.item_id)).agreement, 'pending');
  await assert.rejects(publish(f, A, application(next)), { code: 'COORDINATION_NOT_ACKNOWLEDGED' });
  await ack(f, A, replacement);
  await publish(f, A, application(next));
});

test('counter-proposals reject missing, withdrawn, and self-referential predecessors; duplicate identities are refused', async t => {
  const f = await selected(t), first = proposal(f);
  await assert.rejects(publish(f, B, counter(first)), { code: 'PEER_RESOLUTION_INVALID' });
  const original = await publish(f, A, first);
  await assert.rejects(publish(f, B, counter(first, first.resolution_digest)), { code: 'PEER_RESOLUTION_INVALID' });
  await f.control.execute(A, { kind: 'withdraw_note', operation_key: key(), note_id: original.item_id });
  await assert.rejects(publish(f, B, counter(first)), { code: 'PEER_RESOLUTION_INVALID' });

  const duplicate = proposal(f, 'e'.repeat(64));
  await publish(f, A, duplicate);
  await assert.rejects(publish(f, B, duplicate), { code: 'PEER_RESOLUTION_INVALID' });
  const unique = await publish(f, A, counter(duplicate));
  assert.equal((await f.control.note(A, unique.item_id)).peer_resolution_state, 'current');
});

test('counter lineage requires the exact current case and evidence context', async t => {
  const f = await selected(t), first = proposal(f);
  await publish(f, A, first);
  for (const patch of [
    { evidence_id: 'e'.repeat(64) },
    { evidence_revision: first.evidence_revision + 1 },
    { scope: [{ kind: 'file', path: 'src/other.ts' }] },
  ]) {
    const candidate = counter(first, 'c'.repeat(64), patch);
    await assert.rejects(publish(f, B, candidate), { code: 'PEER_RESOLUTION_INVALID' });
  }

  const other = await f.control.execute(A, claim({ target: 'refs/heads/other', members: [B.owner_id] }));
  const initial = await f.control.reconciliation(A, other.item_id);
  await f.control.execute(A, caseOp('select_inputs', initial, {
    target_oid: '2'.repeat(40), inputs: [{ work_id: f.work, commit_oid: '3'.repeat(40) }],
  }));
  const otherItem = await f.control.reconciliation(A, other.item_id);
  await assert.rejects(publish(f, B, counter(first, 'f'.repeat(64), {
    case_id: otherItem.id, case_revision: otherItem.revision, case_generation: otherItem.generation,
  })), { code: 'PEER_RESOLUTION_INVALID' });

  await f.control.execute(A, caseOp('select_inputs', f.item, {
    target_oid: '4'.repeat(40), inputs: [{ work_id: f.work, commit_oid: '3'.repeat(40) }],
  }));
  const current = await f.control.reconciliation(A, f.item.id);
  await assert.rejects(publish(f, B, counter(first, 'f'.repeat(64), {
    case_revision: current.revision,
  })), { code: 'PEER_RESOLUTION_INVALID' });
});

test('counter-proposals require exactly the next predecessor revision', async t => {
  const f = await selected(t), first = proposal(f);
  await publish(f, A, first);
  for (const proposal_revision of [first.proposal_revision, first.proposal_revision + 2]) {
    await assert.rejects(publish(f, B, counter(first, 'c'.repeat(64), { proposal_revision })),
      { code: 'PEER_RESOLUTION_INVALID' });
  }
  const valid = await publish(f, B, counter(first));
  assert.equal((await f.control.note(A, valid.item_id)).peer_resolution_state, 'current');
});

test('a stale historical same-digest proposal does not shadow a current acknowledged application', async t => {
  const f = await selected(t), historical = proposal(f);
  const old = await publish(f, A, historical);
  await f.control.execute(A, caseOp('select_inputs', f.item, {
    target_oid: '4'.repeat(40), inputs: [{ work_id: f.work, commit_oid: '3'.repeat(40) }],
  }));
  f.item = await f.control.reconciliation(A, f.item.id);
  const current = proposal(f, historical.resolution_digest);
  const accepted = await publish(f, A, current);
  await ack(f, A, accepted);
  await ack(f, B, accepted);
  assert.equal((await f.control.note(A, old.item_id)).peer_resolution_state, 'stale');
  assert.equal((await f.control.note(A, accepted.item_id)).agreement, 'acknowledged');
  const applied = await publish(f, A, application(current));
  assert.equal((await f.control.note(A, applied.item_id)).peer_resolution_state, 'current');
});

test('a new root cannot reuse a same-context retained digest, even after withdrawal', async t => {
  const f = await selected(t), first = proposal(f);
  const original = await publish(f, A, first);
  await assert.rejects(publish(f, B, proposal(f, first.resolution_digest)), { code: 'PEER_RESOLUTION_INVALID' });
  await f.control.execute(A, { kind: 'withdraw_note', operation_key: key(), note_id: original.item_id });
  await assert.rejects(publish(f, B, proposal(f, first.resolution_digest)), { code: 'PEER_RESOLUTION_INVALID' });
  assert.equal((await f.disk()).notes.length, 1);
  const distinct = await publish(f, B, proposal(f, 'c'.repeat(64)));
  assert.equal((await f.control.note(A, distinct.item_id)).peer_resolution_state, 'current');
});

test('a counter cannot reuse an ancestor or withdrawn same-context digest', async t => {
  const f = await selected(t), first = proposal(f), second = counter(first);
  await publish(f, A, first);
  const middle = await publish(f, B, second);
  await assert.rejects(publish(f, A, counter(second, first.resolution_digest)), { code: 'PEER_RESOLUTION_INVALID' });
  await f.control.execute(B, { kind: 'withdraw_note', operation_key: key(), note_id: middle.item_id });
  const independent = proposal(f, 'd'.repeat(64));
  await publish(f, A, independent);
  await assert.rejects(publish(f, B, counter(independent, second.resolution_digest)), { code: 'PEER_RESOLUTION_INVALID' });
  assert.equal((await f.disk()).notes.length, 3);
  const distinct = await publish(f, B, counter(independent, 'e'.repeat(64)));
  assert.equal((await f.control.note(A, distinct.item_id)).peer_resolution_state, 'current');
});

test('a pending or withdrawn successor leaves acknowledged application and verification current', async t => {
  const f = await selected(t), first = proposal(f), next = counter(first);
  const accepted = await publish(f, A, first);
  await ack(f, A, accepted);
  await ack(f, B, accepted);
  const appliedRecord = application(first);
  const applied = await publish(f, A, appliedRecord);
  const verified = await publish(f, A, verification(appliedRecord));
  const successor = await publish(f, B, next);
  assert.equal((await f.control.note(A, successor.item_id)).agreement, 'pending');
  for (const old of [accepted, applied, verified]) {
    assert.equal((await f.control.note(A, old.item_id)).peer_resolution_state, 'current');
  }
  await ack(f, B, successor);
  assert.equal((await f.control.note(A, successor.item_id)).agreement, 'pending');
  for (const old of [accepted, applied, verified]) {
    assert.equal((await f.control.note(A, old.item_id)).peer_resolution_state, 'current');
  }
  await f.control.execute(B, { kind: 'withdraw_note', operation_key: key(), note_id: successor.item_id });
  for (const old of [accepted, applied, verified]) {
    assert.equal((await f.control.note(A, old.item_id)).peer_resolution_state, 'current');
  }
  const later = await publish(f, A, application(first, 'e'.repeat(64)));
  assert.equal((await f.control.note(A, later.item_id)).peer_resolution_state, 'current');
});

test('full independent acknowledgment of a successor stales prior application and verification', async t => {
  const f = await selected(t), first = proposal(f), next = counter(first);
  const accepted = await publish(f, A, first);
  await ack(f, A, accepted);
  await ack(f, B, accepted);
  const appliedRecord = application(first);
  const applied = await publish(f, A, appliedRecord);
  const verified = await publish(f, A, verification(appliedRecord));
  const successor = await publish(f, B, next);
  await ack(f, B, successor);
  for (const old of [accepted, applied, verified]) {
    assert.equal((await f.control.note(A, old.item_id)).peer_resolution_state, 'current');
  }
  await ack(f, A, successor);
  for (const old of [accepted, applied, verified]) {
    assert.equal((await f.control.note(A, old.item_id)).peer_resolution_state, 'stale');
  }
  await assert.rejects(publish(f, A, application(first, 'e'.repeat(64))), { code: 'COORDINATION_NOT_ACKNOWLEDGED' });
  const replacement = await publish(f, A, application(next));
  assert.equal((await f.control.note(A, replacement.item_id)).peer_resolution_state, 'current');
});

test('withdrawing a predecessor after counter posting stales the counter and blocks late authority', async t => {
  const f = await selected(t), first = proposal(f), next = counter(first);
  const original = await publish(f, A, first);
  const successor = await publish(f, B, next);
  await f.control.execute(A, { kind: 'withdraw_note', operation_key: key(), note_id: original.item_id });
  assert.equal((await f.control.note(A, successor.item_id)).peer_resolution_state, 'stale');
  await assert.rejects(ack(f, A, successor), { code: 'COORDINATION_STALE_REVISION' });
  await assert.rejects(publish(f, A, application(next)), { code: 'COORDINATION_NOT_ACKNOWLEDGED' });
});

test('cold reopen retains supersession and replays the exact successor receipt', async t => {
  const f = await selected(t), first = proposal(f), next = counter(first);
  const accepted = await publish(f, A, first);
  await ack(f, A, accepted);
  await ack(f, B, accepted);
  const applied = await publish(f, A, application(first));
  const command = post({ kind: 'case', id: f.item.id }, {
    note_kind: 'agreement_proposal', text: encodePeerResolutionRecord(next), parties: [A.owner_id, B.owner_id],
  });
  const successor = await f.control.execute(B, command);
  assert.equal((await f.control.note(A, applied.item_id)).peer_resolution_state, 'current');
  await ack(f, A, successor);
  await ack(f, B, successor);
  assert.equal((await f.control.note(A, applied.item_id)).peer_resolution_state, 'stale');
  await f.control.close();
  const reopened = new CoordinationControl(await CoordinationStore.open(f.root, repo, () => {}));
  t.after(() => reopened.close());
  const before = await f.disk();
  assert.deepEqual(await reopened.execute(B, command), successor);
  assert.deepEqual(await f.disk(), before);
  assert.equal((await reopened.note(A, successor.item_id)).agreement, 'acknowledged');
  assert.equal((await reopened.note(A, applied.item_id)).peer_resolution_state, 'stale');
  await assert.rejects(reopened.execute(A, post({ kind: 'case', id: f.item.id }, {
    note_kind: 'resolution_update', text: encodePeerResolutionRecord(application(first, 'e'.repeat(64))),
  })), { code: 'COORDINATION_NOT_ACKNOWLEDGED' });
});

test('superseded predecessors cannot anchor a new counter-proposal', async t => {
  const f = await selected(t), first = proposal(f), second = counter(first);
  await publish(f, A, first);
  const replacement = await publish(f, B, second);
  await ack(f, A, replacement);
  await ack(f, B, replacement);
  await assert.rejects(publish(f, A, counter(first, 'e'.repeat(64))), { code: 'PEER_RESOLUTION_INVALID' });
});

test('a competing successor is refused and late acknowledgment cannot revive its predecessor', async t => {
  const f = await selected(t), first = proposal(f);
  const left = counter(first, 'c'.repeat(64));
  const right = counter(first, 'e'.repeat(64));
  const original = await publish(f, A, first);
  const chosen = await publish(f, B, left);
  await assert.rejects(publish(f, A, right), { code: 'PEER_RESOLUTION_INVALID' });
  await ack(f, A, chosen);
  await ack(f, B, chosen);
  assert.equal((await f.control.note(A, original.item_id)).peer_resolution_state, 'stale');
  await assert.rejects(ack(f, B, original), { code: 'COORDINATION_STALE_REVISION' });
  await assert.rejects(publish(f, A, application(first)), { code: 'COORDINATION_NOT_ACKNOWLEDGED' });
  await assert.rejects(publish(f, A, application(right)), { code: 'COORDINATION_NOT_ACKNOWLEDGED' });
  await publish(f, A, application(left));
});

test('a chained successor invalidates earlier applications and rejects late acknowledgments', async t => {
  const f = await selected(t), first = proposal(f), second = counter(first), third = counter(second, 'e'.repeat(64));
  const original = await publish(f, A, first);
  const middle = await publish(f, B, second);
  const chosen = await publish(f, A, third);
  await ack(f, A, chosen);
  await ack(f, B, chosen);
  for (const old of [original, middle]) {
    assert.equal((await f.control.note(A, old.item_id)).peer_resolution_state, 'stale');
    await assert.rejects(ack(f, B, old), { code: 'COORDINATION_STALE_REVISION' });
  }
  await assert.rejects(publish(f, A, application(first)), { code: 'COORDINATION_NOT_ACKNOWLEDGED' });
  await assert.rejects(publish(f, A, application(second)), { code: 'COORDINATION_NOT_ACKNOWLEDGED' });
  await publish(f, A, application(third));
});

test('reported external integration invalidates acknowledged lineage and its application', async t => {
  const f = await selected(t), first = proposal(f), second = counter(first);
  await publish(f, A, first);
  const chosen = await publish(f, B, second);
  await ack(f, A, chosen);
  await ack(f, B, chosen);
  const applied = await publish(f, A, application(second));
  await f.control.execute(A, caseOp('begin_external_integration', f.item));
  assert.equal((await f.control.note(A, chosen.item_id)).peer_resolution_state, 'stale');
  assert.equal((await f.control.note(A, applied.item_id)).peer_resolution_state, 'stale');
  await assert.rejects(publish(f, A, application(second, 'f'.repeat(64))), { code: 'COORDINATION_STALE_REVISION' });
  await assert.rejects(ack(f, B, chosen), { code: 'COORDINATION_STALE_REVISION' });
});
