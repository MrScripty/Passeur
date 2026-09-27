import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { RepositoryRuntime, resolveRepositoryBinding } from '../../../dist/src/core/repository-runtime.js';
import { TaskStore } from '../../../dist/src/store/task-store.js';
import { operatorToken } from '../../../dist/src/service/operator-token.js';
import { peerResolutionDigest, PEER_RESOLUTION_ACTIONS } from '../../../dist/src/coordination/peer-resolution.js';

const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const intent = { project: config.root, stateRoot: config.state, profilePath: join(config.temp, 'missing-profile.json') };
const identity = { package_version: 'fixture', build_id: 'fixture', mode: 'development',
  node_version: process.version, node_executable: process.execPath, pid: process.pid,
  started_at: new Date().toISOString() };
const send = value => new Promise((resolve, reject) => process.send(value, error => error ? reject(error) : resolve()));
const binding = await resolveRepositoryBinding(intent, {}, new AbortController().signal);
const storeRoot = binding.storeRoot;
const source = index => `export function run() { return ${index}; }\n`;
const pause = async (frontier, facts) => {
  if (config.frontier !== frontier) return;
  await send({ kind: 'checkpoint', frontier, ...facts });
  await new Promise(() => {});
};
const waitFor = async (label, read, predicate) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await read();
    if (predicate(value)) return value;
    await delay(30);
  }
  throw Error(`${label} did not settle`);
};

