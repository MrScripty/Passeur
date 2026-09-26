import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extractNativeFunctions, emptyNativeExtraction } from '../../.passeur-native/src/observation/native-extraction.js';
import { compareExtractions } from '../../.passeur-native/src/observation/match.js';
import { loadNativeParser, nativeParserIdentity } from '../../.passeur-native/src/observation/native-parser.js';

const sha256 = text => createHash('sha256').update(text).digest('hex');
function captured(text, path = 'example.ts', capture_sequence = 1) {
  return { status: 'present', source: { kind: 'working_capture', repository_id: 'test-repository', object_format: 'sha1',
    workspace_id: 'test-workspace', workspace_generation: 1, capture_id: `sample-${capture_sequence}`,
    capture_sequence, head_anchor: 'a'.repeat(40), path }, mode: '100644',
    content_sha256: sha256(text), byte_length: Buffer.byteLength(text), text, consistency: 'sampled_file_not_atomic' };
}

test('real TypeScript grammar extracts a masked written header and direct body marker', async () => {
  const before = 'export function greet(name: string = "secret one"): string { return name; }\n';
  const after = 'export function greet(name: string = "secret two"): string { return name + "!"; }\n';
  const input = await extractNativeFunctions(captured(before), 'typescript');
  const observed = await extractNativeFunctions(captured(after, 'example.ts', 2), 'typescript');
  assert.equal(input.coverage, 'complete');
  assert.equal(observed.coverage, 'complete');
  assert.equal(input.declarations.length, 1);
  assert.equal(input.declarations[0].name, 'greet');
  assert.equal(input.declarations[0].signature, 'export function greet(name: string = <default>): string');
  assert.deepEqual(input.declarations[0].parameters, ['name: string = <default>']);
  assert.deepEqual(input.declarations[0].result, { state: 'declared', syntax: ': string' });
  assert.deepEqual(input.declarations[0].range, { start_byte: 0, end_byte: Buffer.byteLength(before.trimEnd()) });
  assert.ok(!JSON.stringify(input.declarations).includes('secret one'));
  const comparison = compareExtractions(input, observed);
  assert.equal(comparison.changes.length, 1);
  assert.equal(comparison.changes[0].default_changed, true);
  assert.equal(comparison.changes[0].body_changed, true);
});

test('real Rust grammar maps Unicode source ranges and retains explicit result', async () => {
  const source = '// é😀\nfn add(x: i32) -> i32 { x + 1 }\n';
  const result = await extractNativeFunctions(captured(source, 'example.rs'), 'rust');
  assert.equal(result.coverage, 'complete');
  assert.equal(result.declarations.length, 1);
  assert.deepEqual(result.declarations[0].range, { start_byte: 10, end_byte: 10 + Buffer.byteLength('fn add(x: i32) -> i32 { x + 1 }') });
  assert.deepEqual(result.declarations[0].result, { state: 'declared', syntax: 'i32' });
});

test('real TSX grammar keeps JSX in a body digest without presenting it as a signature', async () => {
  const source = 'export function Panel(x: number) { return <section>{x}</section>; }\n';
  const result = await extractNativeFunctions(captured(source, 'Panel.tsx'), 'tsx');
  assert.equal(result.coverage, 'complete');
  assert.equal(result.declarations[0].signature, 'export function Panel(x: number)');
  assert.deepEqual(result.declarations[0].result, { state: 'not_declared' });
  assert.equal(result.declarations[0].body_digest.length, 64);
  assert.ok(!result.declarations[0].signature.includes('section'));
});

test('real TypeScript lexical declarations retain written types, scope and UTF-8 ranges', async () => {
  const source = '// é😀\nexport const café: string = "secret-one";\nlet count = 2;\nvar flag: boolean;\n';
  const result = await extractNativeFunctions(captured(source), 'typescript');
  assert.equal(result.coverage, 'complete');
  assert.deepEqual(result.declarations.map(d => [d.kind, d.name, d.enclosing, d.signature, d.result]), [
    ['variable_declarator', 'café', [], 'export const café: string = <default>;', { state: 'declared', syntax: ': string' }],
    ['variable_declarator', 'count', [], 'let count = <default>;', { state: 'not_declared' }],
    ['variable_declarator', 'flag', [], 'var flag: boolean;', { state: 'declared', syntax: ': boolean' }],
  ]);
  const start = Buffer.byteLength('// é😀\n');
  assert.deepEqual(result.declarations[0].range, { start_byte: start,
    end_byte: start + Buffer.byteLength('export const café: string = "secret-one";') });
  assert.ok(!JSON.stringify(result.declarations).includes('secret-one'));
});

test('multiple declarators and destructuring mask initializer and binding defaults separately', async () => {
  const source = 'const first = privateOne, {x, y: renamed = privateTwo}: Shape = privateThree;\n' +
    'let [left, right = privateFour]: Pair = privateFive;\n';
  const result = await extractNativeFunctions(captured(source), 'typescript');
  assert.equal(result.coverage, 'complete');
  assert.deepEqual(result.declarations.map(d => [d.name, d.signature, d.result]), [
    ['first', 'const first = <default>', { state: 'not_declared' }],
    ['{x, y: renamed = <default>}', 'const {x, y: renamed = <default>}: Shape = <default>',
      { state: 'declared', syntax: ': Shape' }],
    ['[left, right = <default>]', 'let [left, right = <default>]: Pair = <default>;',
      { state: 'declared', syntax: ': Pair' }],
  ]);
  assert.deepEqual(result.declarations.map(d => d.default_digests.length), [1, 2, 2]);
  assert.ok(!/private(One|Two|Three|Four|Five)/.test(JSON.stringify(result.declarations)));
  assert.ok(result.declarations[0].range.end_byte <= result.declarations[1].range.start_byte);
});

test('initializer-only edits differ from written edits, additions, removals and unchanged variables', async () => {
  const before = 'const changed: number = 1;\nlet stable = 7;\nvar removed = 3;\n';
  const after = 'const changed: number = 2;\nlet stable = 7;\nvar added = 4;\n';
  const input = await extractNativeFunctions(captured(before), 'typescript');
  const observed = await extractNativeFunctions(captured(after, 'example.ts', 2), 'typescript');
  assert.equal(input.coverage, 'complete');
  assert.equal(observed.coverage, 'complete');
  assert.deepEqual(compareExtractions(input, observed).changes.map(c => [
    c.observed?.name ?? c.input?.name, c.kind, c.declaration_changed, c.default_changed,
  ]), [
    ['added', 'added', true, false], ['changed', 'modified', false, true], ['removed', 'removed', true, false],
  ]);
  const written = await extractNativeFunctions(captured('const changed: string = 1;\nlet stable = 7;\nvar removed = 3;\n',
    'example.ts', 3), 'typescript');
  assert.deepEqual(compareExtractions(input, written).changes.map(c => [c.observed?.name, c.declaration_changed,
    c.default_changed]), [['changed', true, false]]);
});

