import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serviceFixture, command, key, B } from '../fixtures/structural/service-fixture.mjs';
import { managedFixture } from '../fixtures/structural/managed-fixture.mjs';
import { RepositoryRuntime, resolveRepositoryBinding } from '../../.passeur-core/src/core/repository-runtime.js';
import { operatorToken } from '../../.passeur-core/src/service/operator-token.js';
import { ObservationStore } from '../../.passeur-core/src/store/observation-store.js';
import { ObservationMonitor } from '../../.passeur-core/src/observation/monitor.js';
import { BridgeError } from '../../.passeur-core/src/core/errors.js';

const identity = () => ({ package_version: 'fixture', build_id: 'fixture', mode: 'development',
  node_version: process.version, node_executable: process.execPath, pid: process.pid,
  started_at: new Date().toISOString() });
const client = owner_id => ({ owner_id, client_id: randomUUID() });

test('real runtime publishes native observation and gates durable notices and exact detail by source scope', async t => {
  const fixture = await serviceFixture(t);
  await fixture.service.close();
  const intent = { project: fixture.root, stateRoot: fixture.state, profilePath: join(fixture.temp, 'absent-profile.json') };
  const binding = await resolveRepositoryBinding(intent, {}, new AbortController().signal);
  const token = await operatorToken(binding, true);
  const owner = client(createHash('sha256').update(token).digest('hex'));
  const recipient = client(B.owner_id);
  const runtime = new RepositoryRuntime(intent, identity());
  fixture.sessions.push({ close: () => runtime.shutdown() });
  await runtime.coordinate({ schema_version: 1, kind: 'initialize', limits: fixture.limits }, owner, fixture.root);
  const registered = await runtime.coordinate(command({ kind: 'register_external_work', operation_key: key(),
    input_oid: fixture.base, intent: 'Observe declared TypeScript', areas: [{ kind: 'file', path: 'source.ts' }], readers: [] }), owner, fixture.root);
  assert.equal(registered.kind, 'receipt');
  const workId = registered.receipt.item_id;
  const first = await runtime.structuralRefresh(workId, owner);
  assert.ok(['published', 'unchanged'].includes(first.status), JSON.stringify(first));
  const ownerNotices = await runtime.structuralNoticePull(owner, 0);
  assert.equal(ownerNotices.notices.length, 0);
  assert.equal((await runtime.structuralCurrent(owner)).reports.length, 1);
  assert.deepEqual((await runtime.structuralNoticePull(recipient, 0)).notices, []);
  await runtime.coordinate(command({ kind: 'grant_source', operation_key: key(), work_id: workId,
    expected_revision: 1, recipients: [{ recipient: recipient.owner_id, scope: 'report' }] }), owner, fixture.root);
  await runtime.coordinate(command({ kind: 'watch_source', operation_key: key(), work_id: workId,
    expected_revision: 2, watchers: [owner.owner_id, recipient.owner_id].map(id => ({ recipient: id,
      regions: [{ kind: 'file', path: 'source.ts' }] })) }), owner, fixture.root);
  await runtime.structuralRefresh(workId, owner);
  assert.equal((await runtime.structuralCurrent(recipient)).reports[0]?.work_revision, 3);
  assert.equal((await runtime.structuralNoticePull(recipient, 0)).notices.length, 0);
  await writeFile(join(fixture.root, 'source.ts'), 'export function run(value: string): number { return value.length; }\n');
  const refreshed = await runtime.structuralRefresh(workId, owner);
  assert.equal(refreshed.status, 'published');
  const received = await runtime.structuralNoticePull(recipient, 0);
  assert.equal(received.notices.length, 1);
  const notice = received.notices[0];
  assert.equal(notice.work_id, workId);
  const report = await runtime.structuralArtifactReport(recipient, notice.artifact_id);
  assert.match(report.text, /run/);
  await assert.rejects(runtime.structuralArtifactDetail(recipient, notice.artifact_id, 'observed', 0, 6),
    { code: 'STRUCTURAL_SOURCE_FORBIDDEN' });
  assert.equal((await runtime.structuralNoticeAck(recipient, notice.id)).acknowledged, true);
  assert.equal((await runtime.structuralNoticePull(recipient, received.cursor)).notices.length, 0);
  await runtime.coordinate(command({ kind: 'grant_source', operation_key: key(), work_id: workId,
    expected_revision: 3, recipients: [{ recipient: recipient.owner_id, scope: 'detail' }] }), owner, fixture.root);
  await assert.rejects(runtime.structuralArtifactReport(recipient, notice.artifact_id), { code: 'STRUCTURAL_SOURCE_FORBIDDEN' });
  await runtime.structuralRefresh(workId, owner);
  const latest = (await runtime.structuralCurrent(recipient)).reports.at(-1);
  assert.ok(latest);
  assert.equal((await runtime.structuralArtifactDetail(recipient, latest.id, 'observed', 0, 6)).text, 'export');
});

