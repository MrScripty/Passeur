import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fixture, git, done } from './helpers.mjs';
import { RepositoryRuntime } from '../../.passeur-core/src/core/repository-runtime.js';
import { codexDefinition } from '../../.passeur-core/src/agents/codex/config.js';
import { reconcileStoredTasks } from '../../.passeur-core/src/core/recovery.js';
import { projectId } from '../../.passeur-core/src/workspace/project.js';

const exec = promisify(execFile);
const codexOptions = { codex_bin: '/bin/codex', codex_home: '/tmp/codex-home', model: 'fixture-model',
  subscription_confirmed: true, experimental_opt_in: true, use_caller_codex_home: true };
const capability = { schema_version: 1, mount_kind: 'canonical_common_dir' };
const identity = { package_version: 'fixture', build_id: 'fixture', mode: 'development',
  node_version: process.version, node_executable: process.execPath, pid: process.pid, started_at: new Date().toISOString() };

async function commit(input, privateView) {
  const name = privateView ? 'protected.txt' : 'ordinary.txt';
  await writeFile(join(input.workspace, name), `${name}\n`);
  const environment = privateView ? { ...process.env,
    GIT_DIR: join(privateView.private_common_dir, privateView.admin_relative) } : process.env;
  await exec('git', ['-C', input.workspace, 'add', '--', name], { env: environment });
  await exec('git', ['-C', input.workspace, '-c', 'user.name=Worker', '-c', 'user.email=worker@example.invalid',
    'commit', '-qm', `test: ${name}`], { env: environment });
}

function observed(run) {
  return async input => {
    const turn_id = crypto.randomUUID();
    await input.onEvent({ kind: 'turn_started', turn_id });
    const result = await run(input);
    await input.onEvent({ kind: 'turn_settled', turn_id, terminal: result.status === 'completed' ? 'completed' : 'failed' });
    return result;
  };
}

async function runtimeFixture(t, f, registrations, definitions) {
  let loads = 0;
  const profile = { ...f.profile, agents: registrations };
  const runtime = new RepositoryRuntime({ project: f.root, profilePath: join(f.temp, 'profile.json') }, identity, {
    resolveBinding: async () => ({ project: f.root, repositoryId: projectId(join(f.root, '.git')), commonDir: join(f.root, '.git'),
      stateRoot: f.state, storeRoot: f.state, profilePath: join(f.temp, 'profile.json') }),
    acquire: async () => ({ state: 'held', assertOwned() {}, async release() {} }),
    store: () => f.store, recover: reconcileStoredTasks, legacyRoots: async () => [],
    profile: async () => { loads++; return profile; }, definitions,
  }, {});
  t.after(() => runtime.shutdown());
  const execute = async assignment => {
    const signal = new AbortController().signal;
    const receipt = await runtime.submit(assignment, f.owner, f.root, signal);
    while (true) {
      const result = await f.store.readResult(receipt.task_id);
      if (result) return result;
      const state = await runtime.taskObservation(receipt.task_id, f.owner);
      await runtime.waitTask(receipt.task_id, f.owner, state.revision, 50, signal);
    }
  };
  return { runtime, execute, get loads() { return loads; } };
}

test('registered capable worker uses RepositoryRuntime private Git while an ordinary worker keeps its ordinary path', async t => {
  const f = await fixture(t), seen = [];
  const hookMarker = join(f.temp, 'hook-ran');
  const hook = join(f.root, '.git', 'hooks', 'pre-commit');
  await writeFile(hook, `#!/bin/sh\nprintf hook >> '${hookMarker}'\n`); await chmod(hook, 0o755);
  const registrations = [
    { agent_id: 'protected', adapter_id: 'codex', enabled: true, description: 'protected',
      options: { ...codexOptions, experimental_real_protected: true } },
    { agent_id: 'ordinary', adapter_id: 'ordinary', enabled: true, description: 'ordinary', options: {} },
  ];
  const definitions = {
    codex: { configure(options) {
      const configured = codexDefinition.configure(options);
      return { ...configured, worker: { ...configured.worker, run: observed(async input => {
        seen.push({ kind: 'protected', view: input.private_git?.view });
        assert.deepEqual(input.private_git && { schema_version: input.private_git.schema_version,
          mount_kind: input.private_git.mount_kind }, capability);
        assert.equal((await f.store.readResource(input.task_id)).private_git.state, 'prepared');
        await commit(input, input.private_git.view);
        return done();
      }) } };
    } },
    ordinary: { configure: () => ({ contract: 'ordinary/1', modes: ['implement'], configuration: {},
      worker: { run: observed(async input => {
        seen.push({ kind: 'ordinary', view: input.private_git?.view });
        assert.equal(input.private_git, undefined);
        await commit(input);
        return done();
      }) } }) },
  };
  const host = await runtimeFixture(t, f, registrations, definitions);
  const catalog = await host.runtime.agents();
  assert.equal(catalog.total, 2); assert.equal(host.loads, 1); assert.deepEqual(seen, []);
  assert.equal((await f.store.list()).length, 0);
  const protectedResult = await host.execute(f.implementation('protected-registered', { agent_id: 'protected' }));
  assert.equal(protectedResult.execution_status, 'completed');
  assert.equal(protectedResult.delivery.status, 'committed');
  assert.equal((await f.store.readResource(protectedResult.task_id)).private_git.state, 'published');
  assert.equal((await f.store.readPrivatePublication(protectedResult.task_id)).state, 'published');
  assert.equal(await readFile(hookMarker, 'utf8'), 'hook');
  assert.equal(await readFile(join(protectedResult.delivery.worktree_path, 'protected.txt'), 'utf8'), 'protected.txt\n');
  const ordinaryResult = await host.execute(f.implementation('ordinary-registered', { agent_id: 'ordinary' }));
  assert.equal(ordinaryResult.execution_status, 'completed');
  assert.equal(ordinaryResult.delivery.status, 'committed');
  assert.equal((await f.store.readResource(ordinaryResult.task_id)).schema_version, 1);
  assert.equal(await f.store.readPrivatePublication(ordinaryResult.task_id), undefined);
  assert.equal(await readFile(hookMarker, 'utf8'), 'hookhook');
  assert.equal((await git(f.root, 'rev-parse', 'HEAD')).trim(), f.base);
  assert.deepEqual(seen.map(item => item.kind), ['protected', 'ordinary']);
});

test('disabled protected registration remains unavailable without native import or private preparation', async t => {
  const f = await fixture(t);
  const host = await runtimeFixture(t, f, [{ agent_id: 'protected', adapter_id: 'codex', enabled: false,
    description: 'disabled', options: { ...codexOptions, experimental_real_protected: true } }],
    { codex: codexDefinition });
  assert.equal((await host.runtime.agents()).agents[0].state, 'disabled');
  assert.equal((await f.store.list()).length, 0);
});
