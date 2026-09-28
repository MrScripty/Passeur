import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Coordinator } from '../../.passeur-core/src/core/coordinator.js';
import { AgentRegistry } from '../../.passeur-core/src/agents/registry.js';
import { TaskStore } from '../../.passeur-core/src/store/task-store.js';
import { canonicalHash } from '../../.passeur-core/src/core/async.js';
import { RepositoryRuntime, resolveRepositoryBinding } from '../../.passeur-core/src/core/repository-runtime.js';
import { operatorToken } from '../../.passeur-core/src/service/operator-token.js';
import { serviceFixture } from '../fixtures/structural/service-fixture.mjs';

const exec = promisify(execFile), hash = value => createHash('sha256').update(value).digest('hex');
const hold = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const [root, stage] = process.argv.slice(2);
if (!root || !['reserved', 'partial', 'result', 'observed', 'runtime_receipt'].includes(stage))
  throw Error('invalid child stage');
if (stage === 'runtime_receipt') {
  const fixture = await serviceFixture({ after() {}, name: 'runtime receipt child' });
  await fixture.service.close();
  const intent = { project: fixture.root, stateRoot: fixture.state,
    profilePath: join(fixture.temp, 'missing-profile.json') };
  const binding = await resolveRepositoryBinding(intent, {}, new AbortController().signal);
  const token = await operatorToken(binding, true);
  const actors = [createHash('sha256').update(token).digest('hex'), 'b'.repeat(64), 'c'.repeat(64)]
    .map(owner_id => ({ owner_id, client_id: randomUUID() }));
  const workers = [0, 1, 2].map(index => ({ async run(input) {
    await writeFile(join(input.workspace, 'source.ts'),
      `export function run() { return ${index + 1}; }\n`);
    await input.onEvent({ kind: 'turn_started', turn_id: `initial-${index}`,
      native_session_id: `session-${index}` });
    await input.onEvent({ kind: 'turn_settled', turn_id: `initial-${index}`,
      native_session_id: `session-${index}`, terminal: 'completed' });
    for (;;) {
      const envelope = await input.peer.next();
      if (!envelope) { await new Promise(resolve => setTimeout(resolve, 20)); continue; }
      const turnId = `peer-${index}`;
      await input.onEvent({ kind: 'turn_started', turn_id: turnId,
        native_session_id: `session-${index}` });
      await input.peer.delivered(envelope.idempotency_key, turnId, `session-${index}`);
      await input.onEvent({ kind: 'turn_settled', turn_id: turnId,
        native_session_id: `session-${index}`, terminal: 'completed' });
      await input.peer.observed(envelope.idempotency_key, turnId, `session-${index}`);
    }
  } }));
  const runtimeStore = new TaskStore(binding.storeRoot);
  const runtime = new RepositoryRuntime(intent, { package_version: 'fixture', build_id: 'fixture',
    mode: 'development', node_version: process.version, node_executable: process.execPath,
  pid: process.pid, started_at: new Date().toISOString() }, {
    enableObservedCaseExtensionForTest: true,
    beforeObservedCaseDeliverySettlementForTest: attempt => {
      process.send?.({ stage, temp: fixture.temp, state_root: binding.storeRoot,
        case_id: attempt.case_id, recipient_work_id: attempt.recipient_work_id });
      // The receipt is durable, while the synchronous stop prevents metadata write.
      process.kill(process.pid, 'SIGSTOP');
    },
    store: () => runtimeStore,
    profile: async () => ({ schema_version: 3, execution: {
      stop_grace_ms: 1000, max_workers: 3, max_queued_tasks: 3, max_clients: 32,
      max_waiters: 128, max_pending_inputs: 16, max_control_receipts: 512,
      implementation: { enabled: true, worktree_root: join(fixture.temp, 'managed-worktrees') },
    }, agents: workers.map((_, index) => ({ agent_id: `peer${index}`, adapter_id: `peer${index}`,
      description: '', enabled: true, options: {} })) }),
    definitions: Object.fromEntries(workers.map((worker, index) => [`peer${index}`, {
      configure: () => ({ modes: ['implement'], contract: 'controlled-peer/1', configuration: {}, worker }),
    }])),
  });
  await runtime.coordinate({ schema_version: 1, kind: 'initialize', limits: fixture.limits },
    actors[0], fixture.root);
  const submit = index => runtime.submitCoordinated({ schema_version: 2, kind: 'inline',
    assignment: { schema_version: 3, agent_id: `peer${index}`, request_key: randomUUID(),
      mode: 'implement', objective: `Change source.ts for peer ${index}`, context: '',
      acceptance_criteria: ['Edit source.ts'], allowed_paths: ['source.ts'],
      base_commit: fixture.base, target_ref: 'refs/heads/main' },
  }, actors[index], fixture.root, new AbortController().signal);
  const ids = (await Promise.all([submit(0), submit(1)])).map(item => item.task_id);
  let selectedPair;
  while (!selectedPair) {
    for (let index = 0; index < ids.length; index++) {
      try { await runtime.structuralRefresh(ids[index], actors[index]); }
      catch (error) {
        if (!['STRUCTURAL_SOURCE_FORBIDDEN', 'COORDINATION_NOT_FOUND'].includes(error.code)) throw error;
      }
    }
    const snapshot = JSON.parse(await readFile(
      join(binding.storeRoot, 'coordination', 'control.json'), 'utf8'));
    selectedPair = snapshot.cases.find(item => item.observed_origin === 'selected' && item.inputs.length === 2);
    if (!selectedPair) await new Promise(resolve => setTimeout(resolve, 30));
  }
  ids.push((await submit(2)).task_id);
  for (;;) {
    for (let index = 0; index < ids.length; index++) {
      try { await runtime.structuralRefresh(ids[index], actors[index]); }
      catch (error) {
        if (!['STRUCTURAL_SOURCE_FORBIDDEN', 'COORDINATION_NOT_FOUND'].includes(error.code)) throw error;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 30));
  }
}
const project = join(root, 'project'), stateRoot = join(root, 'state');
await mkdir(project, { recursive: true });
const git = (...args) => exec('git', ['-C', project, ...args]);
await git('init', '-q', '-b', 'main'); await git('config', 'user.name', 'Peer Child');
await git('config', 'user.email', 'peer@example.invalid'); await git('config', 'commit.gpgsign', 'false');
await writeFile(join(project, 'seed'), 'seed\n'); await git('add', 'seed'); await git('commit', '-qm', 'seed');
const base = (await git('rev-parse', 'HEAD')).stdout.trim();
const policy = { stop_grace_ms: 1000, max_workers: 1, max_queued_tasks: 1, max_clients: 8,
  max_waiters: 32, max_pending_inputs: 8, max_control_receipts: 64,
  implementation: { enabled: true, worktree_root: join(root, 'worktrees') } };
