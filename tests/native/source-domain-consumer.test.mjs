import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { extractNativeFunctions } from '../../.passeur-native/src/observation/native-extraction.js';
import { compareCapturedSources } from '../../.passeur-native/src/observation/comparison.js';

const source = id => ({ kind: 'working_capture', repository_id: 'repo', object_format: 'sha1',
  workspace_id: 'workspace', workspace_generation: 1, capture_id: id, capture_sequence: 1,
  head_anchor: 'a'.repeat(40), path: 'src/total.ts' });
const file = (id, text) => ({ status: 'present', source: source(id), mode: '100644',
  content_sha256: createHash('sha256').update(text).digest('hex'), byte_length: Buffer.byteLength(text),
  text, consistency: 'sampled_file_not_atomic' });

test('ordinary source-domain consumer reads declarations, containment, and changed body', async () => {
  const extractor = { extract: extractNativeFunctions };
    const input = file('input', 'class Cart { total() { return 100; } }\n');
    const observed = file('observed', 'class Cart { total() { return 80; } }\n');
    const result = await compareCapturedSources(input, observed, 'typescript', extractor);
    assert.equal(result.comparison.coverage, 'complete');
    const method = result.observed.declarations.find(item => item.name === 'total');
    assert.ok(method);
    assert.deepEqual(method.enclosing, ['Cart']);
    assert.equal(Buffer.from(observed.text).subarray(method.range.start_byte, method.range.end_byte).toString(),
      'total() { return 80; }');
    assert.equal(result.comparison.changes.some(change => change.observed?.name === 'total' && change.body_changed), true);
});
