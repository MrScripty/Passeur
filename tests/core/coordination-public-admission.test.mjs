// Real Git, TaskStore, lease and coordination metadata; the controlled adapter verifies
// admission ordering only. Installed native-host acceptance is a separate plan gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serviceFixture, request, readRequest, key } from '../fixtures/structural/service-fixture.mjs';
import { managedFixture } from '../fixtures/structural/managed-fixture.mjs';
import { RepositoryRuntime, resolveRepositoryBinding } from '../../.passeur-core/src/core/repository-runtime.js';
import { TaskStore } from '../../.passeur-core/src/store/task-store.js';
import { CoordinationService } from '../../.passeur-core/src/service/coordination.js';
import { TaskControls, initialControl } from '../../.passeur-core/src/core/task-control.js';
import { coordinatedMaterialIdentity } from '../../.passeur-core/src/contracts/tasks.js';
import { canonicalHash } from '../../.passeur-core/src/core/async.js';
import { operatorToken } from '../../.passeur-core/src/service/operator-token.js';

const identity = () => ({ package_version: 'fixture', build_id: 'fixture', mode: 'development', node_version: process.version,
  node_executable: process.execPath, pid: process.pid, started_at: new Date().toISOString() });
const assignment = (base, requestKey = key()) => ({ schema_version: 3, agent_id: 'fixture', request_key: requestKey,
  mode: 'implement', objective: 'Edit one scoped declaration', context: 'Public admission regression',
  acceptance_criteria: ['Retain exact task and source identities'], allowed_paths: ['source.ts'],
  base_commit: base, target_ref: 'refs/heads/main' });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventual(read) {
  for (let attempt = 0; attempt < 250; attempt++) { const result = await read(); if (result) return result; await sleep(10); }
  throw new Error('Expected retained admission did not settle');
}

