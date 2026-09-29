import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ELF, MODEL, PROVIDER, exactOneFileTree, fixedCommand, fixedOutputDiagnostic, finalSse, nativeCheckDiagnostic, nativePresentedFixedCommand, protectedProfileToml, providerSequenceResult, run } from '../../scripts/qualify-codex-protected-worker.mjs';

test('fixed provider command checks inaccessible host roots before one ordinary commit', () => {
  const command = fixedCommand('/tmp/task/workspace', '/tmp/fixture/protected/auth', '/tmp/fixture/sibling/canary');
  assert.ok(command.startsWith('test ! -e /tmp/fixture/protected/auth && test ! -e /tmp/task/workspace/protected-link && '));
  assert.match(command, /test ! -e \/proc\/self\/root\/tmp\/fixture\/protected\/auth/);
  assert.match(command, /test ! -e \/tmp\/fixture\/sibling\/canary && rm -- \/tmp\/task\/workspace\/protected-link/);
  assert.match(command, /git -C \/tmp\/task\/workspace add -- protected-change\.txt/);
  assert.match(command, /commit -m 'test: protected Codex native commit'/);
  assert.throws(() => fixedCommand('/tmp/unsafe path', '/tmp/protected', '/tmp/sibling'));
});

test('named profile grants only the task workspace and exact canonical private Git path', () => {
  const config = protectedProfileToml('/tmp/task/workspace', '/tmp/project/.git',
    '/tmp/project/.git/worktrees/task', 39173);
  assert.match(config, /default_permissions = "passeur-boundary"/);
  assert.match(config, /"\/tmp\/task\/workspace" = true\n"\/tmp\/project\/\.git" = true/);
  assert.match(config, /"\/tmp\/project\/\.git\/worktrees\/task" = "write"/);
  assert.match(config, /network\]\nenabled = false/);
  assert.equal(config.includes('sandbox_mode'), false);
  assert.throws(() => protectedProfileToml('/tmp/task/workspace', '/tmp/project/.git',
    '/tmp/other/worktrees/task', 39173));
});

test('fixed final response is one bounded SSE message carrying a valid worker report', () => {
  const events = finalSse().trim().split('\n\n').map(frame => JSON.parse(frame.split('\ndata: ')[1]));
  assert.deepEqual(events.map(event => event.type), ['response.created', 'response.output_item.done', 'response.completed']);
  const text = events[1].item.content[0].text;
  assert.ok(text.startsWith('PASSEUR_MESSAGE '));
  assert.equal(JSON.parse(text.slice('PASSEUR_MESSAGE '.length)).kind, 'final');
  assert.ok(Buffer.byteLength(finalSse()) < 4096);
});

test('qualification pins one installed executable, model and synthetic provider identity', () => {
  assert.ok(ELF.endsWith('/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex'));
  assert.equal(MODEL, 'gpt-5.3-codex');
  assert.equal(PROVIDER, 'passeur_fixture_loopback');
});

test('qualification accepts only the fixed commit and explicit cancellation modes', async () => {
  await assert.rejects(run('retry'), /unsupported qualification mode/);
});

test('provider sequence diagnostics preserve the primary native failure', () => {
  const native = { status: 'blocked', worker_stop: 'unconfirmed',
    error: { code: 'CODEX_CONFIGURATION_MISMATCH', message: 'Native config layer rejected' } };
  assert.strictEqual(providerSequenceResult(native, false, 'commit'), native);
  assert.equal(providerSequenceResult({ status: 'completed', worker_stop: 'confirmed' }, false, 'commit').error.code,
    'CODEX_PROVIDER_SEQUENCE_INVALID');
});

