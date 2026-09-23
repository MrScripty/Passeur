import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extractNativeFunctions } from '../../.passeur-native/src/observation/native-extraction.js';
import { compareExtractions } from '../../.passeur-native/src/observation/match.js';

const sha256 = text => createHash('sha256').update(text).digest('hex');
const extensions = { kotlin: 'kt', zig: 'zig', odin: 'odin' };
async function fixture(dialect) {
  return readFile(new URL(`../fixtures/structural/languages/${dialect}/declarations.${extensions[dialect]}`, import.meta.url), 'utf8');
}
async function advanced(dialect) {
  return readFile(new URL(`../fixtures/structural/languages/${dialect}/advanced.${extensions[dialect]}`, import.meta.url), 'utf8');
}
async function caseFile(dialect, name) {
  return readFile(new URL(`../fixtures/structural/languages/${dialect}/${name}`, import.meta.url), 'utf8');
}
async function extract(dialect, text, sequence = 1) {
  const file = { status: 'present', source: { kind: 'working_capture', repository_id: 'test-repository',
    object_format: 'sha1', workspace_id: 'test-workspace', workspace_generation: 1,
    capture_id: `sample-${sequence}`, capture_sequence: sequence, head_anchor: 'a'.repeat(40),
    path: `sample.${extensions[dialect]}` }, mode: '100644', text,
  content_sha256: sha256(text), byte_length: Buffer.byteLength(text), consistency: 'sampled_file_not_atomic' };
  return extractNativeFunctions(file, dialect);
}

test('pinned Kotlin grammar maps written class, member, extension, and alias headers', async () => {
  const source = await fixture('kotlin');
  const result = await extract('kotlin', source);
  assert.equal(result.coverage, 'complete');
  assert.deepEqual(result.declarations.map(d => [d.kind, d.name, d.enclosing]), [
    ['class_declaration', 'Box', []], ['function_declaration', 'get', ['Box']],
    ['property_declaration', 'current', ['Box']], ['function_declaration', 'repeat2', []],
    ['type_alias', 'Names', []],
  ]);
  assert.equal(result.declarations[0].signature, '<attribute>\nclass Box<T>(val item: T)');
  assert.deepEqual(result.declarations[1].parameters, ['fallback: T = <default>']);
  assert.deepEqual(result.declarations[1].result, { state: 'declared', syntax: 'T' });
  assert.equal(result.declarations[2].signature, 'val current: T = <default>');
  assert.equal(result.declarations[3].signature, 'fun String.repeat2(times: Int = <default>): String');
  assert.deepEqual(result.declarations[4].result, { state: 'declared', syntax: 'List<String>' });
  assert.ok(!JSON.stringify(result.declarations).includes('internal note'));
  assert.deepEqual(result.declarations[0].range, {
    start_byte: Buffer.byteLength(source.slice(0, source.indexOf('@Deprecated'))),
    end_byte: Buffer.byteLength(source.slice(0, source.indexOf('\n\nfun String'))),
  });
});

test('pinned Zig grammar maps namespace containers, fields, receivers, generic parameters, and enum cases', async () => {
  const result = await extract('zig', await fixture('zig'));
  assert.equal(result.coverage, 'complete');
  assert.deepEqual(result.declarations.map(d => [d.kind, d.name, d.enclosing]), [
    ['variable_declaration', 'Point', []], ['container_field', 'x', ['Point']],
    ['container_field', 'y', ['Point']], ['function_declaration', 'move', ['Point']],
    ['function_declaration', 'add', []], ['variable_declaration', 'Choice', []],
    ['container_field', 'first', ['Choice']], ['container_field', 'second', ['Choice']],
  ]);
  assert.equal(result.declarations[2].signature, 'y: i32 = <default>');
  assert.deepEqual(result.declarations[3].parameters, ['self: *Point', 'dx: i32']);
  assert.deepEqual(result.declarations[3].result, { state: 'declared', syntax: 'void' });
  assert.deepEqual(result.declarations[4].parameters, ['comptime T: type', 'x: T']);
  assert.equal(result.declarations[6].signature, 'first');
  assert.equal(result.declarations[7].signature, 'second');
});

