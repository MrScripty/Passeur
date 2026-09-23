import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, A, B } from '../fixtures/structural/coordination-fixture.mjs';
import { ObservationStore } from '../../.passeur-core/src/store/observation-store.js';
import { BridgeError } from '../../.passeur-core/src/core/errors.js';

function sample(text = 'export function f(x: number): number { return x; }\n', path = 'src/f.ts') {
  const work = randomUUID(), capture = randomUUID();
  const inputSource = { kind: 'commit', repository_id: 'coordination-fixture', object_format: 'sha1',
    commit_oid: '1'.repeat(40), tree_oid: '2'.repeat(40), path };
  const observedSource = { kind: 'working_capture', repository_id: 'coordination-fixture', object_format: 'sha1',
    workspace_id: 'workspace', workspace_generation: 1, capture_id: capture, capture_sequence: 1,
    head_anchor: '1'.repeat(40), path };
  const input = { status: 'absent_in_commit', source: inputSource };
  const observed = { status: 'present', source: observedSource, mode: '100644', content_sha256: createHash('sha256').update(text).digest('hex'),
    byte_length: Buffer.byteLength(text), text, consistency: 'sampled_file_not_atomic' };
  const comparison = { input: { status: input.status, source: input.source },
    observed: { status: observed.status, source: observed.source, mode: observed.mode, content_sha256: observed.content_sha256,
      byte_length: observed.byte_length, consistency: observed.consistency }, dialect: 'typescript', parser_identity: 'fixture-real-contract',
    extractor_identity: 'fixture-real-contract', coverage: 'complete', changes: [], region_changed: true, limitations: [] };
  const report = { work_id: work, parent_id: A.owner_id, attribution: 'observed_in_work_authorship_not_established', comparison };
  return { report, work_revision: 1, workspace_generation: 1, control_generation: null,
    input, observed, recipients: [A.owner_id, B.owner_id] };
}
const allow = () => {};

test('immutable report and exact captured detail survive reopen; current authority gates every read', async t => {
  const f = await fixture(t), store = await ObservationStore.initialize(f.store, allow);
  t.after(() => store.close());
  const item = sample();
  const published = await store.publish(item);
  const path = join(f.root, 'coordination/observation/artifacts', `${published.id}.json`);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).id, published.id);
  const reopened = await ObservationStore.open(f.store, allow);
  t.after(() => reopened.close());
  assert.match((await reopened.readReport(published.id, A.owner_id, allow)).text, /region_changed/);
  assert.equal((await reopened.readDetail(published.id, A.owner_id, 'observed', 0, item.observed.byte_length, allow)).text,
    item.observed.text);
  await assert.rejects(reopened.readDetail(published.id, A.owner_id, 'observed', 0, 25_000, allow), { code: 'STRUCTURAL_DETAIL_RANGE_INVALID' });
  let grants = 0;
  await assert.rejects(reopened.readReport(published.id, B.owner_id, () => { grants++; throw Object.assign(Error('revoked'), { code: 'REVOKED' }); }), { code: 'REVOKED' });
  assert.equal(grants, 1);
  await writeFile(path, '{}');
  await assert.rejects(reopened.readReport(published.id, A.owner_id, allow), { code: 'OBSERVATION_RECORD_INVALID' });
});

test('interrupted pull repeats until explicit ack; no-op materiality suppresses duplicate notice', async t => {
  const f = await fixture(t), store = await ObservationStore.initialize(f.store, allow);
  t.after(() => store.close());
  const item = sample();
  const firstArtifact = await store.publish(item);
  const first = await store.pull(A.owner_id, 0, allow);
  assert.equal(first.gap, false); assert.equal(first.notices.length, 1);
  assert.equal((await store.pull(A.owner_id, first.cursor, allow)).notices[0].id, first.notices[0].id);
  const changedCapture = structuredClone(item);
  changedCapture.observed.source.capture_id = randomUUID();
  changedCapture.report.comparison.observed.source.capture_id = changedCapture.observed.source.capture_id;
  const secondArtifact = await store.publish(changedCapture);
  assert.equal(secondArtifact.id, firstArtifact.id);
  assert.equal((await store.publish(item)).id, firstArtifact.id);
  const changedParser = structuredClone(item);
  changedParser.report.comparison.parser_identity = 'fixture-new-parser';
  const parserArtifact = await store.publish(changedParser);
  assert.notEqual(parserArtifact.id, firstArtifact.id);
  assert.equal((await store.listCurrent(A.owner_id, allow)).reports[0].id, parserArtifact.id);
  assert.equal((await store.pull(A.owner_id, 0, allow)).notices.length, 1);
  await store.ack(A.owner_id, first.notices[0].id, allow);
  assert.equal((await store.pull(A.owner_id, first.cursor, allow)).notices.length, 0);
  await assert.rejects(store.ack(B.owner_id, first.notices[0].id, allow), { code: 'OBSERVATION_NOTICE_UNAVAILABLE' });
});

