import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, A, key, register, claim, caseOp, post } from '../fixtures/structural/coordination-fixture.mjs';
import { encodePeerResolutionRecord, PEER_RESOLUTION_ACTIONS } from '../../.passeur-core/src/coordination/peer-resolution.js';
import { CoordinationControl } from '../../.passeur-core/src/coordination/control.js';
import { fixture as taskFixture } from './helpers.mjs';

const full = (actor, operation) => { const { owner_id: _owner, ...identity } = actor; return { schema_version: 1, ...identity, ...operation }; };
const deferred = () => {
  let release, entered;
  return { blocked: new Promise(resolve => { release = resolve; }), reached: new Promise(resolve => { entered = resolve; }),
    release: () => release(), enter: () => entered() };
};
const within = (promise, label) => Promise.race([promise, new Promise((_, reject) =>
  setTimeout(() => reject(new Error(`${label} blocked on authority`)), 1000))]);

async function selectedManaged(t) {
  const f = await fixture(t), source_view = '/source/repository';
  f.control.workerAuthority = {
    assertCurrent: async (actor, state, item) => {
      const work = state.works.find(candidate => candidate.managed?.task_id === actor.task_id);
      if (!work || work.owner !== actor.owner_id || work.managed.control_generation !== actor.control_generation
        || work.workspace_id !== actor.workspace_id || !item.inputs.some(input => input.work_id === work.id)) {
        throw Object.assign(new Error('test task authority changed'), { code: 'PEER_OPERATION_STALE' });
      }
    },
    assertConsentCurrent: async () => {},
  };
  const bound = await f.control.bindSubmission(A, { operation_key: `passeur-internal:${key()}`, task_id: randomUUID(), request_key: key(),
    source_view, input_oid: '1'.repeat(40), intent_hash: '2'.repeat(64), areas: [{ kind: 'subtree', path: 'src' }] });
  await f.control.settleSubmission(A, { operation_key: `passeur-internal:${key()}`, task_id: bound.task_id,
    request_key: bound.request_key, link_hash: bound.link_hash });
  const work = await f.control.execute(A, { kind: 'register_task_work', operation_key: key(), workspace_id: `workspace:${key()}`,
    input_oid: '1'.repeat(40), object_format: 'sha1', intent: 'managed peer work', areas: [{ kind: 'subtree', path: 'src' }],
    managed: { task_id: bound.task_id, control_generation: 1, intent_truncated: false, areas_source: 'allowed_paths' } });
  const claimed = await f.control.execute(A, claim()), item = await f.control.reconciliation(A, claimed.item_id);
  await f.control.execute(A, caseOp('select_inputs', item, { target_oid: '2'.repeat(40), inputs: [{ work_id: work.item_id, commit_oid: '3'.repeat(40) }] }));
  const current = await f.control.reconciliation(A, claimed.item_id);
  const actor = { owner_id: A.owner_id, task_id: bound.task_id, run_id: randomUUID(), control_generation: 1,
    workspace_id: `workspace:${work.item_id === bound.task_id ? (await f.control.work(A, work.item_id)).workspace_id.slice('workspace:'.length) : ''}`, source_view, case_id: current.id };
  return { ...f, actor, work: work.item_id, item: current };
}

async function addSibling(f) {
  const bound = await f.control.bindSubmission(A, { operation_key: `passeur-internal:${key()}`, task_id: randomUUID(), request_key: key(),
    source_view: f.actor.source_view, input_oid: '1'.repeat(40), intent_hash: '2'.repeat(64), areas: [{ kind: 'subtree', path: 'src' }] });
  await f.control.settleSubmission(A, { operation_key: `passeur-internal:${key()}`, task_id: bound.task_id,
    request_key: bound.request_key, link_hash: bound.link_hash });
  const workspace_id = `workspace:${key()}`;
  await f.control.execute(A, { kind: 'register_task_work', operation_key: key(), workspace_id,
    input_oid: '1'.repeat(40), object_format: 'sha1', intent: 'sibling peer work', areas: [{ kind: 'subtree', path: 'src' }],
    managed: { task_id: bound.task_id, control_generation: 1, intent_truncated: false, areas_source: 'allowed_paths' } });
  const item = await f.control.reconciliation(A, f.item.id);
  await f.control.execute(A, caseOp('select_inputs', item, { target_oid: '2'.repeat(40), inputs: [
    { work_id: f.work, commit_oid: '3'.repeat(40) }, { work_id: bound.task_id, commit_oid: '4'.repeat(40) }] }));
  return { ...f.actor, task_id: bound.task_id, run_id: randomUUID(), workspace_id };
}

function proposalFor(f, sources) {
  return { schema_version: 1, kind: 'peer_resolution_proposal', case_id: f.item.id, case_revision: f.item.revision,
    case_generation: f.item.generation, proposal_revision: 1, evidence_id: 'a'.repeat(64), evidence_revision: 1,
    participants: [A.owner_id], sources, scope: [{ kind: 'file', path: 'src/a.ts' }], action: 'propose',
    resolution_digest: 'b'.repeat(64), predecessor_digest: null, permitted_actions: [...PEER_RESOLUTION_ACTIONS] };
}

