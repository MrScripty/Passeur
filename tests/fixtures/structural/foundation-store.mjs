import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Test-only in-memory store. It does not claim TaskStore codec or crash-durability conformance. */
export class FoundationStore {
  requests = new Map();
  controls = new Map();
  resources = new Map();
  results = new Map();
  events = [];
  reason;
  constructor(root) { this.root = root; }
  taskDir(id) { return join(this.root, id); }
  async create(request, control) {
    if (this.requests.has(request.task_id)) throw new Error('Duplicate fixture task');
    await mkdir(this.taskDir(request.task_id), { recursive: true });
    this.requests.set(request.task_id, structuredClone(request));
    this.controls.set(request.task_id, structuredClone(control));
  }
  async find(key) {
    const request = key.task_id ? this.requests.get(key.task_id)
      : [...this.requests.values()].find(r => r.request.request_key === key.request_key);
    return structuredClone(request);
  }
  async list() { return structuredClone([...this.requests.values()]); }
  async durableRequest(id) {
    const record = this.requests.get(id);
    if (!record) throw new Error('Missing fixture admission');
    return structuredClone(record);
  }
  async readControl(id) {
    const record = this.controls.get(id);
    if (!record) throw new Error('Missing fixture control');
    return structuredClone(record);
  }
  async readState(id) { return this.readControl(id); }
  async writeControl(id, state) { this.controls.set(id, structuredClone(state)); }
  async writeState(id, state) { return this.writeControl(id, state); }
  async readResource(id) { return structuredClone(this.resources.get(id)); }
  async writeResource(id, value) { this.resources.set(id, structuredClone(value)); }
  async readResult(id) { return structuredClone(this.results.get(id)); }
  async writeResult(id, value) {
    const old = this.results.get(id);
    if (old && JSON.stringify(old) !== JSON.stringify(value)) throw new Error('Fixture result is immutable');
    this.results.set(id, structuredClone(value));
  }
  async appendEvent(id, event) { this.events.push({ id, event: structuredClone(event) }); return true; }
  async frozenReason() { return this.reason; }
  async freeze(reason) { this.reason ??= reason; }
  async readOperation() { return undefined; }
}

export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
