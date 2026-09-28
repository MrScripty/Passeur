import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import { TaskStore } from '../../.passeur-core/src/store/task-store.js';
import { reconcileStoredTasks } from '../../.passeur-core/src/core/recovery.js';
import { TaskControls } from '../../.passeur-core/src/core/task-control.js';

async function stoppedChild(t, stage) {
  const root = await mkdtemp(join(tmpdir(), 'passeur-peer-completion-restart-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const child = fork(new URL('./peer-delivery-completion-child.mjs', import.meta.url), [root, stage],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-4096); });
  let marker, timer;
  try {
    marker = await Promise.race([
      new Promise((resolve, reject) => {
        child.on('message', resolve);
        child.on('error', reject);
        child.on('exit', (code, signal) => reject(Error(`child exited before ${stage}: ${code}/${signal}: ${stderr}`)));
      }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`child ${stage} marker timed out: ${stderr}`)),
        stage === 'runtime_receipt' ? 45_000 : 15_000); }),
    ]);
    assert.equal(marker.stage, stage);
  } finally {
    clearTimeout(timer);
    child.kill('SIGKILL');
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
  }
  if (marker.temp) t.after(() => rm(marker.temp, { recursive: true, force: true }));
  return { root, marker, store: new TaskStore(marker.state_root ?? join(root, 'state')) };
}

for (const stage of ['reserved', 'partial', 'result']) {
  test(`child death after ${stage} preserves peer obligation without inferred completion`, async t => {
    const { store, marker } = await stoppedChild(t, stage);
    const before = await store.readControl(marker.task_id);
    assert.equal(before.schema_version, 3);
    assert.equal(before.peer_delivery_reservations.filter(slot => slot.state === 'reserved').length,
      stage === 'reserved' ? 2 : 1);
    if (stage !== 'reserved') {
      assert.equal(before.peer_delivery_reservations.filter(slot => slot.state === 'consumed').length, 1);
      assert.equal(before.peer_deliveries[0].envelope.delivery_id, marker.delivery_id);
      assert.equal(before.peer_deliveries[0].state, 'queued');
    }
    const saved = await store.readResult(marker.task_id);
    const eventPath = join(store.taskDir(marker.task_id), 'events.ndjson');
    const eventsBefore = await readFile(eventPath, 'utf8');
    if (stage === 'result') {
      assert.equal(marker.status, 'interrupted');
      assert.equal(marker.worker_stop, 'confirmed');
      assert.equal(saved.execution_status, 'interrupted');
      assert.equal(saved.error.code, 'PEER_DELIVERY_RECOVERY_REQUIRED');
      assert.equal(saved.worker_stop, 'confirmed');
      assert.equal(saved.native_evidence.state, 'stopped');
      assert.equal(before.phase, 'finalizing');
      assert.equal(before.settled_outcome, 'interrupted');
    } else assert.equal(saved, undefined);
    await reconcileStoredTasks(store);
    const after = await store.readControl(marker.task_id);
    assert.equal(after.phase, 'needs_attention');
    assert.deepEqual(after.peer_delivery_reservations, before.peer_delivery_reservations);
    assert.deepEqual(after.peer_deliveries, before.peer_deliveries);
    assert.deepEqual(await store.readResult(marker.task_id), saved);
    assert.equal(await readFile(eventPath, 'utf8'), eventsBefore, 'recovery must not replay worker events');
    assert.equal((await store.readResource(marker.task_id)).state, 'pending');
    assert.equal(await store.readPrivatePublication(marker.task_id), undefined);
    assert.match(await store.frozenReason(), /unresolved peer completion/);
  });
}

test('child death after exact observed control retains successful completed evidence on reopen', async t => {
  const { store, marker } = await stoppedChild(t, 'observed');
  const before = await store.readControl(marker.task_id), saved = await store.readResult(marker.task_id);
  assert.equal(before.peer_deliveries[0].state, 'observed');
  assert.equal(before.peer_deliveries[0].envelope.delivery_id, marker.delivery_id);
  assert.equal(saved.execution_status, 'completed');
  await reconcileStoredTasks(store);
  assert.equal((await store.readResult(marker.task_id)).execution_status, 'completed');
  assert.equal((await store.readControl(marker.task_id)).peer_deliveries[0].state, 'observed');
});

