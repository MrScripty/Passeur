import { canonicalHash } from "../core/async.js";
import { BridgeError } from "../core/errors.js";

/** Owned internal/persisted contract. Transport authorization is a separate boundary. */
export const CONTROL_SCHEMA = 1;
export const CONTROL_MAX_BYTES = 2 * 1024 * 1024;
// More than the worst-case escaped closure receipt and its bounded counter changes.
export const CONTROL_RELEASE_BYTES = 4096;
const MAX_ENTITIES = 4096;
export const MAX_PARTIES = 64;
export const MAX_REGIONS = 256;
export const MAX_NOTE_BYTES = 16_384;
export type ParentId = string;
export type Region = { kind: "file" | "subtree"; path: string };
export type Subject = { kind: "work" | "case"; id: string };
export type Selection = { work_id: string; commit_oid: string };
export type Limits = { works: number; cases: number; notes: number; receipts: number; note_bytes: number };
export type Work = {
  id: string; owner: ParentId; workspace_id: string; revision: number;
  state: "active" | "closed"; input_oid: string; object_format: "sha1" | "sha256";
  intent: string; areas: Region[]; readers: ParentId[];
};
export type Case = {
  id: string; target: string; lead: ParentId; members: ParentId[];
  revision: number; generation: number; state: "active" | "closed";
  external_effect: "not_started" | "possible"; target_oid: string | null; inputs: Selection[];
};
export type Note = {
  id: string; subject: Subject; author: ParentId;
  kind: "intent" | "question" | "statement" | "agreement_proposal" | "resolution_update";
  text: string; work_refs: string[]; parties: ParentId[]; acknowledged: ParentId[]; withdrawn: boolean;
};
export type Receipt = {
  owner: ParentId; key: string; request_hash: string; revision: number;
  action: Command["kind"]; entity: Subject; item_id: string; outcome: "recorded";
};
type ControlData = {
  repository_id: string; epoch: string; revision: number; limits: Limits;
  works: Work[]; cases: Case[]; notes: Note[]; receipts: Receipt[];
};
/** Existing state stays v1 until one authorized recovery atomically publishes v2. */
export type ControlState = ControlData & (
  | { schema_version: 1 }
  | { schema_version: 2; recoveries: RecoveryReceipt[] }
);
export type RecoveryCommand = {
  operation_key: string; epoch: string; expected_owner: ParentId;
  expected_revision: number; statement: string;
} & (
  | { kind: "adopt_work"; work_id: string; new_owner: ParentId }
  | { kind: "close_work"; work_id: string }
  | { kind: "adopt_case"; case_id: string; expected_generation: number; new_owner: ParentId }
  | { kind: "release_case"; case_id: string; expected_generation: number }
  | { kind: "settle_case"; case_id: string; expected_generation: number }
);
export type RecoveryReceipt = {
  operator: ParentId; request_hash: string; revision: number; command: RecoveryCommand;
};
const recoveryActions = ["adopt_work", "close_work", "adopt_case", "release_case", "settle_case"] as const;
// A bounded operator attribution or evidence reference, not a generated explanation or process proof.
export const RECOVERY_STATEMENT_BYTES = 256;
export function recoveryReceipts(state: ControlState): readonly RecoveryReceipt[] {
  return state.schema_version === 2 ? state.recoveries : [];
}
export function controlReceiptCount(state: ControlState): number {
  return state.receipts.length + recoveryReceipts(state).length;
}

export type Command =
  | { kind: "register_work"; operation_key: string; workspace_id: string; input_oid: string;
      object_format: "sha1" | "sha256"; intent: string; areas: Region[]; readers: ParentId[] }
  | { kind: "share_work"; operation_key: string; work_id: string; expected_revision: number; readers: ParentId[] }
  | { kind: "close_work"; operation_key: string; work_id: string; expected_revision: number }
  | { kind: "post_note"; operation_key: string; subject: Subject; note_kind: Note["kind"]; text: string; parties: ParentId[] }
  | { kind: "ack_note" | "withdraw_note"; operation_key: string; note_id: string }
  | { kind: "claim_target"; operation_key: string; target: string; members: ParentId[] }
  | { kind: "select_inputs"; operation_key: string; case_id: string; expected_revision: number;
      generation: number; target_oid: string; inputs: Selection[] }
  | { kind: "release_case" | "begin_external_integration" | "record_external_settlement";
      operation_key: string; case_id: string; expected_revision: number; generation: number }
  | { kind: "transfer_case"; operation_key: string; case_id: string; expected_revision: number;
      generation: number; new_lead: ParentId };
