import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { extractNativeFunctions } from '../../.passeur-native/src/observation/native-extraction.js';
import { compareExtractions } from '../../.passeur-native/src/observation/match.js';

const hash = value => createHash('sha256').update(value).digest('hex');
function captured(text, path, capture_sequence = 1) {
  return { status: 'present', source: { kind: 'working_capture', repository_id: 'parser-coverage', object_format: 'sha1',
    workspace_id: 'fixture', workspace_generation: 1, capture_id: `capture-${capture_sequence}`, capture_sequence,
    head_anchor: 'a'.repeat(40), path }, mode: '100644', content_sha256: hash(text),
    byte_length: Buffer.byteLength(text), text, consistency: 'sampled_file_not_atomic' };
}

test('ordinary JavaScript bindings retain written structure while masking initializer values', async () => {
  const source = 'export const café = privateOne, next = privateTwo;\nlet {x = privateThree, y} = source;\n';
  const result = await extractNativeFunctions(captured(source, 'sample.js'), 'javascript');
  assert.equal(result.coverage, 'complete');
  assert.deepEqual(result.limitations, []);
  assert.deepEqual(result.declarations.map(({ name, signature, default_digests }) =>
    [name, signature, default_digests.length]), [
    ['café', 'export const café = <default>', 1],
    ['next', 'const next = <default>', 1],
    ['{x = <default>, y}', 'let {x = <default>, y} = <default>;', 2],
  ]);
  assert.equal(result.declarations[0].range.start_byte, 0);
  assert.equal(result.declarations[0].range.end_byte, Buffer.byteLength('export const café = privateOne'));
  assert.ok(!JSON.stringify(result.declarations).includes('private'));
});

test('ordinary JavaScript initializer edit is a default change', async () => {
  const before = await extractNativeFunctions(captured('const count = 1;\n', 'sample.js'), 'javascript');
  const after = await extractNativeFunctions(captured('const count = 2;\n', 'sample.js', 2), 'javascript');
  assert.equal(before.coverage, 'complete');
  assert.equal(after.coverage, 'complete');
  assert.deepEqual(compareExtractions(before, after).changes.map(change =>
    [change.declaration_changed, change.body_changed, change.default_changed]), [[false, false, true]]);
});

test('Rust const and static values are masked in top level and module scopes', async () => {
  const source = 'pub const LIMIT: usize = 3;\nstatic COUNT: u32 = 0;\nmod nested { const INNER: u8 = 2; }\n';
  const result = await extractNativeFunctions(captured(source, 'sample.rs'), 'rust');
  assert.equal(result.coverage, 'complete');
  assert.deepEqual(result.limitations, []);
  assert.deepEqual(result.declarations.map(({ kind, name, enclosing, signature }) => [kind, name, enclosing, signature]), [
    ['const_item', 'LIMIT', [], 'pub const LIMIT: usize = <default>;'],
    ['static_item', 'COUNT', [], 'static COUNT: u32 = <default>;'],
    ['mod_item', 'nested', [], 'mod nested'],
    ['const_item', 'INNER', ['nested'], 'const INNER: u8 = <default>;'],
  ]);
  assert.deepEqual(result.declarations[0].result, { state: 'declared', syntax: 'usize' });
});

test('Rust constant value edit is a default change', async () => {
  const before = await extractNativeFunctions(captured('const SIZE: usize = 3;\n', 'sample.rs'), 'rust');
  const after = await extractNativeFunctions(captured('const SIZE: usize = 4;\n', 'sample.rs', 2), 'rust');
  assert.equal(before.coverage, 'complete');
  assert.equal(after.coverage, 'complete');
  assert.deepEqual(compareExtractions(before, after).changes.map(change =>
    [change.declaration_changed, change.body_changed, change.default_changed]), [[false, false, true]]);
});

test('Rust associated constants retain impl and trait scope', async () => {
  const source = 'impl Box { const SIZE: usize = 3; }\ntrait T { const ZERO: u8; }\n';
  const result = await extractNativeFunctions(captured(source, 'sample.rs'), 'rust');
  assert.equal(result.coverage, 'complete');
  assert.deepEqual(result.declarations.map(({ kind, name, enclosing, signature }) => [kind, name, enclosing, signature]), [
    ['impl_item', 'Box', [], 'impl Box'],
    ['const_item', 'SIZE', ['Box'], 'const SIZE: usize = <default>;'],
    ['trait_item', 'T', [], 'trait T'],
    ['const_item', 'ZERO', ['T'], 'const ZERO: u8;'],
  ]);
});
