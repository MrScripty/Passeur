import { canonicalHash } from "../core/async.js";
import { BridgeError } from "../core/errors.js";
import { isAbsolute } from "node:path";

/** Owned internal/persisted contract. Transport authorization is a separate boundary. */
export const CONTROL_SCHEMA = 1;
export const MANAGED_CONTROL_SCHEMA = 3;
export const SUBMISSION_CONTROL_SCHEMA = 4;
export const SOURCE_GRANT_CONTROL_SCHEMA = 5;
export const SOURCE_WATCH_CONTROL_SCHEMA = 6;
export const WORK_INTENT_BYTES = 4096;
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
/** Immutable source attribution; native-task control remains with TaskControls. */
export type ManagedWork = {
  task_id: string; control_generation: number; intent_truncated: boolean;
  areas_source: "allowed_paths" | "not_declared";
};
export type Work = {
  id: string; owner: ParentId; workspace_id: string; revision: number;
  state: "active" | "closed"; input_oid: string; object_format: "sha1" | "sha256";
  intent: string; areas: Region[]; readers: ParentId[]; managed?: ManagedWork;
  source_grants?: SourceGrant[];
  source_watches?: SourceWatch[];
};
export type SourceGrant = { recipient: ParentId; scope: "report" | "detail"; work_revision: number };
export type SourceWatch = { recipient: ParentId; regions: Region[];
  dialect_overrides?: Array<{ path: string; dialect: "jsx" | "c" | "cpp" }>; work_revision: number };
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
export type AnnouncementRecord = {
  id: string; owner: ParentId; revision: number; state: "unresolved" | "bound" | "linked" | "withdrawn";
  payload_ref: string; payload_digest: string; source_view: string; assignment_hash: string; areas: Region[];
  readers: ParentId[];
  task_id?: string;
};
export type SubmissionBinding = {
  task_id: string; request_key: string; owner: ParentId; intent_hash: string; decision_identity: string;
  link_hash: string; source_view: string; input_oid: string; areas: Region[];
  announcement?: { id: string; revision: number }; state: "bound" | "settled" | "released" | "terminal";
  terminal?: { revision: number; control_generation: number; outcome: "completed" | "blocked" | "failed" | "cancelled" | "interrupted" };
};
export type SubmissionEvent = {
  kind: "announce" | "withdraw" | "bind" | "settle" | "release" | "terminal";
  owner: ParentId; key: string; item_id: string; request_hash: string; revision: number;
};
/** Existing state stays v1 until one authorized recovery atomically publishes v2. */
export type ControlState = ControlData & (
  | { schema_version: 1 }
  | { schema_version: 2 | 3; recoveries: RecoveryReceipt[] }
  | { schema_version: 4 | 5 | 6; recoveries: RecoveryReceipt[]; announcements: AnnouncementRecord[];
      bindings: SubmissionBinding[]; submission_events: SubmissionEvent[] }
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
  return state.schema_version === 1 ? [] : state.recoveries;
}
export function controlReceiptCount(state: ControlState): number {
  return state.receipts.length + recoveryReceipts(state).length + submissionEvents(state).length;
}
export function announcements(state: ControlState): readonly AnnouncementRecord[] { return state.schema_version === 4 || state.schema_version === 5 || state.schema_version === 6 ? state.announcements : []; }
export function submissionBindings(state: ControlState): readonly SubmissionBinding[] { return state.schema_version === 4 || state.schema_version === 5 || state.schema_version === 6 ? state.bindings : []; }
export function submissionEvents(state: ControlState): readonly SubmissionEvent[] { return state.schema_version === 4 || state.schema_version === 5 || state.schema_version === 6 ? state.submission_events : []; }

