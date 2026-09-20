import { randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ResourceRecord } from "../contracts/types.js";
import type { Assignment, AgentResult, ExecutionPolicy } from "../contracts/agents.js";
import type { AgentRegistry, SelectedAgent } from "../agents/registry.js";
import { priorTaskResult } from "./prior-task.js";
import { BridgeError, errorInfo } from "./errors.js";
import { Mutex, canonicalHash, throwIfAborted, withAbort } from "./async.js";
import { transition, type TaskState } from "./state.js";
import { baseResult } from "./result.js";
import type { ApprovalHandler } from "../agents/types.js";
import type { TaskStore, StoredRequest } from "../store/task-store.js";
import { collectChanges, createDiff, createManifest, observeDelivery, prepareWorkspace, type Workspace } from "../workspace/worktree.js";
import { currentRevision, digestFiles, sourceStatus } from "../workspace/project.js";
export type RunContext = { signal: AbortSignal; approve: ApprovalHandler; approvalAvailable?: boolean; progress?: (message: string) => Promise<void> };
type Entry = {
  selected: SelectedAgent; record: StoredRequest; request: Assignment; context: RunContext; hash: string;
  controller: AbortController; promise: Promise<AgentResult>; resolve: (result: AgentResult) => void; reject: (error: unknown) => void;
  stage: "queued" | "running" | "settling"; slot: boolean; timer: NodeJS.Timeout;
  detachOwner: () => void;
};
const now = () => new Date().toISOString();
export function assignmentPrompt(request: Assignment, taskId: string, workspace: Workspace): string {
  return `Complete one independent Passeur assignment.\nTask: ${taskId}\nMode: ${request.mode}\nWorkspace: ${workspace.path}\nObjective: ${request.objective}\n\nContext:\n${request.context}\n\nAcceptance criteria:\n${request.acceptance_criteria.map((item) => `- ${item}`).join("\n")}\n\nContext files:\n${request.context_files?.join("\n") ?? "none"}\nAllowed paths:\n${request.allowed_paths?.join("\n") ?? "follow the assignment scope"}\n\nRead applicable repository instructions in this workspace. Other workers may be implementing unrelated or unfinished components. Verify only what this assignment and the repository standards require; disclose deferred or unavailable checks.\n${request.mode === "implement" ? "Inspect and stage only your intended changes. Create standards-compliant commits on the assigned task branch through ordinary Git, preserving repository hooks and commit/signing policy. Do not update target refs, sibling workspaces, or shared Git configuration. Do not bypass hooks. Fix scoped check failures within this assignment or report the blocker. Commit all intended delivery files; leave no nonignored uncommitted work. Do not manufacture an empty commit. No end-to-end build or primary-model review is required merely because this worker finishes." : "Inspect only; no commit or repository modification is required."}\n\nFinish with PASSEUR_RESULT followed by one JSON object:\n{"summary":"short outcome","assessment":"met|partial|unmet|unknown","blockers":[],"questions":[],"checks":[{"command":"command actually run","cwd":"directory","exit_code":0}],"no_changes_reason":"include only when no changes were needed"}\nKeep verification claims truthful. Passeur will identify the actual Git deliverable; it will not run or select project tests for you.`;
}

