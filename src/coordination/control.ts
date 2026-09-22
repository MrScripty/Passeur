import { randomUUID } from "node:crypto";
import { canonicalHash, Mutex } from "../core/async.js";
import { BridgeError } from "../core/errors.js";
import { CONTROL_MAX_BYTES, CONTROL_RELEASE_BYTES, releaseSlotsRequired, decodeCommand, entityId, parentId, type Case, type Command, type ControlState, type Note,
  coordinationOperationKey, type ParentId, type Receipt, type Region, type Subject, type Work } from "../contracts/coordination-control.js";
import type { CoordinationStore } from "../store/coordination-store.js";

/** The caller is the authenticated service actor, never an actor field taken from a command. */
export type CoordinationActor = Readonly<{ owner_id: string }>;
/** Internal owner only. Source membership, task linkage and public projections are not implemented here. */
export class CoordinationControl {
  readonly #ordering = new Mutex();
  #closing = false;
  constructor(private readonly store: CoordinationStore) {}

  get repositoryId(): string { return this.store.repositoryId; }

  /** A receipt lookup never consults a workspace or restores old control authority. */
  async receipt(actor: CoordinationActor, key: unknown): Promise<Receipt | undefined> {
    const owner = parentId(actor.owner_id), operationKey = coordinationOperationKey(key);
    return this.#ordering.run(async () => structuredClone((await this.store.snapshot()).receipts.find(r => r.owner === owner && r.key === operationKey)));
  }

  /** Capture permission-checked values for read-only Git validation, outside this owner's lock. */
  async prepareSourceCommand(actor: CoordinationActor, raw: unknown): Promise<
    { kind: "recorded"; receipt: Receipt } | { kind: "inspect"; target: Case | null; works: Work[] }
  > {
    const owner = parentId(actor.owner_id), command = decodeCommand(raw);
    if (command.kind !== "claim_target" && command.kind !== "select_inputs" && command.kind !== "begin_external_integration") {
      throw new BridgeError("COORDINATION_OPERATION_UNSUPPORTED", "This operation does not require a Git preflight");
    }
    const hash = canonicalHash({ owner, command });
    return this.#ordering.run(async () => {
      const state = await this.store.snapshot();
      const prior = state.receipts.find(r => r.owner === owner && r.key === command.operation_key);
      if (prior) {
        if (prior.request_hash !== hash) throw new BridgeError("COORDINATION_KEY_CONFLICT", "Operation key already names different intent");
        return { kind: "recorded", receipt: structuredClone(prior) };
      }
      if (command.kind === "claim_target") return { kind: "inspect", target: null, works: [] };
      const target = ownCase(state, owner, command.case_id, command.expected_revision, command.generation);
      idle(target);
      const inputs = command.kind === "select_inputs" ? command.inputs : target.inputs;
      const works = inputs.map(i => visibleWork(state, owner, i.work_id));
      for (const work of works) for (const member of target.members) visibleWork(state, member, work.id);
      return { kind: "inspect", target: structuredClone(target), works: structuredClone(works) };
    });
  }

  async execute(actor: CoordinationActor, input: unknown): Promise<Receipt> {
    const owner = parentId(actor.owner_id), command = decodeCommand(input);
    if (this.#closing) throw new BridgeError("COORDINATION_CLOSED", "Coordination no longer accepts operations");
    const hash = canonicalHash({ owner, command });
    return this.#ordering.run(async () => {
      this.store.assertMutable();
      const current = await this.store.snapshot();
      const prior = current.receipts.find(r => r.owner === owner && r.key === command.operation_key);
      if (prior) {
        if (prior.request_hash !== hash) throw new BridgeError("COORDINATION_KEY_CONFLICT", "Operation key already names different intent");
        // Historical acknowledgment, not a current ownership token or permission to repeat an external effect.
        return structuredClone(prior);
      }
      const next = structuredClone(current);
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
  async work(actor: CoordinationActor, id: string): Promise<Work> {
    const owner = parentId(actor.owner_id), workId = entityId(id);
    return this.#ordering.run(async () => structuredClone(visibleWork(await this.store.snapshot(), owner, workId)));
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
  async close(): Promise<void> {
    this.#closing = true;
    await this.#ordering.run(() => this.store.close());
  }
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
    case "register_work": {
      if (state.works.some(w => w.state === "active" && w.workspace_id === command.workspace_id)) throw new BridgeError("COORDINATION_WORKSPACE_HELD", "The workspace identity already has a registered writer");
      if (command.readers.includes(parent)) throw new BridgeError("COORDINATION_INVALID", "The owner is not a separate reader");
      const id = randomUUID();
      state.works.push({ id, owner: parent, workspace_id: command.workspace_id, revision: 1, state: "active", input_oid: command.input_oid,
        object_format: command.object_format, intent: command.intent, areas: command.areas, readers: command.readers });
      return { entity: { kind: "work", id }, item_id: id };
    }
    case "share_work": case "close_work": {
      const work = ownWork(state, parent, command.work_id, command.expected_revision);
      if (command.kind === "share_work") {
        if (command.readers.includes(parent)) throw new BridgeError("COORDINATION_INVALID", "The owner is not a separate reader");
        work.readers = command.readers;
      } else {
        if (work.state === "closed") throw new BridgeError("COORDINATION_WORK_CLOSED", "Work was already explicitly closed");
        work.state = "closed";
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
function overlap(a: Region, b: Region): boolean {
  return a.path === b.path || a.kind === "subtree" && b.path.startsWith(`${a.path}/`) || b.kind === "subtree" && a.path.startsWith(`${b.path}/`);
}
function checkCapacity(state: ControlState): void {
  const { limits } = state;
  // Preserve one explicit close, complete sharing revocation, agreement withdrawal, and external settlement/release path.
  const reserved = releaseSlotsRequired(state);
  if (Buffer.byteLength(`${JSON.stringify(state, null, 2)}\n`) + reserved * CONTROL_RELEASE_BYTES > CONTROL_MAX_BYTES
    || state.works.length > limits.works || state.cases.length > limits.cases || state.notes.length > limits.notes
    || state.receipts.length + reserved > limits.receipts || state.notes.some(n => Buffer.byteLength(n.text) > limits.note_bytes)) {
    throw new BridgeError("COORDINATION_CAPACITY", "Coordination capacity is exhausted; current records and release opportunities are preserved");
  }
}
