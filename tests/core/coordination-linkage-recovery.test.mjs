import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Coordinator, reconcileCoordinatedRecord } from '../../.passeur-core/src/core/coordinator.js';
import { TaskStore } from '../../.passeur-core/src/store/task-store.js';
import { AgentRegistry } from '../../.passeur-core/src/agents/registry.js';
import { reconcileStoredTasks } from '../../.passeur-core/src/core/recovery.js';
import { canonicalHash } from '../../.passeur-core/src/core/async.js';

const exec = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');
const free = () => new AbortController().signal;
const policy = { stop_grace_ms: 1000, max_workers: 1, max_queued_tasks: 1, max_clients: 32,
  max_waiters: 128, max_pending_inputs: 16, max_control_receipts: 512, implementation: { enabled: false } };
const assignment = request_key => ({ schema_version: 3, agent_id: 'fixture', request_key, mode: 'review',
  objective: 'Inspect the admitted source', context: '', acceptance_criteria: ['Report observed result'] });
const result = () => ({ status: 'completed', summary: 'controlled completion', worker_stop: 'confirmed',
  worker_assessment: 'met', blockers: [], questions: [], checks: [] });
function decisionFor(token, marker) {
  const decision_identity = hash(marker), link = { schema_version: 1, task_id: token.task_id,
    request_key: token.request_key, owner_id: token.owner_id, intent_hash: token.intent_hash,
    decision_identity, ...(token.announcement ? { announcement: token.announcement } : {}) };
  return { decision_identity, link_hash: canonicalHash(link) };
}
async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'passeur-link-')), project = join(root, 'project');
  await mkdir(project); await exec('git', ['-C', project, 'init', '-q', '-b', 'main']);
  await exec('git', ['-C', project, 'config', 'user.name', 'Fixture']);
  await exec('git', ['-C', project, 'config', 'user.email', 'fixture@example.invalid']);
  await exec('git', ['-C', project, 'config', 'commit.gpgsign', 'false']);
  await writeFile(join(project, 'seed'), 'seed\n'); await exec('git', ['-C', project, 'add', 'seed']);
  await exec('git', ['-C', project, 'commit', '-qm', 'fixture seed']);
  const base = (await exec('git', ['-C', project, 'rev-parse', 'HEAD'])).stdout.trim();
  const store = new TaskStore(join(root, 'state')); await store.initialize();
  const execution = { ...policy, ...overrides };
  const profile = { schema_version: 3, execution,
    agents: [{ agent_id: 'fixture', adapter_id: 'fixture', description: '', enabled: true, options: {} }] };
  let runs = 0, attachments = 0;
  const registry = new AgentRegistry(profile, { fixture: { configure: () => ({ modes: ['review', 'implement'],
    contract: 'controlled-turn/1', configuration: {}, worker: { run: async input => {
      if (input.request.mode === 'implement') assert.equal(attachments, 1);
      runs++; const turn_id = randomUUID(); await input.onEvent({ kind: 'turn_started', turn_id });
      await input.onEvent({ kind: 'turn_settled', turn_id, terminal: 'completed' }); return result();
    } } }) } });
  const actor = { owner_id: hash(randomUUID()), client_id: randomUUID() };
  const coordinator = new Coordinator(project, 'repository', execution, store, registry);
  const terminalNotifications = [];
  coordinator.onTaskSettled = taskId => terminalNotifications.push(taskId);
  coordinator.onCoordinatedWorkspacePrepared = async () => { attachments++; };
  t.after(async () => { await coordinator.shutdown(); await rm(root, { recursive: true, force: true }); });
  const identity = key => ({ schema_version: 2, source_view: project, assignment: assignment(key) });
  return { store, coordinator, registry, execution, actor, identity, base, project, terminalNotifications,
    runs: () => runs, attachments: () => attachments };
}

