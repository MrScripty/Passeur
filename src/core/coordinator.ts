import { createHash } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { DelegateRequest, DelegateResult, Profile } from "../contracts/index.js";
import { BridgeError } from "./errors.js";
import { transition, type TaskState } from "./state.js";
import type { ApprovalHandler, WorkerAdapter } from "../muse/adapter.js";
import { TaskStore, type StoredRequest } from "../store/task-store.js";
import { changedFiles, createDiff, createManifest, prepareWorkspace, type Workspace } from "../workspace/worktree.js";
import { currentRevision, digestFiles, repositoryInstructions, sourceStatus } from "../workspace/project.js";

export type RunContext = { signal: AbortSignal; approve: ApprovalHandler; progress?: (message: string) => Promise<void> };

function canonicalHash(request: DelegateRequest): string { return createHash("sha256").update(JSON.stringify(request)).digest("hex"); }
function initialState(): TaskState { return { phase: "accepted", updated_at: new Date().toISOString() }; }

function promptFor(request: DelegateRequest, taskId: string, workspace: Workspace, instructions: Array<{ path: string; text: string }>): string {
  const files = request.context_files?.map((path) => `@${path}`).join("\n") ?? "(none)";
  return `You are completing one bounded Muse Bridge assignment. Do not delegate to another agent.\n\nTask ID: ${taskId}\nMode: ${request.mode}\nWorkspace: ${workspace.path}\nObjective: ${request.objective}\n\nContext:\n${request.context}\n\nAcceptance criteria:\n${request.acceptance_criteria.map((item, index) => `${index + 1}. ${item}`).join("\n")}\n\nContext files:\n${files}\n\nAllowed paths:\n${request.allowed_paths?.join("\n") ?? "(not specified; follow workspace permission policy)"}\n\nRepository instruction provenance:\n${instructions.map((entry) => `${entry.path}:\n${entry.text}`).join("\n\n") || "(none found)"}\n\nFinish with exactly this marker followed by one JSON object on the remainder of the response:\nMUSE_BRIDGE_RESULT {"summary":"concise report","assessment":"met|partial|unmet|unknown","blockers":[],"questions":[],"checks":[{"command":"exact command","cwd":"working directory","exit_code":0}]}\nReport only checks you actually observed through tools. Do not claim verification you did not observe.`;
}

function baseResult(taskId: string, request: DelegateRequest, profile: Profile, workspace?: Workspace): DelegateResult {
  return {
    schema_version: 1, task_id: taskId, request_key: request.request_key, execution_status: "failed", worker_stop: "not_started", worker_assessment: "unknown", summary: "", blockers: [], questions: [], model: { requested: profile.model },
    workspace: workspace?.kind === "task_worktree" ? { kind: "task_worktree", base_commit: workspace.base_commit!, worktree_path: workspace.path, stale: false } : { kind: "source_read_only", stale: false },
    changed_files: [], checks: [], artifacts: [], output_truncated: false,
  };
}

export class Coordinator {
  #active: { requestKey: string; hash: string; promise: Promise<DelegateResult> } | undefined;
  #admission: Promise<void> = Promise.resolve();
  constructor(readonly project: string, readonly projectId: string, readonly profile: Profile, readonly store: TaskStore, readonly worker: WorkerAdapter) {}

