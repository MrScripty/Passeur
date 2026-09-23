import { createHash } from "node:crypto";
import { BridgeError } from "../core/errors.js";
import type { Response } from "../contracts/service.js";

/** Bounds the doubly JSON-escaped public MCP page, not the worker's assignment. */
export const ANNOUNCEMENT_PAGE_BYTES = 4096;
type Announcement = Response<"announcement">;
export type AnnouncementPageRequest = Readonly<{
  offset: number;
  limit: number;
  expected_sha256?: string;
}>;

function payload(value: Announcement): { bytes: Buffer; sha256: string } {
  // The service response decoder has already established Assignment's contract.
  const bytes = Buffer.from(JSON.stringify(value.assignment), "utf8");
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** Public response v2: a small receipt, never an echo of the supplied prompt. */
export function announcementReceipt(value: Announcement) {
  const { bytes, sha256 } = payload(value);
  const { id, revision, state, payload_digest, task_id } = value.record;
  return {
    schema_version: 2 as const, kind: "announcement_receipt" as const,
    record: { id, revision, state, payload_digest, ...(task_id === undefined ? {} : { task_id }) },
    payload: { bytes: bytes.length, sha256 },
  };
}

/** Call only after a fresh authorized announcement read; this function holds no cached authority. */
export function announcementPage(value: Announcement, request: AnnouncementPageRequest) {
  const { offset, limit, expected_sha256 } = request;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) ||
      limit < 4 || limit > ANNOUNCEMENT_PAGE_BYTES ||
      expected_sha256 !== undefined && !/^[a-f0-9]{64}$/.test(expected_sha256)) {
    throw new BridgeError("ANNOUNCEMENT_RANGE_INVALID", "Use a nonnegative byte offset and a page of 4 to 4096 bytes");
  }
  if (offset > 0 && expected_sha256 === undefined) {
    throw new BridgeError("ANNOUNCEMENT_HASH_REQUIRED", "Continue with the payload SHA-256 returned by the receipt or preceding page");
  }
  const data = payload(value);
  if (expected_sha256 !== undefined && data.sha256 !== expected_sha256) {
    throw new BridgeError("ANNOUNCEMENT_PAYLOAD_CHANGED", "The requested payload identity does not match this authorized announcement");
  }
  if (offset > data.bytes.length || offset < data.bytes.length && (data.bytes[offset]! & 0xc0) === 0x80) {
    throw new BridgeError("ANNOUNCEMENT_RANGE_INVALID", "The offset must be a UTF-8 boundary inside the payload");
  }
  // Streaming decoding leaves a partial trailing codepoint for the next page.
  const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
    .decode(data.bytes.subarray(offset, offset + limit), { stream: true });
  const bytes = Buffer.byteLength(content, "utf8"), next_offset = offset + bytes;
  if (bytes === 0 && next_offset < data.bytes.length) {
    throw new BridgeError("ANNOUNCEMENT_RANGE_INVALID", "The requested page cannot make progress");
  }
  return {
    schema_version: 2 as const, kind: "announcement_payload_page" as const,
    id: value.record.id, payload_sha256: data.sha256, total_bytes: data.bytes.length,
    offset, bytes, next_offset, eof: next_offset === data.bytes.length, content,
  };
}
