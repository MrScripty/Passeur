import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import Parser from 'tree-sitter';
import { extractCFamily } from '../../.passeur-native/src/observation/language-c-family.js';
import { Utf8SourceRanges } from '../../.passeur-native/src/observation/ranges.js';
import { finishFamilyExtraction } from '../../.passeur-native/src/observation/language-common.js';
import { compareExtractions } from '../../.passeur-native/src/observation/match.js';
import { extractNativeFunctions } from '../../.passeur-native/src/observation/native-extraction.js';

const rows = [
  ['c', 'tree-sitter-c', 'c'],
  ['cpp', 'tree-sitter-cpp', 'cpp'],
  ['csharp', 'tree-sitter-c-sharp', 'cs'],
];
const fixture = (dialect, name, ext) => new URL(`../fixtures/structural/languages/${dialect}/${name}.${ext}`, import.meta.url);
async function parse(dialect, grammar, ext, name) {
  const source = await readFile(fixture(dialect, name, ext), 'utf8');
  const imported = await import(grammar);
  const parser = new Parser();
  parser.setLanguage(imported.default ?? imported);
  const root = parser.parse(source).rootNode;
  const result = extractCFamily({
    file: { status: 'present', text: source }, dialect, root,
    ranges: new Utf8SourceRanges(source), parserIdentity: `${grammar}@pinned`,
  });
  return { source, root, result };
}
function extraction(parsed, dialect, ext, sequence) {
  const source = parsed.source;
  return finishFamilyExtraction({
    file: {
      status: 'present', text: source, byte_length: Buffer.byteLength(source),
      content_sha256: createHash('sha256').update(source).digest('hex'), mode: '100644',
      consistency: 'sampled_file_not_atomic',
      source: { kind: 'working_capture', repository_id: 'c-family-native-fixture', object_format: 'sha1',
        workspace_id: 'fixture-workspace', workspace_generation: 1,
        capture_id: `fixture-${sequence}`, capture_sequence: sequence,
        head_anchor: '0'.repeat(40), path: `comparison.${ext}` },
    }, dialect, root: parsed.root, ranges: new Utf8SourceRanges(source), parserIdentity: `${dialect}@pinned`,
  }, parsed.result);
}
for (const [dialect, grammar, ext] of rows) {
  test(`real ${dialect} grammar matches hand-written declaration oracle and UTF-8 ranges`, async () => {
    const expected = JSON.parse(await readFile(fixture(dialect, 'expected', 'json'), 'utf8'));
    const { source, root, result } = await parse(dialect, grammar, ext, 'input');
    assert.equal(root.hasError, false);
    assert.deepEqual(result.declarations.map(declaration => declaration.name), expected.names);
    assert.deepEqual(result.declarations.map(declaration => declaration.kind), expected.kinds);
    assert.deepEqual(result.limitations, expected.limitations);
    const bytes = Buffer.from(source, 'utf8');
    for (const declaration of result.declarations) {
      const { start_byte, end_byte } = declaration.range;
      assert.ok(end_byte > start_byte);
      assert.ok(end_byte <= bytes.length);
      assert.ok(bytes.subarray(start_byte, end_byte).toString('utf8').includes(declaration.name));
      assert.equal(declaration.header_complete, true);
    }
    assert.equal(result.declarations[0].range.start_byte, expected.first_start_byte);
    assert.equal(result.declarations[0].range.end_byte,
      expected.first_start_byte + Buffer.byteLength(expected.first_source));
    assert.equal(bytes.subarray(result.declarations[0].range.start_byte,
      result.declarations[0].range.end_byte).toString('utf8'), expected.first_source);
    assert.ok(result.declarations[0].range.start_byte > source.indexOf('\n'), 'multibyte prefix precedes declaration');
    if (dialect === 'c') {
      assert.equal(result.declarations[0].signature, expected.sum_signature);
      assert.deepEqual(result.declarations[0].parameters, expected.sum_parameters);
      assert.deepEqual(result.declarations[0].result, { state: 'declared', syntax: expected.sum_result });
      assert.equal(result.declarations.filter(declaration => declaration.name === 'selected').length, expected.selected_branch_count);
      assert.equal(result.declarations[2].result.syntax, 'int');
    } else if (dialect === 'cpp') {
      assert.equal(result.declarations[1].signature, expected.choose_signature);
      assert.deepEqual(result.declarations[1].parameters, expected.choose_parameters);
      assert.deepEqual(result.declarations[1].result, { state: 'declared', syntax: expected.choose_result });
      assert.deepEqual(result.declarations[5].enclosing, expected.run_enclosing);
      assert.deepEqual(result.declarations[5].result, { state: 'declared', syntax: expected.run_result });
      assert.equal(result.declarations[1].default_digests.length, 1);
    } else {
      assert.deepEqual(result.declarations[1].parameters, expected.record_parameters);
      assert.deepEqual(result.declarations[3].enclosing, expected.method_enclosing);
      assert.equal(result.declarations[3].signature, expected.method_signature);
      assert.deepEqual(result.declarations[3].parameters, expected.method_parameters);
      assert.deepEqual(result.declarations[3].result, { state: 'declared', syntax: expected.method_result });
      assert.equal(result.declarations[4].default_digests.length, expected.property_initializer_digests);
      assert.equal(result.declarations[6].signature, 'public int Seed = <default>;');
      const displayed = result.declarations.map(declaration => declaration.signature).join('\n');
      assert.ok(!displayed.includes('secret'));
      assert.ok(!displayed.includes('private'));
      assert.ok(!displayed.includes('17'));
    }
  });
  test(`real ${dialect} grammar keeps changed body/default evidence and malformed source incomplete`, async () => {
    const before = await parse(dialect, grammar, ext, 'input');
    const after = await parse(dialect, grammar, ext, 'changed');
    const changedName = dialect === 'c' ? 'sum' : dialect === 'cpp' ? 'run' : 'Run';
    const first = before.result.declarations.find(declaration => declaration.name === changedName && declaration.body_digest);
    const second = after.result.declarations.find(declaration => declaration.name === changedName && declaration.body_digest);
    assert.ok(first && second);
    if (dialect === 'csharp') {
      assert.notDeepEqual(first.default_digests, second.default_digests);
      assert.equal(first.body_digest, second.body_digest);
    } else {
      assert.notEqual(first.body_digest, second.body_digest);
      assert.equal(first.signature, second.signature);
    }
    const malformed = await parse(dialect, grammar, ext, 'incomplete');
    assert.equal(malformed.root.hasError, true);
    assert.ok(malformed.result.limitations.some(value => value.startsWith('declaration_')));
    assert.ok(malformed.result.declarations.length > 0);
  });
}
test('production native dispatch reaches all three C-family grammars with captured bytes', async () => {
  for (const [dialect, , ext] of rows) {
    const text = await readFile(fixture(dialect, 'input', ext), 'utf8');
    const expected = JSON.parse(await readFile(fixture(dialect, 'expected', 'json'), 'utf8'));
    const file = {
      status: 'present', text, mode: '100644', byte_length: Buffer.byteLength(text),
      content_sha256: createHash('sha256').update(text).digest('hex'), consistency: 'immutable_git_blob',
      source: { kind: 'commit', repository_id: 'c-family-native-fixture', object_format: 'sha1',
        commit_oid: '1'.repeat(40), tree_oid: '2'.repeat(40), path: `sample.${ext}` },
    };
    const result = await extractNativeFunctions(file, dialect);
    assert.deepEqual(result.declarations.map(declaration => declaration.name), expected.names);
    assert.deepEqual(result.limitations, expected.limitations);
    assert.equal(result.source.byte_length, Buffer.byteLength(text));
    assert.ok(result.parser_identity.startsWith('tree-sitter@0.25.1/'));
  }
});
test('repaired C++23 grammar extracts explicit object parameter and written return', async () => {
  const sample = await parse('cpp', 'tree-sitter-cpp', 'cpp', 'explicit-object');
  const expected = JSON.parse(await readFile(fixture('cpp', 'explicit-object-expected', 'json'), 'utf8'));
  assert.equal(sample.root.hasError, false);
  assert.deepEqual(sample.result.limitations, []);
  assert.equal(sample.result.declarations.length, 2);
  assert.equal(sample.result.declarations[0].name, expected.container_name);
  assert.equal(sample.result.declarations[0].kind, expected.container_kind);
  const declaration = sample.result.declarations[1];
  assert.equal(declaration.name, expected.name);
  assert.equal(declaration.kind, expected.kind);
  assert.equal(declaration.signature, expected.signature);
  assert.deepEqual(declaration.parameters, expected.parameters);
  assert.deepEqual(declaration.result, { state: 'declared', syntax: expected.result });
  assert.deepEqual(declaration.enclosing, expected.enclosing);
});
test('repaired C#14 grammar extracts extension receiver and member', async () => {
  const sample = await parse('csharp', 'tree-sitter-c-sharp', 'cs', 'extension-block');
  const expected = JSON.parse(await readFile(fixture('csharp', 'extension-block-expected', 'json'), 'utf8'));
  assert.equal(sample.root.hasError, false);
  assert.deepEqual(sample.result.limitations, []);
  assert.deepEqual(sample.result.declarations.map(declaration => declaration.name), expected.names);
  assert.deepEqual(sample.result.declarations.map(declaration => declaration.kind), expected.kinds);
  assert.deepEqual(sample.result.declarations[1].parameters, expected.receiver);
  assert.deepEqual(sample.result.declarations[2].enclosing, expected.property_enclosing);
  assert.deepEqual(sample.result.declarations[2].result, { state: 'declared', syntax: expected.property_result });
  assert.ok(sample.result.declarations[2].body_digest);
});
test('C23 direct typeof declaration and initializer remain written and masked', async () => {
  const sample = await parse('c', 'tree-sitter-c', 'c', 'modern');
  const expected = JSON.parse(await readFile(fixture('c', 'modern-expected', 'json'), 'utf8'));
  assert.equal(sample.root.hasError, false);
  assert.deepEqual(sample.result.limitations, []);
  assert.deepEqual(sample.result.declarations.map(declaration => declaration.name), expected.names);
  assert.deepEqual(sample.result.declarations.map(declaration => declaration.result.syntax), expected.types);
  assert.equal(sample.result.declarations[1].signature, expected.number_signature);
  assert.equal(sample.result.declarations[1].default_digests.length, 1);
  assert.deepEqual(sample.result.declarations[2].parameters, expected.nullish_parameters);
});
test('patched C23 grammar extracts bit-precise type with exact multibyte CRLF range', async () => {
  const sample = await parse('c', 'tree-sitter-c', 'c', 'bitint');
  const expected = JSON.parse(await readFile(fixture('c', 'bitint-expected', 'json'), 'utf8'));
  assert.equal(sample.root.hasError, false);
  assert.deepEqual(sample.result.limitations, []);
  assert.equal(sample.result.declarations.length, 1);
  const declaration = sample.result.declarations[0];
  assert.equal(declaration.name, expected.name);
  assert.equal(declaration.kind, expected.kind);
  assert.equal(declaration.signature, expected.signature);
  assert.deepEqual(declaration.result, { state: 'declared', syntax: expected.result });
  assert.deepEqual(declaration.range, expected.range);
  assert.equal(Buffer.from(sample.source).subarray(declaration.range.start_byte, declaration.range.end_byte).toString(),
    expected.signature);
});
for (const [dialect, grammar, ext] of rows) {
  test(`real ${dialect} changes parameter order and declared result with stable overload correspondence`, async () => {
    const before = await parse(dialect, grammar, ext, 'comparison-before');
    const after = await parse(dialect, grammar, ext, 'comparison-after');
    assert.equal(before.root.hasError, false);
    assert.equal(after.root.hasError, false);
    assert.deepEqual(before.result.limitations, []);
    assert.deepEqual(after.result.limitations, []);
    const comparison = compareExtractions(extraction(before, dialect, ext, 1), extraction(after, dialect, ext, 2));
    assert.equal(comparison.changes.length, 1);
    assert.equal(comparison.changes[0].kind, 'modified');
    assert.equal(comparison.changes[0].correspondence, 'unique_syntax_correspondence');
    assert.equal(comparison.changes[0].declaration_changed, true);
    assert.deepEqual(comparison.changes[0].input.parameters, ['int a', dialect === 'csharp' ? 'string b' : 'float b']);
    assert.deepEqual(comparison.changes[0].observed.parameters,
      [dialect === 'csharp' ? 'string b' : 'float b', 'int a']);
    assert.equal(comparison.changes[0].observed.result.syntax, 'long');
  });
}
test('real C duplicate declarations retain ambiguous correspondence', async () => {
  const before = await parse('c', 'tree-sitter-c', 'c', 'ambiguous-before');
  const after = await parse('c', 'tree-sitter-c', 'c', 'ambiguous-after');
  const comparison = compareExtractions(extraction(before, 'c', 'c', 1), extraction(after, 'c', 'c', 2));
  assert.equal(before.root.hasError, false);
  assert.equal(after.root.hasError, false);
  assert.equal(comparison.coverage, 'incomplete');
  assert.ok(comparison.limitations.includes('declaration_correspondence_ambiguous'));
  assert.equal(comparison.changes.filter(change => change.kind === 'ambiguous').length, 4);
});
for (const [dialect, grammar, ext] of rows) {
  test(`real ${dialect} declaration addition and removal have distinct unmatched evidence`, async () => {
    const before = await parse(dialect, grammar, ext, 'add-before');
    const after = await parse(dialect, grammar, ext, 'add-after');
    const added = compareExtractions(extraction(before, dialect, ext, 1), extraction(after, dialect, ext, 2));
    const removed = compareExtractions(extraction(after, dialect, ext, 1), extraction(before, dialect, ext, 2));
    const wanted = dialect === 'csharp' ? 'Fresh' : 'fresh';
    assert.equal(before.root.hasError, false);
    assert.equal(after.root.hasError, false);
    assert.ok(added.changes.some(change => change.kind === 'added' && change.observed?.name === wanted));
    assert.ok(removed.changes.some(change => change.kind === 'removed' && change.input?.name === wanted));
  });
}
for (const [dialect, grammar, ext] of rows) {
  test(`real ${dialect} parser masks comments inside public result syntax`, async () => {
    const sample = await parse(dialect, grammar, ext, 'comment-result');
    const expected = JSON.parse(await readFile(fixture(dialect, 'comment-result-expected', 'json'), 'utf8'));
    assert.equal(sample.root.hasError, false);
    assert.deepEqual(sample.result.limitations, []);
    const declaration = sample.result.declarations.find(item => item.name === expected.name);
    assert.ok(declaration);
    assert.deepEqual(declaration.result, { state: 'declared', syntax: expected.result });
    assert.ok(!declaration.signature.includes('private-'));
    assert.ok(!JSON.stringify(declaration.result).includes('private-'));
    const text = sample.source;
    const production = await extractNativeFunctions({
      status: 'present', text, mode: '100644', byte_length: Buffer.byteLength(text),
      content_sha256: createHash('sha256').update(text).digest('hex'), consistency: 'immutable_git_blob',
      source: { kind: 'commit', repository_id: 'c-family-native-fixture', object_format: 'sha1',
        commit_oid: '1'.repeat(40), tree_oid: '2'.repeat(40), path: `comment-result.${ext}` },
    }, dialect);
    const publicResult = production.declarations.find(item => item.name === expected.name)?.result;
    assert.deepEqual(publicResult, { state: 'declared', syntax: expected.result });
    assert.ok(!JSON.stringify(publicResult).includes('private-'));
  });
}
