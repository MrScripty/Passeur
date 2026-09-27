import { randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Assignment } from "../contracts/agents.js";
import { CoordinatedSubmissionIdentitySchema, CoordinatedLinkSchema, coordinatedMaterialIdentity, TaskIdSchema } from "../contracts/tasks.js";
import type { LifecyclePolicy, LifecycleResult, SubmissionIdentity, CoordinatedSubmissionIdentity, CurrentDurableRequest, CoordinatedDurableRequest, CoordinatedLink, TaskObservation, TaskControl } from "../contracts/tasks.js";
import { TaskControls, initialControl, owns, type ClientActor } from "./task-control.js";
import { InputBroker } from "./input-broker.js";
import type { AgentRegistry, SelectedAgent } from "../agents/registry.js";
import type { WorkerEvent } from "../agents/types.js";
import type { WorkerPeerOperationRequest, WorkerPeerPort } from "../agents/types.js";
import type { PeerWorkerOperationResult } from "../contracts/peer-operations.js";
import { immutablePeerEnvelope, parsePeerDeliverySource, PeerDeliveryNativeSessionIdSchema, PeerDeliverySlotBundleSchema,
  MAX_PEER_DELIVERIES, type PeerDeliveryEnvelope, type PeerDeliverySource, type PeerDeliveryRecord,
  type PeerDeliveryReceiptStatus, type PeerDeliverySlotBundle, type PeerDeliverySlotReservation } from "../contracts/peer-delivery.js";
import { BridgeError, errorInfo } from "./errors.js";
import { Mutex, canonicalHash } from "./async.js";
import { baseResult } from "./result.js";
import { workerMessageInstructions } from "../agents/report-format.js";
import { TaskStore } from "../store/task-store.js";
import { collectChanges, createDiff, createManifest, observeDelivery, prepareWorkspace,
  preparePrivateGitView, preparePrivatePublication, replayPrivatePublication, type PrivateGitView, type Workspace } from "../workspace/worktree.js";
import { currentRevision, digestFiles, sourceStatus } from "../workspace/project.js";

type Entry = { selected: SelectedAgent; record: CurrentDurableRequest; controller: AbortController;
  stage: "queued" | "running" | "settling"; done: Promise<void>; resolve: () => void; workspace?: string };
export type CoordinatedReservation = Readonly<{ task_id: string; request_key: string; owner_id: string;
  intent_hash: string; payload_digest: string; source_view: string; announcement?: { id: string; revision: number };
  status: "reserved" | "admitted" }>;
