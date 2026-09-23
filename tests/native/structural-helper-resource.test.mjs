import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { NativeAnalysisHelper } from '../../.passeur-native/src/observation/helper.js';

function captured(text, sequence) {
  return { status: 'present', source: { kind: 'working_capture', repository_id: 'resource-test', object_format: 'sha1',
    workspace_id: 'resource-test', workspace_generation: 1, capture_id: `capture-${sequence}`,
    capture_sequence: sequence, head_anchor: 'a'.repeat(40), path: 'resource.ts' }, mode: '100644',
    content_sha256: createHash('sha256').update(text).digest('hex'), byte_length: Buffer.byteLength(text),
    text, consistency: 'sampled_file_not_atomic' };
}

test('Linux RSS overload terminates the real native analysis child without closing later admission', { skip: process.platform !== 'linux' }, async () => {
  // The minimum supported limit is below a real Node child baseline, independent of timing or parser output.
  const limited = new NativeAnalysisHelper(undefined, 1);
  try {
    await assert.rejects(limited.extract(captured('export function bounded() { return 1; }\n', 1), 'typescript'),
      { code: 'STRUCTURAL_ANALYSIS_RESOURCE_LIMIT' });
  } finally { await limited.close(); }

  const normal = new NativeAnalysisHelper();
  try {
    const extraction = await normal.extract(captured('export function available() { return 2; }\n', 2), 'typescript');
    assert.equal(extraction.declarations[0].name, 'available');
  } finally { await normal.close(); }
});

test('helper refuses a resource setting above its fixed maximum', () => {
  assert.throws(() => new NativeAnalysisHelper(undefined, 512 * 1024 + 1),
    { code: 'STRUCTURAL_ANALYSIS_RESOURCE_LIMIT_INVALID' });
});