const store = new TaskStore(stateRoot); await store.initialize();
const ready = hold(), resume = hold();
const worker = { run: async input => {
  await input.onEvent({ kind: 'turn_started', turn_id: 'initial', native_session_id: 'session-child' });
  await input.onEvent({ kind: 'turn_settled', turn_id: 'initial', native_session_id: 'session-child', terminal: 'completed' });
  ready.resolve(); await resume.promise;
  if (stage === 'observed') {
    const envelope = await input.peer.next();
    await input.onEvent({ kind: 'turn_started', turn_id: 'peer', native_session_id: 'session-child' });
    await input.peer.delivered(envelope.idempotency_key, 'peer', 'session-child');
    await input.onEvent({ kind: 'turn_settled', turn_id: 'peer', native_session_id: 'session-child', terminal: 'completed' });
    await input.peer.observed(envelope.idempotency_key, 'peer', 'session-child');
  }
  return { status: 'completed', summary: 'child completed', worker_stop: 'confirmed', worker_assessment: 'met',
    blockers: [], questions: [], checks: [] };
} };
const registry = new AgentRegistry({ schema_version: 3, execution: policy,
  agents: [{ agent_id: 'fixture', adapter_id: 'fixture', description: '', enabled: true, options: {} }] },
{ fixture: { configure: () => ({ modes: ['implement'], contract: 'child-peer/1', configuration: {}, worker }) } });
const coordinator = new Coordinator(project, 'repository', policy, store, registry);
coordinator.onCoordinatedWorkspacePrepared = async () => {};
coordinator.onAuthorizePeerDelivery = async () => 'current';
const actor = { owner_id: hash(randomUUID()), client_id: randomUUID() };
const identity = { schema_version: 2, source_view: project,
  assignment: { schema_version: 3, agent_id: 'fixture', request_key: `child-${randomUUID()}`, mode: 'implement',
    objective: 'Retain peer completion evidence', context: '', acceptance_criteria: ['Exact result'],
    base_commit: base, target_ref: 'refs/heads/main' } };