test('public coordinated inline and reference submissions bind before native eligibility and enroll prepared source', async t => {
  const f = await serviceFixture(t); await f.service.close();
  const intent = { project: f.root, stateRoot: f.state, profilePath: join(f.temp, 'fixture-profile.json') };
  const binding = await resolveRepositoryBinding(intent, {}, new AbortController().signal);
  const token = await operatorToken(binding, true), actor = { owner_id: createHash('sha256').update(token).digest('hex'), client_id: randomUUID() };
  const profile = { schema_version: 3, execution: { stop_grace_ms: 1000, max_workers: 1, max_queued_tasks: 2,
    max_clients: 32, max_waiters: 128, max_pending_inputs: 16, max_control_receipts: 512,
    implementation: { enabled: true, worktree_root: join(f.temp, 'worktrees') } },
    agents: [{ agent_id: 'fixture', adapter_id: 'fixture', description: '', enabled: true, options: {} }] };
  let pendingGate, ownerReadGate;
  class DelayedStore extends TaskStore {
    async writeResource(id, resource) {
      if (resource.state === 'pending' && pendingGate) {
        const gate = pendingGate; pendingGate = undefined; gate.enter(); await gate.released;
      }
      return super.writeResource(id, resource);
    }
    async readControl(id) {
      const state = await super.readControl(id);
      if (ownerReadGate) {
        const gate = ownerReadGate; ownerReadGate = undefined; gate.enter(); await gate.released;
      }
      return state;
    }
  }
  const store = new DelayedStore(binding.storeRoot);
  let starts = 0, observedOwner;
  const definitions = { fixture: { configure: () => ({ modes: ['implement'], contract: 'controlled-turn/1', configuration: {},
    worker: { run: async input => {
      starts++;
      const control = await store.readControl(input.task_id);
      observedOwner = control.owner_id;
      const managed = await runtime.coordinate(readRequest({ kind: 'work', id: input.task_id }),
        { owner_id: control.owner_id, client_id: randomUUID() }, f.root);
      assert.equal(JSON.parse(managed.content).managed.task_id, input.task_id);
      assert.equal((await store.readCoordinatedLink(input.task_id)).state, 'settled');
      const turn_id = randomUUID();
      await input.onEvent({ kind: 'turn_started', turn_id });
      await input.onEvent({ kind: 'turn_settled', turn_id, terminal: 'completed' });
      return { status: 'completed', worker_stop: 'confirmed', worker_assessment: 'met', summary: 'fixture done', blockers: [], questions: [], checks: [] };
    } } }) } };
  const runtime = new RepositoryRuntime(intent, identity(), { profile: async () => profile, definitions,
    store: () => store });
  f.sessions.push({ close: () => runtime.shutdown() });
  const signal = new AbortController().signal;
  await runtime.coordinate(request('initialize', { limits: f.limits }), actor, f.root);

  const inline = { schema_version: 2, kind: 'inline', assignment: assignment(f.base) };
  const preflight = await runtime.preflightCoordinated(inline, actor, f.root, signal);
  assert.match(preflight.decision_identity, /^[a-f0-9]{64}$/);
  const first = await runtime.submitCoordinated({ ...inline, expected_decision_identity: preflight.decision_identity }, actor, f.root, signal);
  assert.equal((await store.durableRequest(first.task_id)).schema_version, 5);
  assert.equal((await runtime.submitCoordinated({ ...inline, expected_decision_identity: preflight.decision_identity }, actor, f.root, signal)).task_id, first.task_id);
  await eventual(async () => (await store.readResult(first.task_id))?.execution_status === 'completed');

  const announced = await runtime.announce({ schema_version: 1, operation_key: key(), assignment: assignment(f.base), readers: [] }, actor, f.root, signal);
  assert.equal(announced.record.state, 'unresolved');
  const referenced = { schema_version: 2, kind: 'reference', announcement: { id: announced.record.id, revision: announced.record.revision } };
  const refPreflight = await runtime.preflightCoordinated(referenced, actor, f.root, signal);
  let entered;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  let release;
  const released = new Promise(resolve => { release = resolve; });
  pendingGate = { enter: entered, released };
  const second = await runtime.submitCoordinated({ ...referenced, expected_decision_identity: refPreflight.decision_identity }, actor, f.root, signal);
  assert.equal((await store.durableRequest(second.task_id)).linkage.announcement.id, announced.record.id);
  await enteredPromise;
  const successor = { owner_id: createHash('sha256').update(randomUUID()).digest('hex'), client_id: randomUUID() };
  let ownerReadEntered;
  const ownerReadEnteredPromise = new Promise(resolve => { ownerReadEntered = resolve; });
  let releaseOwnerRead;
  ownerReadGate = { enter: ownerReadEntered, released: new Promise(resolve => { releaseOwnerRead = resolve; }) };
  release();
  await ownerReadEnteredPromise;
  try { await runtime.attachTask({ task_id: second.task_id }, successor, key()); }
  finally { releaseOwnerRead(); }
  await eventual(async () => (await store.readResult(second.task_id))?.execution_status === 'completed');
  await eventual(async () => {
    const state = JSON.parse(await readFile(join(binding.storeRoot, 'coordination', 'control.json'), 'utf8'));
    const bindingRecord = state.bindings?.find(item => item.task_id === second.task_id);
    return bindingRecord?.state === 'terminal' && bindingRecord.terminal?.outcome === 'completed';
  });
  assert.equal(starts, 2);
  assert.equal(observedOwner, successor.owner_id);
  assert.equal((await runtime.announcement(announced.record.id, actor, f.root, signal)).record.state, 'linked');
});

test('task and metadata adoption together give the new owner fresh source access without reviving an old report', async t => {
  const f = await managedFixture(t);
  await f.initialize();
  const task = await f.addTask();
  await f.enroll(task);
  const old = await f.runtime.structuralReport(task.id, f.ordinary, f.root);
  const successor = { owner_id: createHash('sha256').update(randomUUID()).digest('hex'), client_id: randomUUID() };
  await f.runtime.attachTask({ task_id: task.id }, successor, key());
  const work = await f.get('work', task.id, f.ordinary);
  await f.call({ schema_version: 1, kind: 'recover_metadata', recovery: { kind: 'adopt_work', operation_key: key(),
    epoch: (await f.disk()).epoch, work_id: task.id, expected_owner: work.owner, expected_revision: work.revision,
    new_owner: successor.owner_id, statement: 'Fixture operator transfers the exact managed work to the task owner.' } }, f.operator);
  await assert.rejects(f.runtime.structuralReport(task.id, f.ordinary, f.root), { code: 'COORDINATION_NOT_FOUND' });
  await assert.rejects(f.runtime.structuralDetail(task.id, old.reports[0].report_id, 'observed', 0, 6, successor),
    { code: 'STRUCTURAL_DETAIL_UNAVAILABLE' });
  const fresh = await f.runtime.structuralReport(task.id, successor, f.root);
  assert.equal(fresh.reports.length, 1);
  assert.equal((await f.runtime.structuralDetail(task.id, fresh.reports[0].report_id, 'observed', 0, 6, successor)).text, 'export');
});

