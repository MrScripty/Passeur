import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, A, key, claim, caseOp, post } from '../fixtures/structural/coordination-fixture.mjs';
import { peerResolutionDigest } from '../../.passeur-core/src/coordination/peer-resolution.js';
import { BridgeError } from '../../.passeur-core/src/core/errors.js';
import { peerOperationResultPrompt } from '../../.passeur-core/src/agents/report-format.js';

const sourceView = '/source/repository';
const request = (actor, operation) => {
  const { owner_id: _owner, ...identity } = actor;
  return { schema_version: 1, ...identity, ...operation };
};

async function agreed(t) {
  const f = await fixture(t);
  let captureId = 'e'.repeat(64);
  f.control.workerAuthority = { assertCurrent: async () => {}, assertConsentCurrent: async () => {},
    captureEvidenceId: async () => captureId };
  const task_id = randomUUID(), workspace_id = `workspace:${key()}`;
  const bound = await f.control.bindSubmission(A, { operation_key: `passeur-internal:${key()}`, task_id,
    request_key: key(), source_view: sourceView, input_oid: '1'.repeat(40), intent_hash: '2'.repeat(64),
    areas: [{ kind: 'subtree', path: 'src' }] });
  await f.control.settleSubmission(A, { operation_key: `passeur-internal:${key()}`, task_id,
    request_key: bound.request_key, link_hash: bound.link_hash });
  await f.control.execute(A, { kind: 'register_task_work', operation_key: key(), workspace_id,
    input_oid: '1'.repeat(40), object_format: 'sha1', intent: 'worker result',
    areas: [{ kind: 'subtree', path: 'src' }],
    managed: { task_id, control_generation: 1, intent_truncated: false, areas_source: 'allowed_paths' } });
  const claimed = await f.control.execute(A, claim());
  const item = await f.control.reconciliation(A, claimed.item_id);
  await f.control.execute(A, caseOp('select_inputs', item, { target_oid: '2'.repeat(40),
    inputs: [{ work_id: task_id, commit_oid: '3'.repeat(40) }] }));
  const actor = { owner_id: A.owner_id, task_id, run_id: randomUUID(), control_generation: 1,
    workspace_id, source_view: sourceView, case_id: item.id };
  const current = await f.control.workerPeerOperation(actor, request(actor, { kind: 'inspect', operation_key: key() }));
  const summary = 'Apply the agreed combined result';
  const changes = [{ path: 'src/a.ts', before_sha256: null, after_base64: Buffer.from('combined\n').toString('base64') }];
  const proposal = { ...current.first_proposal, summary, changes, scope: [{ kind: 'file', path: 'src/a.ts' }],
    resolution_digest: peerResolutionDigest(summary, changes) };
  const proposed = await f.control.workerPeerOperation(actor,
    request(actor, { kind: 'propose', operation_key: key(), proposal }));
  await f.control.workerPeerOperation(actor,
    request(actor, { kind: 'acknowledge', operation_key: key(), note_id: proposed.note_id }));
  const operation = request(actor, { kind: 'apply', operation_key: key(), note_id: proposed.note_id,
    expected_case_revision: current.case_revision, expected_case_generation: current.case_generation,
    proposal_digest: proposal.resolution_digest });
  const result = { schema_version: 1, task_id, run_id: actor.run_id, control_generation: 1,
    workspace_id, source_view: sourceView, case_id: item.id, operation_key: operation.operation_key,
    kind: 'application', operation: 'apply', note_id: proposed.note_id,
    status: 'applied', application_digest: 'f'.repeat(64), paths: ['src/a.ts'] };
  return { ...f, actor, operation, result, setCaptureId: value => { captureId = value; } };
}

