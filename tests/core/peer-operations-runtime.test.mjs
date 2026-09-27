import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, done, hold } from './helpers.mjs';
import { appendWorkerPeerOperationStartEvent } from '../../.passeur-core/src/core/repository-runtime.js';
import { TaskStore } from '../../.passeur-core/src/store/task-store.js';
import { reconcileStoredTasks } from '../../.passeur-core/src/core/recovery.js';
import { RepositoryRuntime, resolveRepositoryBinding } from '../../.passeur-core/src/core/repository-runtime.js';
import { CoordinationService } from '../../.passeur-core/src/service/coordination.js';
import { TaskControls } from '../../.passeur-core/src/core/task-control.js';
import { BridgeError } from '../../.passeur-core/src/core/errors.js';
import { serviceFixture, request as coordinationRequest, command as coordinationCommand,
  readRequest, key } from '../fixtures/structural/service-fixture.mjs';
import { operatorToken } from '../../.passeur-core/src/service/operator-token.js';
import { PEER_RESOLUTION_ACTIONS } from '../../.passeur-core/src/coordination/peer-resolution.js';

function operation(taskId, runId, kind = 'await_change') {
  const base = { schema_version: 1, task_id: taskId, run_id: runId, control_generation: 1,
    workspace_id: `workspace:${randomUUID()}`, source_view: '/source/repository', case_id: randomUUID(), operation_key: `peer-${randomUUID()}` };
  return kind === 'await_change' ? { ...base, kind, after_case_revision: 3, after_case_generation: 2 } : { ...base, kind };
}

test('task-owned peer intent survives reopen and restart exposes an exact unavailable wait', async t => {
  const f = await fixture(t), id = randomUUID();
  await f.store.create(f.admission(f.request('pending-peer'), id), f.initial(id));
  const request = operation(id, (await f.store.readControl(id)).native.run_id);
  const first = await f.store.startPeerOperation(id, request);
  assert.equal(first.created, true);
  const reopened = new TaskStore(f.state);
  assert.deepEqual((await reopened.readPeerOperation(id, request.operation_key)).request, request);
  assert.equal((await reopened.startPeerOperation(id, request)).created, false);
  await assert.rejects(reopened.startPeerOperation(id, { ...request, after_case_revision: 4 }), { code: 'OPERATION_KEY_CONFLICT' });
  await reconcileStoredTasks(reopened);
  assert.equal((await reopened.readPeerOperation(id, request.operation_key)).disposition, 'unavailable');
  assert.equal((await reopened.startPeerOperation(id, request)).record.disposition, 'unavailable');
  assert.equal((await reopened.readControl(id)).phase, 'needs_attention');
});

test('exact retry of a started peer operation does not append another start event', async t => {
  const f = await fixture(t), id = randomUUID();
  await f.store.create(f.admission(f.request('retry-peer'), id), f.initial(id));
  const request = operation(id, (await f.store.readControl(id)).native.run_id, 'inspect');
  const first = await f.store.startPeerOperation(id, request);
  assert.equal(first.created, true);
  assert.equal(await appendWorkerPeerOperationStartEvent(f.store, id, request, first.created), true);

  const retry = await f.store.startPeerOperation(id, request);
  assert.equal(retry.created, false);
  assert.equal(retry.record.disposition, 'started');
  assert.equal(await appendWorkerPeerOperationStartEvent(f.store, id, request, retry.created), true);

  const events = (await readFile(join(f.store.taskDir(id), 'events.ndjson'), 'utf8'))
    .trim().split('\n').map(line => JSON.parse(line).event);
  assert.equal(events.filter(event => event.kind === 'worker_peer_operation_started' &&
    event.operation_key === request.operation_key).length, 1);
});

