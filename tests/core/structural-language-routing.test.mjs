import test from 'node:test';
import assert from 'node:assert/strict';
import { isStructuralSourcePath, sourceDialectForPath } from '../../.passeur-core/src/observation/language-routing.js';

test('required source suffixes route to fixed native dialects without probing repository code', () => {
  const cases = [
    ['a.rs', 'rust'], ['a.ts', 'typescript'], ['a.mts', 'typescript'], ['a.cts', 'typescript'],
    ['a.tsx', 'tsx'], ['a.js', 'javascript'], ['a.mjs', 'javascript'], ['a.cjs', 'javascript'],
    ['a.jsx', 'jsx'], ['a.py', 'python'], ['a.pyi', 'python'], ['a.lua', 'lua'],
    ['a.kt', 'kotlin'], ['a.kts', 'kotlin'], ['a.zig', 'zig'], ['a.cs', 'csharp'],
    ['a.c', 'c'], ['a.cc', 'cpp'], ['a.cpp', 'cpp'], ['a.cxx', 'cpp'],
    ['a.hpp', 'cpp'], ['a.hh', 'cpp'], ['a.hxx', 'cpp'], ['a.odin', 'odin'],
    ['a.svelte', 'svelte5'], ['a.svelte.js', 'javascript'], ['a.svelte.ts', 'typescript'],
  ];
  for (const [path, dialect] of cases) {
    assert.equal(isStructuralSourcePath(path), true, path);
    assert.equal(sourceDialectForPath(path), dialect, path);
  }
  assert.equal(isStructuralSourcePath('a.h'), true);
  assert.equal(sourceDialectForPath('a.h'), undefined, 'headers require an explicit dialect');
  assert.equal(sourceDialectForPath('a.h', 'c'), 'c');
  assert.equal(sourceDialectForPath('a.h', 'cpp'), 'cpp');
  assert.equal(sourceDialectForPath('a.js', 'jsx'), 'jsx');
  assert.equal(sourceDialectForPath('a.js', 'cpp'), undefined, 'an invalid explicit route is never guessed');
  assert.equal(sourceDialectForPath('a.jsx', 'jsx'), undefined, 'an override applies only to ambiguous suffixes');
  assert.equal(sourceDialectForPath('a.svelte.js', 'jsx'), undefined);
  assert.equal(isStructuralSourcePath('a.txt'), false);
});