test('exact settled apply replay does not run another effect after source bytes change', async t => {
  const f = await agreed(t);
  let writes = 0;
  await assert.rejects(f.control.withWorkerApplication(f.actor, f.operation, async () => {
    writes++; throw new Error('unadmitted effect must not run');
  }, undefined, f.result), { code: 'PEER_OPERATION_RECOVERY_REQUIRED' });
  assert.equal(writes, 0);
  const first = await f.control.withWorkerApplication(f.actor, f.operation, async () => {
    writes++; f.setCaptureId('d'.repeat(64)); return f.result;
  });
  assert.deepEqual(first, f.result);
  const replay = await f.control.withWorkerApplication(f.actor, f.operation, async () => {
    writes++; throw new Error('second effect must not run');
  }, undefined, f.result);
  assert.deepEqual(replay, first);
  assert.equal(writes, 1);
  const observed = await f.control.workerPeerOperation(f.actor,
    request(f.actor, { kind: 'inspect', operation_key: key() }));
  assert.equal(observed.proposal, null);
  assert.equal(observed.application_outcome.status, 'applied');
  assert.equal(observed.application_outcome.proposal_note_id, f.operation.note_id);
  assert.equal(observed.application_outcome.proposal_digest, f.operation.proposal_digest);
  assert.equal(observed.application_outcome.application_digest, f.result.application_digest);
});

test('exact retained inspection remains disclosable after ambient capture changes', async t => {
  const f = await agreed(t);
  const operation = request(f.actor, { kind: 'inspect', operation_key: key() });
  const captured = await f.control.workerPeerOperation(f.actor, operation);
  f.setCaptureId('d'.repeat(64));
  assert.deepEqual(await f.control.workerPeerRetainedResult(f.actor, operation, captured), captured);
  await assert.rejects(f.control.workerPeerStoredResult(f.actor, operation, captured), { code: 'PEER_OPERATION_STALE' });
});

test('retained inspection survives a sibling case note posted during disclosure', async t => {
  const f = await agreed(t);
  const operation = request(f.actor, { kind: 'inspect', operation_key: key() });
  const captured = await f.control.workerPeerOperation(f.actor, operation);
  let release, entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const reached = new Promise(resolve => { entered = resolve; });
  f.control.workerAuthority = { ...f.control.workerAuthority,
    assertRetainedSources: async () => { entered(); await blocked; } };
  const disclosure = f.control.workerPeerRetainedResult(f.actor, operation, captured);
  await reached;
  await f.control.execute(A, post({ kind: 'case', id: f.actor.case_id }));
  release();
  assert.deepEqual(await disclosure, captured);
});

test('await_change remains pending during a reserved effect and wakes on its durable outcome', async t => {
  const f = await agreed(t);
  const inspected = await f.control.workerPeerOperation(f.actor,
    request(f.actor, { kind: 'inspect', operation_key: key() }));
  let settled = false;
  const waiting = f.control.workerPeerOperation(f.actor, request(f.actor, { kind: 'await_change',
    operation_key: key(), after_case_revision: inspected.case_revision,
    after_case_generation: inspected.case_generation,
    after_negotiation_cursor: inspected.negotiation_cursor }))
    .finally(() => { settled = true; });
  let release, entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const reached = new Promise(resolve => { entered = resolve; });
  const applying = f.control.withWorkerApplication(f.actor, f.operation, async () => {
    entered(); await blocked; f.setCaptureId('d'.repeat(64)); return f.result;
  });
  await reached;
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(settled, false);
  release();
  assert.equal((await applying).status, 'applied');
  const changed = await waiting;
  assert.equal(changed.kind, 'current');
  assert.equal(changed.application_outcome.status, 'applied');
  assert.equal(changed.application_outcome.proposal_note_id, f.operation.note_id);
});

