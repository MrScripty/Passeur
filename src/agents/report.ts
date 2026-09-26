import { z } from "zod";
import { BridgeError } from "../core/errors.js";
import type { WorkerRun } from "./types.js";

import { REPORT_MARKER } from "./report-format.js";
import { PeerDeliveryKeySchema } from "../contracts/peer-delivery.js";
import { decodePeerResolutionText, PEER_RESOLUTION_PREFIX, PEER_RESOLUTION_MAX_BYTES, type PeerResolutionProposal } from "../coordination/peer-resolution.js";
const bounded = (n: number) => z.string().min(1).max(n);
const uuid = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const operationKey = bounded(256).refine((value) => Buffer.byteLength(value, "utf8") <= 256 &&
  Buffer.from(value, "utf8").toString("utf8") === value && !/[\u0000-\u001f\u007f]/.test(value));
const operationBase = { schema_version: z.literal(1), operation_key: operationKey, case_id: uuid };
const proposal = z.unknown().transform((value, context): PeerResolutionProposal | typeof z.NEVER => {
  try {
    const encoded = `${PEER_RESOLUTION_PREFIX}${JSON.stringify(value)}`;
    if (Buffer.byteLength(encoded, "utf8") <= PEER_RESOLUTION_MAX_BYTES) {
      const decoded = decodePeerResolutionText(encoded);
      if (decoded?.kind === "peer_resolution_proposal") return decoded;
    }
  } catch { /* Invalid worker content is reported by the message boundary. */ }
  context.addIssue({ code: "custom", message: "Peer proposal violates its canonical contract" });
  return z.NEVER;
});
const peerOperation = z.discriminatedUnion("kind", [
  z.object({ ...operationBase, kind: z.literal("inspect") }).strict(),
  z.object({ ...operationBase, kind: z.literal("propose"), proposal }).strict(),
  z.object({ ...operationBase, kind: z.literal("counter_propose"), proposal }).strict(),
  z.object({ ...operationBase, kind: z.literal("acknowledge"), note_id: uuid }).strict(),
  z.object({ ...operationBase, kind: z.literal("withdraw"), note_id: uuid }).strict(),
  z.object({ ...operationBase, kind: z.literal("await_change"), after_case_revision: positive, after_case_generation: positive }).strict(),
]).superRefine((value, context) => {
  if ((value.kind === "propose" || value.kind === "counter_propose") &&
      (value.proposal.action !== value.kind || value.proposal.case_id !== value.case_id)) {
    context.addIssue({ code: "custom", message: "Peer proposal action and case must match the operation" });
  }
});
/** Observation alone conveys no agreement, application, or proposal authority. */
const peerObserved = { peer_observed: PeerDeliveryKeySchema.optional() };
const finalFields = {
  summary: bounded(8192), assessment: z.enum(["met", "partial", "unmet", "unknown"]),
  blockers: z.array(bounded(2048)).max(64), questions: z.array(bounded(2048)).max(64),
  checks: z.array(z.object({ command: bounded(4096), cwd: bounded(4096), exit_code: z.number().int().nullable() }).strict()).max(100),
  no_changes_reason: bounded(8192).optional(),
};
/** Runtime messages are versioned independently of historical reports on disk. */
export const WorkerMessageSchema = z.discriminatedUnion("kind", [
  z.object({ schema_version: z.literal(2), kind: z.literal("final"), ...finalFields, ...peerObserved }).strict(),
  z.object({ schema_version: z.literal(2), kind: z.literal("input_required"), question: bounded(8192), ...peerObserved }).strict(),
  z.object({ schema_version: z.literal(2), kind: z.literal("blocked"), reason: bounded(8192), ...peerObserved }).strict(),
  z.object({ schema_version: z.literal(2), kind: z.literal("peer_operation"), operation: peerOperation, ...peerObserved }).strict(),
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
