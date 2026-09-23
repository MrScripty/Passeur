import { z } from "zod";
import { createHash } from "node:crypto";
import { BridgeError } from "../core/errors.js";
import { canonicalHash } from "../core/async.js";
import type { SourceFile } from "../observation/model.js";

export const OBSERVATION_SCHEMA = 1;
export const OBSERVATION_STATE_SCHEMA = 2;
export const OBSERVATION_MAX_ARTIFACT_BYTES = 17 * 1024 * 1024;
export const OBSERVATION_MAX_RETAINED_BYTES = 64 * 1024 * 1024;
export const OBSERVATION_MAX_ARTIFACTS = 16;
export const OBSERVATION_MAX_NOTICES = 256;
export const OBSERVATION_MAX_RECIPIENTS = 64;
export const OBSERVATION_MAX_PULL = 32;
export const OBSERVATION_MAX_STATE_BYTES = 256 * 1024;

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid();
const parent = digest;
const integer = z.number().int().nonnegative().safe();
const path = z.string().min(1).max(4096).refine(value => !value.startsWith("/") && value.split("/").every(part => part && part !== "." && part !== ".."));
const common = { repository_id: z.string().min(1).max(4096), object_format: z.enum(["sha1", "sha256"]), path };
const gitSource = z.strictObject({ kind: z.literal("commit"), ...common, commit_oid: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/), tree_oid: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/) });
const workingSource = z.strictObject({ kind: z.literal("working_capture"), ...common, workspace_id: z.string().min(1).max(4096),
  workspace_generation: integer, capture_id: uuid, capture_sequence: integer, head_anchor: z.string().max(64) });
const source = z.discriminatedUnion("kind", [gitSource, workingSource]);
const present = z.strictObject({ status: z.literal("present"), source, mode: z.string().max(32), content_sha256: digest,
  byte_length: integer.max(8 * 1024 * 1024), text: z.string().max(8 * 1024 * 1024), consistency: z.enum(["immutable_git_blob", "sampled_file_not_atomic"]), blob_oid: z.string().optional() });
const absent = z.strictObject({ status: z.literal("absent_in_commit"), source: gitSource });
const missing = z.strictObject({ status: z.literal("missing_during_capture"), source: workingSource });
const nonSource = z.strictObject({ status: z.literal("non_source"), source, entry_kind: z.enum(["symlink", "submodule", "directory", "special"]), mode: z.string().optional(), object_oid: z.string().optional() });
const sourceFile = z.discriminatedUnion("status", [present, absent, missing, nonSource]);
const artifact = z.strictObject({ schema_version: z.literal(OBSERVATION_SCHEMA), id: digest, work_id: uuid, work_revision: integer,
  workspace_generation: integer.positive(), control_generation: integer.positive().nullable(),
  parent_id: parent, materiality: digest, capture_digest: digest, analysis_digest: digest,
  path, report_text: z.string().max(65536), input: sourceFile, observed: sourceFile });
const notice = z.strictObject({ schema_version: z.literal(OBSERVATION_SCHEMA), sequence: integer.positive(), id: digest,
  recipient: parent, work_id: uuid, work_revision: integer.positive(), workspace_generation: integer.positive(),
  control_generation: integer.positive().nullable(), artifact_id: digest, materiality: digest,
  subject_id: digest.optional(), correspondence_state: z.enum(["overlap", "resolved"]).optional(),
  acknowledged: z.boolean() });
const artifactIndexV1 = z.strictObject({ id: digest, bytes: integer.positive(), work_id: uuid, work_revision: integer.positive(),
  workspace_generation: integer.positive(), control_generation: integer.positive().nullable(), path, materiality: digest,
  capture_digest: digest, analysis_digest: digest });
const stateV1 = z.strictObject({ schema_version: z.literal(1), repository_id: z.string().min(1).max(4096), epoch: uuid,
  revision: integer, next_sequence: integer.positive(), floor_sequence: integer,
  artifacts: z.array(artifactIndexV1).max(OBSERVATION_MAX_ARTIFACTS),
  notices: z.array(notice).max(OBSERVATION_MAX_NOTICES) });
const state = z.strictObject({ ...stateV1.shape, schema_version: z.literal(OBSERVATION_STATE_SCHEMA),
  artifacts: z.array(artifactIndexV1.safeExtend({ ordinary_recipients: z.array(parent).max(OBSERVATION_MAX_RECIPIENTS) })).max(OBSERVATION_MAX_ARTIFACTS) });

export type ObservationArtifact = z.infer<typeof artifact> & { input: SourceFile; observed: SourceFile };
export type ObservationNotice = z.infer<typeof notice>;
export type ObservationState = z.infer<typeof state>;
export type ObservationGeneration = Readonly<Pick<ObservationArtifact, "workspace_generation" | "control_generation">>;
export type ObservationReportReference = Readonly<Pick<ObservationArtifact, "id" | "work_id" | "work_revision" |
  "workspace_generation" | "control_generation" | "path" | "materiality">>;
export type ObservationCurrent = Readonly<{ schema_version: 1; reports: readonly ObservationReportReference[] }>;
export type ObservationPull = Readonly<{ schema_version: 1; cursor: number; gap: boolean; notices: readonly ObservationNotice[];
  current: readonly ObservationNotice[] }>;

