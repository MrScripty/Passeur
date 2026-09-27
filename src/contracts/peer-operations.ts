import { isAbsolute } from "node:path";
import { BridgeError } from "../core/errors.js";
import {
  decodePeerResolutionText, encodePeerResolutionRecord, PEER_RESOLUTION_PREFIX,
  PEER_RESOLUTION_MAX_BYTES, type PeerResolutionProposal,
} from "../coordination/peer-resolution.js";

export const PEER_OPERATION_SCHEMA = 1 as const;

/** Identity is supplied by the task-bound coordinator, never trusted from worker text alone. */
export type PeerWorkerIdentity = Readonly<{
  task_id: string;
  run_id: string;
  control_generation: number;
  workspace_id: string;
  source_view: string;
  case_id: string;
}>;

type RequestBase = PeerWorkerIdentity & Readonly<{
  schema_version: typeof PEER_OPERATION_SCHEMA;
  operation_key: string;
}>;

export type PeerWorkerOperation =
  | (RequestBase & Readonly<{ kind: "inspect" }>)
  | (RequestBase & Readonly<{ kind: "propose" | "counter_propose"; proposal: PeerResolutionProposal }>)
  | (RequestBase & Readonly<{ kind: "acknowledge" | "withdraw"; note_id: string }>)
  | (RequestBase & Readonly<{ kind: "await_change"; after_case_revision: number; after_case_generation: number;
      after_negotiation_cursor?: string }>);

type ResultBase = RequestBase;

/** Pending is a retained continuation obligation, with no clock or polling instruction. */
export type PeerWorkerOperationResult =
  | (ResultBase & Readonly<{ kind: "current"; operation: "inspect" | "await_change";
      case_revision: number; case_generation: number; evidence_id: string; evidence_revision: number;
      negotiation_cursor: string; proposal_note_id: string | null; proposal: PeerResolutionProposal | null;
      participant_task_ids: string[]; acknowledged_task_ids: string[] }>)
  | (ResultBase & Readonly<{ kind: "receipt"; operation: "propose" | "counter_propose" | "acknowledge" | "withdraw";
      receipt_revision: number; note_id: string }>)
  | (ResultBase & Readonly<{ kind: "pending"; operation: "await_change";
      after_case_revision: number; after_case_generation: number; after_negotiation_cursor?: string }>);

function invalid(message: string): never {
  throw new BridgeError("PEER_OPERATION_INVALID", message);
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid("Expected a peer operation record");
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) invalid("Peer operation records must be plain values");
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") invalid("Peer operation records cannot contain symbol fields");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) invalid("Peer operation fields must be enumerable data values");
  }
  return Object.fromEntries(Object.entries(value));
}

function exact(value: Record<string, unknown>, fields: readonly string[]): void {
  if (Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) {
    invalid("Peer operation fields do not match the selected contract");
  }
}

function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value.length || Buffer.byteLength(value, "utf8") > maximum ||
      Buffer.from(value, "utf8").toString("utf8") !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    invalid("Peer operation text violates its bounded UTF-8 contract");
  }
  return value;
}

function uuid(value: unknown): string {
  const result = text(value, 36);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(result)) invalid("Peer operation identity must be a UUID");
  return result;
}

function digest(value: unknown): string {
  const result = text(value, 64);
  if (!/^[a-f0-9]{64}$/.test(result)) invalid("Peer operation evidence must be a SHA-256 identity");
  return result;
}

function positive(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) invalid("Peer operation revision must be a positive safe integer");
  return value;
}

const identityFields = ["task_id", "run_id", "control_generation", "workspace_id", "source_view", "case_id"] as const;
const baseFields = ["schema_version", ...identityFields, "operation_key", "kind"] as const;

function identity(value: Record<string, unknown>): PeerWorkerIdentity {
  const source_view = text(value.source_view, 4096);
  if (!isAbsolute(source_view)) invalid("Peer operation source view must be an absolute path");
  return {
    task_id: uuid(value.task_id), run_id: uuid(value.run_id), control_generation: positive(value.control_generation),
    workspace_id: text(value.workspace_id, 4096), source_view, case_id: uuid(value.case_id),
  };
}

export function decodePeerWorkerIdentity(value: unknown): PeerWorkerIdentity {
  const entry = object(value);
  exact(entry, identityFields);
  return Object.freeze(identity(entry));
}

function base(value: Record<string, unknown>): RequestBase {
  if (value.schema_version !== PEER_OPERATION_SCHEMA) invalid("Unsupported peer operation schema");
  return { schema_version: PEER_OPERATION_SCHEMA, ...identity(value), operation_key: text(value.operation_key, 256) };
}

/** Copy only bounded JSON data before delegating every proposal invariant to the canonical codec. */
function jsonData(value: unknown, depth: number, budget: { nodes: number }, seen: WeakSet<object>): unknown {
  if (++budget.nodes > 2048 || depth > 12) invalid("Peer proposal exceeds its structural bounds");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return text(value, PEER_RESOLUTION_MAX_BYTES);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid("Peer proposal contains a non-finite number");
    return value;
  }
  if (typeof value !== "object" || seen.has(value)) invalid("Peer proposal contains unsupported or cyclic data");
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > 256 || Reflect.ownKeys(value).length !== value.length + 1) invalid("Peer proposal array is not bounded and dense");
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) invalid("Peer proposal array contains an accessor or hole");
      result.push(jsonData(descriptor.value, depth + 1, budget, seen));
    }
    seen.delete(value);
    return result;
  }
  const entry = object(value);
  const result = Object.fromEntries(Object.entries(entry).map(([key, item]) => [key, jsonData(item, depth + 1, budget, seen)]));
  seen.delete(value);
  return result;
}

