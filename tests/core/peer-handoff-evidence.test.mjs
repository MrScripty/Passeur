import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { selectPeerOverlapEvidence } from '../../.passeur-core/src/observation/overlap.js';

const identity = id => ({ kind: 'working_capture', repository_id: 'repo', object_format: 'sha1',
  workspace_id: 'work', workspace_generation: 1, capture_id: id, capture_sequence: 1,
  head_anchor: 'a'.repeat(40), path: 'src/total.ts' });
const capture = (id, text) => ({ status: 'present', source: identity(id), mode: '100644',
  content_sha256: createHash('sha256').update(text).digest('hex'), byte_length: Buffer.byteLength(text),
  text, consistency: 'sampled_file_not_atomic' });
const declaration = (text, signature) => ({ key: 'total', kind: 'function_declaration', name: 'total',
  enclosing: [], range: { start_byte: 0, end_byte: Buffer.byteLength(text.split('\n')[0]) }, signature,
  parameters: [], result: { state: 'declared', syntax: 'number' }, header_complete: true,
  body_digest: createHash('sha256').update(text).digest('hex'), default_digests: [] });

test('peer handoff keeps source-side signatures and bounded body text from immutable captures', () => {
  const before = 'function total() { return 100; }\nfunction unrelated() { return 9; }\n';
  const after = 'function total() { return 80; }\nfunction unrelated() { return 9; }\n';
  const input = capture('input', before), observed = capture('observed', after);
  const left = declaration(before, 'function total()');
  const right = declaration(after, 'function total()');
  const selection = { subject_id: 'total', dialect: 'typescript', parser_identity: 'parser', extractor_identity: 'extractor',
    input, declaration: left, observations: [{ observation_id: 'work-b', observed,
      change: { kind: 'modified', declaration_changed: false, body_changed: true, default_changed: false,
        input: left, observed: right } }] };
  const evidence = selectPeerOverlapEvidence(selection);
  assert.equal(evidence.coverage, 'complete');
  assert.deepEqual(evidence.changes[0].input_declaration.signature, left.signature);
  assert.deepEqual(evidence.changes[0].observed_declaration.signature, right.signature);
  assert.deepEqual(evidence.changes[0].spans.map(span => span.side), ['input', 'observed']);
  for (const span of evidence.changes[0].spans) {
    const source = span.side === 'input' ? input : observed;
    assert.equal(span.text, Buffer.from(source.text).subarray(span.range.start_byte, span.range.end_byte).toString());
    assert.equal(span.omitted_before, span.range.start_byte > left.range.start_byte);
    assert.equal(span.omitted_after, span.range.end_byte < (span.side === 'input' ? left : right).range.end_byte);
  }
  assert.equal(JSON.stringify(evidence).includes('unrelated'), false);
  assert.equal(selectPeerOverlapEvidence(selection).evidence_id, evidence.evidence_id);
});

test('peer handoff retains changed defaults when the body also changes', () => {
  const before = 'function total(rate = 1) { return rate + 100; }\n';
  const after = 'function total(rate = 2) { return rate + 80; }\n';
  const input = capture('input-default', before), observed = capture('observed-default', after);
  const left = declaration(before, 'function total(rate = <default>)');
  const right = declaration(after, 'function total(rate = <default>)');
  const evidence = selectPeerOverlapEvidence({ subject_id: 'total', dialect: 'typescript',
    parser_identity: 'parser', extractor_identity: 'extractor', input, declaration: left,
    observations: [{ observation_id: 'work-a', observed, change: { kind: 'modified', declaration_changed: false,
      body_changed: true, default_changed: true, input: left, observed: right } }] });
  const spans = evidence.changes[0].spans;
  assert.deepEqual(spans.map(span => span.side), ['input', 'observed']);
  assert.ok(spans.find(span => span.side === 'input').text.includes('rate = 1'));
  assert.ok(spans.find(span => span.side === 'observed').text.includes('rate = 2'));
});

test('peer handoff shows an added declaration when the input file is absent in its commit', () => {
  const text = 'function total() { return 80; }\n';
  const observed = capture('observed-add', text);
  const added = declaration(text, 'function total()');
  const input = { status: 'absent_in_commit', source: { kind: 'commit', repository_id: 'repo', object_format: 'sha1',
    commit_oid: 'a'.repeat(40), tree_oid: 'b'.repeat(40), path: 'src/total.ts' } };
  const evidence = selectPeerOverlapEvidence({ subject_id: 'total', dialect: 'typescript',
    parser_identity: 'parser', extractor_identity: 'extractor', input, declaration: added,
    observations: [{ observation_id: 'work-a', observed, change: { kind: 'added', declaration_changed: true,
      body_changed: false, default_changed: false, observed: added } }] });
  assert.equal(evidence.coverage, 'complete');
  assert.deepEqual(evidence.changes[0].spans.map(span => span.side), ['observed']);
  assert.equal(evidence.changes[0].spans[0].text, text.trim());
});

test('peer handoff exposes both written signatures when a declaration changes', () => {
  const before = 'function total(rate: number) { return rate; }\n';
  const after = 'function total(rate: bigint) { return rate; }\n';
  const input = capture('signature-input', before), observed = capture('signature-observed', after);
  const left = declaration(before, 'function total(rate: number)');
  const right = declaration(after, 'function total(rate: bigint)');
  const evidence = selectPeerOverlapEvidence({ subject_id: 'total', dialect: 'typescript',
    parser_identity: 'parser', extractor_identity: 'extractor', input, declaration: left,
    observations: [{ observation_id: 'work-a', observed, change: { kind: 'modified', declaration_changed: true,
      body_changed: false, default_changed: false, input: left, observed: right } }] });
  assert.equal(evidence.changes[0].input_declaration.signature, 'function total(rate: number)');
  assert.equal(evidence.changes[0].observed_declaration.signature, 'function total(rate: bigint)');
  assert.equal(evidence.changes[0].spans.some(span => span.side === 'observed' && span.text.includes('bigint')), true);
});
