import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { compareExtractions } from '../../.passeur-native/src/observation/match.js';
import { extractNativeFunctions } from '../../.passeur-native/src/observation/native-extraction.js';
import { NativeAnalysisHelper } from '../../.passeur-native/src/observation/helper.js';
import { compareCapturedWork } from '../../.passeur-native/src/observation/comparison.js';
import { sourceDialectForPath } from '../../.passeur-native/src/observation/language-routing.js';

const hash = text => createHash('sha256').update(text).digest('hex');
const base = new URL('../fixtures/structural/languages/', import.meta.url);
const fixture = (stem, name) => readFile(new URL(`${stem}/${name}`, base), 'utf8');
const expectations = async stem => JSON.parse(await fixture(stem, 'expected.json'));

function captured(text, path, sequence = 1) {
  return { status: 'present', source: { kind: 'working_capture', repository_id: 'js-family-test',
    object_format: 'sha1', workspace_id: 'js-family-workspace', workspace_generation: 1,
    capture_id: `capture-${sequence}`, capture_sequence: sequence, head_anchor: 'a'.repeat(40), path },
  mode: '100644', content_sha256: hash(text), byte_length: Buffer.byteLength(text), text,
  consistency: 'sampled_file_not_atomic' };
}
function absent(path) {
  return { status: 'absent_in_commit', source: { kind: 'commit', repository_id: 'js-family-test',
    object_format: 'sha1', commit_oid: 'a'.repeat(40), tree_oid: 'b'.repeat(40), path } };
}

async function extract(text, dialect, path, sequence = 1) {
  return extractNativeFunctions(captured(text, path, sequence), dialect);
}

test('real JavaScript grammar extracts generator, arrow, class and defaults from exact source', async () => {
  const source = await fixture('javascript', 'input.mjs');
  const result = await extract(source, 'javascript', 'input.mjs');
  const expected = await expectations('javascript');
  assert.equal(result.coverage, 'complete');
  assert.deepEqual(result.declarations.map(d => [d.kind, d.name, d.enclosing, d.signature]),
    expected.input_declarations);
  assert.deepEqual(result.declarations.map(d => [d.range.start_byte, d.range.end_byte]), expected.input_ranges);
  assert.equal(result.declarations[0].signature, 'export async function* stream({limit = <default>}, ...rest)');
  assert.deepEqual(result.declarations[0].parameters, ['{limit = <default>}', '...rest']);
  assert.deepEqual(result.declarations[0].result, { state: 'not_declared' });
  assert.deepEqual(result.declarations[0].range, { start_byte: 109, end_byte: 177 });
  assert.ok(!JSON.stringify(result.declarations).includes('= 2'));
  assert.ok(!JSON.stringify(result.declarations).includes('secret'));
  const changed = await extract(await fixture('javascript', 'changed.mjs'), 'javascript', 'input.mjs', 2);
  assert.deepEqual(changed.declarations.map(d => [d.range.start_byte, d.range.end_byte]), expected.changed_ranges);
  const stream = compareExtractions(result, changed).changes.find(change =>
    (change.input ?? change.observed)?.name === 'stream');
  assert.equal(stream?.default_changed, true);
  assert.equal(stream?.body_changed, true);
});

test('named function assignments and anonymous default exports use written JavaScript syntax', async () => {
  const source = 'let local = function(x = 1) { return x; };\nhandler = function(y = 2) { return y; };\nexport default function(z) { return z; }\n';
  const result = await extract(source, 'javascript', 'functions.cjs');
  assert.equal(result.coverage, 'complete');
  assert.deepEqual(result.declarations.map(d => [d.name, d.header_complete, d.signature]), [
    ['local', true, 'let local = function(x = <default>)'],
    ['handler', true, 'handler = function(y = <default>)'],
    [null, true, 'export default function(z)'],
  ]);
});

test('written result annotations mask embedded comments in both signature and result', async () => {
  const source = 'export function label(x: number): /* private note */ string { return String(x); }\n';
  const result = await extract(source, 'tsx', 'label.tsx');
  assert.equal(result.coverage, 'complete');
  assert.equal(result.declarations[0].signature, 'export function label(x: number): <comment> string');
  assert.deepEqual(result.declarations[0].result, { state: 'declared', syntax: ': <comment> string' });
  assert.ok(!JSON.stringify(result.declarations).includes('private note'));
});

