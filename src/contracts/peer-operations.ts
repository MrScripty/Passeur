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
  | (RequestBase & Readonly<{ kind: "source_detail"; work_id: string; report_id: string;
      side: "input" | "observed"; start_byte: number; end_byte: number }>)
  | (RequestBase & Readonly<{ kind: "apply"; note_id: string; expected_case_revision: number;
      expected_case_generation: number; proposal_digest: string }>)
  | (RequestBase & Readonly<{ kind: "propose" | "counter_propose"; proposal: PeerResolutionProposal }>)
  | (RequestBase & Readonly<{ kind: "acknowledge" | "withdraw"; note_id: string }>)
  | (RequestBase & Readonly<{ kind: "await_change"; after_case_revision: number; after_case_generation: number;
      after_negotiation_cursor?: string }>);

type ResultBase = RequestBase;

/** Stable fields the server supplies before the worker chooses scope and file effects. */
export type PeerFirstProposalContext = Readonly<Pick<PeerResolutionProposal, "case_id" | "case_revision" |
  "case_generation" | "evidence_id" | "evidence_revision" | "participants" | "sources" | "permitted_actions"> & {
  schema_version: 2; kind: "peer_resolution_proposal"; proposal_revision: 1;
  action: "propose"; predecessor_digest: null;
}>;
export type PeerSelectedWorkContext = Readonly<{ task_id: string; work_id: string; intent_excerpt: string;
  intent_truncated: boolean; declared_areas: ReadonlyArray<{ kind: "file" | "subtree"; path: string }>;
  areas_omitted: number }>;
export type PeerApplicationOutcome = Readonly<{ proposal_note_id: string; application_note_id: string;
  status: "applied" | "rejected" | "effect_unknown"; proposal_digest: string; application_digest: string }>;

/** Pending is a retained continuation obligation, with no clock or polling instruction. */
export type PeerWorkerOperationResult =
  | (ResultBase & Readonly<{ kind: "current"; operation: "inspect" | "await_change";
      case_revision: number; case_generation: number; evidence_status: "current" | "historical" | "unavailable";
      evidence_id: string | null; evidence_revision: number | null;
      negotiation_cursor: string; proposal_note_id: string | null; proposal: PeerResolutionProposal | null;
      participant_task_ids: string[]; acknowledged_task_ids: string[];
      first_proposal: PeerFirstProposalContext | null;
      application_outcome: PeerApplicationOutcome | null;
      selected_work_context: PeerSelectedWorkContext[]; selected_work_omitted: number }>)
  | (ResultBase & Readonly<{ kind: "detail"; operation: "source_detail"; work_id: string; report_id: string;
      side: "input" | "observed"; start_byte: number; end_byte: number; content_sha256: string; text: string }>)
  | (ResultBase & Readonly<{ kind: "application"; operation: "apply"; note_id: string;
      status: "applied" | "rejected" | "effect_unknown"; application_digest: string | null; paths: string[] }>)
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
function effectPath(value: unknown): string {
  const result = text(value, 4096);
  if (result.startsWith("/") || result.includes("\\") ||
      result.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) {
    invalid("Peer application path is outside its scoped Git source");
  }
  return result;
}

function positive(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) invalid("Peer operation revision must be a positive safe integer");
  return value;
}
function byteOffset(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid("Peer detail offset is invalid");
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
    case "source_detail": {
      exact(entry, [...baseFields, "work_id", "report_id", "side", "start_byte", "end_byte"]);
      const start_byte = byteOffset(entry.start_byte), end_byte = byteOffset(entry.end_byte);
      if (end_byte < start_byte || end_byte - start_byte > 8192) invalid("Peer source detail exceeds its captured-byte bound");
      if (entry.side !== "input" && entry.side !== "observed") invalid("Peer source detail side is invalid");
      return Object.freeze({ ...common, kind: "source_detail", work_id: uuid(entry.work_id), report_id: digest(entry.report_id),
        side: entry.side, start_byte, end_byte });
    }
    case "apply":
      exact(entry, [...baseFields, "note_id", "expected_case_revision", "expected_case_generation", "proposal_digest"]);
      return Object.freeze({ ...common, kind: "apply", note_id: uuid(entry.note_id),
        expected_case_revision: positive(entry.expected_case_revision), expected_case_generation: positive(entry.expected_case_generation),
        proposal_digest: digest(entry.proposal_digest) });
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
    case "verify":
      throw new BridgeError("PEER_OPERATION_UNSUPPORTED", "Verification is not a worker peer operation");
    default:
      throw new BridgeError("PEER_OPERATION_UNSUPPORTED", "Unsupported worker peer operation");
  }
}

