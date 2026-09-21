import { join, resolve } from "node:path";
import type { DelegateRequest, DelegateResult, FinalizeOperation, ResultRequest, StoredResult } from "../contracts/types.js";
import type { RuntimeBinding, RuntimeIdentity, RuntimeStatus } from "../contracts/runtime.js";
import type { TaskStore } from "../store/task-store.js";
import type { Coordinator } from "./coordinator.js";
import type { AdapterDefinition } from "../agents/types.js";
import type { Assignment, AgentCatalog } from "../contracts/agents.js";
import type { AgentRegistry } from "../agents/registry.js";
import { TaskControls, owns, type ClientActor } from "./task-control.js";
import type { SharedProfile, TaskObservation, SubmissionIdentity } from "../contracts/tasks.js";

import type { RepositoryLease } from "./lease.js";
import { BridgeError, diagnosticInfo, errorInfo, filesystemFailure } from "./errors.js";
import { Mutex, withAbort, canonicalHash } from "./async.js";

const PREPARATION_TIMEOUT_MS = 90_000;
export type LaunchIntent = {
  project: string; profilePath?: string; stateRoot?: string; expectedRepositoryId?: string;
};
export type ResolvedBinding = {
  project: string; repositoryId: string; commonDir: string; stateRoot: string; storeRoot: string; profilePath?: string;
};
// Binding consults only HOME/XDG keys; callers may supply a read-only environment map.
type Environment = Readonly<Record<string, string | undefined>>;
export type RuntimeDependencies = {
  resolveBinding?: (intent: LaunchIntent, environment: Environment, signal: AbortSignal) => Promise<ResolvedBinding>;
  acquire?: (path: string, signal: AbortSignal, compromised: (error: BridgeError) => void) => Promise<RepositoryLease>;
  store?: (root: string, authority: () => void) => TaskStore;
  recover?: (store: TaskStore) => Promise<void>;
  legacyRoots?: (binding: ResolvedBinding, signal: AbortSignal) => Promise<string[]>;
  profile?: (path: string) => Promise<SharedProfile>;
  definitions?: Readonly<Record<string, AdapterDefinition>>;
};

export async function resolveRepositoryBinding(intent: LaunchIntent, environment: Environment, signal: AbortSignal): Promise<ResolvedBinding> {
  const { canonicalProject, repositoryIdentity, projectId } = await import("../workspace/project.js");
  signal.throwIfAborted();
  let project: string;
  try { project = await canonicalProject(intent.project); }
  catch (error) { throw filesystemFailure(error, "project.resolve", intent.project); }
  const repository = await repositoryIdentity(project, signal);
  signal.throwIfAborted();
  if (intent.expectedRepositoryId && repository.id !== intent.expectedRepositoryId) {
    throw new BridgeError("PROJECT_BINDING_CHANGED", "The project no longer resolves to its registered repository", {
      stage: "project.identity", path: project, next_action: "Inspect the project move or alias and explicitly register the intended binding.",
    });
  }
  const stateRoot = intent.stateRoot ?? environment.XDG_STATE_HOME ?? (environment.HOME ? join(environment.HOME, ".local", "state") : undefined);
  const configRoot = environment.XDG_CONFIG_HOME ?? (environment.HOME ? join(environment.HOME, ".config") : undefined);
  if (!stateRoot) throw new BridgeError("PATH_CONFIGURATION_UNAVAILABLE", "An explicit state path or HOME/XDG state root is required", { stage: "configuration.paths" });
  const profilePath = intent.profilePath ?? (configRoot ? join(configRoot, "muse-bridge", "projects", `${projectId(project)}.json`) : undefined);
  return {
    project, repositoryId: repository.id, commonDir: repository.common_dir, stateRoot: resolve(stateRoot),
    storeRoot: join(resolve(stateRoot), "muse-bridge", "repositories", repository.id),
    ...(profilePath ? { profilePath: resolve(profilePath) } : {}),
  };
}

