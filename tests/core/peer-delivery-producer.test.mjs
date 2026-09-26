import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { peerDeliveryCandidate } from '../../.passeur-core/src/core/repository-runtime.js';
import { parsePeerDeliverySource } from '../../.passeur-core/src/contracts/peer-delivery.js';

const recipientTaskId = randomUUID();
const sourceId = randomUUID(), targetId = randomUUID();
const artifactId = 'a'.repeat(64);
const source = { id: sourceId, owner: 'b'.repeat(64), workspace_id: 'source', revision: 3,
  state: 'active', input_oid: '1'.repeat(40), object_format: 'sha1', intent: '', areas: [], readers: [] };
const target = { ...source, id: targetId, owner: 'c'.repeat(64), workspace_id: 'target',
  managed: { task_id: recipientTaskId, control_generation: 2, intent_truncated: false, areas_source: 'allowed_paths' } };
const peerCase = { id: randomUUID(), target: 'refs/heads/main', lead: target.owner, members: [source.owner, target.owner],
  revision: 4, generation: 2, state: 'active', external_effect: 'not_started', target_oid: '1'.repeat(40),
  inputs: [{ work_id: sourceId, commit_oid: '2'.repeat(40) }, { work_id: targetId, commit_oid: '3'.repeat(40) }] };
const pair = { current_work_id: sourceId, other_work_id: targetId, subject_id: 'd'.repeat(64),
  pair_id: 'e'.repeat(64), input: { kind: 'commit', repository_id: 'repo', object_format: 'sha1',
    commit_oid: '1'.repeat(40), tree_oid: '2'.repeat(40), path: 'src/important.ts' },
  input_range: { start_byte: 10, end_byte: 25 },
  current_change: { kind: 'modified', declaration_changed: false, body_changed: true,
    default_changed: false, evidence_id: 'f'.repeat(64) },
  other_change: { kind: 'modified', declaration_changed: true, body_changed: false,
    default_changed: false, evidence_id: '0'.repeat(64) } };

test('selected managed target gets stable, bounded source-grounded evidence with explicit limitations', () => {
  const candidate = peerDeliveryCandidate(pair, peerCase, source, target, recipientTaskId, artifactId);
  assert.deepEqual(candidate, peerDeliveryCandidate(pair, peerCase, source, target, recipientTaskId, artifactId));
  assert.deepEqual(parsePeerDeliverySource(candidate), candidate);
  assert.equal(candidate.source_work_revision, source.revision);
  assert.equal(candidate.case_revision, peerCase.revision);
  assert.equal(candidate.case_generation, peerCase.generation);
  assert.ok(Buffer.byteLength(candidate.content) < 16_384);
  const content = JSON.parse(candidate.content);
  assert.equal(content.source_artifact_id, artifactId);
  assert.equal(content.input.commit_oid, pair.input.commit_oid);
  assert.deepEqual(content.input.range, pair.input_range);
  assert.deepEqual(content.limitations, ['compact_correspondence_only', 'changed_source_detail_unavailable', 'authorship_unproven']);
  assert.equal(candidate.content.includes(pair.input.path), false);
});

test('producer rejects absent exact selection, unmanaged target and unrelated task', () => {
  assert.equal(peerDeliveryCandidate(pair, { ...peerCase, inputs: peerCase.inputs.slice(0, 1) }, source,
    target, recipientTaskId, artifactId), undefined);
  assert.equal(peerDeliveryCandidate(pair, { ...peerCase, inputs: peerCase.inputs.slice(1) }, source,
    target, recipientTaskId, artifactId), undefined);
  assert.equal(peerDeliveryCandidate(pair, { ...peerCase, state: 'closed' }, source, target,
    recipientTaskId, artifactId), undefined);
  assert.equal(peerDeliveryCandidate(pair, peerCase, source, { ...target, managed: undefined },
    recipientTaskId, artifactId), undefined);
  assert.equal(peerDeliveryCandidate(pair, peerCase, source, target, randomUUID(), artifactId), undefined);
  assert.equal(peerDeliveryCandidate(pair, peerCase, { ...source, id: randomUUID() }, target,
    recipientTaskId, artifactId), undefined);
});

test('key changes for changed case, source, artifact and either overlap marker', () => {
  const original = peerDeliveryCandidate(pair, peerCase, source, target, recipientTaskId, artifactId);
  const candidates = [
    peerDeliveryCandidate(pair, { ...peerCase, revision: peerCase.revision + 1 }, source, target, recipientTaskId, artifactId),
    peerDeliveryCandidate(pair, peerCase, { ...source, revision: source.revision + 1 }, target, recipientTaskId, artifactId),
    peerDeliveryCandidate(pair, peerCase, source, target, recipientTaskId, 'b'.repeat(64)),
    peerDeliveryCandidate({ ...pair, current_change: { ...pair.current_change, evidence_id: '1'.repeat(64) } },
      peerCase, source, target, recipientTaskId, artifactId),
    peerDeliveryCandidate({ ...pair, other_change: { ...pair.other_change, evidence_id: '1'.repeat(64) } },
      peerCase, source, target, recipientTaskId, artifactId),
  ];
  for (const candidate of candidates) assert.notEqual(candidate.idempotency_key, original.idempotency_key);
});
