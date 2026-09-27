import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { selectPeerOverlapEvidence } from '../../.passeur-core/src/observation/overlap.js';

const identity = (id) => ({ kind: 'working_capture', repository_id: 'repo', object_format: 'sha1',
  workspace_id: `${id}-workspace`, workspace_generation: 1, capture_id: id, capture_sequence: 1,
  head_anchor: 'a'.repeat(40), path: 'src/example.ts' });
const file = (id, text) => ({ status: 'present', source: identity(id), mode: '100644',
  content_sha256: createHash('sha256').update(text).digest('hex'), byte_length: Buffer.byteLength(text),
  text, consistency: 'sampled_file_not_atomic' });
const declaration = (text, signature = 'function example()') => ({ key: 'example', kind: 'function',
  name: 'example', enclosing: [], range: { start_byte: 0, end_byte: Buffer.byteLength(text) },
  signature, parameters: [], result: { state: 'declared', syntax: 'number' },
  header_complete: true, body_digest: createHash('sha256').update(text).digest('hex'), default_digests: [] });
const selection = (before, observations) => ({ subject_id: 'subject', dialect: 'typescript',
  parser_identity: 'tree-sitter-typescript@1', extractor_identity: 'native-declarations@1',
  input: file('input', before), declaration: declaration(before), observations });
const observation = (id, before, after, flags = {}) => ({ observation_id: id, observed: file(id, after),
  change: { kind: 'modified', declaration_changed: false, body_changed: true, default_changed: false,
    ...flags, input: declaration(before), observed: declaration(after) } });
const size = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');

test('near-limit evidence retains an earlier complete pair and records omitted later evidence', () => {
  const before = 'function example() { return "é"; }\n';
  const a = observation('a', before, 'function example() { return "ø"; }\n');
  const b = observation('b', before, 'function example() { return "☃"; }\n');
  const base = selection(before, [b, a]);
  const full = selectPeerOverlapEvidence(base);
  const partialShape = { ...full, coverage: 'incomplete', limitations: ['evidence_budget_exceeded'],
    changes: full.changes.map((change, index) => index === 0 ? change : { ...change, spans: [] }) };
  const budget = size(partialShape);
  const partial = selectPeerOverlapEvidence({ ...base, budget_bytes: budget });
  assert.equal(partial.coverage, 'incomplete');
  assert.deepEqual(partial.limitations, ['evidence_budget_exceeded']);
  assert.deepEqual(partial.changes.map((change) => change.spans.length), [2, 0]);
  assert.ok(size(partial) <= budget);
  assert.deepEqual(partial, selectPeerOverlapEvidence({ ...base, observations: [a, b], budget_bytes: budget }));
  assert.notEqual(partial.evidence_id, full.evidence_id);
});

test('header-only and default changes select changed bytes rather than a large declaration', () => {
  const before = `function example(value = 1) {\n${'  const unchanged = "'+ 'x'.repeat(100) +'";\n'.repeat(40)}  return value;\n}\n`;
  const after = before.replace('value = 1', 'value = 2');
  for (const flags of [
    { body_changed: false, declaration_changed: true },
    { body_changed: false, default_changed: true },
  ]) {
    const result = selectPeerOverlapEvidence(selection(before, [observation('a', before, after, flags)]));
    assert.equal(result.coverage, 'complete');
    assert.equal(result.changes[0].spans.length, 2);
    assert.ok(result.changes[0].spans.every((span) => span.omitted_after));
    assert.ok(result.changes[0].spans.every((span) => size(span.text) < 300));
  }
});

test('distant body edits yield disjoint source-side windows with explicit omission markers', () => {
  const before = `function example() {\n  const first = 1;\n${'  const unchanged = "' + 'z'.repeat(80) + '";\n'.repeat(16)}  const last = 1;\n}\n`;
  const after = before.replace('first = 1', 'first = 2').replace('last = 1', 'last = 2');
  const result = selectPeerOverlapEvidence(selection(before, [observation('a', before, after)]));
  const spans = result.changes[0].spans;
  assert.equal(spans.length, 4);
  assert.ok(spans[0].text.includes('first = 1'));
  assert.ok(spans[1].text.includes('first = 2'));
  assert.ok(spans[2].text.includes('last = 1'));
  assert.ok(spans[3].text.includes('last = 2'));
  assert.ok(spans[0].omitted_after && spans[2].omitted_before);
  assert.ok(spans.reduce((sum, span) => sum + size(span.text), 0) < size(before));
});

test('escaped Unicode uses encoded JSON bytes and oversize required metadata fails explicitly', () => {
  const before = 'function example() { return "é\\n"; }\n';
  const after = 'function example() { return "ø\\n"; }\n';
  const base = selection(before, [observation('a', before, after)]);
  const full = selectPeerOverlapEvidence(base);
  assert.equal(size(selectPeerOverlapEvidence({ ...base, budget_bytes: size(full) })), size(full));
  const oversized = { ...base, subject_id: 's'.repeat(128),
    observations: [observation('id-' + 'x'.repeat(240), before, after)] };
  assert.throws(() => selectPeerOverlapEvidence({ ...oversized, budget_bytes: 512 }),
    { code: 'STRUCTURAL_OVERLAP_INVALID' });
});
