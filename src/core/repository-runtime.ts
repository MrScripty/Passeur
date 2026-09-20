import { join, resolve } from "node:path";
import type { DelegateRequest, DelegateResult, FinalizeOperation, ResultRequest, StoredResult } from "../contracts/types.js";
import type { RuntimeBinding, RuntimeIdentity, RuntimeStatus } from "../contracts/runtime.js";
import type { TaskStore } from "../store/task-store.js";
import type { Coordinator, RunContext } from "./coordinator.js";
import type { AdapterDefinition } from "../agents/types.js";
import type { AgentProfile, Assignment, AgentResult, AgentCatalog } from "../contracts/agents.js";
import type { AgentRegistry } from "../agents/registry.js";
import { lookupPriorTask, terminalPriorTask } from "./prior-task.js";
import { legacyMuseResult } from "./result.js";
import type { RepositoryLease } from "./lease.js";
import { BridgeError, diagnosticInfo, errorInfo, filesystemFailure } from "./errors.js";
import { Mutex, withAbort, stableHash } from "./async.js";

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
  profile?: (path: string) => Promise<AgentProfile>;
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

/** Owns preparation, authority, lazy execution composition, and terminal drain for one connection. */
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
  #profile: AgentProfile | undefined;
  #registry: AgentRegistry | undefined;
  #profileLoading: Promise<AgentProfile> | undefined;
  #coordinator: Coordinator | undefined;
  #composition: Promise<Coordinator> | undefined;
  #shutdown: Promise<void> | undefined;
  #approval: RuntimeStatus["execution"]["approval"] = "not_checked";
  #containment: Promise<void> | undefined;

  constructor(intent: LaunchIntent, identity: RuntimeIdentity, dependencies: RuntimeDependencies = {}, environment: Environment = process.env) {
    this.#intent = { ...intent };
    this.#identity = { ...identity };
    this.#deps = dependencies;
    this.#environment = { HOME: environment.HOME, XDG_STATE_HOME: environment.XDG_STATE_HOME, XDG_CONFIG_HOME: environment.XDG_CONFIG_HOME };
  }
  approvalTimeoutMs(): number { return this.#profile?.execution.task_timeout_ms ?? 1_800_000; }
  observeApproval(available: boolean): void { this.#approval = available ? "available" : "unavailable"; }
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
        provider: "not_checked", approval: this.#approval,
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
      this.#containment = this.#coordinator?.shutdown(error) ?? Promise.resolve();
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
            : import("./profile.js").then(({ loadAgentProfile }) => loadAgentProfile(profilePath));
        }
        const profile = await this.#profileLoading;
        this.#assertOpen();
        await this.#ensurePrepared(this.#lifetime.signal);
        const { Coordinator } = await import("./coordinator.js");
        const { AgentRegistry } = await import("../agents/registry.js");
        const definitions = this.#deps.definitions ?? (await import("../agents/builtins.js")).builtinAdapters;
        const registry = new AgentRegistry(profile, definitions);
        this.#assertOpen(); this.#assertAuthority();
        this.#coordinator = new Coordinator(binding.project, binding.repositoryId, profile.execution, this.#store!, registry, () => this.#assertAuthority());
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
      const profile = this.#deps.profile ? await this.#deps.profile(path) : await (await import("./profile.js")).loadAgentProfile(path);
      const { AgentRegistry } = await import("../agents/registry.js");
      const definitions = this.#deps.definitions ?? (await import("../agents/builtins.js")).builtinAdapters;
      this.#assertOpen();
      return new AgentRegistry(profile, definitions).catalog(false, offset, limit);
    });
  }
  delegate(request: Assignment, context: RunContext): Promise<AgentResult> {
    return this.#track(async () => {
      context.signal.throwIfAborted();
      if (!this.#coordinator) {
        const prior = await lookupPriorTask(await this.#readStore(), request);
        // Composition may have finished during the read. Its live-task map owns subscriber attachment.
        if (!this.#coordinator) {
          const result = terminalPriorTask(prior);
          context.signal.throwIfAborted();
          if (result) return result;
          if (this.#approval !== "available") throw new BridgeError("ELICITATION_UNAVAILABLE", "New execution requires human approval capability");
        }
      }
      const coordinator = this.#coordinator ?? await withAbort(this.#execution(), context.signal);
      context.signal.throwIfAborted(); this.#assertOpen();
      return coordinator.delegate(request, { ...context, approvalAvailable: this.#approval === "available" });
    });
  }
  delegateBatch(assignments: Assignment[], context: RunContext): Promise<Array<{ request_key: string; result?: AgentResult; error?: { code: string; message: string } }>> {
    return this.#track(async () => {
      if (!assignments.length || assignments.length > 8 || new Set(assignments.map((item) => item.request_key)).size !== assignments.length) throw new BridgeError("INVALID_BATCH", "Supply one to eight unique request keys");
      return Promise.all(assignments.map(async (request) => {
        try { return { request_key: request.request_key, result: await this.delegate(request, context) }; }
        catch (error) { return { request_key: request.request_key, error: errorInfo(error) }; }
      }));
    });
  }
  /** Deployed Muse v2 calls preserve their original retry comparison and representable result contract. */
  delegateMuse(request: DelegateRequest, context: RunContext): Promise<DelegateResult> {
    return this.#track(async () => {
      context.signal.throwIfAborted();
      const store = await this.#readStore();
      const previous = await store.find({ request_key: request.request_key });
      if (previous && previous.request.schema_version !== 3) {
        if (previous.request.schema_version !== 2) throw new BridgeError("LEGACY_REQUEST_KEY", "Read historical v1 work through passeur_result");
        if (previous.canonical_hash !== stableHash(request)) throw new BridgeError("REQUEST_KEY_CONFLICT", "The key belongs to a different assignment");
        const saved = await store.readResult(previous.task_id);
        if (!saved) throw new BridgeError("PROJECT_NEEDS_RECONCILIATION", "Historical execution lacks terminal evidence");
        if (saved.schema_version !== 2) throw new BridgeError("LEGACY_RESULT_UNREPRESENTABLE", "Read the versioned recovery evidence through passeur_result");
        context.signal.throwIfAborted();
        return saved;
      }
      const { museAssignment } = await import("../contracts/agents.js");
      return legacyMuseResult(await this.delegate(museAssignment(request), context));
    });
  }
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
        ...(this.#coordinator ? [this.#coordinator.shutdown(reason)] : []),
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
