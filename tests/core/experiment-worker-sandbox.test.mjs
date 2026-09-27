import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareSandbox, probeBubblewrap } from '../../scripts/experiment-worker-sandbox.mjs';

function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'passeur-worker-sandbox-'));
  const paths = Object.fromEntries(['worker', 'sibling', 'oracle', 'control', 'pristine', 'git-private', 'runtime'].map((name) => {
    const path = join(root, name);
    mkdirSync(path);
    writeFileSync(join(path, 'marker'), name);
    return [name, path];
  }));
  try { return fn(paths); } finally { rmSync(root, { recursive: true, force: true }); }
}

function config(paths) {
  return {
    workspace: paths.worker,
    denied: [paths.sibling, paths.oracle, paths.control, paths.pristine],
    mounts: [
      { mode: 'rw', source: paths['git-private'], target: '/mounts/git-private' },
      { mode: 'ro', source: paths.runtime, target: '/mounts/runtime' },
    ],
    env: { EXPERIMENT_TOKEN: 'toy-only' },
  };
}

test('preflight rejects protected and overlapping mount sources with typed diagnostics', () => fixture((paths) => {
  const base = config(paths);
  assert.throws(() => prepareSandbox({ ...base, mounts: [{ mode: 'ro', source: paths.oracle, target: '/mounts/oracle' }] }, ['/bin/true']), /SOURCE_DENIED: mount 0 source/);
  assert.throws(() => prepareSandbox({ ...base, workspace: paths.sibling }, ['/bin/true']), /SOURCE_DENIED: workspace/);
  assert.throws(() => prepareSandbox({ ...base, mounts: [...base.mounts, { mode: 'rw', source: paths['git-private'], target: '/mounts/second-git' }] }, ['/bin/true']), /WRITE_OVERLAP/);
  assert.throws(() => prepareSandbox({ ...base, mounts: [{ mode: 'rw', source: paths.runtime, target: '/usr' }] }, ['/bin/true']), /TARGET_RESERVED/);
  assert.throws(() => prepareSandbox({ ...base, workspace: '/' }, ['/bin/true']), /SOURCE_INVALID/);
  assert.throws(() => prepareSandbox({ ...base, mounts: [{ mode: 'rw', source: '/', target: '/mounts/host' }] }, ['/bin/true']), /SOURCE_INVALID/);
  assert.throws(() => prepareSandbox({ ...base, denied: ['/usr'] }, ['/bin/true']), /SOURCE_DENIED: system \/usr/);
}));

test('fake host can write own workspace and private Git while protected paths and symlink/proc routes stay absent', { skip: process.platform !== 'linux' }, () => fixture((paths) => {
  probeBubblewrap();
  assert.equal(readFileSync(join(paths.oracle, 'marker'), 'utf8'), 'oracle');
  assert.equal(readFileSync(join(paths.sibling, 'marker'), 'utf8'), 'sibling');
  symlinkSync(paths.oracle, join(paths.worker, 'oracle-link'));
  symlinkSync(paths.sibling, join(paths.worker, 'sibling-link'));
  const script = [
    "const fs=require('fs');",
    "const assert=require('assert/strict');",
    "assert.equal(process.cwd(),'/workspace');",
    "assert.equal(process.env.EXPERIMENT_TOKEN,'toy-only');",
    "assert.equal(process.env.HOME,'/workspace');",
    "for(const p of ['/workspace/oracle-link/marker','/workspace/sibling-link/marker','/proc/self/root/workspace/oracle-link/marker','/proc/1/root/workspace/oracle-link/marker']) assert.equal(fs.existsSync(p),false,p);",
    "for(const p of process.argv.slice(1)) assert.equal(fs.existsSync(p),false,p);",
    "fs.writeFileSync('/workspace/output','own');",
    "fs.writeFileSync('/mounts/git-private/output','git');",
    "assert.equal(fs.readFileSync('/mounts/runtime/marker','utf8'),'runtime');",
    "assert.throws(()=>fs.writeFileSync('/mounts/runtime/marker','changed'));",
  ].join('');
  const prepared = prepareSandbox(config(paths), ['/usr/bin/node', '-e', script, paths.oracle, paths.control, paths.pristine, paths.sibling]);
  const result = spawnSync(prepared.executable, prepared.args, { encoding: 'utf8', env: {} });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(paths.worker, 'output'), 'utf8'), 'own');
  assert.equal(readFileSync(join(paths['git-private'], 'output'), 'utf8'), 'git');
  assert.equal(readFileSync(join(paths.runtime, 'marker'), 'utf8'), 'runtime');
}));

test('ordinary Git hook executes inside the worker filesystem and command exit is retained', { skip: process.platform !== 'linux' }, () => fixture((paths) => {
  probeBubblewrap();
  const init = spawnSync('git', ['init', '-q', paths.worker], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const hooks = join(paths.worker, '.git', 'hooks');
  writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\nprintf hook > hook-ran\n');
  chmodSync(join(hooks, 'pre-commit'), 0o755);
  writeFileSync(join(paths.worker, 'tracked'), 'content');
  const command = ['/bin/sh', '-c', 'git add tracked && git -c user.name=Fake -c user.email=fake@example.invalid commit -qm offline'];
  const prepared = prepareSandbox(config(paths), command);
  const commit = spawnSync(prepared.executable, prepared.args, { encoding: 'utf8', env: {} });
  assert.equal(commit.status, 0, commit.stderr);
  assert.equal(readFileSync(join(paths.worker, 'hook-ran'), 'utf8'), 'hook');
  const exitPrepared = prepareSandbox(config(paths), ['/bin/sh', '-c', 'exit 37']);
  const exited = spawnSync(exitPrepared.executable, exitPrepared.args, { encoding: 'utf8', env: {} });
  assert.equal(exited.status, 37, exited.stderr);
  const configPath = join(paths['git-private'], 'sandbox.json');
  writeFileSync(configPath, JSON.stringify(config(paths)));
  const cli = spawnSync(process.execPath, [
    fileURLToPath(new URL('../../scripts/experiment-worker-sandbox.mjs', import.meta.url)),
    configPath, '--', '/bin/sh', '-c', 'printf cli > cli-ran; exit 23',
  ], { encoding: 'utf8' });
  assert.equal(cli.status, 23, cli.stderr);
  assert.equal(readFileSync(join(paths.worker, 'cli-ran'), 'utf8'), 'cli');
}));