test('managed adoption invalidates old audience and lets the successor start a fresh observation', async t => {
  const fixture = await managedFixture(t);
  await fixture.initialize();
  const task = await fixture.addTask();
  await fixture.enroll(task);
  await fixture.call(command({ kind: 'watch_source', operation_key: key(), work_id: task.id,
    expected_revision: 1, watchers: [{ recipient: fixture.ordinary.owner_id, regions: [{ kind: 'file', path: 'source.ts' }] }] }), fixture.ordinary);
  const first = await fixture.runtime.structuralRefresh(task.id, fixture.ordinary);
  assert.equal(first.status, 'published');
  const oldNotice = (await fixture.runtime.structuralNoticePull(fixture.ordinary, 0)).notices[0];
  assert.ok(oldNotice);
  const successor = client(createHash('sha256').update(randomUUID()).digest('hex'));
  await fixture.runtime.attachTask({ task_id: task.id }, successor, key());
  const work = await fixture.get('work', task.id, fixture.ordinary);
  await fixture.call({ schema_version: 1, kind: 'recover_metadata', recovery: { kind: 'adopt_work',
    operation_key: key(), epoch: (await fixture.disk()).epoch, work_id: task.id,
    expected_owner: work.owner, expected_revision: work.revision, new_owner: successor.owner_id,
    statement: 'Transfer source evidence to the current task owner.' } }, fixture.operator);
  assert.equal((await fixture.runtime.structuralNoticePull(fixture.ordinary, 0)).notices.length, 0);
  await assert.rejects(fixture.runtime.structuralArtifactReport(fixture.ordinary, oldNotice.artifact_id),
    { code: 'STRUCTURAL_SOURCE_FORBIDDEN' });
  const current = await fixture.runtime.structuralRefresh(task.id, successor);
  assert.equal(current.status, 'published');
  assert.equal((await fixture.runtime.structuralNoticePull(successor, 0)).notices.length, 0);
  const freshReport = (await fixture.runtime.structuralCurrent(successor)).reports[0];
  assert.ok(freshReport);
  assert.match((await fixture.runtime.structuralArtifactReport(successor, freshReport.id)).text, /run/);
});

test('fixed off setting suppresses automatic observation while on-demand native report and controls remain usable', async t => {
  const fixture = await serviceFixture(t);
  await fixture.service.close();
  const intent = { project: fixture.root, stateRoot: fixture.state, profilePath: join(fixture.temp, 'absent-profile.json') };
  const binding = await resolveRepositoryBinding(intent, {}, new AbortController().signal);
  const token = await operatorToken(binding, true);
  const owner = client(createHash('sha256').update(token).digest('hex'));
  const runtime = new RepositoryRuntime(intent, identity(), {}, { PASSEUR_OBSERVATION_MONITOR: 'off' });
  fixture.sessions.push({ close: () => runtime.shutdown() });
  await runtime.coordinate({ schema_version: 1, kind: 'initialize', limits: fixture.limits }, owner, fixture.root);
  const registered = await runtime.coordinate(command({ kind: 'register_external_work', operation_key: key(),
    input_oid: fixture.base, intent: 'On-demand only', areas: [{ kind: 'file', path: 'source.ts' }], readers: [] }), owner, fixture.root);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.deepEqual((await runtime.structuralCurrent(owner)).reports, []);
  assert.deepEqual((await runtime.structuralNoticePull(owner, 0)).notices, []);
  const report = await runtime.structuralReport(registered.receipt.item_id, owner, fixture.root);
  assert.equal(report.reports.length, 1);
  assert.match(report.reports[0].text, /Dialect: "typescript"/);
  assert.match(report.reports[0].text, /Coverage: complete/);
  assert.equal(runtime.status().coordination.state, 'ready');
});