const actions = ["register_work", "share_work", "close_work", "post_note", "ack_note", "withdraw_note", "claim_target",
  "select_inputs", "release_case", "begin_external_integration", "record_external_settlement", "transfer_case"] as const;
const noteKinds = ["intent", "question", "statement", "agreement_proposal", "resolution_update"] as const;

function invalid(message: string): never { throw new BridgeError("COORDINATION_INVALID", message); }
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid("Expected a record");
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) invalid("Expected a plain record");
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !Object.getOwnPropertyDescriptor(value, key)!.enumerable || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value")) invalid("Accessors and symbol fields are not contract values");
  }
  return Object.fromEntries(Object.entries(value));
}
function fields(value: Record<string, unknown>, names: readonly string[]): void {
  if (Object.keys(value).length !== names.length || names.some((key) => !Object.hasOwn(value, key))) invalid("Record fields do not match the selected contract");
  if (Reflect.ownKeys(value).length !== names.length) invalid("Symbol/hidden fields are not supported");
  for (const name of names) if (!Object.hasOwn(Object.getOwnPropertyDescriptor(value, name)!, "value")) invalid("Accessors are not contract values");
}
function text(value: unknown, maximum: number, empty = false): string {
  if (typeof value !== "string" || (!empty && !value.length) || Buffer.from(value, "utf8").toString("utf8") !== value || Buffer.byteLength(value) > maximum || value.includes("\0")) invalid("Text violates its byte/encoding contract");
  return value;
}
function number(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid("Expected a bounded safe integer");
  return value;
}
function boolean(value: unknown): boolean { if (typeof value !== "boolean") invalid("Expected a boolean"); return value; }
function choice<T extends string>(value: unknown, options: readonly T[]): T {
  for (const option of options) if (value === option) return option;
  return invalid("Unsupported value for selected field");
}
function list<T>(value: unknown, maximum: number, decode: (item: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > maximum) invalid("Expected a bounded array");
  return Array.from(value, decode);
}
function unique<T>(items: T[], key: (item: T) => string): T[] {
  if (new Set(items.map(key)).size !== items.length) invalid("Duplicate identity in record");
  return items;
}
export function parentId(value: unknown): ParentId {
  const v = text(value, 64); if (!/^[a-f0-9]{64}$/.test(v)) invalid("Expected an authenticated parent identity"); return v;
}
export function entityId(value: unknown): string {
  const v = text(value, 36); if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v)) invalid("Expected an entity UUID"); return v;
}
function digest(value: unknown): string { const v = text(value, 64); if (!/^[a-f0-9]{64}$/.test(v)) invalid("Expected a SHA-256 identity"); return v; }
export function coordinationOid(value: unknown): string { const v = text(value, 64); if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(v)) invalid("Expected a full Git object identity"); return v; }
function formatOid(commit: string, format: Work["object_format"]): void { if (commit.length !== (format === "sha1" ? 40 : 64)) invalid("Object identity contradicts the Git object format"); }
function parents(value: unknown): ParentId[] { return unique(list(value, MAX_PARTIES, parentId), x => x); }
function path(value: unknown): string {
  const v = text(value, 4096);
  if (v.startsWith("/") || v.split("/").some(x => x === "" || x === "." || x === "..")) invalid("Expected a component-relative Git path");
  return v;
}
function region(value: unknown): Region { const v = object(value); fields(v, ["kind", "path"]); return { kind: choice(v.kind, ["file", "subtree"]), path: path(v.path) }; }
function regions(value: unknown): Region[] { return unique(list(value, MAX_REGIONS, region), x => `${x.kind}:${x.path}`); }
function subject(value: unknown): Subject { const v = object(value); fields(v, ["kind", "id"]); return { kind: choice(v.kind, ["work", "case"]), id: entityId(v.id) }; }
export function coordinationTarget(value: unknown): string {
  // Logical target identity only. Git existence/legality is checked by its owner before integration.
  const v = text(value, 512); if (!v.startsWith("refs/heads/") || v.length === 11 || /[\r\n\0]/.test(v)) invalid("Expected a full local target ref"); return v;
}
function selections(value: unknown): Selection[] {
  return unique(list(value, MAX_REGIONS, item => {
    const v = object(item); fields(v, ["work_id", "commit_oid"]); return { work_id: entityId(v.work_id), commit_oid: coordinationOid(v.commit_oid) };
  }), x => x.work_id);
}
export function decodeLimits(value: unknown): Limits {
  const v = object(value); fields(v, ["works", "cases", "notes", "receipts", "note_bytes"]);
  return { works: number(v.works, 1, MAX_ENTITIES), cases: number(v.cases, 1, MAX_ENTITIES), notes: number(v.notes, 1, MAX_ENTITIES),
    receipts: number(v.receipts, 1, MAX_ENTITIES), note_bytes: number(v.note_bytes, 1, MAX_NOTE_BYTES) };
}
export function decodeCommand(value: unknown): Command {
  const v = object(value);
  if (typeof v.kind === "string" && !actions.some(action => action === v.kind)) throw new BridgeError("COORDINATION_OPERATION_UNSUPPORTED", "The operation has no implemented handler");
  const kind = choice(v.kind, actions), operation_key = text(v.operation_key, 256);
  switch (kind) {
    case "register_work": {
      fields(v, ["kind", "operation_key", "workspace_id", "input_oid", "object_format", "intent", "areas", "readers"]);
      const object_format = choice(v.object_format, ["sha1", "sha256"]), input_oid = coordinationOid(v.input_oid); formatOid(input_oid, object_format);
      return { kind, operation_key, workspace_id: text(v.workspace_id, 4096), input_oid, object_format, intent: text(v.intent, 4096, true), areas: regions(v.areas), readers: parents(v.readers) };
    }
    case "share_work": fields(v, ["kind", "operation_key", "work_id", "expected_revision", "readers"]);
      return { kind, operation_key, work_id: entityId(v.work_id), expected_revision: number(v.expected_revision, 1), readers: parents(v.readers) };
    case "close_work": fields(v, ["kind", "operation_key", "work_id", "expected_revision"]);
      return { kind, operation_key, work_id: entityId(v.work_id), expected_revision: number(v.expected_revision, 1) };
    case "post_note": {
      fields(v, ["kind", "operation_key", "subject", "note_kind", "text", "parties"]);
      const note_kind = choice(v.note_kind, noteKinds), parties = parents(v.parties);
      if ((note_kind === "agreement_proposal") !== (parties.length > 0)) invalid("Only agreements name a nonempty set of required acknowledgments");
      return { kind, operation_key, subject: subject(v.subject), note_kind, text: text(v.text, MAX_NOTE_BYTES), parties };
    }
    case "ack_note": case "withdraw_note": fields(v, ["kind", "operation_key", "note_id"]);
      return { kind, operation_key, note_id: entityId(v.note_id) };
    case "claim_target": fields(v, ["kind", "operation_key", "target", "members"]);
      return { kind, operation_key, target: coordinationTarget(v.target), members: parents(v.members) };
    case "select_inputs": fields(v, ["kind", "operation_key", "case_id", "expected_revision", "generation", "target_oid", "inputs"]);
      return { kind, operation_key, case_id: entityId(v.case_id), expected_revision: number(v.expected_revision, 1), generation: number(v.generation, 1), target_oid: coordinationOid(v.target_oid), inputs: selections(v.inputs) };
    case "transfer_case": fields(v, ["kind", "operation_key", "case_id", "expected_revision", "generation", "new_lead"]);
      return { kind, operation_key, case_id: entityId(v.case_id), expected_revision: number(v.expected_revision, 1), generation: number(v.generation, 1), new_lead: parentId(v.new_lead) };
    default: fields(v, ["kind", "operation_key", "case_id", "expected_revision", "generation"]);
      return { kind, operation_key, case_id: entityId(v.case_id), expected_revision: number(v.expected_revision, 1), generation: number(v.generation, 1) };
  }
}
function work(value: unknown): Work {
  const v = object(value); fields(v, ["id", "owner", "workspace_id", "revision", "state", "input_oid", "object_format", "intent", "areas", "readers"]);
  const object_format = choice(v.object_format, ["sha1", "sha256"]), input_oid = coordinationOid(v.input_oid); formatOid(input_oid, object_format);
  return { id: entityId(v.id), owner: parentId(v.owner), workspace_id: text(v.workspace_id, 4096), revision: number(v.revision, 1),
    state: choice(v.state, ["active", "closed"]), input_oid, object_format, intent: text(v.intent, 4096, true), areas: regions(v.areas), readers: parents(v.readers) };
}
function caseRecord(value: unknown): Case {
  const v = object(value); fields(v, ["id", "target", "lead", "members", "revision", "generation", "state", "external_effect", "target_oid", "inputs"]);
  return { id: entityId(v.id), target: coordinationTarget(v.target), lead: parentId(v.lead), members: parents(v.members), revision: number(v.revision, 1),
    generation: number(v.generation, 1), state: choice(v.state, ["active", "closed"]), external_effect: choice(v.external_effect, ["not_started", "possible"]),
    target_oid: v.target_oid === null ? null : coordinationOid(v.target_oid), inputs: selections(v.inputs) };
}
function note(value: unknown): Note {
  const v = object(value); fields(v, ["id", "subject", "author", "kind", "text", "work_refs", "parties", "acknowledged", "withdrawn"]);
  const kind = choice(v.kind, noteKinds), parties = parents(v.parties), acknowledged = parents(v.acknowledged);
  if ((kind === "agreement_proposal") !== (parties.length > 0) || acknowledged.some(p => !parties.includes(p))) invalid("Acknowledgments contradict the exact named agreement parties");
  return { id: entityId(v.id), subject: subject(v.subject), author: parentId(v.author), kind, text: text(v.text, MAX_NOTE_BYTES), work_refs: unique(list(v.work_refs, MAX_REGIONS, entityId), x => x), parties, acknowledged, withdrawn: boolean(v.withdrawn) };
}
function receipt(value: unknown): Receipt {
  const v = object(value); fields(v, ["owner", "key", "request_hash", "revision", "action", "entity", "item_id", "outcome"]);
  return { owner: parentId(v.owner), key: text(v.key, 256), request_hash: digest(v.request_hash), revision: number(v.revision, 1),
    action: choice(v.action, actions), entity: subject(v.entity), item_id: entityId(v.item_id), outcome: choice(v.outcome, ["recorded"]) };
}
export function decodeControl(value: unknown, expectedRepository: string): ControlState {
  const v = object(value);
  if (typeof v.schema_version === "number" && Number.isSafeInteger(v.schema_version) && v.schema_version > 0 && v.schema_version !== CONTROL_SCHEMA && v.schema_version !== 2) throw new BridgeError("COORDINATION_VERSION_UNSUPPORTED", "The control version has no supported reader");
  fields(v, ["schema_version", "repository_id", "epoch", "revision", "limits", "works", "cases", "notes", "receipts", ...(v.schema_version === 2 ? ["recoveries"] : [])]);
  if (v.schema_version !== CONTROL_SCHEMA && v.schema_version !== 2) invalid("Missing or malformed control schema version");
  const repository_id = text(v.repository_id, 256); if (repository_id !== expectedRepository) throw new BridgeError("COORDINATION_BINDING_CONFLICT", "Control belongs to another repository");
  const limits = decodeLimits(v.limits), revision = number(v.revision);
  const works = unique(list(v.works, limits.works, work), x => x.id), cases = unique(list(v.cases, limits.cases, caseRecord), x => x.id);
  const notes = unique(list(v.notes, limits.notes, note), x => x.id), receipts = unique(list(v.receipts, limits.receipts, receipt), x => `${x.owner}:${x.key}`);
  const recoveries = v.schema_version === 2 ? list(v.recoveries, limits.receipts, decodeRecoveryReceipt) : [];
  if (v.schema_version === 2 && recoveries.length === 0) invalid("Recovery storage requires its first atomic recovery receipt");
  if (receipts.length + recoveries.length > limits.receipts) invalid("Receipt capacity includes operator recovery history");
  unique([...receipts.map(r => `${r.owner}:${r.key}`), ...recoveries.map(r => `${r.operator}:${r.command.operation_key}`)], x => x);
  unique(works.filter(x => x.state === "active"), x => x.workspace_id);
  unique(cases.filter(x => x.state === "active"), x => x.target);
  const allIds = [...works.map(x => x.id), ...cases.map(x => x.id), ...notes.map(x => x.id)]; unique(allIds, x => x);
  const workMap = new Map(works.map(w => [w.id, w])), caseMap = new Map(cases.map(c => [c.id, c]));
  for (const w of works) if (w.revision > revision || w.readers.includes(w.owner)) invalid("Work revision/sharing contradicts its owner");
  for (const c of cases) {
    if (c.revision > revision || c.generation > revision || !c.members.includes(c.lead) || c.state === "closed" && c.external_effect !== "not_started") invalid("Case lifecycle contradicts its authority");
    if (c.inputs.length && !c.target_oid) invalid("Selected inputs need an explicit target observation");
    for (const input of c.inputs) { const w = workMap.get(input.work_id); if (!w) invalid("Case input references missing work"); formatOid(input.commit_oid, w.object_format); if (c.target_oid) formatOid(c.target_oid, w.object_format); }
  }
  for (const n of notes) {
    if (n.work_refs.some(id => !workMap.has(id)) || n.subject.kind === "work" && (n.work_refs.length !== 1 || n.work_refs[0] !== n.subject.id) || Buffer.byteLength(n.text) > limits.note_bytes || !(n.subject.kind === "work" ? workMap.has(n.subject.id) : caseMap.has(n.subject.id))) invalid("Note violates retention bounds or references a missing subject");
  }
  unique([...receipts.map(r => r.revision), ...recoveries.map(r => r.revision)], String);
  if (receipts.length + recoveries.length !== revision) invalid("Control revision and retained receipt history disagree");
  for (const r of receipts) if (!allIds.includes(r.item_id) || r.revision > revision || !(r.entity.kind === "work" ? workMap.has(r.entity.id) : caseMap.has(r.entity.id))) invalid("Receipt references missing state or a future revision");
  const epoch = entityId(v.epoch);
  for (const r of recoveries) {
    const c = r.command;
    if (r.revision > revision || c.epoch !== epoch || c.expected_revision >= r.revision
      || ("work_id" in c ? !workMap.has(c.work_id) : !caseMap.has(c.case_id))) invalid("Recovery references missing state or contradicts its revision/epoch");
  }
  const data = { repository_id, epoch, revision, limits, works, cases, notes, receipts };
  return v.schema_version === 2 ? { schema_version: 2, ...data, recoveries } : { schema_version: 1, ...data };
}
export function emptyControl(repository: string, epoch: string, limits: unknown): ControlState {
  return decodeControl({ schema_version: CONTROL_SCHEMA, repository_id: repository, epoch, revision: 0, limits, works: [], cases: [], notes: [], receipts: [] }, repository);
}

