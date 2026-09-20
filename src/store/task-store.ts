import { mkdir, open, readFile, readdir, realpath, rename, stat, unlink } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { FinalizeReceipt, HistoricalRequest, ResourceRecord, StoredResult } from "../contracts/types.js";
import { KeyedMutex, stableHash } from "../core/async.js";
import { BridgeError } from "../core/errors.js";
import { validPhase, type TaskState } from "../core/state.js";

export type StoredRequest = {
  task_id: string; project_id: string; canonical_hash: string;
  accepted_at: string; deadline_at: string; request: HistoricalRequest;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const absent = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
export async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally { await handle.close(); }
  await rename(temporary, path);
  const directory = await open(dirname(path), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}
async function json(path: string): Promise<unknown> { return JSON.parse(await readFile(path, "utf8")); }
function object(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function checkRequest(value: unknown, id: string): StoredRequest {
  if (!object(value) || value.task_id !== id || typeof value.project_id !== "string" || typeof value.accepted_at !== "string" || typeof value.deadline_at !== "string" || typeof value.canonical_hash !== "string" || !object(value.request) || ![1, 2].includes(Number(value.request.schema_version)) || typeof value.request.request_key !== "string") {
    throw new BridgeError("STORE_CORRUPT", `Invalid request record for ${id}`);
  }
  return value as StoredRequest;
}

/** Reads do not mutate records. Recovery and migration require the repository-owner lease. */
export class TaskStore {
  #writes = new KeyedMutex();
  constructor(readonly root: string) {}
  taskDir(taskId: string): string {
    if (!uuid.test(taskId)) throw new BridgeError("INVALID_TASK_ID", "Expected a UUID task ID");
    return join(this.root, "tasks", taskId);
  }
  async initialize(): Promise<void> { await mkdir(join(this.root, "tasks"), { recursive: true, mode: 0o700 }); }
  async create(record: StoredRequest, state: TaskState): Promise<void> {
    await this.initialize();
    const temporary = join(this.root, "tasks", `.creating-${record.task_id}-${randomUUID()}`);
    await mkdir(join(temporary, "artifacts"), { recursive: true, mode: 0o700 });
    await atomicJson(join(temporary, "request.json"), record);
    await atomicJson(join(temporary, "state.json"), state);
    await rename(temporary, this.taskDir(record.task_id));
    const directory = await open(join(this.root, "tasks"), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }
  async writeState(id: string, state: TaskState): Promise<void> {
    await this.#writes.run(id, () => atomicJson(join(this.taskDir(id), "state.json"), state));
  }
  async writeResult(id: string, result: StoredResult): Promise<void> {
    await this.#writes.run(id, async () => {
      const existing = await this.readResult(id);
      if (existing) {
        if (stableHash(existing) !== stableHash(result)) throw new BridgeError("RESULT_IMMUTABLE", `Terminal result ${id} cannot be overwritten`);
        return;
      }
      await atomicJson(join(this.taskDir(id), "result.json"), result);
    });
  }
  async writeResource(id: string, resource: ResourceRecord): Promise<void> {
    await this.#writes.run(id, () => atomicJson(join(this.taskDir(id), "resource.json"), resource));
  }
  async readResource(id: string): Promise<ResourceRecord | undefined> {
    try {
      const value = await json(join(this.taskDir(id), "resource.json"));
      if (!object(value) || value.schema_version !== 1 || value.task_id !== id || typeof value.project_id !== "string" || typeof value.state !== "string") throw new BridgeError("STORE_CORRUPT", `Invalid resource record ${id}`);
      return value as ResourceRecord;
    } catch (error) { if (absent(error)) return undefined; throw error; }
  }
  async writeOperation(id: string, receipt: FinalizeReceipt): Promise<void> {
    await this.#writes.run(id, () => atomicJson(join(this.taskDir(id), "operations", `${stableHash(receipt.operation.operation_key)}.json`), receipt));
  }
  async readOperation(id: string, key: string): Promise<FinalizeReceipt | undefined> {
    try {
      const value = await json(join(this.taskDir(id), "operations", `${stableHash(key)}.json`));
      if (!object(value) || !object(value.operation) || value.operation.operation_key !== key || typeof value.request_hash !== "string") throw new BridgeError("STORE_CORRUPT", "Invalid disposition receipt");
      return value as FinalizeReceipt;
    } catch (error) { if (absent(error)) return undefined; throw error; }
  }
  async appendEvent(id: string, event: unknown): Promise<void> {
    await this.#writes.run(id, async () => {
      const line = `${JSON.stringify({ at: new Date().toISOString(), event })}\n`;
      if (Buffer.byteLength(line) > 262_144) return;
      const path = join(this.taskDir(id), "events.ndjson");
      let bytes = 0;
      try { bytes = (await stat(path)).size; } catch (error) { if (!absent(error)) throw error; }
      if (bytes + Buffer.byteLength(line) > 20 * 1024 * 1024) return;
      const handle = await open(path, "a", 0o600);
      try { await handle.writeFile(line); } finally { await handle.close(); }
    });
  }
  async list(): Promise<StoredRequest[]> {
    let entries;
    try { entries = await readdir(join(this.root, "tasks"), { withFileTypes: true }); }
    catch (error) { if (absent(error)) return []; throw error; }
    const records: StoredRequest[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !uuid.test(entry.name)) continue;
      records.push(checkRequest(await json(join(this.taskDir(entry.name), "request.json")), entry.name));
      await this.readState(entry.name);
    }
    return records.sort((a, b) => b.accepted_at.localeCompare(a.accepted_at));
  }
  async find(key: { task_id?: string; request_key?: string }): Promise<StoredRequest | undefined> {
    if (!key.task_id) return (await this.list()).find((record) => record.request.request_key === key.request_key);
    try { return checkRequest(await json(join(this.taskDir(key.task_id), "request.json")), key.task_id); }
    catch (error) { if (absent(error)) return undefined; throw error; }
  }
  async readState(id: string): Promise<TaskState> {
    const value = await json(join(this.taskDir(id), "state.json"));
    if (!object(value) || !validPhase(value.phase) || typeof value.updated_at !== "string") throw new BridgeError("STORE_CORRUPT", `Invalid state ${id}`);
    return value as TaskState;
  }
  async readResult(id: string): Promise<StoredResult | undefined> {
    try {
      const value = await json(join(this.taskDir(id), "result.json"));
      if (!object(value) || ![1, 2].includes(Number(value.schema_version)) || value.task_id !== id || typeof value.request_key !== "string" || !["completed", "blocked", "failed", "cancelled", "timed_out", "interrupted"].includes(String(value.execution_status)) || !["confirmed", "unconfirmed", "not_started"].includes(String(value.worker_stop)) || !Array.isArray(value.artifacts)) throw new BridgeError("STORE_CORRUPT", `Invalid result ${id}`);
      if (value.schema_version === 2 && !object(value.delivery)) throw new BridgeError("STORE_CORRUPT", `Missing delivery ${id}`);
      return value as StoredResult;
    } catch (error) { if (absent(error)) return undefined; throw error; }
  }
  async readSlice(id: string, section: "result" | "log", offset: number, limit: number): Promise<Buffer> {
    return this.#readBounded(join(this.taskDir(id), section === "result" ? "result.json" : "events.ndjson"), offset, limit);
  }
  async readSection(id: string, section: "result" | "log", offset: number, limit: number): Promise<string> {
    return (await this.readSlice(id, section, offset, limit)).toString("utf8");
  }
  async readArtifact(id: string, artifactId: string, offset: number, limit: number): Promise<Buffer> {
    const artifact = (await this.readResult(id))?.artifacts.find((entry) => entry.id === artifactId);
    if (!artifact) throw new BridgeError("ARTIFACT_NOT_FOUND", `Artifact not found: ${artifactId}`);
    const task = await realpath(this.taskDir(id));
    const path = await realpath(resolve(task, artifact.path));
    const rel = relative(task, path);
    if (rel === ".." || rel.startsWith(`..${sep}`)) throw new BridgeError("INVALID_ARTIFACT", "Artifact escapes task directory");
    return this.#readBounded(path, offset, limit);
  }
  async #readBounded(path: string, offset: number, limit: number): Promise<Buffer> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 24_576) throw new BridgeError("INVALID_RANGE", "Invalid artifact range");
    const handle = await open(path, "r");
    try {
      if (!(await handle.stat()).isFile()) throw new BridgeError("INVALID_ARTIFACT", "Artifact is not a regular file");
      const buffer = Buffer.alloc(limit);
      const read = await handle.read(buffer, 0, limit, offset);
      return buffer.subarray(0, read.bytesRead);
    } finally { await handle.close(); }
  }
  async freeze(reason: string): Promise<void> {
    await this.#writes.run("repository-safety", () => atomicJson(join(this.root, "safety.json"), { reason, at: new Date().toISOString() }));
  }
  async frozenReason(): Promise<string | undefined> {
    try {
      const value = await json(join(this.root, "safety.json"));
      return object(value) && typeof value.reason === "string" ? value.reason : "Invalid repository safety record";
    } catch (error) { if (absent(error)) return undefined; throw error; }
  }
  /** Call only under the repository lease, before workers can start. */
  async quarantineIncomplete(): Promise<string[]> {
    await this.initialize();
    const quarantined: string[] = [];
    for (const entry of await readdir(join(this.root, "tasks"), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".incomplete-")) { quarantined.push(entry.name); continue; }
      if (!uuid.test(entry.name)) continue;
      try { await this.find({ task_id: entry.name }).then((record) => { if (!record) throw new Error("Missing request"); }); await this.readState(entry.name); }
      catch {
        const name = `.incomplete-${entry.name}-${randomUUID()}`;
        await rename(this.taskDir(entry.name), join(this.root, "tasks", name));
        quarantined.push(name);
      }
    }
    if (quarantined.length) await this.freeze(`Quarantined task records require reconciliation: ${quarantined.join(", ")}`);
    return quarantined;
  }
  /** Move old path-keyed records under the common-repository owner, preserving bytes and keys. */
  async importLegacy(source: string): Promise<void> {
    if (resolve(source) === resolve(this.root)) return;
    let entries;
    try { entries = await readdir(join(source, "tasks"), { withFileTypes: true }); }
    catch (error) { if (absent(error)) return; throw error; }
    await this.initialize();
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".incomplete-")) {
        const imported = `${entry.name}-import-${randomUUID()}`;
        await rename(join(source, "tasks", entry.name), join(this.root, "tasks", imported));
        await this.freeze(`Historical quarantine ${imported} requires reconciliation`);
        continue;
      }
      if (!uuid.test(entry.name)) continue;
      const from = join(source, "tasks", entry.name);
      const to = this.taskDir(entry.name);
      try {
        await stat(to);
        throw new BridgeError("LEGACY_IMPORT_CONFLICT", `Task ${entry.name} already exists in the common repository store`);
      } catch (error) { if (!absent(error)) throw error; }
      await rename(from, to);
    }
  }
  /** Explicit operator acknowledgement; callers must first reconcile processes/resources. */
  async acknowledgeSafety(): Promise<void> { await unlink(join(this.root, "safety.json")).catch((error) => { if (!absent(error)) throw error; }); }
}
