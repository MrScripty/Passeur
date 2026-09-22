import { createHash } from "node:crypto";
import type { AttributedComparison, Declaration } from "../observation/model.js";

function visible(d: Declaration | undefined): unknown {
  return d ? { kind: d.kind, name: d.name, enclosing: d.enclosing, signature: d.signature,
    parameters: d.parameters, result: d.result, header_complete: d.header_complete } : null;
}

/** Pure evidence materiality, not delivery or authorization. Callers own relevance and recipient access. */
export function noticeMateriality(report: AttributedComparison): string {
  const c = report.comparison;
  const changes = c.changes.map(change => ({ kind: change.kind, correspondence: change.correspondence,
    input: visible(change.input), observed: visible(change.observed), declaration_changed: change.declaration_changed,
    body_changed: change.body_changed, default_changed: change.default_changed }));
  // Presentation ordering, source positions, digests and capture/commit advancement alone do not create new notices.
  const ordered = changes.map(change => JSON.stringify(change)).sort();
  const material = { work_id: report.work_id, parent_id: report.parent_id, repository: c.input.source.repository_id,
    input_path: c.input.source.path, observed_path: c.observed.source.path,
    input_status: c.input.status, observed_status: c.observed.status, input_mode: c.input.mode, observed_mode: c.observed.mode,
    input_entry: c.input.entry_kind, observed_entry: c.observed.entry_kind,
    dialect: c.dialect, coverage: c.coverage, changes: ordered, region_changed: c.region_changed,
    limitations: [...new Set(c.limitations)].sort() };
  return createHash("sha256").update(JSON.stringify(material)).digest("hex");
}