/** Recovery is a separate operator contract; ordinary command decoding never accepts it. */
export function decodeRecoveryCommand(value: unknown): RecoveryCommand {
  const v = object(value);
  if (typeof v.kind === "string" && !recoveryActions.some(kind => kind === v.kind)) throw new BridgeError("COORDINATION_RECOVERY_OPERATION_UNSUPPORTED", "The operator recovery action is not supported");
  const kind = choice(v.kind, recoveryActions);
  const common = ["kind", "operation_key", "epoch", "expected_owner", "expected_revision", "statement"];
  const base = { operation_key: coordinationOperationKey(v.operation_key), epoch: entityId(v.epoch),
    expected_owner: parentId(v.expected_owner), expected_revision: number(v.expected_revision, 1),
    statement: text(v.statement, RECOVERY_STATEMENT_BYTES) };
  if (!base.statement.trim().length) invalid("Recovery needs an operator statement or evidence reference");
  if (kind === "adopt_work" || kind === "close_work") {
    fields(v, [...common, "work_id", ...(kind === "adopt_work" ? ["new_owner"] : [])]);
    const work_id = entityId(v.work_id);
    return kind === "adopt_work" ? { ...base, kind, work_id, new_owner: parentId(v.new_owner) } : { ...base, kind, work_id };
  }
  fields(v, [...common, "case_id", "expected_generation", ...(kind === "adopt_case" ? ["new_owner"] : [])]);
  const case_id = entityId(v.case_id), expected_generation = number(v.expected_generation, 1);
  return kind === "adopt_case" ? { ...base, kind, case_id, expected_generation, new_owner: parentId(v.new_owner) }
    : { ...base, kind, case_id, expected_generation };
}
export function decodeRecoveryReceipt(value: unknown): RecoveryReceipt {
  const v = object(value); fields(v, ["operator", "request_hash", "revision", "command"]);
  const operator = parentId(v.operator), command = decodeRecoveryCommand(v.command), request_hash = digest(v.request_hash);
  if (request_hash !== canonicalHash({ operator, recovery: command })) invalid("Recovery receipt does not match its attributed request");
  const revision = number(v.revision, 1);
  if (revision <= command.expected_revision || "expected_generation" in command && revision <= command.expected_generation) invalid("Recovery acknowledgment precedes its requested state");
  return { operator, command, request_hash, revision };
}

