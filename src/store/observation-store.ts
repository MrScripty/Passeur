import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, opendir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { canonicalHash, Mutex } from "../core/async.js";
import { BridgeError, nativeCode } from "../core/errors.js";
import type { CoordinationStore } from "./coordination-store.js";
import { atomicJson, type MutationAuthority } from "./atomic-json.js";
import { captureContentDigest, decodeObservationArtifact, decodeObservationState, OBSERVATION_MAX_ARTIFACT_BYTES, OBSERVATION_MAX_ARTIFACTS,
  OBSERVATION_MAX_NOTICES, OBSERVATION_MAX_PULL, OBSERVATION_MAX_RECIPIENTS, OBSERVATION_MAX_RETAINED_BYTES,
  OBSERVATION_MAX_STATE_BYTES, OBSERVATION_SCHEMA, OBSERVATION_STATE_SCHEMA, type ObservationArtifact, type ObservationNotice,
  type ObservationCurrent, type ObservationGeneration, type ObservationPull, type ObservationState } from "../contracts/observation.js";
import type { AttributedComparison, SourceFile, SourceReference } from "../observation/model.js";
import { noticeMateriality } from "../coordination/notices.js";
import { renderComparison } from "../observation/report.js";
import { requiresParameterMaskRefresh } from "../observation/extractor-identity.js";

export type ObservationAuthority = (recipient: string, workId: string, workRevision: number,
  generation: ObservationGeneration) => Promise<void> | void;
export type PublishObservation = Readonly<{ report: AttributedComparison; work_revision: number;
  workspace_generation: number; control_generation: number | null;
  input: SourceFile; observed: SourceFile; recipients: readonly string[] }>;
export type RetainedObservationPair = Readonly<Pick<ObservationArtifact, "id" | "work_id" | "work_revision" |
  "workspace_generation" | "control_generation" | "parent_id" | "path" | "input" | "observed">>;

/** Disposable observation state under one elected CoordinationStore generation. No task outcome depends on it. */
export class ObservationStore {
  readonly #writes = new Mutex();
  readonly #root: string;
  readonly #artifacts: string;
  #closed = false;
  #uncertain = false;
  private constructor(private readonly coordination: CoordinationStore, private readonly authority: MutationAuthority) {
    this.#root = join(coordination.root, "observation");
    this.#artifacts = join(this.#root, "artifacts");
  }

