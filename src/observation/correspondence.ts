import { createHash } from "node:crypto";
import { BridgeError } from "../core/errors.js";
import type { AttributedComparison, Declaration, DeclarationChange, GitSource } from "./model.js";

const MAX_REPORTS = 8192;
const MAX_ANCHORS_PER_REPORT = 256;
const MAX_ANCHORS = 8192;

export type CorrespondenceChange = Readonly<{
  kind: "modified" | "removed";
  declaration_changed: boolean;
  body_changed: boolean;
  default_changed: boolean;
  evidence_id: string;
}>;
export type CorrespondencePair = Readonly<{
  current_work_id: string;
  other_work_id: string;
  subject_id: string;
  pair_id: string;
  input: GitSource;
  input_range: Readonly<{ start_byte: number; end_byte: number }>;
  current_change: CorrespondenceChange;
  other_change: CorrespondenceChange;
}>;
export type CorrespondenceResolution = Readonly<{
  current_work_id: string;
  other_work_id: string;
  subject_id: string;
  pair_id: string;
}>;
export type CorrespondenceUpdate = Readonly<{
  pairs: readonly CorrespondencePair[];
  resolved: readonly CorrespondenceResolution[];
}>;

type Candidate = Readonly<{
  work_id: string;
  subject_id: string;
  input: GitSource;
  input_range: Readonly<{ start_byte: number; end_byte: number }>;
  change: CorrespondenceChange;
}>;
type IndexedReport = Readonly<{ work_id: string; path: string; candidates: ReadonlyMap<string, Candidate> }>;

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function pairId(subjectId: string, a: string, b: string): string {
  return digest([subjectId, ...[a, b].sort()]);
}
function direct(change: DeclarationChange): change is DeclarationChange & { input: Declaration } {
  return change.input !== undefined && change.input.header_complete &&
    (change.kind === "modified" && change.correspondence === "unique_syntax_correspondence" ||
      change.kind === "removed" && change.correspondence === "unmatched") &&
    (change.declaration_changed || change.body_changed || change.default_changed);
}
function candidate(report: AttributedComparison, change: DeclarationChange, source: GitSource): Candidate {
  const declaration = change.input!;
  // A source position alone is not an anchor: it is tied to one immutable input and native extraction contract.
  const subject_id = digest([source.repository_id, source.object_format, source.commit_oid, source.path,
    report.comparison.dialect, report.comparison.parser_identity, report.comparison.extractor_identity,
    declaration.key, declaration.kind, declaration.name, declaration.enclosing,
    declaration.range.start_byte, declaration.range.end_byte]);
  const projected: CorrespondenceChange = Object.freeze({ kind: change.kind as "modified" | "removed",
    declaration_changed: change.declaration_changed, body_changed: change.body_changed,
    default_changed: change.default_changed,
    evidence_id: digest([change.kind, change.declaration_changed, change.body_changed, change.default_changed,
      change.observed?.kind, change.observed?.name, change.observed?.enclosing, change.observed?.signature]) });
  return Object.freeze({ work_id: report.work_id, subject_id, input: source,
    input_range: Object.freeze({ ...declaration.range }), change: projected });
}
function candidates(report: AttributedComparison): Map<string, Candidate> {
  const result = new Map<string, Candidate>();
  const duplicate = new Set<string>();
  const input = report.comparison.input;
  if (input.source.kind !== "commit" || input.status !== "present" ||
    report.comparison.coverage === "unavailable") return result;
  for (const change of report.comparison.changes) {
    if (!direct(change)) continue;
    const entry = candidate(report, change, input.source);
    if (result.has(entry.subject_id)) duplicate.add(entry.subject_id);
    else result.set(entry.subject_id, entry);
    if (result.size + duplicate.size > MAX_ANCHORS_PER_REPORT) {
      throw new BridgeError("STRUCTURAL_CORRESPONDENCE_CAPACITY", "One report exceeds the bounded correspondence index");
    }
  }
  // Repeated anchors in one report cannot establish a unique declaration, even if their markers match.
  for (const id of duplicate) result.delete(id);
  return result;
}

/** Disposable compact index. It never grants source access or retains captured source bytes. */
export class CorrespondenceIndex {
  readonly #reports = new Map<string, IndexedReport>();
  readonly #anchors = new Map<string, Map<string, Candidate>>();
  #size = 0;

  upsert(report: AttributedComparison): CorrespondenceUpdate {
    const path = report.comparison.input.source.path;
    const reportKey = JSON.stringify([report.work_id, path]);
    const next = candidates(report);
    const previous = this.#reports.get(reportKey);
    if (!previous && this.#reports.size >= MAX_REPORTS ||
      this.#size - (previous?.candidates.size ?? 0) + next.size > MAX_ANCHORS) {
      throw new BridgeError("STRUCTURAL_CORRESPONDENCE_CAPACITY", "Correspondence index capacity is full");
    }
    const resolved: CorrespondenceResolution[] = [];
    for (const [id, old] of previous?.candidates ?? []) {
      if (next.has(id)) continue;
      const matches = this.#anchors.get(id);
      if (!matches) continue;
      for (const other of matches.values()) if (other.work_id !== report.work_id) {
        resolved.push(Object.freeze({ current_work_id: report.work_id, other_work_id: other.work_id,
          subject_id: id, pair_id: pairId(id, old.work_id, other.work_id) }));
      }
      matches.delete(reportKey);
      if (!matches.size) this.#anchors.delete(id);
    }
    for (const [id, entry] of next) {
      let matches = this.#anchors.get(id);
      if (!matches) { matches = new Map(); this.#anchors.set(id, matches); }
      matches.set(reportKey, entry);
    }
    this.#size += next.size - (previous?.candidates.size ?? 0);
    this.#reports.set(reportKey, { work_id: report.work_id, path, candidates: next });
    const pairs: CorrespondencePair[] = [];
    for (const [id, current] of next) {
      if (previous?.candidates.get(id)?.change.evidence_id === current.change.evidence_id) continue;
      for (const [otherKey, other] of this.#anchors.get(id) ?? []) {
        if (otherKey === reportKey || other.work_id === report.work_id) continue;
        pairs.push(Object.freeze({ current_work_id: report.work_id, other_work_id: other.work_id,
          subject_id: id, pair_id: pairId(id, report.work_id, other.work_id), input: current.input,
          input_range: current.input_range, current_change: current.change, other_change: other.change }));
      }
    }
    pairs.sort((a, b) => a.subject_id.localeCompare(b.subject_id) || a.other_work_id.localeCompare(b.other_work_id));
    resolved.sort((a, b) => a.subject_id.localeCompare(b.subject_id) || a.other_work_id.localeCompare(b.other_work_id));
    return Object.freeze({ pairs: Object.freeze(pairs), resolved: Object.freeze(resolved) });
  }

  remove(workId: string): void {
    for (const [key, report] of this.#reports) {
      if (report.work_id !== workId) continue;
      for (const id of report.candidates.keys()) {
        const matches = this.#anchors.get(id);
        matches?.delete(key);
        if (!matches?.size) this.#anchors.delete(id);
      }
      this.#size -= report.candidates.size;
      this.#reports.delete(key);
    }
  }
}
