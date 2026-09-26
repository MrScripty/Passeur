import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extractNativeFunctions } from '../../.passeur-native/src/observation/native-extraction.js';
import { compareExtractions } from '../../.passeur-native/src/observation/match.js';
import { sourceDialectForPath } from '../../.passeur-native/src/observation/language-routing.js';
import { selectPeerOverlapEvidence } from '../../.passeur-core/src/observation/overlap.js';

const root = new URL('../oracles/fixture-apps/', import.meta.url);
const apps = new URL('../fixture-apps/', import.meta.url);
const ids = Array.from({ length: 13 }, (_, index) => `L${String(index + 1).padStart(2, '0')}`);
const aliases = new Map([
  ['L02', [['src/format.cts', 'typescript'], ['src/quote.mts', 'typescript']]],
  ['L04', [['quote.pyi', 'python']]],
  ['L06', [['quote.kts', 'kotlin']]],
  ['L09', [['quote.h', 'c', 'c']]],
  ['L10', [['pricing.h', 'cpp', 'cpp']]],
  ['L12', [['src/App.svelte', 'svelte5'], ['src/quote.svelte.ts', 'typescript'],
    ['src/delivery.svelte.js', 'javascript']]],
  ['L13', [['src/LineItem.js', 'jsx', 'jsx'], ['src/QuoteForm.jsx', 'jsx'],
    ['src/QuoteForm.tsx', 'tsx']]],
]);
const capture = (text, path, sequence) => ({ status: 'present', text, mode: '100644',
  content_sha256: createHash('sha256').update(text).digest('hex'), byte_length: Buffer.byteLength(text),
  consistency: 'sampled_file_not_atomic', source: { kind: 'working_capture',
    repository_id: 'fixture-oracle', object_format: 'sha1', workspace_id: 'fixture-oracle',
    workspace_generation: 1, capture_id: `fixture-${sequence}`, capture_sequence: sequence,
    head_anchor: 'a'.repeat(40), path } });

function authoredRange(text, snippet) {
  const first = text.indexOf(snippet);
  assert.ok(first >= 0 && text.indexOf(snippet, first + 1) < 0, 'authored range snippet must occur once');
  return { start_byte: Buffer.byteLength(text.slice(0, first)),
    end_byte: Buffer.byteLength(text.slice(0, first + snippet.length)) };
}

function targetChange(comparison, name) {
  const matches = comparison.changes.filter(change => (change.observed?.name ?? change.input?.name) === name);
  assert.equal(matches.length, 1, `${name} needs exactly one corresponding change`);
  return matches[0];
}

function fixturePath(rootName, path) {
  assert.match(rootName, /^[a-z][a-z0-9-]*$/, 'manifest fixture root');
  const prefix = `tests/fixture-apps/${rootName}/`;
  assert.ok(path.startsWith(prefix), 'source path must identify its manifest fixture root');
  const relative = path.slice(prefix.length);
  assert.match(relative, /^(?!\/)(?!.*(?:^|\/)\.\.?\/)[\w./-]+$/, 'fixture-relative source path');
  return new URL(`${rootName}/${relative}`, apps);
}

function replaceOnce(source, from, to, label) {
  assert.ok(typeof from === 'string' && from.length > 0, `${label} needs an authored before span`);
  assert.ok(typeof to === 'string' && to !== from, `${label} needs a distinct authored replacement`);
  const first = source.indexOf(from);
  assert.ok(first >= 0 && source.indexOf(from, first + from.length) < 0,
    `${label} before span must occur exactly once in the app source`);
  return source.slice(0, first) + to + source.slice(first + from.length);
}

function assertRoute(path, dialect, override, label) {
  assert.equal(sourceDialectForPath(path, override), dialect, `${label} route`);
  if (path.endsWith('.h') || (path.endsWith('.js') && dialect === 'jsx')) {
    assert.equal(sourceDialectForPath(path), path.endsWith('.h') ? undefined : 'javascript',
      `${label} requires an explicit dialect owner`);
  } else {
    assert.equal(override, undefined, `${label} fixed suffix cannot use an override`);
  }
}

function assertAvailable(extraction, label) {
  assert.notEqual(extraction.coverage, 'unavailable',
    `${label}: ${extraction.limitations.join(', ')}`);
}

