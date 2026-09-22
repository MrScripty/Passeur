import { BridgeError } from "../core/errors.js";
import type { Declaration, DeclarationChange, Extraction, SourceReference, StructuralComparison } from "./model.js";

const header = (d: Declaration) => JSON.stringify([d.kind, d.name, d.enclosing, d.signature, d.parameters, d.result]);
const subject = (d: Declaration) => JSON.stringify([d.kind, d.name, d.enclosing]);
const sameDefaults = (a: Declaration, b: Declaration) => JSON.stringify(a.default_digests) === JSON.stringify(b.default_digests);
const sourceValue = (s: SourceReference) => JSON.stringify([s.status, s.content_sha256, s.mode, s.entry_kind, s.object_oid]);

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function inspect(extraction: Extraction): void {
  const seen = new Set<string>();
  for (const d of extraction.declarations) {
    if (!d.key || seen.has(d.key) || !Number.isSafeInteger(d.range.start_byte) || !Number.isSafeInteger(d.range.end_byte) ||
        d.range.start_byte < 0 || d.range.end_byte < d.range.start_byte ||
        extraction.source.byte_length === undefined || d.range.end_byte > extraction.source.byte_length) {
      throw new BridgeError("STRUCTURAL_EXTRACTION_INVALID", "Declaration identity or range contradicts the captured source");
    }
    seen.add(d.key);
  }
  if (extraction.source.status !== "present" && extraction.declarations.length) {
    throw new BridgeError("STRUCTURAL_EXTRACTION_INVALID", "Declarations require captured source bytes");
  }
}
function complete(x: Extraction): boolean {
  return x.coverage === "complete" && (x.source.status === "present" || x.source.status === "absent_in_commit");
}
function group(items: readonly Declaration[]): Map<string, Declaration[]> {
  const groups = new Map<string, Declaration[]>();
  for (const item of items) {
    const key = subject(item);
    const list = groups.get(key) ?? []; list.push(item); groups.set(key, list);
  }
  return groups;
}

/** Compare already-extracted internal values. This is neither a parser nor an IPC decoding boundary. */
export function compareExtractions(input: Extraction, observed: Extraction): StructuralComparison {
  inspect(input); inspect(observed);
  if (input.source.source.repository_id !== observed.source.source.repository_id ||
      input.source.source.object_format !== observed.source.source.object_format ||
      input.source.source.path !== observed.source.source.path || input.dialect !== observed.dialect ||
      input.parser_identity !== observed.parser_identity || input.extractor_identity !== observed.extractor_identity) {
    throw new BridgeError("STRUCTURAL_PAIR_INVALID", "Comparison requires explicitly corresponding files and the same extraction contract");
  }
  const changes: DeclarationChange[] = [];
  const limitations = new Set([...input.limitations, ...observed.limitations]);
  const left = group(input.declarations), right = group(observed.declarations);
  function pair(a: Declaration, b: Declaration): void {
    if (!a.header_complete || !b.header_complete) {
      changes.push({ kind: "unobserved", correspondence: "unique_syntax_correspondence", input: a, observed: b,
        declaration_changed: false, body_changed: false, default_changed: false });
      limitations.add("declaration_header_incomplete"); return;
    }
    const declaration_changed = header(a) !== header(b);
    const body_changed = a.body_digest !== b.body_digest && a.body_digest !== undefined && b.body_digest !== undefined;
    const default_changed = !sameDefaults(a, b);
    if (a.body_digest === undefined || b.body_digest === undefined) limitations.add("direct_body_coverage_unavailable");
    if (declaration_changed || body_changed || default_changed) {
      changes.push({ kind: "modified", correspondence: "unique_syntax_correspondence", input: a, observed: b,
        declaration_changed, body_changed, default_changed });
    }
  }
  for (const key of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    let a = [...left.get(key) ?? []], b = [...right.get(key) ?? []];
    // Distinct unchanged overloads match first. Duplicate spellings are never assigned by their list position.
    if (a[0]?.name !== null && b[0]?.name !== null) {
      const index = (items: readonly Declaration[]) => {
        const result = new Map<string, Declaration[]>();
        for (const item of items) if (item.header_complete) {
          const shape = header(item), list = result.get(shape) ?? [];
          list.push(item); result.set(shape, list);
        }
        return result;
      };
      const indexA = index(a), indexB = index(b);
      const usedA = new Set<Declaration>(), usedB = new Set<Declaration>();
      for (const [shape, matchesA] of indexA) {
        const matchesB = indexB.get(shape);
        if (matchesA.length === 1 && matchesB?.length === 1) {
          pair(matchesA[0]!, matchesB[0]!); usedA.add(matchesA[0]!); usedB.add(matchesB[0]!);
        }
      }
      a = a.filter(item => !usedA.has(item)); b = b.filter(item => !usedB.has(item));
      if (a.length === 1 && b.length === 1) { pair(a[0]!, b[0]!); a.length = 0; b.length = 0; }
    }
    const ambiguous = a.length > 0 && b.length > 0;
    if (ambiguous) limitations.add("declaration_correspondence_ambiguous");
    for (const item of a) {
      const removed = !ambiguous && item.header_complete && complete(input) && complete(observed);
      changes.push({ kind: ambiguous ? "ambiguous" : removed ? "removed" : "unobserved",
        correspondence: ambiguous ? "ambiguous" : "unmatched", input: item,
        declaration_changed: removed, body_changed: false, default_changed: false });
    }
    for (const item of b) {
      const added = !ambiguous && item.header_complete && complete(input) && complete(observed);
      changes.push({ kind: ambiguous ? "ambiguous" : added ? "added" : "unobserved",
        correspondence: ambiguous ? "ambiguous" : "unmatched", observed: item,
        declaration_changed: added, body_changed: false, default_changed: false });
    }
  }
  const sourceChanged = sourceValue(input.source) !== sourceValue(observed.source);
  const unknownBody = [...input.declarations, ...observed.declarations].some(d => d.body_digest === undefined);
  const region_changed = sourceChanged && (input.remainder_digest === undefined || observed.remainder_digest === undefined ||
    input.remainder_digest !== observed.remainder_digest || unknownBody || input.source.mode !== observed.source.mode ||
    input.source.status === "non_source" || observed.source.status === "non_source");
  if (!complete(input) || !complete(observed)) limitations.add("comparison_coverage_incomplete");
  if ([...input.declarations, ...observed.declarations].some(d => !d.header_complete)) limitations.add("declaration_header_incomplete");
  if (unknownBody) limitations.add("direct_body_coverage_unavailable");
  if (input.remainder_digest === undefined || observed.remainder_digest === undefined) limitations.add("outside_declaration_coverage_unavailable");
  const unavailable = input.coverage === "unavailable" || observed.coverage === "unavailable" ||
    input.source.status === "missing_during_capture" || observed.source.status === "missing_during_capture";
  const coverage = unavailable ? "unavailable" : !complete(input) || !complete(observed) || limitations.size ? "incomplete" : "complete";
  const result: StructuralComparison = { input: input.source, observed: observed.source, dialect: input.dialect,
    parser_identity: input.parser_identity, extractor_identity: input.extractor_identity, coverage,
    changes, region_changed, limitations: [...limitations].sort() };
  return freeze(structuredClone(result));
}
