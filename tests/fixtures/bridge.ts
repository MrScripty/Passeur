import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DelegateRequest, Profile } from "../../src/contracts/types.js";
import { Coordinator } from "../../src/core/coordinator.js";
import { TaskStore } from "../../src/store/task-store.js";
import type { WorkerAdapter, WorkerRun } from "../../src/muse/types.js";
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
  const profile: Profile = { schema_version: 1, muse_bin: "muse", model: "model", review: { disable_write: true, disable_shell: true, sandbox_network: "restricted" }, implementation: { enabled: true, worktree_root: worktrees, sandbox_network: "restricted" }, task_timeout_ms: 60_000, stop_grace_ms: 1_000, max_workers: 2, max_queued_tasks: 8, subscription: { provenance: "user_confirmed" } };
  const store = new TaskStore(state); await store.initialize();
  const request = (key: string, mode: DelegateRequest["mode"] = "review"): DelegateRequest => ({ schema_version: 2, request_key: key, mode, objective: "Perform the bounded assignment", context: "Independent task", acceptance_criteria: ["Report scoped outcome"], ...(mode === "implement" ? { base_commit: base, target_ref: "refs/heads/main" } : {}) });
  return { temporary, root, state, worktrees, base, profile, store, git, request,
    coordinator: (worker: WorkerAdapter) => new Coordinator(root, "project", profile, store, worker),
    dispose: () => rm(temporary, { recursive: true, force: true }),
  };
}
