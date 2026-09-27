import { randomUUID } from "node:crypto";
import { canonicalHash, Mutex } from "../core/async.js";
import { BridgeError } from "../core/errors.js";
import { MANAGED_CONTROL_SCHEMA, SUBMISSION_CONTROL_SCHEMA, SOURCE_GRANT_CONTROL_SCHEMA, SOURCE_WATCH_CONTROL_SCHEMA, OBSERVED_CASE_CONTROL_SCHEMA, CONTROL_MAX_BYTES, CONTROL_RELEASE_BYTES, releaseSlotsRequired, decodeCommand, entityId, parentId, type Case, type Command, type ControlState, type Note,
  coordinationOperationKey, controlReceiptCount, recoveryReceipts, decodeRecoveryCommand, MAX_PARTIES, MAX_REGIONS, type RecoveryCommand, type RecoveryReceipt, type ParentId, type Receipt, type Region, type Subject, type Work, type ObservedDeliveryMetadataGuard } from "../contracts/coordination-control.js";
import { announcements, submissionBindings, submissionEvents, decodeAnnouncementInput, decodeAnnouncementWithdrawalInput,
  decodeSubmissionPreflightInput, decodeSubmissionBindInput, decodeSubmissionDispositionInput, decodeSubmissionTerminalInput,
  type AnnouncementRecord, type SubmissionBinding, type SubmissionEvent, type SubmissionPreflightInput } from "../contracts/coordination-control.js";
import type { CoordinationStore } from "../store/coordination-store.js";
import { decodePeerResolutionText, PEER_RESOLUTION_ACTIONS, type PeerResolutionRecord, type PeerResolutionSource, type PeerResolutionProposal, type PeerResolutionApplication, type PeerResolutionVerification } from "./peer-resolution.js";
import { encodePeerResolutionRecord } from "./peer-resolution.js";
import { decodePeerWorkerOperation, decodePeerWorkerOperationResult, type PeerWorkerOperation, type PeerWorkerOperationResult,
  type PeerSelectedWorkContext, type PeerApplicationOutcome } from "../contracts/peer-operations.js";

/** The caller is the authenticated service actor, never an actor field taken from a command. */
export type CoordinationActor = Readonly<{ owner_id: string }>;
/** Supplied by a task-bound coordinator, never reconstructed from worker input. */
export type WorkerPeerActor = CoordinationActor & Readonly<{
  task_id: string; run_id: string; control_generation: number; workspace_id: string; source_view: string; case_id: string;
}>;
export type WorkerPeerAuthority = Readonly<{
  assertCurrent(actor: WorkerPeerActor, state: ControlState, item: Case, historicalOutcome?: boolean): Promise<void>;
  assertConsentCurrent(state: ControlState, item: Case, note: Note): Promise<void>;
  /** Runtime capture identity is stable for equivalent selected source bytes, independent of report transport IDs. */
  captureEvidenceId?(actor: WorkerPeerActor, state: ControlState, item: Case): Promise<string>;
  /** Runtime checks every historical source, including sources no longer selected by the case. */
  assertRetainedSources?(actor: WorkerPeerActor, state: ControlState, sources: readonly PeerResolutionSource[]): Promise<void>;
  /** Reserve selected task publication only for the final metadata commit or disclosure. */
  withPublication?<T>(state: ControlState, item: Case, actor: WorkerPeerActor | undefined,
    retainedSources: readonly PeerResolutionSource[], publish: () => Promise<T>, consent?: Note,
    historicalOutcome?: boolean): Promise<T>;
}>;
export type SourceVersions = ReadonlyArray<Readonly<{ task_id: string; version: number }>>;
export type RetirementReservation = Readonly<{ release(): Promise<void> }>;
const WORKER_PEER_KEY_PREFIX = "worker-peer-v1:";
const MAX_PEER_WAITERS = 128;
type PeerWaiter = { fingerprint: string; actor: WorkerPeerActor; operation: Extract<PeerWorkerOperation, { kind: "await_change" }>;
  captureEvidenceId: string | null | undefined; evidenceStatus: "current" | "historical" | "unavailable";
  captureVersion: number; checkedVersion: number;
  resolve(value: PeerWorkerOperationResult): void; reject(reason: unknown): void; cleanup(): void };
/** Owns metadata transitions and their ordering against Passeur-owned retirement, not Git effects. */
export class CoordinationControl {
  readonly #ordering = new Mutex();
  #closing = false;
  readonly #resourceVersions = new Map<string, number>();
  readonly #retirements = new Map<string, Promise<void>>();
  readonly #peerWaiters = new Set<PeerWaiter>();
  readonly #observationGenerations = new Map<string, number>();
  readonly #peerRefreshes = new Set<Promise<void>>();
  readonly #transitionTasks = new Set<string>();
  readonly #transitionCases = new Set<string>();
  readonly #applicationCases = new Set<string>();
  #transitionEpoch = 0;
  #close: Promise<void> | undefined;
  constructor(private readonly store: CoordinationStore, private readonly workerAuthority?: WorkerPeerAuthority,
    private readonly serviceTransitions?: ReadonlySet<string>) {}

  get repositoryId(): string { return this.store.repositoryId; }

