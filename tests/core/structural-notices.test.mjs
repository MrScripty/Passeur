import test from 'node:test';
import assert from 'node:assert/strict';
import { noticeMateriality } from '../../.passeur-core/src/coordination/notices.js';

function report() {
  const source = { kind: 'commit', repository_id: 'repo', object_format: 'sha1', commit_oid: '1'.repeat(40), tree_oid: '2'.repeat(40), path: 'src/f.ts' };
  const declaration = { key: 'f', kind: 'function_declaration', name: 'f', enclosing: [], range: { start_byte: 0, end_byte: 42 },
    signature: 'function f(x: number): number', parameters: ['x: number'], result: { state: 'declared', syntax: 'number' },
    header_complete: true, default_digests: [], body_digest: 'a'.repeat(64) };
  return { work_id: '11111111-1111-4111-8111-111111111111', parent_id: 'a'.repeat(64), attribution: 'observed_in_work_authorship_not_established',
    comparison: { input: { source, status: 'present', mode: '100644', content_sha256: '1'.repeat(64), byte_length: 42 },
      observed: { source: { ...source, commit_oid: '3'.repeat(40), tree_oid: '4'.repeat(40) }, status: 'present', mode: '100644',
        content_sha256: '2'.repeat(64), byte_length: 42 }, dialect: 'typescript', parser_identity: 'parser', extractor_identity: 'extractor',
      coverage: 'complete', changes: [{ kind: 'modified', correspondence: 'unique_syntax_correspondence', input: declaration,
        observed: { ...declaration, body_digest: 'b'.repeat(64) }, declaration_changed: false, body_changed: true, default_changed: false }],
      region_changed: false, limitations: [] } };
}

test('materiality ignores capture identity, ordering, and body digest while retaining body change', () => {
  const a = report(), b = structuredClone(a);
  b.comparison.input.source.commit_oid = '5'.repeat(40);
  b.comparison.observed.source.commit_oid = '6'.repeat(40);
  b.comparison.changes[0].input.range.start_byte = 100;
  b.comparison.changes[0].observed.body_digest = 'c'.repeat(64);
  b.comparison.input.content_sha256 = '7'.repeat(64);
  assert.equal(noticeMateriality(a), noticeMateriality(b));
  b.comparison.changes[0].body_changed = false;
  assert.notEqual(noticeMateriality(a), noticeMateriality(b));
});

test('materiality distinguishes incomplete coverage and exact declaration signatures', () => {
  const a = report(), b = structuredClone(a);
  b.comparison.coverage = 'incomplete';
  assert.notEqual(noticeMateriality(a), noticeMateriality(b));
  b.comparison.coverage = 'complete';
  b.comparison.changes[0].observed.signature = 'function f(x: string): number';
  assert.notEqual(noticeMateriality(a), noticeMateriality(b));
});