test('revoked work is filtered from pull and acknowledgment cannot act as a source grant', async t => {
  const f = await fixture(t), store = await ObservationStore.initialize(f.store, allow);
  t.after(() => store.close());
  const old = sample(), current = sample('export function current() {}\n');
  await store.publish(old); await store.publish(current);
  const notice = (await store.pull(A.owner_id, 0, allow)).notices[0];
  const currentOnly = (_, workId, revision) => {
    if (workId === old.report.work_id || revision !== 1) throw new BridgeError('STRUCTURAL_SOURCE_FORBIDDEN', 'revoked');
  };
  // A typed current-grant denial cannot reveal the revoked work or hide other work.
  const pulled = await store.pull(A.owner_id, 0, currentOnly);
  assert.deepEqual(pulled.notices.map(row => row.work_id), [current.report.work_id]);
  await assert.rejects(store.ack(A.owner_id, notice.id, currentOnly), { code: 'STRUCTURAL_SOURCE_FORBIDDEN' });
  assert.equal((await store.pull(A.owner_id, 0, allow)).notices.length, 2);
});

test('ack authority may reenter a read without holding the notice write lock', async t => {
  const f = await fixture(t), store = await ObservationStore.initialize(f.store, allow);
  t.after(() => store.close());
  await store.publish(sample());
  const notice = (await store.pull(A.owner_id, 0, allow)).notices[0];
  const acknowledged = await store.ack(A.owner_id, notice.id, async () => {
    assert.equal((await store.pull(A.owner_id, 0, allow)).notices.length, 1);
  });
  assert.equal(acknowledged.acknowledged, true);
});

test('current report discovery is independent of unsolicited notices and checks live work revision', async t => {
  const f = await fixture(t), store = await ObservationStore.initialize(f.store, allow);
  t.after(() => store.close());
  const original = sample(), updated = sample('export function updated() {}\n'), other = sample('export function other() {}\n');
  updated.report.work_id = original.report.work_id;
  updated.work_revision = 2;
  updated.workspace_generation = 2;
  updated.observed.source.workspace_generation = 2;
  updated.report.comparison.observed.source.workspace_generation = 2;
  original.recipients = []; updated.recipients = []; other.recipients = [];
  const first = await store.publish(original), latest = await store.publish(updated), separate = await store.publish(other);
  assert.equal((await store.pull(A.owner_id, 0, allow)).notices.length, 0);
  const expectedRevision = (_, workId, revision) => {
    if (workId === original.report.work_id && revision !== 2) throw new BridgeError('STRUCTURAL_SOURCE_FORBIDDEN', 'stale work revision');
  };
  const current = await store.listCurrent(A.owner_id, expectedRevision);
  assert.deepEqual(current.reports.map(row => row.id), [separate.id, latest.id]);
  assert.ok(current.reports.every(row => row.path === 'src/f.ts'));
  assert.equal(current.reports.find(row => row.id === latest.id).work_revision, 2);
  await assert.rejects(store.readReport(first.id, A.owner_id, expectedRevision), { code: 'STRUCTURAL_SOURCE_FORBIDDEN' });
  const reopened = await ObservationStore.open(f.store, allow);
  t.after(() => reopened.close());
  assert.deepEqual((await reopened.listCurrent(A.owner_id, expectedRevision)).reports, current.reports);
});

test('body-only capture changes advance current exact detail without producing another notice', async t => {
  const f = await fixture(t), store = await ObservationStore.initialize(f.store, allow);
  t.after(() => store.close());
  const first = sample('export function f() { return 1; }\n');
  const second = sample('export function f() { return 2; }\n');
  const third = sample('export function f() { return 3; }\n');
  for (const item of [second, third]) item.report.work_id = first.report.work_id;
  const one = await store.publish(first), two = await store.publish(second), three = await store.publish(third);
  assert.notEqual(one.id, two.id); assert.notEqual(two.id, three.id);
  assert.equal((await store.pull(A.owner_id, 0, allow)).notices.length, 1);
  assert.equal((await store.listCurrent(A.owner_id, allow)).reports[0].id, three.id);
  const detail = await store.readDetail(three.id, A.owner_id, 'observed', 0, third.observed.byte_length, allow);
  assert.equal(detail.text, third.observed.text);
  const reopened = await ObservationStore.open(f.store, allow);
  t.after(() => reopened.close());
  assert.equal((await reopened.listCurrent(A.owner_id, allow)).reports[0].id, three.id);
});