  async announce(actor: CoordinationActor, raw: unknown): Promise<AnnouncementRecord> {
    const owner = parentId(actor.owner_id), input = decodeAnnouncementInput(raw), hash = canonicalHash({ owner, kind: "announce", input });
    if (input.readers.includes(owner)) throw new BridgeError("COORDINATION_INVALID", "Announcement owner cannot be its own reader");
    return this.#ordering.run(async () => {
      this.store.assertMutable(); const current = await this.store.snapshot();
      const prior = sameSubmissionKey(current, owner, input.operation_key, hash);
      if (prior) {
        const item = announcements(current).find(a => a.id === prior.item_id);
        if (!item || prior.kind !== "announce") throw new BridgeError("COORDINATION_KEY_CONFLICT", "Key names another submission operation");
        return structuredClone(item);
      }
      if (announcements(current).some(a => a.id === input.id) || submissionBindings(current).some(b => b.task_id === input.id)) {
        throw new BridgeError("COORDINATION_ANNOUNCEMENT_EXISTS", "Announcement identity is already retained");
      }
      const next = submissionState(current);
      const item: AnnouncementRecord = { id: input.id, owner, revision: 1, state: "unresolved", payload_ref: input.id,
        payload_digest: input.payload_digest, source_view: input.source_view, assignment_hash: input.assignment_hash,
        areas: input.areas, readers: input.readers };
      next.announcements.push(item); appendSubmissionEvent(next, "announce", owner, input.operation_key, input.id, hash);
      checkCapacity(next); await this.#publish(current, next); return structuredClone(item);
    });
  }

  async announcement(actor: CoordinationActor, id: string): Promise<AnnouncementRecord> {
    const owner = parentId(actor.owner_id), announcementId = entityId(id);
    return this.#ordering.run(async () => {
      const item = announcements(await this.store.snapshot()).find(a => a.id === announcementId);
      if (!item || item.owner !== owner && !item.readers.includes(owner)) return unavailable();
      return structuredClone(item);
    });
  }

  async withdrawAnnouncement(actor: CoordinationActor, raw: unknown): Promise<AnnouncementRecord> {
    const owner = parentId(actor.owner_id), input = decodeAnnouncementWithdrawalInput(raw), hash = canonicalHash({ owner, kind: "withdraw", input });
    return this.#ordering.run(async () => {
      this.store.assertMutable(); const current = await this.store.snapshot();
      const prior = sameSubmissionKey(current, owner, input.operation_key, hash);
      if (prior) {
        const item = announcements(current).find(a => a.id === prior.item_id);
        if (!item || prior.kind !== "withdraw") throw new BridgeError("COORDINATION_KEY_CONFLICT", "Key names another submission operation");
        return structuredClone(item);
      }
      const next = submissionState(current), item = next.announcements.find(a => a.id === input.id);
      if (!item || item.owner !== owner) return unavailable();
      if (item.revision !== input.expected_revision) throw new BridgeError("COORDINATION_STALE_REVISION", "Announcement revision changed");
      if (item.state !== "unresolved") throw new BridgeError("COORDINATION_ANNOUNCEMENT_HELD", "Only an unresolved announcement may be withdrawn");
      item.state = "withdrawn"; item.revision++;
      appendSubmissionEvent(next, "withdraw", owner, input.operation_key, item.id, hash);
      checkCapacity(next); await this.#publish(current, next); return structuredClone(item);
    });
  }

  /** Advisory evidence; a gated caller must pass this identity to bindSubmission. */
  async preflight(actor: CoordinationActor, raw: unknown): Promise<{ decision_identity: string; overlaps: Array<{ kind: "work" | "announcement" | "binding"; id: string; areas: Region[] }> }> {
    const owner = parentId(actor.owner_id), input = decodeSubmissionPreflightInput(raw);
    return this.#ordering.run(async () => {
      const state = await this.store.snapshot();
      return structuredClone(submissionDecision(state, owner, input));
    });
  }

  async bindSubmission(actor: CoordinationActor, raw: unknown): Promise<SubmissionBinding> {
    const owner = parentId(actor.owner_id), input = decodeSubmissionBindInput(raw), hash = canonicalHash({ owner, kind: "bind", input });
    return this.#ordering.run(async () => {
      this.store.assertMutable(); const current = await this.store.snapshot();
      const prior = sameSubmissionKey(current, owner, input.operation_key, hash);
      if (prior) {
        const item = submissionBindings(current).find(b => b.task_id === prior.item_id);
        if (!item || prior.kind !== "bind") throw new BridgeError("COORDINATION_KEY_CONFLICT", "Key names another submission operation");
        return structuredClone(item);
      }
      if (submissionBindings(current).some(b => b.task_id === input.task_id || b.owner === owner && b.request_key === input.request_key && b.state !== "released")) {
        throw new BridgeError("COORDINATION_BINDING_CONFLICT", "Task or request key is already bound");
      }
      const decision = submissionDecision(current, owner, input);
      if (input.expected_decision_identity && input.expected_decision_identity !== decision.decision_identity) {
        throw new BridgeError("COORDINATION_CHANGED", "Relevant authorized overlap changed before task admission");
      }
      const next = submissionState(current), announcement = input.announcement
        ? next.announcements.find(a => a.id === input.announcement!.id) : undefined;
      if (input.announcement) {
        if (!announcement || announcement.owner !== owner) return unavailable();
        if (announcement.revision !== input.announcement.revision || announcement.state !== "unresolved") {
          throw new BridgeError("COORDINATION_CHANGED", "Announcement authority changed before binding");
        }
        if (announcement.payload_digest !== input.payload_digest || announcement.source_view !== input.source_view
          || announcement.assignment_hash !== input.assignment_hash || canonicalHash(announcement.areas) !== canonicalHash(input.areas)) {
          throw new BridgeError("COORDINATION_BINDING_CONFLICT", "Announced immutable assignment differs from submitted intent");
        }
      }
      const link = { schema_version: 1, task_id: input.task_id, request_key: input.request_key,
        owner_id: owner, intent_hash: input.intent_hash, decision_identity: decision.decision_identity,
        ...(input.announcement ? { announcement: input.announcement } : {}) };
      const item: SubmissionBinding = { task_id: input.task_id, request_key: input.request_key, owner,
        intent_hash: input.intent_hash, decision_identity: decision.decision_identity, link_hash: canonicalHash(link),
        source_view: input.source_view, input_oid: input.input_oid, areas: input.areas,
        ...(input.announcement ? { announcement: input.announcement } : {}), state: "bound" };
      next.bindings.push(item);
      if (announcement) { announcement.state = "bound"; announcement.task_id = input.task_id; announcement.revision++; }
      appendSubmissionEvent(next, "bind", owner, input.operation_key, item.task_id, hash);
      checkCapacity(next); await this.#publish(current, next); return structuredClone(item);
    });
  }

  async settleSubmission(actor: CoordinationActor, raw: unknown): Promise<SubmissionBinding> {
    return this.#disposeSubmission(actor, raw, "settle");
  }
  /** Only the admission owner calls release after proving no durable task admission. */
  async releaseUnadmittedBinding(actor: CoordinationActor, raw: unknown): Promise<SubmissionBinding> {
    return this.#disposeSubmission(actor, raw, "release");
  }
  /** The elected runtime supplies evidence read from its authoritative terminal TaskControl. */
  async terminalSubmissionBinding(actor: CoordinationActor, raw: unknown): Promise<SubmissionBinding> {
    const owner = parentId(actor.owner_id), input = decodeSubmissionTerminalInput(raw), hash = canonicalHash({ owner, kind: "terminal", input });
    return this.#ordering.run(async () => {
      this.store.assertMutable(); const current = await this.store.snapshot();
      const prior = sameSubmissionKey(current, owner, input.operation_key, hash);
      if (prior) {
        const item = submissionBindings(current).find(b => b.task_id === prior.item_id);
        if (!item || prior.kind !== "terminal") throw new BridgeError("COORDINATION_KEY_CONFLICT", "Key names another submission operation");
        return structuredClone(item);
      }
      const next = submissionState(current), item = next.bindings.find(b => b.task_id === input.task_id);
      if (!item || item.owner !== owner) return unavailable();
      if (item.request_key !== input.request_key || item.link_hash !== input.link_hash) {
        throw new BridgeError("COORDINATION_BINDING_CONFLICT", "Terminal evidence names a different task link");
      }
      if (item.state !== "settled") throw new BridgeError("COORDINATION_BINDING_SETTLED", "Only a settled binding may receive terminal evidence");
      item.state = "terminal"; item.terminal = input.terminal;
      appendSubmissionEvent(next, "terminal", owner, input.operation_key, item.task_id, hash);
      checkCapacity(next); await this.#publish(current, next); return structuredClone(item);
    });
  }
  async #disposeSubmission(actor: CoordinationActor, raw: unknown, kind: "settle" | "release"): Promise<SubmissionBinding> {
    const owner = parentId(actor.owner_id), input = decodeSubmissionDispositionInput(raw), hash = canonicalHash({ owner, kind, input });
    return this.#ordering.run(async () => {
      this.store.assertMutable(); const current = await this.store.snapshot();
      const prior = sameSubmissionKey(current, owner, input.operation_key, hash);
      if (prior) {
        const item = submissionBindings(current).find(b => b.task_id === prior.item_id);
        if (!item || prior.kind !== kind) throw new BridgeError("COORDINATION_KEY_CONFLICT", "Key names another submission operation");
        return structuredClone(item);
      }
      const next = submissionState(current), item = next.bindings.find(b => b.task_id === input.task_id);
      if (!item || item.owner !== owner) return unavailable();
      if (item.request_key !== input.request_key || item.link_hash !== input.link_hash) {
        throw new BridgeError("COORDINATION_BINDING_CONFLICT", "Task, request key and link hash must identify one exact binding");
      }
      if (item.state !== "bound") throw new BridgeError("COORDINATION_BINDING_SETTLED", "Binding already has another disposition");
      item.state = kind === "settle" ? "settled" : "released";
      const announcement = item.announcement ? next.announcements.find(a => a.id === item.announcement!.id) : undefined;
      if (item.announcement) {
        if (!announcement || announcement.owner !== owner || announcement.task_id !== item.task_id || announcement.state !== "bound") {
          throw new BridgeError("COORDINATION_BINDING_CONFLICT", "Announcement no longer identifies this exact bound task");
        }
        announcement.revision++;
        if (kind === "settle") announcement.state = "linked";
        else { announcement.state = "unresolved"; delete announcement.task_id; }
      }
      appendSubmissionEvent(next, kind, owner, input.operation_key, item.task_id, hash);
      checkCapacity(next); await this.#publish(current, next); return structuredClone(item);
    });
  }

  async submissionBinding(actor: CoordinationActor, taskId: string): Promise<SubmissionBinding> {
    const owner = parentId(actor.owner_id), id = entityId(taskId);
    return this.#ordering.run(async () => {
      const item = submissionBindings(await this.store.snapshot()).find(b => b.task_id === id);
      if (!item || item.owner !== owner) return unavailable();
      return structuredClone(item);
    });
  }
  async submissionBindingByRequestKey(actor: CoordinationActor, rawRequestKey: unknown): Promise<SubmissionBinding | undefined> {
    const owner = parentId(actor.owner_id), requestKey = coordinationOperationKey(rawRequestKey);
    return this.#ordering.run(async () => {
      const matches = submissionBindings(await this.store.snapshot()).filter(b => b.owner === owner && b.request_key === requestKey);
      const active = matches.find(b => b.state !== "released");
      return structuredClone(active ?? matches.at(-1));
    });
  }

  /** A receipt lookup never consults a workspace or restores old control authority. */
  async receipt(actor: CoordinationActor, key: unknown): Promise<Receipt | undefined> {
    const owner = parentId(actor.owner_id), operationKey = coordinationOperationKey(key);
    return this.#ordering.run(async () => structuredClone((await this.store.snapshot()).receipts.find(r => r.owner === owner && r.key === operationKey)));
  }

  /** Elected observation only. The caller has already proved task, Git and complete delivery scope. */
  async extendObservedCase(actor: CoordinationActor, input: Readonly<{
    operation_key: string; case_id: string; expected_revision: number; generation: number;
    new_work_id: string; target_oid: string;
  }>): Promise<Receipt> {
    const owner = parentId(actor.owner_id), command = {
      kind: "extend_observed_case" as const, operation_key: coordinationOperationKey(input.operation_key),
      case_id: entityId(input.case_id), expected_revision: input.expected_revision,
      generation: input.generation, new_work_id: entityId(input.new_work_id), target_oid: input.target_oid,
    };
    const hash = canonicalHash({ owner, command });
    return this.#ordering.run(async () => {
      this.store.assertMutable();
      const current = await this.store.snapshot();
      const prior = current.receipts.find(receipt => receipt.owner === owner && receipt.key === command.operation_key);
      if (prior) {
        if (prior.request_hash !== hash || prior.action !== command.kind) throw new BridgeError("COORDINATION_KEY_CONFLICT", "Observed extension key identifies different intent");
        return structuredClone(prior);
      }
      if (recoveryReceipts(current).some(receipt => receipt.operator === owner && receipt.command.operation_key === command.operation_key)
        || submissionEvents(current).some(event => event.owner === owner && event.key === command.operation_key))
        throw new BridgeError("COORDINATION_KEY_CONFLICT", "Observed extension key identifies another authority");
      const item = ownCase(current, owner, command.case_id, command.expected_revision, command.generation);
      if (item.observed_origin !== "selected" || item.external_effect !== "not_started")
        throw new BridgeError("COORDINATION_OBSERVED_ORIGIN_UNAVAILABLE", "Only an uneffected elected observed case can extend");
      if (this.#applicationCases.has(item.id) || this.#transitionCases.has(item.id))
        throw new BridgeError("PEER_OPERATION_STALE", "Selected case has an active task or effect transition");
      if (current.notes.some(note => note.subject.kind === "case" && note.subject.id === item.id &&
        retainedPeerRecord(note.text)?.kind === "peer_resolution_application"))
        throw new BridgeError("COORDINATION_EXTERNAL_EFFECT_UNRESOLVED", "Retained application admission prevents case extension");
      const selected = item.inputs.map(input => visibleWork(current, owner, input.work_id));
      const added = current.works.find(work => work.id === command.new_work_id);
      if (!added) return unavailable();
      if (selected.some(work => work.id === added.id)) throw new BridgeError("COORDINATION_OBSERVED_DUPLICATE", "Work is already selected");
      if (!added.managed || added.state !== "active" || !selected.length || selected.some(work => !work.managed || work.state !== "active" || work.input_oid !== added.input_oid || work.object_format !== added.object_format)
        || command.target_oid !== item.target_oid)
        throw new BridgeError("COORDINATION_OBSERVED_SCOPE_UNSUPPORTED", "Observed extension requires current compatible managed sources and target");
      const members = [...new Set([...item.members, added.owner])];
      if (members.length > MAX_PARTIES) throw new BridgeError("COORDINATION_CAPACITY", "Case participant capacity is full");
      const visibility_delta = [...selected, added].map(work => ({ work_id: work.id,
        work_revision: work.revision, control_generation: work.managed!.control_generation,
        areas: structuredClone(work.areas), added_readers: members.filter(member => !canReadWork(member, work)) }));
      for (const work of [...selected, added]) if (work.managed && (this.#transitionTasks.has(work.managed.task_id)
        || this.serviceTransitions?.has(work.managed.task_id) || this.#retirements.has(work.managed.task_id)))
        throw new BridgeError("PEER_OPERATION_STALE", "Selected task authority is changing");
      const next = structuredClone(current), changed = next.cases.find(candidate => candidate.id === item.id)!;
      changed.members = members;
      changed.inputs.push({ work_id: added.id, commit_oid: added.input_oid });
      changed.delivery_pending = changed.inputs.map(input => input.work_id);
      changed.delivery_observed = [];
      changed.visibility_delta = visibility_delta;
      changed.revision++;
      next.revision++;
      const receipt: Receipt = { owner, key: command.operation_key, request_hash: hash, revision: next.revision,
        action: command.kind, entity: { kind: "case", id: item.id }, item_id: item.id, outcome: "recorded" };
      next.receipts.push(receipt);
      checkCapacity(next);
      await this.#publish(current, next);
      return structuredClone(receipt);
    });
  }

  /** Runtime calls this only after all current-revision peer envelopes for one task carry native observed receipts. */
  async observeCaseDelivery(actor: CoordinationActor, input: Readonly<{
    operation_key: string; case_id: string; case_revision: number; generation: number;
    recipient_work_id: string; observation_digest: string;
  }>, guard: ObservedDeliveryMetadataGuard): Promise<Receipt> {
    const owner = parentId(actor.owner_id), command = { kind: "observe_case_delivery" as const,
      operation_key: coordinationOperationKey(input.operation_key), case_id: entityId(input.case_id),
      case_revision: input.case_revision, generation: input.generation,
      recipient_work_id: entityId(input.recipient_work_id), observation_digest: input.observation_digest };
    const hash = canonicalHash({ owner, command });
    return this.#ordering.run(async () => {
      this.store.assertMutable();
      const current = await this.store.snapshot();
      const prior = current.receipts.find(receipt => receipt.owner === owner && receipt.key === command.operation_key);
      if (prior) {
        if (prior.request_hash !== hash || prior.action !== command.kind) throw new BridgeError("COORDINATION_KEY_CONFLICT", "Delivery observation key identifies different evidence");
        return structuredClone(prior);
      }
      if (!guard || current.epoch !== guard.epoch || current.revision !== guard.revision)
        throw new BridgeError("PEER_DELIVERY_STALE", "Metadata changed after current delivery evidence was checked");
      const item = current.cases.find(candidate => candidate.id === command.case_id && candidate.state === "active");
      if (!item || item.lead !== owner || item.revision !== command.case_revision || item.generation !== command.generation ||
        item.observed_origin !== "selected" || !item.delivery_pending?.includes(command.recipient_work_id))
        throw new BridgeError("PEER_DELIVERY_STALE", "Current case has no pending observation for this task");
      const next = structuredClone(current), changed = next.cases.find(candidate => candidate.id === item.id)!;
      changed.delivery_pending = changed.delivery_pending!.filter(id => id !== command.recipient_work_id);
      (changed.delivery_observed ??= []).push({ work_id: command.recipient_work_id,
        observation_digest: command.observation_digest });
      next.revision++;
      const receipt: Receipt = { owner, key: command.operation_key, request_hash: hash, revision: next.revision,
        action: command.kind, entity: { kind: "case", id: item.id }, item_id: item.id, outcome: "recorded" };
      next.receipts.push(receipt);
      checkCapacity(next);
      await this.#publish(current, next);
      return structuredClone(receipt);
    });
  }

  /** Capture permission-checked values for read-only Git validation, outside this owner's lock. */
  async prepareSourceCommand(actor: CoordinationActor, raw: unknown): Promise<
    { kind: "recorded"; receipt: Receipt } | { kind: "inspect"; target: Case | null; works: Work[]; resource_versions: SourceVersions }
  > {
    const owner = parentId(actor.owner_id), command = decodeCommand(raw);
    if (command.kind !== "claim_target" && command.kind !== "select_inputs" && command.kind !== "begin_external_integration") {
      throw new BridgeError("COORDINATION_OPERATION_UNSUPPORTED", "This operation does not require a Git preflight");
    }
    const hash = canonicalHash({ owner, command });
    return this.#ordering.run(async () => {
      const state = await this.store.snapshot();
      if (recoveryReceipts(state).some(r => r.operator === owner && r.command.operation_key === command.operation_key)) {
        throw new BridgeError("COORDINATION_KEY_CONFLICT", "Operation key already identifies operator recovery");
      }
      if (submissionEvents(state).some(e => e.owner === owner && e.key === command.operation_key)) {
        throw new BridgeError("COORDINATION_KEY_CONFLICT", "Operation key already identifies submission authority");
      }
      const prior = state.receipts.find(r => r.owner === owner && r.key === command.operation_key);
      if (prior) {
        if (prior.request_hash !== hash) throw new BridgeError("COORDINATION_KEY_CONFLICT", "Operation key already names different intent");
        return { kind: "recorded", receipt: structuredClone(prior) };
      }
      if (command.kind === "claim_target") return { kind: "inspect", target: null, works: [], resource_versions: [] };
      const target = ownCase(state, owner, command.case_id, command.expected_revision, command.generation);
      idle(target);
      const inputs = command.kind === "select_inputs" ? command.inputs : target.inputs;
      const works = inputs.map(i => visibleWork(state, owner, i.work_id));
      for (const work of works) for (const member of target.members) visibleWork(state, member, work.id);
      const resource_versions = works.flatMap(w => w.managed ? [{ task_id: w.managed.task_id, version: this.#resourceVersions.get(w.managed.task_id) ?? 0 }] : []);
      for (const resource of resource_versions) if (this.#retirements.has(resource.task_id)) throw new BridgeError("COORDINATION_RETIREMENT_ACTIVE", "A selected task is being retired; refresh after the operation settles");
      return { kind: "inspect", target: structuredClone(target), works: structuredClone(works), resource_versions };
    });
  }

  async execute(actor: CoordinationActor, input: unknown, sourceVersions?: SourceVersions, observed = false): Promise<Receipt> {
    const owner = parentId(actor.owner_id), command = decodeCommand(input);
    const versions = sourceVersions ? sourceVersions.map(v => ({ ...v })) : [];
    if (this.#closing) throw new BridgeError("COORDINATION_CLOSED", "Coordination no longer accepts operations");
    if (command.operation_key.startsWith(WORKER_PEER_KEY_PREFIX)) throw new BridgeError("COORDINATION_FORBIDDEN", "Worker peer operation keys are reserved");
    let consentGuard: { revision: number; epoch: number } | undefined;
    let consentPublication: { state: ControlState; item: Case; consent: Note } | undefined;
    if (command.kind === "post_note") {
      const record = decodePeerResolutionText(command.text);
      if (record && record.kind !== "peer_resolution_proposal") {
        const captured = await this.#ordering.run(async () => {
          const state = immutableSnapshot(await this.store.snapshot()), item = state.cases.find(candidate => candidate.id === record.case_id);
          if (item) this.#assertCaseTransition(state, item);
          const consent = item && workerConsentNote(state, item, record);
          return consent && item ? { state, item, consent, epoch: this.#transitionEpoch } : undefined;
        });
        if (captured) {
          if (!this.workerAuthority) throw new BridgeError("PEER_OPERATION_UNAVAILABLE", "Worker consent authority is unavailable");
          await this.workerAuthority.assertConsentCurrent(captured.state, captured.item, captured.consent);
          consentGuard = { revision: captured.state.revision, epoch: captured.epoch };
          consentPublication = { state: captured.state, item: captured.item, consent: captured.consent };
        }
      }
    }
    const publish = () => this.#ordering.run(() => this.#executeCommand(owner, command, versions, consentGuard, observed));
    return consentPublication
      ? this.#withWorkerPublication(consentPublication.state, consentPublication.item, undefined, [], publish,
        consentPublication.consent)
      : publish();
  }

  /** The caller holds #ordering. Worker consent, when required, was checked outside it. */
  async #executeCommand(owner: ParentId, command: Command, versions: SourceVersions,
    consentGuard?: { revision: number; epoch: number }, observed = false): Promise<Receipt> {
    const hash = canonicalHash({ owner, command });
      this.store.assertMutable();
      const current = await this.store.snapshot();
      const selectedCase = "case_id" in command ? current.cases.find(item => item.id === command.case_id) : undefined;
      if (selectedCase && this.#applicationCases.has(selectedCase.id)) {
        throw new BridgeError("PEER_OPERATION_STALE", "Selected case is reserved for task publication");
      }
      const pendingApplications = command.kind === "release_case" ? current.receipts.filter(receipt =>
        receipt.key.startsWith(WORKER_PEER_KEY_PREFIX) && receipt.key.endsWith(":pending") &&
        current.notes.some(note => note.id === receipt.item_id &&
          note.subject.kind === "case" && note.subject.id === command.case_id)) : [];
      if (pendingApplications.some(receipt => {
        const outcome = current.receipts.find(candidate => candidate.owner === receipt.owner &&
          candidate.key === `${receipt.key.slice(0, -":pending".length)}:outcome`);
        const note = current.notes.find(candidate => candidate.id === outcome?.item_id);
        const record = note && retainedPeerRecord(note.text);
        return record?.kind !== "peer_resolution_application" || record.status !== "applied" && record.status !== "rejected";
      })) {
        throw new BridgeError("COORDINATION_EXTERNAL_EFFECT_UNRESOLVED", "A task application requires explicit operator reconciliation before ordinary release");
      }
      if ("work_id" in command && current.cases.some(item => this.#applicationCases.has(item.id)
        && item.inputs.some(input => input.work_id === command.work_id))) {
        throw new BridgeError("PEER_OPERATION_STALE", "Selected source is reserved for task publication");
      }
      if (consentGuard && (current.revision !== consentGuard.revision || this.#transitionEpoch !== consentGuard.epoch)) {
        throw new BridgeError("PEER_OPERATION_STALE", "Worker consent changed during authority validation");
      }
      if (recoveryReceipts(current).some(r => r.operator === owner && r.command.operation_key === command.operation_key)) {
        throw new BridgeError("COORDINATION_KEY_CONFLICT", "Operation key already identifies operator recovery");
      }
      if (submissionEvents(current).some(e => e.owner === owner && e.key === command.operation_key)) {
        throw new BridgeError("COORDINATION_KEY_CONFLICT", "Operation key already identifies submission authority");
      }
      const prior = current.receipts.find(r => r.owner === owner && r.key === command.operation_key);
      if (prior) {
        if (prior.request_hash !== hash) throw new BridgeError("COORDINATION_KEY_CONFLICT", "Operation key already names different intent");
        // Historical acknowledgment, not a current ownership token or permission to repeat an external effect.
        return structuredClone(prior);
      }
      if ((command.kind === "ack_note" || command.kind === "withdraw_note")
        && current.receipts.some(receipt => receipt.action === "post_note" && receipt.item_id === command.note_id
          && receipt.key.startsWith(WORKER_PEER_KEY_PREFIX))) {
        throw new BridgeError("COORDINATION_FORBIDDEN", "Worker proposal consent and withdrawal require task authority");
      }
      for (const resource of versions) {
        if (this.#retirements.has(resource.task_id) || (this.#resourceVersions.get(resource.task_id) ?? 0) !== resource.version) {
          throw new BridgeError("COORDINATION_RESOURCE_CHANGED", "Task retirement changed during source inspection; refresh the source facts");
        }
      }
      if (command.kind === "select_inputs" || command.kind === "begin_external_integration") {
        const inputs = command.kind === "select_inputs" ? command.inputs : current.cases.find(c => c.id === command.case_id)?.inputs ?? [];
        for (const input of inputs) {
          const task = current.works.find(w => w.id === input.work_id)?.managed?.task_id;
          if (task && this.#retirements.has(task)) throw new BridgeError("COORDINATION_RETIREMENT_ACTIVE", "A selected task is being retired");
        }
      }
      if (command.kind === "register_task_work" && this.#retirements.has(command.managed.task_id)) throw new BridgeError("COORDINATION_RETIREMENT_ACTIVE", "The task is being retired");
      let peerCase: Case | undefined;
      if (command.kind === "ack_note" || command.kind === "withdraw_note") {
        const note = current.notes.find(candidate => candidate.id === command.note_id);
        const peerRecord = note && retainedPeerRecord(note.text);
        if (peerRecord) {
          peerCase = current.cases.find(candidate => candidate.id === peerRecord.case_id);
          if (peerCase) this.#assertCaseTransition(current, peerCase);
        }
      }
      if (command.kind === "post_note") {
        const peerRecord = decodePeerResolutionText(command.text);
        if (peerRecord) {
          const item = current.cases.find(candidate => candidate.id === peerRecord.case_id);
          peerCase = item;
          if (item) this.#assertCaseTransition(current, item);
          if (peerRecord.kind !== "peer_resolution_proposal") {
            const consent = item && workerConsentNote(current, item, peerRecord);
            if (item && consent) {
              if (!consentGuard) throw new BridgeError("PEER_OPERATION_STALE", "Worker consent requires current authority validation");
              this.#assertCaseTransition(current, item);
            }
          }
          assertPeerResolutionPost(current, owner, command.subject, command.note_kind, command.parties, peerRecord);
          if (item) this.#assertCaseTransition(current, item);
        }
      }
      const next: ControlState = observed && command.kind === "claim_target" ||
        command.kind === "post_note" && command.subject.kind === "work" && current.schema_version < OBSERVED_CASE_CONTROL_SCHEMA
        ? { ...structuredClone(current), schema_version: OBSERVED_CASE_CONTROL_SCHEMA,
            recoveries: structuredClone([...recoveryReceipts(current)]),
            announcements: structuredClone([...announcements(current)]),
            bindings: structuredClone([...submissionBindings(current)]),
            submission_events: structuredClone([...submissionEvents(current)]) }
        : command.kind === "watch_source"
        ? current.schema_version >= SOURCE_WATCH_CONTROL_SCHEMA ? structuredClone(current)
          : { ...structuredClone(current), schema_version: SOURCE_WATCH_CONTROL_SCHEMA,
              recoveries: structuredClone([...recoveryReceipts(current)]),
              announcements: structuredClone([...announcements(current)]),
              bindings: structuredClone([...submissionBindings(current)]),
              submission_events: structuredClone([...submissionEvents(current)]) }
        : command.kind === "grant_source"
        ? current.schema_version >= SOURCE_GRANT_CONTROL_SCHEMA ? structuredClone(current)
          : { ...structuredClone(current), schema_version: SOURCE_GRANT_CONTROL_SCHEMA,
              recoveries: structuredClone([...recoveryReceipts(current)]),
              announcements: structuredClone([...announcements(current)]),
              bindings: structuredClone([...submissionBindings(current)]),
              submission_events: structuredClone([...submissionEvents(current)]) }
        : command.kind === "register_task_work"
        ? current.schema_version >= SUBMISSION_CONTROL_SCHEMA ? structuredClone(current)
          : { ...structuredClone(current), schema_version: MANAGED_CONTROL_SCHEMA, recoveries: structuredClone([...recoveryReceipts(current)]) }
        : structuredClone(current);
      const result = apply(next, owner, command, observed);
      next.revision++;
      const receipt: Receipt = { owner, key: command.operation_key, request_hash: hash, revision: next.revision,
        action: command.kind, entity: result.entity, item_id: result.item_id, outcome: "recorded" };
      next.receipts.push(receipt);
      checkCapacity(next);
      if (peerCase) this.#assertCaseTransition(current, peerCase);
      await this.#publish(current, next);
      return structuredClone(receipt);
  }

  /** Task identity is supplied by the coordinator; worker text only requests a bounded operation. */
  async workerPeerOperation(actor: WorkerPeerActor, raw: unknown, signal?: AbortSignal,
    deferDisclosure = false): Promise<PeerWorkerOperationResult> {
    return this.#workerPeerOperation(actor, raw, signal, 0, deferDisclosure);
  }
  async #workerPeerOperation(actor: WorkerPeerActor, raw: unknown, signal: AbortSignal | undefined,
    retries: number, deferDisclosure: boolean): Promise<PeerWorkerOperationResult> {
    if (!this.workerAuthority) throw new BridgeError("PEER_OPERATION_UNAVAILABLE", "Worker task authority is unavailable");
    const operation = decodePeerWorkerOperation(raw);
    if (operation.kind === "source_detail" || operation.kind === "apply") throw new BridgeError("PEER_OPERATION_UNAVAILABLE", "Source detail and application are served by the runtime boundary");
    const owner = parentId(actor.owner_id);
    for (const field of ["task_id", "run_id", "control_generation", "workspace_id", "source_view", "case_id"] as const) {
      if (actor[field] !== operation[field]) throw new BridgeError("PEER_OPERATION_FORBIDDEN", "Worker operation identity differs from authenticated task authority");
    }
    if (this.#closing) throw new BridgeError("COORDINATION_CLOSED", "Coordination no longer accepts operations");
    if (signal?.aborted) throw signal.reason ?? new BridgeError("REQUEST_CANCELLED", "Peer wait was cancelled");
    const captured = await this.#ordering.run(async () => {
      const state = immutableSnapshot(await this.store.snapshot()), item = workerPeerCase(state, owner, actor);
      this.#assertWorkerTransition(actor, item, state);
      const historicalOutcome = (operation.kind === "inspect" || operation.kind === "await_change") &&
        historicalWorkerOutcome(state, item);
      return { state, item, historicalOutcome, observationGeneration: this.#observationGenerations.get(item.id) ?? 0,
        epoch: this.#transitionEpoch };
    });
    await this.workerAuthority.assertCurrent(actor, captured.state, captured.item, captured.historicalOutcome);
    const observed = operation.kind === "inspect" || operation.kind === "await_change"
      ? await workerPeerCurrent(captured.state, captured.item, actor, operation, this.workerAuthority,
          undefined, captured.observationGeneration) : undefined;
    const immediatelyChanged = operation.kind === "await_change" && observed?.kind === "current" &&
      (captured.item.revision !== operation.after_case_revision ||
        captured.item.generation !== operation.after_case_generation || operation.after_negotiation_cursor !== undefined &&
        operation.after_negotiation_cursor !== observed.negotiation_cursor);
    const currentValue = operation.kind === "inspect" || immediatelyChanged ? observed : undefined;
    let currentEvidenceId: string | undefined;
    const publish = () => this.#ordering.run(async (): Promise<{ value?: PeerWorkerOperationResult; wait?: Promise<PeerWorkerOperationResult>; retry?: true }> => {
      if (this.#closing) throw new BridgeError("COORDINATION_CLOSED", "Coordination no longer accepts operations");
      if (signal?.aborted) throw signal.reason ?? new BridgeError("REQUEST_CANCELLED", "Peer operation was cancelled");
      const state = await this.store.snapshot();
      const item = workerPeerCase(state, owner, actor);
      this.#assertWorkerTransition(actor, item, state);
      if (state.revision !== captured.state.revision || this.#transitionEpoch !== captured.epoch ||
        (operation.kind === "inspect" || operation.kind === "await_change") &&
          (this.#observationGenerations.get(item.id) ?? 0) !== captured.observationGeneration) {
        if (operation.kind === "inspect" || operation.kind === "await_change") return { retry: true };
        throw new BridgeError("PEER_OPERATION_STALE", "Peer metadata changed during authority validation");
      }
      if (operation.kind === "inspect") return { value: currentValue! };
      if (operation.kind === "await_change") {
        if (item.revision !== operation.after_case_revision || item.generation !== operation.after_case_generation
          || operation.after_negotiation_cursor !== undefined
            && operation.after_negotiation_cursor !== observed!.negotiation_cursor) {
          return { value: currentValue! };
        }
        if (this.#peerWaiters.size >= MAX_PEER_WAITERS) throw new BridgeError("PEER_OPERATION_CAPACITY", "Too many retained peer change waits");
        if (signal?.aborted) throw signal.reason ?? new BridgeError("REQUEST_CANCELLED", "Peer wait was cancelled");
        let resolve!: (value: PeerWorkerOperationResult) => void;
        let reject!: (reason: unknown) => void;
        const wait = new Promise<PeerWorkerOperationResult>((yes, no) => { resolve = yes; reject = no; });
        wait.catch(() => undefined);
        const abort = () => { this.#peerWaiters.delete(waiter); waiter.cleanup(); reject(signal?.reason ?? new BridgeError("REQUEST_CANCELLED", "Peer wait was cancelled")); };
        const current = observed as Extract<PeerWorkerOperationResult, { kind: "current" }>;
        const waiter: PeerWaiter = { fingerprint: current.negotiation_cursor, actor, operation,
          captureEvidenceId: current.evidence_id, evidenceStatus: current.evidence_status,
          captureVersion: 0, checkedVersion: current.evidence_status === "historical" ||
            !this.workerAuthority?.captureEvidenceId ? 0 : -1,
          resolve, reject, cleanup: () => signal?.removeEventListener("abort", abort) };
        this.#peerWaiters.add(waiter);
        if (waiter.checkedVersion < 0) this.#schedulePeerRefresh();
        signal?.addEventListener("abort", abort, { once: true });
        return { wait };
      }
      this.store.assertMutable();
      const key = workerPeerKey(operation);
      const hash = canonicalHash({ owner, operation });
      const prior = state.receipts.find(receipt => receipt.owner === owner && receipt.key === key);
      if (prior) {
        if (prior.request_hash !== hash && prior.request_hash !== legacyWorkerPeerHash(owner, operation, item)) {
          throw new BridgeError("COORDINATION_KEY_CONFLICT", "Key names different worker intent");
        }
        return { value: workerPeerReceipt(operation, prior) };
      }
      const parties = workerPeerParties(state, item);
      const principal = workerPeerPrincipal(state, actor);
      let action: Receipt["action"];
      let noteId: string;
      const next = structuredClone(state);
      if (operation.kind === "propose" || operation.kind === "counter_propose") {
        if (currentEvidenceId !== undefined && operation.proposal.evidence_id !== currentEvidenceId) {
          throw new BridgeError("COORDINATION_STALE_REVISION", "Peer proposal evidence changed before publication");
        }
        assertPeerResolutionPost(state, owner, { kind: "case", id: item.id }, "agreement_proposal", item.members, operation.proposal, "worker");
        const text = encodePeerResolutionRecord(operation.proposal);
        noteId = randomUUID(); action = "post_note";
        next.notes.push({ id: noteId, subject: { kind: "case", id: item.id }, author: owner, kind: "agreement_proposal",
          text, work_refs: item.inputs.map(input => input.work_id), parties: parties.map(party => party.principal),
          ...(item.observed_origin ? { readers: [...item.members] } : {}),
          acknowledged: [], withdrawn: false });
      } else if ("note_id" in operation) {
        noteId = operation.note_id;
        const note = state.notes.find(candidate => candidate.id === noteId);
        const proposal = note && retainedPeerRecord(note.text);
        if (!note || note.subject.kind !== "case" || note.subject.id !== item.id || note.kind !== "agreement_proposal"
          || proposal?.kind !== "peer_resolution_proposal" || !peerRecordCurrent(state, note, proposal)
          || !sameSet(note.parties, parties.map(party => party.principal))) {
          throw new BridgeError("PEER_OPERATION_FORBIDDEN", "Worker note is not a current proposal in this case");
        }
        if (operation.kind === "withdraw" && !state.receipts.some(receipt => receipt.owner === owner
          && receipt.key.startsWith(workerPeerTaskPrefix(actor)) && receipt.action === "post_note" && receipt.item_id === note.id)) {
          throw new BridgeError("PEER_OPERATION_FORBIDDEN", "Only the proposing task may withdraw its proposal");
        }
        const changed = next.notes.find(candidate => candidate.id === noteId)!;
        if (operation.kind === "acknowledge") {
          if (currentEvidenceId !== undefined && proposal.evidence_id !== currentEvidenceId) {
            throw new BridgeError("COORDINATION_STALE_REVISION", "Peer proposal evidence changed before consent");
          }
          if (note.withdrawn) throw new BridgeError("COORDINATION_NOTE_WITHDRAWN", "Withdrawn agreements cannot receive acknowledgment");
          if (!note.parties.includes(principal)) throw new BridgeError("PEER_OPERATION_FORBIDDEN", "Task is not a named proposal participant");
          assertPeerResolutionAcknowledgment(state, note, proposal, true);
          if (note.acknowledged.includes(principal)) throw new BridgeError("COORDINATION_ALREADY_ACKNOWLEDGED", "Use the original operation key to retrieve an acknowledgment");
          changed.acknowledged.push(principal); action = "ack_note";
        } else {
          if (note.withdrawn) throw new BridgeError("COORDINATION_NOTE_WITHDRAWN", "Note is already withdrawn");
          changed.withdrawn = true; action = "withdraw_note";
        }
      } else {
        throw new BridgeError("PEER_OPERATION_UNSUPPORTED", "Unsupported worker peer mutation");
      }
      next.revision++;
      const receipt: Receipt = { owner, key, request_hash: hash, revision: next.revision,
        action, entity: { kind: "case", id: item.id }, item_id: noteId, outcome: "recorded" };
      next.receipts.push(receipt);
      checkCapacity(next);
      if (signal?.aborted) throw signal.reason ?? new BridgeError("REQUEST_CANCELLED", "Peer operation was cancelled");
      await this.#publish(state, next);
      return { value: workerPeerReceipt(operation, receipt) };
    });
    // A suspended wait owns no task reservation. Only publication and immediate
    // observation disclosure need exclusion from native task mutations.
    const result = operation.kind === "await_change" && !immediatelyChanged
      ? await publish()
      : await this.#withWorkerPublication(captured.state, captured.item, actor, [], async () => {
          if (operation.kind === "propose" || operation.kind === "counter_propose" || operation.kind === "acknowledge") {
            currentEvidenceId = await workerPeerEvidenceId(captured.state, captured.item, actor, this.workerAuthority!);
          }
          return publish();
        }, undefined, captured.historicalOutcome);
    if (result.retry) {
      if (retries >= 3) throw new BridgeError("PEER_OPERATION_STALE", "Peer metadata changed repeatedly during authority validation");
      return this.#workerPeerOperation(actor, raw, signal, retries + 1, deferDisclosure);
    }
    const value = result.value ?? await result.wait!;
    if (operation.kind === "inspect" || operation.kind === "await_change") {
      if (signal?.aborted) throw signal.reason ?? new BridgeError("REQUEST_CANCELLED", "Peer operation was cancelled");
      // The runtime settles this captured value first, then authorizes disclosure
      // of the exact durable winner. Direct control callers retain fresh checks.
      if (deferDisclosure) return value;
      return this.workerPeerStoredResult(actor, raw, value);
    }
    return value;
  }

  /** Linearize disclosure of a retained task result with source grants and task transitions. */
  async workerPeerStoredResult(actor: WorkerPeerActor, raw: unknown, value: PeerWorkerOperationResult): Promise<PeerWorkerOperationResult> {
    return this.#workerPeerResult(actor, raw, value, false);
  }
  /** Only the runtime may select this path after reading an exact settled TaskStore key. */
  async workerPeerRetainedResult(actor: WorkerPeerActor, raw: unknown, value: PeerWorkerOperationResult): Promise<PeerWorkerOperationResult> {
    return this.#workerPeerResult(actor, raw, value, true);
  }
  async #workerPeerResult(actor: WorkerPeerActor, raw: unknown, value: PeerWorkerOperationResult,
    retainedExact: boolean): Promise<PeerWorkerOperationResult> {
    if (!this.workerAuthority) throw new BridgeError("PEER_OPERATION_UNAVAILABLE", "Worker task authority is unavailable");
    const operation = decodePeerWorkerOperation(raw), owner = parentId(actor.owner_id);
    if (operation.kind === "source_detail" || operation.kind === "apply")
      throw new BridgeError("PEER_OPERATION_UNAVAILABLE", "This task operation is owned by the runtime boundary");
    for (const field of ["task_id", "run_id", "control_generation", "workspace_id", "source_view", "case_id"] as const) {
      if (actor[field] !== operation[field] || value[field] !== operation[field]) {
        throw new BridgeError("PEER_OPERATION_FORBIDDEN", "Stored peer result identity differs from authenticated task authority");
      }
    }
    if (value.operation_key !== operation.operation_key || value.operation !== operation.kind
      || value.kind === "pending" || value.kind === "current" && operation.kind !== "inspect" && operation.kind !== "await_change"
      || value.kind === "receipt" && (operation.kind === "inspect" || operation.kind === "await_change")) {
      throw new BridgeError("PEER_OPERATION_FORBIDDEN", "Stored peer result differs from the exact operation");
    }
    const captured = await this.#ordering.run(async () => {
      const state = immutableSnapshot(await this.store.snapshot()), item = workerPeerCase(state, owner, actor);
      this.#assertWorkerTransition(actor, item, state);
      if (!retainedExact && value.kind === "current" &&
        (value.case_revision !== item.revision || value.case_generation !== item.generation)) {
        throw new BridgeError("PEER_OPERATION_STALE", "Stored peer inspection no longer matches current metadata");
      }
      if (retainedExact && value.kind === "current") {
        for (const source of value.proposal?.sources ?? value.first_proposal?.sources ?? []) {
          const work = state.works.find(candidate => candidate.id === source.work_id);
          const input = item.inputs.find(candidate => candidate.work_id === source.work_id);
          if (!work?.managed || work.state !== "active" || work.revision !== source.work_revision ||
            work.input_oid !== source.input_oid || input?.commit_oid !== source.selected_commit_oid || !canReadSelectedWork(state, owner, work)) {
            throw new BridgeError("STRUCTURAL_SOURCE_FORBIDDEN", "Retained peer source is no longer authorized");
          }
        }
      }
      const historicalOutcome = value.kind === "current" && value.evidence_status === "historical" &&
        value.proposal === null && value.first_proposal === null &&
        value.application_outcome !== null && historicalWorkerOutcome(state, item) &&
        (() => {
          const canonical = workerApplicationOutcome(state, item, workerPeerParties(state, item));
          return canonical !== null && canonical.record.evidence_id === value.evidence_id &&
            canonical.record.evidence_revision === value.evidence_revision &&
            canonicalHash(canonical.outcome) === canonicalHash(value.application_outcome);
        })();
      return { state, item, historicalOutcome, observationGeneration: this.#observationGenerations.get(item.id) ?? 0,
        epoch: this.#transitionEpoch };
    });
    await this.workerAuthority.assertCurrent(actor, captured.state, captured.item, captured.historicalOutcome);
    const retainedSources = retainedExact && value.kind === "current"
      ? value.proposal?.sources ?? value.first_proposal?.sources ?? [] : [];
    if (retainedSources.length) {
      // Standalone control fixtures retain metadata-only validation when they
      // have no native task store. The runtime always supplies this callback.
      await this.workerAuthority.assertRetainedSources?.(actor, captured.state, retainedSources);
    }
    if (!retainedExact) await assertWorkerResultConsent(captured.state, captured.item, value, this.workerAuthority);
    return this.#withWorkerPublication(captured.state, captured.item, actor,
      retainedSources, async () => {
      if (value.kind === "current" && !retainedExact) {
        const evidenceId = captured.historicalOutcome ? value.evidence_id
          : await readablePeerEvidenceId(captured.state, captured.item, actor, this.workerAuthority!,
              captured.observationGeneration);
        const status = captured.historicalOutcome ? "historical" : evidenceId === null ? "unavailable" : "current";
        if (evidenceId !== undefined && evidenceId !== value.evidence_id || value.evidence_status !== status ||
          value.negotiation_cursor !== workerPeerCursor(captured.state, captured.item, status, value.evidence_id)) {
          throw new BridgeError("PEER_OPERATION_STALE", "Peer evidence changed before result disclosure");
        }
      }
      return this.#ordering.run(async () => {
      const state = immutableSnapshot(await this.store.snapshot()), item = workerPeerCase(state, owner, actor);
      this.#assertWorkerTransition(actor, item, state);
      if ((!retainedExact && (state.revision !== captured.state.revision ||
          (this.#observationGenerations.get(item.id) ?? 0) !== captured.observationGeneration)) ||
        this.#transitionEpoch !== captured.epoch || retainedExact &&
        (item.revision !== captured.item.revision || item.generation !== captured.item.generation ||
          retainedSources.some(source => {
            const work = state.works.find(candidate => candidate.id === source.work_id);
            const input = item.inputs.find(candidate => candidate.work_id === source.work_id);
            return !work?.managed || work.state !== "active" || work.revision !== source.work_revision ||
              work.input_oid !== source.input_oid || input?.commit_oid !== source.selected_commit_oid || !canReadSelectedWork(state, owner, work);
          }))) {
        throw new BridgeError("PEER_OPERATION_STALE", "Peer result authority changed during disclosure");
      }
      return structuredClone(value);
      });
    }, undefined, captured.historicalOutcome);
  }

  #withWorkerPublication<T>(state: ControlState, item: Case, actor: WorkerPeerActor | undefined,
    retainedSources: readonly PeerResolutionSource[], publish: () => Promise<T>, consent?: Note,
    historicalOutcome?: boolean): Promise<T> {
    return this.workerAuthority?.withPublication?.(state, item, actor, retainedSources, publish, consent, historicalOutcome) ?? publish();
  }

  /** A started task intent may recover only a committed, exact metadata receipt. */
  async workerPeerCommittedReceipt(actor: WorkerPeerActor, raw: unknown): Promise<PeerWorkerOperationResult | undefined> {
    if (!this.workerAuthority) throw new BridgeError("PEER_OPERATION_UNAVAILABLE", "Worker task authority is unavailable");
    const operation = decodePeerWorkerOperation(raw), owner = parentId(actor.owner_id);
    if (operation.kind === "inspect" || operation.kind === "await_change" || operation.kind === "source_detail" || operation.kind === "apply") return undefined;
    for (const field of ["task_id", "run_id", "control_generation", "workspace_id", "source_view", "case_id"] as const) {
      if (actor[field] !== operation[field]) throw new BridgeError("PEER_OPERATION_FORBIDDEN", "Worker receipt identity differs from authenticated task authority");
    }
    const captured = await this.#ordering.run(async () => {
      const state = immutableSnapshot(await this.store.snapshot()), item = workerPeerCase(state, owner, actor);
      this.#assertWorkerTransition(actor, item, state);
      return { state, item, epoch: this.#transitionEpoch };
    });
    await this.workerAuthority.assertCurrent(actor, captured.state, captured.item);
    return this.#ordering.run(async () => {
      const state = await this.store.snapshot(), item = workerPeerCase(state, owner, actor);
      this.#assertWorkerTransition(actor, item, state);
      if (state.revision !== captured.state.revision || this.#transitionEpoch !== captured.epoch) {
        throw new BridgeError("PEER_OPERATION_STALE", "Peer receipt authority changed during lookup");
      }
      const receipt = state.receipts.find(candidate => candidate.owner === owner && candidate.key === workerPeerKey(operation));
      if (!receipt) return undefined;
      const hash = canonicalHash({ owner, operation });
      if (receipt.request_hash !== hash && receipt.request_hash !== legacyWorkerPeerHash(owner, operation, item)) {
        throw new BridgeError("COORDINATION_KEY_CONFLICT", "Key names different worker intent");
      }
      return workerPeerReceipt(operation, receipt);
    });
  }

  /** A logical case reservation fences final source disclosure and application effects without holding a mutex over I/O. */
  async withWorkerCasePublication<T>(actor: WorkerPeerActor, raw: unknown, publish: () => Promise<T>): Promise<T> {
    if (!this.workerAuthority) throw new BridgeError("PEER_OPERATION_UNAVAILABLE", "Worker task authority is unavailable");
    const operation = decodePeerWorkerOperation(raw), owner = parentId(actor.owner_id);
    if (operation.kind !== "source_detail" && operation.kind !== "apply")
      throw new BridgeError("PEER_OPERATION_UNSUPPORTED", "This operation has no runtime case publication");
    for (const field of ["task_id", "run_id", "control_generation", "workspace_id", "source_view", "case_id"] as const) {
      if (operation[field] !== actor[field]) throw new BridgeError("PEER_OPERATION_FORBIDDEN", "Worker case publication identity differs from task authority");
    }
    const captured = await this.#ordering.run(async () => {
      const state = immutableSnapshot(await this.store.snapshot()), item = workerPeerCase(state, owner, actor);
      this.#assertWorkerTransition(actor, item, state);
      return { state, item, epoch: this.#transitionEpoch };
    });
    await this.workerAuthority.assertCurrent(actor, captured.state, captured.item);
    await this.#ordering.run(async () => {
      const state = await this.store.snapshot(), item = workerPeerCase(state, owner, actor);
      this.#assertWorkerTransition(actor, item, state);
      if (state.revision !== captured.state.revision || this.#transitionEpoch !== captured.epoch)
        throw new BridgeError("PEER_OPERATION_STALE", "Selected case changed before task publication");
      this.#applicationCases.add(item.id);
    });
    try { return await publish(); }
    finally { await this.#ordering.run(async () => { this.#applicationCases.delete(captured.item.id); }); }
  }

  /** Admits one exact acknowledged v2 worker proposal and reserves its case through the owned effect callback. */
  async withWorkerApplication(actor: WorkerPeerActor, raw: unknown,
    effect: (proposal: PeerResolutionProposal) => Promise<PeerWorkerOperationResult>,
    preflight?: (proposal: PeerResolutionProposal) => Promise<void>,
    settledResult?: PeerWorkerOperationResult): Promise<PeerWorkerOperationResult> {
    if (!this.workerAuthority) throw new BridgeError("PEER_OPERATION_UNAVAILABLE", "Worker task authority is unavailable");
    const operation = decodePeerWorkerOperation(raw), owner = parentId(actor.owner_id);
    if (operation.kind !== "apply") throw new BridgeError("PEER_OPERATION_UNSUPPORTED", "Application admission requires an apply operation");
    for (const field of ["task_id", "run_id", "control_generation", "workspace_id", "source_view", "case_id"] as const) {
      if (operation[field] !== actor[field]) throw new BridgeError("PEER_OPERATION_FORBIDDEN", "Application identity differs from task authority");
    }
    const select = (state: ControlState) => {
      const item = workerPeerCase(state, owner, actor);
      this.#assertWorkerTransition(actor, item, state);
      const note = state.notes.find(candidate => candidate.id === operation.note_id);
      const proposal = note && retainedPeerRecord(note.text);
      if (!note || proposal?.kind !== "peer_resolution_proposal" || proposal.schema_version !== 2 ||
        !proposal.changes?.length || !proposal.summary || !peerRecordCurrent(state, note, proposal) ||
        !acknowledged(state, item, note) || !sameSet(note.parties, workerPeerParties(state, item).map(party => party.principal)) ||
        proposal.case_revision !== operation.expected_case_revision ||
        proposal.case_generation !== operation.expected_case_generation ||
        proposal.resolution_digest !== operation.proposal_digest ||
        !state.receipts.some(receipt => receipt.action === "post_note" && receipt.item_id === note.id &&
          receipt.owner === owner && receipt.key.startsWith(workerPeerTaskPrefix(actor)))) {
        throw new BridgeError("PEER_OPERATION_FORBIDDEN", "Application requires this task's current fully acknowledged v2 proposal");
      }
      return { item, note, proposal };
    };
    const pendingFor = (state: ControlState, item: Case, proposal: PeerResolutionProposal) => {
      const pending: PeerResolutionApplication = { schema_version: 1, kind: "peer_resolution_application",
        case_id: item.id, case_revision: item.revision, case_generation: item.generation,
        evidence_id: proposal.evidence_id, evidence_revision: proposal.evidence_revision,
        sources: proposal.sources, scope: proposal.scope,
        proposal_digest: proposal.resolution_digest,
        application_digest: canonicalHash({ task_id: actor.task_id, operation }), status: "pending" };
      const receipt = state.receipts.find(candidate => candidate.owner === owner &&
        candidate.key === `${workerPeerKey(operation)}:pending`);
      const note = state.notes.find(candidate => candidate.id === receipt?.item_id);
      if (!receipt || receipt.request_hash !== canonicalHash({ owner, operation, pending }) ||
        !note || note.subject.kind !== "case" || note.subject.id !== item.id ||
        note.text !== encodePeerResolutionRecord(pending)) {
        throw new BridgeError("PEER_OPERATION_RECOVERY_REQUIRED", "Settled application has no exact retained effect admission");
      }
      return pending;
    };
    const pendingKey = `${workerPeerKey(operation)}:pending`;
    const unresolvedApplication = (state: ControlState, item: Case): boolean => state.receipts.some(receipt => {
      if (!receipt.key.startsWith(WORKER_PEER_KEY_PREFIX) || !receipt.key.endsWith(":pending") ||
        !state.notes.some(note => note.id === receipt.item_id && note.subject.kind === "case" && note.subject.id === item.id) ||
        receipt.owner === owner && receipt.key === pendingKey) return false;
      const outcomeReceipt = state.receipts.find(candidate => candidate.owner === receipt.owner &&
        candidate.key === `${receipt.key.slice(0, -":pending".length)}:outcome`);
      const outcomeNote = state.notes.find(note => note.id === outcomeReceipt?.item_id);
      const outcome = outcomeNote && retainedPeerRecord(outcomeNote.text);
      return outcome?.kind !== "peer_resolution_application" || outcome.status !== "rejected";
    });
    const retained = settledResult && decodePeerWorkerOperationResult(settledResult);
    if (retained && (retained.kind !== "application" || retained.operation !== "apply" ||
      retained.task_id !== actor.task_id || retained.run_id !== actor.run_id ||
      retained.control_generation !== actor.control_generation || retained.workspace_id !== actor.workspace_id ||
      retained.source_view !== actor.source_view || retained.case_id !== actor.case_id ||
      retained.operation_key !== operation.operation_key || retained.note_id !== operation.note_id)) {
      throw new BridgeError("PEER_OPERATION_INVALID", "Settled application result differs from the exact task operation");
    }
    const captured = await this.#ordering.run(async () => {
      const state = immutableSnapshot(await this.store.snapshot()), selected = select(state);
      if (retained) pendingFor(state, selected.item, selected.proposal);
      return { state, ...selected, epoch: this.#transitionEpoch };
    });
    await this.workerAuthority.assertCurrent(actor, captured.state, captured.item);
    await this.workerAuthority.assertConsentCurrent(captured.state, captured.item, captured.note);
    await this.workerAuthority.assertRetainedSources?.(actor, captured.state, captured.proposal.sources);
    if (unresolvedApplication(captured.state, captured.item)) {
      throw new BridgeError("COORDINATION_EXTERNAL_EFFECT_UNRESOLVED", "This case already has a retained application effect; reconcile it before another key");
    }
    if (!retained) {
      await preflight?.(captured.proposal);
      const evidenceId = await workerPeerEvidenceId(captured.state, captured.item, actor, this.workerAuthority);
      if (evidenceId !== undefined && evidenceId !== captured.proposal.evidence_id) {
        throw new BridgeError("COORDINATION_STALE_REVISION", "Agreed peer evidence changed before application admission");
      }
    }
    await this.#ordering.run(async () => {
      const state = await this.store.snapshot();
      const selected = select(state);
      if (state.revision !== captured.state.revision || this.#transitionEpoch !== captured.epoch ||
        selected.proposal.resolution_digest !== captured.proposal.resolution_digest) {
        throw new BridgeError("PEER_OPERATION_STALE", "Application consent or source changed before effect admission");
      }
      if (retained) pendingFor(state, selected.item, selected.proposal);
      const applicationReceipts = state.receipts.filter(receipt => receipt.key.startsWith(WORKER_PEER_KEY_PREFIX)
        && receipt.key.endsWith(":pending") &&
        state.notes.some(note => note.id === receipt.item_id && note.subject.kind === "case" && note.subject.id === selected.item.id));
      if (unresolvedApplication(state, selected.item)) {
        throw new BridgeError("COORDINATION_EXTERNAL_EFFECT_UNRESOLVED", "This case already has a retained application effect; reconcile it before another key");
      }
      if (!applicationReceipts.some(receipt => receipt.owner === owner && receipt.key === pendingKey)) {
        const pending: PeerResolutionApplication = { schema_version: 1, kind: "peer_resolution_application",
          case_id: selected.item.id, case_revision: selected.item.revision, case_generation: selected.item.generation,
          evidence_id: selected.proposal.evidence_id, evidence_revision: selected.proposal.evidence_revision,
          sources: selected.proposal.sources, scope: selected.proposal.scope,
          proposal_digest: selected.proposal.resolution_digest,
          application_digest: canonicalHash({ task_id: actor.task_id, operation }), status: "pending" };
        const next = structuredClone(state), noteId = randomUUID();
        next.notes.push({ id: noteId, subject: { kind: "case", id: selected.item.id }, author: owner,
          kind: "resolution_update", text: encodePeerResolutionRecord(pending),
          work_refs: selected.item.inputs.map(input => input.work_id), parties: [],
          ...(selected.item.observed_origin ? { readers: [...selected.item.members] } : {}),
          acknowledged: [], withdrawn: false });
        next.revision++;
        next.receipts.push({ owner, key: pendingKey, request_hash: canonicalHash({ owner, operation, pending }),
          revision: next.revision, action: "post_note", entity: { kind: "case", id: selected.item.id },
          item_id: noteId, outcome: "recorded" });
        checkCapacity(next);
        await this.#publish(state, next);
      }
      this.#applicationCases.add(selected.item.id);
    });
    try {
      const result = retained ?? await effect(structuredClone(captured.proposal));
      if (result.kind !== "application" || result.operation !== "apply" || result.note_id !== operation.note_id ||
        result.case_id !== captured.item.id || result.operation_key !== operation.operation_key) {
        throw new BridgeError("PEER_OPERATION_INVALID", "Application effect returned a different task operation");
      }
      await this.#ordering.run(async () => {
        const state = await this.store.snapshot();
        const prior = state.receipts.find(receipt => receipt.owner === owner && receipt.key === `${workerPeerKey(operation)}:outcome`);
        if (prior) {
          if (prior.request_hash !== canonicalHash({ owner, operation, result })) {
            throw new BridgeError("COORDINATION_KEY_CONFLICT", "Application outcome differs from the exact settled result");
          }
          return;
        }
        const item = state.cases.find(candidate => candidate.id === captured.item.id);
        if (!item || item.revision !== captured.item.revision || item.generation !== captured.item.generation ||
          !state.receipts.some(receipt => receipt.owner === owner && receipt.key === `${workerPeerKey(operation)}:pending`)) {
          throw new BridgeError("PEER_OPERATION_STALE", "Application case changed before outcome publication");
        }
        const record: PeerResolutionApplication = { schema_version: 1, kind: "peer_resolution_application",
          case_id: item.id, case_revision: item.revision, case_generation: item.generation,
          evidence_id: captured.proposal.evidence_id, evidence_revision: captured.proposal.evidence_revision,
          sources: captured.proposal.sources, scope: captured.proposal.scope,
          proposal_digest: captured.proposal.resolution_digest,
          application_digest: result.application_digest ?? canonicalHash({ operation, result }), status: result.status };
        const text = encodePeerResolutionRecord(record), noteId = randomUUID(), next = structuredClone(state);
        next.notes.push({ id: noteId, subject: { kind: "case", id: item.id }, author: owner,
          kind: "resolution_update", text, work_refs: item.inputs.map(input => input.work_id),
          ...(item.observed_origin ? { readers: [...item.members] } : {}),
          parties: [], acknowledged: [], withdrawn: false });
        next.revision++;
        next.receipts.push({ owner, key: `${workerPeerKey(operation)}:outcome`, request_hash: canonicalHash({ owner, operation, result }),
          revision: next.revision, action: "post_note", entity: { kind: "case", id: item.id },
          item_id: noteId, outcome: "recorded" });
        checkCapacity(next);
        await this.#publish(state, next);
      });
      return result;
    }
    finally { await this.#ordering.run(async () => {
      this.#applicationCases.delete(captured.item.id);
      this.#schedulePeerRefresh();
    }); }
  }

  /** Serialize adoption with metadata publication and reject suspended old workers. */
  async withWorkerTaskTransition<T>(taskId: string, transition: () => Promise<T>): Promise<T> {
    const affected = await this.#ordering.run(async () => {
      const state = await this.store.snapshot();
      const affected = new Set(state.cases.filter(item => item.state === "active" && item.inputs.some(input =>
        state.works.find(work => work.id === input.work_id)?.managed?.task_id === taskId)).map(item => item.id));
      if (this.#transitionTasks.has(taskId) || [...affected].some(id => this.#transitionCases.has(id) || this.#applicationCases.has(id))) {
        throw new BridgeError("PEER_OPERATION_STALE", "A selected task transition is already active");
      }
      this.#transitionTasks.add(taskId);
      for (const id of affected) this.#transitionCases.add(id);
      this.#transitionEpoch++;
      for (const waiter of this.#peerWaiters) if (waiter.actor.task_id === taskId || affected.has(waiter.actor.case_id)) {
        this.#peerWaiters.delete(waiter); waiter.cleanup();
        waiter.reject(new BridgeError("PEER_OPERATION_STALE", "Task authority changed during peer wait"));
      }
      return affected;
    });
    try { return await transition(); }
    finally {
      await this.#ordering.run(async () => {
        this.#transitionTasks.delete(taskId);
        for (const id of affected) this.#transitionCases.delete(id);
        this.#transitionEpoch++;
      });
    }
  }

  /** Notify the metadata owner of an already committed stop, including during adoption. */
  async invalidateCancelledTask(taskId: string): Promise<void> {
    const rejected = await this.#ordering.run(async () => {
      const state = await this.store.snapshot();
      const affected = new Set(state.cases.filter(item => item.state === "active" && item.inputs.some(input =>
        state.works.find(work => work.id === input.work_id)?.managed?.task_id === taskId)).map(item => item.id));
      this.#transitionEpoch++;
      const waiters = [...this.#peerWaiters].filter(waiter => waiter.actor.task_id === taskId || affected.has(waiter.actor.case_id));
      for (const waiter of waiters) { this.#peerWaiters.delete(waiter); waiter.cleanup(); }
      return waiters;
    });
    for (const waiter of rejected) waiter.reject(new BridgeError("PEER_OPERATION_STALE", "Task cancellation invalidated peer wait"));
  }

  /** Trusted observation publication wakes existing waits; captured bytes decide whether evidence changed. */
  async notifyWorkerPeerCaptureChanged(workId: string, path: string): Promise<void> {
    if (!workId || !path || this.#closing) return;
    await this.#ordering.run(async () => {
      const state = await this.store.snapshot();
      const selectedCases = state.cases.filter(item => item.state === "active" &&
        item.inputs.some(input => input.work_id === workId));
      for (const item of selectedCases) this.#observationGenerations.set(item.id,
        (this.#observationGenerations.get(item.id) ?? 0) + 1);
      let changed = false;
      for (const waiter of this.#peerWaiters) {
        if (selectedCases.some(item => item.id === waiter.actor.case_id)) {
          waiter.captureVersion++;
          changed = true;
        }
      }
      if (changed) this.#schedulePeerRefresh();
    });
  }

  async #publish(current: ControlState, next: ControlState): Promise<void> {
    await this.store.publish(current, next);
    this.#schedulePeerRefresh();
  }
  #schedulePeerRefresh(): void {
    if (this.#closing || !this.#peerWaiters.size) return;
    const refresh = Promise.resolve().then(() => this.#refreshPeerWaiters());
    this.#peerRefreshes.add(refresh);
    void refresh.then(() => this.#peerRefreshes.delete(refresh), () => this.#peerRefreshes.delete(refresh));
  }
  #assertWorkerTransition(actor: WorkerPeerActor, item: Case, state: ControlState): void {
    if (this.#transitionTasks.has(actor.task_id) || this.serviceTransitions?.has(actor.task_id)) {
      throw new BridgeError("PEER_OPERATION_STALE", "Selected task authority is changing");
    }
    this.#assertCaseTransition(state, item);
  }
  #assertCaseTransition(state: ControlState, item: Case): void {
    if (this.#applicationCases.has(item.id)) throw new BridgeError("PEER_OPERATION_STALE", "A selected application effect is in progress");
    if (this.#transitionCases.has(item.id) || item.inputs.some(input => {
      const taskId = state.works.find(work => work.id === input.work_id)?.managed?.task_id;
      return taskId !== undefined && (this.#transitionTasks.has(taskId) || this.serviceTransitions?.has(taskId));
    })) {
      throw new BridgeError("PEER_OPERATION_STALE", "Selected task authority is changing");
    }
  }
  async #refreshPeerWaiters(): Promise<void> {
    for (const waiter of this.#peerWaiters) {
      if (this.#closing) return;
      try {
        const captured = await this.#ordering.run(async () => {
          if (this.#closing || !this.#peerWaiters.has(waiter)) return undefined;
          const state = immutableSnapshot(await this.store.snapshot());
          const item = workerPeerCase(state, parentId(waiter.actor.owner_id), waiter.actor);
          if (this.#applicationCases.has(item.id)) return undefined;
          this.#assertWorkerTransition(waiter.actor, item, state);
          const metadataChanged = item.revision !== waiter.operation.after_case_revision
            || item.generation !== waiter.operation.after_case_generation
            || waiter.operation.after_negotiation_cursor !== undefined
              && workerPeerCursor(state, item, waiter.evidenceStatus,
                waiter.captureEvidenceId ?? null) !== waiter.fingerprint;
          const captureChanged = waiter.checkedVersion !== waiter.captureVersion;
          return metadataChanged || captureChanged ? { state, item, historicalOutcome: historicalWorkerOutcome(state, item),
            metadataChanged, captureChanged, captureVersion: waiter.captureVersion,
            observationGeneration: this.#observationGenerations.get(item.id) ?? 0,
            epoch: this.#transitionEpoch } : undefined;
        });
        if (!captured) continue;
        if (!this.workerAuthority) throw new BridgeError("PEER_OPERATION_UNAVAILABLE", "Worker task authority is unavailable");
        await this.workerAuthority.assertCurrent(waiter.actor, captured.state, captured.item, captured.historicalOutcome);
        const evidenceId = captured.captureChanged
          ? captured.historicalOutcome || !this.workerAuthority.captureEvidenceId ? waiter.captureEvidenceId
            : await readablePeerEvidenceId(captured.state, captured.item, waiter.actor, this.workerAuthority,
              captured.observationGeneration) : undefined;
        if (captured.captureChanged && !captured.metadataChanged && evidenceId === waiter.captureEvidenceId &&
          (evidenceId !== null || captured.captureVersion === 0 || captured.historicalOutcome)) {
          await this.#ordering.run(async () => {
            if (!this.#peerWaiters.has(waiter)) return;
            if (waiter.captureVersion === captured.captureVersion) waiter.checkedVersion = captured.captureVersion;
            else this.#schedulePeerRefresh();
          });
          continue;
        }
        const value = await workerPeerCurrent(captured.state, captured.item, waiter.actor, waiter.operation,
          this.workerAuthority, evidenceId, captured.observationGeneration);
        await this.#ordering.run(async () => {
          if (this.#closing || !this.#peerWaiters.has(waiter)) return;
          const state = await this.store.snapshot();
          const item = workerPeerCase(state, parentId(waiter.actor.owner_id), waiter.actor);
          if (this.#applicationCases.has(item.id)) return;
          this.#assertWorkerTransition(waiter.actor, item, state);
          if (this.#transitionEpoch !== captured.epoch || state.revision !== captured.state.revision ||
            waiter.captureVersion !== captured.captureVersion ||
            (this.#observationGenerations.get(item.id) ?? 0) !== captured.observationGeneration) {
            this.#schedulePeerRefresh();
            return;
          }
          this.#peerWaiters.delete(waiter); waiter.cleanup(); waiter.resolve(value);
        });
      } catch (error) {
        this.#peerWaiters.delete(waiter); waiter.cleanup(); waiter.reject(error);
      }
    }
  }
  /** Only the service's verified operator path calls this method. No process or Git effect is performed. */
  async recoverAuthorized(actor: CoordinationActor, input: unknown): Promise<RecoveryReceipt> {
    const operator = parentId(actor.owner_id), recovery = decodeRecoveryCommand(input);
    if (this.#closing) throw new BridgeError("COORDINATION_CLOSED", "Coordination no longer accepts operations");
    if (recovery.operation_key.startsWith(WORKER_PEER_KEY_PREFIX)) throw new BridgeError("COORDINATION_FORBIDDEN", "Worker peer operation keys are reserved");
    const request_hash = canonicalHash({ operator, recovery });
    return this.#ordering.run(async () => {
      this.store.assertMutable();
      const current = await this.store.snapshot();
      if ("case_id" in recovery && this.#applicationCases.has(recovery.case_id) ||
        "work_id" in recovery && current.cases.some(item => this.#applicationCases.has(item.id)
          && item.inputs.some(selected => selected.work_id === recovery.work_id))) {
        throw new BridgeError("PEER_OPERATION_STALE", "Selected case is reserved for task publication");
      }
      const prior = recoveryReceipts(current).find(r => r.operator === operator && r.command.operation_key === recovery.operation_key);
      if (prior) {
        if (prior.request_hash !== request_hash) throw new BridgeError("COORDINATION_KEY_CONFLICT", "Recovery key already identifies different intent");
        return structuredClone(prior);
      }
      if (current.receipts.some(r => r.owner === operator && r.key === recovery.operation_key)) {
        throw new BridgeError("COORDINATION_KEY_CONFLICT", "Recovery key already identifies an ordinary operation");
      }
      if (submissionEvents(current).some(e => e.owner === operator && e.key === recovery.operation_key)) {
        throw new BridgeError("COORDINATION_KEY_CONFLICT", "Recovery key already identifies submission authority");
      }
      if (recovery.epoch !== current.epoch) throw new BridgeError("COORDINATION_STALE_EPOCH", "Recovery belongs to a different initialized coordination store");
      const next: Exclude<ControlState, { schema_version: 1 }> = "announcements" in current ? structuredClone(current) : {
        ...structuredClone(current), schema_version: current.schema_version === MANAGED_CONTROL_SCHEMA ? MANAGED_CONTROL_SCHEMA : 2,
        recoveries: structuredClone([...recoveryReceipts(current)]),
      };
      applyRecovery(next, recovery);
      next.revision++;
      const receipt: RecoveryReceipt = { operator, request_hash, revision: next.revision, command: recovery };
      next.recoveries.push(receipt);
      checkCapacity(next);
      // One atomic publication owns the version transition, metadata update and attributed acknowledgment.
      await this.#publish(current, next);
      return structuredClone(receipt);
    });
  }

  /** Administrative inspection reveals metadata only, after service-owned operator authorization. */
  async inspectRecoveryAuthorized(actor: CoordinationActor, selector:
    { kind: "inventory" } | { kind: "work" | "case"; id: string } | { kind: "receipt"; operation_key: string }): Promise<unknown> {
    const operator = parentId(actor.owner_id);
    return this.#ordering.run(async () => {
      const state = await this.store.snapshot();
      if (selector.kind === "receipt") {
        const key = coordinationOperationKey(selector.operation_key);
        return structuredClone(recoveryReceipts(state).find(r => r.operator === operator && r.command.operation_key === key) ?? null);
      }
      if (selector.kind === "inventory") {
        return { epoch: state.epoch, revision: state.revision,
          works: state.works.filter(w => w.state === "active").map(w => ({ id: w.id, owner: w.owner, revision: w.revision, workspace_id: w.workspace_id })),
          cases: state.cases.filter(c => c.state === "active").map(c => ({ id: c.id, target: c.target, lead: c.lead, revision: c.revision, generation: c.generation, external_effect: c.external_effect })) };
      }
      const id = entityId(selector.id);
      const entity = selector.kind === "work" ? state.works.find(w => w.id === id) : state.cases.find(c => c.id === id);
      if (!entity) return unavailable();
      return { epoch: state.epoch, revision: state.revision, subject: structuredClone(entity) };
    });
  }

  async work(actor: CoordinationActor, id: string): Promise<Work> {
    const owner = parentId(actor.owner_id), workId = entityId(id);
    return this.#ordering.run(async () => structuredClone(visibleWork(await this.store.snapshot(), owner, workId)));
  }
  async sourceWork(actor: CoordinationActor, id: string, scope: "report" | "detail"): Promise<Work> {
    const recipient = parentId(actor.owner_id), workId = entityId(id);
    return this.#ordering.run(async () => {
      const work = (await this.store.snapshot()).works.find(w => w.id === workId);
      if (!work || work.state !== "active") throw new BridgeError("STRUCTURAL_SOURCE_FORBIDDEN", "Current source work is unavailable");
      const grant = work.source_grants?.find(g => g.recipient === recipient && g.work_revision === work.revision);
      if (work.owner !== recipient && (!grant || scope === "detail" && grant.scope !== "detail")) {
        throw new BridgeError("STRUCTURAL_SOURCE_FORBIDDEN", "Current source scope does not authorize this recipient");
      }
      return structuredClone(work);
    });
  }
  async note(actor: CoordinationActor, id: string): Promise<Note & { agreement: "not_applicable" | "pending" | "acknowledged" | "withdrawn"; peer_resolution?: PeerResolutionRecord; peer_resolution_state?: "current" | "stale" }> {
    const owner = parentId(actor.owner_id), noteId = entityId(id);
    const captured = await this.#ordering.run(async () => {
      const state = immutableSnapshot(await this.store.snapshot()), note = state.notes.find(n => n.id === noteId);
      if (!note) return unavailable();
      requireNoteAccess(state, owner, note);
      return { state, note, epoch: this.#transitionEpoch };
    });
    const { state, note } = captured;
    const peer_resolution = retainedPeerRecord(note.text);
    let peer_resolution_state: "current" | "stale" | undefined = peer_resolution
        ? peerRecordCurrent(state, note, peer_resolution) ? "current" : "stale" : undefined;
      if (peer_resolution_state === "current" && peer_resolution) {
        const item = state.cases.find(candidate => candidate.id === peer_resolution.case_id);
        if (item) {
          try { this.#assertCaseTransition(state, item); }
          catch { peer_resolution_state = "stale"; }
        }
        const consent = item && workerConsentNote(state, item, peer_resolution, note);
        if (consent && peer_resolution_state === "current") {
          if (!this.workerAuthority) peer_resolution_state = "stale";
          else {
          try {
            await this.workerAuthority.assertConsentCurrent(state, item, consent);
          }
          catch { peer_resolution_state = "stale"; }
          }
        }
        if (item && peer_resolution_state === "current") {
          try { this.#assertCaseTransition(state, item); }
          catch { peer_resolution_state = "stale"; }
        }
      }
      const agreement = note.kind !== "agreement_proposal" ? "not_applicable" : note.withdrawn ? "withdrawn"
        : note.parties.every(p => note.acknowledged.includes(p)) && peer_resolution_state !== "stale" ? "acknowledged" : "pending";
    if (peer_resolution) {
      const finalCheck = () => this.#ordering.run(async () => {
      const latest = await this.store.snapshot();
      if (latest.revision !== state.revision || this.#transitionEpoch !== captured.epoch) {
        throw new BridgeError("PEER_OPERATION_STALE", "Peer note changed during consent validation");
      }
      const item = latest.cases.find(candidate => candidate.id === peer_resolution.case_id);
      if (item && peer_resolution_state === "current") this.#assertCaseTransition(latest, item);
      });
      const item = state.cases.find(candidate => candidate.id === peer_resolution.case_id);
      const consent = item && peer_resolution_state === "current" && workerConsentNote(state, item, peer_resolution, note);
      if (item && consent) {
        await this.#withWorkerPublication(state, item, undefined, [], finalCheck, consent);
      } else await finalCheck();
    }
    return { ...structuredClone(note), agreement, ...(peer_resolution ? { peer_resolution } : {}), ...(peer_resolution_state ? { peer_resolution_state } : {}) };
  }
  async reconciliation(actor: CoordinationActor, id: string): Promise<Case> {
    const owner = parentId(actor.owner_id), caseId = entityId(id);
    return this.#ordering.run(async () => structuredClone(visibleCase(await this.store.snapshot(), owner, caseId)));
  }
  /** Informational references only. The future retirement owner must coordinate its own reservation and Git proof. */
  async selectedCases(actor: CoordinationActor, workId: string): Promise<Array<{ case_id: string; commit_oid: string }>> {
    const owner = parentId(actor.owner_id), id = entityId(workId);
    return this.#ordering.run(async () => {
      const state = await this.store.snapshot(); visibleWork(state, owner, id);
      return state.cases.filter(c => c.state === "active" && canReadCase(state, owner, c)).flatMap(c =>
        c.inputs.filter(i => i.work_id === id).map(i => ({ case_id: c.id, commit_oid: i.commit_oid })));
    });
  }
  /** Returns only currently disclosed overlap. This is not a preflight admission or permission decision. */
  async overlaps(actor: CoordinationActor, workId: string): Promise<Array<{ work_id: string; areas: Region[] }>> {
    const owner = parentId(actor.owner_id), id = entityId(workId);
    return this.#ordering.run(async () => {
      const state = await this.store.snapshot(), target = visibleWork(state, owner, id);
      return state.works.filter(w => w.id !== id && w.state === "active" && canReadSelectedWork(state, owner, w))
        .map(w => ({ work_id: w.id, areas: w.areas.filter(a => target.areas.some(b => overlap(a, b))) })).filter(w => w.areas.length > 0);
    });
  }
  /** The runtime holds this reservation across disposition; no store lock is held across Git. */
  async reserveRetirement(taskId: string): Promise<RetirementReservation> {
    const id = entityId(taskId);
    if (this.#closing) throw new BridgeError("COORDINATION_CLOSED", "Coordination is closing");
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    await this.#ordering.run(async () => {
      if (this.#closing) throw new BridgeError("COORDINATION_CLOSED", "Coordination is closing");
      this.store.assertMutable();
      const state = await this.store.snapshot();
      if (this.#closing) throw new BridgeError("COORDINATION_CLOSED", "Coordination closed during retirement admission");
      const ids = new Set(state.works.filter(w => w.managed?.task_id === id).map(w => w.id));
      if (state.cases.some(c => c.state === "active" && c.inputs.some(i => ids.has(i.work_id)))) {
        throw new BridgeError("COORDINATION_RESULT_SELECTED", "An active reconciliation case selects this task; release that selection before retirement");
      }
      if (this.#retirements.has(id)) throw new BridgeError("COORDINATION_RETIREMENT_ACTIVE", "This task already has a retirement operation");
      // Only enrolled work needs a generation retained after release; this map is bounded by work capacity.
      if (ids.size) this.#resourceVersions.set(id, (this.#resourceVersions.get(id) ?? 0) + 1);
      this.#retirements.set(id, done);
    });
    let releasing: Promise<void> | undefined;
    return Object.freeze({ release: () => releasing ??= (async () => {
      await this.#ordering.run(() => {
        this.#retirements.delete(id);
        if (this.#resourceVersions.has(id)) this.#resourceVersions.set(id, this.#resourceVersions.get(id)! + 1);
      });
      finish();
    })() });
  }

  async close(): Promise<void> {
    this.#closing = true;
    for (const waiter of this.#peerWaiters) {
      this.#peerWaiters.delete(waiter); waiter.cleanup(); waiter.reject(new BridgeError("COORDINATION_CLOSED", "Coordination closed during peer wait"));
    }
    this.#close ??= (async () => {
      await Promise.allSettled([...this.#peerRefreshes]);
      await Promise.all([...this.#retirements.values()]);
      await this.#ordering.run(() => this.store.close());
    })();
    return this.#close;
  }
}
/** Authority callbacks receive detached, recursively immutable metadata. */
function immutableSnapshot<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) immutableSnapshot(child);
    Object.freeze(value);
  }
  return value;
}
function workerPeerTaskPrefix(actor: WorkerPeerActor): string {
  return `${WORKER_PEER_KEY_PREFIX}${actor.task_id}:${actor.run_id}:`;
}
function workerPeerKey(operation: PeerWorkerOperation): string {
  return `${WORKER_PEER_KEY_PREFIX}${operation.task_id}:${operation.run_id}:${canonicalHash(operation.operation_key)}`;
}
function legacyWorkerPeerHash(owner: ParentId, operation: Exclude<PeerWorkerOperation, { kind: "inspect" | "await_change" | "source_detail" | "apply" }>, item: Case): string {
  const command: Command = "note_id" in operation
    ? { kind: operation.kind === "acknowledge" ? "ack_note" : "withdraw_note",
        operation_key: workerPeerKey(operation), note_id: operation.note_id }
    : { kind: "post_note", operation_key: workerPeerKey(operation), subject: { kind: "case", id: item.id },
        note_kind: "agreement_proposal", text: encodePeerResolutionRecord(operation.proposal), parties: [...item.members] };
  return canonicalHash({ owner, command });
}
function workerPeerPrincipal(state: ControlState, actor: WorkerPeerActor): string {
  const work = state.works.find(candidate => candidate.managed?.task_id === actor.task_id);
  if (!work || work.owner !== actor.owner_id || work.workspace_id !== actor.workspace_id
    || work.managed?.control_generation !== actor.control_generation) {
    throw new BridgeError("PEER_OPERATION_FORBIDDEN", "Worker principal no longer has its selected work");
  }
  return canonicalHash({ task_id: actor.task_id, owner: work.owner, control_generation: actor.control_generation,
    workspace_id: actor.workspace_id });
}
function workerPeerParties(state: ControlState, item: Case): Array<{ task_id: string; principal: string }> {
  const parties = item.inputs.map(input => {
    const work = state.works.find(candidate => candidate.id === input.work_id);
    if (!work?.managed || work.state !== "active") throw new BridgeError("PEER_OPERATION_FORBIDDEN", "Every peer participant needs current managed work");
    return { task_id: work.managed.task_id, principal: canonicalHash({ task_id: work.managed.task_id, owner: work.owner,
      control_generation: work.managed.control_generation, workspace_id: work.workspace_id }) };
  });
  if (parties.length > MAX_PARTIES || new Set(parties.map(party => party.principal)).size !== parties.length
    || item.members.some(member => !item.inputs.some(input => state.works.find(work => work.id === input.work_id)?.owner === member))) {
    throw new BridgeError("PEER_OPERATION_FORBIDDEN", "Peer case participants lack distinct selected task authority");
  }
  return parties;
}
function workerPeerReceipt(operation: Exclude<PeerWorkerOperation, { kind: "inspect" | "await_change" | "source_detail" | "apply" }>, receipt: Receipt): PeerWorkerOperationResult {
  return { schema_version: operation.schema_version, task_id: operation.task_id, run_id: operation.run_id,
    control_generation: operation.control_generation, workspace_id: operation.workspace_id, source_view: operation.source_view,
    case_id: operation.case_id, operation_key: operation.operation_key, kind: "receipt", operation: operation.kind,
    receipt_revision: receipt.revision, note_id: receipt.item_id };
}
function workerPeerCase(state: ControlState, owner: ParentId, actor: WorkerPeerActor): Case {
  const item = state.cases.find(candidate => candidate.id === actor.case_id);
  if (!item || !item.members.includes(owner)) return unavailable();
  if (item.state !== "active") throw new BridgeError("COORDINATION_CASE_CLOSED", "Worker peer case has closed");
  const work = state.works.find(candidate => candidate.managed?.task_id === actor.task_id
    && candidate.owner === owner && candidate.workspace_id === actor.workspace_id
    && candidate.managed.control_generation === actor.control_generation);
  if (!work || work.state !== "active" || !item.inputs.some(input => input.work_id === work.id) || !canReadCase(state, owner, item)) {
    throw new BridgeError("PEER_OPERATION_FORBIDDEN", "Task is not a current managed participant in this selected case");
  }
  const binding = submissionBindings(state).find(candidate => candidate.task_id === actor.task_id && candidate.owner === owner);
  if (!binding || binding.source_view !== actor.source_view || binding.state !== "bound" && binding.state !== "settled") {
    throw new BridgeError("PEER_OPERATION_FORBIDDEN", "Task source view or submission authority is no longer current");
  }
  for (const input of item.inputs) {
    const selected = state.works.find(candidate => candidate.id === input.work_id);
    if (!selected?.managed || selected.state !== "active" || !item.members.includes(selected.owner)
      || !canReadSelectedWork(state, owner, selected)) {
      throw new BridgeError("PEER_OPERATION_FORBIDDEN", "Worker selected source authority is no longer current");
    }
  }
  return item;
}
function workerPeerFingerprint(state: ControlState, item: Case): string {
  return canonicalHash({ case: item, notes: state.notes.filter(note => note.subject.kind === "case" && note.subject.id === item.id),
    works: item.inputs.map(input => state.works.find(work => work.id === input.work_id)),
    bindings: submissionBindings(state).filter(binding => item.inputs.some(input => input.work_id === binding.task_id)) });
}
function workerPeerCursor(state: ControlState, item: Case,
  status: "current" | "historical" | "unavailable", evidenceId: string | null): string {
  return canonicalHash([workerPeerFingerprint(state, item), status, evidenceId]);
}
function intentExcerpt(value: string): { text: string; truncated: boolean } {
  let text = "", bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > 256) return { text, truncated: true };
    text += character; bytes += size;
  }
  return { text, truncated: false };
}
function selectedWorkContext(state: ControlState, item: Case): PeerSelectedWorkContext[] {
  return item.inputs.slice(0, 4).map(input => {
    const work = state.works.find(candidate => candidate.id === input.work_id)!;
    const intent = intentExcerpt(work.intent);
    const declared_areas = work.areas.filter(area => Buffer.byteLength(area.path, "utf8") <= 512).slice(0, 4);
    return { task_id: work.managed!.task_id, work_id: work.id, intent_excerpt: intent.text,
      intent_truncated: intent.truncated, declared_areas,
      areas_omitted: work.areas.length - declared_areas.length };
  });
}
async function workerPeerEvidenceId(state: ControlState, item: Case, actor: WorkerPeerActor,
  authority: WorkerPeerAuthority): Promise<string | undefined> {
  if (!authority.captureEvidenceId) return undefined;
  const id = await authority.captureEvidenceId(actor, state, item);
  if (!/^[a-f0-9]{64}$/.test(id)) throw new BridgeError("PEER_OPERATION_UNAVAILABLE", "Current peer evidence identity is invalid");
  return id;
}
async function readablePeerEvidenceId(state: ControlState, item: Case, actor: WorkerPeerActor,
  authority: WorkerPeerAuthority, observationGeneration: number): Promise<string | null | undefined> {
  try { return await workerPeerEvidenceId(state, item, actor, authority); }
  catch (error) {
    if (observationGeneration > 0 && error instanceof BridgeError &&
      error.code === "PEER_OPERATION_NO_CURRENT_OVERLAP") return null;
    throw error;
  }
}
function workerApplicationOutcome(state: ControlState, item: Case,
  parties: ReturnType<typeof workerPeerParties>): { outcome: PeerApplicationOutcome; record: PeerResolutionApplication } | null {
  for (const receipt of [...state.receipts].reverse()) {
    if (receipt.action !== "post_note" || !receipt.key.endsWith(":outcome") ||
      receipt.entity.kind !== "case" || receipt.entity.id !== item.id ||
      !parties.some(party => receipt.key.startsWith(`${WORKER_PEER_KEY_PREFIX}${party.task_id}:`))) continue;
    const note = state.notes.find(candidate => candidate.id === receipt.item_id);
    const record = note && retainedPeerRecord(note.text);
    if (!note || note.author !== receipt.owner || record?.kind !== "peer_resolution_application" ||
      record.status === "pending" || !peerRecordCurrent(state, note, record)) continue;
    const pendingReceipt = state.receipts.find(candidate => candidate.owner === receipt.owner &&
      candidate.key === `${receipt.key.slice(0, -":outcome".length)}:pending`);
    const pendingNote = state.notes.find(candidate => candidate.id === pendingReceipt?.item_id);
    const pending = pendingNote && retainedPeerRecord(pendingNote.text);
    if (!pendingReceipt || pending?.kind !== "peer_resolution_application" || pending.status !== "pending" ||
      pending.proposal_digest !== record.proposal_digest || !samePeerEvidence(pending, record)) continue;
    const proposal = matchingProposal(state, item, record);
    if (!proposal || !workerProposalReceipt(state, proposal.note)) continue;
    return { outcome: { proposal_note_id: proposal.note.id, application_note_id: note.id,
      status: record.status, proposal_digest: record.proposal_digest,
      application_digest: record.application_digest }, record };
  }
  return null;
}
function historicalWorkerOutcome(state: ControlState, item: Case): boolean {
  const status = workerApplicationOutcome(state, item, workerPeerParties(state, item))?.record.status;
  return status === "applied" || status === "effect_unknown";
}
async function workerPeerCurrent(state: ControlState, item: Case, actor: WorkerPeerActor,
  operation: Extract<PeerWorkerOperation, { kind: "inspect" | "await_change" }>,
  authority: WorkerPeerAuthority, knownEvidenceId?: string | null, observationGeneration = 0): Promise<Extract<PeerWorkerOperationResult, { kind: "current" }>> {
  const parties = workerPeerParties(state, item);
  const application = workerApplicationOutcome(state, item, parties);
  const terminalEffect = application?.record.status === "applied" || application?.record.status === "effect_unknown";
  const capturedEvidenceId = terminalEffect ? undefined : knownEvidenceId !== undefined ? knownEvidenceId
    : await readablePeerEvidenceId(state, item, actor, authority, observationGeneration);
  const evidenceUnavailable = capturedEvidenceId === null;
  const selected = terminalEffect || evidenceUnavailable ? undefined : peerProposalNotes(state, item).filter(candidate => peerRecordCurrent(state, candidate.note, candidate.proposal)
    && (capturedEvidenceId === undefined || candidate.proposal.evidence_id === capturedEvidenceId)
    && sameSet(candidate.note.parties, parties.map(party => party.principal))).at(-1);
  if (selected) await authority.assertConsentCurrent(state, item, selected.note);
  const evidence_id = evidenceUnavailable ? null : application && terminalEffect ? application.record.evidence_id : capturedEvidenceId ?? selected?.proposal.evidence_id ?? canonicalHash({ case_id: item.id,
    revision: item.revision, generation: item.generation, target_oid: item.target_oid, inputs: item.inputs });
  const sources = item.inputs.map(input => {
    const work = state.works.find(candidate => candidate.id === input.work_id)!;
    return { work_id: work.id, work_revision: work.revision, input_oid: work.input_oid,
      selected_commit_oid: input.commit_oid };
  });
  const first_proposal = selected || terminalEffect || evidenceUnavailable ? null : { schema_version: 2 as const, kind: "peer_resolution_proposal" as const,
    case_id: item.id, case_revision: item.revision, case_generation: item.generation, proposal_revision: 1 as const,
    evidence_id: evidence_id!, evidence_revision: item.revision, participants: [...item.members], sources,
    action: "propose" as const, predecessor_digest: null, permitted_actions: [...PEER_RESOLUTION_ACTIONS] };
  return { schema_version: operation.schema_version, task_id: operation.task_id, run_id: operation.run_id,
    control_generation: operation.control_generation, workspace_id: operation.workspace_id, source_view: operation.source_view,
    case_id: operation.case_id, operation_key: operation.operation_key, kind: "current", operation: operation.kind,
    case_revision: item.revision, case_generation: item.generation,
    negotiation_cursor: workerPeerCursor(state, item, evidenceUnavailable ? "unavailable" : terminalEffect ? "historical" : "current", evidence_id),
    evidence_status: evidenceUnavailable ? "unavailable" : terminalEffect ? "historical" : "current", evidence_id,
    evidence_revision: evidenceUnavailable ? null : application && terminalEffect ? application.record.evidence_revision : selected?.proposal.evidence_revision ?? item.revision,
    proposal_note_id: selected?.note.id ?? null, proposal: selected?.proposal ?? null,
    application_outcome: application?.outcome ?? null,
    participant_task_ids: parties.map(party => party.task_id), first_proposal,
    selected_work_context: selectedWorkContext(state, item), selected_work_omitted: item.inputs.length - Math.min(item.inputs.length, 4),
    acknowledged_task_ids: selected ? parties.filter(party => selected.note.acknowledged.includes(party.principal)).map(party => party.task_id) : [] };
}
async function assertWorkerResultConsent(state: ControlState, item: Case, value: PeerWorkerOperationResult,
  authority: WorkerPeerAuthority): Promise<void> {
  if (value.kind !== "current" || !value.proposal_note_id) return;
  const note = state.notes.find(candidate => candidate.id === value.proposal_note_id);
  const proposal = note && retainedPeerRecord(note.text);
  if (!note || proposal?.kind !== "peer_resolution_proposal" || !peerRecordCurrent(state, note, proposal)) {
    throw new BridgeError("PEER_OPERATION_STALE", "Worker proposal consent changed before result disclosure");
  }
  await authority.assertConsentCurrent(state, item, note);
}
function submissionState(current: ControlState): Extract<ControlState, { schema_version: 4 | 5 | 6 | 7 }> {
  return "announcements" in current ? structuredClone(current) : {
    ...structuredClone(current), schema_version: SUBMISSION_CONTROL_SCHEMA,
    recoveries: structuredClone([...recoveryReceipts(current)]), announcements: [], bindings: [], submission_events: [],
  };
}
function sameSubmissionKey(state: ControlState, owner: ParentId, key: string, hash: string): SubmissionEvent | undefined {
  if (key.startsWith(WORKER_PEER_KEY_PREFIX)) throw new BridgeError("COORDINATION_FORBIDDEN", "Worker peer operation keys are reserved");
  if (state.receipts.some(r => r.owner === owner && r.key === key)
    || recoveryReceipts(state).some(r => r.operator === owner && r.command.operation_key === key)) {
    throw new BridgeError("COORDINATION_KEY_CONFLICT", "Operation key names another retained metadata action");
  }
  const prior = submissionEvents(state).find(e => e.owner === owner && e.key === key);
  if (prior && prior.request_hash !== hash) throw new BridgeError("COORDINATION_KEY_CONFLICT", "Operation key names different submission intent");
  return prior;
}
function appendSubmissionEvent(next: Extract<ControlState, { schema_version: 4 | 5 | 6 | 7 }>, kind: SubmissionEvent["kind"],
  owner: ParentId, key: string, item_id: string, request_hash: string): void {
  next.revision++;
  next.submission_events.push({ kind, owner, key, item_id, request_hash, revision: next.revision });
}
function submissionDecision(state: ControlState, owner: ParentId, input: SubmissionPreflightInput): {
  decision_identity: string; overlaps: Array<{ kind: "work" | "announcement" | "binding"; id: string; areas: Region[] }> } {
  const announcement = input.announcement ? announcements(state).find(a => a.id === input.announcement!.id) : undefined;
  if (input.announcement && (!announcement || announcement.owner !== owner)) return unavailable();
  if (announcement && (announcement.revision !== input.announcement!.revision || announcement.state !== "unresolved"
    || announcement.source_view !== input.source_view
    || canonicalHash(announcement.areas) !== canonicalHash(input.areas))) {
    throw new BridgeError("COORDINATION_CHANGED", "Announcement changed before the requested preflight");
  }
  const overlaps = [
    ...state.works.filter(w => w.state === "active" && canReadSelectedWork(state, owner, w))
      .map(w => ({ kind: "work" as const, id: w.id, revision: w.revision,
        areas: w.areas.filter(area => input.areas.some(b => overlap(area, b))) })).filter(w => w.areas.length),
    ...announcements(state).filter(a => a.state === "unresolved" && a.id !== input.announcement?.id
      && (a.owner === owner || a.readers.includes(owner)))
      .map(a => ({ kind: "announcement" as const, id: a.id, revision: a.revision,
        areas: a.areas.filter(area => input.areas.some(b => overlap(area, b))) })).filter(a => a.areas.length),
    ...submissionBindings(state).filter(b => (b.state === "bound" || b.state === "settled") &&
      (b.owner === owner || b.announcement && announcements(state).some(a => a.id === b.announcement!.id && a.readers.includes(owner)))
      && !state.works.some(w => w.managed?.task_id === b.task_id && canReadSelectedWork(state, owner, w)))
      .map(b => ({ kind: "binding" as const, id: b.task_id, revision: b.announcement?.revision ?? 0,
        areas: b.areas.filter(area => input.areas.some(other => overlap(area, other))) })).filter(b => b.areas.length),
  ].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  const decision_identity = canonicalHash({ owner, source_view: input.source_view, input_oid: input.input_oid,
    intent_hash: input.intent_hash, areas: input.areas, announcement: input.announcement ?? null, overlaps });
  return { decision_identity, overlaps: overlaps.map(({ kind, id, areas }) => ({ kind, id, areas })) };
}
function unavailable(): never { throw new BridgeError("COORDINATION_NOT_FOUND", "The subject is unavailable under current sharing authority"); }
function retainedPeerRecord(text: string): PeerResolutionRecord | null {
  try { return decodePeerResolutionText(text); }
  catch (error) {
    // A pre-schema note that happens to use the reserved prefix remains ordinary retained data on read.
    if (text.startsWith("passeur-peer-resolution-v1:") && error instanceof BridgeError && error.code === "PEER_RESOLUTION_INVALID") return null;
    throw error;
  }
}
function canReadWork(parent: ParentId, work: Work): boolean { return work.owner === parent || work.readers.includes(parent); }
function canReadSelectedWork(state: ControlState, parent: ParentId, work: Work): boolean {
  if (canReadWork(parent, work)) return true;
  return state.cases.some(item => item.state === "active" && item.observed_origin === "selected" &&
    item.members.includes(parent) && item.inputs.some(input => input.work_id === work.id) &&
    item.visibility_delta?.some(delta => delta.work_id === work.id && delta.work_revision === work.revision &&
      delta.control_generation === work.managed?.control_generation &&
      canonicalHash(delta.areas) === canonicalHash(work.areas) && delta.added_readers.includes(parent)));
}
function visibleWork(state: ControlState, parent: ParentId, id: string): Work {
  const work = state.works.find(w => w.id === id); if (!work || !canReadSelectedWork(state, parent, work)) return unavailable(); return work;
}
function canReadCase(state: ControlState, parent: ParentId, item: Case): boolean {
  return item.members.includes(parent) && item.inputs.every(i => { const work = state.works.find(w => w.id === i.work_id); return work !== undefined && canReadSelectedWork(state, parent, work); });
}
function visibleCase(state: ControlState, parent: ParentId, id: string): Case {
  const item = state.cases.find(c => c.id === id); if (!item || !canReadCase(state, parent, item)) return unavailable(); return item;
}
function requireSubject(state: ControlState, parent: ParentId, subject: Subject): void {
  if (subject.kind === "work") visibleWork(state, parent, subject.id); else visibleCase(state, parent, subject.id);
}
function requireNoteAccess(state: ControlState, parent: ParentId, note: Note): void {
  requireSubject(state, parent, note.subject);
  // Case-scoped work visibility cannot retroactively add a reader to retained text.
  // Legacy notes without an audience stamp fail closed to their explicit principals.
  if ((note.subject.kind === "work" || note.readers !== undefined ||
    state.cases.find(item => item.id === note.subject.id)?.observed_origin) &&
    !(note.readers?.includes(parent) || note.author === parent || note.parties.includes(parent))) return unavailable();
  for (const id of note.work_refs) visibleWork(state, parent, id);
}
function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every(item => right.includes(item));
}
function assertPeerResolutionSources(state: ControlState, parent: ParentId, item: Case, sources: readonly PeerResolutionSource[]): void {
  if (!Array.isArray(sources) || sources.length !== item.inputs.length) throw new BridgeError("PEER_RESOLUTION_INVALID", "Peer-resolution record must version every selected source");
  for (const source of sources) {
    const selected = item.inputs.find(input => input.work_id === source.work_id);
    if (!selected) throw new BridgeError("PEER_RESOLUTION_INVALID", "Peer-resolution record names an unselected work");
    const work = visibleWork(state, parent, source.work_id);
    if (source.work_revision !== work.revision || source.input_oid !== work.input_oid || source.selected_commit_oid !== selected.commit_oid) {
      throw new BridgeError("COORDINATION_STALE_REVISION", "Peer-resolution source versions are stale");
    }
  }
}
function peerProposalNotes(state: ControlState, item: Case, includeWithdrawn = false): Array<{ note: Note; proposal: PeerResolutionProposal }> {
  return state.notes.flatMap(note => {
    if (note.subject.kind !== "case" || note.subject.id !== item.id || note.kind !== "agreement_proposal" || note.withdrawn && !includeWithdrawn) return [];
    const proposal = retainedPeerRecord(note.text);
    return proposal?.kind === "peer_resolution_proposal" ? [{ note, proposal }] : [];
  });
}
function workerProposalReceipt(state: ControlState, note: Note): Receipt | undefined {
  return state.receipts.find(receipt => receipt.action === "post_note" && receipt.item_id === note.id
    && receipt.key.startsWith(WORKER_PEER_KEY_PREFIX));
}
function workerProposalCurrent(state: ControlState, item: Case, note: Note): boolean {
  const record = retainedPeerRecord(note.text);
  if (record?.kind === "peer_resolution_proposal" && record.action === "counter_propose") {
    const predecessor = matchingPredecessor(state, item, record);
    if (predecessor && workerProposalLineage(state, item, predecessor.note, new Set()) && !workerProposalReceipt(state, note)) return false;
  }
  if (!workerProposalReceipt(state, note)) return true;
  try { return sameSet(note.parties, workerPeerParties(state, item).map(party => party.principal)); }
  catch { return false; }
}
function workerProposalLineage(state: ControlState, item: Case, note: Note, seen: Set<string>): boolean {
  if (seen.has(note.id)) return false;
  seen.add(note.id);
  if (workerProposalReceipt(state, note)) return true;
  const record = retainedPeerRecord(note.text);
  if (record?.kind !== "peer_resolution_proposal" || record.action !== "counter_propose") return false;
  const predecessor = matchingPredecessor(state, item, record);
  return predecessor !== undefined && workerProposalLineage(state, item, predecessor.note, seen);
}
function acknowledged(state: ControlState, item: Case, note: Note): boolean {
  return workerProposalCurrent(state, item, note) && note.parties.every(party => note.acknowledged.includes(party));
}
function peerProposalSuperseded(state: ControlState, item: Case, proposal: PeerResolutionProposal, ignoredSuccessorNoteId?: string): boolean {
  const successors = peerProposalNotes(state, item).filter(candidate => candidate.note.id !== ignoredSuccessorNoteId
    && samePeerEvidence(candidate.proposal, proposal));
  const seen = new Set<string>(), pending = [proposal.resolution_digest];
  while (pending.length) {
    const digest = pending.pop();
    for (const candidate of successors) {
      if (candidate.proposal.predecessor_digest !== digest || candidate.proposal.resolution_digest === digest
        || seen.has(candidate.note.id)) continue;
      seen.add(candidate.note.id);
      if (acknowledged(state, item, candidate.note)) return true;
      pending.push(candidate.proposal.resolution_digest);
    }
  }
  return false;
}
function matchingPredecessor(state: ControlState, item: Case, proposal: PeerResolutionProposal): { note: Note; proposal: PeerResolutionProposal } | undefined {
  if (proposal.action !== "counter_propose" || proposal.predecessor_digest === proposal.resolution_digest) return undefined;
  const matches = peerProposalNotes(state, item, true).filter(candidate => candidate.proposal.resolution_digest === proposal.predecessor_digest
    && samePeerEvidence(candidate.proposal, proposal));
  const match = matches.length === 1 ? matches[0] : undefined;
  return match && !match.note.withdrawn && proposal.proposal_revision === match.proposal.proposal_revision + 1 ? match : undefined;
}
function matchingProposal(state: ControlState, item: Case, record: PeerResolutionApplication): { note: Note; proposal: PeerResolutionProposal } | undefined {
  const matches = peerProposalNotes(state, item, true).filter(candidate => candidate.proposal.resolution_digest === record.proposal_digest
    && samePeerEvidence(candidate.proposal, record));
  const match = matches.length === 1 ? matches[0] : undefined;
  return match && !match.note.withdrawn && acknowledged(state, item, match.note)
    && !peerProposalSuperseded(state, item, match.proposal) ? match : undefined;
}
function samePeerEvidence(left: PeerResolutionRecord, right: PeerResolutionRecord): boolean {
  return left.case_id === right.case_id && left.case_revision === right.case_revision && left.case_generation === right.case_generation
    && left.evidence_id === right.evidence_id && left.evidence_revision === right.evidence_revision
    && canonicalHash(left.sources) === canonicalHash(right.sources) && canonicalHash(left.scope) === canonicalHash(right.scope);
}
function matchingAppliedApplication(state: ControlState, item: Case, record: PeerResolutionVerification): { note: Note; application: PeerResolutionApplication } | undefined {
  return state.notes.flatMap(note => {
    if (note.subject.kind !== "case" || note.subject.id !== item.id || note.kind !== "resolution_update" || note.withdrawn) return [];
    const decoded = retainedPeerRecord(note.text);
    return decoded?.kind === "peer_resolution_application" ? [{ note, application: decoded }] : [];
  }).find(candidate => candidate.application.application_digest === record.application_digest && candidate.application.status === "applied"
    && samePeerEvidence(candidate.application, record) && peerRecordCurrent(state, candidate.note, candidate.application));
}
function workerConsentNote(state: ControlState, item: Case, record: PeerResolutionRecord, note?: Note): Note | undefined {
  if (record.kind === "peer_resolution_proposal") return note && workerProposalReceipt(state, note) ? note : undefined;
  const application = record.kind === "peer_resolution_application" ? record : matchingAppliedApplication(state, item, record)?.application;
  if (!application) return undefined;
  const proposal = matchingProposal(state, item, application);
  return proposal && workerProposalReceipt(state, proposal.note) ? proposal.note : undefined;
}
function peerRecordCurrent(state: ControlState, note: Note, record: PeerResolutionRecord, ignoredSuccessorNoteId?: string): boolean {
  if (note.withdrawn || note.subject.kind !== "case" || note.subject.id !== record.case_id
    || note.kind !== (record.kind === "peer_resolution_proposal" ? "agreement_proposal" : "resolution_update")) return false;
  const item = state.cases.find(candidate => candidate.id === record.case_id);
  if (!item || item.state !== "active" || item.revision !== record.case_revision || item.generation !== record.case_generation) return false;
  if (record.kind === "peer_resolution_proposal" && !workerProposalCurrent(state, item, note)) return false;
  if (record.kind === "peer_resolution_proposal" && peerProposalSuperseded(state, item, record, ignoredSuccessorNoteId)) return false;
  if (!record.sources.every(source => {
    const work = state.works.find(candidate => candidate.id === source.work_id);
    const selected = item.inputs.find(input => input.work_id === source.work_id);
    return work !== undefined && selected !== undefined && work.revision === source.work_revision && work.input_oid === source.input_oid && selected.commit_oid === source.selected_commit_oid;
  }) || record.sources.length !== item.inputs.length) return false;
  if (record.kind === "peer_resolution_proposal" && record.action === "counter_propose") {
    const predecessor = matchingPredecessor(state, item, record);
    // Ignore this counter's edge while checking its ancestor; other acknowledged branches still invalidate it.
    if (!predecessor || !peerRecordCurrent(state, predecessor.note, predecessor.proposal, note.id)) return false;
  }
  if (record.kind === "peer_resolution_application") {
    const proposal = matchingProposal(state, item, record);
    return proposal !== undefined && samePeerEvidence(proposal.proposal, record)
      && peerRecordCurrent(state, proposal.note, proposal.proposal);
  }
  if (record.kind === "peer_resolution_verification") return matchingAppliedApplication(state, item, record) !== undefined;
  return true;
}
function assertPeerResolutionPost(state: ControlState, parent: ParentId, subject: Subject, noteKind: Note["kind"], parties: readonly ParentId[], record: PeerResolutionRecord,
  origin: "public" | "worker" = "public"): void {
  if (record.kind === "peer_resolution_proposal" && noteKind !== "agreement_proposal" || record.kind !== "peer_resolution_proposal" && noteKind !== "resolution_update") {
    throw new BridgeError("PEER_RESOLUTION_INVALID", "Peer-resolution record kind must match its coordination note kind");
  }
  if (subject.kind !== "case" || record.case_id !== subject.id) {
    throw new BridgeError("PEER_RESOLUTION_INVALID", "Peer-resolution records must name their containing case exactly");
  }
  const item = visibleCase(state, parent, subject.id);
  if (item.state !== "active") throw new BridgeError("COORDINATION_CASE_CLOSED", "Peer-resolution records require an active case");
  if (record.case_revision !== item.revision || record.case_generation !== item.generation) {
    throw new BridgeError("COORDINATION_STALE_REVISION", "Peer-resolution record names a stale case version");
  }
  if (record.kind === "peer_resolution_proposal") {
    const expectedParticipants = item.members;
    if (!sameSet(record.participants, expectedParticipants) || !sameSet(parties, expectedParticipants) || !record.participants.includes(parent)) {
      throw new BridgeError("PEER_RESOLUTION_INVALID", "Peer-resolution proposal participants must equal the authenticated case parties");
    }
    assertPeerResolutionSources(state, parent, item, record.sources);
    if (peerProposalNotes(state, item, true).some(candidate => candidate.proposal.resolution_digest === record.resolution_digest
      && samePeerEvidence(candidate.proposal, record))) {
      throw new BridgeError("PEER_RESOLUTION_INVALID", "A peer-resolution proposal already retains this digest in the same context");
    }
    if (record.action === "counter_propose") {
      const predecessor = matchingPredecessor(state, item, record);
      if (!predecessor || !peerRecordCurrent(state, predecessor.note, predecessor.proposal)) {
        throw new BridgeError("PEER_RESOLUTION_INVALID", "Counter-proposals require one current, unwithdrawn predecessor in the same context and next revision");
      }
      if (origin === "public" && workerProposalLineage(state, item, predecessor.note, new Set())) {
        throw new BridgeError("COORDINATION_FORBIDDEN", "Worker proposal successors require task-authenticated consent");
      }
      if (peerProposalNotes(state, item).some(candidate => candidate.proposal.predecessor_digest === record.predecessor_digest
        && samePeerEvidence(candidate.proposal, record))) {
        throw new BridgeError("PEER_RESOLUTION_INVALID", "An active counter-proposal already names this predecessor in the same context");
      }
    }
  } else if (parent !== item.lead) {
    throw new BridgeError("COORDINATION_FORBIDDEN", "Only the current case lead may record application or verification state");
  } else {
    assertPeerResolutionSources(state, parent, item, record.sources);
    if (record.kind === "peer_resolution_application") {
      const proposal = matchingProposal(state, item, record);
      if (!proposal || !samePeerEvidence(proposal.proposal, record) || !peerRecordCurrent(state, proposal.note, proposal.proposal)) {
        throw new BridgeError("COORDINATION_NOT_ACKNOWLEDGED", "Application must reference an acknowledged exact proposal");
      }
    } else {
      if (!matchingAppliedApplication(state, item, record)) {
        throw new BridgeError("COORDINATION_NOT_ACKNOWLEDGED", "Verification must reference a current applied exact application record");
      }
    }
  }
}
function assertPeerResolutionAcknowledgment(state: ControlState, note: Note, record: PeerResolutionRecord, worker = false): void {
  if (record.kind !== "peer_resolution_proposal") return;
  const item = state.cases.find(candidate => candidate.id === record.case_id);
  if (!item || item.state !== "active" || item.revision !== record.case_revision || item.generation !== record.case_generation) {
    throw new BridgeError("COORDINATION_STALE_REVISION", "Peer-resolution acknowledgment names a stale or closed case version");
  }
  if (peerProposalSuperseded(state, item, record)) throw new BridgeError("COORDINATION_STALE_REVISION", "Peer-resolution acknowledgment names a superseded proposal");
  for (const source of record.sources) {
    const work = state.works.find(candidate => candidate.id === source.work_id);
    const selected = item.inputs.find(input => input.work_id === source.work_id);
    if (!work || !selected || work.revision !== source.work_revision || work.input_oid !== source.input_oid || selected.commit_oid !== source.selected_commit_oid) {
      throw new BridgeError("COORDINATION_STALE_REVISION", "Peer-resolution acknowledgment names stale source evidence");
    }
  }
  if (record.action === "counter_propose" && !peerRecordCurrent(state, note, record)) {
    throw new BridgeError("COORDINATION_STALE_REVISION", "Peer-resolution acknowledgment names a stale counter lineage");
  }
  const expected = worker ? workerPeerParties(state, item).map(party => party.principal) : record.participants;
  if (!sameSet(note.parties, expected)) throw new BridgeError("PEER_RESOLUTION_INVALID", "Peer-resolution acknowledgment parties are not in the proposal");
}
function ownWork(state: ControlState, parent: ParentId, id: string, revision: number): Work {
  const work = visibleWork(state, parent, id);
  if (work.owner !== parent) throw new BridgeError("COORDINATION_FORBIDDEN", "Only the work owner may change its control record");
  if (work.revision !== revision) throw new BridgeError("COORDINATION_STALE_REVISION", "Work revision changed");
  return work;
}
function ownCase(state: ControlState, parent: ParentId, id: string, revision: number, generation: number): Case {
  // Losing input access must not prevent the established lead from releasing its claim.
  const item = state.cases.find(c => c.id === id);
  if (!item || !item.members.includes(parent)) return unavailable();
  if (item.lead !== parent) throw new BridgeError("COORDINATION_FORBIDDEN", "Only the current lead may change this case");
  if (item.generation !== generation) throw new BridgeError("COORDINATION_STALE_GENERATION", "Case leadership changed");
  if (item.revision !== revision) throw new BridgeError("COORDINATION_STALE_REVISION", "Case inputs or state changed");
  if (item.state !== "active") throw new BridgeError("COORDINATION_CASE_CLOSED", "This case has been explicitly closed");
  return item;
}
function idle(item: Case): void {
  if (item.external_effect !== "not_started") throw new BridgeError("COORDINATION_EXTERNAL_EFFECT_UNRESOLVED", "Unmediated integration may still be in progress; explicit settlement is required");
}
function apply(state: ControlState, parent: ParentId, command: Command, observed = false): { entity: Subject; item_id: string } {
  switch (command.kind) {
    case "register_task_work": {
      if (state.works.some(w => w.id === command.managed.task_id)) throw new BridgeError("COORDINATION_TASK_REGISTERED", "This task already has retained coordination work; use its original receipt or read its current metadata");
      if (state.works.some(w => w.state === "active" && w.workspace_id === command.workspace_id)) throw new BridgeError("COORDINATION_WORKSPACE_HELD", "The physical workspace already has a registered writer");
      const id = command.managed.task_id;
      state.works.push({ id, owner: parent, workspace_id: command.workspace_id, revision: 1, state: "active", input_oid: command.input_oid,
        object_format: command.object_format, intent: command.intent, areas: command.areas, readers: [], managed: command.managed });
      return { entity: { kind: "work", id }, item_id: id };
    }
    case "register_work": {
      if (state.works.some(w => w.state === "active" && w.workspace_id === command.workspace_id)) throw new BridgeError("COORDINATION_WORKSPACE_HELD", "The workspace identity already has a registered writer");
      if (command.readers.includes(parent)) throw new BridgeError("COORDINATION_INVALID", "The owner is not a separate reader");
      const id = randomUUID();
      state.works.push({ id, owner: parent, workspace_id: command.workspace_id, revision: 1, state: "active", input_oid: command.input_oid,
        object_format: command.object_format, intent: command.intent, areas: command.areas, readers: command.readers });
      return { entity: { kind: "work", id }, item_id: id };
    }
    case "share_work": case "close_work": case "grant_source": case "watch_source": {
      const work = ownWork(state, parent, command.work_id, command.expected_revision);
      if (command.kind === "share_work") {
        if (command.readers.includes(parent)) throw new BridgeError("COORDINATION_INVALID", "The owner is not a separate reader");
        work.readers = command.readers;
        if (work.source_grants) work.source_grants = [];
        if (work.source_watches) work.source_watches = [];
      } else if (command.kind === "grant_source") {
        if (work.state !== "active") throw new BridgeError("COORDINATION_WORK_CLOSED", "Closed work cannot grant source access");
        if (command.recipients.some(r => r.recipient === parent)) throw new BridgeError("COORDINATION_INVALID", "The owner already has source access");
        work.source_grants = command.recipients.map(r => ({ ...r, work_revision: work.revision + 1 }));
        if (work.source_watches) work.source_watches = [];
      } else if (command.kind === "watch_source") {
        if (work.state !== "active") throw new BridgeError("COORDINATION_WORK_CLOSED", "Closed work cannot publish source watches");
        for (const watcher of command.watchers) if (watcher.recipient !== parent
          && !work.source_grants?.some(g => g.recipient === watcher.recipient && g.work_revision === work.revision)) {
          throw new BridgeError("COORDINATION_FORBIDDEN", "A source watcher requires current report or detail source access");
        }
        if (command.watchers.reduce((sum, watcher) => sum + watcher.regions.length, 0) > MAX_REGIONS) {
          throw new BridgeError("COORDINATION_INVALID", "Source watches exceed the bounded region inventory");
        }
        work.source_watches = command.watchers.map(watcher => ({ ...watcher, work_revision: work.revision + 1 }));
        if (work.source_grants) work.source_grants = work.source_grants.map(grant => ({ ...grant, work_revision: work.revision + 1 }));
      } else {
        if (work.state === "closed") throw new BridgeError("COORDINATION_WORK_CLOSED", "Work was already explicitly closed");
        work.state = "closed";
        if (work.source_grants) work.source_grants = [];
        if (work.source_watches) work.source_watches = [];
      }
      work.revision++; return { entity: { kind: "work", id: work.id }, item_id: work.id };
    }
    case "post_note": {
      requireSubject(state, parent, command.subject);
      for (const party of command.parties) requireSubject(state, party, command.subject);
      const id = randomUUID();
      state.notes.push({ id, subject: command.subject, author: parent, kind: command.note_kind, text: command.text,
        work_refs: command.subject.kind === "work" ? [command.subject.id] : visibleCase(state, parent, command.subject.id).inputs.map(i => i.work_id),
        ...(command.subject.kind === "case" && state.cases.find(item => item.id === command.subject.id)?.observed_origin
          ? { readers: [...state.cases.find(item => item.id === command.subject.id)!.members] }
          : command.subject.kind === "work" ? { readers: [...new Set([
            state.works.find(work => work.id === command.subject.id)!.owner,
            ...state.works.find(work => work.id === command.subject.id)!.readers])] } : {}),
        parties: command.parties, acknowledged: [], withdrawn: false });
      return { entity: command.subject, item_id: id };
    }
    case "ack_note": case "withdraw_note": {
      const note = state.notes.find(n => n.id === command.note_id); if (!note) return unavailable();
      // The author may withdraw an existing statement after losing access; that exposes no new content.
      if (command.kind === "withdraw_note" && note.author === parent) {
        if (note.withdrawn) throw new BridgeError("COORDINATION_NOTE_WITHDRAWN", "Note is already withdrawn");
        note.withdrawn = true;
      } else {
        requireNoteAccess(state, parent, note);
        if (command.kind === "withdraw_note") throw new BridgeError("COORDINATION_FORBIDDEN", "Only the author may withdraw a note");
        if (note.withdrawn) throw new BridgeError("COORDINATION_NOTE_WITHDRAWN", "Withdrawn agreements cannot receive new acknowledgment");
        if (note.kind !== "agreement_proposal" || !note.parties.includes(parent)) throw new BridgeError("COORDINATION_FORBIDDEN", "Only the exact named parties can acknowledge this agreement");
        const peerRecord = retainedPeerRecord(note.text);
        if (peerRecord) assertPeerResolutionAcknowledgment(state, note, peerRecord);
        if (note.acknowledged.includes(parent)) throw new BridgeError("COORDINATION_ALREADY_ACKNOWLEDGED", "Use the original operation key to retrieve an acknowledgment");
        note.acknowledged.push(parent);
      }
      return { entity: note.subject, item_id: note.id };
    }
    case "claim_target": {
      if (state.cases.some(c => c.target === command.target && c.state === "active")) throw new BridgeError("COORDINATION_TARGET_HELD", "A parent already coordinates this target; no claim was acquired");
      const generation = Math.max(0, ...state.cases.filter(c => c.target === command.target).map(c => c.generation)) + 1;
      const id = randomUUID();
      state.cases.push({ id, target: command.target, lead: parent, members: [...new Set([parent, ...command.members])], revision: 1, generation,
        state: "active", external_effect: "not_started", target_oid: null, inputs: [],
        ...(observed ? { observed_origin: "pending" as const } : {}) });
      return { entity: { kind: "case", id }, item_id: id };
    }
    default: {
      const item = ownCase(state, parent, command.case_id, command.expected_revision, command.generation);
      switch (command.kind) {
        case "select_inputs":
          idle(item);
          if (item.observed_origin === "pending" && !observed || observed && item.observed_origin !== "pending")
            throw new BridgeError("COORDINATION_OBSERVED_ORIGIN_UNAVAILABLE", "Observed case selection requires its original elected claim");
          for (const input of command.inputs) for (const member of item.members) visibleWork(state, member, input.work_id);
          item.inputs = command.inputs; item.target_oid = command.target_oid;
          if (observed) item.observed_origin = "selected";
          break;
        case "transfer_case":
          idle(item);
          if (command.new_lead === parent || !item.members.includes(command.new_lead)) throw new BridgeError("COORDINATION_FORBIDDEN", "Handoff requires a different existing case participant");
          visibleCase(state, command.new_lead, item.id);
          item.lead = command.new_lead; item.generation++; break;
        case "begin_external_integration":
          idle(item); visibleCase(state, parent, item.id);
          if (!item.target_oid || !item.inputs.length) throw new BridgeError("COORDINATION_INPUTS_REQUIRED", "Record exact intended inputs and target observation first");
          item.external_effect = "possible"; break;
        case "record_external_settlement":
          if (item.external_effect !== "possible") throw new BridgeError("COORDINATION_NO_EXTERNAL_EFFECT", "There is no reported external operation to settle");
          item.external_effect = "not_started"; break;
        case "release_case": idle(item); item.state = "closed"; break;
      }
      item.revision++; return { entity: { kind: "case", id: item.id }, item_id: item.id };
    }
  }
}
function applyRecovery(state: ControlState, command: RecoveryCommand): void {
  if ("work_id" in command) {
    const work = state.works.find(w => w.id === command.work_id);
    if (!work) return unavailable();
    if (work.owner !== command.expected_owner || work.revision !== command.expected_revision) {
      throw new BridgeError("COORDINATION_STALE_REVISION", "Work ownership or revision changed since operator inspection");
    }
    if (work.state !== "active") throw new BridgeError("COORDINATION_WORK_CLOSED", "Recovery does not reopen closed work");
    if (command.kind === "adopt_work") {
      if (command.new_owner === work.owner) throw new BridgeError("COORDINATION_INVALID", "Adoption requires a different parent");
      work.owner = command.new_owner;
      work.readers = work.readers.filter(p => p !== command.new_owner);
    } else work.state = "closed";
    if (work.source_grants) work.source_grants = [];
    if (work.source_watches) work.source_watches = [];
    work.revision++;
    return;
  }
  const item = state.cases.find(c => c.id === command.case_id);
  if (!item) return unavailable();
  if (item.lead !== command.expected_owner || item.revision !== command.expected_revision) {
    throw new BridgeError("COORDINATION_STALE_REVISION", "Case ownership or revision changed since operator inspection");
  }
  if (item.generation !== command.expected_generation) throw new BridgeError("COORDINATION_STALE_GENERATION", "Case generation changed since operator inspection");
  if (item.state !== "active") throw new BridgeError("COORDINATION_CASE_CLOSED", "Recovery does not reopen a closed case");
  if (command.kind === "settle_case") {
    if (item.external_effect !== "possible") throw new BridgeError("COORDINATION_NO_EXTERNAL_EFFECT", "There is no reported external operation to settle");
    item.external_effect = "not_started";
  } else {
    idle(item);
    if (command.kind === "release_case") item.state = "closed";
    else {
      if (command.new_owner === item.lead) throw new BridgeError("COORDINATION_INVALID", "Adoption requires a different parent");
      // A lead transfer does not grant access to other parents' selected inputs.
      for (const input of item.inputs) visibleWork(state, command.new_owner, input.work_id);
      const members = [...new Set([...item.members, command.new_owner])];
      if (members.length > MAX_PARTIES) throw new BridgeError("COORDINATION_CAPACITY", "Case participant capacity is full");
      item.members = members; item.lead = command.new_owner; item.generation++;
    }
  }
  item.revision++;
}

function overlap(a: Region, b: Region): boolean {
  return a.path === b.path || a.kind === "subtree" && b.path.startsWith(`${a.path}/`) || b.kind === "subtree" && a.path.startsWith(`${b.path}/`);
}
function checkCapacity(state: ControlState): void {
  const { limits } = state;
  // Preserve one explicit close, complete sharing revocation, agreement withdrawal, and external settlement/release path.
  const reserved = releaseSlotsRequired(state);
  if (Buffer.byteLength(`${JSON.stringify(state, null, 2)}\n`) + reserved * CONTROL_RELEASE_BYTES > CONTROL_MAX_BYTES
    || state.works.length > limits.works || state.cases.length > limits.cases || state.notes.length > limits.notes
    || controlReceiptCount(state) + reserved > limits.receipts || state.notes.some(n => Buffer.byteLength(n.text) > limits.note_bytes)) {
    throw new BridgeError("COORDINATION_CAPACITY", "Coordination capacity is exhausted; current records and release opportunities are preserved");
  }
}