test('metadata bind precedes durable admission; exact settlement alone enables one native run', async t => {
  const f = await fixture(t), intent = f.identity('linked');
  const [a, b] = await Promise.all([f.coordinator.reserveCoordinated(intent, f.actor, free()),
    f.coordinator.reserveCoordinated(intent, f.actor, free())]);
  assert.equal(a.task_id, b.task_id); assert.equal(a.status, 'reserved');
  assert.equal((await f.coordinator.reserveCoordinated({ ...intent, expected_decision_identity: hash('fresh preflight') }, f.actor, free())).task_id, a.task_id);
  assert.equal(await f.store.find({ task_id: a.task_id }), undefined);
  assert.equal(f.runs(), 0);
  const decision = decisionFor(a, 'relevant-overlap-set');
  const admitted = await f.coordinator.commitReserved(a, decision);
  assert.equal(admitted.phase, 'queued'); assert.equal(f.runs(), 0);
  assert.equal(await f.store.readCoordinatedLink(a.task_id), undefined);
  await assert.rejects(f.coordinator.activateLinked(a, { ...decision, link_hash: hash('another binding') }), { code: 'COORDINATION_LINK_CONFLICT' });
  assert.equal(f.runs(), 0);
  await f.coordinator.activateLinked(a, decision);
  await f.coordinator.waitForIdle();
  assert.equal(f.runs(), 1); assert.equal(f.attachments(), 0);
  assert.deepEqual(f.terminalNotifications, [a.task_id]);
  assert.equal((await f.store.readCoordinatedLink(a.task_id)).link.link_hash, decision.link_hash);
  assert.equal((await f.coordinator.reserveCoordinated(intent, f.actor, free())).task_id, a.task_id);
  await f.coordinator.activateLinked(a, decision); assert.equal(f.runs(), 1);
});

test('interrupted exact binding can recover its task ID and queued admission is not replayed on reopen', async t => {
  const f = await fixture(t), intent = f.identity('interrupted'), original = randomUUID();
  const token = await f.coordinator.recoverCoordinatedReservation(intent, f.actor, original, free());
  assert.equal(token.task_id, original);
  await assert.rejects(f.coordinator.recoverCoordinatedReservation(intent, f.actor, randomUUID(), free()), { code: 'COORDINATION_LINK_CONFLICT' });
  const decision = decisionFor(token, 'decision');
  await f.coordinator.commitReserved(token, decision);
  await reconcileStoredTasks(f.store);
  assert.equal((await f.store.readControl(original)).phase, 'needs_attention');
  assert.equal((await f.store.readControl(original)).native.state, 'not_started');
  assert.equal(f.runs(), 0);
  await assert.rejects(f.coordinator.commitReserved(token, { ...decision, link_hash: hash('contradiction') }), { code: 'COORDINATION_LINK_CONFLICT' });
  await assert.rejects(f.coordinator.releaseUnadmitted(token), { code: 'COORDINATION_ALREADY_ADMITTED' });
});

test('announced assignment links only its exact immutable payload and a known unadmitted reservation releases capacity', async t => {
  const f = await fixture(t), id = randomUUID(), assignmentValue = assignment('announced');
  await f.store.publishAnnouncement({ schema_version: 1, id, revision: 1, owner_id: f.actor.owner_id,
    source_view: f.identity('announced').source_view, assignment: assignmentValue, published_at: new Date().toISOString() });
  const announced = { schema_version: 2, source_view: f.identity('announced').source_view,
    assignment: assignmentValue, announcement: { id, revision: 1 } };
  const first = await f.coordinator.reserveCoordinated(announced, f.actor, free());
  await assert.rejects(f.coordinator.submit({ schema_version: 1, source_view: announced.source_view, assignment: assignmentValue }, f.actor, free()),
    { code: 'REQUEST_KEY_CONFLICT' });
  await f.coordinator.releaseUnadmitted(first);
  assert.equal(await f.store.find({ task_id: first.task_id }), undefined);
  const second = await f.coordinator.reserveCoordinated(announced, f.actor, free());
  const decision = decisionFor(second, 'announced decision');
  await f.coordinator.commitReserved(second, decision);
  await f.coordinator.activateLinked(second, decision);
  await f.coordinator.waitForIdle();
  assert.equal((await f.store.readAnnouncement(id)).control.task_id, second.task_id);
  assert.equal(f.runs(), 1);
});