/** One owner, many independent executions. The lock covers admission, never inference. */
export class Coordinator {
  readonly administration = new Mutex();
  #admission = new Mutex();
  #entries = new Map<string, Entry>();
  #queue: Entry[] = [];
  #active = 0;
  #closing = false;
  #frozen: string | undefined;
  #pumping = false;
  constructor(readonly project: string, readonly projectId: string, readonly policy: ExecutionPolicy, readonly store: TaskStore, readonly registry: AgentRegistry, readonly assertAuthority?: () => void) {
    this.policy = structuredClone(policy); Object.freeze(this.policy.implementation); Object.freeze(this.policy);
  }
  isActive(taskId: string): boolean { return [...this.#entries.values()].some((entry) => entry.record.task_id === taskId); }
  get activeCount(): number { return this.#active; }
  get queuedCount(): number { return this.#queue.length; }
  get frozenReason(): string | undefined { return this.#frozen; }
  async assertMutationAllowed(): Promise<void> {
    this.assertAuthority?.();
    const reason = this.#frozen ?? await this.store.frozenReason();
    if (reason) throw new BridgeError("PROJECT_NEEDS_RECONCILIATION", reason);
    if (this.#closing) throw new BridgeError("BRIDGE_CLOSING", "The coordinator is shutting down");
  }
  async #freeze(reason: string): Promise<void> {
    this.#frozen ??= reason;
    // An in-memory latch protects this process even when the disk failure prevents a sentinel write.
    await this.store.freeze(this.#frozen).catch(() => undefined);
    for (const entry of this.#queue) entry.controller.abort(new BridgeError("PROJECT_NEEDS_RECONCILIATION", this.#frozen));
    this.#kick();
  }
  async delegate(request: Assignment, context: RunContext): Promise<AgentResult> {
    throwIfAborted(context.signal);
    if (request.schema_version !== 3) throw new BridgeError("CONTRACT_UPGRADE_REQUIRED", "Use schema_version 3 with agent_id");
    let entry!: Entry;
    let cached: AgentResult | undefined;
    request = structuredClone(request);
    Object.freeze(request.acceptance_criteria);
    if (request.allowed_paths) Object.freeze(request.allowed_paths);
    if (request.context_files) Object.freeze(request.context_files);
    Object.freeze(request);
    const hash = canonicalHash(request);
    await this.#admission.run(async () => {
      throwIfAborted(context.signal);
      if (this.#closing) throw new BridgeError("BRIDGE_CLOSING", "The coordinator is shutting down");
      const active = this.#entries.get(request.request_key);
      if (active) {
        if (active.hash !== hash) throw new BridgeError("REQUEST_KEY_CONFLICT", "The active key belongs to a different assignment");
        entry = active; return;
      }
      cached = await priorTaskResult(this.store, request);
      if (cached) return;
      if (context.approvalAvailable === false) throw new BridgeError("ELICITATION_UNAVAILABLE", "New execution requires human approval capability");
      const selected = this.registry.select(request, this.policy);
      await this.assertMutationAllowed();
      // Known live siblings are not historical incomplete executions.
      for (const prior of await this.store.list()) {
        if (this.isActive(prior.task_id)) continue;
        const result = await this.store.readResult(prior.task_id);
        if (!result || (result.worker_stop === "unconfirmed" && !(await this.store.readResource(prior.task_id))?.stop_reconciled)) throw new BridgeError("PROJECT_NEEDS_RECONCILIATION", `Task ${prior.task_id} needs reconciliation before new starts`);
      }
      const workers = this.policy.max_workers ?? 2, queueLimit = this.policy.max_queued_tasks ?? 8;
      const occupying = [...this.#entries.values()].filter((value) => value.stage !== "settling").length;
      if (occupying >= workers + queueLimit) throw new BridgeError("CAPACITY_EXCEEDED", "The bounded worker pool and queue are full");
      throwIfAborted(context.signal);
      const acceptedAt = Date.now(), taskId = randomUUID();
      const record: StoredRequest = { task_id: taskId, project_id: this.projectId, canonical_hash: hash, accepted_at: new Date(acceptedAt).toISOString(), deadline_at: new Date(acceptedAt + this.policy.task_timeout_ms).toISOString(), request, execution: selected.snapshot };
      await this.store.create(record, { phase: "queued", updated_at: now() });
      let resolve!: Entry["resolve"], reject!: Entry["reject"];
      const promise = new Promise<AgentResult>((yes, no) => { resolve = yes; reject = no; });
      promise.catch(() => undefined);
      const controller = new AbortController();
      const cancelOwner = () => controller.abort(context.signal.reason ?? new BridgeError("REQUEST_CANCELLED", "Owning request cancelled"));
      const timer = setTimeout(() => controller.abort(new BridgeError("TASK_TIMEOUT", "Absolute task deadline exceeded, including queue time")), Math.max(0, acceptedAt + this.policy.task_timeout_ms - Date.now()));
      entry = { selected, record, request, context, hash, controller, promise, resolve, reject, stage: "queued", slot: false, timer, detachOwner: () => context.signal.removeEventListener("abort", cancelOwner) };
      this.#entries.set(request.request_key, entry); this.#queue.push(entry);
      controller.signal.addEventListener("abort", () => this.#kick(), { once: true });
      if (this.#closing) controller.abort(new BridgeError("BRIDGE_CLOSING", "Coordinator closed during admission"));
      if (context.signal.aborted) cancelOwner(); else context.signal.addEventListener("abort", cancelOwner, { once: true });
    });
    if (cached) {
      return cached;
    }
    this.#kick();
    // Only the first context is wired to entry.controller. Duplicate subscribers merely detach.
    return withAbort(entry.promise, context.signal);
  }
  async delegateBatch(assignments: Assignment[], context: RunContext): Promise<Array<{ request_key: string; result?: AgentResult; error?: { code: string; message: string } }>> {
    if (!assignments.length || assignments.length > 8 || new Set(assignments.map((item) => item.request_key)).size !== assignments.length) throw new BridgeError("INVALID_BATCH", "Supply one to eight unique request keys");
    return Promise.all(assignments.map(async (request) => {
      try { return { request_key: request.request_key, result: await this.delegate(request, context) }; }
      catch (error) { return { request_key: request.request_key, error: errorInfo(error) }; }
    }));
  }
  #kick(): void {
    if (this.#pumping) return;
    this.#pumping = true;
    void this.#admission.run(() => {
      // Expired/cancelled queued tasks finalize immediately, without waiting for a host slot.
      const observedAt = Date.now();
      for (const entry of this.#queue) {
        if (!entry.controller.signal.aborted && Date.parse(entry.record.deadline_at) <= observedAt) {
          entry.controller.abort(new BridgeError("TASK_TIMEOUT", "Absolute task deadline exceeded, including queue time"));
        }
      }
      const cancelled = this.#queue.filter((entry) => entry.controller.signal.aborted);
      this.#queue = this.#queue.filter((entry) => !entry.controller.signal.aborted);
      for (const entry of cancelled) { entry.stage = "settling"; void this.#run(entry); }
      while (!this.#closing && !this.#frozen && this.#queue.length && this.#active < (this.policy.max_workers ?? 2)) {
        const entry = this.#queue.shift()!;
        entry.stage = "running"; entry.slot = true; this.#active++;
        void this.#run(entry);
      }
    }).catch((error) => this.#freeze(errorInfo(error).message)).finally(() => {
      this.#pumping = false;
      if (this.#queue.some((entry) => entry.controller.signal.aborted) || (!this.#closing && !this.#frozen && this.#queue.length && this.#active < (this.policy.max_workers ?? 2))) this.#kick();
    });
  }
  async #run(entry: Entry): Promise<void> {
    let result: AgentResult | undefined, failure: unknown;
    try {
      result = await this.#execute(entry);
      if (result.worker_stop === "unconfirmed") await this.#freeze(`Worker ${entry.record.task_id} did not confirm shutdown`);
    } catch (error) {
      failure = error;
      await this.#freeze(`Task ${entry.record.task_id} could not preserve terminal evidence: ${errorInfo(error).message}`);
    } finally {
      clearTimeout(entry.timer); entry.detachOwner();
      await this.#admission.run(() => {
        if (entry.slot) this.#active--;
        this.#entries.delete(entry.request.request_key);
      });
      if (result) entry.resolve(result); else entry.reject(failure);
      this.#kick();
    }
  }
  async #execute(entry: Entry): Promise<AgentResult> {
    const { request, context, controller, record } = entry, id = record.task_id;
    let state: TaskState = { phase: "queued", updated_at: now() }, workspace: Workspace | undefined;
    let result = baseResult(id, request, entry.selected.snapshot), workerSettled = false, pendingApprovals = 0;
    const phaseLock = new Mutex();
    const phase = (next: TaskState["phase"]) => phaseLock.run(async () => {
      state = transition(state, next); await this.store.writeState(id, state);
    });
    const progress = async (message: string) => { await context.progress?.(message).catch(() => undefined); };
    try {
      throwIfAborted(controller.signal);
      await phase("preparing"); await progress(`Preparing ${id}`);
      await this.assertMutationAllowed();
      // Unique task workspaces and Git's own locks isolate preparation; hooks run outside the administrative mutex.
      workspace = await prepareWorkspace(this.project, request, this.policy, this.projectId, id, {
          signal: controller.signal, ...(this.assertAuthority ? { assertAuthority: this.assertAuthority } : {}),
          onIntent: async (intent) => this.store.writeResource(id, {
            schema_version: 1, task_id: id, project_id: this.projectId, state: "creating", updated_at: now(),
            worktree_path: intent.path, branch_ref: intent.branch!, base_commit: intent.base_commit!, target_ref: intent.target_ref!,
          }),
      });
      result = baseResult(id, request, entry.selected.snapshot, workspace);
      const resource = await this.store.readResource(id);
      await this.store.writeResource(id, resource ? { ...resource, state: "pending", updated_at: now() } : {
        schema_version: 1, task_id: id, project_id: this.projectId, state: "not_applicable", updated_at: now(),
      });
      const paths = request.context_files ?? [];
      const before = await digestFiles(workspace.path, paths);
      const initialStatus = await sourceStatus(workspace.path, false, controller.signal), initialRevision = await currentRevision(workspace.path, controller.signal);
      if (request.mode === "review" && initialRevision) result.workspace.base_commit = initialRevision;
      throwIfAborted(controller.signal);
      await phase("running"); await progress(`Agent task ${id} is working`);
      result.worker_stop = "unconfirmed";
      this.assertAuthority?.();
      const run = await entry.selected.worker.run({
        request, task_id: id, prompt: assignmentPrompt(request, id, workspace), workspace: workspace.path,
        policy: this.policy, signal: controller.signal,
        onEvent: (event) => this.store.appendEvent(id, event),
        approve: async (approval, signal) => {
          await phaseLock.run(async () => {
            throwIfAborted(signal);
            if (state.phase !== "running" && state.phase !== "awaiting_input") throw new BridgeError("STALE_APPROVAL", "Task is no longer accepting approvals");
            if (++pendingApprovals === 1) { state = transition(state, "awaiting_input"); await this.store.writeState(id, state); }
          });
          try { return await context.approve({ ...approval, task_id: id, workspace: workspace!.path }, signal); }
          finally {
            await phaseLock.run(async () => {
              pendingApprovals--;
              if (!pendingApprovals && state.phase === "awaiting_input" && !signal.aborted) { state = transition(state, "running"); await this.store.writeState(id, state); }
            });
          }
        },
      });
      // Stop evidence must survive every optional finalization operation below.
      result = { ...result, execution_status: run.status, worker_stop: run.worker_stop, worker_assessment: run.worker_assessment, summary: run.summary,
        blockers: [...run.blockers], questions: run.questions, checks: run.checks,
        model: { ...(entry.selected.snapshot.requested_model ? { requested: entry.selected.snapshot.requested_model } : {}), ...(run.reported_model ? { reported: run.reported_model } : {}) }, ...(run.error ? { error: run.error } : {}) };
      workerSettled = true;
      if (run.worker_stop === "unconfirmed") await this.#freeze(`Worker ${id} did not confirm shutdown`);
      await phase("finalizing"); await progress(`Collecting ${id}`);
      if (run.worker_stop === "unconfirmed") {
        result.delivery = { status: request.mode === "review" ? "not_applicable" : "incomplete", reason: "Cannot identify a stable deliverable until worker shutdown is reconciled" };
      } else {
        result.delivery = await observeDelivery(workspace, run.no_changes_reason);
        const after = await digestFiles(workspace.path, paths, true);
        result.workspace.stale = request.mode === "review" && (JSON.stringify(before) !== JSON.stringify(after) || JSON.stringify(initialStatus) !== JSON.stringify(await sourceStatus(workspace.path, false, controller.signal)) || initialRevision !== await currentRevision(workspace.path, controller.signal));
        const changes = await collectChanges(workspace);
        result.changed_files = changes.map((change) => change.path).sort();
        const scopePaths = [...new Set(changes.flatMap((change) => change.old_path ? [change.old_path, change.path] : [change.path]))];
        const outside = request.allowed_paths ? scopePaths.filter((path) => !request.allowed_paths!.some((allowed) => path === allowed || path.startsWith(`${allowed.replace(/\/$/, "")}/`))) : [];
        if (outside.length) result.blockers.push(`Changes outside allowed_paths require an orchestrator decision: ${outside.join(", ")}`);
        if (request.mode === "implement") await this.#artifacts(id, workspace, result, changes);
        const owned = await this.store.readResource(id);
        if (owned && result.delivery.head_commit) await this.store.writeResource(id, { ...owned, head_commit: result.delivery.head_commit, updated_at: now() });
      }
    } catch (error) {
      const detail = errorInfo(error);
      if (detail.code === "GIT_STOP_UNCONFIRMED") { result.worker_stop = "unconfirmed"; await this.#freeze(detail.message); }
      if (workerSettled) {
        result.error = { code: "FINALIZATION_FAILED", message: detail.message };
        result.blockers.push(`Result finalization failed: ${detail.message}`);
      } else {
        const reason = controller.signal.reason as { code?: string } | undefined;
        const status = controller.signal.aborted ? (reason?.code === "TASK_TIMEOUT" ? "timed_out" : reason?.code === "PROJECT_NEEDS_RECONCILIATION" ? "blocked" : "cancelled") : ["DIRTY_SOURCE", "IMPLEMENTATION_DISABLED", "PROJECT_NEEDS_RECONCILIATION"].includes(detail.code) ? "blocked" : "failed";
        result = { ...result, execution_status: status, summary: detail.message, error: detail, blockers: status === "blocked" ? [detail.message] : [] };
      }
    }
    if (state.phase !== "finalizing") await phase("finalizing");
    if (!await this.store.readResource(id)) await this.store.writeResource(id, { schema_version: 1, task_id: id, project_id: this.projectId, state: "not_applicable", updated_at: now() });
    // Persist immutable result before publishing terminal state. Recovery repairs the interrupted pair.
    await this.store.writeResult(id, result);
    await phaseLock.run(async () => { state = transition(state, "terminal", { outcome: result.execution_status }); await this.store.writeState(id, state); });
    return result;
  }
  async #artifacts(id: string, workspace: Workspace, result: AgentResult, changes: Awaited<ReturnType<typeof collectChanges>>): Promise<void> {
    const dir = join(this.store.taskDir(id), "artifacts"); this.assertAuthority?.(); await mkdir(dir, { recursive: true, mode: 0o700 });
    const files = await createManifest(workspace, dir, changes, this.assertAuthority);
    const manifestPath = join(dir, "manifest.json"), diffPath = join(dir, "changes.diff");
    this.assertAuthority?.();
    await writeFile(manifestPath, `${JSON.stringify({ base_commit: workspace.base_commit, head_commit: result.delivery.head_commit, files }, null, 2)}\n`, { mode: 0o600 });
    const diff = await createDiff(workspace);
    this.assertAuthority?.();
    await writeFile(diffPath, diff, { mode: 0o600 });
    for (const [artifactId, kind, path] of [["manifest", "manifest", manifestPath], ["diff", "diff", diffPath]] as const) result.artifacts.push({ id: artifactId, kind, path: relative(this.store.taskDir(id), path), bytes: (await stat(path)).size });
    for (const file of files) if (file.artifact_path && file.artifact_id) {
      const path = join(dir, file.artifact_path);
      result.artifacts.push({ id: file.artifact_id, kind: "report", path: relative(this.store.taskDir(id), path), bytes: (await stat(path)).size });
    }
  }
  closeAdmission(reason: unknown = new BridgeError("BRIDGE_CLOSING", "Coordinator closed")): void {
    this.#closing = true;
    for (const entry of this.#entries.values()) entry.controller.abort(reason);
    this.#kick();
  }
  async waitForIdle(): Promise<void> {
    do {
      await this.#admission.idle();
      await Promise.allSettled([...this.#entries.values()].map((entry) => entry.promise));
      await this.#admission.idle();
    } while (this.#entries.size);
  }
  async shutdown(reason?: unknown): Promise<void> { this.closeAdmission(reason); await this.waitForIdle(); await this.administration.idle(); }
}
