import { randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Assignment } from "../contracts/agents.js";
import type { LifecyclePolicy, LifecycleResult, SubmissionIdentity, DurableRequest, TaskObservation } from "../contracts/tasks.js";
import { TaskControls, initialControl, owns, type ClientActor } from "./task-control.js";
import { InputBroker } from "./input-broker.js";
import type { AgentRegistry, SelectedAgent } from "../agents/registry.js";
import type { WorkerEvent } from "../agents/types.js";
import { BridgeError, errorInfo } from "./errors.js";
import { Mutex, canonicalHash } from "./async.js";
import { baseResult } from "./result.js";
import { workerMessageInstructions } from "../agents/report-format.js";
import type { TaskStore } from "../store/task-store.js";
import { collectChanges, createDiff, createManifest, observeDelivery, prepareWorkspace, type Workspace } from "../workspace/worktree.js";
import { currentRevision, digestFiles, sourceStatus } from "../workspace/project.js";

type Entry = { selected: SelectedAgent; record: DurableRequest; controller: AbortController;
  stage: "queued" | "running" | "settling"; done: Promise<void>; resolve: () => void };
const now = () => new Date().toISOString();
export function assignmentPrompt(request: Assignment, id: string, workspace: Workspace): string {
  return `Complete one independent Passeur assignment.\nTask: ${id}\nMode: ${request.mode}\nWorkspace: ${workspace.path}\nObjective: ${request.objective}\nContext:\n${request.context}\nAcceptance criteria:\n${request.acceptance_criteria.join("\n")}\nContext files:\n${request.context_files?.join("\n") ?? "none"}\nAllowed paths:\n${request.allowed_paths?.join("\n") ?? "follow assignment scope"}\nRead applicable repository instructions. Perform the scoped checks those instructions require. Preserve hooks, signing, shared configuration and other workers. ${request.mode === "implement" ? "Stage only intended changes and create ordinary commits on this task branch. Do not modify target refs, integrate other work, bypass hooks or manufacture empty commits." : "Inspect only; do not write or run shell commands."}\n${workerMessageInstructions} Passeur observes Git; the caller owns broader acceptance and integration.`;
}