test('committed peer result is retrievable by exact key without a second start or result event', async t => {
  const f = await fixture(t), id = randomUUID();
  await f.store.create(f.admission(f.request('peer-result'), id), f.initial(id));
  const request = operation(id, (await f.store.readControl(id)).native.run_id, 'inspect');
  await f.store.startPeerOperation(id, request);
  const result = { ...request, kind: 'current', operation: 'inspect', case_revision: 3, case_generation: 2,
    evidence_id: 'a'.repeat(64), evidence_revision: 3, negotiation_cursor: 'b'.repeat(64),
    proposal_note_id: null, proposal: null, participant_task_ids: [], acknowledged_task_ids: [] };
  await f.store.settlePeerOperation(id, request.operation_key, result);
  assert.equal(await f.store.appendEvent(id, { kind: 'worker_peer_operation', padding: 'x'.repeat(262_144) }), false);
  const reopened = new TaskStore(f.state);
  const retry = await reopened.startPeerOperation(id, request);
  assert.equal(retry.created, false);
  assert.deepEqual(retry.record.result, result);
  assert.deepEqual(await reopened.listPeerOperations(id), [retry.record]);
  assert.deepEqual(await reopened.settlePeerOperation(id, request.operation_key, result), retry.record);
});

test('concurrent exact peer settlements retain one result and reject a conflicting result', async t => {
  const f = await fixture(t), id = randomUUID();
  await f.store.create(f.admission(f.request('racing-peer-result'), id), f.initial(id));
  const request = operation(id, (await f.store.readControl(id)).native.run_id, 'inspect');
  await f.store.startPeerOperation(id, request);
  const result = { ...request, kind: 'current', operation: 'inspect', case_revision: 3, case_generation: 2,
    evidence_id: 'a'.repeat(64), evidence_revision: 3, negotiation_cursor: 'b'.repeat(64),
    proposal_note_id: null, proposal: null, participant_task_ids: [], acknowledged_task_ids: [] };
  const [firstOutcome, secondOutcome] = await Promise.all([
    f.store.settlePeerOperationOutcome(id, request.operation_key, result),
    f.store.settlePeerOperationOutcome(id, request.operation_key, Object.fromEntries(Object.entries(result).reverse())),
  ]);
  const first = firstOutcome.record, second = secondOutcome.record;
  assert.deepEqual([firstOutcome.created, secondOutcome.created].sort(), [false, true]);
  assert.deepEqual(first, second);
  assert.equal(first.disposition, 'settled');
  assert.deepEqual(first.result, result);
  assert.deepEqual((await f.store.startPeerOperation(id, request)).record, first);
  assert.deepEqual(await f.store.readPeerOperation(id, request.operation_key), first);
  await assert.rejects(f.store.settlePeerOperation(id, request.operation_key,
    { ...result, evidence_id: 'c'.repeat(64) }), { code: 'OPERATION_KEY_CONFLICT' });
  assert.deepEqual(await f.store.readPeerOperation(id, request.operation_key), first);
});

test('unsettled peer operation prevents a successful task result', async t => {
  const f = await fixture(t);
  const coordinator = f.coordinator({ run: async input => {
    const control = await f.store.readControl(input.task_id);
    await f.store.startPeerOperation(input.task_id, operation(input.task_id, control.native.run_id));
    return done();
  } });
  t.after(() => coordinator.shutdown());
  const result = await coordinator.execute(f.request('unsettled-peer'));
  assert.equal(result.execution_status, 'interrupted');
  assert.equal(result.error.code, 'PEER_OPERATION_RECOVERY_REQUIRED');
  assert.equal((await f.store.listPeerOperations(result.task_id))[0].disposition, 'started');
});