test('React JSX and TSX preserve component headers and mark JSX-only body edits', async () => {
  const jsx = await fixture('react', 'input.jsx');
  const first = await extract(jsx, 'jsx', 'input.jsx');
  assert.equal(first.coverage, 'complete');
  const expected = await expectations('react');
  assert.deepEqual(first.declarations.map(d => [d.kind, d.name, d.enclosing, d.signature]), expected.jsx_declarations);
  assert.deepEqual(first.declarations.map(d => [d.range.start_byte, d.range.end_byte]), expected.jsx_input_ranges);
  assert.equal(first.declarations[0].signature, 'export function Card({title = <default>})');
  assert.deepEqual(first.declarations[0].parameters, ['{title = <default>}']);
  assert.deepEqual(first.declarations[0].result, { state: 'not_declared' });
  assert.deepEqual(first.declarations[0].range, { start_byte: 44, end_byte: 112 });
  const second = await extract(await fixture('react', 'changed.jsx'), 'jsx', 'input.jsx', 2);
  assert.deepEqual(second.declarations.map(d => [d.range.start_byte, d.range.end_byte]), expected.jsx_changed_ranges);
  assert.deepEqual(compareExtractions(first, second).changes.map(change =>
    [change.declaration_changed, change.body_changed, change.default_changed]), [expected.jsx_body_only]);

  const tsxSource = await fixture('react', 'input.tsx');
  const tsx = await extract(tsxSource, 'tsx', 'input.tsx');
  assert.equal(tsx.coverage, 'complete');
  assert.deepEqual(tsx.declarations.map(d => [d.kind, d.name, d.enclosing, d.signature]), expected.tsx_declarations);
  assert.deepEqual(tsx.declarations.map(d => [d.range.start_byte, d.range.end_byte]), expected.tsx_input_ranges);
  assert.equal(tsx.declarations[0].signature, 'export function TypedCard({title}: {title: string}): JSX.Element');
  assert.deepEqual(tsx.declarations[0].result, { state: 'declared', syntax: ': JSX.Element' });
  const changedTsx = await extract(await fixture('react', 'changed.tsx'), 'tsx', 'input.tsx', 2);
  assert.deepEqual(changedTsx.declarations.map(d => [d.range.start_byte, d.range.end_byte]), expected.tsx_changed_ranges);
  assert.deepEqual(compareExtractions(tsx, changedTsx).changes.map(change =>
    [change.declaration_changed, change.body_changed, change.default_changed]), [expected.tsx_body_only]);
});

test('Svelte 5 maps module and instance scripts plus snippet parameters to component bytes', async () => {
  const source = await fixture('svelte5', 'input.svelte');
  const result = await extract(source, 'svelte5', 'input.svelte');
  const expected = await expectations('svelte5');
  assert.equal(result.coverage, 'complete');
  assert.deepEqual(result.declarations.map(d => [d.kind, d.name, d.enclosing, d.signature]),
    expected.input_declarations);
  assert.deepEqual(result.declarations.map(d => [d.range.start_byte, d.range.end_byte]), expected.input_ranges);
  assert.deepEqual(result.declarations[2].result, { state: 'declared', syntax: ': Props' });
  assert.deepEqual(result.declarations[2].parameters, ['title = <default>']);
  const propsEdit = await extract(source.replace('title = "welcome"', 'title = "new"'), 'svelte5', 'input.svelte', 3);
  const propsChange = compareExtractions(result, propsEdit).changes.find(change =>
    (change.input ?? change.observed)?.name === '$props');
  assert.equal(propsChange?.default_changed, true);
  assert.equal(result.declarations[3].signature, '{#snippet card(item: string = <default>)}');
  assert.deepEqual(result.declarations[3].parameters, ['item: string = <default>']);
  assert.deepEqual(result.declarations[3].range, { start_byte: 224, end_byte: 286 });
  for (const declaration of result.declarations) {
    const start = Buffer.from(source).subarray(0, declaration.range.start_byte).toString('utf8');
    const captured = Buffer.from(source).subarray(declaration.range.start_byte, declaration.range.end_byte).toString('utf8');
    assert.ok(source.startsWith(captured, start.length));
    assert.ok(!captured.includes('function _('));
  }
  const changed = await extract(await fixture('svelte5', 'changed.svelte'), 'svelte5', 'input.svelte', 2);
  assert.deepEqual(changed.declarations.map(d => [d.range.start_byte, d.range.end_byte]), expected.changed_ranges);
  const comparison = compareExtractions(result, changed);
  const snippet = comparison.changes.find(change => (change.input ?? change.observed)?.name === 'card');
  assert.equal(snippet?.default_changed, true);
  assert.equal(snippet?.body_changed, true);
  assert.equal(comparison.region_changed, true); // render and style remain outside declarations
  const renderOnly = await extract(source.replace('card("hello" as string)', 'card("other" as string)'),
    'svelte5', 'input.svelte', 4);
  assert.equal(renderOnly.coverage, 'complete');
  const renderChange = compareExtractions(result, renderOnly);
  assert.deepEqual(renderChange.changes, []);
  assert.equal(renderChange.region_changed, true);
  const styleOnly = await extract(source.replace('color: red', 'color: orange'),
    'svelte5', 'input.svelte', 5);
  assert.equal(styleOnly.coverage, 'complete');
  const styleChange = compareExtractions(result, styleOnly);
  assert.deepEqual(styleChange.changes, []);
  assert.equal(styleChange.region_changed, true);
});

