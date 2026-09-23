import test from 'node:test';
import assert from 'node:assert/strict';
import { CorrespondenceIndex } from '../../.passeur-core/src/observation/correspondence.js';

const oid = 'a'.repeat(40);
const tree = 'b'.repeat(40);
const base = { kind: 'commit', repository_id: 'repo', object_format: 'sha1', commit_oid: oid,
  tree_oid: tree, path: 'src/source.ts' };
const declaration = { key: 'function:run:0', kind: 'function', name: 'run', enclosing: [],
  range: { start_byte: 0, end_byte: 30 }, signature: 'function run(value: string): void',
  parameters: ['value: string'], result: { state: 'declared', syntax: 'void' },
  header_complete: true, body_digest: 'c'.repeat(64), default_digests: [] };

function report(workId, changes, options = {}) {
  const input = { status: 'present', source: { ...base, ...options.source }, content_sha256: 'd'.repeat(64),
    byte_length: 40, mode: '100644', consistency: 'immutable_git_blob' };
  return { work_id: workId, parent_id: `parent-${workId}`,
    attribution: 'observed_in_work_authorship_not_established',
    comparison: { input, observed: { ...input, source: { kind: 'working_capture', repository_id: 'repo',
      object_format: 'sha1', path: input.source.path, workspace_id: workId, workspace_generation: 1,
      capture_id: 'capture', capture_sequence: 1, head_anchor: oid } }, dialect: 'typescript',
      parser_identity: 'tree-sitter-typescript@fixture', extractor_identity: 'fixture',
      coverage: 'complete', changes, region_changed: false, limitations: [] } };
}
function modified(input = declaration, body = 'e'.repeat(64)) {
  return { kind: 'modified', correspondence: 'unique_syntax_correspondence', input,
    observed: { ...input, key: `${input.key}:observed`, body_digest: body },
    declaration_changed: false, body_changed: true, default_changed: false };
}

test('exact common input declaration produces one compact stable pair and reversion resolves it', () => {
  const index = new CorrespondenceIndex();
  assert.deepEqual(index.upsert(report('a', [modified()])).pairs, []);
  const first = index.upsert(report('b', [modified(declaration, 'f'.repeat(64))]));
  assert.equal(first.pairs.length, 1);
  assert.deepEqual(first.resolved, []);
  const pair = first.pairs[0];
  assert.equal(pair.current_work_id, 'b');
  assert.equal(pair.other_work_id, 'a');
  assert.equal(pair.input.commit_oid, oid);
  assert.deepEqual(pair.input_range, declaration.range);
  assert.match(pair.subject_id, /^[0-9a-f]{64}$/);
  assert.match(pair.pair_id, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(pair).includes('function run'), false);
  assert.equal(index.upsert(report('b', [modified(declaration, 'f'.repeat(64))])).pairs.length, 0);
  const reverted = index.upsert(report('b', []));
  assert.deepEqual(reverted.pairs, []);
  assert.deepEqual(reverted.resolved, [{ current_work_id: 'b', other_work_id: 'a',
    subject_id: pair.subject_id, pair_id: pair.pair_id }]);
  assert.equal(index.upsert(report('b', [])).resolved.length, 0);
});

test('different bases, paths, anchors and extraction identities never imply correspondence', () => {
  const variants = [
    { source: { commit_oid: '9'.repeat(40) } },
    { source: { path: 'src/other.ts' } },
    { change: modified({ ...declaration, range: { start_byte: 1, end_byte: 31 } }) },
  ];
  for (const variant of variants) {
    const index = new CorrespondenceIndex();
    index.upsert(report('a', [modified()]));
    assert.deepEqual(index.upsert(report('b', [variant.change ?? modified()], variant)).pairs, []);
  }
  const index = new CorrespondenceIndex();
  index.upsert(report('a', [modified()]));
  const other = report('b', [modified()]);
  other.comparison.parser_identity = 'different parser';
  assert.deepEqual(index.upsert(other).pairs, []);
});

test('ambiguous, added, unobserved and unrelated region changes are only queryable context', () => {
  const index = new CorrespondenceIndex();
  index.upsert(report('a', [modified()]));
  const ambiguous = { ...modified(), kind: 'ambiguous', correspondence: 'ambiguous' };
  const added = { ...modified(), kind: 'added', input: undefined };
  const unobserved = { ...modified(), kind: 'unobserved' };
  const sameAnchorTwice = [modified(), modified({ ...declaration, key: declaration.key })];
  assert.deepEqual(index.upsert(report('b', [ambiguous, added, unobserved, ...sameAnchorTwice])).pairs, []);
  const region = report('c', []); region.comparison.region_changed = true;
  assert.deepEqual(index.upsert(region).pairs, []);
  assert.deepEqual(index.upsert(report('d', [modified({ ...declaration, header_complete: false })])).pairs, []);
});

test('index bounds reject excess anchors without losing previously indexed evidence', () => {
  const index = new CorrespondenceIndex();
  index.upsert(report('a', [modified()]));
  const changes = Array.from({ length: 257 }, (_, n) => modified({ ...declaration,
    key: `function:run:${n}`, range: { start_byte: n, end_byte: n + 1 } }));
  assert.throws(() => index.upsert(report('a', changes)), { code: 'STRUCTURAL_CORRESPONDENCE_CAPACITY' });
  assert.equal(index.upsert(report('b', [modified()])).pairs.length, 1);
  index.remove('a');
  assert.deepEqual(index.upsert(report('c', [modified()])).pairs.map(pair => pair.other_work_id), ['b']);
});
