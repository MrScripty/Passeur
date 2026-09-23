import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, A, B, key, register, post, repo } from '../fixtures/structural/coordination-fixture.mjs';
import { CoordinationStore } from '../../.passeur-core/src/store/coordination-store.js';
import { CoordinationControl } from '../../.passeur-core/src/coordination/control.js';
import { CoordinationService } from '../../.passeur-core/src/service/coordination.js';
import { decodeRepositoryCommand } from '../../.passeur-core/src/contracts/coordination-control.js';
import { decodeCoordinationRequest } from '../../.passeur-core/src/contracts/coordination-service.js';

const identity = (patch = {}) => ({ source_view: '/source/repository', input_oid: '1'.repeat(40),
  intent_hash: '2'.repeat(64), areas: [{ kind: 'subtree', path: 'src' }], ...patch });
const internalKey = () => `passeur-internal:${key()}`;
const announcement = (patch = {}) => ({ operation_key: key(), id: randomUUID(), payload_digest: '3'.repeat(64),
  source_view: '/source/repository', assignment_hash: '4'.repeat(64), areas: [{ kind: 'subtree', path: 'src' }], readers: [B.owner_id], ...patch });
const binding = (patch = {}) => ({ operation_key: internalKey(), task_id: randomUUID(), request_key: key(), ...identity(), ...patch });

test('v4 preflight binds only the current visible overlap set and preserves unrelated metadata activity', async t => {
  const f = await fixture(t);
  const staged = await f.control.announce(A, announcement());
  assert.equal((await f.disk()).schema_version, 4);
  assert.equal((await f.control.announcement(B, staged.id)).id, staged.id);
  const gate = await f.control.preflight(A, identity({ announcement: { id: staged.id, revision: 1 } }));
  await f.control.execute(A, register({ areas: [{ kind: 'file', path: 'elsewhere.ts' }] }));
  const unrelated = await f.control.execute(A, register({ areas: [{ kind: 'file', path: 'other.ts' }] }));
  await f.control.execute(A, post(unrelated.entity));
  const accepted = await f.control.bindSubmission(A, binding({ announcement: { id: staged.id, revision: 1 },
    payload_digest: staged.payload_digest, assignment_hash: staged.assignment_hash, expected_decision_identity: gate.decision_identity }));
  assert.equal(accepted.decision_identity, gate.decision_identity);
  assert.equal((await f.control.submissionBindingByRequestKey(A, accepted.request_key)).task_id, accepted.task_id);
  assert.equal(await f.control.submissionBindingByRequestKey(B, accepted.request_key), undefined);
  assert.equal((await f.control.announcement(A, staged.id)).state, 'bound');
  const settled = await f.control.settleSubmission(A, { operation_key: internalKey(), task_id: accepted.task_id,
    request_key: accepted.request_key, link_hash: accepted.link_hash });
  assert.equal(settled.state, 'settled');
  assert.equal((await f.control.announcement(A, staged.id)).state, 'linked');
  const reopened = new CoordinationControl(await CoordinationStore.open(f.root, repo, () => {}));
  assert.equal((await reopened.submissionBinding(A, accepted.task_id)).link_hash, accepted.link_hash);
  await reopened.close();
});

test('a newly visible relevant overlap rejects gated bind before task admission', async t => {
  const f = await fixture(t);
  const gate = await f.control.preflight(A, identity());
  await f.control.execute(B, register({ areas: [{ kind: 'file', path: 'src/new.ts' }], readers: [A.owner_id] }));
  const before = await f.disk();
  await assert.rejects(f.control.bindSubmission(A, binding({ expected_decision_identity: gate.decision_identity })),
    { code: 'COORDINATION_CHANGED' });
  assert.deepEqual(await f.disk(), before);
  const current = await f.control.preflight(A, identity());
  assert.equal(current.overlaps.length, 1);
  assert.notEqual(current.decision_identity, gate.decision_identity);
});

test('announcement overlap is gated only when shared to the submitting parent', async t => {
  const f = await fixture(t);
  const gate = await f.control.preflight(A, identity());
  const hidden = await f.control.announce(B, announcement({ readers: [] }));
  assert.equal((await f.control.preflight(A, identity())).decision_identity, gate.decision_identity);
  await assert.rejects(f.control.announcement(A, hidden.id), { code: 'COORDINATION_NOT_FOUND' });
  const visible = await f.control.announce(B, announcement({ readers: [A.owner_id] }));
  const changed = await f.control.preflight(A, identity());
  assert.notEqual(changed.decision_identity, gate.decision_identity);
  assert.deepEqual(changed.overlaps, [{ kind: 'announcement', id: visible.id, areas: [{ kind: 'subtree', path: 'src' }] }]);
});

