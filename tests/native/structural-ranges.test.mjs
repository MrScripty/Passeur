import test from 'node:test';
import assert from 'node:assert/strict';
import Parser from 'tree-sitter';
import rust from 'tree-sitter-rust';
import typescript from 'tree-sitter-typescript';
import { Utf8SourceRanges } from '../../.passeur-native/src/observation/ranges.js';

for (const [name, grammar, declaration] of [
  ['rust', rust, 'fn f(x: i32) -> i32 { x }'],
  ['typescript', typescript.typescript, 'function f(x: number): number { return x; }'],
  ['tsx', typescript.tsx, 'function F(x: number): number { return <div>{x}</div>; }'],
]) {
  test(`${name} native indices convert to exact captured UTF-8 bytes`, () => {
    const source = `// é😀\n${declaration}\n`;
    const parser = new Parser();
    parser.setLanguage(grammar);
    const tree = parser.parse(source);
    assert.equal(tree.rootNode.hasError, false);
    const node = tree.rootNode.namedChildren[1];
    assert.ok(node);
    assert.equal(node.startIndex, 7);
    const ranges = new Utf8SourceRanges(source);
    assert.deepEqual(ranges.byteRange(node.startIndex, node.endIndex), {
      start_byte: 10,
      end_byte: 10 + Buffer.byteLength(declaration),
    });
  });
}
