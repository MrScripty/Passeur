import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodePeerResolutionText, encodePeerResolutionRecord, peerResolutionDigest,
  PEER_RESOLUTION_ACTIONS, PEER_RESOLUTION_PREFIX,
} from '../../.passeur-core/src/coordination/peer-resolution.js';

function proposed(changes) {
  const summary = 'Keep the discount and delivery charge in the combined total';
  return {
    schema_version: 2, kind: 'peer_resolution_proposal',
    case_id: '11111111-1111-4111-8111-111111111111', case_revision: 2, case_generation: 1,
    proposal_revision: 1, evidence_id: 'a'.repeat(64), evidence_revision: 3,
    participants: ['b'.repeat(64), 'c'.repeat(64)],
    sources: [{ work_id: '22222222-2222-4222-8222-222222222222', work_revision: 1,
      input_oid: 'd'.repeat(40), selected_commit_oid: 'e'.repeat(40) }],
    scope: [{ kind: 'file', path: 'src/quote.ts' }], action: 'propose',
    resolution_digest: peerResolutionDigest(summary, changes), predecessor_digest: null,
    permitted_actions: [...PEER_RESOLUTION_ACTIONS], summary, changes,
  };
}

test('readable v2 proposal binds exact sorted file effects while legacy records remain readable', () => {
  const changes = [{ path: 'src/quote.ts', before_sha256: 'f'.repeat(64),
    after_base64: Buffer.from('export const total = 8500;\n').toString('base64') }];
  const record = proposed(changes);
  assert.deepEqual(decodePeerResolutionText(encodePeerResolutionRecord(record)), record);
  assert.throws(() => encodePeerResolutionRecord({ ...record, summary: 'Different semantics' }), { code: 'PEER_RESOLUTION_INVALID' });
  assert.throws(() => encodePeerResolutionRecord({ ...record, changes: [{ ...changes[0], path: '../quote.ts' }] }), { code: 'PEER_RESOLUTION_INVALID' });
  assert.throws(() => encodePeerResolutionRecord({ ...record, changes: [changes[0], changes[0]] }), { code: 'PEER_RESOLUTION_INVALID' });
  assert.throws(() => encodePeerResolutionRecord({ ...record,
    scope: [...record.scope, { kind: 'file', path: '.Git/config' }] }), { code: 'PEER_RESOLUTION_INVALID' });
  const empty = [{ path: 'src/quote.ts', before_sha256: changes[0].before_sha256, after_base64: '' }];
  assert.deepEqual(decodePeerResolutionText(encodePeerResolutionRecord(proposed(empty))).changes, empty);
  const legacy = { ...record, schema_version: 1 };
  delete legacy.summary; delete legacy.changes;
  assert.equal(decodePeerResolutionText(`${PEER_RESOLUTION_PREFIX}${JSON.stringify(legacy)}`).schema_version, 1);
});