test('pinned Odin grammar maps procedures, receiver syntax, direct fields, aliases, and variants', async () => {
  const result = await extract('odin', await fixture('odin'));
  assert.equal(result.coverage, 'complete');
  assert.deepEqual(result.declarations.map(d => [d.kind, d.name, d.enclosing]), [
    ['struct_declaration', 'Point', []], ['field', 'x', ['Point']], ['field', 'y', ['Point']],
    ['procedure_declaration', 'add', []], ['procedure_declaration', '(Point) .move', []],
    ['const_declaration', 'Id', []], ['enum_declaration', 'Color', []],
    ['identifier', 'Red', ['Color']], ['identifier', 'Blue', ['Color']],
  ]);
  assert.deepEqual(result.declarations[3].parameters, ['x: int', 'y: int = <default>']);
  assert.deepEqual(result.declarations[3].result, { state: 'declared', syntax: 'int' });
  assert.deepEqual(result.declarations[4].parameters, ['self: ^Point', 'dx: int']);
  assert.equal(result.declarations[0].signature, 'Point :: struct');
});

test('real grammar comparisons separate defaults, body edits, and direct headers', async () => {
  const before = await fixture('kotlin');
  const after = before.replace('fallback: T = item', 'fallback: T = TODO()')
    .replace('return this.repeat(times)', 'return this.repeat(times + 1)');
  const input = await extract('kotlin', before);
  const observed = await extract('kotlin', after, 2);
  const changes = compareExtractions(input, observed).changes;
  assert.deepEqual(changes.map(change => [change.observed?.name, change.default_changed, change.body_changed]), [
    ['get', true, false], ['repeat2', false, true],
  ]);
  assert.ok(!JSON.stringify(observed.declarations).includes('TODO()'));
});

test('constructor defaults and header comments are masked without exposing their text', async () => {
  const source = 'class C(val x: Int = 42) {}\nfun f(/* private */ x: Int = 3): Int = x\n';
  const result = await extract('kotlin', source);
  assert.equal(result.coverage, 'complete');
  assert.deepEqual(result.declarations[0].parameters, ['val x: Int = <default>']);
  assert.ok(result.declarations[1].signature.includes('<comment>'));
  assert.ok(!JSON.stringify(result.declarations).includes('private'));
  assert.equal(result.declarations[0].default_digests.length, 1);
});

test('ambiguous Zig constant aliases do not publish initializer values as types', async () => {
  const result = await extract('zig', 'const Alias = SecretValue;\n');
  assert.equal(result.coverage, 'incomplete');
  assert.deepEqual(result.limitations, ['ambiguous_constant_type_value']);
  assert.equal(result.declarations[0].signature, 'const Alias = <default>;');
  assert.deepEqual(result.declarations[0].result, { state: 'not_declared' });
});

test('malformed modern source has explicit incomplete coverage and local header/body state', async () => {
  const kotlin = await extract('kotlin', 'fun good(x: Int): Int = x\nfun broken(x: ) {}\n');
  assert.equal(kotlin.coverage, 'incomplete');
  assert.equal(kotlin.declarations[0].header_complete, true);
  assert.equal(kotlin.declarations[1].header_complete, false);
  const zig = await extract('zig', 'pub fn okay(x: i32) i32 { return x; }\npub fn bad(x: i32) i32 { return x + ; }\n');
  assert.equal(zig.coverage, 'incomplete');
  assert.equal(zig.declarations[0].header_complete, true);
  assert.equal(zig.declarations[1].header_complete, true);
  assert.ok(zig.limitations.includes('declaration_body_incomplete'));
});

test('Kotlin production dispatch preserves BOM, CRLF, combining text, constructor defaults, and exact bytes', async () => {
  const result = await extract('kotlin', await advanced('kotlin'));
  assert.equal(result.coverage, 'complete');
  assert.deepEqual(result.declarations.map(d => [d.kind, d.name, d.range.start_byte, d.range.end_byte]), [
    ['class_declaration', 'Service', 31, 88], ['function_declaration', 'run', 55, 86],
    ['class_declaration', 'Holder', 90, 210], ['secondary_constructor', 'constructor', 160, 208],
  ]);
  assert.deepEqual(result.declarations[2].parameters, ['val value: String = <default>']);
  assert.equal(result.declarations[2].signature, 'class Holder private constructor(val value: String = <default>)');
  assert.equal(result.declarations[3].signature, 'constructor(size: Int): this(size.toString())');
  assert.ok(!JSON.stringify(result.declarations).includes('"private"'));
});

test('Zig production dispatch preserves anytype, noalias, error union, pointer and optional syntax', async () => {
  const result = await extract('zig', await advanced('zig'));
  assert.equal(result.coverage, 'complete');
  assert.deepEqual(result.declarations.map(d => [d.name, d.range.start_byte, d.range.end_byte]), [
    ['load', 12, 83], ['copy', 85, 148], ['select', 150, 217],
  ]);
  assert.deepEqual(result.declarations[0].parameters, ['reader: anytype']);
  assert.deepEqual(result.declarations[0].result, { state: 'declared', syntax: '![]const u8' });
  assert.deepEqual(result.declarations[1].parameters, ['noalias dst: []u8', 'noalias src: []const u8']);
  assert.deepEqual(result.declarations[2].result, { state: 'declared', syntax: '?T' });
});

