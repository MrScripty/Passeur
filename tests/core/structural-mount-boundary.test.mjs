import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdtemp, mkdir, open, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { assertSourceMount, captureWorkingFile, parseSourceMountId, sourceMountId } from '../../.passeur-core/src/observation/source.js';
import { listDeclaredSourcePaths } from '../../.passeur-core/src/observation/source-inventory.js';

const run = promisify(execFile);

async function mountedChild() {
  const [, , , root, external, input] = process.argv;
  try { await run('mount', ['--bind', external, join(root, 'src', 'mounted')]); }
  catch (error) {
    if (/permission denied|operation not permitted|wrong fs type/i.test(String(error.stderr ?? error.message))) {
      process.stdout.write('MOUNT_UNAVAILABLE\n');
      return;
    }
    throw error;
  }
  try {
    assert.equal((await stat(root)).dev, (await stat(join(root, 'src', 'mounted'))).dev,
      'The bind mount probe must exercise a same-device boundary');
    const paths = await listDeclaredSourcePaths(root, input, [{ kind: 'subtree', path: 'src' }], 16);
    assert.deepEqual(paths.paths, ['src/safe.ts']);
    assert.ok(paths.limitations.includes('mounted_source_boundary'));
    await assert.rejects(captureWorkingFile({ root, workspace_id: 'mount-fixture', workspace_generation: 1,
      capture_sequence: 1, input_commit_oid: input }, 'src/mounted/secret.ts', { max_bytes: 4096 }),
    { code: 'SOURCE_MOUNT_BOUNDARY' });
    assert.equal((await captureWorkingFile({ root, workspace_id: 'mount-fixture', workspace_generation: 1,
      capture_sequence: 2, input_commit_oid: input }, 'src/safe.ts', { max_bytes: 4096 })).status, 'present');
    process.stdout.write('MOUNT_BOUNDARY_OK\n');
  } finally { await run('umount', [join(root, 'src', 'mounted')]); }
}

if (process.argv[2] === '--mounted-child') {
  await mountedChild();
} else {
  test('Linux fdinfo mount IDs fail closed on missing or ambiguous identity', () => {
    assert.equal(parseSourceMountId('pos:\t0\nmnt_id:\t41\nino:\t7\n'), '41');
    assert.throws(() => parseSourceMountId('pos:\t0\nino:\t7\n'), { code: 'SOURCE_MOUNT_ID_UNAVAILABLE' });
    assert.throws(() => parseSourceMountId('mnt_id:\t41\nmnt_id:\t42\n'), { code: 'SOURCE_MOUNT_ID_UNAVAILABLE' });
    assert.throws(() => parseSourceMountId('mnt_id:\t0x29\n'), { code: 'SOURCE_MOUNT_ID_UNAVAILABLE' });
  });

  test('opened descriptors distinguish a root mount from a nested mount', async t => {
    if (process.platform !== 'linux') return t.skip('Linux descriptor mount identity is required');
    const root = await open('/sys', constants.O_RDONLY | constants.O_DIRECTORY);
    const nested = await open('/sys/fs/cgroup', constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      const rootId = await sourceMountId(root);
      const nestedId = await sourceMountId(nested);
      if (rootId === nestedId) return t.skip('The host does not expose a nested /sys/fs/cgroup mount');
      await assert.doesNotReject(assertSourceMount(root, rootId));
      await assert.rejects(assertSourceMount(nested, rootId), { code: 'SOURCE_MOUNT_BOUNDARY' });
    } finally { await nested.close(); await root.close(); }
  });

  test('inventory and capture refuse a real same-device bind mount below a Git worktree', async t => {
    if (process.platform !== 'linux') return t.skip('Linux descriptor mount identity is required');
    const home = await mkdtemp(join(tmpdir(), 'passeur-mount-boundary-'));
    t.after(() => rm(home, { recursive: true, force: true }));
    const root = join(home, 'repo');
    const external = join(home, 'external');
    await mkdir(join(root, 'src', 'mounted'), { recursive: true });
    await mkdir(external);
    await writeFile(join(root, 'src', 'mounted', 'secret.ts'), 'export const old = 1;\n');
    await writeFile(join(root, 'src', 'safe.ts'), 'export const safe = 1;\n');
    await writeFile(join(external, 'secret.ts'), 'export const outside = 1;\n');
    const git = async (...args) => (await run('git', ['-C', root, ...args], { encoding: 'utf8' })).stdout.trim();
    await git('init', '-q');
    await git('add', 'src');
    await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'core.hooksPath=/dev/null',
      'commit', '-qm', 'input');
    const input = await git('rev-parse', 'HEAD');
    let result;
    try {
      result = await run('unshare', ['-Urnm', process.execPath, import.meta.filename, '--mounted-child', root, external, input],
        { encoding: 'utf8' });
    } catch (error) {
      if (/operation not permitted|permission denied/i.test(String(error.stderr ?? error.message))) {
        return t.skip('User mount namespace is unavailable on this Linux host');
      }
      throw error;
    }
    if (result.stdout.includes('MOUNT_UNAVAILABLE')) return t.skip('Bind mounts are unavailable in the user namespace');
    if (!result.stdout && !result.stderr) return t.skip('Nested user namespace execution is blocked by the test-process sandbox');
    assert.match(result.stdout, /MOUNT_BOUNDARY_OK/, result.stderr);
  });
}
