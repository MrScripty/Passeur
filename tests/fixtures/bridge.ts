import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Assignment } from "../../src/contracts/agents.js";
import type { SharedProfile, LifecyclePolicy, DurableRequest } from "../../src/contracts/tasks.js";
import { initialControl, type ClientActor } from "../../src/core/task-control.js";
import { randomUUID } from "node:crypto";
import { AgentRegistry } from "../../src/agents/registry.js";
import { canonicalHash } from "../../src/core/async.js";
import type { StoredRequest } from "../../src/store/task-store.js";
import { Coordinator } from "../../src/core/coordinator.js";
import { TaskStore } from "../../src/store/task-store.js";
import type { WorkerAdapter, WorkerRun, AdapterDefinition } from "../../src/agents/types.js";
const exec = promisify(execFile);
export const completed = (summary = "done"): WorkerRun => ({ status: "completed", summary, worker_stop: "confirmed", worker_assessment: "met", blockers: [], questions: [], checks: [] });
export const context = () => ({ signal: new AbortController().signal, approve: async () => ({ choice_id: "deny" }) });
export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export async function fixture() {
  const temporary = await mkdtemp(join(tmpdir(), "passeur-sdk-tests-"));
  const root = join(temporary, "repo"), state = join(temporary, "state"), worktrees = join(temporary, "worktrees");
  await mkdir(root); await mkdir(state); await mkdir(worktrees);
  const git = async (...args: string[]) => (await exec("git", ["-C", root, ...args], { timeout: 10_000 })).stdout;
  await git("init", "-q", "-b", "main");
  // Isolated fixture identity only. Product code never changes Git signing or identity policy.
  await git("config", "user.name", "Fixture"); await git("config", "user.email", "fixture@example.invalid");
  await git("config", "commit.gpgsign", "false");
  await writeFile(join(root, "tracked.txt"), "before\n"); await git("add", "tracked.txt"); await git("commit", "-qm", "test: seed fixture");
  const base = (await git("rev-parse", "HEAD")).trim();
  const policy: LifecyclePolicy = { implementation: { enabled: true, worktree_root: worktrees },
    stop_grace_ms: 1_000, max_workers: 2, max_queued_tasks: 8, max_clients: 32, max_waiters: 128, max_pending_inputs: 16, max_control_receipts: 512 };
  const profile: SharedProfile = { schema_version: 3, execution: policy,
    agents: [{ agent_id: "muse", adapter_id: "muse", description: "Controlled worker fixture", enabled: true, options: {} }] };
  const definitions = (worker: WorkerAdapter): Record<string, AdapterDefinition> => ({ muse: { configure: () => ({ worker: observedWorker(worker), modes: ["review", "implement"],
    contract: "fixture/1", requested_model: "model", configuration: { model: "model" } }) } });
  const registry = (worker: WorkerAdapter) => new AgentRegistry(profile, definitions(worker));
  const store = new TaskStore(state); await store.initialize();
  const request = (key: string, mode: Assignment["mode"] = "review"): Assignment => ({ schema_version: 3, agent_id: "muse", request_key: key, mode, objective: "Perform the bounded assignment", context: "Independent task", acceptance_criteria: ["Report scoped outcome"], ...(mode === "implement" ? { base_commit: base, target_ref: "refs/heads/main" } : {}) });
  const snapshot = (assignment: Assignment) => registry({ run: async () => completed() }).select(assignment, policy).snapshot;
  const owner: ClientActor = { owner_id: canonicalHash(randomUUID()), client_id: randomUUID() };
  const admission = (assignment: Assignment, id = randomUUID()): DurableRequest => ({
    schema_version: 4, task_id: id, project_id: "project", canonical_hash: canonicalHash({ schema_version: 1, source_view: root, assignment }), request: assignment,
    execution: snapshot(assignment), source_view: root, initial_owner: owner.owner_id, accepted_at: new Date().toISOString() });
  const coordinators: Coordinator[] = [];
  const coordinator = (worker: WorkerAdapter) => {
    const c = new Coordinator(root, "project", policy, store, registry(worker)); coordinators.push(c);
    return Object.assign(c, { execute: async (assignment: Assignment, ctx = context()) => {
      const receipt = await c.submit({ schema_version: 1, source_view: root, assignment }, owner, ctx.signal);
      while (true) {
        const result = await store.readResult(receipt.task_id); if (result) return result;
        if (c.frozenReason && !c.isActive(receipt.task_id)) throw new Error(c.frozenReason);
        const state = await c.controls.read(receipt.task_id, owner);
        await c.controls.wait(receipt.task_id, owner, state.revision, 50, ctx.signal);
      }
    } });
  };
  return { temporary, root, state, worktrees, base, profile, policy, store, git, request, registry, definitions, snapshot, admission, owner,
    initial: (id: string) => initialControl(id, owner.owner_id), coordinator,
    dispose: async () => { for (const c of coordinators) { for (const r of await store.list()) { if (!("schema_version" in r)) continue; const state = await store.readControl(r.task_id); if (state.phase !== "terminal" && !state.settled_outcome) await c.cancel(r.task_id, owner, state.control_generation, `fixture-stop:${r.task_id}`, "Explicit synthetic fixture teardown"); } await c.shutdown(); } await rm(temporary, { recursive: true, force: true }); },
  };
}
/** Controlled workers in core/Git tests model a complete native turn; real adapters are tested without this wrapper. */
export function observedWorker(worker: WorkerAdapter): WorkerAdapter {
  return { run: async (input) => {
    const turn_id = randomUUID(); await input.onEvent({ kind: "turn_started", turn_id });
    const result = await worker.run(input);
    await input.onEvent({ kind: "turn_settled", turn_id, terminal: result.status === "completed" ? "completed" : result.status === "cancelled" ? "cancelled" : "failed" });
    return result;
  } };
}
