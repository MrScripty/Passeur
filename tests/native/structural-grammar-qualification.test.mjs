import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import Parser from 'tree-sitter';

const require = createRequire(import.meta.url);
const cases = [
  { dialect: 'c', package: 'tree-sitter-c', version: '0.24.2',
    fixture: '../fixtures/structural/languages/c/bitint.c', node: 'bitint_type' },
  { dialect: 'rust', package: 'tree-sitter-rust', version: '0.24.2',
    fixture: '../fixtures/structural/languages/rust/edition2024.rs', node: 'foreign_mod_item' },
  { dialect: 'cpp', package: 'tree-sitter-cpp', version: '0.23.4',
    fixture: '../fixtures/structural/languages/cpp/explicit-object.cpp', node: 'explicit_object_parameter_declaration' },
  { dialect: 'csharp', package: 'tree-sitter-c-sharp', version: '0.23.5',
    fixture: '../fixtures/structural/languages/csharp/extension-block.cs', node: 'extension_declaration' },
];

function containsNode(root, type) {
  if (root.type === type) return true;
  return root.namedChildren.some(child => containsNode(child, type));
}

test('patched C grammar parses unsigned and parameter C23 bit-precise types', async () => {
  const grammarModule = await import('tree-sitter-c');
  const parser = new Parser();
  parser.setLanguage(grammarModule.default ?? grammarModule);
  for (const source of ['unsigned _BitInt(17) bits;', 'void f(_BitInt(17) bits) { }', 'int old;']) {
    const root = parser.parse(source).rootNode;
    assert.equal(root.hasError, false, root.toString());
    if (source.includes('_BitInt')) assert.equal(containsNode(root, 'bitint_type'), true, root.toString());
  }
});

test('patched Kotlin grammar parses modern named context declarations and former receiver syntax', async () => {
  const grammarModule = await import('@tree-sitter-grammars/tree-sitter-kotlin');
  const parser = new Parser();
  parser.setLanguage(grammarModule.default ?? grammarModule);
  for (const [source, requiredNode] of [
    ['context(user: User) fun read(): String = user.name', 'context_parameter'],
    ['context(user: User, log: Logger)\nfun read(): String = user.name', 'context_parameter'],
    ['context(user: User) val current: String get() = user.name', 'context_parameter'],
    ['context(User) fun read(): String = "x"', 'context_receiver'],
    ['fun plain(x: Int): Int = x', 'function_declaration'],
  ]) {
    const root = parser.parse(source).rootNode;
    assert.equal(root.hasError, false, root.toString());
    assert.equal(containsNode(root, requiredNode), true, root.toString());
  }
});

for (const row of cases) {
  test(`${row.dialect} pinned native grammar parses the selected modern syntax`, async () => {
    const grammarModule = await import(row.package);
    const grammar = grammarModule.default ?? grammarModule;
    assert.equal(require(`${row.package}/package.json`).version, row.version);
    const parser = new Parser();
    parser.setLanguage(grammar);
    const text = await readFile(new URL(row.fixture, import.meta.url), 'utf8');
    const root = parser.parse(text).rootNode;
    assert.equal(root.hasError, false, root.toString());
    assert.equal(containsNode(root, row.node), true, root.toString());
  });
}

test('patched Python native grammar parses defaulted named and starred type parameters', async () => {
  const grammarModule = await import('tree-sitter-python');
  const grammar = grammarModule.default ?? grammarModule;
  assert.equal(require('tree-sitter-python/package.json').version, '0.25.0');
  const parser = new Parser();
  parser.setLanguage(grammar);
  for (const text of [
    'class Box[T = int]:\n    pass\n',
    'def value[T = int](x: T) -> T:\n    return x\n',
    'type Alias[T = int] = list[T]\n',
    'class Pack[*Ts = tuple[int, ...], **P = None]:\n    pass\n',
    'class Legacy[T: int, *Ts, **P]:\n    pass\n',
  ]) {
    const root = parser.parse(text).rootNode;
    assert.equal(root.hasError, false, root.toString());
    if (text.includes(' = ')) assert.equal(containsNode(root, 'default_type_parameter'), true, root.toString());
  }
});
