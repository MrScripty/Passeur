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
import { serviceFixture } from '../fixtures/structural/service-fixture.mjs';
import { TaskStore } from '../../.passeur-core/src/store/task-store.js';
import { operatorToken } from '../../.passeur-core/src/service/operator-token.js';

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