test('task-authenticated worker proposals, retry receipts, and event-backed waits stay case-scoped', async t => {
  const f = await selectedManaged(t);
  const record = { schema_version: 1, kind: 'peer_resolution_proposal', case_id: f.item.id, case_revision: f.item.revision,
    case_generation: f.item.generation, proposal_revision: 1, evidence_id: 'a'.repeat(64), evidence_revision: 1,
    participants: [A.owner_id], sources: [{ work_id: f.work, work_revision: 1, input_oid: '1'.repeat(40), selected_commit_oid: '3'.repeat(40) }],
    scope: [{ kind: 'file', path: 'src/a.ts' }], action: 'propose', resolution_digest: 'b'.repeat(64), predecessor_digest: null,
    permitted_actions: [...PEER_RESOLUTION_ACTIONS] };
  const operation = full(f.actor, { operation_key: 'worker-propose', kind: 'propose', proposal: record });
  const receipt = await f.control.workerPeerOperation(f.actor, operation);
  assert.equal(receipt.kind, 'receipt'); assert.equal(receipt.operation, 'propose');
  assert.deepEqual(await f.control.workerPeerOperation(f.actor, operation), receipt);
  const inspection = await f.control.workerPeerOperation(f.actor, full(f.actor, { operation_key: 'worker-inspect', kind: 'inspect' }));
  assert.equal(inspection.kind, 'current'); assert.equal(inspection.proposal_note_id, receipt.note_id);

  const wait = f.control.workerPeerOperation(f.actor, full(f.actor, { operation_key: 'worker-await', kind: 'await_change',
    after_case_revision: f.item.revision, after_case_generation: f.item.generation,
    after_negotiation_cursor: inspection.negotiation_cursor }));
  await f.control.execute(A, post({ kind: 'case', id: f.item.id }));
  const changed = await wait;
  assert.equal(changed.kind, 'current'); assert.equal(changed.operation, 'await_change');
  const refreshed = await f.control.reconciliation(A, f.item.id);
  await f.control.execute(A, caseOp('select_inputs', refreshed, { target_oid: '4'.repeat(40), inputs: [{ work_id: f.work, commit_oid: '3'.repeat(40) }] }));
  assert.deepEqual(await f.control.workerPeerOperation(f.actor, operation), receipt);

  await assert.rejects(f.control.workerPeerOperation({ ...f.actor, workspace_id: 'workspace:forged' },
    full({ ...f.actor, workspace_id: 'workspace:forged' }, { operation_key: 'forged', kind: 'inspect' })), { code: 'PEER_OPERATION_FORBIDDEN' });
  await assert.rejects(f.control.workerPeerOperation(f.actor, full(f.actor, { operation_key: 'effect', kind: 'apply',
    note_id: receipt.note_id, expected_case_revision: refreshed.revision,
    expected_case_generation: refreshed.generation, proposal_digest: 'b'.repeat(64) })), { code: 'PEER_OPERATION_UNAVAILABLE' });
});

test('siblings retain separate consent; parent acknowledgment cannot substitute; cursor sees intervening consent', async t => {
  const f = await selectedManaged(t), sibling = await addSibling(f);
  f.item = await f.control.reconciliation(A, f.item.id);
  const sources = [f.work, sibling.task_id].map((work_id, index) => ({ work_id, work_revision: 1,
    input_oid: '1'.repeat(40), selected_commit_oid: (index ? '4' : '3').repeat(40) }));
  const proposed = await f.control.workerPeerOperation(f.actor, full(f.actor, { operation_key: 'siblings-propose', kind: 'propose',
    proposal: proposalFor(f, sources) }));
  const before = await f.control.workerPeerOperation(f.actor, full(f.actor, { operation_key: 'siblings-inspect', kind: 'inspect' }));
  assert.deepEqual(before.participant_task_ids, [f.actor.task_id, sibling.task_id]);
  assert.deepEqual(before.acknowledged_task_ids, []);
  await assert.rejects(f.control.execute(A, { kind: 'ack_note', operation_key: key(), note_id: proposed.note_id }),
    { code: 'COORDINATION_FORBIDDEN' });
  await assert.rejects(f.control.execute(A, { kind: 'withdraw_note', operation_key: key(), note_id: proposed.note_id }),
    { code: 'COORDINATION_FORBIDDEN' });
  await f.control.workerPeerOperation(f.actor, full(f.actor, { operation_key: 'first-consent', kind: 'acknowledge', note_id: proposed.note_id }));
  assert.equal((await f.control.note(A, proposed.note_id)).peer_resolution_state, 'current');
  const raced = await f.control.workerPeerOperation(sibling, full(sibling, { operation_key: 'cursor-race', kind: 'await_change',
    after_case_revision: before.case_revision, after_case_generation: before.case_generation,
    after_negotiation_cursor: before.negotiation_cursor }));
  assert.equal(raced.kind, 'current');
  assert.deepEqual(raced.acknowledged_task_ids, [f.actor.task_id]);
  assert.notEqual(raced.negotiation_cursor, before.negotiation_cursor);
  const pending = f.control.workerPeerOperation(f.actor, full(f.actor, { operation_key: 'second-consent-wait', kind: 'await_change',
    after_case_revision: raced.case_revision, after_case_generation: raced.case_generation,
    after_negotiation_cursor: raced.negotiation_cursor }));
  await f.control.workerPeerOperation(sibling, full(sibling, { operation_key: 'second-consent', kind: 'acknowledge', note_id: proposed.note_id }));
  assert.deepEqual((await pending).acknowledged_task_ids, [f.actor.task_id, sibling.task_id]);
  const agreed = await f.control.workerPeerOperation(f.actor, full(f.actor, { operation_key: 'agreed-inspect', kind: 'inspect' }));
  assert.deepEqual(agreed.acknowledged_task_ids, [f.actor.task_id, sibling.task_id]);
});

