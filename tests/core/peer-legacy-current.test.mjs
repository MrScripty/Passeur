import test from 'node:test';
import assert from 'node:assert/strict';
import { decodePeerWorkerOperationResult } from '../../.passeur-core/src/contracts/peer-operations.js';
import { peerOperationResultPrompt } from '../../.passeur-core/src/agents/report-format.js';

test('legacy current result with participants decodes twice and renders for the worker', () => {
  const task_id = '11111111-1111-4111-8111-111111111111';
  const case_id = '22222222-2222-4222-8222-222222222222';
  const operation_key = 'legacy-inspect';
  const legacy = { schema_version: 1, task_id, run_id: '33333333-3333-4333-8333-333333333333',
    control_generation: 1, workspace_id: 'git-worktree-v1:' + 'a'.repeat(64), source_view: '/source',
    case_id, operation_key, kind: 'current', operation: 'inspect', case_revision: 1, case_generation: 1,
    evidence_id: 'b'.repeat(64), evidence_revision: 1, negotiation_cursor: 'c'.repeat(64),
    participant_task_ids: [task_id], acknowledged_task_ids: [], proposal_note_id: null, proposal: null };
  const once = decodePeerWorkerOperationResult(legacy);
  assert.equal(once.first_proposal, null);
  assert.deepEqual(once.selected_work_context, []);
  assert.equal(once.selected_work_omitted, 1);
  assert.equal(once.application_outcome, null);
  assert.deepEqual(decodePeerWorkerOperationResult(once), once);
  assert.throws(() => decodePeerWorkerOperationResult({ ...once, application_outcome: {
    proposal_note_id: case_id, application_note_id: case_id, status: 'pending',
    proposal_digest: 'd'.repeat(64), application_digest: 'e'.repeat(64) } }),
  { code: 'PEER_OPERATION_INVALID' });
  const prompt = peerOperationResultPrompt(task_id,
    { schema_version: 1, operation_key, case_id, kind: 'inspect' }, once);
  assert.match(prompt, /"participant_task_ids":\["11111111-1111-4111-8111-111111111111"\]/);
  assert.match(prompt, /"selected_work_omitted":1/);
});
