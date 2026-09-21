import { z } from "zod";
import { BridgeError } from "../core/errors.js";
import type { WorkerRun } from "./types.js";

import { REPORT_MARKER } from "./report-format.js";
const bounded = (n: number) => z.string().min(1).max(n);
const finalFields = {
  summary: bounded(8192), assessment: z.enum(["met", "partial", "unmet", "unknown"]),
  blockers: z.array(bounded(2048)).max(64), questions: z.array(bounded(2048)).max(64),
  checks: z.array(z.object({ command: bounded(4096), cwd: bounded(4096), exit_code: z.number().int().nullable() }).strict()).max(100),
  no_changes_reason: bounded(8192).optional(),
};
/** Runtime messages are versioned independently of historical reports on disk. */
export const WorkerMessageSchema = z.discriminatedUnion("kind", [
  z.object({ schema_version: z.literal(2), kind: z.literal("final"), ...finalFields }).strict(),
  z.object({ schema_version: z.literal(2), kind: z.literal("input_required"), question: bounded(8192) }).strict(),
  z.object({ schema_version: z.literal(2), kind: z.literal("blocked"), reason: bounded(8192) }).strict(),
]);
export type WorkerMessage = z.output<typeof WorkerMessageSchema>;
export function parseWorkerMessage(text: string | undefined): WorkerMessage {
  if (!text || Buffer.byteLength(text) > 131_072) throw new BridgeError("WORKER_MESSAGE_INVALID", "The turn did not provide a bounded assignment disposition");
  const offset = text.lastIndexOf(REPORT_MARKER);
  if (offset < 0) throw new BridgeError("WORKER_MESSAGE_INVALID", "The completed turn did not provide an explicit assignment disposition");
  let value: unknown;
  try { value = JSON.parse(text.slice(offset + REPORT_MARKER.length).trim()); }
  catch { throw new BridgeError("WORKER_MESSAGE_INVALID", "Assignment disposition is not valid JSON"); }
  const parsed = WorkerMessageSchema.safeParse(value);
  if (!parsed.success) throw new BridgeError("WORKER_MESSAGE_INVALID", "Assignment disposition violates its versioned contract");
  return parsed.data;
}
export function finalReport(message: Extract<WorkerMessage, { kind: "final" }>): Pick<WorkerRun, "summary" | "worker_assessment" | "blockers" | "questions" | "checks" | "no_changes_reason"> {
  return { summary: message.summary, worker_assessment: message.assessment, blockers: message.blockers, questions: message.questions,
    checks: message.checks.map((check) => ({ ...check, evidence: "worker_reported" as const })),
    ...(message.no_changes_reason ? { no_changes_reason: message.no_changes_reason } : {}) };
}