/** Owns preparation, authority, lazy execution composition, and terminal drain for one repository service. */
export class RepositoryRuntime {
  readonly #intent: LaunchIntent;
  readonly #identity: RuntimeIdentity;
  readonly #environment: Environment;
  readonly #deps: RuntimeDependencies;
  readonly #lifetime = new AbortController();
  readonly #administration = new Mutex();
  readonly #pending = new Set<Promise<unknown>>();
  #phase: RuntimeStatus["coordination"]["state"] = "idle";
  #failure: ReturnType<typeof diagnosticInfo> | undefined;
  #executionFailure: ReturnType<typeof diagnosticInfo> | undefined;
  #checkedAt: string | undefined;
  #binding: ResolvedBinding | undefined;
  #lease: RepositoryLease | undefined;
  #store: TaskStore | undefined;
  #preparation: Promise<void> | undefined;
  #profile: SharedProfile | undefined;
  #registry: AgentRegistry | undefined;
  #profileLoading: Promise<SharedProfile> | undefined;
  #coordinator: Coordinator | undefined;
  #admissionClosed = false;
  #controls: TaskControls | undefined;
  onSettled?: () => void;
  #composition: Promise<Coordinator> | undefined;
  #shutdown: Promise<void> | undefined;
  #containment: Promise<void> | undefined;

