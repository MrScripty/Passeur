import { mkdir, open, readFile, readdir, realpath, rename, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { FinalizeReceipt, HistoricalRequest, ResourceRecord, StoredResult } from "../contracts/types.js";
import { KeyedMutex, stableHash } from "../core/async.js";
import { BridgeError, filesystemFailure, nativeCode } from "../core/errors.js";
import type { DurableRequest, TaskControl } from "../contracts/tasks.js";
import { TaskControlSchema } from "../contracts/tasks.js";
import type { TaskState } from "../core/state.js";
import { decodeRequest, decodeState, decodeResult, decodeResource, decodeReceipt, decodeSafety, assertResultAdmission } from "./record-codecs.js";

export type LegacyStoredRequest = {
  task_id: string; project_id: string; canonical_hash: string;
  accepted_at: string; deadline_at: string; request: HistoricalRequest;
  execution?: import("../contracts/agents.js").ExecutionSnapshot;
};
export type StoredRequest = LegacyStoredRequest | DurableRequest;
export type MutationAuthority = () => void;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A bounded read rejects oversized authoritative records without labeling or quarantining them as corrupt.
const MAX_RECORD_BYTES = 8 * 1024 * 1024;
const absent = (error: unknown) => nativeCode(error) === "ENOENT";

export async function atomicJson(path: string, value: unknown, authority?: MutationAuthority): Promise<void> {
  authority?.();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  authority?.();
  const handle = await open(temporary, "wx", 0o600);
  try { authority?.(); await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  authority?.();
  await rename(temporary, path);
  const directory = await open(dirname(path), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

/** Low-level persistence. Production mutation callers supply their current lease authority. */
export class TaskStore {
  #writes = new KeyedMutex();
  constructor(readonly root: string, private readonly authority?: MutationAuthority) {}
  taskDir(taskId: string): string {
    if (!uuid.test(taskId)) throw new BridgeError("INVALID_TASK_ID", "Expected a UUID task ID");
    return join(this.root, "tasks", taskId);
  }
  async #json(path: string): Promise<unknown | undefined> {
    let handle;
    try { handle = await open(path, "r"); }
    catch (error) { if (absent(error)) return undefined; throw filesystemFailure(error, "store.open", path); }
    let contents: Buffer;
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) throw new BridgeError("STORE_CORRUPT", "A persisted record is not a regular file", { stage: "store.read", path });
      if (metadata.size > MAX_RECORD_BYTES) throw new BridgeError("STORE_RECORD_TOO_LARGE", "Persisted record exceeds the supported read budget", { stage: "store.read", path });
      // Read through this handle and retain a hard bound even if a noncooperating writer grows it.
      const buffer = Buffer.alloc(Math.min(MAX_RECORD_BYTES + 1, metadata.size + 1));
      let length = 0;
      while (length < buffer.length) {
        const chunk = await handle.read(buffer, length, buffer.length - length, length);
        if (!chunk.bytesRead) break;
        length += chunk.bytesRead;
      }
      if (length > MAX_RECORD_BYTES || length > metadata.size) throw new BridgeError("STORE_CHANGED_DURING_READ", "Persisted record changed while being read", { stage: "store.read", path });
      contents = buffer.subarray(0, length);
    } catch (error) { throw filesystemFailure(error, "store.read", path); }
    finally { await handle.close(); }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(contents)); }
    catch (cause) { throw new BridgeError("STORE_CORRUPT", "Persisted record contains malformed JSON", { cause, stage: "store.decode", path }); }
  }
  async #required(path: string): Promise<unknown> {
    const value = await this.#json(path);
    if (value === undefined) throw new BridgeError("STORE_INCOMPLETE", "A required persisted record is missing", { stage: "store.read", path });
    return value;
  }
  async #directories(root: string): Promise<import("node:fs").Dirent[]> {
    try { return await readdir(root, { withFileTypes: true }); }
    catch (error) { if (absent(error)) return []; throw filesystemFailure(error, "store.list", root); }
  }
  async #write(path: string, value: unknown): Promise<void> {
    try { await atomicJson(path, value, this.authority); }
    catch (error) { throw filesystemFailure(error, "store.publish", path); }
  }
  async initialize(): Promise<void> {
    this.authority?.();
    try { await mkdir(join(this.root, "tasks"), { recursive: true, mode: 0o700 }); }
    catch (error) { throw filesystemFailure(error, "store.initialize", this.root); }
  }
  async create(record: StoredRequest, state: TaskState): Promise<void> {
    decodeRequest(record, record.task_id); decodeState(state);
    if (("schema_version" in record) !== ("schema_version" in state)) throw new BridgeError("STORE_CORRUPT", "Admission and control versions disagree");
    if ("schema_version" in state && (state.task_id !== record.task_id || !("initial_owner" in record) || state.owner_id !== record.initial_owner)) throw new BridgeError("STORE_CORRUPT", "Initial control identity differs from admission");
    await this.initialize();
    const temporary = join(this.root, "tasks", `.creating-${record.task_id}-${randomUUID()}`);
    this.authority?.();
    await mkdir(join(temporary, "artifacts"), { recursive: true, mode: 0o700 });
    await this.#write(join(temporary, "request.json"), record);
    await this.#write(join(temporary, "state.json"), state);
    this.authority?.();
    await rename(temporary, this.taskDir(record.task_id));
    const directory = await open(join(this.root, "tasks"), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }
  async durableRequest(id: string): Promise<DurableRequest> {
    const record = await this.find({ task_id: id });
    if (!record || !("schema_version" in record) || record.schema_version !== 4) throw new BridgeError("TASK_API_UPGRADE_REQUIRED", "Use historical result access for this record");
    return record;
  }
  async readControl(id: string): Promise<TaskControl> {
    const state = await this.readState(id);
    if (!("schema_version" in state) || state.schema_version !== 2) throw new BridgeError("TASK_API_UPGRADE_REQUIRED", "Historical state has no durable task control");
    return state;
  }
  async writeControl(id: string, state: TaskControl): Promise<void> {
    await this.writeState(id, state);
  }
  async writeState(id: string, state: TaskState): Promise<void> {
    const validated = decodeState(state);
    await this.#assertStateAdmission(id, validated);
    await this.#writes.run(id, () => this.#write(join(this.taskDir(id), "state.json"), validated));
  }
  async writeResult(id: string, result: StoredResult): Promise<void> {
    decodeResult(result, id);
    const admission = decodeRequest(await this.#required(join(this.taskDir(id), "request.json")), id);
    assertResultAdmission(result, admission);
    if (result.schema_version === 4) {
      const control = await this.readControl(id);
      if (result.native_evidence.run_id !== control.native.run_id || control.settled_outcome && result.execution_status !== control.settled_outcome) throw new BridgeError("STORE_CORRUPT", "Result contradicts its native run or accepted settlement");
    }
    await this.#writes.run(id, async () => {
      const existing = await this.readResult(id);
      if (existing) {
        if (stableHash(existing) !== stableHash(result)) throw new BridgeError("RESULT_IMMUTABLE", `Terminal result ${id} cannot be overwritten`);
        return;
      }
      await this.#write(join(this.taskDir(id), "result.json"), result);
    });
  }
  async writeResource(id: string, resource: ResourceRecord): Promise<void> {
    decodeResource(resource, id);
    await this.#writes.run(id, () => this.#write(join(this.taskDir(id), "resource.json"), resource));
  }
  async readResource(id: string): Promise<ResourceRecord | undefined> {
    const value = await this.#json(join(this.taskDir(id), "resource.json"));
    return value === undefined ? undefined : decodeResource(value, id);
  }
  async writeOperation(id: string, receipt: FinalizeReceipt): Promise<void> {
    decodeReceipt(receipt, id, receipt.operation.operation_key);
    await this.#writes.run(id, () => this.#write(join(this.taskDir(id), "operations", `${stableHash(receipt.operation.operation_key)}.json`), receipt));
  }
  async readOperation(id: string, key: string): Promise<FinalizeReceipt | undefined> {
    const value = await this.#json(join(this.taskDir(id), "operations", `${stableHash(key)}.json`));
    return value === undefined ? undefined : decodeReceipt(value, id, key);
  }
  async appendEvent(id: string, event: unknown): Promise<boolean> {
    return this.#writes.run(id, async () => {
      const line = `${JSON.stringify({ at: new Date().toISOString(), event })}\n`;
      if (Buffer.byteLength(line) > 262_144) return false;
      const path = join(this.taskDir(id), "events.ndjson");
      let bytes = 0;
      try { bytes = (await stat(path)).size; } catch (error) { if (!absent(error)) throw filesystemFailure(error, "store.log.stat", path); }
      if (bytes + Buffer.byteLength(line) > 20 * 1024 * 1024) return false;
      this.authority?.();
      const handle = await open(path, "a", 0o600);
      try { this.authority?.(); await handle.writeFile(line); } finally { await handle.close(); }
      return true;
    });
  }
  async list(): Promise<StoredRequest[]> {
    const records: StoredRequest[] = [];
    for (const entry of await this.#directories(join(this.root, "tasks"))) {
      if (!entry.isDirectory() || !uuid.test(entry.name)) continue;
      records.push(decodeRequest(await this.#required(join(this.taskDir(entry.name), "request.json")), entry.name));
      await this.readState(entry.name);
    }
    return records.sort((a, b) => b.accepted_at.localeCompare(a.accepted_at));
  }
  async find(key: { task_id?: string; request_key?: string }): Promise<StoredRequest | undefined> {
    if (!key.task_id) return (await this.list()).find((record) => record.request.request_key === key.request_key);
    const path = this.taskDir(key.task_id);
    const value = await this.#json(join(path, "request.json"));
    if (value !== undefined) return decodeRequest(value, key.task_id);
    try { await stat(path); }
    catch (error) { if (absent(error)) return undefined; throw filesystemFailure(error, "store.task.stat", path); }
    throw new BridgeError("STORE_INCOMPLETE", "Existing task has no request record", { stage: "store.request", path });
  }
  async #assertStateAdmission(id: string, state: TaskState): Promise<void> {
    const admission = decodeRequest(await this.#required(join(this.taskDir(id), "request.json")), id);
    if (("schema_version" in admission) !== ("schema_version" in state) || "schema_version" in state && state.task_id !== id) {
      throw new BridgeError("STORE_CORRUPT", "Task control version or identity differs from its admission");
    }
  }
  async readState(id: string): Promise<TaskState> {
    const state = decodeState(await this.#required(join(this.taskDir(id), "state.json")));
    await this.#assertStateAdmission(id, state);
    return state;
  }
  async readResult(id: string): Promise<StoredResult | undefined> {
    const value = await this.#json(join(this.taskDir(id), "result.json"));
    if (value === undefined) return undefined;
    const result = decodeResult(value, id);
    const admission = decodeRequest(await this.#required(join(this.taskDir(id), "request.json")), id);
    assertResultAdmission(result, admission);
    if (result.schema_version === 4) {
      const control = await this.readControl(id);
      if (result.native_evidence.run_id !== control.native.run_id || control.settled_outcome && result.execution_status !== control.settled_outcome) throw new BridgeError("STORE_CORRUPT", "Reopened result contradicts its admitted run or settlement");
    }
    return result;
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
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`) || resolve(task, rel) !== path) throw new BridgeError("INVALID_ARTIFACT", "Artifact escapes task directory");
    return this.#readBounded(path, offset, limit);
  }
  async #readBounded(path: string, offset: number, limit: number): Promise<Buffer> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 24_576) throw new BridgeError("INVALID_RANGE", "Invalid artifact range");
    let handle;
    try { handle = await open(path, "r"); }
    catch (error) { throw filesystemFailure(error, "store.artifact.open", path); }
    try {
      if (!(await handle.stat()).isFile()) throw new BridgeError("INVALID_ARTIFACT", "Artifact is not a regular file");
      const buffer = Buffer.alloc(limit);
      const read = await handle.read(buffer, 0, limit, offset);
      return buffer.subarray(0, read.bytesRead);
    } finally { await handle.close(); }
  }
  async freeze(reason: string): Promise<void> {
    const value = decodeSafety({ reason, at: new Date().toISOString() });
    await this.#writes.run("repository-safety", () => this.#write(join(this.root, "safety.json"), value));
  }
  async frozenReason(): Promise<string | undefined> {
    const value = await this.#json(join(this.root, "safety.json"));
    return value === undefined ? undefined : decodeSafety(value).reason;
  }
  async #checkOperations(id: string): Promise<void> {
    const directory = join(this.taskDir(id), "operations");
    for (const entry of await this.#directories(directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
      const value = await this.#required(join(directory, entry.name));
      const receipt = decodeReceipt(value, id);
      if (`${stableHash(receipt.operation.operation_key)}.json` !== entry.name) throw new BridgeError("STORE_CORRUPT", "Disposition filename does not match its operation identity");
    }
  }
  /** Preserve proven corrupt/incomplete records. Operational failures never authorize quarantine. */
  async quarantineIncomplete(): Promise<string[]> {
    await this.initialize();
    const quarantined: string[] = [], candidates: string[] = [];
    for (const entry of await this.#directories(join(this.root, "tasks"))) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".incomplete-")) { quarantined.push(entry.name); continue; }
      if (!uuid.test(entry.name)) continue;
      let corrupt = false;
      const checks = [
        async () => { if (!await this.find({ task_id: entry.name })) throw new BridgeError("STORE_INCOMPLETE", "Task disappeared before recovery"); },
        () => this.readState(entry.name), () => this.readResult(entry.name), () => this.readResource(entry.name),
        () => this.#checkOperations(entry.name),
      ];
      for (const check of checks) {
        this.authority?.();
        try { await check(); }
        catch (error) {
          if (!(error instanceof BridgeError) || !["STORE_CORRUPT", "STORE_INCOMPLETE"].includes(error.code)) throw error;
          corrupt = true;
        }
      }
      if (corrupt) candidates.push(entry.name);
    }
    for (const id of candidates) {
      const name = `.incomplete-${id}-${randomUUID()}`;
      this.authority?.();
      try { await rename(this.taskDir(id), join(this.root, "tasks", name)); }
      catch (error) { throw filesystemFailure(error, "store.quarantine", this.taskDir(id)); }
      quarantined.push(name);
    }
    if (quarantined.length) await this.freeze(`Quarantined task records require reconciliation: ${quarantined.join(", ")}`);
    return quarantined;
  }
  /** Existing path-keyed migration; no alternate state namespace or inference replay is introduced. */
  async importLegacy(source: string): Promise<void> {
    if (resolve(source) === resolve(this.root)) return;
    const entries = await this.#directories(join(source, "tasks"));
    const selected = entries.filter((entry) => entry.isDirectory() && (uuid.test(entry.name) || entry.name.startsWith(".incomplete-")));
    if (!selected.length) return;
    // A foreign/unsupported record must fail before any record in this import is moved.
    const historical = new TaskStore(source, this.authority);
    for (const entry of selected) {
      this.authority?.();
      if (!uuid.test(entry.name)) continue;
      const from = join(source, "tasks", entry.name);
      decodeRequest(await this.#required(join(from, "request.json")), entry.name);
      decodeState(await this.#required(join(from, "state.json")));
      const result = await this.#json(join(from, "result.json"));
      if (result !== undefined) decodeResult(result, entry.name);
      const resource = await this.#json(join(from, "resource.json"));
      if (resource !== undefined) decodeResource(resource, entry.name);
      await historical.#checkOperations(entry.name);
      try { await stat(this.taskDir(entry.name)); }
      catch (error) { if (absent(error)) continue; throw filesystemFailure(error, "store.import.destination", this.taskDir(entry.name)); }
      throw new BridgeError("LEGACY_IMPORT_CONFLICT", `Task ${entry.name} already exists in the common repository store`);
    }
    await this.initialize();
    for (const entry of selected) {
      const quarantine = entry.name.startsWith(".incomplete-");
      const name = quarantine ? `${entry.name}-import-${randomUUID()}` : entry.name;
      this.authority?.();
      try { await rename(join(source, "tasks", entry.name), join(this.root, "tasks", name)); }
      catch (error) { throw filesystemFailure(error, "store.import.move", join(source, "tasks", entry.name)); }
      if (quarantine) await this.freeze(`Historical quarantine ${name} requires reconciliation`);
    }
  }
  /** Operator acknowledgment is separate from immutable worker-stop evidence. */
  async acknowledgeSafety(): Promise<void> {
    this.authority?.();
    await unlink(join(this.root, "safety.json")).catch((error) => { if (!absent(error)) throw filesystemFailure(error, "store.safety.clear", this.root); });
  }
}