test('coordinated implementation attaches the prepared real worktree before native startup', async t => {
  const worktree_root = join(tmpdir(), `passeur-link-worktrees-${randomUUID()}`);
  t.after(() => rm(worktree_root, { recursive: true, force: true }));
  const f = await fixture(t, { implementation: { enabled: true, worktree_root } });
  const intent = f.identity('prepared');
  intent.assignment = { ...intent.assignment, mode: 'implement', base_commit: f.base, target_ref: 'refs/heads/main' };
  const token = await f.coordinator.reserveCoordinated(intent, f.actor, free());
  const decision = decisionFor(token, 'prepared decision');
  await f.coordinator.commitReserved(token, decision);
  await f.coordinator.activateLinked(token, decision);
  await f.coordinator.waitForIdle();
  assert.equal(f.attachments(), 1); assert.equal(f.runs(), 1);
});

test('cancellation after durable admission waits for exact link settlement and never starts native work', async t => {
  const f = await fixture(t), token = await f.coordinator.reserveCoordinated(f.identity('cancel-window'), f.actor, free());
  const decision = decisionFor(token, 'cancel-window');
  const admitted = await f.coordinator.commitReserved(token, decision);
  await f.coordinator.cancel(token.task_id, f.actor, admitted.control_generation, 'cancel-before-settle', 'Operator stopped queued work');
  assert.equal((await f.store.readControl(token.task_id)).phase, 'needs_attention');
  assert.equal((await f.store.readControl(token.task_id)).native.state, 'not_started');
  assert.equal(await f.store.readResult(token.task_id), undefined);
  await reconcileStoredTasks(f.store);
  assert.equal((await f.store.readControl(token.task_id)).native.state, 'not_started');
  assert.equal(f.runs(), 0);
  await f.coordinator.activateLinked(token, decision);
  const settled = await f.store.readControl(token.task_id);
  assert.equal(settled.phase, 'terminal'); assert.equal(settled.outcome, 'cancelled');
  assert.equal((await f.store.readResult(token.task_id)).worker_stop, 'not_started');
  assert.equal((await f.store.readCoordinatedLink(token.task_id)).link.link_hash, decision.link_hash);
  assert.equal(f.runs(), 0);
  assert.deepEqual(f.terminalNotifications, [token.task_id]);
  await f.coordinator.activateLinked(token, decision); assert.equal(f.runs(), 0);
  assert.deepEqual(f.terminalNotifications, [token.task_id]);
});

test('a later metadata announcement revision reuses the original private immutable payload', async t => {
  const f = await fixture(t), id = randomUUID(), assignmentValue = assignment('rebound');
  await f.store.publishAnnouncement({ schema_version: 1, id, revision: 1, owner_id: f.actor.owner_id,
    source_view: f.project, assignment: assignmentValue, published_at: new Date().toISOString() });
  const identity = { schema_version: 2, source_view: f.project, assignment: assignmentValue,
    announcement: { id, revision: 3 } };
  const token = await f.coordinator.reserveCoordinated(identity, f.actor, free());
  const decision = decisionFor(token, 'rebound');
  await f.coordinator.commitReserved(token, decision);
  assert.equal((await f.store.readAnnouncement(id)).control.revision, 1);
  assert.equal((await f.store.durableRequest(token.task_id)).linkage.announcement.revision, 3);
  await f.coordinator.activateLinked(token, decision);
  await f.coordinator.waitForIdle();
  assert.equal((await f.store.readAnnouncement(id)).payload.revision, 1);
  assert.equal((await f.store.readAnnouncement(id)).control.state, 'linked');
  assert.equal((await f.store.readAnnouncement(id)).control.revision, 2);
  assert.equal((await f.store.readCoordinatedLink(token.task_id)).link.announcement.revision, 3);
  assert.equal(f.runs(), 1);
});