test('Svelte malformed snippet parameters never disclose raw defaults and comments are masked', async () => {
  const result = await extract(await fixture('svelte5', 'adversarial.svelte'), 'svelte5', 'adversarial.svelte');
  assert.equal(result.coverage, 'incomplete');
  const props = result.declarations.find(declaration => declaration.name === '$props');
  const malformed = result.declarations.find(declaration => declaration.name === 'malformed');
  const commented = result.declarations.find(declaration => declaration.name === 'commented');
  assert.deepEqual(props.result, { state: 'declared', syntax: ': <comment> Props' });
  assert.equal(malformed.header_complete, false);
  assert.equal(malformed.signature, '<header extraction incomplete>');
  assert.deepEqual(malformed.parameters, []);
  assert.ok(result.limitations.includes('snippet_parameters_unavailable'));
  assert.equal(commented.signature, '{#snippet commented(item <comment> = <default>)}');
  assert.deepEqual(commented.parameters, ['item <comment> = <default>']);
  assert.ok(!result.limitations.includes('template_expression_not_extracted'));
  const projected = JSON.stringify(result.declarations);
  for (const secret of ['secretValue', 'confidential comment', 'secret default', 'private type', 'secret props']) {
    assert.ok(!projected.includes(secret));
  }
});

test('Svelte snippets with repeated names retain lexical scope and isolate nested body edits', async () => {
  const before = await extract(await fixture('svelte5', 'nested.svelte'), 'svelte5', 'nested.svelte');
  const after = await extract(await fixture('svelte5', 'nested_changed.svelte'), 'svelte5', 'nested.svelte', 2);
  assert.equal(before.coverage, 'complete');
  assert.equal(after.coverage, 'complete');
  assert.deepEqual(before.declarations.map(d => [d.name, d.enclosing]),
    (await expectations('svelte5')).nested_declarations);
  const comparison = compareExtractions(before, after);
  assert.equal(comparison.coverage, 'complete');
  assert.deepEqual(comparison.changes.map(change => [change.observed?.name, change.observed?.enclosing,
    change.body_changed]), [['row', ['outer'], true]]);
});

test('Svelte script-only suffixes use their native JS and TS routes with fixed byte oracles', async () => {
  const expected = await expectations('svelte5');
  for (const [path, changedPath, oracle, changedRange, dialect] of [
    ['component.svelte.js', 'component_changed.svelte.js', expected.script_js, expected.script_js_changed_range, 'javascript'],
    ['component.svelte.ts', 'component_changed.svelte.ts', expected.script_ts, expected.script_ts_changed_range, 'typescript'],
  ]) {
    assert.equal(sourceDialectForPath(path), dialect);
    const input = await extract(await fixture('svelte5', path), dialect, path);
    const observed = await extract(await fixture('svelte5', changedPath), dialect, path, 2);
    assert.equal(input.coverage, 'complete');
    assert.equal(observed.coverage, 'complete');
    assert.deepEqual([input.declarations[0].kind, input.declarations[0].name,
      input.declarations[0].signature, [input.declarations[0].range.start_byte, input.declarations[0].range.end_byte]], oracle);
    assert.deepEqual([observed.declarations[0].range.start_byte, observed.declarations[0].range.end_byte], changedRange);
    const change = compareExtractions(input, observed).changes[0];
    assert.equal(change.default_changed, true);
    assert.equal(change.body_changed, true);
  }
});

test('JSX-bearing .js is source-observable through the current JS route and explicit JSX selection', async () => {
  const path = 'configured.jsx.js';
  const before = await fixture('react', path), after = await fixture('react', 'configured_changed.jsx.js');
  const expected = await expectations('react');
  assert.equal(sourceDialectForPath(path), 'javascript');
  for (const dialect of ['javascript', 'jsx']) {
    const input = await extract(before, dialect, path);
    const observed = await extract(after, dialect, path, 2);
    assert.equal(input.coverage, 'complete');
    assert.equal(observed.coverage, 'complete');
    assert.deepEqual([input.declarations[0].kind, input.declarations[0].name,
      input.declarations[0].signature, [input.declarations[0].range.start_byte, input.declarations[0].range.end_byte]],
    expected.configured_jsx_js);
    assert.deepEqual([observed.declarations[0].range.start_byte, observed.declarations[0].range.end_byte],
      expected.configured_jsx_js_changed_range);
    assert.deepEqual(compareExtractions(input, observed).changes.map(change =>
      [change.declaration_changed, change.body_changed, change.default_changed]), [[false, true, false]]);
  }
});

