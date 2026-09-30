import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { CoordinationService, type CoordinationServiceLimits } from "../service/coordination.js";
import { decodeCoordinationRequest, coordinationRequestLane, type CoordinationReply } from "../contracts/coordination-service.js";
import type { CoordinationActor } from "../coordination/control.js";
import type { ManagedEnrollment } from "../coordination/bound-control.js";
import { managedTaskSource, managedWorkProjection } from "./managed-coordination.js";
import { parentId, type Case, type ControlState, type Region, type Work } from "../contracts/coordination-control.js";
import { operatorToken } from "../service/operator-token.js";
import { privateDirectory } from "../service/process.js";
import { assertExternalWorkspace } from "./coordination-resources.js";
import type { DelegateRequest, DelegateResult, FinalizeOperation, ResultRequest, StoredResult } from "../contracts/types.js";
import type { RuntimeBinding, RuntimeIdentity, RuntimeStatus } from "../contracts/runtime.js";
import type { TaskStore } from "../store/task-store.js";
import type { Coordinator } from "./coordinator.js";
import type { AdapterDefinition, WorkerPeerOperationRequest } from "../agents/types.js";
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
import { CorrespondenceIndex, type CorrespondencePair, type CorrespondenceUpdate } from "../observation/correspondence.js";
import { selectPeerOverlapEvidence, type PeerOverlapEvidence, type PeerOverlapSelection } from "../observation/overlap.js";
import { applyPeerResolutionChanges } from "../coordination/peer-application.js";
import type { AttributedComparison, SourceFile, SourceReference } from "../observation/model.js";
import type { ObservationGeneration, ObservationPull } from "../contracts/observation.js";
import { MAX_PEER_DELIVERIES, MAX_PEER_DELIVERY_ENVELOPE_BYTES, peerDeliveryContentDigest, peerDeliveryEnvelopeBytes,
  peerDeliverySizingEnvelope, type PeerDeliveryEnvelope, type PeerDeliverySource,
  type PeerDeliverySlotBundle } from "../contracts/peer-delivery.js";
import { MAX_CODEX_PEER_DELIVERY_PROMPT_BYTES, peerDeliveryPromptBytes } from "../agents/report-format.js";
import { decodePeerWorkerOperation, type PeerWorkerOperation, type PeerWorkerOperationResult } from "../contracts/peer-operations.js";

import type { RepositoryLease } from "./lease.js";
import { BridgeError, diagnosticInfo, errorInfo, filesystemFailure, nativeCode } from "./errors.js";
import { Mutex, withAbort, canonicalHash } from "./async.js";

const PREPARATION_TIMEOUT_MS = 90_000;
// Initial safety bounds for metadata work, distinct from native inference capacity.
const coordinationLimits: CoordinationServiceLimits = Object.freeze({
  ordinary_requests: 16, control_requests: 4, max_source_operations: 4, max_worktrees: 256,
});
const coordinationResourceRecords = 4096;
// PeerDeliveryEnvelopeSchema owns this content cap. Selection must leave room for
// the complete serialized content, including identities and JSON escaping.
const PEER_DELIVERY_CONTENT_BYTES = 16_384;
const PEER_RECONCILIATION_ATTEMPTS = 4;
const PEER_RECONCILIATION_DELAY_MS = 40;
type SelectedCaseReconciliation = { requested: boolean; running: Promise<void> | undefined;
  receiptRequested: boolean; receiptRunning: Promise<void> | undefined;
  diagnostic: string | undefined; pendingWorkIds: string[] };
