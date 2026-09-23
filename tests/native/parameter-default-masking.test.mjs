import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { extractNativeFunctions } from '../../.passeur-native/src/observation/native-extraction.js';
import { decodeHelperExtraction } from '../../.passeur-native/src/observation/helper-protocol.js';
import { nativeExtractorIdentity, requiresParameterMaskRefresh } from '../../.passeur-native/src/observation/extractor-identity.js';
import { nativeParserIdentity } from '../../.passeur-native/src/observation/native-parser.js';
import { canonicalHash } from '../../.passeur-native/src/core/async.js';

function file(text, dialect) {
  return { status: 'present', source: { kind: 'working_capture', repository_id: 'fixture', object_format: 'sha1',
    workspace_id: 'fixture-worktree', workspace_generation: 1, capture_id: 'fixture-capture', capture_sequence: 1,
    head_anchor: 'a'.repeat(40), path: dialect === 'tsx' ? 'component.tsx' : 'source.ts' }, mode: '100644',
    content_sha256: createHash('sha256').update(text).digest('hex'), byte_length: Buffer.byteLength(text),
    text, consistency: 'sampled_file_not_atomic' };
}
const source = (token, mode) => `export function connect(
  { token = "${token}", nested: { value = "INNER_SENTINEL" } = {} }:
    { token?: string; nested?: { value?: string }; kind?: "literal-type" },
  [mode = "${mode}"]: [string?] = []
): "result-literal" { return "result-literal"; }
`;

for (const dialect of ['typescript', 'tsx']) {
  test(`native ${dialect} masks nested object/array defaults without masking literal types`, async () => {
    const input = file(source('TOKEN_SENTINEL', 'MODE_SENTINEL'), dialect);
    const extraction = await extractNativeFunctions(input, dialect);
    assert.equal(extraction.coverage, 'complete');
    assert.equal(extraction.extractor_identity, 'native-declarations@2');
    const declaration = extraction.declarations.find(d => d.name === 'connect');
    assert.ok(declaration); assert.equal(declaration.header_complete, true);
    const visible = JSON.stringify({ signature: declaration.signature, parameters: declaration.parameters, result: declaration.result });
    for (const hidden of ['TOKEN_SENTINEL', 'MODE_SENTINEL', 'INNER_SENTINEL']) assert.equal(visible.includes(hidden), false, hidden);
    assert.ok(declaration.signature.includes('"literal-type"'));
    assert.ok(declaration.result.syntax.includes('"result-literal"'));
    assert.ok(declaration.signature.includes('<default>'));
    assert.ok(declaration.default_digests.length >= 5);
    assert.equal(decodeHelperExtraction(extraction, input, dialect).declarations[0].name, 'connect');
  });
  test(`native ${dialect} default-only changes keep visible declaration stable`, async () => {
    const a = await extractNativeFunctions(file(source('FIRST_SECRET', 'FIRST_MODE'), dialect), dialect);
    const b = await extractNativeFunctions(file(source('SECOND_SECRET', 'SECOND_MODE'), dialect), dialect);
    const left = a.declarations.find(d => d.name === 'connect'), right = b.declarations.find(d => d.name === 'connect');
    assert.equal(left.signature, right.signature);
    assert.deepEqual(left.parameters, right.parameters);
    assert.deepEqual(left.result, right.result);
    assert.notDeepEqual(left.default_digests, right.default_digests);
  });
  test(`native ${dialect} rejects an older helper extraction instead of treating it as freshly masked`, async () => {
    const input = file(source('TOKEN', 'MODE'), dialect), extraction = await extractNativeFunctions(input, dialect);
    assert.throws(() => decodeHelperExtraction({ ...extraction, extractor_identity: 'native-declarations@1' }, input, dialect),
      { code: 'STRUCTURAL_HELPER_REPLY_INVALID' });
    const digest = version => canonicalHash({ parser_identity: nativeParserIdentity(dialect), extractor_identity: version });
    assert.equal(requiresParameterMaskRefresh(digest('native-declarations@1')), true);
    assert.equal(requiresParameterMaskRefresh(digest(nativeExtractorIdentity(dialect))), false);
  });
}
test('other language extraction identities remain unchanged', () => {
  for (const dialect of ['rust','javascript','jsx','python','lua','kotlin','zig','csharp','c','cpp','odin','svelte5']) {
    assert.equal(nativeExtractorIdentity(dialect), 'native-declarations@1');
    assert.equal(requiresParameterMaskRefresh(canonicalHash({ parser_identity: nativeParserIdentity(dialect), extractor_identity: 'native-declarations@1' })), false);
  }
});
