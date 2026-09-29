import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ELF, MODEL, PROVIDER, ACCOUNT_CHECK_PATH, ACCOUNT_CHECK_RESPONSE, HOME_DENIAL_MARKERS, SEED_DENIAL_MARKERS, containsSeedValue, retainedArtifactsClean, seededAbortAccepted, lateExposureRefusalStatus, qualificationExitCode, createHomeCanaryAfterFirstPost, exactOneFileTree, fixedCommand, fixedOutputDiagnostic, finalSse, homeProbeOutputValid, nativeCheckDiagnostic, nativePreflightStage, nativePresentedFixedCommand, protectedProfileToml, provider, providerToolDiagnostic, providerSequenceComplete, providerSequenceResult, run } from '../../scripts/qualify-codex-protected-worker.mjs';

test('seeded provider accepts one synthetic account check before model traffic', async () => {
  const root = await mkdtemp(join(tmpdir(), 'passeur-codex-account-check-'));
  const socket = join(root, 'provider.sock');
  const state = { accountChecks: 0, requests: 0, failure: null };
  const fixture = provider(socket, '/tmp/task/workspace', '/tmp/protected', '/tmp/sibling', state, 'seeded-cancel');
  const get = (path, headers = {}) => new Promise((resolve, reject) => {
    const request = httpRequest({ socketPath: socket, method: 'GET', path,
      headers: { 'x-passeur-native-auth-present': '1', ...headers } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject); request.end();
  });
  try {
    await fixture.listen();
    assert.deepEqual(await get(ACCOUNT_CHECK_PATH), { status: 200, body: JSON.stringify(ACCOUNT_CHECK_RESPONSE) });
    assert.equal(state.accountChecks, 1);
    assert.equal(state.requests, 0);
    assert.equal((await get(ACCOUNT_CHECK_PATH)).status, 400);
    assert.equal(state.failure, 'account_check_invalid');
  } finally { await fixture.close(); await rm(root, { recursive: true, force: true }); }
});

test('fixed provider command checks inaccessible host roots before one ordinary commit', () => {
  const command = fixedCommand('/tmp/task/workspace', '/tmp/fixture/protected/auth', '/tmp/fixture/sibling/canary');
  assert.ok(command.startsWith('test ! -e /tmp/fixture/protected/auth && test ! -e /tmp/task/workspace/protected-link && '));
  assert.match(command, /test ! -e \/proc\/self\/root\/tmp\/fixture\/protected\/auth/);
  assert.match(command, /test ! -e \/tmp\/fixture\/sibling\/canary && rm -- \/tmp\/task\/workspace\/protected-link/);
  assert.match(command, /git -C \/tmp\/task\/workspace add -- protected-change\.txt/);
  assert.match(command, /commit -m 'test: protected Codex native commit'/);
  assert.throws(() => fixedCommand('/tmp/unsafe path', '/tmp/protected', '/tmp/sibling'));
});

test('home canary command requires workspace control and three read failures before commit', () => {
  const command = fixedCommand('/tmp/task/workspace', '/tmp/fixture/protected/auth',
    '/tmp/fixture/sibling/canary', '/mounts/home/credential-canary');
  assert.match(command, /cat \/tmp\/task\/workspace\/watched\.txt >\/dev\/null/);
  assert.match(command, /! cat \/mounts\/home\/credential-canary >\/dev\/null 2>&1/);
  assert.match(command, /! cat \/tmp\/task\/workspace\/home-link >\/dev\/null 2>&1/);
  assert.match(command, /! cat \/proc\/self\/root\/mounts\/home\/credential-canary >\/dev\/null 2>&1/);
  assert.ok(command.indexOf('HOME_PROC_DENIED') < command.indexOf('git -C /tmp/task/workspace add'));
  assert.throws(() => fixedCommand('/tmp/task/workspace', '/tmp/protected', '/tmp/sibling', '/home/bad path'));
});

test('dummy home value is created only after first accepted provider request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'passeur-codex-home-canary-test-'));
  try {
    const state = { requests: 0, first: false, homeCanaryReady: false,
      homeCanary: 'a'.repeat(48), homeCanaryHostPath: join(root, 'credential-canary') };
    assert.throws(() => createHomeCanaryAfterFirstPost(state));
    await assert.rejects(readFile(state.homeCanaryHostPath));
    state.requests = 1; state.first = true;
    createHomeCanaryAfterFirstPost(state);
    assert.equal(await readFile(state.homeCanaryHostPath, 'utf8'), state.homeCanary);
    assert.equal((await stat(state.homeCanaryHostPath)).mode % 0o1000, 0o600);
    assert.throws(() => createHomeCanaryAfterFirstPost(state));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('home denial marker projection rejects missing, altered and duplicate output envelopes', () => {
  const body = `Chunk ID: a1\nProcess exited with code 0\nOutput:\n${HOME_DENIAL_MARKERS.join('\n')}\ncommit output`;
  assert.equal(homeProbeOutputValid(body), true);
  assert.equal(homeProbeOutputValid(body.replace(HOME_DENIAL_MARKERS[1], 'HOME_SYMLINK_VISIBLE')), false);
  assert.equal(homeProbeOutputValid(body.replace(`${HOME_DENIAL_MARKERS[2]}\n`, '')), false);
  assert.equal(homeProbeOutputValid(`${body}\nOutput:\n${HOME_DENIAL_MARKERS.join('\n')}`), false);
  assert.equal(homeProbeOutputValid(`${body}\n${HOME_DENIAL_MARKERS[0]}`), false);
  assert.equal(homeProbeOutputValid(null), false);
});

test('startup seed probe requires direct, symlink, proc, parent proc and inherited FD denials', () => {
  const command = fixedCommand('/tmp/task/workspace', '/tmp/fixture/protected/auth',
    '/tmp/fixture/sibling/canary', '/mounts/home/auth.json', true);
  assert.match(command, /HOME_PARENT_PROC_DENIED/);
  assert.match(command, /HOME_FD_DENIED/);
  assert.match(command, /\/usr\/bin\/head -c 65536/);
  const body = `Chunk ID: a1\nProcess exited with code 0\nOutput:\n${SEED_DENIAL_MARKERS.join('\n')}\ncommit output`;
  assert.equal(homeProbeOutputValid(body, true), true);
  assert.equal(homeProbeOutputValid(body.replace(SEED_DENIAL_MARKERS[3], 'HOME_PARENT_PROC_VISIBLE'), true), false);
  assert.equal(homeProbeOutputValid(body.replace(SEED_DENIAL_MARKERS[4], 'HOME_FD_VISIBLE'), true), false);
});

test('JWT and refresh secret both block native/provider acceptance and retained artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'passeur-codex-secret-scan-'));
  const source = join(root, 'seed-auth.json'), retained = join(root, 'retained.json');
  const secrets = ['jwt.synthetic', 'synthetic-refresh'];
  try {
    await writeFile(source, secrets.join('\n'));
    assert.equal(containsSeedValue({ checks: [{ command: secrets[0] }] }, secrets), true);
    assert.equal(containsSeedValue({ summary: secrets[1] }, secrets), true);
    assert.equal(containsSeedValue({ summary: 'safe' }, secrets), false);
    assert.equal(await retainedArtifactsClean(root, source, secrets), true);
    await writeFile(retained, secrets[1]);
    assert.equal(await retainedArtifactsClean(root, source, secrets), false);
    await writeFile(retained, secrets[0]);
    assert.equal(await retainedArtifactsClean(root, source, secrets), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('seeded cancellation and startup failure require finite provider sequences', () => {
  const state = { first: true, requests: 1, accountChecks: 1, failure: null };
  assert.equal(providerSequenceComplete(state, 'seeded-cancel', false, false), true);
  assert.equal(providerSequenceComplete({ ...state, requests: 2 }, 'seeded-cancel', false, false), false);
  assert.equal(providerSequenceComplete({ ...state, first: false, requests: 0, accountChecks: 0 }, 'seeded-startup-failure', false, false), true);
  assert.equal(providerSequenceComplete({ ...state, first: false, requests: 0 }, 'seeded-startup-failure', false, false), true);
  assert.equal(providerSequenceComplete({ ...state, first: false, requests: 0, accountChecks: 2 }, 'seeded-startup-failure', false, false), false);
  assert.equal(providerSequenceComplete(state, 'seeded-startup-failure', false, false), false);
  assert.equal(providerSequenceComplete({ ...state, accountChecks: 0 }, 'seeded-cancel', false, false), false);
  assert.equal(providerSequenceResult({ status: 'completed' }, true, 'seeded-cancel').status, 'failed');
  const report = { privateAfter: 'base', canonicalAfter: 'base', mainAfter: 'base',
    hostCanariesIntact: true, nativeOutputClean: true, deliveryStatus: 'none',
    providerRequests: 1, accountChecks: 1, cancelAfterProviderRequest: true,
    explicitCancel: { accepted: true }, providerFailure: null, providerSequenceComplete: true };
  const resource = { private_git: { state: 'prepared' } };
  const cancelled = { execution_status: 'cancelled', worker_stop: 'confirmed' };
  assert.equal(seededAbortAccepted('seeded-cancel', cancelled, resource, report, 'base', true), true);
  assert.equal(seededAbortAccepted('seeded-cancel', { ...cancelled, worker_stop: 'unconfirmed' }, resource, report, 'base', true), false);
  assert.equal(seededAbortAccepted('seeded-cancel', cancelled, resource, { ...report, deliveryStatus: 'committed' }, 'base', true), false);
  assert.equal(seededAbortAccepted('seeded-cancel', cancelled, resource, report, 'base', false), false);
  const failed = { execution_status: 'failed', worker_stop: 'confirmed' };
  assert.equal(seededAbortAccepted('seeded-startup-failure', failed, resource,
    { ...report, providerRequests: 0, accountChecks: 0 }, 'base', true), true);
  assert.equal(seededAbortAccepted('seeded-startup-failure', failed, resource,
    { ...report, providerRequests: 0 }, 'base', true), true);
  assert.equal(seededAbortAccepted('seeded-startup-failure', failed, resource,
    { ...report, providerRequests: 0, providerFailure: 'account_check_invalid', providerSequenceComplete: false },
  'base', true), false);
  assert.equal(seededAbortAccepted('seeded-startup-failure', failed, resource,
    { ...report, providerRequests: 0, providerFailure: 'unexpected_provider_request', providerSequenceComplete: false },
  'base', true), false);
  assert.equal(seededAbortAccepted('seeded-startup-failure', failed, resource, report, 'base', true), false);
});

test('late exposure refusal distinguishes unconfirmed stop and rejects publication or contamination', () => {
  const base = 'base', taskId = 'task';
  const result = { execution_status: 'failed', worker_stop: 'unconfirmed',
    error: { code: 'CODEX_PROTECTED_SECRET_EXPOSED' } };
  const resource = { private_git: { state: 'prepared' } };
  const report = { taskId, branchRef: `refs/heads/muse-bridge/${taskId}`,
    privateResourceBefore: 'prepared', privateBefore: base, canonicalBefore: base,
    privateAfter: 'private-commit', canonicalAfter: base, mainAfter: base,
    providerRequests: 2, accountChecks: 1, providerFailure: null,
    providerOutputDiagnostic: { category: 'exit_zero' }, providerOutput: { sha256: 'digest', bytes: 1 },
    homeProbeMarkersValid: true, homeCanaryIntact: true, hostCanariesIntact: true,
    nativeOutputClean: true, retainedArtifactsClean: true, deliveryStatus: 'incomplete' };
  assert.equal(lateExposureRefusalStatus(result, resource, report, base, true),
    'observed_synthetic_late_exposure_refusal_unconfirmed_stop');
  assert.equal(lateExposureRefusalStatus({ ...result, worker_stop: 'confirmed' }, resource, report, base, true),
    'accepted_synthetic_late_exposure_refusal_confirmed_stop');
  for (const invalid of [{ deliveryStatus: 'committed' }, { canonicalAfter: 'published' },
    { providerFailure: 'unexpected_provider_request' }, { nativeOutputClean: false },
    { retainedArtifactsClean: false }, { accountChecks: 0 }, { providerRequests: 1 },
    { homeCanaryIntact: false }, { hostCanariesIntact: false }]) {
    assert.equal(lateExposureRefusalStatus(result, resource, { ...report, ...invalid }, base, true), 'incomplete');
  }
  assert.equal(lateExposureRefusalStatus(result, resource, report, base, false), 'incomplete');
  assert.equal(lateExposureRefusalStatus({ ...result, error: { code: 'OTHER' } }, resource, report, base, true), 'incomplete');
});

test('CLI passes only confirmed late exposure refusal', () => {
  assert.equal(qualificationExitCode('accepted_synthetic_late_exposure_refusal_confirmed_stop'), 0);
  assert.equal(qualificationExitCode('observed_synthetic_late_exposure_refusal_unconfirmed_stop'), 1);
  assert.equal(qualificationExitCode('accepted_synthetic_late_exposure_refusal'), 1);
});

for (const [mode, expected] of [
  ['seeded-cancel', 'accepted_synthetic_seeded_cancellation'],
  ['seeded-startup-failure', 'accepted_synthetic_seeded_startup_failure'],
  ['seeded-late-exposure', 'observed_synthetic_late_exposure_refusal_unconfirmed_stop'],
]) test(`installed controlled Coordinator ${mode} lifecycle`,
  { skip: process.env.PASSEUR_CODEX_INSTALLED_SEEDED_GATE !== '1' }, async () => {
    const report = await run(mode);
    if (mode === 'seeded-late-exposure') {
      assert.equal(report.status, report.workerStop === 'confirmed' ?
        'accepted_synthetic_late_exposure_refusal_confirmed_stop' : expected);
      assert.ok(['confirmed', 'unconfirmed'].includes(report.workerStop));
    } else {
      assert.equal(report.status, expected);
      assert.equal(report.workerStop, 'confirmed');
    }
    assert.notEqual(report.deliveryStatus, 'committed');
    assert.equal(report.retainedArtifactsClean, true);
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

test('seeded profile requires native account auth while anonymous profile stays anonymous', () => {
  const args = ['/tmp/task/workspace', '/tmp/project/.git', '/tmp/project/.git/worktrees/task', 39173];
  assert.match(protectedProfileToml(...args), /requires_openai_auth = false/);
  assert.equal(protectedProfileToml(...args).includes('chatgpt_base_url'), false);
  const seeded = protectedProfileToml(...args, true);
  assert.match(seeded, /^chatgpt_base_url = "http:\/\/127\.0\.0\.1:39173"\n/);
  assert.match(seeded, /requires_openai_auth = true/);
  assert.equal(ACCOUNT_CHECK_PATH, '/api/codex/accounts/check');
  assert.deepEqual(ACCOUNT_CHECK_RESPONSE, { accounts: [{ id: 'synthetic-account',
    workspace_backend_origin: 'https://fixture.invalid', account_routing_override: 'NO_CONSTRAINT' }] });
});

test('provider tool diagnosis retains only finite schema facts', () => {
  const diagnostic = providerToolDiagnostic({ model: MODEL,
    tools: [{ name: 'exec_command' }, { name: 'secret-injected-tool' }] });
  assert.deepEqual(diagnostic, { schema: 'inventory_mismatch', modelMatches: true,
    toolCount: 2, recognizedPresent: ['exec_command'], extraCandidate: 'unknown', extraType: 'unknown' });
  assert.equal(JSON.stringify(diagnostic).includes('secret-injected-tool'), false);
  assert.equal(providerToolDiagnostic({ model: MODEL,
    tools: [{ name: 'apply_patch', type: 'custom' }] }).extraCandidate, 'apply_patch');
  const imageGen = providerToolDiagnostic({ model: MODEL, tools: [{ name: 'image_gen', type: 'namespace' }] });
  assert.equal(imageGen.extraCandidate, 'image_gen');
  assert.equal(imageGen.extraType, 'namespace');
});

test('native preflight stage projection is finite and value-free', () => {
  assert.equal(nativePreflightStage({ error: { code: 'CODEX_NATIVE_REJECTED',
    message: 'Native operation rejected during thread/start' } }), 'thread/start');
  assert.equal(nativePreflightStage({ error: { code: 'CODEX_NATIVE_REJECTED',
    message: 'Native operation rejected during credential-value' } }), 'unknown');
  assert.equal(nativePreflightStage({ error: { code: 'OTHER', message: 'secret' } }), null);
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

test('qualification accepts only fixed commit, cancellation and home-canary modes', async () => {
  await assert.rejects(run('retry'), /unsupported qualification mode/);
});

test('provider sequence diagnostics preserve the primary native failure', () => {
  const native = { status: 'blocked', worker_stop: 'unconfirmed',
    error: { code: 'CODEX_CONFIGURATION_MISMATCH', message: 'Native config layer rejected' } };
  assert.strictEqual(providerSequenceResult(native, false, 'commit'), native);
  assert.equal(providerSequenceResult({ status: 'completed', worker_stop: 'confirmed' }, false, 'commit').error.code,
    'CODEX_PROVIDER_SEQUENCE_INVALID');
});

test('home canary failure prevents Coordinator publication before the wrapper returns', () => {
  const state = { first: true, second: true, failure: null, requests: 2, accountChecks: 0, homeProbeMarkersValid: true };
  assert.equal(providerSequenceComplete(state, 'home-canary', true, true), true);
  assert.equal(providerSequenceComplete(state, 'home-canary', true, false), false);
  assert.equal(providerSequenceComplete({ ...state, homeProbeMarkersValid: false }, 'home-canary', true, true), false);
  assert.equal(providerSequenceComplete(state, 'home-canary', false, true), false);
  const refused = providerSequenceResult({ status: 'completed', worker_stop: 'confirmed' }, false, 'home-canary');
  assert.equal(refused.status, 'failed');
  assert.equal(refused.error.code, 'CODEX_PROVIDER_SEQUENCE_INVALID');
});

test('native output diagnostic retains only a bounded failure class and exit code', () => {
  const denial = fixedOutputDiagnostic({ status: 'accepted', text:
    'Process exited with code 128\nfatal: Unable to create index.lock: Permission denied\nprivate output' },
  'protected-secret', 'sibling-secret');
  assert.deepEqual(denial, { category: 'git_index_write_denied', exitCode: 128 });
  assert.equal(JSON.stringify(denial).includes('private output'), false);
  assert.deepEqual(fixedOutputDiagnostic({ status: 'accepted', text: 'protected-secret' },
    'protected-secret', 'sibling-secret'), { category: 'canary_exposed', exitCode: null });
  assert.deepEqual(fixedOutputDiagnostic({ status: 'accepted', text: 'Process exited with code 0\nhome-secret' },
    'protected-secret', 'sibling-secret', 'home-secret'), { category: 'canary_exposed', exitCode: null });
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
