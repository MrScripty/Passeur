import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ASSIGNMENTS, BASELINE, COMBINED_ORACLE, assertBlindness, classifyPair,
  oracleOutput, prepareFixture, promptFor, registeredProfile } from '../../scripts/qualify-codex-blinded-pair.mjs';
import { RepositoryRuntime } from '../../.passeur-core/src/core/repository-runtime.js';

const python = (cwd, ...args) => execFileSync('python3', ['main.py', ...args],
  { cwd, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' } });
const git = (cwd, ...args) => execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8',
  env: { PATH: '/usr/bin:/bin', HOME: cwd, GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1' } }).trim();

test('disposable L04-derived baseline is a clean no-remote pre-feature application', async t => {
  const fixture = await prepareFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  assert.equal(fixture.no_remote, true);
  assert.equal(git(fixture.project, 'remote'), '');
  assert.equal(git(fixture.project, 'status', '--porcelain'), '');
  assert.equal(git(fixture.project, 'rev-parse', 'HEAD'), fixture.base);
  await assert.rejects(readFile(join(fixture.project, '.git', 'hooks', 'fixture-hook-marker')), { code: 'ENOENT' });
  const report = JSON.parse(await readFile(join(fixture.root, 'bounded-report.json'), 'utf8'));
  assert.equal(report.status, 'prepared_only');
  assert.equal(report.qualification, 'nonpassing_retained');
  assert.deepEqual(report.accepted_task_ids, []);
  assert.equal(report.baseline_sha256, fixture.baseline_sha256);
  for (const [name, bytes] of Object.entries(BASELINE))
    assert.equal(await readFile(join(fixture.project, name), 'utf8'), bytes);
  assert.equal(python(fixture.project, '1250', '3'), 'subtotal_cents=3750\ntotal_cents=3750\n');
  assert.equal(oracleOutput(python(fixture.project, '1250', '3'), COMBINED_ORACLE.fields), false);
  const beforeFeatures = spawnSync('python3', ['main.py', ...COMBINED_ORACLE.input],
    { cwd: fixture.project, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(beforeFeatures.status, 2);
  assert.equal(beforeFeatures.stdout, '');
  assert.equal(beforeFeatures.stderr, 'error: expected unit_cents quantity\n');
  assert.doesNotMatch(BASELINE['quote.py'], /discount|delivery|shipping/i);
});

test('held assignments and combined oracle do not enter either initial prompt', async t => {
  const fixture = await prepareFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const held = JSON.parse(await readFile(join(fixture.root, 'vault', 'assignments.json'), 'utf8'));
  const prompts = held.map(part => promptFor({ ...part, base_commit: fixture.base }));
  assertBlindness(prompts, held.map(part => part.held_canary));
  assert.match(fixture.root, /^\/tmp\/passeur-codex-work-[^/]+$/);
  assert.doesNotMatch(fixture.project, /blinded|pair|overlap|conflict|negotiat/i);
  const profile = registeredProfile(fixture.root, '/usr/bin/true', join(fixture.root, 'home'));
  assert.doesNotMatch(JSON.stringify({ workspace: profile.execution.implementation.worktree_root,
    registration: profile.agents[0] }), /blinded|pair|overlap|conflict|negotiat/i);
  assert.doesNotMatch(await readFile(join(fixture.project, '.git', 'hooks', 'pre-commit'), 'utf8'),
    /blinded|pair|overlap|conflict|negotiat/i);
  for (const [index, prompt] of prompts.entries()) {
    assert.deepEqual(prompt.allowed_paths, ['main.py', 'quote.py', 'display.py']);
    assert.equal(prompt.base_commit, fixture.base);
    assert.equal(prompt.target_ref, 'refs/heads/main');
    assert.equal(prompt.agent_id, 'codex');
    assert.match(prompt.request_key, /^task-[0-9a-f-]+$/);
    assert.match(prompt.context, /git -c user\.name='Passeur Fixture' -c user\.email='passeur-fixture@example\.invalid' commit/);
    assert.doesNotMatch(JSON.stringify(prompt), new RegExp(held[1 - index].held_canary, 'i'));
    assert.doesNotMatch(JSON.stringify(prompt), new RegExp(ASSIGNMENTS[1 - index].objective, 'i'));
    assert.doesNotMatch(JSON.stringify(prompt), /combined.oracle|sibling|peer|overlap|negotiat|conflict/i);
  }
  assert.deepEqual(JSON.parse(await readFile(join(fixture.root, 'vault', 'combined-oracle.json'), 'utf8')),
    COMBINED_ORACLE);
  assert.equal(oracleOutput('subtotal_cents=10000\ndiscount_cents=2000\ndelivery_cents=500\ntotal_cents=8500\n',
    COMBINED_ORACLE.fields), true);
  assert.equal(oracleOutput('subtotal_cents=10000\ndiscount_cents=2000\ndelivery_cents=500\ntotal_cents=8000\n',
    COMBINED_ORACLE.fields), false);
  for (const malformed of [
    'subtotal_cents=10000\ndiscount_cents=2000\ndelivery_cents=500\ndelivery_cents=500\ntotal_cents=8500\n',
    'subtotal_cents=10000\ndiscount_cents=2000\ndiscount_cents=2000\ntotal_cents=8500\n',
    'subtotal_cents=10000\ndiscount_cents=2000\ndelivery_cents=500\ntotal_cents=8500=8500\n',
    'subtotal_cents=10000\ndiscount_cents=2000\ndelivery_cents=500\ntotal_cents\n',
    'subtotal_cents=10000\ndiscount_cents=2000\ndelivery_cents=500\ntotal_cents=8500\n\n',
  ]) assert.equal(oracleOutput(malformed, COMBINED_ORACLE.fields), false);
});

test('missing native, peer, or retention evidence cannot classify a pair as passing', () => {
  const complete = Object.fromEntries(['blind', 'baseline', 'no_remote', 'overlapping_native_execution',
    'automatic_overlap', 'source_grounded_handoff', 'proposal', 'counterproposal', 'distinct_consent',
    'exact_version_application', 'hooked_commits', 'combined_oracle', 'confirmed_stops',
    'protected_canaries', 'retained_resources'].map(key => [key, true]));
  assert.equal(classifyPair(complete), 'pair_passed');
  for (const key of ['overlapping_native_execution', 'counterproposal', 'exact_version_application',
    'confirmed_stops', 'retained_resources'])
    assert.equal(classifyPair({ ...complete, [key]: false }), 'nonpassing_retained');
  assert.equal(classifyPair({}), 'nonpassing_retained');
});

test('the built-in Codex registration is discoverable through RepositoryRuntime without native startup', async t => {
  const fixture = await prepareFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const profilePath = join(fixture.root, 'profile.json');
  const profile = registeredProfile(fixture.root, '/usr/bin/true', join(fixture.root, 'home'));
  await writeFile(profilePath, `${JSON.stringify(profile)}\n`, { mode: 0o600 });
  const runtime = new RepositoryRuntime({ project: fixture.project, profilePath,
    stateRoot: join(fixture.root, 'state') }, { package_version: 'fixture', build_id: 'offline-profile',
    mode: 'development', node_version: process.version, node_executable: process.execPath,
    pid: process.pid, started_at: new Date().toISOString() });
  t.after(() => runtime.shutdown());
  const catalog = await runtime.agents();
  assert.equal(catalog.agents.length, 1);
  assert.equal(catalog.agents[0].agent_id, 'codex');
  assert.equal(catalog.agents[0].state, 'configured');
  assert.deepEqual(catalog.agents[0].modes, ['implement']);
});