test('Odin production dispatch extracts named and multiple results, proc groups, modifiers and union members', async () => {
  const result = await extract('odin', await advanced('odin'));
  assert.equal(result.coverage, 'complete');
  assert.deepEqual(result.declarations.map(d => [d.kind, d.name, d.range.start_byte, d.range.end_byte]), [
    ['procedure_declaration', 'pair', 14, 83], ['procedure_declaration', 'identity', 85, 149],
    ['procedure_declaration', 'copy', 151, 208], ['overloaded_procedure_declaration', 'group', 209, 238],
    ['union_declaration', 'Blob', 239, 268], ['type', 'int', 255, 258], ['type', 'string', 260, 266],
    ['procedure_declaration', 'tagged', 269, 317],
  ]);
  assert.deepEqual(result.declarations[0].result, { state: 'declared', syntax: '(first: int, ok: bool)' });
  assert.deepEqual(result.declarations[1].parameters, ['$T: typeid', 'value: T']);
  assert.deepEqual(result.declarations[2].parameters, ['#no_alias src: []u8', '#no_alias dst: []u8']);
  assert.equal(result.declarations[3].signature, 'group :: proc{pair, identity}');
  assert.equal(result.declarations[7].signature, '<attribute> tagged :: proc()');
  assert.ok(!JSON.stringify(result.declarations).includes('private note'));
});

test('each real grammar reports additions, deletion, duplicate ambiguity and body-only change', async () => {
  const cases = {
    kotlin: { one: 'fun one(x: Int): Int { return x }\n',
      two: 'fun two(x: Int): Int { return x }\n',
      duplicate: 'fun same(x: Int): Int { return x }\nfun same(x: Int): Int { return x + 1 }\n',
      duplicateChanged: 'fun same(x: Int): Int { return x + 2 }\nfun same(x: Int): Int { return x + 3 }\n' },
    zig: { one: 'pub fn one(x: i32) i32 { return x; }\n',
      two: 'pub fn two(x: i32) i32 { return x; }\n',
      duplicate: 'pub fn same(x: i32) i32 { return x; }\npub fn same(x: i32) i32 { return x + 1; }\n',
      duplicateChanged: 'pub fn same(x: i32) i32 { return x + 2; }\npub fn same(x: i32) i32 { return x + 3; }\n' },
    odin: { one: 'one :: proc(x: int) -> int { return x }\n',
      two: 'two :: proc(x: int) -> int { return x }\n',
      duplicate: 'same :: proc(x: int) -> int { return x }\nsame :: proc(x: int) -> int { return x + 1 }\n',
      duplicateChanged: 'same :: proc(x: int) -> int { return x + 2 }\nsame :: proc(x: int) -> int { return x + 3 }\n' },
  };
  for (const [dialect, sample] of Object.entries(cases)) {
    const empty = await extract(dialect, '');
    const one = await extract(dialect, sample.one, 2);
    const two = await extract(dialect, sample.one + sample.two, 3);
    const added = compareExtractions(empty, two);
    assert.deepEqual(added.changes.map(change => [change.kind, change.observed?.name]),
      [['added', 'one'], ['added', 'two']], dialect);
    const removed = compareExtractions(two, one);
    assert.deepEqual(removed.changes.map(change => [change.kind, change.input?.name]), [['removed', 'two']], dialect);
    const before = await extract(dialect, sample.duplicate, 4);
    const after = await extract(dialect, sample.duplicateChanged, 5);
    const ambiguous = compareExtractions(before, after);
    assert.equal(ambiguous.changes.length, 4, dialect);
    assert.ok(ambiguous.changes.every(change => change.kind === 'ambiguous'), dialect);
    assert.ok(ambiguous.limitations.includes('declaration_correspondence_ambiguous'), dialect);
    const body = compareExtractions(one, await extract(dialect, sample.one.replace('return x', 'return x + 1'), 6));
    assert.deepEqual(body.changes.map(change => [change.kind, change.declaration_changed, change.body_changed]),
      [['modified', false, true]], dialect);
  }
});

