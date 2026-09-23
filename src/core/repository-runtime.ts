import { isAbsolute, join, resolve } from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { CoordinationService, type CoordinationServiceLimits } from "../service/coordination.js";
import { decodeCoordinationRequest, coordinationRequestLane, type CoordinationReply } from "../contracts/coordination-service.js";
import type { CoordinationActor } from "../coordination/control.js";
import type { ManagedEnrollment } from "../coordination/bound-control.js";
import { managedTaskSource, managedWorkProjection } from "./managed-coordination.js";
import { parentId, type Region, type Work } from "../contracts/coordination-control.js";
import { operatorToken } from "../service/operator-token.js";
import { privateDirectory } from "../service/process.js";
import { assertExternalWorkspace } from "./coordination-resources.js";
import type { DelegateRequest, DelegateResult, FinalizeOperation, ResultRequest, StoredResult } from "../contracts/types.js";
import type { RuntimeBinding, RuntimeIdentity, RuntimeStatus } from "../contracts/runtime.js";
import type { TaskStore } from "../store/task-store.js";
import type { Coordinator } from "./coordinator.js";
import type { AdapterDefinition } from "../agents/types.js";
import type { Assignment, AgentCatalog } from "../contracts/agents.js";
import type { AgentRegistry } from "../agents/registry.js";
import { TaskControls, owns, type ClientActor } from "./task-control.js";
import { CoordinatedSubmissionIdentitySchema, coordinatedMaterialIdentity, type CoordinatedSubmissionIdentity, type SharedProfile, type TaskObservation, type SubmissionIdentity } from "../contracts/tasks.js";
import { operationSchemas, type CoordinatedSubmitSchema, type AnnouncementCreateSchema } from "../contracts/service.js";
import type { z } from "zod";
import { validateSourcePath } from "../observation/source.js";
import type { NativeAnalysisHelper } from "../observation/helper.js";
import type { NativeDialect } from "../observation/native-parser.js";
import { CapturedPairCache } from "../observation/cache.js";
import { ObservationMonitor, type ObservationJob, type ObservationWorkspace } from "../observation/monitor.js";
import { ObservationStore } from "../store/observation-store.js";
import { CorrespondenceIndex } from "../observation/correspondence.js";
import type { AttributedComparison, SourceFile } from "../observation/model.js";
import type { ObservationGeneration, ObservationPull } from "../contracts/observation.js";

import type { RepositoryLease } from "./lease.js";
import { BridgeError, diagnosticInfo, errorInfo, filesystemFailure } from "./errors.js";
import { Mutex, withAbort, canonicalHash } from "./async.js";

const PREPARATION_TIMEOUT_MS = 90_000;
// Initial safety bounds for metadata work, distinct from native inference capacity.
const coordinationLimits: CoordinationServiceLimits = Object.freeze({
  ordinary_requests: 16, control_requests: 4, max_source_operations: 4, max_worktrees: 256,
});
const coordinationResourceRecords = 4096;
type CoordinatedPublicRequest = z.output<typeof CoordinatedSubmitSchema>;
type AnnouncementPublicRequest = z.output<typeof AnnouncementCreateSchema>;
type PreparedCoordinated = Readonly<{ identity: CoordinatedSubmissionIdentity; input_oid: string; areas: Region[] }>;
type MonitoredPair = Readonly<{ report: AttributedComparison; input: SourceFile; observed: SourceFile }>;
type PendingCorrespondenceNotice = Readonly<{ artifactId: string; recipient: string; workId: string;
  subjectId: string; state: "overlap" | "resolved" }>;
