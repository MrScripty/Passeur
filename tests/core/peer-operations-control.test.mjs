import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, A, key, register, claim, caseOp, post } from '../fixtures/structural/coordination-fixture.mjs';
import { encodePeerResolutionRecord, PEER_RESOLUTION_ACTIONS } from '../../.passeur-core/src/coordination/peer-resolution.js';

const full = (actor, operation) => { const { owner_id: _owner, ...identity } = actor; return { schema_version: 1, ...identity, ...operation }; };

async function selectedManaged(t) {
  const f = await fixture(t), source_view = '/source/repository';
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
    after_case_revision: f.item.revision, after_case_generation: f.item.generation }));
  await f.control.execute(A, post({ kind: 'case', id: f.item.id }));
  const changed = await wait;
  assert.equal(changed.kind, 'current'); assert.equal(changed.operation, 'await_change');
  const refreshed = await f.control.reconciliation(A, f.item.id);
  await f.control.execute(A, caseOp('select_inputs', refreshed, { target_oid: '4'.repeat(40), inputs: [{ work_id: f.work, commit_oid: '3'.repeat(40) }] }));
  assert.deepEqual(await f.control.workerPeerOperation(f.actor, operation), receipt);

  await assert.rejects(f.control.workerPeerOperation({ ...f.actor, workspace_id: 'workspace:forged' },
    full({ ...f.actor, workspace_id: 'workspace:forged' }, { operation_key: 'forged', kind: 'inspect' })), { code: 'PEER_OPERATION_FORBIDDEN' });
  await assert.rejects(f.control.workerPeerOperation(f.actor, full(f.actor, { operation_key: 'effect', kind: 'apply' })), { code: 'PEER_OPERATION_UNSUPPORTED' });
});