/** One service owns admission and work. A request's signal can stop receipt delivery, never accepted execution. */
export class Coordinator {
  readonly administration = new Mutex();
  readonly controls: TaskControls;
  readonly inputs: InputBroker;
  readonly #admission = new Mutex();
  readonly #entries = new Map<string, Entry>();
  #queue: Entry[] = [];
  #active = 0;
  #closing = false;
  #frozen: string | undefined;
  #pump: Promise<void> | undefined;
  onSettled?: () => void;
  constructor(readonly project: string, readonly projectId: string, readonly policy: LifecyclePolicy,
    readonly store: TaskStore, readonly registry: AgentRegistry, readonly assertAuthority: () => void = () => {}, controls?: TaskControls) {
    this.policy = structuredClone(policy); Object.freeze(this.policy.implementation); Object.freeze(this.policy);
    this.controls = controls ?? new TaskControls(store, policy.max_waiters, policy.max_control_receipts);
    this.inputs = new InputBroker(this.controls, policy.max_pending_inputs);
  }
  isActive(id: string): boolean { return this.#entries.has(id); }
  get activeCount(): number { return this.#active; }
  get queuedCount(): number { return this.#queue.length; }
  get outstandingCount(): number { return this.#entries.size; }
  get frozenReason(): string | undefined { return this.#frozen; }
  async assertMutationAllowed(): Promise<void> {
    this.assertAuthority();
    const reason = this.#frozen ?? await this.store.frozenReason();
    if (reason) throw new BridgeError("PROJECT_NEEDS_RECONCILIATION", reason);
    if (this.#closing) throw new BridgeError("BRIDGE_CLOSING", "Service admission is closed");
  }
  async #freeze(reason: string): Promise<void> {
    this.#frozen ??= reason;
    await this.store.freeze(reason).catch(() => undefined);
    // Queued work remains durably accepted. Freezing admission is not cancellation authority.
  }
  async submit(identity: SubmissionIdentity, actor: ClientActor, signal: AbortSignal): Promise<TaskObservation> {
    signal.throwIfAborted();
    identity = structuredClone(identity);
    const hash = canonicalHash(identity);
    let taskId = "";
    await this.#admission.run(async () => {
      signal.throwIfAborted();
      const prior = await this.store.find({ request_key: identity.assignment.request_key });
      if (prior) {
        if (!("schema_version" in prior) || prior.schema_version !== 4) throw new BridgeError("LEGACY_REQUEST_KEY", "Use historical result access; this key cannot start a new execution");
        owns(await this.store.readControl(prior.task_id), actor);
        if (prior.canonical_hash !== hash) throw new BridgeError("REQUEST_KEY_CONFLICT", "Request key names different material intent or source view");
        taskId = prior.task_id; return;
      }
      await this.assertMutationAllowed();
      let unfinished = 0;
      for (const record of await this.store.list()) if ((await this.store.readState(record.task_id)).phase !== "terminal") unfinished++;
      if (unfinished >= this.policy.max_workers + this.policy.max_queued_tasks) throw new BridgeError("CAPACITY_EXCEEDED", "Repository worker and queue capacity is full");
      const selected = this.registry.select(identity.assignment, this.policy);
      signal.throwIfAborted();
      const id = randomUUID();
      const record: DurableRequest = { schema_version: 4, task_id: id, project_id: this.projectId, canonical_hash: hash,
        accepted_at: now(), source_view: identity.source_view, initial_owner: actor.owner_id, request: identity.assignment, execution: selected.snapshot };
      // The request and initial control share one publication boundary, before any native/Git effects.
      await this.store.create(record, initialControl(id, actor.owner_id));
      let resolve!: () => void; const done = new Promise<void>((yes) => { resolve = yes; });
      const entry: Entry = { selected, record, controller: new AbortController(), stage: "queued", done, resolve };
      this.#entries.set(id, entry); this.#queue.push(entry); taskId = id;
    });
    this.#kick();
    return this.controls.read(taskId, actor);
  }
  async cancel(id: string, actor: ClientActor, generation: number, operation: string, reason: string) {
    const receipt = await this.controls.cancel(id, actor, generation, operation, reason);
    if (receipt.outcome === "accepted") {
      const entry = this.#entries.get(id);
      if (entry) entry.controller.abort(new BridgeError("TASK_CANCELLED", reason));
      else await this.#cancelRecoveredQueue(id);
      this.#kick();
    }
    return receipt;
  }
  async #cancelRecoveredQueue(id: string): Promise<void> {
    const state = await this.store.readControl(id);
    if (state.native.state !== "not_started" || !state.attention?.startsWith("Recovered queued")) return;
    const record = await this.store.durableRequest(id);
    const result = { ...baseResult(id, record.request, record.execution), execution_status: "cancelled" as const,
      summary: "Explicitly cancelled preserved never-started work", native_evidence: state.native };
    await this.store.writeResult(id, result);
    await this.controls.change(id, (s) => { s.phase = "terminal"; s.outcome = "cancelled"; delete s.attention; });
  }
  #kick(): void {
    if (this.#pump) return;
    this.#pump = this.#admission.run(() => {
      const cancelled = this.#queue.filter((e) => e.controller.signal.aborted);
      this.#queue = this.#queue.filter((e) => !e.controller.signal.aborted);
      for (const entry of cancelled) { entry.stage = "settling"; void this.#run(entry, false); }
      while (!this.#frozen && this.#queue.length && this.#active < this.policy.max_workers) {
        const entry = this.#queue.shift()!; entry.stage = "running"; this.#active++; void this.#run(entry, true);
      }
    }).catch((error) => this.#freeze(errorInfo(error).message)).finally(() => {
      this.#pump = undefined;
      if (this.#queue.some((e) => e.controller.signal.aborted) || !this.#frozen && this.#queue.length && this.#active < this.policy.max_workers) this.#kick();
    });
  }
  async #run(entry: Entry, slot: boolean): Promise<void> {
    try { await this.#execute(entry); }
    catch (error) { await this.#freeze(`Task ${entry.record.task_id} cannot preserve authoritative evidence: ${errorInfo(error).message}`); }
    finally {
      await this.#admission.run(() => { this.#entries.delete(entry.record.task_id); if (slot) this.#active--; });
      entry.resolve(); this.#kick(); this.onSettled?.();
    }
  }
  async #event(id: string, event: WorkerEvent): Promise<void> {
    if (event.kind === "input_withdrawn") { await this.inputs.withdraw(id, event.native_id); return; }
    if (event.kind === "turn_settled") await this.inputs.settleTurn(id, event.turn_id);
    if (["turn_started", "turn_settled", "operation_started", "operation_finished", "process_observed", "runtime_unknown"].includes(event.kind)) {
      await this.controls.change(id, (state) => {
        if (state.phase === "terminal") throw new BridgeError("STALE_NATIVE_EVENT", "Native event arrived after terminal publication");
        state.native.last_observed_at = now();
        if (event.kind === "turn_started") {
          if (state.native.obligations.length || state.inputs.some((i) => i.state === "pending")) throw new BridgeError("NATIVE_OBLIGATIONS_PENDING", "Prior native work has not settled");
          state.native.turn_id = event.turn_id; state.native.state = "observed_live"; state.native.coverage = "unknown";
          if (!state.cancel) state.phase = "active";
        } else if (event.kind === "turn_settled") {
          if (state.native.turn_id !== event.turn_id) throw new BridgeError("NATIVE_CORRELATION_INVALID", "Terminal event belongs to another turn");
          state.native.coverage = "turn_scoped";
        } else if (event.kind === "operation_started") {
          if (state.native.obligations.some((o) => o.id === event.id) || state.native.obligations.length >= 256) throw new BridgeError("NATIVE_OBLIGATION_INVALID", "Duplicate or excessive native obligations");
          state.native.obligations.push({ id: event.id, kind: event.operation });
        } else if (event.kind === "operation_finished") {
          const index = state.native.obligations.findIndex((o) => o.id === event.id);
          if (index < 0) throw new BridgeError("NATIVE_OBLIGATION_INVALID", "Completion has no observed start");
          state.native.obligations.splice(index, 1);
        } else if (event.kind === "process_observed") {
          state.native.process = { pid: event.pid, boot_id: event.boot_id, started: event.started }; state.native.state = "observed_live";
        } else if (event.kind === "runtime_unknown") {
          state.native.state = "unknown"; state.native.limitation = event.reason;
          if (!state.cancel) state.phase = "needs_attention";
        }
      });
    }
    if (await this.store.appendEvent(id, event) === false) await this.controls.change(id, (s) => { s.telemetry_omitted = true; });
  }
  async #execute(entry: Entry): Promise<void> {
    const { record, controller } = entry, id = record.task_id, request = record.request;
    let workspace: Workspace | undefined;
    let result = baseResult(id, request, record.execution), workerSettled = false;
    const phase = async (next: "starting" | "active" | "finalizing") => this.controls.change(id, (s) => { if (!s.cancel) s.phase = next; });
    try {
      controller.signal.throwIfAborted(); this.assertAuthority(); await phase("starting");
      // Active-task ownership protects this unique workspace; hooks run outside repository administration.
      workspace = await prepareWorkspace(record.source_view, request, this.policy, this.projectId, id, {
        signal: controller.signal, assertAuthority: this.assertAuthority,
        onIntent: (intent) => this.administration.run(async () => {
          this.assertAuthority();
          await this.store.writeResource(id, { schema_version: 1, task_id: id, project_id: this.projectId,
            state: "creating", updated_at: now(), worktree_path: intent.path, branch_ref: intent.branch!, base_commit: intent.base_commit!, target_ref: intent.target_ref! });
        }),
      });
      result = baseResult(id, request, record.execution, workspace);
      const resource = await this.store.readResource(id);
      await this.store.writeResource(id, resource ? { ...resource, state: "pending", updated_at: now() }
        : { schema_version: 1, task_id: id, project_id: this.projectId, state: "not_applicable", updated_at: now() });
      const before = await digestFiles(workspace.path, request.context_files ?? []);
      const beforeStatus = await sourceStatus(workspace.path, false, controller.signal), revision = await currentRevision(workspace.path, controller.signal);
      if (request.mode === "review" && revision) result.workspace.base_commit = revision;
      controller.signal.throwIfAborted(); this.assertAuthority();
      // Persist the run intent before startup. A crash after this point cannot claim never-started safety.
      await this.controls.change(id, (s) => { s.native.state = "unknown"; if (!s.cancel) s.phase = "active"; });
      result.worker_stop = "unconfirmed";
      const run = await entry.selected.worker.run({ request, task_id: id, workspace: workspace.path, policy: this.policy,
        prompt: assignmentPrompt(request, id, workspace), signal: controller.signal,
        onEvent: (event) => this.#event(id, event),
        approve: async (approval, signal) => ({ choice_id: await this.inputs.request(id, { kind: "permission", approval: { ...approval, task_id: id, workspace: workspace!.path } }, approval.id, signal) }),
        input: (question, attention = false, nativeId, choices, inputSignal) => this.inputs.request(id, { kind: "clarification", question, attention, ...(choices ? { choices: [...choices] } : {}) }, nativeId ?? `clarification:${randomUUID()}`, inputSignal ? AbortSignal.any([controller.signal, inputSignal]) : controller.signal),
      });
      workerSettled = true;
      result = { ...result, execution_status: run.status, worker_stop: run.worker_stop, worker_assessment: run.worker_assessment,
        summary: run.summary, blockers: run.blockers, questions: run.questions, checks: run.checks,
        model: { ...(record.execution.requested_model ? { requested: record.execution.requested_model } : {}), ...(run.reported_model ? { reported: run.reported_model } : {}) }, ...(run.error ? { error: run.error } : {}) };
      const state = await this.store.readControl(id);
      if (state.cancel) result.execution_status = "cancelled";
      if (run.status === "completed" && !state.cancel && (state.native.coverage !== "turn_scoped" || state.native.obligations.length || state.inputs.some((i) => i.state === "pending" || i.state === "answer_intent" || i.state === "delivery_unknown"))) {
        result.execution_status = "failed"; result.error = { code: "COMPLETION_EVIDENCE_MISSING", message: "Native completion did not account for required obligations" };
      }
      if (run.worker_stop === "unconfirmed") {
        if (result.execution_status === "completed") result.execution_status = "interrupted";
        await this.#freeze(`Task ${id} has unconfirmed native shutdown`);
      } else {
        await phase("finalizing");
        // Accounted-for native stop permits collection independent of execution cancellation.
        const collection = { ...workspace };
        delete collection.signal;
        this.assertAuthority();
        result.delivery = await observeDelivery(collection, run.no_changes_reason);
        result.workspace.stale = request.mode === "review" && (JSON.stringify(before) !== JSON.stringify(await digestFiles(workspace.path, request.context_files ?? [], true))
          || JSON.stringify(beforeStatus) !== JSON.stringify(await sourceStatus(workspace.path)) || revision !== await currentRevision(workspace.path));
        const changes = await collectChanges(collection); result.changed_files = changes.map((c) => c.path).sort();
        const paths = [...new Set(changes.flatMap((c) => c.old_path ? [c.old_path, c.path] : [c.path]))];
        const outside = request.allowed_paths ? paths.filter((p) => !request.allowed_paths!.some((a) => p === a || p.startsWith(`${a.replace(/\/$/, "")}/`))) : [];
        if (outside.length) result.blockers.push(`Changes outside allowed_paths require caller review: ${outside.join(", ").slice(0, 1800)}`);
        if (request.mode === "implement") await this.#artifacts(id, collection, result, changes);
        const owned = await this.store.readResource(id);
        if (owned && result.delivery.head_commit) await this.store.writeResource(id, { ...owned, head_commit: result.delivery.head_commit, updated_at: now() });
      }
    } catch (error) {
      const detail = errorInfo(error);
      if (detail.code === "GIT_STOP_UNCONFIRMED") result.worker_stop = "unconfirmed";
      result.error = workerSettled ? { code: "FINALIZATION_FAILED", message: detail.message } : detail; result.summary = detail.message;
      result.execution_status = controller.signal.aborted ? "cancelled" : "failed";
      if (workerSettled) result.blockers.push("Delivery collection failed; preserve the worktree and evidence");
    }
    if (!await this.store.readResource(id)) await this.store.writeResource(id, { schema_version: 1, task_id: id, project_id: this.projectId, state: "not_applicable", updated_at: now() });
    if (result.worker_stop === "unconfirmed" && result.execution_status === "completed") result.execution_status = "interrupted";
    // Serialize cancellation versus successful settlement at the same state owner. No provider callback runs here.
    await this.controls.change(id, (s) => { if (s.cancel) result.execution_status = "cancelled"; s.phase = "finalizing"; s.settled_outcome = result.execution_status; });
    let state = await this.store.readControl(id);
    result.native_evidence = structuredClone(state.native);
    result.native_evidence.state = result.worker_stop === "confirmed" ? "stopped" : result.worker_stop === "not_started" ? "not_started" : "unknown";
    await this.store.writeResult(id, result);
    await this.controls.change(id, (s) => {
      s.native = result.native_evidence;
      for (const input of s.inputs) {
        delete input.claim;
        if (input.state === "pending") input.state = "withdrawn";
        if (input.state === "answer_intent") input.state = "delivery_unknown";
      }
      if (result.worker_stop === "unconfirmed" || s.inputs.some((i) => i.state === "delivery_unknown")) { s.phase = "needs_attention"; s.attention = "Native shutdown or input delivery remains unconfirmed; explicit reconciliation is required"; }
      else { s.phase = "terminal"; s.outcome = result.execution_status; }
    });
    if (result.worker_stop === "unconfirmed" || (await this.store.readControl(id)).inputs.some((i) => i.state === "delivery_unknown")) await this.#freeze(`Task ${id} has unconfirmed shutdown or input delivery`);
  }
  async #artifacts(id: string, workspace: Workspace, result: LifecycleResult, changes: Awaited<ReturnType<typeof collectChanges>>): Promise<void> {
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
  closeAdmission(): void { this.#closing = true; }
  async waitForIdle(): Promise<void> {
    do { await this.#admission.idle(); await Promise.all([...this.#entries.values()].map((e) => e.done)); await this.#admission.idle(); } while (this.#entries.size);
    await this.administration.idle();
  }
  async shutdown(): Promise<void> {
    this.closeAdmission();
    if (this.#frozen) {
      const queued = await this.#admission.run(() => { const q = this.#queue; this.#queue = []; for (const e of q) this.#entries.delete(e.record.task_id); return q; });
      for (const e of queued) {
        await this.controls.change(e.record.task_id, (s) => { s.phase = "needs_attention"; s.attention = "Recovered queued work: retained during explicit frozen-service shutdown; cancel explicitly before resubmitting"; });
        e.resolve();
      }
    }
    await this.waitForIdle();
  }
  async authorityLost(reason: unknown): Promise<void> {
    this.closeAdmission(); this.#frozen = errorInfo(reason).message;
    // Lease compromise is independent failure/containment authority, not a caller timeout.
    for (const entry of this.#entries.values()) entry.controller.abort(reason);
    this.#kick(); await this.waitForIdle();
  }
}