type PendingReservation = { token: CoordinatedReservation; identity: CoordinatedSubmissionIdentity; selected: SelectedAgent };
/** Reconciles durable linkage and a never-started cancellation from retained admission alone. */
export async function reconcileCoordinatedRecord(store: TaskStore, record: CoordinatedDurableRequest,
  exactDecision: CoordinatedLink, liveControls?: TaskControls): Promise<boolean> {
  const link = CoordinatedLinkSchema.parse(exactDecision);
  const retained = await store.durableRequest(record.task_id);
  if (retained.schema_version !== 5 || canonicalHash(retained) !== canonicalHash(record) ||
    canonicalHash(retained.linkage) !== canonicalHash(link)) {
    throw new BridgeError("COORDINATION_LINK_CONFLICT", "Reconciliation requires the exact retained task and metadata binding");
  }
  if (retained.linkage.announcement) await store.changeAnnouncement(retained.linkage.announcement.id,
    retained.linkage.owner_id, { kind: "link", task_id: retained.task_id, revision: retained.linkage.announcement.revision });
  await store.settleCoordinatedLink(retained.linkage);
  const controls = liveControls ?? new TaskControls(store, retained.execution.policy.max_waiters, retained.execution.policy.max_control_receipts);
  return settleNeverStartedCoordinatedCancellation(store, retained, controls);
}
async function settleNeverStartedCoordinatedCancellation(store: TaskStore, record: CoordinatedDurableRequest,
  controls: TaskControls): Promise<boolean> {
  const id = record.task_id, state = await store.readControl(id);
  if (!state.cancel || state.phase === "terminal" || state.native.state !== "not_started") return false;
  if (!await store.readCoordinatedLink(id)) return false;
  const saved = await store.readResult(id);
  if (saved && (saved.schema_version !== 4 || saved.execution_status !== "cancelled" || saved.worker_stop !== "not_started")) {
    throw new BridgeError("COORDINATION_CANCELLATION_CONFLICT", "Retained result contradicts never-started cancellation");
  }
  if (!saved) {
    const result = { ...baseResult(id, record.request, record.execution), execution_status: "cancelled" as const,
      summary: "Cancelled before coordinated native startup", native_evidence: state.native };
    await store.writeResult(id, result);
  }
  await controls.change(id, (s) => {
    if (!s.cancel || s.native.state !== "not_started") throw new BridgeError("COORDINATION_CANCELLATION_CONFLICT", "Never-started cancellation evidence changed");
    s.phase = "terminal"; s.outcome = "cancelled"; s.settled_outcome = "cancelled"; delete s.attention;
  });
  return true;
}
const now = () => new Date().toISOString();
/** Replace one provisional Muse observation and its live inputs in a single durable control change. */
export function correlateNativeTurn(state: TaskControl, event: Extract<WorkerEvent, { kind: "turn_correlated" }>): void {
  const valid = (value: string) => value.length > 0 && Buffer.byteLength(value, "utf8") <= 256 && !value.includes("\0");
  if (!valid(event.provisional_turn_id) || !valid(event.turn_id) || !valid(event.native_session_id) ||
    state.native.turn_id !== event.provisional_turn_id || state.native.native_session_id !== event.native_session_id ||
    state.native.coverage !== "unknown" || state.native.state !== "observed_live" || state.cancel || state.settled_outcome ||
    state.native.obligations.length || state.inputs.some((input) =>
      (input.state === "pending" || input.state === "answer_intent" || input.state === "delivery_unknown") &&
      input.turn_id !== event.provisional_turn_id) ||
    state.inputs.some((input) => input.turn_id === event.provisional_turn_id && input.state === "delivery_unknown")) {
    throw new BridgeError("NATIVE_CORRELATION_INVALID", "Native turn cannot safely replace the provisional observation");
  }
  for (const input of state.inputs) if (input.turn_id === event.provisional_turn_id &&
    (input.state === "pending" || input.state === "answer_intent")) input.turn_id = event.turn_id;
  state.native.turn_id = event.turn_id;
}
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
  readonly #reservations = new Map<string, PendingReservation>();
  #queue: Entry[] = [];
  #active = 0;
  #closing = false;
  #frozen: string | undefined;
  #pump: Promise<void> | undefined;
  onSettled?: () => void;
  /** Signals the exact terminal task; the subscriber owns metadata retries and asynchronous failure. */
  onTaskSettled?: (taskId: string) => void;
  onCoordinatedWorkspacePrepared?: (record: CoordinatedDurableRequest, workspace: Workspace) => Promise<void>;
  /** Coordination owner must recheck exact grants and case/source versions; absence keeps the port unavailable. */
  onAuthorizePeerDelivery?: (envelope: PeerDeliveryEnvelope) => Promise<"current" | "stale" | "revoked">;
  /** Advisory wake after a durable native observed receipt; reconciliation reads TaskStore itself. */
  onPeerDeliveryObserved?: (caseId: string) => Promise<void>;
  /** A queued stale envelope may have been replaced by newer source evidence. */
  onPeerDeliveryQueuedStale?: (caseId: string) => Promise<void>;
  /** The runtime supplies task-bound identity; adapters may submit only decoded operation intent. */
  onWorkerPeerOperation?: (taskId: string, request: WorkerPeerOperationRequest, signal: AbortSignal) => Promise<PeerWorkerOperationResult>;
  constructor(readonly project: string, readonly projectId: string, readonly policy: LifecyclePolicy,
    readonly store: TaskStore, readonly registry: AgentRegistry, readonly assertAuthority: () => void = () => {}, controls?: TaskControls,
    readonly privateGitMode: "disabled" | "controlled" = "disabled") {
    this.policy = structuredClone(policy); Object.freeze(this.policy.implementation); Object.freeze(this.policy);
    this.controls = controls ?? new TaskControls(store, policy.max_waiters, policy.max_control_receipts);
    this.inputs = new InputBroker(this.controls, policy.max_pending_inputs);
  }
  isActive(id: string): boolean { return this.#entries.has(id); }
  get activeCount(): number { return this.#active; }
  get queuedCount(): number { return this.#queue.length; }
  get outstandingCount(): number { return this.#entries.size + this.#reservations.size; }
  get frozenReason(): string | undefined { return this.#frozen; }
  async assertMutationAllowed(): Promise<void> {
    this.assertAuthority();
    const reason = this.#frozen ?? await this.store.frozenReason();
    if (reason) throw new BridgeError("PROJECT_NEEDS_RECONCILIATION", reason);
    if (this.#closing) throw new BridgeError("BRIDGE_CLOSING", "Service admission is closed");
  }
  async #peerEvent(id: string, record: PeerDeliveryRecord): Promise<void> {
    if (!await this.store.appendEvent(id, { kind: "peer_delivery", delivery_id: record.envelope.delivery_id,
      idempotency_key: record.envelope.idempotency_key, state: record.state,
      ...(record.native_turn_id ? { native_turn_id: record.native_turn_id } : {}),
      ...(record.native_session_id ? { native_session_id: record.native_session_id } : {}) })) {
      await this.controls.change(id, (state) => { state.telemetry_omitted = true; });
    }
  }
  async #peerReceiptBinding(id: string, state: import("../contracts/tasks.js").TaskControl, envelope: PeerDeliveryEnvelope): Promise<"current" | "stale" | "cancelled" | "replaced"> {
    if (state.cancel || state.phase === "stopping") return "cancelled";
    if (state.phase === "terminal" || state.phase === "finalizing" || state.settled_outcome) return "stale";
    if (state.phase === "needs_attention" || state.native.state !== "observed_live") return "stale";
    const entry = this.#entries.get(id), resource = await this.store.readResource(id);
    if (!entry || entry.record.schema_version !== 5 || !entry.workspace || resource?.state !== "pending" || resource.worktree_path !== entry.workspace ||
      envelope.recipient_task_id !== id || envelope.recipient_run_id !== state.native.run_id ||
      envelope.recipient_workspace !== entry.workspace || envelope.recipient_workspace_fingerprint !== canonicalHash({
        task_id: id, source_view: entry.record.source_view, workspace: entry.workspace,
        base_commit: resource.base_commit, branch_ref: resource.branch_ref, target_ref: resource.target_ref,
      })) return "replaced";
    if (envelope.recipient_control_generation !== state.control_generation) return "stale";
    return "current";
  }
  async #peerValidity(id: string, state: import("../contracts/tasks.js").TaskControl, envelope: PeerDeliveryEnvelope): Promise<"current" | "stale" | "revoked" | "cancelled" | "replaced"> {
    const binding = await this.#peerReceiptBinding(id, state, envelope);
    if (binding !== "current") return binding;
    if (!this.onAuthorizePeerDelivery) return "revoked";
    const decision = await this.onAuthorizePeerDelivery(envelope);
    if (decision !== "current" && decision !== "stale" && decision !== "revoked") {
      throw new BridgeError("PEER_DELIVERY_AUTHORITY_INVALID", "Coordination returned an invalid peer grant decision");
    }
    return decision;
  }
  /** Trusted coordination producer only. The supplied source confers no authority without the current grant hook. */
  async reservePeerDeliverySlots(raw: PeerDeliverySlotBundle): Promise<void> {
    const bundle = PeerDeliverySlotBundleSchema.parse(raw);
    await this.assertMutationAllowed();
    await this.controls.change(bundle.recipient_task_id, async state => {
      const entry = this.#entries.get(bundle.recipient_task_id);
      const resource = await this.store.readResource(bundle.recipient_task_id);
      if (!entry?.workspace || entry.record.schema_version !== 5 || state.phase !== "active" || state.cancel ||
        state.native.state !== "observed_live" || state.native.run_id !== bundle.recipient_run_id ||
        state.control_generation !== bundle.recipient_control_generation ||
        resource?.state !== "pending" || resource.worktree_path !== bundle.recipient_workspace ||
        entry.workspace !== bundle.recipient_workspace ||
        canonicalHash({ task_id: bundle.recipient_task_id, source_view: entry.record.source_view,
          workspace: entry.workspace, base_commit: resource.base_commit, branch_ref: resource.branch_ref,
          target_ref: resource.target_ref }) !== bundle.recipient_workspace_fingerprint)
        throw new BridgeError("PEER_DELIVERY_STALE", "Recipient task or workspace changed before capacity reservation");
      if (state.schema_version === 2) Object.assign(state, { schema_version: 3, peer_delivery_reservations: [] });
      const slots = (state as Extract<TaskControl, { schema_version: 3 }>).peer_delivery_reservations;
      if (slots.some(slot => slot.state !== "released" && slot.case_id === bundle.case_id &&
        slot.case_revision === bundle.case_revision && slot.case_generation === bundle.case_generation &&
        slot.operation_key !== bundle.operation_key))
        throw new BridgeError("PEER_DELIVERY_RESERVATION_CONFLICT", "A different extension already owns this case revision's recipient slots");
      for (const source of bundle.sources) {
        const slot: PeerDeliverySlotReservation = { schema_version: 1,
          operation_key: bundle.operation_key, request_digest: bundle.request_digest,
          case_id: bundle.case_id, expected_case_revision: bundle.expected_case_revision,
          case_revision: bundle.case_revision, case_generation: bundle.case_generation,
          recipient_task_id: bundle.recipient_task_id, recipient_run_id: bundle.recipient_run_id,
          recipient_control_generation: bundle.recipient_control_generation,
          recipient_workspace: bundle.recipient_workspace,
          recipient_workspace_fingerprint: bundle.recipient_workspace_fingerprint,
          source_work_id: source.work_id, source_work_revision: source.work_revision, state: "reserved" };
        const prior = slots.find(candidate => candidate.operation_key === slot.operation_key &&
          candidate.source_work_id === slot.source_work_id);
        if (prior) {
          const { state: _state, delivery_id: _deliveryId, ...identity } = prior;
          const { state: _desiredState, ...wanted } = slot;
          if (canonicalHash(identity) !== canonicalHash(wanted))
            throw new BridgeError("PEER_DELIVERY_KEY_CONFLICT", "Reservation key names different recipient or source evidence");
          if (prior.state === "released") throw new BridgeError("PEER_DELIVERY_RESERVATION_RELEASED", "Ruled-out extension slot cannot be reserved again");
          continue;
        }
        if ((state.peer_deliveries?.length ?? 0) + slots.filter(candidate => candidate.state === "reserved").length >= MAX_PEER_DELIVERIES)
          throw new BridgeError("PEER_DELIVERY_CAPACITY", "Recipient cannot reserve every directed extension obligation");
        slots.push(slot);
      }
    });
  }
  async queuePeerDelivery(recipientTaskId: string, candidate: unknown,
    reservationOperationKey?: string): Promise<PeerDeliveryEnvelope> {
    const source = parsePeerDeliverySource(candidate);
    await this.assertMutationAllowed();
    for (let attempt = 0; attempt < 128; attempt++) {
      const captured = await this.store.readControl(recipientTaskId);
      const entry = this.#entries.get(recipientTaskId), resource = await this.store.readResource(recipientTaskId);
      const value = entry?.record.schema_version === 5 && entry.workspace && resource?.state === "pending" &&
        resource.worktree_path === entry.workspace && captured.native.state === "observed_live"
        ? immutablePeerEnvelope({ schema_version: 1, delivery_id: randomUUID(), ...source,
          recipient_task_id: recipientTaskId, recipient_run_id: captured.native.run_id,
          recipient_control_generation: captured.control_generation, recipient_workspace: entry.workspace,
          recipient_workspace_fingerprint: canonicalHash({ task_id: recipientTaskId, source_view: entry.record.source_view,
            workspace: entry.workspace, base_commit: resource.base_commit, branch_ref: resource.branch_ref, target_ref: resource.target_ref }) })
        : undefined;
      const validity = value ? await this.#peerValidity(recipientTaskId, captured, value) : "replaced";
      let changed: PeerDeliveryRecord | undefined;
      const outcome = await this.controls.change(recipientTaskId, (state) => {
        if (state.revision !== captured.revision) return { kind: "retry" as const };
      if (state.cancel) throw new BridgeError("PEER_DELIVERY_CANCELLED", "Recipient task was cancelled");
      if (state.phase === "terminal" || state.phase === "finalizing" || state.settled_outcome) {
        throw new BridgeError("PEER_DELIVERY_STALE", "Recipient task is no longer accepting peer evidence");
      }
      if (!value) throw new BridgeError("PEER_DELIVERY_UNAVAILABLE", "Recipient has no current coordinated native workspace");
      if (validity !== "current") throw new BridgeError(`PEER_DELIVERY_${validity.toUpperCase()}`, `Peer delivery ${validity} before queueing`);
      const prior = state.peer_deliveries?.find((record) => record.envelope.idempotency_key === source.idempotency_key);
      if (prior) {
        const previous: PeerDeliverySource = { source_work_id: prior.envelope.source_work_id,
          source_work_revision: prior.envelope.source_work_revision, case_id: prior.envelope.case_id,
          case_revision: prior.envelope.case_revision, case_generation: prior.envelope.case_generation,
          evidence_id: prior.envelope.evidence_id, evidence_revision: prior.envelope.evidence_revision,
          evidence_digest: prior.envelope.evidence_digest, content: prior.envelope.content,
          idempotency_key: prior.envelope.idempotency_key };
        if (canonicalHash(previous) !== canonicalHash(source)) throw new BridgeError("PEER_DELIVERY_KEY_CONFLICT", "Peer delivery key names different evidence");
        return { kind: "value" as const, envelope: immutablePeerEnvelope(prior.envelope) };
      }
      const reservedForSource = state.schema_version === 3 ? state.peer_delivery_reservations.find(slot =>
        slot.state === "reserved" && slot.recipient_task_id === recipientTaskId &&
        slot.recipient_run_id === value.recipient_run_id &&
        slot.recipient_control_generation === value.recipient_control_generation &&
        slot.recipient_workspace === value.recipient_workspace &&
        slot.recipient_workspace_fingerprint === value.recipient_workspace_fingerprint &&
        slot.case_id === source.case_id && slot.case_revision === source.case_revision &&
        slot.case_generation === source.case_generation && slot.source_work_id === source.source_work_id &&
        slot.source_work_revision === source.source_work_revision) : undefined;
      if (state.schema_version === 3 && state.peer_delivery_reservations.some(slot =>
        slot.state === "released" && slot.case_id === source.case_id &&
        slot.case_revision === source.case_revision && slot.case_generation === source.case_generation &&
        slot.source_work_id === source.source_work_id && slot.operation_key === reservationOperationKey))
        throw new BridgeError("PEER_DELIVERY_RESERVATION_RELEASED", "Ruled-out extension cannot queue a former obligation");
      if (reservedForSource && reservedForSource.operation_key !== reservationOperationKey)
        throw new BridgeError("PEER_DELIVERY_RESERVATION_REQUIRED", "Exact extension operation is required to consume its delivery slot");
      const matchingSlot = reservedForSource;
      if (reservationOperationKey && !matchingSlot) {
        const consumed = state.schema_version === 3 ? state.peer_delivery_reservations.find(slot =>
          slot.state === "consumed" && slot.operation_key === reservationOperationKey &&
          slot.case_id === source.case_id && slot.case_revision === source.case_revision &&
          slot.case_generation === source.case_generation && slot.source_work_id === source.source_work_id &&
          slot.source_work_revision <= source.source_work_revision &&
          slot.recipient_task_id === recipientTaskId && slot.recipient_run_id === value.recipient_run_id &&
          slot.recipient_control_generation === value.recipient_control_generation &&
          slot.recipient_workspace === value.recipient_workspace &&
          slot.recipient_workspace_fingerprint === value.recipient_workspace_fingerprint) : undefined;
        if (!consumed)
          throw new BridgeError("PEER_DELIVERY_RESERVATION_STALE", "Extension delivery has no exact current reserved or consumed source slot");
      }
      const reserved = state.schema_version === 3
        ? state.peer_delivery_reservations.filter(slot => slot.state === "reserved").length : 0;
      if ((state.peer_deliveries?.length ?? 0) + reserved >= MAX_PEER_DELIVERIES && !matchingSlot) {
        const pending = state.schema_version === 3 && state.peer_delivery_reservations.some(slot =>
          slot.case_id === source.case_id && slot.case_revision === source.case_revision &&
          slot.source_work_id === source.source_work_id);
        throw new BridgeError(pending ? "PEER_DELIVERY_CAPACITY_PENDING" : "PEER_DELIVERY_CAPACITY",
          "Retained peer deliveries and reserved obligations exhaust recipient capacity");
      }
      changed = { envelope: value, state: "queued", queued_at: now() };
      (state.peer_deliveries ??= []).push(changed);
      if (matchingSlot) { matchingSlot.state = "consumed"; matchingSlot.delivery_id = value.delivery_id; }
      return { kind: "value" as const, envelope: value };
      });
      if (outcome.kind === "retry") continue;
      if (changed) await this.#peerEvent(recipientTaskId, changed);
      return outcome.envelope;
    }
    throw new BridgeError("PEER_DELIVERY_STALE", "Recipient control changed during peer admission");
  }
  #peerPort(id: string): WorkerPeerPort {
    return Object.freeze({
      next: async () => {
        for (let attempt = 0; attempt < MAX_PEER_DELIVERIES * 2; attempt++) {
          const captured = await this.store.readControl(id);
          const head = captured.peer_deliveries?.find((record) => record.state === "queued");
          if (!head) return undefined;
          const validity = await this.#peerValidity(id, captured, head.envelope);
          let changed: PeerDeliveryRecord | undefined;
          const outcome = await this.controls.change(id, (state) => {
            if (state.revision !== captured.revision) return { kind: "retry" as const };
            const delivery = state.peer_deliveries?.find((record) => record.state === "queued");
            if (!delivery || delivery.envelope.delivery_id !== head.envelope.delivery_id) return { kind: "retry" as const };
            if (validity !== "current") {
              delivery.state = validity; delivery.disposition_at = now(); changed = structuredClone(delivery);
              return { kind: "drain" as const };
            }
          if (state.native.coverage !== "turn_scoped" || state.native.obligations.length ||
            state.inputs.some((input) => input.state === "pending" || input.state === "answer_intent" || input.state === "delivery_unknown")) {
            throw new BridgeError("PEER_DELIVERY_TURN_PENDING", "Peer delivery requires a settled native turn without pending obligations");
          }
          delivery.state = "dispatch_intent"; delivery.dispatch_intent_at = now(); changed = structuredClone(delivery);
            return { kind: "value" as const, envelope: immutablePeerEnvelope(delivery.envelope) };
          });
          if (changed) {
            await this.#peerEvent(id, changed);
            if (changed.state === "stale") {
              const callback = this.onPeerDeliveryQueuedStale;
              if (callback) void Promise.resolve().then(() => callback(changed!.envelope.case_id)).catch(() => undefined);
            }
          }
          if (outcome.kind === "retry" || outcome.kind === "drain") continue;
          const current = await this.#peerValidity(id, await this.store.readControl(id), outcome.envelope);
          if (current !== "current") {
            let withheld: PeerDeliveryRecord | undefined;
            await this.controls.change(id, state => {
              const delivery = state.peer_deliveries?.find(record => record.envelope.delivery_id === outcome.envelope.delivery_id);
              if (delivery?.state === "dispatch_intent") {
                // next() has not returned the envelope, so the native adapter cannot
                // have submitted it. An interrupted intent remains unknown on recovery.
                delivery.state = current; delivery.disposition_at = now(); withheld = structuredClone(delivery);
              }
            });
            if (withheld) {
              await this.#peerEvent(id, withheld);
              if (withheld.state === "stale") {
                const callback = this.onPeerDeliveryQueuedStale;
                if (callback) void Promise.resolve().then(() => callback(withheld!.envelope.case_id)).catch(() => undefined);
              }
            }
            continue;
          }
          return outcome.envelope;
        }
        throw new BridgeError("PEER_DELIVERY_STALE", "Peer queue changed during dispatch");
      },
      delivered: (key: string, nativeTurnId: string, nativeSessionId: string) => this.#acceptPeerReceipt(id, key, nativeTurnId, nativeSessionId, "delivered"),
      observed: (key: string, nativeTurnId: string, nativeSessionId: string) => this.#acceptPeerReceipt(id, key, nativeTurnId, nativeSessionId, "observed"),
      operation: async (request: WorkerPeerOperationRequest) => {
        const handler = this.onWorkerPeerOperation;
        if (!handler) throw new BridgeError("PEER_OPERATION_UNAVAILABLE", "The task has no authenticated worker operation boundary");
        const entry = this.#entries.get(id);
        if (!entry) throw new BridgeError("PEER_OPERATION_STALE", "The task no longer owns a live worker operation boundary");
        return handler(id, request, entry.controller.signal);
      },
    });
  }
  async #acceptPeerReceipt(id: string, key: string, nativeTurnId: string, nativeSessionId: string, target: "delivered" | "observed"): Promise<PeerDeliveryReceiptStatus> {
    if (!PeerDeliveryNativeSessionIdSchema.safeParse(nativeSessionId).success) {
      throw new BridgeError("PEER_DELIVERY_STALE", "Peer receipt lacks a bounded native session identity");
    }
    for (let attempt = 0; attempt < 128; attempt++) {
      const captured = await this.store.readControl(id);
      const selected = captured.peer_deliveries?.find((record) => record.envelope.idempotency_key === key);
      if (!selected) throw new BridgeError("PEER_DELIVERY_UNKNOWN", "Peer delivery receipt unknown");
      const binding = await this.#peerReceiptBinding(id, captured, selected.envelope);
      let changed: PeerDeliveryRecord | undefined;
      const outcome = await this.controls.change(id, (state) => {
      if (state.revision !== captured.revision) return "retry";
      const delivery = state.peer_deliveries?.find((record) => record.envelope.idempotency_key === key);
      if (!delivery) return "unknown";
      if (binding !== "current") {
        if (delivery.state === "dispatch_intent" || delivery.state === "delivered") {
          delivery.state = "unknown"; delivery.disposition_at = now(); changed = structuredClone(delivery);
        }
        return binding;
      }
      if (delivery.state === target && delivery.native_turn_id === nativeTurnId && delivery.native_session_id === nativeSessionId &&
        state.native.turn_id === nativeTurnId && state.native.native_session_id === nativeSessionId) return "accepted";
      if (delivery.state !== (target === "delivered" ? "dispatch_intent" : "delivered")) return "stale";
      if (!nativeTurnId || Buffer.byteLength(nativeTurnId, "utf8") > 256 || nativeTurnId.includes("\0") ||
        state.native.turn_id !== nativeTurnId || state.native.native_session_id !== nativeSessionId ||
        target === "delivered" && state.native.coverage === "turn_scoped" ||
        target === "observed" && (state.native.coverage !== "turn_scoped" || delivery.native_turn_id !== nativeTurnId ||
          delivery.native_session_id !== nativeSessionId || state.native.obligations.length)) return "stale";
      delivery.state = target; delivery.native_turn_id = nativeTurnId;
      delivery.native_session_id = nativeSessionId;
      if (target === "delivered") delivery.delivered_at = now(); else delivery.observed_at = now();
      changed = structuredClone(delivery); return "accepted";
    });
    if (changed) await this.#peerEvent(id, changed);
    if (outcome === "retry") continue;
    if (outcome !== "accepted") throw new BridgeError(`PEER_DELIVERY_${outcome.toUpperCase()}`, `Peer delivery receipt ${outcome}`);
    if (target === "observed" && changed) {
      const callback = this.onPeerDeliveryObserved;
      if (callback) void Promise.resolve().then(() => callback(changed!.envelope.case_id)).catch(() => undefined);
    }
    // A later case/source change cannot erase this exact native receipt, but the
    // adapter must discard obsolete content and obtain a fresh context.
    try { return await this.#peerValidity(id, await this.store.readControl(id), selected.envelope) === "current" ? "current" : "superseded"; }
    catch { return "superseded"; }
    }
    throw new BridgeError("PEER_DELIVERY_STALE", "Recipient control changed during peer receipt");
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
      if (this.#reservations.has(identity.assignment.request_key)) throw new BridgeError("REQUEST_KEY_CONFLICT", "Request key has a pending coordinated admission");
      const prior = await this.store.find({ request_key: identity.assignment.request_key });
      if (prior) {
        if (!("schema_version" in prior) || prior.schema_version !== 4 && prior.schema_version !== 5) throw new BridgeError("LEGACY_REQUEST_KEY", "Use historical result access; this key cannot start a new execution");
        owns(await this.store.readControl(prior.task_id), actor);
        if (prior.canonical_hash !== hash) throw new BridgeError("REQUEST_KEY_CONFLICT", "Request key names different material intent or source view");
        taskId = prior.task_id; return;
      }
      await this.assertMutationAllowed();
      let unfinished = this.#reservations.size;
      for (const record of await this.store.list()) if ((await this.store.readState(record.task_id)).phase !== "terminal" &&
        this.#reservations.get(record.request.request_key)?.token.task_id !== record.task_id) unfinished++;
      if (unfinished >= this.policy.max_workers + this.policy.max_queued_tasks) throw new BridgeError("CAPACITY_EXCEEDED", "Repository worker and queue capacity is full");
      const selected = this.registry.select(identity.assignment, this.policy);
      signal.throwIfAborted();
      const id = randomUUID();
      const record: CurrentDurableRequest = { schema_version: 4, task_id: id, project_id: this.projectId, canonical_hash: hash,
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
  /** Capacity and identity are captured before metadata ordering; no lock crosses that external decision. */
  async reserveCoordinated(identity: CoordinatedSubmissionIdentity, actor: ClientActor, signal: AbortSignal): Promise<CoordinatedReservation> {
    return this.#reserveCoordinated(identity, actor, signal);
  }
  /** Reuse metadata's exact published task identity after an interrupted bind/admission frontier. */
  async recoverCoordinatedReservation(identity: CoordinatedSubmissionIdentity, actor: ClientActor, taskId: string, signal: AbortSignal): Promise<CoordinatedReservation> {
    TaskIdSchema.parse(taskId);
    return this.#reserveCoordinated(identity, actor, signal, taskId);
  }
  async #reserveCoordinated(identity: CoordinatedSubmissionIdentity, actor: ClientActor, signal: AbortSignal, recoveredId?: string): Promise<CoordinatedReservation> {
    signal.throwIfAborted();
    identity = CoordinatedSubmissionIdentitySchema.parse(identity);
    const intent_hash = canonicalHash(coordinatedMaterialIdentity(identity)), payload_digest = canonicalHash(identity.assignment);
    return this.#admission.run(async () => {
      signal.throwIfAborted();
      const key = identity.assignment.request_key;
      const prior = await this.store.find({ request_key: key });
      if (prior) {
        if (!("schema_version" in prior) || prior.schema_version !== 5) throw new BridgeError("REQUEST_KEY_CONFLICT", "Request key belongs to a different submission contract");
        owns(await this.store.readControl(prior.task_id), actor);
        if (prior.canonical_hash !== intent_hash || prior.initial_owner !== actor.owner_id) throw new BridgeError("REQUEST_KEY_CONFLICT", "Request key names another coordinated intent");
        if (recoveredId && prior.task_id !== recoveredId) throw new BridgeError("COORDINATION_LINK_CONFLICT", "Metadata binding names another admitted task");
        return { task_id: prior.task_id, request_key: key, owner_id: actor.owner_id, intent_hash, payload_digest,
          source_view: identity.source_view, ...(identity.announcement ? { announcement: identity.announcement } : {}), status: "admitted" };
      }
      const existing = this.#reservations.get(key);
      if (existing) {
        if (existing.token.intent_hash !== intent_hash || existing.token.owner_id !== actor.owner_id) throw new BridgeError("REQUEST_KEY_CONFLICT", "Request key has another pending coordinated intent");
        if (recoveredId && existing.token.task_id !== recoveredId) throw new BridgeError("COORDINATION_LINK_CONFLICT", "Metadata binding names another reserved task");
        return existing.token;
      }
      await this.assertMutationAllowed();
      let unfinished = this.#reservations.size;
      for (const record of await this.store.list()) if ((await this.store.readState(record.task_id)).phase !== "terminal" &&
        this.#reservations.get(record.request.request_key)?.token.task_id !== record.task_id) unfinished++;
      if (unfinished >= this.policy.max_workers + this.policy.max_queued_tasks) throw new BridgeError("CAPACITY_EXCEEDED", "Repository worker and queue capacity is full");
      const selected = this.registry.select(identity.assignment, this.policy);
      signal.throwIfAborted();
      const token: CoordinatedReservation = Object.freeze({ task_id: recoveredId ?? randomUUID(), request_key: key,
        owner_id: actor.owner_id, intent_hash, payload_digest, source_view: identity.source_view,
        ...(identity.announcement ? { announcement: structuredClone(identity.announcement) } : {}), status: "reserved" });
      this.#reservations.set(key, { token, identity, selected });
      return token;
    });
  }
  /** The metadata owner has already published its exact binding before this durable admission. */
  async commitReserved(reservation: CoordinatedReservation, decision: { decision_identity: string; link_hash: string }): Promise<TaskObservation> {
    if (!/^[a-f0-9]{64}$/.test(decision.decision_identity) || !/^[a-f0-9]{64}$/.test(decision.link_hash)) throw new BridgeError("COORDINATION_LINK_INVALID", "Expected exact metadata decision hashes");
    return this.#admission.run(async () => {
      const competing = await this.store.find({ request_key: reservation.request_key });
      if (competing && competing.task_id !== reservation.task_id) throw new BridgeError("REQUEST_KEY_CONFLICT", "Request key was admitted under another task identity");
      const prior = await this.store.find({ task_id: reservation.task_id });
      if (prior) {
        if (!("schema_version" in prior) || prior.schema_version !== 5 || prior.canonical_hash !== reservation.intent_hash ||
          prior.linkage.decision_identity !== decision.decision_identity || prior.linkage.link_hash !== decision.link_hash ||
          prior.initial_owner !== reservation.owner_id || prior.request.request_key !== reservation.request_key) {
          throw new BridgeError("COORDINATION_LINK_CONFLICT", "Existing admission differs from metadata binding");
        }
        return this.controls.read(prior.task_id, { owner_id: reservation.owner_id, client_id: "coordinated-admission" });
      }
      await this.assertMutationAllowed();
      const pending = this.#reservations.get(reservation.request_key);
      if (!pending || pending.token !== reservation) throw new BridgeError("COORDINATION_RESERVATION_STALE", "Exact reserved task identity is no longer available");
      if (reservation.announcement) {
        const announced = await this.store.readAnnouncement(reservation.announcement.id);
        if (!announced || announced.payload.owner_id !== reservation.owner_id || announced.payload.source_view !== reservation.source_view ||
          canonicalHash(announced.payload.assignment) !== reservation.payload_digest ||
          announced.control.state === "withdrawn" || announced.control.state === "linked" && announced.control.task_id !== reservation.task_id) {
          throw new BridgeError("ANNOUNCEMENT_CHANGED", "Announcement reference no longer names this exact assignment");
        }
      }
      const link = { schema_version: 1 as const, task_id: reservation.task_id, request_key: reservation.request_key,
        owner_id: reservation.owner_id, intent_hash: reservation.intent_hash,
        decision_identity: decision.decision_identity, link_hash: decision.link_hash,
        ...(reservation.announcement ? { announcement: reservation.announcement } : {}) };
      const { link_hash, ...binding } = link;
      if (canonicalHash(binding) !== link_hash) throw new BridgeError("COORDINATION_LINK_CONFLICT", "Metadata link hash does not identify this exact binding");
      const record: CoordinatedDurableRequest = { schema_version: 5, task_id: reservation.task_id,
        project_id: this.projectId, canonical_hash: reservation.intent_hash, accepted_at: now(),
        source_view: reservation.source_view, initial_owner: reservation.owner_id,
        request: pending.identity.assignment, execution: pending.selected.snapshot, linkage: link };
      await this.store.create(record, initialControl(record.task_id, reservation.owner_id));
      // Accepted but deliberately absent from the execution queue until metadata settlement.
      return this.controls.read(record.task_id, { owner_id: reservation.owner_id, client_id: "coordinated-admission" });
    });
  }
  /** The caller supplies the already-settled metadata identity; only an exact match starts this task. */
  async activateLinked(reservation: CoordinatedReservation, decision: { decision_identity: string; link_hash: string }): Promise<TaskObservation> {
    return this.#admission.run(async () => {
      const record = await this.store.durableRequest(reservation.task_id);
      if (record.schema_version !== 5 || record.linkage.request_key !== reservation.request_key ||
        record.linkage.owner_id !== reservation.owner_id || record.linkage.intent_hash !== reservation.intent_hash ||
        record.linkage.decision_identity !== decision.decision_identity || record.linkage.link_hash !== decision.link_hash) {
        throw new BridgeError("COORDINATION_LINK_CONFLICT", "Metadata settlement does not match durable admission");
      }
      await this.#settleLinkedRecord(record);
      return this.controls.read(record.task_id, { owner_id: reservation.owner_id, client_id: "coordinated-admission" });
    }).then((observation) => { this.#kick(); return observation; });
  }
  /** Elected-service reconciliation after exact metadata settlement; returns no task-control projection. */
  async reconcileCoordinatedLink(taskId: string, requestKey: string, decisionIdentity: string, linkHash: string): Promise<void> {
    TaskIdSchema.parse(taskId);
    this.assertAuthority();
    await this.#admission.run(async () => {
      const record = await this.store.durableRequest(taskId);
      if (record.schema_version !== 5 || record.linkage.request_key !== requestKey ||
        record.linkage.decision_identity !== decisionIdentity || record.linkage.link_hash !== linkHash) {
        throw new BridgeError("COORDINATION_LINK_CONFLICT", "Reconciliation does not identify the immutable task and metadata binding");
      }
      await this.#settleLinkedRecord(record);
    });
    this.#kick();
  }
  async #settleLinkedRecord(record: CoordinatedDurableRequest): Promise<void> {
    if (await reconcileCoordinatedRecord(this.store, record, record.linkage, this.controls)) this.#notifyTaskSettled(record.task_id);
    const pending = this.#reservations.get(record.request.request_key);
    if (pending && pending.token.task_id === record.task_id && !this.#entries.has(record.task_id)) {
      const state = await this.store.readControl(record.task_id);
      if (state.phase === "queued" && state.native.state === "not_started") {
        let resolve!: () => void; const done = new Promise<void>((yes) => { resolve = yes; });
        const entry: Entry = { selected: pending.selected, record, controller: new AbortController(), stage: "queued", done, resolve };
        this.#entries.set(record.task_id, entry); this.#queue.push(entry);
      }
      this.#reservations.delete(record.request.request_key);
    }
  }
  async releaseUnadmitted(reservation: CoordinatedReservation): Promise<void> {
    await this.#admission.run(async () => {
      const pending = this.#reservations.get(reservation.request_key);
      if (!pending || pending.token !== reservation) return;
      if (await this.store.find({ task_id: reservation.task_id })) throw new BridgeError("COORDINATION_ALREADY_ADMITTED", "Accepted task cannot be released with its reservation");
      this.#reservations.delete(reservation.request_key);
    });
  }
  async cancel(id: string, actor: ClientActor, generation: number, operation: string, reason: string) {
    const receipt = await this.controls.cancel(id, actor, generation, operation, reason);
    await this.dispatchCommittedCancellation(id);
    return receipt;
  }
  /** Dispatch a retained stop without reauthorizing the caller or its old generation. */
  async dispatchCommittedCancellation(id: string): Promise<void> {
    const control = await this.store.readControl(id);
    if (!control.cancel) return;
    const entry = await this.#admission.run(() => this.#entries.get(id));
    if (entry) {
      // Abort listeners may re-enter coordinator admission.
      entry.controller.abort(new BridgeError("TASK_CANCELLED", control.cancel.reason));
    } else {
      const record = await this.store.durableRequest(id);
      if (record.schema_version === 5) await this.#settleNeverStartedCoordinatedCancellation(id);
      else await this.#cancelRecoveredQueue(id);
    }
    this.#kick();
  }
  async #settleNeverStartedCoordinatedCancellation(id: string): Promise<void> {
    const record = await this.store.durableRequest(id);
    if (record.schema_version !== 5) return;
    const state = await this.store.readControl(id);
    if (!state.cancel || state.phase === "terminal" || state.native.state !== "not_started") return;
    if (!await this.store.readCoordinatedLink(id)) {
      await this.controls.change(id, (s) => {
        if (s.cancel && s.native.state === "not_started" && s.phase !== "terminal") {
          s.phase = "needs_attention";
          s.attention = "Cancellation is retained while exact coordinated link settlement remains pending";
        }
      });
      return;
    }
    if (await settleNeverStartedCoordinatedCancellation(this.store, record, this.controls)) this.#notifyTaskSettled(id);
  }
  #notifyTaskSettled(id: string): void {
    try { this.onTaskSettled?.(id); }
    catch (error) {
      // Notification failure cannot rewrite a retained terminal task or its native outcome.
      void this.store.appendEvent(id, { kind: "terminal_notification_failed", error: errorInfo(error) }).catch(() => undefined);
    }
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
    let terminal = false;
    try { await this.#execute(entry); terminal = (await this.store.readControl(entry.record.task_id)).phase === "terminal"; }
    catch (error) { await this.#freeze(`Task ${entry.record.task_id} cannot preserve authoritative evidence: ${errorInfo(error).message}`); }
    finally {
      await this.#admission.run(() => { this.#entries.delete(entry.record.task_id); if (slot) this.#active--; });
      entry.resolve(); this.#kick();
      if (terminal) this.#notifyTaskSettled(entry.record.task_id);
      this.onSettled?.();
    }
  }
  async #event(id: string, event: WorkerEvent): Promise<void> {
    if (event.kind === "input_withdrawn") { await this.inputs.withdraw(id, event.native_id); return; }
    if (["turn_started", "turn_correlated", "turn_settled", "operation_started", "operation_finished", "process_observed", "runtime_unknown"].includes(event.kind)) {
      await this.controls.change(id, (state) => {
        if (state.phase === "terminal") throw new BridgeError("STALE_NATIVE_EVENT", "Native event arrived after terminal publication");
        state.native.last_observed_at = now();
        if (event.kind === "turn_started") {
          if (!event.turn_id || Buffer.byteLength(event.turn_id, "utf8") > 256 || event.turn_id.includes("\0") ||
            event.native_session_id !== undefined && (!event.native_session_id || Buffer.byteLength(event.native_session_id, "utf8") > 256 || event.native_session_id.includes("\0")) ||
            state.native.native_session_id !== undefined && state.native.native_session_id !== event.native_session_id) {
            throw new BridgeError("NATIVE_CORRELATION_INVALID", "Native turn or session identity is invalid");
          }
          if (state.native.obligations.length || state.inputs.some((i) => i.state === "pending")) throw new BridgeError("NATIVE_OBLIGATIONS_PENDING", "Prior native work has not settled");
          state.native.turn_id = event.turn_id; state.native.state = "observed_live"; state.native.coverage = "unknown";
          if (event.native_session_id !== undefined) state.native.native_session_id = event.native_session_id;
          if (!state.cancel) state.phase = "active";
        } else if (event.kind === "turn_correlated") {
          correlateNativeTurn(state, event);
        } else if (event.kind === "turn_settled") {
          if (state.native.turn_id !== event.turn_id || state.native.native_session_id !== event.native_session_id) throw new BridgeError("NATIVE_CORRELATION_INVALID", "Terminal event belongs to another native session or turn");
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
    if (event.kind === "turn_settled") await this.inputs.settleTurn(id, event.turn_id);
    if (await this.store.appendEvent(id, event) === false) await this.controls.change(id, (s) => { s.telemetry_omitted = true; });
  }
  async #execute(entry: Entry): Promise<void> {
    const { record, controller } = entry, id = record.task_id, request = record.request;
    let workspace: Workspace | undefined;
    let privateView: PrivateGitView | undefined;
    let result = baseResult(id, request, record.execution), workerSettled = false;
    const phase = async (next: "starting" | "active" | "finalizing") => this.controls.change(id, (s) => { if (!s.cancel) s.phase = next; });
    try {
      controller.signal.throwIfAborted(); this.assertAuthority(); await phase("starting");
      if ((await this.store.readControl(id)).cancel) throw new BridgeError("TASK_CANCELLED", "Task was cancelled before preparation");
      if (this.privateGitMode === "controlled" && (request.mode !== "implement" ||
          entry.selected.worker.private_git?.schema_version !== 1 ||
          entry.selected.worker.private_git.mount_kind !== "canonical_common_dir")) {
        throw new BridgeError("PRIVATE_GIT_ADAPTER_UNSUPPORTED", "Selected worker cannot mount the exact private Git common directory");
      }
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
      entry.workspace = workspace.path;
      if (this.privateGitMode === "controlled") {
        if (workspace.kind !== "task_worktree" || !resource?.worktree_path || !resource.branch_ref || !resource.base_commit)
          throw new BridgeError("PRIVATE_GIT_UNAVAILABLE", "Private Git requires the owned task worktree");
        const control = await this.store.readControl(id);
        const privateCommonDir = join(this.store.taskDir(id), "private-git");
        const quarantinePath = join(this.store.taskDir(id), "private-quarantine");
        const reserved = { ...resource, schema_version: 2 as const, state: "pending" as const, updated_at: now(),
          private_git: { schema_version: 1 as const, state: "reserved" as const, private_common_dir: privateCommonDir,
            quarantine_path: quarantinePath, run_id: control.native.run_id, control_generation: control.control_generation } };
        // This ordinary task resource is durable before either private directory is created.
        await this.store.writeResource(id, reserved);
        privateView = await preparePrivateGitView(record.source_view, workspace, privateCommonDir, this.assertAuthority);
        await this.store.writeResource(id, { ...reserved, updated_at: now(), private_git: {
          ...reserved.private_git, state: "prepared", view: privateView } });
      }
      if (record.schema_version === 5 && workspace.kind === "task_worktree") {
        if (!this.onCoordinatedWorkspacePrepared) throw new BridgeError("COORDINATION_ATTACHMENT_UNAVAILABLE", "Coordinated task has no prepared-workspace attachment owner");
        await this.onCoordinatedWorkspacePrepared(record, workspace);
      }
      const before = await digestFiles(workspace.path, request.context_files ?? []);
      const beforeStatus = await sourceStatus(workspace.path, false, controller.signal), revision = await currentRevision(workspace.path, controller.signal);
      if (request.mode === "review" && revision) result.workspace.base_commit = revision;
      controller.signal.throwIfAborted(); this.assertAuthority();
      if ((await this.store.readControl(id)).cancel) throw new BridgeError("TASK_CANCELLED", "Task was cancelled before native startup");
      // Persist the run intent before startup. A crash after this point cannot claim never-started safety.
      await this.controls.change(id, (s) => {
        if (s.cancel) throw new BridgeError("TASK_CANCELLED", "Task was cancelled before native startup");
        s.native.state = "unknown"; s.phase = "active";
      });
      result.worker_stop = "unconfirmed";
      const run = await entry.selected.worker.run({ request, task_id: id, workspace: workspace.path, policy: this.policy,
        prompt: assignmentPrompt(request, id, workspace), signal: controller.signal,
        ...(privateView ? { private_git: { schema_version: 1 as const, mount_kind: "canonical_common_dir" as const, view: privateView } } : {}),
        onEvent: (event) => this.#event(id, event),
        approve: async (approval, signal) => ({ choice_id: await this.inputs.request(id, { kind: "permission", approval: { ...approval, task_id: id, workspace: workspace!.path } }, approval.id, signal) }),
        input: (question, attention = false, nativeId, choices, inputSignal) => this.inputs.request(id, { kind: "clarification", question, attention, ...(choices ? { choices: [...choices] } : {}) }, nativeId ?? `clarification:${randomUUID()}`, inputSignal ? AbortSignal.any([controller.signal, inputSignal]) : controller.signal),
        peer: this.#peerPort(id),
      });
      workerSettled = true;
      result = { ...result, execution_status: run.status, worker_stop: run.worker_stop, worker_assessment: run.worker_assessment,
        summary: run.summary, blockers: run.blockers, questions: run.questions, checks: run.checks,
        model: { ...(record.execution.requested_model ? { requested: record.execution.requested_model } : {}), ...(run.reported_model ? { reported: run.reported_model } : {}) }, ...(run.error ? { error: run.error } : {}) };
      const state = await this.store.readControl(id);
      const uncertainPeerOperations = this.store instanceof TaskStore
        ? (await this.store.listPeerOperations(id)).filter(operation => operation.disposition !== "settled") : [];
      if (state.cancel) result.execution_status = "cancelled";
      if (uncertainPeerOperations.length && result.execution_status === "completed") {
        result.execution_status = "interrupted";
        result.error = { code: "PEER_OPERATION_RECOVERY_REQUIRED", message: "A retained worker peer operation has no proven result" };
      }
      if (run.status === "completed" && !state.cancel && (state.native.coverage !== "turn_scoped" || state.native.obligations.length || state.inputs.some((i) => i.state === "pending" || i.state === "answer_intent" || i.state === "delivery_unknown"))) {
        result.execution_status = "failed"; result.error = { code: "COMPLETION_EVIDENCE_MISSING", message: "Native completion did not account for required obligations" };
      }
      if (run.worker_stop === "unconfirmed") {
        if (result.execution_status === "completed") result.execution_status = "interrupted";
        await this.#freeze(`Task ${id} has unconfirmed native shutdown`);
      } else {
        if (privateView) {
          if (run.worker_stop !== "confirmed" || state.native.coverage !== "turn_scoped" || state.native.obligations.length ||
              state.inputs.some((i) => i.state === "pending" || i.state === "answer_intent" || i.state === "delivery_unknown") ||
              state.native.run_id !== (await this.store.readResource(id))?.private_git?.run_id ||
              state.control_generation !== (await this.store.readResource(id))?.private_git?.control_generation) {
            throw new BridgeError("PRIVATE_GIT_STOP_UNCONFIRMED", "Exact private worker run has no complete confirmed descendant-stop evidence");
          }
          await this.controls.change(id, (s) => {
            if (s.native.run_id !== state.native.run_id || s.control_generation !== state.control_generation || s.cancel ||
                s.native.coverage !== "turn_scoped" || s.native.obligations.length)
              throw new BridgeError("PRIVATE_GIT_STOP_UNCONFIRMED", "Private worker evidence changed before stop settlement");
            s.native.state = "stopped";
          });
          await this.administration.run(() => this.controls.withTaskPublication([id], async () => {
            const current = await this.store.readControl(id), owned = await this.store.readResource(id);
            if (current.cancel || current.native.run_id !== state.native.run_id ||
                current.control_generation !== state.control_generation || current.native.state !== "stopped" ||
                current.native.coverage !== "turn_scoped" || current.native.obligations.length ||
                current.inputs.some(input => input.state === "pending" || input.state === "answer_intent" || input.state === "delivery_unknown") ||
                !owned || owned.schema_version !== 2 || owned.private_git.state !== "prepared" ||
                owned.private_git.run_id !== current.native.run_id ||
                owned.private_git.control_generation !== current.control_generation ||
                owned.worktree_path !== workspace!.path || owned.branch_ref !== workspace!.branch ||
                owned.base_commit !== workspace!.base_commit) {
              throw new BridgeError("PRIVATE_PUBLICATION_IDENTITY", "Private task or resource changed before publication reservation");
            }
            const publication = await preparePrivatePublication(record.source_view, workspace!, privateView!,
              owned.private_git.quarantine_path, run.worker_stop, this.assertAuthority);
            const intent = await this.store.beginPrivatePublication({ schema_version: 1, operation_key: "private-publication",
              task_id: id, request_key: request.request_key, run_id: owned.private_git.run_id,
              control_generation: owned.private_git.control_generation, source_view: record.source_view,
              workspace: { path: workspace!.path, branch: workspace!.branch!, base_commit: workspace!.base_commit! },
              view: privateView!, publication });
            await this.store.writeResource(id, { ...owned, updated_at: now(), private_git: {
              ...owned.private_git, state: "publication_intent" } });
            await replayPrivatePublication(this.store, record.source_view, {
              task_id: id, operation_key: intent.request.operation_key, run_id: intent.request.run_id,
              control_generation: intent.request.control_generation }, run.worker_stop, this.assertAuthority);
            const after = await this.store.readResource(id);
            if (!after || after.schema_version !== 2) throw new BridgeError("PRIVATE_RESOURCE_CONFLICT", "Private publication resource disappeared");
            await this.store.writeResource(id, { ...after, updated_at: now(), private_git: {
              ...after.private_git, state: "published" } });
          }));
        }
        await phase("finalizing");
        // Accounted-for native stop permits collection independent of execution cancellation.
        const collection = { ...workspace };
        delete collection.signal;
        this.assertAuthority();
        result.delivery = await observeDelivery(collection, run.no_changes_reason);
        if (privateView) {
          const retained = await this.store.readPrivatePublication(id);
          if (retained?.state !== "published" ||
              result.delivery.head_commit !== retained.request.publication.new_head ||
              result.delivery.tree_oid !== retained.request.publication.tree_oid ||
              result.delivery.base_commit !== retained.request.workspace.base_commit ||
              result.delivery.branch_ref !== retained.request.workspace.branch ||
              result.delivery.worktree_path !== retained.request.workspace.path ||
              !["committed", "no_changes_needed"].includes(result.delivery.status)) {
            throw new BridgeError("PRIVATE_PUBLICATION_RESULT_CONFLICT", "Observed delivery differs from the exact private publication");
          }
        }
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
      if (privateView) result.delivery = { status: "incomplete", reason: "Private Git publication or delivery failed" };
      if (workerSettled) result.blockers.push("Delivery collection failed; preserve the worktree and evidence");
    }
    if (!await this.store.readResource(id)) await this.store.writeResource(id, { schema_version: 1, task_id: id, project_id: this.projectId, state: "not_applicable", updated_at: now() });
    const privateResource = await this.store.readResource(id);
    const privateUnresolved = privateResource?.schema_version === 2 &&
      (privateResource.private_git.state !== "published" || (await this.store.readPrivatePublication(id))?.state !== "published");
    if (privateUnresolved && result.execution_status === "completed") result.execution_status = "interrupted";
    if (privateUnresolved) {
      result.delivery = { status: "incomplete", reason: "Private Git preparation or publication requires exact offline disposition" };
      result.blockers.push("Private Git resource and publication evidence are retained for exact reconciliation");
    }
    if (result.worker_stop === "unconfirmed" && result.execution_status === "completed") result.execution_status = "interrupted";
    // Serialize cancellation versus successful settlement at the same state owner. No provider callback runs here.
    await this.controls.change(id, (s) => {
      if (s.cancel) result.execution_status = "cancelled";
      for (const delivery of s.peer_deliveries ?? []) {
        if (delivery.state === "queued") { delivery.state = s.cancel ? "cancelled" : "stale"; delivery.disposition_at = now(); }
        else if (delivery.state === "dispatch_intent" || delivery.state === "delivered") {
          delivery.state = "unknown"; delivery.disposition_at = now();
          if (result.execution_status === "completed") {
            result.execution_status = "interrupted";
            result.error = { code: "PEER_DELIVERY_UNKNOWN", message: "Peer dispatch or worker observation lacks a settled receipt" };
          }
        }
      }
      s.phase = "finalizing"; s.settled_outcome = result.execution_status;
    });
    let state = await this.store.readControl(id);
    result.native_evidence = structuredClone(state.native);
    result.native_evidence.state = privateResource?.schema_version === 2
      ? state.native.state === "stopped" && result.worker_stop === "confirmed" ? "stopped"
        : state.native.state === "not_started" && result.worker_stop === "not_started" ? "not_started" : "unknown"
      : result.worker_stop === "confirmed" ? "stopped" : result.worker_stop === "not_started" ? "not_started" : "unknown";
    await this.store.writeResult(id, result);
    await this.controls.change(id, (s) => {
      s.native = result.native_evidence;
      for (const input of s.inputs) {
        delete input.claim;
        if (input.state === "pending") input.state = "withdrawn";
        if (input.state === "answer_intent") input.state = "delivery_unknown";
      }
      if (privateUnresolved || result.worker_stop === "unconfirmed" || s.inputs.some((i) => i.state === "delivery_unknown")) { s.phase = "needs_attention"; s.attention = privateUnresolved
        ? "Private Git preparation or publication remains unresolved; retain all task resources"
        : "Native shutdown or input delivery remains unconfirmed; explicit reconciliation is required"; }
      else { s.phase = "terminal"; s.outcome = result.execution_status; }
    });
    if (privateUnresolved || result.worker_stop === "unconfirmed" || (await this.store.readControl(id)).inputs.some((i) => i.state === "delivery_unknown"))
      await this.#freeze(privateUnresolved ? `Task ${id} has unresolved private Git publication` : `Task ${id} has unconfirmed shutdown or input delivery`);
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