test('a managed control generation change revokes old retained report, detail, notice and cursor views', async t => {
  const fixture = await managedFixture(t);
  await fixture.initialize();
  const task = await fixture.addTask();
  await fixture.enroll(task);
  await fixture.call(command({ kind: 'watch_source', operation_key: key(), work_id: task.id,
    expected_revision: 1, watchers: [{ recipient: fixture.ordinary.owner_id, regions: [{ kind: 'file', path: 'source.ts' }] }] }), fixture.ordinary);
  await fixture.runtime.structuralRefresh(task.id, fixture.ordinary);
  const prior = (await fixture.runtime.structuralCurrent(fixture.ordinary)).reports[0];
  const notice = (await fixture.runtime.structuralNoticePull(fixture.ordinary, 0)).notices[0];
  assert.ok(prior && notice);
  const changed = fixture.states.get(task.id);
  changed.control_generation++;
  changed.revision++;
  fixture.states.set(task.id, changed);
  assert.deepEqual((await fixture.runtime.structuralCurrent(fixture.ordinary)).reports, []);
  assert.deepEqual((await fixture.runtime.structuralNoticePull(fixture.ordinary, 0)).notices, []);
  await assert.rejects(fixture.runtime.structuralNoticeAck(fixture.ordinary, notice.id), { code: 'STRUCTURAL_SOURCE_FORBIDDEN' });
  await assert.rejects(fixture.runtime.structuralArtifactReport(fixture.ordinary, prior.id), { code: 'STRUCTURAL_SOURCE_FORBIDDEN' });
  await assert.rejects(fixture.runtime.structuralArtifactDetail(fixture.ordinary, prior.id, 'observed', 0, 6),
    { code: 'STRUCTURAL_SOURCE_FORBIDDEN' });
  await fixture.runtime.structuralRefresh(task.id, fixture.ordinary);
  const latest = (await fixture.runtime.structuralCurrent(fixture.ordinary)).reports[0];
  assert.ok(latest && latest.id !== prior.id);
  assert.equal(latest.control_generation, changed.control_generation);
});

test('invalid encoding and unsafe ancestor paths are reported while another real path is published', async t => {
  const fixture = await serviceFixture(t);
  await fixture.service.close();
  await fixture.commit(fixture.root, 'bad.ts', Buffer.from([0xff]));
  await mkdir(join(fixture.root, 'unsafe'));
  const base = await fixture.commit(fixture.root, 'unsafe/skip.ts', 'export const skip = 1;\n');
  await rm(join(fixture.root, 'unsafe'), { recursive: true });
  await symlink(fixture.root, join(fixture.root, 'unsafe'), 'dir');
  const intent = { project: fixture.root, stateRoot: fixture.state, profilePath: join(fixture.temp, 'absent-profile.json') };
  const binding = await resolveRepositoryBinding(intent, {}, new AbortController().signal);
  const token = await operatorToken(binding, true);
  const owner = client(createHash('sha256').update(token).digest('hex'));
  const runtime = new RepositoryRuntime(intent, identity(), {}, { PASSEUR_OBSERVATION_MONITOR: 'off' });
  fixture.sessions.push({ close: () => runtime.shutdown() });
  await runtime.coordinate({ schema_version: 1, kind: 'initialize', limits: fixture.limits }, owner, fixture.root);
  const receipt = await runtime.coordinate(command({ kind: 'register_external_work', operation_key: key(), input_oid: base,
    intent: 'Three source paths', areas: [{ kind: 'file', path: 'source.ts' }, { kind: 'file', path: 'bad.ts' },
      { kind: 'file', path: 'unsafe/skip.ts' }], readers: [] }), owner, fixture.root);
  await writeFile(join(fixture.root, 'source.ts'), 'export function run(value: number) { return value + 1; }\n');
  const outcome = await runtime.structuralRefresh(receipt.receipt.item_id, owner);
  assert.equal(outcome.status, 'published');
  assert.ok(outcome.limitations.includes('bad.ts:SOURCE_ENCODING_UNSUPPORTED'), JSON.stringify(outcome.limitations));
  assert.ok(outcome.limitations.includes('unsafe/skip.ts:SOURCE_PATH_UNSAFE'), JSON.stringify(outcome.limitations));
  assert.deepEqual((await runtime.structuralCurrent(owner)).reports.map(row => row.path), ['source.ts']);
});

