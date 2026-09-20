import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TaskStore } from '../../.passeur-core/src/store/task-store.js';
import { AgentRegistry } from '../../.passeur-core/src/agents/registry.js';
import { canonicalHash } from '../../.passeur-core/src/core/async.js';
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
    task_timeout_ms: 60_000, stop_grace_ms: 1_000, max_workers: 2, max_queued_tasks: 8 };
  const profile = { schema_version: 2, execution: policy,
    agents: [{ agent_id: 'muse', adapter_id: 'muse', description: 'Controlled worker', enabled: true, options: {} }] };
  const registry = worker => new AgentRegistry(profile, { muse: { configure: () => ({ worker, modes: ['review', 'implement'], contract: 'fixture/1', requested_model: 'model', configuration: { model: 'model' } }) } });
  const snapshot = request => registry({run: async () => done()}).select(request, policy).snapshot;
  const admission = (request, id = crypto.randomUUID()) => { const now = Date.now(); return {
    task_id: id, project_id: 'project', request, execution: snapshot(request), canonical_hash: canonicalHash(request),
    accepted_at: new Date(now).toISOString(), deadline_at: new Date(now + policy.task_timeout_ms).toISOString(),
  }; };
  const store = new TaskStore(state); await store.initialize();
  return { temp, root, state, worktrees, base, profile, policy, store, registry, snapshot, admission,
    coordinator: (worker, overrides = {}) => new Coordinator(root, 'project', { ...policy, ...overrides }, store, registry(worker)),
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
