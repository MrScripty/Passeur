import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { listDeclaredSourcePaths } from '../../.passeur-core/src/observation/source-inventory.js';

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'passeur-source-inventory-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = join(home, 'repo');
  await mkdir(join(root, 'src'), { recursive: true });
  const git = async (...args) => (await promisify(execFile)('git', ['-C', root, ...args], { encoding: 'utf8' })).stdout.trim();
  await git('init', '-q');
  await writeFile(join(root, 'src', 'deleted.rs'), 'fn removed() {}\n');
  await writeFile(join(root, 'src', 'same.ts'), 'export function same() {}\n');
  await writeFile(join(root, 'src', 'unsupported.txt'), 'ordinary text\n');
  await git('add', 'src');
  await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'input');
  const input = await git('rev-parse', 'HEAD');
  return { home, root, git, input };
}

test('declared subtree merges immutable input-only files and untracked working sources deterministically', async t => {
  const f = await fixture(t);
  await rm(join(f.root, 'src', 'deleted.rs'));
  await writeFile(join(f.root, 'src', 'new.mts'), 'export const newSource = 1;\n');
  await writeFile(join(f.root, 'src', 'new.cts'), 'export const newCommonJs = 1;\n');
  await writeFile(join(f.root, 'src', 'new.tsx'), 'export const view = <div />;\n');
  const actual = await listDeclaredSourcePaths(f.root, f.input, [{ kind: 'subtree', path: 'src' }], 10);
  assert.deepEqual(actual.paths, ['src/deleted.rs', 'src/new.cts', 'src/new.mts', 'src/new.tsx', 'src/same.ts']);
  assert.deepEqual(actual.limitations, []);
});

test('exact declared files stay observable when absent on both sides; the result exposes truncation', async t => {
  const f = await fixture(t);
  const actual = await listDeclaredSourcePaths(f.root, f.input, [
    { kind: 'file', path: 'src/missing.ts' }, { kind: 'subtree', path: 'src' }], 2);
  assert.deepEqual(actual.paths, ['src/deleted.rs', 'src/missing.ts']);
  assert.deepEqual(actual.limitations, ['source_file_inventory_limit']);
});

test('a managed subtree declaration may name one source file', async t => {
  const f = await fixture(t);
  const actual = await listDeclaredSourcePaths(f.root, f.input, [{ kind: 'subtree', path: 'src/same.ts' }], 4);
  assert.deepEqual(actual.paths, ['src/same.ts']);
  assert.deepEqual(actual.limitations, []);
});

test('the coordination contract permits more than fifty declared regions', async t => {
  const f = await fixture(t);
  const areas = Array.from({ length: 52 }, (_, index) => ({ kind: 'file', path: `src/area${String(index).padStart(3, '0')}.ts` }));
  const actual = await listDeclaredSourcePaths(f.root, f.input, areas, 4);
  assert.deepEqual(actual.paths, areas.slice(0, 4).map(area => area.path));
  assert.deepEqual(actual.limitations, ['source_file_inventory_limit']);
});

test('a symlink inside a declared subtree cannot inventory outside names', async t => {
  const f = await fixture(t);
  const outside = join(f.home, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'secret.ts'), 'export const secret = true;\n');
  await symlink(outside, join(f.root, 'src', 'linked'));
  const actual = await listDeclaredSourcePaths(f.root, f.input, [{ kind: 'subtree', path: 'src' }], 10);
  assert.equal(actual.paths.includes('src/linked/secret.ts'), false);
  assert.ok(actual.limitations.includes('source_inventory_unsafe_or_changed'));
});

test('an untracked nested Git repository is a source boundary', async t => {
  const f = await fixture(t);
  const nested = join(f.root, 'nested');
  await mkdir(nested);
  await promisify(execFile)('git', ['-C', nested, 'init', '-q']);
  await writeFile(join(nested, 'secret.ts'), 'export const nestedSource = true;\n');
  const actual = await listDeclaredSourcePaths(f.root, f.input, [{ kind: 'subtree', path: 'nested' }], 4);
  assert.deepEqual(actual.paths, []);
  assert.ok(actual.limitations.includes('nested_repository_boundary'));
});