test('cursorless await_change waits for case versions while a cursor observes note changes', async t => {
  const f = await selectedManaged(t);
  const current = await f.control.workerPeerOperation(f.actor, full(f.actor, { operation_key: key(), kind: 'inspect' }));
  let settled = false;
  const waiting = f.control.workerPeerOperation(f.actor, full(f.actor, { operation_key: key(), kind: 'await_change',
    after_case_revision: current.case_revision, after_case_generation: current.case_generation }));
  waiting.then(() => { settled = true; });
  await f.control.execute(A, post({ kind: 'case', id: f.item.id }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  const item = await f.control.reconciliation(A, f.item.id);
  await f.control.execute(A, caseOp('select_inputs', item, { target_oid: '4'.repeat(40), inputs: [
    { work_id: f.work, commit_oid: '3'.repeat(40) }] }));
  assert.equal((await waiting).case_revision, item.revision + 1);
});

test('metadata-only await_change stays pending without a capture hook until case metadata changes', async t => {
  const f = await selectedManaged(t);
  const current = await f.control.workerPeerOperation(f.actor, full(f.actor, { operation_key: key(), kind: 'inspect' }));
  let settled = false;
  const waiting = f.control.workerPeerOperation(f.actor, full(f.actor, { operation_key: key(), kind: 'await_change',
    after_case_revision: current.case_revision, after_case_generation: current.case_generation,
    after_negotiation_cursor: current.negotiation_cursor }));
  waiting.then(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(settled, false, 'registration must not wake on its synthetic evidence baseline');
  await f.control.notifyWorkerPeerCaptureChanged(f.work, 'src/a.ts');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(settled, false, 'observation notification has no capture identity to compare');
  await f.control.execute(A, post({ kind: 'case', id: f.item.id }));
  const changed = await within(waiting, 'metadata-only await_change');
  assert.equal(changed.kind, 'current');
  assert.notEqual(changed.negotiation_cursor, current.negotiation_cursor);
});

test('public counter proposal cannot replace worker consent; worker successor retains task parties', async t => {
  const f = await selectedManaged(t);
  const sources = [{ work_id: f.work, work_revision: 1, input_oid: '1'.repeat(40), selected_commit_oid: '3'.repeat(40) }];
  const proposal = proposalFor(f, sources);
  const first = await f.control.workerPeerOperation(f.actor, full(f.actor, { operation_key: key(), kind: 'propose', proposal }));
  await f.control.workerPeerOperation(f.actor, full(f.actor, { operation_key: key(), kind: 'acknowledge', note_id: first.note_id }));
  const successor = { ...proposal, proposal_revision: 2, action: 'counter_propose',
    resolution_digest: 'c'.repeat(64), predecessor_digest: proposal.resolution_digest };
  await assert.rejects(f.control.execute(A, post({ kind: 'case', id: f.item.id }, {
    note_kind: 'agreement_proposal', text: encodePeerResolutionRecord(successor), parties: [A.owner_id] })),
  { code: 'COORDINATION_FORBIDDEN' });
  const second = await f.control.workerPeerOperation(f.actor, full(f.actor, { operation_key: key(),
    kind: 'counter_propose', proposal: successor }));
  assert.equal(second.kind, 'receipt');
  const current = await f.control.workerPeerOperation(f.actor, full(f.actor, { operation_key: key(), kind: 'inspect' }));
  assert.equal(current.proposal_note_id, second.note_id);
  assert.deepEqual(current.acknowledged_task_ids, []);
});

test('revoked consent is rejected by fresh inspection and publication wakeup', async t => {
  const f = await selectedManaged(t);
  let consentCurrent = true;
  f.control.workerAuthority = {
    assertCurrent: async () => {},
    assertConsentCurrent: async () => {
      if (!consentCurrent) throw Object.assign(new Error('consent revoked'), { code: 'PEER_OPERATION_STALE' });
    },
  };
  const proposal = proposalFor(f, [{ work_id: f.work, work_revision: 1,
    input_oid: '1'.repeat(40), selected_commit_oid: '3'.repeat(40) }]);
  const posted = await f.control.workerPeerOperation(f.actor, full(f.actor, { operation_key: key(), kind: 'propose', proposal }));
  await f.control.workerPeerOperation(f.actor, full(f.actor, { operation_key: key(), kind: 'acknowledge', note_id: posted.note_id }));
  const before = await f.control.workerPeerOperation(f.actor, full(f.actor, { operation_key: key(), kind: 'inspect' }));
  const waiting = f.control.workerPeerOperation(f.actor, full(f.actor, { operation_key: key(), kind: 'await_change',
    after_case_revision: before.case_revision, after_case_generation: before.case_generation,
    after_negotiation_cursor: before.negotiation_cursor }));
  waiting.catch(() => undefined);
  consentCurrent = false;
  await assert.rejects(f.control.workerPeerOperation(f.actor, full(f.actor, { operation_key: key(), kind: 'inspect' })),
    { code: 'PEER_OPERATION_STALE' });
  await assert.rejects(f.control.workerPeerStoredResult(f.actor, full(f.actor, {
    operation_key: before.operation_key, kind: 'inspect' }), before), { code: 'PEER_OPERATION_STALE' });
  await f.control.execute(A, post({ kind: 'case', id: f.item.id }));
  await assert.rejects(waiting, { code: 'PEER_OPERATION_STALE' });
});

test('retained exact inspection replays captured cursor while current authority remains required', async t => {
  const f = await selectedManaged(t);
  const proposal = proposalFor(f, [{ work_id: f.work, work_revision: 1,
    input_oid: '1'.repeat(40), selected_commit_oid: '3'.repeat(40) }]);
  await f.control.workerPeerOperation(f.actor, full(f.actor, { operation_key: key(), kind: 'propose', proposal }));
  const request = full(f.actor, { operation_key: key(), kind: 'inspect' });
  const captured = await f.control.workerPeerOperation(f.actor, request);
  await f.control.execute(A, post({ kind: 'case', id: f.item.id }));
  await assert.rejects(f.control.workerPeerStoredResult(f.actor, request, captured), { code: 'PEER_OPERATION_STALE' });
  assert.deepEqual(await f.control.workerPeerRetainedResult(f.actor, request, captured), captured);
  f.control.workerAuthority = {
    assertCurrent: async () => { throw Object.assign(new Error('revoked'), { code: 'PEER_OPERATION_STALE' }); },
    assertConsentCurrent: async () => {},
  };
  await assert.rejects(f.control.workerPeerRetainedResult(f.actor, request, captured), { code: 'PEER_OPERATION_STALE' });
});

test('retained replay refuses a proposal source removed from current selection', async t => {
  const f = await selectedManaged(t), sibling = await addSibling(f);
  f.item = await f.control.reconciliation(A, f.item.id);
  const sources = [f.work, sibling.task_id].map((work_id, index) => ({ work_id, work_revision: 1,
    input_oid: '1'.repeat(40), selected_commit_oid: (index ? '4' : '3').repeat(40) }));
  const proposal = proposalFor(f, sources);
  await f.control.workerPeerOperation(f.actor, full(f.actor, { operation_key: key(), kind: 'propose', proposal }));
  const request = full(f.actor, { operation_key: key(), kind: 'inspect' });
  const captured = await f.control.workerPeerOperation(f.actor, request);
  assert.deepEqual(captured.proposal.sources, sources);
  const item = await f.control.reconciliation(A, f.item.id);
  await f.control.execute(A, caseOp('select_inputs', item, { target_oid: '2'.repeat(40),
    inputs: [{ work_id: f.work, commit_oid: '3'.repeat(40) }] }));
  await assert.rejects(f.control.workerPeerRetainedResult(f.actor, request, captured), { code: 'STRUCTURAL_SOURCE_FORBIDDEN' });
  assert.deepEqual(captured.proposal.sources, sources);
});

test('task transition callback runs outside metadata ordering and marks selected case', async t => {
  const f = await selectedManaged(t), sibling = await addSibling(f);
  await f.control.withWorkerTaskTransition(f.actor.task_id, async () => {
    assert.equal((await f.control.reconciliation(A, f.item.id)).id, f.item.id);
    await assert.rejects(f.control.workerPeerOperation(f.actor, full(f.actor, { operation_key: key(), kind: 'inspect' })),
      { code: 'PEER_OPERATION_STALE' });
    await assert.rejects(f.control.workerPeerOperation(sibling, full(sibling, { operation_key: key(), kind: 'inspect' })),
      { code: 'PEER_OPERATION_STALE' });
  });
});

test('public peer consent and projection fail closed during a selected task transition', async t => {
  const f = await selectedManaged(t);
  const subject = { kind: 'case', id: f.item.id };
  const proposal = proposalFor(f, [{ work_id: f.work, work_revision: 1,
    input_oid: '1'.repeat(40), selected_commit_oid: '3'.repeat(40) }]);
  const posted = await f.control.workerPeerOperation(f.actor, full(f.actor, { operation_key: key(), kind: 'propose', proposal }));
  await f.control.workerPeerOperation(f.actor, full(f.actor, { operation_key: key(), kind: 'acknowledge', note_id: posted.note_id }));
  const application = { schema_version: 1, kind: 'peer_resolution_application', case_id: proposal.case_id,
    case_revision: proposal.case_revision, case_generation: proposal.case_generation,
    evidence_id: proposal.evidence_id, evidence_revision: proposal.evidence_revision,
    sources: proposal.sources, scope: proposal.scope, proposal_digest: proposal.resolution_digest,
    application_digest: 'c'.repeat(64), status: 'applied' };
  const applied = await f.control.execute(A, post(subject, { note_kind: 'resolution_update',
    text: encodePeerResolutionRecord(application) }));
  const verification = { schema_version: 1, kind: 'peer_resolution_verification', case_id: proposal.case_id,
    case_revision: proposal.case_revision, case_generation: proposal.case_generation,
    evidence_id: proposal.evidence_id, evidence_revision: proposal.evidence_revision,
    sources: proposal.sources, scope: proposal.scope, application_digest: application.application_digest, status: 'passed' };
  const parentProposal = await f.control.execute(A, post(subject, { note_kind: 'agreement_proposal',
    text: encodePeerResolutionRecord({ ...proposal, resolution_digest: 'e'.repeat(64) }), parties: [A.owner_id] }));
  let release, entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const reached = new Promise(resolve => { entered = resolve; });
  const transition = f.control.withWorkerTaskTransition(f.actor.task_id, async () => { entered(); await blocked; });
  await reached;
  try {
    assert.equal((await f.control.reconciliation(A, f.item.id)).id, f.item.id);
    assert.equal((await f.control.note(A, posted.note_id)).peer_resolution_state, 'stale');
    assert.equal((await f.control.note(A, applied.item_id)).peer_resolution_state, 'stale');
    await assert.rejects(f.control.execute(A, post(subject, { note_kind: 'resolution_update',
      text: encodePeerResolutionRecord(verification) })), { code: 'PEER_OPERATION_STALE' });
    await assert.rejects(f.control.execute(A, post(subject, { note_kind: 'resolution_update',
      text: encodePeerResolutionRecord(application) })), { code: 'PEER_OPERATION_STALE' });
    await assert.rejects(f.control.execute(A, post(subject, { note_kind: 'agreement_proposal',
      text: encodePeerResolutionRecord({ ...proposal, resolution_digest: 'd'.repeat(64) }), parties: [A.owner_id] })),
    { code: 'PEER_OPERATION_STALE' });
    await assert.rejects(f.control.execute(A, { kind: 'ack_note', operation_key: key(), note_id: parentProposal.item_id }),
      { code: 'PEER_OPERATION_STALE' });
    assert.equal((await f.control.execute(A, post(subject))).action, 'post_note');
  } finally { release(); await transition; }
  assert.equal((await f.control.note(A, posted.note_id)).peer_resolution_state, 'current');
  assert.equal((await f.control.note(A, applied.item_id)).peer_resolution_state, 'current');
});

test('publication releases metadata ordering while worker authority is pending', async t => {
  const f = await selectedManaged(t);
  const before = await f.control.workerPeerOperation(f.actor, full(f.actor, { operation_key: key(), kind: 'inspect' }));
  const waiting = f.control.workerPeerOperation(f.actor, full(f.actor, { operation_key: key(), kind: 'await_change',
    after_case_revision: before.case_revision, after_case_generation: before.case_generation,
    after_negotiation_cursor: before.negotiation_cursor }));
  await f.control.reconciliation(A, f.item.id);
  let release, entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const reached = new Promise(resolve => { entered = resolve; });
  f.control.workerAuthority = {
    assertCurrent: async () => { entered(); await blocked; },
    assertConsentCurrent: async () => {},
  };
  const limit = label => new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), 1000));
  try {
    await Promise.race([f.control.execute(A, post({ kind: 'case', id: f.item.id })), limit('publish')]);
    await Promise.race([reached, limit('authority')]);
    assert.equal((await Promise.race([f.control.reconciliation(A, f.item.id), limit('reconciliation')])).id, f.item.id);
  } finally { release(); }
  assert.equal((await waiting).kind, 'current');
});

