import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Coordinator } from '../../.passeur-core/src/core/coordinator.js';
import { AgentRegistry } from '../../.passeur-core/src/agents/registry.js';
import { TaskStore } from '../../.passeur-core/src/store/task-store.js';
import { canonicalHash } from '../../.passeur-core/src/core/async.js';
import { reconcileStoredTasks } from '../../.passeur-core/src/core/recovery.js';
import { NativeEvidenceSchema } from '../../.passeur-core/src/contracts/tasks.js';
import { TaskControls } from '../../.passeur-core/src/core/task-control.js';
import { PeerDeliveryRecordSchema } from '../../.passeur-core/src/contracts/peer-delivery.js';
import { decodeState } from '../../.passeur-core/src/store/record-codecs.js';

const exec = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');
const hold = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const done = () => ({ status: 'completed', summary: 'controlled completion', worker_stop: 'confirmed',
  worker_assessment: 'met', blockers: [], questions: [], checks: [] });
const free = () => new AbortController().signal;
const source = (key = 'peer-1') => ({ source_work_id: randomUUID(), source_work_revision: 3, case_id: randomUUID(), case_revision: 2,
  case_generation: 1, evidence_id: hash('evidence'), evidence_revision: 1,
  content: 'Bounded overlap evidence', evidence_digest: hash('Bounded overlap evidence'), idempotency_key: key });
const slotBundle = (recipient, sources) => ({ operation_key: `observed-extension:${randomUUID()}`,
  request_digest: hash(randomUUID()), case_id: randomUUID(), expected_case_revision: 2,
  case_revision: 3, case_generation: 1, recipient_task_id: recipient.recipient_task_id,
  recipient_run_id: recipient.recipient_run_id,
  recipient_control_generation: recipient.recipient_control_generation,
  recipient_workspace: recipient.recipient_workspace,
  recipient_workspace_fingerprint: recipient.recipient_workspace_fingerprint,
  sources: sources.map(work_id => ({ work_id, work_revision: 3 })) });
const reservedSource = (bundle, index, key) => ({ ...source(key), case_id: bundle.case_id,
  case_revision: bundle.case_revision, case_generation: bundle.case_generation,
  source_work_id: bundle.sources[index].work_id, source_work_revision: bundle.sources[index].work_revision });
async function seedPeerDeliveries(f, count) {
  const baseline = await f.coordinator.queuePeerDelivery(f.taskId, source('seed-0'));
  await f.coordinator.controls.change(f.taskId, state => {
    for (let index = 1; index < count; index++) state.peer_deliveries.push({
      envelope: { ...baseline, delivery_id: randomUUID(), idempotency_key: `seed-${index}` },
      state: 'queued', queued_at: new Date().toISOString(),
    });
  });
  return baseline;
}
function decision(token) {
  const decision_identity = hash('peer decision'), binding = { schema_version: 1, task_id: token.task_id,
    request_key: token.request_key, owner_id: token.owner_id, intent_hash: token.intent_hash, decision_identity };
  return { decision_identity, link_hash: canonicalHash(binding) };
}
async function fixture(t, run) {
  const root = await mkdtemp(join(tmpdir(), 'passeur-peer-delivery-'));
  const project = join(root, 'project'), worktrees = join(root, 'worktrees');
  await mkdir(project);
  const git = (...args) => exec('git', ['-C', project, ...args]);
  await git('init', '-q', '-b', 'main'); await git('config', 'user.name', 'Peer Fixture');
  await git('config', 'user.email', 'peer@example.invalid'); await git('config', 'commit.gpgsign', 'false');
  await writeFile(join(project, 'seed'), 'seed\n'); await git('add', 'seed'); await git('commit', '-qm', 'test: seed');
  const base = (await git('rev-parse', 'HEAD')).stdout.trim();
  const policy = { stop_grace_ms: 1000, max_workers: 1, max_queued_tasks: 1, max_clients: 32,
    max_waiters: 128, max_pending_inputs: 16, max_control_receipts: 512,
    implementation: { enabled: true, worktree_root: worktrees } };
  const store = new TaskStore(join(root, 'state')); await store.initialize();
  const profile = { schema_version: 3, execution: policy,
    agents: [{ agent_id: 'fixture', adapter_id: 'fixture', description: '', enabled: true, options: {} }] };
  const registry = new AgentRegistry(profile, { fixture: { configure: () => ({ modes: ['implement'],
    contract: 'controlled-peer/1', configuration: {}, worker: { run } }) } });
  const coordinator = new Coordinator(project, 'repository', policy, store, registry);
  coordinator.onCoordinatedWorkspacePrepared = async () => {};
  const actor = { owner_id: hash(randomUUID()), client_id: randomUUID() };
  t.after(async () => { await coordinator.shutdown(); await rm(root, { recursive: true, force: true }); });
  const assignment = { schema_version: 3, agent_id: 'fixture', request_key: `peer-${randomUUID()}`, mode: 'implement',
    objective: 'Process peer evidence', context: '', acceptance_criteria: ['Return explicit result'],
    base_commit: base, target_ref: 'refs/heads/main' };
  const identity = { schema_version: 2, source_view: project, assignment };
  const token = await coordinator.reserveCoordinated(identity, actor, free());
  const binding = decision(token);
  await coordinator.commitReserved(token, binding);
  await coordinator.activateLinked(token, binding);
  const authorizationChecks = [];
  coordinator.onAuthorizePeerDelivery = async envelope => {
    authorizationChecks.push(structuredClone(envelope));
    let payload;
    try { payload = JSON.parse(envelope.content); } catch { payload = undefined; }
    return envelope.recipient_task_id === token.task_id &&
      envelope.source_work_id.length > 0 && envelope.case_id.length > 0 &&
      (payload === undefined || payload.source_work_id === envelope.source_work_id && payload.case_id === envelope.case_id &&
        typeof payload.source_artifact_id === 'string' && payload.source_artifact_id.length > 0) ? 'current' : 'revoked';
  };
  return { coordinator, store, actor, taskId: token.task_id, authorizationChecks };
}

