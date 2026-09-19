import { mkdir, open, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
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
    const tasks = join(this.root, "tasks");
    const temporary = join(tasks, `.creating-${record.task_id}-${crypto.randomUUID()}`);
    await mkdir(join(temporary, "artifacts"), { recursive: true, mode: 0o700 });
    await atomicJson(join(temporary, "request.json"), record);
    await atomicJson(join(temporary, "state.json"), state);
    await rename(temporary, this.taskDir(record.task_id));
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
    const entries = await readdir(join(this.root, "tasks"), { withFileTypes: true });
    const records: StoredRequest[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/i.test(entry.name)) continue;
      try {
        const record = JSON.parse(await readFile(join(this.taskDir(entry.name), "request.json"), "utf8")) as StoredRequest;
        await readFile(join(this.taskDir(entry.name), "state.json"), "utf8");
        records.push(record);
      } catch {
        await rename(this.taskDir(entry.name), join(this.root, "tasks", `.incomplete-${entry.name}-${crypto.randomUUID()}`));
      }
    }
    return records.sort((a, b) => b.accepted_at.localeCompare(a.accepted_at));
  }
  async find(key: { task_id?: string; request_key?: string }): Promise<StoredRequest | undefined> {
    if (key.task_id) { try { return JSON.parse(await readFile(join(this.taskDir(key.task_id), "request.json"), "utf8")) as StoredRequest; } catch { return undefined; } }
    return (await this.list()).find((record) => record.request.request_key === key.request_key);
  }
  async readState(taskId: string): Promise<TaskState> { return JSON.parse(await readFile(join(this.taskDir(taskId), "state.json"), "utf8")) as TaskState; }
  async readResult(taskId: string): Promise<DelegateResult | undefined> { try { return JSON.parse(await readFile(join(this.taskDir(taskId), "result.json"), "utf8")) as DelegateResult; } catch { return undefined; } }
  async readSection(taskId: string, section: "result" | "log", offset: number, limit: number): Promise<string> {
    const path = section === "result" ? join(this.taskDir(taskId), "result.json") : join(this.taskDir(taskId), "events.ndjson");
    const data = await readFile(path);
    return data.subarray(offset, offset + limit).toString("utf8");
  }
  async readArtifact(taskId: string, artifactId: string, offset: number, limit: number): Promise<Buffer> {
    const result = await this.readResult(taskId);
    const artifact = result?.artifacts.find((entry) => entry.id === artifactId);
    if (!artifact) throw new Error(`Artifact not found: ${artifactId}`);
    const task = this.taskDir(taskId);
    const path = resolve(task, artifact.path);
    const fromTask = relative(task, path);
    if (fromTask === ".." || fromTask.startsWith(`..${sep}`)) throw new Error("Saved artifact path escapes its task directory");
    const data = await readFile(path);
    return data.subarray(offset, offset + limit);
  }
}