test('stored result disclosure is ordered with adoption and worker authority', async t => {
  const f = await selectedManaged(t);
  const request = full(f.actor, { operation_key: key(), kind: 'inspect' });
  const result = await f.control.workerPeerOperation(f.actor, request);
  assert.deepEqual(await f.control.workerPeerStoredResult(f.actor, request, result), result);
  await f.control.execute(A, post({ kind: 'case', id: f.item.id }));
  await assert.rejects(f.control.workerPeerStoredResult(f.actor, request, result), { code: 'PEER_OPERATION_STALE' });
  let generation = 1;
  f.control.workerAuthority = {
    assertCurrent: async actor => {
      if (actor.control_generation !== generation) throw Object.assign(new Error('adopted'), { code: 'PEER_OPERATION_STALE' });
    },
    assertConsentCurrent: async () => {},
  };
  await f.control.withWorkerTaskTransition(f.actor.task_id, async () => { generation++; });
  await assert.rejects(f.control.workerPeerStoredResult(f.actor, request, result), { code: 'PEER_OPERATION_STALE' });
});

test('worker operations fail closed without native task authority while parent metadata remains usable', async t => {
  const f = await selectedManaged(t);
  f.control.workerAuthority = undefined;
  await assert.rejects(f.control.workerPeerOperation(f.actor, full(f.actor, { operation_key: key(), kind: 'inspect' })),
    { code: 'PEER_OPERATION_UNAVAILABLE' });
  assert.equal((await f.control.reconciliation(A, f.item.id)).id, f.item.id);
});