test('authenticated delivery is durable through queue, intent, native delivery and exact observation', async t => {
  const settled = hold(), proceed = hold(); let worker;
  const f = await fixture(t, async input => {
    worker = input; await input.onEvent({ kind: 'turn_started', turn_id: 'initial', native_session_id: 'session-a' });
    await input.onEvent({ kind: 'turn_settled', turn_id: 'initial', native_session_id: 'session-a', terminal: 'completed' }); settled.resolve();
    await proceed.promise;
    const envelope = await input.peer.next(); assert.equal(Object.isFrozen(envelope), true);
    await input.onEvent({ kind: 'turn_started', turn_id: 'peer-turn', native_session_id: 'session-a' });
    await input.peer.delivered(envelope.idempotency_key, 'peer-turn', 'session-a');
    await input.onEvent({ kind: 'turn_settled', turn_id: 'peer-turn', native_session_id: 'session-a', terminal: 'completed' });
    await input.peer.observed(envelope.idempotency_key, 'peer-turn', 'session-a');
    await input.peer.observed(envelope.idempotency_key, 'peer-turn', 'session-a');
    return done();
  });
  await settled.promise;
  const observedCases = [];
  f.coordinator.onPeerDeliveryObserved = async caseId => { observedCases.push(caseId); throw new Error('advisory wake failed'); };
  const evidence = source();
  const queued = await f.coordinator.queuePeerDelivery(f.taskId, evidence);
  assert.equal(queued.recipient_task_id, f.taskId);
  assert.equal(queued.source_work_revision, evidence.source_work_revision);
  assert.equal(queued.recipient_run_id, (await f.store.readControl(f.taskId)).native.run_id);
  assert.ok(f.authorizationChecks.length > 0);
  assert.ok(f.authorizationChecks.every(envelope => envelope.recipient_task_id === f.taskId));
  assert.deepEqual(await f.coordinator.queuePeerDelivery(f.taskId, evidence), queued);
  await assert.rejects(f.coordinator.queuePeerDelivery(f.taskId, { ...evidence, content: 'changed', evidence_digest: hash('changed') }), { code: 'PEER_DELIVERY_KEY_CONFLICT' });
  await assert.rejects(f.coordinator.queuePeerDelivery(f.taskId, { ...evidence, source_work_revision: 4 }), { code: 'PEER_DELIVERY_KEY_CONFLICT' });
  assert.equal((await f.store.readPeerDeliveries(f.taskId))[0].state, 'queued');
  proceed.resolve(); await f.coordinator.waitForIdle();
  assert.equal((await f.store.readPeerDeliveries(f.taskId))[0].state, 'observed');
  assert.deepEqual(observedCases, [evidence.case_id], 'only the new durable observed receipt wakes reconciliation');
  assert.equal((await f.store.readResult(f.taskId)).execution_status, 'completed');
  assert.equal(worker.task_id, f.taskId);
});

test('two durable extension slots at 62 retained deliveries exclude ordinary enqueue and consume exactly once', async t => {
  const settled = hold(), proceed = hold();
  const f = await fixture(t, async input => {
    await input.onEvent({ kind: 'turn_started', turn_id: 'initial' });
    await input.onEvent({ kind: 'turn_settled', turn_id: 'initial', terminal: 'completed' });
    settled.resolve(); await proceed.promise; return done();
  });
  await settled.promise;
  assert.equal((await f.store.readControl(f.taskId)).schema_version, 2);
  const baseline = await seedPeerDeliveries(f, 62);
  const bundle = slotBundle(baseline, [randomUUID(), randomUUID()]);
  await f.coordinator.reservePeerDeliverySlots(bundle);
  await f.coordinator.reservePeerDeliverySlots(bundle);
  await assert.rejects(f.coordinator.reservePeerDeliverySlots({ ...bundle,
    operation_key: `observed-extension:${randomUUID()}`, request_digest: hash(randomUUID()) }),
  { code: 'PEER_DELIVERY_RESERVATION_CONFLICT' });
  const reserved = await new TaskStore(f.store.root).readControl(f.taskId);
  assert.equal(reserved.schema_version, 3);
  assert.equal(reserved.peer_delivery_reservations.filter(slot => slot.state === 'reserved').length, 2);
  assert.equal(reserved.peer_deliveries.length, 62);
  assert.throws(() => decodeState({ ...reserved, peer_delivery_reservations: [
    ...reserved.peer_delivery_reservations,
    { ...reserved.peer_delivery_reservations[0], source_work_id: randomUUID() },
  ] }), { code: 'STORE_CORRUPT' });
  await assert.rejects(f.coordinator.queuePeerDelivery(f.taskId, source('ordinary-at-cap')),
    { code: 'PEER_DELIVERY_CAPACITY' });
  const first = reservedSource(bundle, 0, 'obligation-a');
  const second = reservedSource(bundle, 1, 'obligation-b');
  await assert.rejects(f.coordinator.queuePeerDelivery(f.taskId, first),
    { code: 'PEER_DELIVERY_RESERVATION_REQUIRED' });
  await assert.rejects(f.coordinator.queuePeerDelivery(f.taskId, first, 'wrong-extension-operation'),
    { code: 'PEER_DELIVERY_RESERVATION_REQUIRED' });
  const firstEnvelope = await f.coordinator.queuePeerDelivery(f.taskId, first, bundle.operation_key);
  assert.deepEqual(await f.coordinator.queuePeerDelivery(f.taskId, first), firstEnvelope);
  assert.equal((await f.store.readControl(f.taskId)).peer_delivery_reservations.find(slot =>
    slot.source_work_id === first.source_work_id).delivery_id, firstEnvelope.delivery_id);
  const secondEnvelope = await f.coordinator.queuePeerDelivery(f.taskId, second, bundle.operation_key);
  const full = await new TaskStore(f.store.root).readControl(f.taskId);
  assert.equal(full.peer_deliveries.length, 64);
  assert.equal(full.peer_delivery_reservations.filter(slot => slot.state === 'consumed').length, 2);
  assert.deepEqual(new Set(full.peer_delivery_reservations.map(slot => slot.delivery_id)),
    new Set([firstEnvelope.delivery_id, secondEnvelope.delivery_id]));
  await assert.rejects(f.coordinator.queuePeerDelivery(f.taskId, source('ordinary-after-cap')),
    { code: 'PEER_DELIVERY_CAPACITY' });
  assert.throws(() => decodeState({ ...full, schema_version: 4 }), { code: 'STORE_VERSION_UNSUPPORTED' });
  proceed.resolve();
});

test('ordinary enqueue winning the 62-slot race prevents an all-or-nothing extension reservation', async t => {
  const settled = hold(), proceed = hold();
  const f = await fixture(t, async input => {
    await input.onEvent({ kind: 'turn_started', turn_id: 'initial' });
    await input.onEvent({ kind: 'turn_settled', turn_id: 'initial', terminal: 'completed' });
    settled.resolve(); await proceed.promise; return done();
  });
  await settled.promise;
  const baseline = await seedPeerDeliveries(f, 62);
  const bundle = slotBundle(baseline, [randomUUID(), randomUUID()]);
  await f.coordinator.queuePeerDelivery(f.taskId, source('ordinary-wins'));
  await assert.rejects(f.coordinator.reservePeerDeliverySlots(bundle), { code: 'PEER_DELIVERY_CAPACITY' });
  const after = await new TaskStore(f.store.root).readControl(f.taskId);
  assert.equal(after.schema_version, 2, 'failed reservation cannot publish a partial schema upgrade');
  assert.equal(after.peer_deliveries.length, 63);
  proceed.resolve();
});