/** Capacity owed to explicit terminal/revocation operations, not elapsed-time reclamation. */
export function releaseSlotsRequired(state: ControlState): number {
  return state.works.reduce((n, w) => n + Number(w.state === "active") + Number(w.readers.length > 0), 0)
    + state.cases.reduce((n, c) => n + (c.state === "active" ? c.external_effect === "possible" ? 2 : 1 : 0), 0)
    + state.notes.filter(n => !n.withdrawn && n.kind === "agreement_proposal").length;
}

/** Persisted history may advance only through append/owned mutable fields; migration is separate. */
export function assertControlTransition(before: ControlState, next: ControlState): void {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (before.epoch !== next.epoch || before.repository_id !== next.repository_id || !same(before.limits, next.limits)
    || next.revision !== before.revision + 1) invalid("Publication contradicts the current control identity or revision");
  const oldRecoveries = recoveryReceipts(before), newRecoveries = recoveryReceipts(next);
  if (next.schema_version < before.schema_version || oldRecoveries.some((r, i) => !same(r, newRecoveries[i]))) invalid("Recovery history or supported storage version was rewritten");
  const recovered = newRecoveries.length === oldRecoveries.length + 1 ? newRecoveries.at(-1) : undefined;
  if (recovered) {
    if (next.schema_version !== 2 || recovered.revision !== next.revision || before.receipts.length !== next.receipts.length) invalid("Recovery publication must append exactly its own receipt");
    assertRecoveryTransition(before, next, recovered.command);
  } else if (newRecoveries.length !== oldRecoveries.length || next.receipts.length !== before.receipts.length + 1 || next.schema_version !== before.schema_version) {
    invalid("A control publication appends one ordinary or recovery receipt");
  }
  if (before.receipts.some((r, i) => !same(r, next.receipts[i]))) invalid("Accepted operation receipts are immutable");
  for (const old of before.works) {
    const item = next.works.find(w => w.id === old.id); if (!item) invalid("Retained work cannot disappear during a control update");
    if (recovered && "work_id" in recovered.command && recovered.command.work_id === old.id) continue;
    const { revision: a, state: oldState, readers: _oldReaders, ...oldIdentity } = old;
    const { revision: b, state: newState, readers: _newReaders, ...newIdentity } = item;
    if (!same(oldIdentity, newIdentity) || b < a || b > a + 1 || oldState === "closed" && newState !== "closed"
      || b === a && !same(old, item)) invalid("Work identity, closure or revision was rewritten");
  }
  for (const old of before.cases) {
    const item = next.cases.find(c => c.id === old.id); if (!item) invalid("Retained cases cannot disappear during a control update");
    if (recovered && "case_id" in recovered.command && recovered.command.case_id === old.id) continue;
    if (old.target !== item.target || !same(old.members, item.members) || item.revision < old.revision || item.revision > old.revision + 1
      || item.generation < old.generation || item.generation > old.generation + 1 || old.lead !== item.lead && item.generation !== old.generation + 1
      || old.state === "closed" && !same(old, item) || old.revision === item.revision && !same(old, item)) invalid("Case identity, generation or closure was rewritten");
  }
  for (const old of before.notes) {
    const item = next.notes.find(n => n.id === old.id); if (!item) invalid("Retained notes cannot disappear during a control update");
    const { acknowledged: oldAnswers, withdrawn: oldWithdrawn, ...oldText } = old;
    const { acknowledged: answers, withdrawn, ...newText } = item;
    if (!same(oldText, newText) || oldWithdrawn && !withdrawn || oldAnswers.some((p, i) => answers[i] !== p)) invalid("Note text, context, parties or prior acknowledgment was rewritten");
  }
}