test('transition of a selected sibling rejects other participants waiting on the case', async t => {
  const f = await selectedManaged(t), sibling = await addSibling(f);
  const current = await f.control.workerPeerOperation(f.actor, full(f.actor, { operation_key: key(), kind: 'inspect' }));
  const waiting = f.control.workerPeerOperation(f.actor, full(f.actor, { operation_key: key(), kind: 'await_change',
    after_case_revision: current.case_revision, after_case_generation: current.case_generation,
    after_negotiation_cursor: current.negotiation_cursor }));
  await f.control.withWorkerTaskTransition(sibling.task_id, async () => {});
  await assert.rejects(waiting, { code: 'PEER_OPERATION_STALE' });
});

test('a queued worker mutation cancelled before publication leaves no note', async t => {
  const f = await selectedManaged(t), abort = new AbortController();
  const original = f.store.snapshot.bind(f.store);
  let release, entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const reached = new Promise(resolve => { entered = resolve; });
  f.store.snapshot = async (...args) => { entered(); await blocked; return original(...args); };
  const sources = [{ work_id: f.work, work_revision: 1, input_oid: '1'.repeat(40), selected_commit_oid: '3'.repeat(40) }];
  const mutation = f.control.workerPeerOperation(f.actor, full(f.actor, { operation_key: 'cancelled-propose', kind: 'propose',
    proposal: proposalFor(f, sources) }), abort.signal);
  await reached; abort.abort(new Error('cancelled')); release();
  await assert.rejects(mutation, /cancelled/);
  f.store.snapshot = original;
  assert.equal((await f.control.reconciliation(A, f.item.id)).revision, f.item.revision);
  assert.equal((await f.disk()).notes.length, 0);
});

test('abort after the final worker check cannot turn a committed mutation into an abort result', async t => {
  const f = await selectedManaged(t), abort = new AbortController();
  const original = f.store.publish.bind(f.store);
  f.store.publish = async (...args) => { abort.abort(new Error('late abort')); return original(...args); };
  const sources = [{ work_id: f.work, work_revision: 1, input_oid: '1'.repeat(40), selected_commit_oid: '3'.repeat(40) }];
  const result = await f.control.workerPeerOperation(f.actor, full(f.actor, { operation_key: key(), kind: 'propose',
    proposal: proposalFor(f, sources) }), abort.signal);
  assert.equal(result.kind, 'receipt');
  assert.equal((await f.disk()).notes.length, 1);
});

test('selected work reader revocation during await_change rejects the wakeup', async t => {
  const f = await fixture(t), source_view = '/source/repository';
  f.control.workerAuthority = {
    assertCurrent: async () => {},
    assertConsentCurrent: async () => {},
  };
  async function managed(owner) {
    const bound = await f.control.bindSubmission(owner, { operation_key: `passeur-internal:${key()}`, task_id: randomUUID(), request_key: key(),
      source_view, input_oid: '1'.repeat(40), intent_hash: '2'.repeat(64), areas: [{ kind: 'subtree', path: 'src' }] });
    await f.control.settleSubmission(owner, { operation_key: `passeur-internal:${key()}`, task_id: bound.task_id,
      request_key: bound.request_key, link_hash: bound.link_hash });
    const workspace_id = `workspace:${key()}`;
    await f.control.execute(owner, { kind: 'register_task_work', operation_key: key(), workspace_id,
      input_oid: '1'.repeat(40), object_format: 'sha1', intent: 'peer work', areas: [{ kind: 'subtree', path: 'src' }],
      managed: { task_id: bound.task_id, control_generation: 1, intent_truncated: false, areas_source: 'allowed_paths' } });
    return { owner_id: owner.owner_id, task_id: bound.task_id, run_id: randomUUID(), control_generation: 1,
      workspace_id, source_view };
  }
  const first = await managed(A), second = await managed({ owner_id: 'b'.repeat(64) });
  const B = { owner_id: second.owner_id };
  await f.control.execute(A, { kind: 'share_work', operation_key: key(), work_id: first.task_id, expected_revision: 1, readers: [B.owner_id] });
  await f.control.execute(B, { kind: 'share_work', operation_key: key(), work_id: second.task_id, expected_revision: 1, readers: [A.owner_id] });
  await f.control.execute(A, { kind: 'grant_source', operation_key: key(), work_id: first.task_id, expected_revision: 2,
    recipients: [{ recipient: B.owner_id, scope: 'report' }] });
  await f.control.execute(B, { kind: 'grant_source', operation_key: key(), work_id: second.task_id, expected_revision: 2,
    recipients: [{ recipient: A.owner_id, scope: 'report' }] });
  const claimed = await f.control.execute(A, claim({ members: [B.owner_id] }));
  const initial = await f.control.reconciliation(A, claimed.item_id);
  await f.control.execute(A, caseOp('select_inputs', initial, { target_oid: '2'.repeat(40), inputs: [
    { work_id: first.task_id, commit_oid: '3'.repeat(40) }, { work_id: second.task_id, commit_oid: '4'.repeat(40) }] }));
  const item = await f.control.reconciliation(A, claimed.item_id), actor = { ...first, case_id: item.id };
  const current = await f.control.workerPeerOperation(actor, full(actor, { operation_key: 'grant-inspect', kind: 'inspect' }));
  const pending = f.control.workerPeerOperation(actor, full(actor, { operation_key: 'grant-wait', kind: 'await_change',
    after_case_revision: current.case_revision, after_case_generation: current.case_generation,
    after_negotiation_cursor: current.negotiation_cursor }));
  await f.control.execute(B, { kind: 'share_work', operation_key: key(), work_id: second.task_id, expected_revision: 3, readers: [] });
  await assert.rejects(pending, { code: 'PEER_OPERATION_FORBIDDEN' });
  await assert.rejects(f.control.workerPeerOperation(actor, full(actor, { operation_key: 'grant-again', kind: 'inspect' })),
    { code: 'PEER_OPERATION_FORBIDDEN' });
  await assert.rejects(f.control.workerPeerStoredResult(actor, full(actor, { operation_key: 'grant-inspect', kind: 'inspect' }), current),
    { code: 'PEER_OPERATION_FORBIDDEN' });
  await assert.rejects(f.control.workerPeerRetainedResult(actor, full(actor, { operation_key: 'grant-inspect', kind: 'inspect' }), current),
    { code: 'PEER_OPERATION_FORBIDDEN' });
});

