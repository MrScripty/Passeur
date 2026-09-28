import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { fixture, git } from './helpers.mjs';
import { AgentRegistry } from '../../.passeur-core/src/agents/registry.js';
import { Coordinator } from '../../.passeur-core/src/core/coordinator.js';
import { TaskStore } from '../../.passeur-core/src/store/task-store.js';
import { prepareWorkspace, preparePrivateGitView } from '../../.passeur-core/src/workspace/worktree.js';
import { protectedApprovalRequest, protectedMuseWorker, verifySettledStop } from '../../scripts/qualify-muse-protected-worker.mjs';
import { runStatusPhase, shellProbeCommand } from '../../scripts/qualify-muse-sandbox-transport.mjs';
import { relaySandboxConfig } from '../../scripts/qualify-muse-credential-relay.mjs';
import { prepareSandbox } from '../../scripts/experiment-worker-sandbox.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(read) {
  const end = Date.now() + 3_000;
  while (Date.now() < end) { const value = await read(); if (value) return value; await delay(5); }
  throw Error('controlled protected task observation absent');
}

test('native pending approval projection carries exact raw arguments and recorded IDs', () => {
  const checkpoint = { sessionId: 'session-1', turnId: 'turn-1' };
  const handoff = { kind: 'native_shell_live_approval', command: 'true',
    nativeRawArgs: JSON.stringify({ command: 'true', description: 'Disposable native shell qualification' }),
    approval: { sessionId: 'session-1', turnId: 'turn-1', approvalId: 'approval-1',
      toolCallId: 'call-1', toolName: 'bash', requirementId: { approvalId: 'approval-1', sourceIndex: 0 },
      choices: [{ choiceId: 'once', label: 'Allow once', decision: 'approved', scope: 'once' },
        { choiceId: 'deny', label: 'Deny', decision: 'denied', scope: 'once' }] } };
  const request = protectedApprovalRequest(handoff, checkpoint, '/tmp/task');
  assert.equal(request.raw_args, handoff.nativeRawArgs);
  assert.equal(request.id, 'approval-1:0');
  assert.deepEqual(request.subject.requirement_id, handoff.approval.requirementId);
  assert.deepEqual(request.choices.map(choice => choice.id), ['once', 'deny']);
  assert.throws(() => protectedApprovalRequest({ ...handoff, nativeRawArgs: '{"command":"other"}' },
    checkpoint, '/tmp/task'), { code: 'NATIVE_TASK_APPROVAL_INVALID' });
  assert.throws(() => protectedApprovalRequest(handoff, { ...checkpoint, turnId: 'foreign' },
    '/tmp/task'), { code: 'NATIVE_TASK_APPROVAL_INVALID' });
  const nativeAbort = { ...handoff, approval: { ...handoff.approval, choices: [
    { choiceId: 'abort', label: 'Reject', decision: 'abort', scope: 'once' },
    { choiceId: 'always', label: 'Allow always', decision: 'approved', scope: 'always' }] } };
  assert.deepEqual(protectedApprovalRequest(nativeAbort, checkpoint, '/tmp/task').choices,
    [{ id: 'abort', label: 'Reject', decision: 'denied', scope: 'once' }]);
  assert.throws(() => protectedApprovalRequest({ ...nativeAbort,
    approval: { ...nativeAbort.approval, choices: [nativeAbort.approval.choices[1]] } },
  checkpoint, '/tmp/task'), { code: 'NATIVE_TASK_APPROVAL_UNSUPPORTED' });
});

test('stop verification retains the first survivor and rejects a late apparent success', async () => {
  let checks = 0;
  await assert.rejects(verifySettledStop(async () => {
    if (++checks === 1) throw Object.assign(Error('observed PID 123 remains present'),
      { code: 'STOP_SURVIVOR' });
    const end = performance.now() + 2_100;
    while (performance.now() < end) { /* simulate an event-loop delay in verification */ }
    return { kind: 'confirmed' };
  }, {}, {}, {}), error => {
    assert.equal(error.code, 'NATIVE_TASK_STOP_UNCONFIRMED');
    assert.deepEqual(error.stopObservation, { firstSurvivor: {
      code: 'STOP_SURVIVOR', message: 'observed PID 123 remains present' }, attempts: 2 });
    return true;
  });
});