test('partially consumed reservations survive store reopen without creating native liveness', async t => {
  const settled = hold(), proceed = hold();
  const f = await fixture(t, async input => {
    await input.onEvent({ kind: 'turn_started', turn_id: 'initial' });
    await input.onEvent({ kind: 'turn_settled', turn_id: 'initial', terminal: 'completed' });
    settled.resolve(); await proceed.promise; return done();
  });
  try {
    await settled.promise;
    const baseline = await seedPeerDeliveries(f, 62);
    const bundle = slotBundle(baseline, [randomUUID(), randomUUID()]);
    await f.coordinator.reservePeerDeliverySlots(bundle);
    const first = await f.coordinator.queuePeerDelivery(f.taskId, reservedSource(bundle, 0, 'partial-first'), bundle.operation_key);
    const reopened = await new TaskStore(f.store.root).readControl(f.taskId);
    assert.equal(reopened.peer_deliveries.length, 63);
    assert.equal(reopened.peer_delivery_reservations.find(slot => slot.source_work_id === bundle.sources[0].work_id).delivery_id,
      first.delivery_id);
    assert.equal(reopened.peer_delivery_reservations.find(slot => slot.source_work_id === bundle.sources[1].work_id).state,
      'reserved');
    await assert.rejects(f.coordinator.queuePeerDelivery(f.taskId, source('partial-ordinary')),
      { code: 'PEER_DELIVERY_CAPACITY' });
    await f.coordinator.queuePeerDelivery(f.taskId, reservedSource(bundle, 1, 'partial-second'), bundle.operation_key);
  } finally { proceed.resolve(); }
});

test('publication-scoped release wins queued consumption and cannot escape its recipient fence', async t => {
  const settled = hold(), proceed = hold(), entered = hold(), finish = hold();
  const f = await fixture(t, async input => {
    await input.onEvent({ kind: 'turn_started', turn_id: 'initial' });
    await input.onEvent({ kind: 'turn_settled', turn_id: 'initial', terminal: 'completed' });
    settled.resolve(); await proceed.promise; return done();
  });
  try {
    await settled.promise;
    const baseline = await seedPeerDeliveries(f, 62);
    const bundle = slotBundle(baseline, [randomUUID(), randomUUID()]);
    await f.coordinator.reservePeerDeliverySlots(bundle);
    await assert.rejects(f.coordinator.controls.releasePeerDeliverySlotsInPublication(bundle),
      { code: 'PEER_DELIVERY_RESERVATION_SCOPE' });
    await f.coordinator.controls.withTaskPublication([randomUUID()], async () => {
      await assert.rejects(f.coordinator.controls.releasePeerDeliverySlotsInPublication(bundle),
        { code: 'PEER_DELIVERY_RESERVATION_SCOPE' });
    });
    const publication = f.coordinator.controls.withTaskPublication([f.taskId], async () => {
      await assert.rejects(f.coordinator.controls.releasePeerDeliverySlotsInPublication({ ...bundle,
        sources: [bundle.sources[0], { work_id: randomUUID(), work_revision: 3 }] }),
      { code: 'PEER_DELIVERY_RESERVATION_MANIFEST' });
      assert.equal((await f.store.readControl(f.taskId)).peer_delivery_reservations
        .filter(slot => slot.state === 'reserved').length, 2);
      await f.coordinator.controls.releasePeerDeliverySlotsInPublication(bundle);
      await f.coordinator.controls.releasePeerDeliverySlotsInPublication(bundle);
      entered.resolve(); await finish.promise;
    });
    await entered.promise;
    const queued = f.coordinator.queuePeerDelivery(f.taskId, reservedSource(bundle, 0, 'released-slot'), bundle.operation_key);
    finish.resolve(); await publication;
    await assert.rejects(queued, { code: 'PEER_DELIVERY_RESERVATION_RELEASED' });
    await assert.rejects(f.coordinator.reservePeerDeliverySlots(bundle), { code: 'PEER_DELIVERY_RESERVATION_RELEASED' });
    const reopened = await new TaskStore(f.store.root).readControl(f.taskId);
    assert.equal(reopened.peer_delivery_reservations.filter(slot => slot.state === 'released').length, 2);
    const successor = { ...bundle, operation_key: `observed-extension:${randomUUID()}`,
      request_digest: hash(randomUUID()) };
    await f.coordinator.reservePeerDeliverySlots(successor);
    await f.coordinator.queuePeerDelivery(f.taskId, reservedSource(successor, 0, 'successor-first'), successor.operation_key);
    await f.coordinator.queuePeerDelivery(f.taskId, reservedSource(successor, 1, 'successor-second'), successor.operation_key);
    assert.equal((await f.store.readControl(f.taskId)).peer_deliveries.length, 64);
    await assert.rejects(f.coordinator.queuePeerDelivery(f.taskId,
      reservedSource(bundle, 0, 'old-replay'), bundle.operation_key),
    { code: 'PEER_DELIVERY_RESERVATION_RELEASED' });
  } finally { finish.resolve(); proceed.resolve(); }
});

test('consumed slot cannot be released and an unrelated task stays blocked by the full selected publication fence', async t => {
  const settled = hold(), proceed = hold(), entered = hold(), finish = hold();
  const f = await fixture(t, async input => {
    await input.onEvent({ kind: 'turn_started', turn_id: 'initial' });
    await input.onEvent({ kind: 'turn_settled', turn_id: 'initial', terminal: 'completed' });
    settled.resolve(); await proceed.promise; return done();
  });
  try {
    await settled.promise;
    const baseline = await seedPeerDeliveries(f, 62);
    const bundle = slotBundle(baseline, [randomUUID(), randomUUID()]);
    await f.coordinator.reservePeerDeliverySlots(bundle);
    await f.coordinator.queuePeerDelivery(f.taskId, reservedSource(bundle, 0, 'consumption-wins'), bundle.operation_key);
    await f.coordinator.controls.withTaskPublication([f.taskId], async () => {
      await assert.rejects(f.coordinator.controls.releasePeerDeliverySlotsInPublication(bundle),
        { code: 'PEER_DELIVERY_RESERVATION_CONSUMED' });
    });
    const retained = await f.store.readControl(f.taskId);
    assert.equal(retained.peer_delivery_reservations.filter(slot => slot.state === 'reserved').length, 1);
    const other = randomUUID(), third = randomUUID();
    const otherControl = id => ({ ...structuredClone(retained), task_id: id,
      peer_deliveries: [], peer_delivery_reservations: [] });
    const states = new Map([[f.taskId, retained], [other, otherControl(other)], [third, otherControl(third)]]);
    const controls = new TaskControls({
      readControl: async id => structuredClone(states.get(id)),
      writeControl: async (id, state) => { states.set(id, structuredClone(state)); },
      durableRequest: async () => { throw new Error('unused'); },
    }, 8, 64);
    const publication = controls.withTaskPublication([f.taskId, other, third], async () => {
      entered.resolve(); await finish.promise;
    });
    await entered.promise;
    let changed = false;
    const mutation = controls.change(third, state => { state.attention = 'after publication'; changed = true; });
    await Promise.resolve();
    assert.equal(changed, false);
    finish.resolve(); await publication; await mutation;
    assert.equal(changed, true);
  } finally { finish.resolve(); proceed.resolve(); }
});

