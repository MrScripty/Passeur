import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodePeerResolutionText,
  encodePeerResolutionRecord,
  PEER_RESOLUTION_ACTIONS,
  PEER_RESOLUTION_MAX_BYTES,
  PEER_RESOLUTION_PREFIX,
} from '../../.passeur-core/src/coordination/peer-resolution.js';

const proposal = () => ({
  schema_version: 1,
  kind: 'peer_resolution_proposal',
  case_id: '11111111-1111-4111-8111-111111111111',
  case_revision: 2,
  case_generation: 1,
  proposal_revision: 1,
  evidence_id: 'a'.repeat(64),
  evidence_revision: 3,
  participants: ['b'.repeat(64), 'c'.repeat(64)],
  sources: [{
    work_id: '22222222-2222-4222-8222-222222222222',
    work_revision: 1,
    input_oid: 'd'.repeat(40),
    selected_commit_oid: 'e'.repeat(40),
  }],
  scope: [{ kind: 'file', path: 'src/quote.ts' }],
  action: 'propose',
  resolution_digest: 'f'.repeat(64),
  predecessor_digest: null,
  permitted_actions: [...PEER_RESOLUTION_ACTIONS],
});

const decodeObject = value => decodePeerResolutionText(`${PEER_RESOLUTION_PREFIX}${JSON.stringify(value)}`);
const invalid = fn => assert.throws(fn, { code: 'PEER_RESOLUTION_INVALID' });

test('peer-resolution records encode canonically and round-trip all record kinds', () => {
  const value = proposal();
  const reversed = Object.fromEntries(Object.entries(value).reverse());
  assert.equal(encodePeerResolutionRecord(reversed), encodePeerResolutionRecord(value));
  const decodedProposal = decodePeerResolutionText(encodePeerResolutionRecord(value));
  assert.deepEqual(decodedProposal, value);
  assert.equal(Object.isFrozen(decodedProposal.sources), true);
  assert.equal(Object.isFrozen(decodedProposal.sources[0]), true);
  assert.equal(decodePeerResolutionText('ordinary coordination note'), null);

  const base = { schema_version: 1, case_id: value.case_id, case_revision: 2, case_generation: 1,
    evidence_id: value.evidence_id, evidence_revision: 3, sources: value.sources, scope: value.scope };
  const application = { ...base, kind: 'peer_resolution_application', proposal_digest: '1'.repeat(64),
    application_digest: '2'.repeat(64), status: 'effect_unknown' };
  const verification = { ...base, kind: 'peer_resolution_verification', application_digest: '2'.repeat(64),
    status: 'unavailable' };
  for (const record of [application, verification]) {
    assert.deepEqual(decodePeerResolutionText(encodePeerResolutionRecord(record)), record);
  }
});

test('peer-resolution decoder rejects extra fields and invalid proposal lineage or actions', () => {
  const value = proposal();
  invalid(() => decodeObject({ ...value, surprise: true }));
  invalid(() => decodeObject({ ...value, sources: [{ ...value.sources[0], surprise: true }] }));
  invalid(() => decodeObject({ ...value, scope: [{ ...value.scope[0], surprise: true }] }));
  invalid(() => decodeObject({ ...value, predecessor_digest: '1'.repeat(64) }));
  invalid(() => decodeObject({ ...value, action: 'counter_propose' }));
  invalid(() => decodeObject({ ...value, action: 'counter_propose', predecessor_digest: '1'.repeat(64), proposal_revision: 2,
    permitted_actions: [...PEER_RESOLUTION_ACTIONS.slice(0, -1), 'execute_shell'] }));
  invalid(() => decodeObject({ ...value, action: 'merge' }));
  assert.equal(decodeObject({ ...value, action: 'counter_propose', predecessor_digest: '1'.repeat(64), proposal_revision: 2 }).action,
    'counter_propose');
});

test('peer-resolution text uses UTF-8 byte limits and rejects malformed text or oversized payloads', () => {
  const value = proposal();
  const boundaryPath = `src/${'😀'.repeat(1023)}`;
  assert.equal(Buffer.byteLength(boundaryPath, 'utf8'), 4096);
  assert.equal(decodePeerResolutionText(encodePeerResolutionRecord({ ...value, scope: [{ kind: 'file', path: boundaryPath }] })).scope[0].path,
    boundaryPath);
  invalid(() => decodeObject({ ...value, scope: [{ kind: 'file', path: `${boundaryPath}x` }] }));
  invalid(() => decodeObject({ ...value, scope: [{ kind: 'file', path: 'src/\ud800.ts' }] }));
  const oversized = `${PEER_RESOLUTION_PREFIX}${' '.repeat(PEER_RESOLUTION_MAX_BYTES)}`;
  assert.ok(Buffer.byteLength(oversized, 'utf8') > PEER_RESOLUTION_MAX_BYTES);
  invalid(() => decodePeerResolutionText(oversized));
});