test('deep Svelte template nesting terminates at the owned analysis bound', async () => {
  const source = '<div>'.repeat(270) + '</div>'.repeat(270);
  await assert.rejects(extract(source, 'svelte5', 'deep.svelte'), error => error.code === 'STRUCTURAL_ANALYSIS_CAPACITY');
});

test('malformed or escaping template expressions remain incomplete without synthetic declarations', async () => {
  for (const source of ['é😀 {@render card(}', 'é😀 {item +}',
    'é😀 {@render card) ; function synthetic(){}; (}']) {
    const result = await extract(source, 'svelte5', 'broken.svelte');
    assert.equal(result.coverage, 'incomplete');
    assert.ok(result.limitations.includes('embedded_expression_parse_error_or_missing_token'));
    assert.deepEqual(result.declarations, []);
  }
});

test('malformed headers stay incomplete with real grammar output', async () => {
  const js = await extract(await fixture('javascript', 'incomplete.mjs'), 'javascript', 'incomplete.mjs');
  const jsx = await extract(await fixture('react', 'incomplete.jsx'), 'jsx', 'incomplete.jsx');
  const svelte = await extract(await fixture('svelte5', 'incomplete.svelte'), 'svelte5', 'incomplete.svelte');
  for (const result of [js, jsx, svelte]) assert.equal(result.coverage, 'incomplete');
  for (const [stem, result] of [['javascript', js], ['react', jsx], ['svelte5', svelte]]) {
    for (const limitation of (await expectations(stem)).incomplete_limitations) {
      assert.ok(result.limitations.includes(limitation), `${stem}: missing ${limitation} in ${result.limitations.join(', ')}`);
    }
  }
});

test('production helper and report carry JS, React and Svelte source differences without defaults', async () => {
  const helper = new NativeAnalysisHelper();
  try {
    for (const [stem, dialect, path, inputName, changedName, concealed] of [
      ['javascript', 'javascript', 'input.mjs', 'input.mjs', 'changed.mjs', ['= 2', '= 4', 'secret']],
      ['react', 'jsx', 'input.jsx', 'input.jsx', 'changed.jsx', ['hello']],
      ['svelte5', 'svelte5', 'input.svelte', 'input.svelte', 'changed.svelte', ['welcome', 'goodbye']],
    ]) {
      const output = await compareCapturedWork({ work_id: `work-${stem}`, parent_id: 'parent-1', dialect,
        input: captured(await fixture(stem, inputName), path),
        observed: captured(await fixture(stem, changedName), path, 2) }, helper);
      assert.equal(output.report.comparison.coverage, 'complete', stem);
      assert.ok(output.report.comparison.changes.length > 0, stem);
      assert.ok(output.text.includes(`Dialect: "${dialect}"`), stem);
      assert.ok(output.text.includes('source bytes:'), stem);
      for (const secret of concealed) assert.ok(!output.text.includes(secret), `${stem} disclosed ${secret}`);
    }
  } finally { await helper.close(); }
});

test('production matching reports added, removed and ambiguous React/JavaScript declarations conservatively', async () => {
  const source = 'export function Added() { return <p/>; }\n';
  const present = await extract(source, 'jsx', 'new.jsx');
  const missing = await extractNativeFunctions(absent('new.jsx'), 'jsx');
  const added = compareExtractions(missing, present);
  const removed = compareExtractions(present, missing);
  assert.deepEqual(added.changes.map(change => change.kind), ['added']);
  assert.deepEqual(removed.changes.map(change => change.kind), ['removed']);
  assert.equal(added.coverage, 'complete');
  assert.equal(removed.coverage, 'complete');

  const before = 'function same(x) { return 1; }\nfunction same(x) { return 1; }\n';
  const after = 'function same(x) { return 2; }\nfunction same(x) { return 1; }\n';
  const compared = compareExtractions(await extract(before, 'javascript', 'duplicate.js'),
    await extract(after, 'javascript', 'duplicate.js', 2));
  assert.equal(compared.coverage, 'incomplete');
  assert.ok(compared.limitations.includes('declaration_correspondence_ambiguous'));
  assert.ok(compared.changes.every(change => change.kind === 'ambiguous'));
});