test('ordinary notice materiality is tracked per work and path across alternating no-op sweeps', async t => {
  const f = await fixture(t), store = await ObservationStore.initialize(f.store, allow);
  t.after(() => store.close());
  const a = sample('export function a() {}\n', 'src/a.ts');
  const b = sample('export function b() {}\n', 'src/b.ts');
  b.report.work_id = a.report.work_id;
  await store.publish(a); await store.publish(b);
  for (let sweep = 0; sweep < 3; sweep++) {
    const nextA = sample(a.observed.text, 'src/a.ts'), nextB = sample(b.observed.text, 'src/b.ts');
    nextA.report.work_id = a.report.work_id; nextB.report.work_id = a.report.work_id;
    await store.publish(nextA); await store.publish(nextB);
  }
  const pending = (await store.pull(A.owner_id, 0, allow)).notices;
  assert.equal(pending.length, 2);
  assert.deepEqual(new Set(pending.map(row => row.artifact_id)).size, 2);
  assert.deepEqual((await store.listCurrent(A.owner_id, allow)).reports.map(row => row.path), ['src/b.ts', 'src/a.ts']);
});

test('pruned cursor snapshot retains both watched paths of one authorized work', async t => {
  const f = await fixture(t), store = await ObservationStore.initialize(f.store, allow);
  t.after(() => store.close());
  const a = sample('export function a() {}\n', 'src/a.ts'); a.recipients = [];
  const b = sample('export function b() {}\n', 'src/b.ts'); b.report.work_id = a.report.work_id;
  const aArtifact = await store.publish(a);
  for (let i = 0; i < 256; i++) await store.notifyExisting(aArtifact.id, A.owner_id,
    createHash('sha256').update(`gap:${i}`).digest('hex'), 'overlap', allow);
  await store.publish(b);
  const pulled = await store.pull(A.owner_id, 0, allow);
  assert.equal(pulled.gap, true);
  const paths = new Map((await store.listCurrent(A.owner_id, allow)).reports.map(row => [row.id, row.path]));
  assert.deepEqual(new Set(pulled.current.map(row => paths.get(row.artifact_id))), new Set(['src/a.ts', 'src/b.ts']));
  const reopened = await ObservationStore.open(f.store, allow);
  t.after(() => reopened.close());
  assert.deepEqual(new Set((await reopened.pull(A.owner_id, 0, allow)).current.map(row => paths.get(row.artifact_id))),
    new Set(['src/a.ts', 'src/b.ts']));
});

test('pruning only an ordinary notice keeps no-op sweeps quiet while a first watch still announces', async t => {
  const f = await fixture(t), store = await ObservationStore.initialize(f.store, allow);
  t.after(() => store.close());
  const initial = sample(); initial.recipients = [A.owner_id];
  const artifact = await store.publish(initial);
  for (let i = 0; i < 256; i++) await store.notifyExisting(artifact.id, A.owner_id,
    createHash('sha256').update(`pruned-ordinary:${i}`).digest('hex'), 'overlap', allow);
  const path = join(f.root, 'coordination/observation/state.json');
  const before = JSON.parse(await readFile(path, 'utf8'));
  assert.ok(before.floor_sequence > 0);
  assert.equal(before.notices.some(row => row.subject_id === undefined && row.recipient === A.owner_id), false);
  const refreshed = sample(initial.observed.text); refreshed.report.work_id = initial.report.work_id;
  refreshed.recipients = [A.owner_id];
  assert.equal((await store.publish(refreshed)).id, artifact.id);
  const quiet = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(quiet.next_sequence, before.next_sequence);
  const firstWatch = sample(initial.observed.text); firstWatch.report.work_id = initial.report.work_id;
  firstWatch.recipients = [B.owner_id];
  await store.publish(firstWatch);
  const newNotice = (await store.pull(B.owner_id, 0, allow)).notices;
  assert.equal(newNotice.length, 1); assert.equal(newNotice[0].subject_id, undefined);
  const after = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(after.artifacts.at(-1).ordinary_recipients.sort(), [A.owner_id, B.owner_id].sort());
});

