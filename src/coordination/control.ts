import { randomUUID } from "node:crypto";
import { canonicalHash, Mutex } from "../core/async.js";
import { BridgeError } from "../core/errors.js";
import { MANAGED_CONTROL_SCHEMA, SUBMISSION_CONTROL_SCHEMA, SOURCE_GRANT_CONTROL_SCHEMA, SOURCE_WATCH_CONTROL_SCHEMA, CONTROL_MAX_BYTES, CONTROL_RELEASE_BYTES, releaseSlotsRequired, decodeCommand, entityId, parentId, type Case, type Command, type ControlState, type Note,
  coordinationOperationKey, controlReceiptCount, recoveryReceipts, decodeRecoveryCommand, MAX_PARTIES, MAX_REGIONS, type RecoveryCommand, type RecoveryReceipt, type ParentId, type Receipt, type Region, type Subject, type Work } from "../contracts/coordination-control.js";
import { announcements, submissionBindings, submissionEvents, decodeAnnouncementInput, decodeAnnouncementWithdrawalInput,
  decodeSubmissionPreflightInput, decodeSubmissionBindInput, decodeSubmissionDispositionInput, decodeSubmissionTerminalInput,
  type AnnouncementRecord, type SubmissionBinding, type SubmissionEvent, type SubmissionPreflightInput } from "../contracts/coordination-control.js";
import type { CoordinationStore } from "../store/coordination-store.js";

/** The caller is the authenticated service actor, never an actor field taken from a command. */
export type CoordinationActor = Readonly<{ owner_id: string }>;
export type SourceVersions = ReadonlyArray<Readonly<{ task_id: string; version: number }>>;
export type RetirementReservation = Readonly<{ release(): Promise<void> }>;
/** Owns metadata transitions and their ordering against Passeur-owned retirement, not Git effects. */
export class CoordinationControl {
  readonly #ordering = new Mutex();
  #closing = false;
  readonly #resourceVersions = new Map<string, number>();
  readonly #retirements = new Map<string, Promise<void>>();
  constructor(private readonly store: CoordinationStore) {}

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
      checkCapacity(next); await this.store.publish(current, next); return structuredClone(item);
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
      checkCapacity(next); await this.store.publish(current, next); return structuredClone(item);
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
      checkCapacity(next); await this.store.publish(current, next); return structuredClone(item);
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
      checkCapacity(next); await this.store.publish(current, next); return structuredClone(item);
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
      checkCapacity(next); await this.store.publish(current, next); return structuredClone(item);
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