function proposal(value: unknown, action: "propose" | "counter_propose", caseId: string): PeerResolutionProposal {
  const safe = jsonData(value, 0, { nodes: 0 }, new WeakSet<object>());
  const encoded = `${PEER_RESOLUTION_PREFIX}${JSON.stringify(safe)}`;
  const record = decodePeerResolutionText(encoded);
  if (record?.kind !== "peer_resolution_proposal" || record.action !== action || record.case_id !== caseId) {
    invalid("Peer operation proposal must match its action and case");
  }
  // The encoder enforces the same canonical record and encoded-byte budget used for retained notes.
  encodePeerResolutionRecord(record);
  return record;
}

export function decodePeerWorkerOperation(value: unknown): PeerWorkerOperation {
  const entry = object(value);
  const common = base(entry);
  switch (entry.kind) {
    case "inspect":
      exact(entry, baseFields);
      return Object.freeze({ ...common, kind: "inspect" });
    case "propose": case "counter_propose":
      exact(entry, [...baseFields, "proposal"]);
      return Object.freeze({ ...common, kind: entry.kind, proposal: proposal(entry.proposal, entry.kind, common.case_id) });
    case "acknowledge": case "withdraw":
      exact(entry, [...baseFields, "note_id"]);
      return Object.freeze({ ...common, kind: entry.kind, note_id: uuid(entry.note_id) });
    case "await_change":
      exact(entry, [...baseFields, "after_case_revision", "after_case_generation", ...(Object.hasOwn(entry, "after_negotiation_cursor") ? ["after_negotiation_cursor"] : [])]);
      return Object.freeze({ ...common, kind: "await_change", after_case_revision: positive(entry.after_case_revision),
        after_case_generation: positive(entry.after_case_generation),
        ...(Object.hasOwn(entry, "after_negotiation_cursor") ? { after_negotiation_cursor: digest(entry.after_negotiation_cursor) } : {}) });
    case "apply": case "verify":
      throw new BridgeError("PEER_OPERATION_UNSUPPORTED", "Application and verification are not worker peer operations");
    default:
      throw new BridgeError("PEER_OPERATION_UNSUPPORTED", "Unsupported worker peer operation");
  }
}

export function decodePeerWorkerOperationResult(value: unknown): PeerWorkerOperationResult {
  const entry = object(value);
  const common = base(entry);
  switch (entry.kind) {
    case "current": {
      exact(entry, [...baseFields, "operation", "case_revision", "case_generation", "evidence_id", "evidence_revision", "negotiation_cursor", "proposal_note_id", "proposal", "participant_task_ids", "acknowledged_task_ids"]);
      if (entry.operation !== "inspect" && entry.operation !== "await_change") invalid("Current result has an unsupported operation");
      if ((entry.proposal_note_id === null) !== (entry.proposal === null)) invalid("Current proposal and note identity must appear together");
      const participant_task_ids = taskIds(entry.participant_task_ids), acknowledged_task_ids = taskIds(entry.acknowledged_task_ids);
      if (acknowledged_task_ids.some(id => !participant_task_ids.includes(id)) || entry.proposal === null && acknowledged_task_ids.length) {
        invalid("Acknowledgments must name participants in the selected proposal");
      }
      return Object.freeze({ ...common, kind: "current", operation: entry.operation, case_revision: positive(entry.case_revision),
        case_generation: positive(entry.case_generation), evidence_id: digest(entry.evidence_id), evidence_revision: positive(entry.evidence_revision),
        negotiation_cursor: digest(entry.negotiation_cursor), participant_task_ids, acknowledged_task_ids,
        proposal_note_id: entry.proposal_note_id === null ? null : uuid(entry.proposal_note_id),
        proposal: entry.proposal === null ? null : proposal(entry.proposal, object(entry.proposal).action === "counter_propose" ? "counter_propose" : "propose", common.case_id) });
    }
    case "receipt":
      exact(entry, [...baseFields, "operation", "receipt_revision", "note_id"]);
      if (entry.operation !== "propose" && entry.operation !== "counter_propose" && entry.operation !== "acknowledge" && entry.operation !== "withdraw") {
        invalid("Receipt has an unsupported mutation operation");
      }
      return Object.freeze({ ...common, kind: "receipt", operation: entry.operation,
        receipt_revision: positive(entry.receipt_revision), note_id: uuid(entry.note_id) });
    case "pending":
      exact(entry, [...baseFields, "operation", "after_case_revision", "after_case_generation", ...(Object.hasOwn(entry, "after_negotiation_cursor") ? ["after_negotiation_cursor"] : [])]);
      if (entry.operation !== "await_change") invalid("Pending result must continue await_change");
      return Object.freeze({ ...common, kind: "pending", operation: "await_change",
        after_case_revision: positive(entry.after_case_revision), after_case_generation: positive(entry.after_case_generation),
        ...(Object.hasOwn(entry, "after_negotiation_cursor") ? { after_negotiation_cursor: digest(entry.after_negotiation_cursor) } : {}) });
    default:
      throw new BridgeError("PEER_OPERATION_UNSUPPORTED", "Unsupported worker peer result");
  }
}

function taskIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 64 || Reflect.ownKeys(value).length !== value.length + 1) {
    invalid("Peer participants exceed their bound or contain extra fields");
  }
  const ids = Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) invalid("Peer participants must be dense data values");
    return uuid(descriptor.value);
  });
  if (new Set(ids).size !== ids.length) invalid("Peer participants must be distinct");
  return ids;
}