test('retained legacy worker note with parent parties cannot authorize application', async t => {
  const f = await selectedManaged(t);
  const proposal = proposalFor(f, [{ work_id: f.work, work_revision: 1, input_oid: '1'.repeat(40), selected_commit_oid: '3'.repeat(40) }]);
  const posted = await f.control.execute(A, post({ kind: 'case', id: f.item.id }, {
    note_kind: 'agreement_proposal', text: encodePeerResolutionRecord(proposal), parties: [A.owner_id] }));
  await f.control.execute(A, { kind: 'ack_note', operation_key: key(), note_id: posted.item_id });
  const retained = structuredClone(await f.store.snapshot());
  retained.receipts.find(receipt => receipt.item_id === posted.item_id && receipt.action === 'post_note').key =
    `worker-peer-v1:${f.actor.task_id}:${f.actor.run_id}:${'a'.repeat(64)}`;
  f.store.snapshot = async () => structuredClone(retained);
  const application = { schema_version: 1, kind: 'peer_resolution_application', case_id: proposal.case_id,
    case_revision: proposal.case_revision, case_generation: proposal.case_generation,
    evidence_id: proposal.evidence_id, evidence_revision: proposal.evidence_revision,
    sources: proposal.sources, scope: proposal.scope, proposal_digest: proposal.resolution_digest,
    application_digest: 'c'.repeat(64), status: 'applied' };
  await assert.rejects(f.control.execute(A, post({ kind: 'case', id: f.item.id }, {
    note_kind: 'resolution_update', text: encodePeerResolutionRecord(application), parties: [] })),
  { code: 'COORDINATION_NOT_ACKNOWLEDGED' });
  assert.equal((await f.control.note(A, posted.item_id)).peer_resolution_state, 'stale');
});

test('task transition invalidates an active worker wait and subsequent mutation', async t => {
  const f = await selectedManaged(t);
  let generation = 1;
  f.control.workerAuthority = {
    assertCurrent: async actor => {
      if (actor.control_generation !== generation) throw Object.assign(new Error('adopted'), { code: 'PEER_OPERATION_STALE' });
    },
    assertConsentCurrent: async () => {},
  };
  const current = await f.control.workerPeerOperation(f.actor, full(f.actor, { operation_key: key(), kind: 'inspect' }));
  const waiting = f.control.workerPeerOperation(f.actor, full(f.actor, { operation_key: key(), kind: 'await_change',
    after_case_revision: current.case_revision, after_case_generation: current.case_generation,
    after_negotiation_cursor: current.negotiation_cursor }));
  await f.control.withWorkerTaskTransition(f.actor.task_id, async () => { generation++; });
  await assert.rejects(waiting, { code: 'PEER_OPERATION_STALE' });
  await assert.rejects(f.control.workerPeerOperation(f.actor, full(f.actor, { operation_key: key(), kind: 'propose',
    proposal: proposalFor(f, [{ work_id: f.work, work_revision: 1, input_oid: '1'.repeat(40), selected_commit_oid: '3'.repeat(40) }]) })),
  { code: 'PEER_OPERATION_STALE' });
  assert.equal((await f.disk()).notes.length, 0);
});

test('adoption invalidates already acknowledged worker consent for public application', async t => {
  const f = await selectedManaged(t);
  let generation = 1;
  f.control.workerAuthority = {
    assertCurrent: async actor => {
      if (actor.control_generation !== generation) throw Object.assign(new Error('adopted'), { code: 'PEER_OPERATION_STALE' });
    },
    assertConsentCurrent: async () => {
      if (generation !== 1) throw Object.assign(new Error('stale consent'), { code: 'PEER_OPERATION_STALE' });
    },
  };
  const proposal = proposalFor(f, [{ work_id: f.work, work_revision: 1, input_oid: '1'.repeat(40), selected_commit_oid: '3'.repeat(40) }]);
  const posted = await f.control.workerPeerOperation(f.actor, full(f.actor, { operation_key: key(), kind: 'propose', proposal }));
  await f.control.workerPeerOperation(f.actor, full(f.actor, { operation_key: key(), kind: 'acknowledge', note_id: posted.note_id }));
  assert.equal((await f.control.note(A, posted.note_id)).agreement, 'acknowledged');
  await f.control.withWorkerTaskTransition(f.actor.task_id, async () => { generation++; });
  assert.equal((await f.control.note(A, posted.note_id)).peer_resolution_state, 'stale');
  const application = { schema_version: 1, kind: 'peer_resolution_application', case_id: proposal.case_id,
    case_revision: proposal.case_revision, case_generation: proposal.case_generation,
    evidence_id: proposal.evidence_id, evidence_revision: proposal.evidence_revision,
    sources: proposal.sources, scope: proposal.scope, proposal_digest: proposal.resolution_digest,
    application_digest: 'c'.repeat(64), status: 'applied' };
  await assert.rejects(f.control.execute(A, post({ kind: 'case', id: f.item.id }, {
    note_kind: 'resolution_update', text: encodePeerResolutionRecord(application), parties: [] })),
  { code: 'PEER_OPERATION_STALE' });
  assert.equal((await f.disk()).notes.length, 1);
});