test('a refreshed source at the full cap reports pending capacity without rewriting historical slots', async t => {
  const settled = hold(), proceed = hold();
  const f = await fixture(t, async input => {
    await input.onEvent({ kind: 'turn_started', turn_id: 'initial' });
    await input.onEvent({ kind: 'turn_settled', turn_id: 'initial', terminal: 'completed' });
    settled.resolve(); await proceed.promise; return done();
  });
  await settled.promise;
  const baseline = await seedPeerDeliveries(f, 62);
  const bundle = slotBundle(baseline, [randomUUID(), randomUUID()]);
  await f.coordinator.reservePeerDeliverySlots(bundle);
  await f.coordinator.queuePeerDelivery(f.taskId, reservedSource(bundle, 0, 'obligation-a'), bundle.operation_key);
  await f.coordinator.queuePeerDelivery(f.taskId, reservedSource(bundle, 1, 'obligation-b'), bundle.operation_key);
  const historical = await new TaskStore(f.store.root).readControl(f.taskId);
  const replacement = { ...reservedSource(bundle, 0, 'replacement'), source_work_revision: 4 };
  await assert.rejects(f.coordinator.queuePeerDelivery(f.taskId, replacement, bundle.operation_key),
    { code: 'PEER_DELIVERY_CAPACITY_PENDING' });
  assert.deepEqual((await new TaskStore(f.store.root).readControl(f.taskId)).peer_delivery_reservations,
    historical.peer_delivery_reservations);
  assert.equal((await f.store.readPeerDeliveries(f.taskId)).length, 64);
  proceed.resolve();
});

test('a keyed current source refresh after slot consumption uses spare ordinary capacity', async t => {
  const settled = hold(), proceed = hold();
  const f = await fixture(t, async input => {
    await input.onEvent({ kind: 'turn_started', turn_id: 'initial' });
    await input.onEvent({ kind: 'turn_settled', turn_id: 'initial', terminal: 'completed' });
    settled.resolve(); await proceed.promise; return done();
  });
  try {
    await settled.promise;
    const baseline = await f.coordinator.queuePeerDelivery(f.taskId, source('refresh-baseline'));
    const bundle = slotBundle(baseline, [randomUUID()]);
    await f.coordinator.reservePeerDeliverySlots(bundle);
    const original = reservedSource(bundle, 0, 'refresh-original');
    const first = await f.coordinator.queuePeerDelivery(f.taskId, original, bundle.operation_key);
    const recaptured = { ...reservedSource(bundle, 0, 'refresh-same-revision'),
      evidence_id: hash('new capture at same work revision'), evidence_revision: 2 };
    const recapturedEnvelope = await f.coordinator.queuePeerDelivery(f.taskId, recaptured, bundle.operation_key);
    assert.notEqual(recapturedEnvelope.delivery_id, first.delivery_id);
    const refreshed = { ...reservedSource(bundle, 0, 'refresh-new'), source_work_revision: 4 };
    await assert.rejects(f.coordinator.queuePeerDelivery(f.taskId, refreshed, 'unknown-extension'),
      { code: 'PEER_DELIVERY_RESERVATION_STALE' });
    const second = await f.coordinator.queuePeerDelivery(f.taskId, refreshed, bundle.operation_key);
    assert.notEqual(second.delivery_id, first.delivery_id);
    assert.deepEqual(await f.coordinator.queuePeerDelivery(f.taskId, refreshed, bundle.operation_key), second);
    const reopened = await new TaskStore(f.store.root).readControl(f.taskId);
    assert.equal(reopened.peer_deliveries.length, 4);
    assert.equal(reopened.peer_delivery_reservations[0].state, 'consumed');
    assert.equal(reopened.peer_delivery_reservations[0].delivery_id, first.delivery_id,
      'new current evidence must retain the original exact slot receipt');
    await f.coordinator.controls.change(f.taskId, state => { state.native.run_id = randomUUID(); });
    await assert.rejects(f.coordinator.queuePeerDelivery(f.taskId,
      { ...reservedSource(bundle, 0, 'refresh-after-run'), source_work_revision: 5 }, bundle.operation_key),
    { code: 'PEER_DELIVERY_RESERVATION_STALE' });
  } finally { proceed.resolve(); }
});

test('replaced native run cannot spend an old extension slot even with spare ordinary capacity', async t => {
  const settled = hold(), proceed = hold();
  const f = await fixture(t, async input => {
    await input.onEvent({ kind: 'turn_started', turn_id: 'initial' });
    await input.onEvent({ kind: 'turn_settled', turn_id: 'initial', terminal: 'completed' });
    settled.resolve(); await proceed.promise; return done();
  });
  try {
    await settled.promise;
    const baseline = await f.coordinator.queuePeerDelivery(f.taskId, source('spare-baseline'));
    const bundle = slotBundle(baseline, [randomUUID()]);
    await f.coordinator.reservePeerDeliverySlots(bundle);
    await f.coordinator.controls.change(f.taskId, state => { state.native.run_id = randomUUID(); });
    await assert.rejects(f.coordinator.queuePeerDelivery(f.taskId,
      reservedSource(bundle, 0, 'replaced-run-extension'), bundle.operation_key),
    { code: 'PEER_DELIVERY_RESERVATION_STALE' });
    const reopened = await new TaskStore(f.store.root).readControl(f.taskId);
    assert.equal(reopened.peer_deliveries.length, 1);
    assert.equal(reopened.peer_delivery_reservations[0].state, 'reserved');
  } finally { proceed.resolve(); }
});

