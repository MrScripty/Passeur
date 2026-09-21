// These tests prove coordinator/control behavior and real Git effects. MemoryStore deliberately
// excludes codec, durable publication and service-IPC claims, covered by the integration suites.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MemoryStore } from '../fixtures/memory-store.mjs';
import { TaskControls, initialControl } from '../../.passeur-core/src/core/task-control.js';
import { InputBroker } from '../../.passeur-core/src/core/input-broker.js';
import { Coordinator } from '../../.passeur-core/src/core/coordinator.js';
import { AgentRegistry } from '../../.passeur-core/src/agents/registry.js';
import { canonicalHash } from '../../.passeur-core/src/core/async.js';
import { reconcileStoredTasks } from '../../.passeur-core/src/core/recovery.js';
const exec = promisify(execFile);
const actor = () => ({ owner_id: createHash('sha256').update(randomUUID()).digest('hex'), client_id: randomUUID() });
const hold = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const done = (extra = {}) => ({ status: 'completed', summary: 'fixture done', worker_stop: 'confirmed', worker_assessment: 'met', blockers: [], questions: [], checks: [], ...extra });
const policy = { stop_grace_ms: 1000, max_workers: 2, max_queued_tasks: 8, max_clients: 32, max_waiters: 128, max_pending_inputs: 16, max_control_receipts: 512, implementation: { enabled: false } };
const request = (key, extra = {}) => ({ schema_version: 3, agent_id: 'fixture', request_key: key, mode: 'review', objective: key, context: '', acceptance_criteria: ['Explicit outcome'], ...extra });
const free = () => new AbortController().signal;
const delay = (ms) => new Promise(r => setTimeout(r, ms));
async function eventually(fn) { for (let n = 0; n < 1000; n++) { const value = await fn(); if (value) return value; await delay(2); } throw Error('Test observation did not arrive'); }
async function fixture(t, run = async () => done(), overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'passeur-durable-')), project = join(root, 'project'); await mkdir(project);
  const git = async (...args) => (await exec('git', ['-C', project, ...args])).stdout.trim();
  await git('init', '-q', '-b', 'main'); await git('config', 'user.name', 'Synthetic Fixture'); await git('config', 'user.email', 'fixture@example.invalid'); await git('config', 'commit.gpgsign', 'false');
  await writeFile(join(project, 'seed'), 'synthetic\n'); await git('add', 'seed'); await git('commit', '-qm', 'test: synthetic seed');
  const base = await git('rev-parse', 'HEAD');
  const p = { ...policy, ...overrides }, store = new MemoryStore(join(root, 'store'));
  const profile = { schema_version: 3, execution: p, agents: [{ agent_id: 'fixture', adapter_id: 'fixture', description: '', enabled: true, options: {} }] };
  const definitions = { fixture: { configure: () => ({ modes: ['review', 'implement'], contract: 'controlled-turn/1', configuration: {}, worker: { run } }) } };
  const registry = new AgentRegistry(profile, definitions);
  const c = new Coordinator(project, 'repository', p, store, registry), owner = actor();
  t.after(async () => {
    for (const r of await store.list()) { const s = await store.readControl(r.task_id); if (s.phase !== 'terminal' && !s.settled_outcome) await c.cancel(r.task_id, { ...owner, owner_id: s.owner_id }, s.control_generation, `cleanup:${r.task_id}`, 'Discard-authorized synthetic fixture shutdown'); }
    await c.shutdown();
    // Only this synthetic repository and its generated disposable refs are discard-authorized.
    await rm(root, { recursive: true, force: true });
  });
  return { root, project, base, store, c, owner, registry, profile, git,
    submit: (key, signal = free(), extra = {}) => c.submit({ schema_version: 1, source_view: project, assignment: request(key, extra) }, owner, signal),
    terminal: async id => { await eventually(async () => (await store.readResult(id))); return store.readResult(id); } };
}
async function terminalRun(input, effect = async () => {}) {
  const turn_id = randomUUID(); await input.onEvent({ kind: 'turn_started', turn_id }); await effect(); await input.onEvent({ kind: 'turn_settled', turn_id, terminal: 'completed' }); return done();
}

