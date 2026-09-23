import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { TaskStore } from '../../.passeur-core/src/store/task-store.js';
import { canonicalHash } from '../../.passeur-core/src/core/async.js';
import { initialControl } from '../../.passeur-core/src/core/task-control.js';

const owner = () => createHash('sha256').update(randomUUID()).digest('hex');
const hash = value => createHash('sha256').update(value).digest('hex');
const payload = (id, owner_id, source_view) => ({ schema_version: 1, id, revision: 1, owner_id, source_view,
  assignment: { schema_version: 3, agent_id: 'fixture', request_key: `ann-${id}`, mode: 'review',
    objective: 'Inspect exact announced work', context: 'Private assignment context', acceptance_criteria: ['Report result'] },
  published_at: new Date().toISOString() });

test('private announcement publishes immutable payload, bounded control and exact owner disposition', async t => {
  const root = await mkdtemp(join(tmpdir(), 'passeur-ann-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new TaskStore(root); const id = randomUUID(), parent = owner(), original = payload(id, parent, root);
  await store.publishAnnouncement(original);
  assert.deepEqual((await store.readAnnouncement(id)).payload, original);
  await store.publishAnnouncement(original);
  await assert.rejects(store.publishAnnouncement({ ...original, assignment: { ...original.assignment, objective: 'Changed' } }), { code: 'ANNOUNCEMENT_CONFLICT' });
  await assert.rejects(store.changeAnnouncement(id, owner(), { kind: 'withdraw' }), { code: 'ANNOUNCEMENT_OWNER_CONFLICT' });
  const linkedTask = randomUUID();
  const identity = { schema_version: 2, source_view: root, assignment: original.assignment,
    announcement: { id, revision: 1 } };
  const policy = { stop_grace_ms: 1000, max_workers: 1, max_queued_tasks: 1, max_clients: 32,
    max_waiters: 128, max_pending_inputs: 16, max_control_receipts: 512, implementation: { enabled: false } };
  const link = { schema_version: 1, task_id: linkedTask, request_key: original.assignment.request_key,
    owner_id: parent, intent_hash: canonicalHash(identity), decision_identity: hash('decision'),
    announcement: { id, revision: 1 } };
  const record = { schema_version: 5, task_id: linkedTask, project_id: 'repository',
    canonical_hash: canonicalHash(identity), accepted_at: new Date().toISOString(), request: original.assignment,
    source_view: root, initial_owner: parent,
    execution: { schema_version: 2, agent_id: 'fixture', adapter_id: 'fixture', adapter_contract: 'controlled-turn/1',
      configuration: {}, configuration_fingerprint: canonicalHash({}), policy },
    linkage: { ...link, link_hash: canonicalHash(link) } };
  await store.create(record, initialControl(linkedTask, parent));
  const linked = await store.changeAnnouncement(id, parent, { kind: 'link', task_id: linkedTask, revision: 1 });
  assert.equal(linked.state, 'linked'); assert.equal(linked.task_id, linkedTask);
  assert.deepEqual(await store.changeAnnouncement(id, parent, { kind: 'link', task_id: linkedTask, revision: 1 }), linked);
  await assert.rejects(store.changeAnnouncement(id, parent, { kind: 'link', task_id: randomUUID(), revision: 1 }), { code: 'ANNOUNCEMENT_CHANGED' });
  assert.deepEqual((await new TaskStore(root).readAnnouncement(id)).payload, original);
});

test('announcement withdrawal is explicit and irreversible; missing staged data is not accepted', async t => {
  const root = await mkdtemp(join(tmpdir(), 'passeur-ann-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new TaskStore(root), id = randomUUID(), parent = owner();
  assert.equal(await store.readAnnouncement(id), undefined);
  await store.publishAnnouncement(payload(id, parent, root));
  const withdrawn = await store.changeAnnouncement(id, parent, { kind: 'withdraw' });
  assert.equal(withdrawn.state, 'withdrawn');
  await assert.rejects(store.changeAnnouncement(id, parent, { kind: 'link', task_id: randomUUID(), revision: 1 }), { code: 'ANNOUNCEMENT_CHANGED' });
  assert.equal((await store.readAnnouncement(id)).payload.assignment.context, 'Private assignment context');
});