test('qualified Kotlin grammar preserves named context parameters and legacy receiver syntax as written', async () => {
  const source = await readFile(new URL('../fixtures/structural/languages/kotlin/context.kt', import.meta.url), 'utf8');
  const result = await extract('kotlin', source);
  assert.equal(result.coverage, 'complete');
  assert.deepEqual(result.declarations.map(d => [d.kind, d.name, d.signature]), [
    ['function_declaration', 'read', 'context(user: User) fun read(x: Int): Int'],
    ['property_declaration', 'count', 'context(user: User) val count: Int'],
    ['function_declaration', 'old', 'context(User) fun old(): Unit'],
  ]);
  assert.deepEqual(result.declarations[0].parameters, ['x: Int']);
  assert.deepEqual(result.declarations[0].result, { state: 'declared', syntax: 'Int' });
  assert.deepEqual(result.declarations[1].result, { state: 'declared', syntax: 'Int' });
  assert.deepEqual(result.declarations[0].range, { start_byte: 10, end_byte: 55 });
});

test('nested Kotlin declarations inside a function are explicitly outside direct coverage', async () => {
  const result = await extract('kotlin', 'fun outer() {\n fun inner(): Int = 1\n}\n');
  assert.equal(result.coverage, 'incomplete');
  assert.ok(result.limitations.includes('nested_declaration_coverage_unavailable'));
  assert.deepEqual(result.declarations.map(declaration => declaration.name), ['outer']);
});

test('all three native grammars map a multibyte codepoint spanning a 4 KiB byte boundary', async () => {
  const prefix = `//${'a'.repeat(4093)}é😀\n`;
  assert.equal(Buffer.byteLength(prefix), 4102);
  const declarations = {
    kotlin: 'fun f(): Int = 1\n',
    zig: 'pub fn f() i32 { return 1; }\n',
    odin: 'f :: proc() -> int { return 1 }\n',
  };
  for (const [dialect, declaration] of Object.entries(declarations)) {
    const result = await extract(dialect, prefix + declaration);
    assert.equal(result.coverage, 'complete', dialect);
    assert.deepEqual(result.declarations[0].range,
      { start_byte: 4102, end_byte: 4102 + Buffer.byteLength(declaration.trimEnd()) }, dialect);
  }
});

test('result annotations mask comments in Kotlin, Zig, and Odin native syntax trees', async () => {
  const sources = {
    kotlin: 'fun f(): List</* private result */String> = emptyList()\n',
    zig: 'pub fn f() ?\n// private result\ni32 { return null; }\n',
    odin: 'f :: proc() -> (first: int, /* private result */ ok: bool) { return 1, true }\n',
  };
  for (const [dialect, source] of Object.entries(sources)) {
    const result = await extract(dialect, source);
    assert.equal(result.coverage, 'complete', dialect);
    assert.equal(result.declarations.length, 1, dialect);
    assert.equal(result.declarations[0].result.state, 'declared', dialect);
    assert.ok(result.declarations[0].result.syntax.includes('<comment>'), dialect);
    assert.ok(result.declarations[0].signature.includes('<comment>'), dialect);
    assert.ok(!JSON.stringify(result.declarations).includes('private result'), dialect);
  }
});

test('L06/L07/L11 canonical source files match independent declarations, ranges, changes, and incomplete expectations', async () => {
  for (const dialect of ['kotlin', 'zig', 'odin']) {
    const cases = JSON.parse(await caseFile(dialect, 'cases.json'));
    const expected = JSON.parse(await caseFile(dialect, cases.expectations));
    assert.equal(cases.dialect, dialect);
    const input = await extract(dialect, await caseFile(dialect, cases.input));
    const changed = await extract(dialect, await caseFile(dialect, cases.changed), 2);
    const incomplete = await extract(dialect, await caseFile(dialect, cases.incomplete), 3);
    const advancedResult = await extract(dialect, await caseFile(dialect, cases.advanced), 4);
    assert.equal(input.coverage, 'complete', dialect);
    assert.deepEqual(input.declarations.map(d => [d.kind, d.name, d.enclosing, d.signature,
      d.range.start_byte, d.range.end_byte]), expected.input_declarations, dialect);
    const comparison = compareExtractions(input, changed);
    assert.deepEqual(comparison.changes.map(change => [change.kind, change.observed?.name ?? change.input?.name,
      change.declaration_changed, change.body_changed, change.default_changed]), expected.changes, dialect);
    assert.equal(incomplete.coverage, 'incomplete', dialect);
    assert.deepEqual(incomplete.limitations, expected.incomplete_limitations, dialect);
    assert.deepEqual(advancedResult.declarations.map(d => [d.kind, d.name, d.signature,
      d.range.start_byte, d.range.end_byte]), expected.advanced_declarations, dialect);
    if (cases.context) {
      const context = await extract(dialect, await caseFile(dialect, cases.context), 5);
      assert.equal(context.coverage, 'complete');
      assert.deepEqual(context.declarations.map(d => [d.kind, d.name, d.signature,
        d.range.start_byte, d.range.end_byte]), expected.context_declarations);
    }
  }
});