test('source-only capture notification wakes await_change only for changed evidence bytes', async t => {
  const f = await agreed(t);
  const inspected = await f.control.workerPeerOperation(f.actor,
    request(f.actor, { kind: 'inspect', operation_key: key() }));
  let settled = false;
  const waiting = f.control.workerPeerOperation(f.actor, request(f.actor, { kind: 'await_change',
    operation_key: key(), after_case_revision: inspected.case_revision,
    after_case_generation: inspected.case_generation,
    after_negotiation_cursor: inspected.negotiation_cursor })).finally(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 25));
  await f.control.notifyWorkerPeerCaptureChanged(f.actor.task_id, 'src/a.ts');
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(settled, false, 'identical capture must not wake the worker');
  f.setCaptureId('d'.repeat(64));
  await f.control.notifyWorkerPeerCaptureChanged(f.actor.task_id, 'src/a.ts');
  const changed = await Promise.race([waiting, new Promise((_, reject) =>
    setTimeout(() => reject(new Error('source-only evidence change did not wake await_change')), 1000))]);
  assert.equal(changed.kind, 'current');
  assert.equal(changed.case_revision, inspected.case_revision);
  assert.notEqual(changed.negotiation_cursor, inspected.negotiation_cursor);
  assert.equal(changed.evidence_id, 'd'.repeat(64));
  assert.equal(changed.proposal, null);
  assert.equal(changed.first_proposal.evidence_id, 'd'.repeat(64));
});

test('await_change sees a source edit between inspect and wait registration while identical recapture stays pending', async t => {
  const f = await agreed(t);
  const before = await f.control.workerPeerOperation(f.actor,
    request(f.actor, { kind: 'inspect', operation_key: key() }));
  f.setCaptureId('d'.repeat(64));
  await f.control.notifyWorkerPeerCaptureChanged(f.actor.task_id, 'src/a.ts');
  const delayed = await Promise.race([f.control.workerPeerOperation(f.actor,
    request(f.actor, { kind: 'await_change', operation_key: key(),
      after_case_revision: before.case_revision, after_case_generation: before.case_generation,
      after_negotiation_cursor: before.negotiation_cursor })),
  new Promise((_, reject) => setTimeout(() => reject(new Error('delayed await did not see changed source')), 1000))]);
  assert.equal(delayed.kind, 'current');
  assert.equal(delayed.case_revision, before.case_revision);
  assert.equal(delayed.evidence_id, 'd'.repeat(64));
  assert.notEqual(delayed.negotiation_cursor, before.negotiation_cursor);
  let settled = false;
  const waiting = f.control.workerPeerOperation(f.actor,
    request(f.actor, { kind: 'await_change', operation_key: key(),
      after_case_revision: delayed.case_revision, after_case_generation: delayed.case_generation,
      after_negotiation_cursor: delayed.negotiation_cursor })).finally(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 25));
  await f.control.notifyWorkerPeerCaptureChanged(f.actor.task_id, 'src/a.ts');
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(settled, false, 'identical recapture must preserve the inspected cursor');
  f.setCaptureId('f'.repeat(64));
  await f.control.notifyWorkerPeerCaptureChanged(f.actor.task_id, 'src/a.ts');
  const changed = await Promise.race([waiting, new Promise((_, reject) =>
    setTimeout(() => reject(new Error('subsequent changed source did not wake await')), 1000))]);
  assert.equal(changed.evidence_id, 'f'.repeat(64));
  assert.notEqual(changed.negotiation_cursor, delayed.negotiation_cursor);
});

test('loss of the last selected overlap wakes await_change with no fabricated evidence identity', async t => {
  const f = await agreed(t);
  const inspected = await f.control.workerPeerOperation(f.actor,
    request(f.actor, { kind: 'inspect', operation_key: key() }));
  const waiting = f.control.workerPeerOperation(f.actor, request(f.actor, { kind: 'await_change',
    operation_key: key(), after_case_revision: inspected.case_revision,
    after_case_generation: inspected.case_generation,
    after_negotiation_cursor: inspected.negotiation_cursor }));
  await new Promise(resolve => setTimeout(resolve, 25));
  f.control.workerAuthority = { ...f.control.workerAuthority,
    captureEvidenceId: async () => { throw new BridgeError('PEER_OPERATION_NO_CURRENT_OVERLAP',
      'Selected case has no current captured overlap'); } };
  await f.control.notifyWorkerPeerCaptureChanged(f.actor.task_id, 'src/a.ts');
  const changed = await Promise.race([waiting, new Promise((_, reject) =>
    setTimeout(() => reject(new Error('last overlap removal did not wake await_change')), 1000))]);
  assert.equal(changed.kind, 'current');
  assert.equal(changed.case_revision, inspected.case_revision);
  assert.notEqual(changed.negotiation_cursor, inspected.negotiation_cursor);
  assert.equal(changed.evidence_status, 'unavailable');
  assert.equal(changed.evidence_id, null);
  assert.equal(changed.evidence_revision, null);
  assert.equal(changed.proposal, null);
  assert.equal(changed.first_proposal, null);
  const prompt = peerOperationResultPrompt(f.actor.task_id,
    { schema_version: 1, operation_key: changed.operation_key, case_id: f.actor.case_id, kind: 'await_change',
      after_case_revision: inspected.case_revision, after_case_generation: inspected.case_generation,
      after_negotiation_cursor: inspected.negotiation_cursor }, changed);
  assert.match(prompt, /"evidence_status":"unavailable","evidence_id":null/);
  const again = await f.control.workerPeerOperation(f.actor,
    request(f.actor, { kind: 'inspect', operation_key: key() }));
  assert.equal(again.evidence_status, 'unavailable');
  await assert.rejects(f.control.workerPeerOperation(f.actor,
    request(f.actor, { kind: 'acknowledge', operation_key: key(), note_id: f.operation.note_id })),
  { code: 'PEER_OPERATION_NO_CURRENT_OVERLAP' });
});