test('accepted task survives cancellation of submit acknowledgement and observation wait', async t => {
  const started = hold(), finish = hold(); let signal;
  const f = await fixture(t, input => terminalRun(input, async () => { signal = input.signal; started.resolve(); await finish.promise; }));
  const client = new AbortController(), receipt = await f.submit('long', client.signal); await started.promise;
  client.abort(Error('caller disconnected')); assert.equal(signal.aborted, false);
  const waitSignal = new AbortController(); const state = await f.c.controls.read(receipt.task_id, f.owner);
  const waiting = f.c.controls.wait(receipt.task_id, f.owner, state.revision, 60_000, waitSignal.signal); waiting.catch(() => undefined);
  waitSignal.abort(Error('stop only this wait')); await assert.rejects(waiting, /stop only this wait/); assert.equal(signal.aborted, false);
  const next = await f.c.controls.read(receipt.task_id, f.owner);
  assert.equal((await f.c.controls.wait(receipt.task_id, f.owner, next.revision, 1, free())).kind, 'wait_elapsed');
  assert.equal((await f.store.readControl(receipt.task_id)).cancel, undefined); finish.resolve(); assert.equal((await f.terminal(receipt.task_id)).execution_status, 'completed');
});

test('lost receipt is resolved by key and owner without another execution', async t => {
  let runs = 0; const f = await fixture(t, i => terminalRun(i, async () => { runs++; }));
  const r = await f.submit('once'); await f.terminal(r.task_id);
  assert.equal((await f.submit('once')).task_id, r.task_id); assert.equal(runs, 1);
  await assert.rejects(f.c.submit({ schema_version: 1, source_view: f.project, assignment: request('once') }, actor(), free()), { code: 'TASK_CONTROL_CONFLICT' });
  await assert.rejects(f.submit('once', free(), { objective: 'different' }), { code: 'REQUEST_KEY_CONFLICT' });
});

test('two clients share capacity while draining does not cancel their work', async t => {
  const both = hold(), finish = hold(); let starts = 0, cancelled = false;
  const f = await fixture(t, i => terminalRun(i, async () => { if (++starts === 2) both.resolve(); i.signal.addEventListener('abort', () => { cancelled = true; }); await finish.promise; }));
  const a = await f.submit('a'), other = actor();
  const b = await f.c.submit({ schema_version: 1, source_view: f.project, assignment: request('b') }, other, free()); await both.promise;
  let drained = false; const close = f.c.shutdown().then(() => { drained = true; }); await delay(10);
  assert.equal(drained, false); assert.equal(cancelled, false); finish.resolve(); await close;
  assert.equal((await f.terminal(a.task_id)).execution_status, 'completed'); assert.equal((await f.terminal(b.task_id)).execution_status, 'completed');
});

test('queued task has no elapsed deadline and explicit cancellation never starts it', async t => {
  const started = hold(), finish = hold(); let starts = 0;
  const f = await fixture(t, i => terminalRun(i, async () => { starts++; started.resolve(); await finish.promise; }), { max_workers: 1, max_queued_tasks: 1 });
  const first = await f.submit('first'); await started.promise;
  const queued = await f.submit('queued'); await assert.rejects(f.submit('excess'), { code: 'CAPACITY_EXCEEDED' });
  const before = await f.store.readControl(queued.task_id), originalNow = Date.now;
  try { Date.now = () => originalNow() + 10 * 86400000; await delay(5); assert.equal((await f.store.readControl(queued.task_id)).phase, 'queued'); }
  finally { Date.now = originalNow; }
  await f.c.cancel(queued.task_id, f.owner, before.control_generation, 'stop-queued', 'Explicit stop');
  const result = await f.terminal(queued.task_id); assert.equal(result.execution_status, 'cancelled'); assert.equal(result.worker_stop, 'not_started'); assert.equal(starts, 1);
  finish.resolve(); await f.terminal(first.task_id);
});