test('protected relay config presents Coordinator private Git at the canonical common path', async t => {
  const f = await fixture(t);
  const task = randomUUID();
  const workspace = await prepareWorkspace(f.root, f.implementation('mount-binding'), f.policy,
    'project', task);
  const controlRoot = join(f.temp, 'task-control');
  await mkdir(controlRoot);
  const view = await preparePrivateGitView(f.root, workspace, join(controlRoot, 'private-git'));
  const runtime = join(f.temp, 'runtime'), home = join(f.temp, 'home');
  const protectedRoot = join(f.temp, 'protected'), socketDirectory = join(f.temp, 'socket');
  await Promise.all([runtime, home, protectedRoot, socketDirectory].map(path => mkdir(path)));
  const config = relaySandboxConfig({ workspace: workspace.path, runtime, home, protectedRoot,
    socketDirectory, privateGit: { controlRoot, view } });
  const prepared = prepareSandbox(config, ['/mounts/runtime/node', '--guest-native']);
  const mount = prepared.args.findIndex((part, index) => part === '--bind' &&
    prepared.args[index + 1] === view.private_common_dir);
  assert.ok(mount >= 0);
  assert.equal(prepared.args[mount + 2], view.canonical_common_dir);
  assert.equal(prepared.privateGit.target, view.canonical_common_dir);
  assert.equal(prepared.writable.includes(view.private_common_dir), true);
  assert.equal((await git(f.root, 'rev-parse', workspace.branch)).trim(), f.base);
});