test('historical applied outcome uses actor-only disclosure without recapturing changed source', async t => {
  const f = await agreed(t);
  await f.control.withWorkerApplication(f.actor, f.operation, async () => {
    f.setCaptureId('d'.repeat(64)); return f.result;
  });
  const flags = [];
  f.control.workerAuthority = {
    assertCurrent: async (_actor, _state, _item, historicalOutcome) => {
      flags.push(historicalOutcome);
      if (!historicalOutcome) throw new Error('sibling source is no longer live');
    },
    assertConsentCurrent: async () => {},
    captureEvidenceId: async () => { throw new Error('applied bytes are not the proposal baseline'); },
    withPublication: async (_state, _item, _actor, _sources, publish, _consent, historicalOutcome) => {
      assert.equal(historicalOutcome, true); return publish();
    },
  };
  const observed = await f.control.workerPeerOperation(f.actor,
    request(f.actor, { kind: 'inspect', operation_key: key() }));
  assert.equal(observed.proposal, null);
  assert.equal(observed.first_proposal, null);
  assert.equal(observed.application_outcome.status, 'applied');
  assert.ok(flags.length >= 2 && flags.every(Boolean));
});

test('settled result reconciles a missing case outcome after a failed publication without a second write', async t => {
  const f = await agreed(t);
  const publish = f.store.publish.bind(f.store);
  let writes = 0;
  await assert.rejects(f.control.withWorkerApplication(f.actor, f.operation, async () => {
    writes++; f.setCaptureId('d'.repeat(64));
    f.store.publish = async () => { f.store.publish = publish; throw new Error('simulated crash after effect'); };
    return f.result;
  }), /simulated crash after effect/);
  const before = await f.store.snapshot();
  assert.equal(before.receipts.filter(receipt => receipt.key.endsWith(':pending')).length, 1);
  assert.equal(before.receipts.filter(receipt => receipt.key.endsWith(':outcome')).length, 0);
  const beforeOutcome = await f.control.workerPeerOperation(f.actor,
    request(f.actor, { kind: 'inspect', operation_key: key() }));
  assert.equal(beforeOutcome.application_outcome, null);
  const replay = await f.control.withWorkerApplication(f.actor, f.operation, async () => {
    writes++; throw new Error('second effect must not run');
  }, undefined, f.result);
  assert.deepEqual(replay, f.result);
  assert.equal(writes, 1);
  const after = await f.store.snapshot();
  assert.equal(after.receipts.filter(receipt => receipt.key.endsWith(':outcome')).length, 1);
  const observed = await f.control.workerPeerOperation(f.actor,
    request(f.actor, { kind: 'inspect', operation_key: key() }));
  assert.equal(observed.application_outcome.status, 'applied');
  assert.equal(observed.application_outcome.application_note_id,
    after.receipts.find(receipt => receipt.key.endsWith(':outcome')).item_id);
});