function assertAuthoredCoverage(result, permitted, label) {
  assertAvailable(result, label);
  if (permitted.length === 0)
    assert.equal(result.coverage, 'complete', `${label} requires complete coverage`);
  else
    assert.ok(['complete', 'incomplete'].includes(result.coverage),
      `${label} requires at least incomplete coverage`);
}

function assertRouteExpectation(extraction, expectation, label) {
  assert.ok(expectation && Array.isArray(expectation.minimum_declarations) &&
    expectation.minimum_declarations.length > 0 &&
    expectation.minimum_declarations.every(name => typeof name === 'string' && name.length > 0),
  `${label} needs independently authored minimum declarations`);
  assert.ok(Array.isArray(expectation.permitted_limitations) &&
    expectation.permitted_limitations.every(item => typeof item === 'string' && item.length > 0),
  `${label} needs independently authored permitted limitations`);
  assert.equal(new Set(expectation.minimum_declarations).size,
    expectation.minimum_declarations.length, `${label} duplicate minimum declaration`);
  assert.equal(new Set(expectation.permitted_limitations).size,
    expectation.permitted_limitations.length, `${label} duplicate permitted limitation`);
  assertAuthoredCoverage(extraction, expectation.permitted_limitations, label);
  const names = new Set(extraction.declarations.map(item => item.name));
  for (const name of expectation.minimum_declarations)
    assert.ok(names.has(name), `${label} missing required declaration ${name}`);
  for (const limitation of extraction.limitations)
    assert.ok(expectation.permitted_limitations.includes(limitation),
      `${label} unexpected limitation ${limitation}`);
}

function assertComparisonExpectation(comparison, permitted, label) {
  assert.ok(Array.isArray(permitted) &&
    permitted.every(item => typeof item === 'string' && item.length > 0),
  `${label} needs independently authored comparison limitations`);
  assert.equal(new Set(permitted).size, permitted.length, `${label} duplicate permitted limitation`);
  assertAuthoredCoverage(comparison, permitted, label);
  for (const limitation of comparison.limitations)
    assert.ok(permitted.includes(limitation), `${label} unexpected limitation ${limitation}`);
}

for (const id of ids) test(`${id} authored parser and two-edit overlap oracle`, async () => {
  const oracle = JSON.parse(await readFile(new URL(`${id}.json`, root), 'utf8'));
  assert.equal(oracle.id, id);
  assert.deepEqual(oracle.functional.map(item => item.id), ['normal', 'zero', 'invalid']);
  for (const entry of oracle.syntax) {
    const before = await extractNativeFunctions(capture(entry.source, entry.path, 1), entry.dialect);
    const left = await extractNativeFunctions(capture(entry.left, entry.path, 2), entry.dialect);
    const right = await extractNativeFunctions(capture(entry.right, entry.path, 3), entry.dialect);
    const declaration = before.declarations.filter(item => item.name === entry.expected.declaration);
    assert.equal(declaration.length, 1, `${id}/${entry.id} declaration`);
    assert.deepEqual(declaration[0].range, authoredRange(entry.source, entry.expected.range_text));
    assert.ok(declaration[0].signature.includes(entry.expected.signature_contains));
    assert.equal(declaration[0].header_complete, true);
    for (const [label, extracted, expected] of [
      ['left', left, entry.expected.left_changes], ['right', right, entry.expected.right_changes]]) {
      const comparison = compareExtractions(before, extracted);
      for (const item of expected) {
        const change = targetChange(comparison, item.name);
        assert.equal(change.kind, item.kind, `${id}/${entry.id}/${label} kind`);
        assert.equal(change.body_changed, item.body_changed, `${id}/${entry.id}/${label} body`);
        assert.equal(change.default_changed, item.default_changed, `${id}/${entry.id}/${label} default`);
        assert.equal(change.declaration_changed, item.declaration_changed, `${id}/${entry.id}/${label} signature`);
      }
      assert.ok(comparison.changes.some(change => (change.observed?.name ?? change.input?.name) ===
        entry.expected.overlap.subject), `${id}/${entry.id}/${label} overlap subject`);
      assert.notEqual(extracted.source.content_sha256, before.source.content_sha256);
    }
    const replay = compareExtractions(before, left);
    assert.deepEqual(replay, compareExtractions(before, left), `${id}/${entry.id} deterministic comparison`);
    const leftChange = targetChange(replay, entry.expected.overlap.subject);
    const rightChange = targetChange(compareExtractions(before, right), entry.expected.overlap.subject);
    assert.equal(leftChange.body_changed && rightChange.body_changed, true,
      `${id}/${entry.id} both independent edits touch the authored subject`);
    assert.equal(entry.expected.overlap.observations, 2);
  }
});

