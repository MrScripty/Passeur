import test from 'node:test';
import assert from 'node:assert/strict';
import { loadNativeParser } from '../../.passeur-native/src/observation/native-parser.js';

for (const [dialect, sample] of [
  ['rust', 'pub fn f(x: i32) -> i32 { x }'],
  ['typescript', 'export function f(x: number): number { return x; }'],
  ['tsx', 'export function F(x: number) { return <div>{x}</div>; }'],
]) {
  test(`${dialect} uses the pinned native grammar`, async () => {
    const { parser, identity } = await loadNativeParser(dialect);
    const tree = parser.parse(sample);
    assert.equal(tree.rootNode.hasError, false);
    assert.match(identity, /^tree-sitter@0\.25\.1\//);
  });
}

test('every selected grammar route is loadable by the fixed catalog', async () => {
  for (const dialect of ['javascript', 'jsx', 'python', 'lua', 'kotlin', 'zig', 'csharp', 'c', 'cpp', 'odin', 'svelte5']) {
    const { parser, identity } = await loadNativeParser(dialect);
    assert.ok(parser.parse('').rootNode);
    assert.match(identity, /^tree-sitter@0\.25\.1\//);
  }
});