test('TSX lexical JSX initializers stay concealed and function-valued bindings retain their path', async () => {
  const source = 'export const title: string = "privateTitle", view = <div secret="privateJSX" />;\n' +
    'export const render = (x: number): number => x + 1;\n';
  const result = await extractNativeFunctions(captured(source, 'Panel.tsx'), 'tsx');
  assert.equal(result.coverage, 'complete');
  assert.deepEqual(result.declarations.map(d => [d.kind, d.name, d.signature]), [
    ['variable_declarator', 'title', 'export const title: string = <default>'],
    ['variable_declarator', 'view', 'export const view = <default>'],
    ['arrow_function', 'render', 'export const render = (x: number): number =>'],
  ]);
  assert.ok(!/privateTitle|privateJSX/.test(JSON.stringify(result.declarations)));
});

test('nested binding defaults and declaration comments remain concealed', async () => {
  const source = 'const {a: {b = innerSecret} = outerSecret} = sourceSecret;\n' +
    'const /* commentSecret */ value = initializerSecret;\n';
  const result = await extractNativeFunctions(captured(source), 'typescript');
  assert.equal(result.coverage, 'complete');
  assert.deepEqual(result.declarations.map(d => [d.name, d.signature]), [
    ['{a: {b = <default>} = <default>}', 'const {a: {b = <default>} = <default>} = <default>;'],
    ['value', 'const <comment> value = <default>;'],
  ]);
  for (const secret of ['innerSecret', 'outerSecret', 'sourceSecret', 'commentSecret', 'initializerSecret'])
    assert.equal(JSON.stringify(result.declarations).includes(secret), false);
});

test('export-prefix comments remain concealed for every lexical declarator', async () => {
  const result = await extractNativeFunctions(captured('export /* commentSecret */ const first = 1, second = 2;\n'), 'typescript');
  assert.equal(result.coverage, 'complete');
  assert.equal(result.declarations.length, 2);
  assert.ok(result.declarations.every(d => d.signature.includes('<comment>')));
  assert.equal(JSON.stringify(result.declarations).includes('commentSecret'), false);
});

test('every lexical declarator retains mutability in direct comparison', async () => {
  const input = await extractNativeFunctions(captured('const first = 1, second = 2;\n'), 'typescript');
  const observed = await extractNativeFunctions(captured('let first = 1, second = 2;\n', 'example.ts', 2), 'typescript');
  assert.deepEqual(compareExtractions(input, observed).changes.map(change => change.observed?.name), ['first', 'second']);
});

test('multiple function-valued declarators retain mutability in direct comparison', async () => {
  const input = await extractNativeFunctions(captured('const first = () => 1, second = () => 2;\n'), 'typescript');
  const observed = await extractNativeFunctions(captured('let first = () => 1, second = () => 2;\n', 'example.ts', 2), 'typescript');
  assert.deepEqual(compareExtractions(input, observed).changes.map(change => change.observed?.name), ['first', 'second']);
});

test('declaration-like constructs inside concealed initializers remain an explicit limit', async () => {
  const source = 'const Holder = class Hidden { value: string; get(): number { return 1; } };\n' +
    'const wrapped = ((x: number): number => x);\n';
  const result = await extractNativeFunctions(captured(source), 'typescript');
  assert.equal(result.coverage, 'incomplete');
  assert.ok(result.limitations.includes('nested_declaration_coverage_unavailable'));
  assert.equal(JSON.stringify(result.declarations).includes('Hidden'), false);
  assert.equal(JSON.stringify(result.declarations).includes('number'), false);
});

test('parenthesized and destructuring-default declarations retain an explicit limit', async () => {
  const source = 'const Holder = (class Hidden { value: string; });\n' +
    'const {factory = (() => hiddenSecret)} = source;\n';
  const result = await extractNativeFunctions(captured(source), 'typescript');
  assert.equal(result.coverage, 'incomplete');
  assert.ok(result.limitations.includes('nested_declaration_coverage_unavailable'));
  assert.equal(JSON.stringify(result.declarations).includes('Hidden'), false);
  assert.equal(JSON.stringify(result.declarations).includes('hiddenSecret'), false);
});

test('declaration-like class expressions returned from functions retain an explicit limit', async () => {
  for (const dialect of ['typescript', 'tsx']) {
    const result = await extractNativeFunctions(captured(
      'function outer() { return class Hidden { value: number; }; }\n', `${dialect}.source`), dialect);
    assert.equal(result.coverage, 'incomplete', dialect);
    assert.deepEqual(result.declarations.map(declaration => declaration.name), ['outer'], dialect);
    assert.ok(result.limitations.includes('nested_declaration_coverage_unavailable'), dialect);
  }
});

test('generator bindings retain written parameters and results', async () => {
  const result = await extractNativeFunctions(captured('const make = function* (x: number): Generator<number> { yield x; };\n'), 'typescript');
  assert.equal(result.coverage, 'complete');
  assert.deepEqual(result.declarations.map(d => [d.kind, d.name, d.signature, d.parameters, d.result]), [
    ['generator_function', 'make', 'const make = function* (x: number): Generator<number>',
      ['x: number'], { state: 'declared', syntax: ': Generator<number>' }],
  ]);
});

test('TypeScript namespaces retain their scope and nested declarations', async () => {
  const result = await extractNativeFunctions(captured('namespace Space { export const x: number = 1; }\n'), 'typescript');
  assert.equal(result.coverage, 'complete');
  assert.deepEqual(result.declarations.map(d => [d.kind, d.name, d.enclosing, d.signature]), [
    ['internal_module', 'Space', [], 'namespace Space'],
    ['variable_declarator', 'x', ['Space'], 'export const x: number = <default>;'],
  ]);
});

test('namespace member edits do not duplicate as parent body changes', async () => {
  const input = await extractNativeFunctions(captured('namespace Space { export const x: number = 1; }\n', 'space.ts'), 'typescript');
  const observed = await extractNativeFunctions(captured('namespace Space { export const x: number = 2; }\n', 'space.ts', 2), 'typescript');
  assert.deepEqual(compareExtractions(input, observed).changes.map(change => [
    change.observed?.name ?? change.input?.name, change.default_changed, change.body_changed,
  ]), [['x', true, false]]);
});