test('Coordinator task retains one native pending permission through observer loss and cancels exact worker', async t => {
  const f = await fixture(t);
  let releaseFinish, stopped = false, callbackCount = 0, stopChecks = 0, retainedRoots;
  const finished = new Promise(resolve => { releaseFinish = resolve; });
  const never = new Promise(() => undefined);
  const checkpoint = { schemaVersion: 1, checkpointId: 'checkpoint-1', sessionId: 'native-session',
    turnId: 'native-turn', status: 'accepted', disposition: 'started', startedNewTurn: true };
  const handoff = { kind: 'native_shell_live_approval', command: 'true',
    nativeRawArgs: JSON.stringify({ command: 'true', description: 'Disposable native shell qualification' }),
    approval: { sessionId: checkpoint.sessionId, turnId: checkpoint.turnId, approvalId: 'native-approval',
      toolCallId: 'native-call', toolName: 'bash', requirementId: { approvalId: 'native-approval', sourceIndex: 0 },
      choices: [{ choiceId: 'allow_once', label: 'Allow once', decision: 'approved', scope: 'once' },
        { choiceId: 'deny', label: 'Deny', decision: 'denied', scope: 'once' }] } };
  const host = { pid: 123, ready: null, outcome: never,
    liveStatus: Promise.resolve({ child: 456, exit: null }),
  turnAccepted: Promise.resolve(checkpoint),
  handoff: Promise.resolve(handoff),
  releaseTurn() {}, async recordAndAckTurn(recorder) { callbackCount++; await recorder(checkpoint); },
  cancelTask() { if (!stopped) { stopped = true; releaseFinish({ code: 143, signal: 'SIGTERM',
    statusLines: ['{"child-pid":456}', '{"exit-code":143}'] }); } }, finished };
  const worker = protectedMuseWorker({ stage: async root => root, sentinelStart: async () =>
    ({ port: 8001, close: async () => {} }), upstreamStart: async () =>
      ({ origin: 'http://127.0.0.1:8002/', provider: { requests: [
        { method: 'GET', path: '/muse-code/models' }], rejection: never },
      close: async () => {} }), brokerStart: async () =>
      ({ failure: never, close: async () => {} }), prepare: () => ({ executable: 'controlled', args: [] }),
    probe: () => {}, launch: (_, config) => { host.ready = Promise.resolve({
      nativeIdentity: { start: '123', pid: 42 }, nativeNamespace: 'net:[1]',
      commandSha256: createHash('sha256').update(shellProbeCommand(config.workspace,
        config.protectedRoot, config.canaryToken)).digest('hex') });
      host.handoff = Promise.resolve({ ...handoff, command: shellProbeCommand(config.workspace,
        config.protectedRoot, config.canaryToken), nativeRawArgs: JSON.stringify({ command:
          shellProbeCommand(config.workspace, config.protectedRoot, config.canaryToken),
          description: 'Disposable native shell qualification' }) });
      return host; }, validateReady: () => {},
    capture: async () => ({ native: { nspid: [42], netns: 'net:[1]' },
      fd: { close: async () => {} } }), verifyStop: async (_, __, ___, options) => {
      assert.equal(options.allowTaskStop, true);
      if (++stopChecks === 1) throw Object.assign(Error('transient observed PID 123'),
        { code: 'STOP_SURVIVOR' });
      return { kind: 'confirmed' };
    },
    onPending: async ({ root, runtimeRoot }) => { retainedRoots = [root, runtimeRoot];
      await never; } });
  const registry = new AgentRegistry(f.profile, { muse: { configure: () => ({ worker,
    modes: ['implement'], contract: 'protected-fixture/1', configuration: {} }) } });
  const coordinator = new Coordinator(f.root, 'project', f.policy, f.store, registry,
    () => {}, undefined, 'controlled');
  const receipt = await coordinator.submit({ schema_version: 1, source_view: f.root,
    assignment: f.implementation(`protected-${randomUUID()}`) }, f.owner, new AbortController().signal);
  const state = await eventually(async () => { const current = await f.store.readControl(receipt.task_id);
    return current.inputs[0]?.state === 'pending' ? current : null; });
  await eventually(() => retainedRoots);
  assert.equal(callbackCount, 1);
  assert.equal(state.native.turn_id, checkpoint.turnId);
  assert.equal(state.native.native_session_id, checkpoint.sessionId);
  assert.equal(state.inputs[0].native_id, 'native-approval:0');
  const claim = await coordinator.inputs.claim(receipt.task_id, state.inputs[0].input_id,
    f.owner, state.control_generation);
  await coordinator.inputs.dismiss(receipt.task_id, claim.input_id, f.owner, claim.claim.id);
  await assert.rejects(coordinator.inputs.answer(receipt.task_id, claim.input_id, f.owner,
    state.control_generation, claim.claim.id, `stale-${randomUUID()}`, 'allow_once'),
  { code: 'STALE_INPUT' });
  const observer = new AbortController();
  const current = await coordinator.controls.read(receipt.task_id, f.owner);
  const waiting = coordinator.controls.wait(receipt.task_id, f.owner, current.revision,
    60_000, observer.signal);
  waiting.catch(() => undefined);
  observer.abort(Error('presentation observer ended'));
  await assert.rejects(waiting, /presentation observer ended/);
  const originalNow = Date.now;
  try { Date.now = () => originalNow() + 24 * 60 * 60 * 1000;
    assert.equal((await f.store.readControl(receipt.task_id)).inputs[0].state, 'pending'); }
  finally { Date.now = originalNow; }
  await delay(60);
  assert.equal((await f.store.readControl(receipt.task_id)).inputs[0].state, 'pending');
  assert.equal(stopped, false);
  const cancelled = await coordinator.cancel(receipt.task_id, f.owner, state.control_generation,
    `cancel-${randomUUID()}`, 'Explicit controlled native stop');
  assert.equal(cancelled.outcome, 'accepted');
  const result = await eventually(() => f.store.readResult(receipt.task_id));
  assert.equal(result.execution_status, 'cancelled');
  assert.equal(result.worker_stop, 'confirmed');
  assert.equal(stopped, true);
  assert.equal(stopChecks, 2);
  assert.match(result.summary, /first stop check: STOP_SURVIVOR: transient observed PID 123; checks: 2/);
  const resource = await f.store.readResource(receipt.task_id);
  assert.equal(resource.private_git.state, 'prepared');
  assert.equal((await git(f.root, 'rev-parse', resource.branch_ref)).trim(), f.base);
  assert.equal(await readFile(join(resource.worktree_path, 'protected-link')).then(() => 'file', () => 'not_file'), 'not_file');
  await coordinator.shutdown();
  for (const path of retainedRoots) await rm(path, { recursive: true, force: true });
});

