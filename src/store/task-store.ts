import { mkdir, open, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DelegateRequest, DelegateResult } from "../contracts/index.js";
import type { TaskState } from "../core/state.js";

export type StoredRequest = { task_id: string; project_id: string; canonical_hash: string; accepted_at: string; deadline_at: string; request: DelegateRequest };

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
}

export class TaskStore {
  constructor(readonly root: string) {}
  taskDir(taskId: string): string { return join(this.root, "tasks", taskId); }
  async initialize(): Promise<void> { await mkdir(join(this.root, "tasks"), { recursive: true, mode: 0o700 }); }
  async create(record: StoredRequest, state: TaskState): Promise<void> {
    const dir = this.taskDir(record.task_id);
    await mkdir(join(dir, "artifacts"), { recursive: true, mode: 0o700 });
    await atomicJson(join(dir, "request.json"), record);
    await atomicJson(join(dir, "state.json"), state);
  }
  async writeState(taskId: string, state: TaskState): Promise<void> { await atomicJson(join(this.taskDir(taskId), "state.json"), state); }
  async writeResult(taskId: string, result: DelegateResult): Promise<void> { await atomicJson(join(this.taskDir(taskId), "result.json"), result); }
  async appendEvent(taskId: string, event: unknown): Promise<void> {
    const line = JSON.stringify({ at: new Date().toISOString(), event });
    if (Buffer.byteLength(line) > 262_144) return;
    const path = join(this.taskDir(taskId), "events.ndjson");
    let bytes = 0; try { bytes = (await stat(path)).size; } catch {}
    if (bytes + Buffer.byteLength(line) + 1 > 20 * 1024 * 1024) return;
    await writeFile(path, `${line}\n`, { flag: "a", mode: 0o600 });
  }
  async list(): Promise<StoredRequest[]> {
    await this.initialize();
    const ids = await readdir(join(this.root, "tasks"));
    const records = await Promise.all(ids.map(async (id) => JSON.parse(await readFile(join(this.taskDir(id), "request.json"), "utf8")) as StoredRequest));
    return records.sort((a, b) => b.accepted_at.localeCompare(a.accepted_at));
  }
  async find(key: { task_id?: string; request_key?: string }): Promise<StoredRequest | undefined> {
    if (key.task_id) { try { return JSON.parse(await readFile(join(this.taskDir(key.task_id), "request.json"), "utf8")) as StoredRequest; } catch { return undefined; } }
    return (await this.list()).find((record) => record.request.request_key === key.request_key);
  }
  async readState(taskId: string): Promise<TaskState> { return JSON.parse(await readFile(join(this.taskDir(taskId), "state.json"), "utf8")) as TaskState; }
  async readResult(taskId: string): Promise<DelegateResult | undefined> { try { return JSON.parse(await readFile(join(this.taskDir(taskId), "result.json"), "utf8")) as DelegateResult; } catch { return undefined; } }
  async readSection(taskId: string, section: "result" | "manifest" | "log", offset: number, limit: number): Promise<string> {
    const path = section === "result" ? join(this.taskDir(taskId), "result.json") : section === "manifest" ? join(this.taskDir(taskId), "artifacts", "manifest.json") : join(this.taskDir(taskId), "events.ndjson");
    const data = await readFile(path);
    return data.subarray(offset, offset + limit).toString("utf8");
  }
}