export type Command =
  | { kind: "register_task_work"; operation_key: string; workspace_id: string; input_oid: string;
      object_format: "sha1" | "sha256"; intent: string; areas: Region[]; managed: ManagedWork }
  | { kind: "register_work"; operation_key: string; workspace_id: string; input_oid: string;
      object_format: "sha1" | "sha256"; intent: string; areas: Region[]; readers: ParentId[] }
  | { kind: "share_work"; operation_key: string; work_id: string; expected_revision: number; readers: ParentId[] }
  | { kind: "grant_source"; operation_key: string; work_id: string; expected_revision: number;
      recipients: Array<{ recipient: ParentId; scope: "report" | "detail" }> }
  | { kind: "watch_source"; operation_key: string; work_id: string; expected_revision: number;
      watchers: Array<{ recipient: ParentId; regions: Region[];
        dialect_overrides?: Array<{ path: string; dialect: "jsx" | "c" | "cpp" }> }> }
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
const actions = ["register_task_work", "register_work", "share_work", "grant_source", "watch_source", "close_work", "post_note", "ack_note", "withdraw_note", "claim_target",
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
    case "register_task_work": {
      fields(v, ["kind", "operation_key", "workspace_id", "input_oid", "object_format", "intent", "areas", "managed"]);
      const object_format = choice(v.object_format, ["sha1", "sha256"]), input_oid = coordinationOid(v.input_oid); formatOid(input_oid, object_format);
      const managed = managedWork(v.managed), areas = regions(v.areas);
      if (managed.areas_source === "not_declared" && areas.length) invalid("Undeclared areas cannot contain projected scope");
      return { kind, operation_key, workspace_id: text(v.workspace_id, 4096), input_oid, object_format,
        intent: text(v.intent, 4096, true), areas, managed };
    }
    case "register_work": {
      fields(v, ["kind", "operation_key", "workspace_id", "input_oid", "object_format", "intent", "areas", "readers"]);
      const object_format = choice(v.object_format, ["sha1", "sha256"]), input_oid = coordinationOid(v.input_oid); formatOid(input_oid, object_format);
      return { kind, operation_key, workspace_id: text(v.workspace_id, 4096), input_oid, object_format, intent: text(v.intent, 4096, true), areas: regions(v.areas), readers: parents(v.readers) };
    }
    case "share_work": fields(v, ["kind", "operation_key", "work_id", "expected_revision", "readers"]);
      return { kind, operation_key, work_id: entityId(v.work_id), expected_revision: number(v.expected_revision, 1), readers: parents(v.readers) };
    case "grant_source": fields(v, ["kind", "operation_key", "work_id", "expected_revision", "recipients"]);
      return { kind, operation_key, work_id: entityId(v.work_id), expected_revision: number(v.expected_revision, 1),
        recipients: unique(list(v.recipients, MAX_PARTIES, item => {
          const r = object(item); fields(r, ["recipient", "scope"]);
          return { recipient: parentId(r.recipient), scope: choice(r.scope, ["report", "detail"]) };
        }), item => item.recipient) };
    case "watch_source": {
      fields(v, ["kind", "operation_key", "work_id", "expected_revision", "watchers"]);
      const watchers = unique(list(v.watchers, MAX_PARTIES, item => {
          const w = object(item); fields(w, ["recipient", "regions", ...(Object.hasOwn(w, "dialect_overrides") ? ["dialect_overrides"] : [])]);
          const selected = regions(w.regions);
          if (!selected.length) invalid("Each source watcher needs an explicit region");
          const dialect_overrides = Object.hasOwn(w, "dialect_overrides") ? decodeDialectOverrides(w.dialect_overrides, selected) : undefined;
          return { recipient: parentId(w.recipient), regions: selected, ...(dialect_overrides ? { dialect_overrides } : {}) };
        }), item => item.recipient);
      assertWatchInventory(watchers);
      return { kind, operation_key, work_id: entityId(v.work_id), expected_revision: number(v.expected_revision, 1), watchers };
    }
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
function managedWork(value: unknown): ManagedWork {
  const v = object(value); fields(v, ["task_id", "control_generation", "intent_truncated", "areas_source"]);
  return { task_id: entityId(v.task_id), control_generation: number(v.control_generation, 1),
    intent_truncated: boolean(v.intent_truncated), areas_source: choice(v.areas_source, ["allowed_paths", "not_declared"]) };
}
function decodeDialectOverrides(value: unknown, watched: readonly Region[]): Array<{ path: string; dialect: "jsx" | "c" | "cpp" }> {
  return unique(list(value, MAX_REGIONS, item => {
    const v = object(item); fields(v, ["path", "dialect"]);
    const selectedPath = path(v.path), dialect = choice(v.dialect, ["jsx", "c", "cpp"]);
    if (!watched.some(region => region.kind === "file" && region.path === selectedPath)
      || dialect === "jsx" && (!selectedPath.endsWith(".js") || selectedPath.endsWith(".svelte.js"))
      || dialect !== "jsx" && !selectedPath.endsWith(".h")) {
      invalid("Dialect override requires an exact watched .js or .h file");
    }
    return { path: selectedPath, dialect };
  }), item => item.path);
}
function assertWatchInventory(watches: readonly { regions: readonly Region[];
  dialect_overrides?: readonly { path: string; dialect: "jsx" | "c" | "cpp" }[] }[]): void {
  if (watches.reduce((sum, watch) => sum + watch.regions.length, 0) > MAX_REGIONS) invalid("Source watches exceed the bounded region inventory");
  const selected = new Map<string, "jsx" | "c" | "cpp">();
  for (const watch of watches) for (const override of watch.dialect_overrides ?? []) {
    const existing = selected.get(override.path);
    if (existing && existing !== override.dialect) invalid("Source watchers conflict on the exact file dialect");
    selected.set(override.path, override.dialect);
  }
}
function work(value: unknown): Work {
  const v = object(value); fields(v, ["id", "owner", "workspace_id", "revision", "state", "input_oid", "object_format", "intent", "areas", "readers", ...(Object.hasOwn(v, "managed") ? ["managed"] : []), ...(Object.hasOwn(v, "source_grants") ? ["source_grants"] : []), ...(Object.hasOwn(v, "source_watches") ? ["source_watches"] : [])]);
  const object_format = choice(v.object_format, ["sha1", "sha256"]), input_oid = coordinationOid(v.input_oid); formatOid(input_oid, object_format);
  const decoded: Work = { id: entityId(v.id), owner: parentId(v.owner), workspace_id: text(v.workspace_id, 4096), revision: number(v.revision, 1),
    state: choice(v.state, ["active", "closed"]), input_oid, object_format, intent: text(v.intent, 4096, true), areas: regions(v.areas), readers: parents(v.readers),
    ...(Object.hasOwn(v, "managed") ? { managed: managedWork(v.managed) } : {}),
    ...(Object.hasOwn(v, "source_grants") ? { source_grants: unique(list(v.source_grants, MAX_PARTIES, item => {
      const g = object(item); fields(g, ["recipient", "scope", "work_revision"]);
      return { recipient: parentId(g.recipient), scope: choice(g.scope, ["report", "detail"]), work_revision: number(g.work_revision, 1) };
    }), g => g.recipient) } : {}),
    ...(Object.hasOwn(v, "source_watches") ? { source_watches: unique(list(v.source_watches, MAX_PARTIES, item => {
      const w = object(item); fields(w, ["recipient", "regions", "work_revision", ...(Object.hasOwn(w, "dialect_overrides") ? ["dialect_overrides"] : [])]);
      const selected = regions(w.regions);
      if (!selected.length) invalid("Each source watcher needs an explicit region");
      const dialect_overrides = Object.hasOwn(w, "dialect_overrides") ? decodeDialectOverrides(w.dialect_overrides, selected) : undefined;
      return { recipient: parentId(w.recipient), regions: selected, ...(dialect_overrides ? { dialect_overrides } : {}), work_revision: number(w.work_revision, 1) };
    }), w => w.recipient) } : {}) };
  assertWatchInventory(decoded.source_watches ?? []);
  return decoded;
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
function sourceView(value: unknown): string {
  const v = text(value, 4096);
  if (!isAbsolute(v)) invalid("Source view must be an absolute path");
  return v;
}
function announcementRecord(value: unknown): AnnouncementRecord {
  const v = object(value);
  fields(v, ["id", "owner", "revision", "state", "payload_ref", "payload_digest", "source_view", "assignment_hash", "areas", "readers", ...(Object.hasOwn(v, "task_id") ? ["task_id"] : [])]);
  const state = choice(v.state, ["unresolved", "bound", "linked", "withdrawn"]);
  const task_id = Object.hasOwn(v, "task_id") ? entityId(v.task_id) : undefined;
  if ((state === "bound" || state === "linked") !== (task_id !== undefined)) invalid("Announcement task identity contradicts its state");
  const owner = parentId(v.owner), readers = parents(v.readers);
  if (readers.includes(owner)) invalid("Announcement owner is not a separate reader");
  return { id: entityId(v.id), owner, revision: number(v.revision, 1), state,
    payload_ref: entityId(v.payload_ref), payload_digest: digest(v.payload_digest), source_view: sourceView(v.source_view),
    assignment_hash: digest(v.assignment_hash), areas: regions(v.areas), readers, ...(task_id ? { task_id } : {}) };
}
function announcementReference(value: unknown): { id: string; revision: number } {
  const v = object(value); fields(v, ["id", "revision"]);
  return { id: entityId(v.id), revision: number(v.revision, 1) };
}
function submissionBinding(value: unknown): SubmissionBinding {
  const v = object(value);
  fields(v, ["task_id", "request_key", "owner", "intent_hash", "decision_identity", "link_hash", "source_view", "input_oid", "areas", "state", ...(Object.hasOwn(v, "announcement") ? ["announcement"] : []), ...(Object.hasOwn(v, "terminal") ? ["terminal"] : [])]);
  const task_id = entityId(v.task_id), request_key = coordinationOperationKey(v.request_key), owner = parentId(v.owner);
  const intent_hash = digest(v.intent_hash), decision_identity = digest(v.decision_identity);
  const announcement = Object.hasOwn(v, "announcement") ? announcementReference(v.announcement) : undefined;
  const link_hash = digest(v.link_hash);
  const expectedLink = { schema_version: 1, task_id, request_key, owner_id: owner, intent_hash, decision_identity,
    ...(announcement ? { announcement } : {}) };
  if (link_hash !== canonicalHash(expectedLink)) invalid("Submission link hash contradicts exact bound identity");
  const state = choice(v.state, ["bound", "settled", "released", "terminal"]);
  if ((state === "terminal") !== Object.hasOwn(v, "terminal")) invalid("Terminal evidence must appear only on a terminal binding");
  return { task_id, request_key, owner, intent_hash, decision_identity, link_hash,
    source_view: sourceView(v.source_view), input_oid: coordinationOid(v.input_oid), areas: regions(v.areas),
    ...(announcement ? { announcement } : {}), state,
    ...(state === "terminal" ? { terminal: terminalEvidence(v.terminal) } : {}) };
}
function terminalEvidence(value: unknown): NonNullable<SubmissionBinding["terminal"]> {
  const v = object(value); fields(v, ["revision", "control_generation", "outcome"]);
  return { revision: number(v.revision, 1), control_generation: number(v.control_generation, 1),
    outcome: choice(v.outcome, ["completed", "blocked", "failed", "cancelled", "interrupted"]) };
}
function submissionEvent(value: unknown): SubmissionEvent {
  const v = object(value); fields(v, ["kind", "owner", "key", "item_id", "request_hash", "revision"]);
  return { kind: choice(v.kind, ["announce", "withdraw", "bind", "settle", "release", "terminal"]),
    owner: parentId(v.owner), key: coordinationOperationKey(v.key), item_id: entityId(v.item_id),
    request_hash: digest(v.request_hash), revision: number(v.revision, 1) };
}
export function decodeControl(value: unknown, expectedRepository: string): ControlState {
  const v = object(value);
  if (typeof v.schema_version === "number" && Number.isSafeInteger(v.schema_version) && v.schema_version > SOURCE_WATCH_CONTROL_SCHEMA) throw new BridgeError("COORDINATION_VERSION_UNSUPPORTED", "The control version has no supported reader");
  fields(v, ["schema_version", "repository_id", "epoch", "revision", "limits", "works", "cases", "notes", "receipts", ...(v.schema_version !== 1 ? ["recoveries"] : []),
    ...(v.schema_version === SUBMISSION_CONTROL_SCHEMA || v.schema_version === SOURCE_GRANT_CONTROL_SCHEMA || v.schema_version === SOURCE_WATCH_CONTROL_SCHEMA ? ["announcements", "bindings", "submission_events"] : [])]);
  if (v.schema_version !== CONTROL_SCHEMA && v.schema_version !== 2 && v.schema_version !== MANAGED_CONTROL_SCHEMA && v.schema_version !== SUBMISSION_CONTROL_SCHEMA && v.schema_version !== SOURCE_GRANT_CONTROL_SCHEMA && v.schema_version !== SOURCE_WATCH_CONTROL_SCHEMA) invalid("Missing or malformed control schema version");
  const repository_id = text(v.repository_id, 256); if (repository_id !== expectedRepository) throw new BridgeError("COORDINATION_BINDING_CONFLICT", "Control belongs to another repository");
  const limits = decodeLimits(v.limits), revision = number(v.revision);
  const works = unique(list(v.works, limits.works, work), x => x.id), cases = unique(list(v.cases, limits.cases, caseRecord), x => x.id);
  const notes = unique(list(v.notes, limits.notes, note), x => x.id), receipts = unique(list(v.receipts, limits.receipts, receipt), x => `${x.owner}:${x.key}`);
  const recoveries = v.schema_version !== 1 ? list(v.recoveries, limits.receipts, decodeRecoveryReceipt) : [];
  const announcementRecords = v.schema_version >= 4 ? unique(list(v.announcements, limits.works, announcementRecord), x => x.id) : [];
  const bindings = v.schema_version >= 4 ? unique(list(v.bindings, limits.receipts, submissionBinding), x => x.task_id) : [];
  const events = v.schema_version >= 4 ? list(v.submission_events, limits.receipts, submissionEvent) : [];
  if (typeof v.schema_version === "number" && v.schema_version < SOURCE_GRANT_CONTROL_SCHEMA && works.some(w => w.source_grants !== undefined)) invalid("Source grants require control storage v5");
  if (typeof v.schema_version === "number" && v.schema_version < SOURCE_WATCH_CONTROL_SCHEMA && works.some(w => w.source_watches !== undefined)) invalid("Source watches require control storage v6");
  if (v.schema_version === 2 && recoveries.length === 0) invalid("Recovery storage requires its first atomic recovery receipt");
  if (receipts.length + recoveries.length + events.length > limits.receipts) invalid("Receipt capacity includes submission and operator history");
  unique([...receipts.map(r => `${r.owner}:${r.key}`), ...recoveries.map(r => `${r.operator}:${r.command.operation_key}`), ...events.map(e => `${e.owner}:${e.key}`)], x => x);
  if (v.schema_version === MANAGED_CONTROL_SCHEMA && !works.some(w => w.managed)) invalid("Managed storage requires a managed enrollment");
  if (v.schema_version < MANAGED_CONTROL_SCHEMA && (works.some(w => w.managed) || receipts.some(r => r.action === "register_task_work"))) invalid("Managed enrollment requires control storage v3");
  const workMap = new Map(works.map(w => [w.id, w])), caseMap = new Map(cases.map(c => [c.id, c]));
  const enrollments = new Map<string, Receipt>();
  for (const r of receipts) if (r.action === "register_task_work") {
    if (!workMap.get(r.item_id)?.managed || enrollments.has(r.item_id)) invalid("Managed receipt requires one uniquely enrolled work");
    enrollments.set(r.item_id, r);
  }
  for (const w of works) if (w.managed) {
    if (w.id !== w.managed.task_id || w.managed.areas_source === "not_declared" && w.areas.length) invalid("Managed work attribution is inconsistent");
    const receipt = enrollments.get(w.id);
    if (!receipt) invalid("Managed work requires exactly one enrollment receipt");
    const command = { kind: "register_task_work", operation_key: receipt.key, workspace_id: w.workspace_id,
      input_oid: w.input_oid, object_format: w.object_format, intent: w.intent, areas: w.areas, managed: w.managed };
    if (receipt.entity.kind !== "work" || receipt.entity.id !== w.id || receipt.request_hash !== canonicalHash({ owner: receipt.owner, command })) invalid("Managed attribution differs from its immutable enrollment");
  }
  unique(works.filter(x => x.state === "active"), x => x.workspace_id);
  unique(cases.filter(x => x.state === "active"), x => x.target);
  const allIds = [...works.map(x => x.id), ...cases.map(x => x.id), ...notes.map(x => x.id)]; unique(allIds, x => x);
  for (const w of works) {
    if (w.revision > revision || w.readers.includes(w.owner)) invalid("Work revision/sharing contradicts its owner");
    if (w.source_grants?.some(g => g.recipient === w.owner || g.work_revision !== w.revision || w.state !== "active")) invalid("Source grants contradict current work authority");
    if (w.source_watches?.some(watch => watch.work_revision !== w.revision || w.state !== "active"
      || watch.recipient !== w.owner && !w.source_grants?.some(g => g.recipient === watch.recipient && g.work_revision === w.revision))) invalid("Source watches contradict current work authority");
    if ((w.source_watches ?? []).reduce((sum, watch) => sum + watch.regions.length, 0) > MAX_REGIONS) invalid("Source watches exceed the bounded region inventory");
  }
  for (const c of cases) {
    if (c.revision > revision || c.generation > revision || !c.members.includes(c.lead) || c.state === "closed" && c.external_effect !== "not_started") invalid("Case lifecycle contradicts its authority");
    if (c.inputs.length && !c.target_oid) invalid("Selected inputs need an explicit target observation");
    for (const input of c.inputs) { const w = workMap.get(input.work_id); if (!w) invalid("Case input references missing work"); formatOid(input.commit_oid, w.object_format); if (c.target_oid) formatOid(c.target_oid, w.object_format); }
  }
  for (const n of notes) {
    if (n.work_refs.some(id => !workMap.has(id)) || n.subject.kind === "work" && (n.work_refs.length !== 1 || n.work_refs[0] !== n.subject.id) || Buffer.byteLength(n.text) > limits.note_bytes || !(n.subject.kind === "work" ? workMap.has(n.subject.id) : caseMap.has(n.subject.id))) invalid("Note violates retention bounds or references a missing subject");
  }
  unique([...receipts.map(r => r.revision), ...recoveries.map(r => r.revision), ...events.map(e => e.revision)], String);
  if (receipts.length + recoveries.length + events.length !== revision) invalid("Control revision and retained receipt history disagree");
  for (const r of receipts) if (!allIds.includes(r.item_id) || r.revision > revision || !(r.entity.kind === "work" ? workMap.has(r.entity.id) : caseMap.has(r.entity.id))) invalid("Receipt references missing state or a future revision");
  const epoch = entityId(v.epoch);
  for (const r of recoveries) {
    const c = r.command;
    if (r.revision > revision || c.epoch !== epoch || c.expected_revision >= r.revision
      || ("work_id" in c ? !workMap.has(c.work_id) : !caseMap.has(c.case_id))) invalid("Recovery references missing state or contradicts its revision/epoch");
  }
  if (v.schema_version >= 4) {
    unique(bindings.filter(b => b.state !== "released"), b => `${b.owner}:${b.request_key}`);
    for (const announcement of announcementRecords) {
      if (announcement.payload_ref !== announcement.id || announcement.revision > revision) invalid("Announcement reference or revision contradicts control history");
      const bound = bindings.find(b => b.task_id === announcement.task_id);
      if ((announcement.state === "bound" || announcement.state === "linked") && (!bound || bound.owner !== announcement.owner || bound.announcement?.id !== announcement.id || bound.announcement.revision > announcement.revision
        || announcement.state === "bound" && bound.state !== "bound"
        || announcement.state === "linked" && bound.state !== "settled" && bound.state !== "terminal")) invalid("Announcement link has no matching bound task");
      const changes = events.filter(e => e.item_id === announcement.id && (e.kind === "announce" || e.kind === "withdraw")
        || (e.kind === "bind" || e.kind === "settle" || e.kind === "release") && bindings.some(b => b.task_id === e.item_id && b.announcement?.id === announcement.id));
      if (!changes.some(e => e.kind === "announce") || announcement.revision !== changes.length) invalid("Announcement revision contradicts retained submission history");
    }
    for (const binding of bindings) {
      if (binding.announcement && !announcementRecords.some(a => a.id === binding.announcement!.id && a.owner === binding.owner && a.payload_ref === binding.announcement!.id)) invalid("Binding references an unavailable announcement");
      const history = events.filter(e => e.item_id === binding.task_id && (e.kind === "bind" || e.kind === "settle" || e.kind === "release" || e.kind === "terminal"));
      const disposition = binding.state === "settled" ? "settle" : binding.state === "released" ? "release" : undefined;
      if (history.length !== (binding.state === "bound" ? 1 : binding.state === "terminal" ? 3 : 2) || history[0]?.kind !== "bind"
        || history[0].owner !== binding.owner || disposition && history[1]?.kind !== disposition
        || binding.state === "terminal" && (history[1]?.kind !== "settle" || history[2]?.kind !== "terminal")
        || history.some(e => e.owner !== binding.owner)) invalid("Binding state contradicts its retained publication history");
    }
    for (const event of events) if (event.revision > revision || !announcementRecords.some(a => a.id === event.item_id) && !bindings.some(b => b.task_id === event.item_id)) invalid("Submission event references missing state or a future revision");
  }
  const data = { repository_id, epoch, revision, limits, works, cases, notes, receipts };
  return v.schema_version === 1 ? { schema_version: 1, ...data } : v.schema_version >= 4
    ? { schema_version: v.schema_version as 4 | 5 | 6, ...data, recoveries, announcements: announcementRecords, bindings, submission_events: events }
    : { schema_version: v.schema_version as 2 | 3, ...data, recoveries };
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
/** Public mutation path; retained historical recovery receipts keep the older key reader. */
export function decodePublicRecoveryCommand(value: unknown): RecoveryCommand {
  const command = decodeRecoveryCommand(value);
  publicCoordinationOperationKey(command.operation_key);
  return command;
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
    + state.notes.filter(n => !n.withdrawn && n.kind === "agreement_proposal").length
    + announcements(state).filter(a => a.state === "unresolved" || a.state === "bound").length
    + submissionBindings(state).filter(b => b.state === "settled" || b.state === "bound" && !b.announcement).length;
}

/** Persisted history may advance only through append/owned mutable fields; migration is separate. */
export function assertControlTransition(before: ControlState, next: ControlState): void {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (before.epoch !== next.epoch || before.repository_id !== next.repository_id || !same(before.limits, next.limits)
    || next.revision !== before.revision + 1) invalid("Publication contradicts the current control identity or revision");
  const oldRecoveries = recoveryReceipts(before), newRecoveries = recoveryReceipts(next);
  if (next.schema_version < before.schema_version || oldRecoveries.some((r, i) => !same(r, newRecoveries[i]))) invalid("Recovery history or supported storage version was rewritten");
  const recovered = newRecoveries.length === oldRecoveries.length + 1 ? newRecoveries.at(-1) : undefined;
  const oldEvents = submissionEvents(before), newEvents = submissionEvents(next);
  if (oldEvents.some((event, i) => !same(event, newEvents[i])) || newEvents.length > oldEvents.length + 1) invalid("Submission event history was rewritten");
  const submissionEvent = newEvents.length === oldEvents.length + 1 ? newEvents.at(-1) : undefined;
  if (submissionEvent) {
    if (next.schema_version < SUBMISSION_CONTROL_SCHEMA || recovered || next.receipts.length !== before.receipts.length
      || newRecoveries.length !== oldRecoveries.length || submissionEvent.revision !== next.revision
      || !same(before.works, next.works) || !same(before.cases, next.cases) || !same(before.notes, next.notes)) invalid("Submission publication changed unrelated authority");
    assertSubmissionTransition(before, next, submissionEvent);
  }
  if (recovered) {
    if (next.schema_version < 2 || (before.schema_version >= MANAGED_CONTROL_SCHEMA && next.schema_version < MANAGED_CONTROL_SCHEMA) || recovered.revision !== next.revision || before.receipts.length !== next.receipts.length || submissionEvent) invalid("Recovery publication must append exactly its own receipt");
    assertRecoveryTransition(before, next, recovered.command);
  } else if (!submissionEvent && (newRecoveries.length !== oldRecoveries.length || next.receipts.length !== before.receipts.length + 1
    || next.schema_version !== before.schema_version && !(next.schema_version === MANAGED_CONTROL_SCHEMA && next.receipts.at(-1)?.action === "register_task_work")
      && !(next.schema_version === SOURCE_GRANT_CONTROL_SCHEMA && next.receipts.at(-1)?.action === "grant_source")
      && !(next.schema_version === SOURCE_WATCH_CONTROL_SCHEMA && next.receipts.at(-1)?.action === "watch_source"))) {
    invalid("A control publication appends one ordinary or recovery receipt");
  }
  if (!submissionEvent && (!same(announcements(before), announcements(next)) || !same(submissionBindings(before), submissionBindings(next)))) invalid("Ordinary or recovery publication changed submission authority");
  if (before.receipts.some((r, i) => !same(r, next.receipts[i]))) invalid("Accepted operation receipts are immutable");
  if (next.receipts.at(-1)?.action === "register_task_work" && next.receipts.length === before.receipts.length + 1) {
    const receipt = next.receipts.at(-1)!, added = next.works.at(-1);
    if (next.schema_version < MANAGED_CONTROL_SCHEMA || next.works.length !== before.works.length + 1 || !same(next.works.slice(0, -1), before.works)
      || !same(before.cases, next.cases) || !same(before.notes, next.notes) || !added?.managed
      || added.owner !== receipt.owner || added.revision !== 1 || added.state !== "active" || added.readers.length
      || receipt.item_id !== added.id || !same(oldRecoveries, newRecoveries)) invalid("Managed enrollment changed unrelated authority");
  }
  const grantReceipt = next.receipts.length === before.receipts.length + 1 && next.receipts.at(-1)?.action === "grant_source"
    ? next.receipts.at(-1) : undefined;
  const watchReceipt = next.receipts.length === before.receipts.length + 1 && next.receipts.at(-1)?.action === "watch_source"
    ? next.receipts.at(-1) : undefined;
  if ((grantReceipt || watchReceipt) && (next.schema_version < SOURCE_GRANT_CONTROL_SCHEMA
    || watchReceipt && next.schema_version !== SOURCE_WATCH_CONTROL_SCHEMA || !same(before.cases, next.cases)
    || !same(before.notes, next.notes) || next.works.length !== before.works.length
    || !before.works.some(w => w.id === (grantReceipt ?? watchReceipt)!.item_id))) invalid("Source configuration changed unrelated metadata");
  for (const old of before.works) {
    const item = next.works.find(w => w.id === old.id); if (!item) invalid("Retained work cannot disappear during a control update");
    if (recovered && "work_id" in recovered.command && recovered.command.work_id === old.id) continue;
    const { revision: a, state: oldState, readers: _oldReaders, source_grants: _oldGrants, source_watches: _oldWatches, ...oldIdentity } = old;
    const { revision: b, state: newState, readers: _newReaders, source_grants: _newGrants, source_watches: _newWatches, ...newIdentity } = item;
    if (!same(oldIdentity, newIdentity) || b < a || b > a + 1 || oldState === "closed" && newState !== "closed"
      || b === a && !same(old, item)) invalid("Work identity, closure or revision was rewritten");
    if (grantReceipt?.item_id === old.id) {
      const expectedCommand: Command = { kind: "grant_source", operation_key: grantReceipt.key, work_id: old.id,
        expected_revision: old.revision, recipients: (item.source_grants ?? []).map(g => ({ recipient: g.recipient, scope: g.scope })) };
      if (old.owner !== grantReceipt.owner || old.state !== "active" || item.state !== "active" || b !== a + 1
        || !same(old.readers, item.readers) || item.source_grants?.some(g => g.work_revision !== b || g.recipient === old.owner)
        || (item.source_watches?.length ?? 0) !== 0
        || grantReceipt.request_hash !== canonicalHash({ owner: old.owner, command: expectedCommand })) invalid("Grant publication lacks current owner or changed other work authority");
    } else if (watchReceipt?.item_id === old.id) {
      const expectedCommand: Command = { kind: "watch_source", operation_key: watchReceipt.key, work_id: old.id,
        expected_revision: old.revision, watchers: (item.source_watches ?? []).map(w => ({ recipient: w.recipient,
          regions: w.regions, ...(w.dialect_overrides ? { dialect_overrides: w.dialect_overrides } : {}) })) };
      const expectedGrants = old.source_grants?.map(g => ({ ...g, work_revision: b }));
      if (old.owner !== watchReceipt.owner || old.state !== "active" || item.state !== "active" || b !== a + 1
        || !same(old.readers, item.readers) || item.source_watches === undefined
        || !same(item.source_grants, expectedGrants)
        || watchReceipt.request_hash !== canonicalHash({ owner: old.owner, command: expectedCommand })) invalid("Watch publication lacks current owner or changed other work authority");
    } else if ((grantReceipt || watchReceipt) && !same(old, item)) {
      invalid("Source configuration changed another work");
    } else if (!same(old.source_grants ?? [], item.source_grants ?? [])
      && !(b === a + 1 && (item.source_grants?.length ?? 0) === 0)) invalid("Unrelated work changed its source grants");
    if (!grantReceipt && !watchReceipt && !same(old.source_watches ?? [], item.source_watches ?? [])
      && !(b === a + 1 && (item.source_watches?.length ?? 0) === 0)) invalid("Unrelated work changed its source watches");
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

function assertSubmissionTransition(before: ControlState, next: ControlState, event: SubmissionEvent): void {
  const same = (a: unknown, b: unknown) => canonicalHash(a) === canonicalHash(b);
  const oldAnnouncements = announcements(before), oldBindings = submissionBindings(before);
  if (next.schema_version !== 4 && next.schema_version !== 5 && next.schema_version !== 6) invalid("Submission transition requires v4 storage");
  if (event.kind === "announce") {
    const added = next.announcements.at(-1);
    if (!added || added.id !== event.item_id || added.owner !== event.owner || added.state !== "unresolved" || added.revision !== 1
      || next.announcements.length !== oldAnnouncements.length + 1 || !same(next.announcements.slice(0, -1), oldAnnouncements)
      || !same(next.bindings, oldBindings)) invalid("Announcement publication changed unrelated submission state");
    return;
  }
  if (event.kind === "withdraw") {
    const old = oldAnnouncements.find(a => a.id === event.item_id);
    if (!old || old.owner !== event.owner || old.state !== "unresolved"
      || !same(next.bindings, oldBindings)
      || !same(next.announcements, oldAnnouncements.map(a => a.id === old.id ? { ...a, revision: a.revision + 1, state: "withdrawn" } : a))) invalid("Withdrawal changed another announcement or active binding");
    return;
  }
  if (event.kind === "bind") {
    const added = next.bindings.at(-1);
    if (!added || added.task_id !== event.item_id || added.owner !== event.owner || added.state !== "bound"
      || next.bindings.length !== oldBindings.length + 1 || !same(next.bindings.slice(0, -1), oldBindings)) invalid("Binding publication changed unrelated task links");
    const expected = oldAnnouncements.map(a => a.id === added.announcement?.id ? { ...a, revision: a.revision + 1, state: "bound", task_id: added.task_id } : a);
    if (added.announcement && !oldAnnouncements.some(a => a.id === added.announcement!.id && a.owner === event.owner && a.state === "unresolved" && a.revision === added.announcement!.revision)
      || !same(next.announcements, expected)) invalid("Binding changed an unavailable announcement");
    return;
  }
  if (event.kind === "terminal") {
    const old = oldBindings.find(b => b.task_id === event.item_id);
    const updated = next.bindings.find(b => b.task_id === event.item_id);
    if (!old || old.owner !== event.owner || old.state !== "settled" || !updated?.terminal
      || !same(next.bindings, oldBindings.map(b => b.task_id === old.task_id ? { ...b, state: "terminal", terminal: updated.terminal } : b))
      || !same(next.announcements, oldAnnouncements)) invalid("Terminal evidence changed another submission authority");
    return;
  }
  const old = oldBindings.find(b => b.task_id === event.item_id);
  if (!old || old.owner !== event.owner || old.state !== "bound") invalid("Settlement/release lacks an owned bound task");
  const destination = event.kind === "settle" ? "settled" : "released";
  if (!same(next.bindings, oldBindings.map(b => b.task_id === old.task_id ? { ...b, state: destination } : b))) invalid("Settlement/release changed another binding");
  const expected = oldAnnouncements.map(a => a.id === old.announcement?.id
    ? event.kind === "settle" ? { ...a, revision: a.revision + 1, state: "linked" }
      : { ...a, revision: a.revision + 1, state: "unresolved", task_id: undefined }
    : a).map(a => a.task_id === undefined ? { ...a, task_id: undefined } : a);
  const normalized = expected.map(a => { if (a.task_id === undefined) { const { task_id: _unused, ...rest } = a; return rest; } return a; });
  if (!same(next.announcements, normalized)) invalid("Settlement/release changed unrelated announcement state");
}

function assertRecoveryTransition(before: ControlState, next: ControlState, command: RecoveryCommand): void {
  const same = (a: unknown, b: unknown) => canonicalHash(a) === canonicalHash(b);
  if (command.epoch !== before.epoch || !same(before.notes, next.notes) || !same(before.receipts, next.receipts)
    || before.works.length !== next.works.length || before.cases.length !== next.cases.length) invalid("Recovery changed unrelated retained authority");
  if ("work_id" in command) {
    const work = before.works.find(w => w.id === command.work_id);
    if (!work || work.state !== "active" || work.owner !== command.expected_owner || work.revision !== command.expected_revision) invalid("Recovery does not match the work being changed");
    const expected = { ...work, revision: work.revision + 1,
      ...(work.source_grants ? { source_grants: [] } : {}),
      ...(work.source_watches ? { source_watches: [] } : {}) };
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
export type ManagedWorkRegistration = { kind: "register_managed_work"; operation_key: string; task_id: string };
export type RepositoryCommand = Exclude<Command, { kind: "register_work" | "register_task_work" }> | ExternalWorkRegistration | ManagedWorkRegistration;
export function decodeRepositoryCommand(value: unknown): RepositoryCommand { return decodeRepositoryCommandCore(value, false); }
/** Elected service path for F9 enrollment after durable coordinated admission. */
export function decodeInternalRepositoryCommand(value: unknown): RepositoryCommand { return decodeRepositoryCommandCore(value, true); }
function decodeRepositoryCommandCore(value: unknown, internal: boolean): RepositoryCommand {
  const v = object(value);
  if (v.kind === "register_work" || v.kind === "register_task_work") throw new BridgeError("COORDINATION_OPERATION_UNSUPPORTED", "Physical workspace metadata must be derived by the repository boundary");
  if (v.kind === "register_managed_work") {
    fields(v, ["kind", "operation_key", "task_id"]);
    return { kind: "register_managed_work", operation_key: internal ? internalCoordinationOperationKey(v.operation_key) : publicCoordinationOperationKey(v.operation_key), task_id: entityId(v.task_id) };
  }
  if (v.kind !== "register_external_work") {
    const command = decodeCommand(v);
    if (command.kind === "register_work" || command.kind === "register_task_work") invalid("Unreachable raw workspace registration");
    if (internal) internalCoordinationOperationKey(command.operation_key); else publicCoordinationOperationKey(command.operation_key);
    return command;
  }
  fields(v, ["kind", "operation_key", "input_oid", "intent", "areas", "readers"]);
  return { kind: "register_external_work", operation_key: internal ? internalCoordinationOperationKey(v.operation_key) : publicCoordinationOperationKey(v.operation_key), input_oid: coordinationOid(v.input_oid),
    intent: text(v.intent, 4096, true), areas: regions(v.areas), readers: parents(v.readers) };
}
/** The key names a retained acknowledgment, not a current authority token. */
export function coordinationOperationKey(value: unknown): string { return text(value, 256); }
export const INTERNAL_OPERATION_KEY_PREFIX = "passeur-internal:";
export function internalCoordinationOperationKey(value: unknown): string {
  const key = coordinationOperationKey(value);
  if (!key.startsWith(INTERNAL_OPERATION_KEY_PREFIX)) invalid("Internal metadata operation requires the reserved key prefix");
  return key;
}
export function publicCoordinationOperationKey(value: unknown): string {
  const key = coordinationOperationKey(value);
  if (key.startsWith(INTERNAL_OPERATION_KEY_PREFIX)) throw new BridgeError("COORDINATION_OPERATION_KEY_RESERVED", "The operation key prefix is reserved for elected-service bookkeeping");
  return key;
}

export type AnnouncementInput = { operation_key: string; id: string; payload_digest: string;
  source_view: string; assignment_hash: string; areas: Region[]; readers: ParentId[] };
export function decodeAnnouncementInput(value: unknown): AnnouncementInput {
  const v = object(value); fields(v, ["operation_key", "id", "payload_digest", "source_view", "assignment_hash", "areas", "readers"]);
  return { operation_key: publicCoordinationOperationKey(v.operation_key), id: entityId(v.id), payload_digest: digest(v.payload_digest),
    source_view: sourceView(v.source_view), assignment_hash: digest(v.assignment_hash), areas: regions(v.areas), readers: parents(v.readers) };
}
export type AnnouncementReference = { id: string; revision: number };
export type SubmissionPreflightInput = { source_view: string; input_oid: string; intent_hash: string; areas: Region[];
  announcement?: AnnouncementReference };
export function decodeSubmissionPreflightInput(value: unknown): SubmissionPreflightInput {
  const v = object(value); fields(v, ["source_view", "input_oid", "intent_hash", "areas", ...(Object.hasOwn(v, "announcement") ? ["announcement"] : [])]);
  return { source_view: sourceView(v.source_view), input_oid: coordinationOid(v.input_oid), intent_hash: digest(v.intent_hash),
    areas: regions(v.areas), ...(Object.hasOwn(v, "announcement") ? { announcement: announcementReference(v.announcement) } : {}) };
}
export type SubmissionBindInput = SubmissionPreflightInput & { operation_key: string; task_id: string; request_key: string;
  expected_decision_identity?: string; payload_digest?: string; assignment_hash?: string };
export function decodeSubmissionBindInput(value: unknown): SubmissionBindInput {
  const v = object(value); fields(v, ["operation_key", "task_id", "request_key", "source_view", "input_oid", "intent_hash", "areas",
    ...(Object.hasOwn(v, "announcement") ? ["announcement"] : []), ...(Object.hasOwn(v, "expected_decision_identity") ? ["expected_decision_identity"] : []),
    ...(Object.hasOwn(v, "payload_digest") ? ["payload_digest"] : []), ...(Object.hasOwn(v, "assignment_hash") ? ["assignment_hash"] : [])]);
  const source = decodeSubmissionPreflightInput({ source_view: v.source_view, input_oid: v.input_oid, intent_hash: v.intent_hash,
    areas: v.areas, ...(Object.hasOwn(v, "announcement") ? { announcement: v.announcement } : {}) });
  if ((v.payload_digest !== undefined) !== (source.announcement !== undefined)
    || (v.assignment_hash !== undefined) !== (source.announcement !== undefined)) invalid("Announcement binding requires its immutable payload and assignment digests");
  return { ...source, operation_key: internalCoordinationOperationKey(v.operation_key), task_id: entityId(v.task_id),
    request_key: coordinationOperationKey(v.request_key),
    ...(Object.hasOwn(v, "expected_decision_identity") ? { expected_decision_identity: digest(v.expected_decision_identity) } : {}),
    ...(Object.hasOwn(v, "payload_digest") ? { payload_digest: digest(v.payload_digest) } : {}),
    ...(Object.hasOwn(v, "assignment_hash") ? { assignment_hash: digest(v.assignment_hash) } : {}) };
}
export type SubmissionDispositionInput = { operation_key: string; task_id: string; request_key: string; link_hash: string };
export function decodeSubmissionDispositionInput(value: unknown): SubmissionDispositionInput {
  const v = object(value); fields(v, ["operation_key", "task_id", "request_key", "link_hash"]);
  return { operation_key: internalCoordinationOperationKey(v.operation_key), task_id: entityId(v.task_id),
    request_key: coordinationOperationKey(v.request_key), link_hash: digest(v.link_hash) };
}
export type SubmissionTerminalInput = SubmissionDispositionInput & { terminal: NonNullable<SubmissionBinding["terminal"]> };
export function decodeSubmissionTerminalInput(value: unknown): SubmissionTerminalInput {
  const v = object(value); fields(v, ["operation_key", "task_id", "request_key", "link_hash", "terminal"]);
  return { ...decodeSubmissionDispositionInput({ operation_key: v.operation_key, task_id: v.task_id,
    request_key: v.request_key, link_hash: v.link_hash }), terminal: terminalEvidence(v.terminal) };
}
export type AnnouncementWithdrawalInput = { operation_key: string; id: string; expected_revision: number };
export function decodeAnnouncementWithdrawalInput(value: unknown): AnnouncementWithdrawalInput {
  const v = object(value); fields(v, ["operation_key", "id", "expected_revision"]);
  return { operation_key: publicCoordinationOperationKey(v.operation_key), id: entityId(v.id), expected_revision: number(v.expected_revision, 1) };
}

/** Complete receipt representation reused by service projections; this proves no current control grant. */
export function decodeCoordinationReceipt(value: unknown): Receipt { return receipt(value); }
