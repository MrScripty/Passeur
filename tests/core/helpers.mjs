import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TaskStore } from '../../.passeur-core/src/store/task-store.js';
import { AgentRegistry } from '../../.passeur-core/src/agents/registry.js';
import { canonicalHash } from '../../.passeur-core/src/core/async.js';
import { initialControl } from '../../.passeur-core/src/core/task-control.js';
import { Coordinator } from '../../.passeur-core/src/core/coordinator.js';
export const exec = promisify(execFile);
export async function git(root, ...args) { return (await exec('git', ['-C', root, ...args])).stdout; }
export async function fixture(t) {
  const temp = await mkdtemp(join(tmpdir(), 'passeur-core-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, 'project'), state = join(temp, 'state'), worktrees = join(temp, 'worktrees');
  await mkdir(root); await mkdir(worktrees);
  await git(root, 'init', '-q', '-b', 'main');
  await git(root, 'config', 'user.email', 'passeur-test@example.invalid');
  await git(root, 'config', 'user.name', 'Passeur Test');
  await git(root, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(root, 'watched.txt'), 'before\n\n');
  await git(root, 'add', '.'); await git(root, 'commit', '-qm', 'test: base');
  const base = (await git(root, 'rev-parse', 'HEAD')).trim();
  const policy = { implementation: { enabled: true, worktree_root: worktrees },
    stop_grace_ms: 1_000, max_workers: 2, max_queued_tasks: 8, max_clients: 32, max_waiters: 128, max_pending_inputs: 16, max_control_receipts: 512 };
  const profile = { schema_version: 3, execution: policy,
    agents: [{ agent_id: 'muse', adapter_id: 'muse', description: 'Controlled worker', enabled: true, options: {} }] };
  const registry = worker => new AgentRegistry(profile, { muse: { configure: () => ({ worker: observedWorker(worker), modes: ['review', 'implement'], contract: 'fixture/1', requested_model: 'model', configuration: { model: 'model' } }) } });
  const snapshot = request => registry({run: async () => done()}).select(request, policy).snapshot;
  const owner = { owner_id: canonicalHash(crypto.randomUUID()), client_id: crypto.randomUUID() };
  const admission = (request, id = crypto.randomUUID()) => ({ schema_version: 4, task_id: id, project_id: 'project', request, execution: snapshot(request),
    source_view: root, initial_owner: owner.owner_id, canonical_hash: canonicalHash({ schema_version: 1, source_view: root, assignment: request }), accepted_at: new Date().toISOString() });
  const store = new TaskStore(state); await store.initialize();
  return { temp, root, state, worktrees, base, profile, policy, store, registry, snapshot, admission, owner, initial: id => initialControl(id, owner.owner_id),
    coordinator: (worker, overrides = {}) => wrapCoordinator(new Coordinator(root, 'project', { ...policy, ...overrides }, store, registry(worker)), root, owner),
    request: (key, extra = {}) => ({ schema_version: 3, agent_id: 'muse', request_key: key, mode: 'review', objective: key, context: '', acceptance_criteria: ['scoped outcome'], ...extra }),
    implementation: (key, extra = {}) => ({ schema_version: 3, agent_id: 'muse', request_key: key, mode: 'implement', objective: key, context: '', acceptance_criteria: ['scoped outcome'], base_commit: base, target_ref: 'refs/heads/main', ...extra }),
  };
}
export const done = (extra = {}) => ({ status: 'completed', summary: 'done', worker_stop: 'confirmed', worker_assessment: 'met', blockers: [], questions: [], checks: [], ...extra });
export function context(controller = new AbortController()) { return { signal: controller.signal, approve: async () => ({ choice_id: 'deny' }) }; }
export function hold() { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; }
export async function until(check) {
  const deadline = Date.now() + 3000;
  while (!check()) { if (Date.now() >= deadline) throw Error('condition did not become true'); await new Promise(resolve => setTimeout(resolve, 2)); }
}
export async function commitFile(input, name = 'change.txt', content = 'change\n') {
  await writeFile(join(input.workspace, name), content);
  await git(input.workspace, 'add', '--', name);
  await git(input.workspace, 'commit', '-qm', `feat: ${input.request.request_key}`);
  return done();
}

/** Fixture turn evidence, never applied to a native adapter under test. */
export function observedWorker(worker) { return { run: async input => {
  const turn_id = crypto.randomUUID(); await input.onEvent({kind:'turn_started',turn_id});
  const result = await worker.run(input); await input.onEvent({kind:'turn_settled',turn_id,terminal:result.status==='completed'?'completed':result.status==='cancelled'?'cancelled':'failed'}); return result;
} }; }
export function wrapCoordinator(c, root, owner) {
  const execute = async (assignment, ctx = context()) => {
    const receipt = await c.submit({ schema_version: 1, source_view: root, assignment }, owner, ctx.signal);
    while (true) {
      const result = await c.store.readResult(receipt.task_id); if (result) return result;
      if (c.frozenReason && !c.isActive(receipt.task_id)) throw Error(c.frozenReason);
      const state = await c.controls.read(receipt.task_id, owner); await c.controls.wait(receipt.task_id, owner, state.revision, 50, ctx.signal);
    }
  };
  return Object.assign(c, { execute, executeBatch: (assignments, ctx = context()) => Promise.all(assignments.map(async assignment => {
    try { return {request_key:assignment.request_key,result:await execute(assignment,ctx)}; }
    catch(error) { return {request_key:assignment.request_key,error:{code:error.code??'ERROR',message:error.message}}; }
  })) });
}
