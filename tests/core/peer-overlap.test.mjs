import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { selectPeerOverlapEvidence } from '../../.passeur-core/src/observation/overlap.js';
import { CorrespondenceIndex } from '../../.passeur-core/src/observation/correspondence.js';

const sourceIdentity = (capture_id) => ({ kind: 'working_capture', repository_id: 'repo', object_format: 'sha1',
  workspace_id: `${capture_id}-workspace`, workspace_generation: 1, capture_id, capture_sequence: 1,
  head_anchor: 'a'.repeat(40), path: 'src/quote.ts' });
const file = (capture_id, text) => ({ status: 'present', source: sourceIdentity(capture_id), mode: '100644',
  content_sha256: createHash('sha256').update(text).digest('hex'), byte_length: Buffer.byteLength(text), text, consistency: 'sampled_file_not_atomic' });
const declaration = (body_digest, range, signature = 'function total()') => ({ key: 'total', kind: 'function', name: 'total',
  enclosing: [], range, signature, parameters: [], result: { state: 'declared', syntax: 'number' }, header_complete: true,
  body_digest, default_digests: [] });

test('body-only revisions emit fresh correspondence evidence with unchanged flags', () => {
  const index = new CorrespondenceIndex();
  const input = declaration('input-body', { start_byte: 0, end_byte: 32 });
  const source = { kind: 'commit', repository_id: 'repo', object_format: 'sha1',
    commit_oid: 'a'.repeat(40), tree_oid: 'b'.repeat(40), path: 'src/quote.ts' };
  const report = (workId, bodyDigest, evidence = {}) => ({ work_id: workId, parent_id: `owner-${workId}`,
    attribution: 'observed_in_work_authorship_not_established',
    comparison: { input: { status: 'present', source }, observed: { status: 'present', source: sourceIdentity(workId) },
      dialect: 'typescript', parser_identity: 'tree-sitter-typescript@1', extractor_identity: 'native-declarations@1',
      coverage: 'complete', region_changed: false, limitations: [],
      changes: [{ kind: 'modified', correspondence: 'unique_syntax_correspondence',
        declaration_changed: false, body_changed: true, default_changed: false,
        input: { ...input, body_digest: evidence.inputBodyDigest ?? input.body_digest,
          default_digests: evidence.inputDefaults ?? input.default_digests,
          signature: evidence.inputSignature ?? input.signature },
        observed: { ...input, body_digest: bodyDigest,
          default_digests: evidence.observedDefaults ?? input.default_digests,
          signature: evidence.observedSignature ?? input.signature } }] } });
  assert.equal(index.upsert(report('a', 'first')).pairs.length, 0);
  const first = index.upsert(report('b', 'second')).pairs[0];
  assert.ok(first);
  assert.equal(index.upsert(report('b', 'second')).pairs.length, 0);
  const revised = index.upsert(report('b', 'third')).pairs[0];
  assert.ok(revised);
  assert.equal(revised.pair_id, first.pair_id);
  assert.notEqual(revised.current_change.evidence_id, first.current_change.evidence_id);
  assert.deepEqual([revised.current_change.body_changed, revised.current_change.default_changed],
    [first.current_change.body_changed, first.current_change.default_changed]);
  let previous = revised;
  for (const evidence of [
    { inputBodyDigest: 'revised-input' },
    { inputBodyDigest: 'revised-input', inputDefaults: ['input-default'] },
    { inputBodyDigest: 'revised-input', inputDefaults: ['input-default'], inputSignature: 'function total(value = 1)' },
    { inputBodyDigest: 'revised-input', inputDefaults: ['input-default'], inputSignature: 'function total(value = 1)',
      observedDefaults: ['observed-default'] },
    { inputBodyDigest: 'revised-input', inputDefaults: ['input-default'], inputSignature: 'function total(value = 1)',
      observedDefaults: ['observed-default'], observedSignature: 'function total(value = 2)' },
  ]) {
    const next = index.upsert(report('b', 'third', evidence)).pairs[0];
    assert.ok(next);
    assert.notEqual(next.current_change.evidence_id, previous.current_change.evidence_id);
    assert.match(next.current_change.evidence_id, /^[0-9a-f]{64}$/);
    previous = next;
  }
});

function inputFor(text) {
  const subjectEnd = text.indexOf("}\n") + 1;
  return { input: file('input', text), dialect: 'typescript', parser_identity: 'tree-sitter-typescript@1',
    extractor_identity: 'native-declarations@1', subject_id: 'subject', declaration: declaration('input-body', { start_byte: 0, end_byte: subjectEnd }) };
}

