import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extractNativeFunctions } from '../../.passeur-native/src/observation/native-extraction.js';
import { compareExtractions } from '../../.passeur-native/src/observation/match.js';

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

test('still-unmapped top-level syntax remains an explicit incomplete extraction', async () => {
  const result = await extractNativeFunctions(captured('const x = 1;\n'), 'typescript');
  assert.equal(result.coverage, 'incomplete');
  assert.deepEqual(result.limitations, ['unmapped_top_level_syntax']);
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

test('real Rust 2024-style generic headers keep type constraints and conceal defaults and attributes', async () => {
  const before = '#[route("secret one")] pub async fn run<const N: usize = 3, T: Iterator<Item = u8>>(x: T) -> i32 where T: Clone { 1 }\n';
  const after = '#[route("secret two")] pub async fn run<const N: usize = 4, T: Iterator<Item = u8>>(x: T) -> i32 where T: Clone { 1 }\n';
  const input = await extractNativeFunctions(captured(before, 'generic.rs'), 'rust');
  const observed = await extractNativeFunctions(captured(after, 'generic.rs', 2), 'rust');
  assert.equal(input.coverage, 'complete');
  assert.equal(input.declarations[0].signature,
    '<attribute> pub async fn run<const N: usize = <default>, T: Iterator<Item = u8>>(x: T) -> i32 where T: Clone');
  assert.equal(input.declarations[0].default_digests.length, 2);
  assert.ok(!JSON.stringify(input.declarations).includes('secret one'));
  const change = compareExtractions(input, observed).changes[0];
  assert.equal(change.default_changed, true);
  assert.equal(change.declaration_changed, false);
});

test('real Rust nested functions charge edits to the inner declaration only', async () => {
  const before = 'fn outer() { let x = 1; fn inner(x: i32) -> i32 { x + 1 } }\n';
  const after = 'fn outer() { let x = 1; fn inner(x: i32) -> i32 { x + 2 } }\n';
  const input = await extractNativeFunctions(captured(before, 'nested.rs'), 'rust');
  const observed = await extractNativeFunctions(captured(after, 'nested.rs', 2), 'rust');
  assert.equal(input.coverage, 'complete');
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