test('native output diagnostic retains only a bounded failure class and exit code', () => {
  const denial = fixedOutputDiagnostic({ status: 'accepted', text:
    'Process exited with code 128\nfatal: Unable to create index.lock: Permission denied\nprivate output' },
  'protected-secret', 'sibling-secret');
  assert.deepEqual(denial, { category: 'git_index_write_denied', exitCode: 128 });
  assert.equal(JSON.stringify(denial).includes('private output'), false);
  assert.deepEqual(fixedOutputDiagnostic({ status: 'accepted', text: 'protected-secret' },
    'protected-secret', 'sibling-secret'), { category: 'canary_exposed', exitCode: null });
  assert.deepEqual(fixedOutputDiagnostic({ status: 'call_output_mismatch' },
    'protected-secret', 'sibling-secret'), { category: 'call_output_mismatch', exitCode: null });
});

test('native check diagnostic identifies correlation failure without retaining command or cwd', () => {
  const native = { status: 'completed', checks: [{ command: 'secret fixture command', cwd: '/tmp/secret-root',
    exit_code: 0, evidence: 'runtime_observed' }] };
  const diagnostic = nativeCheckDiagnostic(native, 'expected command', '/tmp/workspace');
  assert.equal(diagnostic.nativeStatus, 'completed');
  assert.equal(diagnostic.count, 1);
  assert.equal(diagnostic.matches, false);
  assert.equal(diagnostic.checks[0].commandMatches, false);
  assert.equal(diagnostic.checks[0].cwdMatches, false);
  assert.equal(diagnostic.checks[0].exitCode, 0);
  assert.equal(JSON.stringify(diagnostic).includes('secret fixture command'), false);
  assert.equal(JSON.stringify(diagnostic).includes('/tmp/secret-root'), false);
});

test('fixed native command presentation matches installed shlex 1.3.0 and requires exact bytes', () => {
  const workspace = '/tmp/task/workspace';
  const expected = nativePresentedFixedCommand(fixedCommand(workspace,
    '/tmp/fixture/protected/auth', '/tmp/fixture/sibling/canary'));
  assert.ok(expected.startsWith('/usr/bin/bash -c '));
  assert.equal(createHash('sha256').update(expected).digest('hex'),
    'c5dc1b3939d1a570ff53d01119b42e23a685890c60c55372f624cf63c45330c3');
  const check = { cwd: workspace, exit_code: 0, evidence: 'runtime_observed' };
  assert.equal(nativeCheckDiagnostic({ status: 'completed', checks: [{ ...check, command: expected }] },
    expected, workspace).matches, true);
  const altered = expected.replace('protected-change.txt', 'protected-change.txX');
  assert.equal(Buffer.byteLength(altered), Buffer.byteLength(expected));
  assert.equal(nativeCheckDiagnostic({ status: 'completed', checks: [{ ...check, command: altered }] },
    expected, workspace).matches, false);
  assert.throws(() => nativePresentedFixedCommand('echo café'));
});

test('published tree oracle rejects an extra edit to the base file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'passeur-codex-tree-oracle-'));
  const git = (...args) => execFileSync('/usr/bin/git', args, { cwd: root, encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1',
      GIT_ATTR_NOSYSTEM: '1' } }).trim();
  try {
    git('init', '-q');
    git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    await writeFile(join(root, 'watched.txt'), 'before\n');
    git('add', '.'); git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    await writeFile(join(root, 'protected-change.txt'), 'exact protected Codex commit bytes\n');
    await writeFile(join(root, 'watched.txt'), 'extra change\n');
    git('add', '.'); git('commit', '-qm', 'extra');
    const head = git('rev-parse', 'HEAD');
    const oid = git('rev-parse', `${head}:protected-change.txt`);
    assert.equal(exactOneFileTree(git('diff-tree', '--no-commit-id', '--name-status', '-r', base, head),
      git('ls-tree', head, '--', 'protected-change.txt'), 'protected-change.txt', oid), false);
    assert.equal(exactOneFileTree('A\tprotected-change.txt',
      git('ls-tree', head, '--', 'protected-change.txt'), 'protected-change.txt', oid), true);
    assert.equal(exactOneFileTree('A\tprotected-change.txt',
      `100755 blob ${oid}\tprotected-change.txt`, 'protected-change.txt', oid), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
