import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, A, key, claim, caseOp } from '../fixtures/structural/coordination-fixture.mjs';
import { decodePeerWorkerOperationResult } from '../../.passeur-core/src/contracts/peer-operations.js';
import { parseWorkerMessage } from '../../.passeur-core/src/agents/report.js';
import { peerOperationResultPrompt } from '../../.passeur-core/src/agents/report-format.js';

const sourceView = '/source/repository';
const request = (actor, operation) => {
  const { owner_id: _owner, ...identity } = actor;
  return { schema_version: 1, ...identity, ...operation };
};

test('the first valid worker proposal needs only inspect and the worker chosen effect', async t => {
  const f = await fixture(t);
  let captureId = 'e'.repeat(64);
  f.control.workerAuthority = { assertCurrent: async () => {}, assertConsentCurrent: async () => {},
    captureEvidenceId: async () => captureId };
  const actors = [];
  for (let index = 0; index < 2; index++) {
    const task_id = randomUUID(), workspace_id = `workspace:${key()}`;
    const bound = await f.control.bindSubmission(A, { operation_key: `passeur-internal:${key()}`, task_id,
      request_key: key(), source_view: sourceView, input_oid: '1'.repeat(40), intent_hash: '2'.repeat(64),
      areas: [{ kind: 'subtree', path: 'src' }] });
    await f.control.settleSubmission(A, { operation_key: `passeur-internal:${key()}`, task_id,
      request_key: bound.request_key, link_hash: bound.link_hash });
    await f.control.execute(A, { kind: 'register_task_work', operation_key: key(), workspace_id,
      input_oid: '1'.repeat(40), object_format: 'sha1', intent: `worker ${index}`,
      areas: [{ kind: 'subtree', path: 'src' }],
      managed: { task_id, control_generation: 1, intent_truncated: false, areas_source: 'allowed_paths' } });
    actors.push({ owner_id: A.owner_id, task_id, run_id: randomUUID(), control_generation: 1,
      workspace_id, source_view: sourceView });
  }
  const claimed = await f.control.execute(A, claim());
  const item = await f.control.reconciliation(A, claimed.item_id);
  await f.control.execute(A, caseOp('select_inputs', item, { target_oid: '2'.repeat(40), inputs: actors.map((actor, index) =>
    ({ work_id: actor.task_id, commit_oid: (index ? '4' : '3').repeat(40) })) }));
  const worker = { ...actors[0], case_id: item.id };

  // The proposal is assembled after this point without a parent case or work read.
  const inspected = await f.control.workerPeerOperation(worker, request(worker, { kind: 'inspect', operation_key: key() }));
  const current = decodePeerWorkerOperationResult(inspected);
  const presented = peerOperationResultPrompt(worker.task_id,
    { schema_version: 1, kind: 'inspect', case_id: item.id, operation_key: current.operation_key }, current);
  assert.match(presented, /"first_proposal":\{/);
  assert.match(presented, /Omit resolution_digest; Passeur derives it/);
  assert.equal(current.proposal, null);
  assert.deepEqual(current.participant_task_ids, actors.map(actor => actor.task_id));
  assert.deepEqual(current.selected_work_context.map(work => work.intent_excerpt), ['worker 0', 'worker 1']);
  assert.deepEqual(current.selected_work_context[0].declared_areas, [{ kind: 'subtree', path: 'src' }]);
  assert.equal(current.selected_work_omitted, 0);
  assert.equal(current.first_proposal.sources.length, 2);
  assert.deepEqual(current.first_proposal.sources.map(source => source.selected_commit_oid), ['3'.repeat(40), '4'.repeat(40)]);
  const summary = 'Combine the two workers’ changes to src/a.ts';
  const changes = [{ path: 'src/a.ts', before_sha256: null,
    after_base64: Buffer.from('export const combined = true;\n').toString('base64') }];
  const proposal = { ...current.first_proposal, scope: [{ kind: 'file', path: 'src/a.ts' }],
    summary, changes };
  const reordered = changes.map(change => ({ after_base64: change.after_base64, path: change.path,
    before_sha256: change.before_sha256 }));
  const operation = { schema_version: 1, kind: 'propose', case_id: current.case_id, operation_key: key(),
    proposal: { ...proposal, changes: reordered } };
  const parsed = parseWorkerMessage(`PASSEUR_MESSAGE ${JSON.stringify({ schema_version: 2, kind: 'peer_operation', operation })}`);
  assert.equal(parsed.kind, 'peer_operation');
  assert.match(parsed.operation.proposal.resolution_digest, /^[a-f0-9]{64}$/);
  const canonical = parseWorkerMessage(`PASSEUR_MESSAGE ${JSON.stringify({ schema_version: 2, kind: 'peer_operation',
    operation: { ...operation, proposal } })}`);
  assert.equal(parsed.operation.proposal.resolution_digest, canonical.operation.proposal.resolution_digest);
  assert.equal(parseWorkerMessage(`PASSEUR_MESSAGE ${JSON.stringify({ schema_version: 2,
    kind: 'peer_operation', operation: { ...operation,
      proposal: { ...proposal, changes: [{ ...reordered[0], unexpected: true }] } } })}`).kind,
  'peer_proposal_invalid');
  assert.equal(parseWorkerMessage(`PASSEUR_MESSAGE ${JSON.stringify({ schema_version: 2,
    kind: 'peer_operation', operation: { ...operation, proposal: { ...proposal, resolution_digest: '0'.repeat(64) } } })}`).kind,
  'peer_proposal_invalid');
  const receipt = await f.control.workerPeerOperation(worker, request(worker, parsed.operation));
  assert.equal(receipt.kind, 'receipt');
  assert.equal(receipt.operation, 'propose');
  const after = await f.control.workerPeerOperation(worker, request(worker, { kind: 'inspect', operation_key: key() }));
  assert.equal(after.proposal_note_id, receipt.note_id);
  assert.equal(after.first_proposal, null);
  assert.deepEqual(after.proposal.sources, current.first_proposal.sources);
  const sibling = { ...actors[1], case_id: item.id };
  for (const actor of [worker, sibling]) await f.control.workerPeerOperation(actor,
    request(actor, { kind: 'acknowledge', operation_key: key(), note_id: receipt.note_id }));
  const agreed = await f.control.workerPeerOperation(worker,
    request(worker, { kind: 'inspect', operation_key: key() }));

  captureId = 'f'.repeat(64);
  const changedEvidence = await f.control.workerPeerOperation(worker,
    request(worker, { kind: 'inspect', operation_key: key() }));
  assert.equal(changedEvidence.proposal, null);
  assert.equal(changedEvidence.first_proposal.evidence_id, captureId);
  await assert.rejects(f.control.workerPeerOperation(worker,
    request(worker, { kind: 'propose', operation_key: key(), proposal: parsed.operation.proposal })),
  { code: 'COORDINATION_STALE_REVISION' });
  await assert.rejects(f.control.workerPeerOperation(worker,
    request(worker, { kind: 'acknowledge', operation_key: key(), note_id: receipt.note_id })),
  { code: 'COORDINATION_STALE_REVISION' });
  await assert.rejects(f.control.workerPeerStoredResult(worker,
    request(worker, { kind: 'inspect', operation_key: agreed.operation_key }), agreed),
  { code: 'PEER_OPERATION_STALE' });
  let effectRan = false;
  await assert.rejects(f.control.withWorkerApplication(worker,
    request(worker, { kind: 'apply', operation_key: key(), note_id: receipt.note_id,
      expected_case_revision: after.case_revision, expected_case_generation: after.case_generation,
      proposal_digest: after.proposal.resolution_digest }), async () => { effectRan = true; throw Error('unexpected effect'); }),
  { code: 'COORDINATION_STALE_REVISION' });
  assert.equal(effectRan, false);
  captureId = 'e'.repeat(64);

  const successor = { ...after.proposal, action: 'counter_propose', proposal_revision: 2,
    predecessor_digest: after.proposal.resolution_digest, summary: 'Use the refined combined source',
    changes: reordered };
  delete successor.resolution_digest;
  const counter = { schema_version: 1, kind: 'counter_propose', case_id: current.case_id,
    operation_key: key(), proposal: successor };
  const parsedCounter = parseWorkerMessage(`PASSEUR_MESSAGE ${JSON.stringify({ schema_version: 2,
    kind: 'peer_operation', operation: counter })}`);
  assert.equal(parsedCounter.kind, 'peer_operation');
  assert.match(parsedCounter.operation.proposal.resolution_digest, /^[a-f0-9]{64}$/);
  const canonicalCounter = parseWorkerMessage(`PASSEUR_MESSAGE ${JSON.stringify({ schema_version: 2,
    kind: 'peer_operation', operation: { ...counter, proposal: { ...successor, changes } } })}`);
  assert.equal(parsedCounter.operation.proposal.resolution_digest,
    canonicalCounter.operation.proposal.resolution_digest);
  assert.equal(parseWorkerMessage(`PASSEUR_MESSAGE ${JSON.stringify({ schema_version: 2,
    kind: 'peer_operation', operation: { ...counter,
      proposal: { ...successor, changes: [{ after_base64: changes[0].after_base64,
        path: changes[0].path }] } } })}`).kind,
  'peer_proposal_invalid');
  const counterReceipt = await f.control.workerPeerOperation(worker, request(worker, parsedCounter.operation));
  assert.equal(counterReceipt.operation, 'counter_propose');

  const selected = await f.control.reconciliation(A, item.id);
  await f.control.execute(A, caseOp('select_inputs', selected, { target_oid: '2'.repeat(40),
    inputs: actors.map((actor, index) => ({ work_id: actor.task_id,
      commit_oid: (index ? '4' : '5').repeat(40) })) }));
  await assert.rejects(f.control.workerPeerRetainedResult(worker,
    request(worker, { kind: 'inspect', operation_key: current.operation_key }), current),
  { code: 'STRUCTURAL_SOURCE_FORBIDDEN' });
});