test('malformed and unsupported lexical bindings remain explicit limitations', async () => {
  const malformed = await extractNativeFunctions(captured('const broken = ;\n'), 'typescript');
  assert.equal(malformed.coverage, 'incomplete');
  assert.ok(malformed.limitations.includes('parse_error_or_missing_token'));
  assert.ok(malformed.declarations.every(d => !d.header_complete));
  const unsupported = await extractNativeFunctions(captured('const {[secretKey]: value} = source;\n'), 'typescript');
  assert.equal(unsupported.coverage, 'incomplete');
  assert.ok(unsupported.limitations.includes('unmapped_binding_syntax'));
  assert.ok(!JSON.stringify(unsupported.declarations).includes('secretKey'));
});

test('local ordinary variables remain outside the admitted inventory with explicit incomplete coverage', async () => {
  const result = await extractNativeFunctions(captured('function outer() { const local: string = "hidden"; }\n'), 'typescript');
  assert.equal(result.coverage, 'incomplete');
  assert.deepEqual(result.declarations.map(d => d.name), ['outer']);
  assert.ok(result.limitations.includes('nested_declaration_coverage_unavailable'));
  assert.ok(!JSON.stringify(result.declarations).includes('hidden'));
});

test('qualified multilingual limits do not masquerade as complete declarations', async () => {
  const rust = await extractNativeFunctions(captured('const LIMIT: usize = 3;\n', 'limits.rs'), 'rust');
  assert.equal(rust.coverage, 'incomplete');
  assert.deepEqual(rust.declarations, []);
  assert.ok(rust.limitations.includes('unmapped_top_level_syntax'));
  const javascript = await extractNativeFunctions(captured('const ordinary = 3;\n', 'ordinary.mjs'), 'javascript');
  assert.equal(javascript.coverage, 'incomplete');
  assert.deepEqual(javascript.declarations, []);
  assert.ok(javascript.limitations.includes('unmapped_binding_syntax'));
  const rustLocal = await extractNativeFunctions(captured(
    'fn run(value: Option<i32>) { const LOCAL: i32 = 1; match value { Some(captured) => captured, _ => 0 }; let closure = |arg: i32| arg; }\n',
    'local.rs'), 'rust');
  assert.equal(rustLocal.coverage, 'incomplete');
  assert.ok(rustLocal.limitations.includes('nested_declaration_coverage_unavailable'));
  for (const [dialect, path, source] of [
    ['c', 'local.c', 'int run(void) { int local = 1; return local; }\n'],
    ['zig', 'local.zig', 'fn run() void { const local: i32 = 1; }\n'],
    ['zig', 'loop.zig', 'fn run(items: []i32) void { for (items) |item| { _ = item; } }\n'],
    ['odin', 'local.odin', 'run :: proc() { LOCAL :: 1; }\n'],
    ['kotlin', 'local.kt', 'fun run(value: Any?) { try { } catch (error: Exception) { println(error) } }\n'],
    ['csharp', 'local.cs', 'class C { void run(object value) { if (value is int local) { System.Console.WriteLine(local); } } }\n'],
    ['csharp', 'global.cs', 'class C {}\nint top = 1;\n'],
  ]) {
    const result = await extractNativeFunctions(captured(source, path), dialect);
    assert.equal(result.coverage, 'incomplete', dialect);
    assert.ok(result.limitations.includes(dialect === 'csharp' && path === 'global.cs' ?
      'unmapped_top_level_syntax' : 'unmapped_local_syntax'), dialect);
  }
  for (const [dialect, source] of [
    ['typescript', 'function outer() { try {} catch (local) {} }\n'],
    ['tsx', 'function outer() { try {} catch (local) {} }\n'],
  ]) {
    const result = await extractNativeFunctions(captured(source, `${dialect}.source`), dialect);
    assert.equal(result.coverage, 'incomplete', dialect);
    assert.ok(result.limitations.includes('nested_declaration_coverage_unavailable'), dialect);
  }
  const cppCatch = await extractNativeFunctions(captured('int run() { try {} catch (int local) { return local; } return 0; }\n', 'catch.cpp'), 'cpp');
  assert.equal(cppCatch.coverage, 'incomplete');
  assert.ok(cppCatch.limitations.includes('unmapped_local_syntax'));
});

test('loop-local TypeScript bindings remain outside the admitted inventory explicitly', async () => {
  const result = await extractNativeFunctions(captured('function outer(items: string[]) { for (const local of items) { console.log(local); } }\n'), 'typescript');
  assert.equal(result.coverage, 'incomplete');
  assert.deepEqual(result.declarations.map(d => d.name), ['outer']);
  assert.ok(result.limitations.includes('nested_declaration_coverage_unavailable'));
});

test('real Rust type and direct field/method declarations retain their own scopes', async () => {
  const source = 'pub struct Point<T> { x: T, y: T }\nimpl<T> Point<T> { pub fn shift(&mut self, dx: T) { } }\n';
  const result = await extractNativeFunctions(captured(source, 'point.rs'), 'rust');
  assert.equal(result.coverage, 'complete');
  assert.deepEqual(result.declarations.map(d => [d.kind, d.name, d.enclosing]), [
    ['struct_item', 'Point', []], ['field_declaration', 'x', ['Point']], ['field_declaration', 'y', ['Point']],
    ['impl_item', 'Point<T>', []], ['function_item', 'shift', ['Point<T>']],
  ]);
  assert.deepEqual(result.declarations[1].result, { state: 'declared', syntax: 'T' });
  assert.equal(result.declarations[4].parameters[0], '&mut self');
});

test('real TypeScript interface and class members are separate directly changed declarations', async () => {
  const before = 'export interface Point { x: number; move(dx: number): void }\nexport class Box { value: number; get(): number { return this.value; } }\n';
  const after = 'export interface Point { x: string; move(dx: number): void }\nexport class Box { value: number; get(): number { return this.value; } }\n';
  const input = await extractNativeFunctions(captured(before), 'typescript');
  const observed = await extractNativeFunctions(captured(after, 'example.ts', 2), 'typescript');
  assert.equal(input.coverage, 'complete');
  assert.deepEqual(input.declarations.map(d => [d.kind, d.name, d.enclosing]), [
    ['interface_declaration', 'Point', []], ['property_signature', 'x', ['Point']], ['method_signature', 'move', ['Point']],
    ['class_declaration', 'Box', []], ['public_field_definition', 'value', ['Box']], ['method_definition', 'get', ['Box']],
  ]);
  const comparison = compareExtractions(input, observed);
  assert.deepEqual(comparison.changes.map(change => change.observed?.name ?? change.input?.name), ['x']);
});