test('cancellation, adoption and replaced runs retain slots without transferring authority', async t => {
  const cases = [
    async (f, bundle) => f.coordinator.controls.cancel(f.taskId, f.actor, 1, 'cancel-slots', 'controlled stop'),
    async (f, bundle) => f.coordinator.controls.adopt(f.taskId,
      { owner_id: hash('new parent'), client_id: randomUUID() }, 'adopt-slots'),
    async (f, bundle) => f.coordinator.controls.change(f.taskId, state => {
      state.native.run_id = randomUUID();
    }),
  ];
  for (const change of cases) {
    const settled = hold(), proceed = hold();
    const f = await fixture(t, async input => {
      await input.onEvent({ kind: 'turn_started', turn_id: 'initial' });
      await input.onEvent({ kind: 'turn_settled', turn_id: 'initial', terminal: 'completed' });
      settled.resolve(); await proceed.promise; return done();
    });
    try {
      await settled.promise;
      const baseline = await seedPeerDeliveries(f, 62);
      const bundle = slotBundle(baseline, [randomUUID(), randomUUID()]);
      await f.coordinator.reservePeerDeliverySlots(bundle);
      await change(f, bundle);
      await assert.rejects(f.coordinator.reservePeerDeliverySlots(bundle),
        { code: 'PEER_DELIVERY_STALE' });
      await assert.rejects(f.coordinator.queuePeerDelivery(f.taskId, reservedSource(bundle, 0, 'old-authority')),
        error => ['PEER_DELIVERY_CANCELLED', 'PEER_DELIVERY_STALE', 'PEER_DELIVERY_CAPACITY_PENDING'].includes(error.code));
      const retained = await new TaskStore(f.store.root).readControl(f.taskId);
      assert.equal(retained.peer_delivery_reservations.filter(slot => slot.state === 'reserved').length, 2);
      assert.equal(retained.peer_deliveries.length, 62);
    } finally { proceed.resolve(); }
  }
});

test('source supersession after native dispatch retains exact historical delivery and observation across reopen', async t => {
  const settled = hold(), proceed = hold(), dispatched = hold(), resume = hold();
  let deliveredStatus, observedStatus, validity = 'current';
  const f = await fixture(t, async input => {
    await input.onEvent({ kind: 'turn_started', turn_id: 'initial', native_session_id: 'session-a' });
    await input.onEvent({ kind: 'turn_settled', turn_id: 'initial', native_session_id: 'session-a', terminal: 'completed' });
    settled.resolve(); await proceed.promise;
    const envelope = await input.peer.next();
    await input.onEvent({ kind: 'turn_started', turn_id: 'peer-native', native_session_id: 'session-a' });
    dispatched.resolve(); await resume.promise;
    await assert.rejects(input.peer.delivered(envelope.idempotency_key, 'wrong-turn', 'session-a'),
      { code: 'PEER_DELIVERY_STALE' });
    deliveredStatus = await input.peer.delivered(envelope.idempotency_key, 'peer-native', 'session-a');
    await input.onEvent({ kind: 'turn_settled', turn_id: 'peer-native', native_session_id: 'session-a', terminal: 'completed' });
    observedStatus = await input.peer.observed(envelope.idempotency_key, 'peer-native', 'session-a');
    return done();
  });
  await settled.promise;
  f.coordinator.onAuthorizePeerDelivery = async () => validity;
  await f.coordinator.queuePeerDelivery(f.taskId, source('historical-native-receipt'));
  proceed.resolve(); await dispatched.promise;
  validity = 'stale'; resume.resolve(); await f.coordinator.waitForIdle();
  assert.equal(deliveredStatus, 'superseded');
  assert.equal(observedStatus, 'superseded');
  const reopened = new TaskStore(f.store.root);
  const [record] = await reopened.readPeerDeliveries(f.taskId);
  assert.equal(record.state, 'observed');
  assert.equal(record.native_turn_id, 'peer-native');
  assert.equal(record.native_session_id, 'session-a');
});

test('source evidence replacement after delivered receipt preserves settled native observation', async t => {
  const settled = hold(), proceed = hold(), nativeDelivered = hold(), resume = hold();
  let observedStatus, validity = 'current';
  const f = await fixture(t, async input => {
    await input.onEvent({ kind: 'turn_started', turn_id: 'initial', native_session_id: 'session-a' });
    await input.onEvent({ kind: 'turn_settled', turn_id: 'initial', native_session_id: 'session-a', terminal: 'completed' });
    settled.resolve(); await proceed.promise;
    const envelope = await input.peer.next();
    await input.onEvent({ kind: 'turn_started', turn_id: 'peer-native', native_session_id: 'session-a' });
    assert.equal(await input.peer.delivered(envelope.idempotency_key, 'peer-native', 'session-a'), 'current');
    nativeDelivered.resolve(); await resume.promise;
    await input.onEvent({ kind: 'turn_settled', turn_id: 'peer-native', native_session_id: 'session-a', terminal: 'completed' });
    observedStatus = await input.peer.observed(envelope.idempotency_key, 'peer-native', 'session-a');
    return done();
  });
  await settled.promise;
  f.coordinator.onAuthorizePeerDelivery = async () => validity;
  await f.coordinator.queuePeerDelivery(f.taskId, source('replacement-after-delivery'));
  proceed.resolve(); await nativeDelivered.promise;
  validity = 'stale'; resume.resolve(); await f.coordinator.waitForIdle();
  assert.equal(observedStatus, 'superseded');
  assert.equal((await f.store.readPeerDeliveries(f.taskId))[0].state, 'observed');
});