// A dispatched obsolete turn can currently freeze its worker. The controlled extension
// remains unavailable until native receipts and current content authority are separated.
export function assertObservedExtensionDeliveryCapacity(retainedCounts: readonly number[], selectedCount: number): void {
  if (retainedCounts.some(count => count + selectedCount - 1 > MAX_PEER_DELIVERIES))
    throw new BridgeError("PEER_DELIVERY_CAPACITY", "Recipient cannot retain every revised peer envelope");
}
export function assertObservedExtensionEvidenceCurrent(
  pinnedPairs: readonly Readonly<{ id: string; digest: string }>[],
  pinnedArtifacts: readonly Readonly<{ id: string; path: string; artifact: Readonly<{ id: string; owner: string }> }>[],
  currentPairs: ReadonlyMap<string, CorrespondencePair>,
  currentArtifacts: ReadonlyMap<string, Readonly<{ id: string; owner: string }>>,
): void {
  if (pinnedPairs.some(pinned => {
    const current = currentPairs.get(pinned.id);
    return !current || canonicalHash(current) !== pinned.digest;
  }) || pinnedArtifacts.some(pinned => {
    const current = currentArtifacts.get(JSON.stringify([pinned.id, pinned.path]));
    return !current || current.id !== pinned.artifact.id || current.owner !== pinned.artifact.owner;
  })) throw new BridgeError("PEER_DELIVERY_STALE", "Selected overlap capture changed before case publication");
}
type PeerSourceContext = Readonly<{ source_artifact_id: string; recipient_artifact_id: string }>;
export async function appendWorkerPeerOperationStartEvent(store: Pick<TaskStore, "appendEvent">,
  taskId: string, operation: PeerWorkerOperation, created: boolean): Promise<boolean> {
  if (!created) return true;
  return store.appendEvent(taskId, { kind: "worker_peer_operation_started", operation: operation.kind,
    operation_key: operation.operation_key, case_id: operation.case_id, run_id: operation.run_id,
    control_generation: operation.control_generation });
}
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
function observedSourceIdentity(source: SourceReference): string {
  return canonicalHash({ status: source.status, content_sha256: source.content_sha256 ?? null,
    mode: source.mode ?? null, entry_kind: source.entry_kind ?? null,
    object_oid: source.object_oid ?? null });
}
/** Compact correspondence is evidence of overlap, not changed source detail or authorship. */
function peerDeliveryContent(pair: CorrespondencePair, peerCase: Case, source: Work, target: Work,
  artifactId: string, selectedEvidence?: Pick<PeerOverlapEvidence, "limitations">,
  sourceContext?: PeerSourceContext): string {
  const sourceChange = source.id === pair.current_work_id ? pair.current_change : pair.other_change;
  const otherChange = source.id === pair.current_work_id ? pair.other_change : pair.current_change;
  return JSON.stringify({ schema_version: selectedEvidence ? 2 : 1, kind: "peer_overlap_evidence",
    source_work_id: source.id, source_work_revision: source.revision, source_artifact_id: artifactId,
    case_id: peerCase.id, case_revision: peerCase.revision, case_generation: peerCase.generation,
    input: { repository_id: pair.input.repository_id, object_format: pair.input.object_format,
      commit_oid: pair.input.commit_oid, tree_oid: pair.input.tree_oid,
      path_sha256: createHash("sha256").update(pair.input.path).digest("hex"), range: pair.input_range },
    subject_id: pair.subject_id, pair_id: pair.pair_id,
    source_change: sourceChange, recipient_change: otherChange,
    ...(selectedEvidence ? { ...(sourceContext ? { participants: [source, target].map((work, index) => ({
      work_id: work.id, task_id: work.managed?.task_id, intent: work.intent,
      intent_truncated: work.managed?.intent_truncated ?? false, areas: work.areas,
      report_id: index === 0 ? sourceContext.source_artifact_id : sourceContext.recipient_artifact_id,
    })) } : {}), selected_evidence: selectedEvidence,
      limitations: [...selectedEvidence.limitations, "authorship_unproven"] }
      : { limitations: ["compact_correspondence_only", "changed_source_detail_unavailable", "authorship_unproven"] }) });
}
export function peerDeliveryCandidate(pair: CorrespondencePair, peerCase: Case, source: Work,
  target: Work, recipientTaskId: string, artifactId: string, selectedEvidence?: PeerOverlapEvidence,
  sourceContext?: PeerSourceContext): PeerDeliverySource | undefined {
  if (peerCase.state !== "active" || source.id === target.id ||
    !peerCase.inputs.some(input => input.work_id === source.id) ||
    !peerCase.inputs.some(input => input.work_id === target.id) ||
    !target.managed || target.managed.task_id !== recipientTaskId ||
    ![pair.current_work_id, pair.other_work_id].includes(source.id) ||
    ![pair.current_work_id, pair.other_work_id].includes(target.id)) return undefined;
  const sourceChange = source.id === pair.current_work_id ? pair.current_change : pair.other_change;
  const otherChange = source.id === pair.current_work_id ? pair.other_change : pair.current_change;
  const evidence_id = canonicalHash([artifactId, pair.pair_id, sourceChange.evidence_id, otherChange.evidence_id]);
  const content = peerDeliveryContent(pair, peerCase, source, target, artifactId, selectedEvidence, sourceContext);
  if (Buffer.byteLength(content, "utf8") > PEER_DELIVERY_CONTENT_BYTES) {
    throw new BridgeError("PEER_DELIVERY_METADATA_TOO_LARGE",
      "Required peer delivery metadata and selected evidence exceed the bounded content");
  }
  return { source_work_id: source.id, source_work_revision: source.revision,
    case_id: peerCase.id, case_revision: peerCase.revision, case_generation: peerCase.generation,
    evidence_id, evidence_revision: source.revision, content, evidence_digest: peerDeliveryContentDigest(content),
    idempotency_key: canonicalHash([recipientTaskId, peerCase.id, peerCase.revision,
      peerCase.generation, source.id, source.revision, evidence_id]) };
}
/** Select against the bytes of the complete consumer message, including repeated JSON escaping. */
export function selectPeerDeliveryEvidence(selection: PeerOverlapSelection, pair: CorrespondencePair,
  peerCase: Case, source: Work, target: Work, recipientTaskId: string,
  sourceContext: PeerSourceContext, recipientWorkspace: string): PeerOverlapEvidence {
  const selectAt = (budget: number): PeerOverlapEvidence | undefined => {
    let evidence: PeerOverlapEvidence;
    try {
      evidence = selectPeerOverlapEvidence({ ...selection, budget_bytes: budget });
    } catch (error) {
      if (errorInfo(error).code === "STRUCTURAL_OVERLAP_INVALID" &&
        error instanceof BridgeError && error.message.includes("budget is too small for its required metadata")) {
        return undefined;
      }
      throw error;
    }
    return evidence;
  };
  // First find the smallest qualified evidence. Escaped participant metadata
  // can consume most of an envelope; subtracting the excess from a trial
  // budget can jump below this floor even when a compact selection fits.
  let lower = 512, upper = PEER_DELIVERY_CONTENT_BYTES;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (selectAt(middle)) upper = middle;
    else lower = middle + 1;
  }
  const minimum = selectAt(lower);
  if (!minimum) throw new BridgeError("PEER_DELIVERY_METADATA_TOO_LARGE",
    "Required selected overlap metadata cannot fit the bounded peer delivery");
  const fits = (evidence: PeerOverlapEvidence): boolean => {
    const content = peerDeliveryContent(pair, peerCase, source, target,
      sourceContext.source_artifact_id, evidence, sourceContext);
    if (Buffer.byteLength(content, "utf8") > PEER_DELIVERY_CONTENT_BYTES) return false;
    const candidate = peerDeliveryCandidate(pair, peerCase, source, target,
      recipientTaskId, sourceContext.source_artifact_id, evidence, sourceContext);
    if (!candidate) throw new BridgeError("PEER_DELIVERY_UNAVAILABLE", "Selected peer delivery is no longer current");
    return peerDeliveryEnvelopeBytes(candidate, recipientWorkspace) <= MAX_PEER_DELIVERY_ENVELOPE_BYTES &&
      peerDeliveryPromptBytes(peerDeliverySizingEnvelope(candidate, recipientWorkspace), "codex") <=
        MAX_CODEX_PEER_DELIVERY_PROMPT_BYTES;
  };
  if (!fits(minimum)) throw new BridgeError("PEER_DELIVERY_METADATA_TOO_LARGE",
    "Required peer evidence cannot fit the encoded delivery envelope");
  let best = minimum;
  lower++;
  upper = PEER_DELIVERY_CONTENT_BYTES;
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2);
    const evidence = selectAt(middle);
    if (evidence && fits(evidence)) { best = evidence; lower = middle + 1; }
    else upper = middle - 1;
  }
  return best;
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
  /** Internal, completion-only observation of a durable delivery reconciliation attempt. */
  onObservedCaseSettlement?: (attempt: Readonly<{ case_id: string; recipient_work_id: string;
    observed_delivery_ids: readonly string[]; outcome: "completed" | "rejected" | "failed" }>) => void;
  /** Controlled in-process composition only; production construction leaves extension disabled. */
  enableObservedCaseExtensionForTest?: true;
  /** Completion barrier for deterministic controlled reservation races; never used by service configuration. */
  onObservedCaseSlotsReservedForTest?: (taskIds: readonly string[], controls: TaskControls) => Promise<void>;
  /** Controlled interruption before one queued revised edge; absent from production composition. */
  beforeObservedCaseDeliveryQueueForTest?: (edge: Readonly<{ case_id: string; case_revision: number;
    recipient_task_id: string; source_work_id: string }>) => void;
  /** Controlled failure after exact native observations, before final metadata settlement. */
  beforeObservedCaseDeliverySettlementForTest?: (attempt: Readonly<{ case_id: string;
    recipient_work_id: string; pending_count: number }>) => void;
  /** Holds the terminal wake's exact metadata snapshot await in a controlled shutdown fixture. */
  onTerminalCaseWakeSnapshotForTest?: (snapshot: Promise<ControlState>) => Promise<ControlState>;
  /** Exposes a coalesced same-runtime wake only to an injected controlled fixture. */
  onObservedCaseExtensionPublishedForTest?: (caseId: string, retry: () => Promise<void>) => void;
  /** Signals a controlled capture publication before its task/capture reservation. */
  onCapturePublicationAttemptForTest?: (workId: string, path: string) => void;
  /** Signals a controlled capture publication after its reservation releases. */
  onCapturePublicationCompletedForTest?: (workId: string, path: string, artifactId: string) => void;
  /** Lowers only the in-memory artifact index limit for a controlled race fixture. */
  artifactIndexLimitForTest?: number;
  onArtifactIndexEvictedForTest?: (workId: string, path: string, artifactId: string) => void;
  /** Lowers only the in-memory pair index limit for a controlled race fixture. */
  pairIndexLimitForTest?: number;
  onPairIndexEvictedForTest?: (pairId: string, workIds: readonly string[], path: string,
    artifacts: readonly Readonly<{ workId: string; path: string; artifactId: string }>[],
    admitted: Readonly<{ pairId: string; workIds: readonly string[]; path: string }>) => void;
  /** Signals an actual capture-index removal before and after its protected mutation. */
  onCaptureRemovalAttemptForTest?: (workId: string) => void;
  onCaptureRemovalCompletedForTest?: (workId: string) => void;
  /** Same-live retained comparison race seam; never reattaches a native task. */
  onRetainedCaptureRestoreForTest?: (restore: (workId: string) => Promise<boolean>) => void;
  /** Pauses after genuine retained comparison, before its protected index install. */
  beforeRetainedCaptureInstallForTest?: (workId: string, artifactId: string) => Promise<void>;
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
  let profilePath = intent.profilePath ?? (configRoot ? join(configRoot, "muse-bridge", "projects", `${repository.id}.json`) : undefined);
  if (!intent.profilePath && configRoot && profilePath && basename(repository.common_dir) === ".git") {
    const legacyProfile = join(configRoot, "muse-bridge", "projects", `${projectId(dirname(repository.common_dir))}.json`);
    if (legacyProfile !== profilePath) {
      const exists = async (path: string): Promise<boolean> => {
        try { await (await import("node:fs/promises")).lstat(path); return true; }
        catch (error) {
          if (nativeCode(error) === "ENOENT") return false;
          throw filesystemFailure(error, "profile.binding", path);
        }
      };
      if (!await exists(profilePath) && await exists(legacyProfile)) profilePath = legacyProfile;
    }
  }
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
  readonly #artifactIndexLimit: number;
  readonly #pairIndexLimit: number;
  readonly #captureIndex = new Mutex();
  readonly #correspondence = new CorrespondenceIndex();
  readonly #currentOverlapPairs = new Map<string, CorrespondencePair>();
  readonly #publishedArtifactIds = new Map<string, Readonly<{ id: string; owner: string }>>();
  readonly #publishedComparisons = new Map<string, AttributedComparison>();
  readonly #pendingCorrespondenceNotices = new Map<string, PendingCorrespondenceNotice>();
  readonly #observationFailures = new Map<string, string>();
  readonly #deliveryReconciliation = new Map<string, SelectedCaseReconciliation>();
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
  readonly #taskAssociationWaiters = new Map<string, Set<() => void>>();
  #coordinationOrdinary = 0;
  #coordinationControls = 0;
  readonly #coordinatedAdmission = new Mutex();
  readonly #terminalBindingInFlight = new Set<string>();
  readonly #terminalBindingDone = new Set<string>();
  readonly #terminalCaseWakes = new Set<Promise<void>>();
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
    this.#artifactIndexLimit = dependencies.artifactIndexLimitForTest ?? 512;
    if (!Number.isSafeInteger(this.#artifactIndexLimit) || this.#artifactIndexLimit < 1 || this.#artifactIndexLimit > 512)
      throw new BridgeError("STRUCTURAL_MONITOR_CONFIGURATION_INVALID", "Invalid controlled artifact index limit");
    this.#pairIndexLimit = dependencies.pairIndexLimitForTest ?? 8192;
    if (!Number.isSafeInteger(this.#pairIndexLimit) || this.#pairIndexLimit < 1 || this.#pairIndexLimit > 8192)
      throw new BridgeError("STRUCTURAL_MONITOR_CONFIGURATION_INVALID", "Invalid controlled pair index limit");
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
      this.#deps.onRetainedCaptureRestoreForTest?.(async workId => {
        const snapshot = await metadata.snapshot();
        const work = snapshot.works.find(item => item.id === workId && item.state === "active");
        if (!work) return false;
        const current = await this.#observationStore!.listCurrent(work.owner, (recipient, id, revision, generation) =>
          this.#authorizeObservation(recipient, id, revision, generation, "report"));
        const item = current.reports.find(report => report.work_id === work.id && report.work_revision === work.revision);
        return item ? this.#restoreRetainedComparison(work, item, this.#observationStore!) : false;
      });
      this.#observationMonitor = new ObservationMonitor<readonly MonitoredPair[]>({
        analyze: job => this.#analyzeObservation(job),
        publish: async (job, pairs, isCurrent) => {
          await this.#drainCorrespondenceNotices();
          for (const pair of pairs) {
            const publish = async () => {
              if (!isCurrent()) return null;
              const work = await this.#currentSourceWork(pair.report.parent_id, job.workspace.work_id, "report");
              if (!isCurrent() || work.revision !== job.workspace.work_revision ||
                (work.managed && (await this.#store!.readControl(work.managed.task_id)).control_generation !== job.workspace.control_generation)) return null;
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
              const previous = this.#publishedComparisons.get(artifactKey);
              const sourceChanged = previous !== undefined &&
                observedSourceIdentity(previous.comparison.observed) !== observedSourceIdentity(pair.report.comparison.observed);
              this.#publishedArtifactIds.set(artifactKey, { id: artifact.id, owner: work.owner });
              this.#publishedComparisons.set(artifactKey, pair.report);
              let evictedArtifact: { workId: string; path: string; artifactId: string } | undefined;
              if (this.#publishedArtifactIds.size > this.#artifactIndexLimit) {
                const key = this.#publishedArtifactIds.keys().next().value!;
                const previousArtifact = this.#publishedArtifactIds.get(key)!;
                const [evictedWorkId, evictedPath] = JSON.parse(key) as [string, string];
                evictedArtifact = { workId: evictedWorkId, path: evictedPath, artifactId: previousArtifact.id };
                this.#publishedArtifactIds.delete(key);
              }
              if (this.#publishedComparisons.size > this.#artifactIndexLimit)
                this.#publishedComparisons.delete(this.#publishedComparisons.keys().next().value!);
              const correspondence = this.#correspondence.upsert(pair.report);
              const evictedPairs = this.#retainCorrespondence(correspondence);
              for (const [state, events] of [["overlap", correspondence.pairs], ["resolved", correspondence.resolved]] as const) {
                for (const event of events) {
                  this.#queueCorrespondenceNotice({ artifactId: artifact.id, recipient: work.owner, workId: work.id,
                    subjectId: event.subject_id, state });
                  const other = this.#publishedArtifactIds.get(JSON.stringify([event.other_work_id, path]));
                  if (other) this.#queueCorrespondenceNotice({ artifactId: other.id, recipient: other.owner,
                    workId: event.other_work_id, subjectId: event.subject_id, state });
                }
              }
              return { correspondence, sourceChanged, workId: work.id, path, artifactId: artifact.id,
                evictedArtifact, evictedPairs,
                indexedArtifacts: evictedPairs.length ? [...this.#publishedArtifactIds].map(([key, value]) => {
                  const [id, artifactPath] = JSON.parse(key) as [string, string];
                  return { workId: id, path: artifactPath, artifactId: value.id };
                }) : [] };
            };
            const managedTaskId = job.workspace.control_generation ?
              (await (await this.#coordinationSession(this.#binding!).observationStore()).snapshot()).works
                .find(work => work.id === job.workspace.work_id)?.managed?.task_id : undefined;
            const publishProtected = () => this.#captureIndex.run(publish);
            this.#deps.onCapturePublicationAttemptForTest?.(job.workspace.work_id, pair.report.comparison.input.source.path);
            const published = managedTaskId
              ? await (await this.#taskControls()).withTaskPublication([managedTaskId], publishProtected)
              : await publishProtected();
            if (!published) return;
            this.#deps.onCapturePublicationCompletedForTest?.(published.workId, published.path, published.artifactId);
            if (published.evictedArtifact) this.#deps.onArtifactIndexEvictedForTest?.(
              published.evictedArtifact.workId, published.evictedArtifact.path, published.evictedArtifact.artifactId);
            for (const evicted of published.evictedPairs) this.#deps.onPairIndexEvictedForTest?.(
              evicted.evicted.pair_id, [evicted.evicted.current_work_id, evicted.evicted.other_work_id],
              evicted.evicted.input.path, published.indexedArtifacts,
              { pairId: evicted.admitted.pair_id,
                workIds: [evicted.admitted.current_work_id, evicted.admitted.other_work_id],
                path: evicted.admitted.input.path });
            if (published.sourceChanged) await this.#coordinationSession(this.#binding!).notifyPeerObservation(published.workId, published.path);
            for (const event of published.correspondence.pairs) await this.#queuePeerOverlap(event);
            await this.#wakeCasesForWork(published.workId);
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
  /** The task control supplies the principal; envelope text and selectors never supply authority. */
  async #settlementTaskEligible(taskId: string, control: Awaited<ReturnType<TaskStore["readControl"]>>): Promise<boolean> {
    if (control.phase === "active") return !control.cancel;
    if (control.phase !== "terminal" || control.outcome !== "completed" || control.cancel ||
      control.native.state !== "stopped" || control.native.coverage !== "turn_scoped" ||
      control.native.obligations.length) return false;
    const result = await this.#store!.readResult(taskId);
    return result?.schema_version === 4 && result.task_id === taskId &&
      result.execution_status === "completed" && result.worker_stop === "confirmed" &&
      result.native_evidence.state === "stopped" && result.native_evidence.run_id === control.native.run_id &&
      result.native_evidence.coverage === "turn_scoped" && !result.native_evidence.obligations.length;
  }
  async #authorizePeerDelivery(envelope: PeerDeliveryEnvelope,
    settlementOnly = false): Promise<"current" | "stale" | "revoked"> {
    this.#assertOpen(); this.#assertAuthority();
    const binding = this.#binding, store = this.#store;
    if (!binding || !store) return "stale";
    const control = await store.readControl(envelope.recipient_task_id);
    if (control.control_generation !== envelope.recipient_control_generation || control.native.run_id !== envelope.recipient_run_id ||
      (settlementOnly ? !await this.#settlementTaskEligible(envelope.recipient_task_id, control)
        : control.phase !== "active" || control.cancel)) return "stale";
    const admission = await store.durableRequest(envelope.recipient_task_id);
    const resource = await store.readResource(envelope.recipient_task_id);
    if (admission.schema_version !== 5 || admission.project_id !== binding.repositoryId ||
      (resource?.state !== "pending" && (!settlementOnly || resource?.state !== "retained")) ||
      resource.project_id !== binding.repositoryId ||
      resource.worktree_path !== envelope.recipient_workspace) return "stale";
    if (canonicalHash({ task_id: envelope.recipient_task_id, source_view: admission.source_view,
      workspace: resource.worktree_path, base_commit: resource.base_commit, branch_ref: resource.branch_ref,
      target_ref: resource.target_ref }) !== envelope.recipient_workspace_fingerprint) return "stale";

    const metadata = this.#coordinationSession(binding);
    // The elected metadata store is capacity bounded. A snapshot keeps case membership,
    // selected inputs, work identity and grants at one metadata revision.
    const snapshot = await (await metadata.observationStore()).snapshot();
    const peerCase = snapshot.cases.find(item => item.id === envelope.case_id);
    if (!peerCase || peerCase.state !== "active" || peerCase.revision !== envelope.case_revision ||
      peerCase.generation !== envelope.case_generation ||
      !peerCase.inputs.some(input => input.work_id === envelope.source_work_id)) return "stale";
    const recipientWorks = snapshot.works.filter(item => item.managed?.task_id === envelope.recipient_task_id && item.state === "active");
    const recipientWork = recipientWorks[0];
    if (recipientWorks.length !== 1 || !recipientWork || recipientWork.owner !== control.owner_id ||
      recipientWork.managed?.control_generation !== control.control_generation) return "stale";
    if (!peerCase.inputs.some(input => input.work_id === recipientWork.id)) return "stale";
    if (!peerCase.members.includes(control.owner_id)) return "revoked";
    const source = snapshot.works.find(item => item.id === envelope.source_work_id);
    if (!source || source.state !== "active" || source.revision !== envelope.source_work_revision) return "stale";
    // An envelope is usable only while its exact compact pair and retained source artifact remain current.
    let content: { pair_id?: unknown; source_artifact_id?: unknown };
    try { content = JSON.parse(envelope.content) as typeof content; } catch { return "stale"; }
    if (typeof content.pair_id !== "string" || typeof content.source_artifact_id !== "string") return "stale";
    const pair = this.#currentOverlapPairs.get(content.pair_id);
    if (!pair || ![pair.current_work_id, pair.other_work_id].includes(source.id) ||
      ![pair.current_work_id, pair.other_work_id].includes(recipientWork.id)) return "stale";
    const artifact = this.#publishedArtifactIds.get(JSON.stringify([source.id, pair.input.path]));
    if (!artifact || artifact.id !== content.source_artifact_id || artifact.owner !== source.owner || !this.#observationStore) return "stale";
    const evidence = await this.#selectedOverlapEvidence(pair, peerCase, envelope.recipient_task_id,
      source, recipientWork, resource.worktree_path, false, settlementOnly);
    const recipientArtifact = this.#publishedArtifactIds.get(JSON.stringify([recipientWork.id, pair.input.path]));
    if (!recipientArtifact) return "stale";
    const currentCandidate = peerDeliveryCandidate(pair, peerCase, source, recipientWork,
      envelope.recipient_task_id, artifact.id, evidence,
      { source_artifact_id: artifact.id, recipient_artifact_id: recipientArtifact.id });
    if (!currentCandidate || canonicalHash(currentCandidate) !== canonicalHash({
      source_work_id: envelope.source_work_id, source_work_revision: envelope.source_work_revision,
      case_id: envelope.case_id, case_revision: envelope.case_revision, case_generation: envelope.case_generation,
      evidence_id: envelope.evidence_id, evidence_revision: envelope.evidence_revision,
      evidence_digest: envelope.evidence_digest, content: envelope.content, idempotency_key: envelope.idempotency_key,
    })) return "stale";
    try {
      const retained = await this.#observationStore.readRetainedPair(artifact.id, control.owner_id,
        (_recipient, workId, revision, generation) => this.#authorizePeerCaseSource(peerCase.id,
          envelope.recipient_task_id, workId, revision, generation, "report", settlementOnly));
      if (retained.work_id !== source.id || retained.work_revision !== source.revision ||
        retained.path !== pair.input.path || retained.input.source.kind !== "commit" ||
        retained.input.source.commit_oid !== pair.input.commit_oid ||
        retained.input.source.repository_id !== pair.input.repository_id) return "stale";
    } catch (error) {
      const code = errorInfo(error).code;
      if (code === "STRUCTURAL_SOURCE_FORBIDDEN") return "revoked";
      if (code === "STRUCTURAL_DETAIL_UNAVAILABLE") return "stale";
      throw error;
    }
    try { await this.#authorizePeerCaseSource(peerCase.id, envelope.recipient_task_id, source.id,
      source.revision, { control_generation: source.managed?.control_generation ?? null,
        workspace_generation: source.managed?.control_generation ?? Math.max(1, source.revision) }, "report", settlementOnly); }
    catch (error) {
      if (errorInfo(error).code === "STRUCTURAL_SOURCE_FORBIDDEN") {
        const current = await (await metadata.observationStore()).snapshot();
        const currentCase = current.cases.find(item => item.id === envelope.case_id);
        const currentWork = current.works.find(item => item.id === source.id);
        return !currentCase || currentCase.state !== "active" || currentCase.revision !== envelope.case_revision ||
          !currentWork || currentWork.state !== "active" || currentWork.revision !== envelope.source_work_revision ? "stale" : "revoked";
      }
      throw error;
    }
    let recipientSource;
    try { recipientSource = await managedTaskSource(store, binding.repositoryId, envelope.recipient_task_id); }
    catch (error) { if (errorInfo(error).code.startsWith("COORDINATION_TASK_")) return "stale"; throw error; }
    if (recipientSource.root !== envelope.recipient_workspace || recipientSource.input_oid !== recipientWork.input_oid) return "stale";
    const { CoordinationRepository } = await import("../coordination/repository.js");
    try {
      const repository = await CoordinationRepository.open(recipientSource.root, binding.repositoryId, coordinationLimits.max_worktrees);
      const workspace = await repository.inspect(recipientSource.root);
      if (workspace.workspace_id !== recipientWork.workspace_id || workspace.repository_id !== binding.repositoryId) return "stale";
      if (source.managed) {
        const sourceControl = await store.readControl(source.managed.task_id);
        if (sourceControl.owner_id !== source.owner || sourceControl.control_generation !== source.managed.control_generation) return "stale";
        let sourceTask;
        try { sourceTask = await managedTaskSource(store, binding.repositoryId, source.managed.task_id); }
        catch (error) { if (errorInfo(error).code.startsWith("COORDINATION_TASK_")) return "stale"; throw error; }
        if (sourceTask.input_oid !== source.input_oid) return "stale";
        const sourceWorkspace = await repository.inspect(sourceTask.root);
        if (sourceWorkspace.workspace_id !== source.workspace_id || sourceWorkspace.repository_id !== binding.repositoryId) return "stale";
        const latestSourceControl = await store.readControl(source.managed.task_id);
        if (latestSourceControl.owner_id !== source.owner || latestSourceControl.control_generation !== source.managed.control_generation) return "stale";
      }
    } catch (error) {
      if (["COORDINATION_WORKSPACE_UNREGISTERED", "COORDINATION_WORKSPACE_UNAVAILABLE", "COORDINATION_WORKSPACE_CHANGED"].includes(errorInfo(error).code)) return "stale";
      throw error;
    }
    if ((await (await metadata.observationStore()).snapshot()).revision !== snapshot.revision) return "stale";
    this.#assertAuthority();
    return "current";
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
  /** Internal peer read binds source bytes to selected managed tasks, never to a parent-wide source grant. */
  async #authorizePeerCaseSource(caseId: string, recipientTaskId: string, workId: string,
    workRevision: number, generation: ObservationGeneration, scope: "report" | "detail",
    settlementOnly = false): Promise<void> {
    const binding = this.#binding, store = this.#store;
    if (!binding || !store) throw new BridgeError("PEER_OPERATION_UNAVAILABLE", "Peer source authority is unavailable");
    const snapshot = await (await this.#coordinationSession(binding).observationStore()).snapshot();
    const item = snapshot.cases.find(candidate => candidate.id === caseId && candidate.state === "active");
    const source = snapshot.works.find(candidate => candidate.id === workId && candidate.state === "active");
    const recipient = snapshot.works.find(candidate => candidate.managed?.task_id === recipientTaskId && candidate.state === "active");
    const caseGrant = item?.visibility_delta?.find(delta => delta.work_id === source?.id &&
      delta.work_revision === source?.revision && delta.control_generation === source?.managed?.control_generation &&
      canonicalHash(delta.areas) === canonicalHash(source?.areas) && delta.added_readers.includes(recipient?.owner ?? ""));
    if (!item || !source?.managed || !recipient?.managed || source.revision !== workRevision ||
      !item.inputs.some(input => input.work_id === source.id) ||
      !item.inputs.some(input => input.work_id === recipient.id) ||
      source.owner !== recipient.owner && !source.readers.includes(recipient.owner) && !caseGrant ||
      !item.members.includes(source.owner) || !item.members.includes(recipient.owner)) {
      throw new BridgeError("PEER_OPERATION_FORBIDDEN", "Captured source is outside the current selected managed case");
    }
    const [sourceControl, recipientControl, sourceResource, recipientResource] = await Promise.all([
      store.readControl(source.managed.task_id), store.readControl(recipientTaskId),
      store.readResource(source.managed.task_id), store.readResource(recipientTaskId),
    ]);
    if (sourceControl.owner_id !== source.owner || sourceControl.control_generation !== source.managed.control_generation ||
      (settlementOnly ? !await this.#settlementTaskEligible(source.managed.task_id, sourceControl)
        : sourceControl.phase !== "active" || sourceControl.cancel) ||
      (sourceResource?.state !== "pending" && (!settlementOnly || sourceResource?.state !== "retained")) ||
      recipientControl.owner_id !== recipient.owner || recipientControl.control_generation !== recipient.managed.control_generation ||
      (settlementOnly ? !await this.#settlementTaskEligible(recipientTaskId, recipientControl)
        : recipientControl.phase !== "active" || recipientControl.cancel) ||
      (recipientResource?.state !== "pending" && (!settlementOnly || recipientResource?.state !== "retained"))) {
      throw new BridgeError("PEER_OPERATION_STALE", "Selected task source authority changed");
    }
    const [sourceTask, recipientTask] = await Promise.all([
      managedTaskSource(store, binding.repositoryId, source.managed.task_id),
      managedTaskSource(store, binding.repositoryId, recipientTaskId),
    ]);
    if (sourceTask.root !== sourceResource.worktree_path || recipientTask.root !== recipientResource.worktree_path ||
      sourceTask.input_oid !== source.input_oid || recipientTask.input_oid !== recipient.input_oid) {
      throw new BridgeError("PEER_OPERATION_STALE", "Selected task workspace identity changed");
    }
    const { CoordinationRepository } = await import("../coordination/repository.js");
    const repository = await CoordinationRepository.open(binding.project, binding.repositoryId, coordinationLimits.max_worktrees);
    const [sourceWorkspace, recipientWorkspace] = await Promise.all([
      repository.inspect(sourceTask.root), repository.inspect(recipientTask.root),
    ]);
    if (sourceWorkspace.workspace_id !== source.workspace_id || recipientWorkspace.workspace_id !== recipient.workspace_id ||
      sourceWorkspace.repository_id !== binding.repositoryId || recipientWorkspace.repository_id !== binding.repositoryId) {
      throw new BridgeError("PEER_OPERATION_STALE", "Selected task physical workspace changed");
    }
    await this.#authorizeObservation(source.owner, source.id, workRevision, generation, scope);
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
    if (!this.#binding) return;
    let snapshot;
    try { snapshot = await (await this.#coordinationSession(this.#binding).observationStore()).snapshot(); }
    catch (error) { if (errorInfo(error).code === "COORDINATION_NOT_ENABLED") return; throw error; }
    for (const item of snapshot.cases.filter(candidate => candidate.delivery_pending?.length))
      await this.#settleObservedCaseDeliveries(item.id);
    if (!this.#monitorEnabled) return;
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
        const restore = () => this.#captureIndex.run(async () => {
          const current = await store.listCurrent(work.owner, (recipient, workId, revision, generation) =>
            this.#authorizeObservation(recipient, workId, revision, generation, "report"));
          owners.set(work.owner, current);
          for (const item of current.reports.filter(item => item.work_id === work.id && item.work_revision === work.revision))
            this.#publishedArtifactIds.set(JSON.stringify([work.id, item.path]), { id: item.id, owner: work.owner });
        });
        if (work.managed) await (await this.#taskControls()).withTaskPublication([work.managed.task_id], restore);
        else await restore();
      } catch (error) { this.#observationFailures.set(work.id, errorInfo(error).code); }
    }
    for (const work of selected) {
      const current = owners.get(work.owner);
      if (!current) continue;
      for (const item of current.reports.filter(item => item.work_id === work.id && item.work_revision === work.revision)) {
        try {
          await this.#restoreRetainedComparison(work, item, store);
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
    for (const item of snapshot.cases.filter(candidate => candidate.delivery_pending?.length))
      await this.#settleObservedCaseDeliveries(item.id);
  }
  async #restoreRetainedComparison(work: Work,
    item: Awaited<ReturnType<ObservationStore["listCurrent"]>>["reports"][number], store: ObservationStore): Promise<boolean> {
    const retained = await store.readRetainedPair(item.id, work.owner, (recipient, workId, revision, generation) =>
      this.#authorizeObservation(recipient, workId, revision, generation, "report"));
    const { sourceDialectForPath } = await import("../observation/language-routing.js");
    const override = work.source_watches?.flatMap(watch => watch.dialect_overrides ?? []).find(route => route.path === item.path)?.dialect;
    const dialect = sourceDialectForPath(item.path, override);
    if (!dialect) return false;
    const { compareCapturedWork } = await import("../observation/comparison.js");
    const { NativeAnalysisHelper } = await import("../observation/helper.js");
    this.#nativeAnalysis ??= new NativeAnalysisHelper(this.#identity.mode === "installed" ? this.#identity.build_id : undefined);
    const compared = await compareCapturedWork({ work_id: work.id, parent_id: work.owner, dialect,
      input: retained.input, observed: retained.observed }, this.#nativeAnalysis, this.#lifetime.signal);
    await this.#deps.beforeRetainedCaptureInstallForTest?.(work.id, item.id);
    const restore = () => this.#captureIndex.run(() => {
      if (this.#publishedArtifactIds.get(JSON.stringify([work.id, item.path]))?.id !== item.id) return undefined;
      const update = this.#correspondence.upsert(compared.report);
      this.#publishedComparisons.set(JSON.stringify([work.id, item.path]), compared.report);
      const emitted = new Set(update.pairs.map(pair => pair.pair_id));
      const missing = this.#correspondence.pairsFor(work.id, item.path).filter(pair =>
        !emitted.has(pair.pair_id) && !this.#currentOverlapPairs.has(pair.pair_id));
      this.#retainCorrespondence({ pairs: [...update.pairs, ...missing], resolved: update.resolved });
      for (const event of update.pairs) {
        this.#queueCorrespondenceNotice({ artifactId: item.id, recipient: work.owner, workId: work.id,
          subjectId: event.subject_id, state: "overlap" });
        const peer = this.#publishedArtifactIds.get(JSON.stringify([event.other_work_id, item.path]));
        if (peer) this.#queueCorrespondenceNotice({ artifactId: peer.id, recipient: peer.owner,
          workId: event.other_work_id, subjectId: event.subject_id, state: "overlap" });
      }
      return update;
    });
    const update = work.managed
      ? await (await this.#taskControls()).withTaskPublication([work.managed.task_id], restore)
      : await restore();
    if (!update) return false;
    for (const event of update.pairs) await this.#queuePeerOverlap(event);
    await this.#wakeCasesForWork(work.id);
    await this.#drainCorrespondenceNotices();
    return true;
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
    for (const [key, pair] of this.#currentOverlapPairs) {
      if (pair.current_work_id === workId || pair.other_work_id === workId) this.#currentOverlapPairs.delete(key);
    }
    for (const key of this.#publishedArtifactIds.keys()) if (JSON.parse(key)[0] === workId) this.#publishedArtifactIds.delete(key);
    for (const key of this.#publishedComparisons.keys()) if (JSON.parse(key)[0] === workId) this.#publishedComparisons.delete(key);
    for (const [key, notice] of this.#pendingCorrespondenceNotices) if (notice.workId === workId) this.#pendingCorrespondenceNotices.delete(key);
    this.#observationFailures.delete(workId);
    this.#observationRehydrationGaps.delete(workId);
    if (attached || attaching || workspaceId) this.#fillObservationSlots();
  }
  async #forgetObservationSafely(workId: string, workspaceId?: string): Promise<void> {
    const binding = this.#binding;
    const taskId = binding && (await (await this.#coordinationSession(binding).observationStore()).snapshot())
      .works.find(work => work.id === workId)?.managed?.task_id;
    this.#deps.onCaptureRemovalAttemptForTest?.(workId);
    if (taskId) {
      await (await this.#taskControls()).withTaskPublication([taskId], async () => {
        await this.#captureIndex.run(() => this.#forgetObservation(workId, workspaceId));
      });
    } else await this.#captureIndex.run(() => this.#forgetObservation(workId, workspaceId));
    this.#deps.onCaptureRemovalCompletedForTest?.(workId);
  }
  #retainCorrespondence(update: CorrespondenceUpdate): Array<{ evicted: CorrespondencePair; admitted: CorrespondencePair }> {
    const evicted: Array<{ evicted: CorrespondencePair; admitted: CorrespondencePair }> = [];
    for (const resolved of update.resolved) this.#currentOverlapPairs.delete(resolved.pair_id);
    for (const pair of update.pairs) {
      if (!this.#currentOverlapPairs.has(pair.pair_id) && this.#currentOverlapPairs.size >= this.#pairIndexLimit) {
        const oldestId = this.#currentOverlapPairs.keys().next().value!;
        evicted.push({ evicted: this.#currentOverlapPairs.get(oldestId)!, admitted: pair });
        this.#currentOverlapPairs.delete(oldestId);
      }
      this.#currentOverlapPairs.set(pair.pair_id, pair);
    }
    return evicted;
  }
  async #recordPeerDeliveryFailure(taskId: string, pairId: string, code: string): Promise<void> {
    const store = this.#store;
    if (!store) return;
    try {
      const retained = await store.appendEvent(taskId, { kind: "peer_delivery_unavailable", pair_id: pairId,
        code: code.slice(0, 128) });
      if (!retained) await this.#controls?.change(taskId, state => { state.telemetry_omitted = true; });
    } catch (error) { this.#failure ??= diagnosticInfo(error); }
  }
  async #selectedOverlapEvidence(pair: CorrespondencePair, peerCase: Case,
    recipientTaskId: string, source: Work, target: Work, recipientWorkspace: string,
    beforePublication = false, settlementOnly = false): Promise<PeerOverlapEvidence> {
    const path = pair.input.path;
    const reports = [pair.current_work_id, pair.other_work_id].map(id => this.#publishedComparisons.get(JSON.stringify([id, path])));
    const artifacts = [pair.current_work_id, pair.other_work_id].map(id => this.#publishedArtifactIds.get(JSON.stringify([id, path])));
    if (reports.some(report => !report) || artifacts.some(artifact => !artifact) || !this.#observationStore) {
      throw new BridgeError("PEER_DELIVERY_UNAVAILABLE", "Current compared source evidence is unavailable");
    }
    const sourceContext = { source_artifact_id: artifacts[[pair.current_work_id, pair.other_work_id].indexOf(source.id)]!.id,
      recipient_artifact_id: artifacts[[pair.current_work_id, pair.other_work_id].indexOf(target.id)]!.id };
    const upstreamLimitations = reports.flatMap((report, index) => [
      ...(report!.comparison.coverage === "complete" ? [] :
        [`comparison_coverage:${[pair.current_work_id, pair.other_work_id][index]}:${report!.comparison.coverage}`]),
      ...report!.comparison.limitations.map(limitation =>
        `comparison:${[pair.current_work_id, pair.other_work_id][index]}:${limitation}`),
    ]);
    const observations = [];
    let input: SourceFile | undefined;
    let declaration;
    for (let index = 0; index < 2; index++) {
      const workId = index === 0 ? pair.current_work_id : pair.other_work_id;
      const report = reports[index]!;
      const change = report.comparison.changes.find(candidate => candidate.input &&
        candidate.input.range.start_byte === pair.input_range.start_byte &&
        candidate.input.range.end_byte === pair.input_range.end_byte &&
        (candidate.kind === "modified" || candidate.kind === "removed"));
      if (!change?.input) throw new BridgeError("PEER_DELIVERY_UNAVAILABLE", "Current overlap declaration is unavailable");
      const retained = await this.#observationStore.readRetainedPair(artifacts[index]!.id, "0".repeat(64),
        (_recipient, id, revision, generation) => beforePublication
          ? this.#authorizeObservation(id === source.id ? source.owner : target.owner, id, revision, generation, "report")
          : this.#authorizePeerCaseSource(peerCase.id, recipientTaskId, id, revision, generation,
            "report", settlementOnly));
      if (retained.work_id !== workId || retained.path !== path || retained.input.source.kind !== "commit" ||
        retained.input.source.commit_oid !== pair.input.commit_oid) {
        throw new BridgeError("PEER_DELIVERY_STALE", "Selected overlap source capture changed");
      }
      input ??= retained.input;
      declaration ??= change.input;
      observations.push({ observation_id: workId, observed: retained.observed, change: {
        kind: change.kind as "modified" | "removed", declaration_changed: change.declaration_changed,
        body_changed: change.body_changed, default_changed: change.default_changed,
        input: change.input, ...(change.observed ? { observed: change.observed } : {}) } });
    }
    return selectPeerDeliveryEvidence({ subject_id: pair.subject_id, dialect: reports[0]!.comparison.dialect,
      parser_identity: reports[0]!.comparison.parser_identity,
      extractor_identity: reports[0]!.comparison.extractor_identity,
      input: input!, declaration: declaration!, observations, limitations: upstreamLimitations },
    pair, peerCase, source, target, recipientTaskId, sourceContext, recipientWorkspace);
  }
  /**
   * Stable proposal evidence identity for all currently selected overlap paths.
   * Capture UUIDs and report IDs are transport identities; source bytes and
   * analysis coverage are the facts to which worker consent must bind.
   */
  async #peerCaptureEvidenceId(actorTaskId: string, state: ControlState, peerCase: Case): Promise<string> {
    const selected = new Set(peerCase.inputs.map(input => input.work_id));
    const pairs = [...this.#currentOverlapPairs.values()].filter(pair =>
      selected.has(pair.current_work_id) && selected.has(pair.other_work_id))
      .sort((left, right) => left.pair_id.localeCompare(right.pair_id));
    if (!pairs.length) throw new BridgeError("PEER_OPERATION_NO_CURRENT_OVERLAP",
      "Selected case has no current captured overlap");
    const paths = [...new Set(pairs.map(pair => pair.input.path))].sort();
    if (paths.length > 64 || !this.#observationStore || !this.#binding || !this.#store) {
      throw new BridgeError("PEER_OPERATION_UNAVAILABLE", "Selected capture evidence exceeds its bounded runtime inventory");
    }
    const { captureWorkingFile } = await import("../observation/source.js");
    const sources = [];
    for (const path of paths) for (const input of peerCase.inputs) {
      const work = state.works.find(item => item.id === input.work_id);
      const artifact = this.#publishedArtifactIds.get(JSON.stringify([input.work_id, path]));
      const report = this.#publishedComparisons.get(JSON.stringify([input.work_id, path]));
      if (!work?.managed || !artifact || !report || artifact.owner !== work.owner) {
        throw new BridgeError("PEER_OPERATION_STALE", "Selected overlap has no current source capture");
      }
      const retained = await this.#observationStore.readRetainedPair(artifact.id, work.owner,
        (_recipient, workId, revision, generation) => this.#authorizePeerCaseSource(peerCase.id,
          actorTaskId, workId, revision, generation, "detail"));
      if (retained.work_id !== work.id || retained.work_revision !== work.revision || retained.path !== path ||
        retained.input.source.kind !== "commit" || retained.input.source.commit_oid !== input.commit_oid ||
        retained.observed.source.kind !== "working_capture") {
        throw new BridgeError("PEER_OPERATION_STALE", "Selected source capture differs from case inputs");
      }
      const managed = await managedTaskSource(this.#store, this.#binding.repositoryId, work.managed.task_id);
      const live = await captureWorkingFile({ root: managed.root, workspace_id: work.workspace_id,
        workspace_generation: work.managed.control_generation, capture_sequence: 1,
        input_commit_oid: work.input_oid }, path, { max_bytes: 8 * 1024 * 1024 });
      if (live.status !== "present" || retained.observed.status !== "present" ||
        live.content_sha256 !== retained.observed.content_sha256 || live.mode !== retained.observed.mode) {
        throw new BridgeError("PEER_OPERATION_STALE", "Current source bytes differ from the selected capture");
      }
      sources.push({ path, work_id: work.id, work_revision: work.revision,
        workspace_id: work.workspace_id, workspace_generation: work.managed.control_generation,
        input: retained.input.status === "present"
          ? { status: retained.input.status, commit_oid: input.commit_oid,
            content_sha256: retained.input.content_sha256, mode: retained.input.mode }
          : { status: retained.input.status, commit_oid: input.commit_oid },
        observed: { status: retained.observed.status, content_sha256: retained.observed.content_sha256,
          mode: retained.observed.mode },
        parser_identity: report.comparison.parser_identity,
        extractor_identity: report.comparison.extractor_identity,
        coverage: report.comparison.coverage, limitations: report.comparison.limitations });
    }
    return canonicalHash({ case_id: peerCase.id, case_revision: peerCase.revision,
      case_generation: peerCase.generation, inputs: peerCase.inputs,
      pair_ids: pairs.map(pair => pair.pair_id), sources });
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
  /** A compact source correspondence may establish authority only for two current managed tasks. */
  async #establishObservedCase(pair: CorrespondencePair): Promise<void> {
    const binding = this.#binding, store = this.#store;
    if (!binding || !store) return;
    const metadata = this.#coordinationSession(binding);
    const ids = [pair.current_work_id, pair.other_work_id].sort();
    const initial = await (await metadata.observationStore()).snapshot();
    const works = ids.map(id => initial.works.find(work => work.id === id));
    if (works.some(work => !work?.managed || work.state !== "active")) return;
    const [left, right] = works as [Work, Work];
    if (left.input_oid !== right.input_oid ||
      pair.input.commit_oid !== left.input_oid) return;
    const resources = await Promise.all(works.map(async work => {
      const taskId = work!.managed!.task_id;
      const [control, resource, source] = await Promise.all([
        store.readControl(taskId), store.readResource(taskId), managedTaskSource(store, binding.repositoryId, taskId),
      ]);
      if (control.owner_id !== work!.owner || control.control_generation !== work!.managed!.control_generation ||
        control.phase !== "active" || control.cancel || resource?.state !== "pending" ||
        resource.worktree_path !== source.root || source.input_oid !== work!.input_oid) {
        throw new BridgeError("PEER_DELIVERY_STALE", "Observed managed task authority changed");
      }
      return { target: resource.target_ref, source_view: source.root };
    }));
    const assertCurrent = async () => {
      for (const [index, work] of works.entries()) {
        const taskId = work!.managed!.task_id;
        const [control, resource, source] = await Promise.all([
          store.readControl(taskId), store.readResource(taskId), managedTaskSource(store, binding.repositoryId, taskId),
        ]);
        if (control.owner_id !== work!.owner || control.control_generation !== work!.managed!.control_generation ||
          control.phase !== "active" || control.cancel || resource?.state !== "pending" ||
          resource.target_ref !== resources[index]!.target || resource.worktree_path !== source.root ||
          source.root !== resources[index]!.source_view || source.input_oid !== work!.input_oid) {
          throw new BridgeError("PEER_OPERATION_STALE", "Observed task or source authority changed during case establishment");
        }
      }
    };
    if (resources[0]!.target !== resources[1]!.target) return;
    const { CoordinationRepository } = await import("../coordination/repository.js");
    const repository = await CoordinationRepository.open(binding.project, binding.repositoryId, coordinationLimits.max_worktrees);
    const targetOid = await repository.target(resources[0]!.target);
    const existing = initial.cases.find(candidate => candidate.target === resources[0]!.target && candidate.state === "active");
    if (existing?.inputs.length && !ids.every(id => existing.inputs.some(input => input.work_id === id))) {
      if (this.#deps.enableObservedCaseExtensionForTest !== true)
        throw new BridgeError("COORDINATION_OBSERVED_EXTENSION_DISABLED", "Automatic observed case extension awaits safe native receipt settlement");
      await this.#extendObservedCase(pair, existing, initial, targetOid);
      return;
    }
    if (existing?.inputs.length) return;
    const key = `passeur-internal:observed-overlap:${canonicalHash([binding.repositoryId, resources[0]!.target, ids])}`;
    const current = async () => (await metadata.observationStore()).snapshot();
    const publish = async (owner: string, sourceView: string, command: unknown) =>
      (await this.#taskControls()).withTaskPublication(works.map(work => work!.managed!.task_id), async () => {
        await assertCurrent();
        const receipt = await metadata.executeObservedOverlapCommand({ owner_id: owner, source_view: sourceView }, command);
        await assertCurrent();
        return receipt;
      });
    for (const [index, work] of works.entries()) {
      const peer = works[1 - index]!;
      if (work!.owner === peer.owner) continue;
      let latest = (await current()).works.find(item => item.id === work!.id)!;
      if (!latest.readers.includes(peer.owner)) {
        await publish(latest.owner, resources[index]!.source_view,
          { kind: "share_work", operation_key: `${key}:share:${latest.id}`, work_id: latest.id,
            expected_revision: latest.revision, readers: [...latest.readers, peer.owner] });
      }
    }
    let state = await current();
    let item = state.cases.find(candidate => candidate.target === resources[0]!.target && candidate.state === "active");
    if (!item) {
      const receipt = await publish(left.owner, resources[0]!.source_view,
        { kind: "claim_target", operation_key: `${key}:claim`, target: resources[0]!.target, members: [right.owner] });
      state = await current(); item = state.cases.find(candidate => candidate.id === receipt.item_id);
    }
    if (!item || !item.members.includes(left.owner) || !item.members.includes(right.owner)) return;
    if (!ids.every(id => item!.inputs.some(input => input.work_id === id))) {
      if (item.inputs.length || item.lead !== left.owner) return;
      await publish(left.owner, resources[0]!.source_view,
        { kind: "select_inputs", operation_key: `${key}:select`, case_id: item.id, expected_revision: item.revision,
          generation: item.generation, target_oid: targetOid,
          inputs: ids.map(id => ({ work_id: id, commit_oid: state.works.find(work => work.id === id)!.input_oid })) });
    }
    await assertCurrent();
    await (await this.#taskControls()).withTaskPublication(works.map(work => work!.managed!.task_id), async () => {
      await assertCurrent();
      await this.#captureIndex.run(() => {
        for (const id of ids) { this.#forgetObservation(id); this.#scheduleObservation(id); }
      });
    });
  }
  /** A connected clique is the bounded three-worker scope; other graphs need a case-scoped evidence model. */
  async #extendObservedCase(pair: CorrespondencePair, peerCase: Case, initial: ControlState, targetOid: string): Promise<void> {
    const binding = this.#binding, store = this.#store, coordinator = this.#coordinator;
    if (!binding || !store || !coordinator) return;
    if (peerCase.observed_origin !== "selected")
      throw new BridgeError("COORDINATION_OBSERVED_ORIGIN_UNAVAILABLE", "Manual or unknown case cannot join an observed worker");
    if (peerCase.inputs.length !== 2 || peerCase.external_effect !== "not_started" || peerCase.target_oid !== targetOid)
      throw new BridgeError("COORDINATION_OBSERVED_SCOPE_UNSUPPORTED", "Observed extension supports one uneffected pair and one new worker");
    const present = peerCase.inputs.map(input => input.work_id);
    const incoming = [pair.current_work_id, pair.other_work_id].find(id => !present.includes(id));
    if (!incoming || ![pair.current_work_id, pair.other_work_id].some(id => present.includes(id)))
      throw new BridgeError("COORDINATION_OBSERVED_SCOPE_UNSUPPORTED", "New observation is disconnected from the selected case");
    const ids = [...present, incoming];
    const works = ids.map(id => initial.works.find(work => work.id === id));
    if (works.some(work => !work?.managed || work.state !== "active" || work.input_oid !== pair.input.commit_oid ||
      !regionIncludesPath(work.areas, pair.input.path)))
      throw new BridgeError("COORDINATION_OBSERVED_SCOPE_UNSUPPORTED", "Every selected input must be a current managed task at the same base");
    const selected = works as Work[];
    const matching = (left: string, right: string) => [...this.#currentOverlapPairs.values()]
      .filter(candidate => [candidate.current_work_id, candidate.other_work_id].includes(left) &&
        [candidate.current_work_id, candidate.other_work_id].includes(right) &&
        candidate.subject_id === pair.subject_id && candidate.input.path === pair.input.path &&
        candidate.input.commit_oid === pair.input.commit_oid)
      .sort((a, b) => a.pair_id.localeCompare(b.pair_id))[0];
    const clique: CorrespondencePair[] = [];
    for (let left = 0; left < ids.length; left++) for (let right = left + 1; right < ids.length; right++) {
      const connected = matching(ids[left]!, ids[right]!);
      if (!connected) throw new BridgeError("COORDINATION_OBSERVED_SCOPE_UNSUPPORTED", "Connected non-clique overlap has no complete case-scoped proof");
      clique.push(connected);
    }
    const pinnedPairs = clique.map(edge => ({ id: edge.pair_id, digest: canonicalHash(edge) }));
    const pinnedArtifacts = ids.map(id => {
      const artifact = this.#publishedArtifactIds.get(JSON.stringify([id, pair.input.path]));
      if (!artifact) throw new BridgeError("PEER_DELIVERY_UNAVAILABLE", "A selected worker has no current overlap capture");
      return { id, path: pair.input.path, artifact };
    });
    const assertPinnedEvidence = () => assertObservedExtensionEvidenceCurrent(pinnedPairs, pinnedArtifacts,
      this.#currentOverlapPairs, this.#publishedArtifactIds);
    const metadata = this.#coordinationSession(binding);
    const resources = await Promise.all(selected.map(async work => {
      const taskId = work.managed!.task_id;
      const [control, resource, source, admission] = await Promise.all([
        store.readControl(taskId), store.readResource(taskId), managedTaskSource(store, binding.repositoryId, taskId),
        store.durableRequest(taskId),
      ]);
      if (control.owner_id !== work.owner || control.control_generation !== work.managed!.control_generation ||
        control.phase !== "active" || control.cancel || resource?.state !== "pending" ||
        admission.schema_version !== 5 ||
        source.input_oid !== work.input_oid || source.root !== resource.worktree_path ||
        resource.target_ref !== peerCase.target)
        throw new BridgeError("PEER_OPERATION_STALE", "Selected task or workspace changed before observed extension");
      return { taskId, runId: control.native.run_id, controlGeneration: control.control_generation, root: source.root,
        sourceView: admission.source_view,
        fingerprint: canonicalHash({ task_id: taskId, source_view: admission.source_view,
          workspace: resource.worktree_path, base_commit: resource.base_commit,
          branch_ref: resource.branch_ref, target_ref: resource.target_ref }),
        workspace: work.workspace_id, base: source.input_oid, target: resource.target_ref };
    }));
    const { CoordinationRepository } = await import("../coordination/repository.js");
    const repository = await CoordinationRepository.open(binding.project, binding.repositoryId, coordinationLimits.max_worktrees);
    for (let index = 0; index < selected.length; index++) {
      const source = await repository.inspect(resources[index]!.root);
      if (source.workspace_id !== selected[index]!.workspace_id || source.repository_id !== binding.repositoryId ||
        source.object_format !== selected[index]!.object_format)
        throw new BridgeError("PEER_OPERATION_STALE", "Observed selected workspace identity changed");
    }
    const prospective: Case = { ...peerCase, revision: peerCase.revision + 1,
      inputs: [...peerCase.inputs, { work_id: incoming, commit_oid: selected[2]!.input_oid }],
      members: [...new Set([...peerCase.members, selected[2]!.owner])] };
    // Prove current captures and the complete encoded envelope for every directed peer edge.
    for (const edge of clique) for (const targetId of [edge.current_work_id, edge.other_work_id]) {
      const sourceId = targetId === edge.current_work_id ? edge.other_work_id : edge.current_work_id;
      const source = selected.find(work => work.id === sourceId)!;
      const target = selected.find(work => work.id === targetId)!;
      const recipient = resources[ids.indexOf(targetId)]!;
      const artifact = this.#publishedArtifactIds.get(JSON.stringify([sourceId, edge.input.path]));
      const recipientArtifact = this.#publishedArtifactIds.get(JSON.stringify([targetId, edge.input.path]));
      if (!artifact || !recipientArtifact || artifact.owner !== source.owner || recipientArtifact.owner !== target.owner)
        throw new BridgeError("PEER_DELIVERY_UNAVAILABLE", "A selected worker has no current overlap capture");
      const evidence = await this.#selectedOverlapEvidence(edge, prospective, recipient.taskId,
        source, target, recipient.root, true);
      if (!peerDeliveryCandidate(edge, prospective, source, target, recipient.taskId, artifact.id, evidence,
        { source_artifact_id: artifact.id, recipient_artifact_id: recipientArtifact.id }))
        throw new BridgeError("PEER_DELIVERY_UNAVAILABLE", "Complete selected context cannot be encoded");
    }
    const operationKey = `passeur-internal:observed-extension:${canonicalHash([peerCase.id, incoming])}`;
    const requestDigest = canonicalHash({ operation_key: operationKey, case_id: peerCase.id,
      expected_revision: peerCase.revision, generation: peerCase.generation, new_work_id: incoming,
      target_oid: targetOid, target: peerCase.target });
    const bundles: PeerDeliverySlotBundle[] = selected.map((target, index) => ({
      operation_key: operationKey, request_digest: requestDigest, case_id: peerCase.id,
      expected_case_revision: peerCase.revision, case_revision: peerCase.revision + 1,
      case_generation: peerCase.generation, recipient_task_id: resources[index]!.taskId,
      recipient_run_id: resources[index]!.runId, recipient_control_generation: resources[index]!.controlGeneration,
      recipient_workspace: resources[index]!.root, recipient_workspace_fingerprint: resources[index]!.fingerprint,
      sources: selected.filter(source => source.id !== target.id)
        .map(source => ({ work_id: source.id, work_revision: source.revision })),
    }));
    const controls = await this.#taskControls();
    const releaseRuledOut = async () => controls.withTaskPublication(resources.map(resource => resource.taskId), async () => {
      const current = await (await metadata.observationStore()).snapshot();
      const currentCase = current.cases.find(item => item.id === peerCase.id);
      if (current.epoch !== initial.epoch || current.revision !== initial.revision ||
        currentCase?.revision !== peerCase.revision ||
        currentCase.generation !== peerCase.generation ||
        current.receipts.some(receipt => receipt.owner === peerCase.lead && receipt.key === operationKey))
        throw new BridgeError("PEER_DELIVERY_RESERVATION_PENDING", "Extension publication cannot be ruled out at its original metadata epoch");
      for (const bundle of bundles) await controls.releasePeerDeliverySlotsInPublication(bundle);
    });
    let admitted = 0;
    try {
      for (const bundle of [...bundles].sort((a, b) => a.recipient_task_id.localeCompare(b.recipient_task_id))) {
        await coordinator.reservePeerDeliverySlots(bundle); admitted++;
      }
    } catch (error) {
      if (admitted) {
        try { await releaseRuledOut(); }
        catch (releaseError) { throw new BridgeError("PEER_DELIVERY_RESERVATION_PENDING",
          "Partial durable delivery reservations await serialized publication ruling", { cause: releaseError }); }
      }
      throw error;
    }
    const exact = async () => {
      assertPinnedEvidence();
      const current = await (await metadata.observationStore()).snapshot();
      const currentCase = current.cases.find(item => item.id === peerCase.id);
      if (currentCase?.revision !== peerCase.revision || currentCase.generation !== peerCase.generation ||
        ids.some((id, index) => current.works.find(work => work.id === id)?.revision !== selected[index]!.revision))
        throw new BridgeError("PEER_OPERATION_STALE", "Observed case or selected work changed before publication");
      for (const [index, work] of selected.entries()) {
        const control = await store.readControl(resources[index]!.taskId);
        const resource = await store.readResource(resources[index]!.taskId);
        if (control.owner_id !== work.owner || control.control_generation !== resources[index]!.controlGeneration ||
          control.phase !== "active" || control.cancel || control.native.state !== "observed_live" ||
          control.native.run_id !== resources[index]!.runId || !coordinator.isActive(resources[index]!.taskId) ||
          resource?.state !== "pending" || resource.worktree_path !== resources[index]!.root ||
          resource.target_ref !== resources[index]!.target ||
          canonicalHash({ task_id: resources[index]!.taskId, source_view: resources[index]!.sourceView,
            workspace: resource.worktree_path, base_commit: resource.base_commit,
            branch_ref: resource.branch_ref, target_ref: resource.target_ref }) !== resources[index]!.fingerprint)
          throw new BridgeError("PEER_OPERATION_STALE", "Selected task changed before case publication");
        const bundle = bundles[index]!;
        if (control.schema_version !== 3 || bundle.sources.some(source => !control.peer_delivery_reservations.some(slot =>
          slot.state === "reserved" && slot.operation_key === bundle.operation_key &&
          slot.request_digest === bundle.request_digest && slot.case_id === bundle.case_id &&
          slot.expected_case_revision === bundle.expected_case_revision && slot.case_revision === bundle.case_revision &&
          slot.case_generation === bundle.case_generation && slot.recipient_task_id === bundle.recipient_task_id &&
          slot.recipient_run_id === bundle.recipient_run_id &&
          slot.recipient_control_generation === bundle.recipient_control_generation &&
          slot.recipient_workspace === bundle.recipient_workspace &&
          slot.recipient_workspace_fingerprint === bundle.recipient_workspace_fingerprint &&
          slot.source_work_id === source.work_id && slot.source_work_revision === source.work_revision)))
          throw new BridgeError("PEER_DELIVERY_RESERVATION_STALE", "Directed delivery slots changed before case publication");
      }
    };
    let publicationAttempted = false;
    try {
      await this.#deps.onObservedCaseSlotsReservedForTest?.(resources.map(resource => resource.taskId), controls);
      await controls.withTaskPublication(resources.map(resource => resource.taskId), async () => {
      await exact(); publicationAttempted = true;
      await metadata.extendObservedCase({ owner_id: peerCase.lead, source_view: resources[ids.indexOf(peerCase.inputs[0]!.work_id)]!.root }, {
        operation_key: operationKey,
        case_id: peerCase.id, expected_revision: peerCase.revision, generation: peerCase.generation,
        new_work_id: incoming, target_oid: targetOid, target: peerCase.target });
      });
    }
    catch (error) {
      if (!publicationAttempted) {
        try { await releaseRuledOut(); }
        catch (releaseError) { throw new BridgeError("PEER_DELIVERY_RESERVATION_PENDING",
          "Durable delivery reservations await serialized publication ruling", { cause: releaseError }); }
      }
      throw error;
    }
    // The preflight validated every current capture. Re-observing here would replace those
    // captures while their revision-specific envelopes are being dispatched.
    this.#deps.onObservedCaseExtensionPublishedForTest?.(peerCase.id, () => this.#wakeSelectedCase(peerCase.id));
    this.#wakeSelectedCase(peerCase.id);
  }
  /** Observation publication owns this attempt; delivery admission and dispatch remain Coordinator owned. */
  async #queuePeerOverlap(pair: CorrespondencePair, failed?: (code: string) => void,
    selectedCaseId?: string): Promise<void> {
    const coordinator = this.#coordinator, binding = this.#binding, store = this.#store;
    if (!coordinator || !binding || !store || coordinator.frozenReason || this.#lifetime.signal.aborted ||
      this.#admissionClosed) return;
    const workIds = [pair.current_work_id, pair.other_work_id] as const;
    let snapshot;
    try { snapshot = await (await this.#coordinationSession(binding).observationStore()).snapshot(); }
    catch (error) {
      failed?.(errorInfo(error).code);
      const limitation = `peer_delivery_unavailable:${errorInfo(error).code}`.slice(0, 256);
      for (const id of workIds) {
        if (!this.#observationFailures.has(id) && this.#observationFailures.size >= coordinationResourceRecords)
          this.#observationFailures.delete(this.#observationFailures.keys().next().value!);
        this.#observationFailures.set(id, limitation);
      }
      return;
    }
    if (!selectedCaseId && !snapshot.cases.some(item => item.state === "active" && workIds.every(id => item.inputs.some(input => input.work_id === id)))) {
      try {
        await this.#establishObservedCase(pair);
        snapshot = await (await this.#coordinationSession(binding).observationStore()).snapshot();
      } catch (error) {
        failed?.(errorInfo(error).code);
        for (const id of workIds) this.#observationFailures.set(id, `case_establishment_unavailable:${errorInfo(error).code}`.slice(0, 256));
        return;
      }
    }
    for (const targetId of workIds) {
      const target = snapshot.works.find(work => work.id === targetId);
      const source = snapshot.works.find(work => work.id === workIds.find(id => id !== targetId));
      const taskId = target?.managed?.task_id;
      if (!target || !source || target.state !== "active" || source.state !== "active" ||
        !taskId || !coordinator.isActive(taskId)) continue;
      try {
        const control = await store.readControl(taskId);
        if (control.owner_id !== target.owner || control.control_generation !== target.managed!.control_generation) {
          await this.#recordPeerDeliveryFailure(taskId, pair.pair_id, "PEER_DELIVERY_STALE");
          continue;
        }
        const peerCases = snapshot.cases.filter(item => item.state === "active" &&
          (!selectedCaseId || item.id === selectedCaseId) &&
          item.members.includes(control.owner_id) &&
          item.inputs.some(input => input.work_id === target.id) &&
          item.inputs.some(input => input.work_id === source.id)).sort((a, b) => a.id.localeCompare(b.id));
        if (!peerCases.length) continue;
        const artifact = this.#publishedArtifactIds.get(JSON.stringify([source.id, pair.input.path]));
        if (!artifact || artifact.owner !== source.owner) {
          await this.#recordPeerDeliveryFailure(taskId, pair.pair_id, "PEER_DELIVERY_UNAVAILABLE");
          continue;
        }
        const selectedCase = peerCases[0]!;
        const resource = await store.readResource(taskId);
        if (resource?.state !== "pending" || !resource.worktree_path) {
          throw new BridgeError("PEER_DELIVERY_UNAVAILABLE", "Recipient workspace for bounded delivery is unavailable");
        }
        const retained = await this.#observationStore!.readRetainedPair(artifact.id, control.owner_id,
          (_recipient, workId, revision, generation) => this.#authorizePeerCaseSource(selectedCase.id,
            taskId, workId, revision, generation, "report"));
        if (retained.work_id !== source.id || retained.work_revision !== source.revision ||
          retained.path !== pair.input.path || retained.input.source.kind !== "commit" ||
          retained.input.source.commit_oid !== pair.input.commit_oid ||
          retained.input.source.repository_id !== pair.input.repository_id) {
          await this.#recordPeerDeliveryFailure(taskId, pair.pair_id, "PEER_DELIVERY_STALE");
          continue;
        }
        for (const peerCase of peerCases) {
          const evidence = await this.#selectedOverlapEvidence(pair, peerCase, taskId, source, target,
            resource.worktree_path);
          const recipientArtifact = this.#publishedArtifactIds.get(JSON.stringify([target.id, pair.input.path]));
          if (!recipientArtifact) throw new BridgeError("PEER_DELIVERY_UNAVAILABLE", "Recipient source capture is unavailable");
          const candidate = peerDeliveryCandidate(pair, peerCase, source, target, taskId, artifact.id, evidence,
            { source_artifact_id: artifact.id, recipient_artifact_id: recipientArtifact.id });
          if (candidate) {
            if (this.#lifetime.signal.aborted || this.#admissionClosed) return;
            if (peerCase.observed_origin === "selected" && peerCase.inputs.length === 3)
              this.#deps.beforeObservedCaseDeliveryQueueForTest?.({ case_id: peerCase.id,
                case_revision: peerCase.revision, recipient_task_id: taskId, source_work_id: source.id });
            const reservationOperationKey = peerCase.observed_origin === "selected" && peerCase.inputs.length === 3
              ? `passeur-internal:observed-extension:${canonicalHash([peerCase.id, peerCase.inputs[2]!.work_id])}`
              : undefined;
            await coordinator.queuePeerDelivery(taskId, candidate, reservationOperationKey);
            if (this.#observationFailures.get(targetId) === "PEER_DELIVERY_CAPACITY_PENDING")
              this.#observationFailures.delete(targetId);
          }
        }
      } catch (error) {
        const code = errorInfo(error).code;
        failed?.(code);
        if (code === "PEER_DELIVERY_CAPACITY_PENDING") this.#observationFailures.set(targetId, code);
        await this.#recordPeerDeliveryFailure(taskId, pair.pair_id,
          code === "STRUCTURAL_SOURCE_FORBIDDEN" ? "PEER_DELIVERY_REVOKED" : code);
      }
    }
  }
  #selectedCaseReconciliation(caseId: string): SelectedCaseReconciliation {
    let entry = this.#deliveryReconciliation.get(caseId);
    if (!entry) {
      entry = { requested: false, running: undefined, receiptRequested: false, receiptRunning: undefined,
        diagnostic: undefined, pendingWorkIds: [] };
      this.#deliveryReconciliation.set(caseId, entry);
    }
    return entry;
  }
  #wakeSelectedCase(caseId: string): Promise<void> {
    if (this.#lifetime.signal.aborted || this.#admissionClosed || this.#phase === "closing" || this.#phase === "closed")
      return Promise.resolve();
    const entry = this.#selectedCaseReconciliation(caseId);
    entry.requested = true;
    for (const workId of entry.pendingWorkIds) if (this.#observationFailures.get(workId) === entry.diagnostic)
      this.#observationFailures.delete(workId);
    entry.diagnostic = undefined;
    entry.pendingWorkIds = [];
    if (entry.running) return entry.running;
    const state = entry;
    const running = this.#track(async () => {
      let attempts = 0;
      while (!this.#lifetime.signal.aborted && !this.#admissionClosed) {
        state.requested = false;
        let outcome: "complete" | "native_pending" | "retry" | "unavailable" = "retry";
        let code = "PEER_DELIVERY_RECONCILIATION_FAILED";
        try { outcome = await this.#retrySelectedCase(caseId); }
        catch (error) { code = errorInfo(error).code; }
        if (outcome === "complete" || outcome === "native_pending" || outcome === "unavailable") {
          if (!state.requested) break;
          attempts = 0;
          continue;
        }
        if (state.requested) { attempts = 0; continue; }
        if (++attempts >= PEER_RECONCILIATION_ATTEMPTS) {
          state.diagnostic = `peer_delivery_reconciliation_exhausted:${code}`;
          try {
            const snapshot = await (await this.#coordinationSession(this.#binding!).observationStore()).snapshot();
            const pending = snapshot.cases.find(item => item.id === caseId)?.delivery_pending ?? [];
            state.pendingWorkIds = [...pending];
            for (const workId of pending) this.#observationFailures.set(workId, state.diagnostic);
          } catch (error) {
            state.diagnostic = `peer_delivery_reconciliation_exhausted:${errorInfo(error).code}`;
          }
          if (!state.requested) break;
          attempts = 0;
          continue;
        }
        try { await delay(PEER_RECONCILIATION_DELAY_MS, undefined, { signal: this.#lifetime.signal }); }
        catch { break; }
      }
    });
    entry.running = running;
    void running.finally(() => {
      if (state.running !== running) return;
      state.running = undefined;
      if (state.requested && !this.#lifetime.signal.aborted && !this.#admissionClosed) this.#wakeSelectedCase(caseId);
      else if (!state.diagnostic && !state.receiptRunning) this.#deliveryReconciliation.delete(caseId);
    }).catch(() => undefined);
    return running;
  }
  #wakeObservedCaseReceipt(caseId: string): void {
    if (this.#lifetime.signal.aborted || this.#admissionClosed) return;
    const state = this.#selectedCaseReconciliation(caseId);
    state.receiptRequested = true;
    if (state.receiptRunning) return;
    const running = this.#track(async () => {
      while (state.receiptRequested && !this.#lifetime.signal.aborted && !this.#admissionClosed) {
        state.receiptRequested = false;
        try { await this.#settleObservedCaseDeliveries(caseId); }
        catch { /* The bounded selected-case worker retries exact metadata settlement. */ }
        this.#wakeSelectedCase(caseId);
      }
    });
    state.receiptRunning = running;
    void running.finally(() => {
      if (state.receiptRunning !== running) return;
      state.receiptRunning = undefined;
      if (state.receiptRequested && !this.#lifetime.signal.aborted && !this.#admissionClosed)
        this.#wakeObservedCaseReceipt(caseId);
      else if (!state.running && !state.diagnostic) this.#deliveryReconciliation.delete(caseId);
    }).catch(() => undefined);
  }
  async #wakeCasesForWork(workId: string): Promise<void> {
    if (!this.#binding || !this.#coordinator || this.#lifetime.signal.aborted) return;
    let snapshot;
    try { snapshot = await (await this.#coordinationSession(this.#binding).observationStore()).snapshot(); }
    catch (error) {
      this.#observationFailures.set(workId, `peer_delivery_reconciliation_unavailable:${errorInfo(error).code}`.slice(0, 256));
      return;
    }
    for (const item of snapshot.cases) if (item.state === "active" && item.delivery_pending?.length &&
      item.inputs.some(input => input.work_id === workId)) this.#wakeSelectedCase(item.id);
  }
  async #wakeCasesForSettledTask(taskId: string): Promise<void> {
    if (!this.#binding || !this.#coordinator || this.#lifetime.signal.aborted) return;
    const pending = (await this.#coordinationSession(this.#binding).observationStore()).snapshot();
    const snapshot = await (this.#deps.onTerminalCaseWakeSnapshotForTest?.(pending) ?? pending);
    if (this.#lifetime.signal.aborted || this.#admissionClosed) return;
    const works = new Set(snapshot.works.filter(work => work.managed?.task_id === taskId).map(work => work.id));
    for (const item of snapshot.cases) if (item.state === "active" && item.delivery_pending?.length &&
      item.inputs.some(input => works.has(input.work_id))) this.#wakeSelectedCase(item.id);
  }
  async #retrySelectedCase(caseId: string): Promise<"complete" | "native_pending" | "retry" | "unavailable"> {
    if (!this.#binding || !this.#coordinator || this.#lifetime.signal.aborted || this.#admissionClosed) return "unavailable";
    const snapshot = await (await this.#coordinationSession(this.#binding).observationStore()).snapshot();
    const peerCase = snapshot.cases.find(item => item.id === caseId && item.state === "active");
    if (!peerCase?.delivery_pending?.length) return "complete";
    // Native receipts can complete a case without another source lookup or queue pass.
    await this.#settleObservedCaseDeliveries(caseId);
    const afterReceipts = await (await this.#coordinationSession(this.#binding).observationStore()).snapshot();
    if (!afterReceipts.cases.find(item => item.id === caseId && item.state === "active")?.delivery_pending?.length)
      return "complete";
    const selected = new Set(peerCase.inputs.map(input => input.work_id));
    let attempted = false, failure: string | undefined;
    for (const pair of this.#currentOverlapPairs.values()) {
      if (selected.has(pair.current_work_id) && selected.has(pair.other_work_id)) {
        attempted = true;
        await this.#queuePeerOverlap(pair, code => { failure ??= code; }, caseId);
      }
    }
    if (!attempted || failure === "PEER_DELIVERY_STALE" || failure === "PEER_OPERATION_STALE" ||
      failure === "PEER_DELIVERY_RESERVATION_STALE" || failure === "PEER_DELIVERY_CAPACITY_PENDING" ||
      failure === "PEER_DELIVERY_UNAVAILABLE" || failure === "STRUCTURAL_SOURCE_FORBIDDEN") return "unavailable";
    for (const input of peerCase.inputs) {
      const recipient = snapshot.works.find(work => work.id === input.work_id);
      if (!recipient?.managed || !peerCase.delivery_pending.includes(input.work_id)) continue;
      const control = await this.#store!.readControl(recipient.managed.task_id);
      if (control.schema_version !== 3) return "unavailable";
      if (control.owner_id !== recipient.owner || control.control_generation !== recipient.managed.control_generation ||
        control.phase !== "active" || control.cancel || !this.#coordinator.isActive(recipient.managed.task_id))
        return "unavailable";
      const slots = control.peer_delivery_reservations.filter(slot => slot.case_id === caseId &&
        slot.case_revision === peerCase.revision && slot.case_generation === peerCase.generation);
      if (slots.some(slot => slot.state === "reserved")) return "retry";
    }
    return failure ? "retry" : "native_pending";
  }
  /** Adapter observation, never queue admission, discharges each recipient's revision-specific obligation. */
  async #settleObservedCaseDeliveries(caseId: string): Promise<void> {
    const binding = this.#binding, store = this.#store;
    if (!binding || !store) return;
    const metadata = this.#coordinationSession(binding);
    const observationMetadata = await metadata.observationStore();
    const first = await observationMetadata.snapshot();
    const selectedCase = first.cases.find(candidate => candidate.id === caseId && candidate.state === "active");
    if (!selectedCase?.delivery_pending?.length || selectedCase.observed_origin !== "selected") return;
    const selectedTasks = selectedCase.inputs.map(input => first.works.find(work => work.id === input.work_id)?.managed?.task_id);
    if (selectedTasks.some(id => !id)) return;
    const taskIds = selectedTasks.filter((id): id is string => id !== undefined);
    const pending = [...selectedCase.delivery_pending];
    type Attempt = { case_id: string; recipient_work_id: string; observed_delivery_ids: string[];
      outcome: "completed" | "rejected" | "failed" };
    const attempts: Attempt[] = [];
    let failure: unknown;
    try { await (await this.#taskControls()).withTaskPublication(taskIds, () => this.#captureIndex.run(async () => {
      for (const recipientWorkId of pending) {
        const snapshot = await (await metadata.observationStore()).snapshot();
        const item = snapshot.cases.find(candidate => candidate.id === caseId && candidate.state === "active");
        if (!item || item.revision !== selectedCase.revision || item.generation !== selectedCase.generation ||
          item.observed_origin !== "selected" || item.inputs.length !== taskIds.length ||
          item.inputs.some((input, index) => snapshot.works.find(work => work.id === input.work_id)?.managed?.task_id !== taskIds[index])) return;
        if (!item.delivery_pending?.includes(recipientWorkId)) continue;
        const recipient = snapshot.works.find(work => work.id === recipientWorkId);
        if (!recipient?.managed || recipient.state !== "active") continue;
        const control = await store.readControl(recipient.managed.task_id);
        if (control.owner_id !== recipient.owner || control.control_generation !== recipient.managed.control_generation ||
          !await this.#settlementTaskEligible(recipient.managed.task_id, control)) continue;
        const attempt: Attempt = { case_id: caseId, recipient_work_id: recipientWorkId,
          observed_delivery_ids: [], outcome: "rejected" };
        attempts.push(attempt);
        const peers = item.inputs.filter(input => input.work_id !== recipientWorkId);
        const observations = [];
        const validated: PeerDeliveryEnvelope[] = [];
        for (const peer of peers) {
          const source = snapshot.works.find(work => work.id === peer.work_id);
          if (!source?.managed || source.state !== "active") break;
          const exact = (control.peer_deliveries ?? []).filter(record => record.state === "observed" &&
            record.envelope.case_id === item.id && record.envelope.case_revision === item.revision &&
            record.envelope.case_generation === item.generation && record.envelope.recipient_task_id === recipient.managed!.task_id &&
            record.envelope.recipient_control_generation === control.control_generation &&
            record.envelope.recipient_run_id === control.native.run_id &&
            record.envelope.source_work_id === source.id && record.envelope.source_work_revision === source.revision)
            .sort((a, b) => a.envelope.delivery_id.localeCompare(b.envelope.delivery_id));
          let current;
          for (const record of exact) {
            attempt.observed_delivery_ids.push(record.envelope.delivery_id);
            try { if (await this.#authorizePeerDelivery(record.envelope, true) === "current") { current = record; break; } }
            catch { /* A failed current evidence check cannot settle the durable obligation. */ }
          }
          if (!current) break;
          validated.push(current.envelope);
          observations.push({ source_work_id: source.id, delivery_id: current.envelope.delivery_id,
            native_turn_id: current.native_turn_id, native_session_id: current.native_session_id });
        }
        if (observations.length !== peers.length) continue;
        try {
          this.#deps.beforeObservedCaseDeliverySettlementForTest?.({ case_id: item.id,
            recipient_work_id: recipientWorkId, pending_count: item.delivery_pending.length });
          await metadata.observeCaseDelivery({ owner_id: item.lead, source_view: binding.project }, {
            operation_key: `passeur-internal:observed-delivery:${canonicalHash([item.id, item.revision, recipientWorkId])}`,
            case_id: item.id, case_revision: item.revision, generation: item.generation,
            recipient_work_id: recipientWorkId, observation_digest: canonicalHash(observations),
          }, { epoch: snapshot.epoch, revision: snapshot.revision });
          attempt.outcome = "completed";
        } catch (error) {
          if (errorInfo(error).code !== "PEER_DELIVERY_STALE") throw error;
          // Metadata may advance for another recipient between the exact check and
          // publication. Retry only while the same case and every native receipt
          // still carry current task, source, capture and workspace authority.
          const fresh = await observationMetadata.snapshot();
          const current = fresh.cases.find(candidate => candidate.id === item.id && candidate.state === "active");
          if (!current || current.revision !== item.revision || current.generation !== item.generation ||
            current.observed_origin !== "selected" || current.inputs.length !== item.inputs.length ||
            current.inputs.some((input, index) => input.work_id !== item.inputs[index]!.work_id ||
              fresh.works.find(work => work.id === input.work_id)?.managed?.task_id !== taskIds[index]) ||
            !current.delivery_pending?.includes(recipientWorkId)) continue;
          let exact = true;
          for (const envelope of validated) {
            try { if (await this.#authorizePeerDelivery(envelope, true) !== "current") { exact = false; break; } }
            catch { exact = false; break; }
          }
          if (exact) throw new BridgeError("PEER_DELIVERY_METADATA_CONFLICT",
            "Current exact native receipt remains pending after an optimistic metadata conflict");
        }
      }
    })); }
    catch (error) { failure = error; if (attempts.length) attempts[attempts.length - 1]!.outcome = "failed"; }
    // This observer has no authority or backpressure. It runs after task and capture
    // reservations release, and cannot affect the canonical receipt or case state.
    for (const attempt of attempts) {
      try { this.#deps.onObservedCaseSettlement?.(Object.freeze({ ...attempt,
        observed_delivery_ids: Object.freeze([...attempt.observed_delivery_ids]) })); }
      catch { /* Advisory test/diagnostic observer cannot change settlement. */ }
    }
    if (failure) throw failure;
  }
  async #workerPeerOperation(taskId: string, request: WorkerPeerOperationRequest, signal: AbortSignal): Promise<PeerWorkerOperationResult> {
    const store = this.#store, binding = this.#binding;
    if (!store || !binding) throw new BridgeError("PEER_OPERATION_UNAVAILABLE", "Worker operation authority is not prepared");
    if (this.#observationResume) await this.#observationResume;
    const snapshot = await (await this.#coordinationSession(binding).observationStore()).snapshot();
    const item = snapshot.cases.find(candidate => candidate.id === request.case_id && candidate.state === "active");
    if (!item) throw new BridgeError("PEER_OPERATION_FORBIDDEN", "Worker operation does not target an active case");
    const selected = item.inputs.map(input => snapshot.works.find(work => work.id === input.work_id)?.managed?.task_id);
    if (selected.some(id => !id) || !selected.includes(taskId)) {
      throw new BridgeError("PEER_OPERATION_FORBIDDEN", "Worker operation requires selected managed task authority");
    }
    let telemetryOmitted = false;
    const controls = await this.#taskControls();
    try {
      return await this.#workerPeerOperationCore(taskId, request, signal, selected as string[],
        () => { telemetryOmitted = true; });
    } finally {
      if (telemetryOmitted) {
        try { await controls.change(taskId, control => { control.telemetry_omitted = true; }); }
        catch { /* Advisory telemetry cannot change the retained operation outcome. */ }
      }
    }
  }
  async #workerPeerOperationCore(taskId: string, request: WorkerPeerOperationRequest, signal: AbortSignal,
    selectedTasks: readonly string[], omitTelemetry: () => void): Promise<PeerWorkerOperationResult> {
    signal.throwIfAborted(); this.#assertAuthority();
    const store = this.#store, binding = this.#binding;
    if (!store || !binding) throw new BridgeError("PEER_OPERATION_UNAVAILABLE", "Worker operation authority is not prepared");
    const admission = await store.durableRequest(taskId), state = await store.readControl(taskId), resource = await store.readResource(taskId);
    if (admission.schema_version !== 5 || state.owner_id !== admission.initial_owner || state.cancel || state.phase !== "active" ||
        state.native.state !== "observed_live" || state.native.coverage !== "turn_scoped" || state.native.obligations.length ||
        state.inputs.some(input => input.state === "pending" || input.state === "answer_intent" || input.state === "delivery_unknown")) {
      throw new BridgeError("PEER_OPERATION_STALE", "Worker operations require the current active task and a settled native turn");
    }
    if (!resource || resource.state !== "pending" || !resource.worktree_path) {
      throw new BridgeError("PEER_OPERATION_STALE", "Worker operation workspace authority is no longer current");
    }
    const managed = await managedTaskSource(store, binding.repositoryId, taskId);
    if (managed.root !== resource.worktree_path) throw new BridgeError("PEER_OPERATION_STALE", "The task workspace changed during worker authentication");
    const { CoordinationRepository } = await import("../coordination/repository.js");
    const repository = await CoordinationRepository.open(binding.project, binding.repositoryId, coordinationLimits.max_worktrees, signal);
    const workspace = await repository.inspect(managed.root, signal);
    const metadata = await this.#coordinationSession(binding).observationStore(), snapshot = await metadata.snapshot();
    const work = snapshot.works.find(candidate => candidate.managed?.task_id === taskId && candidate.owner === state.owner_id);
    if (!work || work.state !== "active" || work.managed?.control_generation !== state.control_generation ||
        work.workspace_id !== workspace.workspace_id || workspace.root !== managed.root || workspace.repository_id !== binding.repositoryId) {
      throw new BridgeError("PEER_OPERATION_FORBIDDEN", "Worker task is not bound to its current managed coordination work");
    }
    const peerCase = snapshot.cases.find(candidate => candidate.id === request.case_id && candidate.state === "active");
    if (!peerCase || !peerCase.inputs.some(input => input.work_id === work.id)) {
      throw new BridgeError("PEER_OPERATION_FORBIDDEN", "Worker operation does not target its selected active case");
    }
    const currentTasks = peerCase.inputs.map(input => snapshot.works.find(candidate => candidate.id === input.work_id)?.managed?.task_id);
    if (currentTasks.some(id => !id) || currentTasks.length !== selectedTasks.length ||
      currentTasks.some(id => !selectedTasks.includes(id!))) {
      throw new BridgeError("PEER_OPERATION_STALE", "Selected task authority changed before the peer operation lease");
    }
    const actor = { owner_id: state.owner_id, task_id: taskId, run_id: state.native.run_id,
      control_generation: state.control_generation, workspace_id: work.workspace_id, source_view: admission.source_view, case_id: request.case_id };
    const operation = decodePeerWorkerOperation({ ...request, task_id: actor.task_id, run_id: actor.run_id,
      control_generation: actor.control_generation, workspace_id: actor.workspace_id, source_view: actor.source_view, case_id: actor.case_id });
    // Observation can return a canonical settled outcome after a selected source
    // task has finished. Fresh inspect/await still reauthorizes every source in
    // captureEvidenceId before exposing source-backed proposal evidence.
    if (operation.kind !== "inspect" && operation.kind !== "await_change") {
      for (const input of peerCase.inputs) {
        const selected = snapshot.works.find(candidate => candidate.id === input.work_id)!;
        await this.#authorizePeerCaseSource(peerCase.id, taskId, selected.id, selected.revision,
          { control_generation: selected.managed!.control_generation,
            workspace_generation: selected.managed!.control_generation }, "report");
      }
    }
    if (operation.kind === "apply") {
      const prior = await store.readPeerOperation(taskId, operation.operation_key);
      if (prior) {
        if (prior.request_hash !== canonicalHash(operation))
          throw new BridgeError("OPERATION_KEY_CONFLICT", "Application key belongs to a different task request");
        if (prior.disposition !== "settled")
          throw new BridgeError("PEER_OPERATION_RECOVERY_REQUIRED", "An application effect is pending or uncertain; inspect its workspace before another attempt");
        // A crash can settle the task result before the case outcome note. Re-enter
        // exact application admission with the retained result to finish that note;
        // this callback has no filesystem effect.
        return this.#coordinationSession(binding).workerApplication(
          { owner_id: state.owner_id, source_view: admission.source_view }, actor, operation,
          async () => prior.result!, undefined, prior.result!);
      }
      const assertEffectScope = () => {
        const paths = proposalPaths();
        for (const path of paths) {
          if (!admission.request.allowed_paths?.some(allowed =>
            allowed.endsWith("/") ? path.startsWith(allowed) : path === allowed || path.startsWith(`${allowed}/`)) ||
            !peerCase.inputs.every(input => {
              const selected = snapshot.works.find(candidate => candidate.id === input.work_id);
              return selected?.areas.some(area => regionIncludesPath([area], path));
            }) || ![...this.#currentOverlapPairs.values()].some(pair => pair.input.path === path &&
              peerCase.inputs.some(input => input.work_id === pair.current_work_id) &&
              peerCase.inputs.some(input => input.work_id === pair.other_work_id))) {
            throw new BridgeError("PEER_OPERATION_FORBIDDEN", "Application path is outside task and observed overlap scope");
          }
        }
      };
      let admittedProposal: import("../coordination/peer-resolution.js").PeerResolutionProposal | undefined;
      const proposalPaths = () => admittedProposal?.changes?.map(change => change.path) ?? [];
      return this.#coordinationSession(binding).workerApplication(
        { owner_id: state.owner_id, source_view: admission.source_view }, actor, operation, async proposal => {
          admittedProposal = proposal;
          const intent = await store.startPeerOperation(taskId, operation);
          if (!intent.created) {
            if (intent.record.disposition === "settled") return intent.record.result!;
            throw new BridgeError("PEER_OPERATION_RECOVERY_REQUIRED", "An application effect is pending or uncertain; inspect its workspace before another attempt");
          }
          const sourcesCurrent = async () => {
            assertEffectScope();
            const latest = await metadata.snapshot();
            const currentCase = latest.cases.find(candidate => candidate.id === peerCase.id && candidate.state === "active");
            if (!currentCase || currentCase.revision !== proposal.case_revision ||
              currentCase.generation !== proposal.case_generation ||
              proposal.sources.length !== currentCase.inputs.length) {
              throw new BridgeError("PEER_OPERATION_STALE", "Application case changed before file effect");
            }
            for (const source of proposal.sources) {
              const selected = currentCase.inputs.find(input => input.work_id === source.work_id);
              const selectedWork = latest.works.find(candidate => candidate.id === source.work_id);
              if (!selected || selected.commit_oid !== source.selected_commit_oid || !selectedWork?.managed ||
                selectedWork.revision !== source.work_revision || selectedWork.input_oid !== source.input_oid) {
                throw new BridgeError("PEER_OPERATION_STALE", "Application selected source changed");
              }
              const sourceControl = await store.readControl(selectedWork.managed.task_id);
              if (sourceControl.owner_id !== selectedWork.owner ||
                sourceControl.control_generation !== selectedWork.managed.control_generation ||
                sourceControl.phase !== "active" || sourceControl.cancel ||
                selectedWork.managed.task_id === taskId &&
                  (sourceControl.native.state !== "observed_live" ||
                    sourceControl.native.coverage !== "turn_scoped" || sourceControl.native.obligations.length)) {
                throw new BridgeError("PEER_OPERATION_STALE", "Application selected source task authority changed");
              }
              await this.#authorizePeerCaseSource(currentCase.id, taskId, selectedWork.id, selectedWork.revision,
                { control_generation: selectedWork.managed.control_generation,
                  workspace_generation: selectedWork.managed.control_generation }, "detail");
            }
            if (await this.#peerCaptureEvidenceId(taskId, latest, currentCase) !== proposal.evidence_id) {
              throw new BridgeError("PEER_OPERATION_STALE", "Selected source bytes changed after worker consent");
            }
            const applyingControl = await store.readControl(taskId), applyingResource = await store.readResource(taskId);
            if (applyingControl.owner_id !== actor.owner_id || applyingControl.control_generation !== actor.control_generation ||
              applyingControl.native.run_id !== actor.run_id || applyingControl.phase !== "active" || applyingControl.cancel ||
              applyingResource?.state !== "pending" || applyingResource.worktree_path !== managed.root) {
              throw new BridgeError("PEER_OPERATION_STALE", "Applying task workspace authority changed");
            }
            const latestWorkspace = await repository.inspect(managed.root, signal);
            if (latestWorkspace.workspace_id !== actor.workspace_id) {
              throw new BridgeError("PEER_OPERATION_STALE", "Applying workspace identity changed");
            }
          };
          const applied = await applyPeerResolutionChanges({ workspaceRoot: managed.root,
            scope: proposal.scope, sources: proposal.sources, changes: proposal.changes!,
            withCurrentSources: async (_sources, effect) => (await this.#taskControls()).withTaskPublication(selectedTasks, async () => {
              await sourcesCurrent();
              return effect();
            }) });
          const verifiedAfter = applied.verified_after;
          const verified = applied.status === "applied" && verifiedAfter?.length === proposal.changes!.length &&
            verifiedAfter.every((item, index) => item.path === proposal.changes![index]!.path &&
              item.after_sha256 === (proposal.changes![index]!.after_base64 === null ? null :
                createHash("sha256").update(Buffer.from(proposal.changes![index]!.after_base64!, "base64")).digest("hex")));
          const applicationDigest = verified
            ? canonicalHash({ case_id: peerCase.id, note_id: operation.note_id,
              proposal_digest: proposal.resolution_digest, workspace_id: actor.workspace_id,
              paths: applied.paths, after: verifiedAfter }) : null;
          const status = applied.status === "applied" && applicationDigest === null ? "effect_unknown" : applied.status;
          const result: PeerWorkerOperationResult = { schema_version: 1, task_id: actor.task_id, run_id: actor.run_id,
            control_generation: actor.control_generation, workspace_id: actor.workspace_id, source_view: actor.source_view,
            case_id: actor.case_id, operation_key: operation.operation_key, kind: "application", operation: "apply",
            note_id: operation.note_id, status, application_digest: applicationDigest, paths: [...applied.paths] };
          const settled = await store.settlePeerOperationOutcome(taskId, operation.operation_key, result);
          return settled.record.result!;
        }, async proposal => (await this.#taskControls()).withTaskPublication(selectedTasks, async () => {
          admittedProposal = proposal;
          assertEffectScope();
          if (await this.#peerCaptureEvidenceId(taskId, snapshot, peerCase) !== proposal.evidence_id) {
            throw new BridgeError("PEER_OPERATION_STALE", "Selected source bytes changed after worker consent");
          }
        }));
    }
    if (operation.kind === "source_detail") {
      const source = snapshot.works.find(candidate => candidate.id === operation.work_id);
      if (!source?.managed || !peerCase.inputs.some(input => input.work_id === source.id))
        throw new BridgeError("PEER_OPERATION_FORBIDDEN", "Requested captured detail is outside the selected case");
      const observation = await this.#observation();
      const authorize = (_recipient: string, workId: string, revision: number, generation: ObservationGeneration) =>
        this.#authorizePeerCaseSource(peerCase.id, taskId, workId, revision, generation, "detail");
      const retained = await observation.store.readRetainedPair(operation.report_id, state.owner_id, authorize);
      const selectedOverlap = [...this.#currentOverlapPairs.values()].some(pair =>
        pair.input.path === retained.path && [pair.current_work_id, pair.other_work_id].includes(source.id) &&
        [pair.current_work_id, pair.other_work_id].includes(work.id) &&
        regionIncludesPath(source.areas, retained.path) && regionIncludesPath(work.areas, retained.path) &&
        peerCase.inputs.some(input => input.work_id === pair.current_work_id) &&
        peerCase.inputs.some(input => input.work_id === pair.other_work_id));
      if (retained.work_id !== source.id || retained.work_revision !== source.revision ||
        !selectedOverlap ||
        this.#publishedArtifactIds.get(JSON.stringify([source.id, retained.path]))?.id !== retained.id) {
        throw new BridgeError("PEER_OPERATION_STALE", "Requested capture is not the current selected source report");
      }
      const disclose = async (value: PeerWorkerOperationResult): Promise<PeerWorkerOperationResult> =>
        (await this.#taskControls()).withTaskPublication(selectedTasks, async () => {
          const latest = await metadata.snapshot();
          const selectedCase = latest.cases.find(candidate => candidate.id === peerCase.id && candidate.state === "active");
          if (!selectedCase || selectedCase.revision !== peerCase.revision || selectedCase.generation !== peerCase.generation ||
            !selectedCase.inputs.some(input => input.work_id === source.id) ||
            !selectedCase.inputs.some(input => input.work_id === work.id)) {
            throw new BridgeError("PEER_OPERATION_STALE", "Selected case changed before source disclosure");
          }
          if (this.#publishedArtifactIds.get(JSON.stringify([source.id, retained.path]))?.id !== retained.id ||
            ![...this.#currentOverlapPairs.values()].some(pair => pair.input.path === retained.path &&
              [pair.current_work_id, pair.other_work_id].includes(source.id) &&
              [pair.current_work_id, pair.other_work_id].includes(work.id) &&
              selectedCase.inputs.some(input => input.work_id === pair.current_work_id) &&
              selectedCase.inputs.some(input => input.work_id === pair.other_work_id))) {
            throw new BridgeError("PEER_OPERATION_STALE", "Captured overlap changed before source disclosure");
          }
          for (const id of selectedTasks) {
            const current = await store.readControl(id);
            const selectedWork = latest.works.find(candidate => candidate.managed?.task_id === id);
            if (!selectedWork?.managed || current.owner_id !== selectedWork.owner ||
              current.control_generation !== selectedWork.managed.control_generation || current.phase !== "active" || current.cancel ||
              id === taskId && (current.native.run_id !== actor.run_id || current.native.state !== "observed_live" ||
                current.native.coverage !== "turn_scoped" || current.native.obligations.length)) {
              throw new BridgeError("PEER_OPERATION_STALE", "Selected task changed before source disclosure");
            }
          }
          await authorize(state.owner_id, source.id, source.revision,
            { control_generation: source.managed!.control_generation,
              workspace_generation: source.managed!.control_generation });
          return value;
        });
      const intent = await store.startPeerOperation(taskId, operation);
      if (!intent.created && intent.record.disposition === "settled") return this.#coordinationSession(binding).workerCasePublication(
        { owner_id: state.owner_id, source_view: admission.source_view }, actor, operation,
        () => disclose(intent.record.result!));
      if (!intent.created && intent.record.disposition === "unavailable")
        throw new BridgeError("PEER_OPERATION_RECOVERY_REQUIRED", "Source detail was unavailable during restart recovery");
      const detail = await observation.store.readDetail(operation.report_id, state.owner_id, operation.side,
        operation.start_byte, operation.end_byte, authorize);
      const selectedFile = retained[operation.side];
      if (selectedFile.status !== "present") throw new BridgeError("STRUCTURAL_DETAIL_UNAVAILABLE", "Selected source side has no captured bytes");
      const result: PeerWorkerOperationResult = { schema_version: 1, task_id: actor.task_id, run_id: actor.run_id,
        control_generation: actor.control_generation, workspace_id: actor.workspace_id,
        source_view: actor.source_view, case_id: actor.case_id, operation_key: operation.operation_key,
        kind: "detail", operation: "source_detail", work_id: source.id, report_id: retained.id,
        side: operation.side, start_byte: operation.start_byte, end_byte: operation.end_byte,
        content_sha256: selectedFile.content_sha256, text: detail.text };
      const settled = await store.settlePeerOperationOutcome(taskId, operation.operation_key, result);
      return this.#coordinationSession(binding).workerCasePublication(
        { owner_id: state.owner_id, source_view: admission.source_view }, actor, operation,
        () => disclose(settled.record.result!));
    }
    const intent = await store.startPeerOperation(taskId, operation);
    if (!intent.created) {
      if (intent.record.disposition === "settled") return this.#coordinationSession(binding).workerPeerRetainedResult(
        { owner_id: state.owner_id, source_view: admission.source_view }, actor, operation, intent.record.result!);
      const recovered = await this.#coordinationSession(binding).workerPeerCommittedReceipt(
        { owner_id: state.owner_id, source_view: admission.source_view }, actor, operation);
      if (intent.record.disposition === "unavailable") {
        if (recovered) {
          // The metadata receipt is durable. The task intent remains unavailable because
          // restart did not restore the native continuation or its task-owned result.
          return this.#coordinationSession(binding).workerPeerRetainedResult(
            { owner_id: state.owner_id, source_view: admission.source_view }, actor, operation, recovered);
        }
        throw new BridgeError("PEER_OPERATION_RECOVERY_REQUIRED", "Peer operation was marked unavailable during restart recovery");
      }
      if (recovered) {
        const settled = await store.settlePeerOperation(taskId, operation.operation_key, recovered);
        return this.#coordinationSession(binding).workerPeerRetainedResult(
          { owner_id: state.owner_id, source_view: admission.source_view }, actor, operation, settled.result!);
      }
    }
    const started = await appendWorkerPeerOperationStartEvent(store, taskId, operation, intent.created);
    if (!started) omitTelemetry();
    let result: PeerWorkerOperationResult;
    try {
      result = await this.#coordinationSession(binding).workerPeerOperation(
        { owner_id: state.owner_id, source_view: admission.source_view }, actor, operation, signal, true);
    } catch (error) {
      if ((operation.kind !== "inspect" && operation.kind !== "await_change") ||
          errorInfo(error).code !== "PEER_OPERATION_STALE") throw error;
      // Another exact observer may have settled while this one retried fresh metadata.
      const retained = await store.readPeerOperation(taskId, operation.operation_key);
      if (retained?.disposition !== "settled") throw error;
      return this.#coordinationSession(binding).workerPeerRetainedResult(
        { owner_id: state.owner_id, source_view: admission.source_view }, actor, operation, retained.result!);
    }
    {
      // The task record is authoritative across restart; telemetry may be capped independently.
      let settlement;
      try { settlement = await store.settlePeerOperationOutcome(taskId, operation.operation_key, result); }
      catch (error) {
        if ((operation.kind !== "await_change" && operation.kind !== "inspect") ||
            errorInfo(error).code !== "OPERATION_KEY_CONFLICT") throw error;
        // Concurrent exact observations may capture different case versions. The first
        // durable result wins; the later observer discloses that retained result.
        const retained = await store.readPeerOperation(taskId, operation.operation_key);
        if (retained?.disposition !== "settled") throw error;
        settlement = { record: retained, created: false };
      }
      const settled = settlement.record;
      if (settlement.created) {
        const retained = await store.appendEvent(taskId, { kind: "worker_peer_operation", operation: operation.kind,
          operation_key: operation.operation_key, case_id: operation.case_id, run_id: operation.run_id,
          control_generation: operation.control_generation, outcome: settled.result!.kind, result_digest: canonicalHash(settled.result) });
        if (!retained) omitTelemetry();
      }
      return this.#coordinationSession(binding).workerPeerRetainedResult(
        { owner_id: state.owner_id, source_view: admission.source_view }, actor, operation, settled.result!);
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
        this.#coordinator = new Coordinator(binding.project, binding.repositoryId, profile.execution, this.#store!, registry, () => this.#assertAuthority(), this.#controls, "selected_capable");
        this.#coordinator.onAuthorizePeerDelivery = envelope => this.#authorizePeerDelivery(envelope);
        this.#coordinator.onPeerDeliveryObserved = caseId => { this.#wakeObservedCaseReceipt(caseId); return Promise.resolve(); };
        this.#coordinator.onPeerDeliveryQueuedStale = caseId => { this.#wakeSelectedCase(caseId); return Promise.resolve(); };
        this.#coordinator.onWorkerPeerOperation = (taskId, request, signal) => this.#workerPeerOperation(taskId, request, signal);
        this.#coordinator.onSettled = () => this.onSettled?.();
        this.#coordinator.onTaskSettled = taskId => {
          if (this.#lifetime.signal.aborted) return;
          this.#scheduleTerminalBinding(taskId);
          if (this.#admissionClosed) return;
          const wake = this.#track(() => this.#wakeCasesForSettledTask(taskId));
          this.#terminalCaseWakes.add(wake);
          void wake.then(() => this.#terminalCaseWakes.delete(wake), error => {
            this.#terminalCaseWakes.delete(wake);
            this.#failure ??= diagnosticInfo(error);
          });
        };
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
      if (reply.kind === "receipt" && reply.receipt.action === "select_inputs") {
        this.#wakeSelectedCase(reply.receipt.item_id);
      }
      if (reply.kind === "receipt" && (reply.receipt.action === "grant_source" ||
        reply.receipt.action === "watch_source" || reply.receipt.action === "share_work")) {
        await this.#forgetObservationSafely(reply.receipt.item_id);
      }
      if (reply.kind === "receipt" && (reply.receipt.action === "register_work" ||
        reply.receipt.action === "register_task_work" || reply.receipt.action === "grant_source" ||
        reply.receipt.action === "watch_source" || reply.receipt.action === "share_work")) {
        this.#scheduleObservation(reply.receipt.item_id);
      }
      if (reply.kind === "receipt" && reply.receipt.action === "close_work") {
        const metadata = await this.#coordinationSession(binding).observationStore();
        const work = (await metadata.snapshot()).works.find(item => item.id === reply.receipt.item_id);
        if (work) await this.#forgetObservationSafely(work.id, work.workspace_id);
      }
      if (reply.kind === "recovery_receipt") {
        const command = reply.receipt.command;
        if (command.kind === "adopt_work") { await this.#forgetObservationSafely(command.work_id); this.#scheduleObservation(command.work_id); }
        if (command.kind === "close_work") {
          const metadata = await this.#coordinationSession(binding).observationStore();
          const work = (await metadata.snapshot()).works.find(item => item.id === command.work_id);
          if (work) await this.#forgetObservationSafely(work.id, work.workspace_id);
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
    selectedPaths?: readonly string[], view: "comparison" | "input" | "observed" = "comparison"): Promise<Readonly<{
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
    if (view !== "comparison" && view !== "input" && view !== "observed") {
      return Promise.reject(new BridgeError("STRUCTURAL_REPORT_VIEW_INVALID", "Structural report view must be comparison, input, or observed"));
    }
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
      const { compareCapturedWork, inspectCapturedSource } = await import("../observation/comparison.js");
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
        const rendered = view === "comparison"
          ? await compareCapturedWork({ work_id: work.id, parent_id: work.owner, dialect, input, observed }, this.#nativeAnalysis, ownedSignal)
          : await inspectCapturedSource(view === "input" ? input : observed, dialect, this.#nativeAnalysis, ownedSignal);
        samples.push({ path, dialect, text: rendered.text, input, observed });
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
        workerPeerAuthority: {
          captureEvidenceId: (actor, snapshot, item) =>
            this.#peerCaptureEvidenceId(actor.task_id, snapshot, item),
          assertCurrent: async (actor, snapshot, item, historicalOutcome) => {
            const store = this.#store;
            if (!store) throw new BridgeError("PEER_OPERATION_UNAVAILABLE", "Task authority store is unavailable");
            const current = await store.readControl(actor.task_id);
            const admission = await store.durableRequest(actor.task_id);
            const resource = await store.readResource(actor.task_id);
            if (current.owner_id !== actor.owner_id || current.control_generation !== actor.control_generation
              || current.native.run_id !== actor.run_id || current.native.state !== "observed_live"
              || current.native.coverage !== "turn_scoped" || current.native.obligations.length
              || current.cancel || current.phase !== "active" || admission.schema_version !== 5
              || admission.source_view !== actor.source_view || admission.initial_owner !== actor.owner_id
              || !resource || resource.state !== "pending" || !resource.worktree_path) {
              throw new BridgeError("PEER_OPERATION_STALE", "Worker task authority changed during peer operation");
            }
            const ownWork = snapshot.works.find(work => work.managed?.task_id === actor.task_id);
            if (!ownWork || ownWork.workspace_id !== actor.workspace_id || ownWork.owner !== actor.owner_id
              || ownWork.managed?.control_generation !== actor.control_generation) {
              throw new BridgeError("PEER_OPERATION_STALE", "Worker managed work authority changed");
            }
            const source = await managedTaskSource(store, binding.repositoryId, actor.task_id);
            if (source.root !== resource.worktree_path) throw new BridgeError("PEER_OPERATION_STALE", "Worker workspace authority changed");
            if (historicalOutcome) return;
            for (const input of item.inputs) {
              const work = snapshot.works.find(candidate => candidate.id === input.work_id);
              if (!work?.managed) continue;
              const control = await store.readControl(work.managed.task_id);
              if (control.owner_id !== work.owner || control.control_generation !== work.managed.control_generation
                || control.cancel || control.phase !== "active") {
                throw new BridgeError("PEER_OPERATION_STALE", "Selected managed source authority changed");
              }
            }
          },
          assertConsentCurrent: async (snapshot, item, note) => {
            const store = this.#store;
            if (!store) throw new BridgeError("PEER_OPERATION_UNAVAILABLE", "Task authority store is unavailable");
            for (const input of item.inputs) {
              const work = snapshot.works.find(candidate => candidate.id === input.work_id);
              if (!work?.managed) throw new BridgeError("PEER_OPERATION_STALE", "Worker proposal has no current managed participant");
              const control = await store.readControl(work.managed.task_id);
              if (control.owner_id !== work.owner || control.control_generation !== work.managed.control_generation
                || control.cancel || control.phase !== "active") {
                throw new BridgeError("PEER_OPERATION_STALE", "Worker consent was invalidated by task control");
              }
              const principal = canonicalHash({ task_id: work.managed.task_id, owner: work.owner,
                control_generation: work.managed.control_generation, workspace_id: work.workspace_id });
              if (note.acknowledged.includes(principal)) {
                const prefix = `worker-peer-v1:${work.managed.task_id}:${control.native.run_id}:`;
                if (!snapshot.receipts.some(receipt => receipt.action === "ack_note" && receipt.item_id === note.id
                  && receipt.key.startsWith(prefix))) {
                  throw new BridgeError("PEER_OPERATION_STALE", "Worker consent belongs to an earlier native run");
                }
              }
            }
          },
          assertRetainedSources: async (actor, snapshot, sources) => {
            const store = this.#store;
            if (!store) throw new BridgeError("PEER_OPERATION_UNAVAILABLE", "Task authority store is unavailable");
            for (const source of sources) {
              const work = snapshot.works.find(candidate => candidate.id === source.work_id);
              if (!work || work.state !== "active" || work.revision !== source.work_revision ||
                work.input_oid !== source.input_oid) {
                throw new BridgeError("STRUCTURAL_SOURCE_FORBIDDEN", "Retained peer source work changed");
              }
              const selectedCase = snapshot.cases.find(candidate => candidate.id === actor.case_id && candidate.state === "active");
              if (!selectedCase || !selectedCase.members.includes(actor.owner_id) ||
                !selectedCase.inputs.some(input => input.work_id === work.id)) {
                throw new BridgeError("STRUCTURAL_SOURCE_FORBIDDEN", "Retained peer source is outside the selected case");
              }
              if (!work.managed) continue;
              const control = await store.readControl(work.managed.task_id);
              if (control.owner_id !== work.owner || control.control_generation !== work.managed.control_generation
                || control.cancel || control.phase !== "active") {
                throw new BridgeError("STRUCTURAL_SOURCE_FORBIDDEN", "Retained managed source authority changed");
              }
              const resource = await store.readResource(work.managed.task_id);
              const managed = await managedTaskSource(store, binding.repositoryId, work.managed.task_id);
              if (!resource || resource.state !== "pending" || resource.worktree_path !== managed.root
                || managed.input_oid !== work.input_oid) {
                throw new BridgeError("STRUCTURAL_SOURCE_FORBIDDEN", "Retained managed source workspace changed");
              }
              const { CoordinationRepository } = await import("../coordination/repository.js");
              const repository = await CoordinationRepository.open(binding.project, binding.repositoryId, coordinationLimits.max_worktrees);
              const workspace = await repository.inspect(managed.root);
              if (workspace.workspace_id !== work.workspace_id || workspace.repository_id !== binding.repositoryId) {
                throw new BridgeError("STRUCTURAL_SOURCE_FORBIDDEN", "Retained managed source view changed");
              }
            }
          },
          withPublication: async (snapshot, item, actor, retainedSources, publish, consent, historicalOutcome) => {
            const store = this.#store;
            if (!store) throw new BridgeError("PEER_OPERATION_UNAVAILABLE", "Task authority store is unavailable");
            if (historicalOutcome && (!actor || retainedSources.length || consent)) {
              throw new BridgeError("PEER_OPERATION_STALE", "Historical outcome disclosure cannot admit a source or effect");
            }
            const selected = item.inputs.filter(input => !historicalOutcome ||
              snapshot.works.find(work => work.id === input.work_id)?.managed?.task_id === actor?.task_id)
              .map(input => snapshot.works.find(work => work.id === input.work_id));
            const retained = retainedSources.map(source => snapshot.works.find(work => work.id === source.work_id));
            const works = [...selected, ...retained];
            if (works.some(work => !work?.managed)) {
              throw new BridgeError("PEER_OPERATION_STALE", "Worker publication requires current managed source authority");
            }
            const taskIds = works.map(work => work!.managed!.task_id);
            type TaskState = Awaited<ReturnType<TaskStore["readControl"]>>;
            const authorityFacts = (control: TaskState) => canonicalHash({
              owner_id: control.owner_id, control_generation: control.control_generation,
              phase: control.phase, cancel: control.cancel ?? null,
              // A peer's routine next turn does not revoke its immutable source.
              // The acting task still needs its exact settled native state.
              native: actor?.task_id === control.task_id ? control.native : { run_id: control.native.run_id },
            });
            const validate = (work: Work, control: TaskState) => {
              if (control.owner_id !== work.owner || control.control_generation !== work.managed!.control_generation
                || control.cancel || control.phase !== "active" || actor?.task_id === control.task_id &&
                  (control.native.state !== "observed_live"
                    || control.native.coverage !== "turn_scoped" || control.native.obligations.length)
                || actor?.task_id === control.task_id && control.native.run_id !== actor.run_id) {
                throw new BridgeError("PEER_OPERATION_STALE", "Selected task authority changed before peer publication");
              }
              if (consent) {
                const principal = canonicalHash({ task_id: work.managed!.task_id, owner: work.owner,
                  control_generation: work.managed!.control_generation, workspace_id: work.workspace_id });
                if (consent.acknowledged.includes(principal)) {
                  const prefix = `worker-peer-v1:${work.managed!.task_id}:${control.native.run_id}:`;
                  if (!snapshot.receipts.some(receipt => receipt.action === "ack_note" && receipt.item_id === consent.id
                    && receipt.key.startsWith(prefix))) {
                    throw new BridgeError("PEER_OPERATION_STALE", "Worker consent belongs to an earlier native run");
                  }
                }
              }
            };
            // Capture only bounded task facts. The reservation closes the gap
            // between this read and the metadata commit without holding a mutex
            // across repository or authority callbacks.
            const observed = new Map<string, string>();
            for (const work of works) {
              const control = await store.readControl(work!.managed!.task_id);
              validate(work!, control);
              observed.set(control.task_id, authorityFacts(control));
            }
            return (await this.#taskControls()).withTaskPublication(taskIds, async () => {
              for (const work of works) {
                const control = await store.readControl(work!.managed!.task_id);
                if (observed.get(control.task_id) !== authorityFacts(control))
                  throw new BridgeError("PEER_OPERATION_STALE", actor?.task_id === control.task_id
                    ? "Acting task turn changed before peer publication"
                    : "Selected source task authority changed before peer publication");
                validate(work!, control);
              }
              return publish();
            });
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
    return () => {
      if (released) return;
      released = true;
      this.#taskAssociations.delete(id);
      const waiters = this.#taskAssociationWaiters.get(id);
      this.#taskAssociationWaiters.delete(id);
      for (const wake of waiters ?? []) wake();
    };
  }
  async #reserveTaskAssociationAfterCurrent(id: string): Promise<() => void> {
    for (;;) {
      this.#assertOpen(); this.#assertAuthority();
      if (!this.#taskAssociations.has(id)) return this.#reserveTaskAssociation(id);
      await new Promise<void>(resolve => {
        const waiters = this.#taskAssociationWaiters.get(id) ?? new Set<() => void>();
        waiters.add(resolve);
        this.#taskAssociationWaiters.set(id, waiters);
      });
    }
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
        const receipt = this.#coordination && this.#binding
          ? await this.#coordination.withWorkerTaskTransition(
            { owner_id: actor.owner_id, source_view: this.#binding.project }, id,
            () => controls.adopt(id, actor, operation))
          : await controls.adopt(id, actor, operation);
        await controls.withTaskPublication([id], () => this.#captureIndex.run(() => this.#forgetObservation(id)));
        return { receipt, task: await controls.read(id, actor) };
      } finally { release(); }
    });
  }
  async cancelTask(id: string, actor: ClientActor, generation: number, operation: string, reason: string) {
    return this.#track(async () => {
      const controls = await this.#taskControls();
      const release = await this.#reserveTaskAssociationAfterCurrent(id);
      try {
      // This durable receipt is the sole caller authorization. Later effects read
      // the retained stop and can be retried after a collision or generation change.
      const admittedReceipt = await controls.cancel(id, actor, generation, operation, reason);
      const state = await this.#store!.readControl(id);
      if (!state.cancel) return admittedReceipt;
      const invalidate = this.#coordination ? this.#coordination.invalidateCancelledTask(id) : Promise.resolve();
      const dispatch = this.#coordinator ? this.#coordinator.dispatchCommittedCancellation(id) : Promise.resolve();
      const [nativeOutcome, metadataOutcome] = await Promise.allSettled([dispatch, invalidate]);
      if (nativeOutcome.status === "rejected") throw nativeOutcome.reason;
      if (metadataOutcome.status === "rejected") throw metadataOutcome.reason;
      if (this.#coordinator) return admittedReceipt;
      const admitted = await this.#store!.durableRequest(id);
      if (admitted.schema_version === 5 && state.cancel && state.native.state === "not_started" && state.phase !== "terminal") {
        if (!this.#startupCoordinatedQueue.includes(id)) this.#startupCoordinatedQueue.push(id);
        await this.#reconcileStartupCoordinated();
        return admittedReceipt;
      }
      if (state.native.state === "not_started" && state.attention?.startsWith("Recovered queued") && !await this.#store!.readResult(id)) {
        const { baseResult } = await import("./result.js");
        const result = { ...baseResult(id, admitted.request, admitted.execution), execution_status: "cancelled" as const, summary: "Explicitly cancelled preserved never-started work", native_evidence: state.native };
        await this.#store!.writeResult(id, result);
        await controls.change(id, (s) => { s.phase = "terminal"; s.outcome = "cancelled"; delete s.attention; });
      }
      return admittedReceipt;
      } finally { release(); }
    });
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
    if (this.#preparation || this.#composition && !this.#coordinator || this.#obligationPending.size ||
      this.#terminalCaseWakes.size || this.#coordinator?.outstandingCount || this.#coordination?.pendingCount) return true;
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
      await Promise.allSettled([...this.#terminalCaseWakes]);
      await Promise.allSettled([...this.#deliveryReconciliation.values()].flatMap(item =>
        [item.receiptRunning, item.running].filter((running): running is Promise<void> => !!running)));
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