test('reopen after settled link but before cancelled result preserves never-started state and exact retry', async t => {
  const f = await fixture(t), intent = f.identity('cancel-link-frontier');
  const token = await f.coordinator.reserveCoordinated(intent, f.actor, free());
  const decision = decisionFor(token, 'cancel-link-frontier');
  const admitted = await f.coordinator.commitReserved(token, decision);
  await f.coordinator.cancel(token.task_id, f.actor, admitted.control_generation, 'stop-frontier', 'No worker needed');
  const record = await f.store.durableRequest(token.task_id);
  await f.store.settleCoordinatedLink(record.linkage);
  assert.equal(await f.store.readResult(token.task_id), undefined);

  const reopenedStore = new TaskStore(f.store.root);
  await reconcileStoredTasks(reopenedStore);
  assert.equal(await reopenedStore.frozenReason(), undefined);
  assert.equal((await reopenedStore.readControl(token.task_id)).native.state, 'not_started');
  const reopened = new Coordinator(f.project, 'repository', f.execution, reopenedStore, f.registry);
  const notices = []; reopened.onTaskSettled = id => notices.push(id);
  t.after(() => reopened.shutdown());
  const retry = await reopened.recoverCoordinatedReservation(intent, f.actor, token.task_id, free());
  assert.equal(retry.status, 'admitted');
  await reopened.activateLinked(retry, decision);
  const state = await reopenedStore.readControl(token.task_id);
  assert.equal(state.phase, 'terminal'); assert.equal(state.outcome, 'cancelled');
  assert.equal((await reopenedStore.readResult(token.task_id)).worker_stop, 'not_started');
  assert.deepEqual(notices, [token.task_id]);
  assert.equal(f.runs(), 0);
});

test('adoption before metadata settlement keeps task control with successor across reopen', async t => {
  const f = await fixture(t), intent = f.identity('adopt-before-settle');
  const token = await f.coordinator.reserveCoordinated(intent, f.actor, free());
  const decision = decisionFor(token, 'adopt-before-settle');
  await f.coordinator.commitReserved(token, decision);
  const successor = { owner_id: hash(randomUUID()), client_id: randomUUID() };
  await f.coordinator.controls.adopt(token.task_id, successor, 'human-confirmed-adoption');
  const reopenedStore = new TaskStore(f.store.root);
  await reconcileStoredTasks(reopenedStore);
  const reopened = new Coordinator(f.project, 'repository', f.execution, reopenedStore, f.registry);
  t.after(() => reopened.shutdown());
  await assert.rejects(reopened.controls.read(token.task_id, f.actor), { code: 'TASK_CONTROL_CONFLICT' });
  await assert.rejects(reopened.reconcileCoordinatedLink(token.task_id, token.request_key, decision.decision_identity, hash('wrong link')),
    { code: 'COORDINATION_LINK_CONFLICT' });
  await reopened.reconcileCoordinatedLink(token.task_id, token.request_key, decision.decision_identity, decision.link_hash);
  assert.equal((await reopenedStore.readCoordinatedLink(token.task_id)).link.owner_id, f.actor.owner_id);
  assert.equal((await reopened.controls.read(token.task_id, successor)).phase, 'needs_attention');
  assert.equal(f.runs(), 0);
  const current = await reopened.controls.read(token.task_id, successor);
  await reopened.cancel(token.task_id, successor, current.control_generation, 'successor-cancel', 'Retire never-started task');
  assert.equal((await reopenedStore.readControl(token.task_id)).outcome, 'cancelled');
  assert.equal((await reopenedStore.readResult(token.task_id)).worker_stop, 'not_started');
  await assert.rejects(reopened.controls.read(token.task_id, f.actor), { code: 'TASK_CONTROL_CONFLICT' });
});

