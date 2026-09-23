import { BridgeError } from "../core/errors.js";
import { canonicalHash } from "../core/async.js";
import { CONTROL_MAX_BYTES, coordinationOperationKey, decodeCoordinationReceipt, decodeLimits,
  decodeRepositoryCommand, decodePublicRecoveryCommand, decodeRecoveryReceipt, entityId, parentId, type RecoveryCommand, type RecoveryReceipt, type Limits, type Receipt, type RepositoryCommand } from "./coordination-control.js";

/** Versioned metadata operation; CLI/MCP project this contract without granting additional authority. */
export const COORDINATION_SERVICE_VERSION = 1;
export const COORDINATION_PAGE_BYTES = 8192;
export const COORDINATION_MESSAGE_BYTES = 24_576;
export const COORDINATION_VIEW_BYTES = CONTROL_MAX_BYTES + 4096;
export type CoordinationSelector =
  | { kind: "work" | "note" | "case" | "overlaps"; id: string }
  | { kind: "receipt"; operation_key: string };
export type RecoverySelector =
  | { kind: "inventory" }
  | { kind: "work" | "case"; id: string }
  | { kind: "receipt"; operation_key: string };
export type CoordinationRequest =
  | { schema_version: 1; kind: "identity" }
  | { schema_version: 1; kind: "status" }
  | { schema_version: 1; kind: "initialize"; limits: Limits }
  | { schema_version: 1; kind: "command"; command: RepositoryCommand }
  | { schema_version: 1; kind: "recover_metadata"; recovery: RecoveryCommand }
  | { schema_version: 1; kind: "recovery_read"; selector: RecoverySelector; offset: number; limit: number; expected_hash: string | null }
  | { schema_version: 1; kind: "read"; selector: CoordinationSelector; offset: number; limit: number; expected_hash: string | null };
export type CoordinationReply =
  | { schema_version: 1; kind: "identity"; repository_id: string; parent_id: string }
  | { schema_version: 1; kind: "status"; repository_id: string; state: "not_enabled" }
  | { schema_version: 1; kind: "status"; repository_id: string; state: "ready"; epoch: string; revision: number; limits: Limits }
  | { schema_version: 1; kind: "receipt"; repository_id: string; receipt: Receipt }
  | { schema_version: 1; kind: "recovery_receipt"; repository_id: string; receipt: RecoveryReceipt }
  | { schema_version: 1; kind: "page"; repository_id: string; selector: CoordinationSelector | RecoverySelector; hash: string;
      offset: number; bytes: number; next_offset: number; total_bytes: number; eof: boolean; content: string };

/** Borrowed client interface. Its implementation owns authenticated transport and reply validation. */
export interface CoordinationEndpoint {
  coordinate(request: unknown, signal?: AbortSignal): Promise<CoordinationReply>;
}