function regionIncludesPath(regions: readonly Region[], path: string): boolean {
  return regions.some(region => region.path === path || region.kind === "subtree" && path.startsWith(`${region.path}/`));
}
function changedStructuralEvidence(report: AttributedComparison): boolean {
  const comparison = report.comparison;
  return comparison.region_changed || comparison.changes.some(change => change.kind !== "unobserved" &&
    (change.declaration_changed || change.body_changed || change.default_changed || change.kind === "added" || change.kind === "removed"));
}
function announcementId(owner: string, operationKey: string): string {
  const hex = createHash("sha256").update(`passeur-announcement-v1:${owner}:${operationKey}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
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
  readonly #obligationPending = new Set<Promise<unknown>>();
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
  #coordination: CoordinationService | undefined;
  #nativeAnalysis: NativeAnalysisHelper | undefined;
  #observationStore: ObservationStore | undefined;
  #observationMonitor: ObservationMonitor<readonly MonitoredPair[]> | undefined;
  #observationPreparing: Promise<void> | undefined;
  #observationResume: Promise<void> | undefined;
  #observationResuming = false;
  #observationStartupFailure: string | undefined;
  readonly #monitorEnabled: boolean;
  readonly #correspondence = new CorrespondenceIndex();
  readonly #publishedArtifactIds = new Map<string, Readonly<{ id: string; owner: string }>>();
  readonly #pendingCorrespondenceNotices = new Map<string, PendingCorrespondenceNotice>();
  readonly #observationFailures = new Map<string, string>();
  readonly #observationAttached = new Map<string, string>();
  readonly #observationAttaching = new Map<string, string>();
  readonly #observationAttachAbort = new Map<string, AbortController>();
  readonly #observationEpoch = new Map<string, number>();
  readonly #observationAttachTail = new Map<string, Promise<void>>();
  readonly #observationRehydrationGaps = new Set<string>();
  #observationOmittedCount = 0;
  readonly #capturedPairs = new CapturedPairCache();
  #captureSequence = 0;
  // Admit before any Git inventory or source read. The helper has its own bounded
  // queue, but waiting callers must not each retain captured source buffers.
  #structuralReportActive = false;
  readonly #taskAssociations = new Set<string>();
  #coordinationOrdinary = 0;
  #coordinationControls = 0;
  readonly #coordinatedAdmission = new Mutex();
  readonly #terminalBindingInFlight = new Set<string>();
  readonly #terminalBindingDone = new Set<string>();
  readonly #startupCoordinatedQueue: string[] = [];
  #startupCoordinatedFailure: ReturnType<typeof diagnosticInfo> | undefined;

  constructor(intent: LaunchIntent, identity: RuntimeIdentity, dependencies: RuntimeDependencies = {}, environment: Environment = process.env) {
    if (environment.PASSEUR_OBSERVATION_MONITOR !== undefined && environment.PASSEUR_OBSERVATION_MONITOR !== "on" &&
      environment.PASSEUR_OBSERVATION_MONITOR !== "off") {
      throw new BridgeError("STRUCTURAL_MONITOR_CONFIGURATION_INVALID", "PASSEUR_OBSERVATION_MONITOR must be on or off");
    }
    this.#intent = { ...intent };
    this.#identity = { ...identity };
    this.#deps = dependencies;
    this.#monitorEnabled = environment.PASSEUR_OBSERVATION_MONITOR !== "off";
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
  #track<T>(work: () => Promise<T>, obligation = true): Promise<T> {
    this.#assertOpen();
    const promise = work();
    this.#pending.add(promise);
    if (obligation) this.#obligationPending.add(promise);
    const settled = () => { this.#pending.delete(promise); this.#obligationPending.delete(promise); };
    void promise.then(settled, settled);
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
      // Crash recovery may find a committed v5 admission whose metadata/link or terminal
      // event was not settled. Process bounded batches without loading an execution profile.
      for (const record of await this.#store.list()) {
        if (!("schema_version" in record) || record.schema_version !== 5) continue;
        const link = await this.#store.readCoordinatedLink(record.task_id);
        const control = await this.#store.readControl(record.task_id);
        if (!link || control.phase === "terminal" || control.cancel && control.native.state === "not_started")
          this.#startupCoordinatedQueue.push(record.task_id);
      }
      if (this.#startupCoordinatedQueue.length) {
        const recovery = this.#track(() => this.#reconcileStartupCoordinated());
        void recovery.catch(error => { this.#startupCoordinatedFailure = diagnosticInfo(error); });
      }
      this.#observationResuming = true;
      const resume = this.#track(() => this.#resumeObservations(), false);
      this.#observationResume = resume;
      void resume.catch(error => { this.#observationStartupFailure = errorInfo(error).code; })
        .finally(() => { this.#observationResuming = false; });
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
  async #reconcileStartupCoordinated(): Promise<void> {
    let batch = 0;
    while (this.#startupCoordinatedQueue.length) {
      const taskId = this.#startupCoordinatedQueue[0]!;
      const record = await this.#store!.durableRequest(taskId);
      if (record.schema_version !== 5) throw new BridgeError("COORDINATION_LINK_CONFLICT", "Startup task ceased to be a coordinated admission");
      const control = await this.#store!.readControl(taskId);
      if (!await this.#store!.readCoordinatedLink(taskId) || control.cancel && control.native.state === "not_started" && control.phase !== "terminal") {
        const connection = { owner_id: record.initial_owner, source_view: record.source_view };
        const metadata = this.#coordinationSession(this.#binding!);
        let binding = await metadata.submissionBinding(connection, taskId);
        if (binding.task_id !== taskId || binding.request_key !== record.request.request_key ||
          binding.owner !== record.initial_owner || binding.intent_hash !== record.canonical_hash ||
          binding.decision_identity !== record.linkage.decision_identity || binding.link_hash !== record.linkage.link_hash ||
          binding.state === "released") throw new BridgeError("COORDINATION_LINK_CONFLICT", "Startup metadata binding differs from immutable task admission");
        if (binding.state === "bound") binding = await metadata.settleSubmission(connection, {
          operation_key: `passeur-internal:settle:${record.request.request_key}`, task_id: taskId,
          request_key: record.request.request_key, link_hash: record.linkage.link_hash });
        if (binding.state !== "settled" && binding.state !== "terminal") {
          throw new BridgeError("COORDINATION_BINDING_UNSETTLED", "Startup admission has no settled metadata binding");
        }
        const { reconcileCoordinatedRecord } = await import("./coordinator.js");
        await reconcileCoordinatedRecord(this.#store!, record, record.linkage, this.#controls);
      }
      if ((await this.#store!.readControl(taskId)).phase === "terminal") await this.#terminalBinding(taskId);
      this.#startupCoordinatedQueue.shift();
      if (++batch === 16) { batch = 0; await delay(0, undefined, { signal: this.#lifetime.signal }); }
    }
  }
  #assertCoordinatedReconciled(): void {
    if (this.#startupCoordinatedFailure) throw new BridgeError("COORDINATION_LINK_RECONCILIATION_REQUIRED",
      `Coordinated admission recovery stopped: ${this.#startupCoordinatedFailure.message}`);
    if (this.#startupCoordinatedQueue.length) throw new BridgeError("COORDINATION_LINK_RECONCILIATION_PENDING",
      "Coordinated admission recovery is in progress; retry the original operation after it completes");
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
  async #observation(): Promise<{ store: ObservationStore; monitor: ObservationMonitor<readonly MonitoredPair[]> }> {
    await this.#ensurePrepared();
    if (!this.#observationPreparing) this.#observationPreparing = (async () => {
      const metadata = await this.#coordinationSession(this.#binding!).observationStore();
      this.#observationStore = await ObservationStore.initialize(metadata, () => this.#assertAuthority());
      this.#observationMonitor = new ObservationMonitor<readonly MonitoredPair[]>({
        analyze: job => this.#analyzeObservation(job),
        publish: async (job, pairs, isCurrent) => {
          await this.#drainCorrespondenceNotices();
          for (const pair of pairs) {
            if (!isCurrent()) return;
            const work = await this.#currentSourceWork(pair.report.parent_id, job.workspace.work_id, "report");
            if (!isCurrent() || work.revision !== job.workspace.work_revision ||
              (work.managed && (await this.#store!.readControl(work.managed.task_id)).control_generation !== job.workspace.control_generation)) return;
            const path = pair.report.comparison.input.source.path;
            const recipients = changedStructuralEvidence(pair.report)
              ? (work.source_watches ?? []).filter(watch => watch.work_revision === work.revision &&
                regionIncludesPath(watch.regions, path) && (watch.recipient === work.owner ||
                  work.source_grants?.some(grant => grant.work_revision === work.revision && grant.recipient === watch.recipient)))
                .map(watch => watch.recipient) : [];
            const artifact = await this.#observationStore!.publish({ ...pair, work_revision: work.revision,
              workspace_generation: job.workspace.workspace_generation,
              control_generation: work.managed ? job.workspace.control_generation : null,
              recipients: [...new Set(recipients)] });
            const artifactKey = JSON.stringify([work.id, path]);
            this.#publishedArtifactIds.set(artifactKey, { id: artifact.id, owner: work.owner });
            if (this.#publishedArtifactIds.size > 512) this.#publishedArtifactIds.delete(this.#publishedArtifactIds.keys().next().value!);
            const correspondence = this.#correspondence.upsert(pair.report);
            for (const [state, events] of [["overlap", correspondence.pairs], ["resolved", correspondence.resolved]] as const) {
              for (const event of events) {
                this.#queueCorrespondenceNotice({ artifactId: artifact.id, recipient: work.owner, workId: work.id,
                  subjectId: event.subject_id, state });
                const other = this.#publishedArtifactIds.get(JSON.stringify([event.other_work_id, path]));
                if (other) this.#queueCorrespondenceNotice({ artifactId: other.id, recipient: other.owner,
                  workId: event.other_work_id, subjectId: event.subject_id, state });
              }
            }
            await this.#drainCorrespondenceNotices();
          }
        },
      });
    })().catch(error => { this.#observationPreparing = undefined; throw error; });
    await this.#observationPreparing;
    return { store: this.#observationStore!, monitor: this.#observationMonitor! };
  }
  async #currentSourceWork(recipient: string, workId: string, scope: "report" | "detail"): Promise<Work> {
    const work = await this.#coordinationSession(this.#binding!).authorizeSourceRead(recipient, workId, scope);
    if (work.managed) {
      const control = await this.#store!.readControl(work.managed.task_id);
      if (control.owner_id !== work.owner) {
        throw new BridgeError("STRUCTURAL_SOURCE_FORBIDDEN", "Managed source authority differs from current task ownership");
      }
    }
    return work;
  }
  async #authorizeObservation(recipient: string, workId: string, workRevision: number,
    generation: ObservationGeneration, scope: "report" | "detail"): Promise<void> {
    const work = await this.#currentSourceWork(recipient, workId, scope);
    if (work.revision !== workRevision) throw new BridgeError("STRUCTURAL_SOURCE_FORBIDDEN", "Source grant revision changed");
    if (work.managed) {
      const control = await this.#store!.readControl(work.managed.task_id);
      if (control.owner_id !== work.owner || control.control_generation !== generation.control_generation ||
        control.control_generation !== generation.workspace_generation)
        throw new BridgeError("STRUCTURAL_SOURCE_FORBIDDEN", "Managed source control generation changed");
    } else if (generation.control_generation !== null || generation.workspace_generation !== Math.max(1, work.revision)) {
      throw new BridgeError("STRUCTURAL_SOURCE_FORBIDDEN", "External source workspace generation changed");
    }
  }
  async #observationWorkspace(work: Work): Promise<ObservationWorkspace> {
    const { CoordinationRepository } = await import("../coordination/repository.js");
    const repository = await CoordinationRepository.open(this.#binding!.project, this.#binding!.repositoryId,
      coordinationLimits.max_worktrees, this.#lifetime.signal);
    const workspace = (await repository.resolveMany([work.workspace_id], this.#lifetime.signal)).get(work.workspace_id);
    if (!workspace) throw new BridgeError("COORDINATION_WORKSPACE_UNAVAILABLE", "Registered source workspace is unavailable");
    const controlGeneration = work.managed ? (await this.#store!.readControl(work.managed.task_id)).control_generation : 0;
    const watched = (work.source_watches ?? []).filter(watch => watch.work_revision === work.revision &&
      (watch.recipient === work.owner || work.source_grants?.some(grant =>
        grant.work_revision === work.revision && grant.recipient === watch.recipient)));
    const areas = [...work.areas];
    for (const region of watched.flatMap(watch => watch.regions)) {
      // Exact file watches remain priority selectors even inside a declared subtree.
      if (!areas.some(area => area.kind === region.kind && area.path === region.path)) areas.push(region);
    }
    return { work_id: work.id, work_revision: work.revision, control_generation: controlGeneration,
      workspace_id: work.workspace_id, workspace_generation: work.managed ? controlGeneration : Math.max(1, work.revision),
      root: workspace.root, input_commit_oid: work.input_oid, areas };
  }
  async #analyzeObservation(job: ObservationJob) {
    if (job.paths.length > 16) return { kind: "incomplete" as const, limitation: "analysis_path_budget_exceeded" };
    const { readCommittedFile, captureWorkingFile } = await import("../observation/source.js");
    const { sourceDialectForPath } = await import("../observation/language-routing.js");
    const { compareCapturedWork } = await import("../observation/comparison.js");
    const { NativeAnalysisHelper } = await import("../observation/helper.js");
    this.#nativeAnalysis ??= new NativeAnalysisHelper(this.#identity.mode === "installed" ? this.#identity.build_id : undefined);
    const metadata = await this.#coordinationSession(this.#binding!).observationStore();
    const owner = (await metadata.snapshot()).works.find(item => item.id === job.workspace.work_id)?.owner;
    if (!owner) return { kind: "incomplete" as const, limitation: "work_not_current" };
    const work = await this.#currentSourceWork(owner, job.workspace.work_id, "report");
    if (work.revision !== job.workspace.work_revision) return { kind: "incomplete" as const, limitation: "work_revision_changed" };
    const pairs: MonitoredPair[] = [];
    const incompletePaths: string[] = [];
    for (const path of job.paths) {
      job.signal.throwIfAborted();
      const override = work.source_watches?.flatMap(watch => watch.dialect_overrides ?? []).find(item => item.path === path)?.dialect;
      const dialect = sourceDialectForPath(path, override);
      if (!dialect) continue;
      try {
        const input = await readCommittedFile(job.workspace.root, work.input_oid, path, { max_bytes: 8 * 1024 * 1024, signal: job.signal });
        const observed = await captureWorkingFile({ root: job.workspace.root, workspace_id: work.workspace_id,
          workspace_generation: job.workspace.workspace_generation, capture_sequence: ++this.#captureSequence,
          input_commit_oid: work.input_oid }, path, { max_bytes: 8 * 1024 * 1024, signal: job.signal });
        const compared = await compareCapturedWork({ work_id: work.id, parent_id: work.owner, dialect, input, observed }, this.#nativeAnalysis, job.signal);
        pairs.push({ report: compared.report, input, observed });
      } catch (error) {
        if (error instanceof BridgeError && (error.code === "SOURCE_TOO_LARGE" || error.code === "SOURCE_ENCODING_UNSUPPORTED" ||
          error.code === "SOURCE_MOUNT_BOUNDARY" || error.code === "SOURCE_CHANGED_DURING_CAPTURE" ||
          error.code === "SOURCE_CAPTURE_MOVED" || error.code === "SOURCE_PATH_UNSAFE" ||
          error.code === "STRUCTURAL_ANALYSIS_CAPACITY")) {
          incompletePaths.push(`${path.slice(0, 128)}:${error.code}`);
          continue;
        }
        throw error;
      }
    }
    return pairs.length ? { kind: "artifact" as const, evidence_id: canonicalHash(pairs.map(pair => pair.report.comparison)),
      artifact: pairs, limitations: incompletePaths }
      : { kind: "incomplete" as const, limitation: incompletePaths.length
        ? "source_capture_incomplete" : "no_qualifying_source_capture", limitations: incompletePaths };
  }
  async #resumeObservations(): Promise<void> {
    if (!this.#monitorEnabled) return;
    if (!this.#binding) return;
    let snapshot;
    try { snapshot = await (await this.#coordinationSession(this.#binding).observationStore()).snapshot(); }
    catch (error) { if (errorInfo(error).code === "COORDINATION_NOT_ENABLED") return; throw error; }
    const active = snapshot.works.filter(work => work.state === "active").sort((a, b) => a.id.localeCompare(b.id));
    this.#observationOmittedCount = Math.max(0, active.length - 32);
    for (const work of active.slice(32)) this.#observationFailures.set(work.id, "observation_capacity");
    if (!active.length) return;
    const { monitor, store } = await this.#observation();
    const selected = active.slice(0, 32);
    const owners = new Map<string, Awaited<ReturnType<ObservationStore["listCurrent"]>>>();
    // Rebuild the disposable correspondence index from exact retained captures before
    // any live rescan can replace an overlap with an offline reversion.
    for (const work of selected) {
      try {
        let current = owners.get(work.owner);
        if (!current) {
          current = await store.listCurrent(work.owner, (recipient, workId, revision, generation) =>
            this.#authorizeObservation(recipient, workId, revision, generation, "report"));
          owners.set(work.owner, current);
        }
        for (const item of current.reports.filter(item => item.work_id === work.id && item.work_revision === work.revision))
          this.#publishedArtifactIds.set(JSON.stringify([work.id, item.path]), { id: item.id, owner: work.owner });
      } catch (error) { this.#observationFailures.set(work.id, errorInfo(error).code); }
    }
    const { compareCapturedWork } = await import("../observation/comparison.js");
    const { sourceDialectForPath } = await import("../observation/language-routing.js");
    const { NativeAnalysisHelper } = await import("../observation/helper.js");
    this.#nativeAnalysis ??= new NativeAnalysisHelper(this.#identity.mode === "installed" ? this.#identity.build_id : undefined);
    for (const work of selected) {
      const current = owners.get(work.owner);
      if (!current) continue;
      for (const item of current.reports.filter(item => item.work_id === work.id && item.work_revision === work.revision)) {
        try {
          const retained = await store.readRetainedPair(item.id, work.owner, (recipient, workId, revision, generation) =>
            this.#authorizeObservation(recipient, workId, revision, generation, "report"));
          const override = work.source_watches?.flatMap(watch => watch.dialect_overrides ?? []).find(route => route.path === item.path)?.dialect;
          const dialect = sourceDialectForPath(item.path, override);
          if (!dialect) continue;
          const compared = await compareCapturedWork({ work_id: work.id, parent_id: work.owner, dialect,
            input: retained.input, observed: retained.observed }, this.#nativeAnalysis, this.#lifetime.signal);
          const update = this.#correspondence.upsert(compared.report);
          for (const event of update.pairs) {
            this.#queueCorrespondenceNotice({ artifactId: item.id, recipient: work.owner, workId: work.id,
              subjectId: event.subject_id, state: "overlap" });
            const peer = this.#publishedArtifactIds.get(JSON.stringify([event.other_work_id, item.path]));
            if (peer) this.#queueCorrespondenceNotice({ artifactId: peer.id, recipient: peer.owner,
              workId: event.other_work_id, subjectId: event.subject_id, state: "overlap" });
          }
          await this.#drainCorrespondenceNotices();
        } catch (error) {
          this.#observationRehydrationGaps.add(work.id);
          this.#observationFailures.set(work.id, errorInfo(error).code);
        }
      }
    }
    const attachments: Promise<void>[] = [];
    for (const [index, work] of active.entries()) {
      if (index >= 32) { this.#observationFailures.set(work.id, "observation_capacity"); continue; }
      try {
        const workspace = await this.#observationWorkspace(work);
        const epoch = this.#observationEpoch.get(work.id) ?? 0;
        const controller = new AbortController();
        this.#observationAttaching.set(work.id, work.workspace_id);
        this.#observationAttachAbort.set(work.id, controller);
        attachments.push(monitor.attach(workspace, AbortSignal.any([controller.signal, this.#lifetime.signal])).then(async () => {
          try {
            const current = await this.#currentSourceWork(work.owner, work.id, "report");
            if ((this.#observationEpoch.get(work.id) ?? 0) !== epoch ||
              current.revision !== work.revision || current.workspace_id !== work.workspace_id ||
              current.owner !== work.owner) monitor.detach(work.id, work.workspace_id);
            else {
              this.#observationAttached.set(work.id, work.workspace_id);
              this.#observationFailures.delete(work.id);
            }
          } catch { monitor.detach(work.id, work.workspace_id); }
        }, error => {
          const code = errorInfo(error).code;
          this.#observationFailures.set(work.id, code === "STRUCTURAL_MONITOR_CAPACITY" ? "observation_capacity" : code);
        }).finally(() => {
          if (this.#observationAttaching.get(work.id) === work.workspace_id) this.#observationAttaching.delete(work.id);
          if (this.#observationAttachAbort.get(work.id) === controller) this.#observationAttachAbort.delete(work.id);
        }));
      } catch (error) { this.#observationFailures.set(work.id, errorInfo(error).code); }
    }
    await Promise.all(attachments);
  }
  #scheduleObservation(workId: string): void {
    if (!this.#monitorEnabled) return;
    const epoch = (this.#observationEpoch.get(workId) ?? 0) + 1;
    this.#observationEpoch.set(workId, epoch);
    const previous = this.#observationAttachTail.get(workId);
    let operation: Promise<void>;
    try { operation = this.#track(async () => {
      if (previous) await previous.catch(() => undefined);
      if (this.#observationResume) await this.#observationResume.catch(() => undefined);
      if (this.#observationEpoch.get(workId) !== epoch) return;
      const metadata = await this.#coordinationSession(this.#binding!).observationStore();
      const work = (await metadata.snapshot()).works.find(item => item.id === workId);
      if (!work || work.state !== "active") return;
      const { monitor } = await this.#observation();
      const workspace = await this.#observationWorkspace(work);
      if (this.#observationEpoch.get(workId) !== epoch) return;
      const controller = new AbortController();
      this.#observationAttaching.set(workId, work.workspace_id);
      this.#observationAttachAbort.set(workId, controller);
      try { await monitor.attach(workspace, AbortSignal.any([controller.signal, this.#lifetime.signal])); }
      finally {
        if (this.#observationAttaching.get(workId) === work.workspace_id) this.#observationAttaching.delete(workId);
        if (this.#observationAttachAbort.get(workId) === controller) this.#observationAttachAbort.delete(workId);
      }
      try {
        const current = await this.#currentSourceWork(work.owner, work.id, "report");
        if (this.#observationEpoch.get(workId) !== epoch ||
          current.revision !== work.revision || current.workspace_id !== work.workspace_id ||
          current.owner !== work.owner) throw new BridgeError("STRUCTURAL_SOURCE_FORBIDDEN", "Observation work changed during attachment");
        if (current.managed) await this.#authorizeObservation(work.owner, work.id, work.revision,
          { control_generation: workspace.control_generation, workspace_generation: workspace.workspace_generation }, "report");
        this.#observationAttached.set(work.id, work.workspace_id);
        this.#observationFailures.delete(work.id);
      } catch {
        monitor.detach(work.id, work.workspace_id);
        this.#fillObservationSlots();
      }
    }, false); } catch { return; }
    this.#observationAttachTail.set(workId, operation);
    const settled = () => { if (this.#observationAttachTail.get(workId) === operation) this.#observationAttachTail.delete(workId); };
    void operation.then(settled, settled);
    void operation.catch(error => {
      if (this.#observationEpoch.get(workId) !== epoch) return;
      const code = errorInfo(error).code;
      this.#observationFailures.set(workId, code === "STRUCTURAL_MONITOR_CAPACITY" ? "observation_capacity" : code);
    });
  }
  #fillObservationSlots(): void {
    if (!this.#monitorEnabled || !this.#observationMonitor) return;
    let free = 32 - this.#observationAttached.size;
    for (const [id, failure] of this.#observationFailures) {
      if (free <= 0) break;
      if (failure !== "observation_capacity") continue;
      this.#observationFailures.delete(id);
      this.#scheduleObservation(id);
      free--;
    }
  }
  #forgetObservation(workId: string, workspaceId?: string): void {
    this.#observationEpoch.set(workId, (this.#observationEpoch.get(workId) ?? 0) + 1);
    const attached = this.#observationAttached.get(workId);
    const attaching = this.#observationAttaching.get(workId);
    this.#observationAttachAbort.get(workId)?.abort(new BridgeError("STRUCTURAL_ANALYSIS_CANCELLED", "Source authority changed during attachment"));
    if (attached) this.#observationMonitor?.detach(workId, attached);
    if (attaching && attaching !== attached) this.#observationMonitor?.detach(workId, attaching);
    if (workspaceId && workspaceId !== attached) this.#observationMonitor?.detach(workId, workspaceId);
    this.#observationAttached.delete(workId);
    this.#correspondence.remove(workId);
    for (const key of this.#publishedArtifactIds.keys()) if (JSON.parse(key)[0] === workId) this.#publishedArtifactIds.delete(key);
    for (const [key, notice] of this.#pendingCorrespondenceNotices) if (notice.workId === workId) this.#pendingCorrespondenceNotices.delete(key);
    this.#observationFailures.delete(workId);
    this.#observationRehydrationGaps.delete(workId);
    if (attached || attaching || workspaceId) this.#fillObservationSlots();
  }
  #queueCorrespondenceNotice(notice: PendingCorrespondenceNotice): void {
    const key = JSON.stringify([notice.artifactId, notice.recipient, notice.subjectId, notice.state]);
    if (this.#pendingCorrespondenceNotices.has(key)) return;
    if (this.#pendingCorrespondenceNotices.size >= 256)
      throw new BridgeError("STRUCTURAL_CORRESPONDENCE_CAPACITY", "Pending structural correspondence notice capacity is full");
    this.#pendingCorrespondenceNotices.set(key, notice);
  }
  async #drainCorrespondenceNotices(): Promise<void> {
    for (const [key, notice] of this.#pendingCorrespondenceNotices) {
      try {
        await this.#observationStore!.notifyExisting(notice.artifactId, notice.recipient, notice.subjectId, notice.state,
          (recipient, workId, revision, generation) => this.#authorizeObservation(recipient, workId, revision, generation, "report"));
        this.#pendingCorrespondenceNotices.delete(key);
      } catch (error) {
        const code = errorInfo(error).code;
        if (code !== "STRUCTURAL_DETAIL_UNAVAILABLE" && code !== "STRUCTURAL_SOURCE_FORBIDDEN") throw error;
        // A pruned or retired peer cannot be recovered by recapturing its old working source.
        this.#pendingCorrespondenceNotices.delete(key);
      }
    }
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
        this.#coordinator.onTaskSettled = taskId => this.#scheduleTerminalBinding(taskId);
        this.#coordinator.onCoordinatedWorkspacePrepared = async (record, workspace) => {
          if (workspace.kind !== "task_worktree" || record.request.mode !== "implement") {
            throw new BridgeError("COORDINATION_WORKSPACE_INVALID", "Coordinated admission requires its prepared implementation worktree");
          }
          for (let attempt = 0; attempt < 4; attempt++) {
            const current = await this.#store!.readControl(record.task_id);
            try {
              const receipt = await this.#coordinationSession(binding).enrollPreparedManagedWork(
                { owner_id: current.owner_id, source_view: record.source_view },
                record.task_id, `passeur-internal:admission:${record.task_id}`);
              if (receipt.item_id !== record.task_id) throw new BridgeError("COORDINATION_ATTACHMENT_INVALID", "Prepared task did not receive its exact managed-work receipt");
              this.#scheduleObservation(record.task_id);
              return;
            } catch (error) {
              const code = errorInfo(error).code;
              if (attempt === 3 || code !== "TASK_CONTROL_CONFLICT" && code !== "COORDINATION_TASK_BUSY") throw error;
              await delay(10, undefined, { signal: this.#lifetime.signal });
            }
          }
        };
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
  async #preparedCoordinated(request: CoordinatedPublicRequest, actor: ClientActor, sourceView: string,
    signal: AbortSignal): Promise<PreparedCoordinated> {
    const { canonicalProject, repositoryIdentity, exactCommit } = await import("../workspace/project.js");
    const source = await canonicalProject(sourceView), binding = await this.#resolve(signal);
    if ((await repositoryIdentity(source, signal)).id !== binding.repositoryId) throw new BridgeError("SOURCE_VIEW_CONFLICT", "Source view is not part of this repository");
    let assignment: Assignment, announcement: { id: string; revision: number } | undefined;
    if (request.kind === "inline") assignment = request.assignment;
    else {
      const connection = { owner_id: actor.owner_id, source_view: source };
      const record = await this.#coordinationSession(binding).announcement(connection, request.announcement.id);
      const expectedRevision = request.announcement.revision + (record.state === "bound" ? 1 : record.state === "linked" ? 2 : 0);
      if (record.owner !== actor.owner_id || record.revision !== expectedRevision || record.state === "withdrawn") {
        throw new BridgeError("ANNOUNCEMENT_UNAVAILABLE", "The referenced announcement is not controlled and unresolved by this parent");
      }
      const published = await this.#store!.readAnnouncement(request.announcement.id);
      if (!published || published.payload.owner_id !== actor.owner_id || published.payload.source_view !== source ||
        published.payload.revision !== request.announcement.revision ||
        canonicalHash(published.payload.assignment) !== record.payload_digest) {
        throw new BridgeError("ANNOUNCEMENT_CONFLICT", "The referenced immutable assignment differs from its coordination record");
      }
      assignment = published.payload.assignment;
      announcement = request.announcement;
    }
    const declaredPaths = assignment.allowed_paths;
    if (assignment.mode !== "implement" || !assignment.base_commit || !declaredPaths?.length) {
      throw new BridgeError("COORDINATION_SCOPE_REQUIRED", "Coordinated submission requires an implementation base and explicit allowed paths");
    }
    const input_oid = await exactCommit(source, assignment.base_commit, signal);
    assignment = { ...assignment, base_commit: input_oid };
    const areas = [...new Set(declaredPaths.map(path => path.replace(/\/$/, "")))].map(path => {
      validateSourcePath(path); return { kind: "subtree" as const, path };
    });
    const identity = CoordinatedSubmissionIdentitySchema.parse({ schema_version: 2, source_view: source, assignment,
      ...(announcement ? { announcement } : {}),
      ...(request.expected_decision_identity ? { expected_decision_identity: request.expected_decision_identity } : {}) });
    return { identity, input_oid, areas };
  }
  /** A preflight is advisory until the same identity is checked in metadata's binding order. */
  preflightCoordinated(request: CoordinatedPublicRequest, actor: ClientActor, sourceView: string, signal: AbortSignal) {
    return this.#track(async () => {
      await this.#ensurePrepared(signal, true);
      this.#assertCoordinatedReconciled();
      const prepared = await this.#preparedCoordinated(request, actor, sourceView, signal);
      const binding = this.#binding!, connection = { owner_id: actor.owner_id, source_view: prepared.identity.source_view };
      const decision = await this.#coordinationSession(binding).preflight(connection, {
        source_view: prepared.identity.source_view, input_oid: prepared.input_oid,
        intent_hash: canonicalHash(coordinatedMaterialIdentity(prepared.identity)),
        areas: prepared.areas, ...(prepared.identity.announcement ? { announcement: prepared.identity.announcement } : {}),
      }, signal);
      return { schema_version: 1 as const, ...decision };
    });
  }
  announce(request: AnnouncementPublicRequest, actor: ClientActor, sourceView: string, signal: AbortSignal) {
    return this.#track(async () => {
      if (this.#admissionClosed) throw new BridgeError("SERVICE_DRAINING", "Announcement admission is closed");
      await this.#ensurePrepared(signal);
      const { canonicalProject, repositoryIdentity } = await import("../workspace/project.js");
      const source = await canonicalProject(sourceView), binding = this.#binding!;
      if ((await repositoryIdentity(source, signal)).id !== binding.repositoryId) throw new BridgeError("SOURCE_VIEW_CONFLICT", "Source view is not part of this repository");
      const id = announcementId(actor.owner_id, request.operation_key);
      const prepared = await this.#preparedCoordinated({ schema_version: 2, kind: "inline", assignment: request.assignment }, actor, source, signal);
      const payload_digest = canonicalHash(prepared.identity.assignment);
      const prior = await this.#store!.readAnnouncement(id);
      const payload = { schema_version: 1 as const, id, revision: 1 as const, owner_id: actor.owner_id, source_view: source,
        assignment: prepared.identity.assignment, published_at: prior?.payload.published_at ?? new Date().toISOString() };
      await this.#store!.publishAnnouncement(payload);
      // The immutable TaskStore payload is durable before metadata refers to it.
      const record = await this.#coordinationSession(binding).announce({ owner_id: actor.owner_id, source_view: source }, {
        operation_key: request.operation_key, id, payload_digest, source_view: source,
        assignment_hash: payload_digest, areas: prepared.areas, readers: request.readers,
      }, this.#lifetime.signal);
      return { schema_version: 1 as const, record, assignment: payload.assignment };
    });
  }
  announcement(id: string, actor: ClientActor, sourceView: string, signal: AbortSignal) {
    return this.#track(async () => {
      const binding = await this.#resolve(signal);
      await this.#ensurePrepared(signal, true);
      const record = await this.#coordinationSession(binding).announcement({ owner_id: actor.owner_id, source_view: sourceView }, id);
      const payload = await this.#store!.readAnnouncement(id);
      if (!payload || payload.payload.source_view !== record.source_view ||
        payload.payload.owner_id !== record.owner || canonicalHash(payload.payload.assignment) !== record.payload_digest) {
        throw new BridgeError("ANNOUNCEMENT_CONFLICT", "Coordination metadata does not match its retained immutable assignment");
      }
      return { schema_version: 1 as const, record, assignment: payload.payload.assignment };
    });
  }
  withdrawAnnouncement(id: string, revision: number, operationKey: string, actor: ClientActor, sourceView: string) {
    return this.#track(async () => {
      const binding = await this.#resolve(this.#lifetime.signal);
      await this.#ensurePrepared(this.#lifetime.signal, true);
      const record = await this.#coordinationSession(binding).withdrawAnnouncement({ owner_id: actor.owner_id, source_view: sourceView },
        { id, expected_revision: revision, operation_key: operationKey });
      const payload = await this.#store!.readAnnouncement(id);
      if (!payload || payload.payload.owner_id !== actor.owner_id) throw new BridgeError("ANNOUNCEMENT_CONFLICT", "Retained announcement payload is missing or owned elsewhere");
      if (payload.control.state !== "withdrawn") await this.#store!.changeAnnouncement(id, actor.owner_id, { kind: "withdraw" });
      return record;
    });
  }
  submitCoordinated(request: CoordinatedPublicRequest, actor: ClientActor, sourceView: string, signal: AbortSignal): Promise<TaskObservation> {
    return this.#track(() => this.#coordinatedAdmission.run(async () => {
      if (this.#admissionClosed) throw new BridgeError("SERVICE_DRAINING", "Coordinated admission is closed");
      await this.#ensurePrepared(signal);
      this.#assertCoordinatedReconciled();
      const prepared = await this.#preparedCoordinated(request, actor, sourceView, signal);
      const identity = prepared.identity, binding = this.#binding!;
      const connection = { owner_id: actor.owner_id, source_view: identity.source_view };
      const metadata = this.#coordinationSession(binding), coordinator = await this.#execution();
      const existing = await metadata.submissionBindingByRequestKey(connection, identity.assignment.request_key);
      if (existing?.state === "released") throw new BridgeError("COORDINATION_BINDING_RELEASED", "This request key names a released admission; inspect its retained identity");
      // From reservation onward the service owns recovery. Client cancellation detaches only its response.
      const reservation = existing
        ? await coordinator.recoverCoordinatedReservation(identity, actor, existing.task_id, this.#lifetime.signal)
        : await coordinator.reserveCoordinated(identity, actor, this.#lifetime.signal);
      const operation_key = `passeur-internal:bind:${identity.assignment.request_key}`;
      let bound = existing;
      try {
        bound ??= await metadata.bindSubmission(connection, {
          operation_key, task_id: reservation.task_id, request_key: reservation.request_key,
          source_view: reservation.source_view, input_oid: prepared.input_oid,
          intent_hash: reservation.intent_hash, areas: prepared.areas,
          ...(reservation.announcement ? { announcement: reservation.announcement, payload_digest: reservation.payload_digest,
            assignment_hash: reservation.payload_digest } : {}),
          ...(identity.expected_decision_identity ? { expected_decision_identity: identity.expected_decision_identity } : {}),
        }, this.#lifetime.signal);
      } catch (error) {
        // A failed publication may have succeeded before acknowledgment. Release only after an authoritative absent read.
        try { bound = await metadata.submissionBindingByRequestKey(connection, reservation.request_key); }
        catch (lookupError) {
          throw new BridgeError("COORDINATION_ADMISSION_UNCERTAIN", "Binding reply and exact recovery read both failed; retry the original request key", { cause: lookupError });
        }
        if (bound === undefined) {
          await coordinator.releaseUnadmitted(reservation);
          throw error;
        }
      }
      if (bound.task_id !== reservation.task_id || bound.owner !== actor.owner_id ||
        bound.intent_hash !== reservation.intent_hash || bound.request_key !== reservation.request_key ||
        bound.state === "released") throw new BridgeError("COORDINATION_LINK_CONFLICT", "Metadata binding differs from exact task reservation");
      const decision = { decision_identity: bound.decision_identity, link_hash: bound.link_hash };
      try { await coordinator.commitReserved(reservation, decision); }
      catch (error) {
        // The exact task directory is the admission frontier. Only proven absence permits release.
        const admitted = await this.#store!.find({ task_id: reservation.task_id });
        if (!admitted && reservation.status === "reserved") {
          await metadata.releaseUnadmittedBinding(connection, { operation_key: `passeur-internal:release:${identity.assignment.request_key}`,
            task_id: reservation.task_id, request_key: reservation.request_key, link_hash: bound.link_hash });
          await coordinator.releaseUnadmitted(reservation);
        }
        throw error;
      }
      if (bound.state === "bound") await metadata.settleSubmission(connection, {
        operation_key: `passeur-internal:settle:${identity.assignment.request_key}`, task_id: reservation.task_id,
        request_key: reservation.request_key, link_hash: bound.link_hash,
      });
      const observation = await coordinator.activateLinked(reservation, decision);
      if (observation.phase === "terminal") this.#scheduleTerminalBinding(observation.task_id);
      return observation;
    }));
  }
  #scheduleTerminalBinding(taskId: string): void {
    if (this.#terminalBindingDone.has(taskId) || this.#terminalBindingInFlight.has(taskId)) return;
    this.#terminalBindingInFlight.add(taskId);
    let operation: Promise<void>;
    try { operation = this.#track(() => this.#terminalBinding(taskId)); }
    catch (error) { this.#terminalBindingInFlight.delete(taskId); this.#failure ??= diagnosticInfo(error); return; }
    void operation.then(() => this.#terminalBindingInFlight.delete(taskId), error => {
      this.#terminalBindingInFlight.delete(taskId);
      // This is retryable metadata accounting; it does not alter the worker's terminal result.
      this.#failure ??= diagnosticInfo(error);
    });
  }
  async #terminalBinding(taskId: string): Promise<void> {
    if (!this.#store || !this.#binding) return;
    const record = await this.#store.find({ task_id: taskId });
    if (!record || !("schema_version" in record) || record.schema_version !== 5) return;
    const control = await this.#store.readControl(taskId);
    if (control.phase !== "terminal" || !control.outcome) return;
    const settled = await this.#store.readCoordinatedLink(taskId);
    if (!settled || settled.state !== "settled") throw new BridgeError("COORDINATION_LINK_UNSETTLED", "Terminal task has no exact settled TaskStore link");
    const connection = { owner_id: record.initial_owner, source_view: record.source_view };
    const metadata = this.#coordinationSession(this.#binding);
    const binding = await metadata.submissionBinding(connection, taskId);
    if (binding.request_key !== record.request.request_key || binding.link_hash !== record.linkage.link_hash ||
      binding.owner !== record.initial_owner || binding.intent_hash !== record.canonical_hash) {
      throw new BridgeError("COORDINATION_LINK_CONFLICT", "Terminal metadata binding differs from immutable task admission");
    }
    if (binding.state === "terminal") { this.#terminalBindingDone.add(taskId); return; }
    if (binding.state !== "settled") throw new BridgeError("COORDINATION_BINDING_UNSETTLED", "Terminal task has no settled metadata link");
    await metadata.terminalSubmissionBinding(connection, { operation_key: `passeur-internal:terminal:${taskId}`, task_id: taskId,
      request_key: record.request.request_key, link_hash: record.linkage.link_hash,
      terminal: { revision: control.revision, control_generation: control.control_generation, outcome: control.outcome } });
    this.#terminalBindingDone.add(taskId);
  }
  /** Internal service entrypoint. The listener, not the payload, supplies its authenticated actor/source. */
  coordinate(raw: unknown, actor: ClientActor, sourceView: string, signal?: AbortSignal): Promise<CoordinationReply> {
    let request: ReturnType<typeof decodeCoordinationRequest>, connection: Readonly<{ owner_id: string; source_view: string }>;
    try {
      signal?.throwIfAborted(); this.#assertOpen();
      request = decodeCoordinationRequest(raw);
      connection = Object.freeze({ owner_id: parentId(actor.owner_id), source_view: sourceView });
      if (typeof sourceView !== "string" || !sourceView.length || sourceView.length > 4096 || sourceView.includes("\0") || !isAbsolute(sourceView)) {
        throw new BridgeError("COORDINATION_SOURCE_VIEW_INVALID", "Use the authenticated connection's absolute source view");
      }
      if (this.#admissionClosed && (request.kind === "initialize" || request.kind === "command" && coordinationRequestLane(request) === "ordinary")) {
        throw new BridgeError("COORDINATION_SERVICE_DRAINING", "New coordination work is closed; existing reads and release controls remain available");
      }
      this.#assertOpen();
    } catch (error) { return Promise.reject(error); }
    const control = coordinationRequestLane(request) === "control";
    if (control ? this.#coordinationControls >= coordinationLimits.control_requests : this.#coordinationOrdinary >= coordinationLimits.ordinary_requests) {
      return Promise.reject(new BridgeError(control ? "COORDINATION_CONTROL_CAPACITY" : "COORDINATION_SERVICE_CAPACITY", "The selected runtime coordination lane is full; no operation was admitted"));
    }
    if (control) this.#coordinationControls++; else this.#coordinationOrdinary++;
    const operation = this.#track(async () => {
      // From admission onward, preparation/publication has runtime ownership.
      // A request cancellation detaches only the promise returned below.
      const binding = await this.#resolve(this.#lifetime.signal);
      if (request.kind === "initialize" || request.kind === "command" || request.kind === "recover_metadata" || request.kind === "recovery_read") await this.#ensurePrepared(undefined, control);
      this.#assertOpen();
      if (this.#admissionClosed && (request.kind === "initialize" || request.kind === "command" && !control)) {
        throw new BridgeError("COORDINATION_SERVICE_DRAINING", "Coordination admission closed during preparation");
      }
      if (request.kind !== "identity") {
        // Service startup supplies this private namespace. A read cannot recreate
        // a missing namespace or reinterpret lost authority as a never-enabled store.
        try { await privateDirectory(binding.storeRoot); }
        catch (error) { throw filesystemFailure(error, "coordination.namespace", binding.storeRoot); }
      }
      // Namespace checks suspend. Closing during that read must not create a
      // session after shutdown has already selected the owners it will close.
      this.#assertOpen();
      const reply = await this.#coordinationSession(binding).handle(connection, request);
      if (reply.kind === "receipt" && (reply.receipt.action === "grant_source" ||
        reply.receipt.action === "watch_source" || reply.receipt.action === "share_work")) {
        this.#forgetObservation(reply.receipt.item_id);
      }
      if (reply.kind === "receipt" && (reply.receipt.action === "register_work" ||
        reply.receipt.action === "register_task_work" || reply.receipt.action === "grant_source" ||
        reply.receipt.action === "watch_source" || reply.receipt.action === "share_work")) {
        this.#scheduleObservation(reply.receipt.item_id);
      }
      if (reply.kind === "receipt" && reply.receipt.action === "close_work") {
        const metadata = await this.#coordinationSession(binding).observationStore();
        const work = (await metadata.snapshot()).works.find(item => item.id === reply.receipt.item_id);
        if (work) this.#forgetObservation(work.id, work.workspace_id);
      }
      if (reply.kind === "recovery_receipt") {
        const command = reply.receipt.command;
        if (command.kind === "adopt_work") { this.#forgetObservation(command.work_id); this.#scheduleObservation(command.work_id); }
        if (command.kind === "close_work") {
          const metadata = await this.#coordinationSession(binding).observationStore();
          const work = (await metadata.snapshot()).works.find(item => item.id === command.work_id);
          if (work) this.#forgetObservation(work.id, work.workspace_id);
        }
      }
      return reply;
    });
    const settled = () => {
      if (control) this.#coordinationControls--; else this.#coordinationOrdinary--;
      // Notification is advisory and runs after #track removed the owned work.
      // A broken observer cannot turn a published receipt into a failed mutation.
      try { this.onSettled?.(); } catch (error) { this.#failure ??= diagnosticInfo(error); }
    };
    void operation.then(settled, settled);
    return withAbort(operation, signal);
  }

  /** Owner-only initial source report. File identities come from the registered work, never a caller path. */
  structuralRefresh(workId: string, actor: ClientActor, signal?: AbortSignal) {
    return this.#track(async () => {
      await this.#ensurePrepared(signal);
      if (this.#observationResume) await this.#observationResume.catch(() => undefined);
      const work = await this.#ownedStructuralWork(this.#binding!, actor, workId);
      const epoch = (this.#observationEpoch.get(workId) ?? 0) + 1;
      this.#observationEpoch.set(workId, epoch);
      const previous = this.#observationAttachTail.get(workId);
      const refresh = (async () => {
        if (previous) await previous.catch(() => undefined);
        if (this.#observationEpoch.get(workId) !== epoch)
          throw new BridgeError("STRUCTURAL_SOURCE_FORBIDDEN", "Observation work changed before refresh");
        const { monitor } = await this.#observation();
        const workspace = await this.#observationWorkspace(work);
        if (this.#observationEpoch.get(workId) !== epoch)
          throw new BridgeError("STRUCTURAL_SOURCE_FORBIDDEN", "Observation work changed before attachment");
        const controller = new AbortController();
        this.#observationAttaching.set(workId, work.workspace_id);
        this.#observationAttachAbort.set(workId, controller);
        let outcome;
        try { outcome = await monitor.attach(workspace, AbortSignal.any([controller.signal, this.#lifetime.signal])); }
        finally {
          if (this.#observationAttaching.get(workId) === work.workspace_id) this.#observationAttaching.delete(workId);
          if (this.#observationAttachAbort.get(workId) === controller) this.#observationAttachAbort.delete(workId);
        }
        try {
          const current = await this.#ownedStructuralWork(this.#binding!, actor, workId);
          if (this.#observationEpoch.get(workId) !== epoch || current.revision !== work.revision ||
            current.workspace_id !== work.workspace_id)
            throw new BridgeError("STRUCTURAL_SOURCE_FORBIDDEN", "Observation work changed during refresh");
        } catch (error) {
          monitor.detach(work.id, work.workspace_id);
          this.#fillObservationSlots();
          throw error;
        }
        this.#observationAttached.set(work.id, work.workspace_id);
        if (outcome.status !== "incomplete") this.#observationFailures.delete(work.id);
        return { schema_version: 1 as const, ...outcome };
      })();
      const tail = refresh.then(() => undefined, () => undefined);
      this.#observationAttachTail.set(workId, tail);
      try { return await refresh; }
      finally { if (this.#observationAttachTail.get(workId) === tail) this.#observationAttachTail.delete(workId); }
    });
  }
  structuralObservationStatus(workId: string, actor: ClientActor) {
    return this.#track(async () => {
      await this.#ensurePrepared();
      const work = await this.#ownedStructuralWork(this.#binding!, actor, workId);
      const snapshot = await (await this.#coordinationSession(this.#binding!).observationStore()).snapshot();
      const active = snapshot.works.filter(item => item.state === "active");
      this.#observationOmittedCount = active.filter(item => this.#observationFailures.get(item.id) === "observation_capacity").length;
      const limitation = this.#observationFailures.get(work.id) ??
        (this.#observationRehydrationGaps.has(work.id) ? "retained_rehydration_gap" : undefined) ?? this.#observationStartupFailure ??
        (this.#observationResuming ? "observation_rehydrating" : undefined);
      const outcome = this.#observationMonitor?.status(work.id, work.workspace_id);
      const state = !this.#monitorEnabled ? "disabled" as const : limitation || outcome?.status === "incomplete"
        ? "incomplete" as const : outcome ? "observed" as const : "not_attached" as const;
      return { schema_version: 1 as const, work_id: work.id, state,
        capacity_omitted_count: this.#observationOmittedCount,
        limitations: !this.#monitorEnabled ? ["monitor_disabled"] : limitation ? [limitation] : outcome?.limitations ?? [] };
    });
  }
  structuralNoticePull(actor: ClientActor, cursor: number, signal?: AbortSignal): Promise<ObservationPull> {
    return this.#track(async () => {
      await this.#ensurePrepared(signal);
      const { store } = await this.#observation();
      return store.pull(actor.owner_id, cursor, (recipient, workId, revision, generation) =>
        this.#authorizeObservation(recipient, workId, revision, generation, "report"));
    });
  }
  structuralNoticeAck(actor: ClientActor, noticeId: string) {
    return this.#track(async () => {
      const { store } = await this.#observation();
      return store.ack(actor.owner_id, noticeId, (recipient, workId, revision, generation) =>
        this.#authorizeObservation(recipient, workId, revision, generation, "report"));
    });
  }
  structuralCurrent(actor: ClientActor) {
    return this.#track(async () => {
      const { store } = await this.#observation();
      return store.listCurrent(actor.owner_id, (recipient, workId, revision, generation) =>
        this.#authorizeObservation(recipient, workId, revision, generation, "report"));
    });
  }
  structuralArtifactReport(actor: ClientActor, artifactId: string) {
    return this.#track(async () => {
      const { store } = await this.#observation();
      return store.readReport(artifactId, actor.owner_id, (recipient, workId, revision, generation) =>
        this.#authorizeObservation(recipient, workId, revision, generation, "report"));
    });
  }
  structuralArtifactDetail(actor: ClientActor, artifactId: string, side: "input" | "observed", startByte: number, endByte: number) {
    return this.#track(async () => {
      const { store } = await this.#observation();
      return store.readDetail(artifactId, actor.owner_id, side, startByte, endByte,
        (recipient, workId, revision, generation) => this.#authorizeObservation(recipient, workId, revision, generation, "detail"));
    });
  }
  structuralReport(workId: string, actor: ClientActor, sourceView: string, signal?: AbortSignal,
    selectedPaths?: readonly string[]): Promise<Readonly<{
    schema_version: 1; work_id: string; reports: readonly Readonly<{ report_id: string; path: string; dialect: NativeDialect; text: string }>[];
    limitations: readonly string[];
  }>> {
    this.#assertOpen();
    const selection = operationSchemas.structural_report.shape.paths.safeParse(selectedPaths);
    if (!selection.success) {
      return Promise.reject(new BridgeError("STRUCTURAL_SOURCE_SELECTION_INVALID", "Select one to four distinct source paths"));
    }
    // Canonical decoding also gives this invocation its own bounded array.
    const requestedPaths = selection.data;
    if (this.#structuralReportActive) {
      return Promise.reject(new BridgeError("STRUCTURAL_ANALYSIS_CAPACITY", "A source report is already using the bounded analysis admission"));
    }
    this.#structuralReportActive = true;
    let operation: Promise<Readonly<{
      schema_version: 1; work_id: string; reports: readonly Readonly<{ report_id: string; path: string; dialect: NativeDialect; text: string }>[];
      limitations: readonly string[];
    }>>;
    try { operation = this.#track(async () => {
      const ownedSignal = signal ? AbortSignal.any([signal, this.#lifetime.signal]) : this.#lifetime.signal;
      const binding = await this.#resolve(ownedSignal);
      await this.#ensurePrepared(undefined, false);
      this.#assertOpen(); this.#assertAuthority();
      const work = await this.#ownedStructuralWork(binding, actor, workId);
      const { CoordinationRepository } = await import("../coordination/repository.js");
      const repository = await CoordinationRepository.open(sourceView, binding.repositoryId, coordinationLimits.max_worktrees, ownedSignal);
      const workspace = (await repository.resolveMany([work.workspace_id], ownedSignal)).get(work.workspace_id);
      if (!workspace) throw new BridgeError("COORDINATION_WORKSPACE_UNAVAILABLE", "The registered worktree is not available for current source capture");
      const { listDeclaredSourcePaths } = await import("../observation/source-inventory.js");
      const { sourceDialectForPath } = await import("../observation/language-routing.js");
      let reportAreas = work.areas;
      if (requestedPaths !== undefined) {
        for (const path of requestedPaths) {
          validateSourcePath(path);
          if (!regionIncludesPath(work.areas, path))
            throw new BridgeError("STRUCTURAL_SOURCE_FORBIDDEN", "Selected source lies outside this work's declared areas");
        }
        reportAreas = requestedPaths.map(path => ({ kind: "file" as const, path }));
      }
      const inventory = await listDeclaredSourcePaths(workspace.root, work.input_oid, reportAreas, 4, ownedSignal);
      const limitations = new Set(inventory.limitations);
      if (work.areas.length === 0) limitations.add("source_scope_not_declared");
      const { readCommittedFile, captureWorkingFile } = await import("../observation/source.js");
      const { compareCapturedWork } = await import("../observation/comparison.js");
      const { NativeAnalysisHelper } = await import("../observation/helper.js");
      this.#assertOpen(); this.#assertAuthority();
      this.#nativeAnalysis ??= new NativeAnalysisHelper(this.#identity.mode === "installed" ? this.#identity.build_id : undefined);
      const samples: { path: string; dialect: NativeDialect; text: string;
        input: import("../observation/model.js").SourceFile; observed: import("../observation/model.js").SourceFile }[] = [];
      for (const path of inventory.paths) {
        const override = work.source_watches?.flatMap(watch => watch.dialect_overrides ?? []).find(item => item.path === path)?.dialect;
        const dialect = sourceDialectForPath(path, override);
        if (!dialect) { limitations.add("declared_file_dialect_not_qualified"); continue; }
        const max_bytes = 8 * 1024 * 1024;
        const input = await readCommittedFile(workspace.root, work.input_oid, path, { max_bytes, signal: ownedSignal });
        const observed = await captureWorkingFile({ root: workspace.root, workspace_id: work.workspace_id,
          workspace_generation: work.source_control_generation ?? Math.max(1, work.revision), capture_sequence: ++this.#captureSequence,
          input_commit_oid: work.input_oid }, path, { max_bytes, signal: ownedSignal });
        const compared = await compareCapturedWork({ work_id: work.id, parent_id: work.owner, dialect, input, observed }, this.#nativeAnalysis, ownedSignal);
        samples.push({ path, dialect, text: compared.text, input, observed });
      }
      const currentWorkspace = await repository.inspect(workspace.root, ownedSignal);
      if (currentWorkspace.workspace_id !== workspace.workspace_id || currentWorkspace.repository_id !== workspace.repository_id) {
        throw new BridgeError("STRUCTURAL_SOURCE_CHANGED", "Registered workspace identity changed during report capture");
      }
      // Recheck current source authority after Git and helper work. A stale owner never receives a completed report.
      const current = await this.#ownedStructuralWork(binding, actor, workId);
      if (current.revision !== work.revision || current.workspace_id !== work.workspace_id || current.input_oid !== work.input_oid ||
        current.source_control_generation !== work.source_control_generation) {
        throw new BridgeError("STRUCTURAL_SOURCE_CHANGED", "Work authority or source identity changed during report capture");
      }
      this.#assertOpen(); this.#assertAuthority();
      const reports = samples.map(sample => ({ report_id: this.#capturedPairs.put({ work_id: work.id, work_revision: work.revision,
        input: sample.input, observed: sample.observed }), path: sample.path, dialect: sample.dialect, text: sample.text }));
      return Object.freeze({ schema_version: 1 as const, work_id: work.id, reports: Object.freeze(reports),
        limitations: Object.freeze([...limitations].sort()) });
    }); } catch (error) { this.#structuralReportActive = false; throw error; }
    void operation.then(() => { this.#structuralReportActive = false; }, () => { this.#structuralReportActive = false; });
    return withAbort(operation, signal);
  }

  /** Exact captured bytes only. No filesystem or Git re-read occurs for a working detail request. */
  structuralDetail(workId: string, reportId: string, side: "input" | "observed", startByte: number, endByte: number,
    actor: ClientActor, signal?: AbortSignal): Promise<Readonly<{
      schema_version: 1; work_id: string; report_id: string; side: "input" | "observed";
      start_byte: number; end_byte: number; content_sha256: string; text: string;
    }>> {
    const operation = this.#track(async () => {
      if (!Number.isSafeInteger(startByte) || !Number.isSafeInteger(endByte) || startByte < 0 || endByte < startByte || endByte - startByte > 8192) {
        throw new BridgeError("STRUCTURAL_RANGE_INVALID", "Detail range must be at most 8192 captured bytes");
      }
      const binding = await this.#resolve(this.#lifetime.signal);
      await this.#ensurePrepared(undefined, false);
      const work = await this.#ownedStructuralWork(binding, actor, workId);
      const pair = this.#capturedPairs.get(reportId);
      if (pair.work_id !== work.id || pair.work_revision !== work.revision) {
        throw new BridgeError("STRUCTURAL_DETAIL_UNAVAILABLE", "The captured detail no longer has current work authority");
      }
      if (work.managed && (pair.observed.source.kind !== "working_capture" ||
        pair.observed.source.workspace_generation !== work.source_control_generation)) {
        throw new BridgeError("STRUCTURAL_DETAIL_UNAVAILABLE", "Task control changed after this managed source capture");
      }
      const file = pair[side];
      if (file.status !== "present") throw new BridgeError("STRUCTURAL_DETAIL_UNAVAILABLE", "This source side has no captured bytes");
      const { sourceExcerpt } = await import("../observation/source.js");
      const text = sourceExcerpt(file, { start_byte: startByte, end_byte: endByte });
      const current = await this.#ownedStructuralWork(binding, actor, workId);
      if (current.revision !== pair.work_revision || current.source_control_generation !== work.source_control_generation) {
        throw new BridgeError("STRUCTURAL_DETAIL_UNAVAILABLE", "Work or task control changed during detail retrieval");
      }
      this.#assertOpen(); this.#assertAuthority();
      return Object.freeze({ schema_version: 1 as const, work_id: work.id, report_id: reportId, side,
        start_byte: startByte, end_byte: endByte, content_sha256: file.content_sha256, text });
    });
    return withAbort(operation, signal);
  }
  async #ownedStructuralWork(binding: ResolvedBinding, actor: ClientActor, workId: string): Promise<Work & { source_control_generation?: number }> {
    const work = await this.#coordinationSession(binding).ownedSourceWork(actor.owner_id, workId);
    if (work.managed) {
      const control = await this.#store!.readControl(work.managed.task_id);
      if (control.owner_id !== actor.owner_id) {
        throw new BridgeError("STRUCTURAL_SOURCE_FORBIDDEN", "Managed source evidence requires current task and metadata ownership");
      }
      const source = await managedTaskSource(this.#store!, binding.repositoryId, work.managed.task_id);
      if (source.input_oid !== work.input_oid) throw new BridgeError("STRUCTURAL_SOURCE_FORBIDDEN", "Managed task input differs from registered work");
      const { CoordinationRepository } = await import("../coordination/repository.js");
      const repository = await CoordinationRepository.open(source.root, binding.repositoryId, coordinationLimits.max_worktrees);
      const workspace = await repository.inspect(source.root);
      if (workspace.workspace_id !== work.workspace_id) {
        throw new BridgeError("STRUCTURAL_SOURCE_FORBIDDEN", "Managed task workspace differs from registered work");
      }
      return { ...work, source_control_generation: control.control_generation };
    }
    return work;
  }
  #coordinationSession(binding: ResolvedBinding): CoordinationService {
    this.#assertOpen();
    if (!this.#coordination) {
      this.#coordination = new CoordinationService({ store_root: binding.storeRoot, repository_id: binding.repositoryId }, {
        assertOwned: () => this.#assertAuthority(),
        authorizeInitialization: principal => this.#authorizeCoordinationOperator(principal.owner_id, "initialization"),
        authorizeRecovery: principal => this.#authorizeCoordinationOperator(principal.owner_id, "recovery"),
        externalWorkspaces: { assertExternalRegistration: async (_principal, workspace, sourceSignal) => {
          if (!this.#store) throw new BridgeError("COORDINATION_RESOURCE_UNAVAILABLE", "The runtime resource inventory is not prepared");
          await assertExternalWorkspace(workspace, this.#store,
            { records: coordinationResourceRecords, worktrees: coordinationLimits.max_worktrees }, () => this.#assertAuthority(), sourceSignal);
        } },
        managedWorkspaces: {
          acquireRegistration: (principal, taskId) => this.#managedEnrollment(principal, taskId),
          inspectSelection: async work => {
            if (!work.managed || !this.#store) throw new BridgeError("COORDINATION_TASK_AUTHORITY_UNAVAILABLE", "Managed task/resource facts are unavailable");
            this.#assertAuthority();
            const source = await managedTaskSource(this.#store, binding.repositoryId, work.managed.task_id);
            this.#assertAuthority();
            return { root: source.root, branch_ref: source.branch_ref, input_oid: source.input_oid };
          },
        },
      }, coordinationLimits);
      if (this.#admissionClosed) this.#coordination.beginDrain();
    }
    return this.#coordination;
  }
  /** Logical per-task exclusion, not a held lock: Git and store callbacks execute outside synchronization. */
  #reserveTaskAssociation(id: string): () => void {
    this.#assertOpen(); this.#assertAuthority();
    if (this.#taskAssociations.has(id)) throw new BridgeError("COORDINATION_TASK_BUSY", "Task enrollment, adoption or disposition is already in progress; retry after that operation settles");
    this.#taskAssociations.add(id);
    let released = false;
    return () => { if (!released) { released = true; this.#taskAssociations.delete(id); } };
  }
  async #managedEnrollment(actor: CoordinationActor, taskId: string): Promise<ManagedEnrollment> {
    if (!this.#store || !this.#binding) throw new BridgeError("COORDINATION_TASK_AUTHORITY_UNAVAILABLE", "The task store is not prepared");
    const release = this.#reserveTaskAssociation(taskId);
    try {
      // Only the actual task owner can enroll; metadata sharing or recovery never supplies this permission.
      const state = await this.#store.readControl(taskId);
      owns(state, actor);
      const source = await managedTaskSource(this.#store, this.#binding.repositoryId, taskId);
      this.#assertAuthority();
      return Object.freeze({ ...source, ...managedWorkProjection(source, state.control_generation), release });
    } catch (error) { release(); throw error; }
  }
  async #authorizeCoordinationOperator(owner: string, purpose: "initialization" | "recovery"): Promise<void> {
    if (!this.#binding) throw new BridgeError("COORDINATION_SERVICE_BINDING_INVALID", "Operator control needs the resolved repository binding");
    const token = await operatorToken(this.#binding);
    const expected = token === undefined ? undefined : createHash("sha256").update(token).digest("hex");
    if (!expected || !timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(owner, "hex"))) {
      throw new BridgeError(purpose === "initialization" ? "COORDINATION_INITIALIZATION_FORBIDDEN" : "COORDINATION_RECOVERY_FORBIDDEN",
        "This operation requires the existing operator identity; task or connection ownership does not authorize it");
    }
    this.#assertAuthority();
  }
  async retainedTaskId(requestKey: string): Promise<string> {
    const record = await (await this.#readStore()).find({ request_key: requestKey });
    if (!record) throw new BridgeError("RESULT_NOT_FOUND", "No matching retained request");
    return record.task_id;
  }
  async taskObservation(id: string, actor: ClientActor): Promise<TaskObservation> {
    const observation = await (await this.#taskControls()).read(id, actor);
    if (observation.phase === "terminal") this.#scheduleTerminalBinding(id);
    return observation;
  }
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
      if (task.phase === "terminal") this.#scheduleTerminalBinding(task.task_id);
    }
    return { total: visible.length, offset, tasks, next_offset: offset + tasks.length < visible.length ? offset + tasks.length : null };
  }
  async waitTask(id: string, actor: ClientActor, after: number, budget: number, signal: AbortSignal) {
    const result = await (await this.#taskControls()).wait(id, actor, after, budget, signal);
    if (result.task.phase === "terminal") this.#scheduleTerminalBinding(id);
    return result;
  }
  async authorizeTask(id: string, actor: ClientActor): Promise<void> {
    const store = await this.#readStore(), record = await store.find({ task_id: id });
    if (record && "schema_version" in record) owns(await store.readControl(id), actor);
  }
  async attachTask(key: { task_id?: string | undefined; request_key?: string | undefined }, actor: ClientActor, operation: string) {
    return this.#track(async () => {
      const controls = await this.#taskControls(), id = await this.taskId(key);
      const release = this.#reserveTaskAssociation(id);
      try {
        const receipt = await controls.adopt(id, actor, operation);
        this.#forgetObservation(id);
        return { receipt, task: await controls.read(id, actor) };
      } finally { release(); }
    });
  }
  async cancelTask(id: string, actor: ClientActor, generation: number, operation: string, reason: string) {
    const controls = await this.#taskControls();
    if (this.#coordinator) return this.#coordinator.cancel(id, actor, generation, operation, reason);
    const receipt = await controls.cancel(id, actor, generation, operation, reason);
    const state = await this.#store!.readControl(id);
    const admitted = await this.#store!.durableRequest(id);
    if (admitted.schema_version === 5 && state.cancel && state.native.state === "not_started" && state.phase !== "terminal") {
      if (!this.#startupCoordinatedQueue.includes(id)) this.#startupCoordinatedQueue.push(id);
      await this.#reconcileStartupCoordinated();
      return receipt;
    }
    if (state.native.state === "not_started" && state.attention?.startsWith("Recovered queued") && !await this.#store!.readResult(id)) {
      const { baseResult } = await import("./result.js");
      const result = { ...baseResult(id, admitted.request, admitted.execution), execution_status: "cancelled" as const, summary: "Explicitly cancelled preserved never-started work", native_evidence: state.native };
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
    if (this.#preparation || this.#composition && !this.#coordinator || this.#obligationPending.size || this.#coordinator?.outstandingCount || this.#coordination?.pendingCount) return true;
    if (!this.#store) return false;
    for (const record of await this.#store.list()) if ((await this.#store.readState(record.task_id)).phase !== "terminal") return true;
    return false;
  }
  async stopAdmission(): Promise<void> { this.#admissionClosed = true; this.#coordinator?.closeAdmission(); this.#coordination?.beginDrain(); }
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
        let releaseTask: (() => void) | undefined;
        let reservation: Awaited<ReturnType<CoordinationService["reserveRetirement"]>>;
        try {
          releaseTask = this.#reserveTaskAssociation(operation.task_id);
          if (operation.disposition !== "retained") reservation = await this.#coordinationSession(this.#binding!).reserveRetirement(operation.task_id);
          results.push({ task_id: operation.task_id, operation_key: operation.operation_key, receipt: await manager.finalize(operation) });
        } catch (error) { results.push({ task_id: operation.task_id, operation_key: operation.operation_key, error: diagnosticInfo(error) }); }
        finally {
          try { await reservation?.release(); }
          finally { releaseTask?.(); }
        }
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
  reconcile(taskId: string, owner: string, reason: string, actor: ClientActor): Promise<void> {
    return this.#track(async () => {
      await this.#ensurePrepared(undefined, true); this.#assertOpen(); this.#assertAuthority();
      await this.#authorizeCoordinationOperator(actor.owner_id, "recovery");
      const release = this.#reserveTaskAssociation(taskId);
      try {
        const { acknowledgeStoppedTask } = await import("./recovery.js");
        await this.#controls!.withTaskMutation(taskId, async () => {
          this.#assertOpen(); this.#assertAuthority();
          await this.#authorizeCoordinationOperator(actor.owner_id, "recovery");
          if (this.#coordinator?.isActive(taskId)) throw new BridgeError("TASK_ACTIVE", "A live task cannot be reconciled as stopped");
          await acknowledgeStoppedTask(this.#store!, taskId, owner, reason);
        });
        const remaining = await this.#store!.frozenReason();
        this.#phase = remaining ? "frozen" : "ready";
        this.#failure = remaining ? diagnosticInfo(new BridgeError("PROJECT_NEEDS_RECONCILIATION", remaining)) : undefined;
      } finally { release(); }
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
        ...(this.#observationMonitor ? [this.#observationMonitor.close()] : []),
        ...(this.#observationStore ? [this.#observationStore.close()] : []),
        ...(this.#coordination ? [this.#coordination.close()] : []),
        ...(this.#nativeAnalysis ? [this.#nativeAnalysis.close()] : []),
        ...(this.#containment ? [this.#containment] : []),
      ]);
      await Promise.allSettled([...this.#pending]);
      this.#capturedPairs.clear();
      try {
        if (this.#lease?.state === "held") await this.#lease.release();
        const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
        if (failure) throw failure.reason;
      } finally { this.#phase = "closed"; }
    })();
  }
}
