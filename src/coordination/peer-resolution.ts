import { BridgeError } from "../core/errors.js";
import type { ParentId, Region } from "../contracts/coordination-control.js";

/** Versioned, content-addressed coordination payload carried by an existing note. */
export const PEER_RESOLUTION_SCHEMA = 1 as const;
export const PEER_RESOLUTION_PREFIX = "passeur-peer-resolution-v1:";
export const PEER_RESOLUTION_ACTIONS = ["inspect_evidence", "propose", "counter_propose", "acknowledge", "apply", "verify"] as const;
export const PEER_RESOLUTION_MAX_BYTES = 15_000;
const MAX_SCOPE = 256;
const MAX_SOURCES = 64;

export type PeerResolutionSource = Readonly<{
  work_id: string;
  work_revision: number;
  input_oid: string;
  selected_commit_oid: string;
}>;

export type PeerResolutionProposal = Readonly<{
  schema_version: typeof PEER_RESOLUTION_SCHEMA;
  kind: "peer_resolution_proposal";
  case_id: string;
  case_revision: number;
  case_generation: number;
  proposal_revision: number;
  evidence_id: string;
  evidence_revision: number;
  participants: readonly ParentId[];
  sources: readonly PeerResolutionSource[];
  scope: readonly Region[];
  action: "propose" | "counter_propose";
  resolution_digest: string;
  predecessor_digest: string | null;
  permitted_actions: readonly typeof PEER_RESOLUTION_ACTIONS[number][];
}>;

export type PeerResolutionApplication = Readonly<{
  schema_version: typeof PEER_RESOLUTION_SCHEMA;
  kind: "peer_resolution_application";
  case_id: string;
  case_revision: number;
  case_generation: number;
  evidence_id: string;
  evidence_revision: number;
  sources: readonly PeerResolutionSource[];
  scope: readonly Region[];
  proposal_digest: string;
  application_digest: string;
  status: "pending" | "applied" | "effect_unknown" | "rejected";
}>;

export type PeerResolutionVerification = Readonly<{
  schema_version: typeof PEER_RESOLUTION_SCHEMA;
  kind: "peer_resolution_verification";
  case_id: string;
  case_revision: number;
  case_generation: number;
  evidence_id: string;
  evidence_revision: number;
  sources: readonly PeerResolutionSource[];
  scope: readonly Region[];
  application_digest: string;
  status: "not_run" | "passed" | "failed" | "unavailable";
}>;

export type PeerResolutionRecord = PeerResolutionProposal | PeerResolutionApplication | PeerResolutionVerification;

function invalid(message: string): never {
  throw new BridgeError("PEER_RESOLUTION_INVALID", message);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as object)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid("Expected a peer-resolution record");
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) invalid("Peer-resolution records must be plain values");
  return Object.fromEntries(Object.entries(value));
}

function exact(value: Record<string, unknown>, fields: readonly string[]): void {
  if (Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) {
    invalid("Peer-resolution record fields do not match its schema");
  }
}

function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value.length || Buffer.byteLength(value, "utf8") > maximum ||
      Buffer.from(value, "utf8").toString("utf8") !== value || value.includes("\0") || /[\r\n]/.test(value)) {
    invalid("Peer-resolution text violates its bounded UTF-8 contract");
  }
  return value;
}

function integer(value: unknown, minimum = 1, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    invalid("Peer-resolution version is outside its supported bounds");
  }
  return value;
}

function digest(value: unknown): string {
  const result = text(value, 64);
  if (!/^[a-f0-9]{64}$/.test(result)) invalid("Peer-resolution digest must be a SHA-256 identity");
  return result;
}

function uuid(value: unknown): string {
  const result = text(value, 36);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(result)) invalid("Peer-resolution identity must be a UUID");
  return result;
}

function parent(value: unknown): ParentId {
  const result = text(value, 64);
  if (!/^[a-f0-9]{64}$/.test(result)) invalid("Peer-resolution participant must be an authenticated parent identity");
  return result;
}

function oid(value: unknown): string {
  const result = text(value, 64);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(result)) invalid("Peer-resolution source must identify a full Git object");
  return result;
}

function path(value: unknown): string {
  const result = text(value, 4096);
  if (result.startsWith("/") || result.split("/").some(part => !part || part === "." || part === ".." || part === ".git")) {
    invalid("Peer-resolution scope must be a component-relative Git path");
  }
  return result;
}

function regions(value: unknown): Region[] {
  if (!Array.isArray(value) || value.length > MAX_SCOPE) invalid("Peer-resolution scope is not a bounded array");
  const result = value.map(item => {
    const entry = record(item); exact(entry, ["kind", "path"]);
    const kind = entry.kind === "file" || entry.kind === "subtree" ? entry.kind : invalid("Peer-resolution scope has an unsupported kind");
    return { kind, path: path(entry.path) } as Region;
  });
  if (new Set(result.map(item => `${item.kind}:${item.path}`)).size !== result.length) invalid("Peer-resolution scope contains duplicates");
  return result;
}

function participants(value: unknown): ParentId[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) invalid("Peer-resolution participants are not bounded");
  const result = value.map(parent);
  if (new Set(result).size !== result.length) invalid("Peer-resolution participants contain duplicates");
  return result;
}