test('native class field initializers are masked and method body edits are marker-only', async () => {
  const before = 'class C { value: string = "private one"; get(): string { return this.value; } }\n';
  const after = 'class C { value: string = "private two"; get(): string { return this.value + "!"; } }\n';
  const input = await extractNativeFunctions(captured(before), 'typescript');
  const observed = await extractNativeFunctions(captured(after, 'example.ts', 2), 'typescript');
  assert.equal(input.coverage, 'complete');
  assert.equal(input.declarations[1].signature, 'value: string = <default>');
  assert.ok(!JSON.stringify(input.declarations).includes('private one'));
  const changes = compareExtractions(input, observed).changes;
  assert.deepEqual(changes.map(change => [change.observed?.name, change.default_changed, change.body_changed]),
    [['get', false, true], ['value', true, false]]);
});

test('real Rust aliases and enum variants show directly written types without inferred users', async () => {
  const source = 'pub type Id<T> = Vec<T>;\npub enum Kind { A, B(i32), C { x: i32 } }\n';
  const result = await extractNativeFunctions(captured(source, 'kind.rs'), 'rust');
  assert.equal(result.coverage, 'complete');
  assert.deepEqual(result.declarations.map(d => [d.kind, d.name, d.enclosing]), [
    ['type_item', 'Id', []], ['enum_item', 'Kind', []], ['enum_variant', 'A', ['Kind']],
    ['enum_variant', 'B', ['Kind']], ['enum_variant', 'C', ['Kind']],
  ]);
  assert.equal(result.declarations[0].signature, 'pub type Id<T> = Vec<T>;');
  assert.deepEqual(result.declarations[0].result, { state: 'declared', syntax: 'Vec<T>' });
  assert.equal(result.declarations[3].signature, 'B(i32)');
});

test('real TypeScript aliases expose type syntax while enum values remain masked', async () => {
  const source = 'export type Id<T> = ReadonlyArray<T>;\nexport enum Kind { A, B = 2, C }\n';
  const result = await extractNativeFunctions(captured(source), 'typescript');
  assert.equal(result.coverage, 'complete');
  assert.deepEqual(result.declarations.map(d => [d.kind, d.name, d.enclosing]), [
    ['type_alias_declaration', 'Id', []], ['enum_declaration', 'Kind', []],
    ['property_identifier', 'A', ['Kind']], ['enum_assignment', 'B', ['Kind']], ['property_identifier', 'C', ['Kind']],
  ]);
  assert.equal(result.declarations[0].signature, 'export type Id<T> = ReadonlyArray<T>;');
  assert.deepEqual(result.declarations[0].result, { state: 'declared', syntax: 'ReadonlyArray<T>' });
  assert.equal(result.declarations[3].signature, 'B = <default>');
});

test('generic default type expressions are masked while the declared alias type remains visible', async () => {
  const result = await extractNativeFunctions(captured('export type Id<T = Secret> = ReadonlyArray<T>;\n'), 'typescript');
  assert.equal(result.coverage, 'complete');
  assert.equal(result.declarations[0].signature, 'export type Id<T = <default>> = ReadonlyArray<T>;');
  assert.ok(!JSON.stringify(result.declarations).includes('Secret'));
});

test('type arrows and Rust associated type constraints remain observed headers', async () => {
  const ts = await extractNativeFunctions(captured('function f(cb: () => void): void {}\n'), 'typescript');
  const rust = await extractNativeFunctions(captured('fn f<T: Iterator<Item = u8>>() {}\n', 'example.rs'), 'rust');
  assert.equal(ts.coverage, 'complete');
  assert.equal(rust.coverage, 'complete');
  assert.equal(ts.declarations[0].header_complete, true);
  assert.equal(rust.declarations[0].header_complete, true);
  assert.ok(ts.declarations[0].signature.includes('() => void'));
  assert.ok(rust.declarations[0].signature.includes('Item = u8'));
});

test('unrelated syntax damage does not erase a valid native declaration', async () => {
  const result = await extractNativeFunctions(captured('export function valid(x: number): number { return x; }\nconst broken = ;\n'), 'typescript');
  assert.equal(result.coverage, 'incomplete');
  assert.ok(result.limitations.includes('parse_error_or_missing_token'));
  assert.equal(result.declarations[0].name, 'valid');
  assert.equal(result.declarations[0].header_complete, true);
});

test('real Rust trait signatures, impl receivers, and modules retain written scopes', async () => {
  const source = 'pub trait Service { fn run(&self, x: &str) -> usize; }\n' +
    'impl Service for Worker { fn run(&self, x: &str) -> usize { x.len() } }\n' +
    'mod internal { pub fn helper() {} }\n';
  const result = await extractNativeFunctions(captured(source, 'service.rs'), 'rust');
  assert.equal(result.coverage, 'complete');
  assert.deepEqual(result.declarations.map(d => [d.kind, d.name, d.enclosing]), [
    ['trait_item', 'Service', []], ['function_signature_item', 'run', ['Service']],
    ['impl_item', 'Service for Worker', []], ['function_item', 'run', ['Service for Worker']],
    ['mod_item', 'internal', []], ['function_item', 'helper', ['internal']],
  ]);
  assert.deepEqual(result.declarations[1].parameters, ['&self', 'x: &str']);
  assert.deepEqual(result.declarations[1].result, { state: 'declared', syntax: 'usize' });
  assert.deepEqual(result.declarations[5].result, { state: 'not_declared' });
});

test('real valid Rust generic headers keep type constraints and conceal defaults and attributes', async () => {
  const before = '#[doc = "secret one"] pub struct Config<T = i32> { value: T }\n' +
    'pub async fn run<T: Iterator<Item = u8> + Clone>(mut x: T) -> i32 where T: Clone { x.next(); 1 }\n';
  const after = '#[doc = "secret two"] pub struct Config<T = i64> { value: T }\n' +
    'pub async fn run<T: Iterator<Item = u8> + Clone>(mut x: T) -> i32 where T: Clone { x.next(); 1 }\n';
  const input = await extractNativeFunctions(captured(before, 'generic.rs'), 'rust');
  const observed = await extractNativeFunctions(captured(after, 'generic.rs', 2), 'rust');
  assert.equal(input.coverage, 'complete');
  assert.equal(input.declarations[0].signature,
    '<attribute> pub struct Config<T = <default>>');
  assert.equal(input.declarations[0].default_digests.length, 2);
  assert.equal(input.declarations[2].signature,
    'pub async fn run<T: Iterator<Item = u8> + Clone>(mut x: T) -> i32 where T: Clone');
  assert.ok(!JSON.stringify(input.declarations).includes('secret one'));
  const change = compareExtractions(input, observed).changes.find(change => change.observed?.name === 'Config');
  assert.equal(change.default_changed, true);
  assert.equal(change.declaration_changed, false);
});