test('a shared bound task remains an overlap until visible managed work replaces its scope', async t => {
  const f = await fixture(t);
  const announced = await f.control.announce(B, announcement({ readers: [A.owner_id] }));
  const submission = binding({ announcement: { id: announced.id, revision: 1 },
    payload_digest: announced.payload_digest, assignment_hash: announced.assignment_hash });
  const bound = await f.control.bindSubmission(B, submission);
  const before = await f.control.preflight(A, identity());
  assert.deepEqual(before.overlaps, [{ kind: 'binding', id: bound.task_id, areas: [{ kind: 'subtree', path: 'src' }] }]);
  await f.control.settleSubmission(B, { operation_key: internalKey(), task_id: bound.task_id,
    request_key: bound.request_key, link_hash: bound.link_hash });
  assert.equal((await f.control.preflight(A, identity())).decision_identity, before.decision_identity);
  await f.control.execute(B, { kind: 'register_task_work', operation_key: key(), workspace_id: randomUUID(),
    input_oid: '1'.repeat(40), object_format: 'sha1', intent: '', areas: [{ kind: 'subtree', path: 'src' }],
    managed: { task_id: bound.task_id, control_generation: 1, intent_truncated: false, areas_source: 'allowed_paths' } });
  assert.deepEqual((await f.control.preflight(A, identity())).overlaps, before.overlaps);
  assert.deepEqual((await f.control.preflight(B, identity())).overlaps,
    [{ kind: 'work', id: bound.task_id, areas: [{ kind: 'subtree', path: 'src' }] }]);
  await assert.rejects(f.control.terminalSubmissionBinding(B, { operation_key: internalKey(), task_id: bound.task_id,
    request_key: bound.request_key, link_hash: '0'.repeat(64),
    terminal: { revision: 3, control_generation: 1, outcome: 'completed' } }), { code: 'COORDINATION_BINDING_CONFLICT' });
  const terminal = await f.control.terminalSubmissionBinding(B, { operation_key: internalKey(), task_id: bound.task_id,
    request_key: bound.request_key, link_hash: bound.link_hash,
    terminal: { revision: 3, control_generation: 1, outcome: 'completed' } });
  assert.equal(terminal.state, 'terminal');
  assert.equal((await f.control.preflight(A, identity())).overlaps.length, 0);
  assert.equal((await f.control.submissionBindingByRequestKey(B, bound.request_key)).terminal.outcome, 'completed');
});

test('announcement ownership, revision, exact assignment and release are enforced at binding', async t => {
  const f = await fixture(t);
  const announced = await f.control.announce(A, announcement());
  const reference = { id: announced.id, revision: 1 };
  await assert.rejects(f.control.bindSubmission(B, binding({ announcement: reference, payload_digest: announced.payload_digest, assignment_hash: announced.assignment_hash })),
    { code: 'COORDINATION_NOT_FOUND' });
  await assert.rejects(f.control.bindSubmission(A, binding({ announcement: reference, payload_digest: announced.payload_digest, assignment_hash: announced.assignment_hash,
    areas: [{ kind: 'subtree', path: 'different' }] })), { code: 'COORDINATION_CHANGED' });
  const bound = await f.control.bindSubmission(A, binding({ announcement: reference, payload_digest: announced.payload_digest, assignment_hash: announced.assignment_hash }));
  await assert.rejects(f.control.settleSubmission(A, { operation_key: internalKey(), task_id: bound.task_id,
    request_key: bound.request_key, link_hash: '0'.repeat(64) }), { code: 'COORDINATION_BINDING_CONFLICT' });
  const released = await f.control.releaseUnadmittedBinding(A, { operation_key: internalKey(), task_id: bound.task_id,
    request_key: bound.request_key, link_hash: bound.link_hash });
  assert.equal(released.state, 'released');
  assert.equal((await f.control.announcement(A, announced.id)).state, 'unresolved');
  await assert.rejects(f.control.bindSubmission(A, binding({ announcement: reference, payload_digest: announced.payload_digest, assignment_hash: announced.assignment_hash })),
    { code: 'COORDINATION_CHANGED' });
  const current = await f.control.announcement(A, announced.id);
  const rebound = await f.control.bindSubmission(A, binding({ announcement: { id: announced.id, revision: current.revision },
    payload_digest: announced.payload_digest, assignment_hash: announced.assignment_hash, intent_hash: '5'.repeat(64) }));
  assert.equal(rebound.state, 'bound');
  assert.equal(rebound.intent_hash, '5'.repeat(64));
});