test('a failed second correspondence notice is replayed before source reversion resolves the pair', async t => {
  const fixture = await serviceFixture(t);
  await fixture.service.close();
  const sibling = await fixture.linked('related-worktree');
  const intent = { project: fixture.root, stateRoot: fixture.state, profilePath: join(fixture.temp, 'absent-profile.json') };
  const binding = await resolveRepositoryBinding(intent, {}, new AbortController().signal);
  const token = await operatorToken(binding, true);
  const firstOwner = client(createHash('sha256').update(token).digest('hex'));
  const secondOwner = client(B.owner_id);
  const runtime = new RepositoryRuntime(intent, identity(), {}, { PASSEUR_OBSERVATION_MONITOR: 'off' });
  fixture.sessions.push({ close: () => runtime.shutdown() });
  await runtime.coordinate({ schema_version: 1, kind: 'initialize', limits: fixture.limits }, firstOwner, fixture.root);
  const register = (actor, root) => runtime.coordinate(command({ kind: 'register_external_work', operation_key: key(),
    input_oid: fixture.base, intent: 'Corresponding source', areas: [{ kind: 'file', path: 'source.ts' }], readers: [] }), actor, root);
  const first = await register(firstOwner, fixture.root);
  const second = await register(secondOwner, sibling);
  await writeFile(join(fixture.root, 'source.ts'), 'export function run(value: string) { return value.length; }\n');
  assert.equal((await runtime.structuralRefresh(first.receipt.item_id, firstOwner)).status, 'published');
  const firstId = (await runtime.structuralCurrent(firstOwner)).reports[0].id;
  const original = ObservationStore.prototype.notifyExisting;
  let failOnce = true;
  ObservationStore.prototype.notifyExisting = function (...args) {
    if (failOnce && args[0] === firstId && args[1] === firstOwner.owner_id) {
      failOnce = false;
      throw new BridgeError('TEST_NOTICE_PUBLICATION_FAILURE', 'Injected one retained notice failure');
    }
    return original.apply(this, args);
  };
  t.after(() => { ObservationStore.prototype.notifyExisting = original; });
  await writeFile(join(sibling, 'source.ts'), 'export function run(value: number) { return value + 1; }\n');
  assert.equal((await runtime.structuralRefresh(second.receipt.item_id, secondOwner)).status, 'incomplete');
  ObservationStore.prototype.notifyExisting = original;
  await writeFile(join(sibling, 'source.ts'), 'export function run() {}\n');
  assert.equal((await runtime.structuralRefresh(second.receipt.item_id, secondOwner)).status, 'published');
  const a = (await runtime.structuralNoticePull(firstOwner, 0)).notices;
  const b = (await runtime.structuralNoticePull(secondOwner, 0)).notices;
  assert.deepEqual(a.map(row => row.correspondence_state), ['overlap', 'resolved']);
  assert.deepEqual(b.map(row => row.correspondence_state), ['overlap', 'resolved']);
});

test('retained overlap is rehydrated before an offline reversion is reconciled after restart', async t => {
  const fixture = await serviceFixture(t);
  await fixture.service.close();
  const sibling = await fixture.linked('restart-related');
  const intent = { project: fixture.root, stateRoot: fixture.state, profilePath: join(fixture.temp, 'absent-profile.json') };
  const binding = await resolveRepositoryBinding(intent, {}, new AbortController().signal);
  const token = await operatorToken(binding, true);
  const firstOwner = client(createHash('sha256').update(token).digest('hex'));
  const secondOwner = client(B.owner_id);
  const runtime = new RepositoryRuntime(intent, identity(), {}, { PASSEUR_OBSERVATION_MONITOR: 'off' });
  await runtime.coordinate({ schema_version: 1, kind: 'initialize', limits: fixture.limits }, firstOwner, fixture.root);
  const register = (actor, root) => runtime.coordinate(command({ kind: 'register_external_work', operation_key: key(),
    input_oid: fixture.base, intent: 'Retained correspondence', areas: [{ kind: 'file', path: 'source.ts' }], readers: [] }), actor, root);
  const first = await register(firstOwner, fixture.root);
  const second = await register(secondOwner, sibling);
  await writeFile(join(fixture.root, 'source.ts'), 'export function run(value: string) { return value.length; }\n');
  await writeFile(join(sibling, 'source.ts'), 'export function run(value: number) { return value + 1; }\n');
  assert.equal((await runtime.structuralRefresh(first.receipt.item_id, firstOwner)).status, 'published');
  assert.equal((await runtime.structuralRefresh(second.receipt.item_id, secondOwner)).status, 'published');
  assert.deepEqual((await runtime.structuralNoticePull(firstOwner, 0)).notices.map(row => row.correspondence_state), ['overlap']);
  await runtime.shutdown();
  await writeFile(join(sibling, 'source.ts'), 'export function run() {}\n');
  const resumed = new RepositoryRuntime(intent, identity());
  fixture.sessions.push({ close: () => resumed.shutdown() });
  await resumed.prepare();
  const beforeStatus = await resumed.structuralObservationStatus(second.receipt.item_id, secondOwner);
  assert.equal((await resumed.structuralRefresh(second.receipt.item_id, secondOwner)).status, 'published');
  const a = (await resumed.structuralNoticePull(firstOwner, 0)).notices;
  const b = (await resumed.structuralNoticePull(secondOwner, 0)).notices;
  assert.deepEqual(a.map(row => row.correspondence_state), ['overlap', 'resolved'], JSON.stringify(beforeStatus));
  assert.deepEqual(b.map(row => row.correspondence_state), ['overlap', 'resolved']);
});

