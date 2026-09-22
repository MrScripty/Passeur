import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, access, appendFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { git, projectId } from '../../../.passeur-core/src/workspace/project.js';
import { CoordinationStore } from '../../../.passeur-core/src/store/coordination-store.js';
import { CoordinationControl } from '../../../.passeur-core/src/coordination/control.js';
import { CoordinationRepository } from '../../../.passeur-core/src/coordination/repository.js';
import { RepositoryCoordination } from '../../../.passeur-core/src/coordination/bound-control.js';

export { git, CoordinationRepository, RepositoryCoordination, CoordinationStore, CoordinationControl };
export const A = Object.freeze({ owner_id: 'a'.repeat(64) });
export const B = Object.freeze({ owner_id: 'b'.repeat(64) });
export const C = Object.freeze({ owner_id: 'c'.repeat(64) });
export const key = () => randomUUID();
export const op = (kind, item, rest = {}) => ({ kind, operation_key: key(), case_id: item.id, expected_revision: item.revision, generation: item.generation, ...rest });
export const hold = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
export async function repoFixture(t, options = {}) {
  const temp = await mkdtemp(join(tmpdir(), 'passeur-bound-'));
  const root = join(temp, options.rootName ?? 'repo'), state = join(temp, 'state');
  await mkdir(root); await mkdir(state, { mode: 0o700 });
  const owners = [];
  t.after(async () => {
    for (const owner of owners.reverse()) await owner.close();
    // All fixture commits, paths and linked registrations are intentionally disposable, never user resources.
    let head;
    try { head = (await git(root, ['rev-parse', 'HEAD'])).trim(); } catch { head = 'fixture-root-moved'; }
    await rm(temp, { recursive: true }); await assert.rejects(access(temp), { code: 'ENOENT' });
    if (process.env.PASSEUR_TEST_RESOURCE_LOG) await appendFile(process.env.PASSEUR_TEST_RESOURCE_LOG,
      JSON.stringify({ test: t.name, root: temp, head, outcome: 'removed-discard-authorized-test-fixture' }) + '\n');
  });
  await git(root, ['init', `--object-format=${options.format ?? 'sha1'}`, '-b', 'main']);
  await git(root, ['config', 'user.name', 'Passeur binding fixture']);
  await git(root, ['config', 'user.email', 'binding@example.invalid']);
  await git(root, ['config', 'commit.gpgsign', 'false']);
  const commit = async (workspace = root, path = 'source.ts', text = 'export function run() {}\n') => {
    await writeFile(join(workspace, path), text); await git(workspace, ['add', '--', path]);
    await git(workspace, ['commit', '-m', 'test: fixture change']);
    return (await git(workspace, ['rev-parse', 'HEAD'])).trim();
  };
  const base = await commit(), repositoryId = projectId(join(root, '.git'));
  const limits = { works: 32, cases: 16, notes: 32, receipts: 256, note_bytes: 1024 };
  const store = await CoordinationStore.initialize(state, repositoryId, limits, options.authority ?? (() => {}));
  const control = new CoordinationControl(store);
  const admittedRoots = new Set([root]);
  const resourceAuthority = options.resourceAuthority ?? {
    async assertExternalRegistration(_actor, workspace) {
      assert.equal(admittedRoots.has(workspace.root), true, 'fixture policy only admits its explicitly declared external roots');
    },
  };
  const bound = await RepositoryCoordination.open(root, control, resourceAuthority,
    { max_worktrees: options.maxWorktrees ?? 64, max_source_operations: options.maxSourceOperations ?? 4 });
  owners.push(bound);
  const connection = (actor = A, source_view = root) => ({ ...actor, source_view });
  const linked = async (name = 'worker', from = base, detach = false) => {
    const path = join(temp, name);
    await git(root, ['worktree', 'add', ...(detach ? ['--detach'] : ['-b', name.replace(/[^a-z0-9-]/gi, '') || key()]), path, from]);
    admittedRoots.add(path); return path;
  };
  const register = (patch = {}) => ({ kind: 'register_external_work', operation_key: key(), input_oid: base, intent: 'fixture assignment',
    areas: [{ kind: 'file', path: 'source.ts' }], readers: [], ...patch });
  const claim = (patch = {}) => ({ kind: 'claim_target', operation_key: key(), target: 'refs/heads/main', members: [], ...patch });
  return { temp, root, state, store, control, bound, repositoryId, base, owners, admittedRoots, resourceAuthority, connection,
    commit, linked, register, claim, disk: async () => JSON.parse(await readFile(join(state, 'coordination/control.json'), 'utf8')) };
}
export async function selectedFixture(t, options = {}) {
  const f = await repoFixture(t, options), worker = await f.linked();
  const result = await f.commit(worker, 'worker.ts', 'export function worker(value: string) {}\n');
  const registered = await f.bound.execute(f.connection(A, worker), f.register({ readers: [B.owner_id] }));
  const work = await f.control.work(A, registered.item_id);
  const claimed = await f.bound.execute(f.connection(), f.claim({ members: [B.owner_id] }));
  let item = await f.control.reconciliation(A, claimed.item_id);
  const selection = op('select_inputs', item, { target_oid: f.base, inputs: [{ work_id: work.id, commit_oid: result }] });
  await f.bound.execute(f.connection(), selection); item = await f.control.reconciliation(A, item.id);
  return { ...f, worker, result, work, item, selection };
}