test('real Rust nested functions charge edits to the inner declaration only', async () => {
  const before = 'fn outer() { let x = 1; fn inner(x: i32) -> i32 { x + 1 } }\n';
  const after = 'fn outer() { let x = 1; fn inner(x: i32) -> i32 { x + 2 } }\n';
  const input = await extractNativeFunctions(captured(before, 'nested.rs'), 'rust');
  const observed = await extractNativeFunctions(captured(after, 'nested.rs', 2), 'rust');
  assert.equal(input.coverage, 'incomplete');
  assert.ok(input.limitations.includes('nested_declaration_coverage_unavailable'));
  assert.deepEqual(input.declarations.map(d => [d.name, d.enclosing]), [['outer', []], ['inner', ['outer']]]);
  assert.deepEqual(compareExtractions(input, observed).changes.map(c => [c.observed?.name, c.body_changed]), [['inner', true]]);
});

test('same method name in distinct Rust trait impls remains in distinct scopes', async () => {
  const before = 'impl A for Worker { fn run(&self) { 1; } }\nimpl B for Worker { fn run(&self) { 2; } }\n';
  const after = 'impl A for Worker { fn run(&self) { 3; } }\nimpl B for Worker { fn run(&self) { 2; } }\n';
  const input = await extractNativeFunctions(captured(before, 'impls.rs'), 'rust');
  const observed = await extractNativeFunctions(captured(after, 'impls.rs', 2), 'rust');
  assert.equal(input.coverage, 'complete');
  assert.deepEqual(input.declarations.filter(d => d.name === 'run').map(d => d.enclosing),
    [['A for Worker'], ['B for Worker']]);
  const changes = compareExtractions(input, observed).changes;
  assert.deepEqual(changes.map(change => [change.observed?.name, change.observed?.enclosing, change.body_changed]),
    [['run', ['A for Worker'], true]]);
});

test('real TypeScript overloads and named arrows expose written signatures, parameters and results', async () => {
  const source = 'export function convert(x: string): number;\n' +
    'export function convert(x: number): string;\n' +
    'export function convert(x: string | number): string | number { return x; }\n' +
    'export const mapper = ({key}: Key, ...rest: string[]): string => key + rest.join("");\n';
  const result = await extractNativeFunctions(captured(source), 'typescript');
  assert.equal(result.coverage, 'complete');
  assert.deepEqual(result.declarations.map(d => [d.kind, d.name]), [
    ['function_signature', 'convert'], ['function_signature', 'convert'],
    ['function_declaration', 'convert'], ['arrow_function', 'mapper'],
  ]);
  assert.deepEqual(result.declarations[3].parameters, ['{key}: Key', '...rest: string[]']);
  assert.deepEqual(result.declarations[3].result, { state: 'declared', syntax: ': string' });
  assert.equal(result.declarations[3].signature,
    'export const mapper = ({key}: Key, ...rest: string[]): string =>');
  assert.ok(!result.declarations[3].signature.includes('rest.join'));
});

test('real TSX named component arrow conceals destructured default and charges JSX-only edits to body', async () => {
  const before = 'export const Panel = ({x}: Props = privateOne): JSX.Element => <div>{x}</div>;\n';
  const after = 'export const Panel = ({x}: Props = privateOne): JSX.Element => <span>{x}</span>;\n';
  const input = await extractNativeFunctions(captured(before, 'Panel.tsx'), 'tsx');
  const observed = await extractNativeFunctions(captured(after, 'Panel.tsx', 2), 'tsx');
  assert.equal(input.coverage, 'complete');
  assert.equal(input.declarations[0].signature,
    'export const Panel = ({x}: Props = <default>): JSX.Element =>');
  assert.deepEqual(input.declarations[0].parameters, ['{x}: Props = <default>']);
  assert.deepEqual(input.declarations[0].result, { state: 'declared', syntax: ': JSX.Element' });
  assert.ok(!JSON.stringify(input.declarations).includes('privateOne'));
  const change = compareExtractions(input, observed).changes[0];
  assert.equal(change.body_changed, true);
  assert.equal(change.default_changed, false);
  assert.equal(change.declaration_changed, false);
});

test('real TypeScript comments and decorators in compact headers never expose argument values', async () => {
  const source = '@route("secret") export class C { @field("hidden") value: string = "private"; ' +
    '@method("hidden") method(/* note */ x: number = {a: 1}): number { return x; } }\n';
  const result = await extractNativeFunctions(captured(source), 'typescript');
  assert.equal(result.coverage, 'complete');
  assert.deepEqual(result.declarations.map(d => d.signature), [
    '<attribute> export class C', '<attribute> value: string = <default>',
    '<attribute> method(<comment> x: number = <default>): number',
  ]);
  assert.deepEqual(result.declarations[2].parameters, ['x: number = <default>']);
  for (const hidden of ['secret', 'hidden', 'private', 'note', '{a: 1}']) {
    assert.ok(!JSON.stringify(result.declarations).includes(hidden));
  }
});

test('malformed body leaves valid header available with explicit incomplete body coverage', async () => {
  const result = await extractNativeFunctions(captured('function f(x: number): number { return +; }\n'), 'typescript');
  assert.equal(result.declarations[0].header_complete, true);
  assert.equal(result.coverage, 'incomplete');
  assert.ok(result.limitations.includes('declaration_body_incomplete'));
  assert.equal(result.declarations[0].body_digest, undefined);
});

test('imports and macro token regions remain visible as opaque outside-declaration changes', async () => {
  const rustBefore = 'use crate::old;\nmacro_rules! token { () => { 1 } }\nfn stable() {}\n';
  const rustAfter = 'use crate::new;\nmacro_rules! token { () => { 2 } }\nfn stable() {}\n';
  const input = await extractNativeFunctions(captured(rustBefore, 'opaque.rs'), 'rust');
  const observed = await extractNativeFunctions(captured(rustAfter, 'opaque.rs', 2), 'rust');
  assert.equal(input.coverage, 'complete');
  assert.equal(observed.coverage, 'complete');
  assert.equal(input.declarations.length, 1);
  assert.deepEqual(compareExtractions(input, observed).changes, []);
  assert.equal(compareExtractions(input, observed).region_changed, true);

  const tsInput = await extractNativeFunctions(captured('import { x } from "one";\nfunction f() {}\n'), 'typescript');
  const tsObserved = await extractNativeFunctions(captured('import { x } from "two";\nfunction f() {}\n', 'example.ts', 2), 'typescript');
  assert.equal(tsInput.coverage, 'complete');
  assert.deepEqual(compareExtractions(tsInput, tsObserved).changes, []);
  assert.equal(compareExtractions(tsInput, tsObserved).region_changed, true);
});

