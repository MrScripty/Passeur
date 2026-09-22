import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CoordinationService } from '../../../.passeur-core/src/service/coordination.js';
import { git, projectId } from '../../../.passeur-core/src/workspace/project.js';
import { BridgeError } from '../../../.passeur-core/src/core/errors.js';
export { git, CoordinationService, BridgeError };
export const A = Object.freeze({ owner_id: 'a'.repeat(64) });
export const B = Object.freeze({ owner_id: 'b'.repeat(64) });
export const C = Object.freeze({ owner_id: 'c'.repeat(64) });
export const key = () => randomUUID();
export const hold = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
export const request = (kind, fields = {}) => ({ schema_version: 1, kind, ...fields });
export const command = c => request('command', { command: c });
export const readRequest = (selector, fields = {}) => request('read', { selector, offset: 0, limit: 8192, expected_hash: null, ...fields });
export const caseCommand = (kind, item, fields = {}) => command({ kind, operation_key: key(), case_id: item.id, expected_revision: item.revision, generation: item.generation, ...fields });
export async function serviceFixture(t, options = {}) {
  const temp = await mkdtemp(join(tmpdir(), 'passeur-session-'));
  const root = join(temp, 'repo'), state = join(temp, 'state');
  await mkdir(root); await mkdir(state, { mode: 0o700 });
  const sessions = [], admittedRoots = new Set([root]);
  t.after(async () => {
    for (const session of sessions.reverse()) await session.close();
    // The fixture owns the whole disposable repository, commits, and linked registrations.
    await rm(temp, { recursive: true }); await assert.rejects(access(temp), { code: 'ENOENT' });
    if (process.env.PASSEUR_TEST_RESOURCE_LOG) await appendFile(process.env.PASSEUR_TEST_RESOURCE_LOG,
      JSON.stringify({ test: t.name, root: temp, outcome: 'removed-discard-authorized-test-fixture' }) + '\n');
  });
  await git(root, ['init', `--object-format=${options.format ?? 'sha1'}`, '-b', 'main']);
  await git(root, ['config', 'user.name', 'Passeur service fixture']);
  await git(root, ['config', 'user.email', 'service@example.invalid']);
  await git(root, ['config', 'commit.gpgsign', 'false']);
  const commit = async (workspace = root, name = 'source.ts', contents = 'export function run() {}\n') => {
    await writeFile(join(workspace, name), contents); await git(workspace, ['add', '--', name]);
    await git(workspace, ['commit', '-m', 'test: fixture source']);
    return (await git(workspace, ['rev-parse', 'HEAD'])).trim();
  };
  const base = await commit(), repositoryId = projectId(join(root, '.git'));
  const limits = { works: 32, cases: 16, notes: 32, receipts: 256, note_bytes: 16384 };
  const serviceLimits = { ordinary_requests: 16, control_requests: 4, max_source_operations: 4, max_worktrees: 64, ...options.serviceLimits };
  let owned = true, authorizations = 0, registrations = 0;
  const authority = {
    assertOwned() { if (!owned) throw new BridgeError('LEASE_NOT_HELD', 'Fixture service authority was withdrawn'); },
    async authorizeInitialization(actor, proposed) {
      authorizations++; assert.ok(Object.isFrozen(actor)); assert.ok(Object.isFrozen(proposed));
      if (options.authorizeInitialization) return options.authorizeInitialization(actor, proposed);
      if (actor.owner_id !== A.owner_id) throw new BridgeError('COORDINATION_INITIALIZATION_FORBIDDEN', 'Fixture operator policy denied this principal');
    },
    externalWorkspaces: { async assertExternalRegistration(actor, workspace) {
      registrations++;
      if (options.externalRegistration) return options.externalRegistration(actor, workspace);
      if (!admittedRoots.has(workspace.root)) throw new BridgeError('TASK_WORKSPACE_OWNED', 'Fixture resource policy denied external enrollment');
    } },
  };
  const make = () => { const s = new CoordinationService({ store_root: state, repository_id: repositoryId }, authority, serviceLimits); sessions.push(s); return s; };
  let service = make();
  const connection = (actor = A, source_view = root) => ({ ...actor, source_view });
  const call = (req, actor = A, source = root, signal) => service.handle(connection(actor, source), req, signal);
  const initialize = (actor = A, selected = limits) => call(request('initialize', { limits: selected }), actor);
  const linked = async name => { const path = join(temp, name); await git(root, ['worktree', 'add', '-b', name, path, base]); admittedRoots.add(path); return path; };
  const registerRequest = (fields = {}) => command({ kind: 'register_external_work', operation_key: key(), input_oid: base, intent: 'fixture work', areas: [{ kind: 'file', path: 'source.ts' }], readers: [], ...fields });
  const get = async (kind, id, actor = A, pageLimit = 8192) => {
    const selector = kind === 'receipt' ? { kind, operation_key: id } : { kind, id };
    let offset = 0, expected_hash = null, content = '';
    do {
      const reply = await call(readRequest(selector, { offset, expected_hash, limit: pageLimit }), actor);
      assert.equal(reply.kind, 'page'); assert.equal(reply.offset, offset);
      content += reply.content; offset = reply.next_offset; expected_hash = reply.hash;
      if (reply.eof) return JSON.parse(content);
    } while (true);
  };
  return { temp, root, state, repositoryId, base, limits, serviceLimits, authority, admittedRoots, sessions, connection, call,
    initialize, linked, commit, registerRequest, get, get service() { return service; }, make,
    async restart() { await service.close(); service = make(); return service; },
    loseAuthority() { owned = false; }, stats() { return { authorizations, registrations }; },
    disk: async () => JSON.parse(await readFile(join(state, 'coordination/control.json'), 'utf8')) };
}
