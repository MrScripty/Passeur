import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Assignment, AgentProfile, ExecutionPolicy } from "../../src/contracts/agents.js";
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
  const policy: ExecutionPolicy = { implementation: { enabled: true, worktree_root: worktrees }, task_timeout_ms: 60_000,
    stop_grace_ms: 1_000, max_workers: 2, max_queued_tasks: 8 };
  const profile: AgentProfile = { schema_version: 2, execution: policy,
    agents: [{ agent_id: "muse", adapter_id: "muse", description: "Controlled worker fixture", enabled: true, options: {} }] };
  const definitions = (worker: WorkerAdapter): Record<string, AdapterDefinition> => ({ muse: { configure: () => ({ worker, modes: ["review", "implement"],
    contract: "fixture/1", requested_model: "model", configuration: { model: "model" } }) } });
  const registry = (worker: WorkerAdapter) => new AgentRegistry(profile, definitions(worker));
  const store = new TaskStore(state); await store.initialize();
  const request = (key: string, mode: Assignment["mode"] = "review"): Assignment => ({ schema_version: 3, agent_id: "muse", request_key: key, mode, objective: "Perform the bounded assignment", context: "Independent task", acceptance_criteria: ["Report scoped outcome"], ...(mode === "implement" ? { base_commit: base, target_ref: "refs/heads/main" } : {}) });
  const snapshot = (assignment: Assignment) => registry({ run: async () => completed() }).select(assignment, policy).snapshot;
  const admission = (assignment: Assignment, id = crypto.randomUUID()): StoredRequest => {
    const now = Date.now();
    return { task_id: id, project_id: "project", canonical_hash: canonicalHash(assignment), request: assignment, execution: snapshot(assignment),
      accepted_at: new Date(now).toISOString(), deadline_at: new Date(now + policy.task_timeout_ms).toISOString() };
  };
  return { temporary, root, state, worktrees, base, profile, policy, store, git, request, registry, definitions, snapshot, admission,
    coordinator: (worker: WorkerAdapter) => new Coordinator(root, "project", policy, store, registry(worker)),
    dispose: () => rm(temporary, { recursive: true, force: true }),
  };
}