test('anonymous export remains observed but correspondence stays ambiguous', async () => {
  const input = await extractNativeFunctions(captured('export default function (x: number) { return x; }\n'), 'typescript');
  const observed = await extractNativeFunctions(captured('export default function (x: number) { return x + 1; }\n', 'example.ts', 2), 'typescript');
  assert.equal(input.coverage, 'complete');
  assert.equal(input.declarations[0].name, null);
  assert.equal(input.declarations[0].signature, 'export default function (x: number)');
  assert.deepEqual(input.declarations[0].parameters, ['x: number']);
  assert.deepEqual(compareExtractions(input, observed).changes.map(change => change.kind), ['ambiguous', 'ambiguous']);
});

test('a named type edit does not mark a written but unchanged use', async () => {
  const before = 'type Item = string;\nfunction take(x: Item): Item { return x; }\n';
  const after = 'type Item = number;\nfunction take(x: Item): Item { return x; }\n';
  const input = await extractNativeFunctions(captured(before), 'typescript');
  const observed = await extractNativeFunctions(captured(after, 'example.ts', 2), 'typescript');
  assert.equal(input.coverage, 'complete');
  assert.deepEqual(compareExtractions(input, observed).changes.map(change => change.observed?.name), ['Item']);
  assert.deepEqual(input.declarations[1].result, { state: 'declared', syntax: ': Item' });
});

test('indirectly nested function declarations do not masquerade as fully inventoried', async () => {
  const source = 'function outer() { if (true) { function inner() {} } }\n';
  const result = await extractNativeFunctions(captured(source), 'typescript');
  assert.equal(result.coverage, 'incomplete');
  assert.ok(result.limitations.includes('nested_declaration_coverage_unavailable'));
  assert.equal(result.declarations[0].name, 'outer');
  assert.ok(result.declarations[0].body_digest);
});

for (const stem of ['rust', 'typescript']) {
  test(`fixture-backed ${stem} source to output follows the written expected observations`, async () => {
    const base = new URL(`../fixtures/structural/languages/${stem}/`, import.meta.url);
    const cases = JSON.parse(await readFile(new URL('cases.json', base), 'utf8'));
    const expected = JSON.parse(await readFile(new URL(cases.expectations, base), 'utf8'));
    const inputText = await readFile(new URL(cases.input, base), 'utf8');
    const changedText = await readFile(new URL(cases.changed, base), 'utf8');
    const incompleteText = await readFile(new URL(cases.incomplete, base), 'utf8');
    const input = await extractNativeFunctions(captured(inputText, cases.input), cases.dialect);
    const observed = await extractNativeFunctions(captured(changedText, cases.input, 2), cases.dialect);
    const incomplete = await extractNativeFunctions(captured(incompleteText, cases.incomplete, 3), cases.dialect);
    assert.equal(input.coverage, 'complete');
    assert.equal(observed.coverage, 'complete');
    assert.deepEqual(input.declarations.map(d => [d.kind, d.name, d.enclosing, d.signature]), expected.input_declarations);
    const changes = compareExtractions(input, observed).changes.map(c => [
      c.observed?.name ?? c.input?.name, c.declaration_changed, c.body_changed, c.default_changed,
    ]).sort((a, b) => a[0].localeCompare(b[0]));
    assert.deepEqual(changes, expected.changes);
    assert.equal(incomplete.coverage, 'incomplete');
    for (const limitation of expected.incomplete_limitations) assert.ok(incomplete.limitations.includes(limitation));
  });
}

test('pinned Rust 2024 unsafe extern block has exact native nodes, declarations and byte ranges', async () => {
  const base = new URL('../fixtures/structural/languages/rust/', import.meta.url);
  const cases = JSON.parse(await readFile(new URL('cases.json', base), 'utf8'));
  const expected = JSON.parse(await readFile(new URL(cases.expectations, base), 'utf8'));
  const text = await readFile(new URL(cases.edition_2024, base), 'utf8');
  assert.ok(nativeParserIdentity('rust').endsWith('tree-sitter-rust@0.24.2'));
  const { parser } = await loadNativeParser('rust');
  const native = parser.parse(text);
  const result = await extractNativeFunctions(captured(text, cases.edition_2024), 'rust');
  assert.equal(native.rootNode.hasError, false);
  assert.deepEqual(native.rootNode.namedChildren.map(node => node.type), expected.edition_2024_native_nodes);
  assert.equal(result.coverage, 'complete');
  assert.deepEqual(result.limitations, []);
  assert.deepEqual(result.declarations.map(d => [d.kind, d.name, d.enclosing, d.signature]), expected.edition_2024_declarations);
  assert.deepEqual(result.declarations.map(d => [d.range.start_byte, d.range.end_byte]), expected.edition_2024_ranges);
});

test('native Rust foreign-block signatures remain scoped to their written ABI', async () => {
  const source = 'extern "C" { pub fn native(x: i32) -> i32; }\n';
  const result = await extractNativeFunctions(captured(source, 'extern.rs'), 'rust');
  assert.equal(result.coverage, 'complete');
  assert.deepEqual(result.declarations.map(d => [d.kind, d.name, d.enclosing, d.signature]), [
    ['foreign_mod_item', 'extern "C"', [], 'extern "C"'],
    ['function_signature_item', 'native', ['extern "C"'], 'pub fn native(x: i32) -> i32;'],
  ]);
  assert.deepEqual(result.declarations[1].parameters, ['x: i32']);
  assert.deepEqual(result.declarations[1].result, { state: 'declared', syntax: 'i32' });
});