function sources(value: unknown): PeerResolutionSource[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SOURCES) invalid("Peer-resolution sources are not bounded");
  const result = value.map(item => {
    const entry = record(item); exact(entry, ["work_id", "work_revision", "input_oid", "selected_commit_oid"]);
    return { work_id: uuid(entry.work_id), work_revision: integer(entry.work_revision), input_oid: oid(entry.input_oid), selected_commit_oid: oid(entry.selected_commit_oid) };
  });
  if (new Set(result.map(item => item.work_id)).size !== result.length) invalid("Peer-resolution sources contain duplicate work identities");
  return result;
}

function actions(value: unknown): Array<typeof PEER_RESOLUTION_ACTIONS[number]> {
  if (!Array.isArray(value) || value.length !== PEER_RESOLUTION_ACTIONS.length) invalid("Peer-resolution permitted actions are incomplete");
  const result = value.map(item => {
    if (!PEER_RESOLUTION_ACTIONS.includes(item as typeof PEER_RESOLUTION_ACTIONS[number])) invalid("Peer-resolution contains an unsupported permitted action");
    return item as typeof PEER_RESOLUTION_ACTIONS[number];
  });
  if (new Set(result).size !== result.length || result.some((item, index) => item !== PEER_RESOLUTION_ACTIONS[index])) invalid("Peer-resolution permitted actions are not canonical");
  return result;
}

function baseFields(entry: Record<string, unknown>): { schema_version: 1; case_id: string; case_revision: number; case_generation: number; evidence_id: string; evidence_revision: number } {
  const schema_version = entry.schema_version === PEER_RESOLUTION_SCHEMA ? PEER_RESOLUTION_SCHEMA : invalid("Unsupported peer-resolution schema");
  return { schema_version, case_id: uuid(entry.case_id), case_revision: integer(entry.case_revision), case_generation: integer(entry.case_generation),
    evidence_id: digest(entry.evidence_id), evidence_revision: integer(entry.evidence_revision) };
}

function decodeRecord(value: unknown): PeerResolutionRecord {
  const entry = record(value);
  if (entry.kind === "peer_resolution_proposal") {
    exact(entry, ["schema_version", "kind", "case_id", "case_revision", "case_generation", "proposal_revision", "evidence_id", "evidence_revision", "participants", "sources", "scope", "action", "resolution_digest", "predecessor_digest", "permitted_actions"]);
    const base = baseFields(entry);
    const action = entry.action === "propose" || entry.action === "counter_propose" ? entry.action : invalid("Unsupported peer-resolution proposal action");
    const predecessor_digest = entry.predecessor_digest === null ? null : digest(entry.predecessor_digest);
    if ((action === "counter_propose") !== (predecessor_digest !== null)) invalid("Counter-proposals require exactly one predecessor digest");
    return { ...base, kind: "peer_resolution_proposal", proposal_revision: integer(entry.proposal_revision, 1, 4096), participants: participants(entry.participants),
      sources: sources(entry.sources), scope: regions(entry.scope), action, resolution_digest: digest(entry.resolution_digest), predecessor_digest, permitted_actions: actions(entry.permitted_actions) };
  }
  if (entry.kind === "peer_resolution_application") {
    exact(entry, ["schema_version", "kind", "case_id", "case_revision", "case_generation", "evidence_id", "evidence_revision", "sources", "scope", "proposal_digest", "application_digest", "status"]);
    const base = baseFields(entry), status = ["pending", "applied", "effect_unknown", "rejected"].includes(entry.status as string) ? entry.status as PeerResolutionApplication["status"] : invalid("Unsupported peer-resolution application status");
    return { ...base, kind: "peer_resolution_application", sources: sources(entry.sources), scope: regions(entry.scope), proposal_digest: digest(entry.proposal_digest), application_digest: digest(entry.application_digest), status };
  }
  if (entry.kind === "peer_resolution_verification") {
    exact(entry, ["schema_version", "kind", "case_id", "case_revision", "case_generation", "evidence_id", "evidence_revision", "sources", "scope", "application_digest", "status"]);
    const base = baseFields(entry), status = ["not_run", "passed", "failed", "unavailable"].includes(entry.status as string) ? entry.status as PeerResolutionVerification["status"] : invalid("Unsupported peer-resolution verification status");
    return { ...base, kind: "peer_resolution_verification", sources: sources(entry.sources), scope: regions(entry.scope), application_digest: digest(entry.application_digest), status };
  }
  return invalid("Unsupported peer-resolution record kind");
}

/** Decode only the explicitly marked structured payload; ordinary legacy notes remain ordinary notes. */
export function decodePeerResolutionText(value: string): PeerResolutionRecord | null {
  if (!value.startsWith(PEER_RESOLUTION_PREFIX)) return null;
  if (Buffer.byteLength(value, "utf8") > PEER_RESOLUTION_MAX_BYTES) invalid("Peer-resolution payload exceeds its bounded note budget");
  let parsed: unknown;
  try { parsed = JSON.parse(value.slice(PEER_RESOLUTION_PREFIX.length)); }
  catch (cause) { throw new BridgeError("PEER_RESOLUTION_INVALID", "Peer-resolution payload is not valid JSON", { cause }); }
  return deepFreeze(decodeRecord(parsed));
}

/** Canonical transport text for callers that already hold a validated record. */
export function encodePeerResolutionRecord(value: PeerResolutionRecord): string {
  const decoded = decodeRecord(value);
  const encoded = `${PEER_RESOLUTION_PREFIX}${JSON.stringify(decoded)}`;
  if (Buffer.byteLength(encoded, "utf8") > PEER_RESOLUTION_MAX_BYTES) invalid("Peer-resolution payload exceeds its bounded note budget");
  return encoded;
}
