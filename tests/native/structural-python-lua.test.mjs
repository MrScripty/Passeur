import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extractNativeFunctions } from '../../.passeur-native/src/observation/native-extraction.js';
import { compareExtractions } from '../../.passeur-native/src/observation/match.js';

const sha256 = text => createHash('sha256').update(text).digest('hex');
const utf8Offset = (source, fragment) => Buffer.byteLength(source.slice(0, source.indexOf(fragment)), 'utf8');
function captured(text, path, sequence = 1) {
  return { status: 'present', source: { kind: 'working_capture', repository_id: 'test-repository',
    object_format: 'sha1', workspace_id: 'test-workspace', workspace_generation: 1,
    capture_id: `sample-${sequence}`, capture_sequence: sequence, head_anchor: 'a'.repeat(40), path },
    mode: '100644', content_sha256: sha256(text), byte_length: Buffer.byteLength(text), text,
    consistency: 'sampled_file_not_atomic' };
}

for (const [dialect, extension] of [['python', 'py'], ['lua', 'lua']]) {
  test(`${dialect} independently written source-to-output oracle covers every selected row`, async () => {
    const base = new URL(`../fixtures/structural/languages/${dialect}/`, import.meta.url);
    const cases = JSON.parse(await readFile(new URL('cases.json', base), 'utf8'));
    const source = await readFile(new URL(cases.input, base), 'utf8');
    const expected = JSON.parse(await readFile(new URL(cases.expectations, base), 'utf8'));
    const extraction = await extractNativeFunctions(captured(source, cases.input), dialect);
    assert.equal(extraction.coverage, expected.coverage);
    assert.deepEqual(extraction.limitations, []);
    assert.equal(extraction.declarations.length, expected.declarations.length);
    for (const [index, row] of expected.declarations.entries()) {
      const actual = extraction.declarations[index];
      assert.deepEqual({ kind: actual.kind, name: actual.name, enclosing: actual.enclosing,
        range: actual.range, signature: actual.signature, parameters: actual.parameters,
        result: actual.result, default_count: actual.default_digests.length },
      { kind: row.kind, name: row.name, enclosing: row.enclosing, range: row.range,
        signature: row.signature, parameters: row.parameters, result: row.result,
        default_count: row.default_count });
      if (row.direct_body_text) assert.equal(actual.body_digest, sha256(row.direct_body_text));
    }
  });

  test(`${dialect} production dispatch matches fixture change, add, delete, error and ambiguity oracles`, async () => {
    const base = new URL(`../fixtures/structural/languages/${dialect}/`, import.meta.url);
    const cases = JSON.parse(await readFile(new URL('cases.json', base), 'utf8'));
    const expected = JSON.parse(await readFile(new URL(cases.expectations, base), 'utf8'));
    const read = name => readFile(new URL(name, base), 'utf8');
    const extraction = (source, sequence) => extractNativeFunctions(captured(source, `pair.${extension}`, sequence), dialect);
    const input = await extraction(await read(cases.input), 1);
    const changed = await extraction(await read(cases.changed), 2);
    const changes = compareExtractions(input, changed).changes;
    assert.equal(changes.length, Object.keys(expected.changed).length);
    for (const change of changes) {
      const name = change.observed?.name ?? change.input?.name;
      assert.deepEqual({ declaration_changed: change.declaration_changed,
        body_changed: change.body_changed, default_changed: change.default_changed }, expected.changed[name]);
    }
    const incomplete = await extraction(await read(cases.incomplete), 3);
    assert.equal(incomplete.coverage, 'incomplete');
    assert.deepEqual(incomplete.limitations, expected.incomplete_limitations);
    assert.equal(incomplete.declarations[0].header_complete, true);
    const ambiguousBefore = await extraction(await read(cases.ambiguous_before), 4);
    const ambiguousAfter = await extraction(await read(cases.ambiguous_after), 5);
    const ambiguous = compareExtractions(ambiguousBefore, ambiguousAfter);
    assert.equal(ambiguous.changes.length, expected.ambiguous_change_count);
    assert.ok(ambiguous.changes.every(change => change.kind === 'ambiguous'));
    assert.ok(ambiguous.limitations.includes('declaration_correspondence_ambiguous'));
    const addedBefore = await extraction(await read(cases.added_before), 6);
    const addedAfter = await extraction(await read(cases.added_after), 7);
    assert.deepEqual(compareExtractions(addedBefore, addedAfter).changes.map(change =>
      [change.kind, change.observed?.name]), [['added', expected.added_name]]);
    assert.deepEqual(compareExtractions(addedAfter, addedBefore).changes.map(change =>
      [change.kind, change.input?.name]), [['removed', expected.added_name]]);
  });
}