function assertRecoveryTransition(before: ControlState, next: ControlState, command: RecoveryCommand): void {
  const same = (a: unknown, b: unknown) => canonicalHash(a) === canonicalHash(b);
  if (command.epoch !== before.epoch || !same(before.notes, next.notes) || !same(before.receipts, next.receipts)
    || before.works.length !== next.works.length || before.cases.length !== next.cases.length) invalid("Recovery changed unrelated retained authority");
  if ("work_id" in command) {
    const work = before.works.find(w => w.id === command.work_id);
    if (!work || work.state !== "active" || work.owner !== command.expected_owner || work.revision !== command.expected_revision) invalid("Recovery does not match the work being changed");
    const expected = { ...work, revision: work.revision + 1 };
    if (command.kind === "adopt_work") {
      if (command.new_owner === work.owner) invalid("Adoption requires a different owner");
      expected.owner = command.new_owner; expected.readers = work.readers.filter(p => p !== command.new_owner);
    } else expected.state = "closed";
    if (!same(before.cases, next.cases) || !same(next.works, before.works.map(w => w.id === work.id ? expected : w))) invalid("Recovery work delta differs from its explicit command");
  } else {
    const item = before.cases.find(c => c.id === command.case_id);
    if (!item || item.state !== "active" || item.lead !== command.expected_owner || item.revision !== command.expected_revision || item.generation !== command.expected_generation) invalid("Recovery does not match the case being changed");
    const expected = { ...item, revision: item.revision + 1 };
    if (command.kind === "settle_case") {
      if (item.external_effect !== "possible") invalid("Only a possible external effect can be operator-settled");
      expected.external_effect = "not_started";
    } else {
      if (item.external_effect !== "not_started") invalid("Unsettled external effects prevent handoff or release");
      if (command.kind === "release_case") expected.state = "closed";
      else {
        if (item.lead === command.new_owner) invalid("Adoption requires a different lead");
        expected.lead = command.new_owner; expected.generation++;
        expected.members = [...new Set([...item.members, command.new_owner])];
      }
    }
    if (!same(before.works, next.works) || !same(next.cases, before.cases.map(c => c.id === item.id ? expected : c))) invalid("Recovery case delta differs from its explicit command");
  }
}