test('input, HEAD, and index gitlinks each block submodule source enumeration', async t => {
  const f = await fixture(t);
  const remote = join(f.home, 'local-submodule');
  await mkdir(remote);
  const childGit = async (...args) => (await promisify(execFile)('git', ['-C', remote, ...args], { encoding: 'utf8' })).stdout.trim();
  await childGit('init', '-q');
  await writeFile(join(remote, 'secret.ts'), 'export const submoduleSource = true;\n');
  await childGit('add', 'secret.ts');
  await childGit('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'submodule');
  await f.git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', remote, 'deps/local');
  const areas = [{ kind: 'subtree', path: 'deps/local' }];
  const staged = await listDeclaredSourcePaths(f.root, f.input, areas, 4);
  assert.deepEqual(staged.paths, []);
  assert.ok(staged.limitations.includes('nested_repository_boundary'));
  const nestedDeclaredFile = await listDeclaredSourcePaths(f.root, f.input,
    [{ kind: 'file', path: 'deps/local/secret.ts' }], 4);
  assert.deepEqual(nestedDeclaredFile.paths, []);
  assert.ok(nestedDeclaredFile.limitations.includes('nested_repository_boundary'));
  await f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'core.hooksPath=/dev/null', 'commit', '-qam', 'add submodule');
  const inputGitlink = await f.git('rev-parse', 'HEAD');
  const committed = await listDeclaredSourcePaths(f.root, f.input, areas, 4);
  assert.deepEqual(committed.paths, []);
  assert.ok(committed.limitations.includes('nested_repository_boundary'));
  await f.git('rm', '-qf', 'deps/local');
  await f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'core.hooksPath=/dev/null', 'commit', '-qam', 'remove submodule');
  await mkdir(join(f.root, 'deps', 'local'), { recursive: true });
  await writeFile(join(f.root, 'deps', 'local', 'fresh.ts'), 'export const fresh = true;\n');
  const oldInput = await listDeclaredSourcePaths(f.root, inputGitlink, areas, 4);
  assert.deepEqual(oldInput.paths, []);
  assert.ok(oldInput.limitations.includes('nested_repository_boundary'));
});

test('replacement races never expose names reached through an outside symlink', async t => {
  const f = await fixture(t);
  const outside = join(f.home, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'secret.ts'), 'export const secret = true;\n');
  await mkdir(join(f.root, 'volatile'));
  await writeFile(join(f.root, 'volatile', 'safe.ts'), 'export const safe = true;\n');
  const renamed = join(f.root, 'volatile-renamed');
  let running = true;
  const churn = (async () => {
    while (running) {
      try {
        await rename(join(f.root, 'volatile'), renamed);
        await symlink(outside, join(f.root, 'volatile'));
        await rm(join(f.root, 'volatile'));
        await rename(renamed, join(f.root, 'volatile'));
      } catch { /* The reader may observe an intermediate rename; continue the bounded race probe. */ }
    }
  })();
  try {
    for (let index = 0; index < 12; index++) {
      const actual = await listDeclaredSourcePaths(f.root, f.input, [{ kind: 'subtree', path: 'volatile' }], 10);
      assert.equal(actual.paths.some(path => path.includes('secret.ts')), false);
    }
  } finally { running = false; await churn; }
});

test('invalid input OIDs and area paths are rejected before inventory', async t => {
  const f = await fixture(t);
  await assert.rejects(listDeclaredSourcePaths(f.root, 'HEAD', [{ kind: 'subtree', path: 'src' }], 10),
    { code: 'STRUCTURAL_INVENTORY_INPUT_INVALID' });
  await assert.rejects(listDeclaredSourcePaths(f.root, f.input, [{ kind: 'subtree', path: '../outside' }], 10),
    { code: 'SOURCE_PATH_INVALID' });
});