test('verification and retained application projection lose adopted worker consent', async t => {
  const f = await selectedManaged(t);
  let generation = 1;
  f.control.workerAuthority = {
    assertCurrent: async actor => {
      if (actor.control_generation !== generation) throw Object.assign(new Error('adopted'), { code: 'PEER_OPERATION_STALE' });
    },
    assertConsentCurrent: async () => {
      if (generation !== 1) throw Object.assign(new Error('stale consent'), { code: 'PEER_OPERATION_STALE' });
    },
  };
  const proposal = proposalFor(f, [{ work_id: f.work, work_revision: 1, input_oid: '1'.repeat(40), selected_commit_oid: '3'.repeat(40) }]);
  const posted = await f.control.workerPeerOperation(f.actor, full(f.actor, { operation_key: key(), kind: 'propose', proposal }));
  await f.control.workerPeerOperation(f.actor, full(f.actor, { operation_key: key(), kind: 'acknowledge', note_id: posted.note_id }));
  const application = { schema_version: 1, kind: 'peer_resolution_application', case_id: proposal.case_id,
    case_revision: proposal.case_revision, case_generation: proposal.case_generation,
    evidence_id: proposal.evidence_id, evidence_revision: proposal.evidence_revision,
    sources: proposal.sources, scope: proposal.scope, proposal_digest: proposal.resolution_digest,
    application_digest: 'c'.repeat(64), status: 'applied' };
  const subject = { kind: 'case', id: f.item.id };
  const applied = await f.control.execute(A, post(subject, { note_kind: 'resolution_update',
    text: encodePeerResolutionRecord(application), parties: [] }));
  const verification = { schema_version: 1, kind: 'peer_resolution_verification', case_id: proposal.case_id,
    case_revision: proposal.case_revision, case_generation: proposal.case_generation,
    evidence_id: proposal.evidence_id, evidence_revision: proposal.evidence_revision,
    sources: proposal.sources, scope: proposal.scope, application_digest: application.application_digest, status: 'passed' };
  const verified = await f.control.execute(A, post(subject, { note_kind: 'resolution_update',
    text: encodePeerResolutionRecord(verification), parties: [] }));
  assert.equal((await f.control.note(A, verified.item_id)).peer_resolution_state, 'current');
  await f.control.withWorkerTaskTransition(f.actor.task_id, async () => { generation++; });
  assert.equal((await f.control.note(A, applied.item_id)).peer_resolution_state, 'stale');
  assert.equal((await f.control.note(A, verified.item_id)).peer_resolution_state, 'stale');
  await assert.rejects(f.control.execute(A, post(subject, { note_kind: 'resolution_update',
    text: encodePeerResolutionRecord(verification), parties: [] })), { code: 'PEER_OPERATION_STALE' });
});

test('a started task intent recovers only its exact committed metadata receipt', async t => {
  const f = await selectedManaged(t), tasks = await taskFixture(t);
  await tasks.store.create(tasks.admission(tasks.request('recover-peer'), f.actor.task_id), tasks.initial(f.actor.task_id));
  const operation = full(f.actor, { operation_key: 'recover-propose', kind: 'propose',
    proposal: proposalFor(f, [{ work_id: f.work, work_revision: 1, input_oid: '1'.repeat(40), selected_commit_oid: '3'.repeat(40) }]) });
  await tasks.store.startPeerOperation(f.actor.task_id, operation);
  const committed = await f.control.workerPeerOperation(f.actor, operation);
  const original = tasks.store.settlePeerOperation.bind(tasks.store);
  tasks.store.settlePeerOperation = async () => { throw new Error('settlement interrupted'); };
  await assert.rejects(tasks.store.settlePeerOperation(f.actor.task_id, operation.operation_key, committed), /interrupted/);
  tasks.store.settlePeerOperation = original;
  assert.equal((await tasks.store.readPeerOperation(f.actor.task_id, operation.operation_key)).disposition, 'started');
  const recovered = await f.control.workerPeerCommittedReceipt(f.actor, operation);
  assert.deepEqual(recovered, committed);
  await tasks.store.settlePeerOperation(f.actor.task_id, operation.operation_key, recovered);
  assert.equal((await tasks.store.readPeerOperation(f.actor.task_id, operation.operation_key)).disposition, 'settled');
  assert.equal((await f.disk()).notes.length, 1);
  await assert.rejects(f.control.workerPeerCommittedReceipt(f.actor, { ...operation, proposal: { ...operation.proposal,
    resolution_digest: 'd'.repeat(64) } }), { code: 'COORDINATION_KEY_CONFLICT' });
});

test('pending worker authority leaves metadata reads and transitions free, then rejects stale mutation', async t => {
  const f = await selectedManaged(t), gate = deferred();
  f.control.workerAuthority = { assertCurrent: async () => { gate.enter(); await gate.blocked; },
    assertConsentCurrent: async () => {} };
  const operation = full(f.actor, { operation_key: key(), kind: 'propose', proposal: proposalFor(f,
    [{ work_id: f.work, work_revision: 1, input_oid: '1'.repeat(40), selected_commit_oid: '3'.repeat(40) }]) });
  const pending = f.control.workerPeerOperation(f.actor, operation);
  await within(gate.reached, 'worker authority entry');
  try {
    assert.equal((await within(f.control.reconciliation(A, f.item.id), 'metadata read')).id, f.item.id);
    await within(f.control.withWorkerTaskTransition(f.actor.task_id, async () => {}), 'task transition');
  } finally { gate.release(); }
  await assert.rejects(pending, { code: 'PEER_OPERATION_STALE' });
  assert.equal((await f.disk()).notes.length, 0);
});