for (const id of ids) test(`${id} app source routes and selects two actual overlap observations`, async () => {
  const oracle = JSON.parse(await readFile(new URL(`${id}.json`, root), 'utf8'));
  const manifest = JSON.parse(await readFile(new URL('manifest.json', apps), 'utf8'));
  const row = manifest.rows.find(item => item.id === id);
  assert.ok(row, `${id} needs a fixture manifest row`);
  const overlap = oracle.fixture_overlap;
  assert.ok(overlap, `${id} needs fixture_overlap metadata for actual app source qualification`);
  assert.ok(typeof overlap.path === 'string' && typeof overlap.dialect === 'string' &&
    typeof overlap.subject === 'string' && typeof overlap.anchor === 'string' &&
    typeof overlap.left === 'string' && typeof overlap.right === 'string',
  `${id} fixture_overlap needs path, dialect, subject, anchor, left and right`);
  assert.ok(overlap.extraction_expectation?.minimum_declarations?.includes(overlap.subject),
    `${id} minimum declarations must include the overlap subject`);
  const path = overlap.path;
  assert.ok(row.sources.some(source => path === `tests/fixture-apps/${row.root}/${source.path}`),
    `${id} overlap path must be in manifest`);
  assertRoute(path, overlap.dialect, overlap.override, `${id} baseline`);
  const baseline = await readFile(fixturePath(row.root, path), 'utf8');
  const left = replaceOnce(baseline, overlap.anchor, overlap.left, `${id}/left`);
  const right = replaceOnce(baseline, overlap.anchor, overlap.right, `${id}/right`);
  assert.notEqual(left, right, `${id} independent edits must differ`);
  const files = [baseline, left, right].map((source, index) => capture(source, path, index + 1));
  const [before, leftExtracted, rightExtracted] = await Promise.all(files.map(file =>
    extractNativeFunctions(file, overlap.dialect)));
  for (const [index, extracted] of [before, leftExtracted, rightExtracted].entries()) {
    assertRouteExpectation(extracted, overlap.extraction_expectation,
      `${id}/${['before', 'left', 'right'][index]}`);
    assert.equal(extracted.dialect, overlap.dialect);
    assert.deepEqual(extracted.source.source, files[index].source);
  }
  const declaration = before.declarations.filter(item => item.name === overlap.subject);
  assert.equal(declaration.length, 1, `${id} needs one baseline subject`);
  assert.equal(declaration[0].header_complete, true, `${id} subject header`);
  const expectedReason = overlap.expected_reason ?? 'body_changed';
  assert.ok(['body_changed', 'default_changed', 'signature_changed'].includes(expectedReason),
    `${id} needs a supported expected_reason`);
  const comparisons = [leftExtracted, rightExtracted].map(extracted => compareExtractions(before, extracted));
  const changes = comparisons.map((comparison, index) => {
    assertComparisonExpectation(comparison, overlap.permitted_comparison_limitations,
      `${id}/${['left', 'right'][index]} comparison`);
    const change = targetChange(comparison, overlap.subject);
    assert.equal(comparison.changes.length, 1,
      `${id}/${['left', 'right'][index]} edit must exclude unrelated symbols`);
    assert.equal(change.kind, 'modified');
    assert.equal(change[expectedReason === 'signature_changed' ? 'declaration_changed' : expectedReason], true,
      `${id} authored edit must produce ${expectedReason}`);
    assert.deepEqual(change.input, declaration[0]);
    assert.equal(change.observed?.name, overlap.subject);
    if (overlap.unrelated_symbol) {
      assert.ok(before.declarations.some(item => item.name === overlap.unrelated_symbol),
        `${id} unrelated symbol must be present in the app source`);
      assert.ok(!comparison.changes.some(item =>
        (item.input?.name ?? item.observed?.name) === overlap.unrelated_symbol),
      `${id} unrelated symbol must remain unchanged`);
    }
    return change;
  });
  const observedLimitations = [...new Set([before, leftExtracted, rightExtracted, ...comparisons]
    .flatMap(result => result.limitations))].sort();
  const evidence = selectPeerOverlapEvidence({ input: files[0], dialect: overlap.dialect,
    parser_identity: before.parser_identity, extractor_identity: before.extractor_identity,
    subject_id: declaration[0].key, declaration: declaration[0],
    limitations: observedLimitations,
    observations: changes.map((change, index) => ({ observation_id: ['left', 'right'][index],
      observed: files[index + 1], change })) });
  assert.equal(evidence.subject.name, overlap.subject);
  assert.equal(evidence.subject_id, declaration[0].key);
  assert.deepEqual(evidence.changes.map(item => item.observation_id), ['left', 'right']);
  assert.equal(evidence.changes.length, 2);
  assert.ok(evidence.changes.every(item => item.reasons.includes(expectedReason)),
    `${id} selected evidence must retain ${expectedReason}`);
  assert.deepEqual(evidence.input.source, files[0].source);
  assert.deepEqual(evidence.changes.map(item => item.observed_source.source),
    files.slice(1).map(file => file.source));
  assert.ok(files.every(file => file.source.repository_id === files[0].source.repository_id &&
    file.source.workspace_id === files[0].source.workspace_id && file.source.path === path));
  assert.equal(new Set(files.map(file => file.source.capture_id)).size, 3);
  if (overlap.unrelated_symbol)
    assert.notEqual(evidence.subject.name, overlap.unrelated_symbol);

  for (const [relativePath, dialect, override] of aliases.get(id) ?? []) {
    assert.ok(row.sources.some(source => source.path === relativePath), `${id} alias must be in manifest`);
    const aliasPath = `tests/fixture-apps/${row.root}/${relativePath}`;
    assertRoute(aliasPath, dialect, override, `${id}/${relativePath}`);
    const aliasSource = await readFile(fixturePath(row.root, aliasPath), 'utf8');
    const extracted = await extractNativeFunctions(capture(aliasSource, aliasPath, 10), dialect);
    const expectation = overlap.alias_expectations?.[relativePath];
    assertRouteExpectation(extracted, expectation, `${id}/${relativePath} alias`);
    assert.equal(extracted.dialect, dialect, `${id}/${relativePath} extracted dialect`);
    assert.equal(extracted.source.content_sha256,
      createHash('sha256').update(aliasSource).digest('hex'), `${id}/${relativePath} source identity`);
  }
  assert.deepEqual(Object.keys(overlap.alias_expectations ?? {}).sort(),
    (aliases.get(id) ?? []).map(([path]) => path).sort(), `${id} alias expectation routes`);
  assert.deepEqual(evidence.limitations, observedLimitations,
    `${id} selected evidence must retain parser and comparison limitations`);
  for (const limitation of evidence.limitations)
    assert.ok([...overlap.extraction_expectation.permitted_limitations,
      ...overlap.permitted_comparison_limitations].includes(limitation),
    `${id} selected evidence has unexpected limitation ${limitation}`);
  assertAuthoredCoverage(evidence, [...overlap.extraction_expectation.permitted_limitations,
    ...overlap.permitted_comparison_limitations], `${id} selected overlap`);
});

