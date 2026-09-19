import { mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { TaskStore } from "../../src/store/task-store.js";

describe("TaskStore recovery", () => {
  it("quarantines published task directories with missing records", async () => {
    const root = await mkdtemp(join(tmpdir(), "muse-store-test-")); const store = new TaskStore(root); await store.initialize();
    const id = crypto.randomUUID(); await mkdir(store.taskDir(id));
    expect(await store.list()).toEqual([]);
    expect((await readdir(join(root, "tasks"))).some((name) => name.startsWith(`.incomplete-${id}-`))).toBe(true);
  });
  it("ignores unpublished temporary task directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "muse-store-test-")); const store = new TaskStore(root); await store.initialize();
    const path = join(root, "tasks", `.creating-${crypto.randomUUID()}`); await mkdir(path); await writeFile(join(path, "request.json"), "{}");
    expect(await store.list()).toEqual([]);
    expect((await readdir(join(root, "tasks")))).toContain(path.split("/").at(-1));
  });
  it("retrieves only artifacts named by a persisted result", async () => {
    const root = await mkdtemp(join(tmpdir(), "muse-store-test-")); const store = new TaskStore(root); await store.initialize(); const id = crypto.randomUUID();
    await mkdir(join(store.taskDir(id), "artifacts"), { recursive: true }); await writeFile(join(store.taskDir(id), "artifacts", "changes.diff"), "the diff");
    await store.writeResult(id, { schema_version: 1, task_id: id, request_key: "key", execution_status: "completed", worker_stop: "confirmed", worker_assessment: "met", summary: "done", blockers: [], questions: [], model: { requested: "model" }, workspace: { kind: "task_worktree", stale: false }, changed_files: [], checks: [], artifacts: [{ id: "diff", kind: "diff", path: "artifacts/changes.diff", bytes: 8 }], output_truncated: false });
    expect((await store.readArtifact(id, "diff", 0, 100)).toString("utf8")).toBe("the diff"); await expect(store.readArtifact(id, "unknown", 0, 100)).rejects.toThrow(/not found/);
  });
});
