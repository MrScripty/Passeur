import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { extractNativeFunctions } from '../../.passeur-native/src/observation/native-extraction.js';
import { decodeHelperExtraction, decodeHelperRequest, HELPER_PROTOCOL_VERSION } from '../../.passeur-native/src/observation/helper-protocol.js';

test('real native extraction is decoded against its exact captured source identity', async () => {
  const text = 'export function f(x: number): number { return x; }\n';
  const file = { status: 'present', source: { kind: 'working_capture', repository_id: 'fixture', object_format: 'sha1',
    workspace_id: 'worktree', workspace_generation: 1, capture_id: 'capture-1', capture_sequence: 1,
    head_anchor: 'a'.repeat(40), path: 'f.ts' }, mode: '100644', content_sha256: createHash('sha256').update(text).digest('hex'),
    byte_length: Buffer.byteLength(text), text, consistency: 'sampled_file_not_atomic' };
  const actual = await extractNativeFunctions(file, 'typescript');
  assert.equal(decodeHelperExtraction(actual, file, 'typescript').declarations[0].name, 'f');
  const wrongHash = structuredClone(actual); wrongHash.source.content_sha256 = 'b'.repeat(64);
  assert.throws(() => decodeHelperExtraction(wrongHash, file, 'typescript'), { code: 'STRUCTURAL_HELPER_REPLY_INVALID' });
  const wrongRange = structuredClone(actual); wrongRange.declarations[0].range.end_byte = file.byte_length + 1;
  assert.throws(() => decodeHelperExtraction(wrongRange, file, 'typescript'), { code: 'STRUCTURAL_HELPER_REPLY_INVALID' });
  const extraField = structuredClone(actual); extraField.declarations[0].inferred_type = 'number';
  assert.throws(() => decodeHelperExtraction(extraField, file, 'typescript'), { code: 'STRUCTURAL_HELPER_REPLY_INVALID' });

  const envelope = { version: HELPER_PROTOCOL_VERSION, kind: 'extract',
    job_id: '12345678-1234-1234-1234-123456789abc', dialect: 'typescript', file };
  assert.equal(decodeHelperRequest(envelope).file.content_sha256, file.content_sha256);
  const wrongLength = structuredClone(envelope); wrongLength.file.byte_length -= 1;
  assert.throws(() => decodeHelperRequest(wrongLength), { code: 'STRUCTURAL_HELPER_REQUEST_INVALID' });
  const wrongBytes = structuredClone(envelope); wrongBytes.file.text = 'export function other() {}';
  wrongBytes.file.byte_length = Buffer.byteLength(wrongBytes.file.text);
  assert.throws(() => decodeHelperRequest(wrongBytes), { code: 'STRUCTURAL_HELPER_REQUEST_INVALID' });
  const extraRequestField = { ...envelope, coding_worker_pid: process.pid };
  assert.throws(() => decodeHelperRequest(extraRequestField), { code: 'STRUCTURAL_HELPER_REQUEST_INVALID' });
});
