import { z } from "zod";
import { createHash } from "node:crypto";
import { BridgeError } from "../core/errors.js";

const uuid = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const bounded = (size: number) => z.string().min(1).max(size).refine((value) => Buffer.byteLength(value, "utf8") <= size && !value.includes("\0"));
export const MAX_PEER_DELIVERY_ENVELOPE_BYTES = 20_480;
export const PeerDeliveryKeySchema = bounded(128);
export const PeerDeliveryNativeSessionIdSchema = bounded(256);

/** Immutable, task-owned data. The service derives all recipient binding fields. */
export const PeerDeliveryEnvelopeSchema = z.object({
  schema_version: z.literal(1), delivery_id: uuid, idempotency_key: PeerDeliveryKeySchema,
  recipient_task_id: uuid, recipient_run_id: uuid, recipient_control_generation: positive,
  recipient_workspace: bounded(4096), recipient_workspace_fingerprint: hash,
  source_work_id: uuid, source_work_revision: positive, case_id: uuid, case_revision: positive, case_generation: positive,
  evidence_id: hash, evidence_revision: positive, evidence_digest: hash,
  content: bounded(16_384),
}).strict().refine((value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_PEER_DELIVERY_ENVELOPE_BYTES, "peer envelope exceeds 20 KiB");
export type PeerDeliveryEnvelope = Readonly<z.output<typeof PeerDeliveryEnvelopeSchema>>;

export const PeerDeliveryRecordSchema = z.object({
  envelope: PeerDeliveryEnvelopeSchema,
  state: z.enum(["queued", "dispatch_intent", "delivered", "observed", "stale", "revoked", "cancelled", "replaced", "unknown"]),
  queued_at: z.string().datetime(), dispatch_intent_at: z.string().datetime().optional(),
  delivered_at: z.string().datetime().optional(), observed_at: z.string().datetime().optional(),
  native_turn_id: bounded(256).optional(), native_session_id: PeerDeliveryNativeSessionIdSchema.optional(), disposition_at: z.string().datetime().optional(),
}).strict().superRefine((record, context) => {
  if (record.native_session_id && !record.native_turn_id) context.addIssue({ code: "custom", message: "native session receipt lacks its turn" });
  if (["dispatch_intent", "delivered", "observed", "unknown"].includes(record.state) && !record.dispatch_intent_at) context.addIssue({ code: "custom", message: "dispatch evidence missing" });
  if (["delivered", "observed"].includes(record.state) && (!record.delivered_at || !record.native_turn_id || !record.native_session_id)) context.addIssue({ code: "custom", message: "native delivery evidence missing" });
  if (record.state === "observed" && !record.observed_at) context.addIssue({ code: "custom", message: "worker observation evidence missing" });
  if (["stale", "revoked", "cancelled", "replaced", "unknown"].includes(record.state) && !record.disposition_at) context.addIssue({ code: "custom", message: "disposition evidence missing" });
});
export type PeerDeliveryRecord = z.output<typeof PeerDeliveryRecordSchema>;

export const MAX_PEER_DELIVERIES = 64;
export type PeerDeliverySource = Readonly<Pick<PeerDeliveryEnvelope, "source_work_id" | "source_work_revision" | "case_id" | "case_revision" | "case_generation" | "evidence_id" | "evidence_revision" | "evidence_digest" | "content" | "idempotency_key">>;
/** Fixed-width recipient placeholders make sizing conservative before queue admission. */
export function peerDeliverySizingEnvelope(source: PeerDeliverySource, recipientWorkspace: string): PeerDeliveryEnvelope {
  const uuid = "00000000-0000-4000-8000-000000000000";
  return { schema_version: 1, delivery_id: uuid, ...source,
    recipient_task_id: uuid, recipient_run_id: uuid,
    recipient_control_generation: Number.MAX_SAFE_INTEGER,
    recipient_workspace: recipientWorkspace, recipient_workspace_fingerprint: "0".repeat(64) };
}
/** Upper bound for the complete envelope before recipient run and delivery IDs exist. */
export function peerDeliveryEnvelopeBytes(source: PeerDeliverySource, recipientWorkspace: string): number {
  return Buffer.byteLength(JSON.stringify(peerDeliverySizingEnvelope(source, recipientWorkspace)), "utf8");
}
export const PeerDeliverySourceSchema = PeerDeliveryEnvelopeSchema.pick({ source_work_id: true, source_work_revision: true, case_id: true,
  case_revision: true, case_generation: true, evidence_id: true, evidence_revision: true,
  evidence_digest: true, content: true, idempotency_key: true }).strict();

export function peerDeliveryContentDigest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
export function parsePeerDeliverySource(value: unknown): PeerDeliverySource {
  const source = PeerDeliverySourceSchema.safeParse(value);
  if (!source.success || source.data.evidence_digest !== peerDeliveryContentDigest(source.data.content)) {
    throw new BridgeError("PEER_DELIVERY_INVALID", "Peer delivery source or evidence digest is invalid");
  }
  return Object.freeze(source.data);
}
export function immutablePeerEnvelope(value: unknown): PeerDeliveryEnvelope {
  const decoded = PeerDeliveryEnvelopeSchema.safeParse(value);
  if (!decoded.success || decoded.data.evidence_digest !== peerDeliveryContentDigest(decoded.data.content)) {
    throw new BridgeError("PEER_DELIVERY_INVALID", "Peer delivery envelope is invalid");
  }
  return Object.freeze(decoded.data);
}