test('input stays pending across presentation dismissal and owner adoption invalidates old claims', async t => {
  const ready = hold(); let answer;
  const f = await fixture(t, async i => {
    const turn_id = randomUUID(); await i.onEvent({ kind: 'turn_started', turn_id }); ready.resolve();
    answer = await i.input('Which documented format?'); await i.onEvent({ kind: 'turn_settled', turn_id, terminal: 'completed' }); return done();
  });
  const r = await f.submit('question'); await ready.promise;
  const s = await eventually(async () => { const state = await f.store.readControl(r.task_id); return state.inputs.length ? state : undefined; }); const id = s.inputs[0].input_id;
  const claim = await f.c.inputs.claim(r.task_id, id, f.owner, s.control_generation);
  await f.c.inputs.dismiss(r.task_id, id, f.owner, claim.claim.id);
  assert.equal((await f.store.readControl(r.task_id)).inputs[0].state, 'pending'); assert.equal(answer, undefined);
  const oldClaim = await f.c.inputs.claim(r.task_id, id, f.owner, s.control_generation), nextOwner = actor();
  await f.c.controls.adopt(r.task_id, nextOwner, 'confirmed-adoption');
  await assert.rejects(f.c.inputs.answer(r.task_id, id, f.owner, s.control_generation, oldClaim.claim.id, 'late', 'json'), { code: 'TASK_CONTROL_CONFLICT' });
  const fresh = await f.c.controls.read(r.task_id, nextOwner), present = await f.c.inputs.claim(r.task_id, id, nextOwner, fresh.control_generation);
  const receipt = await f.c.inputs.answer(r.task_id, id, nextOwner, fresh.control_generation, present.claim.id, 'answer-once', 'json');
  assert.equal(receipt.outcome, 'answer_intent'); assert.equal((await f.c.inputs.answer(r.task_id, id, nextOwner, fresh.control_generation, present.claim.id, 'answer-once', 'json')).hash, receipt.hash);
  assert.equal((await f.terminal(r.task_id)).execution_status, 'completed'); assert.equal(answer, 'json');
});

test('permission accepts only an offered decision and survives wait budget expiration', async t => {
  let selected;
  const f = await fixture(t, async i => {
    const turn_id = randomUUID(); await i.onEvent({ kind: 'turn_started', turn_id });
    selected = await i.approve({ id: 'native-op', tool: 'file-change', raw_args: 'change assigned file', subject: {}, choices: [{ id: 'no', label: 'Deny', decision: 'denied', scope: 'once' }] }, i.signal);
    await i.onEvent({ kind: 'turn_settled', turn_id, terminal: 'completed' }); return done();
  });
  const r = await f.submit('approval'), state = await eventually(async () => { const s = await f.store.readControl(r.task_id); return s.inputs[0] ? s : undefined; }); const id = state.inputs[0].input_id;
  const present = await f.c.inputs.claim(r.task_id, id, f.owner, state.control_generation);
  await assert.rejects(f.c.inputs.answer(r.task_id, id, f.owner, state.control_generation, present.claim.id, 'illegal', 'allow-all'), { code: 'INPUT_ANSWER_INVALID' });
  assert.equal((await f.store.readControl(r.task_id)).inputs[0].state, 'pending');
  await f.c.inputs.answer(r.task_id, id, f.owner, state.control_generation, present.claim.id, 'human-denial', 'no');
  assert.equal((await f.terminal(r.task_id)).execution_status, 'completed'); assert.deepEqual(selected, { choice_id: 'no' });
});

