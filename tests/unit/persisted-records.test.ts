import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { decodeRequest, decodeResult, decodeResource, decodeState } from "../../src/store/record-codecs.js";
import { TaskStore } from "../../src/store/task-store.js";
const faults = vi.hoisted(() => ({ denied: "" }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, open: (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]) === faults.denied) return Promise.reject(Object.assign(new Error("denied fixture"), { code: "EACCES" }));
    return fs.open(...args);
  } };
});
afterEach(() => { faults.denied = ""; });
const id = randomUUID(), now = new Date().toISOString();
const request = { task_id: id, project_id: "project", canonical_hash: "historical-hash", accepted_at: now, deadline_at: now,
  request: { schema_version: 2 as const, request_key: "request", mode: "review" as const, objective: "Inspect", context: "", acceptance_criteria: ["Report"] } };
const result = { schema_version: 2 as const, task_id: id, request_key: "request", execution_status: "completed" as const,
  worker_stop: "confirmed" as const, worker_assessment: "met" as const, summary: "done", blockers: [], questions: [], model: { requested: "model" },
  workspace: { kind: "source_read_only" as const, stale: false }, delivery: { status: "not_applicable" as const }, changed_files: [], checks: [], artifacts: [], output_truncated: false };
it("fully decodes supported current and historical records", () => {
  expect(decodeRequest(request, id)).toEqual(request);
  const legacy = { ...request, request: { ...request.request, schema_version: 1 } };
  expect(decodeRequest(legacy, id).request.schema_version).toBe(1);
  const { delivery: _delivery, ...fields } = result;
  expect(decodeResult({ ...fields, schema_version: 1 }, id).schema_version).toBe(1);
});
it("rejects malformed nested fields rather than casting partial shapes", () => {
  expect(() => decodeResult({ ...result, checks: [{ command: "test" }] }, id)).toThrowError(expect.objectContaining({ code: "STORE_CORRUPT" }));
  expect(() => decodeResource({ schema_version: 1, task_id: id, project_id: "project", state: "invented", updated_at: now }, id)).toThrowError(expect.objectContaining({ code: "STORE_CORRUPT" }));
  expect(() => decodeState({ phase: "terminal", updated_at: now })).toThrowError(expect.objectContaining({ code: "STORE_CORRUPT" }));
});
it("preserves unsupported versions separately from corrupt data", () => {
  expect(() => decodeResult({ ...result, schema_version: 99 }, id)).toThrowError(expect.objectContaining({ code: "STORE_VERSION_UNSUPPORTED" }));
  expect(() => decodeRequest({ ...request, request: { ...request.request, schema_version: 99 } }, id)).toThrowError(expect.objectContaining({ code: "STORE_VERSION_UNSUPPORTED" }));
});
it("a filesystem-denied request read cannot quarantine or rewrite its actual bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "passeur-records-"));
  const store = new TaskStore(root);
  try {
    await store.create(request, { phase: "queued", updated_at: now });
    const path = join(store.taskDir(id), "request.json"), before = await readFile(path);
    faults.denied = path;
    await expect(store.quarantineIncomplete()).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    faults.denied = "";
    expect(await readFile(path)).toEqual(before); expect(await readdir(join(root, "tasks"))).toContain(id);
  } finally { faults.denied = ""; await rm(root, { recursive: true, force: true }); }
});
it("unsupported optional records block quarantine before any corrupt task is moved", async () => {
  const root = await mkdtemp(join(tmpdir(), "passeur-records-")); const store = new TaskStore(root), corrupt = randomUUID();
  try {
    await store.initialize(); await mkdir(store.taskDir(corrupt));
    await store.create(request, { phase: "queued", updated_at: now });
    await writeFile(join(store.taskDir(id), "result.json"), JSON.stringify({ ...result, schema_version: 99 }));
    await expect(store.quarantineIncomplete()).rejects.toMatchObject({ code: "STORE_VERSION_UNSUPPORTED" });
    expect((await readdir(join(root, "tasks"))).sort()).toEqual([corrupt, id].sort());
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("read-only inspection preserves corrupt records; authorized recovery preserves them in quarantine", async () => {
  const root = await mkdtemp(join(tmpdir(), "passeur-records-")); const store = new TaskStore(root);
  try {
    await store.initialize(); await mkdir(store.taskDir(id)); await writeFile(join(store.taskDir(id), "request.json"), "{bad");
    await expect(store.list()).rejects.toMatchObject({ code: "STORE_CORRUPT" }); expect(await readdir(join(root, "tasks"))).toContain(id);
    const quarantined = await store.quarantineIncomplete(); expect(quarantined).toHaveLength(1);
    expect(await readFile(join(root, "tasks", quarantined[0]!, "request.json"), "utf8")).toBe("{bad"); expect(await store.frozenReason()).toBeTruthy();
  } finally { await rm(root, { recursive: true, force: true }); }
});
