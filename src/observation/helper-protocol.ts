import { z } from "zod";
import { createHash } from "node:crypto";
import { BridgeError } from "../core/errors.js";
import type { Extraction, SourceFile } from "./model.js";
import { nativeParserIdentity, type NativeDialect } from "./native-parser.js";
import { sourceReference as referenceFromFile } from "./source.js";
import { nativeExtractorIdentity } from "./extractor-identity.js";

export const HELPER_PROTOCOL_VERSION = 1;
export const MAX_HELPER_REQUEST_BYTES = 9 * 1024 * 1024;
export const MAX_HELPER_REPLY_BYTES = 1024 * 1024;
export const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const count = z.number().int().nonnegative().safe();
const byteRange = z.object({ start_byte: count, end_byte: count }).strict();
const commitSource = z.object({ kind: z.literal("commit"), repository_id: z.string(), object_format: z.enum(["sha1", "sha256"]),
  commit_oid: z.string(), tree_oid: z.string(), path: z.string() }).strict();
const workingSource = z.object({ kind: z.literal("working_capture"), repository_id: z.string(), object_format: z.enum(["sha1", "sha256"]),
  workspace_id: z.string(), workspace_generation: count, capture_id: z.string(), capture_sequence: count,
  head_anchor: z.string(), path: z.string() }).strict();
const source = z.discriminatedUnion("kind", [commitSource, workingSource]);
const capturedSource = z.object({ status: z.literal("present"), source, mode: z.string().max(128),
  content_sha256: hex64, byte_length: count.max(MAX_SOURCE_BYTES), text: z.string().max(MAX_SOURCE_BYTES),
  consistency: z.enum(["immutable_git_blob", "sampled_file_not_atomic"]), blob_oid: z.string().optional() }).strict();
const request = z.object({ version: z.literal(HELPER_PROTOCOL_VERSION), kind: z.literal("extract"),
  job_id: z.string().regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/),
  dialect: z.enum(["rust", "typescript", "tsx", "javascript", "jsx", "python", "lua", "kotlin", "zig", "csharp", "c", "cpp", "odin", "svelte5"]), file: capturedSource }).strict();

/** Decode before parsing; never treat an IPC object's claimed byte length or hash as evidence. */
export function decodeHelperRequest(raw: unknown): { job_id: string; dialect: NativeDialect; file: SourceFile } {
  const parsed = request.safeParse(raw);
  if (!parsed.success) throw new BridgeError("STRUCTURAL_HELPER_REQUEST_INVALID", "Native helper received a malformed request");
  const value = parsed.data;
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_HELPER_REQUEST_BYTES ||
      Buffer.byteLength(value.file.text, "utf8") !== value.file.byte_length ||
      createHash("sha256").update(value.file.text).digest("hex") !== value.file.content_sha256) {
    throw new BridgeError("STRUCTURAL_HELPER_REQUEST_INVALID", "Native helper request contradicts its captured source");
  }
  return { job_id: value.job_id, dialect: value.dialect, file: value.file as SourceFile };
}
const sourceReferenceSchema = z.object({ source, status: z.enum(["present", "absent_in_commit", "missing_during_capture", "non_source"]),
  content_sha256: hex64.optional(), byte_length: count.optional(), consistency: z.enum(["immutable_git_blob", "sampled_file_not_atomic"]).optional(),
  mode: z.string().optional(), entry_kind: z.enum(["symlink", "submodule", "directory", "special"]).optional(),
  object_oid: z.string().optional() }).strict();
const annotation = z.discriminatedUnion("state", [
  z.object({ state: z.literal("declared"), syntax: z.string().max(65536) }).strict(),
  z.object({ state: z.literal("not_declared") }).strict(),
  z.object({ state: z.literal("unavailable") }).strict(),
]);
const declaration = z.object({ key: z.string().max(4096), kind: z.string().max(128), name: z.string().max(4096).nullable(),
  enclosing: z.array(z.string().max(4096)).max(64), range: byteRange, signature: z.string().max(65536),
  parameters: z.array(z.string().max(65536)).max(256), result: annotation, header_complete: z.boolean(),
  body_digest: hex64.optional(), default_digests: z.array(hex64).max(256) }).strict();
const extraction = z.object({ dialect: z.string().max(64), parser_identity: z.string().max(256), extractor_identity: z.string().max(256),
  source: sourceReferenceSchema, coverage: z.enum(["complete", "incomplete", "unavailable"]),
  declarations: z.array(declaration).max(4096), remainder_digest: hex64.optional(), limitations: z.array(z.string().max(256)).max(64) }).strict();

export function decodeHelperExtraction(raw: unknown, file: SourceFile, dialect: NativeDialect): Extraction {
  if (file.status !== "present") throw new BridgeError("STRUCTURAL_HELPER_REPLY_INVALID", "A native helper job requires captured source bytes");
  const parsed = extraction.safeParse(raw);
  if (!parsed.success) throw new BridgeError("STRUCTURAL_HELPER_REPLY_INVALID", "Native helper returned a malformed extraction");
  const value = parsed.data;
  const expectedSource = sourceReferenceSchema.parse(referenceFromFile(file));
  if (value.dialect !== dialect || value.parser_identity !== nativeParserIdentity(dialect) ||
      value.extractor_identity !== nativeExtractorIdentity(dialect) ||
      JSON.stringify(value.source) !== JSON.stringify(expectedSource) ||
      value.declarations.some(d => d.range.end_byte > file.byte_length || d.range.end_byte < d.range.start_byte) ||
      new Set(value.declarations.map(d => d.key)).size !== value.declarations.length ||
      value.coverage === "complete" && (value.limitations.length > 0 || value.declarations.some(d => !d.header_complete))) {
    throw new BridgeError("STRUCTURAL_HELPER_REPLY_INVALID", "Native helper extraction contradicts the admitted source or grammar");
  }
  return Object.freeze(value) as Extraction;
}
