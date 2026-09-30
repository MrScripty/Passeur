import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { decodeSharedProfile, effectiveProfileFingerprint, loadSharedProfile } from '../../.passeur-core/src/core/profile.js';
import { RepositoryRuntime } from '../../.passeur-core/src/core/repository-runtime.js';
import { repositoryIdentity } from '../../.passeur-core/src/workspace/project.js';

const identity = { package_version: '0.1.0', build_id: 'development-unidentified', mode: 'development', node_version: process.version,
  node_executable: process.execPath, pid: process.pid, started_at: new Date().toISOString() };
function profile() {
  return decodeSharedProfile({ schema_version: 3, execution: { implementation: { enabled: false } }, agents: [
    { agent_id: 'alpha', adapter_id: 'fixture', modes: ['review', 'implement'], options: { model: 'original', nested: { z: 1, a: [true, null] } } },
    { agent_id: 'beta', adapter_id: 'fixture', enabled: false, options: {} },
  ] });
}
async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'passeur-profile-snapshot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function runtimeFixture(t, profilePath, dependencies = {}) {
  const runtime = new RepositoryRuntime({ project: '/fixture/project', profilePath }, identity, {
    resolveBinding: async () => ({ project: '/fixture/project', repositoryId: 'abc', commonDir: '/fixture/project/.git',
      stateRoot: '/fixture/state', storeRoot: '/fixture/state/repo', profilePath }),
    acquire: async () => { throw Error('snapshot must not acquire a lease'); },
    store: () => { throw Error('snapshot must not initialize a store'); },
    recover: async () => { throw Error('snapshot must not reconcile tasks'); }, definitions: {}, ...dependencies,
  }, {});
  t.after(() => runtime.shutdown());
  return runtime;
}

test('fingerprint normalizes object keys, agent order and set-like modes', () => {
  const first = profile(), second = profile();
  second.agents.reverse();
  second.agents[1].modes.reverse();
  second.agents[1].options = { nested: { a: [true, null], z: 1 }, model: 'original' };
  assert.match(effectiveProfileFingerprint(first), /^sha256:v1:[a-f0-9]{64}$/);
  assert.equal(effectiveProfileFingerprint(first), effectiveProfileFingerprint(second));
});
test('fingerprint includes policy, registry fields and opaque option values', () => {
  const original = effectiveProfileFingerprint(profile());
  for (const change of [
    p => p.execution.max_waiters++, p => p.execution.implementation.worktree_root = '/elsewhere',
    p => p.agents[0].agent_id = 'changed', p => p.agents[0].adapter_id = 'changed',
    p => p.agents[0].enabled = false, p => p.agents[0].description = 'changed',
    p => p.agents[0].modes = ['review'], p => delete p.agents[0].modes,
    p => p.agents[0].options.model = 'changed', p => p.agents[0].options.nested.a.reverse(),
  ]) {
    const changed = profile(); change(changed);
    assert.notEqual(effectiveProfileFingerprint(changed), original);
  }
});
test('equal files at different paths share identity and changed content differs', async t => {
  const root = await temporary(t), first = join(root, 'one.json'), second = join(root, 'two.json');
  await Promise.all([writeFile(first, JSON.stringify(profile())), writeFile(second, JSON.stringify(profile()))]);
  const a = await runtimeFixture(t, first).profileSnapshot(), b = await runtimeFixture(t, second).profileSnapshot();
  assert.notEqual(a.profilePath, b.profilePath); assert.equal(a.fingerprint, b.fingerprint);
  const changed = profile(); changed.execution.max_clients++;
  await writeFile(first, JSON.stringify(changed));
  assert.notEqual(a.fingerprint, effectiveProfileFingerprint(await loadSharedProfile(first)));
});
test('concurrent catalog and snapshot admission use one detached deeply frozen profile', async t => {
  const supplied = profile(); let loads = 0, finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const runtime = runtimeFixture(t, '/fixture/profile.json', { profile: async () => { loads++; await gate; return supplied; } });
  const catalog = runtime.agents(), a = runtime.profileSnapshot(), b = runtime.profileSnapshot();
  finish();
  const [observed, first, second] = await Promise.all([catalog, a, b]);
  assert.equal(loads, 1); assert.equal(first, second);
  assert.equal(observed.configuration, 'fixed_for_runtime');
  assert.equal(runtime.status().coordination.state, 'idle');
  for (const value of [first, first.profile, first.profile.execution, first.profile.agents, first.profile.agents[0], first.profile.agents[0].options.nested.a]) assert.ok(Object.isFrozen(value));
  assert.throws(() => { first.profile.agents[0].options.model = 'changed'; }, TypeError);
  supplied.agents[0].options.model = 'changed'; supplied.agents[0].description = 'changed';
  assert.equal(first.profile.agents[0].options.model, 'original');
  assert.equal((await runtime.agents()).agents[0].description, ''); assert.equal(loads, 1);
  assert.equal(first.fingerprint, effectiveProfileFingerprint(first.profile));
});
test('failed profile loads are retryable without admitting a snapshot', async t => {
  const root = await temporary(t), path = join(root, 'profile.json'), runtime = runtimeFixture(t, path);
  await assert.rejects(runtime.profileSnapshot(), { code: 'PATH_NOT_FOUND' });
  await writeFile(path, '{broken');
  await assert.rejects(runtime.agents(), { code: 'PROFILE_INVALID' });
  assert.equal(runtime.configuredProfile, undefined);
  await writeFile(path, JSON.stringify(profile()));
  const snapshot = await runtime.profileSnapshot();
  await writeFile(path, '{broken');
  assert.equal(await runtime.profileSnapshot(), snapshot);
  assert.equal((await runtime.agents()).total, 2);
});
test('execution composition consumes the admitted catalog snapshot after source changes', async t => {
  const root = await temporary(t);
  await promisify(execFile)('git', ['init', '-q', root]);
  const repository = await repositoryIdentity(root, new AbortController().signal);
  let supplied = profile(), loads = 0; const configured = [];
  const runtime = runtimeFixture(t, '/fixture/profile.json', {
    resolveBinding: async () => ({ project: root, repositoryId: repository.id, commonDir: join(root, '.git'),
      stateRoot: root, storeRoot: join(root, 'state'), profilePath: '/fixture/profile.json' }),
    profile: async () => { loads++; return supplied; }, legacyRoots: async () => [],
    acquire: async () => ({ state: 'held', assertOwned() {}, async release() { this.state = 'released'; } }),
    store: () => ({ async initialize() {}, async list() { return []; }, async find() {}, async frozenReason() {} }), recover: async () => {},
    definitions: { fixture: { configure(options) { configured.push(options.model); throw Error('fixture cannot execute'); } } },
  });
  await runtime.agents(); const snapshot = await runtime.profileSnapshot();
  supplied = profile(); supplied.agents[0].options.model = 'changed';
  await assert.rejects(runtime.submit({ agent_id: 'missing', request_key: 'test', mode: 'review' },
    { owner_id: 'owner', client_id: 'client' }, root, new AbortController().signal), { code: 'AGENT_NOT_FOUND' });
  assert.equal(loads, 1); assert.deepEqual(configured, ['original', 'original']);
  assert.equal(await runtime.profileSnapshot(), snapshot);
});