test('metadata revision during worker authority validation rejects the old snapshot', async t => {
  const f = await selectedManaged(t), gate = deferred();
  f.control.workerAuthority = { assertCurrent: async () => { gate.enter(); await gate.blocked; },
    assertConsentCurrent: async () => {} };
  const operation = full(f.actor, { operation_key: key(), kind: 'propose', proposal: proposalFor(f,
    [{ work_id: f.work, work_revision: 1, input_oid: '1'.repeat(40), selected_commit_oid: '3'.repeat(40) }]) });
  const pending = f.control.workerPeerOperation(f.actor, operation);
  await within(gate.reached, 'revision authority entry');
  try {
    await within(f.control.execute(A, post({ kind: 'case', id: f.item.id })), 'unrelated metadata post');
  } finally { gate.release(); }
  await assert.rejects(pending, { code: 'PEER_OPERATION_STALE' });
  assert.equal((await f.disk()).notes.length, 1);
});

test('pending retained-result and receipt authority cannot disclose across a transition', async t => {
  const f = await selectedManaged(t);
  const operation = full(f.actor, { operation_key: key(), kind: 'propose', proposal: proposalFor(f,
    [{ work_id: f.work, work_revision: 1, input_oid: '1'.repeat(40), selected_commit_oid: '3'.repeat(40) }]) });
  const result = await f.control.workerPeerOperation(f.actor, operation);
  for (const disclose of [() => f.control.workerPeerStoredResult(f.actor, operation, result),
    () => f.control.workerPeerCommittedReceipt(f.actor, operation)]) {
    const gate = deferred();
    f.control.workerAuthority = { assertCurrent: async () => { gate.enter(); await gate.blocked; },
      assertConsentCurrent: async () => {} };
    const pending = disclose();
    await within(gate.reached, 'retained authority entry');
    try {
      assert.equal((await within(f.control.reconciliation(A, f.item.id), 'retained metadata read')).id, f.item.id);
      await within(f.control.withWorkerTaskTransition(f.actor.task_id, async () => {}), 'retained task transition');
    } finally { gate.release(); }
    await assert.rejects(pending, { code: 'PEER_OPERATION_STALE' });
  }
});

test('pending public consent cannot post or project across a transition', async t => {
  const f = await selectedManaged(t);
  const proposal = proposalFor(f, [{ work_id: f.work, work_revision: 1,
    input_oid: '1'.repeat(40), selected_commit_oid: '3'.repeat(40) }]);
  const posted = await f.control.workerPeerOperation(f.actor, full(f.actor, { operation_key: key(), kind: 'propose', proposal }));
  await f.control.workerPeerOperation(f.actor, full(f.actor, { operation_key: key(), kind: 'acknowledge', note_id: posted.note_id }));
  const application = { schema_version: 1, kind: 'peer_resolution_application', case_id: proposal.case_id,
    case_revision: proposal.case_revision, case_generation: proposal.case_generation, evidence_id: proposal.evidence_id,
    evidence_revision: proposal.evidence_revision, sources: proposal.sources, scope: proposal.scope,
    proposal_digest: proposal.resolution_digest, application_digest: 'c'.repeat(64), status: 'applied' };
  for (const useConsent of [() => f.control.note(A, posted.note_id),
    () => f.control.execute(A, post({ kind: 'case', id: f.item.id }, {
      note_kind: 'resolution_update', text: encodePeerResolutionRecord(application) }))]) {
    const gate = deferred();
    f.control.workerAuthority = { assertCurrent: async () => {},
      assertConsentCurrent: async () => { gate.enter(); await gate.blocked; } };
    const pending = useConsent();
    await within(gate.reached, 'public consent entry');
    try {
      assert.equal((await within(f.control.reconciliation(A, f.item.id), 'public metadata read')).id, f.item.id);
      await within(f.control.withWorkerTaskTransition(f.actor.task_id, async () => {}), 'public task transition');
    } finally { gate.release(); }
    await assert.rejects(pending, { code: 'PEER_OPERATION_STALE' });
  }
  assert.equal((await f.disk()).notes.length, 1);
});

test('shared service transition markers reject selected worker operations without a callback', async t => {
  const f = await selectedManaged(t), markers = new Set([f.actor.task_id]);
  const control = new CoordinationControl(f.store, f.control.workerAuthority, markers);
  const operation = full(f.actor, { operation_key: key(), kind: 'inspect' });
  await assert.rejects(control.workerPeerOperation(f.actor, operation), { code: 'PEER_OPERATION_STALE' });
  markers.delete(f.actor.task_id);
  assert.equal((await control.workerPeerOperation(f.actor, operation)).kind, 'current');
});

test('close drains a deferred authority refresh after rejecting the peer wait', async t => {
  const f = await selectedManaged(t), gate = deferred();
  let checks = 0;
  f.control.workerAuthority = {
    assertCurrent: async () => { if (++checks === 2) { gate.enter(); await gate.blocked; } },
    assertConsentCurrent: async () => {},
  };
  const wait = f.control.workerPeerOperation(f.actor, full(f.actor, { operation_key: key(), kind: 'await_change',
    after_case_revision: f.item.revision, after_case_generation: f.item.generation }));
  const rejected = assert.rejects(wait, { code: 'COORDINATION_CLOSED' });
  await within(f.control.reconciliation(A, f.item.id), 'wait admission');
  await f.control.execute(A, caseOp('select_inputs', f.item, { target_oid: '2'.repeat(40),
    inputs: [{ work_id: f.work, commit_oid: '3'.repeat(40) }] }));
  await within(gate.reached, 'refresh authority entry');
  let closed = false;
  const closing = f.control.close().then(() => { closed = true; });
  try {
    await rejected;
    await Promise.resolve();
    assert.equal(closed, false);
  } finally { gate.release(); }
  await within(closing, 'refresh drain');
  assert.equal(closed, true);
});