  static async open(coordination: CoordinationStore, authority: MutationAuthority): Promise<ObservationStore> {
    await coordination.snapshot();
    const store = new ObservationStore(coordination, authority);
    await privateDirectory(store.#root);
    await privateDirectory(store.#artifacts);
    await store.#state();
    return store;
  }

  /** Service-owned initialization, not metadata discovery. An incomplete namespace is never reset. */
  static async initialize(coordination: CoordinationStore, authority: MutationAuthority): Promise<ObservationStore> {
    await coordination.snapshot();
    const store = new ObservationStore(coordination, authority);
    try { return await ObservationStore.open(coordination, authority); }
    catch (error) { if (nativeCode(error) !== "ENOENT" && !(error instanceof BridgeError && error.code === "OBSERVATION_NOT_ENABLED")) throw error; }
    authority(); coordination.assertMutable();
    try {
      await mkdir(store.#root, { mode: 0o700 });
      await mkdir(store.#artifacts, { mode: 0o700 });
      await atomicJson(store.#statePath(), emptyState(coordination), authority);
    } catch (cause) {
      throw new BridgeError("OBSERVATION_INITIALIZATION_UNCERTAIN", "Observation initialization has no acknowledged durable outcome; inspect its private namespace", { cause });
    }
    return ObservationStore.open(coordination, authority);
  }

  #statePath(): string { return join(this.#root, "state.json"); }
  #artifactPath(id: string): string { return join(this.#artifacts, `${id}.json`); }
  async #state(): Promise<ObservationState> {
    this.#assertOpen();
    await this.coordination.snapshot();
    const raw = await boundedJson(this.#statePath(), OBSERVATION_MAX_STATE_BYTES);
    return decodeObservationState(raw, this.coordination.repositoryId, this.coordination.epoch);
  }
  #assertOpen(): void {
    if (this.#closed) throw new BridgeError("OBSERVATION_CLOSED", "Observation store is closed");
    if (this.#uncertain) throw new BridgeError("OBSERVATION_REOPEN_REQUIRED", "Observation publication outcome is uncertain; reopen under current authority");
  }
  async #publishState(next: ObservationState): Promise<void> {
    this.coordination.assertMutable(); this.authority();
    if (Buffer.byteLength(JSON.stringify(next)) > OBSERVATION_MAX_STATE_BYTES)
      throw new BridgeError("OBSERVATION_CAPACITY", "Observation notice state reached its byte bound");
    try { await atomicJson(this.#statePath(), next, () => { this.coordination.assertMutable(); this.authority(); }); }
    catch (cause) { this.#uncertain = true; throw new BridgeError("OBSERVATION_PUBLICATION_UNCERTAIN", "Observation state publication has an unknown outcome; reopen before retry", { cause }); }
  }

  async publish(input: PublishObservation): Promise<ObservationArtifact> {
    this.#assertOpen();
    const { report, work_revision, workspace_generation, control_generation } = input, recipients = [...input.recipients];
    if (!Number.isSafeInteger(work_revision) || work_revision < 1 || !Number.isSafeInteger(workspace_generation) || workspace_generation < 1 ||
      (control_generation !== null && (!Number.isSafeInteger(control_generation) || control_generation < 1)) ||
      recipients.length > OBSERVATION_MAX_RECIPIENTS || new Set(recipients).size !== recipients.length)
      throw new BridgeError("OBSERVATION_INVALID", "Invalid work revision or recipient set");
    if (canonicalHash(sourceReference(input.input)) !== canonicalHash(report.comparison.input) ||
      canonicalHash(sourceReference(input.observed)) !== canonicalHash(report.comparison.observed) ||
      report.comparison.input.source.path !== report.comparison.observed.source.path ||
      input.observed.source.kind !== "working_capture" || input.observed.source.workspace_generation !== workspace_generation)
      throw new BridgeError("OBSERVATION_INVALID", "Artifact source identities differ from the compact report");
    const materiality = noticeMateriality(report);
    const capture_digest = captureContentDigest(input.input, input.observed);
    const report_text = renderComparison(report);
    const analysis_digest = canonicalHash({ parser_identity: report.comparison.parser_identity,
      extractor_identity: report.comparison.extractor_identity });
    const base = { schema_version: OBSERVATION_SCHEMA, work_id: report.work_id, work_revision,
      workspace_generation, control_generation, parent_id: report.parent_id, materiality, capture_digest,
      analysis_digest, path: input.input.source.path,
      report_text, input: input.input, observed: input.observed };
    const id = canonicalHash(base);
    const artifact = decodeObservationArtifact({ ...base, id });
    const payload = `${JSON.stringify(artifact)}\n`, bytes = Buffer.byteLength(payload);
    if (bytes > OBSERVATION_MAX_ARTIFACT_BYTES) throw new BridgeError("OBSERVATION_CAPACITY", "One observation artifact exceeds its retained byte bound");
    return this.#writes.run(async () => {
      this.coordination.assertMutable(); this.authority();
      const before = await this.#state();
      await this.#removeOrphans(before);
      const latestArtifact = [...before.artifacts].reverse().find(item => item.work_id === report.work_id && item.path === artifact.path);
      const sameMaterial = latestArtifact?.materiality === materiality && latestArtifact.work_revision === work_revision &&
        latestArtifact.workspace_generation === workspace_generation && latestArtifact.control_generation === control_generation;
      const knownRecipients = sameMaterial ? latestArtifact.ordinary_recipients : [];
      const recipientsToNotify = recipients.filter(recipient => {
        if (!/^[a-f0-9]{64}$/.test(recipient)) throw new BridgeError("OBSERVATION_INVALID", "Invalid recipient identity");
        return !knownRecipients.includes(recipient);
      });
      const ordinary_recipients = [...new Set([...knownRecipients, ...recipientsToNotify])];
      if (ordinary_recipients.length > OBSERVATION_MAX_RECIPIENTS)
        throw new BridgeError("OBSERVATION_CAPACITY", "Watched recipient history for one work path reached its bound");
      if (latestArtifact && latestArtifact.capture_digest === capture_digest && latestArtifact.materiality === materiality &&
        latestArtifact.analysis_digest === analysis_digest &&
        latestArtifact.work_revision === work_revision && latestArtifact.workspace_generation === workspace_generation &&
        latestArtifact.control_generation === control_generation && !recipientsToNotify.length) {
        return decodeObservationArtifact(await boundedJson(this.#artifactPath(latestArtifact.id), OBSERVATION_MAX_ARTIFACT_BYTES));
      }
      const retained = before.artifacts.some(item => item.id === id);
      if (!retained) await publishImmutable(this.#artifactPath(id), payload, () => { this.coordination.assertMutable(); this.authority(); });
      const artifacts = retained ? before.artifacts.map(item => item.id === id ? { ...item, ordinary_recipients } : item)
        : [...before.artifacts, { id, bytes, work_id: report.work_id,
          work_revision, workspace_generation, control_generation, path: artifact.path,
          materiality, capture_digest, analysis_digest, ordinary_recipients }];
      let notices = [...before.notices], floor_sequence = before.floor_sequence, next_sequence = before.next_sequence;
      for (const recipient of recipientsToNotify) {
        notices.push({ schema_version: OBSERVATION_SCHEMA, sequence: next_sequence++, id: createHash("sha256").update(`${recipient}:${id}:${next_sequence - 1}`).digest("hex"),
          recipient, work_id: report.work_id, work_revision, workspace_generation, control_generation,
          artifact_id: id, materiality, acknowledged: false });
      }
      while (artifacts.length > OBSERVATION_MAX_ARTIFACTS || artifacts.reduce((total, item) => total + item.bytes, 0) > OBSERVATION_MAX_RETAINED_BYTES) {
        const removed = artifacts.shift()!;
        notices = notices.filter(item => {
          if (item.artifact_id !== removed.id) return true;
          floor_sequence = Math.max(floor_sequence, item.sequence);
          return false;
        });
      }
      while (notices.length > OBSERVATION_MAX_NOTICES) floor_sequence = Math.max(floor_sequence, notices.shift()!.sequence);
      notices = notices.filter(item => item.sequence > floor_sequence);
      // A notice can be published only after its exact immutable report/capture file exists.
      const next = decodeObservationState({ ...before, revision: before.revision + 1, next_sequence,
        floor_sequence, artifacts, notices }, this.coordination.repositoryId, this.coordination.epoch);
      if (JSON.stringify(next) !== JSON.stringify(before)) await this.#publishState(next);
      await this.#removeOrphans(next);
      return artifact;
    });
  }

  async pull(recipient: string, cursor: number, authorize: ObservationAuthority): Promise<ObservationPull> {
    if (!/^[a-f0-9]{64}$/.test(recipient) || !Number.isSafeInteger(cursor) || cursor < 0) throw new BridgeError("OBSERVATION_CURSOR_INVALID", "Invalid recipient or cursor");
    const state = await this.#state();
    if (cursor >= state.next_sequence) throw new BridgeError("OBSERVATION_CURSOR_INVALID", "Cursor is ahead of the retained observation stream");
    const selected: ObservationNotice[] = [];
    const grants = new Map<string, boolean>();
    for (const item of state.notices) {
      if (item.recipient !== recipient) continue;
      const key = authorizationKey(item);
      let permitted = grants.get(key);
      if (permitted === undefined) {
        try { await authorize(recipient, item.work_id, item.work_revision, generationOf(item)); permitted = true; }
        catch (error) {
          if (!(error instanceof BridgeError) || error.code !== "STRUCTURAL_SOURCE_FORBIDDEN") throw error;
          permitted = false;
        }
        grants.set(key, permitted);
      }
      if (permitted) selected.push(item);
    }
    const pending = selected.filter(item => !item.acknowledged).slice(0, OBSERVATION_MAX_PULL);
    const pathByArtifact = new Map(state.artifacts.map(item => [item.id, item.path]));
    const latest = new Map<string, ObservationNotice>();
    for (const item of selected) {
      const path = pathByArtifact.get(item.artifact_id);
      if (path === undefined) throw new BridgeError("OBSERVATION_RECORD_INVALID", "Notice references an unavailable artifact path");
      latest.set(JSON.stringify([item.work_id, path]), item);
    }
    const current = [...latest.values()].slice(-OBSERVATION_MAX_PULL);
    // A pull does not consume notices. The recipient must explicitly acknowledge them.
    return { schema_version: OBSERVATION_SCHEMA, cursor: state.next_sequence - 1, gap: cursor < state.floor_sequence,
      notices: pending, current: cursor < state.floor_sequence ? current : [] };
  }

  /** Current retained report references, independent of whether a notice was ever emitted. */
  async listCurrent(recipient: string, authorize: ObservationAuthority): Promise<ObservationCurrent> {
    if (!/^[a-f0-9]{64}$/.test(recipient)) throw new BridgeError("OBSERVATION_INVALID", "Invalid recipient identity");
    const state = await this.#state();
    const reports: ObservationCurrent["reports"][number][] = [];
    const selected = new Set<string>();
    for (const item of [...state.artifacts].reverse()) {
      const key = `${item.work_id}:${item.path}`;
      if (selected.has(key)) continue;
      try { await authorize(recipient, item.work_id, item.work_revision, generationOf(item)); }
      catch (error) {
        if (!(error instanceof BridgeError) || error.code !== "STRUCTURAL_SOURCE_FORBIDDEN") throw error;
        continue;
      }
      selected.add(key);
      reports.push({ id: item.id, work_id: item.work_id, work_revision: item.work_revision,
        workspace_generation: item.workspace_generation, control_generation: item.control_generation,
        path: item.path, materiality: item.materiality });
    }
    return { schema_version: OBSERVATION_SCHEMA, reports };
  }

  /** A later related work can make an already retained report relevant without capturing it again. */
  async notifyExisting(artifactId: string, recipient: string, subjectId: string, correspondenceState: "overlap" | "resolved",
    authorize: ObservationAuthority): Promise<ObservationNotice> {
    if (!/^[a-f0-9]{64}$/.test(artifactId) || !/^[a-f0-9]{64}$/.test(recipient) || !/^[a-f0-9]{64}$/.test(subjectId))
      throw new BridgeError("OBSERVATION_INVALID", "Invalid retained artifact, recipient, or exact subject identity");
    if (correspondenceState !== "overlap" && correspondenceState !== "resolved")
      throw new BridgeError("OBSERVATION_INVALID", "Invalid correspondence event phase");
    const observed = await this.#state();
    const selected = observed.artifacts.find(item => item.id === artifactId);
    if (!selected) throw new BridgeError("STRUCTURAL_DETAIL_UNAVAILABLE", "The exact observation artifact was pruned");
    await authorize(recipient, selected.work_id, selected.work_revision, generationOf(selected));
    return this.#writes.run(async () => {
      const before = await this.#state();
      const current = before.artifacts.find(item => item.id === artifactId);
      if (!current || current.work_id !== selected.work_id || current.work_revision !== selected.work_revision)
        throw new BridgeError("STRUCTURAL_DETAIL_UNAVAILABLE", "The exact observation artifact was pruned or replaced");
      let file;
      try { file = await lstat(this.#artifactPath(artifactId)); }
      catch (error) {
        if (nativeCode(error) === "ENOENT") throw new BridgeError("STRUCTURAL_DETAIL_UNAVAILABLE", "The retained observation artifact is missing");
        throw error;
      }
      if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || file.uid !== process.getuid?.() ||
        (file.mode & 0o077) !== 0 || file.size !== current.bytes)
        throw new BridgeError("OBSERVATION_RECORD_INVALID", "Retained observation artifact file contradicts its inventory");
      const latestForSubject = [...before.notices].reverse().find(item => item.recipient === recipient &&
        item.artifact_id === artifactId && item.subject_id === subjectId);
      if (latestForSubject?.correspondence_state === correspondenceState) return latestForSubject;
      const sequence = before.next_sequence;
      const notice: ObservationNotice = { schema_version: OBSERVATION_SCHEMA, sequence,
        id: canonicalHash({ kind: "correspondence_notice", recipient, artifact_id: artifactId,
          subject_id: subjectId, correspondence_state: correspondenceState, sequence }),
        recipient, work_id: current.work_id, work_revision: current.work_revision,
        workspace_generation: current.workspace_generation, control_generation: current.control_generation, artifact_id: artifactId,
        materiality: canonicalHash({ kind: "correspondence", artifact_id: artifactId,
          subject_id: subjectId, correspondence_state: correspondenceState }),
        subject_id: subjectId, correspondence_state: correspondenceState, acknowledged: false };
      let notices = [...before.notices, notice], floor_sequence = before.floor_sequence;
      while (notices.length > OBSERVATION_MAX_NOTICES) floor_sequence = Math.max(floor_sequence, notices.shift()!.sequence);
      const next = decodeObservationState({ ...before, revision: before.revision + 1, next_sequence: sequence + 1,
        floor_sequence, notices }, this.coordination.repositoryId, this.coordination.epoch);
      await this.#publishState(next);
      return notice;
    });
  }

  async ack(recipient: string, noticeId: string, authorize: ObservationAuthority): Promise<ObservationNotice> {
    if (!/^[a-f0-9]{64}$/.test(recipient) || !/^[a-f0-9]{64}$/.test(noticeId)) throw new BridgeError("OBSERVATION_CURSOR_INVALID", "Invalid notice acknowledgment");
    const observed = await this.#state();
    const selected = observed.notices.find(row => row.id === noticeId && row.recipient === recipient);
    if (!selected) throw new BridgeError("OBSERVATION_NOTICE_UNAVAILABLE", "Notice was pruned or does not belong to this recipient");
    await authorize(recipient, selected.work_id, selected.work_revision, generationOf(selected));
    return this.#writes.run(async () => {
      const before = await this.#state();
      const item = before.notices.find(row => row.id === noticeId && row.recipient === recipient);
      if (!item) throw new BridgeError("OBSERVATION_NOTICE_UNAVAILABLE", "Notice was pruned or does not belong to this recipient");
      if (item.acknowledged) return item;
      const acknowledged = { ...item, acknowledged: true };
      const next = decodeObservationState({ ...before, revision: before.revision + 1,
        notices: before.notices.map(row => row.id === noticeId ? acknowledged : row) }, this.coordination.repositoryId, this.coordination.epoch);
      await this.#publishState(next);
      return acknowledged;
    });
  }

  async readReport(id: string, recipient: string, authorize: ObservationAuthority): Promise<Readonly<{ id: string; work_id: string; text: string }>> {
    const item = await this.#readAuthorized(id, recipient, authorize);
    if (requiresParameterMaskRefresh(item.analysis_digest)) {
      throw new BridgeError("STRUCTURAL_REPORT_REFRESH_REQUIRED", "This report predates corrected parameter masking; refresh the work and retrieve its current report identity");
    }
    return { id: item.id, work_id: item.work_id, text: item.report_text };
  }
  /** Internal restart seed from exact retained captures; the public boundary exposes only bounded pages. */
  async readRetainedPair(id: string, recipient: string, authorize: ObservationAuthority): Promise<RetainedObservationPair> {
    const item = await this.#readAuthorized(id, recipient, authorize);
    return { id: item.id, work_id: item.work_id, work_revision: item.work_revision,
      workspace_generation: item.workspace_generation, control_generation: item.control_generation,
      parent_id: item.parent_id, path: item.path, input: item.input, observed: item.observed };
  }
  async readDetail(id: string, recipient: string, side: "input" | "observed", startByte: number, endByte: number,
    authorize: ObservationAuthority): Promise<Readonly<{ id: string; side: "input" | "observed"; text: string }>> {
    if (!Number.isSafeInteger(startByte) || !Number.isSafeInteger(endByte) || startByte < 0 || endByte < startByte || endByte - startByte > 24_576)
      throw new BridgeError("STRUCTURAL_DETAIL_RANGE_INVALID", "Invalid bounded detail range");
    const item = await this.#readAuthorized(id, recipient, authorize), file = item[side];
    if (file.status !== "present" || endByte > file.byte_length) throw new BridgeError("STRUCTURAL_DETAIL_UNAVAILABLE", "The requested detail is unavailable from the exact capture");
    const bytes = Buffer.from(file.text, "utf8");
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(startByte, endByte)); }
    catch { throw new BridgeError("STRUCTURAL_DETAIL_RANGE_INVALID", "Detail range splits a UTF-8 code point"); }
    return { id, side, text };
  }
  async #readAuthorized(id: string, recipient: string, authorize: ObservationAuthority): Promise<ObservationArtifact> {
    if (!/^[a-f0-9]{64}$/.test(id) || !/^[a-f0-9]{64}$/.test(recipient)) throw new BridgeError("OBSERVATION_INVALID", "Invalid artifact or recipient identity");
    const state = await this.#state();
    const selected = state.artifacts.find(item => item.id === id);
    if (!selected) throw new BridgeError("STRUCTURAL_DETAIL_UNAVAILABLE", "The exact observation artifact was pruned");
    await authorize(recipient, selected.work_id, selected.work_revision, generationOf(selected));
    const item = decodeObservationArtifact(await boundedJson(this.#artifactPath(id), OBSERVATION_MAX_ARTIFACT_BYTES));
    if (item.id !== id || canonicalHash({ schema_version: item.schema_version, work_id: item.work_id,
      work_revision: item.work_revision, workspace_generation: item.workspace_generation,
      control_generation: item.control_generation, parent_id: item.parent_id, materiality: item.materiality,
      capture_digest: item.capture_digest, analysis_digest: item.analysis_digest, path: item.path, report_text: item.report_text,
      input: item.input, observed: item.observed }) !== id)
      throw new BridgeError("OBSERVATION_RECORD_INVALID", "Observation artifact content differs from its immutable identity");
    if (item.work_id !== selected.work_id || item.work_revision !== selected.work_revision ||
      item.workspace_generation !== selected.workspace_generation || item.control_generation !== selected.control_generation ||
      item.capture_digest !== selected.capture_digest || item.analysis_digest !== selected.analysis_digest)
      throw new BridgeError("OBSERVATION_RECORD_INVALID", "Artifact metadata contradicts the retained inventory");
    await authorize(recipient, item.work_id, item.work_revision, generationOf(item));
    return item;
  }
  async #removeOrphans(state: ObservationState): Promise<void> {
    const keep = new Set(state.artifacts.map(item => `${item.id}.json`));
    const directory = await opendir(this.#artifacts);
    let seen = 0;
    for await (const entry of directory) {
      if (++seen > 64) throw new BridgeError("OBSERVATION_CAPACITY", "Observation artifact directory exceeds its bounded inventory");
      const orphan = /^[a-f0-9]{64}\.json$/.test(entry.name) && !keep.has(entry.name);
      const stage = /^[a-f0-9]{64}\.json\.\d+\.[0-9a-f-]{36}\.tmp$/.test(entry.name);
      if (orphan || stage) {
        this.coordination.assertMutable(); this.authority(); await unlink(join(this.#artifacts, entry.name));
      }
    }
  }
  async close(): Promise<void> { await this.#writes.run(() => { this.#closed = true; }); }
}

function emptyState(coordination: CoordinationStore): ObservationState {
  return { schema_version: OBSERVATION_STATE_SCHEMA, repository_id: coordination.repositoryId, epoch: coordination.epoch,
    revision: 0, next_sequence: 1, floor_sequence: 0, artifacts: [], notices: [] };
}
function generationOf(value: ObservationGeneration): ObservationGeneration {
  return { workspace_generation: value.workspace_generation, control_generation: value.control_generation };
}
function authorizationKey(value: ObservationNotice): string {
  return JSON.stringify([value.work_id, value.work_revision, value.workspace_generation, value.control_generation]);
}
function sourceReference(file: SourceFile): SourceReference {
  switch (file.status) {
    case "present": return { source: file.source, status: file.status, content_sha256: file.content_sha256,
      byte_length: file.byte_length, consistency: file.consistency, mode: file.mode };
    case "non_source": return { source: file.source, status: file.status, entry_kind: file.entry_kind,
      ...(file.mode === undefined ? {} : { mode: file.mode }), ...(file.object_oid === undefined ? {} : { object_oid: file.object_oid }) };
    default: return { source: file.source, status: file.status };
  }
}
async function privateDirectory(path: string): Promise<void> {
  let info;
  try { info = await lstat(path); } catch (error) {
    if (nativeCode(error) === "ENOENT") throw new BridgeError("OBSERVATION_NOT_ENABLED", "Observation state has not been initialized");
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
    throw new BridgeError("OBSERVATION_PATH_UNSAFE", "Observation state requires private owned directories");
}
async function boundedJson(path: string, maxBytes: number): Promise<unknown> {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (nativeCode(error) === "ENOENT") throw new BridgeError("OBSERVATION_STORE_INCOMPLETE", "Observation state is incomplete");
    if (nativeCode(error) === "ELOOP") throw new BridgeError("OBSERVATION_PATH_UNSAFE", "Observation records may not be symlinks");
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
      throw new BridgeError("OBSERVATION_PATH_UNSAFE", "Observation records must be private owned regular files");
    if (info.size > maxBytes) throw new BridgeError("OBSERVATION_RECORD_TOO_LARGE", "Observation record exceeds its read bound");
    const data = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < data.length) {
      const chunk = await handle.read(data, length, data.length - length, length);
      if (!chunk.bytesRead) break;
      length += chunk.bytesRead;
    }
    if (length !== info.size) throw new BridgeError("OBSERVATION_RECORD_CHANGED", "Observation record changed while being read");
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, length))); }
    catch (cause) { throw new BridgeError("OBSERVATION_RECORD_INVALID", "Observation record is not valid UTF-8 JSON", { cause }); }
  } finally { await handle.close(); }
}
async function publishImmutable(path: string, payload: string, authority: MutationAuthority): Promise<void> {
  const stage = `${path}.${process.pid}.${randomUUID()}.tmp`;
  authority();
  const handle = await open(stage, "wx", 0o600);
  try { await handle.writeFile(payload); await handle.sync(); } finally { await handle.close(); }
  try {
    authority();
    try { await link(stage, path); }
    catch (error) {
      if (nativeCode(error) !== "EEXIST") throw error;
      const existing = await boundedJson(path, OBSERVATION_MAX_ARTIFACT_BYTES);
      if (JSON.stringify(existing) !== payload.trimEnd()) throw new BridgeError("OBSERVATION_ARTIFACT_CONFLICT", "Immutable artifact identity has different bytes");
    }
    const directory = await open(join(path, ".."), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await unlink(stage).catch(() => undefined); }
}
