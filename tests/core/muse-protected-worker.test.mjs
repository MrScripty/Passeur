import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import { exec, fixture, git } from './helpers.mjs';
import { AgentRegistry } from '../../.passeur-core/src/agents/registry.js';
import { Coordinator } from '../../.passeur-core/src/core/coordinator.js';
import { TaskStore } from '../../.passeur-core/src/store/task-store.js';
import { prepareWorkspace, preparePrivateGitView } from '../../.passeur-core/src/workspace/worktree.js';
import { nativeTaskDecision, settledCommitOutcome, protectedApprovalRequest,
  protectedMuseWorker, protectedAdapterApproval, verifySettledStop, verifyStoppedPrivateCommit,
  inspectTaskFinalAndStop, awaitTaskHostFinished, boundedGuestFailure,
  primaryNativeFailure, nativeFailureArtifact,
  settleProductionProtectedOutcome } from '../../scripts/qualify-muse-protected-worker.mjs';
import { createTaskCommitCoverage, runStatusPhase, shellProbeCommand,
  shellCommitCommand, fixedVerificationPayloadSha256 } from '../../scripts/qualify-muse-sandbox-transport.mjs';
import { relaySandboxConfig } from '../../scripts/qualify-muse-credential-relay.mjs';
import { prepareSandbox } from '../../scripts/experiment-worker-sandbox.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const adapterReady = relayPort => ({ relayPort, guestNamespace: 'net:[1]',
  canaries: { direct: true, symlink: true, proc: true } });

test('SDK approval bridge accepts only the exact native once shell request', () => {
  const workspace = '/tmp/passeur-sdk-approval';
  const command = 'printf fixture';
  const frame = { kind: 'adapter_approval', id: '0123456789abcdef01234567', request: {
    tool: 'bash', workspace, raw_args: JSON.stringify({ command,
      description: 'Disposable native shell qualification' }),
    subject: { native: { tool_call_id: 'call_native_shell_1', session_id: 'session',
      turn_id: 'turn', approval_id: 'approval',
      current_requirement_id: { approvalId: 'approval', sourceIndex: 0 } } },
    choices: [{ id: 'once', scope: 'once', decision: 'approved', label: 'Allow once' }],
  } };
  assert.equal(protectedAdapterApproval(frame, command, workspace), frame.request);
  for (const changed of [
    { ...frame, id: 'foreign' },
    { ...frame, request: { ...frame.request, raw_args: JSON.stringify({ command: 'other',
      description: 'Disposable native shell qualification' }) } },
    { ...frame, request: { ...frame.request, choices: [{ id: 'session', scope: 'session',
      decision: 'approved', label: 'Always' }] } },
  ]) assert.throws(() => protectedAdapterApproval(changed, command, workspace),
    { code: 'NATIVE_TASK_APPROVAL_INVALID' });
});

test('actual-SDK fixture rejects premature host close before any private publication', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'passeur-sdk-premature-'));
  let retained, approvals = 0, cancellations = 0;
  const finished = { code: 0, signal: null, output: [], statusLines: [],
    statusClosed: true, overflow: false };
  const worker = protectedMuseWorker({ commitTask: true, adapterMode: true,
    adapterStage: async root => root,
    sentinelStart: async () => ({ port: 10001, close: async () => {} }),
    upstreamStart: async () => ({ origin: 'http://127.0.0.1:10002/',
      provider: { rejection: new Promise(() => {}) }, close: async () => {} }),
    brokerStart: async () => ({ failure: new Promise(() => {}), close: async () => {} }),
    prepare: () => ({ executable: 'controlled', args: [] }), probe: () => {},
    adapterLaunch: () => ({ pid: 123, ready: Promise.resolve(adapterReady(10003)),
      liveStatus: Promise.resolve({ child: 456, exit: null }),
      approval: new Promise(() => {}), outcome: new Promise(() => {}),
      finished: Promise.resolve(finished),
      cancelTask: () => { cancellations++; } }),
    onRetained: observation => { retained = observation; } });
  try {
    const result = await worker.run({ task_id: randomUUID(), workspace,
      private_git: { schema_version: 1, mount_kind: 'canonical_common_dir',
        view: { private_common_dir: join(workspace, 'control', 'private-git') } },
      signal: new AbortController().signal, onEvent: async () => {},
      approve: async () => { approvals++; } });
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'NATIVE_ADAPTER_HOST_EXIT');
    assert.equal(result.worker_stop, 'unconfirmed');
    assert.equal(approvals, 0);
    assert.equal(cancellations, 1);
    assert.ok(retained?.root);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('production installed mode selects the production runtime branch before the SDK fixture', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'passeur-production-branch-test-'));
  let retained;
  const worker = protectedMuseWorker({ commitTask: true, adapterMode: true,
    productionRuntimeMode: true,
    adapterStage: async () => { throw Object.assign(new Error('controlled production stage stop'),
      { code: 'PRODUCTION_STAGE_SELECTED' }); },
    adapterLaunch: () => { throw Error('fixture SDK launch must not run'); },
    onRetained: observation => { retained = observation; } });
  try {
    const result = await worker.run({ task_id: randomUUID(), workspace,
      private_git: { schema_version: 1, mount_kind: 'canonical_common_dir',
        view: { private_common_dir: join(workspace, 'unused', 'private-git') } },
      signal: new AbortController().signal, onEvent: async () => {},
      approve: async () => { throw Error('no approval before stage'); } });
    assert.equal(result.error?.code, 'PRODUCTION_STAGE_SELECTED');
    assert.match(retained.root, /passeur-muse-production-protected-/);
    assert.match(retained.runtimeRoot, /passeur-muse-production-runtime-/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('fixture TLS transport cannot be selected outside the production protected path', async () => {
  const worker = protectedMuseWorker({ commitTask: true, providerTransportMode: true });
  await assert.rejects(worker.run({ task_id: randomUUID(), workspace: '/tmp/fixture-guard',
    private_git: { schema_version: 1, mount_kind: 'canonical_common_dir',
      view: { private_common_dir: '/tmp/fixture-guard/control/private-git' } },
    signal: new AbortController().signal, onEvent: async () => {},
    approve: async () => {} }), { code: 'NATIVE_ADAPTER_CONFIG_INVALID' });
});

test('production cleanup failure revokes success and still retires every owned resource', async () => {
  const result = { status: 'completed', worker_stop: 'confirmed', summary: 'native settled',
    worker_assessment: 'met', blockers: [], questions: [], checks: [] };
  const resources = ['socket', 'provider', 'sentinel'];
  const seen = [];
  const cleanup = async resource => { seen.push(resource);
    if (resource === 'socket') throw Object.assign(Error('socket retirement uncertain'),
      { code: 'SOCKET_STOP_UNVERIFIED' }); };
  const settled = await settleProductionProtectedOutcome({ result, validated: true,
    primaryError: null, resources, cancelled: false, hostStarted: true,
    roots: ['/tmp/retained'] }, cleanup);
  assert.deepEqual(seen, resources);
  assert.equal(settled.outcome.status, 'failed');
  assert.equal(settled.outcome.worker_stop, 'confirmed');
  assert.equal(settled.outcome.error.code, 'SOCKET_STOP_UNVERIFIED');
  const primary = Object.assign(Error('native failure'), { code: 'NATIVE_PRIMARY' });
  const preserved = await settleProductionProtectedOutcome({ result, validated: true,
    primaryError: primary, resources, cancelled: false, hostStarted: true,
    roots: ['/tmp/retained'] }, cleanup);
  assert.equal(preserved.outcome.error.code, 'NATIVE_PRIMARY');
});

test('SDK host death during pending human input withdraws that invocation', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'passeur-sdk-input-death-'));
  let finishHost, presented, stopped = 0;
  const finished = new Promise(resolve => { finishHost = resolve; });
  const approved = new Promise(resolve => { presented = resolve; });
  const frame = { kind: 'adapter_approval', id: '0123456789abcdef01234567', request: {
    tool: 'bash', workspace, raw_args: JSON.stringify({ command: 'placeholder',
      description: 'Disposable native shell qualification' }),
    subject: { native: { tool_call_id: 'call_native_shell_1', session_id: 'session',
      turn_id: 'turn', approval_id: 'approval',
      current_requirement_id: { approvalId: 'approval', sourceIndex: 0 } } },
    choices: [{ id: 'once', scope: 'once', decision: 'approved', label: 'Allow once' }],
  } };
  const worker = protectedMuseWorker({ commitTask: true, adapterMode: true,
    adapterStage: async root => root,
    sentinelStart: async () => ({ port: 10001, close: async () => {} }),
    upstreamStart: async () => ({ origin: 'http://127.0.0.1:10002/',
      provider: { rejection: new Promise(() => {}) }, close: async () => {} }),
    brokerStart: async () => ({ failure: new Promise(() => {}), close: async () => {} }),
    prepare: () => ({ executable: 'controlled', args: [] }), probe: () => {},
    adapterLaunch: (_prepared, config) => ({ pid: 123, ready: Promise.resolve(adapterReady(10003)),
      liveStatus: Promise.resolve({ child: 456, exit: null }),
      approval: Promise.resolve({ ...frame, request: { ...frame.request,
        raw_args: JSON.stringify({ command: shellCommitCommand(config.workspace,
          config.protectedRoot, config.canaryToken),
        description: 'Disposable native shell qualification' }) } }),
      outcome: new Promise(() => {}), finished, events: () => [],
      cancelTask: () => { stopped++; } }),
    adapterCapture: async () => ({ fd: { close: async () => {} },
      wrapper: {}, statusChild: {}, native: { netns: 'net:[1]' }, pidns: 'pid:[1]' }),
    verifyStop: async () => ({ kind: 'confirmed' }) });
  try {
    const run = worker.run({ task_id: randomUUID(), workspace,
      private_git: { schema_version: 1, mount_kind: 'canonical_common_dir',
        view: { private_common_dir: join(workspace, 'control', 'private-git') } },
      signal: new AbortController().signal, onEvent: async () => {},
      approve: async (_request, signal) => {
        presented();
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
          reject(Error('native input withdrawn'));
        }, { once: true }));
      } });
    await approved;
    finishHost({ code: 1, signal: null, overflow: false, statusClosed: true,
      statusLines: ['{"child-pid":456}', '{"exit-code":1}'], output: [] });
    const result = await run;
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'NATIVE_ADAPTER_HOST_EXIT');
    assert.ok(stopped >= 1);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('native-only SDK failure withdraws human input while guest control remains open', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'passeur-sdk-native-death-'));
  let failNative, finishHost, presented, withdrawn = false, cancelled = 0;
  const outcome = new Promise(resolve => { failNative = resolve; });
  const finished = new Promise(resolve => { finishHost = resolve; });
  const pending = new Promise(resolve => { presented = resolve; });
  const worker = protectedMuseWorker({ commitTask: true, adapterMode: true,
    adapterStage: async root => root,
    sentinelStart: async () => ({ port: 10001, close: async () => {} }),
    upstreamStart: async () => ({ origin: 'http://127.0.0.1:10002/',
      provider: { rejection: new Promise(() => {}) }, close: async () => {} }),
    brokerStart: async () => ({ failure: new Promise(() => {}), close: async () => {} }),
    prepare: () => ({ executable: 'controlled', args: [] }), probe: () => {},
    adapterLaunch: (_prepared, config) => ({ pid: 123,
      ready: Promise.resolve(adapterReady(10003)),
      liveStatus: Promise.resolve({ child: 456, exit: null }), outcome, finished,
      approval: Promise.resolve({ kind: 'adapter_approval', id: '0123456789abcdef01234567',
        request: { tool: 'bash', workspace,
          raw_args: JSON.stringify({ command: shellCommitCommand(config.workspace,
            config.protectedRoot, config.canaryToken),
          description: 'Disposable native shell qualification' }),
          subject: { native: { tool_call_id: 'call_native_shell_1', session_id: 'session',
            turn_id: 'turn', approval_id: 'approval',
            current_requirement_id: { approvalId: 'approval', sourceIndex: 0 } } },
          choices: [{ id: 'once', scope: 'once', decision: 'approved', label: 'Allow once' }],
        } }), events: () => [],
      cancelTask: () => { cancelled++;
        finishHost({ code: null, signal: 'SIGTERM', overflow: false, statusClosed: true,
          statusLines: ['{"child-pid":456}', '{"exit-code":1}'], output: [] }); } }),
    adapterCapture: async () => ({ fd: { close: async () => {} },
      wrapper: {}, statusChild: {}, native: { netns: 'net:[1]' }, pidns: 'pid:[1]' }),
    verifyStop: async () => ({ kind: 'confirmed' }) });
  try {
    const run = worker.run({ task_id: randomUUID(), workspace,
      private_git: { schema_version: 1, mount_kind: 'canonical_common_dir',
        view: { private_common_dir: join(workspace, 'control', 'private-git') } },
      signal: new AbortController().signal, onEvent: async () => {},
      approve: async (_request, signal) => {
        presented();
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
          withdrawn = true; reject(Error('native-only failure withdrew input'));
        }, { once: true }));
      } });
    await pending;
    failNative({ status: 'failed', error: { code: 'MUSE_HOST_EXITED' } });
    const result = await Promise.race([run, delay(3_000).then(() => {
      throw Error('native-only failure stranded pending human input'); })]);
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'MUSE_HOST_EXITED');
    assert.equal(withdrawn, true);
    assert.equal(cancelled, 1);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