function invalid(message: string): never { throw new BridgeError("COORDINATION_SERVICE_INVALID", message); }
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid("Expected an operation record");
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return invalid("Expected a plain operation record");
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== "string" || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) return invalid("Operation fields must be enumerable data properties");
  }
  return Object.fromEntries(Object.entries(value));
}
function fields(value: Record<string, unknown>, expected: string[]): void {
  if (Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) invalid("Fields do not match this operation variant");
}
function boundedInteger(value: unknown, maximum: number, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) return invalid("Invalid integer bound");
  return value;
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) return invalid("Expected a SHA-256 view identity");
  return value;
}
function repository(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{24}$/.test(value)) return invalid("Expected the canonical repository identity");
  return value;
}
function version(value: Record<string, unknown>): void {
  if (!Number.isSafeInteger(value.schema_version) || typeof value.schema_version !== "number" || value.schema_version < 1) invalid("Invalid operation version");
  if (value.schema_version !== COORDINATION_SERVICE_VERSION) throw new BridgeError("COORDINATION_SERVICE_VERSION_UNSUPPORTED", "This service contract version has no implemented reader");
}
function selector(value: unknown): CoordinationSelector {
  const v = object(value);
  if (v.kind === "receipt") {
    fields(v, ["kind", "operation_key"]);
    return { kind: v.kind, operation_key: coordinationOperationKey(v.operation_key) };
  }
  fields(v, ["kind", "id"]);
  if (v.kind !== "work" && v.kind !== "note" && v.kind !== "case" && v.kind !== "overlaps") return invalid("Unknown read selector");
  return { kind: v.kind, id: entityId(v.id) };
}
function recoverySelector(value: unknown): RecoverySelector {
  const v = object(value);
  if (v.kind === "inventory") { fields(v, ["kind"]); return { kind: "inventory" }; }
  const selected = selector(v);
  if (selected.kind === "note" || selected.kind === "overlaps") return invalid("Recovery inspection exposes only work, cases and recovery receipts");
  return selected.kind === "receipt" ? selected : { kind: selected.kind, id: selected.id };
}
function messageBound(value: unknown): void {
  // Only reconstructed, validated values reach serialization; raw accessors are never invoked here.
  if (Buffer.byteLength(JSON.stringify(value)) > COORDINATION_MESSAGE_BYTES) throw new BridgeError("COORDINATION_MESSAGE_TOO_LARGE", "The selected service representation exceeds its byte bound");
}
export function decodeCoordinationRequest(value: unknown): CoordinationRequest {
  const v = object(value); version(v);
  let result: CoordinationRequest;
  switch (v.kind) {
    case "identity": case "status":
      fields(v, ["schema_version", "kind"]); result = { schema_version: 1, kind: v.kind }; break;
    case "initialize":
      fields(v, ["schema_version", "kind", "limits"]); result = { schema_version: 1, kind: v.kind, limits: decodeLimits(v.limits) }; break;
    case "command":
      fields(v, ["schema_version", "kind", "command"]); result = { schema_version: 1, kind: v.kind, command: decodeRepositoryCommand(v.command) }; break;
    case "recover_metadata":
      fields(v, ["schema_version", "kind", "recovery"]);
      result = { schema_version: 1, kind: v.kind, recovery: decodePublicRecoveryCommand(v.recovery) }; break;
    case "read": case "recovery_read": {
      fields(v, ["schema_version", "kind", "selector", "offset", "limit", "expected_hash"]);
      const offset = boundedInteger(v.offset, COORDINATION_VIEW_BYTES), expected_hash = v.expected_hash === null ? null : digest(v.expected_hash);
      if (offset > 0 && expected_hash === null) invalid("Continuation pages require the original view identity");
      const page = { schema_version: 1 as const, offset, limit: boundedInteger(v.limit, COORDINATION_PAGE_BYTES, 4), expected_hash };
      result = v.kind === "recovery_read" ? { ...page, kind: v.kind, selector: recoverySelector(v.selector) }
        : { ...page, kind: v.kind, selector: selector(v.selector) }; break;
    }
    default:
      if (typeof v.kind === "string") throw new BridgeError("COORDINATION_SERVICE_OPERATION_UNSUPPORTED", "The service operation has no implemented handler");
      return invalid("Missing operation discriminant");
  }
  messageBound(result); return result;
}

/** Reserved capacity is for completing/releasing authority, never a bypass of command validation. */
export function coordinationRequestLane(request: CoordinationRequest): "ordinary" | "control" {
  if (request.kind === "recovery_read" || request.kind === "recover_metadata") return "control";
  if (request.kind === "read" && request.selector.kind === "receipt") return "control";
  if (request.kind !== "command") return "ordinary";
  const c = request.command;
  return c.kind === "close_work" || c.kind === "release_case" || c.kind === "record_external_settlement"
    || c.kind === "withdraw_note" || c.kind === "share_work" && c.readers.length === 0
    || c.kind === "grant_source" && c.recipients.length === 0
    || c.kind === "watch_source" && c.watchers.length === 0 ? "control" : "ordinary";
}