test('native host death and a failed observer withdraw the pending callback without permission delivery', async t => {
  const f = await fixture(t);
  const workspace = await prepareWorkspace(f.root, f.implementation('native-death'), f.policy,
    'project', randomUUID());
  const controlRoot = join(f.temp, 'task-control-death');
  await mkdir(controlRoot);
  const view = await preparePrivateGitView(f.root, workspace, join(controlRoot, 'private-git'));
  const never = new Promise(() => undefined);
  let finishHost, roots, pendingRequest, withdrawn = false, recorded = 0;
  const finished = new Promise(resolve => { finishHost = resolve; });
  const checkpoint = { sessionId: 'native-session', turnId: 'native-turn', checkpointId: 'check',
    status: 'accepted', disposition: 'started', startedNewTurn: true };
  const host = { pid: 123, ready: null, outcome: never,
    liveStatus: Promise.resolve({ child: 456, exit: null }),
    finished, turnAccepted: Promise.resolve(checkpoint), handoff: null,
    releaseTurn() {}, async recordAndAckTurn(recorder) { recorded++; await recorder(checkpoint); },
    cancelTask() { finishHost({ code: null, signal: 'SIGTERM',
      statusLines: ['{"child-pid":456}'] }); } };
  const worker = protectedMuseWorker({ stage: async root => root, sentinelStart: async () =>
    ({ port: 8001, close: async () => {} }), upstreamStart: async () =>
      ({ origin: 'http://127.0.0.1:8002/', provider: { requests: [
        { method: 'GET', path: '/muse-code/models' }], rejection: never }, close: async () => {} }),
    brokerStart: async () => ({ failure: never, close: async () => {} }),
    prepare: () => ({ executable: 'controlled', args: [] }), probe: () => {},
    launch: (_, config) => {
      const command = shellProbeCommand(config.workspace, config.protectedRoot, config.canaryToken);
      host.ready = Promise.resolve({ nativeIdentity: { start: '123', pid: 42 },
        nativeNamespace: 'net:[1]', commandSha256: createHash('sha256').update(command).digest('hex') });
      host.handoff = Promise.resolve({ kind: 'native_shell_live_approval', command,
        nativeRawArgs: JSON.stringify({ command, description: 'Disposable native shell qualification' }),
        approval: { sessionId: checkpoint.sessionId, turnId: checkpoint.turnId,
          approvalId: 'approval', toolCallId: 'call', toolName: 'bash',
          requirementId: { approvalId: 'approval', sourceIndex: 0 },
          choices: [{ choiceId: 'allow_once', label: 'Allow once', decision: 'approved', scope: 'once' }] } });
      return host;
    }, validateReady: () => {}, capture: async () => ({ native: { nspid: [42], netns: 'net:[1]' },
      fd: { close: async () => {} } }), verifyStop: async () => ({ kind: 'confirmed' }),
    onPending: ({ root, runtimeRoot }) => { roots = [root, runtimeRoot];
      throw Error('observer disconnected'); } });
  const controller = new AbortController();
  const run = worker.run({ task_id: 'controlled-task', workspace: workspace.path,
    private_git: { schema_version: 1, mount_kind: 'canonical_common_dir', view },
    signal: controller.signal, onEvent: async event => { if (event.kind === 'turn_started') recorded++; },
    approve: async (request, signal) => { pendingRequest = request;
      return new Promise((_, reject) => signal.addEventListener('abort', () => {
        withdrawn = true; reject(Error('native callback withdrawn')); }, { once: true })); } });
  await eventually(() => pendingRequest);
  await eventually(() => roots);
  assert.equal(recorded, 2);
  finishHost({ code: 1, signal: null, statusLines: ['{"child-pid":456}', '{"exit-code":1}'] });
  const result = await run;
  assert.equal(result.status, 'failed');
  assert.equal(result.worker_stop, 'confirmed');
  assert.equal(result.error.code, 'NATIVE_TASK_HOST_EXIT');
  assert.equal(withdrawn, true);
  assert.equal((await git(f.root, 'rev-parse', workspace.branch)).trim(), f.base);
  for (const path of roots) await rm(path, { recursive: true, force: true });
});