test('restart fills one failed peer notice before resolving an offline reversion', async t => {
  const fixture = await serviceFixture(t);
  await fixture.service.close();
  const sibling = await fixture.linked('partial-restart-related');
  const intent = { project: fixture.root, stateRoot: fixture.state, profilePath: join(fixture.temp, 'absent-profile.json') };
  const binding = await resolveRepositoryBinding(intent, {}, new AbortController().signal);
  const token = await operatorToken(binding, true);
  const firstOwner = client(createHash('sha256').update(token).digest('hex'));
  const secondOwner = client(B.owner_id);
  const runtime = new RepositoryRuntime(intent, identity(), {}, { PASSEUR_OBSERVATION_MONITOR: 'off' });
  await runtime.coordinate({ schema_version: 1, kind: 'initialize', limits: fixture.limits }, firstOwner, fixture.root);
  const register = (actor, root) => runtime.coordinate(command({ kind: 'register_external_work', operation_key: key(),
    input_oid: fixture.base, intent: 'Partially published correspondence', areas: [{ kind: 'file', path: 'source.ts' }], readers: [] }), actor, root);
  const first = await register(firstOwner, fixture.root);
  const second = await register(secondOwner, sibling);
  await writeFile(join(fixture.root, 'source.ts'), 'export function run(value: string) { return value.length; }\n');
  assert.equal((await runtime.structuralRefresh(first.receipt.item_id, firstOwner)).status, 'published');
  const firstId = (await runtime.structuralCurrent(firstOwner)).reports[0].id;
  const original = ObservationStore.prototype.notifyExisting;
  ObservationStore.prototype.notifyExisting = function (...args) {
    if (args[0] === firstId && args[1] === firstOwner.owner_id)
      throw new BridgeError('TEST_NOTICE_PUBLICATION_FAILURE', 'Injected peer write failure before crash');
    return original.apply(this, args);
  };
  t.after(() => { ObservationStore.prototype.notifyExisting = original; });
  await writeFile(join(sibling, 'source.ts'), 'export function run(value: number) { return value + 1; }\n');
  assert.equal((await runtime.structuralRefresh(second.receipt.item_id, secondOwner)).status, 'incomplete');
  ObservationStore.prototype.notifyExisting = original;
  assert.deepEqual((await runtime.structuralNoticePull(firstOwner, 0)).notices, []);
  assert.deepEqual((await runtime.structuralNoticePull(secondOwner, 0)).notices.map(row => row.correspondence_state), ['overlap']);
  await runtime.shutdown();
  await writeFile(join(sibling, 'source.ts'), 'export function run() {}\n');
  const resumed = new RepositoryRuntime(intent, identity());
  fixture.sessions.push({ close: () => resumed.shutdown() });
  await resumed.prepare();
  assert.equal((await resumed.structuralRefresh(second.receipt.item_id, secondOwner)).status, 'published');
  assert.deepEqual((await resumed.structuralNoticePull(firstOwner, 0)).notices.map(row => row.correspondence_state), ['overlap', 'resolved']);
  assert.deepEqual((await resumed.structuralNoticePull(secondOwner, 0)).notices.map(row => row.correspondence_state), ['overlap', 'resolved']);
});