test('real Python grammar maps selected 3.14 syntax, scopes, exact bytes and masked defaults', async () => {
  const source = await readFile(new URL('../fixtures/structural/languages/python/input.py', import.meta.url), 'utf8');
  const extraction = await extractNativeFunctions(captured(source, 'selected.py'), 'python');
  assert.equal(extraction.coverage, 'complete');
  assert.deepEqual(extraction.declarations.map(d => [d.name, d.enclosing]), [
    ['run', []], ['Box', []], ['value', ['Box']], ['get', ['Box']], ['Alias', []],
  ]);
  assert.equal(extraction.declarations[0].signature,
    '<attribute>\nasync def run[T = <default>](a: int, /, b: str = <default>, *, flag: bool = <default>) -> str:');
  assert.deepEqual(extraction.declarations[0].parameters,
    ['a: int', '/', 'b: str = <default>', '*', 'flag: bool = <default>']);
  assert.deepEqual(extraction.declarations[0].result, { state: 'declared', syntax: 'str' });
  assert.deepEqual(extraction.declarations[0].range, {
    start_byte: utf8Offset(source, '@audit'),
    end_byte: utf8Offset(source, '@audit') + Buffer.byteLength(source.slice(source.indexOf('@audit'), source.indexOf('\n\nclass Box'))),
  });
  assert.equal(extraction.declarations[1].signature, 'class Box[T = <default>]:');
  assert.equal(extraction.declarations[2].signature, 'value: T = <default>');
  assert.deepEqual(extraction.declarations[2].result, { state: 'declared', syntax: 'T' });
  assert.equal(extraction.declarations[4].signature, 'type Alias[T = <default>] = list[T]');
  assert.deepEqual(extraction.declarations[4].result, { state: 'declared', syntax: 'list[T]' });
  for (const secret of ['private decorator argument', 'secret_value', 'private_field', 'private_type']) {
    assert.ok(!JSON.stringify(extraction.declarations).includes(secret));
  }
  assert.equal(extraction.declarations[0].default_digests.length, 4);
  assert.equal(extraction.declarations[1].default_digests.length, 1);
  assert.equal(extraction.declarations[4].default_digests.length, 1);
});

test('Python body changes are direct and a malformed body leaves a valid header available', async () => {
  const before = 'def outer(x: int) -> int:\n    def child() -> int:\n        return 1\n    return x\n';
  const after = before.replace('return 1', 'return 2');
  const input = await extractNativeFunctions(captured(before, 'nested.py'), 'python');
  const observed = await extractNativeFunctions(captured(after, 'nested.py', 2), 'python');
  assert.deepEqual(input.declarations.map(d => [d.name, d.enclosing]), [['outer', []], ['child', ['outer']]]);
  const changes = compareExtractions(input, observed).changes;
  assert.deepEqual(changes.map(c => c.observed?.name ?? c.input?.name), ['child']);
  const malformed = await extractNativeFunctions(captured('def valid(x: int) -> int:\n    return (1 + )\n', 'bad.py'), 'python');
  assert.equal(malformed.coverage, 'incomplete');
  assert.equal(malformed.declarations[0].header_complete, true);
  assert.ok(malformed.limitations.includes('declaration_body_incomplete'));
});

test('defaulted Python type parameters are parsed, masked and independently tracked', async () => {
  const before = 'class Box[T = secret_one]:\n    pass\ntype Alias[T = secret_one] = list[T]\n';
  const after = before.replaceAll('secret_one', 'secret_two');
  const input = await extractNativeFunctions(captured(before, 'generic.py'), 'python');
  const observed = await extractNativeFunctions(captured(after, 'generic.py', 2), 'python');
  assert.equal(input.coverage, 'complete');
  assert.deepEqual(input.declarations.map(d => [d.name, d.signature]), [
    ['Box', 'class Box[T = <default>]:'], ['Alias', 'type Alias[T = <default>] = list[T]'],
  ]);
  assert.ok(!JSON.stringify(input.declarations).includes('secret_one'));
  assert.deepEqual(compareExtractions(input, observed).changes.map(change =>
    [change.observed?.name, change.declaration_changed, change.default_changed]), [
    ['Box', false, true], ['Alias', false, true],
  ]);
});