  async execute(actor: CoordinationActor, input: unknown, sourceVersions?: SourceVersions): Promise<Receipt> {
    const owner = parentId(actor.owner_id), command = decodeCommand(input);
    const versions = sourceVersions ? sourceVersions.map(v => ({ ...v })) : [];
    if (this.#closing) throw new BridgeError("COORDINATION_CLOSED", "Coordination no longer accepts operations");
    const hash = canonicalHash({ owner, command });
    return this.#ordering.run(async () => {
      this.store.assertMutable();
      const current = await this.store.snapshot();
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
      const next: ControlState = command.kind === "watch_source"
        ? current.schema_version === SOURCE_WATCH_CONTROL_SCHEMA ? structuredClone(current)
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
      const result = apply(next, owner, command);
      next.revision++;
      const receipt: Receipt = { owner, key: command.operation_key, request_hash: hash, revision: next.revision,
        action: command.kind, entity: result.entity, item_id: result.item_id, outcome: "recorded" };
      next.receipts.push(receipt);
      checkCapacity(next);
      await this.store.publish(current, next);
      return structuredClone(receipt);
    });
  }
  /** Only the service's verified operator path calls this method. No process or Git effect is performed. */
  async recoverAuthorized(actor: CoordinationActor, input: unknown): Promise<RecoveryReceipt> {
    const operator = parentId(actor.owner_id), recovery = decodeRecoveryCommand(input);
    if (this.#closing) throw new BridgeError("COORDINATION_CLOSED", "Coordination no longer accepts operations");
    const request_hash = canonicalHash({ operator, recovery });
    return this.#ordering.run(async () => {
      this.store.assertMutable();
      const current = await this.store.snapshot();
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
      const next: Exclude<ControlState, { schema_version: 1 }> = current.schema_version === 4 || current.schema_version === 5 || current.schema_version === 6 ? structuredClone(current) : {
        ...structuredClone(current), schema_version: current.schema_version === MANAGED_CONTROL_SCHEMA ? MANAGED_CONTROL_SCHEMA : 2,
        recoveries: structuredClone([...recoveryReceipts(current)]),
      };
      applyRecovery(next, recovery);
      next.revision++;
      const receipt: RecoveryReceipt = { operator, request_hash, revision: next.revision, command: recovery };
      next.recoveries.push(receipt);
      checkCapacity(next);
      // One atomic publication owns the version transition, metadata update and attributed acknowledgment.
      await this.store.publish(current, next);
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
  async note(actor: CoordinationActor, id: string): Promise<Note & { agreement: "not_applicable" | "pending" | "acknowledged" | "withdrawn" }> {
    const owner = parentId(actor.owner_id), noteId = entityId(id);
    return this.#ordering.run(async () => {
      const state = await this.store.snapshot(), note = state.notes.find(n => n.id === noteId);
      if (!note) return unavailable();
      requireNoteAccess(state, owner, note);
      const agreement = note.kind !== "agreement_proposal" ? "not_applicable" : note.withdrawn ? "withdrawn"
        : note.parties.every(p => note.acknowledged.includes(p)) ? "acknowledged" : "pending";
      return { ...structuredClone(note), agreement };
    });
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
      return state.works.filter(w => w.id !== id && w.state === "active" && canReadWork(owner, w))
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
    await Promise.all([...this.#retirements.values()]);
    await this.#ordering.run(() => this.store.close());
  }
}
function submissionState(current: ControlState): Extract<ControlState, { schema_version: 4 | 5 | 6 }> {
  return current.schema_version === 4 || current.schema_version === 5 || current.schema_version === 6 ? structuredClone(current) : {
    ...structuredClone(current), schema_version: SUBMISSION_CONTROL_SCHEMA,
    recoveries: structuredClone([...recoveryReceipts(current)]), announcements: [], bindings: [], submission_events: [],
  };
}
function sameSubmissionKey(state: ControlState, owner: ParentId, key: string, hash: string): SubmissionEvent | undefined {
  if (state.receipts.some(r => r.owner === owner && r.key === key)
    || recoveryReceipts(state).some(r => r.operator === owner && r.command.operation_key === key)) {
    throw new BridgeError("COORDINATION_KEY_CONFLICT", "Operation key names another retained metadata action");
  }
  const prior = submissionEvents(state).find(e => e.owner === owner && e.key === key);
  if (prior && prior.request_hash !== hash) throw new BridgeError("COORDINATION_KEY_CONFLICT", "Operation key names different submission intent");
  return prior;
}
function appendSubmissionEvent(next: Extract<ControlState, { schema_version: 4 | 5 | 6 }>, kind: SubmissionEvent["kind"],
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
    ...state.works.filter(w => w.state === "active" && canReadWork(owner, w))
      .map(w => ({ kind: "work" as const, id: w.id, revision: w.revision,
        areas: w.areas.filter(area => input.areas.some(b => overlap(area, b))) })).filter(w => w.areas.length),
    ...announcements(state).filter(a => a.state === "unresolved" && a.id !== input.announcement?.id
      && (a.owner === owner || a.readers.includes(owner)))
      .map(a => ({ kind: "announcement" as const, id: a.id, revision: a.revision,
        areas: a.areas.filter(area => input.areas.some(b => overlap(area, b))) })).filter(a => a.areas.length),
    ...submissionBindings(state).filter(b => (b.state === "bound" || b.state === "settled") &&
      (b.owner === owner || b.announcement && announcements(state).some(a => a.id === b.announcement!.id && a.readers.includes(owner)))
      && !state.works.some(w => w.managed?.task_id === b.task_id && canReadWork(owner, w)))
      .map(b => ({ kind: "binding" as const, id: b.task_id, revision: b.announcement?.revision ?? 0,
        areas: b.areas.filter(area => input.areas.some(other => overlap(area, other))) })).filter(b => b.areas.length),
  ].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  const decision_identity = canonicalHash({ owner, source_view: input.source_view, input_oid: input.input_oid,
    intent_hash: input.intent_hash, areas: input.areas, announcement: input.announcement ?? null, overlaps });
  return { decision_identity, overlaps: overlaps.map(({ kind, id, areas }) => ({ kind, id, areas })) };
}
function unavailable(): never { throw new BridgeError("COORDINATION_NOT_FOUND", "The subject is unavailable under current sharing authority"); }
function canReadWork(parent: ParentId, work: Work): boolean { return work.owner === parent || work.readers.includes(parent); }
function visibleWork(state: ControlState, parent: ParentId, id: string): Work {
  const work = state.works.find(w => w.id === id); if (!work || !canReadWork(parent, work)) return unavailable(); return work;
}
function canReadCase(state: ControlState, parent: ParentId, item: Case): boolean {
  return item.members.includes(parent) && item.inputs.every(i => { const work = state.works.find(w => w.id === i.work_id); return work !== undefined && canReadWork(parent, work); });
}
function visibleCase(state: ControlState, parent: ParentId, id: string): Case {
  const item = state.cases.find(c => c.id === id); if (!item || !canReadCase(state, parent, item)) return unavailable(); return item;
}
function requireSubject(state: ControlState, parent: ParentId, subject: Subject): void {
  if (subject.kind === "work") visibleWork(state, parent, subject.id); else visibleCase(state, parent, subject.id);
}
function requireNoteAccess(state: ControlState, parent: ParentId, note: Note): void {
  requireSubject(state, parent, note.subject);
  for (const id of note.work_refs) visibleWork(state, parent, id);
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
function apply(state: ControlState, parent: ParentId, command: Command): { entity: Subject; item_id: string } {
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
        state: "active", external_effect: "not_started", target_oid: null, inputs: [] });
      return { entity: { kind: "case", id }, item_id: id };
    }
    default: {
      const item = ownCase(state, parent, command.case_id, command.expected_revision, command.generation);
      switch (command.kind) {
        case "select_inputs":
          idle(item);
          for (const input of command.inputs) for (const member of item.members) visibleWork(state, member, input.work_id);
          item.inputs = command.inputs; item.target_oid = command.target_oid; break;
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
