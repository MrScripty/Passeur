import test from 'node:test';
import assert from 'node:assert/strict';
import { SourcePathPage } from '../../.passeur-core/src/observation/inventory-selection.js';

const names = count => Array.from({ length: count }, (_, i) => `src/a${String(i).padStart(4, '0')}.ts`);
function page(paths, limit, options) { const p = new SourcePathPage(limit, options); for (const name of paths) p.add(name); return p.result(); }

test('an explicitly watched last file cannot be displaced by alphabetically earlier files', () => {
  const input = [...names(300), 'src/z.ts'];
  for (const paths of [input, [...input].reverse()]) {
    const result = page(paths, 256, { priority_paths: ['src/z.ts'] });
    assert.equal(result.paths.length, 256); assert.equal(result.paths[0], 'src/z.ts');
    assert.equal(result.next_path, 'src/a0254.ts');
  }
});
test('bounded continuation visits every stable inventory path beyond 256', () => {
  const input = [...names(600), 'src/z.ts']; const seen = new Set();
  let options = { priority_paths: ['src/z.ts'] }, rounds = 0;
  do {
    const result = page([...input].reverse(), 256, options);
    assert.ok(result.paths.length <= 256); for (const path of result.paths) seen.add(path);
    rounds++; assert.ok(rounds < 10, 'cursor must progress');
    if (result.next_path === undefined) break;
    options = { after_path: result.next_path };
  } while (true);
  assert.deepEqual([...seen].sort(), input);
  assert.equal(rounds, 3);
});
test('an all-priority page continues before the ordinary prefix instead of skipping it', () => {
  const input = ['a', 'b', 'z']; const first = page(input, 1, { priority_paths: ['z'] });
  assert.deepEqual(first, { paths: ['z'], next_path: '' });
  assert.deepEqual(page(input, 1, { after_path: first.next_path }), { paths: ['a'], next_path: 'a' });
});
test('priorities do not repeat at the front of every continuation page', () => {
  const first = page(['a','b','c','z'], 2, { priority_paths: ['z'] });
  assert.deepEqual(first, { paths: ['z','a'], next_path: 'a' });
  assert.deepEqual(page(['a','b','c','z'], 2, { after_path: first.next_path, priority_paths: ['z'] }), { paths: ['b','c'], next_path: 'c' });
});
test('duplicates do not create phantom overflow or cursor entries', () => {
  assert.deepEqual(page(['a','a','b','a','b'], 2), { paths: ['a','b'] });
});
test('source-page continuation propagates through a bounded page merge', () => {
  const p = new SourcePathPage(2); p.add('a'); p.add('b');
  assert.deepEqual(p.result(true), { paths: ['a','b'], next_path: 'b' });
});
test('scope boundaries remove only component descendants', () => {
  const p = new SourcePathPage(4); for (const path of ['src/sub/a.ts','src/submarine.ts','src/x.ts']) p.add(path);
  p.removeBeneath('src/sub');
  assert.deepEqual(p.result(), { paths: ['src/submarine.ts','src/x.ts'] });
});
test('a cursor is an exclusive lexical boundary, not a claim that a live inventory is a snapshot', () => {
  assert.deepEqual(page(['a','b','c','d'], 2, { after_path: 'b' }), { paths: ['c','d'] });
  assert.deepEqual(page(['a','aa','c','d'], 2, { after_path: 'b' }), { paths: ['c','d'] });
  assert.deepEqual(page(['a','aa','c','d'], 2), { paths: ['a','aa'], next_path: 'aa' });
});
test('empty and exact-sized pages finish without a continuation', () => {
  assert.deepEqual(page([], 4), { paths: [] });
  assert.deepEqual(page(['d','a','c','b'], 4), { paths: ['a','b','c','d'] });
});
for (const limit of [0, 257, NaN, 1.5]) test(`invalid page bound ${limit} is rejected`, () => {
  assert.throws(() => new SourcePathPage(limit), { code: 'STRUCTURAL_INVENTORY_LIMIT_INVALID' });
});
test('priority input cannot exceed its own bounded set', () => {
  assert.throws(() => new SourcePathPage(4, { priority_paths: names(257) }), { code: 'STRUCTURAL_INVENTORY_LIMIT_INVALID' });
});
for (const after_path of ['x\0y', 'x'.repeat(4097), 42]) test('invalid continuation representation is rejected', () => {
  assert.throws(() => new SourcePathPage(4, { after_path }), { code: 'STRUCTURAL_INVENTORY_CURSOR_INVALID' });
});

test('priority order preserves a recent change ahead of other watched paths', () => {
  const p = page(['src/a.ts','src/b.ts','src/z.ts'], 2, { priority_paths: ['src/z.ts','src/a.ts','src/z.ts'] });
  assert.deepEqual(p.paths, ['src/z.ts','src/a.ts']);
  assert.equal(p.next_path, '');
});
