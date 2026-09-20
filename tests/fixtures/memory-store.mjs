// In-memory substitute for owner-level tests only. It proves no persisted codec, crash or durability claim.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
const clone = (value) => value === undefined ? undefined : structuredClone(value);
export class MemoryStore {
  constructor(root, records = { requests: new Map(), states: new Map(), results: new Map(), resources: new Map(), operations: new Map(), events: new Map(), frozen: undefined }, authority = () => undefined) {
    this.root = root; this.records = records; this.authority = authority;
  }
  scoped(authority) { return new MemoryStore(this.root, this.records, authority); }
  taskDir(id) { return join(this.root, 'tasks', id); }
  async initialize() { this.authority(); await mkdir(join(this.root, 'tasks'), { recursive: true }); }
  async create(record, state) {
    this.authority(); assert.ok(![...this.records.requests.values()].some((r) => r.request.request_key === record.request.request_key));
    await mkdir(join(this.taskDir(record.task_id), 'artifacts'), { recursive: true });
    this.records.requests.set(record.task_id, clone(record)); this.records.states.set(record.task_id, clone(state));
  }
  async find(query) { return clone(query.task_id ? this.records.requests.get(query.task_id) : [...this.records.requests.values()].find((r) => r.request.request_key === query.request_key)); }
  async list() { return clone([...this.records.requests.values()]); }
  async writeState(id, value) { this.authority(); this.records.states.set(id, clone(value)); }
  async readState(id) { return clone(this.records.states.get(id)); }
  async writeResult(id, value) { this.authority(); const old = this.records.results.get(id); if (old) assert.deepEqual(value, old); this.records.results.set(id, clone(value)); }
  async readResult(id) { return clone(this.records.results.get(id)); }
  async writeResource(id, value) { this.authority(); this.records.resources.set(id, clone(value)); }
  async readResource(id) { return clone(this.records.resources.get(id)); }
  async appendEvent(id, event) { this.authority(); const values = this.records.events.get(id) ?? []; values.push(clone(event)); this.records.events.set(id, values); }
  async freeze(reason) { this.authority(); this.records.frozen = reason; }
  async frozenReason() { return this.records.frozen; }
  async quarantineIncomplete() { this.authority(); return []; }
  async importLegacy() { this.authority(); }
  async acknowledgeSafety() { this.authority(); this.records.frozen = undefined; }
}