test('peer overlap selection is deterministic and includes only the changed body evidence', () => {
  const before = 'function total() { return 100; }\nfunction unrelated() { return 9; }\n';
  const left = 'function total() { return 80; }\nfunction unrelated() { return 9; }\n';
  const right = 'function total() { return 100; }\nfunction unrelated() { return 10; }\n';
  const base = inputFor(before);
  const makeObservation = (id, text, digest) => ({ observation_id: id, observed: file(id, text),
    change: { kind: 'modified', declaration_changed: false, body_changed: true, default_changed: false,
      input: base.declaration, observed: declaration(digest, { start_byte: 0, end_byte: text.indexOf("}\n") + 1 }) } });
  const leftEvidence = selectPeerOverlapEvidence({ ...base, observations: [makeObservation('b', right, 'right-body'), makeObservation('a', left, 'left-body')] });
  const rightEvidence = selectPeerOverlapEvidence({ ...base, observations: [makeObservation('a', left, 'left-body'), makeObservation('b', right, 'right-body')] });
  assert.deepEqual(leftEvidence, rightEvidence);
  assert.equal(leftEvidence.coverage, 'complete');
  assert.equal(leftEvidence.changes.length, 2);
  assert.deepEqual(leftEvidence.changes.map((change) => change.observation_id), ['a', 'b']);
  assert.equal(leftEvidence.changes.every((change) => change.reasons.includes('body_changed')), true);
  assert.equal(leftEvidence.changes.every((change) => change.spans.some((span) => span.text.includes('return'))), true);
  assert.equal(JSON.stringify(leftEvidence).includes('unrelated'), false);
});

test('peer overlap selection reports unavailable source bytes instead of fabricating body evidence', () => {
  const base = inputFor('function total() { return 1; }\n');
  const evidence = selectPeerOverlapEvidence({ ...base, observations: [{ observation_id: 'a',
    observed: { status: 'missing_during_capture', source: sourceIdentity('a') },
    change: { kind: 'modified', declaration_changed: false, body_changed: true, default_changed: false,
      input: base.declaration } }] });
  assert.equal(evidence.coverage, 'unavailable');
  assert.deepEqual(evidence.limitations, ['observed_source_unavailable']);
  assert.deepEqual(evidence.changes[0].spans, []);
});

test('peer overlap selection does not call incomplete comparison facts complete', () => {
  const before = 'function total() { return 1; }\n';
  const base = inputFor(before);
  const evidence = selectPeerOverlapEvidence({ ...base, observations: [{ observation_id: 'a', observed: file('a', before),
    change: { kind: 'modified', declaration_changed: false, body_changed: true, default_changed: false, input: base.declaration } }] });
  assert.equal(evidence.coverage, 'incomplete');
  assert.deepEqual(evidence.limitations, ['observed_declaration_unavailable']);
  assert.deepEqual(evidence.changes[0].spans, []);
});

test('peer overlap selection keeps added and removed declarations on their available side', () => {
  const before = 'function total() { return 1; }\n';
  const after = `${before}function extra() { return 2; }\n`;
  const base = inputFor(before);
  const added = selectPeerOverlapEvidence({ ...base, observations: [{ observation_id: 'added', observed: file('added', after),
    change: { kind: 'added', declaration_changed: true, body_changed: false, default_changed: false,
      observed: declaration('extra', { start_byte: Buffer.byteLength(before), end_byte: Buffer.byteLength(after) }) } }] });
  assert.deepEqual(added.changes[0].reasons, ['declaration_added']);
  assert.equal(added.changes[0].spans.every((span) => span.side === 'observed'), true);
  const removed = selectPeerOverlapEvidence({ ...base, observations: [{ observation_id: 'removed', observed: file('removed', before),
    change: { kind: 'removed', declaration_changed: true, body_changed: false, default_changed: false, input: base.declaration } }] });
  assert.deepEqual(removed.changes[0].reasons, ['declaration_removed']);
  assert.equal(removed.changes[0].spans.every((span) => span.side === 'input'), true);
});

test('peer overlap selection keeps UTF-8 span boundaries valid and reports budget truncation', () => {
  const before = 'function total() { return "é"; }\n';
  const after = 'function total() { return "ø"; }\n';
  const base = inputFor(before);
  const evidence = selectPeerOverlapEvidence({ ...base, observations: [{ observation_id: 'a', observed: file('a', after),
    change: { kind: 'modified', declaration_changed: false, body_changed: true, default_changed: false,
      input: base.declaration, observed: declaration('after-body', { start_byte: 0, end_byte: Buffer.byteLength(after) }) } }] });
  for (const span of evidence.changes[0].spans) assert.doesNotThrow(() => Buffer.from(span.text, 'utf8').toString('utf8'));
  const longAfter = `function total() { return "${'é'.repeat(800)}"; }\n`;
  const many = [{ observation_id: 'observation-' + 'x'.repeat(240), observed: file('observed-' + 'x'.repeat(240), longAfter),
    change: { kind: 'modified', declaration_changed: false, body_changed: false, default_changed: true,
      input: base.declaration, observed: declaration('long-body', { start_byte: 0, end_byte: Buffer.byteLength(longAfter) }) } }];
  const incomplete = selectPeerOverlapEvidence({ ...base, budget_bytes: 3072, observations: many });
  assert.equal(incomplete.coverage, 'incomplete');
  assert.equal(incomplete.limitations.includes('evidence_budget_exceeded'), true);
  assert.ok(Buffer.byteLength(JSON.stringify(incomplete), 'utf8') <= 3072);
  assert.throws(() => selectPeerOverlapEvidence({ ...base, budget_bytes: 512, observations: [{ observation_id: 'a', observed: file('a', after),
    change: { kind: 'modified', declaration_changed: false, body_changed: true, default_changed: false,
      input: base.declaration, observed: declaration('after-body', { start_byte: 0, end_byte: Buffer.byteLength(after) }) } }] }), { code: 'STRUCTURAL_OVERLAP_INVALID' });
});