test('native session and turn are retained and mismatched peer receipts fail closed', async t => {
  const settled = hold(), proceed = hold();
  const f = await fixture(t, async input => {
    await input.onEvent({ kind: 'turn_started', turn_id: 'initial', native_session_id: 'session-a' });
    await input.onEvent({ kind: 'turn_settled', turn_id: 'initial', native_session_id: 'session-a', terminal: 'completed' });
    settled.resolve(); await proceed.promise;
    const envelope = await input.peer.next();
    await input.onEvent({ kind: 'turn_started', turn_id: 'peer-native', native_session_id: 'session-a' });
    await assert.rejects(input.onEvent({ kind: 'turn_settled', turn_id: 'peer-native', native_session_id: 'session-b', terminal: 'completed' }),
      { code: 'NATIVE_CORRELATION_INVALID' });
    await assert.rejects(input.peer.delivered(envelope.idempotency_key, 'peer-native', 'session-b'), { code: 'PEER_DELIVERY_STALE' });
    await assert.rejects(input.peer.delivered(envelope.idempotency_key, 'peer-native'), { code: 'PEER_DELIVERY_STALE' });
    await assert.rejects(input.peer.delivered(envelope.idempotency_key, 'peer-native', ''), { code: 'PEER_DELIVERY_STALE' });
    await assert.rejects(input.peer.delivered(envelope.idempotency_key, 'peer-native', 'é'.repeat(129)), { code: 'PEER_DELIVERY_STALE' });
    await input.peer.delivered(envelope.idempotency_key, 'peer-native', 'session-a');
    await input.onEvent({ kind: 'turn_settled', turn_id: 'peer-native', native_session_id: 'session-a', terminal: 'completed' });
    await assert.rejects(input.peer.observed(envelope.idempotency_key, 'peer-native', 'session-b'), { code: 'PEER_DELIVERY_STALE' });
    await assert.rejects(input.peer.observed(envelope.idempotency_key, 'other-turn', 'session-a'), { code: 'PEER_DELIVERY_STALE' });
    await input.peer.observed(envelope.idempotency_key, 'peer-native', 'session-a');
    await assert.rejects(input.peer.observed(envelope.idempotency_key, 'peer-native'), { code: 'PEER_DELIVERY_STALE' });
    return done();
  });
  await settled.promise;
  await f.coordinator.queuePeerDelivery(f.taskId, source('session-bound'));
  proceed.resolve(); await f.coordinator.waitForIdle();
  const [delivery] = await f.store.readPeerDeliveries(f.taskId);
  assert.equal(delivery.state, 'observed');
  assert.equal(delivery.native_turn_id, 'peer-native');
  assert.equal(delivery.native_session_id, 'session-a');
  assert.equal((await f.store.readControl(f.taskId)).native.native_session_id, 'session-a');
  const events = (await readFile(join(f.store.taskDir(f.taskId), 'events.ndjson'), 'utf8'))
    .trim().split('\n').map(line => JSON.parse(line).event);
  assert.ok(events.some(event => event.kind === 'turn_started' && event.turn_id === 'peer-native' && event.native_session_id === 'session-a'));
  assert.ok(events.some(event => event.kind === 'peer_delivery' && event.state === 'observed' &&
    event.native_turn_id === 'peer-native' && event.native_session_id === 'session-a'));
});

test('ordinary native sessions are optional but peer delivery evidence requires a bounded session', () => {
  const native = { run_id: randomUUID(), state: 'observed_live', turn_id: 'turn', obligations: [], coverage: 'turn_scoped' };
  assert.equal(NativeEvidenceSchema.safeParse(native).success, true);
  assert.equal(NativeEvidenceSchema.safeParse({ ...native, native_session_id: 's'.repeat(256) }).success, true);
  assert.equal(NativeEvidenceSchema.safeParse({ ...native, native_session_id: 'é'.repeat(129) }).success, false);
  const legacy = { envelope: { schema_version: 1, delivery_id: randomUUID(), idempotency_key: 'legacy',
    recipient_task_id: randomUUID(), recipient_run_id: randomUUID(), recipient_control_generation: 1,
    recipient_workspace: '/work', recipient_workspace_fingerprint: hash('workspace'), ...source('legacy') },
    state: 'delivered', queued_at: new Date().toISOString(), dispatch_intent_at: new Date().toISOString(),
    delivered_at: new Date().toISOString(), native_turn_id: 'turn' };
  assert.equal(PeerDeliveryRecordSchema.safeParse(legacy).success, false);
  assert.equal(PeerDeliveryRecordSchema.safeParse({ ...legacy, native_session_id: 'session' }).success, true);
  assert.equal(PeerDeliveryRecordSchema.safeParse({ ...legacy, native_session_id: '' }).success, false);
  assert.equal(PeerDeliveryRecordSchema.safeParse({ ...legacy, native_session_id: 'x'.repeat(257) }).success, false);
  assert.equal(PeerDeliveryRecordSchema.safeParse({ ...legacy, native_session_id: 'session', native_turn_id: undefined }).success, false);
});

test('a peer receipt without a session is rejected even when native events omit it', async t => {
  const settled = hold(), proceed = hold();
  const f = await fixture(t, async input => {
    await input.onEvent({ kind: 'turn_started', turn_id: 'initial' });
    await input.onEvent({ kind: 'turn_settled', turn_id: 'initial', terminal: 'completed' });
    settled.resolve(); await proceed.promise;
    const envelope = await input.peer.next();
    await input.onEvent({ kind: 'turn_started', turn_id: 'peer' });
    await assert.rejects(input.peer.delivered(envelope.idempotency_key, 'peer'), { code: 'PEER_DELIVERY_STALE' });
    await input.onEvent({ kind: 'turn_settled', turn_id: 'peer', terminal: 'completed' });
    return done();
  });
  await settled.promise;
  await f.coordinator.queuePeerDelivery(f.taskId, source('missing-native-session'));
  proceed.resolve(); await f.coordinator.waitForIdle();
  const [delivery] = await f.store.readPeerDeliveries(f.taskId);
  assert.equal(delivery.state, 'unknown');
  assert.equal(delivery.native_session_id, undefined);
});

test('stale generation and revoked grants retain dispositions and never dispatch', async t => {
  const settled = hold(), proceed = hold(); let port;
  const f = await fixture(t, async input => {
    port = input.peer; await input.onEvent({ kind: 'turn_started', turn_id: 'initial' });
    await input.onEvent({ kind: 'turn_settled', turn_id: 'initial', terminal: 'completed' }); settled.resolve();
    await proceed.promise; await port.next(); return done();
  });
  await settled.promise;
  await f.coordinator.queuePeerDelivery(f.taskId, source('stale'));
  await f.coordinator.controls.adopt(f.taskId, { owner_id: hash('new owner'), client_id: randomUUID() }, 'adopt-peer');
  proceed.resolve(); await f.coordinator.waitForIdle();
  assert.equal((await f.store.readPeerDeliveries(f.taskId))[0].state, 'stale');

  const gate = hold(), finish = hold();
  const g = await fixture(t, async input => {
    await input.onEvent({ kind: 'turn_started', turn_id: 'initial' });
    await input.onEvent({ kind: 'turn_settled', turn_id: 'initial', terminal: 'completed' }); gate.resolve();
    await finish.promise; await input.peer.next(); return done();
  });
  await gate.promise; await g.coordinator.queuePeerDelivery(g.taskId, source('revoked'));
  g.coordinator.onAuthorizePeerDelivery = async () => 'revoked'; finish.resolve();
  await g.coordinator.waitForIdle();
  assert.equal((await g.store.readPeerDeliveries(g.taskId))[0].state, 'revoked');
});

