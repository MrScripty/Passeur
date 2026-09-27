import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { peerDeliveryCandidate, RepositoryRuntime, resolveRepositoryBinding,
  selectPeerDeliveryEvidence } from '../../.passeur-core/src/core/repository-runtime.js';
import { MAX_PEER_DELIVERY_ENVELOPE_BYTES, parsePeerDeliverySource, peerDeliveryEnvelopeBytes,
  peerDeliverySizingEnvelope } from '../../.passeur-core/src/contracts/peer-delivery.js';
import { MAX_CODEX_PEER_DELIVERY_PROMPT_BYTES, peerDeliveryPromptBytes } from '../../.passeur-core/src/agents/report-format.js';
import { selectPeerOverlapEvidence } from '../../.passeur-core/src/observation/overlap.js';
import { serviceFixture, command } from '../fixtures/structural/service-fixture.mjs';
import { TaskStore } from '../../.passeur-core/src/store/task-store.js';
import { operatorToken } from '../../.passeur-core/src/service/operator-token.js';
import { CoordinationStore } from '../../.passeur-core/src/store/coordination-store.js';
import { CoordinationControl } from '../../.passeur-core/src/coordination/control.js';

const task = randomUUID();
const source = { id: randomUUID(), owner: 'a'.repeat(64), workspace_id: 'first',
  revision: 1, state: 'active', input_oid: '1'.repeat(40), object_format: 'sha1',
  intent: 'Keep the tax calculation correct', areas: [{ kind: 'file', path: 'src/example.ts' }],
  readers: [], managed: { task_id: randomUUID(), control_generation: 1,
    intent_truncated: false, areas_source: 'allowed_paths' } };
const target = { ...source, id: randomUUID(), owner: 'b'.repeat(64), workspace_id: 'second',
  intent: 'Keep delivery fee calculation correct',
  managed: { ...source.managed, task_id: task } };
const peerCase = { id: randomUUID(), target: 'refs/heads/main', lead: source.owner,
  members: [source.owner, target.owner], revision: 1, generation: 1, state: 'active',
  external_effect: 'not_started', target_oid: '1'.repeat(40),
  inputs: [source, target].map(work => ({ work_id: work.id, commit_oid: work.input_oid })) };
const pair = { current_work_id: source.id, other_work_id: target.id,
  subject_id: 'c'.repeat(64), pair_id: 'd'.repeat(64),
  input: { kind: 'commit', repository_id: 'repo', object_format: 'sha1',
    commit_oid: '1'.repeat(40), tree_oid: '2'.repeat(40), path: 'src/example.ts' },
  input_range: { start_byte: 0, end_byte: 10 },
  current_change: { kind: 'modified', declaration_changed: false, body_changed: true,
    default_changed: false, evidence_id: 'e'.repeat(64) },
  other_change: { kind: 'modified', declaration_changed: false, body_changed: true,
    default_changed: false, evidence_id: 'f'.repeat(64) } };
const handles = { source_artifact_id: '3'.repeat(64), recipient_artifact_id: '4'.repeat(64) };
const selected = text => ({ schema_version: 1, policy: 'minimal-overlap-v1', evidence_id: '5'.repeat(64),
  subject_id: pair.subject_id, dialect: 'typescript', parser_identity: 'parser',
  extractor_identity: 'extractor', input: { source: pair.input, status: 'present' },
  subject: { key: 'example', kind: 'function', name: 'example', enclosing: [],
    range: pair.input_range, signature: 'example()' },
  changes: [{ observation_id: source.id, kind: 'modified', declaration_changed: false,
    body_changed: true, default_changed: false, observed_source: { source: pair.input, status: 'present' },
    reasons: ['body_changed'], spans: [{ side: 'observed', range: pair.input_range,
      text, omitted_before: false, omitted_after: false, reason: 'body_changed' }] }],
  coverage: 'incomplete', limitations: ['comparison:' + source.id + ':syntax_error'] });
const candidate = (text, first = source, second = target) =>
  peerDeliveryCandidate(pair, peerCase, first, second, task, handles.source_artifact_id,
    selected(text), handles);

test('selected delivery retains both work intents, scope, detail handles and analysis limitations', () => {
  const delivery = candidate('return 1');
  assert.deepEqual(parsePeerDeliverySource(delivery), delivery);
  const content = JSON.parse(delivery.content);
  assert.equal(content.selected_evidence.coverage, 'incomplete');
  assert.ok(content.limitations.includes('comparison:' + source.id + ':syntax_error'));
  assert.deepEqual(content.participants.map(item => item.task_id), [source.managed.task_id, task]);
  assert.deepEqual(content.participants.map(item => item.report_id),
    [handles.source_artifact_id, handles.recipient_artifact_id]);
  assert.deepEqual(content.participants.map(item => item.areas), [source.areas, target.areas]);
  assert.deepEqual(content.participants.map(item => item.intent), [source.intent, target.intent]);
});

test('selected delivery bounds complete escaped content at the 16 KiB contract', () => {
  const tiny = candidate('é\n"');
  assert.ok(Buffer.byteLength(tiny.content, 'utf8') < 16_384);
  const near = candidate('é\n"'.repeat(1900));
  assert.ok(Buffer.byteLength(near.content, 'utf8') <= 16_384);
  assert.ok(peerDeliveryEnvelopeBytes(near, '/tmp/worker') > MAX_PEER_DELIVERY_ENVELOPE_BYTES,
    'a content-only near-limit check must reveal the escaped envelope overrun');
  const fitting = candidate('é\n"'.repeat(1200));
  assert.ok(peerDeliveryEnvelopeBytes(fitting, '/tmp/worker') <= MAX_PEER_DELIVERY_ENVELOPE_BYTES);
  assert.ok(peerDeliveryPromptBytes(peerDeliverySizingEnvelope(fitting, '/tmp/worker'), 'codex') <=
    MAX_CODEX_PEER_DELIVERY_PROMPT_BYTES);
  assert.throws(() => candidate('é\n"'.repeat(5000)),
    { code: 'PEER_DELIVERY_METADATA_TOO_LARGE' });
});

test('required participant metadata that cannot fit has a typed diagnostic', () => {
  const oversized = { ...source, intent: '文"\\'.repeat(5000) };
  assert.throws(() => candidate('x', oversized), { code: 'PEER_DELIVERY_METADATA_TOO_LARGE' });
});

