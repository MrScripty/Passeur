import { createHash } from "node:crypto";
import { BridgeError } from "../core/errors.js";
import type { Declaration, SourceFile, SourceReference } from "./model.js";
import { sourceExcerpt, sourceReference } from "./source.js";

/** Versioned selection policy for the source-grounded peer handoff. */
export const PEER_OVERLAP_POLICY = "minimal-overlap-v1";
export const PEER_OVERLAP_SCHEMA = 1 as const;
export const PEER_OVERLAP_DEFAULT_BUDGET = 32 * 1024;
const MAX_OBSERVATIONS = 64;
const MAX_SPANS_PER_CHANGE = 4;
const CONTEXT_BYTES = 24;

export type PeerOverlapSide = "input" | "observed";
export type PeerOverlapSpan = Readonly<{
  side: PeerOverlapSide;
  range: Readonly<{ start_byte: number; end_byte: number }>;
  text: string;
  omitted_before: boolean;
  omitted_after: boolean;
  reason: "signature_changed" | "body_changed" | "default_changed" | "declaration_added" | "declaration_removed";
}>;
export type PeerOverlapChange = Readonly<{
  observation_id: string;
  kind: "modified" | "added" | "removed";
  declaration_changed: boolean;
  body_changed: boolean;
  default_changed: boolean;
  observed_source: SourceReference;
  input_declaration?: PeerOverlapEvidence["subject"];
  observed_declaration?: PeerOverlapEvidence["subject"];
  reasons: readonly PeerOverlapSpan["reason"][];
  spans: readonly PeerOverlapSpan[];
}>;
export type PeerOverlapEvidence = Readonly<{
  schema_version: typeof PEER_OVERLAP_SCHEMA;
  policy: typeof PEER_OVERLAP_POLICY;
  evidence_id: string;
  subject_id: string;
  dialect: string;
  parser_identity: string;
  extractor_identity: string;
  input: SourceReference;
  subject: Readonly<{
    key: string;
    kind: string;
    name: string | null;
    enclosing: readonly string[];
    range: Readonly<{ start_byte: number; end_byte: number }>;
    signature: string;
  }>;
  changes: readonly PeerOverlapChange[];
  coverage: "complete" | "incomplete" | "unavailable";
  limitations: readonly string[];
}>;

export type PeerOverlapObservation = Readonly<{
  /** An opaque caller label; this module does not interpret task or parent identity. */
  observation_id: string;
  observed: SourceFile;
  change: Readonly<{
    kind: "modified" | "added" | "removed";
    declaration_changed: boolean;
    body_changed: boolean;
    default_changed: boolean;
    input?: Declaration;
    observed?: Declaration;
  }>;
}>;

export type PeerOverlapSelection = Readonly<{
  subject_id: string;
  dialect: string;
  parser_identity: string;
  extractor_identity: string;
  input: SourceFile;
  declaration: Declaration;
  observations: readonly PeerOverlapObservation[];
  limitations?: readonly string[];
  budget_bytes?: number;
}>;

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as object)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function boundedText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || !value.length || Buffer.byteLength(value, "utf8") > maximum ||
      Buffer.from(value, "utf8").toString("utf8") !== value || value.includes("\0")) {
    throw new BridgeError("STRUCTURAL_OVERLAP_INVALID", `${field} violates its bounded UTF-8 contract`);
  }
  return value;
}

function validateSourceFile(source: SourceFile): void {
  if (source.status !== "present") return;
  const bytes = Buffer.from(source.text, "utf8");
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (source.byte_length !== bytes.length || source.content_sha256 !== actual) {
    throw new BridgeError("STRUCTURAL_OVERLAP_INVALID", "Overlap evidence requires a content-addressed source capture");
  }
}

function range(value: Readonly<{ start_byte: number; end_byte: number }>, maximum: number): Readonly<{ start_byte: number; end_byte: number }> {
  if (!Number.isSafeInteger(value.start_byte) || !Number.isSafeInteger(value.end_byte) || value.start_byte < 0 ||
      value.end_byte < value.start_byte || value.end_byte > maximum) {
    throw new BridgeError("STRUCTURAL_OVERLAP_INVALID", "Overlap evidence contains an out-of-range UTF-8 span");
  }
  return { start_byte: value.start_byte, end_byte: value.end_byte };
}

function codepointStart(bytes: Uint8Array, offset: number): number {
  while (offset > 0 && ((bytes[offset] ?? 0) & 0xc0) === 0x80) offset--;
  return offset;
}

function codepointEnd(bytes: Uint8Array, offset: number): number {
  while (offset < bytes.length && ((bytes[offset] ?? 0) & 0xc0) === 0x80) offset++;
  return offset;
}