test('publication reservation keeps callbacks outside task mutexes and orders native changes', async t => {
  const f = await fixture(t), id = randomUUID(), sibling = randomUUID();
  await f.store.create(f.admission(f.request('leased-peer'), id), f.initial(id));
  await f.store.create(f.admission(f.request('leased-sibling'), sibling), f.initial(sibling));
  const controls = new TaskControls(f.store, 8, 32);
  const entered = hold(), publish = hold();
  const peer = controls.withTaskPublication([sibling, id], async () => {
    entered.release();
    assert.equal((await controls.read(id, f.owner)).phase, 'queued');
    await assert.rejects(controls.change(id, state => { state.phase = 'needs_attention'; }),
      { code: 'COORDINATION_TASK_BUSY' });
    await publish.promise;
    assert.equal((await f.store.readControl(id)).phase, 'queued');
    assert.equal((await f.store.readControl(sibling)).phase, 'queued');
    return 'published';
  });
  await entered.promise;
  let nativeChanged = false;
  const native = controls.change(sibling, state => { state.phase = 'needs_attention'; }).then(() => { nativeChanged = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(nativeChanged, false);
  publish.release();
  assert.equal(await peer, 'published');
  await native;
  assert.equal((await f.store.readControl(sibling)).phase, 'needs_attention');
});

test('RepositoryRuntime replays concurrent inspections after settlement conflicts and pre-settlement stale errors', async t => {
  const f = await serviceFixture(t);
  await f.service.close();
  const intent = { project: f.root, stateRoot: f.state, profilePath: join(f.temp, 'fixture-profile.json') };
  const binding = await resolveRepositoryBinding(intent, {}, new AbortController().signal);
  const actor = { owner_id: createHash('sha256').update(await operatorToken(binding, true)).digest('hex'),
    client_id: randomUUID() };
  const ready = hold(), proceed = hold(), inspected = hold(), finish = hold();
  const firstAdvanced = hold(), secondCaptured = hold(), staleSecondEntered = hold();
  let selectedCase, operationResult, acknowledgment, inspections, staleInspections, staleInspectionError, workerInput;
  const profile = { schema_version: 3, execution: { stop_grace_ms: 1000, max_workers: 1, max_queued_tasks: 2,
    max_clients: 32, max_waiters: 128, max_pending_inputs: 16, max_control_receipts: 512,
    implementation: { enabled: true, worktree_root: join(f.temp, 'worktrees') } },
    agents: [{ agent_id: 'fixture', adapter_id: 'fixture', description: '', enabled: true, options: {} }] };
  const definitions = { fixture: { configure: () => ({ modes: ['implement'], contract: 'controlled-peer/1', configuration: {},
    worker: { run: async input => {
      workerInput = input;
      const turn = randomUUID();
      await input.onEvent({ kind: 'turn_started', turn_id: turn });
      await input.onEvent({ kind: 'turn_settled', turn_id: turn, terminal: 'completed' });
      ready.release();
      await proceed.promise;
      operationResult = await input.peer.operation({ schema_version: 1, kind: 'propose', operation_key: 'runtime-propose',
        case_id: selectedCase.id, proposal: selectedCase.proposal });
      acknowledgment = await input.peer.operation({ schema_version: 1, kind: 'acknowledge',
        operation_key: 'runtime-acknowledge', case_id: selectedCase.id, note_id: operationResult.note_id });
      inspections = await Promise.all([0, 1].map(() => input.peer.operation({ schema_version: 1,
        kind: 'inspect', operation_key: 'runtime-concurrent-inspect', case_id: selectedCase.id })));
      try {
        staleInspections = await Promise.all([0, 1].map(() => input.peer.operation({ schema_version: 1,
          kind: 'inspect', operation_key: 'runtime-stale-inspect', case_id: selectedCase.id })));
      } catch (error) { staleInspectionError = error; }
      inspected.release();
      await finish.promise;
      return done();
    } } }) } };
  const runtime = new RepositoryRuntime(intent, { package_version: 'fixture', build_id: 'fixture', mode: 'development',
    node_version: process.version, node_executable: process.execPath, pid: process.pid,
    started_at: new Date().toISOString() }, { profile: async () => profile, definitions });
  f.sessions.push({ close: () => runtime.shutdown() });
  const signal = new AbortController().signal;
  const call = value => runtime.coordinate(value, actor, f.root);
  const read = async (kind, id) => JSON.parse((await call(readRequest({ kind, id }))).content);
  await call(coordinationRequest('initialize', { limits: f.limits }));
  const assignment = { schema_version: 3, agent_id: 'fixture', request_key: key(), mode: 'implement',
    objective: 'Record one controlled proposal', context: '', acceptance_criteria: ['Retain the proposal'],
    allowed_paths: ['source.ts'], base_commit: f.base, target_ref: 'refs/heads/main' };
  const submission = { schema_version: 2, kind: 'inline', assignment };
  const preflight = await runtime.preflightCoordinated(submission, actor, f.root, signal);
  const task = await runtime.submitCoordinated({ ...submission, expected_decision_identity: preflight.decision_identity },
    actor, f.root, signal);
  await ready.promise;
  const work = await read('work', task.task_id);
  const claimed = await call(coordinationCommand({ kind: 'claim_target', operation_key: key(), target: 'refs/heads/main', members: [] }));
  let item = await read('case', claimed.receipt.item_id);
  await call(coordinationCommand({ kind: 'select_inputs', operation_key: key(), case_id: item.id,
    expected_revision: item.revision, generation: item.generation, target_oid: f.base,
    inputs: [{ work_id: task.task_id, commit_oid: f.base }] }));
  item = await read('case', item.id);
  selectedCase = { id: item.id, proposal: { schema_version: 1, kind: 'peer_resolution_proposal',
    case_id: item.id, case_revision: item.revision, case_generation: item.generation,
    proposal_revision: 1, evidence_id: 'a'.repeat(64), evidence_revision: 1,
    participants: [actor.owner_id], sources: [{ work_id: work.id, work_revision: work.revision,
      input_oid: work.input_oid, selected_commit_oid: f.base }], scope: [{ kind: 'file', path: 'source.ts' }],
    action: 'propose', resolution_digest: 'b'.repeat(64), predecessor_digest: null,
    permitted_actions: [...PEER_RESOLUTION_ACTIONS] } };
  // Advance metadata after control captures an inspection but before runtime
  // settles and discloses it. The exact concurrent callers must replay the
  // durable winner, even though its cursor is now historical.
  const originalPeerOperation = CoordinationService.prototype.workerPeerOperation;
  let advancedBeforeSettlement = false, inspectionCallCount = 0, staleCallCount = 0;
  const capturedInspections = [];
  CoordinationService.prototype.workerPeerOperation = async function (...args) {
    if (args[2].kind !== 'inspect') return originalPeerOperation.apply(this, args);
    if (args[2].operation_key === 'runtime-stale-inspect') {
      if (staleCallCount++ === 0) {
        const captured = await originalPeerOperation.apply(this, args);
        await staleSecondEntered.promise;
        return captured;
      }
      staleSecondEntered.release();
      const store = new TaskStore(binding.storeRoot), deadline = Date.now() + 5000;
      let settled;
      while (Date.now() < deadline && !settled) {
        const record = await store.readPeerOperation(task.task_id, 'runtime-stale-inspect');
        if (record?.disposition === 'settled') settled = record;
        else await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(settled, 'first stale-path inspection did not settle');
      throw new BridgeError('PEER_OPERATION_STALE', 'Peer metadata changed repeatedly during authority validation');
    }
    const position = inspectionCallCount++;
    if (position === 1) await firstAdvanced.promise;
    const captured = await originalPeerOperation.apply(this, args);
    capturedInspections[position] = captured;
    if (position === 0) {
      advancedBeforeSettlement = true;
      await call(coordinationCommand({ kind: 'post_note', operation_key: key(),
        subject: { kind: 'case', id: selectedCase.id }, note_kind: 'statement',
        text: 'Advance the negotiation cursor before durable settlement', parties: [] }));
      firstAdvanced.release();
      await secondCaptured.promise;
    } else if (position === 1) {
      secondCaptured.release();
      const store = new TaskStore(binding.storeRoot), deadline = Date.now() + 5000;
      let settled;
      while (Date.now() < deadline && !settled) {
        const record = await store.readPeerOperation(task.task_id, 'runtime-concurrent-inspect');
        if (record?.disposition === 'settled') settled = record;
        else await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(settled, 'first inspection did not settle');
    }
    return captured;
  };
  t.after(() => { CoordinationService.prototype.workerPeerOperation = originalPeerOperation; });
  proceed.release();
  await inspected.promise;
  assert.equal(acknowledgment.operation, 'acknowledge');
  const originalPublication = TaskControls.prototype.withTaskPublication;
  const changedTurn = randomUUID();
  let consentRace = false;
  TaskControls.prototype.withTaskPublication = async function (ids, publish) {
    if (ids.includes(task.task_id) && !consentRace) {
      consentRace = true;
      await workerInput.onEvent({ kind: 'turn_started', turn_id: changedTurn });
    }
    return originalPublication.call(this, ids, publish);
  };
  try {
    await assert.rejects(call(readRequest({ kind: 'note', id: operationResult.note_id })),
      { code: 'PEER_OPERATION_STALE' });
    assert.equal(consentRace, true);
  } finally {
    TaskControls.prototype.withTaskPublication = originalPublication;
    await workerInput.onEvent({ kind: 'turn_settled', turn_id: changedTurn, terminal: 'completed' });
    finish.release();
  }
  let outcome;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !outcome) {
    outcome = (await runtime.result(task.task_id)).result;
    if (!outcome) await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(outcome, 'mutating peer operation did not complete');
  assert.equal(outcome.execution_status, 'completed');
  assert.equal(operationResult.kind, 'receipt');
  assert.equal(operationResult.operation, 'propose');
  assert.equal(advancedBeforeSettlement, true);
  assert.notEqual(capturedInspections[0].negotiation_cursor, capturedInspections[1].negotiation_cursor);
  assert.deepEqual(inspections[0], inspections[1]);
  assert.deepEqual(inspections[0], capturedInspections[0]);
  await t.test('pre-settlement stale error replays the exact settled result', () => {
    assert.equal(staleCallCount, 2);
    assert.ifError(staleInspectionError);
    assert.deepEqual(staleInspections[0], staleInspections[1]);
  });
  assert.equal(inspections[0].kind, 'current');
  assert.equal((await new TaskStore(binding.storeRoot).readPeerOperation(task.task_id, 'runtime-propose')).disposition, 'settled');
  assert.equal((await new TaskStore(binding.storeRoot).readPeerOperation(task.task_id, 'runtime-concurrent-inspect')).disposition, 'settled');
  assert.equal((await new TaskStore(binding.storeRoot).readPeerOperation(task.task_id, 'runtime-stale-inspect')).disposition, 'settled');
});

test('native turn change between validation and reservation rejects worker publication', async t => {
  const f = await serviceFixture(t);
  await f.service.close();
  const intent = { project: f.root, stateRoot: f.state, profilePath: join(f.temp, 'fixture-profile.json') };
  const binding = await resolveRepositoryBinding(intent, {}, new AbortController().signal);
  const actor = { owner_id: createHash('sha256').update(await operatorToken(binding, true)).digest('hex'),
    client_id: randomUUID() };
  const ready = hold(), proceed = hold();
  let workerInput, failure;
  const profile = { schema_version: 3, execution: { stop_grace_ms: 1000, max_workers: 1, max_queued_tasks: 2,
    max_clients: 32, max_waiters: 128, max_pending_inputs: 16, max_control_receipts: 512,
    implementation: { enabled: true, worktree_root: join(f.temp, 'worktrees') } },
    agents: [{ agent_id: 'fixture', adapter_id: 'fixture', description: '', enabled: true, options: {} }] };
  const definitions = { fixture: { configure: () => ({ modes: ['implement'], contract: 'controlled-peer/1', configuration: {},
    worker: { run: async input => {
      workerInput = input;
      const settledTurn = randomUUID();
      await input.onEvent({ kind: 'turn_started', turn_id: settledTurn });
      await input.onEvent({ kind: 'turn_settled', turn_id: settledTurn, terminal: 'completed' });
      ready.release();
      await proceed.promise;
      try { await input.peer.operation({ schema_version: 1, kind: 'inspect',
        operation_key: 'native-race-inspect', case_id: selectedCaseId }); }
      catch (error) { failure = error; }
      await input.onEvent({ kind: 'turn_settled', turn_id: changedTurnId, terminal: 'completed' });
      return done();
    } } }) } };
  const runtime = new RepositoryRuntime(intent, { package_version: 'fixture', build_id: 'fixture', mode: 'development',
    node_version: process.version, node_executable: process.execPath, pid: process.pid,
    started_at: new Date().toISOString() }, { profile: async () => profile, definitions });
  f.sessions.push({ close: () => runtime.shutdown() });
  const call = value => runtime.coordinate(value, actor, f.root);
  await call(coordinationRequest('initialize', { limits: f.limits }));
  const assignment = { schema_version: 3, agent_id: 'fixture', request_key: key(), mode: 'implement',
    objective: 'Inspect one selected case', context: '', acceptance_criteria: ['Inspect the case'],
    allowed_paths: ['source.ts'], base_commit: f.base, target_ref: 'refs/heads/main' };
  const submission = { schema_version: 2, kind: 'inline', assignment };
  const signal = new AbortController().signal;
  const preflight = await runtime.preflightCoordinated(submission, actor, f.root, signal);
  const task = await runtime.submitCoordinated({ ...submission, expected_decision_identity: preflight.decision_identity },
    actor, f.root, signal);
  await ready.promise;
  const claimed = await call(coordinationCommand({ kind: 'claim_target', operation_key: key(),
    target: 'refs/heads/main', members: [] }));
  let item = JSON.parse((await call(readRequest({ kind: 'case', id: claimed.receipt.item_id }))).content);
  await call(coordinationCommand({ kind: 'select_inputs', operation_key: key(), case_id: item.id,
    expected_revision: item.revision, generation: item.generation, target_oid: f.base,
    inputs: [{ work_id: task.task_id, commit_oid: f.base }] }));
  item = JSON.parse((await call(readRequest({ kind: 'case', id: item.id }))).content);
  const selectedCaseId = item.id;
  const originalPublication = TaskControls.prototype.withTaskPublication;
  let changedBeforeReservation = false;
  TaskControls.prototype.withTaskPublication = async function (ids, publish) {
    if (ids.includes(task.task_id) && !changedBeforeReservation) {
      changedBeforeReservation = true;
      await workerInput.onEvent({ kind: 'turn_started', turn_id: changedTurnId });
    }
    return originalPublication.call(this, ids, publish);
  };
  const changedTurnId = randomUUID();
  t.after(() => { TaskControls.prototype.withTaskPublication = originalPublication; });
  proceed.release();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !failure) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(changedBeforeReservation, true);
  assert.equal(failure?.code, 'PEER_OPERATION_STALE');
  assert.equal((await new TaskStore(binding.storeRoot).readPeerOperation(task.task_id, 'native-race-inspect')).disposition,
    'started');
  let outcome;
  while (Date.now() < deadline && !outcome) {
    outcome = (await runtime.result(task.task_id)).result;
    if (!outcome) await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(outcome?.error?.code, 'PEER_OPERATION_RECOVERY_REQUIRED');
});

test('rejected cancellation does not notify the peer task owner', async t => {
  const f = await fixture(t), id = randomUUID();
  await f.store.create(f.admission(f.request('cancel-peer'), id), f.initial(id));
  const binding = await resolveRepositoryBinding({ project: f.root, stateRoot: f.state }, {}, new AbortController().signal);
  const identity = { package_version: 'fixture', build_id: 'fixture', mode: 'development',
    node_version: process.version, node_executable: process.execPath, pid: process.pid,
    started_at: new Date().toISOString() };
  const runtime = new RepositoryRuntime({ project: f.root, stateRoot: f.state }, identity, {
    resolveBinding: async () => binding,
    acquire: async () => ({ state: 'held', assertOwned() {}, async release() {} }),
    store: () => f.store, legacyRoots: async () => [], recover: async () => {},
  });
  t.after(() => runtime.shutdown());
  await runtime.prepare();
  await runtime.coordinate({ schema_version: 1, kind: 'identity' }, f.owner, f.root);

  const original = CoordinationService.prototype.invalidateCancelledTask;
  let entered = 0;
  CoordinationService.prototype.invalidateCancelledTask = function (...args) {
    entered++;
    return original.apply(this, args);
  };
  try {
    const alien = { ...f.owner, owner_id: 'f'.repeat(64) };
    await assert.rejects(runtime.cancelTask(id, alien, 1, 'alien-cancel', 'Unauthorized'),
      { code: 'TASK_CONTROL_CONFLICT' });
    await assert.rejects(runtime.cancelTask(id, f.owner, 2, 'stale-cancel', 'Stale generation'),
      { code: 'STALE_CONTROL' });
    assert.equal(entered, 0);
    assert.equal((await f.store.readControl(id)).cancel, undefined);

    await new TaskControls(f.store, 8, 32).adopt(id, f.owner, 'conflicting-key');
    await assert.rejects(runtime.cancelTask(id, f.owner, 2, 'conflicting-key', 'Conflicting intent'),
      { code: 'OPERATION_KEY_CONFLICT' });
    assert.equal(entered, 0);
    assert.equal((await f.store.readControl(id)).cancel, undefined);

    const receipt = await runtime.cancelTask(id, f.owner, 2, 'authorized-cancel', 'Authorized stop');
    assert.equal(receipt.outcome, 'accepted');
    assert.equal(entered, 1);
    assert.equal((await f.store.readControl(id)).cancel.operation_key, 'authorized-cancel');
    assert.deepEqual(await runtime.cancelTask(id, f.owner, 2, 'authorized-cancel', 'Authorized stop'), receipt);
    assert.equal(entered, 2);
  } finally {
    CoordinationService.prototype.invalidateCancelledTask = original;
  }
});

test('a consumed control key cannot commit cancellation or notify metadata', async t => {
  const f = await fixture(t), id = randomUUID();
  await f.store.create(f.admission(f.request('raced-cancel-peer'), id), f.initial(id));
  const binding = await resolveRepositoryBinding({ project: f.root, stateRoot: f.state }, {}, new AbortController().signal);
  const runtime = new RepositoryRuntime({ project: f.root, stateRoot: f.state }, {
    package_version: 'fixture', build_id: 'fixture', mode: 'development', node_version: process.version,
    node_executable: process.execPath, pid: process.pid, started_at: new Date().toISOString(),
  }, { resolveBinding: async () => binding, acquire: async () => ({ state: 'held', assertOwned() {}, async release() {} }),
    store: () => f.store, legacyRoots: async () => [], recover: async () => {} });
  t.after(() => runtime.shutdown());
  await runtime.prepare();
  await runtime.coordinate({ schema_version: 1, kind: 'identity' }, f.owner, f.root);
  const transition = CoordinationService.prototype.invalidateCancelledTask;
  let entered = 0;
  await new TaskControls(f.store, 8, 32).change(id, state => {
    state.receipts.push({ operation_key: 'raced-key', kind: 'attach',
      hash: 'a'.repeat(64), outcome: 'adopted', at: new Date().toISOString(), generation: 1 }); });
  CoordinationService.prototype.invalidateCancelledTask = function (...args) {
    entered++; return transition.apply(this, args);
  };
  try {
    await assert.rejects(runtime.cancelTask(id, f.owner, 1, 'raced-key', 'Stop'), { code: 'OPERATION_KEY_CONFLICT' });
    assert.equal(entered, 0);
    assert.equal((await f.store.readControl(id)).cancel, undefined);
  } finally {
    CoordinationService.prototype.invalidateCancelledTask = transition;
  }
});

test('committed cancellation still aborts native work after control generation changes', async t => {
  const f = await fixture(t), running = hold(), stopped = hold();
  let abortReason;
  const coordinator = f.coordinator({ run: async input => {
    running.release();
    await new Promise(resolve => {
      if (input.signal.aborted) resolve();
      else input.signal.addEventListener('abort', resolve, { once: true });
    });
    abortReason = input.signal.reason;
    stopped.release();
    return { ...done(), status: 'cancelled', worker_assessment: 'unknown' };
  } });
  t.after(() => coordinator.shutdown());
  const admitted = await coordinator.submit({ schema_version: 1, source_view: f.root,
    assignment: f.request('committed-stop') }, f.owner, new AbortController().signal);
  await running.promise;
  const current = await f.store.readControl(admitted.task_id);
  const receipt = await coordinator.controls.cancel(admitted.task_id, f.owner,
    current.control_generation, 'committed-stop-key', 'Retained stop reason');
  await coordinator.controls.adopt(admitted.task_id, f.owner, 'later-generation');
  await coordinator.dispatchCommittedCancellation(admitted.task_id);
  await stopped.promise;
  assert.equal(receipt.outcome, 'accepted');
  assert.equal(abortReason.code, 'TASK_CANCELLED');
  assert.equal(abortReason.message, 'Retained stop reason');
  assert.deepEqual(await coordinator.cancel(admitted.task_id, f.owner, current.control_generation,
    'committed-stop-key', 'Retained stop reason'), receipt);
  await coordinator.waitForIdle();
});