if (process.argv[3] === 'recover') {
  const runtime = new RepositoryRuntime(intent, identity, {
    profile: async () => ({ schema_version: 3, execution: { stop_grace_ms: 1000, max_workers: 2,
      max_queued_tasks: 2, max_clients: 32, max_waiters: 128, max_pending_inputs: 16,
      max_control_receipts: 512, implementation: { enabled: true, worktree_root: join(config.temp, 'worktrees') } },
      agents: [0, 1].map(index => ({ agent_id: `peer${index}`, adapter_id: `peer${index}`,
        description: '', enabled: true, options: {} })) }),
    definitions: Object.fromEntries([0, 1].map(index => [`peer${index}`, { configure: () => ({
      modes: ['implement'], contract: 'controlled-peer/1', configuration: {},
      worker: { run: async () => { await writeFile(join(config.temp, 'unexpected-turn'), 'started');
        throw Error('Recovered runtime started a native worker'); } },
    }) }])) });
  try {
    await runtime.prepare();
    await send({ kind: 'recovery', code: 'UNEXPECTED_READY' });
  } catch (error) {
    await send({ kind: 'recovery', code: error.code ?? 'UNEXPECTED_ERROR', message: error.message });
  } finally {
    await runtime.shutdown();
    process.disconnect();
  }
} else {
  try {
    const token = await operatorToken(binding, true);
    assert.ok(token);
    const actors = [
      { owner_id: createHash('sha256').update(token).digest('hex'), client_id: randomUUID() },
      { owner_id: 'b'.repeat(64), client_id: randomUUID() },
    ];
    class BarrierStore extends TaskStore {
      async startPeerOperation(id, request) {
        if (request.kind === 'apply') await pause('before-intent', { task_id: id, key: request.operation_key });
        const value = await super.startPeerOperation(id, request);
        if (request.kind === 'apply') await pause('after-intent', { task_id: id, key: request.operation_key });
        return value;
      }
      async settlePeerOperationOutcome(id, key, result) {
        if (result.kind === 'application') await pause('after-write', { task_id: id, key });
        const value = await super.settlePeerOperationOutcome(id, key, result);
        if (result.kind === 'application') await pause('after-result', { task_id: id, key });
        return value;
      }
    }
    const store = new BarrierStore(storeRoot);
    const queues = [[], []], wakes = [null, null];
    const call = (index, request) => new Promise((resolve, reject) => {
      queues[index].push({ request, resolve, reject });
      wakes[index]?.();
    });
    const runtime = new RepositoryRuntime(intent, identity, {
      store: () => store,
      profile: async () => ({ schema_version: 3, execution: { stop_grace_ms: 1000, max_workers: 2,
        max_queued_tasks: 2, max_clients: 32, max_waiters: 128, max_pending_inputs: 16,
        max_control_receipts: 512, implementation: { enabled: true, worktree_root: join(config.temp, 'worktrees') } },
        agents: [0, 1].map(index => ({ agent_id: `peer${index}`, adapter_id: `peer${index}`,
          description: '', enabled: true, options: {} })) }),
      definitions: Object.fromEntries([0, 1].map(index => [`peer${index}`, { configure: () => ({
        modes: ['implement'], contract: 'controlled-peer/1', configuration: {}, worker: { run: async input => {
          await writeFile(join(input.workspace, 'source.ts'), source(index + 1));
          const turn_id = randomUUID();
          await input.onEvent({ kind: 'turn_started', turn_id });
          await input.onEvent({ kind: 'turn_settled', turn_id, terminal: 'completed' });
          for (;;) {
            if (!queues[index].length) await new Promise(resolve => { wakes[index] = resolve; });
            wakes[index] = null;
            for (const job of queues[index].splice(0)) {
              try { job.resolve(await input.peer.operation(job.request)); }
              catch (error) { job.reject(error); }
            }
          }
        } },
      }) }])) });
    const coordinate = (request, index = 0) => runtime.coordinate(request, actors[index], config.root);
    const controlFile = join(storeRoot, 'coordination/control.json');
    const readControl = () => readFile(controlFile, 'utf8').then(JSON.parse);
    await coordinate({ schema_version: 1, kind: 'initialize', limits: config.limits });
    const submit = index => runtime.submitCoordinated({ schema_version: 2, kind: 'inline', assignment: {
      schema_version: 3, agent_id: `peer${index}`, request_key: randomUUID(), mode: 'implement',
      objective: `Change source.ts for peer ${index}`, context: 'Controlled application crash',
      acceptance_criteria: ['Edit source.ts'], allowed_paths: ['source.ts'], base_commit: config.base,
      target_ref: 'refs/heads/main',
    } }, actors[index], config.root, new AbortController().signal);
    const tasks = await Promise.all([submit(0), submit(1)]);
    const ids = tasks.map(task => task.task_id);
    await waitFor('settled native turns', async () => Promise.all(ids.map(id => store.readControl(id))),
      states => states.every(state => state.phase === 'active' && state.native.state === 'observed_live' &&
        state.native.coverage === 'turn_scoped' && !state.native.obligations.length));
    const selected = await waitFor('selected overlap', async () => {
      const resources = await Promise.all(ids.map(id => store.readResource(id)));
      if (!resources.every(resource => resource?.worktree_path)) return null;
      for (const [index, id] of ids.entries()) {
        await writeFile(join(config.temp, 'setup-stage.json'), JSON.stringify({ stage: 'refresh-start', id, index,
          at: new Date().toISOString() }));
        try {
          const result = await runtime.structuralRefresh(id, actors[index]);
          await writeFile(join(config.temp, 'setup-stage.json'), JSON.stringify({ stage: 'refresh-result', id, index, result }));
          await appendFile(join(config.temp, 'refresh-results.ndjson'), JSON.stringify({ id, index, result }) + '\n');
          if (result.status === 'incomplete') throw Error(`Structural capture incomplete: ${result.limitations.join(',')}`);
        }
        catch (error) {
          await writeFile(join(config.temp, 'setup-stage.json'), JSON.stringify({ stage: 'refresh-error', id, index,
            code: error.code, message: error.message }));
          if (!['STRUCTURAL_SOURCE_FORBIDDEN', 'COORDINATION_NOT_FOUND'].includes(error.code)) throw error;
        }
      }
      return (await readControl()).cases.find(item => item.observed_origin === 'selected' &&
        item.inputs.length === 2 && ids.every(id => item.inputs.some(input => input.work_id === id)));
    }, Boolean);
    const resources = await Promise.all(ids.map(id => store.readResource(id)));
    const handoffs = await Promise.all(ids.map(async id => {
      const delivery = await waitFor('selected native peer handoff', async () =>
        (await store.readControl(id)).peer_deliveries?.find(item => item.envelope.case_id === selected.id), Boolean);
      return JSON.parse(delivery.envelope.content);
    }));
    for (const evidence of handoffs) {
      assert.equal(evidence.kind, 'peer_overlap_evidence');
      assert.ok(evidence.selected_evidence?.changes?.some(change =>
        change.spans?.some(span => /return [12]/.test(span.text))));
    }
    const inspect = async index => call(index, { schema_version: 1, kind: 'inspect', operation_key: randomUUID(), case_id: selected.id });
    const current = await inspect(0);
    assert.equal(current.kind, 'current');
    const works = (await readControl()).works;
    const sources = selected.inputs.map(input => {
      const work = works.find(item => item.id === input.work_id);
      assert.ok(work);
      return { work_id: work.id, work_revision: work.revision, input_oid: work.input_oid,
        selected_commit_oid: input.commit_oid };
    });
    const base = { schema_version: 2, kind: 'peer_resolution_proposal', case_id: selected.id,
      case_revision: selected.revision, case_generation: selected.generation,
      evidence_id: current.evidence_id, evidence_revision: current.evidence_revision,
      participants: actors.map(actor => actor.owner_id), sources,
      scope: [{ kind: 'file', path: 'source.ts' }], permitted_actions: [...PEER_RESOLUTION_ACTIONS] };
    const change = (before, value) => [{ path: 'source.ts',
      before_sha256: createHash('sha256').update(before).digest('hex'),
      after_base64: Buffer.from(source(value)).toString('base64') }];
    const firstBytes = await readFile(join(resources[0].worktree_path, 'source.ts'));
    const secondBytes = await readFile(join(resources[1].worktree_path, 'source.ts'));
    const initial = { ...base, proposal_revision: 1, action: 'propose', summary: 'Keep first value',
      changes: change(firstBytes, 1), resolution_digest: peerResolutionDigest('Keep first value', change(firstBytes, 1)),
      predecessor_digest: null };
    const posted = await call(0, { schema_version: 1, kind: 'propose', operation_key: 'first-proposal',
      case_id: selected.id, proposal: initial });
    assert.equal(posted.kind, 'receipt');
    const combined = { ...base, proposal_revision: 2, action: 'counter_propose', summary: 'Combine values',
      changes: change(secondBytes, 3), resolution_digest: peerResolutionDigest('Combine values', change(secondBytes, 3)),
      predecessor_digest: initial.resolution_digest };
    const countered = await call(1, { schema_version: 1, kind: 'counter_propose', operation_key: 'combined-counter',
      case_id: selected.id, proposal: combined });
    assert.equal(countered.kind, 'receipt');
    for (const index of [0, 1]) {
      const ack = await call(index, { schema_version: 1, kind: 'acknowledge', operation_key: `ack-${index}`,
        case_id: selected.id, note_id: countered.note_id });
      assert.equal(ack.kind, 'receipt');
    }
    const agreed = await inspect(1);
    assert.deepEqual(new Set(agreed.acknowledged_task_ids), new Set(ids));
    assert.equal(agreed.proposal_note_id, countered.note_id);
    const applying = await store.readControl(ids[1]);
    const facts = { ids, case_id: selected.id, case_revision: selected.revision,
      case_generation: selected.generation, note_id: countered.note_id,
      proposal_digest: combined.resolution_digest, key: 'apply-combined',
      run_id: applying.native.run_id, control_generation: applying.control_generation,
      workspace_id: (await readControl()).works.find(item => item.id === ids[1]).workspace_id,
      worktrees: resources.map(resource => resource.worktree_path) };
    await writeFile(join(config.temp, 'expected.json'), JSON.stringify(facts));
    const result = await call(1, { schema_version: 1, kind: 'apply', operation_key: facts.key,
      case_id: selected.id, note_id: countered.note_id, expected_case_revision: selected.revision,
      expected_case_generation: selected.generation, proposal_digest: combined.resolution_digest });
    assert.equal(result.kind, 'application');
    await pause('after-case', { task_id: ids[1], key: facts.key });
    throw Error('No requested crash frontier was reached');
  } catch (error) {
    await send({ kind: 'setup_failure', code: error.code ?? 'TEST_ERROR', message: error.message,
      stack: error.stack });
    process.disconnect();
  }
}
