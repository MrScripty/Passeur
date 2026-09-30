import { afterEach, expect, it, vi } from "vitest";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as TOML from "smol-toml";
import { decodeSharedProfile, MAX_PROFILE_BYTES } from "../../src/core/profile.js";
import { ensureInstallationDefaultProfile, MAX_MIGRATION_CANDIDATES, MAX_MIGRATION_DIRECTORY_ENTRIES } from "../../src/codex/profile-migration.js";
import { installCodexMcpRegistration, managedPinnedProfileSources, renderCodexMcpToml, type CodexMcpRegistration } from "../../src/codex/config.js";
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const profile = (workers = 2) => decodeSharedProfile({ schema_version: 3, execution: { max_workers: workers, implementation: { enabled: false } }, agents: [] });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "passeur-default-migration-")); roots.push(root);
  const config = join(root, "xdg"), projects = join(config, "muse-bridge", "projects"), target = join(config, "muse-bridge", "default-profile.json");
  await mkdir(projects, { recursive: true });
  const source = join(projects, "existing.json");
  const migrate = (authority = () => {}, pinnedProfiles: string[] = []) => ensureInstallationDefaultProfile({ pinnedProfiles, authority, environment: { XDG_CONFIG_HOME: config } });
  return { root, config, projects, target, source, migrate };
}
function registration(source?: string): CodexMcpRegistration {
  const base = { server_name: "passeur", command: process.execPath, env: {}, startup_timeout_sec: 10, tool_timeout_sec: 2100,
    enabled_tools: ["passeur_status"], state_root: "/state", build_id: "fixture", development: true };
  return source ? { ...base, args: ["/installed/cli.js", "serve", "--project", "/project", "--profile", source, "--state-root", "/state", "--expected-repository-id", "repository"], cwd: "/installed", project: "/project", profile: source, repository_id: "repository" }
    : { ...base, args: ["/installed/cli.js", "serve", "--state-root", "/state"] };
}
it("retains an existing valid default byte-for-byte without inspecting specialized repository sources", async () => {
  const f = await fixture(), bytes = JSON.stringify(profile(3), null, 4);
  await writeFile(f.target, bytes, { mode: 0o640 }); await writeFile(f.source, "invalid");
  await (await f.migrate())();
  expect(await readFile(f.target, "utf8")).toBe(bytes); expect((await lstat(f.target)).mode & 0o777).toBe(0o640);
});
it("groups decoded effective defaults and durably publishes one create-only 0600 copy", async () => {
  const f = await fixture(), bytes = JSON.stringify(profile());
  await writeFile(f.source, bytes); await writeFile(join(f.projects, "equivalent.json"), JSON.stringify({ schema_version: 3, execution: { implementation: { enabled: false } }, agents: [] }));
  await (await f.migrate())();
  expect(decodeSharedProfile(JSON.parse(await readFile(f.target, "utf8")))).toEqual(profile());
  expect((await lstat(f.target)).mode & 0o777).toBe(0o600);
  expect(await readFile(f.source, "utf8")).toBe(bytes); expect(await readdir(dirnameOf(f.target))).not.toContain(expect.stringMatching(/\.tmp$/));
});
function dirnameOf(path: string) { return resolve(path, ".."); }
it("refuses materially different groups and leaves registration and source profiles unchanged", async () => {
  const f = await fixture(); await writeFile(f.source, JSON.stringify(profile())); await writeFile(join(f.projects, "different.json"), JSON.stringify(profile(3)));
  vi.stubEnv("XDG_CONFIG_HOME", f.config);
  const config = join(f.root, "config.toml"), original = renderCodexMcpToml(registration(f.source)); await writeFile(config, original);
  const { registrationFingerprint } = await import("../../src/codex/config.js");
  const table = (TOML.parse(original).mcp_servers as TOML.TomlTable).passeur;
  await expect(installCodexMcpRegistration(registration(), { configPath: config, replaceBinding: registrationFingerprint(table), verify: async () => {} })).rejects.toMatchObject({ code: "PROFILE_DEFAULT_MIGRATION_REQUIRED" });
  expect(await readFile(config, "utf8")).toBe(original); await expect(lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" });
  expect(JSON.parse(await readFile(f.source, "utf8"))).toEqual(profile());
});
it("requires configuration with no candidate and explicitly gates old lifecycle semantics", async () => {
  const f = await fixture(); await expect(f.migrate()).rejects.toMatchObject({ code: "PROFILE_DEFAULT_CONFIGURATION_REQUIRED",
    context: { path: f.target, stage: "codex.profile.migration", next_action: expect.any(String) } });
  await writeFile(f.source, JSON.stringify({ schema_version: 2 }));
  await expect(f.migrate()).rejects.toMatchObject({ code: "PROFILE_MIGRATION_REQUIRED" });
  await expect(lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" });
});
it("does not invent a default path when no configuration root is available", async () => {
  const failure = await ensureInstallationDefaultProfile({ pinnedProfiles: [], authority: () => {}, environment: {} }).catch((error) => error);
  expect(failure).toMatchObject({ code: "PROFILE_DEFAULT_CONFIGURATION_REQUIRED" });
  expect(failure.context).toEqual({ stage: "codex.profile.migration", next_action: expect.any(String) });
});
it("does not promote a repository-specific implementation worktree root", async () => {
  const f = await fixture(), specialized = profile();
  specialized.execution.implementation = { enabled: true, worktree_root: join(f.root, "repository", "worktrees") };
  await writeFile(f.source, JSON.stringify(specialized));
  await expect(f.migrate()).rejects.toMatchObject({ code: "PROFILE_DEFAULT_MIGRATION_REQUIRED" });
  expect(JSON.parse(await readFile(f.source, "utf8"))).toEqual(specialized);
  await expect(lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" });
});
it("accepts only structurally owned pinned profile sources", async () => {
  const f = await fixture(), outside = join(f.root, "pinned.json"); await writeFile(outside, JSON.stringify(profile()));
  const owned = renderCodexMcpToml(registration(outside)); expect(managedPinnedProfileSources(owned)).toEqual([outside]);
  expect(managedPinnedProfileSources(owned.replace(/# passeur:(begin|end) passeur\n/g, ""))).toEqual([]);
  const forged = `description = '''\n# passeur:begin passeur\n# passeur:end passeur\n'''\n${owned.replace(/# passeur:(begin|end) passeur\n/g, "")}`;
  expect(managedPinnedProfileSources(forged)).toEqual([]);
  await (await f.migrate(() => {}, managedPinnedProfileSources(owned)))(); expect(JSON.parse(await readFile(f.target, "utf8"))).toEqual(profile());
});
it("enforces candidate, directory entry, path and byte limits", async () => {
  const f = await fixture();
  await expect(f.migrate(() => {}, Array.from({ length: MAX_MIGRATION_CANDIDATES + 1 }, (_, n) => join(f.root, `${n}.json`)))).rejects.toMatchObject({ code: "PROFILE_DEFAULT_MIGRATION_LIMIT" });
  await expect(f.migrate(() => {}, ["relative.json"])).rejects.toMatchObject({ code: "PROFILE_DEFAULT_PATH_UNSAFE" });
  await expect(f.migrate(() => {}, ["/" + "x".repeat(4096)])).rejects.toMatchObject({ code: "PROFILE_DEFAULT_PATH_UNSAFE" });
  await writeFile(f.source, Buffer.alloc(MAX_PROFILE_BYTES + 1)); await expect(f.migrate()).rejects.toMatchObject({ code: "PROFILE_INVALID" }); await rm(f.source);
  for (let n = 0; n <= MAX_MIGRATION_DIRECTORY_ENTRIES; n++) await writeFile(join(f.projects, `${n}.ignored`), "");
  await expect(f.migrate()).rejects.toMatchObject({ code: "PROFILE_DEFAULT_MIGRATION_LIMIT" });
});
it("rejects symlink profiles and directories", async () => {
  const f = await fixture(), outside = join(f.root, "outside.json"); await writeFile(outside, JSON.stringify(profile())); await symlink(outside, f.source);
  await expect(f.migrate()).rejects.toMatchObject({ code: "PROFILE_DEFAULT_PATH_UNSAFE" }); await rm(f.source);
  await rm(f.projects, { recursive: true }); await symlink(f.root, f.projects);
  await expect(f.migrate()).rejects.toMatchObject({ code: "PROFILE_DEFAULT_PATH_UNSAFE" });
});
it("revalidates source races before publication", async () => {
  const f = await fixture(); await writeFile(f.source, JSON.stringify(profile())); let calls = 0;
  await expect(f.migrate(() => { if (++calls === 3) writeFileSync(f.source, JSON.stringify(profile(3))); })).rejects.toMatchObject({ code: "PROFILE_DEFAULT_MIGRATION_CHANGED" });
  await expect(lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" }); expect(await readdir(dirnameOf(f.target))).not.toContain(expect.stringMatching(/\.tmp$/));
});
it("rejects a managed pinned profile that appears after inventory but before publication", async () => {
  const f = await fixture(), late = join(f.root, "late-pinned-profile.json"); await writeFile(f.source, JSON.stringify(profile())); let inspections = 0;
  await expect(ensureInstallationDefaultProfile({ pinnedProfiles: [late], authority: () => {}, environment: { XDG_CONFIG_HOME: f.config },
    validateInputs: async () => { if (++inspections === 1) await writeFile(late, JSON.stringify(profile(3))); },
  })).rejects.toMatchObject({ code: "PROFILE_DEFAULT_MIGRATION_CHANGED" });
  await expect(lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readdir(dirnameOf(f.target))).not.toContain(expect.stringMatching(/\.tmp$/));
});
it("preserves competing default publication and refuses a different raced effective configuration", async () => {
  const f = await fixture(); await writeFile(f.source, JSON.stringify(profile())); let calls = 0;
  await expect(f.migrate(() => { if (++calls === 3) writeFileSync(f.target, JSON.stringify(profile(3))); })).rejects.toMatchObject({ code: "PROFILE_DEFAULT_MIGRATION_CHANGED" });
  expect(JSON.parse(await readFile(f.target, "utf8"))).toEqual(profile(3));
});
it("retains the published default on writer interruption and TOML inspection rollback", async () => {
  const f = await fixture(); await writeFile(f.source, JSON.stringify(profile())); let calls = 0;
  await expect(f.migrate(() => { if (++calls === 4) throw new Error("lost lease after publication"); })).rejects.toThrow("lost lease");
  expect(JSON.parse(await readFile(f.target, "utf8"))).toEqual(profile());
  vi.stubEnv("XDG_CONFIG_HOME", f.config); const config = join(f.root, "config.toml"), original = 'model = "retained"\n'; await writeFile(config, original);
  await expect(installCodexMcpRegistration(registration(), { configPath: config, verify: async () => { throw new Error("inspection failed"); } })).rejects.toMatchObject({ code: "CODEX_INSPECTION_FAILED" });
  expect(await readFile(config, "utf8")).toBe(original); expect(JSON.parse(await readFile(f.target, "utf8"))).toEqual(profile());
});
it("cannot report registration success when its default changes during inspection", async () => {
  const f = await fixture(); await writeFile(f.source, JSON.stringify(profile())); vi.stubEnv("XDG_CONFIG_HOME", f.config);
  const config = join(f.root, "config.toml");
  await expect(installCodexMcpRegistration(registration(), { configPath: config, verify: async () => { await writeFile(f.target, JSON.stringify(profile(3))); } })).rejects.toMatchObject({ code: "CODEX_INSPECTION_FAILED" });
  await expect(lstat(config)).rejects.toMatchObject({ code: "ENOENT" }); expect(JSON.parse(await readFile(f.target, "utf8"))).toEqual(profile(3));
});
it("publishes a global registration only after its installation default is migrated", async () => {
  const f = await fixture(); await writeFile(f.source, JSON.stringify(profile())); vi.stubEnv("XDG_CONFIG_HOME", f.config);
  const config = join(f.root, "codex", "config.toml"), state = join(f.root, "state");
  const installed = await installCodexMcpRegistration({ ...registration(), state_root: state, args: [process.execPath, "serve", "--state-root", state] }, {
    configPath: config, verify: async () => {},
  });
  expect(installed.configuration).toBe("passed");
  expect(JSON.parse(await readFile(f.target, "utf8"))).toEqual(profile()); expect((await lstat(f.target)).mode & 0o777).toBe(0o600);
  const actual = TOML.parse(await readFile(config, "utf8")) as { mcp_servers: Record<string, { args: string[]; cwd?: string }> };
  const global = actual.mcp_servers.passeur; expect(global).toBeDefined();
  if (!global) throw new Error("Global registration was not published");
  expect(global.cwd).toBeUndefined(); expect(global.args).not.toContain("--profile");
}, 40_000);
