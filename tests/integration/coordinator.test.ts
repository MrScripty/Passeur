import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DelegateRequest, Profile } from "../../src/contracts/index.js";
import { Coordinator } from "../../src/core/coordinator.js";
import type { WorkerAdapter } from "../../src/muse/adapter.js";
import { TaskStore } from "../../src/store/task-store.js";

const profile: Profile = { schema_version: 1, muse_bin: "muse", model: "muse-spark-1.3", review: { disable_write: true, disable_shell: true, sandbox_network: "restricted" }, implementation: { enabled: false, sandbox_network: "proxy-only" }, task_timeout_ms: 60_000, stop_grace_ms: 1_000, subscription: { provenance: "user_confirmed", verified_at: "2026-09-19T00:00:00.000Z" } };
const request: DelegateRequest = { schema_version: 1, request_key: "stable-key", mode: "review", objective: "Review", context: "Context", acceptance_criteria: ["Done"] };

describe("Coordinator", () => {
  it("persists before launch and returns the saved result for an identical key", async () => {
    const root = await mkdtemp(join(tmpdir(), "muse-bridge-test-")); const store = new TaskStore(join(root, "state")); let runs = 0;
    const worker: WorkerAdapter = { run: async () => { runs++; expect((await store.list()).length).toBe(1); return { status: "completed", summary: "review complete", reported_model: profile.model, worker_stop: "confirmed" }; } };
    const coordinator = new Coordinator(root, "project", profile, store, worker);
    const context = { signal: new AbortController().signal, approve: async () => ({ choice_id: "deny" }) };
    const first = await coordinator.delegate(request, context); const second = await coordinator.delegate(request, context);
    expect(first.task_id).toBe(second.task_id); expect(runs).toBe(1);
    expect(JSON.parse(await readFile(join(store.taskDir(first.task_id), "result.json"), "utf8")).execution_status).toBe("completed");
  });
  it("rejects key reuse with a changed assignment", async () => {
    const root = await mkdtemp(join(tmpdir(), "muse-bridge-test-")); const store = new TaskStore(join(root, "state"));
    const worker: WorkerAdapter = { run: async () => ({ status: "completed", summary: "done", worker_stop: "confirmed" }) };
    const coordinator = new Coordinator(root, "project", profile, store, worker); const context = { signal: new AbortController().signal, approve: async () => ({ choice_id: "deny" }) };
    await coordinator.delegate(request, context);
    await expect(coordinator.delegate({ ...request, objective: "Different" }, context)).rejects.toMatchObject({ code: "REQUEST_KEY_CONFLICT" });
  });
});