async function controlledAdapterFailure(t, mode) {
  const f = await fixture(t);
  const never = new Promise(() => undefined);
  const sessionId = '11111111-1111-4111-8111-111111111111';
  let privateView, hostConfig, pendingObservation, finishHost, finishOutcome, workerRoot;
  let releasedAfterValidation = false;
  const finished = new Promise(resolve => { finishHost = resolve; });
  const outcome = new Promise(resolve => { finishOutcome = resolve; });
  const requests = [{ method: 'GET', path: '/muse-code/models' }];
  const seen = [{ correctBearer: true, dummyAbsent: true }];
  const provider = { requests, seen, rejection: never,
    state: { active: 0, primaryCode: null, failed: false }, freeze: async () => {} };
  const events = [{ kind: 'turn_started', turn_id: 'provisional', native_session_id: sessionId },
    { kind: 'turn_correlated', provisional_turn_id: 'provisional', turn_id: 'turn',
      native_session_id: sessionId },
    { kind: 'operation_started', id: 'shell', operation: 'tool' }];
  let notifications = [], committed;
  const host = { pid: 123, ready: Promise.resolve(adapterReady(8003)),
    liveStatus: Promise.resolve({ child: 456, exit: null }), outcome, finished,
    events: () => [...events], notifications: () => [...notifications],
    sendChoice: () => {
      if (mode === 'dispatch') throw Object.assign(Error('SDK approval dispatch failed'),
        { code: 'NATIVE_APPROVAL_DISPATCH_UNKNOWN' });
      void (async () => {
        const workspace = hostConfig.workspace;
        const environment = { ...process.env,
          GIT_DIR: join(privateView.private_common_dir, privateView.admin_relative),
          GIT_COMMON_DIR: privateView.private_common_dir, GIT_WORK_TREE: workspace };
        const privateGit = async (...args) => (await exec('git', ['-C', workspace, ...args],
          { env: environment })).stdout.trim();
        await writeFile(join(workspace, 'qualified-change.txt'), 'native committed change\n');
        await rm(join(workspace, 'protected-link'));
        await privateGit('add', '--', 'qualified-change.txt');
        await privateGit('-c', 'user.name=Passeur Fixture',
          '-c', 'user.email=passeur-fixture@example.invalid', 'commit', '-m', 'Adapter private commit');
        committed = await privateGit('rev-parse', 'HEAD');
        requests.push({ path: '/responses', kind: 'matching_tool_result',
          outputMarkers: { commit: committed } },
        { path: '/responses', kind: 'native_reminder_call' },
        { path: '/responses', kind: 'native_reminder_call' },
        { path: '/responses', kind: 'native_verification_reminder_call' });
        for (let index = 0; index < 4; index++) seen.push({ correctBearer: true, dummyAbsent: true });
        events.push({ kind: 'operation_finished', id: 'shell' },
          { kind: 'turn_settled', turn_id: 'turn', native_session_id: sessionId });
        if (mode === 'survivor' || mode === 'success') {
          const transcript = `direct=denied\nsymlink=denied\nproc=denied\ndummy-auth=visible\ncommit=${committed}\n`;
          const nativeItem = (itemId, callId, kind, status, extra = {}) => ({
            itemId, callId, kind, turnId: 'turn', status, ...extra });
          const notification = (method, item) => ({ method,
            params: { sessionId, item } });
          const shell = nativeItem('shell-item', 'call_native_shell_1', 'toolCall',
            'completed', { tool: 'bash', args: JSON.stringify({ command: shellCommitCommand(
              workspace, hostConfig.protectedRoot, hostConfig.canaryToken) }),
              visibleOutput: transcript });
          notifications = [notification('item/started',
            nativeItem('shell-item', 'call_native_shell_1', 'toolCall', 'inProgress')),
            notification('item/completed', shell)];
          const childNames = [['skill-reminder', 1], ['skill-reminder', 2],
            ['verify-reminder', 1]];
          const children = childNames.map(([reminderAgentId, generationId], index) => ({
            itemId: `child-${index}`, callId: null, turnId: 'turn',
            kind: 'reminderChild', reminderAgentId, generationId,
            childSessionId: `child-session-${index}`, taskId: `child-task-${index}` }));
          for (let index = 0; index < children.length; index++) {
            const child = children[index];
            notifications.push(notification('item/started', { ...child, status: 'inProgress' }),
              notification('item/completed', { ...child, status: 'completed' }));
          }
          notifications.push({ method: 'turn/completed', params: { sessionId,
            turnId: 'turn', terminal: 'completed' } });
          const entry = (sequence, event) => ({ schema_version: 1, sequence,
            record_type: 'event', durability: 'durable', stream: { kind: 'session', id: sessionId },
            payload_type: 'runtime.session', payload_schema_version: 1,
            payload: { kind: 'run', run_id: 'turn', event } });
          const link = child => ({ kind: 'memory_reminder_child_session_linked',
            generation_id: child.generationId, reminder_agent_id: child.reminderAgentId,
            parent_run_id: 'turn', parent_session_id: sessionId,
            child_session_id: child.childSessionId, task_id: child.taskId,
            task_stream: { kind: 'task', id: child.taskId } });
          const proposal = (child, index) => ({ kind: 'reminder_proposal',
            generation_id: child.generationId, reminder_agent_id: child.reminderAgentId,
            decision_call_id: index === 2 ? 'call_native_verify_reminder_1' :
              `call_native_reminder_${index + 1}`,
            decision_run_stream: { kind: 'run', id: child.childSessionId } });
          const journal = [entry(1, link(children[0])), entry(2, proposal(children[0], 0)),
            entry(3, link(children[1])), entry(4, link(children[2])),
            entry(5, proposal(children[2], 2)), entry(6, proposal(children[1], 1))];
          const journalPath = join(workerRoot, 'home', '.local', 'share', 'muse',
            'sessions', '2026', '09', '28', sessionId, 'session.jsonl');
          await mkdir(join(journalPath, '..'), { recursive: true });
          await writeFile(journalPath, `${journal.map(value => JSON.stringify(value)).join('\n')}\n`,
            { mode: 0o600 });
        } else notifications = [{ method: 'item/started', params: { sessionId,
          item: { kind: 'unrecognizedChild', itemId: 'foreign', turnId: 'turn',
            callId: null, status: 'inProgress' } } }];
        finishOutcome({ status: 'completed', worker_assessment: 'met',
          summary: 'Controlled SDK adapter completed the fixed private commit',
          blockers: [], questions: [], checks: [] });
      })().catch(error => finishOutcome({ status: 'failed',
        error: { code: error.code ?? 'CONTROLLED_COMMIT_FAILED' } }));
    },
    cancelTask: () => finishHost({ code: null, signal: 'SIGTERM', overflow: false,
      statusClosed: true, output: [], statusLines: ['{"child-pid":456}', '{"exit-code":1}'] }),
    finishTask: () => { releasedAfterValidation = true;
      finishHost({ code: 0, signal: null, overflow: false,
        statusClosed: true, output: [], statusLines: ['{"child-pid":456}', '{"exit-code":0}'] }); },
  };
  const worker = protectedMuseWorker({ commitTask: true, adapterMode: true,
    adapterStage: async root => root,
    sentinelStart: async () => ({ port: 8001, close: async () => {} }),
    upstreamStart: async () => ({ origin: 'http://127.0.0.1:8002/', provider, seen,
      close: async () => {} }),
    brokerStart: async () => ({ failure: never,
      evidence: { get accepted() { return requests.length; }, rejected: 0 },
      close: async () => {} }),
    prepare: config => { privateView = config.privateGit.view;
      return { executable: 'controlled', args: [] }; },
    probe: () => {}, adapterLaunch: (_prepared, config) => {
      hostConfig = config;
      assert.equal(config.hostPort, 8001);
      const command = shellCommitCommand(config.workspace, config.protectedRoot,
        config.canaryToken);
      requests.push({ path: '/responses', kind: 'native_tool_call',
        callId: 'call_native_shell_1' });
      seen.push({ correctBearer: true, dummyAbsent: true });
      host.approval = Promise.resolve({ kind: 'adapter_approval',
        id: '0123456789abcdef01234567', request: { id: 'stage', tool: 'bash',
          workspace: config.workspace, raw_args: JSON.stringify({ command,
            description: 'Disposable native shell qualification' }),
          subject: { native: { session_id: sessionId, turn_id: 'turn',
            tool_call_id: 'call_native_shell_1', approval_id: 'approval',
            current_requirement_id: { approvalId: 'approval', sourceIndex: 0 } } },
          choices: [{ id: 'allow', label: 'Allow once', scope: 'once',
            decision: 'approved' }] } });
      return host;
    },
    adapterCapture: async () => ({ fd: { close: async () => {} },
      wrapper: {}, statusChild: {}, native: { netns: 'net:[1]' }, pidns: 'pid:[1]' }),
    verifyStop: async () => {
      if (mode === 'survivor') throw Object.assign(Error('descendant still present'),
        { code: 'STOP_SURVIVOR' });
      return { kind: 'confirmed' };
    },
    onPending: value => { pendingObservation = value; },
    onRetained: value => { workerRoot = value.root; } });
  const coordinator = new Coordinator(f.root, 'project', f.policy, f.store,
    new AgentRegistry(f.profile, { muse: { configure: () => ({ worker,
      modes: ['implement'], contract: 'adapter-controlled-negative/1', configuration: {} }) } }),
  () => {}, undefined, 'controlled');
  const receipt = await coordinator.submit({ schema_version: 1, source_view: f.root,
    assignment: f.implementation(`sdk-negative-${randomUUID()}`) }, f.owner,
  new AbortController().signal);
  const state = await eventually(async () => { const value = await f.store.readControl(receipt.task_id);
    return value.inputs[0]?.state === 'pending' ? value : null; });
  await eventually(() => pendingObservation);
  const claim = await coordinator.inputs.claim(receipt.task_id, state.inputs[0].input_id,
    f.owner, state.control_generation);
  if (mode === 'cancel') {
    const stopped = await coordinator.cancel(receipt.task_id, f.owner,
      state.control_generation, `cancel-${randomUUID()}`, 'Explicit SDK fixture cancellation');
    assert.equal(stopped.outcome, 'accepted');
  } else await coordinator.inputs.answer(receipt.task_id, claim.input_id, f.owner,
    state.control_generation, claim.claim.id, `allow-${randomUUID()}`, 'allow');
  const result = await eventually(() => f.store.readResult(receipt.task_id));
  if (mode === 'success') {
    assert.equal(releasedAfterValidation, true);
    assert.equal(result.execution_status, 'completed', JSON.stringify(result));
    assert.equal(result.worker_stop, 'confirmed');
    assert.equal(result.delivery.status, 'committed');
    assert.equal(result.delivery.head_commit, committed);
    assert.equal((await git(f.root, 'rev-parse', result.delivery.branch_ref)).trim(), committed);
    assert.equal((await f.store.readPrivatePublication(receipt.task_id)).state, 'published');
    await coordinator.shutdown();
    return;
  }
  assert.equal(result.execution_status, mode === 'cancel' ? 'cancelled' : 'failed');
  assert.equal(result.worker_stop, mode === 'survivor' ? 'unconfirmed' : 'confirmed');
  if (mode === 'unknown') assert.equal(result.error?.code, 'NATIVE_TASK_OPERATION_UNCERTAIN');
  if (mode === 'unknown') {
    const diagnostic = JSON.parse(await readFile(join(workerRoot, 'adapter-failure.json'), 'utf8'));
    assert.deepEqual(diagnostic, { schema_version: 1,
      error_code: 'NATIVE_TASK_OPERATION_UNCERTAIN', failure_frames: [] });
  }
  if (mode === 'dispatch') assert.equal(result.error?.code, 'NATIVE_APPROVAL_DISPATCH_UNKNOWN');
  if (mode === 'survivor') {
    assert.equal(releasedAfterValidation, true);
    assert.equal(result.error?.code, 'STOP_SURVIVOR');
  }
  const resource = await f.store.readResource(receipt.task_id);
  if (mode === 'unknown' || mode === 'survivor') {
    assert.match(committed, /^[0-9a-f]{40}$/);
    const head = (await readFile(join(privateView.private_common_dir,
      privateView.admin_relative, 'HEAD'), 'utf8')).trim();
    assert.match(head, /^ref: refs\/heads\//);
    assert.equal((await readFile(join(privateView.private_common_dir,
      head.slice(5)), 'utf8')).trim(), committed);
    assert.equal((await git(f.root, 'rev-parse', resource.branch_ref)).trim(), f.base);
  }
  assert.equal(result.delivery.status, 'incomplete');
  assert.equal(await f.store.readPrivatePublication(receipt.task_id), undefined);
  assert.equal(resource.private_git.state, 'prepared');
  assert.equal((await git(f.root, 'rev-parse', 'main')).trim(), f.base);
  await coordinator.shutdown();
}

for (const mode of ['unknown', 'dispatch', 'cancel', 'survivor']) {
  test(`SDK adapter Coordinator retains private resources after ${mode} failure`,
    t => controlledAdapterFailure(t, mode));
}
test('SDK adapter Coordinator publishes after one shell call, three children, journal and stop',
  t => controlledAdapterFailure(t, 'success'));
async function eventually(read, timeoutMs = 3_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { const value = await read(); if (value) return value; await delay(5); }
  throw Error('controlled protected task observation absent');
}

async function retainCommitAttention(receipt, evidence, save, store) {
  try { await save(); }
  catch (saveError) {
    console.error(JSON.stringify({ kind: 'native_commit_evidence_write_failed',
      task_id: receipt?.task_id ?? null, retained_root: evidence.retained_root,
      message: String(saveError.message).slice(0, 400) }));
  }
  if (!receipt) return { current: null, terminal: null };
  let reportedReadFailure = false;
  for (;;) {
    try {
      const current = await store.readControl(receipt.task_id);
      const terminal = await store.readResult(receipt.task_id);
      return { current, terminal };
    } catch (error) {
      if (!reportedReadFailure) console.error(JSON.stringify({
        kind: 'native_commit_control_read_failed', task_id: receipt.task_id,
        retained_root: evidence.retained_root, message: String(error.message).slice(0, 400) }));
      reportedReadFailure = true;
      await delay(100);
    }
  }
}

test('accepted installed task retains current control after both evidence writes fail', async () => {
  const taskId = randomUUID();
  const current = { control_generation: 3, inputs: [{ state: 'pending' }] };
  let reads = 0, writes = 0;
  const store = { async readControl(id) { assert.equal(id, taskId); reads++; return current; },
    async readResult(id) { assert.equal(id, taskId); reads++; return undefined; } };
  const save = async () => { writes++; throw Error('evidence volume unavailable'); };
  await assert.rejects(save, /evidence volume unavailable/);
  const originalError = console.error;
  let reported;
  try {
    console.error = line => { reported = JSON.parse(line); };
    const attention = await retainCommitAttention({ task_id: taskId },
      { retained_root: '/tmp/retained' }, save, store);
    assert.equal(attention.current, current);
    assert.equal(attention.terminal, undefined);
  } finally { console.error = originalError; }
  assert.equal(writes, 2);
  assert.equal(reads, 2);
  assert.equal(reported.task_id, taskId);
  assert.equal(reported.kind, 'native_commit_evidence_write_failed');
});

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

test('task decision selects only an exact current once choice', () => {
  const checkpoint = { sessionId: 'session', turnId: 'turn' };
  const handoff = { handoffId: 'handoff', approval: { sessionId: 'session', turnId: 'turn',
    toolCallId: 'call', approvalId: 'approval', requirementId: { approvalId: 'approval', sourceIndex: 0 },
    choices: [{ choiceId: 'allow', decision: 'approved', scope: 'once' },
      { choiceId: 'always', decision: 'approved', scope: 'always' }] } };
  assert.deepEqual(nativeTaskDecision(handoff, checkpoint, { choice_id: 'allow' }), {
    kind: 'choice', handoffId: 'handoff', sessionId: 'session', turnId: 'turn',
    callId: 'call', approvalId: 'approval',
    requirementId: { approvalId: 'approval', sourceIndex: 0 }, choiceId: 'allow' });
  for (const answer of ['always', 'foreign']) assert.throws(() =>
    nativeTaskDecision(handoff, checkpoint, { choice_id: answer }),
  { code: 'NATIVE_TASK_DECISION_INVALID' });
  assert.throws(() => nativeTaskDecision(handoff, { ...checkpoint, turnId: 'foreign' },
    { choice_id: 'allow' }), { code: 'NATIVE_TASK_DECISION_INVALID' });
});

test('native commit settlement joins three per-agent children after exact provider and native closure', () => {
  const checkpoint = { sessionId: 'session', turnId: 'turn' };
  const handoff = { handoffId: 'handoff', approval: {
    approvalId: 'approval', toolCallId: 'call_native_shell_1' } };
  const commit = 'a'.repeat(40), hash = 'b'.repeat(64);
  const item = { callId: 'call_native_shell_1', itemId: 'shell-item', turnId: 'turn',
    tool: 'bash', status: 'completed', outputMarkers: true,
    workspaceReportedWritten: true, commandMatch: true, commit,
    outputShape: { sha256: hash } };
  const skill = [1, 2].map(ordinal => ({ path: '/responses', kind: 'native_reminder_call',
    model: 'fixture-native-shell', ordinal, responseId: `resp_native_reminder_${ordinal}`,
    itemId: `fc_native_reminder_${ordinal}`, callId: `call_native_reminder_${ordinal}`,
    payloadSha256: hash, nativeChildAssociation: 'unknown' }));
  const verifier = { path: '/responses', kind: 'native_verification_reminder_call',
    model: 'fixture-native-shell', responseId: 'resp_native_verify_reminder_1',
    itemId: 'fc_native_verify_reminder_1', callId: 'call_native_verify_reminder_1',
    nativeChildAssociation: 'unknown', payloadSha256: fixedVerificationPayloadSha256(),
    association: { previousResponse: 'absent', httpRelation: 'unknown', inputCount: 1,
      omittedItems: 0 }, verificationSchema: { selectedComplete: true, identityValid: true } };
  const issued = { path: '/responses', kind: 'native_tool_call', callId: item.callId,
    itemId: 'fc_native_shell_1' };
  const result = { path: '/responses', kind: 'matching_tool_result', forCallId: item.callId,
    outputMarkers: { commit, innerOutputSha256: hash }, resultEvidence: { sha256: hash } };
  const children = [['skill-reminder', 1, skill[0]], ['skill-reminder', 2, skill[1]],
    ['verify-reminder', 1, verifier]].map(([agent, generation, request], index) => ({
      reminderAgentId: agent, generationId: generation,
      itemId: `native-child-${index}`, childSessionId: `child-session-${index}`,
      taskId: `child-task-${index}`, callId: null, turnId: 'turn', status: 'completed',
      request }));
  const journal = { kind: 'native_task_reminder_journal_joined', sessionId: 'session',
    turnId: 'turn', joins: children.map(child => ({ reminderAgentId: child.reminderAgentId,
      generationId: child.generationId, callId: child.request.callId,
      childSessionId: child.childSessionId, taskId: child.taskId })) };
  const nativeChildren = children.map(({ request, ...child }) => child);
  const outcome = { kind: 'native_shell_held_decided', sessionId: 'session', turnId: 'turn',
    providerRequests: [{ method: 'GET', path: '/muse-code/models' }, issued, skill[0],
      result, skill[1], verifier],
    observations: { approvals: [{}], items: [item], reminders: [],
      nativeCoverage: { completed: [{ callId: item.callId, itemId: item.itemId,
        turnId: 'turn', status: 'completed' }], children: nativeChildren },
      omitted: { approvals: 0, items: 0, reminders: 0, protocolErrors: 0 }, protocolErrors: [] },
    held: { kind: 'decided', presentation: { handoffId: 'handoff' }, item,
      decision: { commandId: 'command', choice: { decision: 'approved', choiceId: 'allow' },
        ack: { status: 'accepted', terminal: true } },
      resolved: { kind: 'approval/resolved', approvalId: 'approval',
        decidedByCommandId: 'command', decision: 'approved', resolvedBy: 'user' },
      terminal: { kind: 'turn_completed', turnId: 'turn', sessionId: 'session',
        terminal: 'completed' } } };
  assert.equal(settledCommitOutcome(outcome, checkpoint, handoff, 'allow', journal), commit);
  const resultFirst = structuredClone(outcome);
  resultFirst.providerRequests.splice(3, 2, skill[1], result);
  assert.equal(settledCommitOutcome(resultFirst, checkpoint, handoff, 'allow', journal), commit);
  assert.throws(() => settledCommitOutcome(outcome, checkpoint, handoff, 'allow'),
    { code: 'NATIVE_TASK_REMINDER_ASSOCIATION_UNKNOWN' });
  for (const change of [
    value => { value.joins.pop(); },
    value => { value.joins[2].callId = skill[1].callId; },
    value => { value.joins[2].childSessionId = value.joins[1].childSessionId; },
    value => { value.joins[2].reminderAgentId = 'skill-reminder'; },
  ]) {
    const invalid = structuredClone(journal); change(invalid);
    assert.throws(() => settledCommitOutcome(outcome, checkpoint, handoff, 'allow', invalid),
      { code: 'NATIVE_TASK_REMINDER_ASSOCIATION_UNKNOWN' });
  }
  for (const change of [
    value => { value.observations.nativeCoverage.children[1].status = 'inProgress'; },
    value => { value.observations.nativeCoverage.children[2].status = 'inProgress'; },
    value => { value.observations.nativeCoverage.children[2].generationId = 2; },
    value => { value.observations.nativeCoverage.children[2].taskId = 'child-task-1'; },
    value => { value.providerRequests.pop(); },
    value => { value.providerRequests[5].payloadSha256 = hash; },
    value => { value.providerRequests[5].association.httpRelation = 'foreign'; },
    value => { value.providerRequests[3].outputMarkers.innerOutputSha256 = 'c'.repeat(64); },
    value => { value.observations.nativeCoverage.completed.push({ callId: 'foreign',
      itemId: 'foreign', turnId: 'turn', status: 'completed' }); },
  ]) {
    const invalid = structuredClone(outcome); change(invalid);
    assert.throws(() => settledCommitOutcome(invalid, checkpoint, handoff, 'allow', journal),
      { code: 'NATIVE_TASK_SETTLEMENT_INVALID' });
  }
});

async function controlledCommitScenario(t, disruption = 'none') {
  const f = await fixture(t);
  const hook = join(f.root, '.git', 'hooks', 'pre-commit');
  await writeFile(hook, '#!/bin/sh\nprintf hook-ran > "$(git rev-parse --git-common-dir)/hooks/hook-marker"\n');
  await chmod(hook, 0o755);
  const never = new Promise(() => undefined);
  const sessionId = '11111111-1111-4111-8111-111111111111';
  let workerRoot, privateView, pendingObservation, finishHost, completeOutcome, hostConfig,
    emittedOutcome, commitError, committedEvidence, decided = false, cancelCount = 0;
  const nativeEvents = [];
  const finished = new Promise(resolve => { finishHost = resolve; });
  const outcome = new Promise(resolve => { completeOutcome = resolve; });
  const checkpoint = { schemaVersion: 1, checkpointId: 'checkpoint', sessionId,
    turnId: 'turn', status: 'accepted', disposition: 'started', startedNewTurn: true };
  const approval = { sessionId, turnId: 'turn', approvalId: 'approval',
    toolCallId: 'call_native_shell_1', toolName: 'bash', requirementId: { approvalId: 'approval', sourceIndex: 0 },
    choices: [{ choiceId: 'allow', label: 'Allow once', decision: 'approved', scope: 'once' },
      { choiceId: 'deny', label: 'Deny', decision: 'denied', scope: 'once' }] };
  const provider = { requests: [{ method: 'GET', path: '/muse-code/models' }], rejection: never,
    state: { active: 0, primaryCode: null, failed: false, omittedRequests: 0 }, freeze: async () => {} };
  const seen = [{ correctBearer: true, dummyAbsent: true }];
  const host = { pid: 123, liveStatus: Promise.resolve({ child: 456, exit: null }),
    turnAccepted: Promise.resolve(checkpoint), outcome, finished, releaseTurn() {},
    async recordAndAckTurn(recorder) { await recorder(checkpoint); },
    sendDecision(frame) {
      assert.equal(frame.choiceId, 'allow');
      decided = true;
      void (async () => {
        const workspace = hostConfig.workspace;
        const environment = { ...process.env,
          GIT_DIR: join(privateView.private_common_dir, privateView.admin_relative),
          GIT_COMMON_DIR: privateView.private_common_dir, GIT_WORK_TREE: workspace };
        const privateGit = async (...args) => (await exec('git', ['-C', workspace, ...args],
          { env: environment })).stdout.trim();
        await writeFile(join(workspace, 'qualified-change.txt'), 'native committed change\n');
        await rm(join(workspace, 'protected-link'));
        await privateGit('add', '--', 'qualified-change.txt');
        await privateGit('-c', 'user.name=Passeur Fixture',
          '-c', 'user.email=passeur-fixture@example.invalid',
          'commit', '-m', 'Qualify native private commit');
        const commit = await privateGit('rev-parse', 'HEAD');
        assert.equal(await privateGit('status', '--porcelain'), '');
        const transcript = `direct=denied\nsymlink=denied\nproc=denied\ndummy-auth=visible\ncommit=${commit}\n`;
        const hash = createHash('sha256').update(transcript).digest('hex');
        const item = { callId: 'call_native_shell_1', itemId: 'item', turnId: 'turn', tool: 'bash',
          status: 'completed', commandMatch: true, outputMarkers: true, workspaceReportedWritten: true,
          commit, outputShape: { sha256: hash } };
        provider.requests.push({ path: '/responses', kind: 'matching_tool_result',
            forCallId: 'call_native_shell_1', outputMarkers: { commit, innerOutputSha256: hash },
            resultEvidence: { sha256: hash } });
        seen.push({ correctBearer: true, dummyAbsent: true });
        const skill = [1, 2].map(ordinal => ({ path: '/responses',
          kind: 'native_reminder_call', model: 'fixture-native-shell', ordinal,
          responseId: `resp_native_reminder_${ordinal}`,
          itemId: `fc_native_reminder_${ordinal}`,
          callId: `call_native_reminder_${ordinal}`, payloadSha256: hash,
          nativeChildAssociation: 'unknown' }));
        const verify = { path: '/responses', kind: 'native_verification_reminder_call',
          model: 'fixture-native-shell', responseId: 'resp_native_verify_reminder_1',
          itemId: 'fc_native_verify_reminder_1', callId: 'call_native_verify_reminder_1',
          payloadSha256: fixedVerificationPayloadSha256(),
          nativeChildAssociation: 'unknown',
          verificationSchema: { selectedComplete: true, identityValid: true },
          association: { previousResponse: 'absent', httpRelation: 'unknown',
            inputCount: 1, omittedItems: 0 } };
        provider.requests.splice(2, 0, skill[0]);
        provider.requests.push(skill[1], verify);
        for (let index = 0; index < 3; index++)
          seen.push({ correctBearer: true, dummyAbsent: true });
        const children = [['skill-reminder', 1, skill[0]],
          ['skill-reminder', 2, skill[1]], ['verify-reminder', 1, verify]].map(
          ([agent, generation, request], index) => ({
            itemId: `native-child-${index}`, callId: null, turnId: 'turn',
            status: 'completed', reminderAgentId: agent, generationId: generation,
            childSessionId: `child-session-${index}`,
            taskId: `child-task-${index}`, request }));
        const entry = (sequence, event) => ({ schema_version: 1, sequence,
          record_type: 'event', durability: 'durable',
          stream: { kind: 'session', id: sessionId },
          payload_type: 'runtime.session', payload_schema_version: 1,
          payload: { kind: 'run', run_id: 'turn', event } });
        const link = child => ({ kind: 'memory_reminder_child_session_linked',
          generation_id: child.generationId, reminder_agent_id: child.reminderAgentId,
          parent_run_id: 'turn', parent_session_id: sessionId,
          child_session_id: child.childSessionId, task_id: child.taskId,
          task_stream: { kind: 'task', id: child.taskId } });
        const proposal = child => ({ kind: 'reminder_proposal',
          generation_id: child.generationId, reminder_agent_id: child.reminderAgentId,
          decision_call_id: child.request.callId,
          decision_run_stream: { kind: 'run', id: child.childSessionId } });
        const journal = [entry(1, link(children[0])), entry(2, proposal(children[0])),
          entry(3, link(children[1])), entry(4, link(children[2])),
          entry(5, proposal(children[2])), entry(6, proposal(children[1]))];
        const journalPath = join(workerRoot, 'home', '.local', 'share', 'muse',
          'sessions', '2026', '09', '28', sessionId, 'session.jsonl');
        await mkdir(join(journalPath, '..'), { recursive: true });
        await writeFile(journalPath,
          `${journal.map(value => JSON.stringify(value)).join('\n')}\n`, { mode: 0o600 });
        emittedOutcome = { kind: 'native_shell_held_decided', sessionId, turnId: 'turn',
          providerRequests: [],
          observations: { approvals: [{}], items: [item], reminders: [],
            nativeCoverage: { completed: [{ callId: 'call_native_shell_1', itemId: 'item',
              turnId: 'turn', status: 'completed' }], children: children.map(({ request, ...child }) => child) }, protocolErrors: [],
            omitted: { approvals: 0, items: 0, reminders: 0, protocolErrors: 0 } },
          held: { kind: 'decided', presentation: { handoffId: 'handoff' },
            decision: { choice: { choiceId: 'allow', decision: 'approved' }, commandId: 'cmd',
              ack: { status: 'accepted', terminal: true } },
            resolved: { kind: 'approval/resolved', approvalId: 'approval',
              decidedByCommandId: 'cmd', decision: 'approved', resolvedBy: 'user' }, item,
            terminal: { kind: 'turn_completed', sessionId, turnId: 'turn',
              terminal: 'completed' } } };
        if (disruption !== 'none') {
          emittedOutcome.observations.nativeCoverage.children[2].status = 'inProgress';
          host.partialCoverage = emittedOutcome.observations.nativeCoverage;
          committedEvidence = { commit };
          if (disruption === 'death') finishHost({ code: 1, signal: null,
            output: ['ready', 'handoff'],
            statusLines: ['{"child-pid":456}', '{"exit-code":1}'] });
          return;
        }
        completeOutcome(emittedOutcome);
      })().catch(error => { commitError = error; completeOutcome({ kind: 'guest_transport_error', code: 'CONTROLLED_COMMIT_FAILED',
        message: error.message }); });
    },
    releaseShutdown() { setTimeout(() => finishHost({ code: 0, signal: null,
      output: ['ready', 'handoff', 'outcome', JSON.stringify(emittedOutcome)],
      statusLines: ['{"child-pid":456}', '{"exit-code":0}'] }), 25); },
    cancelTask() { cancelCount++; finishHost({ code: null, signal: 'SIGTERM',
      statusLines: ['{"child-pid":456}'] }); },
  };
  const worker = protectedMuseWorker({ commitTask: true, stage: async root => root,
    onRetained: value => { workerRoot = value.root; },
    sentinelStart: async () => ({ port: 8001, close: async () => {} }),
    upstreamStart: async () => ({ origin: 'http://127.0.0.1:8002/', provider, seen,
      close: async () => {} }), brokerStart: async () => ({ failure: never,
      evidence: { get accepted() { return provider.requests.length; }, rejected: 0 },
      close: async () => {} }),
    prepare: config => { privateView = config.privateGit.view; return { executable: 'controlled', args: [] }; },
    probe: () => {}, launch: (_, config) => {
      hostConfig = config;
      const command = shellCommitCommand(config.workspace, config.protectedRoot, config.canaryToken);
      provider.requests.push({ path: '/responses', kind: 'native_tool_call', callId: 'call_native_shell_1', itemId: 'fc_native_shell_1',
        commandSha256: createHash('sha256').update(command).digest('hex') });
      seen.push({ correctBearer: true, dummyAbsent: true });
      host.ready = Promise.resolve({ nativeIdentity: { start: '123', pid: 42 },
        nativeNamespace: 'net:[1]', metadata: { durableLogPath: `/mounts/home/.local/share/muse/sessions/2026/09/28/${sessionId}/session.jsonl` }, commandSha256: createHash('sha256').update(command).digest('hex') });
      host.handoff = Promise.resolve({ kind: 'native_shell_live_approval', handoffId: 'handoff',
        command, nativeRawArgs: JSON.stringify({ command,
          description: 'Disposable native shell qualification' }), approval });
      return host;
    }, validateReady: () => {},
    capture: async () => ({ native: { nspid: [42], netns: 'net:[1]' },
      fd: { close: async () => {} } }), verifyStop: async () => {
      if (disruption === 'death') throw Object.assign(Error('descendant still present'),
        { code: 'STOP_SURVIVOR' });
      return { kind: 'confirmed' };
    },
    onPending: value => { pendingObservation = value; } });
  const observingWorker = { ...worker, run: input => worker.run({ ...input,
    onEvent: async event => { nativeEvents.push(event.kind); await input.onEvent(event); } }) };
  const coordinator = new Coordinator(f.root, 'project', f.policy, f.store,
    new AgentRegistry(f.profile, { muse: { configure: () => ({ worker: observingWorker,
      modes: ['implement'], contract: 'protected-commit-fixture/1', configuration: {} }) } }),
  () => {}, undefined, 'controlled');
  const receipt = await coordinator.submit({ schema_version: 1, source_view: f.root,
    assignment: f.implementation(`private-commit-${randomUUID()}`) }, f.owner,
  new AbortController().signal);
  const state = await eventually(async () => { const value = await f.store.readControl(receipt.task_id);
    return value.inputs[0]?.state === 'pending' ? value : null; });
  await eventually(() => pendingObservation);
  const before = await f.store.readResource(receipt.task_id);
  assert.equal(decided, false);
  assert.equal(before.private_git.state, 'prepared');
  assert.equal((await git(f.root, 'rev-parse', before.branch_ref)).trim(), f.base);
  assert.equal(await f.store.readPrivatePublication(receipt.task_id), undefined);
  const claim = await coordinator.inputs.claim(receipt.task_id, state.inputs[0].input_id,
    f.owner, state.control_generation);
  await coordinator.inputs.answer(receipt.task_id, claim.input_id, f.owner,
    state.control_generation, claim.claim.id, `human-choice-${randomUUID()}`, 'allow');
  if (disruption !== 'none') {
    await eventually(() => committedEvidence);
    assert.equal(host.partialCoverage.children[2].reminderAgentId, 'verify-reminder');
    assert.equal(host.partialCoverage.children[2].generationId, 1);
    assert.equal(host.partialCoverage.children[2].status, 'inProgress');
    assert.equal(await f.store.readResult(receipt.task_id), undefined);
    if (disruption === 'cancel') {
      const current = await f.store.readControl(receipt.task_id);
      const cancelled = await coordinator.cancel(receipt.task_id, f.owner,
        current.control_generation, `cancel-${randomUUID()}`, 'Explicit verifier child stop');
      assert.equal(cancelled.outcome, 'accepted');
    }
    const result = await eventually(() => f.store.readResult(receipt.task_id));
    assert.equal(result.execution_status, disruption === 'cancel' ? 'cancelled' : 'failed');
    assert.equal(result.worker_stop, disruption === 'cancel' ? 'confirmed' : 'unconfirmed');
    assert.equal(nativeEvents.includes('turn_started'), true);
    assert.equal(nativeEvents.includes('operation_started'), true);
    assert.equal(nativeEvents.includes('operation_finished'), false);
    assert.equal(nativeEvents.includes('turn_settled'), false);
    assert.equal(result.delivery.status, 'incomplete');
    assert.equal(await f.store.readPrivatePublication(receipt.task_id), undefined);
    const resource = await f.store.readResource(receipt.task_id);
    assert.equal(resource.private_git.state, 'prepared');
    assert.equal((await git(f.root, 'rev-parse', resource.branch_ref)).trim(), f.base);
    assert.equal((await git(f.root, '--git-dir', resource.private_git.private_common_dir,
      'rev-parse', resource.branch_ref)).trim(), committedEvidence.commit);
    assert.equal(await readFile(join(resource.private_git.private_common_dir, 'hooks',
      'hook-marker'), 'utf8'), 'hook-ran');
    await coordinator.shutdown();
    for (const path of [pendingObservation.root, pendingObservation.runtimeRoot])
      await rm(path, { recursive: true, force: true });
    return;
  }
  const result = await eventually(() => f.store.readResult(receipt.task_id));
  assert.equal(result.execution_status, 'completed', `${commitError?.stack ?? ''}\n${JSON.stringify(result)}`);
  assert.equal(result.worker_stop, 'confirmed');
  assert.equal(cancelCount, 0);
  assert.equal(result.delivery.status, 'committed');
  assert.equal(await readFile(join(before.worktree_path, 'qualified-change.txt'), 'utf8'),
    'native committed change\n');
  assert.equal(await readFile(join(privateView.private_common_dir, 'hooks', 'hook-marker'), 'utf8'),
    'hook-ran');
  assert.equal((await git(f.root, 'rev-parse', before.branch_ref)).trim(), result.delivery.head_commit);
  await assert.rejects(verifyStoppedPrivateCommit({ private_git: { view: privateView },
    request: { base_commit: f.base } }, f.base), { code: 'NATIVE_TASK_COMMIT_INVALID' });
  assert.equal((await git(f.root, 'rev-parse', `${result.delivery.head_commit}^{tree}`)).trim(),
    result.delivery.tree_oid);
  assert.equal((await f.store.readResource(receipt.task_id)).private_git.state, 'published');
  assert.equal((await f.store.readPrivatePublication(receipt.task_id)).state, 'published');
  await coordinator.shutdown();
  for (const path of [pendingObservation.root, pendingObservation.runtimeRoot])
    await rm(path, { recursive: true, force: true });
}

test('controlled Coordinator publishes only after human intent, hook-executed private commit and stop',
  async t => controlledCommitScenario(t));
test('controlled Coordinator cancellation retains private commit with verifier child unfinished',
  async t => controlledCommitScenario(t, 'cancel'));
test('controlled Coordinator host death retains private commit with uncertain descendant stop',
  async t => controlledCommitScenario(t, 'death'));

test('confirmed post-commit native uncertainty retains private hook commit without publication', async t => {
  const f = await fixture(t);
  const hook = join(f.root, '.git', 'hooks', 'pre-commit');
  await writeFile(hook, '#!/bin/sh\nprintf hook-ran > "$(git rev-parse --git-common-dir)/hooks/hook-marker"\n');
  await chmod(hook, 0o755);
  let privateCommit;
  const worker = { private_git: { schema_version: 1, mount_kind: 'canonical_common_dir' },
    async run(input) {
      await input.onEvent({ kind: 'turn_started', turn_id: 'controlled-native-turn',
        native_session_id: 'controlled-native-session' });
      const view = input.private_git.view;
      const environment = { ...process.env,
        GIT_DIR: join(view.private_common_dir, view.admin_relative),
        GIT_COMMON_DIR: view.private_common_dir, GIT_WORK_TREE: input.workspace };
      const privateGit = async (...args) => (await exec('git', ['-C', input.workspace, ...args],
        { env: environment })).stdout.trim();
      await writeFile(join(input.workspace, 'qualified-change.txt'), 'private result retained\n');
      await privateGit('add', '--', 'qualified-change.txt');
      await privateGit('-c', 'user.name=Passeur Fixture',
        '-c', 'user.email=passeur-fixture@example.invalid',
        'commit', '-m', 'Retain native private candidate');
      privateCommit = await privateGit('rev-parse', 'HEAD');
      return { status: 'failed', worker_stop: 'confirmed', worker_assessment: 'unknown',
        summary: 'Native reminder association remained unknown after the private commit',
        blockers: [], questions: [], checks: [],
        error: { code: 'NATIVE_TASK_REMINDER_ASSOCIATION_UNKNOWN',
          message: 'second native child lacks a reviewed provider-call association' } };
    } };
  const registry = new AgentRegistry(f.profile, { muse: { configure: () => ({ worker,
    modes: ['implement'], contract: 'controlled-post-commit-failure/1', configuration: {} }) } });
  const coordinator = new Coordinator(f.root, 'project', f.policy, f.store, registry,
    () => {}, undefined, 'controlled');
  const receipt = await coordinator.submit({ schema_version: 1, source_view: f.root,
    assignment: f.implementation(`post-commit-failure-${randomUUID()}`) }, f.owner,
  new AbortController().signal);
  const result = await eventually(() => f.store.readResult(receipt.task_id));
  const resource = await f.store.readResource(receipt.task_id);
  assert.equal(result.execution_status, 'failed');
  assert.equal(result.worker_stop, 'confirmed');
  assert.equal(result.error.code, 'NATIVE_TASK_REMINDER_ASSOCIATION_UNKNOWN');
  assert.equal(result.delivery.status, 'incomplete');
  assert.equal(resource.private_git.state, 'prepared');
  assert.equal(await f.store.readPrivatePublication(receipt.task_id), undefined);
  assert.equal((await git(f.root, 'rev-parse', resource.branch_ref)).trim(), f.base);
  assert.equal((await git(f.root, '--git-dir', resource.private_git.private_common_dir,
    'rev-parse', resource.branch_ref)).trim(), privateCommit);
  assert.equal(await readFile(join(resource.private_git.private_common_dir, 'hooks', 'hook-marker'), 'utf8'),
    'hook-ran');
  await coordinator.shutdown();
});

test('forged task outcome before human intent cannot settle or publish', async t => {
  const f = await fixture(t);
  const workspace = await prepareWorkspace(f.root, f.implementation('early-outcome'),
    f.policy, 'project', randomUUID());
  const controlRoot = join(f.temp, 'early-control');
  await mkdir(controlRoot);
  const view = await preparePrivateGitView(f.root, workspace, join(controlRoot, 'private-git'));
  const checkpoint = { sessionId: 'session', turnId: 'turn' };
  const never = new Promise(() => undefined);
  let finishHost, retained;
  const finished = new Promise(resolve => { finishHost = resolve; });
  const host = { pid: 123, liveStatus: Promise.resolve({ child: 456, exit: null }),
    turnAccepted: Promise.resolve(checkpoint), outcome: Promise.resolve({ kind: 'native_shell_held_decided' }),
    finished, releaseTurn() {}, async recordAndAckTurn(recorder) { await recorder(checkpoint); },
    cancelTask() { finishHost({ code: null, signal: 'SIGTERM', statusLines: ['{"child-pid":456}'] }); } };
  const provider = { requests: [{ path: '/responses', kind: 'native_tool_call', callId: 'call' }],
    rejection: never };
  const worker = protectedMuseWorker({ commitTask: true, stage: async root => root,
    sentinelStart: async () => ({ port: 8001, close: async () => {} }),
    upstreamStart: async () => ({ origin: 'http://127.0.0.1:8002/', provider,
      close: async () => {} }), brokerStart: async () => ({ failure: never, close: async () => {} }),
    prepare: () => ({ executable: 'controlled', args: [] }), probe: () => {},
    launch: (_, config) => {
      const command = shellCommitCommand(config.workspace, config.protectedRoot, config.canaryToken);
      host.ready = Promise.resolve({ nativeIdentity: { start: '123', pid: 42 },
        nativeNamespace: 'net:[1]', commandSha256: createHash('sha256').update(command).digest('hex') });
      host.handoff = Promise.resolve({ kind: 'native_shell_live_approval', handoffId: 'handoff',
        command, nativeRawArgs: JSON.stringify({ command,
          description: 'Disposable native shell qualification' }),
        approval: { sessionId: 'session', turnId: 'turn', approvalId: 'approval',
          toolCallId: 'call', toolName: 'bash', requirementId: { approvalId: 'approval', sourceIndex: 0 },
          choices: [{ choiceId: 'allow', label: 'Allow once', decision: 'approved', scope: 'once' }] } });
      return host;
    }, validateReady: () => {}, capture: async () => ({ native: { nspid: [42], netns: 'net:[1]' },
      fd: { close: async () => {} } }), verifyStop: async () => ({ kind: 'confirmed' }),
    onPending: value => { retained = value; } });
  const events = [];
  const result = await worker.run({ task_id: randomUUID(), workspace: workspace.path,
    private_git: { schema_version: 1, mount_kind: 'canonical_common_dir', view },
    signal: new AbortController().signal, onEvent: async event => events.push(event),
    approve: async () => await never });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'NATIVE_TASK_OUTCOME_UNEXPECTED');
  assert.equal(events.some(event => event.kind === 'turn_settled'), false);
  assert.equal((await git(f.root, 'rev-parse', workspace.branch)).trim(), f.base);
  assert.equal(await readFile(join(workspace.path, 'qualified-change.txt')).then(() => true, () => false), false);
  if (retained) for (const path of [retained.root, retained.runtimeRoot])
    await rm(path, { recursive: true, force: true });
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

test('malformed native final output still receives independent confirmed or uncertain stop proof', async () => {
  const finished = { code: 0, signal: null, output: ['ready', 'handoff', 'outcome', 'invalid-json'],
    statusLines: ['{"child-pid":456}', '{"exit-code":0}'] };
  let checks = 0;
  const input = { finished, shutdownReleased: true, nativeOutcome: { kind: 'expected' },
    frozenRequests: [], provider: { state: { primaryCode: null }, requests: [] }, captured: {} };
  const confirmed = await inspectTaskFinalAndStop({ ...input, verifyStop: async () => {
    checks++; return { kind: 'confirmed' }; } });
  assert.equal(confirmed.semanticError.code, 'NATIVE_TASK_FINAL_INVALID');
  assert.equal(confirmed.stopProof.kind, 'confirmed');
  assert.equal(checks, 1);
  const uncertain = await inspectTaskFinalAndStop({ ...input, verifyStop: async () => {
    checks++; throw Object.assign(Error('cannot inspect native namespace'), { code: 'STOP_INSPECTION_FAILED' });
  } });
  assert.ok(uncertain.semanticError);
  assert.equal(uncertain.stopProof, null);
  assert.equal(uncertain.stopError.code, 'STOP_INSPECTION_FAILED');
  assert.equal(checks, 2);
});

test('shutdown close has a bounded grace and one owned stop on expiry', async () => {
  let finish, cancels = 0;
  const finished = new Promise(resolve => { finish = resolve; });
  const host = { finished, cancelTask() { cancels++; finish({ code: null, signal: 'SIGTERM' }); } };
  const timed = await awaitTaskHostFinished(host, { shutdownReleased: true,
    gracefulMs: 5, cleanupMs: 100 });
  assert.equal(timed.error.code, 'NATIVE_TASK_FINAL_DEADLINE');
  assert.equal(timed.finished.signal, 'SIGTERM');
  assert.equal(cancels, 1);
  const normal = await awaitTaskHostFinished({ finished: new Promise(resolve =>
    setTimeout(() => resolve({ code: 0, signal: null }), 15)), cancelTask() { cancels++; } },
  { shutdownReleased: true, gracefulMs: 100, cleanupMs: 10 });
  assert.equal(normal.finished.code, 0);
  assert.equal(normal.error, null);
  assert.equal(cancels, 1);
  const stuck = await awaitTaskHostFinished({ finished: new Promise(() => undefined),
    cancelTask() { cancels++; } }, { shutdownReleased: true, gracefulMs: 2, cleanupMs: 2 });
  assert.equal(stuck.error.code, 'NATIVE_TASK_FINAL_DEADLINE');
  assert.equal(stuck.stopError.code, 'NATIVE_TASK_STOP_UNCONFIRMED');
  assert.equal(cancels, 2);
});

test('guest coverage failure remains primary when relay disconnect follows guest close', async () => {
  let cancels = 0;
  const guest = { kind: 'guest_transport_error', stage: 'native_turn',
    code: 'NATIVE_TASK_OPERATION_UNCERTAIN', message: 'bounded native task failure',
    providerRequests: [], failureObservation: { method: 'item/started', kind: 'reminderChild',
      sessionId: 'session', turnId: 'turn', itemId: 'child', callId: null,
      status: 'inProgress', childLifecycle: { attemptedGeneration: 2,
        acceptedChildren: 1, priorGeneration: 1, priorStatus: 'completed',
        sameFirstItem: false } } };
  const host = { finished: new Promise(resolve => setTimeout(() => resolve({ code: 0,
    signal: null, output: ['ready', JSON.stringify(guest)] }), 15)),
  cancelTask() { cancels++; } };
  const relayFailure = Object.assign(Error('relay disconnected after guest close'),
    { code: 'GUEST_DISCONNECTED' });
  const observed = await awaitTaskHostFinished(host, { shutdownReleased: false,
    priorError: relayFailure, cancelled: false, diagnosticGraceMs: 100, cleanupMs: 5 });
  const first = boundedGuestFailure(observed.finished.output);
  const primary = primaryNativeFailure(relayFailure, first);
  assert.equal(primary.code, 'NATIVE_TASK_OPERATION_UNCERTAIN');
  const { childLifecycle, ...notification } = guest.failureObservation;
  assert.deepEqual(first.notification, notification);
  assert.deepEqual(first.childLifecycle, guest.failureObservation.childLifecycle);
  const hostile = boundedGuestFailure([JSON.stringify({ ...guest,
    failureObservation: { ...guest.failureObservation,
      childLifecycle: { attemptedGeneration: 999, acceptedChildren: -1,
        priorGeneration: 'never-retain-raw-prompt-or-auth',
        priorStatus: 'never-retain-raw-prompt-or-auth',
        sameFirstItem: 'never-retain-raw-prompt-or-auth' } } })]);
  assert.deepEqual(hostile.childLifecycle, { attemptedGeneration: null,
    acceptedChildren: null, priorGeneration: null, priorStatus: null, sameFirstItem: null });
  const secret = 'never-retain-raw-prompt-or-auth';
  const artifact = nativeFailureArtifact({ taskId: 'task', runId: 'run', error: primary,
    guestFailure: first, upstream: { provider: { state: { main: 'unseen', reminder: 'none-issued',
      active: 0, primaryCode: null, omittedRequests: 0 },
    requests: [{ method: 'POST', path: '/responses', kind: 'native_reminder_call',
      callId: 'call_native_reminder_1', raw_args: secret, prompt: secret }] } },
    broker: { evidence: { firstFailure: { code: 'GUEST_DISCONNECTED', stage: 'disconnect' },
      accepted: 2, rejected: 0 } }, finalHost: observed.finished,
    stopProof: { kind: 'confirmed' } });
  assert.equal(artifact.primaryCode, 'NATIVE_TASK_OPERATION_UNCERTAIN');
  assert.equal(artifact.relay.firstFailure.code, 'GUEST_DISCONNECTED');
  assert.equal(artifact.guestFailure.notification.kind, 'reminderChild');
  assert.equal(artifact.stop.proof, 'confirmed');
  assert.equal(JSON.stringify(artifact).includes(secret), false);
  assert.ok(Buffer.byteLength(JSON.stringify(artifact)) <= 12_288);
  const maxed = nativeFailureArtifact({ taskId: 'task', runId: 'run', error: primary,
    guestFailure: first, upstream: { provider: { state: {}, requests: Array.from({ length: 8 },
      () => ({ method: 'M'.repeat(256), path: 'P'.repeat(256), kind: 'K'.repeat(256),
        callId: 'C'.repeat(256), itemId: 'I'.repeat(256), forCallId: 'F'.repeat(256) })) } },
    broker: { evidence: { firstFailure: { code: 'GUEST_DISCONNECTED', stage: 'disconnect' } } },
    finalHost: { code: 1, output: Array.from({ length: 5 }, () =>
      JSON.stringify({ kind: 'K'.repeat(256), stage: 'S'.repeat(256), code: 'GUEST_DISCONNECTED' })) } });
  assert.equal(maxed.provider.requests.length, 8);
  assert.ok(Buffer.byteLength(JSON.stringify(maxed)) <= 12_288);
  assert.equal(cancels, 0);
});

test('failure artifact keeps provider response 3 separate from relay index and strips hostile fields', () => {
  const poison = 'POISON_PRIVATE_COMMIT_CREDENTIAL_81';
  const artifact = nativeFailureArtifact({ taskId: 'task', runId: 'run',
    error: { code: 'NATIVE_INPUT_INVALID' }, upstream: { provider: { state: {
      main: 'call-issued', reminder: 'none-issued', active: 0,
      primaryCode: 'NATIVE_REMINDER_SEQUENCE_INVALID', omittedRequests: 0 },
    requests: [{ method: 'POST', path: '/responses', responseIndex: 3,
      rejection: 'NATIVE_REMINDER_SEQUENCE_INVALID',
      reminderRejection: { schemaClass: 'recognized_reminder', providerResponseIndex: 3,
        relayRequestIndex: poison, issuanceAtAdmission: { main: 'call-issued',
          reminder: 'none-issued', verification: 'unseen', raw: poison },
        classificationState: { main: 'call-issued', reminder: 'none-issued' },
        predicate: 'prior_reminder_issued', ordinal: 1, firstPrelude: false,
        previousResponse: 'issued_shell_response',
        input: { class: 'array', count: 12, omittedItems: 4,
          items: [{ type: 'function_call_output', id: 'absent', callId: 'issued_shell_call',
            output: poison }, { type: poison, id: poison, callId: poison }] },
        nativeChildAssociation: poison, rawPrompt: poison },
      reminderRejectionEvidence: { name: 'provider-response-3-reminder-rejection.json',
        bytes: 420, sha256: 'a'.repeat(64), path: poison },
      reminderRejectionEvidenceError: poison }] } },
    broker: { evidence: { firstFailure: { code: 'NATIVE_INPUT_INVALID', stage: 'admission' },
      accepted: 4, rejected: 2 } } });
  const request = artifact.provider.requests[0];
  assert.equal(request.responseIndex, 3);
  assert.equal(request.reminderRejection.providerResponseIndex, 3);
  assert.equal(request.reminderRejection.relayRequestIndex, null);
  assert.equal(request.reminderRejection.predicate, 'prior_reminder_issued');
  assert.equal(request.reminderRejection.nativeChildAssociation, 'unknown');
  assert.equal(request.reminderRejection.input.items[1].type, null);
  assert.equal(request.reminderRejectionEvidence.bytes, 420);
  assert.equal(JSON.stringify(artifact).includes(poison), false);
  assert.ok(Buffer.byteLength(JSON.stringify(artifact)) <= 12_288);
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

async function runInstalledPrivateCommit(adapterMode, productionRuntimeMode = false,
  providerTransportMode = false) {
    if (providerTransportMode && !productionRuntimeMode)
      throw Error('installed TLS transport requires the production protected runtime');
    if (!process.stdin.isTTY) throw Error('installed commit needs a persistent terminal input channel');
    if (process.env.PASSEUR_MUSE_COMMIT_CHANNEL_DRY_RUN === '1') {
      console.log(JSON.stringify({ kind: 'native_commit_channel_dry_run', stdin_tty: true }));
      return;
    }
    const retained = await mkdtemp(join(tmpdir(), 'passeur-muse-installed-commit-'));
    const project = join(retained, 'project'), worktrees = join(retained, 'worktrees');
    const evidencePath = join(retained, 'qualification.json');
    const evidence = { kind: providerTransportMode ?
      'installed_no_account_muse_provider_transport_tls_private_commit' :
      adapterMode ? 'installed_no_account_muse_sdk_adapter_private_commit' :
      'installed_no_account_native_private_commit',
      adapter_composition: providerTransportMode ?
        'built MuseSdkAdapter.run with production protected host, fixture protocol adapter, built host transport and local TLS peer' :
        productionRuntimeMode ? 'built MuseSdkAdapter.run with production protected host and stop observer' :
        adapterMode ? 'actual MuseSdkAdapter.run with fixture real-SDK ClientStarter' :
        'raw MSP fixture',
      provider_transport_mode: providerTransportMode,
      retained_root: retained, started_at: new Date().toISOString(), checkpoints: [] };
    const save = async () => writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`,
      { mode: 0o600 });
    console.log(`Native commit retained fixture: ${retained}`);
    await Promise.all([project, worktrees].map(path => mkdir(path)));
    await git(project, 'init', '-q', '-b', 'main');
    await git(project, 'config', 'user.email', 'passeur-test@example.invalid');
    await git(project, 'config', 'user.name', 'Passeur Test');
    await git(project, 'config', 'commit.gpgsign', 'false');
    await writeFile(join(project, 'watched.txt'), 'before\n');
    await git(project, 'add', '.');
    await git(project, 'commit', '-qm', 'test: native commit base');
    const base = (await git(project, 'rev-parse', 'HEAD')).trim();
    const hook = join(project, '.git', 'hooks', 'pre-commit');
    await writeFile(hook, '#!/bin/sh\nprintf hook-ran > "$(git rev-parse --git-common-dir)/hooks/hook-marker"\n');
    await chmod(hook, 0o755);
    const policy = { implementation: { enabled: true, worktree_root: worktrees },
      stop_grace_ms: 1_000, max_workers: 1, max_queued_tasks: 1,
      max_clients: 32, max_waiters: 128, max_pending_inputs: 16, max_control_receipts: 512 };
    const profile = { schema_version: 3, execution: policy,
      agents: [{ agent_id: 'muse', adapter_id: 'muse', description: 'No-account native commit fixture',
        enabled: true, options: {} }] };
    const owner = { owner_id: createHash('sha256').update(randomUUID()).digest('hex'),
      client_id: randomUUID() };
    const store = new TaskStore(join(retained, 'state'));
    await store.initialize();
    let pendingObservation, retainedObservation;
    const worker = protectedMuseWorker({ commitTask: true, adapterMode, productionRuntimeMode,
      providerTransportMode,
      onRetained: observation => { retainedObservation = observation; },
      onPending: observation => { pendingObservation = observation; } });
    const coordinator = new Coordinator(project, 'protected-commit-fixture', policy, store,
      new AgentRegistry(profile, { muse: { configure: () => ({ worker, modes: ['implement'],
        contract: 'protected-installed-commit-fixture/1', configuration: {} }) } }),
    () => {}, undefined, 'controlled');
    const assignment = { schema_version: 3, agent_id: 'muse',
      request_key: `installed-commit-${randomUUID()}`, mode: 'implement',
      objective: 'Create one fixed ordinary private Git commit after human once approval',
      context: '', acceptance_criteria: ['one hook-executed private commit and guarded delivery'],
      base_commit: base, target_ref: 'refs/heads/main' };
    let receipt;
    let channel;
    try {
    await save();
    receipt = await coordinator.submit({ schema_version: 1, source_view: project,
      assignment }, owner, new AbortController().signal);
    evidence.task_id = receipt.task_id;
    await save();
    const state = await (async () => {
      for (;;) {
        const current = await store.readControl(receipt.task_id);
        if (current.inputs[0]?.state === 'pending') return current;
        const early = await store.readResult(receipt.task_id);
        if (early) throw Error(`native approval ended early: ${early.error?.code ?? early.execution_status}`);
        await delay(100);
      }
    })();
    while (!pendingObservation) {
      const early = await store.readResult(receipt.task_id);
      if (early) throw Error(`native observation ended early: ${early.error?.code ?? early.execution_status}`);
      await delay(20);
    }
    const resource = await store.readResource(receipt.task_id);
    const input = state.inputs[0];
    assert.equal(resource.private_git.state, 'prepared');
    assert.equal(resource.private_git.run_id, state.native.run_id);
    assert.equal(resource.private_git.control_generation, state.control_generation);
    assert.equal((await git(project, 'rev-parse', resource.branch_ref)).trim(), base);
    assert.equal(await store.readPrivatePublication(receipt.task_id), undefined);
    const nativeSubject = adapterMode ? pendingObservation.approval.subject.native :
      pendingObservation.approval.subject;
    assert.equal(nativeSubject.session_id, state.native.native_session_id);
    assert.equal(nativeSubject.turn_id, state.native.turn_id);
    assert.equal(input.native_id, pendingObservation.approval.id);
    const command = JSON.parse(pendingObservation.approval.raw_args).command;
    const protectedNames = await readdir(join(pendingObservation.root, 'protected'));
    assert.equal(protectedNames.length, 1);
    const protectedToken = protectedNames[0];
    assert.equal(command, shellCommitCommand(resource.worktree_path,
      join(pendingObservation.root, 'protected'), protectedToken));
    evidence.base_commit = base;
    evidence.run_id = state.native.run_id;
    evidence.control_generation = state.control_generation;
    evidence.input_id = input.input_id;
    evidence.native_input_id = input.native_id;
    evidence.approval = pendingObservation.approval;
    evidence.command = command;
    evidence.private_resource = { branch_ref: resource.branch_ref,
      worktree_path: resource.worktree_path,
      private_common_dir: resource.private_git.private_common_dir };
    evidence.worker_roots = [pendingObservation.root, pendingObservation.runtimeRoot];
    if (adapterMode) evidence.adapter_artifacts = JSON.parse(await readFile(join(
      pendingObservation.runtimeRoot, 'runtime', 'adapter-artifact-manifest.json'), 'utf8'));
    evidence.checkpoints.push({ kind: 'pending', at: new Date().toISOString() });
    await save();
    const claim = await coordinator.inputs.claim(receipt.task_id, input.input_id,
      owner, state.control_generation);
    const presentationNonce = randomUUID();
    evidence.presentation_nonce = presentationNonce;
    await save();
    console.log(JSON.stringify({ kind: 'native_commit_human_handoff', task_id: receipt.task_id,
      run_id: state.native.run_id, control_generation: state.control_generation,
      input_id: input.input_id, approval: pendingObservation.approval, command,
      offered_choices: claim.data.approval.choices, presentation_nonce: presentationNonce,
      reply_shape: 'choice_id,control_generation,host_receipt,input_id,operation_key,presentation_nonce,task_id' }));
    channel = createInterface({ input: process.stdin });
    let reply;
    let waitingForChoice = true;
    try {
      const next = await Promise.race([channel[Symbol.asyncIterator]().next(),
        (async () => {
          while (waitingForChoice) {
            const terminal = await store.readResult(receipt.task_id);
            if (terminal) return { terminal };
            await delay(100);
          }
          return new Promise(() => undefined);
        })()]);
      if (next.terminal) throw Error(`native task ended before human choice: ${
        next.terminal.error?.code ?? next.terminal.execution_status}`);
      if (next.done || Buffer.byteLength(next.value) > 16_384) {
        throw Error('host choice channel closed or exceeded its bound without a decision');
      }
      reply = JSON.parse(next.value);
    } finally { waitingForChoice = false; channel.close(); }
    if (Object.keys(reply ?? {}).sort().join(',') !==
        'choice_id,control_generation,host_receipt,input_id,operation_key,presentation_nonce,task_id' ||
        reply.task_id !== receipt.task_id || reply.input_id !== input.input_id ||
        reply.control_generation !== state.control_generation ||
        reply.presentation_nonce !== presentationNonce ||
        typeof reply.operation_key !== 'string' || !reply.operation_key ||
        typeof reply.host_receipt !== 'string' || !reply.host_receipt ||
        Buffer.byteLength(reply.host_receipt) > 512 ||
        typeof reply.choice_id !== 'string' ||
        !claim.data.approval.choices.some(choice => choice.id === reply.choice_id &&
          choice.scope === 'once')) {
      throw Error('forwarded human choice differs from the currently claimed exact input');
    }
    const currentClaim = await store.readControl(receipt.task_id);
    if (currentClaim.control_generation !== state.control_generation ||
        currentClaim.native.run_id !== state.native.run_id ||
        currentClaim.native.turn_id !== state.native.turn_id ||
        currentClaim.inputs.find(value => value.input_id === input.input_id)?.state !== 'pending') {
      throw Error('native input changed before forwarded human choice');
    }
    const intent = await coordinator.inputs.answer(receipt.task_id, input.input_id, owner,
      state.control_generation, claim.claim.id, reply.operation_key, reply.choice_id);
    assert.equal(intent.outcome, 'answer_intent');
    evidence.human_choice = { choice_id: reply.choice_id, operation_key: reply.operation_key,
      host_receipt: reply.host_receipt, presentation_nonce: presentationNonce,
      answer_intent_receipt: intent };
    evidence.checkpoints.push({ kind: 'answer_intent', at: new Date().toISOString() });
    await save();
    let result;
    for (;;) {
      result = await store.readResult(receipt.task_id);
      if (result) break;
      await delay(100);
    }
    evidence.result = { execution_status: result.execution_status,
      worker_stop: result.worker_stop, error: result.error ?? null,
      delivery: result.delivery };
    await save();
    assert.equal(result.execution_status, 'completed');
    assert.equal(result.worker_stop, 'confirmed');
    assert.equal(result.delivery.status, 'committed');
    assert.equal(result.delivery.base_commit, base);
    assert.equal(result.delivery.branch_ref, resource.branch_ref);
    assert.equal(result.delivery.worktree_path, resource.worktree_path);
    const nativeCommit = adapterMode ? result.delivery.head_commit :
      /^Native private commit ([0-9a-f]{40}|[0-9a-f]{64}) settled and stopped$/.exec(
        result.summary ?? '')?.[1];
    assert.ok(nativeCommit, 'worker summary retains the exact stopped native object ID');
    assert.equal(result.delivery.head_commit, nativeCommit);
    assert.equal((await git(project, 'rev-parse', `${nativeCommit}^`)).trim(), base);
    assert.equal(await git(project, 'show', `${nativeCommit}:qualified-change.txt`),
      'native committed change\n');
    assert.equal(await readFile(join(resource.worktree_path, 'qualified-change.txt'), 'utf8'),
      'native committed change\n');
    assert.equal(await readFile(join(resource.private_git.private_common_dir,
      'hooks', 'hook-marker'), 'utf8'), 'hook-ran');
    assert.equal((await git(project, 'rev-parse', resource.branch_ref)).trim(),
      result.delivery.head_commit);
    assert.equal((await git(project, 'rev-parse', `${result.delivery.head_commit}^{tree}`)).trim(),
      result.delivery.tree_oid);
    assert.equal((await git(project, 'rev-parse', 'main')).trim(), base);
    assert.equal(await readFile(join(pendingObservation.root, 'protected', protectedToken), 'utf8'),
    'protected-no-account-canary');
    if (providerTransportMode) {
      const transport = JSON.parse(await readFile(join(pendingObservation.root,
        'provider-transport-evidence.json'), 'utf8'));
      assert.equal(transport.kind, 'fixture_provider_transport_tls');
      assert.equal(transport.schema_version, 1);
      assert.ok(transport.provider_socket.startsWith(`${join(pendingObservation.root,
        'provider-transport')}/`));
      assert.equal(await lstat(transport.provider_socket).then(() => true,
        error => error.code === 'ENOENT' ? false : Promise.reject(error)), false);
      assert.ok(Array.isArray(transport.observed) && transport.observed.length >= 6);
      assert.ok(transport.observed.every(value => value.tls && value.correct_bearer &&
        value.dummy_absent && value.run_header_absent &&
        (value.method === 'GET' && value.path === '/v1/models' ||
          value.method === 'POST' && value.path === '/v1/responses')));
      evidence.transport = transport;
    }
    assert.equal((await store.readResource(receipt.task_id)).private_git.state, 'published');
    assert.equal((await store.readPrivatePublication(receipt.task_id)).state, 'published');
    evidence.checkpoints.push({ kind: 'verified_publication', at: new Date().toISOString() });
    await save();
    await coordinator.shutdown();
    } catch (cause) {
      if (retainedObservation) {
        evidence.worker_roots ??= [retainedObservation.root, retainedObservation.runtimeRoot];
        evidence.worker_failure = await readFile(join(retainedObservation.root,
          'native-task-failure.json'), 'utf8').then(value => JSON.parse(value), () => null);
      }
      evidence.failure = { code: cause.code ?? 'ERROR',
        message: String(cause.message).slice(0, 400) };
      evidence.checkpoints.push({ kind: 'needs_attention', at: new Date().toISOString() });
      const { current, terminal } = await retainCommitAttention(receipt, evidence, save, store);
      if (!receipt) throw cause;
      if (!terminal) {
        console.log(JSON.stringify({ kind: 'native_commit_needs_attention',
          task_id: receipt.task_id, control_generation: current.control_generation,
          reason: evidence.failure, retained_root: retained,
          required_action: 'explicit exact cancel through this persistent terminal' }));
        channel?.close();
        channel = createInterface({ input: process.stdin });
        for await (const line of channel) {
          let request;
          try { request = JSON.parse(line); } catch { continue; }
          if (Object.keys(request ?? {}).sort().join(',') !==
              'control_generation,kind,operation_key,reason,task_id' ||
              request.kind !== 'cancel' || request.task_id !== receipt.task_id ||
              request.control_generation !== current.control_generation ||
              typeof request.operation_key !== 'string' || !request.operation_key ||
              typeof request.reason !== 'string' || !request.reason) continue;
          evidence.cancel = await coordinator.cancel(receipt.task_id, owner,
            current.control_generation, request.operation_key, request.reason);
          await save().catch(saveError => console.error(JSON.stringify({
            kind: 'native_commit_evidence_write_failed', task_id: receipt.task_id,
            retained_root: retained, message: String(saveError.message).slice(0, 400) })));
          break;
        }
        if (!evidence.cancel) await new Promise(() => undefined);
        let stopped;
        for (;;) {
          stopped = await store.readResult(receipt.task_id);
          if (stopped) break;
          await delay(100);
        }
        evidence.stopped_result = { execution_status: stopped.execution_status,
          worker_stop: stopped.worker_stop, error: stopped.error ?? null };
        await save().catch(saveError => console.error(JSON.stringify({
          kind: 'native_commit_evidence_write_failed', task_id: receipt.task_id,
          retained_root: retained, message: String(saveError.message).slice(0, 400) })));
      }
      throw cause;
    } finally { channel?.close(); }
}

test('installed no-account native private commit awaits a forwarded host human choice',
  { skip: process.env.PASSEUR_MUSE_INSTALLED_COMMIT_TASK !== '1' },
  () => runInstalledPrivateCommit(false));

test('installed no-account actual Muse SDK adapter commits only after confirmed stop',
  { skip: process.env.PASSEUR_MUSE_INSTALLED_SDK_ADAPTER_TASK !== '1' },
  () => runInstalledPrivateCommit(true));

test('installed no-account production protected Muse runtime commits only after observed stop',
  { skip: process.env.PASSEUR_MUSE_INSTALLED_PRODUCTION_RUNTIME_TASK !== '1' },
  () => runInstalledPrivateCommit(true, true));

test('installed no-account Muse composes protected host and fixture local TLS transport',
  { skip: process.env.PASSEUR_MUSE_INSTALLED_PROVIDER_TRANSPORT_TASK !== '1' },
  () => runInstalledPrivateCommit(true, true, true));
