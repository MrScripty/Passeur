import { createHash, randomUUID } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { AgentProfileSchema, AgentRegistrationSchema, type AgentProfile } from "../contracts/agents.js";
import { AgentRegistry } from "../agents/registry.js";
import { builtinAdapters } from "../agents/builtins.js";
import { atomicJson } from "../store/task-store.js";
import { BridgeError, filesystemFailure } from "./errors.js";
import { stableHash } from "./async.js";
import { MAX_PROFILE_BYTES, decodeProfileJson, normalizeProfile, readProfileBytes } from "./profile.js";

export type ProfileEdit = { kind: "migrate" } | { kind: "configure-agent"; registration: unknown; replace_fingerprint?: string };
export type ProfileEditReceipt = { profile_path: string; changed: boolean; profile_fingerprint: string; backup_path?: string; restart_required: boolean };
const fingerprint = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Operator-only edit. Cooperating writers lock; external editors must remain quiescent. */
export async function editProfile(path: string, edit: ProfileEdit): Promise<ProfileEditReceipt> {
  if ((await lstat(path)).isSymbolicLink()) throw new BridgeError("PROFILE_EDIT_UNSUPPORTED", "Select the canonical profile file explicitly instead of editing a symlink");
  const canonical = await realpath(path);
  let lost: Error | undefined;
  const { default: lockfile } = await import("proper-lockfile");
  const release = await lockfile.lock(canonical, { realpath: true, retries: 0, stale: 30_000, update: 10_000,
    onCompromised(error) { lost = error; } });
  const authority = () => { if (lost) throw new BridgeError("PROFILE_EDIT_AUTHORITY_LOST", "Profile edit lock was compromised; inspect the candidate and backup", { cause: lost }); };
  try {
    authority();
    const original = await readProfileBytes(canonical);
    const value = decodeProfileJson(original);
    const profile = normalizeProfile(value);
    let candidate: AgentProfile = profile;
    if (edit.kind === "configure-agent") {
      const parsed = AgentRegistrationSchema.safeParse(edit.registration);
      if (!parsed.success) throw new BridgeError("AGENT_CONFIGURATION_INVALID", "Registration violates its declared contract");
      const registration = parsed.data;
      if (!Object.hasOwn(builtinAdapters, registration.adapter_id)) throw new BridgeError("AGENT_UNSUPPORTED", "Configuration-only registration requires an installed adapter");
      const state = new AgentRegistry({ ...profile, agents: [registration] }, builtinAdapters).catalog(false).agents[0]!;
      if (state.state === "invalid" || state.state === "unsupported") throw new BridgeError("AGENT_CONFIGURATION_INVALID", "The new registration violates its adapter contract");
      const existing = profile.agents.find((agent) => agent.agent_id === registration.agent_id);
      if (existing && stableHash(existing) !== stableHash(registration) && edit.replace_fingerprint !== stableHash(existing)) {
        throw new BridgeError("AGENT_REPLACEMENT_REQUIRED", `Replacing this registration requires --replace-agent ${stableHash(existing)}`);
      }
      if (!existing && edit.replace_fingerprint) throw new BridgeError("AGENT_REPLACEMENT_CONFLICT", "The named replacement no longer exists");
      const updated = AgentProfileSchema.safeParse({ ...profile, agents: existing
        ? profile.agents.map((agent) => agent.agent_id === registration.agent_id ? registration : agent)
        : [...profile.agents, registration] });
      if (!updated.success) throw new BridgeError("PROFILE_INVALID", "Updated profile exceeds its declared contract");
      candidate = updated.data;
    }
    const encoded = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
    if (encoded.length > MAX_PROFILE_BYTES) throw new BridgeError("PROFILE_INVALID", "The formatted candidate exceeds the profile file budget");
    if (stableHash(value) === stableHash(candidate)) return { profile_path: canonical, changed: false, profile_fingerprint: fingerprint(original), restart_required: false };
    const backup = `${canonical}.passeur-backup-${randomUUID()}`;
    authority();
    const handle = await open(backup, "wx", 0o600);
    try { await handle.writeFile(original); await handle.sync(); } finally { await handle.close(); }
    if (!(await readProfileBytes(canonical)).equals(original)) throw new BridgeError("PROFILE_EDIT_CONFLICT", "An external writer changed the profile; its content and the backup were preserved");
    authority();
    await atomicJson(canonical, candidate, authority);
    const published = await readProfileBytes(canonical);
    if (!published.equals(encoded)) throw new BridgeError("PROFILE_EDIT_CONFLICT", "Published content changed; inspect the profile and backup before further mutation");
    return { profile_path: canonical, changed: true, profile_fingerprint: fingerprint(published), backup_path: backup, restart_required: true };
  } catch (error) { throw filesystemFailure(error, "profile.edit", canonical); }
  finally { if (!lost) await release(); }
}