export function decodePeerWorkerOperationResult(value: unknown): PeerWorkerOperationResult {
  const entry = object(value);
  const common = base(entry);
  switch (entry.kind) {
    case "current": {
      exact(entry, [...baseFields, "operation", "case_revision", "case_generation", "evidence_id", "evidence_revision", "negotiation_cursor", "proposal_note_id", "proposal", "participant_task_ids", "acknowledged_task_ids",
        ...(Object.hasOwn(entry, "evidence_status") ? ["evidence_status"] : []),
        ...(Object.hasOwn(entry, "first_proposal") ? ["first_proposal"] : []),
        ...(Object.hasOwn(entry, "application_outcome") ? ["application_outcome"] : []),
        ...(Object.hasOwn(entry, "selected_work_context") ? ["selected_work_context", "selected_work_omitted"] : [])]);
      if (entry.operation !== "inspect" && entry.operation !== "await_change") invalid("Current result has an unsupported operation");
      const evidence_status = Object.hasOwn(entry, "evidence_status") ? entry.evidence_status : "current";
      if (evidence_status !== "current" && evidence_status !== "historical" && evidence_status !== "unavailable") {
        invalid("Current evidence status is invalid");
      }
      const evidence_id = evidence_status === "unavailable" && entry.evidence_id === null ? null : digest(entry.evidence_id);
      const evidence_revision = evidence_status === "unavailable" && entry.evidence_revision === null
        ? null : positive(entry.evidence_revision);
      if ((evidence_status === "unavailable") !== (evidence_id === null && evidence_revision === null) ||
        evidence_status === "unavailable" && (entry.proposal !== null || entry.proposal_note_id !== null ||
          entry.first_proposal !== null || !Object.hasOwn(entry, "first_proposal"))) {
        invalid("Unavailable evidence cannot expose a proposal or fabricated capture identity");
      }
      if ((entry.proposal_note_id === null) !== (entry.proposal === null)) invalid("Current proposal and note identity must appear together");
      const participant_task_ids = taskIds(entry.participant_task_ids), acknowledged_task_ids = taskIds(entry.acknowledged_task_ids);
      if (acknowledged_task_ids.some(id => !participant_task_ids.includes(id)) || entry.proposal === null && acknowledged_task_ids.length) {
        invalid("Acknowledgments must name participants in the selected proposal");
      }
      const first_proposal = Object.hasOwn(entry, "first_proposal")
        ? entry.first_proposal === null ? null : firstProposal(entry.first_proposal, common.case_id) : undefined;
      const application_outcome = Object.hasOwn(entry, "application_outcome") && entry.application_outcome !== null
        ? applicationOutcome(entry.application_outcome) : null;
      if (evidence_status === "historical" && (entry.proposal !== null || entry.proposal_note_id !== null ||
        entry.first_proposal !== null || !Object.hasOwn(entry, "first_proposal") ||
        application_outcome?.status !== "applied" && application_outcome?.status !== "effect_unknown")) {
        invalid("Historical evidence requires an exact terminal application outcome without proposal authority");
      }
      const selected_work_context = Object.hasOwn(entry, "selected_work_context")
        ? selectedWorkContext(entry.selected_work_context) : [];
      const selected_work_omitted = Object.hasOwn(entry, "selected_work_context")
        ? nonnegative(entry.selected_work_omitted, 64) : participant_task_ids.length;
      if (selected_work_context.length + selected_work_omitted !== participant_task_ids.length ||
        selected_work_context.some((work, index) => work.task_id !== participant_task_ids[index])) {
        invalid("Selected work context must describe the authorized case participants");
      }
      if (first_proposal && entry.proposal !== null) invalid("First proposal context must appear only before a proposal");
      if (first_proposal && (first_proposal.case_revision !== entry.case_revision || first_proposal.case_generation !== entry.case_generation ||
        first_proposal.evidence_id !== evidence_id || first_proposal.evidence_revision !== evidence_revision)) {
        invalid("First proposal context must match the inspected case and evidence");
      }
      return Object.freeze({ ...common, kind: "current", operation: entry.operation, case_revision: positive(entry.case_revision),
        case_generation: positive(entry.case_generation), evidence_status, evidence_id, evidence_revision,
        negotiation_cursor: digest(entry.negotiation_cursor), participant_task_ids, acknowledged_task_ids,
        first_proposal: first_proposal ?? null,
        application_outcome,
        selected_work_context, selected_work_omitted,
        proposal_note_id: entry.proposal_note_id === null ? null : uuid(entry.proposal_note_id),
        proposal: entry.proposal === null ? null : proposal(entry.proposal, object(entry.proposal).action === "counter_propose" ? "counter_propose" : "propose", common.case_id) });
    }
    case "detail": {
      exact(entry, [...baseFields, "operation", "work_id", "report_id", "side", "start_byte", "end_byte", "content_sha256", "text"]);
      if (entry.operation !== "source_detail" || entry.side !== "input" && entry.side !== "observed") invalid("Peer source detail result is invalid");
      const start_byte = byteOffset(entry.start_byte), end_byte = byteOffset(entry.end_byte);
      if (end_byte < start_byte || end_byte - start_byte > 8192) invalid("Peer source detail result exceeds its captured-byte bound");
      const excerpt = typeof entry.text === "string" ? entry.text : invalid("Peer source detail text is invalid");
      if (Buffer.byteLength(excerpt, "utf8") !== end_byte - start_byte ||
          Buffer.from(excerpt, "utf8").toString("utf8") !== excerpt || /\u0000/.test(excerpt)) {
        invalid("Peer source detail text does not match its exact captured-byte range");
      }
      return Object.freeze({ ...common, kind: "detail", operation: "source_detail", work_id: uuid(entry.work_id),
        report_id: digest(entry.report_id), side: entry.side, start_byte, end_byte,
        content_sha256: digest(entry.content_sha256), text: excerpt });
    }
    case "application": {
      exact(entry, [...baseFields, "operation", "note_id", "status", "application_digest", "paths"]);
      if (entry.operation !== "apply" || !["applied", "rejected", "effect_unknown"].includes(entry.status as string)) {
        invalid("Peer application result is invalid");
      }
      if (!Array.isArray(entry.paths) || entry.paths.length > 32) invalid("Peer application paths are not bounded");
      const paths = entry.paths.map(effectPath);
      if (paths.some((path, index) => index > 0 && paths[index - 1]! >= path)) invalid("Peer application paths must be unique and sorted");
      const application_digest = entry.application_digest === null ? null : digest(entry.application_digest);
      if (entry.status === "applied" && application_digest === null) invalid("Applied peer result requires an effect digest");
      if (entry.status !== "applied" && application_digest !== null) invalid("Unconfirmed peer effect cannot have an applied digest");
      return Object.freeze({ ...common, kind: "application", operation: "apply", note_id: uuid(entry.note_id),
        status: entry.status as "applied" | "rejected" | "effect_unknown", application_digest,
        paths });
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

function firstProposal(value: unknown, caseId: string): PeerFirstProposalContext {
  const entry = object(value);
  exact(entry, ["schema_version", "kind", "case_id", "case_revision", "case_generation", "proposal_revision",
    "evidence_id", "evidence_revision", "participants", "sources", "action", "predecessor_digest", "permitted_actions"]);
  if (entry.schema_version !== 2 || entry.kind !== "peer_resolution_proposal" || entry.action !== "propose" ||
    entry.proposal_revision !== 1 || entry.predecessor_digest !== null || entry.case_id !== caseId) {
    invalid("First proposal context must describe the canonical initial proposal");
  }
  // The canonical proposal decoder validates the nested participant, source, and action contracts.
  // A v1 record carries the same metadata contract without requiring worker-chosen effects.
  const decoded = proposal({ ...entry, schema_version: 1, scope: [], resolution_digest: "0".repeat(64) }, "propose", caseId);
  return { schema_version: 2, kind: "peer_resolution_proposal", case_id: decoded.case_id,
    case_revision: decoded.case_revision, case_generation: decoded.case_generation,
    proposal_revision: 1, evidence_id: decoded.evidence_id,
    evidence_revision: decoded.evidence_revision, participants: decoded.participants,
    sources: decoded.sources, action: "propose", predecessor_digest: null,
    permitted_actions: decoded.permitted_actions };
}

function nonnegative(value: unknown, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) invalid("Peer context count is invalid");
  return value;
}
function selectedWorkContext(value: unknown): PeerSelectedWorkContext[] {
  if (!Array.isArray(value) || value.length > 4) invalid("Selected work context exceeds its presentation bound");
  return value.map(raw => {
    const entry = object(raw);
    exact(entry, ["task_id", "work_id", "intent_excerpt", "intent_truncated", "declared_areas", "areas_omitted"]);
    if (typeof entry.intent_excerpt !== "string" || Buffer.byteLength(entry.intent_excerpt, "utf8") > 256 ||
      entry.intent_excerpt.includes("\0") || Buffer.from(entry.intent_excerpt, "utf8").toString("utf8") !== entry.intent_excerpt ||
      typeof entry.intent_truncated !== "boolean") invalid("Selected work intent is not bounded text");
    if (!Array.isArray(entry.declared_areas) || entry.declared_areas.length > 4) invalid("Declared work areas exceed their presentation bound");
    const declared_areas = entry.declared_areas.map<{ kind: "file" | "subtree"; path: string }>(rawArea => {
      const area = object(rawArea); exact(area, ["kind", "path"]);
      const kind = area.kind;
      if (kind !== "file" && kind !== "subtree" || typeof area.path !== "string" ||
        Buffer.byteLength(area.path, "utf8") > 512) invalid("Declared work area is invalid");
      return { kind, path: effectPath(area.path) };
    });
    return { task_id: uuid(entry.task_id), work_id: uuid(entry.work_id), intent_excerpt: entry.intent_excerpt,
      intent_truncated: entry.intent_truncated, declared_areas, areas_omitted: nonnegative(entry.areas_omitted, 256) };
  });
}
function applicationOutcome(value: unknown): PeerApplicationOutcome {
  const entry = object(value);
  exact(entry, ["proposal_note_id", "application_note_id", "status", "proposal_digest", "application_digest"]);
  if (entry.status !== "applied" && entry.status !== "rejected" && entry.status !== "effect_unknown") {
    invalid("Peer application outcome status is invalid");
  }
  return { proposal_note_id: uuid(entry.proposal_note_id), application_note_id: uuid(entry.application_note_id),
    status: entry.status, proposal_digest: digest(entry.proposal_digest),
    application_digest: digest(entry.application_digest) };
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
