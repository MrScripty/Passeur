import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { prepareFixture, observeBounded, classifyEvidence, readinessFailures, needsAttentionDiagnostic, toolBody } from '../../scripts/qualify-codex-registered-service.mjs';

test('disposable service fixture has clean no-remote Python base, committed canary, private profile, and hook', async () => {
  const { manifest, assignment } = await prepareFixture('/bin/codex', '/tmp/codex-home');
  const execute = promisify(execFile);
  const git = async (...args) => (await execute('/usr/bin/git', args, { cwd: manifest.project, encoding: 'utf8' })).stdout.trim();
  assert.equal(await git('status', '--porcelain'), '');
  assert.equal(await git('remote'), '');
  assert.equal(await git('rev-parse', 'HEAD'), manifest.base);
  assert.equal(await git('ls-files'), 'held-canary.txt\nquote.py');
  assert.equal(await git('config', '--local', '--get', 'commit.gpgsign'), 'false');
  assert.equal(await git('config', '--get', 'commit.gpgsign'), 'false');
  const ambient = join(manifest.root, 'ambient.gitconfig');
  await writeFile(ambient, '[commit]\n\tgpgsign = true\n');
  assert.equal((await execute('/usr/bin/git', ['config', '--get', 'commit.gpgsign'], {
    cwd: manifest.project, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: ambient },
  })).stdout.trim(), 'false');
  assert.equal(await git('config', '--local', '--get', 'core.hooksPath').catch(() => ''), '');
  assert.equal((await stat(manifest.profilePath)).mode & 0o777, 0o600);
  assert.equal((await stat(join(manifest.project, '.git', 'hooks', 'commit-msg'))).mode & 0o111, 0o111);
  assert.equal(assignment.base_commit, manifest.base);
  assert.deepEqual(assignment.allowed_paths, ['registered-service.txt']);
  assert.equal(assignment.context.includes('held-canary'), false);
  assert.equal((await readFile(join(manifest.root, 'registered-service-report.json'), 'utf8')).includes('nonpassing_retained'), true);
});

test('bounded observation treats elapsed wait and input as retained states without control operations', async () => {
  const operations = [];
  let now = 0;
  const initial = { task_id: 'task-one', phase: 'active', revision: 1, inputs_count: 0 };
  const call = async (name, args, timeout) => {
    operations.push({ name, args, timeout }); now += 100;
    return operations.length === 1 ? { kind: 'wait_elapsed', task: initial } :
      { kind: 'input_required', task: { ...initial, phase: 'awaiting_input', revision: 2, inputs_count: 1 } };
  };
  const observed = await observeBounded(call, initial, 1000, () => now);
  assert.equal(observed.phase, 'awaiting_input');
  assert.deepEqual(operations.map(op => op.name), ['passeur_wait', 'passeur_wait']);
  assert.equal(operations[0].args.after_revision, 1);
  assert.equal(operations[0].args.wait_ms, 1000);
  assert.equal(operations[1].args.after_revision, 1);
  assert.equal((await observeBounded(async () => { throw Error('should not wait'); }, initial, 0, () => 0)).phase, 'active');
});

test('single-worker pass needs service, native, Git, hook and retained resource evidence', () => {
  const evidence = { installed: true, same_generation: true, registered: true, no_remote: true,
    main_unchanged: true, canaries_unchanged: true, worktree_canary_unchanged: true, hook_ran: true, marker_exact: true,
    committed_marker_exact: true,
    only_marker_changed: true, private_ref_matches: true, canonical_ref_matches: true,
    resource_state: 'retained', private_publication_state: 'published', base: 'base', head: 'head', task_id: 'task',
    result: { task_id: 'task', execution_status: 'completed', worker_stop: 'confirmed', worker_assessment: 'met',
      blockers: [], questions: [],
      native_evidence: { run_id: 'task', turn_id: 'turn', native_session_id: 'session', state: 'stopped', coverage: 'turn_scoped', obligations: [] },
      model: { reported: 'gpt-6-astra' }, identity: { snapshot: { agent_id: 'codex', adapter_id: 'codex' } },
      delivery: { status: 'committed', base_commit: 'base', head_commit: 'head', branch_ref: 'refs/heads/task' },
      checks: [
        { command: 'python3 -c "import ast; from pathlib import Path; ast.parse(Path(\'quote.py\').read_text())"', exit_code: 0, evidence: 'runtime_observed' },
        { command: 'python3 -c "from pathlib import Path; assert Path(\'registered-service.txt\').read_bytes() == b\'registered-service-ok\\n\'"', exit_code: 0, evidence: 'runtime_observed' },
      ] } };
  assert.equal(classifyEvidence(evidence), 'single_worker_passed');
  for (const key of ['same_generation', 'hook_ran', 'private_ref_matches', 'canaries_unchanged'])
    assert.equal(classifyEvidence({ ...evidence, [key]: false }), 'nonpassing_retained');
  assert.equal(classifyEvidence({ ...evidence, result: { ...evidence.result, worker_stop: 'unconfirmed' } }), 'nonpassing_retained');
  assert.equal(classifyEvidence({ ...evidence, result: { ...evidence.result, native_evidence: { ...evidence.result.native_evidence,
    obligations: [{ id: 'tool', kind: 'tool' }] } } }), 'nonpassing_retained');
  assert.equal(classifyEvidence({ ...evidence, committed_marker_exact: false }), 'nonpassing_retained');
  assert.equal(classifyEvidence({ ...evidence, result: { ...evidence.result, worker_assessment: 'unknown' } }), 'nonpassing_retained');
  assert.equal(classifyEvidence({ ...evidence, result: { ...evidence.result, blockers: ['unmet'] } }), 'nonpassing_retained');
  assert.equal(classifyEvidence({ ...evidence, result: { ...evidence.result, questions: ['what now?'] } }), 'nonpassing_retained');
  for (const exit_code of [1, null]) assert.equal(classifyEvidence({ ...evidence,
    result: { ...evidence.result, checks: [{ ...evidence.result.checks[0], exit_code }, evidence.result.checks[1]] } }), 'nonpassing_retained');
  assert.equal(classifyEvidence({ ...evidence, result: { ...evidence.result, checks: [
    { command: 'python3 -c "print(1)"', exit_code: 0, evidence: 'runtime_observed' }, evidence.result.checks[1]] } }), 'nonpassing_retained');
  assert.equal(classifyEvidence({ ...evidence, result: { ...evidence.result, checks: [
    { ...evidence.result.checks[0], evidence: 'worker_reported' }, evidence.result.checks[1]] } }), 'nonpassing_retained');
});