  async delegate(request: DelegateRequest, context: RunContext): Promise<DelegateResult> {
    const hash = canonicalHash(request);
    let unlock!: () => void;
    const previous = this.#admission;
    this.#admission = new Promise<void>((resolve) => { unlock = resolve; });
    await previous;
    let execution: Promise<DelegateResult>;
    try {
      if (this.#active) {
        if (this.#active.requestKey === request.request_key) {
          if (this.#active.hash !== hash) throw new BridgeError("REQUEST_KEY_CONFLICT", "The active request key belongs to a different assignment");
          execution = this.#active.promise;
        } else throw new BridgeError("TASK_ACTIVE", "This bridge permits one assignment at a time");
      } else {
        const existing = await this.store.find({ request_key: request.request_key });
        if (existing) {
          if (existing.canonical_hash !== hash) throw new BridgeError("REQUEST_KEY_CONFLICT", "The request key already belongs to a different assignment");
          const result = await this.store.readResult(existing.task_id);
          if (result) execution = Promise.resolve(result);
          else throw new BridgeError("TASK_ACTIVE", `Task ${existing.task_id} is active or was interrupted; it will not be launched again`);
        } else {
          for (const prior of await this.store.list()) {
            const result = await this.store.readResult(prior.task_id);
            if (result?.worker_stop === "unconfirmed") throw new BridgeError("PROJECT_NEEDS_RECONCILIATION", `Task ${prior.task_id} has unconfirmed worker shutdown; inspect and explicitly clean up its record after reconciling the process and workspace`);
          }
          const taskId = crypto.randomUUID();
          const acceptedAt = new Date();
          const deadline = new Date(acceptedAt.getTime() + this.profile.task_timeout_ms);
          const stored: StoredRequest = { task_id: taskId, project_id: this.projectId, canonical_hash: hash, accepted_at: acceptedAt.toISOString(), deadline_at: deadline.toISOString(), request };
          await this.store.create(stored, initialState());
          execution = this.#execute(stored, context);
          this.#active = { requestKey: request.request_key, hash, promise: execution };
        }
      }
    } finally { unlock(); }
    try { return await execution; } finally { if (this.#active?.promise === execution) this.#active = undefined; }
  }

  async #execute(stored: StoredRequest, context: RunContext): Promise<DelegateResult> {
    const { task_id: taskId, request } = stored;
    let state = initialState();
    let workspace: Workspace | undefined;
    let result = baseResult(taskId, request, this.profile);
    const controller = new AbortController();
    context.signal.addEventListener("abort", () => controller.abort(context.signal.reason ?? new Error("MCP request cancelled")), { once: true });
    const timeout = setTimeout(() => controller.abort(Object.assign(new Error("Task deadline exceeded"), { code: "TASK_TIMEOUT" })), this.profile.task_timeout_ms);
    try {
      state = transition(state, "preparing"); await this.store.writeState(taskId, state); await context.progress?.("Preparing Muse workspace");
      workspace = await prepareWorkspace(this.project, request, this.profile, this.projectId, taskId);
      result = baseResult(taskId, request, this.profile, workspace);
      const instructions = await repositoryInstructions(workspace.path);
      const paths = request.context_files ?? [];
      const before = await digestFiles(workspace.path, paths);
      const initialStatus = await sourceStatus(workspace.path);
      const initialRevision = await currentRevision(workspace.path);
      if (request.mode === "review" && initialRevision) result.workspace.base_commit = initialRevision;
      state = transition(state, "running"); await this.store.writeState(taskId, state); await context.progress?.("Muse is working");
      const run = await this.worker.run({ request, prompt: promptFor(request, taskId, workspace, instructions), workspace: workspace.path, profile: this.profile, signal: controller.signal, approve: context.approve, onEvent: (event) => this.store.appendEvent(taskId, event) });
      state = transition(state, "finalizing"); await this.store.writeState(taskId, state); await context.progress?.("Collecting Muse result");
      const after = await digestFiles(workspace.path, paths);
      const finalStatus = await sourceStatus(workspace.path);
      const finalRevision = await currentRevision(workspace.path);
      const stale = JSON.stringify(before) !== JSON.stringify(after) || (request.mode === "review" && (JSON.stringify(initialStatus) !== JSON.stringify(finalStatus) || initialRevision !== finalRevision));
      const files = await changedFiles(workspace);
      result = { ...result, execution_status: run.status, worker_stop: run.worker_stop, worker_assessment: run.worker_assessment, summary: run.summary, blockers: run.blockers, questions: run.questions, checks: run.checks, model: { requested: this.profile.model, ...(run.reported_model ? { reported: run.reported_model } : {}) }, workspace: { ...result.workspace, stale }, changed_files: files, ...(run.error ? { error: run.error } : {}) };
      const outsideScope = request.allowed_paths ? files.filter((file) => !request.allowed_paths!.some((allowed) => file === allowed || file.startsWith(`${allowed.replace(/\/$/, "")}/`))) : [];
      if (outsideScope.length) result.blockers.push(`Changes outside allowed_paths require review: ${outsideScope.join(", ")}`);
      if (request.mode === "implement") await this.#artifacts(taskId, workspace, result);
      state = transition(state, "terminal", { outcome: result.execution_status });
    } catch (error) {
      const bridge = error instanceof BridgeError ? error : new BridgeError("BRIDGE_ERROR", error instanceof Error ? error.message : String(error));
      const status = controller.signal.aborted ? (controller.signal.reason?.code === "TASK_TIMEOUT" ? "timed_out" : "cancelled") : bridge.code === "DIRTY_SOURCE" || bridge.code === "IMPLEMENTATION_DISABLED" ? "blocked" : "failed";
      result = { ...result, execution_status: status, summary: bridge.message, blockers: status === "blocked" ? [bridge.message] : [], error: { code: bridge.code, message: bridge.message } };
      if (state.phase !== "finalizing") { try { state = transition(state, "finalizing", { reason: bridge.code }); } catch {} }
      state = transition(state, "terminal", { outcome: status, reason: bridge.code });
    } finally { clearTimeout(timeout); }
    await this.store.writeResult(taskId, result);
    await this.store.writeState(taskId, state);
    return compactResult(result);
  }

  async #artifacts(taskId: string, workspace: Workspace, result: DelegateResult): Promise<void> {
    const dir = join(this.store.taskDir(taskId), "artifacts"); await mkdir(dir, { recursive: true, mode: 0o700 });
    const manifestPath = join(dir, "manifest.json");
    const files = await createManifest(workspace, dir);
    const manifest = { base_commit: workspace.base_commit, files, generated_at: new Date().toISOString() };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    const diffPath = join(dir, "changes.diff"); await writeFile(diffPath, await createDiff(workspace), { mode: 0o600 });
    for (const [id, kind, path] of [["manifest", "manifest", manifestPath], ["diff", "diff", diffPath]] as const) result.artifacts.push({ id, kind, path: relative(this.store.taskDir(taskId), path), bytes: (await stat(path)).size });
    for (const file of files.filter((entry) => entry.artifact_path)) {
      const path = join(dir, file.artifact_path!);
      result.artifacts.push({ id: file.artifact_id!, kind: "report", path: relative(this.store.taskDir(taskId), path), bytes: (await stat(path)).size });
    }
  }
}

export function compactResult(result: DelegateResult): DelegateResult {
  const compact = structuredClone(result);
  if (Buffer.byteLength(JSON.stringify(compact)) <= 24_576) return compact;
  compact.output_truncated = true;
  compact.summary = `${compact.summary.slice(0, 4096)}\n[truncated; use muse_result]`;
  if (compact.error) compact.error.message = compact.error.message.slice(0, 1024);
  compact.blockers = compact.blockers.map((item) => item.slice(0, 1024));
  compact.questions = compact.questions.map((item) => item.slice(0, 1024));
  while (Buffer.byteLength(JSON.stringify(compact)) > 24_576) {
    const longest = [compact.changed_files, compact.checks, compact.artifacts, compact.questions, compact.blockers].sort((a, b) => b.length - a.length)[0];
    if (longest && longest.length) { longest.pop(); continue; }
    compact.summary = compact.summary.slice(0, Math.max(0, compact.summary.length - 512));
    if (!compact.summary.length) break;
  }
  return compact;
}
