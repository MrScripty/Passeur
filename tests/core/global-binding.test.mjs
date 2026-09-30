import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRepositoryBinding, defaultProfilePath } from '../../.passeur-core/src/core/repository-runtime.js';
import { gitSterile, projectId } from '../../.passeur-core/src/workspace/project.js';
import { PasseurFrontend } from '../../.passeur-core/src/service/client.js';
import { diagnosticInfo, BridgeError } from '../../.passeur-core/src/core/errors.js';
import { decodeFrame } from '../../.passeur-core/src/service/transport.js';
import { FrontendStatusSchema } from '../../.passeur-core/src/contracts/service.js';
import { serviceLaunchEnvironment } from '../../.passeur-core/src/service/bootstrap.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'passeur-global-binding-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'repo'), config = join(root, 'config'), state = join(root, 'state');
  await mkdir(project); await mkdir(join(config, 'muse-bridge', 'projects'), { recursive: true });
  await gitSterile(project, ['init', '-b', 'main']);
  const environment = { XDG_CONFIG_HOME: config, XDG_STATE_HOME: state };
  const resolve = (intent = { project }) => resolveRepositoryBinding(intent, environment, AbortSignal.timeout(5000));
  return { root, project, config, state, environment, resolve };
}

test('profile precedence is explicit, canonical repository, legacy, then installation default', async t => {
  const f = await fixture(t);
  const fallback = await f.resolve();
  assert.equal(fallback.profilePath, defaultProfilePath(f.environment));
  assert.equal(fallback.profileSource, 'global');
  const legacy = join(f.config, 'muse-bridge', 'projects', `${projectId(f.project)}.json`);
  await writeFile(legacy, '{}');
  assert.equal((await f.resolve()).profilePath, legacy);
  assert.equal((await f.resolve()).profileSource, 'legacy');
  const canonical = join(f.config, 'muse-bridge', 'projects', `${fallback.repositoryId}.json`);
  await writeFile(canonical, '{}');
  assert.equal((await f.resolve()).profilePath, canonical);
  assert.equal((await f.resolve()).profileSource, 'repository');
  const explicit = join(f.root, 'explicit.json');
  assert.equal((await f.resolve({ project: f.project, profilePath: explicit })).profilePath, explicit);
  assert.equal((await f.resolve({ project: f.project, profilePath: explicit })).profileSource, 'explicit');
  assert.equal(defaultProfilePath({ HOME: f.root }), join(f.root, '.config/muse-bridge/default-profile.json'));
});

test('Git override variables cannot redirect repository identity or legacy lookup', async t => {
  const f = await fixture(t), other = join(f.root, 'other'); await mkdir(other);
  await gitSterile(other, ['init']);
  const expected = await f.resolve();
  const previous = Object.fromEntries(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'].map(k => [k, process.env[k]]));
  try {
    Object.assign(process.env, { GIT_DIR: join(other, '.git'), GIT_WORK_TREE: other, GIT_COMMON_DIR: join(other, '.git'), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.worktree', GIT_CONFIG_VALUE_0: other });
    assert.deepEqual(await f.resolve(), expected);
  } finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});

test('linked worktree uses canonical coordination and main legacy profile with its own source view', async t => {
  const f = await fixture(t);
  await gitSterile(f.project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'fixture']);
  const linked = join(f.root, 'linked'); await gitSterile(f.project, ['worktree', 'add', '-b', 'linked', linked]);
  const legacy = join(f.config, 'muse-bridge', 'projects', `${projectId(f.project)}.json`); await writeFile(legacy, '{}');
  const main = await f.resolve(), worktree = await f.resolve({ project: linked });
  assert.equal(worktree.repositoryId, main.repositoryId); assert.equal(worktree.storeRoot, main.storeRoot);
  assert.equal(worktree.profilePath, legacy); assert.equal(worktree.project, linked);
});

test('frontend captures launch environment and bounds missing-path diagnostics', async t => {
  const f = await fixture(t), old = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = f.config;
  const identity = { package_version: 'fixture', build_id: 'fixture', mode: 'development', node_version: process.version, node_executable: process.execPath, pid: process.pid, started_at: new Date().toISOString() };
  const intent = { project: f.project, stateRoot: f.state };
  const frontend = new PasseurFrontend(intent, identity, '/unused-cli');
  try {
    process.env.XDG_CONFIG_HOME = join(f.root, 'changed'); intent.project = join(f.root, 'missing');
    const observed = await frontend.observeStatus();
    assert.equal(observed.service.state, 'not_checked');
    assert.equal(observed.resolved.project, f.project);
    assert.equal(observed.resolved.profile_path, defaultProfilePath(f.environment));
    assert.equal(observed.resolved.profile_source, 'global');
    await assert.rejects(frontend.agents(0, 16), error => {
      const info = diagnosticInfo(error); assert.equal(info.code, 'PROFILE_CONFIGURATION_REQUIRED');
      assert.equal(info.path, defaultProfilePath(f.environment)); assert.equal(info.native_code, 'ENOENT'); return true;
    });
    assert.equal(frontend.status().binding.project_input, f.project);
    assert.equal(frontend.status().resolved.profile_path, defaultProfilePath(f.environment));
    assert.equal(frontend.status().resolved.profile_source, "global");
    assert.equal(FrontendStatusSchema.safeParse(frontend.status()).success, true);
  } finally { await frontend.shutdown(); if (old === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = old; }
});

test('IPC preserves bounded typed failures and rejects excess fields and context', () => {
  const error = diagnosticInfo(new BridgeError('PATH_NOT_FOUND', 'token=private-value', { stage: 'profile.read', path: '/missing', native_code: 'ENOENT', next_action: 'check path' }));
  const frame = { kind: 'failure', id: 'request', generation: 'generation', error };
  assert.deepEqual(decodeFrame(frame).error, error); assert.equal(error.message, 'token=[redacted]');
  assert.throws(() => decodeFrame({ ...frame, error: { ...error, secret: 'hidden' } }));
  assert.throws(() => decodeFrame({ ...frame, error: { ...error, stage: 'x'.repeat(129) } }));
});

test('service launcher preserves the frontend allowlist and excludes ambient secrets', () => {
  const launch = Object.freeze({ PATH: '/session/bin', HOME: '/session/home', XDG_CONFIG_HOME: '/session/config',
    PASSEUR_OBSERVATION_MONITOR: 'off', API_TOKEN: 'must-not-cross' });
  assert.deepEqual(serviceLaunchEnvironment(launch), { PATH: '/session/bin', HOME: '/session/home',
    XDG_CONFIG_HOME: '/session/config', PASSEUR_OBSERVATION_MONITOR: 'off' });
});