test('managed control generation revokes old artifact and notice with unchanged owner and work revision', async t => {
  const f = await fixture(t), store = await ObservationStore.initialize(f.store, allow);
  t.after(() => store.close());
  const old = sample(), current = sample('export function current() {}\n');
  old.control_generation = 1;
  current.report.work_id = old.report.work_id;
  current.control_generation = 2;
  current.workspace_generation = 2;
  current.observed.source.workspace_generation = 2;
  current.report.comparison.observed.source.workspace_generation = 2;
  const first = await store.publish(old), staleNotice = (await store.pull(A.owner_id, 0, allow)).notices[0];
  const second = await store.publish(current);
  const live = (_, workId, revision, generation) => {
    assert.equal(workId, old.report.work_id); assert.equal(revision, 1);
    if (generation.control_generation !== 2 || generation.workspace_generation !== 2)
      throw new BridgeError('STRUCTURAL_SOURCE_FORBIDDEN', 'old TaskControl generation');
  };
  await assert.rejects(store.readReport(first.id, A.owner_id, live), { code: 'STRUCTURAL_SOURCE_FORBIDDEN' });
  await assert.rejects(store.ack(A.owner_id, staleNotice.id, live), { code: 'STRUCTURAL_SOURCE_FORBIDDEN' });
  assert.deepEqual((await store.pull(A.owner_id, 0, live)).notices.map(row => row.artifact_id), [second.id]);
  assert.deepEqual((await store.listCurrent(A.owner_id, live)).reports.map(row => row.id), [second.id]);
  const reopened = await ObservationStore.open(f.store, allow);
  t.after(() => reopened.close());
  await assert.rejects(reopened.readDetail(first.id, A.owner_id, 'observed', 0, 1, live), { code: 'STRUCTURAL_SOURCE_FORBIDDEN' });
  await assert.rejects(reopened.readRetainedPair(first.id, A.owner_id, live), { code: 'STRUCTURAL_SOURCE_FORBIDDEN' });
  const pair = await reopened.readRetainedPair(second.id, A.owner_id, live);
  assert.equal(pair.observed.text, current.observed.text);
  assert.equal(pair.control_generation, 2);
  assert.equal(pair.workspace_generation, 2);
  assert.deepEqual((await reopened.listCurrent(A.owner_id, live)).reports.map(row => row.id), [second.id]);
});

test('revoked notices before the pull limit cannot starve a later granted notice', async t => {
  const f = await fixture(t), store = await ObservationStore.initialize(f.store, allow);
  t.after(() => store.close());
  const old = sample(); old.control_generation = 1; old.recipients = [];
  const oldArtifact = await store.publish(old);
  for (let i = 0; i < 33; i++) await store.notifyExisting(oldArtifact.id, A.owner_id,
    createHash('sha256').update(`old:${i}`).digest('hex'), 'overlap', allow);
  const current = sample(); current.control_generation = 2;
  const liveArtifact = await store.publish(current);
  const granted = (_, __, ___, generation) => {
    if (generation.control_generation !== 2) throw new BridgeError('STRUCTURAL_SOURCE_FORBIDDEN', 'old generation');
  };
  const pulled = await store.pull(A.owner_id, 0, granted);
  assert.deepEqual(pulled.notices.map(row => row.artifact_id), [liveArtifact.id]);
});

test('later correspondence publishes one idempotent notice for an existing artifact without recapture', async t => {
  const f = await fixture(t), store = await ObservationStore.initialize(f.store, allow);
  t.after(() => store.close());
  const item = sample(); item.recipients = [];
  const artifact = await store.publish(item), subjectId = 'e'.repeat(64);
  const artifactDirectory = join(f.root, 'coordination/observation/artifacts');
  const beforeFiles = await readdir(artifactDirectory);
  const notice = await store.notifyExisting(artifact.id, A.owner_id, subjectId, 'overlap', allow);
  assert.equal(notice.subject_id, subjectId);
  assert.equal(notice.correspondence_state, 'overlap');
  assert.equal(notice.artifact_id, artifact.id);
  assert.equal((await store.notifyExisting(artifact.id, A.owner_id, subjectId, 'overlap', allow)).id, notice.id);
  assert.deepEqual(await readdir(artifactDirectory), beforeFiles);
  assert.equal((await store.pull(A.owner_id, 0, allow)).notices.length, 1);
  await store.ack(A.owner_id, notice.id, allow);
  assert.equal((await store.notifyExisting(artifact.id, A.owner_id, subjectId, 'overlap', allow)).acknowledged, true);
  const resolved = await store.notifyExisting(artifact.id, A.owner_id, subjectId, 'resolved', allow);
  assert.notEqual(resolved.id, notice.id);
  assert.equal(resolved.correspondence_state, 'resolved');
  assert.equal((await store.notifyExisting(artifact.id, A.owner_id, subjectId, 'resolved', allow)).id, resolved.id);
  assert.deepEqual(await readdir(artifactDirectory), beforeFiles);
  assert.deepEqual((await store.pull(A.owner_id, 0, allow)).notices.map(row => row.id), [resolved.id]);
  await store.ack(A.owner_id, resolved.id, allow);
  assert.equal((await store.pull(A.owner_id, 0, allow)).notices.length, 0);
  const renewed = await store.notifyExisting(artifact.id, A.owner_id, subjectId, 'overlap', allow);
  assert.notEqual(renewed.id, notice.id);
  assert.equal((await store.notifyExisting(artifact.id, A.owner_id, subjectId, 'overlap', allow)).id, renewed.id);
  assert.deepEqual((await store.pull(A.owner_id, 0, allow)).notices.map(row => row.id), [renewed.id]);
  await assert.rejects(store.notifyExisting(artifact.id, B.owner_id, subjectId, 'overlap',
    () => { throw new BridgeError('STRUCTURAL_SOURCE_FORBIDDEN', 'revoked'); }), { code: 'STRUCTURAL_SOURCE_FORBIDDEN' });
  const reopened = await ObservationStore.open(f.store, allow);
  t.after(() => reopened.close());
  assert.equal((await reopened.notifyExisting(artifact.id, A.owner_id, subjectId, 'overlap', allow)).id, renewed.id);
});