test('task cancellation with a surviving namespace never claims confirmed stop', async t => {
  const f = await fixture(t);
  const workspace = await prepareWorkspace(f.root, f.implementation('surviving-native'), f.policy,
    'project', randomUUID());
  const controlRoot = join(f.temp, 'task-control-survivor');
  await mkdir(controlRoot);
  const view = await preparePrivateGitView(f.root, workspace, join(controlRoot, 'private-git'));
  const never = new Promise(() => undefined);
  let finishHost, roots, pending = false;
  const finished = new Promise(resolve => { finishHost = resolve; });
  const checkpoint = { sessionId: 'native-session', turnId: 'native-turn' };
  const host = { pid: 123, ready: null, outcome: never,
    liveStatus: Promise.resolve({ child: 456, exit: null }),
    finished, turnAccepted: Promise.resolve(checkpoint), handoff: null,
    releaseTurn() {}, async recordAndAckTurn(recorder) { await recorder(checkpoint); },
    cancelTask() { finishHost({ code: null, signal: 'SIGTERM', statusLines: ['{"child-pid":456}'] }); } };
  const worker = protectedMuseWorker({ stage: async root => root, sentinelStart: async () =>
    ({ port: 8001, close: async () => {} }), upstreamStart: async () =>
      ({ origin: 'http://127.0.0.1:8002/', provider: { requests: [
        { method: 'GET', path: '/muse-code/models' }], rejection: never }, close: async () => {} }),
    brokerStart: async () => ({ failure: never, close: async () => {} }),
    prepare: () => ({ executable: 'controlled', args: [] }), probe: () => {},
    launch: (_, config) => { const command = shellProbeCommand(config.workspace,
      config.protectedRoot, config.canaryToken);
      host.ready = Promise.resolve({ nativeIdentity: { start: '123', pid: 42 },
        nativeNamespace: 'net:[1]', commandSha256: createHash('sha256').update(command).digest('hex') });
      host.handoff = Promise.resolve({ kind: 'native_shell_live_approval', command,
        nativeRawArgs: JSON.stringify({ command, description: 'Disposable native shell qualification' }),
        approval: { sessionId: checkpoint.sessionId, turnId: checkpoint.turnId,
          approvalId: 'approval', toolCallId: 'call', toolName: 'bash',
          requirementId: { approvalId: 'approval', sourceIndex: 0 },
          choices: [{ choiceId: 'allow_once', label: 'Allow once', decision: 'approved', scope: 'once' }] } });
      return host; }, validateReady: () => {}, capture: async () => ({ native: { nspid: [42], netns: 'net:[1]' },
      fd: { close: async () => {} } }), verifyStop: async () => {
      throw Object.assign(Error('surviving native descendant'), { code: 'STOP_SURVIVOR' }); },
    onPending: ({ root, runtimeRoot }) => { roots = [root, runtimeRoot]; } });
  const controller = new AbortController();
  const run = worker.run({ task_id: 'controlled-survivor', workspace: workspace.path,
    private_git: { schema_version: 1, mount_kind: 'canonical_common_dir', view },
    signal: controller.signal, onEvent: async () => {},
    approve: async (_, signal) => { pending = true;
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(Error('stopped')),
        { once: true })); } });
  await eventually(() => pending);
  controller.abort(Error('explicit task stop'));
  const result = await run;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.worker_stop, 'unconfirmed');
  assert.deepEqual(result.blockers,
    ['Native stop verification failed: STOP_SURVIVOR: surviving native descendant']);
  assert.match(result.summary, /first stop check: STOP_SURVIVOR: surviving native descendant/);
  assert.equal((await git(f.root, 'rev-parse', workspace.branch)).trim(), f.base);
  for (const path of roots) await rm(path, { recursive: true, force: true });
});