test('restart reports deterministically omitted active work beyond monitor capacity', async t => {
  const fixture = await serviceFixture(t);
  await fixture.service.close();
  const intent = { project: fixture.root, stateRoot: fixture.state, profilePath: join(fixture.temp, 'absent-profile.json') };
  const binding = await resolveRepositoryBinding(intent, {}, new AbortController().signal);
  const token = await operatorToken(binding, true);
  const owner = client(createHash('sha256').update(token).digest('hex'));
  const registration = new RepositoryRuntime(intent, identity(), {}, { PASSEUR_OBSERVATION_MONITOR: 'off' });
  await registration.coordinate({ schema_version: 1, kind: 'initialize', limits: { ...fixture.limits, works: 64 } }, owner, fixture.root);
  const workIds = [];
  for (let index = 0; index < 33; index++) {
    const root = index ? await fixture.linked(`capacity-${index}`) : fixture.root;
    const reply = await registration.coordinate(command({ kind: 'register_external_work', operation_key: key(),
      input_oid: fixture.base, intent: `Capacity work ${index}`, areas: [{ kind: 'file', path: 'source.ts' }], readers: [] }), owner, root);
    workIds.push(reply.receipt.item_id);
  }
  await registration.shutdown();
  const resumed = new RepositoryRuntime(intent, identity());
  fixture.sessions.push({ close: () => resumed.shutdown() });
  await resumed.prepare();
  const omittedId = [...workIds].sort().at(-1);
  let status;
  for (let attempt = 0; attempt < 100; attempt++) {
    status = await resumed.structuralObservationStatus(omittedId, owner);
    if (status.limitations.includes('observation_capacity')) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(status.capacity_omitted_count, 1);
  assert.equal(status.state, 'incomplete');
  assert.ok(status.limitations.includes('observation_capacity'), JSON.stringify({ status, omittedId, workIds }));
  await assert.rejects(resumed.structuralObservationStatus(omittedId, client(B.owner_id)),
    { code: 'COORDINATION_NOT_FOUND' });
  assert.equal(resumed.status().coordination.state, 'ready');
  const selectedId = [...workIds].sort()[0];
  await resumed.coordinate(command({ kind: 'close_work', operation_key: key(), work_id: selectedId,
    expected_revision: 1 }), owner, fixture.root);
  let afterClose;
  for (let attempt = 0; attempt < 500; attempt++) {
    afterClose = await resumed.structuralObservationStatus(omittedId, owner);
    if (afterClose.state === 'observed') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(afterClose.capacity_omitted_count, 0);
  assert.equal(afterClose.state, 'observed');
  let laterId, laterRoot;
  for (let index = 0; index < 8; index++) {
    const root = await fixture.linked(`capacity-after-release-${index}`);
    const later = await resumed.coordinate(command({ kind: 'register_external_work', operation_key: key(),
      input_oid: fixture.base, intent: 'Later capacity work', areas: [{ kind: 'file', path: 'source.ts' }], readers: [] }), owner, root);
    laterId = later.receipt.item_id;
    laterRoot = root;
    if (laterId < omittedId) break;
  }
  assert.ok(laterId < omittedId, 'later registration must put an attached work outside the sorted first 32');
  for (let attempt = 0; attempt < 100; attempt++) {
    status = await resumed.structuralObservationStatus(laterId, owner);
    if (status.limitations.includes('observation_capacity')) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(status.limitations.includes('observation_capacity'), JSON.stringify(status));
  assert.equal((await resumed.structuralObservationStatus(omittedId, owner)).state, 'observed',
    'the watcher already admitted for this work remains attached regardless of UUID sort order');

  let entered, release;
  const attaching = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const original = ObservationMonitor.prototype.attach;
  ObservationMonitor.prototype.attach = async function (workspace, signal) {
    const result = await original.call(this, workspace, signal);
    if (workspace.work_id === laterId) { entered(); await held; }
    return result;
  };
  t.after(() => { ObservationMonitor.prototype.attach = original; });
  try {
    const otherAttachedId = [...workIds].sort()[1];
    await resumed.coordinate(command({ kind: 'close_work', operation_key: key(), work_id: otherAttachedId,
      expected_revision: 1 }), owner, fixture.root);
    await attaching;
    const replacementRoot = await fixture.linked('capacity-pending-replacement');
    const replacement = await resumed.coordinate(command({ kind: 'register_external_work', operation_key: key(),
      input_oid: fixture.base, intent: 'Replace pending observation',
      areas: [{ kind: 'file', path: 'source.ts' }], readers: [] }), owner, replacementRoot);
    const replacementId = replacement.receipt.item_id;
    for (let attempt = 0; attempt < 100; attempt++) {
      status = await resumed.structuralObservationStatus(replacementId, owner);
      if (status.limitations.includes('observation_capacity')) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(status.limitations.includes('observation_capacity'), JSON.stringify(status));
    await resumed.coordinate(command({ kind: 'grant_source', operation_key: key(), work_id: laterId,
      expected_revision: 1, recipients: [{ recipient: B.owner_id, scope: 'report' }] }), owner, laterRoot);
    for (let attempt = 0; attempt < 500; attempt++) {
      status = await resumed.structuralObservationStatus(replacementId, owner);
      if (status.state === 'observed') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(status.state, 'observed', 'forgetting an in-flight watcher must promote omitted work');
  } finally { release(); }
});

test('closing work during a suspended automatic attach leaves no watcher for the closed workspace', async t => {
  const fixture = await serviceFixture(t);
  await fixture.service.close();
  const intent = { project: fixture.root, stateRoot: fixture.state, profilePath: join(fixture.temp, 'absent-profile.json') };
  const binding = await resolveRepositoryBinding(intent, {}, new AbortController().signal);
  const token = await operatorToken(binding, true);
  const owner = client(createHash('sha256').update(token).digest('hex'));
  const runtime = new RepositoryRuntime(intent, identity());
  fixture.sessions.push({ close: () => runtime.shutdown() });
  await runtime.coordinate({ schema_version: 1, kind: 'initialize', limits: fixture.limits }, owner, fixture.root);
  const entered = { resolve: undefined, promise: undefined };
  entered.promise = new Promise(resolve => { entered.resolve = resolve; });
  const release = { resolve: undefined, promise: undefined };
  release.promise = new Promise(resolve => { release.resolve = resolve; });
  const finished = { resolve: undefined, promise: undefined };
  finished.promise = new Promise(resolve => { finished.resolve = resolve; });
  const original = ObservationMonitor.prototype.attach;
  let monitor, workspaceId;
  ObservationMonitor.prototype.attach = async function (workspace) {
    monitor = this; workspaceId = workspace.workspace_id;
    entered.resolve();
    await release.promise;
    try { return await original.call(this, workspace); }
    finally { finished.resolve(); }
  };
  t.after(() => { ObservationMonitor.prototype.attach = original; });
  try {
    const registered = await runtime.coordinate(command({ kind: 'register_external_work', operation_key: key(),
      input_oid: fixture.base, intent: 'Close during attach', areas: [{ kind: 'file', path: 'source.ts' }], readers: [] }), owner, fixture.root);
    const workId = registered.receipt.item_id;
    await entered.promise;
    assert.equal(await runtime.hasObligations(), false,
      'optional automatic analysis must not hold the service alive after foreground controls settle');
    await runtime.coordinate(command({ kind: 'close_work', operation_key: key(), work_id: workId,
      expected_revision: 1 }), owner, fixture.root);
    release.resolve();
    await finished.promise;
    for (let attempt = 0; attempt < 100 && monitor.status(workId, workspaceId); attempt++)
      await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(monitor.status(workId, workspaceId), undefined);
  } finally { release.resolve(); }
});

test('source revision changes serialize automatic attachment and failed reattachment releases the old watcher', async t => {
  const fixture = await serviceFixture(t);
  await fixture.service.close();
  const intent = { project: fixture.root, stateRoot: fixture.state, profilePath: join(fixture.temp, 'absent-profile.json') };
  const binding = await resolveRepositoryBinding(intent, {}, new AbortController().signal);
  const token = await operatorToken(binding, true);
  const owner = client(createHash('sha256').update(token).digest('hex'));
  const runtime = new RepositoryRuntime(intent, identity());
  fixture.sessions.push({ close: () => runtime.shutdown() });
  await runtime.coordinate({ schema_version: 1, kind: 'initialize', limits: fixture.limits }, owner, fixture.root);
  let enterFirst, releaseFirst, enterSecond, monitor, workspaceId, calls = 0;
  const firstReady = new Promise(resolve => { enterFirst = resolve; });
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const secondReady = new Promise(resolve => { enterSecond = resolve; });
  const original = ObservationMonitor.prototype.attach;
  ObservationMonitor.prototype.attach = async function (workspace) {
    monitor = this; workspaceId = workspace.workspace_id;
    calls++;
    if (calls === 1) {
      const result = await original.call(this, workspace);
      enterFirst();
      await firstGate;
      return result;
    }
    if (calls === 2) { const result = await original.call(this, workspace); enterSecond(); return result; }
    throw new BridgeError('TEST_ATTACH_FAILED', 'Injected failed reattachment');
  };
  t.after(() => { ObservationMonitor.prototype.attach = original; });
  try {
    const registered = await runtime.coordinate(command({ kind: 'register_external_work', operation_key: key(),
      input_oid: fixture.base, intent: 'Revise observed source', areas: [{ kind: 'file', path: 'source.ts' }], readers: [] }), owner, fixture.root);
    const workId = registered.receipt.item_id;
    await firstReady;
    await runtime.coordinate(command({ kind: 'grant_source', operation_key: key(), work_id: workId,
      expected_revision: 1, recipients: [{ recipient: B.owner_id, scope: 'report' }] }), owner, fixture.root);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(calls, 1, 'new revision must wait for the stale attachment to settle');
    releaseFirst();
    await secondReady;
    let status;
    for (let attempt = 0; attempt < 100; attempt++) {
      status = await runtime.structuralObservationStatus(workId, owner);
      if (status.state === 'observed') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(status.state, 'observed');
    assert.ok(monitor.status(workId, workspaceId), 'current revision owns the watcher');
    await runtime.coordinate(command({ kind: 'watch_source', operation_key: key(), work_id: workId,
      expected_revision: 2, watchers: [{ recipient: owner.owner_id,
        regions: [{ kind: 'file', path: 'source.ts' }] }] }), owner, fixture.root);
    for (let attempt = 0; attempt < 100; attempt++) {
      status = await runtime.structuralObservationStatus(workId, owner);
      if (status.limitations.includes('TEST_ATTACH_FAILED')) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(status.limitations.includes('TEST_ATTACH_FAILED'), JSON.stringify(status));
    assert.equal(monitor.status(workId, workspaceId), undefined,
      'a failed replacement must leave no stale watcher from the revoked revision');
  } finally { releaseFirst(); }
});

test('manual refresh cannot detach a newer revision watcher after its own attachment becomes stale', async t => {
  const fixture = await serviceFixture(t);
  await fixture.service.close();
  const intent = { project: fixture.root, stateRoot: fixture.state, profilePath: join(fixture.temp, 'absent-profile.json') };
  const binding = await resolveRepositoryBinding(intent, {}, new AbortController().signal);
  const token = await operatorToken(binding, true);
  const owner = client(createHash('sha256').update(token).digest('hex'));
  const runtime = new RepositoryRuntime(intent, identity(), {}, { PASSEUR_OBSERVATION_MONITOR: 'off' });
  fixture.sessions.push({ close: () => runtime.shutdown() });
  await runtime.coordinate({ schema_version: 1, kind: 'initialize', limits: fixture.limits }, owner, fixture.root);
  const registered = await runtime.coordinate(command({ kind: 'register_external_work', operation_key: key(),
    input_oid: fixture.base, intent: 'Refresh during source revision',
    areas: [{ kind: 'file', path: 'source.ts' }], readers: [] }), owner, fixture.root);
  const workId = registered.receipt.item_id;
  let enterFirst, releaseFirst, monitor, workspaceId, calls = 0;
  const firstReady = new Promise(resolve => { enterFirst = resolve; });
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const original = ObservationMonitor.prototype.attach;
  ObservationMonitor.prototype.attach = async function (workspace, signal) {
    monitor = this; workspaceId = workspace.workspace_id;
    const call = ++calls;
    const result = await original.call(this, workspace, signal);
    if (call === 1) { enterFirst(); await firstGate; }
    return result;
  };
  t.after(() => { ObservationMonitor.prototype.attach = original; });
  try {
    const stale = runtime.structuralRefresh(workId, owner);
    stale.catch(() => undefined);
    await firstReady;
    await runtime.coordinate(command({ kind: 'grant_source', operation_key: key(), work_id: workId,
      expected_revision: 1, recipients: [{ recipient: B.owner_id, scope: 'report' }] }), owner, fixture.root);
    const current = runtime.structuralRefresh(workId, owner);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(calls, 1, 'the newer manual refresh waits for the stale attachment');
    releaseFirst();
    await assert.rejects(stale, { code: 'STRUCTURAL_SOURCE_FORBIDDEN' });
    assert.ok(['published', 'unchanged'].includes((await current).status));
    assert.equal(calls, 2);
    assert.ok(monitor.status(workId, workspaceId), 'current manual refresh retains its watcher');
  } finally { releaseFirst(); }
});

test('registration and watch controls finish while restart rehydration holds automatic attachment', async t => {
  const fixture = await serviceFixture(t);
  await fixture.service.close();
  const sibling = await fixture.linked('registration-during-resume');
  const intent = { project: fixture.root, stateRoot: fixture.state, profilePath: join(fixture.temp, 'absent-profile.json') };
  const binding = await resolveRepositoryBinding(intent, {}, new AbortController().signal);
  const token = await operatorToken(binding, true);
  const owner = client(createHash('sha256').update(token).digest('hex'));
  const initial = new RepositoryRuntime(intent, identity(), {}, { PASSEUR_OBSERVATION_MONITOR: 'off' });
  await initial.coordinate({ schema_version: 1, kind: 'initialize', limits: fixture.limits }, owner, fixture.root);
  const first = await initial.coordinate(command({ kind: 'register_external_work', operation_key: key(),
    input_oid: fixture.base, intent: 'Retained startup seed', areas: [{ kind: 'file', path: 'source.ts' }], readers: [] }), owner, fixture.root);
  await initial.structuralRefresh(first.receipt.item_id, owner);
  await initial.shutdown();
  const original = ObservationStore.prototype.readRetainedPair;
  let enteredResolve, releaseResolve;
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  const release = new Promise(resolve => { releaseResolve = resolve; });
  ObservationStore.prototype.readRetainedPair = async function (...args) {
    enteredResolve();
    await release;
    return original.apply(this, args);
  };
  t.after(() => { releaseResolve(); ObservationStore.prototype.readRetainedPair = original; });
  const resumed = new RepositoryRuntime(intent, identity());
  fixture.sessions.push({ close: () => resumed.shutdown() });
  await resumed.prepare();
  await entered;
  const registered = await Promise.race([
    resumed.coordinate(command({ kind: 'register_external_work', operation_key: key(),
      input_oid: fixture.base, intent: 'Control during rehydration', areas: [{ kind: 'file', path: 'source.ts' }], readers: [] }), owner, sibling),
    new Promise((_, reject) => setTimeout(() => reject(new Error('registration waited for observation')), 1000)),
  ]);
  const secondId = registered.receipt.item_id;
  await Promise.race([
    resumed.coordinate(command({ kind: 'watch_source', operation_key: key(), work_id: secondId, expected_revision: 1,
      watchers: [{ recipient: owner.owner_id, regions: [{ kind: 'file', path: 'source.ts' }] }] }), owner, sibling),
    new Promise((_, reject) => setTimeout(() => reject(new Error('watch waited for observation')), 1000)),
  ]);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual((await resumed.structuralCurrent(owner)).reports.filter(row => row.work_id === secondId), []);
  releaseResolve();
  assert.equal((await resumed.structuralRefresh(secondId, owner)).status, 'published');
  assert.equal((await resumed.structuralCurrent(owner)).reports.filter(row => row.work_id === secondId).length, 1);
});
