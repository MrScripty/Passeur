import { z } from "zod";
import { BridgeError } from "../core/errors.js";
import type { WorkerRun } from "./types.js";
export const REPORT_MARKER = "PASSEUR_RESULT";
const text = z.string().max(4096);
export const WorkerReportSchema = z.object({
  summary: z.string().min(1).max(8192), assessment: z.enum(["met", "partial", "unmet", "unknown"]),
  blockers: z.array(text).max(50), questions: z.array(text).max(50),
  checks: z.array(z.object({ command: text, cwd: z.string().min(1).max(4096), exit_code: z.number().int().nullable() }).strict()).max(100),
  no_changes_reason: z.string().min(1).max(4096).optional(),
}).strict();
export function parseWorkerReport(lastText: string | undefined): Pick<WorkerRun, "summary" | "worker_assessment" | "blockers" | "questions" | "checks" | "no_changes_reason"> {
  if (!lastText || Buffer.byteLength(lastText) > 131_072) throw new BridgeError("WORKER_REPORT_INVALID", "A bounded structured worker report is required");
  const offset = lastText.lastIndexOf(REPORT_MARKER);
  if (offset < 0) throw new BridgeError("WORKER_REPORT_INVALID", "The worker did not supply the required report");
  let raw: unknown;
  try { raw = JSON.parse(lastText.slice(offset + REPORT_MARKER.length).trim()); }
  catch { throw new BridgeError("WORKER_REPORT_INVALID", "The structured worker report is not valid JSON"); }
  const decoded = WorkerReportSchema.safeParse(raw);
  if (!decoded.success) throw new BridgeError("WORKER_REPORT_INVALID", "The worker report does not satisfy the declared contract");
  const report = decoded.data;
  return { summary: report.summary, worker_assessment: report.assessment, blockers: report.blockers, questions: report.questions,
    checks: report.checks.map((check) => ({ ...check, evidence: "worker_reported" })),
    ...(report.no_changes_reason ? { no_changes_reason: report.no_changes_reason } : {}) };
}
