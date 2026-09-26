import { BridgeError } from "../core/errors.js";
import type { AttributedComparison, Declaration, Extraction, SourceReference } from "./model.js";

/** Encoding preserves syntax but makes terminal controls and source-supplied line breaks inert. */
export function quoteStructuralText(text: string): string {
  return JSON.stringify(text).replace(/[\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
function endpoint(label: "INPUT" | "OBSERVED" | "SOURCE", ref: SourceReference): string[] {
  const source = ref.source;
  const lines = [`${label} — ${source.kind === "commit" ? `commit ${source.commit_oid}` : `capture ${source.capture_id}`}`,
    `  repository: ${quoteStructuralText(source.repository_id)} (${source.object_format})`,
    `  path: ${quoteStructuralText(source.path)}`, `  status: ${ref.status}`];
  if (source.kind === "commit") lines.push(`  tree: ${source.tree_oid}`);
  else lines.push(`  workspace: ${quoteStructuralText(source.workspace_id)} generation ${source.workspace_generation}`,
    `  captured sequence: ${source.capture_sequence}`, `  HEAD anchor: ${source.head_anchor}`,
    "  consistency: sampled file, not an atomic workspace snapshot");
  if (ref.content_sha256) lines.push(`  captured content: ${ref.content_sha256}`);
  if (ref.mode) lines.push(`  mode: ${quoteStructuralText(ref.mode)}`);
  if (ref.entry_kind) lines.push(`  entry: ${ref.entry_kind}`);
  return lines;
}
/** A single capture has no correspondence or change claim; every extracted declaration is shown. */
export function renderInspection(extraction: Extraction, maxBytes = 65536): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 128 || maxBytes > 65536) {
    throw new BridgeError("STRUCTURAL_PAGE_INVALID", "Invalid structural report byte budget");
  }
  const lines: string[] = [];
  let bytes = 0;
  const append = (...items: string[]) => {
    for (const item of items) {
      bytes += Buffer.byteLength(item, "utf8") + (lines.length ? 1 : 0);
      if (bytes > maxBytes) throw new BridgeError("STRUCTURAL_ENTRY_TOO_LARGE", "The complete inspection exceeds this byte budget; narrow the selected source");
      lines.push(item);
    }
  };
  append("INSPECTION — one captured source; no comparison or change attribution.",
    ...endpoint("SOURCE", extraction.source),
    `Dialect: ${quoteStructuralText(extraction.dialect)}`,
    `Parser: ${quoteStructuralText(extraction.parser_identity)} / Extractor: ${quoteStructuralText(extraction.extractor_identity)}`,
    `Coverage: ${extraction.coverage}`);
  for (const value of extraction.declarations) {
    append("", `Declaration: ${quoteStructuralText(value.name ?? "<anonymous>")}`,
      `  kind: ${quoteStructuralText(value.kind)}`,
      `  enclosing scope: ${value.enclosing.length ? value.enclosing.map(quoteStructuralText).join(" :: ") : "<top level>"}`,
      `  source bytes (UTF-8): ${value.range.start_byte}..${value.range.end_byte}`,
      `  masked signature: ${quoteStructuralText(value.signature)}`,
      `  parameters: ${value.parameters.length ? value.parameters.map(quoteStructuralText).join(", ") : "<none>"}`,
      `  written result: ${value.result.state === "declared" ? quoteStructuralText(value.result.syntax) : value.result.state}`,
      "  body: omitted", "  defaults/initializers: omitted");
    if (!value.header_complete) append("  declaration extraction incomplete");
  }
  if (!extraction.declarations.length) append("", "No declarations represented by this extraction.");
  for (const limitation of extraction.limitations) append(`Limitation: ${quoteStructuralText(limitation)}`);
  append("Behavior and compatibility: not assessed.");
  return lines.join("\n");
}
function declaration(label: "INPUT" | "OBSERVED", value: Declaration): string[] {
  const lines = [`  ${label}: ${quoteStructuralText(value.signature)}`,
    `    source bytes: ${value.range.start_byte}..${value.range.end_byte}`];
  if (value.parameters.length) lines.push(`    parameters: ${value.parameters.map(quoteStructuralText).join(", ")}`);
  lines.push(`    result: ${value.result.state === "declared" ? quoteStructuralText(value.result.syntax) : value.result.state}`);
  if (!value.header_complete) lines.push("    declaration extraction incomplete");
  return lines;
}
export function renderComparison(report: AttributedComparison, maxBytes = 65536): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 128 || maxBytes > 65536) {
    throw new BridgeError("STRUCTURAL_PAGE_INVALID", "Invalid structural report byte budget");
  }
  const c = report.comparison;
  const lines: string[] = [];
  let bytes = 0;
  const append = (...items: string[]) => {
    for (const item of items) {
      bytes += Buffer.byteLength(item, "utf8") + (lines.length ? 1 : 0);
      if (bytes > maxBytes) throw new BridgeError("STRUCTURAL_ENTRY_TOO_LARGE", "The complete per-work report exceeds this byte budget; narrow the selected subjects");
      lines.push(item);
    }
  };
  append(`WORK ${quoteStructuralText(report.work_id)} / PARENT ${quoteStructuralText(report.parent_id)}`,
    "Attribution: observed in this work; exclusive authorship is not established.",
    ...endpoint("INPUT", c.input), ...endpoint("OBSERVED", c.observed),
    `Dialect: ${quoteStructuralText(c.dialect)}`,
    `Parser: ${quoteStructuralText(c.parser_identity)} / Extractor: ${quoteStructuralText(c.extractor_identity)}`,
    `Coverage: ${c.coverage}`);
  for (const change of c.changes) {
    const d = change.observed ?? change.input;
    if (!d) throw new BridgeError("STRUCTURAL_REPORT_INVALID", "A declaration change has no source side");
    append("", `${change.kind}: ${quoteStructuralText([...d.enclosing, d.name ?? "<anonymous>"].join(" :: "))} (${quoteStructuralText(d.kind)})`,
      `  correspondence: ${change.correspondence}`);
    if (change.input) append(...declaration("INPUT", change.input));
    else append(`  INPUT: ${change.kind === "added" ? "declaration absent in the identified complete input" : "correspondence not established"}`);
    if (change.observed) append(...declaration("OBSERVED", change.observed));
    else append(`  OBSERVED: ${change.kind === "removed" ? "declaration absent in the identified complete observation" : "correspondence not established"}`);
    if (change.body_changed) append("  body_changed (body omitted)");
    if (change.default_changed) append("  concealed_header_changed (default, attribute, or comment values omitted)");
    if (change.kind === "modified" && !change.declaration_changed) append("  declaration_unchanged");
  }
  if (c.region_changed) append("", "region_changed (source bytes or mode outside the compact projection require inspection)");
  if (!c.changes.length && !c.region_changed) append("", "No differences represented by this extraction; this is not a compatibility decision.");
  for (const limitation of c.limitations) append(`Limitation: ${quoteStructuralText(limitation)}`);
  append("Behavior and compatibility: not assessed.");
  return lines.join("\n");
}
export type ReportPage = Readonly<{
  offset: number; next_offset: number; complete: boolean;
  entries: readonly Readonly<{ work_id: string; text: string }>[];
}>;

/** Entire per-work records are paged against actual JSON bytes, including their escaping overhead. */
export function renderReportPage(reports: readonly AttributedComparison[], offset: number, maxBytes: number): ReportPage {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > reports.length || !Number.isSafeInteger(maxBytes) || maxBytes < 128 || maxBytes > 65536) {
    throw new BridgeError("STRUCTURAL_PAGE_INVALID", "Invalid report offset or byte budget");
  }
  const entries: { work_id: string; text: string }[] = [];
  const page = (): ReportPage => ({ offset, next_offset: offset + entries.length,
    complete: offset + entries.length === reports.length, entries });
  for (let index = offset; index < reports.length; index++) {
    const report = reports[index]!;
    entries.push({ work_id: report.work_id, text: renderComparison(report, maxBytes) });
    if (Buffer.byteLength(JSON.stringify(page()), "utf8") > maxBytes) {
      entries.pop();
      if (!entries.length) throw new BridgeError("STRUCTURAL_ENTRY_TOO_LARGE", "The complete per-work report exceeds this page budget; narrow the selected subjects");
      break;
    }
  }
  for (const entry of entries) Object.freeze(entry);
  Object.freeze(entries);
  return Object.freeze(page());
}
