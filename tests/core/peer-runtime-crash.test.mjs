import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { serviceFixture } from '../fixtures/structural/service-fixture.mjs';
import { resolveRepositoryBinding } from '../../.passeur-core/src/core/repository-runtime.js';
import { TaskStore } from '../../.passeur-core/src/store/task-store.js';

const peer = fileURLToPath(new URL('../fixtures/structural/peer-runtime-crash.mjs', import.meta.url));

function deadline(promise, milliseconds, stage) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error(`${stage} exceeded ${milliseconds} ms`)), milliseconds);
  })]).finally(() => clearTimeout(timer));
}

function child(configPath, mode) {
  const processPeer = fork(peer, [configPath, mode], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [] });
  let stderr = '';
  processPeer.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-8192); });
  const exit = once(processPeer, 'exit');
  exit.catch(() => {});
  const message = new Promise((resolve, reject) => {
    processPeer.once('message', resolve);
    exit.then(([code, signal]) => reject(Error(`Peer exited before checkpoint (${code}, ${signal}): ${stderr}`)), reject);
  });
  return { processPeer, exit, message, stderr: () => stderr };
}

async function retained(binding, checkpoint) {
  const store = new TaskStore(binding.storeRoot);
  const metadata = JSON.parse(await readFile(join(binding.storeRoot, 'coordination/control.json'), 'utf8'));
  const controls = await Promise.all(checkpoint.ids.map(id => store.readControl(id)));
  const resources = await Promise.all(checkpoint.ids.map(id => store.readResource(id)));
  const deliveries = await Promise.all(checkpoint.ids.map(id => store.readPeerDeliveries(id)));
  const sources = await Promise.all(resources.map(resource => readFile(join(resource.worktree_path, 'source.ts'), 'utf8')));
  return { metadata, controls, resources, deliveries, sources };
}

test('SIGKILL after a real pending observed case leaves exact receipts and blocks fresh Runtime preparation', async t => {
  const fixture = await serviceFixture(t);
  await fixture.service.close();
  const intent = { project: fixture.root, stateRoot: fixture.state,
    profilePath: join(fixture.temp, 'missing-profile.json') };
  const binding = await resolveRepositoryBinding(intent, {}, new AbortController().signal);
  const configPath = join(fixture.temp, `peer-crash-${randomUUID()}.json`);
  await writeFile(configPath, JSON.stringify({ root: fixture.root, state: fixture.state,
    temp: fixture.temp, base: fixture.base, limits: fixture.limits }), { mode: 0o600 });
  const setup = child(configPath, 'setup');
  let recovery;
  fixture.sessions.push({ close: async () => {
    const failures = [];
    for (const entry of [setup, recovery].filter(Boolean)) {
      try {
        if (entry.processPeer.exitCode === null && entry.processPeer.signalCode === null)
          entry.processPeer.kill('SIGKILL');
        await deadline(entry.exit, 10_000, 'fixture process stop');
      } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Fixture child stop was not confirmed');
  } });
  const checkpoint = await deadline(setup.message, 90_000, 'three-worker durable checkpoint');
  assert.equal(checkpoint.kind, 'checkpoint', JSON.stringify(checkpoint));
  const before = await retained(binding, checkpoint);
  const selected = before.metadata.cases.find(item => item.id === checkpoint.case_id);
  assert.equal(selected.observed_origin, 'selected');
  assert.equal(selected.revision, checkpoint.revision);
  assert.deepEqual(selected.inputs.map(item => item.work_id), checkpoint.work_ids);
  assert.ok(selected.inputs.some(item => item.work_id === checkpoint.recipient_work_id));
  assert.ok(selected.delivery_pending.includes(checkpoint.recipient_work_id));
  assert.equal(selected.delivery_observed.filter(item => item.work_id === checkpoint.recipient_work_id).length, 0);
  const observed = before.deliveries[0].find(record => record.envelope.delivery_id === checkpoint.observed_delivery_id);
  const held = before.deliveries[0].find(record => record.envelope.delivery_id === checkpoint.held_delivery_id);
  assert.equal(observed.state, 'observed');
  assert.equal(observed.envelope.case_revision, selected.revision);
  assert.equal(held.state, 'dispatch_intent');
  assert.equal(held.envelope.case_revision, selected.revision);
  assert.ok(before.controls.every(control => control.native.state === 'observed_live'));
  assert.ok(before.controls.every(control => control.schema_version === 3 &&
    control.peer_delivery_reservations.length >= 2), 'three-worker extension retained exact slot accounting');
  assert.ok(before.resources.every(resource => resource.state === 'pending' && resource.worktree_path));
  assert.equal(new Set(before.resources.map(resource => resource.worktree_path)).size, 3);
  assert.equal(new Set(before.sources).size, 3, 'three distinct task source edits remain in their worktrees');

  // Exit observation is registered by child() before the irreversible test signal.
  assert.equal(setup.processPeer.kill('SIGKILL'), true);
  assert.deepEqual(await deadline(setup.exit, 10_000, 'setup SIGKILL'), [null, 'SIGKILL']);
  const afterKill = await retained(binding, checkpoint);
  assert.deepEqual(afterKill.metadata, before.metadata);
  assert.deepEqual(afterKill.deliveries, before.deliveries);
  assert.deepEqual(afterKill.resources, before.resources);
  assert.deepEqual(afterKill.sources, before.sources);

  recovery = child(configPath, 'recover');
  const recovered = await deadline(recovery.message, 30_000, 'default Runtime recovery');
  assert.deepEqual(recovered, { kind: 'recovery', code: 'PROJECT_NEEDS_RECONCILIATION', state: 'blocked' });
  const recoveryExit = await deadline(recovery.exit, 10_000, 'recovery child exit');
  assert.deepEqual(recoveryExit, [0, null],
    JSON.stringify({ recovery: recovered, exit: recoveryExit, stderr: recovery.stderr() }));
  const after = await retained(binding, checkpoint);
  assert.deepEqual(after.metadata, before.metadata, 'recovery cannot infer an observed delivery or case settlement');
  assert.deepEqual(after.resources, before.resources, 'task-owned workspace resource remains retained');
  assert.deepEqual(after.sources, before.sources, 'source edits remain retained for reconciliation');
  for (const [index, control] of after.controls.entries()) {
    assert.equal(control.native.state, 'unknown');
    assert.equal(control.phase, 'needs_attention');
    assert.deepEqual(control.peer_delivery_reservations, before.controls[index].peer_delivery_reservations);
    assert.deepEqual(after.deliveries[index].map(record => record.envelope.delivery_id),
      before.deliveries[index].map(record => record.envelope.delivery_id), 'recovery creates no replay envelope');
  }
  assert.equal(after.deliveries[0].find(record => record.envelope.delivery_id === checkpoint.observed_delivery_id).state, 'observed');
  assert.equal(after.deliveries[0].find(record => record.envelope.delivery_id === checkpoint.held_delivery_id).state, 'unknown');
  assert.ok(after.deliveries.flat().every(record => record.state !== 'delivered'),
    'an uncertain native effect is not inferred as observed');
});