test('queued stale peer evidence wakes one advisory case retry after durable disposition', async t => {
  const settled = hold(), proceed = hold();
  const f = await fixture(t, async input => {
    await input.onEvent({ kind: 'turn_started', turn_id: 'initial' });
    await input.onEvent({ kind: 'turn_settled', turn_id: 'initial', terminal: 'completed' });
    settled.resolve(); await proceed.promise;
    assert.equal(await input.peer.next(), undefined);
    return done();
  });
  await settled.promise;
  let validity = 'current';
  f.coordinator.onAuthorizePeerDelivery = async () => validity;
  const evidence = source('queued-stale-wake');
  await f.coordinator.queuePeerDelivery(f.taskId, evidence);
  const wakes = [];
  f.coordinator.onPeerDeliveryQueuedStale = async caseId => { wakes.push(caseId); throw new Error('advisory wake failed'); };
  validity = 'stale'; proceed.resolve(); await f.coordinator.waitForIdle();
  assert.equal((await f.store.readPeerDeliveries(f.taskId))[0].state, 'stale');
  assert.deepEqual(wakes, [evidence.case_id]);
});

test('a revoked queued head is drained and a current later envelope is dispatched', async t => {
  const settled = hold(), proceed = hold(); let selected;
  const f = await fixture(t, async input => {
    await input.onEvent({ kind: 'turn_started', turn_id: 'initial' });
    await input.onEvent({ kind: 'turn_settled', turn_id: 'initial', terminal: 'completed' }); settled.resolve();
    await proceed.promise;
    selected = await input.peer.next();
    await input.onEvent({ kind: 'turn_started', turn_id: 'peer', native_session_id: 'session-a' });
    await input.peer.delivered(selected.idempotency_key, 'peer', 'session-a');
    await input.onEvent({ kind: 'turn_settled', turn_id: 'peer', native_session_id: 'session-a', terminal: 'completed' });
    await input.peer.observed(selected.idempotency_key, 'peer', 'session-a');
    return done();
  });
  await settled.promise;
  const revokedSource = source('revoked-head'), currentSource = source('current-tail');
  await f.coordinator.queuePeerDelivery(f.taskId, revokedSource);
  await f.coordinator.queuePeerDelivery(f.taskId, currentSource);
  const checked = [];
  f.coordinator.onAuthorizePeerDelivery = async envelope => {
    checked.push([envelope.idempotency_key, envelope.recipient_task_id, envelope.case_id]);
    if (envelope.recipient_task_id !== f.taskId ||
      ![revokedSource.case_id, currentSource.case_id].includes(envelope.case_id)) return 'stale';
    return envelope.idempotency_key === revokedSource.idempotency_key ? 'revoked' : 'current';
  };
  proceed.resolve(); await f.coordinator.waitForIdle();
  assert.equal(selected.idempotency_key, 'current-tail');
  assert.deepEqual((await f.store.readPeerDeliveries(f.taskId)).map(record => record.state), ['revoked', 'observed']);
  assert.ok(checked.some(([key, task, caseId]) => key === 'revoked-head' && task === f.taskId && caseId === revokedSource.case_id));
  assert.ok(checked.some(([key, task, caseId]) => key === 'current-tail' && task === f.taskId && caseId === currentSource.case_id));
  const events = (await readFile(join(f.store.taskDir(f.taskId), 'events.ndjson'), 'utf8'))
    .trim().split('\n').map(line => JSON.parse(line).event).filter(event => event.kind === 'peer_delivery');
  assert.ok(events.some(event => event.idempotency_key === 'revoked-head' && event.state === 'revoked'));
  assert.ok(events.some(event => event.idempotency_key === 'current-tail' && event.state === 'observed'));
});

test('revocation before dispatch and stale duplicate receipt cannot disclose or confirm evidence', async t => {
  const settled = hold(), proceed = hold();
  const f = await fixture(t, async input => {
    await input.onEvent({ kind: 'turn_started', turn_id: 'initial' });
    await input.onEvent({ kind: 'turn_settled', turn_id: 'initial', terminal: 'completed' }); settled.resolve();
    await proceed.promise;
    assert.equal(await input.peer.next(), undefined);
    return done();
  });
  await settled.promise;
  const evidence = source('revoked-before-next');
  await f.coordinator.queuePeerDelivery(f.taskId, evidence);
  f.coordinator.onAuthorizePeerDelivery = async () => 'revoked';
  await assert.rejects(f.coordinator.queuePeerDelivery(f.taskId, evidence), { code: 'PEER_DELIVERY_REVOKED' });
  proceed.resolve(); await f.coordinator.waitForIdle();
  assert.equal((await f.store.readPeerDeliveries(f.taskId))[0].state, 'revoked');
});

test('slow peer authorization does not hold the task cancellation lock', async t => {
  const settled = hold(), entered = hold(), release = hold(), proceed = hold();
  const f = await fixture(t, async input => {
    await input.onEvent({ kind: 'turn_started', turn_id: 'initial' });
    await input.onEvent({ kind: 'turn_settled', turn_id: 'initial', terminal: 'completed' }); settled.resolve();
    await proceed.promise; await input.peer.next(); return done();
  });
  await settled.promise;
  await f.coordinator.queuePeerDelivery(f.taskId, source('slow-auth'));
  f.coordinator.onAuthorizePeerDelivery = async () => { entered.resolve(); await release.promise; return 'current'; };
  proceed.resolve(); await entered.promise;
  await f.coordinator.cancel(f.taskId, f.actor, 1, 'cancel-during-auth', 'controlled cancellation');
  release.resolve(); await f.coordinator.waitForIdle();
  assert.equal((await f.store.readPeerDeliveries(f.taskId))[0].state, 'cancelled');
});

test('dispatch rechecks revocation before returning an envelope to the worker', async t => {
  const settled = hold(), proceed = hold();
  const f = await fixture(t, async input => {
    await input.onEvent({ kind: 'turn_started', turn_id: 'initial' });
    await input.onEvent({ kind: 'turn_settled', turn_id: 'initial', terminal: 'completed' }); settled.resolve();
    await proceed.promise;
    assert.equal(await input.peer.next(), undefined);
    return done();
  });
  await settled.promise;
  await f.coordinator.queuePeerDelivery(f.taskId, source('late-revocation'));
  let calls = 0;
  f.coordinator.onAuthorizePeerDelivery = async () => ++calls === 1 ? 'current' : 'revoked';
  proceed.resolve(); await f.coordinator.waitForIdle();
  assert.equal(calls, 2);
  assert.equal((await f.store.readPeerDeliveries(f.taskId))[0].state, 'revoked');
});