test('pruning invalidates stale detail and reports a gap with current snapshot', async t => {
  const f = await fixture(t), store = await ObservationStore.initialize(f.store, allow);
  t.after(() => store.close());
  const original = sample(), first = await store.publish(original);
  for (let i = 0; i < 17; i++) {
    const next = sample(`export function f${i}() { return ${i}; }\n`);
    next.report.work_id = original.report.work_id;
    next.report.comparison.input.source.path = original.report.comparison.input.source.path;
    next.report.comparison.limitations = [`sample ${i}`];
    await store.publish(next);
  }
  await assert.rejects(store.readReport(first.id, A.owner_id, allow), { code: 'STRUCTURAL_DETAIL_UNAVAILABLE' });
  const pulled = await store.pull(A.owner_id, 0, allow);
  assert.equal(pulled.gap, true);
  assert.ok(pulled.current.length >= 1);
  assert.ok(pulled.notices.length <= 16);
  assert.ok((await readdir(join(f.root, 'coordination/observation/artifacts'))).length <= 16);
  await assert.rejects(access(join(f.root, 'coordination/observation/artifacts', `${first.id}.json`)), { code: 'ENOENT' });
});

test('v1 observation index migrates atomically on mutation and preserves known watched recipients', async t => {
  const f = await fixture(t), store = await ObservationStore.initialize(f.store, allow);
  t.after(() => store.close());
  const item = sample(); item.recipients = [A.owner_id];
  const artifact = await store.publish(item);
  const path = join(f.root, 'coordination/observation/state.json');
  const old = JSON.parse(await readFile(path, 'utf8'));
  old.schema_version = 1;
  for (const entry of old.artifacts) delete entry.ordinary_recipients;
  await writeFile(path, JSON.stringify(old));
  const reopened = await ObservationStore.open(f.store, allow);
  t.after(() => reopened.close());
  const replay = sample(item.observed.text); replay.report.work_id = item.report.work_id; replay.recipients = [A.owner_id];
  assert.equal((await reopened.publish(replay)).id, artifact.id);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).schema_version, 1);
  const newcomer = sample(item.observed.text); newcomer.report.work_id = item.report.work_id; newcomer.recipients = [B.owner_id];
  await reopened.publish(newcomer);
  const migrated = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(migrated.schema_version, 2);
  assert.deepEqual(migrated.artifacts.at(-1).ordinary_recipients.sort(), [A.owner_id, B.owner_id].sort());
  assert.equal((await reopened.pull(B.owner_id, 0, allow)).notices.filter(row => row.subject_id === undefined).length, 1);
});

test('unsupported state version is preserved rather than reset', async t => {
  const f = await fixture(t), store = await ObservationStore.initialize(f.store, allow);
  t.after(() => store.close());
  const path = join(f.root, 'coordination/observation/state.json');
  const state = JSON.parse(await readFile(path, 'utf8')); state.schema_version = 3;
  await writeFile(path, JSON.stringify(state));
  await assert.rejects(ObservationStore.initialize(f.store, allow), { code: 'OBSERVATION_VERSION_UNSUPPORTED' });
  assert.equal(JSON.parse(await readFile(path, 'utf8')).schema_version, 3);
});