test('authored TypeScript defaults and written signatures advance distinct comparison evidence', async () => {
  const beforeText = 'export function quote(cents: number = 100): number { return cents; }\n';
  const defaultText = 'export function quote(cents: number = 200): number { return cents; }\n';
  const signatureText = 'export function quote(cents: bigint = 100n): bigint { return cents; }\n';
  const before = await extractNativeFunctions(capture(beforeText, 'quote.ts', 11), 'typescript');
  const changedDefault = await extractNativeFunctions(capture(defaultText, 'quote.ts', 12), 'typescript');
  const changedSignature = await extractNativeFunctions(capture(signatureText, 'quote.ts', 13), 'typescript');
  assert.equal(before.declarations[0].signature,
    'export function quote(cents: number = <default>): number');
  assert.deepEqual(before.declarations[0].range, authoredRange(beforeText, beforeText.trimEnd()));
  const defaultChange = targetChange(compareExtractions(before, changedDefault), 'quote');
  assert.deepEqual([defaultChange.declaration_changed, defaultChange.body_changed, defaultChange.default_changed],
    [false, false, true]);
  const signatureChange = targetChange(compareExtractions(before, changedSignature), 'quote');
  assert.deepEqual([signatureChange.declaration_changed, signatureChange.body_changed, signatureChange.default_changed],
    [true, false, true]);
});