test('L01 Rust population fixture covers written scopes, modifiers, types, defaults and opaque regions', async () => {
  const base = new URL('../fixtures/structural/languages/rust/', import.meta.url);
  const cases = JSON.parse(await readFile(new URL('cases.json', base), 'utf8'));
  const expected = JSON.parse(await readFile(new URL(cases.expectations, base), 'utf8'));
  const before = await readFile(new URL(cases.population, base), 'utf8');
  const after = await readFile(new URL(cases.population_changed, base), 'utf8');
  const input = await extractNativeFunctions(captured(before, cases.population), 'rust');
  const observed = await extractNativeFunctions(captured(after, cases.population, 2), 'rust');
  assert.equal(input.coverage, 'incomplete');
  assert.equal(observed.coverage, 'incomplete');
  assert.ok(input.limitations.includes('nested_declaration_coverage_unavailable'));
  assert.ok(observed.limitations.includes('nested_declaration_coverage_unavailable'));
  assert.deepEqual(input.declarations.map(d => [d.kind, d.name, d.enclosing, d.signature]), expected.population_declarations);
  assert.deepEqual(input.declarations.find(d => d.name === 'fetch').parameters, ['mut source: T']);
  assert.deepEqual(input.declarations.find(d => d.name === 'fetch').result, { state: 'declared', syntax: 'usize' });
  assert.deepEqual(input.declarations.find(d => d.name === 'execute' && d.enclosing[0] === 'Work').parameters,
    ['&self', 'input: i32']);
  const comparison = compareExtractions(input, observed);
  assert.deepEqual(comparison.changes.map(c => [c.observed?.kind ?? c.input?.kind,
    c.observed?.name ?? c.input?.name, c.declaration_changed, c.body_changed, c.default_changed]),
  expected.population_changes);
  assert.equal(comparison.region_changed, expected.population_region_changed);
});

for (const ext of ['mts', 'cts']) {
  test(`L02 TypeScript ${ext} fixture covers exact written declarations and changed markers`, async () => {
    const base = new URL('../fixtures/structural/languages/typescript/', import.meta.url);
    const cases = JSON.parse(await readFile(new URL('cases.json', base), 'utf8'));
    const expected = JSON.parse(await readFile(new URL(cases.expectations, base), 'utf8'));
    const before = await readFile(new URL(cases[`population_${ext}`], base), 'utf8');
    const after = await readFile(new URL(cases[`population_${ext}_changed`], base), 'utf8');
    const input = await extractNativeFunctions(captured(before, cases[`population_${ext}`]), 'typescript');
    const observed = await extractNativeFunctions(captured(after, cases[`population_${ext}`], 2), 'typescript');
    assert.equal(input.coverage, 'complete');
    assert.equal(observed.coverage, 'complete');
    assert.deepEqual(input.declarations.map(d => [d.kind, d.name, d.enclosing, d.signature]),
      expected[`population_${ext}_declarations`]);
    const changes = compareExtractions(input, observed).changes.map(c => [c.observed?.kind ?? c.input?.kind,
      c.observed?.name ?? c.input?.name, c.declaration_changed, c.body_changed, c.default_changed]);
    assert.deepEqual(changes, expected[`population_${ext}_changes`]);
    if (ext === 'mts') {
      assert.deepEqual(input.declarations.find(d => d.name === 'pick').parameters,
        ['{x}: {x: number} = <default>', '...rest: number[]']);
      assert.deepEqual(input.declarations.find(d => d.name === 'pick').result,
        { state: 'declared', syntax: ': number' });
      assert.ok(!JSON.stringify(input.declarations).includes('{x: 1}'));
    }
  });
}

test('written parameter reorder and removal are declaration changes without inferred type effects', async () => {
  const rustInput = await extractNativeFunctions(captured('fn arrange(a: i32, b: u8) -> i32 { a }\n', 'arrange.rs'), 'rust');
  const rustObserved = await extractNativeFunctions(captured('fn arrange(b: u8, a: i32) -> i32 { a }\n', 'arrange.rs', 2), 'rust');
  assert.equal(rustInput.coverage, 'complete');
  assert.deepEqual(rustInput.declarations[0].parameters, ['a: i32', 'b: u8']);
  assert.deepEqual(rustObserved.declarations[0].parameters, ['b: u8', 'a: i32']);
  assert.deepEqual(compareExtractions(rustInput, rustObserved).changes.map(c =>
    [c.declaration_changed, c.body_changed, c.default_changed]), [[true, false, false]]);

  const tsInput = await extractNativeFunctions(captured('function arrange(a: number, b?: string): number { return a; }\n'), 'typescript');
  const tsObserved = await extractNativeFunctions(captured('function arrange(a: number): number { return a; }\n', 'example.ts', 2), 'typescript');
  assert.equal(tsInput.coverage, 'complete');
  assert.deepEqual(tsInput.declarations[0].parameters, ['a: number', 'b?: string']);
  assert.deepEqual(tsObserved.declarations[0].parameters, ['a: number']);
  assert.deepEqual(compareExtractions(tsInput, tsObserved).changes.map(c =>
    [c.declaration_changed, c.body_changed, c.default_changed]), [[true, false, false]]);
});

test('duplicate TypeScript interface declarations preserve ambiguous parent correspondence', async () => {
  const before = 'interface View { left: number; }\ninterface View { right: string; }\n';
  const after = 'interface View { left: string; }\ninterface View { right: number; }\n';
  const input = await extractNativeFunctions(captured(before), 'typescript');
  const observed = await extractNativeFunctions(captured(after, 'example.ts', 2), 'typescript');
  assert.equal(input.coverage, 'complete');
  assert.equal(observed.coverage, 'complete');
  const comparison = compareExtractions(input, observed);
  assert.equal(comparison.coverage, 'incomplete');
  assert.ok(comparison.limitations.includes('declaration_correspondence_ambiguous'));
  assert.deepEqual(comparison.changes.filter(c => c.input?.kind === 'interface_declaration' ||
    c.observed?.kind === 'interface_declaration').map(c => c.kind),
  ['ambiguous', 'ambiguous', 'ambiguous', 'ambiguous']);
  assert.deepEqual(comparison.changes.filter(c => c.kind === 'modified').map(c => c.observed?.name), ['left', 'right']);
});

test('native absent-commit endpoints distinguish a file add from a file delete', async () => {
  const path = 'new.ts';
  const absent = emptyNativeExtraction({ status: 'absent_in_commit', source: { kind: 'commit',
    repository_id: 'test-repository', object_format: 'sha1', commit_oid: 'b'.repeat(40),
    tree_oid: 'c'.repeat(40), path } }, 'typescript');
  const present = await extractNativeFunctions(captured('export function added(): void {}\n', path), 'typescript');
  assert.equal(absent.coverage, 'complete');
  assert.equal(present.coverage, 'complete');
  assert.deepEqual(compareExtractions(absent, present).changes.map(c => [c.kind, c.observed?.name]), [['added', 'added']]);
  assert.deepEqual(compareExtractions(present, absent).changes.map(c => [c.kind, c.input?.name]), [['removed', 'added']]);
});