test('duplicate historical observation stays exact while current authority is revoked', async t => {
  const settled = hold(), proceed = hold(); let duplicateStatus;
  const f = await fixture(t, async input => {
    await input.onEvent({ kind: 'turn_started', turn_id: 'initial' });
    await input.onEvent({ kind: 'turn_settled', turn_id: 'initial', terminal: 'completed' }); settled.resolve();
    await proceed.promise;
    const envelope = await input.peer.next();
    await input.onEvent({ kind: 'turn_started', turn_id: 'peer', native_session_id: 'session-a' });
    await input.peer.delivered(envelope.idempotency_key, 'peer', 'session-a');
    await input.onEvent({ kind: 'turn_settled', turn_id: 'peer', native_session_id: 'session-a', terminal: 'completed' });
    await input.peer.observed(envelope.idempotency_key, 'peer', 'session-a');
    f.coordinator.onAuthorizePeerDelivery = async () => 'revoked';
    duplicateStatus = await input.peer.observed(envelope.idempotency_key, 'peer', 'session-a');
    return done();
  });
  await settled.promise;
  await f.coordinator.queuePeerDelivery(f.taskId, source('duplicate-receipt'));
  proceed.resolve(); await f.coordinator.waitForIdle();
  assert.equal(duplicateStatus, 'superseded');
  assert.equal((await f.store.readPeerDeliveries(f.taskId))[0].state, 'observed');
});

test('native unknown and needs attention prevent dispatch of queued evidence', async t => {
  for (const mutation of [state => { state.native.state = 'unknown'; },
    state => { state.phase = 'needs_attention'; }]) {
    const settled = hold(), proceed = hold();
    const f = await fixture(t, async input => {
      await input.onEvent({ kind: 'turn_started', turn_id: 'initial' });
      await input.onEvent({ kind: 'turn_settled', turn_id: 'initial', terminal: 'completed' }); settled.resolve();
      await proceed.promise; assert.equal(await input.peer.next(), undefined); return done();
    });
    await settled.promise;
    await f.coordinator.queuePeerDelivery(f.taskId, source(randomUUID()));
    await f.coordinator.controls.change(f.taskId, mutation);
    proceed.resolve(); await f.coordinator.waitForIdle();
    assert.equal((await f.store.readPeerDeliveries(f.taskId))[0].state, 'stale');
  }
});

test('cancellation and ambiguous dispatch retain unknown without automatic resend', async t => {
  const settled = hold(), dispatch = hold(), intent = hold(), finish = hold(); let next;
  const f = await fixture(t, async input => {
    await input.onEvent({ kind: 'turn_started', turn_id: 'initial' });
    await input.onEvent({ kind: 'turn_settled', turn_id: 'initial', terminal: 'completed' }); settled.resolve();
    await dispatch.promise; const envelope = await input.peer.next(); next = () => input.peer.next(); intent.resolve();
    await finish.promise;
    await assert.rejects(input.peer.delivered(envelope.idempotency_key, 'unstarted-turn', 'session-a'), { code: 'PEER_DELIVERY_STALE' });
    return done();
  });
  await settled.promise; await f.coordinator.queuePeerDelivery(f.taskId, source('ambiguous')); dispatch.resolve(); await intent.promise;
  assert.equal((await f.store.readPeerDeliveries(f.taskId))[0].state, 'dispatch_intent');
  assert.equal(await next(), undefined);
  await f.coordinator.cancel(f.taskId, f.actor, 1, 'cancel-peer', 'controlled cancellation');
  assert.equal((await f.store.readPeerDeliveries(f.taskId))[0].state, 'unknown');
  finish.resolve(); await f.coordinator.waitForIdle();
  assert.equal((await f.store.readPeerDeliveries(f.taskId))[0].state, 'unknown');
  assert.equal((await f.store.readResult(f.taskId)).execution_status, 'cancelled');
  await reconcileStoredTasks(f.store);
  assert.equal((await f.store.readPeerDeliveries(f.taskId))[0].state, 'unknown');
});

test('replaced run and workspace cannot consume retained envelopes', async t => {
  const started = hold(), release = hold(); let peer;
  const f = await fixture(t, async input => {
    peer = input.peer; await input.onEvent({ kind: 'turn_started', turn_id: 'initial' });
    await input.onEvent({ kind: 'turn_settled', turn_id: 'initial', terminal: 'completed' }); started.resolve();
    await release.promise; await peer.next(); return done();
  });
  await started.promise; await f.coordinator.queuePeerDelivery(f.taskId, source('run-replaced'));
  await f.coordinator.controls.change(f.taskId, state => { state.native.run_id = randomUUID(); });
  release.resolve(); await f.coordinator.waitForIdle();
  assert.equal((await f.store.readPeerDeliveries(f.taskId))[0].state, 'replaced');

  const second = hold(), finish = hold();
  const g = await fixture(t, async input => {
    await input.onEvent({ kind: 'turn_started', turn_id: 'initial' });
    await input.onEvent({ kind: 'turn_settled', turn_id: 'initial', terminal: 'completed' }); second.resolve();
    await finish.promise; await input.peer.next(); return done();
  });
  await second.promise; await g.coordinator.queuePeerDelivery(g.taskId, source('workspace-replaced'));
  const resource = await g.store.readResource(g.taskId);
  await g.store.writeResource(g.taskId, { ...resource, worktree_path: join(g.store.root, 'replacement') });
  finish.resolve(); await g.coordinator.waitForIdle();
  assert.equal((await g.store.readPeerDeliveries(g.taskId))[0].state, 'replaced');
});

test('bounded capacity refuses a new delivery before mutation and finalization closes queued work', async t => {
  const started = hold(), finish = hold();
  const f = await fixture(t, async input => {
    await input.onEvent({ kind: 'turn_started', turn_id: 'initial' });
    await input.onEvent({ kind: 'turn_settled', turn_id: 'initial', terminal: 'completed' }); started.resolve();
    await finish.promise; return done();
  });
  await started.promise;
  for (let index = 0; index < 64; index++) await f.coordinator.queuePeerDelivery(f.taskId, source(`capacity-${index}`));
  await assert.rejects(f.coordinator.queuePeerDelivery(f.taskId, source('capacity-64')), { code: 'PEER_DELIVERY_CAPACITY' });
  assert.equal((await f.store.readPeerDeliveries(f.taskId)).length, 64);
  finish.resolve(); await f.coordinator.waitForIdle();
  assert.equal((await f.store.readPeerDeliveries(f.taskId)).every(record => record.state === 'stale'), true);
  await assert.rejects(f.coordinator.queuePeerDelivery(f.taskId, source('after-terminal')), { code: 'PEER_DELIVERY_STALE' });
});