test('real held transport failure withdraws Coordinator pending input while guest remains alive', async t => {
  const f = await fixture(t);
  const workspace = await prepareWorkspace(f.root, f.implementation('withdrawn-native'), f.policy,
    'project', randomUUID());
  const controlRoot = join(f.temp, 'task-control-withdrawn');
  await mkdir(controlRoot);
  const view = await preparePrivateGitView(f.root, workspace, join(controlRoot, 'private-git'));
  const marker = join(f.temp, 'withdraw-native');
  const script = join(f.temp, 'held-guest');
  const never = new Promise(() => undefined);
  let roots, pendingRequest, withdrawn = false;
  const worker = protectedMuseWorker({ stage: async root => root, sentinelStart: async () =>
    ({ port: 8001, close: async () => {} }), upstreamStart: async () =>
    ({ origin: 'http://127.0.0.1:8002/', provider: { requests: [
      { method: 'GET', path: '/muse-code/models' }], rejection: never }, close: async () => {} }),
  brokerStart: async () => ({ failure: never, close: async () => {} }),
  prepare: () => ({ executable: script, args: ['--', 'ignored'] }), probe: () => {},
  launch: (prepared, config) => {
    const command = shellProbeCommand(config.workspace, config.protectedRoot, config.canaryToken);
    const sessionId = 'native-session', turnId = 'native-turn';
    const line = frame => `printf '%s' '${Buffer.from(JSON.stringify(frame)).toString('base64')}' | base64 -d; printf '\\n'`;
    const ready = { kind: 'guest_ready', result: { kind: 'guest_shell_ready',
      metadata: { sessionId }, nativeIdentity: { start: '123', pid: 42 },
      nativeNamespace: 'net:[1]', commandSha256: createHash('sha256').update(command).digest('hex') } };
    const turn = { kind: 'guest_turn_accepted', schemaVersion: 1,
      checkpointId: config.turnCheckpointId, sessionId, turnId,
      status: 'accepted', disposition: 'started', startedNewTurn: true };
    const handoff = { kind: 'guest_handoff', result: { kind: 'native_shell_live_approval',
      command, nativeRawArgs: JSON.stringify({ command, description: 'Disposable native shell qualification' }),
      approval: { sessionId, turnId, approvalId: 'native-approval', toolCallId: 'native-call',
        toolName: 'bash', requirementId: { approvalId: 'native-approval', sourceIndex: 0 },
        choices: [{ choiceId: 'allow_once', label: 'Allow once', decision: 'approved', scope: 'once' }] } } };
    const failure = { kind: 'guest_transport_error', stage: 'native_turn',
      code: 'NATIVE_APPROVAL_WITHDRAWN', message: 'native permission was withdrawn',
      providerRequests: [] };
    writeFileSync(script, `#!/bin/sh
read config
printf '%s\\n' '{"child-pid":456}' >&3
${line(ready)}
read turn
${line(turn)}
read acknowledgement
${line(handoff)}
while [ ! -e '${marker}' ]; do sleep 0.01; done
${line(failure)}
read decision
`, { mode: 0o700 });
    return runStatusPhase(prepared, config);
  }, validateReady: () => {},
  capture: async () => ({ native: { nspid: [42], netns: 'net:[1]' },
    fd: { close: async () => {} } }), verifyStop: async () => ({ kind: 'confirmed' }),
  onPending: async ({ root, runtimeRoot }) => { roots = [root, runtimeRoot];
    await writeFile(marker, 'withdraw'); } });
  const controller = new AbortController();
  const run = worker.run({ task_id: 'controlled-withdrawal', workspace: workspace.path,
    private_git: { schema_version: 1, mount_kind: 'canonical_common_dir', view },
    signal: controller.signal, onEvent: async () => {},
    approve: async (request, signal) => { pendingRequest = request;
      return new Promise((_, reject) => signal.addEventListener('abort', () => {
        withdrawn = true; reject(Error('native callback withdrawn')); }, { once: true })); } });
  const result = await Promise.race([run, delay(3_000).then(() => {
    throw Error('task did not react to guest transport failure'); })]);
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'NATIVE_APPROVAL_WITHDRAWN');
  assert.equal(result.worker_stop, 'confirmed');
  assert.equal(pendingRequest.id, 'native-approval:0');
  assert.equal(withdrawn, true);
  assert.equal((await git(f.root, 'rev-parse', workspace.branch)).trim(), f.base);
  for (const path of roots) await rm(path, { recursive: true, force: true });
});

