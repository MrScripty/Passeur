import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { atomicJson, type MutationAuthority } from "./atomic-json.js";
import { canonicalHash, Mutex } from "../core/async.js";
import { BridgeError, filesystemFailure, nativeCode } from "../core/errors.js";
import { CONTROL_MAX_BYTES, assertControlTransition, entityId, decodeControl, decodeLimits, emptyControl, type ControlState } from "../contracts/coordination-control.js";

type DirectoryIdentity = { dev: number; ino: number };
/** One instance per elected repository service. This store does not elect/fence process owners. */
export class CoordinationStore {
  readonly #writes = new Mutex();
  #closed = false;
  #uncertain = false;
  private constructor(readonly root: string, readonly repositoryId: string, readonly epoch: string,
    private readonly identity: DirectoryIdentity, private readonly authority: MutationAuthority) {}

  static async open(stateRoot: string, repositoryId: string, authority: MutationAuthority): Promise<CoordinationStore> {
    requireLinux();
    const parent = await realpath(stateRoot), root = join(parent, "coordination");
    await directory(parent);
    let info;
    try { info = await directory(root); }
    catch (error) {
      if (nativeCode(error) === "ENOENT") throw new BridgeError("COORDINATION_NOT_ENABLED", "Coordination has not been explicitly initialized");
      throw error;
    }
    const raw = await readRecord(join(root, "initialized.json"));
    const marker = decodeMarker(raw, repositoryId);
    const store = new CoordinationStore(root, repositoryId, marker.epoch, { dev: info.dev, ino: info.ino }, authority);
    await store.snapshot();
    return store;
  }
  /** Explicit operator/service action; discovery uses open and never initializes missing state. */
  static async initialize(stateRoot: string, repositoryId: string, rawLimits: unknown, authority: MutationAuthority): Promise<CoordinationStore> {
    requireLinux();
    const limits = decodeLimits(rawLimits), state = emptyControl(repositoryId, randomUUID(), limits);
    const parent = await realpath(stateRoot), root = join(parent, "coordination");
    await directory(parent); authority();
    try {
      await lstat(root);
      const existing = await CoordinationStore.open(parent, repositoryId, authority);
      if (canonicalHash((await existing.snapshot()).limits) !== canonicalHash(limits)) throw new BridgeError("COORDINATION_CONFIG_CONFLICT", "Existing coordination limits require explicit migration");
      return existing;
    } catch (error) { if (nativeCode(error) !== "ENOENT") throw error; }
    const stage = join(parent, `.coordination-initializing-${state.epoch}`);
    authority(); await mkdir(stage, { mode: 0o700 });
    // Failure leaves an owned non-authoritative stage for explicit recovery, never a partial enabled store.
    try {
      await atomicJson(join(stage, "initialized.json"), { schema_version: 1, repository_id: repositoryId, epoch: state.epoch }, authority);
      await atomicJson(join(stage, "control.json"), state, authority);
      await syncDirectory(stage);
      authority();
      try { await lstat(root); throw new BridgeError("COORDINATION_INIT_CONFLICT", "A coordination directory appeared during initialization"); }
      catch (error) { if (nativeCode(error) !== "ENOENT") throw error; }
      await rename(stage, root); await syncDirectory(parent);
    } catch (cause) {
      throw new BridgeError("COORDINATION_INITIALIZATION_UNCERTAIN", "Initialization did not establish an acknowledged durable outcome; preserve the stage and inspect the destination", { cause, stage: "coordination.initialize" });
    }
    return CoordinationStore.open(parent, repositoryId, authority);
  }
  async #checkDirectory(): Promise<void> {
    if (this.#closed) throw new BridgeError("COORDINATION_CLOSED", "The coordination store is closed");
    let info;
    try { info = await directory(this.root); }
    catch (error) {
      if (nativeCode(error) === "ENOENT") throw new BridgeError("COORDINATION_STORE_INCOMPLETE", "The initialized coordination directory disappeared");
      throw error;
    }
    if (info.dev !== this.identity.dev || info.ino !== this.identity.ino) throw new BridgeError("COORDINATION_STORE_REPLACED", "Coordination directory identity changed");
    const marker = decodeMarker(await readRecord(join(this.root, "initialized.json")), this.repositoryId);
    if (marker.epoch !== this.epoch) throw new BridgeError("COORDINATION_STORE_REPLACED", "Initialization epoch changed");
  }
  async snapshot(): Promise<ControlState> {
    await this.#checkDirectory();
    const state = decodeControl(await readRecord(join(this.root, "control.json")), this.repositoryId);
    if (state.epoch !== this.epoch) throw new BridgeError("COORDINATION_STORE_REPLACED", "Control epoch contradicts initialization");
    return state;
  }
  assertMutable(): void {
    if (this.#closed) throw new BridgeError("COORDINATION_CLOSED", "The coordination store is closed");
    if (this.#uncertain) throw new BridgeError("COORDINATION_REOPEN_REQUIRED", "A previous publication has an unknown outcome; reopen under current service authority");
    this.authority();
  }
  async publish(expected: ControlState, candidate: ControlState): Promise<void> {
    // Decode synchronously before the first await so caller mutation cannot change accepted inputs.
    const before = decodeControl(expected, this.repositoryId), next = decodeControl(candidate, this.repositoryId);
    if (next.epoch !== before.epoch || next.revision !== before.revision + 1 || canonicalHash(next.limits) !== canonicalHash(before.limits)) throw new BridgeError("COORDINATION_INVALID_TRANSITION", "Publication must preserve epoch/limits and advance one revision");
    assertControlTransition(before, next);
    const payload = `${JSON.stringify(next, null, 2)}\n`;
    if (Buffer.byteLength(payload) > CONTROL_MAX_BYTES) throw new BridgeError("COORDINATION_CAPACITY", "Control record byte capacity is exhausted; no update was published");
    await this.#writes.run(async () => {
      this.assertMutable();
      const current = await this.snapshot();
      if (canonicalHash(current) !== canonicalHash(before)) throw new BridgeError("COORDINATION_STALE_RECORD", "Control changed after it was read");
      try {
        await atomicJson(join(this.root, "control.json"), next, this.authority);
      } catch (cause) {
        this.#uncertain = true;
        throw new BridgeError("COORDINATION_PUBLICATION_UNCERTAIN", "Publication outcome is not acknowledged; preserve state and reconcile using the operation key", { cause, stage: "coordination.publish" });
      }
    });
  }
  async close(): Promise<void> { await this.#writes.run(() => { this.#closed = true; }); }
}
function requireLinux(): void {
  if (process.platform !== "linux") throw new BridgeError("COORDINATION_PLATFORM_UNSUPPORTED", "Coordination persistence is qualified only on local Linux filesystems");
}
async function directory(path: string) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new BridgeError("COORDINATION_PATH_UNSAFE", "Coordination requires private owned directories");
  return info;
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function readRecord(path: string): Promise<unknown> {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (nativeCode(error) === "ENOENT") throw new BridgeError("COORDINATION_STORE_INCOMPLETE", "Initialized coordination state is incomplete; it must not be reset");
    if (nativeCode(error) === "ELOOP") throw new BridgeError("COORDINATION_PATH_UNSAFE", "Coordination records may not be symlinks");
    throw filesystemFailure(error, "coordination.read", path);
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new BridgeError("COORDINATION_PATH_UNSAFE", "Coordination records must be private owned regular files");
    if (info.size > CONTROL_MAX_BYTES) throw new BridgeError("COORDINATION_RECORD_TOO_LARGE", "Coordination record exceeds its read bound");
    const buffer = Buffer.alloc(info.size + 1);
    let total = 0;
    while (total < buffer.length) { const read = await handle.read(buffer, total, buffer.length - total, total); if (!read.bytesRead) break; total += read.bytesRead; }
    if (total !== info.size) throw new BridgeError("COORDINATION_RECORD_CHANGED", "Record changed while being read");
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, total))); }
    catch (cause) { throw new BridgeError("COORDINATION_RECORD_CORRUPT", "Control is not valid UTF-8 JSON", { cause }); }
  } finally { await handle.close(); }
}
function decodeMarker(value: unknown, repository: string): { epoch: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new BridgeError("COORDINATION_RECORD_CORRUPT", "Invalid initialization marker");
  const keys = Object.keys(value).sort();
  if (!("schema_version" in value) || typeof value.schema_version !== "number" || !Number.isSafeInteger(value.schema_version) || value.schema_version < 1) throw new BridgeError("COORDINATION_RECORD_CORRUPT", "Invalid initialization version");
  if (value.schema_version !== 1) throw new BridgeError("COORDINATION_VERSION_UNSUPPORTED", "Initialization version has no supported reader");
  if (keys.join(",") !== "epoch,repository_id,schema_version" || !("repository_id" in value) || !("epoch" in value)) throw new BridgeError("COORDINATION_RECORD_CORRUPT", "Initialization marker fields are incomplete or unexpected");
  if (value.repository_id !== repository) throw new BridgeError("COORDINATION_BINDING_CONFLICT", "Initialization belongs to another repository");
  return { epoch: entityId(value.epoch) };
}
