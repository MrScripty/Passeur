import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Coordinator } from '../../.passeur-core/src/core/coordinator.js';
import { AgentRegistry } from '../../.passeur-core/src/agents/registry.js';
import { TaskStore } from '../../.passeur-core/src/store/task-store.js';
import { canonicalHash } from '../../.passeur-core/src/core/async.js';

const exec = promisify(execFile), hash = value => createHash('sha256').update(value).digest('hex');
const hold = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const [root, stage] = process.argv.slice(2);
if (!root || !['reserved', 'partial', 'result', 'observed'].includes(stage)) throw Error('invalid child stage');
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
