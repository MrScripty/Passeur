import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { RepositoryRuntime, resolveRepositoryBinding } from '../../../.passeur-core/src/core/repository-runtime.js';
import { TaskStore } from '../../../.passeur-core/src/store/task-store.js';
import { operatorToken } from '../../../.passeur-core/src/service/operator-token.js';

const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const intent = { project: config.root, stateRoot: config.state,
  profilePath: join(config.temp, 'missing-profile.json') };
const identity = { package_version: 'fixture', build_id: 'fixture', mode: 'development',
  node_version: process.version, node_executable: process.execPath, pid: process.pid,
  started_at: new Date().toISOString() };
const send = message => new Promise((resolve, reject) => process.send(message, error => error ? reject(error) : resolve()));

if (process.argv[3] === 'recover') {
  const runtime = new RepositoryRuntime(intent, identity);
  try {
    await runtime.prepare();
    await send({ kind: 'recovery', code: 'UNEXPECTED_READY', state: runtime.status().coordination.state });
  } catch (error) {
    await send({ kind: 'recovery', code: error.code ?? 'UNEXPECTED_ERROR',
      state: runtime.status().coordination.state });
  } finally {
    await runtime.shutdown();
    process.disconnect();
  }
} else {
  try {
    const binding = await resolveRepositoryBinding(intent, {}, new AbortController().signal);
    const token = await operatorToken(binding, true);
    const actor = { owner_id: createHash('sha256').update(token).digest('hex'), client_id: randomUUID() };
    let firstRevised, heldRevised;
    const workspaces = [];
    const workers = [0, 1, 2].map(index => ({ async run(input) {
      workspaces[index] = input.workspace;
      await writeFile(join(input.workspace, 'source.ts'), `export function run() { return ${index + 1}; }\n`);
      await input.onEvent({ kind: 'turn_started', turn_id: `initial-${index}`, native_session_id: `session-${index}` });
      await input.onEvent({ kind: 'turn_settled', turn_id: `initial-${index}`,
        native_session_id: `session-${index}`, terminal: 'completed' });
      if (index !== 0) return new Promise(() => {});
      let sequence = 0;
      for (;;) {
        const envelope = await input.peer.next();
        if (!envelope) { await delay(25); continue; }
        const turnId = `peer-0-${++sequence}`;
        await input.onEvent({ kind: 'turn_started', turn_id: turnId, native_session_id: 'session-0' });
        if (envelope.case_revision > 2 && firstRevised) {
          heldRevised = envelope;
          return new Promise(() => {});
        }
        await input.peer.delivered(envelope.idempotency_key, turnId, 'session-0');
        await input.onEvent({ kind: 'turn_settled', turn_id: turnId,
          native_session_id: 'session-0', terminal: 'completed' });
        await input.peer.observed(envelope.idempotency_key, turnId, 'session-0');
        if (envelope.case_revision > 2) firstRevised = envelope;
      }
    } }));
    const runtime = new RepositoryRuntime(intent, identity, {
      enableObservedCaseExtensionForTest: true,
      profile: async () => ({ schema_version: 3, execution: {
        stop_grace_ms: 1000, max_workers: 3, max_queued_tasks: 3, max_clients: 32,
        max_waiters: 128, max_pending_inputs: 16, max_control_receipts: 512,
        implementation: { enabled: true, worktree_root: join(config.temp, 'managed-worktrees') },
      }, agents: workers.map((_, index) => ({ agent_id: `peer${index}`, adapter_id: `peer${index}`,
        description: '', enabled: true, options: {} })) }),
      definitions: Object.fromEntries(workers.map((worker, index) => [`peer${index}`, {
        configure: () => ({ modes: ['implement'], contract: 'controlled-peer/1', configuration: {},
          worker: { run: input => worker.run(input) } }),
      }])),
    });
    const store = new TaskStore(binding.storeRoot);
    const state = async () => JSON.parse(await readFile(join(binding.storeRoot, 'coordination/control.json'), 'utf8'));
    const waitFor = async (description, read, predicate, attempts = 400) => {
      for (let attempt = 0; attempt < attempts; attempt++) {
        const value = await read();
        if (predicate(value)) return value;
        await delay(30);
      }
      throw Error(`${description} did not become true`);
    };
    const submit = index => runtime.submitCoordinated({ schema_version: 2, kind: 'inline',
      assignment: { schema_version: 3, agent_id: `peer${index}`, request_key: randomUUID(),
        mode: 'implement', objective: `Change source.ts for peer ${index}`, context: '',
        acceptance_criteria: ['Edit source.ts'], allowed_paths: ['source.ts'],
        base_commit: config.base, target_ref: 'refs/heads/main' },
    }, actor, config.root, new AbortController().signal);
    const refresh = async id => {
      try { await runtime.structuralRefresh(id, actor); }
      catch (error) { if (!['STRUCTURAL_SOURCE_FORBIDDEN', 'COORDINATION_NOT_FOUND'].includes(error.code)) throw error; }
    };
    await runtime.coordinate({ schema_version: 1, kind: 'initialize', limits: config.limits }, actor, config.root);
    const ids = (await Promise.all([submit(0), submit(1)])).map(item => item.task_id);
    let pairCase;
    for (let attempt = 0; attempt < 160 && !pairCase; attempt++) {
      await refresh(ids[0]); await refresh(ids[1]);
      pairCase = (await state()).cases.find(item => item.observed_origin === 'selected' && item.inputs.length === 2);
      if (!pairCase) await delay(30);
    }
    if (!pairCase) throw Error('Initial genuine selected pair was not established');
    await waitFor('original pair observed', () => store.readPeerDeliveries(ids[0]), records =>
      records.some(record => record.state === 'observed' && record.envelope.case_id === pairCase.id &&
        record.envelope.case_revision === pairCase.revision));
    await refresh(ids[0]); await refresh(ids[1]);
    ids.push((await submit(2)).task_id);
    await waitFor('third native task', () => store.readControl(ids[2]), control =>
      control.native.state === 'observed_live' && control.native.coverage === 'turn_scoped');
    await refresh(ids[2]);
    const joined = await waitFor('three-work selected case', async () =>
      (await state()).cases.find(item => item.id === pairCase.id && item.inputs.length === 3), Boolean);
    await waitFor('one exact revised receipt and held native turn', async () => {
      const records = await store.readPeerDeliveries(ids[0]);
      return { records, firstRevised, heldRevised };
    }, value => value.firstRevised && value.heldRevised && value.records.some(record =>
      record.state === 'observed' && record.envelope.delivery_id === value.firstRevised.delivery_id) &&
      value.records.some(record => record.envelope.delivery_id === value.heldRevised.delivery_id));
    const final = await state();
    const selected = final.cases.find(item => item.id === joined.id);
    const recipientWorkId = final.works.find(work => work.managed?.task_id === ids[0])?.id;
    if (!recipientWorkId || !selected.inputs.some(item => item.work_id === recipientWorkId) ||
      !selected.delivery_pending?.includes(recipientWorkId) ||
      selected.delivery_observed?.some(item => item.work_id === recipientWorkId))
      throw Error('Selected case obligation settled before crash checkpoint');
    await send({ kind: 'checkpoint', ids, work_ids: selected.inputs.map(item => item.work_id),
      case_id: selected.id, revision: selected.revision, recipient_work_id: recipientWorkId,
      observed_delivery_id: firstRevised.delivery_id, held_delivery_id: heldRevised.delivery_id });
    await new Promise(() => {});
  } catch (error) {
    await send({ kind: 'setup_failure', code: error.code ?? 'TEST_ERROR', message: error.message });
    process.disconnect();
  }
}