test('16 to 32 KiB source evidence becomes a compact authorized delivery after wrapper sizing', () => {
  const before = `function example() { return "${'a'.repeat(8000)}"; }\n`;
  const after = `function example() { return "${'b'.repeat(8000)}"; }\n`;
  const input = { status: 'present', source: pair.input, mode: '100644',
    content_sha256: createHash('sha256').update(before).digest('hex'),
    byte_length: Buffer.byteLength(before), text: before, consistency: 'immutable_git_blob' };
  const observed = { ...input, source: { kind: 'working_capture', repository_id: 'repo',
    object_format: 'sha1', workspace_id: 'source-workspace', workspace_generation: 1,
    capture_id: randomUUID(), capture_sequence: 1, head_anchor: pair.input.commit_oid,
    path: pair.input.path }, consistency: 'sampled_file_not_atomic', text: after,
    content_sha256: createHash('sha256').update(after).digest('hex') };
  const declaration = text => ({ key: 'example', kind: 'function', name: 'example',
    enclosing: [], range: { start_byte: 0, end_byte: Buffer.byteLength(text) },
    signature: 'function example()', parameters: [], result: { state: 'not_declared' },
    header_complete: true, body_digest: createHash('sha256').update(text).digest('hex'),
    default_digests: [] });
  const selection = { subject_id: pair.subject_id, dialect: 'typescript', parser_identity: 'parser',
    extractor_identity: 'extractor', input, declaration: declaration(before),
    observations: [{ observation_id: source.id, observed, change: { kind: 'modified',
      declaration_changed: false, body_changed: true, default_changed: false,
      input: declaration(before), observed: declaration(after) } }] };
  const whole = selectPeerOverlapEvidence(selection);
  assert.ok(Buffer.byteLength(JSON.stringify(whole)) > 16_384);
  assert.ok(Buffer.byteLength(JSON.stringify(whole)) < 32_768);
  const compact = selectPeerDeliveryEvidence(selection, pair, peerCase, source, target, task,
    handles, '/tmp/worker');
  const delivery = peerDeliveryCandidate(pair, peerCase, source, target, task,
    handles.source_artifact_id, compact, handles);
  assert.equal(compact.coverage, 'incomplete');
  assert.ok(compact.limitations.includes('evidence_budget_exceeded'));
  assert.equal(compact.changes[0].spans.length, 0);
  assert.ok(peerDeliveryEnvelopeBytes(delivery, '/tmp/worker') <= MAX_PEER_DELIVERY_ENVELOPE_BYTES);
  assert.ok(peerDeliveryPromptBytes(peerDeliverySizingEnvelope(delivery, '/tmp/worker'), 'codex') <=
    MAX_CODEX_PEER_DELIVERY_PROMPT_BYTES);
  assert.deepEqual(JSON.parse(delivery.content).participants.map(item => item.report_id),
    [handles.source_artifact_id, handles.recipient_artifact_id]);
});

test('escaped participant intents still allow compact source evidence and detail handles', () => {
  const before = `function example() { return "${'a'.repeat(6000)}"; }\n`;
  const after = `function example() { return "${'b'.repeat(6000)}"; }\n`;
  const file = (text, observed) => ({ status: 'present', mode: '100644', text,
    byte_length: Buffer.byteLength(text), content_sha256: createHash('sha256').update(text).digest('hex'),
    consistency: observed ? 'sampled_file_not_atomic' : 'immutable_git_blob',
    source: observed ? { kind: 'working_capture', repository_id: 'repo', object_format: 'sha1',
      workspace_id: 'source-workspace', workspace_generation: 1, capture_id: randomUUID(),
      capture_sequence: 1, head_anchor: pair.input.commit_oid, path: pair.input.path } : pair.input });
  const declaration = text => ({ key: 'example', kind: 'function', name: 'example', enclosing: [],
    range: { start_byte: 0, end_byte: Buffer.byteLength(text) }, signature: 'function example()',
    parameters: [], result: { state: 'not_declared' }, header_complete: true, default_digests: [],
    body_digest: createHash('sha256').update(text).digest('hex') });
  const selection = { subject_id: pair.subject_id, dialect: 'typescript', parser_identity: 'parser',
    extractor_identity: 'extractor', input: file(before, false), declaration: declaration(before),
    observations: [{ observation_id: source.id, observed: file(after, true), change: {
      kind: 'modified', declaration_changed: false, body_changed: true, default_changed: false,
      input: declaration(before), observed: declaration(after) } }] };
  const escapedIntent = '"\\文'.repeat(250);
  assert.equal(Buffer.byteLength(escapedIntent), 1250);
  const first = { ...source, intent: escapedIntent }, second = { ...target, intent: escapedIntent };
  const compact = selectPeerDeliveryEvidence(selection, pair, peerCase, first, second, task,
    handles, '/tmp/worker');
  const delivery = peerDeliveryCandidate(pair, peerCase, first, second, task,
    handles.source_artifact_id, compact, handles);
  assert.ok(delivery);
  assert.deepEqual(parsePeerDeliverySource(delivery), delivery);
  assert.ok(peerDeliveryEnvelopeBytes(delivery, '/tmp/worker') <= MAX_PEER_DELIVERY_ENVELOPE_BYTES);
  assert.ok(peerDeliveryPromptBytes(peerDeliverySizingEnvelope(delivery, '/tmp/worker'), 'codex') <=
    MAX_CODEX_PEER_DELIVERY_PROMPT_BYTES);
  assert.deepEqual(JSON.parse(delivery.content).participants.map(item => item.report_id),
    [handles.source_artifact_id, handles.recipient_artifact_id]);
  assert.ok(compact.limitations.includes('evidence_budget_exceeded'));
});