test('installed no-account protected task survives old diagnostic deadline and stops on exact cancellation',
  { skip: process.env.PASSEUR_MUSE_INSTALLED_TASK !== '1' }, async () => {
    // Explicit one-shot qualification only. Every root remains for review, including on failure.
    const retained = await mkdtemp(join(tmpdir(), 'passeur-muse-installed-task-'));
    const project = join(retained, 'project'), worktrees = join(retained, 'worktrees');
    const evidencePath = join(retained, 'qualification.json');
    const evidence = { kind: 'installed_no_account_protected_task', retained_root: retained,
      started_at: new Date().toISOString(), checkpoints: [] };
    const save = async () => writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    console.log(`Protected Muse retained fixture: ${retained}`);
    await Promise.all([project, worktrees].map(path => mkdir(path)));
    await git(project, 'init', '-q', '-b', 'main');
    await git(project, 'config', 'user.email', 'passeur-test@example.invalid');
    await git(project, 'config', 'user.name', 'Passeur Test');
    await git(project, 'config', 'commit.gpgsign', 'false');
    await writeFile(join(project, 'watched.txt'), 'before\n\n');
    await git(project, 'add', '.');
    await git(project, 'commit', '-qm', 'test: protected base');
    const base = (await git(project, 'rev-parse', 'HEAD')).trim();
    evidence.base_commit = base;
    const policy = { implementation: { enabled: true, worktree_root: worktrees },
      stop_grace_ms: 1_000, max_workers: 1, max_queued_tasks: 1,
      max_clients: 32, max_waiters: 128, max_pending_inputs: 16, max_control_receipts: 512 };
    const profile = { schema_version: 3, execution: policy,
      agents: [{ agent_id: 'muse', adapter_id: 'muse', description: 'No-account protected fixture',
        enabled: true, options: {} }] };
    const owner = { owner_id: createHash('sha256').update(randomUUID()).digest('hex'),
      client_id: randomUUID() };
    const store = new TaskStore(join(retained, 'state'));
    await store.initialize();
    let pendingObservation;
    const worker = protectedMuseWorker({ onPending: observation => { pendingObservation = observation; } });
    const registry = new AgentRegistry(profile, { muse: { configure: () => ({ worker,
      modes: ['implement'], contract: 'protected-installed-fixture/1', configuration: {} }) } });
    const coordinator = new Coordinator(project, 'protected-fixture', policy, store, registry,
      () => {}, undefined, 'controlled');
    let receipt;
    let failure;
    let baselineResource;
    const poll = async (read, ms, label) => {
      const end = performance.now() + ms;
      while (performance.now() < end) {
        const value = await read();
        if (value) return value;
        const early = receipt && await store.readResult(receipt.task_id);
        if (early) throw Error(`${label} ended early: ${early.error?.code ?? early.execution_status}`);
        await delay(100);
      }
      throw Error(`${label} was absent after ${ms} ms`);
    };
    const live = async identity => {
      assert.ok(identity?.pid && identity?.start && identity?.pidns && identity?.netns);
      const stat = await readFile(`/proc/${identity.pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      assert.equal(fields[19], identity.start);
      assert.equal(['Z', 'X'].includes(fields[0]), false);
      assert.equal(await readlink(`/proc/${identity.pid}/ns/pid`), identity.pidns);
      assert.equal(await readlink(`/proc/${identity.pid}/ns/net`), identity.netns);
    };
    const stable = async (initial, observation) => {
      const state = await store.readControl(receipt.task_id);
      assert.equal(state.task_id, receipt.task_id);
      assert.equal(state.control_generation, initial.control_generation);
      assert.equal(state.native.run_id, initial.native.run_id);
      assert.equal(state.native.state, initial.native.state);
      assert.equal(state.native.native_session_id, initial.native.native_session_id);
      assert.equal(state.native.turn_id, initial.native.turn_id);
      assert.equal(state.inputs.length, 1);
      assert.equal(state.inputs[0].input_id, initial.inputs[0].input_id);
      assert.equal(state.inputs[0].native_id, initial.inputs[0].native_id);
      assert.equal(state.inputs[0].run_id, initial.native.run_id);
      assert.equal(state.inputs[0].digest, initial.inputs[0].digest);
      assert.equal(state.inputs[0].state, 'pending');
      assert.equal(state.phase, initial.phase);
      assert.equal(observation.runId, evidence.relay_run_id);
      for (const identity of [observation.processIdentities.wrapper,
        observation.processIdentities.statusChild, observation.processIdentities.native]) await live(identity);
      const resource = await store.readResource(receipt.task_id);
      assert.equal(resource.task_id, receipt.task_id);
      assert.equal(resource.worktree_path, baselineResource.worktree_path);
      assert.equal(resource.branch_ref, baselineResource.branch_ref);
      assert.equal(resource.base_commit, base);
      assert.equal(resource.private_git.state, 'prepared');
      assert.equal(resource.private_git.run_id, initial.native.run_id);
      assert.equal(resource.private_git.control_generation, initial.control_generation);
      assert.equal(resource.private_git.private_common_dir,
        baselineResource.private_git.private_common_dir);
      assert.equal(await store.readPrivatePublication(receipt.task_id), undefined);
      assert.equal((await git(project, 'rev-parse', resource.branch_ref)).trim(), base);
      await assert.rejects(lstat(join(resource.worktree_path, 'shell-canary')), { code: 'ENOENT' });
      return state;
    };
    try {
      await save();
      const assignment = { schema_version: 3, agent_id: 'muse', request_key: `installed-${randomUUID()}`,
        mode: 'implement', objective: 'Observe one protected native shell permission without deciding it',
        context: '', acceptance_criteria: ['retain pending permission until explicit cancellation'],
        base_commit: base, target_ref: 'refs/heads/main' };
      receipt = await coordinator.submit({ schema_version: 1, source_view: project, assignment },
        owner, new AbortController().signal);
      evidence.task_id = receipt.task_id;
      await save();
      const initial = await poll(async () => { const state = await store.readControl(receipt.task_id);
        return state.inputs[0]?.state === 'pending' ? state : null; }, 120_000, 'native pending approval');
      const observation = await poll(() => pendingObservation, 10_000, 'native identity observation');
      baselineResource = await store.readResource(receipt.task_id);
      evidence.task_run_id = initial.native.run_id;
      evidence.relay_run_id = observation.runId;
      evidence.control_generation = initial.control_generation;
      evidence.private_resource = { task_id: baselineResource.task_id,
        worktree_path: baselineResource.worktree_path,
        branch_ref: baselineResource.branch_ref,
        private_common_dir: baselineResource.private_git.private_common_dir,
        run_id: baselineResource.private_git.run_id,
        control_generation: baselineResource.private_git.control_generation };
      evidence.session_id = initial.native.native_session_id;
      evidence.turn_id = initial.native.turn_id;
      evidence.input_id = initial.inputs[0].input_id;
      evidence.native_input_id = initial.inputs[0].native_id;
      evidence.worker_roots = [observation.root, observation.runtimeRoot];
      evidence.process_identities = observation.processIdentities;
      assert.equal(observation.taskId, receipt.task_id);
      assert.equal(observation.checkpoint.sessionId, evidence.session_id);
      assert.equal(observation.checkpoint.turnId, evidence.turn_id);
      assert.equal(initial.inputs[0].native_id,
        `${observation.approval.subject.approval_id}:${observation.approval.subject.requirement_id.sourceIndex}`);
      await stable(initial, observation);
      evidence.checkpoints.push({ kind: 'pending', at: new Date().toISOString() });
      await save();
      const claim = await coordinator.inputs.claim(receipt.task_id, initial.inputs[0].input_id,
        owner, initial.control_generation);
      await coordinator.inputs.dismiss(receipt.task_id, claim.input_id, owner, claim.claim.id);
      const observer = new AbortController();
      const current = await coordinator.controls.read(receipt.task_id, owner);
      const waiting = coordinator.controls.wait(receipt.task_id, owner, current.revision,
        60_000, observer.signal);
      waiting.catch(() => undefined);
      observer.abort(Error('installed presentation closed'));
      await assert.rejects(waiting, /installed presentation closed/);
      await stable(initial, observation);
      evidence.checkpoints.push({ kind: 'presentation_closed', at: new Date().toISOString() });
      await save();
      const dwellStarted = performance.now();
      while (performance.now() - dwellStarted < 661_000) {
        await delay(Math.min(10_000, 661_000 - (performance.now() - dwellStarted)));
        await stable(initial, observation);
      }
      evidence.checkpoints.push({ kind: 'past_diagnostic_deadline',
        elapsed_ms: performance.now() - dwellStarted, at: new Date().toISOString() });
      await save();
    } catch (cause) { failure = cause; evidence.failure = { code: cause.code ?? 'ERROR',
      message: String(cause.message).slice(0, 400) }; }
    finally {
      if (receipt) {
        try {
          const state = await store.readControl(receipt.task_id);
          if (!await store.readResult(receipt.task_id)) {
            evidence.cancel = await coordinator.cancel(receipt.task_id, owner,
              state.control_generation, `cancel-${randomUUID()}`, 'Explicit installed fixture stop');
          }
          const result = await poll(() => store.readResult(receipt.task_id), 30_000, 'cancelled task result');
          evidence.result = { execution_status: result.execution_status,
            worker_stop: result.worker_stop, summary: result.summary,
            blockers: result.blockers, error: result.error ?? null };
          assert.equal(result.execution_status, 'cancelled');
          assert.equal(result.worker_stop, 'confirmed');
          const resource = await store.readResource(receipt.task_id);
          assert.equal(resource.private_git.state, 'prepared');
          assert.equal(await store.readPrivatePublication(receipt.task_id), undefined);
          assert.equal((await git(project, 'rev-parse', resource.branch_ref)).trim(), base);
          await assert.rejects(lstat(join(resource.worktree_path, 'shell-canary')), { code: 'ENOENT' });
          if (pendingObservation) for (const path of [pendingObservation.root,
            pendingObservation.runtimeRoot]) assert.equal((await lstat(path)).isDirectory(), true);
          evidence.checkpoints.push({ kind: 'exact_stop', at: new Date().toISOString() });
        } catch (cause) {
          failure ??= cause;
          evidence.stop_failure = { code: cause.code ?? 'ERROR', message: String(cause.message).slice(0, 400) };
        }
      }
      await save();
      if (!failure) await coordinator.shutdown();
    }
    if (failure) throw failure;
  });
