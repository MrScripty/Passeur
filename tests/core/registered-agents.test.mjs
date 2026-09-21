import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AgentRegistry } from '../../.passeur-core/src/agents/registry.js';
import { Coordinator } from '../../.passeur-core/src/core/coordinator.js';
import { RepositoryRuntime } from '../../.passeur-core/src/core/repository-runtime.js';
import { reconcileStoredTasks } from '../../.passeur-core/src/core/recovery.js';
import { BridgeError } from '../../.passeur-core/src/core/errors.js';
import { canonicalHash } from '../../.passeur-core/src/core/async.js';
import { projectId } from '../../.passeur-core/src/workspace/project.js';
import { MemoryStore } from '../fixtures/memory-store.mjs';
const exec = promisify(execFile);
const gate = () => { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; };
const context = (controller = new AbortController()) => ({ signal: controller.signal, approve: async () => ({ choice_id: 'decline' }) });
const done = (changes = {}) => ({ status: 'completed', summary: 'done', worker_stop: 'confirmed', worker_assessment: 'met', blockers: [], questions: [], checks: [], ...changes });
const identity = { package_version: '0.1.0', build_id: 'fixture', mode: 'development', node_version: process.version, node_executable: process.execPath, pid: process.pid, started_at: new Date().toISOString() };
const definition = (run, model) => ({ configure: () => ({ worker: { run: async input => { const turn_id=crypto.randomUUID(); await input.onEvent({kind:'turn_started',turn_id}); const result=await run(input); await input.onEvent({kind:'turn_settled',turn_id,terminal:result.status==='completed'?'completed':result.status==='cancelled'?'cancelled':'failed'});return result;} }, modes: ['review', 'implement'], contract: 'fixture/1', requested_model: model, configuration: { model } }) });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'passeur-agent-owners-'));
  const project = join(root, 'repo'); await mkdir(project);
  const git = async (cwd, ...args) => (await exec('git', ['-C', cwd, ...args], { timeout: 10000 })).stdout.trim();
  await git(project, 'init', '-q', '-b', 'main');
  await git(project, 'config', 'user.name', 'Passeur Fixture'); await git(project, 'config', 'user.email', 'fixture@example.invalid');
  await git(project, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(project, 'seed.txt'), 'seed\n'); await git(project, 'add', 'seed.txt'); await git(project, 'commit', '-qm', 'test: seed');
  const base = await git(project, 'rev-parse', 'HEAD');
  const policy = { implementation: { enabled: true, worktree_root: join(root, 'worktrees') }, max_clients:32, max_waiters:128, max_pending_inputs:16, max_control_receipts:512, stop_grace_ms: 1000, max_workers: 2, max_queued_tasks: 8 };
  const profile = { schema_version: 3, execution: policy, agents: ['one', 'two'].map((id) => ({ agent_id: id, adapter_id: id, enabled: true, description: id, options: {} })) };
  const store = new MemoryStore(join(root, 'state'));
  const owner={owner_id:canonicalHash(crypto.randomUUID()),client_id:crypto.randomUUID()},repositoryId=projectId(join(project,'.git'));
  const coordinators = [];
  const coordinator = (definitions, selected = profile) => {
    const c = new Coordinator(project, repositoryId, selected.execution, store, new AgentRegistry(selected, definitions)); coordinators.push(c); return Object.assign(c,{execute:async(request,ctx=context())=>execute(c,request,owner,project,ctx.signal),executeBatch:async(requests,ctx=context())=>Promise.all(requests.map(async request=>{try{return{request_key:request.request_key,result:await execute(c,request,owner,project,ctx.signal)}}catch(error){return{request_key:request.request_key,error:{code:error.code,message:error.message}}}}))});
  };
  const request = (key, agent = 'one', mode = 'review') => ({ schema_version: 3, agent_id: agent, request_key: key, mode, objective: key, context: '', acceptance_criteria: ['Complete the assigned outcome'], ...(mode === 'implement' ? { base_commit: base, target_ref: 'refs/heads/main' } : {}) });
  t.after(async () => { await Promise.all(coordinators.map((c) => c.shutdown())); await rm(root, { recursive: true, force: true }); });
  return { root, project, git, base, policy, profile, store, coordinator, request,owner,repositoryId };
}
async function execute(c,request,owner,root,signal){const receipt=await c.submit({schema_version:1,source_view:root,assignment:request},owner,signal);while(true){const result=await c.store.readResult(receipt.task_id);if(result)return result;const s=await c.controls.read(receipt.task_id,owner);await c.controls.wait(receipt.task_id,owner,s.revision,50,signal);}}
function runtimeFor(t, f, definitions, loader = async () => f.profile) {
  let state = 'held', acquisitions = 0, releases = 0;
  const runtime = new RepositoryRuntime({ project: f.project, profilePath: join(f.root, 'profile.json') }, identity, {
    resolveBinding: async () => ({ project: f.project, repositoryId: f.repositoryId, commonDir: join(f.project, '.git'), stateRoot: f.store.root, storeRoot: f.store.root, profilePath: join(f.root, 'profile.json') }),
    acquire: async () => { acquisitions++; state = 'held'; return { get state() { return state; }, assertOwned() { if (state !== 'held') throw new BridgeError('LEASE_NOT_HELD', 'fixture lease unavailable'); }, async release() { state = 'released'; releases++; } }; },
    store: (_root, guard) => f.store.scoped(guard), recover: reconcileStoredTasks, legacyRoots: async () => [], profile: loader, definitions,
  }, {});
  Object.assign(runtime,{execute:async(request,ctx=context())=>{const r=await runtime.submit(request,f.owner,f.project,ctx.signal);while(true){const result=await f.store.readResult(r.task_id);if(result)return result;const state=await runtime.taskObservation(r.task_id,f.owner);await runtime.waitTask(r.task_id,f.owner,state.revision,50,ctx.signal);}}});
  t.after(() => runtime.shutdown());
  return { runtime, get acquisitions() { return acquisitions; }, get releases() { return releases; } };
}