test('native cancellation wins over a late reported successful turn', async t => {
  const started = hold();
  const f = await fixture(t, async i => {
    const turn_id = randomUUID(); await i.onEvent({ kind: 'turn_started', turn_id }); started.resolve();
    await new Promise(resolve => i.signal.addEventListener('abort', resolve, { once: true }));
    await i.onEvent({ kind: 'turn_settled', turn_id, terminal: 'completed' }); return done();
  });
  const r = await f.submit('cancel'); await started.promise;
  await f.c.cancel(r.task_id, f.owner, r.control_generation, 'explicit', 'Owner stop');
  assert.equal((await f.terminal(r.task_id)).execution_status, 'cancelled');
  assert.equal((await f.c.cancel(r.task_id, f.owner, r.control_generation, 'after', 'Stop after terminal')).outcome, 'already_terminal');
});

test('unsettled native obligations cannot be reported as successful and unknown stop freezes replacements', async t => {
  const f = await fixture(t, async i => { await i.onEvent({ kind: 'turn_started', turn_id: 'turn' }); await i.onEvent({ kind: 'operation_started', id: 'tool', operation: 'command' }); await i.onEvent({ kind: 'turn_settled', turn_id: 'turn', terminal: 'completed' }); return done({ worker_stop: 'unconfirmed' }); });
  const r = await f.submit('unknown'), result = await f.terminal(r.task_id);
  assert.notEqual(result.execution_status, 'completed'); assert.equal(result.native_evidence.obligations.length, 1); assert.equal(result.worker_stop, 'unconfirmed');
  await assert.rejects(f.submit('replacement'), { code: 'PROJECT_NEEDS_RECONCILIATION' });
});

test('recovery preserves queued identity, classifies submitted uncertainty and never replays work', async t => {
  const f = await fixture(t); const id = randomUUID(), q = request('preserved');
  const record = { schema_version: 4, task_id: id, project_id: 'repository', request: q, execution: f.registry.select(q, f.profile.execution).snapshot,
    canonical_hash: canonicalHash({ schema_version: 1, source_view: f.project, assignment: q }), accepted_at: new Date().toISOString(), source_view: f.project, initial_owner: f.owner.owner_id };
  await f.store.create(record, initialControl(id, f.owner.owner_id)); await reconcileStoredTasks(f.store);
  assert.equal((await f.store.readControl(id)).native.state, 'not_started'); assert.match((await f.store.readControl(id)).attention, /Recovered queued/); assert.equal(await f.store.readResult(id), undefined);
  await f.c.cancel(id, f.owner, 1, 'cancel-recovered', 'Explicitly retire never-started work');
  assert.equal((await f.store.readResult(id)).execution_status, 'cancelled');
});

test('source view is part of idempotency and implementation delivers observed real commits', async t => {
  let f; f = await fixture(t, i => terminalRun(i, async () => { await writeFile(join(i.workspace, 'work'), 'implemented\n'); await exec('git', ['-C', i.workspace, 'add', 'work']); await exec('git', ['-C', i.workspace, 'commit', '-qm', 'feat: synthetic assignment']); }), { implementation: { enabled: true, worktree_root: join(tmpdir(), `passeur-worktrees-${randomUUID()}`) } });
  t.after(() => rm(f.profile.execution.implementation.worktree_root, { recursive: true, force: true }));
  const r = await f.submit('code', free(), { mode: 'implement', base_commit: f.base, target_ref: 'refs/heads/main' }), result = await f.terminal(r.task_id);
  assert.equal(result.execution_status, 'completed'); assert.equal(result.delivery.status, 'committed'); assert.notEqual(result.delivery.head_commit, f.base);
  assert.equal(await readFile(join(result.delivery.worktree_path, 'work'), 'utf8'), 'implemented\n');
  const view = join(f.root, 'view'); await f.git('worktree', 'add', '--detach', view, f.base);
  await assert.rejects(f.c.submit({ schema_version: 1, source_view: view, assignment: request('code', { mode: 'implement', base_commit: f.base, target_ref: 'refs/heads/main' }) }, f.owner, free()), { code: 'REQUEST_KEY_CONFLICT' });
});
