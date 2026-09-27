import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serviceFixture } from '../fixtures/structural/service-fixture.mjs';
import { RepositoryRuntime, resolveRepositoryBinding } from '../../.passeur-core/src/core/repository-runtime.js';
import { TaskStore } from '../../.passeur-core/src/store/task-store.js';
import { operatorToken } from '../../.passeur-core/src/service/operator-token.js';
import { peerResolutionDigest } from '../../.passeur-core/src/coordination/peer-resolution.js';

const pause = () => new Promise(resolve => setTimeout(resolve, 30));
const source = value => `export function run() { return ${value}; }\n`;

function worker(index) {
  const jobs = [];
  let wake, stop = false;
  return {
    send(request) { return new Promise((resolve, reject) => { jobs.push({ request, resolve, reject }); wake?.(); }); },
    stop() { stop = true; wake?.(); },
    async run(input) {
      await writeFile(join(input.workspace, 'source.ts'), source(index + 1));
      const turn_id = randomUUID();
      await input.onEvent({ kind: 'turn_started', turn_id });
      await input.onEvent({ kind: 'turn_settled', turn_id, terminal: 'completed' });
      while (!stop) {
        if (!jobs.length) await new Promise(resolve => { wake = resolve; });
        wake = undefined;
        for (const job of jobs.splice(0)) {
          try { job.resolve(await input.peer.operation(job.request)); }
          catch (error) { job.reject(error); }
        }
      }
      return { status: 'completed', worker_stop: 'confirmed', worker_assessment: 'met',
        summary: 'Controlled peer stopped', blockers: [], questions: [], checks: [] };
    },
  };
}