test('registry isolates unsupported entries and only configured modes can be selected', async (t) => {
  const f = await fixture(t);
  const registry = new AgentRegistry(f.profile, { one: definition(async () => done(), 'A') });
  assert.deepEqual(registry.catalog(false).agents.map((a) => a.state), ['configured', 'unsupported']);
  assert.throws(() => registry.select(f.request('x', 'two'), f.policy), { code: 'AGENT_UNSUPPORTED' });
  const selected = registry.select(f.request('x'), f.policy);
  assert.equal(selected.snapshot.requested_model, 'A');
  assert.equal(selected.snapshot.configuration_fingerprint, canonicalHash({ model: 'A' }));
  assert.throws(() => { selected.snapshot.policy.max_workers = 1; }, TypeError);
});
test('mixed agents share capacity and produce independently observed Git commits', async (t) => {
  const f = await fixture(t), both = gate(), finish = gate(); let active = 0, peak = 0;
  const run = (file) => async (input) => {
    peak = Math.max(peak, ++active); if (active === 2) both.resolve(); await finish.promise;
    await writeFile(join(input.workspace, file), `${file}\n`);
    await f.git(input.workspace, 'add', '--', file); await f.git(input.workspace, 'commit', '-qm', `feat: ${file}`);
    active--; return done();
  };
  const c = f.coordinator({ one: definition(run('one.txt'), 'A'), two: definition(run('two.txt'), 'B') });
  const pending = c.executeBatch([f.request('a', 'one', 'implement'), f.request('b', 'two', 'implement')], context());
  try {
    await both.promise; assert.equal(peak, 2); finish.resolve();
    const results = await pending;
    assert.deepEqual(results.map((r) => r.result.identity.snapshot.agent_id), ['one', 'two']);
    assert.deepEqual(results.map((r) => r.result.model.requested), ['A', 'B']);
    for (const row of results) {
      assert.equal(row.result.delivery.status, 'committed');
      assert.equal(await f.git(row.result.delivery.worktree_path, 'rev-parse', 'HEAD'), row.result.delivery.head_commit);
      assert.ok(row.result.delivery.commits.length);
    }
    assert.equal(await f.git(f.project, 'rev-parse', 'HEAD'), f.base);
  } finally { finish.resolve(); await pending; }
});
test('changed agent under an existing key conflicts; equivalent retry ignores current registry', async (t) => {
  const f = await fixture(t); let starts = 0;
  const c = f.coordinator({ one: definition(async () => { starts++; return done(); }, 'A') });
  const result = await c.execute(f.request('same'), context());
  await c.shutdown();
  const empty = f.coordinator({}, { ...f.profile, agents: [] });
  const retained = await empty.execute(f.request('same'), { ...context(), approvalAvailable: false });
  assert.equal(retained.task_id, result.task_id); assert.equal(starts, 1);
  await assert.rejects(empty.execute(f.request('same', 'two'), context()), { code: 'REQUEST_KEY_CONFLICT' });
});
test('a duplicate subscriber detaches without cancelling the owner', async (t) => {
  const f = await fixture(t), started = gate(), finish = gate(); let aborted = false, runs = 0;
  const c = f.coordinator({ one: definition(async ({ signal }) => { runs++; signal.addEventListener('abort', () => { aborted = true; }, { once: true }); started.resolve(); await finish.promise; return done(); }, 'A') });
  const owner = c.execute(f.request('same'), context());
  try {
    await started.promise;
    const cancel = new AbortController(), subscriber = c.execute(f.request('same'), context(cancel));
    cancel.abort(new Error('detach'));
    await assert.rejects(subscriber, /detach/); assert.equal(aborted, false); assert.equal(runs, 1);
  } finally { finish.resolve(); await owner; }
});
test('mutating the caller assignment after admission cannot rewrite execution identity', async (t) => {
  const f = await fixture(t), started = gate(), finish = gate(); let observed;
  const c = f.coordinator({ one: definition(async (input) => { observed = input.request.objective; started.resolve(); await finish.promise; return done(); }, 'A') });
  const assignment = f.request('fixed'), pending = c.execute(assignment, context()); assignment.objective = 'changed';
  try { await started.promise; assert.equal(observed, 'fixed'); finish.resolve(); const result = await pending; assert.equal((await f.store.find({ task_id: result.task_id })).request.objective, 'fixed'); }
  finally { finish.resolve(); await pending; }
});
test('an unavailable agent does not start or invalidate a healthy registration', async (t) => {
  const f = await fixture(t); let runs = 0;
  const c = f.coordinator({ one: definition(async () => { runs++; return done(); }, 'A'), two: { configure() { throw new BridgeError('AGENT_UNAVAILABLE', 'runtime not provisioned'); } } });
  const rows = await c.executeBatch([f.request('bad', 'two'), f.request('good')], context());
  assert.equal(rows[0].error.code, 'AGENT_UNAVAILABLE'); assert.equal(rows[1].result.execution_status, 'completed'); assert.equal(runs, 1);
  assert.equal((await f.store.list()).length, 1);
});
test('unconfirmed stop freezes future agents instead of silently routing around uncertainty', async (t) => {
  const f = await fixture(t); let other = 0;
  const c = f.coordinator({ one: definition(async () => done({ worker_stop: 'unconfirmed' }), 'A'), two: definition(async () => { other++; return done(); }, 'B') });
  const result = await c.execute(f.request('uncertain'), context());
  assert.equal(result.worker_stop, 'unconfirmed');
  await assert.rejects(c.execute(f.request('replacement', 'two'), context()), { code: 'PROJECT_NEEDS_RECONCILIATION' }); assert.equal(other, 0);
});
test('retained result retrieval bypasses missing profile, approval, adapter and lease', async (t) => {
  const f = await fixture(t), c = f.coordinator({ one: definition(async () => done(), 'A') });
  const previous = await c.execute(f.request('retained'), context()); await c.shutdown();
  const host = runtimeFor(t, f, {}, async () => { throw Error('profile must not load'); });
  assert.equal((await host.runtime.result(previous.task_id)).result.task_id, previous.task_id);
  assert.equal(host.acquisitions, 0);
});
test('failed pre-admission config can be repaired without poisoning the diagnostic runtime', async (t) => {
  const f = await fixture(t); let attempts = 0;
  const host = runtimeFor(t, f, { one: definition(async () => done(), 'A') }, async () => {
    if (++attempts === 1) throw new BridgeError('PROFILE_INVALID', 'repair required'); return f.profile;
  });
  await assert.rejects(host.runtime.execute(f.request('first'), context()), { code: 'PROFILE_INVALID' });
  assert.equal(host.runtime.status().execution.profile, 'blocked');
  assert.equal((await host.runtime.execute(f.request('retry'), context())).execution_status, 'completed');
  assert.equal(attempts, 2);
});
test('agent discovery and preparation neither start a worker nor fix a provisional catalog', async (t) => {
  const f = await fixture(t); let starts = 0, configuration = f.profile;
  const host = runtimeFor(t, f, { one: definition(async () => { starts++; return done(); }, 'A') }, async () => configuration);
  const catalog = await host.runtime.agents(); assert.equal(catalog.configuration, 'observed'); assert.equal(host.acquisitions, 0);
  configuration = { ...f.profile, agents: [f.profile.agents[0]] };
  assert.equal((await host.runtime.agents()).total, 1); assert.equal(starts, 0);
  await host.runtime.prepare(); assert.equal(starts, 0); assert.equal(host.runtime.status().execution.profile, 'not_checked');
  await host.runtime.execute(f.request('fix'), context());
  configuration = { ...configuration, agents: [] };
  assert.equal((await host.runtime.agents()).configuration, 'fixed_for_runtime'); assert.equal((await host.runtime.agents()).total, 1);
});
test('historical recovery preserves unavailable identity rather than using current configuration', async (t) => {
  const f = await fixture(t), { agent_id, ...legacy } = f.request('old'); legacy.schema_version = 2;
  const id = crypto.randomUUID(), now = new Date().toISOString();
  await f.store.create({ task_id: id, project_id: 'repo', canonical_hash: canonicalHash(legacy), accepted_at: now, deadline_at: now, request: legacy }, { phase: 'queued', updated_at: now });
  await reconcileStoredTasks(f.store);
  const result = await f.store.readResult(id);
  assert.equal(result.schema_version, 3); assert.equal(result.identity.status, 'unavailable'); assert.equal(result.identity.source_schema_version, 2);
  assert.deepEqual(result.model, {}); assert.equal(result.worker_stop, 'not_started');
});