/** Return the smallest useful changed window, with a little local context, on valid UTF-8 boundaries. */
function changedWindow(before: SourceFile, after: SourceFile, beforeRange: Readonly<{ start_byte: number; end_byte: number }>,
  afterRange: Readonly<{ start_byte: number; end_byte: number }>): [Readonly<{ start_byte: number; end_byte: number }>, Readonly<{ start_byte: number; end_byte: number }>] {
  if (before.status !== "present" || after.status !== "present") throw new BridgeError("SOURCE_DETAIL_UNAVAILABLE", "Source bytes are unavailable for overlap selection");
  const left = Buffer.from(before.text, "utf8").subarray(beforeRange.start_byte, beforeRange.end_byte);
  const right = Buffer.from(after.text, "utf8").subarray(afterRange.start_byte, afterRange.end_byte);
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix++;
  let suffix = 0;
  while (suffix < left.length - prefix && suffix < right.length - prefix &&
    left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix++;
  const leftStart = Math.max(0, prefix - CONTEXT_BYTES), rightStart = Math.max(0, prefix - CONTEXT_BYTES);
  const leftEnd = Math.min(left.length, left.length - suffix + CONTEXT_BYTES);
  const rightEnd = Math.min(right.length, right.length - suffix + CONTEXT_BYTES);
  const leftBytes = Buffer.from(before.text, "utf8"), rightBytes = Buffer.from(after.text, "utf8");
  const leftRange = { start_byte: codepointStart(leftBytes, beforeRange.start_byte + leftStart),
    end_byte: codepointEnd(leftBytes, beforeRange.start_byte + leftEnd) };
  const rightRange = { start_byte: codepointStart(rightBytes, afterRange.start_byte + rightStart),
    end_byte: codepointEnd(rightBytes, afterRange.start_byte + rightEnd) };
  return [range(leftRange, before.byte_length), range(rightRange, after.byte_length)];
}

/** A shared unchanged line can separate two distant edits without implying adjacency. */
function bodyWindows(before: SourceFile, after: SourceFile, beforeRange: Readonly<{ start_byte: number; end_byte: number }>,
  afterRange: Readonly<{ start_byte: number; end_byte: number }>): ReturnType<typeof changedWindow>[] {
  if (before.status !== "present" || after.status !== "present") return [];
  const left = Buffer.from(before.text, "utf8").subarray(beforeRange.start_byte, beforeRange.end_byte);
  const right = Buffer.from(after.text, "utf8").subarray(afterRange.start_byte, afterRange.end_byte);
  let anchor: { left: number; right: number; length: number } | undefined;
  const lines = new Map<string, number>();
  for (let start = 0; start < left.length;) {
    const end = left.indexOf(10, start);
    if (end < 0) break;
    const length = end + 1 - start;
    const key = left.subarray(start, end + 1).toString("base64");
    if (length >= 32 && !lines.has(key)) lines.set(key, start);
    start = end + 1;
  }
  for (let start = 0; start < right.length;) {
    const end = right.indexOf(10, start);
    if (end < 0) break;
    const length = end + 1 - start;
    const match = length >= 32 ? lines.get(right.subarray(start, end + 1).toString("base64")) : undefined;
    if (match !== undefined && (!anchor || length > anchor.length)) anchor = { left: match, right: start, length };
    start = end + 1;
  }
  if (!anchor || anchor.left < CONTEXT_BYTES || anchor.right < CONTEXT_BYTES ||
      left.length - anchor.left - anchor.length < CONTEXT_BYTES ||
      right.length - anchor.right - anchor.length < CONTEXT_BYTES) {
    return [changedWindow(before, after, beforeRange, afterRange)];
  }
  if (left.subarray(0, anchor.left).equals(right.subarray(0, anchor.right)) ||
      left.subarray(anchor.left + anchor.length).equals(right.subarray(anchor.right + anchor.length))) {
    return [changedWindow(before, after, beforeRange, afterRange)];
  }
  const first = changedWindow(before, after,
    { start_byte: beforeRange.start_byte, end_byte: beforeRange.start_byte + anchor.left },
    { start_byte: afterRange.start_byte, end_byte: afterRange.start_byte + anchor.right });
  const second = changedWindow(before, after,
    { start_byte: beforeRange.start_byte + anchor.left + anchor.length, end_byte: beforeRange.end_byte },
    { start_byte: afterRange.start_byte + anchor.right + anchor.length, end_byte: afterRange.end_byte });
  return [first, second];
}

function declarationSummary(value: Declaration): PeerOverlapEvidence["subject"] {
  return { key: value.key, kind: value.kind, name: value.name, enclosing: [...value.enclosing], range: { ...value.range }, signature: value.signature };
}

function observationReason(change: PeerOverlapObservation["change"]): PeerOverlapSpan["reason"][] {
  const result: PeerOverlapSpan["reason"][] = [];
  if (change.kind === "added") result.push("declaration_added");
  else if (change.kind === "removed") result.push("declaration_removed");
  else {
    if (change.declaration_changed) result.push("signature_changed");
    if (change.body_changed) result.push("body_changed");
    if (change.default_changed) result.push("default_changed");
  }
  return result;
}

function selectedSpans(selection: PeerOverlapSelection, observation: PeerOverlapObservation, reasons: readonly PeerOverlapSpan["reason"][]): PeerOverlapSpan[] {
  const inputDeclaration = observation.change.input ?? selection.declaration;
  const observedDeclaration = observation.change.observed;
  const spans: PeerOverlapSpan[] = [];
  const add = (side: PeerOverlapSide, selected: Readonly<{ start_byte: number; end_byte: number }>,
    whole: Readonly<{ start_byte: number; end_byte: number }>, file: SourceFile, reason: PeerOverlapSpan["reason"]): void => {
    spans.push({ side, range: selected, text: sourceExcerpt(file, selected), reason,
      omitted_before: selected.start_byte > whole.start_byte, omitted_after: selected.end_byte < whole.end_byte });
  };
  const beforeRange = range(inputDeclaration.range, selection.input.status === "present" ? selection.input.byte_length : inputDeclaration.range.end_byte);
  const afterRange = observedDeclaration ? range(observedDeclaration.range, observation.observed.status === "present" ? observation.observed.byte_length : observedDeclaration.range.end_byte) : undefined;
  if (observation.change.kind === "added") {
    if (afterRange && observation.observed.status === "present") add("observed", afterRange, afterRange, observation.observed, "declaration_added");
    return spans;
  }
  if (observation.change.kind === "removed") {
    if (selection.input.status === "present") add("input", beforeRange, beforeRange, selection.input, "declaration_removed");
    return spans;
  }
  if (selection.input.status !== "present" || observation.observed.status !== "present" || !observedDeclaration) return spans;
  if (observation.change.body_changed && afterRange) {
    const windows = observation.change.default_changed || observation.change.declaration_changed
      ? [changedWindow(selection.input, observation.observed, beforeRange, afterRange)]
      : bodyWindows(selection.input, observation.observed, beforeRange, afterRange);
    for (const [left, right] of windows) {
      add("input", left, beforeRange, selection.input, "body_changed");
      add("observed", right, afterRange, observation.observed, "body_changed");
    }
    // A body window need not include a separately changed default or attribute in the header.
    const [left, right] = windows[0]!;
    if (observation.change.default_changed && spans.length < MAX_SPANS_PER_CHANGE &&
        (left.start_byte !== beforeRange.start_byte || left.end_byte !== beforeRange.end_byte ||
          right.start_byte !== afterRange.start_byte || right.end_byte !== afterRange.end_byte)) {
      add("input", beforeRange, beforeRange, selection.input, "default_changed");
      add("observed", afterRange, afterRange, observation.observed, "default_changed");
    }
  } else if (afterRange) {
    // Header-only changes can be inside a very large declaration. The changed
    // window carries the source bytes; the summaries carry the whole signature.
    const [left, right] = changedWindow(selection.input, observation.observed, beforeRange, afterRange);
    for (const reason of reasons) {
      if (spans.length >= MAX_SPANS_PER_CHANGE) break;
      add("input", left, beforeRange, selection.input, reason);
      add("observed", right, afterRange, observation.observed, reason);
    }
  } else {
    add("input", beforeRange, beforeRange, selection.input, reasons[0] ?? "signature_changed");
  }
  return spans.slice(0, MAX_SPANS_PER_CHANGE);
}

function build(selection: PeerOverlapSelection, budget: number): PeerOverlapEvidence {
  const subject = declarationSummary(selection.declaration);
  const limitations = new Set<string>();
  if (selection.input.status !== "present" && !(selection.input.status === "absent_in_commit" &&
      selection.observations.every(observation => observation.change.kind === "added"))) limitations.add("input_source_unavailable");
  const changes = [...selection.observations].sort((a, b) => a.observation_id.localeCompare(b.observation_id)).map(observation => {
    const observationId = boundedText(observation.observation_id, "observation_id", 256);
    const reasons = observationReason(observation.change);
    if (observation.observed.status !== "present") limitations.add("observed_source_unavailable");
    if (observation.observed.status === "present" && observation.change.kind === "modified" && !observation.change.observed) limitations.add("observed_declaration_unavailable");
    const spans = selectedSpans(selection, observation, reasons);
    return { observation_id: observationId, kind: observation.change.kind,
      declaration_changed: observation.change.declaration_changed, body_changed: observation.change.body_changed,
      default_changed: observation.change.default_changed, observed_source: sourceReference(observation.observed),
      ...(observation.change.input ? { input_declaration: declarationSummary(observation.change.input) } : {}),
      ...(observation.change.observed ? { observed_declaration: declarationSummary(observation.change.observed) } : {}),
      reasons, spans };
  });
  let coverage: PeerOverlapEvidence["coverage"] = limitations.has("input_source_unavailable") || limitations.has("observed_source_unavailable") ? "unavailable"
    : limitations.has("observed_declaration_unavailable") || (selection.limitations?.length ?? 0) > 0 ? "incomplete" : "complete";
  for (const limitation of selection.limitations ?? []) limitations.add(limitation);
  let result: Omit<PeerOverlapEvidence, "evidence_id"> = { schema_version: PEER_OVERLAP_SCHEMA, policy: PEER_OVERLAP_POLICY, subject_id: boundedText(selection.subject_id, "subject_id", 128),
    dialect: boundedText(selection.dialect, "dialect", 128), parser_identity: boundedText(selection.parser_identity, "parser_identity", 256),
    extractor_identity: boundedText(selection.extractor_identity, "extractor_identity", 256), input: sourceReference(selection.input), subject,
    changes, coverage, limitations: [...limitations].sort() };
  const encodedSize = (value: Omit<PeerOverlapEvidence, "evidence_id">): number =>
    Buffer.byteLength(JSON.stringify({ ...value, evidence_id: "0".repeat(64) }), "utf8");
  if (encodedSize(result) > budget) {
    coverage = coverage === "unavailable" ? coverage : "incomplete";
    limitations.add("evidence_budget_exceeded");
    const orderedChanges = result.changes.map(change => ({ ...change, spans: [] as PeerOverlapSpan[] }));
    result = { ...result, coverage, limitations: [...limitations].sort(), changes: orderedChanges };
    if (encodedSize(result) > budget) {
      throw new BridgeError("STRUCTURAL_OVERLAP_INVALID", "Overlap evidence budget is too small for its required metadata");
    }
    // A modified comparison needs both sides to explain the edit. Admit
    // complete pairs in observation/reason order; never publish a lone side.
    for (let index = 0; index < changes.length; index++) {
      const spans = changes[index]!.spans;
      for (let offset = 0; offset < spans.length;) {
        const width = spans[offset]!.side === "input" && spans[offset + 1]?.side === "observed" ? 2 : 1;
        const candidate = spans.slice(offset, offset + width);
        offset += width;
        const nextChanges = orderedChanges.map((change, changeIndex) => changeIndex === index
          ? { ...change, spans: [...change.spans, ...candidate] } : change);
        const next = { ...result, changes: nextChanges };
        if (encodedSize(next) <= budget) {
          orderedChanges[index] = nextChanges[index]!;
          result = next;
        }
      }
    }
  }
  const evidence_id = digest(result);
  const final = { ...result, evidence_id };
  if (Buffer.byteLength(JSON.stringify(final), "utf8") > budget) {
    throw new BridgeError("STRUCTURAL_OVERLAP_INVALID", "Overlap evidence budget is too small for its required metadata");
  }
  return freeze(final);
}

/** Select bounded, deterministic evidence from already captured source and comparison facts. */
export function selectPeerOverlapEvidence(selection: PeerOverlapSelection): PeerOverlapEvidence {
  if (!Number.isSafeInteger(selection.budget_bytes ?? PEER_OVERLAP_DEFAULT_BUDGET) ||
      (selection.budget_bytes ?? PEER_OVERLAP_DEFAULT_BUDGET) < 512 || (selection.budget_bytes ?? PEER_OVERLAP_DEFAULT_BUDGET) > 131072) {
    throw new BridgeError("STRUCTURAL_OVERLAP_INVALID", "Overlap evidence budget is outside its supported bounds");
  }
  if (!Array.isArray(selection.observations) || selection.observations.length === 0 || selection.observations.length > MAX_OBSERVATIONS) {
    throw new BridgeError("STRUCTURAL_OVERLAP_INVALID", "Overlap evidence requires a bounded nonempty observation set");
  }
  const keys = selection.observations.map(item => item.observation_id);
  if (new Set(keys).size !== keys.length) throw new BridgeError("STRUCTURAL_OVERLAP_INVALID", "Overlap observations require distinct opaque labels");
  validateSourceFile(selection.input);
  for (const observation of selection.observations) validateSourceFile(observation.observed);
  return build(selection, selection.budget_bytes ?? PEER_OVERLAP_DEFAULT_BUDGET);
}
