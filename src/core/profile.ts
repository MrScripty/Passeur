import { SharedProfileSchema, type SharedProfile } from "../contracts/tasks.js";
import { AgentProfileSchema } from "../contracts/agents.js";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { ProfileSchema } from "../contracts/index.js";
import { BridgeError, filesystemFailure } from "./errors.js";

/** Profile reads project supported history in memory. They never rewrite operator configuration. */
export function normalizeProfile(value: unknown): import("../contracts/agents.js").AgentProfile {
  if (typeof value !== "object" || value === null || !("schema_version" in value)) throw new BridgeError("PROFILE_INVALID", "Profile version is required");
  if (value.schema_version === 2) {
    const decoded = AgentProfileSchema.safeParse(value);
    if (!decoded.success) throw new BridgeError("PROFILE_INVALID", "The agent profile violates its schema");
    return decoded.data;
  }
  if (value.schema_version !== 1) throw new BridgeError("PROFILE_VERSION_UNSUPPORTED", "Profile version is unsupported; preserve the original file");
  const legacy = ProfileSchema.safeParse(value);
  if (!legacy.success) throw new BridgeError("PROFILE_INVALID", "The legacy profile violates its schema");
  const p = legacy.data;
  return AgentProfileSchema.parse({ schema_version: 2,
    execution: { task_timeout_ms: p.task_timeout_ms, stop_grace_ms: p.stop_grace_ms,
      max_workers: p.max_workers, max_queued_tasks: p.max_queued_tasks,
      implementation: { enabled: p.implementation.enabled, ...(p.implementation.worktree_root ? { worktree_root: p.implementation.worktree_root } : {}) } },
    agents: [{ agent_id: "muse", adapter_id: "muse", enabled: true, description: "Migrated Muse registration",
      options: { muse_bin: p.muse_bin, model: p.model, review: p.review, subscription: p.subscription,
        implementation: { sandbox_network: p.implementation.sandbox_network } } }],
  });
}
export const MAX_PROFILE_BYTES = 65_536;
/** Bound allocation and UTF-8 decoding even when the operator's file changes during a read. */
export async function readProfileBytes(path: string): Promise<Buffer> {
  const absolute = resolve(path);
  let handle;
  try { handle = await open(absolute, "r"); }
  catch (error) { throw filesystemFailure(error, "profile.open", absolute); }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAX_PROFILE_BYTES) throw new BridgeError("PROFILE_INVALID", "Profile must be a regular file no larger than 64 KiB");
    const buffer = Buffer.alloc(metadata.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length !== metadata.size) throw new BridgeError("PROFILE_CHANGED_DURING_READ", "Profile changed during read; retry after the editor finishes");
    return buffer.subarray(0, length);
  } catch (error) { throw filesystemFailure(error, "profile.read", absolute); }
  finally { await handle.close(); }
}
export function decodeProfileJson(bytes: Buffer): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new BridgeError("PROFILE_INVALID", "Profile contains invalid UTF-8 or JSON"); }
}
export async function readProfileJson(path: string): Promise<unknown> { return decodeProfileJson(await readProfileBytes(path)); }
export async function loadAgentProfile(path: string): Promise<import("../contracts/agents.js").AgentProfile> {
  return normalizeProfile(await readProfileJson(path));
}

/** Admission is deliberately migration-gated. Merely reading old configuration never changes lifetime semantics. */
export function decodeSharedProfile(value: unknown): SharedProfile {
  if (typeof value === "object" && value !== null && "schema_version" in value && (value.schema_version === 1 || value.schema_version === 2)) throw new BridgeError("PROFILE_MIGRATION_REQUIRED", "Run migrate-profile with explicit authority; new tasks require profile version 3 without execution deadlines");
  if (typeof value === "object" && value !== null && "schema_version" in value && Number.isInteger(value.schema_version) && value.schema_version !== 3) throw new BridgeError("PROFILE_VERSION_UNSUPPORTED", "Profile version is unsupported");
  const parsed = SharedProfileSchema.safeParse(value);
  if (!parsed.success) throw new BridgeError("PROFILE_INVALID", "Shared-service profile violates version 3");
  return parsed.data;
}
export async function loadSharedProfile(path: string): Promise<SharedProfile> { return decodeSharedProfile(await readProfileJson(path)); }
export function migrateSharedProfile(value: unknown): SharedProfile {
  if (typeof value === "object" && value !== null && "schema_version" in value && value.schema_version === 3) return decodeSharedProfile(value);
  const old = normalizeProfile(value);
  const { task_timeout_ms: _historicalDeadline, ...execution } = old.execution;
  return SharedProfileSchema.parse({ schema_version: 3, agents: old.agents, execution });
}