test('Runtime child death after exact native receipt retains pending metadata without inferred delivery', async t => {
  const { store, marker } = await stoppedChild(t, 'runtime_receipt');
  const metadataPath = join(marker.state_root, 'coordination', 'control.json');
  const before = JSON.parse(await readFile(metadataPath, 'utf8'));
  const peerCase = before.cases.find(item => item.id === marker.case_id);
  assert.equal(peerCase?.observed_origin, 'selected');
  assert.ok(peerCase.delivery_pending.includes(marker.recipient_work_id));
  assert.ok(!peerCase.delivery_observed.includes(marker.recipient_work_id));
  const recipient = before.works.find(work => work.id === marker.recipient_work_id);
  assert.ok(recipient?.managed?.task_id);
  const taskIds = peerCase.inputs.map(input => before.works.find(work => work.id === input.work_id)?.managed?.task_id);
  assert.ok(taskIds.every(Boolean));
  const controls = await Promise.all(taskIds.map(id => store.readControl(id)));
  const recipientControl = controls[taskIds.indexOf(recipient.managed.task_id)];
  const receipt = recipientControl.peer_deliveries.find(record =>
    record.envelope.case_id === peerCase.id && record.envelope.case_revision === peerCase.revision &&
    record.state === 'observed');
  assert.ok(receipt, 'native observation must be durable before process death');
  assert.equal(receipt.envelope.recipient_task_id, recipient.managed.task_id);
  const envelopesBefore = controls.map(control => control.peer_deliveries);
  const slotsBefore = controls.map(control => control.peer_delivery_reservations);
  const eventsBefore = await Promise.all(taskIds.map(id =>
    readFile(join(store.taskDir(id), 'events.ndjson'), 'utf8')));
  await reconcileStoredTasks(store);
  const reopened = JSON.parse(await readFile(metadataPath, 'utf8'));
  assert.deepEqual(reopened.cases.find(item => item.id === peerCase.id).delivery_pending,
    peerCase.delivery_pending, 'reopen cannot infer metadata settlement from a native receipt');
  assert.deepEqual(reopened.cases.find(item => item.id === peerCase.id).delivery_observed,
    peerCase.delivery_observed);
  const after = await Promise.all(taskIds.map(id => store.readControl(id)));
  assert.deepEqual(after.map(control => control.peer_deliveries), envelopesBefore,
    'reopen cannot append or dispatch a second exact envelope');
  assert.deepEqual(after.map(control => control.peer_delivery_reservations), slotsBefore,
    'reopen cannot release or consume delivery slots by inference');
  assert.deepEqual(await Promise.all(taskIds.map(id =>
    readFile(join(store.taskDir(id), 'events.ndjson'), 'utf8'))), eventsBefore,
  'reopen cannot infer worker continuation');
  assert.ok((await Promise.all(taskIds.map(id => store.readPrivatePublication(id))))
    .every(publication => publication === undefined));
});

test('post-terminal adoption preserves valid earlier observed peer history on reopen', async t => {
  const { store, marker } = await stoppedChild(t, 'observed');
  const first = await store.readControl(marker.task_id);
  assert.equal(first.phase, 'terminal');
  assert.equal(first.control_generation, 1);
  assert.equal(first.peer_deliveries[0].state, 'observed');
  await new TaskControls(store, 32, 64).adopt(marker.task_id,
    { owner_id: createHash('sha256').update('successor').digest('hex'), client_id: randomUUID() },
    'adopt-after-terminal');
  const adopted = await store.readControl(marker.task_id);
  assert.equal(adopted.control_generation, 2);
  assert.equal(adopted.peer_deliveries[0].envelope.recipient_control_generation, 1);
  await reconcileStoredTasks(store);
  assert.equal(await store.frozenReason(), undefined);
  assert.equal((await store.readControl(marker.task_id)).phase, 'terminal');
  assert.equal((await store.readControl(marker.task_id)).outcome, 'completed');
  assert.equal((await store.readResult(marker.task_id)).execution_status, 'completed');
});

test('recovery freezes contradictory retained success without rewriting result or control evidence', async t => {
  const { store, marker } = await stoppedChild(t, 'observed');
  const before = await store.readControl(marker.task_id), saved = await store.readResult(marker.task_id);
  const envelope = before.peer_deliveries[0].envelope;
  const contradictory = { ...before, schema_version: 3, peer_delivery_reservations: [{ schema_version: 1,
    operation_key: `observed-extension:${randomUUID()}`,
    request_digest: createHash('sha256').update('contradiction').digest('hex'),
    case_id: randomUUID(), expected_case_revision: 2, case_revision: 3, case_generation: 1,
    recipient_task_id: marker.task_id, recipient_run_id: before.native.run_id,
    recipient_control_generation: before.control_generation,
    recipient_workspace: envelope.recipient_workspace,
    recipient_workspace_fingerprint: envelope.recipient_workspace_fingerprint,
    source_work_id: randomUUID(), source_work_revision: 1, state: 'reserved' }] };
  await store.writeControl(marker.task_id, contradictory);
  await reconcileStoredTasks(store);
  assert.deepEqual(await store.readControl(marker.task_id), contradictory);
  assert.deepEqual(await store.readResult(marker.task_id), saved);
  assert.match(await store.frozenReason(), /contradictory success with unresolved peer completion/);
});
