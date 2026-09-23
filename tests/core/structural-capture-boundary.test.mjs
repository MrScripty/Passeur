import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { captureWorkingFile } from '../../.passeur-core/src/observation/source.js';

const run = promisify(execFile);
const options = { max_bytes: 4096 };

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'passeur-capture-boundary-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = join(home, 'repo');
  await mkdir(root);
  const git = async (...args) => (await run('git', ['-C', root, ...args], { encoding: 'utf8' })).stdout.trim();
  await git('init', '-q');
  await writeFile(join(root, 'main.ts'), 'export const main = true;\n');
  await git('add', 'main.ts');
  const commit = async message => {
    await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
      '-c', 'core.hooksPath=/dev/null', 'commit', '-qam', message);
    return git('rev-parse', 'HEAD');
  };
  const input = await commit('input');
  const workspace = { root, workspace_id: 'test-workspace', workspace_generation: 1, capture_sequence: 1, input_commit_oid: input };
  return { home, root, git, commit, input, workspace };
}

test('direct capture refuses an untracked nested repository and remains usable for owned files', async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, 'nested'));
  await run('git', ['-C', join(f.root, 'nested'), 'init', '-q']);
  await writeFile(join(f.root, 'nested', 'secret.ts'), 'export const child = true;\n');
  await assert.rejects(captureWorkingFile(f.workspace, 'nested/secret.ts', options), { code: 'SOURCE_REPOSITORY_BOUNDARY' });
  assert.equal((await captureWorkingFile(f.workspace, 'main.ts', options)).status, 'present');
});

test('direct capture refuses a live local submodule even when a source path is requested exactly', async t => {
  const f = await fixture(t);
  const child = join(f.home, 'child');
  await mkdir(child);
  const childGit = async (...args) => (await run('git', ['-C', child, ...args])).stdout;
  await childGit('init', '-q');
  await writeFile(join(child, 'secret.ts'), 'export const child = true;\n');
  await childGit('add', 'secret.ts');
  await childGit('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
    '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'child');
  await f.git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', child, 'deps/local');
  await assert.rejects(captureWorkingFile(f.workspace, 'deps/local/secret.ts', options), { code: 'SOURCE_REPOSITORY_BOUNDARY' });
  await rm(join(f.root, 'deps', 'local', '.git'));
  await assert.rejects(captureWorkingFile(f.workspace, 'deps/local/secret.ts', options), { code: 'SOURCE_REPOSITORY_BOUNDARY' });
  await f.commit('add submodule');
  await f.git('rm', '-q', '--cached', 'deps/local');
  await assert.rejects(captureWorkingFile(f.workspace, 'deps/local/secret.ts', options), { code: 'SOURCE_REPOSITORY_BOUNDARY' });
});

test('an input gitlink still blocks capture after the current workspace replaces it with ordinary files', async t => {
  const f = await fixture(t);
  const child = join(f.home, 'child');
  await mkdir(child);
  const childGit = async (...args) => (await run('git', ['-C', child, ...args])).stdout;
  await childGit('init', '-q');
  await writeFile(join(child, 'secret.ts'), 'export const child = true;\n');
  await childGit('add', 'secret.ts');
  await childGit('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
    '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'child');
  await f.git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', child, 'deps/local');
  const linkedInput = await f.commit('add submodule');
  await f.git('rm', '-qf', 'deps/local');
  await f.commit('remove submodule');
  await mkdir(join(f.root, 'deps', 'local'), { recursive: true });
  await writeFile(join(f.root, 'deps', 'local', 'secret.ts'), 'export const replacement = true;\n');
  await assert.rejects(captureWorkingFile({ ...f.workspace, input_commit_oid: linkedInput },
    'deps/local/secret.ts', options), { code: 'SOURCE_REPOSITORY_BOUNDARY' });
});