test('two independent same-path additions retain separate absent-commit comparison pairs', async () => {
  const path = 'added.rs';
  const absent = emptyNativeExtraction({ status: 'absent_in_commit', source: { kind: 'commit',
    repository_id: 'test-repository', object_format: 'sha1', commit_oid: 'b'.repeat(40),
    tree_oid: 'c'.repeat(40), path } }, 'rust');
  const taskA = await extractNativeFunctions(captured('pub fn shared(x: i32) -> i32 { x }\n', path), 'rust');
  const taskB = await extractNativeFunctions(captured('pub fn shared(x: u8) -> u8 { x }\n', path, 2), 'rust');
  const a = compareExtractions(absent, taskA), b = compareExtractions(absent, taskB);
  assert.deepEqual(a.changes.map(c => [c.kind, c.observed?.signature]),
    [['added', 'pub fn shared(x: i32) -> i32']]);
  assert.deepEqual(b.changes.map(c => [c.kind, c.observed?.signature]),
    [['added', 'pub fn shared(x: u8) -> u8']]);
  assert.notEqual(a.observed.content_sha256, b.observed.content_sha256);
});

test('malformed header and missing body terminator retain distinct local limits', async () => {
  const malformed = await extractNativeFunctions(captured('function f(x: ): number { return 1; }\n'), 'typescript');
  assert.equal(malformed.coverage, 'incomplete');
  assert.equal(malformed.declarations[0].header_complete, false);
  assert.deepEqual(malformed.declarations[0].result, { state: 'unavailable' });
  const missing = await extractNativeFunctions(captured('function f(x: number): number { return x;\n', 'example.ts', 2), 'typescript');
  assert.equal(missing.coverage, 'incomplete');
  assert.ok(missing.limitations.includes('parse_error_or_missing_token'));
  assert.ok(missing.limitations.includes('declaration_body_incomplete'));
  assert.equal(missing.declarations.length, 1);
  assert.equal(missing.declarations[0].name, 'f');
  assert.equal(missing.declarations[0].header_complete, true);
  assert.equal(missing.declarations[0].signature, 'function f(x: number): number');
  assert.deepEqual(missing.declarations[0].parameters, ['x: number']);
  assert.deepEqual(missing.declarations[0].result, { state: 'declared', syntax: ': number' });
  assert.deepEqual(missing.declarations[0].range, { start_byte: 0,
    end_byte: Buffer.byteLength('function f(x: number): number { return x;') });
  assert.equal(missing.declarations[0].body_digest, undefined);
  const complete = await extractNativeFunctions(captured('function f(x: number): number { return x; }\n'), 'typescript');
  const pair = compareExtractions(complete, missing);
  assert.equal(pair.coverage, 'incomplete');
  assert.equal(pair.region_changed, true);
  assert.ok(pair.changes.every(change => change.kind === 'unobserved'));

  const both = await extractNativeFunctions(captured('function f(x: ): number { return x;\n', 'example.ts', 3), 'typescript');
  assert.equal(both.coverage, 'incomplete');
  assert.equal(both.declarations[0].header_complete, false);
  assert.deepEqual(both.declarations[0].result, { state: 'unavailable' });
});

test('exported and async TypeScript missing-brace headers stay local and incomplete', async () => {
  for (const source of [
    'export function f(x: number): number { return x;\n',
    'async function f(x: number): Promise<number> { return x;\n',
    'export default function f(x: number): number { return x;\n',
  ]) {
    const result = await extractNativeFunctions(captured(source), 'typescript');
    assert.equal(result.coverage, 'incomplete');
    assert.equal(result.declarations.length, 1);
    assert.equal(result.declarations[0].name, 'f');
    assert.equal(result.declarations[0].header_complete, true);
    assert.equal(result.declarations[0].body_digest, undefined);
    assert.ok(result.limitations.includes('declaration_body_incomplete'));
  }
});

for (const dialect of ['rust', 'typescript']) {
  test(`${dialect} native half-open byte ranges survive BOM, CRLF, combining text, emoji and a page-crossing codepoint`, async () => {
    const head = '\uFEFF// e\u0301 😀\r\n//';
    const prefix = head + 'a'.repeat(4095 - Buffer.byteLength(head)) + 'é\r\n';
    const declaration = dialect === 'rust'
      ? 'pub fn f(x: i32) -> i32 { x + 1 }'
      : 'export function f(x: number): number { return x + 1; }';
    assert.equal(Buffer.byteLength(prefix.split('é')[0]), 4095);
    const result = await extractNativeFunctions(captured(prefix + declaration + '\r\n',
      dialect === 'rust' ? 'range.rs' : 'range.ts'), dialect);
    assert.equal(result.coverage, 'complete');
    assert.equal(result.declarations.length, 1);
    assert.deepEqual(result.declarations[0].range, {
      start_byte: Buffer.byteLength(prefix), end_byte: Buffer.byteLength(prefix + declaration),
    });
  });
}

test('nested multiline TypeScript defaults and declaration-like comments stay concealed', async () => {
  const before = 'function f(\n/* function secret() {} */ x: string = (() => {\n' +
    '  const marker = "},\\\" é😀";\n  return marker;\n})()\n): string { return x; }\n';
  const after = before.replace('},\\\" é😀', '},\\\" changed');
  const input = await extractNativeFunctions(captured(before), 'typescript');
  const observed = await extractNativeFunctions(captured(after, 'example.ts', 2), 'typescript');
  assert.equal(input.coverage, 'incomplete');
  assert.ok(input.limitations.includes('nested_declaration_coverage_unavailable'));
  assert.equal(input.declarations[0].header_complete, true);
  assert.equal(input.declarations[0].parameters.length, 1);
  assert.ok(input.declarations[0].signature.includes('<default>'));
  for (const hidden of ['secret()', 'marker', 'é😀']) assert.ok(!JSON.stringify(input.declarations).includes(hidden));
  const change = compareExtractions(input, observed).changes[0];
  assert.equal(change.default_changed, true);
  assert.equal(change.body_changed, false);
});

test('literal numbers in written Rust type syntax remain visible declaration changes', async () => {
  const input = await extractNativeFunctions(captured('pub type Bytes = [u8; 3];\n', 'bytes.rs'), 'rust');
  const observed = await extractNativeFunctions(captured('pub type Bytes = [u8; 4];\n', 'bytes.rs', 2), 'rust');
  assert.equal(input.coverage, 'complete');
  assert.equal(input.declarations[0].signature, 'pub type Bytes = [u8; 3];');
  assert.deepEqual(input.declarations[0].result, { state: 'declared', syntax: '[u8; 3]' });
  assert.deepEqual(compareExtractions(input, observed).changes.map(c =>
    [c.declaration_changed, c.default_changed]), [[true, false]]);
});