test('service facade binds authenticated source view and keeps settlement available during drain', async t => {
  const root = await mkdtemp(join(tmpdir(), 'passeur-gated-service-'));
  t.after(() => rm(root, { recursive: true }));
  const repository_id = 'a'.repeat(24);
  const store = await CoordinationStore.initialize(root, repository_id,
    { works: 16, cases: 16, notes: 16, receipts: 128, note_bytes: 4096 }, () => {});
  await store.close();
  const service = new CoordinationService({ store_root: root, repository_id },
    { assertOwned: () => {}, authorizeInitialization: async () => {},
      externalWorkspaces: { assertExternalRegistration: async () => {} } },
    { ordinary_requests: 2, control_requests: 2, max_worktrees: 2, max_source_operations: 1 });
  t.after(() => service.close());
  const connection = { ...A, source_view: '/source/repository' };
  await assert.rejects(service.handle(connection, { schema_version: 1, kind: 'command',
    command: { kind: 'register_external_work', operation_key: internalKey(), input_oid: '1'.repeat(40),
      intent: 'work', areas: [], readers: [] } }), { code: 'COORDINATION_OPERATION_KEY_RESERVED' });
  await assert.rejects(service.preflight(connection, identity({ source_view: '/different' })),
    { code: 'COORDINATION_SOURCE_VIEW_CONFLICT' });
  const gate = await service.preflight(connection, identity());
  const bound = await service.bindSubmission(connection, binding({ expected_decision_identity: gate.decision_identity }));
  assert.equal((await service.submissionBindingByRequestKey(connection, bound.request_key)).task_id, bound.task_id);
  const terminalInput = { operation_key: internalKey(), task_id: bound.task_id, request_key: bound.request_key,
    link_hash: bound.link_hash, terminal: { revision: 4, control_generation: 1, outcome: 'blocked' } };
  await assert.rejects(service.terminalSubmissionBinding(connection, terminalInput), { code: 'COORDINATION_BINDING_SETTLED' });
  service.beginDrain();
  await assert.rejects(service.bindSubmission(connection, binding()), { code: 'COORDINATION_SERVICE_DRAINING' });
  assert.equal((await service.settleSubmission(connection, { operation_key: internalKey(), task_id: bound.task_id,
    request_key: bound.request_key, link_hash: bound.link_hash })).state, 'settled');
  assert.equal((await service.terminalSubmissionBinding(connection, terminalInput)).state, 'terminal');
  assert.deepEqual((await service.preflight(connection, identity())).overlaps, []);
  await service.close();
});

test('reserved internal keys cannot be preempted by public commands or recovery; historical receipts remain readable', () => {
  const reserved = internalKey();
  assert.throws(() => decodeRepositoryCommand({ kind: 'register_external_work', operation_key: reserved,
    input_oid: '1'.repeat(40), intent: 'work', areas: [], readers: [] }),
    { code: 'COORDINATION_OPERATION_KEY_RESERVED' });
  assert.throws(() => decodeRepositoryCommand({ kind: 'register_managed_work', operation_key: reserved,
    task_id: randomUUID() }), { code: 'COORDINATION_OPERATION_KEY_RESERVED' });
  assert.throws(() => decodeCoordinationRequest({ schema_version: 1, kind: 'recover_metadata', recovery: {
    kind: 'adopt_work', operation_key: reserved, epoch: randomUUID(), expected_owner: A.owner_id,
    expected_revision: 1, statement: 'operator evidence', work_id: randomUUID(), new_owner: B.owner_id,
  } }), { code: 'COORDINATION_OPERATION_KEY_RESERVED' });
  assert.equal(decodeCoordinationRequest({ schema_version: 1, kind: 'read',
    selector: { kind: 'receipt', operation_key: reserved }, offset: 0, limit: 4, expected_hash: null }).selector.operation_key, reserved);
  assert.equal(decodeCoordinationRequest({ schema_version: 1, kind: 'recovery_read',
    selector: { kind: 'receipt', operation_key: reserved }, offset: 0, limit: 4, expected_hash: null }).selector.operation_key, reserved);
});

test('settled binding reserves capacity for terminal disposition under metadata saturation', async t => {
  const f = await fixture(t, { receipts: 3 });
  const bound = await f.control.bindSubmission(A, binding());
  await f.control.settleSubmission(A, { operation_key: internalKey(), task_id: bound.task_id,
    request_key: bound.request_key, link_hash: bound.link_hash });
  await assert.rejects(f.control.execute(A, register()), { code: 'COORDINATION_CAPACITY' });
  const final = await f.control.terminalSubmissionBinding(A, { operation_key: internalKey(), task_id: bound.task_id,
    request_key: bound.request_key, link_hash: bound.link_hash,
    terminal: { revision: 2, control_generation: 1, outcome: 'failed' } });
  assert.equal(final.state, 'terminal');
  assert.equal((await f.disk()).revision, 3);
});