const token = await coordinator.reserveCoordinated(identity, actor, new AbortController().signal);
const decision_identity = hash('child decision');
const binding = { schema_version: 1, task_id: token.task_id, request_key: token.request_key,
  owner_id: token.owner_id, intent_hash: token.intent_hash, decision_identity };
const decision = { decision_identity, link_hash: canonicalHash(binding) };
await coordinator.commitReserved(token, decision); await coordinator.activateLinked(token, decision);
await ready.promise;
const control = await store.readControl(token.task_id), resource = await store.readResource(token.task_id);
const recipient = { recipient_task_id: token.task_id, recipient_run_id: control.native.run_id,
  recipient_control_generation: control.control_generation, recipient_workspace: resource.worktree_path,
  recipient_workspace_fingerprint: canonicalHash({ task_id: token.task_id, source_view: project,
    workspace: resource.worktree_path, base_commit: resource.base_commit, branch_ref: resource.branch_ref,
    target_ref: resource.target_ref }) };
const source = { source_work_id: randomUUID(), source_work_revision: 1, case_id: randomUUID(),
  case_revision: 2, case_generation: 1, evidence_id: hash('child evidence'), evidence_revision: 1,
  content: 'Child evidence', evidence_digest: hash('Child evidence'), idempotency_key: 'child-peer' };
let deliveryId;
if (stage === 'observed') {
  deliveryId = (await coordinator.queuePeerDelivery(token.task_id, source)).delivery_id;
  resume.resolve(); await coordinator.waitForIdle();
  process.send?.({ stage, task_id: token.task_id, delivery_id: deliveryId });
} else {
  const bundle = { operation_key: `observed-extension:${randomUUID()}`, request_digest: hash('child request'),
    case_id: source.case_id, expected_case_revision: 1, case_revision: source.case_revision,
    case_generation: source.case_generation, ...recipient,
    sources: [{ work_id: source.source_work_id, work_revision: source.source_work_revision },
      { work_id: randomUUID(), work_revision: 1 }] };
  await coordinator.reservePeerDeliverySlots(bundle);
  if (stage !== 'reserved') deliveryId = (await coordinator.queuePeerDelivery(token.task_id, source, bundle.operation_key)).delivery_id;
  if (stage === 'result') {
    const writeResult = store.writeResult.bind(store);
    store.writeResult = async (id, result) => {
      await writeResult(id, result);
      process.send?.({ stage, task_id: id, delivery_id: deliveryId,
        status: result.execution_status, worker_stop: result.worker_stop });
      await new Promise(() => {});
    };
    resume.resolve();
  } else process.send?.({ stage, task_id: token.task_id, ...(deliveryId ? { delivery_id: deliveryId } : {}) });
}
setInterval(() => {}, 1000);