function decode<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new BridgeError("OBSERVATION_RECORD_INVALID", "Observation state does not satisfy its versioned contract");
  return result.data;
}
export function decodeObservationArtifact(raw: unknown): ObservationArtifact {
  const value = decode(artifact, raw);
  for (const file of [value.input, value.observed]) {
    if (file.status === "present" && (Buffer.byteLength(file.text, "utf8") !== file.byte_length ||
      createHash("sha256").update(file.text).digest("hex") !== file.content_sha256 ||
      file.source.kind === "commit" && file.consistency !== "immutable_git_blob" ||
      file.source.kind === "working_capture" && file.consistency !== "sampled_file_not_atomic")) {
      throw new BridgeError("OBSERVATION_RECORD_INVALID", "Captured source contradicts its byte length or source identity");
    }
  }
  if (value.input.source.path !== value.path || value.observed.source.path !== value.path ||
    value.observed.source.kind !== "working_capture" ||
    value.observed.source.workspace_generation !== value.workspace_generation ||
    captureContentDigest(value.input as SourceFile, value.observed as SourceFile) !== value.capture_digest)
    throw new BridgeError("OBSERVATION_RECORD_INVALID", "Artifact source path or workspace generation differs from capture");
  return value as ObservationArtifact;
}
/** Ignores capture sequence/UUID only when the exact source bytes and stable source context match. */
export function captureContentDigest(input: SourceFile, observed: SourceFile): string {
  const compact = (file: SourceFile): unknown => {
    const source = file.source.kind === "commit" ? file.source : {
      kind: file.source.kind, repository_id: file.source.repository_id, object_format: file.source.object_format,
      workspace_id: file.source.workspace_id, workspace_generation: file.source.workspace_generation,
      head_anchor: file.source.head_anchor, path: file.source.path,
    };
    switch (file.status) {
      case "present": return { source, status: file.status, mode: file.mode, content_sha256: file.content_sha256,
        byte_length: file.byte_length, consistency: file.consistency, blob_oid: file.blob_oid };
      case "non_source": return { source, status: file.status, entry_kind: file.entry_kind, mode: file.mode, object_oid: file.object_oid };
      default: return { source, status: file.status };
    }
  };
  return canonicalHash({ input: compact(input), observed: compact(observed) });
}
export function decodeObservationState(raw: unknown, repositoryId: string, epoch: string): ObservationState {
  if (raw && typeof raw === "object" && "schema_version" in raw && raw.schema_version !== 1 && raw.schema_version !== OBSERVATION_STATE_SCHEMA)
    throw new BridgeError("OBSERVATION_VERSION_UNSUPPORTED", "Observation record version has no supported reader");
  let candidate = raw;
  if (raw && typeof raw === "object" && "schema_version" in raw && raw.schema_version === 1) {
    const old = decode(stateV1, raw);
    const artifactById = new Map(old.artifacts.map(item => [item.id, item]));
    candidate = { ...old, schema_version: OBSERVATION_STATE_SCHEMA, artifacts: old.artifacts.map(item => ({ ...item,
      ordinary_recipients: [...new Set(old.notices.filter(notice => notice.subject_id === undefined &&
        notice.work_id === item.work_id && notice.work_revision === item.work_revision &&
        notice.workspace_generation === item.workspace_generation && notice.control_generation === item.control_generation &&
        notice.materiality === item.materiality && artifactById.get(notice.artifact_id)?.path === item.path)
        .map(notice => notice.recipient))],
    })) };
  }
  const value = decode(state, candidate);
  if (value.repository_id !== repositoryId || value.epoch !== epoch) throw new BridgeError("OBSERVATION_BINDING_CONFLICT", "Observation state belongs to another repository generation");
  if (value.floor_sequence >= value.next_sequence) throw new BridgeError("OBSERVATION_RECORD_INVALID", "Observation cursor floor exceeds the next sequence");
  const ids = new Set(value.artifacts.map(row => row.id));
  if (ids.size !== value.artifacts.length || value.artifacts.reduce((sum, row) => sum + row.bytes, 0) > OBSERVATION_MAX_RETAINED_BYTES ||
    value.artifacts.some(row => new Set(row.ordinary_recipients).size !== row.ordinary_recipients.length))
    throw new BridgeError("OBSERVATION_RECORD_INVALID", "Observation artifact inventory exceeds its capacity");
  const byId = new Map(value.artifacts.map(row => [row.id, row]));
  let previous = value.floor_sequence;
  for (const item of value.notices) {
    const artifact = byId.get(item.artifact_id);
    if ((item.subject_id === undefined) !== (item.correspondence_state === undefined))
      throw new BridgeError("OBSERVATION_RECORD_INVALID", "Correspondence notice requires both subject and phase");
    const expectedMateriality = item.subject_id === undefined ? artifact?.materiality
      : canonicalHash({ kind: "correspondence", artifact_id: item.artifact_id,
        subject_id: item.subject_id, correspondence_state: item.correspondence_state });
    if (item.sequence <= previous || item.sequence >= value.next_sequence || !artifact ||
      artifact.work_id !== item.work_id || artifact.work_revision !== item.work_revision ||
      artifact.workspace_generation !== item.workspace_generation || artifact.control_generation !== item.control_generation ||
      expectedMateriality !== item.materiality)
      throw new BridgeError("OBSERVATION_RECORD_INVALID", "Observation notice sequence or artifact reference is invalid");
    previous = item.sequence;
  }
  return value;
}