/** Complete destination proof, including the request/actor/selector relation. */
export function decodeCoordinationReply(requestValue: CoordinationRequest, parentValue: string, repositoryValue: string, value: unknown): CoordinationReply {
  const request = decodeCoordinationRequest(requestValue), parent = parentId(parentValue), repository_id = repository(repositoryValue);
  const v = object(value); version(v);
  if (v.repository_id !== repository_id) return invalid("Reply belongs to a different repository");
  let result: CoordinationReply;
  if (request.kind === "identity") {
    fields(v, ["schema_version", "kind", "repository_id", "parent_id"]);
    if (v.kind !== "identity" || v.parent_id !== parent) return invalid("Identity reply does not match the authenticated parent");
    result = { schema_version: 1, kind: "identity", repository_id, parent_id: parent };
  } else if (request.kind === "status" || request.kind === "initialize") {
    if (v.kind !== "status") return invalid("Expected enablement status");
    if (v.state === "not_enabled") {
      fields(v, ["schema_version", "kind", "repository_id", "state"]);
      if (request.kind === "initialize") return invalid("Initialization did not produce enabled authority");
      result = { schema_version: 1, kind: "status", repository_id, state: "not_enabled" };
    } else {
      fields(v, ["schema_version", "kind", "repository_id", "state", "epoch", "revision", "limits"]);
      if (v.state !== "ready") return invalid("Unknown coordination status");
      const limits = decodeLimits(v.limits);
      if (request.kind === "initialize" && canonicalHash(limits) !== canonicalHash(request.limits)) return invalid("Initialization changed the requested limits");
      result = { schema_version: 1, kind: "status", repository_id, state: "ready", epoch: entityId(v.epoch),
        revision: boundedInteger(v.revision, Number.MAX_SAFE_INTEGER), limits };
    }
  } else if (request.kind === "recover_metadata") {
    fields(v, ["schema_version", "kind", "repository_id", "receipt"]);
    if (v.kind !== "recovery_receipt") return invalid("Expected an operator recovery receipt");
    const receipt = decodeRecoveryReceipt(v.receipt);
    if (receipt.operator !== parent || receipt.request_hash !== canonicalHash({ operator: parent, recovery: request.recovery })
      || canonicalHash(receipt.command) !== canonicalHash(request.recovery)) return invalid("Recovery receipt acknowledges a different operator or request");
    result = { schema_version: 1, kind: "recovery_receipt", repository_id, receipt };
  } else if (request.kind === "command") {
    fields(v, ["schema_version", "kind", "repository_id", "receipt"]);
    if (v.kind !== "receipt") return invalid("Expected a command receipt");
    const receipt = decodeCoordinationReceipt(v.receipt), command = request.command;
    const action = command.kind === "register_external_work" ? "register_work" : command.kind === "register_managed_work" ? "register_task_work" : command.kind;
    if (receipt.owner !== parent || receipt.action !== action || receipt.key !== command.operation_key) return invalid("Receipt does not acknowledge this parent's command");
    if (command.kind !== "register_external_work" && command.kind !== "register_managed_work" && receipt.request_hash !== canonicalHash({ owner: parent, command })) return invalid("Receipt acknowledges different command content");
    if ("work_id" in command && (receipt.entity.kind !== "work" || receipt.entity.id !== command.work_id || receipt.item_id !== command.work_id)
      || "case_id" in command && (receipt.entity.kind !== "case" || receipt.entity.id !== command.case_id || receipt.item_id !== command.case_id)
      || "note_id" in command && receipt.item_id !== command.note_id
      || command.kind === "post_note" && canonicalHash(receipt.entity) !== canonicalHash(command.subject)
      || command.kind === "register_managed_work" && (receipt.entity.kind !== "work" || receipt.entity.id !== command.task_id || receipt.item_id !== command.task_id)
      || action === "register_work" && (receipt.entity.kind !== "work" || receipt.entity.id !== receipt.item_id)
      || action === "claim_target" && (receipt.entity.kind !== "case" || receipt.entity.id !== receipt.item_id)) return invalid("Receipt names a different command subject");
    result = { schema_version: 1, kind: "receipt", repository_id, receipt };
  } else {
    fields(v, ["schema_version", "kind", "repository_id", "selector", "hash", "offset", "bytes", "next_offset", "total_bytes", "eof", "content"]);
    if (v.kind !== "page") return invalid("Expected a read page");
    const subject = request.kind === "recovery_read" ? recoverySelector(v.selector) : selector(v.selector);
    const hash = digest(v.hash), offset = boundedInteger(v.offset, COORDINATION_VIEW_BYTES);
    const bytes = boundedInteger(v.bytes, request.limit), next_offset = boundedInteger(v.next_offset, COORDINATION_VIEW_BYTES);
    const total_bytes = boundedInteger(v.total_bytes, COORDINATION_VIEW_BYTES);
    if (canonicalHash(subject) !== canonicalHash(request.selector) || offset !== request.offset || request.expected_hash !== null && hash !== request.expected_hash) return invalid("Read page does not match its selector or continuation");
    if (typeof v.content !== "string" || Buffer.from(v.content, "utf8").toString("utf8") !== v.content || Buffer.byteLength(v.content) !== bytes
      || next_offset !== offset + bytes || next_offset > total_bytes || typeof v.eof !== "boolean" || v.eof !== (next_offset === total_bytes)
      || !v.eof && bytes === 0) return invalid("Read page has contradictory text/range/termination fields");
    result = { schema_version: 1, kind: "page", repository_id, selector: subject, hash, offset, bytes, next_offset, total_bytes, eof: v.eof, content: v.content };
  }
  messageBound(result); return result;
}