/** Repository-bound entrypoints derive physical identity and object format, never accept them from a model. */
export type ExternalWorkRegistration = {
  kind: "register_external_work"; operation_key: string; input_oid: string;
  intent: string; areas: Region[]; readers: ParentId[];
};
export type RepositoryCommand = Exclude<Command, { kind: "register_work" }> | ExternalWorkRegistration;
export function decodeRepositoryCommand(value: unknown): RepositoryCommand {
  const v = object(value);
  if (v.kind === "register_work") throw new BridgeError("COORDINATION_OPERATION_UNSUPPORTED", "Physical workspace metadata must be derived by the repository boundary");
  if (v.kind !== "register_external_work") {
    const command = decodeCommand(v);
    if (command.kind === "register_work") invalid("Unreachable raw workspace registration");
    return command;
  }
  fields(v, ["kind", "operation_key", "input_oid", "intent", "areas", "readers"]);
  return { kind: "register_external_work", operation_key: text(v.operation_key, 256), input_oid: coordinationOid(v.input_oid),
    intent: text(v.intent, 4096, true), areas: regions(v.areas), readers: parents(v.readers) };
}
/** The key names a retained acknowledgment, not a current authority token. */
export function coordinationOperationKey(value: unknown): string { return text(value, 256); }

/** Complete receipt representation reused by service projections; this proves no current control grant. */
export function decodeCoordinationReceipt(value: unknown): Receipt { return receipt(value); }