test('source recapture after both consents makes the agreed proposal stale before application', async t => {
  const f = await serviceFixture(t);
  await f.service.close();
  const intent = { project: f.root, stateRoot: f.state, profilePath: join(f.temp, 'missing-profile.json') };
  const binding = await resolveRepositoryBinding(intent, {}, new AbortController().signal);
  const token = await operatorToken(binding, true);
  const actors = [
    { owner_id: createHash('sha256').update(token).digest('hex'), client_id: randomUUID() },
    { owner_id: 'b'.repeat(64), client_id: randomUUID() },
  ];
  const peers = [worker(0), worker(1)];
  const store = new TaskStore(binding.storeRoot);
  const runtime = new RepositoryRuntime(intent, {
    package_version: 'fixture', build_id: 'fixture', mode: 'development',
    node_version: process.version, node_executable: process.execPath,
    pid: process.pid, started_at: new Date().toISOString(),
  }, {
    store: () => store,
    profile: async () => ({ schema_version: 3, execution: {
      stop_grace_ms: 1000, max_workers: 2, max_queued_tasks: 2,
      max_clients: 32, max_waiters: 128, max_pending_inputs: 16,
      max_control_receipts: 512, implementation: { enabled: true,
        worktree_root: join(f.temp, 'managed-worktrees') },
    }, agents: peers.map((_, index) => ({ agent_id: `peer${index}`, adapter_id: `peer${index}`,
      description: '', enabled: true, options: {} })) }),
    definitions: Object.fromEntries(peers.map((peer, index) => [`peer${index}`, {
      configure: () => ({ modes: ['implement'], contract: 'controlled-peer/1', configuration: {},
        worker: { run: input => peer.run(input) } }),
    }])),
  });
  f.sessions.push({ close: async () => { peers.forEach(peer => peer.stop()); await runtime.shutdown(); } });
  const coordinate = (request, index = 0) => runtime.coordinate(request, actors[index], f.root);
  const read = async (kind, id, index = 0) => {
    const page = await coordinate({ schema_version: 1, kind: 'read', selector: { kind, id },
      offset: 0, limit: 8192, expected_hash: null }, index);
    assert.equal(page.kind, 'page');
    return JSON.parse(page.content);
  };
  await coordinate({ schema_version: 1, kind: 'initialize', limits: f.limits });
  const submissions = await Promise.all(peers.map((_, index) => runtime.submitCoordinated({
    schema_version: 2, kind: 'inline', assignment: {
      schema_version: 3, agent_id: `peer${index}`, request_key: randomUUID(), mode: 'implement',
      objective: `Change source.ts for peer ${index}`, context: 'Controlled overlapping edits',
      acceptance_criteria: ['Edit source.ts'], allowed_paths: ['source.ts'],
      base_commit: f.base, target_ref: 'refs/heads/main',
    },
  }, actors[index], f.root, new AbortController().signal)));
  const ids = submissions.map(task => task.task_id);
  let resources;
  for (let attempt = 0; attempt < 200; attempt++) {
    resources = await Promise.all(ids.map(id => store.readResource(id)));
    if (resources.every(resource => resource?.worktree_path)) break;
    await pause();
  }
  assert.ok(resources.every(resource => resource?.worktree_path), 'both managed workspaces must be ready');
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      if ((await Promise.all(resources.map(resource => readFile(join(resource.worktree_path, 'source.ts'), 'utf8'))))
        .every((value, index) => value === source(index + 1))) break;
    } catch { /* The worker has not written its source yet. */ }
    await pause();
  }
  assert.deepEqual(await Promise.all(resources.map(resource => readFile(join(resource.worktree_path, 'source.ts'), 'utf8'))),
    [source(1), source(2)]);
  let selected;
  for (let attempt = 0; attempt < 100 && !selected; attempt++) {
    for (const [index, id] of ids.entries()) {
      try {
        const outcome = await runtime.structuralRefresh(id, actors[index]);
        assert.ok(['published', 'unchanged'].includes(outcome.status), JSON.stringify(outcome));
      } catch (error) {
        if (error.code !== 'STRUCTURAL_SOURCE_FORBIDDEN') throw error;
      }
    }
    const inventory = await coordinate({ schema_version: 1, kind: 'recovery_read',
      selector: { kind: 'inventory' }, offset: 0, limit: 8192, expected_hash: null });
    assert.equal(inventory.kind, 'page');
    for (const candidate of JSON.parse(inventory.content).cases) {
      const item = await read('case', candidate.id);
      if (ids.every(id => item.inputs.some(input => input.work_id === id))) selected = item;
    }
    if (!selected) await pause();
  }
  if (!selected) {
    const inventory = await coordinate({ schema_version: 1, kind: 'recovery_read',
      selector: { kind: 'inventory' }, offset: 0, limit: 8192, expected_hash: null });
    assert.fail(`actual managed source edits must establish an overlap case: ${inventory.content}`);
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    const controls = await Promise.all(ids.map(id => store.readControl(id)));
    if (controls.every(control => control.phase === 'active' && control.native.state === 'observed_live' &&
      control.native.coverage === 'turn_scoped' && !control.native.obligations.length)) break;
    await pause();
  }
  const inspect = (index, label) => peers[index].send({ schema_version: 1, kind: 'inspect',
    operation_key: `${label}-${randomUUID()}`, case_id: selected.id });
  const first = await inspect(0, 'first');
  assert.equal(first.kind, 'current');
  assert.ok(first.first_proposal);
  const applyingPath = join(resources[0].worktree_path, 'source.ts');
  const original = await readFile(applyingPath);
  const changes = [{ path: 'source.ts', before_sha256: createHash('sha256').update(original).digest('hex'),
    after_base64: Buffer.from(source(3)).toString('base64') }];
  const summary = 'Combine both worker values';
  const proposal = { ...first.first_proposal, scope: [{ kind: 'file', path: 'source.ts' }],
    summary, changes, resolution_digest: peerResolutionDigest(summary, changes) };
  const posted = await peers[0].send({ schema_version: 1, kind: 'propose', operation_key: randomUUID(),
    case_id: selected.id, proposal });
  assert.equal(posted.kind, 'receipt');
  for (const index of [0, 1]) {
    const consent = await peers[index].send({ schema_version: 1, kind: 'acknowledge',
      operation_key: randomUUID(), case_id: selected.id, note_id: posted.note_id });
    assert.equal(consent.kind, 'receipt');
  }
  const agreed = await inspect(1, 'agreed');
  assert.deepEqual(new Set(agreed.acknowledged_task_ids), new Set(ids));
  assert.equal(agreed.proposal_note_id, posted.note_id);

  // A fresh sampling of identical source bytes may change capture transport
  // identity, but must preserve the evidence that both workers accepted.
  let waiterSettled = false;
  const changedEvidence = peers[1].send({ schema_version: 1, kind: 'await_change',
    operation_key: randomUUID(), case_id: selected.id,
    after_case_revision: agreed.case_revision,
    after_case_generation: agreed.case_generation,
    after_negotiation_cursor: agreed.negotiation_cursor });
  changedEvidence.finally(() => { waiterSettled = true; }).catch(() => undefined);
  const changedPath = join(resources[1].worktree_path, 'source.ts');
  await writeFile(changedPath, source(2));
  const replay = await runtime.structuralRefresh(ids[1], actors[1]);
  assert.ok(['published', 'unchanged'].includes(replay.status), JSON.stringify(replay));
  const afterReplay = await inspect(0, 'same-bytes-replay').catch(error => {
    error.message = `same-bytes-replay: ${error.message}`; throw error;
  });
  assert.equal(afterReplay.proposal?.evidence_id, agreed.proposal.evidence_id);
  assert.equal(afterReplay.proposal_note_id, posted.note_id);
  assert.deepEqual(new Set(afterReplay.acknowledged_task_ids), new Set(ids));
  await pause();
  assert.equal(waiterSettled, false, 'identical recapture must not wake a retained peer wait');

  // Change a selected source without changing its work revision, input OID, or selected commit.
  const before = await Promise.all(ids.map((id, index) => read('work', id, index)));
  const priorCapture = (await runtime.structuralCurrent(actors[1])).reports.find(report => report.work_id === ids[1]);
  assert.ok(priorCapture);
  await writeFile(changedPath, source(7));
  const applyRequest = () => ({ schema_version: 1, kind: 'apply', operation_key: randomUUID(),
    case_id: selected.id, note_id: posted.note_id, expected_case_revision: selected.revision,
    expected_case_generation: selected.generation, proposal_digest: proposal.resolution_digest });
  await assert.rejects(peers[0].send(applyRequest()), { code: 'PEER_OPERATION_STALE' },
    'unobserved new source bytes must invalidate consent before the queued observation publishes');
  assert.deepEqual(await readFile(applyingPath), original);
  const refreshed = await runtime.structuralRefresh(ids[1], actors[1]);
  assert.equal(refreshed.status, 'published', JSON.stringify(refreshed));
  const changedCurrent = await changedEvidence.catch(error => {
    error.message = `changed-evidence await: ${error.message}`; throw error;
  });
  assert.equal(changedCurrent.kind, 'current');
  assert.equal(changedCurrent.case_revision, afterReplay.case_revision);
  assert.notEqual(changedCurrent.negotiation_cursor, afterReplay.negotiation_cursor);
  assert.notEqual(changedCurrent.evidence_id, afterReplay.evidence_id);
  assert.equal(changedCurrent.proposal, null, 'changed source bytes must hide stale consent');
  const newCapture = (await runtime.structuralCurrent(actors[1])).reports.find(report => report.work_id === ids[1]);
  assert.ok(newCapture);
  assert.notEqual(newCapture.id, priorCapture.id, 'observation must publish a new source version');
  assert.equal((await runtime.structuralArtifactDetail(actors[1], newCapture.id, 'observed', 0,
    Buffer.byteLength(source(7)))).text, source(7));
  const after = await Promise.all(ids.map((id, index) => read('work', id, index)));
  assert.deepEqual(after, before, 'refresh must not alter selected work metadata');
  assert.deepEqual(await read('case', selected.id), selected, 'refresh must not change case selection');
  const observed = await readFile(changedPath, 'utf8');
  assert.equal(observed, source(7));

  await assert.rejects(peers[0].send(applyRequest()), { code: 'PEER_OPERATION_STALE' });
  assert.deepEqual(await readFile(applyingPath), original, 'stale consent cannot write the applying workspace');
  const beforeNoOverlap = await inspect(0, 'before-no-overlap').catch(error => {
    error.message = `before-no-overlap: ${error.message}`; throw error;
  });
  assert.equal(beforeNoOverlap.evidence_id, changedCurrent.evidence_id);

  // The next capture removes the last actual overlap. The selected case still
  // exists, so a retained wait must receive bounded unavailable evidence.
  const noOverlap = peers[1].send({ schema_version: 1, kind: 'await_change',
    operation_key: randomUUID(), case_id: selected.id,
    after_case_revision: changedCurrent.case_revision,
    after_case_generation: changedCurrent.case_generation,
    after_negotiation_cursor: changedCurrent.negotiation_cursor }).catch(error => {
      error.message = `no-overlap await: ${error.message}`; throw error;
    });
  noOverlap.catch(() => undefined);
  await new Promise(resolve => setTimeout(resolve, 1000));
  await writeFile(changedPath, 'export function run() {}\n');
  const resolved = await runtime.structuralRefresh(ids[1], actors[1]);
  assert.equal(resolved.status, 'published', JSON.stringify(resolved));
  const unavailable = await noOverlap;
  assert.equal(unavailable.kind, 'current');
  assert.equal(unavailable.evidence_status, 'unavailable');
  assert.equal(unavailable.evidence_id, null);
  assert.equal(unavailable.proposal, null);
  assert.equal(unavailable.first_proposal, null);
});
