import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { loadAgentProfile, loadSharedProfile, normalizeProfile } from "../../src/core/profile.js";
import { editProfile } from "../../src/core/profile-edit.js";
import { stableHash } from "../../src/core/async.js";

const legacy = { schema_version: 1, muse_bin: "muse", model: "fixture-model",
  review: { disable_write: true, disable_shell: true, sandbox_network: "restricted" },
  implementation: { enabled: false, sandbox_network: "restricted" }, subscription: { provenance: "user_confirmed" } };
async function profileCase(run: (path: string, root: string, original: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "passeur-profile-migration-")), path = join(root, "profile.json");
  const original = `${JSON.stringify(legacy, null, 3)}\n`;
  try { await writeFile(path, original, { mode: 0o600 }); await run(path, root, original); }
  finally { await rm(root, { recursive: true, force: true }); }
}
it("legacy profile reads project to v2 without mutating bytes or creating backups", async () => {
  await profileCase(async (path, root, original) => {
    const profile = await loadAgentProfile(path);
    expect(profile).toMatchObject({ schema_version: 2, execution: { max_workers: 2 }, agents: [{ agent_id: "muse", adapter_id: "muse" }] });
    expect(await readFile(path, "utf8")).toBe(original); expect(await readdir(root)).toEqual(["profile.json"]);
  });
});
it("explicit migration retains exact original bytes and subsequent migration is a no-op", async () => {
  await profileCase(async (path, _root, original) => {
    const receipt = await editProfile(path, { kind: "migrate" });
    expect(receipt.changed).toBe(true); expect(receipt.restart_required).toBe(true);
    expect(await readFile(receipt.backup_path!, "utf8")).toBe(original);
    expect((await loadSharedProfile(path)).schema_version).toBe(3);
    expect((await loadSharedProfile(path)).execution).not.toHaveProperty("task_timeout_ms");
    expect(await editProfile(path, { kind: "migrate" })).toMatchObject({ changed: false, restart_required: false });
  });
});
it("configuration-only registration changes require exact replacement authority", async () => {
  await profileCase(async (path) => {
    await editProfile(path, { kind: "migrate" });
    const previous = (await loadSharedProfile(path)).agents[0]!;
    const replacement = { ...previous, description: "Updated approved registration" };
    const before = await readFile(path);
    await expect(editProfile(path, { kind: "configure-agent", registration: replacement })).rejects.toMatchObject({ code: "AGENT_REPLACEMENT_REQUIRED" });
    expect(await readFile(path)).toEqual(before);
    await editProfile(path, { kind: "configure-agent", registration: replacement, replace_fingerprint: stableHash(previous) });
    expect((await loadSharedProfile(path)).agents[0]?.description).toBe(replacement.description);
  });
});
it("unknown versions and symlink edit targets cannot be rewritten by migration", async () => {
  await profileCase(async (path, root) => {
    await writeFile(path, '{"schema_version":99}'); const before = await readFile(path);
    await expect(editProfile(path, { kind: "migrate" })).rejects.toMatchObject({ code: "PROFILE_VERSION_UNSUPPORTED" });
    expect(await readFile(path)).toEqual(before);
    const link = join(root, "alias.json"); await symlink(path, link);
    await expect(editProfile(link, { kind: "migrate" })).rejects.toMatchObject({ code: "PROFILE_EDIT_UNSUPPORTED" });
  });
});
it("profile v2 rejects duplicate registrations and separates unsupported versions", () => {
  const profile = normalizeProfile(legacy);
  expect(() => normalizeProfile({ ...profile, agents: [profile.agents[0], profile.agents[0]] })).toThrowError(expect.objectContaining({ code: "PROFILE_INVALID" }));
  expect(() => normalizeProfile({ schema_version: 3 })).toThrowError(expect.objectContaining({ code: "PROFILE_VERSION_UNSUPPORTED" }));
});