test('tool decoder refuses errors and malformed envelopes', () => {
  assert.deepEqual(toolBody({ content: [{ type: 'text', text: '{"ok":true}' }] }), { ok: true });
  assert.throws(() => toolBody({ isError: true, content: [{ type: 'text', text: '{"token":"secret"}' }] }), /tool returned an error/);
  assert.throws(() => toolBody({ content: [] }), /Malformed/);
});

test('readiness identifies development frontend before service preparation and exact binding failures', () => {
  const manifest = { project: '/tmp/project', profilePath: '/tmp/profile.json', stateRoot: '/tmp/state' };
  const binding = { project_input: manifest.project, profile_path: manifest.profilePath, state_root: manifest.stateRoot };
  const before = { frontend: { mode: 'installed', build_id: 'build' }, binding, service: { state: 'not_checked' } };
  const ready = { ...before, service: { state: 'connected', status: {
    admission: 'open', repository: { coordination: { state: 'ready' } } } } };
  assert.deepEqual(readinessFailures(before, ready, manifest), []);
  assert.deepEqual(readinessFailures({ ...before, frontend: { mode: 'development', build_id: 'development-unidentified' } },
    ready, manifest), ['before.frontend.mode']);
  assert.deepEqual(readinessFailures(before, { ...ready, binding: { ...binding, profile_path: '/tmp/other.json' } },
    manifest), ['ready.binding.profile_path']);
});

test('needs-attention CLI result keeps exact identity and bounded nonsecret diagnostic', async () => {
  const manifest = { project: '/tmp/project', profilePath: '/tmp/profile.json', stateRoot: '/tmp/state' };
  const taskId = '99c9f330-6743-47ad-b8b8-c86442c56007';
  let invoked;
  const run = async (command, args, options) => {
    invoked = { command, args, options };
    return { stdout: JSON.stringify({ result: { task_id: taskId, schema_version: 4,
      execution_status: 'failed', worker_stop: 'unconfirmed', worker_assessment: 'unknown',
      error: { code: 'CODEX_NATIVE_REJECTED', message: 'secret auth bytes' },
      native_evidence: { run_id: 'run', state: 'unknown', coverage: 'unknown', limitation: 'secret auth bytes' },
      delivery: { status: 'incomplete' }, checks: [], blockers: ['secret auth bytes'], questions: [] },
    resource: { task_id: taskId, state: 'pending', private_git: { state: 'prepared' },
      branch_ref: 'refs/heads/muse-bridge/task' } }) };
  };
  const diagnostic = await needsAttentionDiagnostic('/tmp/installed/dist/src/cli.js', manifest, taskId, run);
  assert.equal(invoked.command, process.execPath);
  assert.deepEqual(invoked.args, ['/tmp/installed/dist/src/cli.js', 'result', '--project', manifest.project,
    '--profile', manifest.profilePath, '--state-root', manifest.stateRoot, '--task', taskId]);
  assert.equal(diagnostic.result.error_code, 'CODEX_NATIVE_REJECTED');
  assert.equal(diagnostic.result.worker_stop, 'unconfirmed');
  assert.equal(diagnostic.resource.state, 'pending');
  assert.equal(JSON.stringify(diagnostic).includes('secret auth bytes'), false);
  await assert.rejects(needsAttentionDiagnostic('/tmp/installed/dist/src/cli.js', manifest, taskId,
    async () => ({ stdout: JSON.stringify({ result: { task_id: 'wrong' }, resource: { task_id: taskId } }) })),
  /INSTALLED_RESULT_IDENTITY_MISMATCH/);
  await assert.rejects(needsAttentionDiagnostic('/tmp/installed/dist/src/cli.js', manifest, taskId,
    async () => { throw Error('secret auth bytes'); }), /INSTALLED_RESULT_UNAVAILABLE/);
});