test('restart settles exact admitted v5 link after caller adoption without loading a provider or replaying native work', async t => {
  const f = await serviceFixture(t); await f.service.close();
  const intent = { project: f.root, stateRoot: f.state, profilePath: join(f.temp, 'missing-profile.json') };
  const binding = await resolveRepositoryBinding(intent, {}, new AbortController().signal);
  const token = await operatorToken(binding, true);
  const actor = { owner_id: createHash('sha256').update(token).digest('hex'), client_id: randomUUID() };
  const first = new RepositoryRuntime(intent, identity(), {}, {});
  f.sessions.push({ close: () => first.shutdown() });
  await first.coordinate(request('initialize', { limits: f.limits }), actor, f.root);
  await first.shutdown();

  const taskId = randomUUID(), item = assignment(f.base), sourceIdentity = { schema_version: 2, source_view: f.root, assignment: item };
  const intentHash = canonicalHash(coordinatedMaterialIdentity(sourceIdentity));
  const metadata = new CoordinationService({ store_root: binding.storeRoot, repository_id: binding.repositoryId }, {
    assertOwned() {}, async authorizeInitialization() {}, externalWorkspaces: { async assertExternalRegistration() {} },
  }, { ordinary_requests: 16, control_requests: 4, max_source_operations: 4, max_worktrees: 64 });
  const connection = { owner_id: actor.owner_id, source_view: f.root };
  const linked = await metadata.bindSubmission(connection, { operation_key: `passeur-internal:bind:${item.request_key}`,
    task_id: taskId, request_key: item.request_key, source_view: f.root, input_oid: f.base,
    intent_hash: intentHash, areas: [{ kind: 'subtree', path: 'source.ts' }] });
  assert.equal(linked.state, 'bound');
  await metadata.close();
  const store = new TaskStore(binding.storeRoot);
  const policy = { stop_grace_ms: 1000, max_workers: 1, max_queued_tasks: 1, max_clients: 32,
    max_waiters: 128, max_pending_inputs: 16, max_control_receipts: 512, implementation: { enabled: true, worktree_root: join(f.temp, 'worktrees') } };
  const execution = { schema_version: 2, agent_id: 'fixture', adapter_id: 'fixture', adapter_contract: 'controlled-turn/1',
    configuration: {}, configuration_fingerprint: canonicalHash({}), policy };
  const link = { schema_version: 1, task_id: taskId, request_key: item.request_key, owner_id: actor.owner_id,
    intent_hash: intentHash, decision_identity: linked.decision_identity, link_hash: linked.link_hash };
  await store.create({ schema_version: 5, task_id: taskId, project_id: binding.repositoryId, canonical_hash: intentHash,
    accepted_at: new Date().toISOString(), source_view: f.root, initial_owner: actor.owner_id, request: item,
    execution, linkage: link }, initialControl(taskId, actor.owner_id));
  const successor = { owner_id: createHash('sha256').update(randomUUID()).digest('hex'), client_id: randomUUID() };
  await new TaskControls(store, 128, 512).adopt(taskId, successor, key());

  const reopened = new RepositoryRuntime(intent, identity(), {}, {});
  f.sessions.push({ close: () => reopened.shutdown() });
  await reopened.prepare(new AbortController().signal);
  await eventual(async () => (await store.readCoordinatedLink(taskId))?.state === 'settled');
  assert.equal((await store.readControl(taskId)).owner_id, successor.owner_id);
  assert.equal((await store.readControl(taskId)).native.state, 'not_started');
  assert.equal(reopened.status().execution.profile, 'not_checked');
  await assert.rejects(reopened.taskObservation(taskId, actor), { code: 'TASK_CONTROL_CONFLICT' });
  assert.equal((await reopened.taskObservation(taskId, successor)).task_id, taskId);
  const state = JSON.parse(await readFile(join(binding.storeRoot, 'coordination', 'control.json'), 'utf8'));
  assert.equal(state.bindings.find(value => value.task_id === taskId).state, 'settled');
});