test('Python written type results and signatures mask comments in all annotation positions', async () => {
  const base = new URL('../fixtures/structural/languages/python/', import.meta.url);
  const cases = JSON.parse(await readFile(new URL('cases.json', base), 'utf8'));
  const source = await readFile(new URL(cases.comment_annotations, base), 'utf8');
  const expected = JSON.parse(await readFile(new URL(cases.comment_expectations, base), 'utf8'));
  const extraction = await extractNativeFunctions(captured(source, cases.comment_annotations), 'python');
  assert.equal(extraction.coverage, expected.coverage);
  assert.deepEqual(extraction.declarations.map(d => ({ name: d.name, signature: d.signature, result: d.result })),
    expected.declarations);
  for (const secret of ['private field annotation', 'private return annotation', 'private alias annotation', 'secret_value']) {
    assert.ok(!JSON.stringify(extraction.declarations).includes(secret));
  }
  const changed = source.replace('private field annotation', 'changed field annotation');
  const observed = await extractNativeFunctions(captured(changed, cases.comment_annotations, 2), 'python');
  assert.deepEqual(compareExtractions(extraction, observed).changes.map(change =>
    [change.observed?.name, change.declaration_changed, change.default_changed]), [['value', false, true]]);
});

test('real Lua grammar extracts local, colon, dot and nested functions plus masked table assignment', async () => {
  const source = await readFile(new URL('../fixtures/structural/languages/lua/input.lua', import.meta.url), 'utf8');
  const extraction = await extractNativeFunctions(captured(source, 'selected.lua'), 'lua');
  assert.equal(extraction.coverage, 'complete');
  assert.deepEqual(extraction.declarations.map(d => [d.name, d.enclosing]), [
    ['greet', []], ['nested', ['greet']], ['Box:get', []], ['Box.read', []], ['value', []],
  ]);
  assert.deepEqual(extraction.declarations[0].parameters, ['x', '...']);
  assert.deepEqual(extraction.declarations[0].result, { state: 'not_declared' });
  assert.equal(extraction.declarations[0].signature, 'local function greet(x, ...)');
  assert.equal(extraction.declarations[4].signature, 'local value = <default>');
  assert.equal(extraction.declarations[0].range.start_byte, utf8Offset(source, 'local function greet'));
  assert.equal(extraction.declarations[4].default_digests.length, 1);
  assert.ok(!JSON.stringify(extraction.declarations).includes('secret = 1'));
});

test('Lua table and body edits change only their direct markers', async () => {
  const before = 'local value = { x = 1 }\nfunction M:go(x) return x end\n';
  const after = 'local value = { x = 2 }\nfunction M:go(x) return x + 1 end\n';
  const input = await extractNativeFunctions(captured(before, 'edit.lua'), 'lua');
  const observed = await extractNativeFunctions(captured(after, 'edit.lua', 2), 'lua');
  assert.deepEqual(compareExtractions(input, observed).changes.map(change =>
    [change.observed?.name, change.default_changed, change.body_changed]), [
    ['M:go', false, true], ['value', true, false],
  ]);
});

for (const [dialect, path, before, after] of [
  ['python', 'ambiguous.py', 'def f():\n    return 1\ndef f():\n    return 2\n',
    'def f():\n    return 3\ndef f():\n    return 4\n'],
  ['lua', 'ambiguous.lua', 'function f() return 1 end\nfunction f() return 2 end\n',
    'function f() return 3 end\nfunction f() return 4 end\n'],
]) {
  test(`${dialect} duplicate syntax remains explicitly ambiguous`, async () => {
    const input = await extractNativeFunctions(captured(before, path), dialect);
    const observed = await extractNativeFunctions(captured(after, path, 2), dialect);
    const comparison = compareExtractions(input, observed);
    assert.equal(input.coverage, 'complete');
    assert.equal(observed.coverage, 'complete');
    assert.deepEqual(comparison.changes.map(change => change.kind),
      ['ambiguous', 'ambiguous', 'ambiguous', 'ambiguous']);
    assert.ok(comparison.limitations.includes('declaration_correspondence_ambiguous'));
  });
}

test('Lua malformed body preserves written function header with explicit incomplete coverage', async () => {
  const extraction = await extractNativeFunctions(captured('function f(x) return (1 + ) end\n', 'bad.lua'), 'lua');
  assert.equal(extraction.coverage, 'incomplete');
  assert.deepEqual(extraction.declarations.map(d => [d.name, d.signature, d.parameters, d.header_complete]),
    [['f', 'function f(x)', ['x'], true]]);
  assert.equal(extraction.declarations[0].body_digest, undefined);
  assert.ok(extraction.limitations.includes('declaration_body_incomplete'));
  assert.ok(extraction.limitations.includes('parse_error_or_missing_token'));
});
