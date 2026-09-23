import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { RepositoryRuntime, resolveRepositoryBinding } from '../../../.passeur-core/src/core/repository-runtime.js';
import { operatorToken } from '../../../.passeur-core/src/service/operator-token.js';
import { serviceFixture, request, command, readRequest, key, hold, git, BridgeError } from './service-fixture.mjs';
export { request, command, readRequest, key, hold, git, BridgeError, operatorToken };

/** Actual runtime/metadata/Git; only task persistence, election and recovery are excluded seams. */
export async function runtimeFixture(t, options = {}) {
  const f = await serviceFixture(t, options);
  await f.service.close();
  const intent = { project: f.root, stateRoot: f.state, profilePath: join(f.temp, 'unavailable-execution-profile.json') };
  const binding = await resolveRepositoryBinding(intent, {}, new AbortController().signal);
  const counts = { acquire: 0, release: 0, recover: 0, initialize: 0, profile: 0, reads: 0 };
  const claims = new Map(), phases = new Map();
  let beforeRecover, beforeList, beforeResource, lost, runtime;
  const leases = [], gates = [];
  const taskStore = {
    root: binding.storeRoot,
    async initialize() { counts.initialize++; await mkdir(binding.storeRoot, { recursive: true, mode: 0o700 }); },
    async list() { if (beforeList) await beforeList(); return [...claims].map(([task_id, claim]) => ({ task_id, project_id: claim?.project_id ?? binding.repositoryId })); },
    async readResource(id) { counts.reads++; if (beforeResource) await beforeResource(id); return structuredClone(claims.get(id)); },
    async readState(id) { assert.ok(phases.has(id), 'only explicitly declared fixture task state is readable'); return { phase: phases.get(id) }; },
    async frozenReason() { return options.frozenReason; },
  };
  const make = () => {
    const r = new RepositoryRuntime(intent, { package_version: 'fixture', build_id: 'fixture', mode: 'development' }, {
      async acquire(_path, signal, compromised) {
        signal.throwIfAborted(); counts.acquire++;
        const lease = { state: 'held', assertOwned() { if (this.state !== 'held') throw new BridgeError('LEASE_NOT_HELD', 'Fixture election authority is unavailable'); },
          async release() { assert.equal(this.state, 'held'); this.state = 'released'; counts.release++; } };
        leases.push(lease);
        lost = () => { lease.state = 'lost'; compromised(new BridgeError('LEASE_LOST', 'Fixture ownership withdrawn')); };
        return lease;
      },
      store(root, _authority) { assert.equal(root, binding.storeRoot); return taskStore; },
      async recover(store) { assert.equal(store, taskStore); counts.recover++; if (beforeRecover) await beforeRecover(); },
      async legacyRoots() { return []; },
      async profile() { counts.profile++; throw new Error('A metadata operation invoked execution-profile loading'); },
    }, {});
    f.sessions.push({ close: async () => { for (const gate of gates) gate.release(); await r.shutdown(); } }); return r;
  };
  runtime = make();
  const ordinary = Object.freeze({ owner_id: 'b'.repeat(64), client_id: randomUUID() });
  let operator;
  const token = async () => {
    const value = await operatorToken(binding, true);
    operator = Object.freeze({ owner_id: createHash('sha256').update(value).digest('hex'), client_id: randomUUID() });
    return value;
  };
  const call = (req, actor = operator ?? ordinary, source = f.root, signal) => runtime.coordinate(req, actor, source, signal);
  const initialize = async () => { if (!operator) await token(); return call(request('initialize', { limits: f.limits }), operator); };
  const register = (fields = {}) => f.registerRequest(fields);
  const get = async (kind, id, actor = operator ?? ordinary) => {
    const selector = kind === 'receipt' ? { kind, operation_key: id } : { kind, id };
    let offset = 0, expected_hash = null, contents = '';
    while (true) {
      const page = await call(readRequest(selector, { offset, expected_hash, limit: 173 }), actor);
      contents += page.content; offset = page.next_offset; expected_hash = page.hash;
      if (page.eof) return JSON.parse(contents);
    }
  };
  return { ...f, intent, binding, counts, claims, phases, leases, taskStore, ordinary, token, call, initialize, register, get,
    get runtime() { return runtime; }, get operator() { return operator; },
    gate() { const gate = hold(); gates.push(gate); return gate; },
    setBeforeRecover(fn) { beforeRecover = fn; }, setBeforeList(fn) { beforeList = fn; }, setBeforeResource(fn) { beforeResource = fn; },
    loseAuthority() { assert.ok(lost); lost(); },
    async restart() { await runtime.shutdown(); runtime = make(); },
    async disk() { return JSON.parse(await readFile(join(binding.storeRoot, 'coordination/control.json'), 'utf8')); },
    managed(path, branch, state = 'pending') {
      const task_id = randomUUID();
      claims.set(task_id, { task_id, project_id: binding.repositoryId, state, worktree_path: path, branch_ref: branch });
      phases.set(task_id, 'terminal'); return task_id;
    },
  };
}