test('service-owned settlement after live adoption starts the accepted task once under successor control', async t => {
  const f = await fixture(t), intent = f.identity('live-adoption');
  const token = await f.coordinator.reserveCoordinated(intent, f.actor, free());
  const decision = decisionFor(token, 'live-adoption');
  await f.coordinator.commitReserved(token, decision);
  const successor = { owner_id: hash(randomUUID()), client_id: randomUUID() };
  await f.coordinator.controls.adopt(token.task_id, successor, 'confirmed-live-adoption');
  await f.coordinator.reconcileCoordinatedLink(token.task_id, token.request_key, decision.decision_identity, decision.link_hash);
  await f.coordinator.waitForIdle();
  assert.equal(f.runs(), 1);
  assert.equal((await f.coordinator.controls.read(token.task_id, successor)).phase, 'terminal');
  await assert.rejects(f.coordinator.controls.read(token.task_id, f.actor), { code: 'TASK_CONTROL_CONFLICT' });
  await f.coordinator.reconcileCoordinatedLink(token.task_id, token.request_key, decision.decision_identity, decision.link_hash);
  assert.equal(f.runs(), 1);
});

test('profile-independent startup settles exact link and cancelled result before terminal control', async t => {
  const f = await fixture(t), intent = f.identity('startup-link');
  const token = await f.coordinator.reserveCoordinated(intent, f.actor, free());
  const decision = decisionFor(token, 'startup-link');
  const admitted = await f.coordinator.commitReserved(token, decision);
  await f.coordinator.cancel(token.task_id, f.actor, admitted.control_generation, 'startup-cancel', 'Stop before startup');
  const reopened = new TaskStore(f.store.root);
  await reconcileStoredTasks(reopened);
  const record = await reopened.durableRequest(token.task_id);
  await assert.rejects(reconcileCoordinatedRecord(reopened, record, { ...record.linkage, link_hash: hash('different') }),
    { code: 'COORDINATION_LINK_CONFLICT' });
  assert.equal(await reconcileCoordinatedRecord(reopened, record, record.linkage), true);
  const state = await reopened.readControl(token.task_id);
  assert.equal(state.phase, 'terminal'); assert.equal(state.outcome, 'cancelled');
  assert.equal(state.native.state, 'not_started');
  assert.equal(state.cancel.reason, 'Stop before startup');
  assert.equal((await reopened.readResult(token.task_id)).worker_stop, 'not_started');
  assert.equal((await reopened.readCoordinatedLink(token.task_id)).link.link_hash, decision.link_hash);
  assert.equal(await reconcileCoordinatedRecord(reopened, record, record.linkage), false);
  assert.equal(f.runs(), 0);
});

test('interrupted cancellation terminal publication reopens from retained result without native replay', async t => {
  const f = await fixture(t), intent = f.identity('cancel-result-frontier');
  const token = await f.coordinator.reserveCoordinated(intent, f.actor, free());
  const decision = decisionFor(token, 'cancel-result-frontier');
  const admitted = await f.coordinator.commitReserved(token, decision);
  await f.coordinator.cancel(token.task_id, f.actor, admitted.control_generation, 'cancel-result-frontier', 'Cancel before worker');
  const reopened = new TaskStore(f.store.root), record = await reopened.durableRequest(token.task_id);
  const writeControl = reopened.writeControl.bind(reopened);
  let interrupted = false;
  reopened.writeControl = async (id, state) => {
    if (!interrupted && state.phase === 'terminal') { interrupted = true; throw Error('injected terminal publication interruption'); }
    return writeControl(id, state);
  };
  await assert.rejects(reconcileCoordinatedRecord(reopened, record, record.linkage), /injected terminal publication interruption/);
  assert.equal((await reopened.readResult(token.task_id)).execution_status, 'cancelled');
  assert.notEqual((await reopened.readControl(token.task_id)).phase, 'terminal');
  reopened.writeControl = writeControl;
  await reconcileStoredTasks(reopened);
  assert.equal((await reopened.readControl(token.task_id)).phase, 'terminal');
  assert.equal((await reopened.readControl(token.task_id)).outcome, 'cancelled');
  assert.equal(f.runs(), 0);
});
