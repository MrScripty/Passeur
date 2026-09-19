import { mkdtemp, readFile } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DelegateRequest, Profile } from "../../src/contracts/index.js";
import { Coordinator } from "../../src/core/coordinator.js";
import type { WorkerAdapter } from "../../src/muse/adapter.js";
import { TaskStore } from "../../src/store/task-store.js";

const profile: Profile = { schema_version: 1, muse_bin: "muse", model: "muse-spark-1.3", review: { disable_write: true, disable_shell: true, sandbox_network: "restricted" }, implementation: { enabled: false, sandbox_network: "proxy-only" }, task_timeout_ms: 60_000, stop_grace_ms: 1_000, subscription: { provenance: "user_confirmed", verified_at: "2026-09-19T00:00:00.000Z" } };
const request: DelegateRequest = { schema_version: 1, request_key: "stable-key", mode: "review", objective: "Review", context: "Context", acceptance_criteria: ["Done"] };
const completed = (summary = "done") => ({ status: "completed" as const, summary, worker_stop: "confirmed" as const, worker_assessment: "met" as const, blockers: [], questions: [], checks: [] });
const exec = promisify(execFile);

describe("Coordinator", () => {
  it("persists before launch and returns the saved result for an identical key", async () => {
    const root = await mkdtemp(join(tmpdir(), "muse-bridge-test-")); const store = new TaskStore(join(root, "state")); let runs = 0;
    const worker: WorkerAdapter = { run: async () => { runs++; expect((await store.list()).length).toBe(1); return { ...completed("review complete"), reported_model: profile.model }; } };
    const coordinator = new Coordinator(root, "project", profile, store, worker);
    const context = { signal: new AbortController().signal, approve: async () => ({ choice_id: "deny" }) };
    const first = await coordinator.delegate(request, context); const second = await coordinator.delegate(request, context);
    expect(first.task_id).toBe(second.task_id); expect(runs).toBe(1);
    expect(JSON.parse(await readFile(join(store.taskDir(first.task_id), "result.json"), "utf8")).execution_status).toBe("completed");
  });
  it("rejects key reuse with a changed assignment", async () => {
    const root = await mkdtemp(join(tmpdir(), "muse-bridge-test-")); const store = new TaskStore(join(root, "state"));
    const worker: WorkerAdapter = { run: async () => completed() };
    const coordinator = new Coordinator(root, "project", profile, store, worker); const context = { signal: new AbortController().signal, approve: async () => ({ choice_id: "deny" }) };
    await coordinator.delegate(request, context);
    await expect(coordinator.delegate({ ...request, objective: "Different" }, context)).rejects.toMatchObject({ code: "REQUEST_KEY_CONFLICT" });
  });
  it("atomically attaches simultaneous identical requests to one worker", async () => {
    const root = await mkdtemp(join(tmpdir(), "muse-bridge-test-")); const store = new TaskStore(join(root, "state")); let runs = 0;
    let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; }); let started!: () => void; const workerStarted = new Promise<void>((resolve) => { started = resolve; });
    const worker: WorkerAdapter = { run: async () => { runs++; started(); await held; return completed(); } };
    const coordinator = new Coordinator(root, "project", profile, store, worker); const context = { signal: new AbortController().signal, approve: async () => ({ choice_id: "deny" }) };
    const first = coordinator.delegate(request, context); const second = coordinator.delegate(request, context);
    await workerStarted;
    expect(runs).toBe(1); expect((await store.list()).length).toBe(1);
    release(); const [a, b] = await Promise.all([first, second]);
    expect(a.task_id).toBe(b.task_id); expect(runs).toBe(1);
  });
  it("rejects a simultaneous different request while one worker is active", async () => {
    const root = await mkdtemp(join(tmpdir(), "muse-bridge-test-")); const store = new TaskStore(join(root, "state"));
    let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
    const worker: WorkerAdapter = { run: async () => { await held; return completed(); } };
    const coordinator = new Coordinator(root, "project", profile, store, worker); const context = { signal: new AbortController().signal, approve: async () => ({ choice_id: "deny" }) };
    const first = coordinator.delegate(request, context);
    await expect(coordinator.delegate({ ...request, request_key: "other-key" }, context)).rejects.toMatchObject({ code: "TASK_ACTIVE" });
    release(); await first;
  });
  it("marks a review stale when HEAD changes during the run", async () => {
    const root = await mkdtemp(join(tmpdir(), "muse-review-test-")); await exec("git", ["init", "-q", root]); await exec("git", ["-C", root, "config", "user.email", "test@example.com"]); await exec("git", ["-C", root, "config", "user.name", "Test"]);
    await writeFile(join(root, "file.txt"), "one\n"); await exec("git", ["-C", root, "add", "."]); await exec("git", ["-C", root, "commit", "-qm", "one"]); const initial = (await exec("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
    const state = await mkdtemp(join(tmpdir(), "muse-state-test-")); const store = new TaskStore(state);
    const worker: WorkerAdapter = { run: async () => { await writeFile(join(root, "file.txt"), "two\n"); await exec("git", ["-C", root, "add", "."]); await exec("git", ["-C", root, "commit", "-qm", "two"]); return completed(); } };
    const coordinator = new Coordinator(root, "project", profile, store, worker); const context = { signal: new AbortController().signal, approve: async () => ({ choice_id: "deny" }) };
    const result = await coordinator.delegate({ ...request, request_key: "revision-drift" }, context);
    expect(result.workspace).toMatchObject({ base_commit: initial, stale: true });
  });
});