test('real incomplete parser coverage reaches the queued peer delivery', async t => {
  const fixture = await serviceFixture(t);
  await fixture.service.close();
  const intent = { project: fixture.root, stateRoot: fixture.state,
    profilePath: join(fixture.temp, 'missing-profile.json') };
  const binding = await resolveRepositoryBinding(intent, {}, new AbortController().signal);
  const token = await operatorToken(binding, true);
  const actors = [{ owner_id: createHash('sha256').update(token).digest('hex'), client_id: randomUUID() },
    { owner_id: 'b'.repeat(64), client_id: randomUUID() }];
  const workers = [0, 1].map(index => {
    let release;
    const hold = new Promise(resolve => { release = resolve; });
    return { release, async run(input) {
      const text = `export function run() { return ${index + 1}; }\n` +
        (index === 0 ? 'export const broken = ;\n' : '');
      await writeFile(join(input.workspace, 'source.ts'), text);
      const turn_id = randomUUID();
      await input.onEvent({ kind: 'turn_started', turn_id });
      await input.onEvent({ kind: 'turn_settled', turn_id, terminal: 'completed' });
      await hold;
      return { status: 'completed', worker_stop: 'confirmed', worker_assessment: 'met',
        summary: 'Controlled peer stopped', blockers: [], questions: [], checks: [] };
    } };
  });
  const store = new TaskStore(binding.storeRoot);
  const runtime = new RepositoryRuntime(intent, { package_version: 'fixture', build_id: 'fixture',
    mode: 'development', node_version: process.version, node_executable: process.execPath,
    pid: process.pid, started_at: new Date().toISOString() }, {
    store: () => store,
    profile: async () => ({ schema_version: 3, execution: {
      stop_grace_ms: 1000, max_workers: 2, max_queued_tasks: 2, max_clients: 32,
      max_waiters: 128, max_pending_inputs: 16, max_control_receipts: 512,
      implementation: { enabled: true, worktree_root: join(fixture.temp, 'managed-worktrees') },
    }, agents: workers.map((_, index) => ({ agent_id: `peer${index}`, adapter_id: `peer${index}`,
      description: '', enabled: true, options: {} })) }),
    definitions: Object.fromEntries(workers.map((worker, index) => [`peer${index}`, {
      configure: () => ({ modes: ['implement'], contract: 'controlled-peer/1', configuration: {},
        worker: { run: input => worker.run(input) } }),
    }])),
  });
  fixture.sessions.push({ close: async () => { workers.forEach(worker => worker.release()); await runtime.shutdown(); } });
  await runtime.coordinate({ schema_version: 1, kind: 'initialize', limits: fixture.limits }, actors[0], fixture.root);
  const submissions = await Promise.all(workers.map((_, index) => runtime.submitCoordinated({
    schema_version: 2, kind: 'inline', assignment: { schema_version: 3,
      agent_id: `peer${index}`, request_key: randomUUID(), mode: 'implement',
      objective: `Change source.ts for peer ${index}`, context: 'Controlled overlapping edits',
      acceptance_criteria: ['Edit source.ts'], allowed_paths: ['source.ts'],
      base_commit: fixture.base, target_ref: 'refs/heads/main' },
  }, actors[index], fixture.root, new AbortController().signal)));
  const ids = submissions.map(item => item.task_id);
  let delivered;
  for (let attempt = 0; attempt < 200 && !delivered; attempt++) {
    for (const [index, id] of ids.entries()) {
      try { await runtime.structuralRefresh(id, actors[index]); }
      catch (error) { if (!['STRUCTURAL_SOURCE_FORBIDDEN', 'COORDINATION_NOT_FOUND'].includes(error.code)) throw error; }
    }
    const controls = await Promise.all(ids.map(id => store.readControl(id)));
    delivered = controls.flatMap(control => control.peer_deliveries ?? [])
      .map(record => record.envelope).find(envelope => {
        const content = JSON.parse(envelope.content);
        return content.selected_evidence?.limitations?.some(value => value.includes('comparison:'));
      });
    if (!delivered) await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.ok(delivered, 'the actual runtime producer must queue selected overlap evidence');
  const content = JSON.parse(delivered.content);
  assert.equal(content.selected_evidence.coverage, 'incomplete');
  assert.ok(content.selected_evidence.limitations.some(value => value.includes('comparison:') &&
    (value.includes('syntax') || value.includes('parse'))), JSON.stringify(content.selected_evidence.limitations));
});

async function currentCaptureReplacementScenario(t, retainedRestoreRace = false) {
  const fixture = await serviceFixture(t);
  await fixture.service.close();
  const intent = { project: fixture.root, stateRoot: fixture.state,
    profilePath: join(fixture.temp, 'missing-profile.json') };
  const binding = await resolveRepositoryBinding(intent, {}, new AbortController().signal);
  const token = await operatorToken(binding, true);
  const actors = [{ owner_id: createHash('sha256').update(token).digest('hex'), client_id: randomUUID() },
    { owner_id: 'b'.repeat(64), client_id: randomUUID() }];
  let releaseNative, releasePeer, captured = false, deliveredStatus, observedStatus;
  let restoreRetained, releaseRestore, reachedRestore;
  const restorePaused = new Promise(resolve => { reachedRestore = resolve; });
  const restoreHold = new Promise(resolve => { releaseRestore = resolve; });
  let restoreWorkId, oldRetainedId;
  const nativeHold = new Promise(resolve => { releaseNative = resolve; });
  const peerHold = new Promise(resolve => { releasePeer = resolve; });
  const workspaces = [];
  const workers = [0, 1].map(index => ({ async run(input) {
    workspaces[index] = input.workspace;
    await writeFile(join(input.workspace, 'source.ts'), `export function run() { return ${index + 1}; }\n`);
    await input.onEvent({ kind: 'turn_started', turn_id: `initial-${index}`, native_session_id: `session-${index}` });
    await input.onEvent({ kind: 'turn_settled', turn_id: `initial-${index}`, native_session_id: `session-${index}`, terminal: 'completed' });
    if (index === 1) await nativeHold;
    else {
      let envelope;
      for (let attempt = 0; attempt < 200 && !envelope; attempt++) {
        envelope = await input.peer.next();
        if (!envelope) await new Promise(resolve => setTimeout(resolve, 25));
      }
      if (!envelope) throw Error('controlled peer envelope was never queued');
      await input.onEvent({ kind: 'turn_started', turn_id: 'peer-native', native_session_id: 'session-0' });
      captured = true; await peerHold;
      deliveredStatus = await input.peer.delivered(envelope.idempotency_key, 'peer-native', 'session-0');
      await input.onEvent({ kind: 'turn_settled', turn_id: 'peer-native', native_session_id: 'session-0', terminal: 'completed' });
      observedStatus = await input.peer.observed(envelope.idempotency_key, 'peer-native', 'session-0');
    }
    return { status: 'completed', worker_stop: 'confirmed', worker_assessment: 'met',
      summary: 'Controlled peer stopped', blockers: [], questions: [], checks: [] };
  } }));
  const store = new TaskStore(binding.storeRoot);
  const runtime = new RepositoryRuntime(intent, { package_version: 'fixture', build_id: 'fixture',
    mode: 'development', node_version: process.version, node_executable: process.execPath,
    pid: process.pid, started_at: new Date().toISOString() }, {
    ...(retainedRestoreRace ? {
      onRetainedCaptureRestoreForTest: restore => { restoreRetained = restore; },
      beforeRetainedCaptureInstallForTest: async (workId, artifactId) => {
        if (workId !== restoreWorkId) return;
        oldRetainedId = artifactId;
        reachedRestore();
        await restoreHold;
      },
    } : {}),
    store: () => store,
    profile: async () => ({ schema_version: 3, execution: {
      stop_grace_ms: 1000, max_workers: 2, max_queued_tasks: 2, max_clients: 32,
      max_waiters: 128, max_pending_inputs: 16, max_control_receipts: 512,
      implementation: { enabled: true, worktree_root: join(fixture.temp, 'managed-worktrees') },
    }, agents: workers.map((_, index) => ({ agent_id: `peer${index}`, adapter_id: `peer${index}`,
      description: '', enabled: true, options: {} })) }),
    definitions: Object.fromEntries(workers.map((worker, index) => [`peer${index}`, {
      configure: () => ({ modes: ['implement'], contract: 'controlled-peer/1', configuration: {},
        worker: { run: input => worker.run(input) } }),
    }])),
  });
  fixture.sessions.push({ close: async () => { releaseRestore(); releasePeer(); releaseNative(); await runtime.shutdown(); } });
  await runtime.coordinate({ schema_version: 1, kind: 'initialize', limits: fixture.limits }, actors[0], fixture.root);
  const submissions = await Promise.all(workers.map((_, index) => runtime.submitCoordinated({
    schema_version: 2, kind: 'inline', assignment: { schema_version: 3,
      agent_id: `peer${index}`, request_key: randomUUID(), mode: 'implement',
      objective: `Change source.ts for peer ${index}`, context: '', acceptance_criteria: ['Edit source.ts'],
      allowed_paths: ['source.ts'], base_commit: fixture.base, target_ref: 'refs/heads/main' },
  }, actors[index], fixture.root, new AbortController().signal)));
  const ids = submissions.map(item => item.task_id);
  for (let attempt = 0; attempt < 160 && !captured; attempt++) {
    for (const [index, id] of ids.entries()) {
      try { await runtime.structuralRefresh(id, actors[index]); }
      catch (error) { if (!['STRUCTURAL_SOURCE_FORBIDDEN', 'COORDINATION_NOT_FOUND'].includes(error.code)) throw error; }
    }
    if (!captured) await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.ok(captured, 'a real observed pair must reach a native peer turn');
  const before = JSON.parse(await readFile(join(binding.storeRoot, 'coordination', 'control.json'), 'utf8'));
  let restoration;
  if (retainedRestoreRace) {
    restoreWorkId = before.works.find(work => work.managed?.task_id === ids[1])?.id;
    assert.ok(restoreWorkId && restoreRetained);
    restoration = restoreRetained(restoreWorkId);
    await restorePaused;
    assert.ok(oldRetainedId, 'the paused comparison used a genuine retained source capture');
  }
  await writeFile(join(workspaces[1], 'source.ts'), 'export function run() { return 3; }\n');
  await runtime.structuralRefresh(ids[1], actors[1]);
  if (retainedRestoreRace) {
    const current = (await runtime.structuralCurrent(actors[1])).reports
      .find(report => report.work_id === restoreWorkId && report.path === 'source.ts');
    assert.ok(current && current.id !== oldRetainedId, 'newer captured source replaced the retained artifact');
    releaseRestore();
    assert.equal(await restoration, false, 'older retained comparison cannot overwrite newer index state');
  }
  const after = JSON.parse(await readFile(join(binding.storeRoot, 'coordination', 'control.json'), 'utf8'));
  assert.equal(after.cases[0].revision, before.cases[0].revision);
  assert.deepEqual(after.works.map(work => work.revision), before.works.map(work => work.revision));
  releasePeer();
  for (let attempt = 0; attempt < 120 && !observedStatus; attempt++)
    await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(deliveredStatus, 'superseded');
  assert.equal(observedStatus, 'superseded');
  const records = await store.readPeerDeliveries(ids[0]);
  assert.ok(records.some(record => record.state === 'observed' && record.native_turn_id === 'peer-native'));
}

test('current capture replacement preserves exact native receipt without changing case or work revision', t =>
  currentCaptureReplacementScenario(t));
test('older retained comparison cannot overwrite a newer same-live capture', t =>
  currentCaptureReplacementScenario(t, true));

async function pendingObservedCaseScenario(t, captureRace = false, removalRace = false) {
  const fixture = await serviceFixture(t);
  await fixture.service.close();
  const intent = { project: fixture.root, stateRoot: fixture.state,
    profilePath: join(fixture.temp, 'missing-profile.json') };
  const binding = await resolveRepositoryBinding(intent, {}, new AbortController().signal);
  const token = await operatorToken(binding, true);
  const actor = { owner_id: createHash('sha256').update(token).digest('hex'), client_id: randomUUID() };
  const pause = () => { let release; const promise = new Promise(resolve => { release = resolve; });
    return { promise, release }; };
  const nativeHolds = [pause(), pause(), pause()], obsoleteTurn = pause(), continuePeer = pause();
  const captureOrder = [];
  let captureRaceWorkId, captureRaceArmed = false;
  const removalOrder = [];
  let removalWorkId, removalArmed = false;
  const workspaces = [], received = [], statuses = [], settlementAttempts = [];
  let otherRevised, obsoleteRevised, obsoleteObserved, settlementRelease, stop = false;
  const workers = [0, 1, 2].map(index => ({ async run(input) {
    workspaces[index] = input.workspace;
    await writeFile(join(input.workspace, 'source.ts'), `export function run() { return ${index + 1}; }\n`);
    await input.onEvent({ kind: 'turn_started', turn_id: `initial-${index}`, native_session_id: `session-${index}` });
    await input.onEvent({ kind: 'turn_settled', turn_id: `initial-${index}`, native_session_id: `session-${index}`, terminal: 'completed' });
    if (index !== 0) await nativeHolds[index].promise;
    else {
      let sequence = 0;
      while (!stop) {
        const envelope = await input.peer.next();
        if (!envelope) { await new Promise(resolve => setTimeout(resolve, 25)); continue; }
        const turn_id = `peer-0-${++sequence}`;
        await input.onEvent({ kind: 'turn_started', turn_id, native_session_id: 'session-0' });
        if (envelope.case_revision > 2 && otherRevised &&
          envelope.source_work_id !== otherRevised.source_work_id && !obsoleteRevised) {
          obsoleteRevised = envelope;
          await obsoleteTurn.promise;
        }
        const delivered = await input.peer.delivered(envelope.idempotency_key, turn_id, 'session-0');
        await input.onEvent({ kind: 'turn_settled', turn_id, native_session_id: 'session-0', terminal: 'completed' });
        const observed = await input.peer.observed(envelope.idempotency_key, turn_id, 'session-0');
        received.push(envelope); statuses.push({ delivered, observed });
        if (envelope.case_revision > 2 && !otherRevised) otherRevised = envelope;
        if (envelope === obsoleteRevised) { obsoleteObserved = observed; await continuePeer.promise; }
      }
    }
    return { status: 'completed', worker_stop: 'confirmed', worker_assessment: 'met',
      summary: 'Controlled peer stopped', blockers: [], questions: [], checks: [] };
  } }));
  const store = new TaskStore(binding.storeRoot);
  const runtime = new RepositoryRuntime(intent, { package_version: 'fixture', build_id: 'fixture',
    mode: 'development', node_version: process.version, node_executable: process.execPath,
    pid: process.pid, started_at: new Date().toISOString() }, {
    enableObservedCaseExtensionForTest: true,
    store: () => store,
    onObservedCaseSettlement: attempt => settlementAttempts.push(attempt),
    ...(captureRace ? {
      onCapturePublicationAttemptForTest: workId => {
        if (captureRaceArmed && workId === captureRaceWorkId) {
          captureOrder.push('capture-attempt');
        }
      },
      onCapturePublicationCompletedForTest: workId => {
        if (captureRaceArmed && workId === captureRaceWorkId) {
          captureOrder.push('capture-published');
        }
      },
    } : {}),
    ...(removalRace ? {
      onCaptureRemovalAttemptForTest: workId => {
        if (removalArmed && workId === removalWorkId) removalOrder.push('remove-attempt');
      },
      onCaptureRemovalCompletedForTest: workId => {
        if (removalArmed && workId === removalWorkId) removalOrder.push('remove-completed');
      },
    } : {}),
    profile: async () => ({ schema_version: 3, execution: {
      stop_grace_ms: 1000, max_workers: 3, max_queued_tasks: 3, max_clients: 32,
      max_waiters: 128, max_pending_inputs: 16, max_control_receipts: 512,
      implementation: { enabled: true, worktree_root: join(fixture.temp, 'managed-worktrees') },
    }, agents: workers.map((_, index) => ({ agent_id: `peer${index}`, adapter_id: `peer${index}`,
      description: '', enabled: true, options: {} })) }),
    definitions: Object.fromEntries(workers.map((worker, index) => [`peer${index}`, {
      configure: () => ({ modes: ['implement'], contract: 'controlled-peer/1', configuration: {},
        worker: { run: input => worker.run(input) } }),
    }])),
  });
  fixture.sessions.push({ close: async () => { stop = true; obsoleteTurn.release(); continuePeer.release();
    settlementRelease?.release(); nativeHolds.forEach(hold => hold.release()); await runtime.shutdown(); } });
  await runtime.coordinate({ schema_version: 1, kind: 'initialize', limits: fixture.limits }, actor, fixture.root);
  const submit = index => runtime.submitCoordinated({ schema_version: 2, kind: 'inline',
    assignment: { schema_version: 3, agent_id: `peer${index}`, request_key: randomUUID(),
      mode: 'implement', objective: `Change source.ts for peer ${index}`, context: '',
      acceptance_criteria: ['Edit source.ts'], allowed_paths: ['source.ts'],
      base_commit: fixture.base, target_ref: 'refs/heads/main' },
  }, actor, fixture.root, new AbortController().signal);
  const ids = (await Promise.all([submit(0), submit(1)])).map(item => item.task_id);
  const state = async () => JSON.parse(await readFile(join(binding.storeRoot, 'coordination', 'control.json'), 'utf8'));
  const waitFor = async (description, read, predicate, attempts = 160) => {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const value = await read(); if (predicate(value)) return value;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.fail(`${description} did not become true`);
  };
  const refresh = async index => {
    try { await runtime.structuralRefresh(ids[index], actor); }
    catch (error) { if (!['STRUCTURAL_SOURCE_FORBIDDEN', 'COORDINATION_NOT_FOUND'].includes(error.code)) throw error; }
  };
  let pairCase;
  for (let attempt = 0; attempt < 160 && !pairCase; attempt++) {
    await refresh(0); await refresh(1);
    pairCase = (await state()).cases.find(item => item.observed_origin === 'selected' && item.inputs.length === 2);
    if (!pairCase) await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.ok(pairCase, 'two real captures must establish an observed case');
  await waitFor('original pair observed before revising its case', () => store.readPeerDeliveries(ids[0]),
    records => records.some(record => record.state === 'observed' &&
      record.envelope.case_id === pairCase.id && record.envelope.case_revision === pairCase.revision), 400);
  await refresh(0); await refresh(1);
  const third = await submit(2); ids.push(third.task_id);
  await waitFor('third native task', () => store.readControl(third.task_id),
    control => control.native.state === 'observed_live' && control.native.coverage === 'turn_scoped');
  const before = await state();
  const workIds = ids.map(id => before.works.find(work => work.managed?.task_id === id)?.id);
  assert.ok(workIds.every(Boolean), 'all three managed works are registered');
  const control = new CoordinationControl(await CoordinationStore.open(binding.storeRoot, binding.repositoryId, () => {}));
  t.after(() => control.close());
  await refresh(2);
  const joined = await waitFor('controlled third worker extension', async () =>
    (await state()).cases.find(item => item.id === pairCase.id && item.inputs.length === 3), Boolean, 400);
  assert.deepEqual([...joined.delivery_pending].sort(), [...workIds].sort());
  await waitFor('other revised source observed before obsolete final source', async () => otherRevised, Boolean);
  await waitFor('final needed revised envelope held', async () => obsoleteRevised, Boolean);
  assert.notEqual(otherRevised.source_work_id, obsoleteRevised.source_work_id);
  assert.ok((await store.readPeerDeliveries(ids[0])).some(record => record.state === 'observed' &&
    record.envelope.delivery_id === otherRevised.delivery_id));
  const sourceIndex = workIds.indexOf(obsoleteRevised.source_work_id);
  assert.ok(sourceIndex > 0, 'held revised envelope comes from another worker');
  await writeFile(join(workspaces[sourceIndex], 'source.ts'), 'export function run() { return 42; }\n');
  await refresh(sourceIndex);
  const changed = await state();
  assert.equal(changed.cases.find(item => item.id === joined.id).revision, joined.revision);
  assert.deepEqual(changed.works.map(work => work.revision), before.works.map(work => work.revision));
  obsoleteTurn.release();
  await waitFor('historical observed receipt', async () => obsoleteObserved, Boolean);
  assert.equal(obsoleteObserved, 'superseded');
  const historical = await store.readPeerDeliveries(ids[0]);
  assert.ok(historical.some(record => record.state === 'observed' &&
    record.envelope.delivery_id === obsoleteRevised.delivery_id));
  assert.ok(historical.some(record => record.state === 'observed' &&
    record.envelope.delivery_id === otherRevised.delivery_id));
  const obsoleteAttempt = await waitFor('obsolete final source reconciliation completed', async () =>
    settlementAttempts.find(attempt => attempt.recipient_work_id === workIds[0] &&
      attempt.observed_delivery_ids.includes(obsoleteRevised.delivery_id)), Boolean, 400);
  assert.equal(obsoleteAttempt.outcome, 'rejected');
  assert.ok((await state()).cases.find(item => item.id === joined.id).delivery_pending.includes(workIds[0]),
    'an obsolete observed native turn cannot discharge the current obligation');
  const reopenedTasks = new TaskStore(binding.storeRoot);
  const reopenedMetadata = await CoordinationStore.open(binding.storeRoot, binding.repositoryId, () => {});
  try {
    assert.ok((await reopenedTasks.readPeerDeliveries(ids[0])).some(record => record.state === 'observed' &&
      record.envelope.delivery_id === obsoleteRevised.delivery_id));
    assert.ok((await reopenedMetadata.snapshot()).cases.find(item => item.id === joined.id).delivery_pending.includes(workIds[0]));
  } finally { await reopenedMetadata.close(); }
  const settlementEntered = pause(), firstGuardFinished = pause(); settlementRelease = pause();
  const observeDelivery = CoordinationControl.prototype.observeCaseDelivery;
  let guarded = false, guardRejected = false, pendingAtGuardRejection = false;
  CoordinationControl.prototype.observeCaseDelivery = async function (...args) {
    let firstAttempt = false;
    if (args[1].case_id === joined.id && args[1].recipient_work_id === workIds[0]) {
      if (!guarded) { guarded = true; firstAttempt = true; settlementEntered.release(); }
      await settlementRelease.promise;
      if (!firstAttempt) await firstGuardFinished.promise;
    }
    try {
      const result = await observeDelivery.apply(this, args);
      if (captureRace && firstAttempt) captureOrder.push('settled');
      return result;
    }
    catch (error) {
      if (firstAttempt && error.code === 'PEER_DELIVERY_STALE') {
        const snapshot = await this.store.snapshot();
        pendingAtGuardRejection = snapshot.cases.find(item => item.id === joined.id)
          .delivery_pending.includes(workIds[0]) &&
          !snapshot.cases.find(item => item.id === joined.id).delivery_observed.some(item => item.work_id === workIds[0]);
        if (removalRace) removalOrder.push('settlement-rejected');
        guardRejected = true;
      }
      throw error;
    } finally { if (firstAttempt) firstGuardFinished.release(); }
  };
  t.after(() => { settlementRelease.release(); firstGuardFinished.release();
    CoordinationControl.prototype.observeCaseDelivery = observeDelivery; });
  continuePeer.release();
  await waitFor('current evidence reached guarded metadata settlement', async () => guarded, Boolean, 400);
  if (captureRace) {
    captureRaceWorkId = workIds[sourceIndex]; captureRaceArmed = true;
    const oldArtifact = (await runtime.structuralCurrent(actor)).reports
      .find(report => report.work_id === captureRaceWorkId && report.path === 'source.ts')?.id;
    assert.ok(oldArtifact, 'selected source has an exact retained capture before replacement');
    await writeFile(join(workspaces[sourceIndex], 'source.ts'), 'export function run() { return 43; }\n');
    const replacementRefresh = refresh(sourceIndex);
    await waitFor('selected capture publication reached its reservation', async () =>
      captureOrder.includes('capture-attempt'), Boolean, 400);
    assert.ok(!captureOrder.includes('capture-published'));
    assert.equal((await runtime.structuralCurrent(actor)).reports
      .find(report => report.work_id === captureRaceWorkId && report.path === 'source.ts')?.id,
    oldArtifact, 'selected publication waits while current receipt settlement holds capture protection');
    settlementRelease.release();
    await waitFor('guarded current receipt committed before capture replacement', async () =>
      (await state()).cases.find(item => item.id === joined.id).delivery_observed.some(item => item.work_id === workIds[0]), Boolean);
    await replacementRefresh;
    await waitFor('selected capture published after settlement', async () =>
      captureOrder.includes('capture-published'), Boolean, 400);
    assert.ok(captureOrder.indexOf('settled') < captureOrder.indexOf('capture-published'));
    const completed = await waitFor('settlement observer after capture race', async () =>
      settlementAttempts.find(attempt => attempt.recipient_work_id === workIds[0] &&
        attempt.outcome === 'completed'), Boolean);
    assert.ok(completed.observed_delivery_ids.includes(received.find(envelope =>
      envelope.case_revision === joined.revision && envelope.source_work_id === obsoleteRevised.source_work_id &&
      envelope.delivery_id !== obsoleteRevised.delivery_id)?.delivery_id));
    assert.ok((await store.readPeerDeliveries(ids[0])).some(record => record.state === 'observed' &&
      record.envelope.delivery_id === obsoleteRevised.delivery_id), 'obsolete native receipt remains historical');
    return;
  }
  if (removalRace) {
    const selectedSource = workIds[sourceIndex];
    removalWorkId = selectedSource; removalArmed = true;
    const sourceRevision = (await state()).works.find(work => work.id === selectedSource).revision;
    const closing = runtime.coordinate(command({ kind: 'close_work', operation_key: randomUUID(),
      work_id: selectedSource, expected_revision: sourceRevision }), actor, fixture.root);
    await waitFor('selected work closure published before capture removal', async () =>
      (await state()).works.find(work => work.id === selectedSource)?.state === 'closed', Boolean, 400);
    await waitFor('selected capture removal reached protected mutation', async () =>
      removalOrder.includes('remove-attempt'), Boolean, 400);
    assert.ok(!removalOrder.includes('remove-completed'),
      'selected capture cannot be removed while exact receipt settlement owns its task/capture fence');
    assert.ok((await state()).cases.find(item => item.id === joined.id).delivery_pending.includes(workIds[0]));
    settlementRelease.release();
    await waitFor('closed selected source rejected stale settlement', async () => guardRejected, Boolean, 400);
    await closing;
    assert.ok(removalOrder.includes('remove-completed'));
    assert.ok(removalOrder.indexOf('settlement-rejected') < removalOrder.indexOf('remove-completed'));
    assert.ok(pendingAtGuardRejection, 'closed source cannot discharge a pending recipient');
    assert.ok((await store.readPeerDeliveries(ids[0])).some(record => record.state === 'observed' &&
      record.envelope.delivery_id === obsoleteRevised.delivery_id), 'obsolete native receipt remains historical');
    assert.ok((await state()).cases.find(item => item.id === joined.id).delivery_pending.includes(workIds[0]));
    return;
  }
  await control.execute(actor, { kind: 'post_note', operation_key: randomUUID(),
    subject: { kind: 'case', id: joined.id }, note_kind: 'statement', text: 'unrelated metadata revision', parties: [] });
  assert.ok((await state()).cases.find(item => item.id === joined.id).delivery_pending.includes(workIds[0]),
    'a pending obligation remains held before the guarded commit');
  settlementRelease.release();
  await waitFor('stale metadata guard rejected earlier proof', async () => guardRejected, Boolean);
  assert.ok(pendingAtGuardRejection, 'rejected stale proof publishes no observed delivery receipt');
  let completedAttempt;
  try { completedAttempt = await waitFor('fresh current peer evidence reconciliation completed', async () =>
    settlementAttempts.find(attempt => attempt.recipient_work_id === workIds[0] &&
      attempt.outcome === 'completed'), Boolean, 400); }
  catch (error) {
    const latest = await state(), records = await store.readPeerDeliveries(ids[0]);
    throw new Error(`${error.message}: ${JSON.stringify({ pending: latest.cases.find(item => item.id === joined.id)?.delivery_pending,
      deliveries: records.filter(record => record.envelope.case_id === joined.id).map(record => ({
        revision: record.envelope.case_revision, source: record.envelope.source_work_id,
        state: record.state, delivery: record.envelope.delivery_id })),
      received: received.map(envelope => ({ revision: envelope.case_revision, source: envelope.source_work_id,
        delivery: envelope.delivery_id })), statuses, guardRejected, runtime: runtime.status().coordination })}`);
  }
  assert.ok(statuses.some(item => item.observed === 'current'));
  const replacement = received.find(envelope => envelope.case_revision === joined.revision &&
    envelope.source_work_id === obsoleteRevised.source_work_id && envelope.delivery_id !== obsoleteRevised.delivery_id);
  assert.ok(replacement);
  const settled = await state();
  assert.ok(!settled.cases.find(item => item.id === joined.id).delivery_pending.includes(workIds[0]));
  assert.equal(settled.cases.find(item => item.id === joined.id).delivery_observed.filter(item => item.work_id === workIds[0]).length, 1);
  assert.ok(completedAttempt.observed_delivery_ids.includes(replacement.delivery_id));
  assert.equal(settlementAttempts.filter(attempt => attempt.recipient_work_id === workIds[0] &&
    attempt.outcome === 'completed').length, 1);
}

test('pending observed case keeps an obsolete native receipt pending until fresh peer evidence is observed', t =>
  pendingObservedCaseScenario(t));
test('selected capture replacement follows a guarded exact receipt settlement', t =>
  pendingObservedCaseScenario(t, true));
test('selected capture removal follows closed-work authority and cannot settle an old receipt', t =>
  pendingObservedCaseScenario(t, false, true));

async function observedExtensionScenario(t, enable, replaceRun = false, partialQueue = false) {
  const fixture = await serviceFixture(t);
  await fixture.service.close();
  const intent = { project: fixture.root, stateRoot: fixture.state,
    profilePath: join(fixture.temp, 'missing-profile.json') };
  const binding = await resolveRepositoryBinding(intent, {}, new AbortController().signal);
  const token = await operatorToken(binding, true);
  const actors = [createHash('sha256').update(token).digest('hex'), 'b'.repeat(64), 'c'.repeat(64)]
    .map(owner_id => ({ owner_id, client_id: randomUUID() }));
  const stops = [0, 1, 2].map(() => {
    let release; const promise = new Promise(resolve => { release = resolve; });
    return { promise, release };
  });
  const workers = stops.map((stop, index) => ({ async run(input) {
    await writeFile(join(input.workspace, 'source.ts'), `export function run() { return ${index + 1}; }\n`);
    await input.onEvent({ kind: 'turn_started', turn_id: `initial-${index}`, native_session_id: `session-${index}` });
    await input.onEvent({ kind: 'turn_settled', turn_id: `initial-${index}`,
      native_session_id: `session-${index}`, terminal: 'completed' });
    await stop.promise;
    return { status: 'completed', worker_stop: 'confirmed', worker_assessment: 'met',
      summary: 'Controlled peer stopped', blockers: [], questions: [], checks: [] };
  } }));
  let replacedTask;
  let interruptRevisedQueue = partialQueue;
  let retrySelectedCase;
  const allowedDirected = new Set();
  const store = new TaskStore(binding.storeRoot);
  const runtime = new RepositoryRuntime(intent, { package_version: 'fixture', build_id: 'fixture',
    mode: 'development', node_version: process.version, node_executable: process.execPath,
    pid: process.pid, started_at: new Date().toISOString() }, {
    ...(enable ? { enableObservedCaseExtensionForTest: true } : {}),
    ...(replaceRun ? { onObservedCaseSlotsReservedForTest: async (taskIds, controls) => {
      if (replacedTask) return;
      replacedTask = taskIds[2];
      await controls.change(replacedTask, state => { state.native.run_id = randomUUID(); });
    } } : {}),
    ...(partialQueue ? { beforeObservedCaseDeliveryQueueForTest: edge => {
      if (!interruptRevisedQueue) return;
      const key = `${edge.recipient_task_id}:${edge.source_work_id}`;
      if (!allowedDirected.has(key) && allowedDirected.size === 2)
        throw new Error('controlled postcommit queue interruption');
      allowedDirected.add(key);
    }, onObservedCaseExtensionPublishedForTest: (_caseId, retry) => { retrySelectedCase = retry; } } : {}),
    store: () => store,
    profile: async () => ({ schema_version: 3, execution: {
      stop_grace_ms: 1000, max_workers: 3, max_queued_tasks: 3, max_clients: 32,
      max_waiters: 128, max_pending_inputs: 16, max_control_receipts: 512,
      implementation: { enabled: true, worktree_root: join(fixture.temp, 'managed-worktrees') },
    }, agents: workers.map((_, index) => ({ agent_id: `peer${index}`, adapter_id: `peer${index}`,
      description: '', enabled: true, options: {} })) }),
    definitions: Object.fromEntries(workers.map((worker, index) => [`peer${index}`, {
      configure: () => ({ modes: ['implement'], contract: 'controlled-peer/1', configuration: {}, worker }),
    }])),
  });
  fixture.sessions.push({ close: async () => { stops.forEach(stop => stop.release()); await runtime.shutdown(); } });
  await runtime.coordinate({ schema_version: 1, kind: 'initialize', limits: fixture.limits }, actors[0], fixture.root);
  const submit = index => runtime.submitCoordinated({ schema_version: 2, kind: 'inline',
    assignment: { schema_version: 3, agent_id: `peer${index}`, request_key: randomUUID(),
      mode: 'implement', objective: `Change source.ts for peer ${index}`, context: '',
      acceptance_criteria: ['Edit source.ts'], allowed_paths: ['source.ts'],
      base_commit: fixture.base, target_ref: 'refs/heads/main' },
  }, actors[index], fixture.root, new AbortController().signal);
  const ids = (await Promise.all([submit(0), submit(1)])).map(item => item.task_id);
  const state = async () => JSON.parse(await readFile(join(binding.storeRoot, 'coordination', 'control.json'), 'utf8'));
  const refresh = async index => {
    try { await runtime.structuralRefresh(ids[index], actors[index]); }
    catch (error) { if (!['STRUCTURAL_SOURCE_FORBIDDEN', 'COORDINATION_NOT_FOUND'].includes(error.code)) throw error; }
  };
  let pair;
  for (let attempt = 0; attempt < 150 && !pair; attempt++) {
    await refresh(0); await refresh(1);
    pair = (await state()).cases.find(item => item.observed_origin === 'selected' && item.inputs.length === 2);
    if (!pair) await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.ok(pair, 'the first two real captures must establish an observed case');
  ids.push((await submit(2)).task_id);
  for (let attempt = 0; attempt < 150; attempt++) {
    const control = await store.readControl(ids[2]);
    if (control.native.state === 'observed_live' && control.native.coverage === 'turn_scoped') break;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  await refresh(2);
  if (replaceRun) {
    assert.ok(replacedTask, 'reservation barrier must observe the selected recipient manifest');
    const current = (await state()).cases.find(item => item.id === pair.id);
    assert.equal(current.revision, pair.revision);
    assert.equal(current.inputs.length, 2, 'changed native run must stop extension publication');
    const reopened = await Promise.all(ids.map(id => new TaskStore(binding.storeRoot).readControl(id)));
    assert.ok(reopened.every(control => control.schema_version === 3 &&
      control.peer_delivery_reservations.every(slot => slot.state === 'released')));
    assert.ok(reopened.every(control => !(control.peer_deliveries ?? []).some(record =>
      record.envelope.case_id === pair.id && record.envelope.case_revision === pair.revision + 1)));
    return;
  }
  if (!enable) {
    const current = (await state()).cases.find(item => item.id === pair.id);
    assert.equal(current.inputs.length, 2, 'production-default Runtime keeps automatic extension disabled');
    assert.ok((await Promise.all(ids.map(id => store.readControl(id)))).every(control =>
      control.schema_version === 2), 'disabled extension creates no delivery reservations');
    return;
  }
  let joined;
  for (let attempt = 0; attempt < 200; attempt++) {
    joined = (await state()).cases.find(item => item.id === pair.id && item.inputs.length === 3);
    if (joined) break;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.ok(joined, 'a single late capture must publish the controlled revised case');
  assert.equal(joined.revision, pair.revision + 1);
  if (partialQueue) {
    const partialMetadata = await state();
    const partialCase = partialMetadata.cases.find(item => item.id === joined.id);
    assert.equal(partialCase.revision, pair.revision + 1);
    assert.equal(partialCase.delivery_pending.length, 3);
    assert.deepEqual(partialCase.delivery_observed, [], 'queue interruption cannot infer native observation');
    const reopenedPartial = await Promise.all(ids.map(id => new TaskStore(binding.storeRoot).readControl(id)));
    const partialSlots = reopenedPartial.flatMap(control => control.peer_delivery_reservations ?? [])
      .filter(slot => slot.case_id === joined.id && slot.case_revision === joined.revision);
    assert.equal(partialSlots.length, 6);
    assert.equal(partialSlots.filter(slot => slot.state === 'consumed').length, 2);
    assert.equal(partialSlots.filter(slot => slot.state === 'reserved').length, 4);
    assert.equal(reopenedPartial.flatMap(control => control.peer_deliveries ?? [])
      .filter(record => record.envelope.case_id === joined.id &&
        record.envelope.case_revision === joined.revision).length, 2);
    assert.ok(reopenedPartial.every(control => (control.peer_deliveries?.length ?? 0) +
      control.peer_delivery_reservations.filter(slot => slot.state === 'reserved').length <= 64));
    assert.ok(retrySelectedCase, 'committed case must expose the existing same-live retry path');
    interruptRevisedQueue = false;
    await retrySelectedCase();
  }
  for (let attempt = 0; attempt < 200; attempt++) {
    const controls = await Promise.all(ids.map(id => store.readControl(id)));
    if (controls.every(control => control.schema_version === 3 &&
      control.peer_delivery_reservations.filter(slot => slot.case_id === joined.id &&
        slot.case_revision === joined.revision && slot.state === 'consumed').length === 2)) break;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  const reopened = await Promise.all(ids.map(id => new TaskStore(binding.storeRoot).readControl(id)));
  for (const control of reopened) {
    assert.equal(control.schema_version, 3);
    const slots = control.peer_delivery_reservations.filter(slot => slot.case_id === joined.id &&
      slot.case_revision === joined.revision);
    assert.equal(slots.length, 2);
    assert.ok(slots.every(slot => slot.state === 'consumed' &&
      control.peer_deliveries.some(record => record.envelope.delivery_id === slot.delivery_id)));
  }
  assert.equal((await state()).cases.find(item => item.id === joined.id).delivery_pending.length, 3,
    'queue admission alone does not settle the revised case');
  if (partialQueue) {
    const after = await state();
    const current = after.cases.find(item => item.id === joined.id);
    assert.deepEqual(current.delivery_observed, []);
    const envelopes = (await Promise.all(ids.map(id => new TaskStore(binding.storeRoot).readPeerDeliveries(id))))
      .flat().filter(record => record.envelope.case_id === joined.id &&
        record.envelope.case_revision === joined.revision);
    assert.equal(envelopes.length, 6);
    assert.equal(new Set(envelopes.map(record => record.envelope.idempotency_key)).size, 6,
      'same-live retry must not append duplicate directed obligations');
  }
}

test('production-default Runtime leaves automatic observed extension disabled', t =>
  observedExtensionScenario(t, false));
test('controlled extension reserves and consumes six durable directed slots through the real Runtime', t =>
  observedExtensionScenario(t, true));
test('prepublication native run replacement prevents controlled extension and releases exact slots', t =>
  observedExtensionScenario(t, true, true));
test('committed case retains partial directed enqueue across reopen and same-live retry', t =>
  observedExtensionScenario(t, true, false, true));

test('late third managed worker joins one observed case and each adapter consumes revised peer evidence', {
  skip: 'G4 gate: an in-flight revised envelope can become unknown and fail its adapter; case delivery remains pending',
}, async t => {
  let stage = 'fixture', polls = 0;
  const within = async (name, promise, ms = 15000) => {
    stage = name;
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() =>
      reject(new Error(`late-third timeout at ${stage} after ${polls} polls`)), ms); })]); }
    finally { clearTimeout(timer); }
  };
  const fixture = await serviceFixture(t);
  await fixture.service.close();
  const intent = { project: fixture.root, stateRoot: fixture.state,
    profilePath: join(fixture.temp, 'missing-profile.json') };
  const binding = await resolveRepositoryBinding(intent, {}, new AbortController().signal);
  const token = await operatorToken(binding, true);
  const actors = [createHash('sha256').update(token).digest('hex'), 'b'.repeat(64), 'c'.repeat(64)]
    .map(owner_id => ({ owner_id, client_id: randomUUID() }));
  const consumed = [[], [], []];
  const workers = [0, 1, 2].map(index => {
    let stopped = false;
    return { release: () => { stopped = true; }, async run(input) {
      await writeFile(join(input.workspace, 'source.ts'),
        `export function run() { return ${index + 1}; }\n`);
      const initial = `initial-${index}`;
      await input.onEvent({ kind: 'turn_started', turn_id: initial, native_session_id: `session-${index}` });
      await input.onEvent({ kind: 'turn_settled', turn_id: initial, native_session_id: `session-${index}`, terminal: 'completed' });
      let sequence = 0;
      while (!stopped) {
        const envelope = await input.peer.next();
        if (!envelope) { await new Promise(resolve => setTimeout(resolve, 30)); continue; }
        const turn_id = `peer-${index}-${++sequence}`;
        await input.onEvent({ kind: 'turn_started', turn_id, native_session_id: `session-${index}` });
        await input.peer.delivered(envelope.idempotency_key, turn_id, `session-${index}`);
        await input.onEvent({ kind: 'turn_settled', turn_id, native_session_id: `session-${index}`, terminal: 'completed' });
        await input.peer.observed(envelope.idempotency_key, turn_id, `session-${index}`);
        consumed[index].push(envelope);
      }
      return { status: 'completed', worker_stop: 'confirmed', worker_assessment: 'met',
        summary: 'Controlled peer stopped', blockers: [], questions: [], checks: [] };
    } };
  });
  const store = new TaskStore(binding.storeRoot);
  const runtime = new RepositoryRuntime(intent, { package_version: 'fixture', build_id: 'fixture',
    mode: 'development', node_version: process.version, node_executable: process.execPath,
    pid: process.pid, started_at: new Date().toISOString() }, {
    store: () => store,
    profile: async () => ({ schema_version: 3, execution: {
      stop_grace_ms: 1000, max_workers: 3, max_queued_tasks: 3, max_clients: 32,
      max_waiters: 128, max_pending_inputs: 16, max_control_receipts: 512,
      implementation: { enabled: true, worktree_root: join(fixture.temp, 'managed-worktrees') },
    }, agents: workers.map((_, index) => ({ agent_id: `peer${index}`, adapter_id: `peer${index}`,
      description: '', enabled: true, options: {} })) }),
    definitions: Object.fromEntries(workers.map((worker, index) => [`peer${index}`, {
      configure: () => ({ modes: ['implement'], contract: 'controlled-peer/1', configuration: {},
        worker: { run: input => worker.run(input) } }),
    }])),
  });
  fixture.sessions.push({ close: async () => { workers.forEach(worker => worker.release());
    await within('shutdown', runtime.shutdown(), 10000); } });
  await within('initialize', runtime.coordinate({ schema_version: 1, kind: 'initialize', limits: fixture.limits }, actors[0], fixture.root));
  const submit = index => runtime.submitCoordinated({ schema_version: 2, kind: 'inline',
    assignment: { schema_version: 3, agent_id: `peer${index}`, request_key: randomUUID(),
      mode: 'implement', objective: `Change source.ts for peer ${index}`, context: '',
      acceptance_criteria: ['Edit source.ts'], allowed_paths: ['source.ts'],
      base_commit: fixture.base, target_ref: 'refs/heads/main' },
  }, actors[index], fixture.root, new AbortController().signal);
  const first = await within('submit-first-pair', Promise.all([submit(0), submit(1)]));
  const ids = first.map(item => item.task_id);
  const caseState = async () => JSON.parse(await readFile(join(binding.storeRoot, 'coordination', 'control.json'), 'utf8'));
  const refresh = async (indices = ids.map((_, index) => index)) => {
    for (const index of indices) {
      const id = ids[index];
      try { await within(`refresh-${index}`, runtime.structuralRefresh(id, actors[index])); }
      catch (error) { if (!['STRUCTURAL_SOURCE_FORBIDDEN', 'COORDINATION_NOT_FOUND'].includes(error.code)) throw error; }
    }
  };
  let pairCase;
  for (let attempt = 0; attempt < 120 && !pairCase; attempt++) {
    polls++; await refresh();
    pairCase = (await caseState()).cases.find(item => item.observed_origin === 'selected' && item.inputs.length === 2);
    if (!pairCase) await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.ok(pairCase, 'the first two real observations must select one observed case');
  for (let attempt = 0; attempt < 120 && !consumed.slice(0, 2).every(records =>
    records.some(envelope => envelope.case_id === pairCase.id && envelope.case_revision === pairCase.revision)); attempt++) {
    polls++; await refresh();
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.ok(consumed.slice(0, 2).every(records => records.some(envelope =>
    envelope.case_id === pairCase.id && envelope.case_revision === pairCase.revision)),
  'both original adapters must observe their pair envelopes before a late revision');
  const third = await within('submit-third', submit(2));
  ids.push(third.task_id);
  for (let attempt = 0; attempt < 120; attempt++) {
    const control = await store.readControl(third.task_id);
    if (control.native.state === 'observed_live' && control.native.coverage === 'turn_scoped') break;
    polls++; await new Promise(resolve => setTimeout(resolve, 30));
  }
  const ready = await store.readControl(third.task_id);
  assert.equal(ready.native.coverage, 'turn_scoped', 'the late worker must finish its source edit before one refresh');
  if (!(await caseState()).cases.some(item => item.id === pairCase.id && item.inputs.length === 3))
    await refresh([2]);
  let joined;
  for (let attempt = 0; attempt < 160; attempt++) {
    joined = (await caseState()).cases.find(item => item.id === pairCase.id && item.inputs.length === 3);
    if (joined) break;
    polls++;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.ok(joined, 'late worker must extend the original observed case');
  for (let attempt = 0; attempt < 160; attempt++) {
    joined = (await caseState()).cases.find(item => item.id === pairCase.id && item.inputs.length === 3);
    if (joined.delivery_pending.length === 0 && consumed.every(records =>
      records.filter(envelope => envelope.case_id === joined.id && envelope.case_revision === joined.revision).length >= 2)) break;
    polls++; await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.equal(joined.revision, pairCase.revision + 1);
  assert.deepEqual(joined.delivery_pending, [], 'only exact adapter observations discharge every recipient');
  for (const [index, records] of consumed.entries()) {
    const current = records.filter(envelope => envelope.case_id === joined.id && envelope.case_revision === joined.revision);
    assert.equal(new Set(current.map(envelope => envelope.source_work_id)).size, 2,
      `adapter ${index} must consume two distinct current peers`);
    assert.ok(current.every(envelope => JSON.parse(envelope.content).selected_evidence?.subject_id));
  }
});