  constructor(intent: LaunchIntent, identity: RuntimeIdentity, dependencies: RuntimeDependencies = {}, environment: Environment = process.env) {
    this.#intent = { ...intent };
    this.#identity = { ...identity };
    this.#deps = dependencies;
    this.#environment = { HOME: environment.HOME, XDG_STATE_HOME: environment.XDG_STATE_HOME, XDG_CONFIG_HOME: environment.XDG_CONFIG_HOME };
  }
  get configuredProfile() { return this.#profile; }
  get binding() { return this.#binding; }
  status(): RuntimeStatus {
    const resolved = this.#binding;
    const coordinatorFailure = this.#coordinator?.frozenReason;
    const phase = coordinatorFailure && this.#phase === "ready" ? "frozen" : this.#phase;
    const binding: RuntimeBinding = {
      project_input: this.#intent.project,
      ...(this.#intent.profilePath ? { profile_path: this.#intent.profilePath } : {}),
      ...(this.#intent.stateRoot ? { state_root: this.#intent.stateRoot } : {}),
      ...(this.#intent.expectedRepositoryId ? { expected_repository_id: this.#intent.expectedRepositoryId } : {}),
      ...(resolved ? { project: resolved.project, repository_id: resolved.repositoryId, common_dir: resolved.commonDir,
        ...(resolved.profilePath ? { profile_path: resolved.profilePath } : {}), state_root: resolved.stateRoot, store_root: resolved.storeRoot } : {}),
    };
    return {
      schema_version: 1, runtime: { ...this.#identity }, binding,
      coordination: { state: phase, authority: this.#lease?.state ?? "not_acquired",
        ...(this.#checkedAt ? { checked_at: this.#checkedAt } : {}), ...(this.#failure ? { failure: { ...this.#failure } } : coordinatorFailure ? { failure: diagnosticInfo(new BridgeError("PROJECT_NEEDS_RECONCILIATION", coordinatorFailure)) } : {}) },
      execution: { profile: this.#profile ? "valid" : this.#executionFailure ? "blocked" : "not_checked",
        provider: "not_checked", approval: "not_checked",
        ...(this.#executionFailure ? { failure: { ...this.#executionFailure } } : {}) },
    };
  }
  #assertOpen(): void {
    if (this.#phase === "closing" || this.#phase === "closed" || this.#lifetime.signal.aborted) {
      throw new BridgeError("BRIDGE_CLOSING", "The repository runtime is closing", { stage: "runtime.admission" });
    }
  }
  #failureError(): BridgeError {
    return new BridgeError(this.#failure?.code ?? "PROJECT_NEEDS_RECONCILIATION", this.#failure?.message ?? "Repository readiness is unavailable");
  }
  #assertAuthority(): void {
    if (!this.#lease) throw new BridgeError("LEASE_NOT_HELD", "Repository coordination authority has not been acquired");
    this.#lease.assertOwned();
  }
  #track<T>(work: () => Promise<T>): Promise<T> {
    this.#assertOpen();
    const promise = work();
    this.#pending.add(promise);
    void promise.then(() => this.#pending.delete(promise), () => this.#pending.delete(promise));
    return promise;
  }
  async #resolve(signal: AbortSignal): Promise<ResolvedBinding> {
    if (this.#binding) return this.#binding;
    const binding = await (this.#deps.resolveBinding ?? resolveRepositoryBinding)(this.#intent, this.#environment, signal);
    signal.throwIfAborted();
    this.#binding = binding;
    return binding;
  }
  async #legacy(binding: ResolvedBinding, signal: AbortSignal): Promise<string[]> {
    if (this.#deps.legacyRoots) return this.#deps.legacyRoots(binding, signal);
    const { projectId } = await import("../workspace/project.js");
    const roots = [join(binding.stateRoot, "muse-bridge", "projects", projectId(binding.project))];
    if (binding.commonDir !== binding.project) {
      const { worktreeEntries } = await import("../workspace/worktree.js");
      for (const entry of await worktreeEntries(binding.project, signal)) roots.push(join(binding.stateRoot, "muse-bridge", "projects", projectId(entry.path)));
    }
    return [...new Set(roots)];
  }
  #compromised = (error: BridgeError): void => {
    // Authority is already invalidated by the lease adapter before this notification.
    this.#failure = diagnosticInfo(error);
    if (this.#phase !== "closing" && this.#phase !== "closed") this.#phase = "frozen";
    if (!this.#containment) {
      this.#containment = this.#coordinator?.authorityLost(error) ?? Promise.resolve();
      void this.#containment.catch((failure: unknown) => { this.#failure = diagnosticInfo(failure); });
    }
  };
  async #initialize(allowFrozen: boolean): Promise<void> {
    const controller = new AbortController();
    const stop = () => controller.abort(this.#lifetime.signal.reason);
    this.#lifetime.signal.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(() => controller.abort(new BridgeError("PREPARATION_TIMEOUT", "Repository preparation exceeded its bounded budget", { stage: "runtime.prepare" })), PREPARATION_TIMEOUT_MS);
    let complete = false;
    try {
      const binding = await this.#resolve(controller.signal);
      const acquire = this.#deps.acquire ?? (async (path: string, signal: AbortSignal, compromised: (error: BridgeError) => void) => {
        const { acquireRepositoryLease } = await import("./lease.js");
        return acquireRepositoryLease(path, { signal, onCompromised: compromised });
      });
      this.#lease = await acquire(binding.storeRoot, controller.signal, this.#compromised);
      controller.signal.throwIfAborted(); this.#assertAuthority();
      const authority = () => { this.#assertAuthority(); if (!complete) controller.signal.throwIfAborted(); };
      this.#store = this.#deps.store ? this.#deps.store(binding.storeRoot, authority) : new (await import("../store/task-store.js")).TaskStore(binding.storeRoot, authority);
      await this.#store.initialize();
      this.#controls = new TaskControls(this.#store, 128, 512);
      for (const root of await this.#legacy(binding, controller.signal)) { authority(); await this.#store.importLegacy(root); }
      authority();
      if (this.#deps.recover) await this.#deps.recover(this.#store);
      else {
        const { reconcileStoredTasks } = await import("./recovery.js");
        await reconcileStoredTasks(this.#store);
      }
      authority();
      const frozen = await this.#store.frozenReason();
      authority();
      if (frozen && !allowFrozen) throw new BridgeError("PROJECT_NEEDS_RECONCILIATION", frozen, { stage: "runtime.recovery" });
      complete = true;
      this.#phase = frozen ? "frozen" : "ready";
      this.#failure = frozen ? diagnosticInfo(new BridgeError("PROJECT_NEEDS_RECONCILIATION", frozen, { stage: "runtime.recovery" })) : undefined;
      this.#checkedAt = new Date().toISOString();
    } catch (error) {
      this.#failure = diagnosticInfo(error); this.#checkedAt = new Date().toISOString();
      if (this.#phase !== "closing" && this.#phase !== "closed") this.#phase = this.#lease?.state === "lost" ? "frozen" : "blocked";
      // A late successful acquisition remains owned until its release has completed.
      if (this.#lease?.state === "held") {
        try { await this.#lease.release(); }
        catch (releaseError) { this.#failure = diagnosticInfo(releaseError); throw releaseError; }
      }
      this.#store = undefined;
      throw error;
    } finally {
      clearTimeout(timer); this.#lifetime.signal.removeEventListener("abort", stop);
    }
  }
  async #ensurePrepared(signal?: AbortSignal, allowFrozen = false): Promise<void> {
    signal?.throwIfAborted(); this.#assertOpen();
    if (this.#lease?.state === "lost") throw this.#failureError();
    if (this.#phase === "ready") {
      this.#assertAuthority();
      const frozen = this.#coordinator?.frozenReason;
      if (frozen && !allowFrozen) throw new BridgeError("PROJECT_NEEDS_RECONCILIATION", frozen);
      return;
    }
    if (this.#phase === "blocked" && this.#lease?.state === "held") throw this.#failureError();
    if (this.#phase === "frozen" && this.#lease?.state === "held") {
      if (allowFrozen) return;
      throw this.#failureError();
    }
    if (!this.#preparation) {
      this.#phase = "preparing";
      const attempt = this.#initialize(allowFrozen);
      this.#preparation = attempt;
      void attempt.then(() => { if (this.#preparation === attempt) this.#preparation = undefined; },
        () => { if (this.#preparation === attempt) this.#preparation = undefined; });
    }
    if (signal) await withAbort(this.#preparation, signal); else await this.#preparation;
    this.#assertOpen(); this.#assertAuthority();
    if (!allowFrozen && this.status().coordination.state !== "ready") throw this.#failureError();
  }
  prepare(signal?: AbortSignal): Promise<RuntimeStatus> {
    return this.#track(async () => { await this.#ensurePrepared(signal); return this.status(); });
  }
  async #execution(): Promise<Coordinator> {
    this.#assertOpen();
    if (this.#coordinator) return this.#coordinator;
    if (!this.#composition) {
      this.#composition = (async () => {
        const binding = await this.#resolve(this.#lifetime.signal);
        const profilePath = binding.profilePath;
        if (!profilePath) throw new BridgeError("PROFILE_PATH_UNAVAILABLE", "Execution requires an explicit profile path or configured HOME/XDG config root", { stage: "execution.profile" });
        if (!this.#profileLoading) {
          this.#profileLoading = this.#deps.profile ? this.#deps.profile(profilePath)
            : import("./profile.js").then(({ loadSharedProfile }) => loadSharedProfile(profilePath));
        }
        const profile = await this.#profileLoading;
        this.#assertOpen();
        await this.#ensurePrepared(this.#lifetime.signal);
        const { Coordinator } = await import("./coordinator.js");
        const { AgentRegistry } = await import("../agents/registry.js");
        const definitions = this.#deps.definitions ?? (await import("../agents/builtins.js")).builtinAdapters;
        const registry = new AgentRegistry(profile, definitions);
        this.#assertOpen(); this.#assertAuthority();
        this.#coordinator = new Coordinator(binding.project, binding.repositoryId, profile.execution, this.#store!, registry, () => this.#assertAuthority(), this.#controls);
        this.#coordinator.onSettled = () => this.onSettled?.();
        this.#controls!.maxWaiters = profile.execution.max_waiters; this.#controls!.maxReceipts = profile.execution.max_control_receipts;
        this.#profile = profile; this.#registry = registry;
        this.#executionFailure = undefined;
        return this.#coordinator;
      })();
      void this.#composition.catch((error: unknown) => {
        this.#executionFailure = diagnosticInfo(error);
        this.#composition = undefined;
        if (!this.#profile) this.#profileLoading = undefined;
      });
    }
    return this.#composition;
  }
  agents(offset = 0, limit = 4): Promise<AgentCatalog> {
    return this.#track(async () => {
      if (this.#registry) return this.#registry.catalog(true, offset, limit);
      const path = this.#intent.profilePath ?? (await this.#resolve(this.#lifetime.signal)).profilePath;
      if (!path) throw new BridgeError("PROFILE_PATH_UNAVAILABLE", "Agent discovery requires a profile path");
      const profile = this.#deps.profile ? await this.#deps.profile(path) : await (await import("./profile.js")).loadSharedProfile(path);
      const { AgentRegistry } = await import("../agents/registry.js");
      const definitions = this.#deps.definitions ?? (await import("../agents/builtins.js")).builtinAdapters;
      this.#assertOpen();
      return new AgentRegistry(profile, definitions).catalog(false, offset, limit);
    });
  }
  async #taskControls(): Promise<TaskControls> {
    await this.#ensurePrepared(undefined, true);
    return this.#controls!;
  }
  async submit(request: Assignment, actor: ClientActor, sourceView: string, signal: AbortSignal): Promise<TaskObservation> {
    return this.#track(async () => {
      const { canonicalProject, repositoryIdentity } = await import("../workspace/project.js");
      const source = await canonicalProject(sourceView), binding = await this.#resolve(signal);
      if ((await repositoryIdentity(source, signal)).id !== binding.repositoryId) throw new BridgeError("SOURCE_VIEW_CONFLICT", "Source view is not part of this repository");
      const identity: SubmissionIdentity = { schema_version: 1, source_view: source, assignment: request };
      const controls = await this.#taskControls();
      const prior = await this.#store!.find({ request_key: request.request_key });
      if (prior) {
        if (!("schema_version" in prior)) throw new BridgeError("LEGACY_REQUEST_KEY", "This key names historical execution; read it without replay");
        owns(await this.#store!.readControl(prior.task_id), actor);
        if (prior.canonical_hash !== canonicalHash(identity)) throw new BridgeError("REQUEST_KEY_CONFLICT", "The key names a different assignment or source view");
        return controls.read(prior.task_id, actor);
      }
      if (this.#admissionClosed) throw new BridgeError("SERVICE_DRAINING", "Service admission is closed");
      const coordinator = await this.#execution();
      if (this.#admissionClosed) { coordinator.closeAdmission(); throw new BridgeError("SERVICE_DRAINING", "Service admission closed during preparation"); }
      return coordinator.submit(identity, actor, signal);
    });
  }
  async retainedTaskId(requestKey: string): Promise<string> {
    const record = await (await this.#readStore()).find({ request_key: requestKey });
    if (!record) throw new BridgeError("RESULT_NOT_FOUND", "No matching retained request");
    return record.task_id;
  }
  async taskObservation(id: string, actor: ClientActor): Promise<TaskObservation> { return (await this.#taskControls()).read(id, actor); }
  async taskId(key: { task_id?: string | undefined; request_key?: string | undefined }): Promise<string> {
    const record = await (await this.#readStore()).find(key.task_id ? { task_id: key.task_id } : { request_key: key.request_key! });
    if (!record || !("schema_version" in record)) throw new BridgeError("TASK_NOT_FOUND", "No durable task matches; historical results use the retained-result tool");
    return record.task_id;
  }
  async tasks(actor: ClientActor, offset: number, limit: number, requestKey?: string): Promise<{ total: number; offset: number; tasks: TaskObservation[]; next_offset: number | null }> {
    const controls = await this.#taskControls();
    const records = (await this.#store!.list()).filter((r) => "schema_version" in r && (!requestKey || r.request.request_key === requestKey));
    const visible: TaskObservation[] = [];
    for (const r of records) {
      if ((await this.#store!.readControl(r.task_id)).owner_id === actor.owner_id) visible.push(await controls.read(r.task_id, actor));
    }
    if (offset > visible.length) throw new BridgeError("INVALID_RANGE", "Task page offset is beyond the authorized inventory");
    const tasks: TaskObservation[] = []; let bytes = 256;
    for (const task of visible.slice(offset, offset + limit)) {
      const size = Buffer.byteLength(JSON.stringify(task));
      if (tasks.length && bytes + size > 16_384) break;
      if (size > 20_000) throw new BridgeError("OBSERVATION_LIMIT", "A task observation exceeds its bounded projection");
      tasks.push(task); bytes += size;
    }
    return { total: visible.length, offset, tasks, next_offset: offset + tasks.length < visible.length ? offset + tasks.length : null };
  }
  async waitTask(id: string, actor: ClientActor, after: number, budget: number, signal: AbortSignal) {
    return (await this.#taskControls()).wait(id, actor, after, budget, signal);
  }
  async authorizeTask(id: string, actor: ClientActor): Promise<void> {
    const store = await this.#readStore(), record = await store.find({ task_id: id });
    if (record && "schema_version" in record) owns(await store.readControl(id), actor);
  }
  async attachTask(key: { task_id?: string | undefined; request_key?: string | undefined }, actor: ClientActor, operation: string) {
    const controls = await this.#taskControls(), id = await this.taskId(key);
    const receipt = await controls.adopt(id, actor, operation);
    return { receipt, task: await controls.read(id, actor) };
  }
  async cancelTask(id: string, actor: ClientActor, generation: number, operation: string, reason: string) {
    const controls = await this.#taskControls();
    if (this.#coordinator) return this.#coordinator.cancel(id, actor, generation, operation, reason);
    const receipt = await controls.cancel(id, actor, generation, operation, reason);
    const state = await this.#store!.readControl(id);
    if (state.native.state === "not_started" && state.attention?.startsWith("Recovered queued") && !await this.#store!.readResult(id)) {
      const record = await this.#store!.durableRequest(id), { baseResult } = await import("./result.js");
      const result = { ...baseResult(id, record.request, record.execution), execution_status: "cancelled" as const, summary: "Explicitly cancelled preserved never-started work", native_evidence: state.native };
      await this.#store!.writeResult(id, result);
      await controls.change(id, (s) => { s.phase = "terminal"; s.outcome = "cancelled"; delete s.attention; });
    }
    return receipt;
  }
  inputBroker() {
    if (!this.#coordinator) throw new BridgeError("INPUT_RUNTIME_UNAVAILABLE", "No live native input callback exists; inspect/reconcile the retained task");
    return this.#coordinator.inputs;
  }
  async detachClient(clientId: string): Promise<void> {
    if (!this.#controls || !this.#store) return;
    for (const record of await this.#store.list()) if ("schema_version" in record) await this.#controls.releaseClient(record.task_id, clientId);
  }
  async hasObligations(): Promise<boolean> {
    if (this.#preparation || this.#composition && !this.#coordinator || this.#pending.size || this.#coordinator?.outstandingCount) return true;
    if (!this.#store) return false;
    for (const record of await this.#store.list()) if ((await this.#store.readState(record.task_id)).phase !== "terminal") return true;
    return false;
  }
  async stopAdmission(): Promise<void> { this.#admissionClosed = true; this.#coordinator?.closeAdmission(); }
  async drain(): Promise<void> { if (this.#coordinator) await this.#coordinator.shutdown(); }
  async #readStore(): Promise<TaskStore> {
    this.#assertOpen();
    if (this.#store) return this.#store;
    const binding = await this.#resolve(this.#lifetime.signal);
    const readOnly = () => { throw new BridgeError("READ_ONLY_STORE", "History access cannot mutate repository state"); };
    if (this.#deps.store) return this.#deps.store(binding.storeRoot, readOnly);
    const { TaskStore } = await import("../store/task-store.js");
    return new TaskStore(binding.storeRoot, readOnly);
  }
  resource(taskId: string) { return this.#track(async () => (await this.#readStore()).readResource(taskId)); }
  retained(request: ResultRequest) {
    return this.#track(async () => {
      const store = await this.#readStore();
      const record = await store.find(request.task_id ? { task_id: request.task_id } : { request_key: request.request_key! });
      if (!record) throw new BridgeError("RESULT_NOT_FOUND", "No matching task");
      const result = await store.readResult(record.task_id);
      if (!result) throw new BridgeError("RESULT_NOT_READY", "No terminal result is available");
      const resource = await store.readResource(record.task_id);
      const buffer = request.artifact_id ? await store.readArtifact(record.task_id, request.artifact_id, request.offset, request.limit)
        : await store.readSlice(record.task_id, request.section ?? "result", request.offset, request.limit);
      return { task_id: record.task_id, resource, buffer };
    });
  }
  inspect() {
    return this.#track(async () => {
      const store = await this.#readStore();
      const records = await store.list();
      return { repository: this.#binding, frozen: await store.frozenReason(), tasks: await Promise.all(records.map(async (record) => ({
        task_id: record.task_id, request_key: record.request.request_key, state: await store.readState(record.task_id),
        resource: await store.readResource(record.task_id) ?? { state: "legacy_unclassified" },
      }))), note: "Inspection does not migrate or repair records; resource observations are not a transaction-wide snapshot." };
    });
  }
  result(taskId: string): Promise<{ result: StoredResult | undefined; resource: unknown }> {
    return this.#track(async () => {
      const store = await this.#readStore();
      const record = await store.find({ task_id: taskId });
      if (!record) throw new BridgeError("RESULT_NOT_FOUND", "Task not found");
      return { result: await store.readResult(taskId), resource: await store.readResource(taskId) ?? { state: "legacy_unclassified" } };
    });
  }
  logs(taskId: string, offset: number, limit = 24_576): Promise<Buffer> {
    return this.#track(async () => (await this.#readStore()).readSlice(taskId, "log", offset, limit));
  }
  finalize(operations: FinalizeOperation[], signal?: AbortSignal) {
    return this.#track(async () => {
      await this.#ensurePrepared(signal);
      const { DispositionManager } = await import("./disposition.js");
      const runtime = this;
      const manager = new DispositionManager(this.#binding!.project, this.#binding!.repositoryId, this.#store!, this.#coordinator ?? {
        administration: this.#administration, isActive: () => false,
        async assertMutationAllowed() {
          runtime.#assertOpen(); runtime.#assertAuthority();
          const frozen = await runtime.#store!.frozenReason();
          if (frozen) throw new BridgeError("PROJECT_NEEDS_RECONCILIATION", frozen);
        },
      }, () => this.#assertAuthority());
      const results = [];
      for (const operation of operations) {
        signal?.throwIfAborted(); this.#assertOpen(); this.#assertAuthority();
        try { results.push({ task_id: operation.task_id, operation_key: operation.operation_key, receipt: await manager.finalize(operation) }); }
        catch (error) { results.push({ task_id: operation.task_id, operation_key: operation.operation_key, error: diagnosticInfo(error) }); }
      }
      return results;
    });
  }
  cleanup(taskId: string): Promise<void> {
    return this.#track(async () => {
      await this.#ensurePrepared(); this.#assertOpen(); this.#assertAuthority();
      const { cleanupTask } = await import("./cleanup.js");
      await cleanupTask({ store: this.#store!, taskId, assertAuthority: () => this.#assertAuthority() });
    });
  }
  reconcile(taskId: string, owner: string, reason: string): Promise<void> {
    return this.#track(async () => {
      if (this.#coordinator?.isActive(taskId)) throw new BridgeError("TASK_ACTIVE", "A live task cannot be reconciled as stopped");
      // Only the operator CLI exposes this explicitly authorized recovery operation.
      await this.#ensurePrepared(undefined, true); this.#assertOpen(); this.#assertAuthority();
      const { acknowledgeStoppedTask } = await import("./recovery.js");
      await acknowledgeStoppedTask(this.#store!, taskId, owner, reason);
      const remaining = await this.#store!.frozenReason();
      this.#phase = remaining ? "frozen" : "ready";
      this.#failure = remaining ? diagnosticInfo(new BridgeError("PROJECT_NEEDS_RECONCILIATION", remaining)) : undefined;
    });
  }
  shutdown(reason: unknown = new BridgeError("BRIDGE_CLOSING", "Connection closed")): Promise<void> {
    return this.#shutdown ??= (async () => {
      this.#phase = "closing";
      this.#lifetime.abort(reason);
      const startup: Promise<unknown>[] = [];
      if (this.#preparation) startup.push(this.#preparation);
      if (this.#composition) startup.push(this.#composition);
      await Promise.allSettled(startup);
      const outcomes = await Promise.allSettled([
        ...(this.#coordinator ? [this.#coordinator.shutdown()] : []),
        ...(this.#containment ? [this.#containment] : []),
      ]);
      await Promise.allSettled([...this.#pending]);
      try {
        if (this.#lease?.state === "held") await this.#lease.release();
        const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
        if (failure) throw failure.reason;
      } finally { this.#phase = "closed"; }
    })();
  }
}
