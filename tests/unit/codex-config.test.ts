import { expect, it } from "vitest";
import * as TOML from "smol-toml";
import { mergeCodexMcpToml, renderCodexMcpToml, registrationFingerprint, type CodexMcpRegistration } from "../../src/codex/config.js";
function registration(name = "passeur_pumas"): CodexMcpRegistration {
  return { server_name: name, command: "/node", args: ["/installed/dist/src/cli.js", "serve", "--project", "/project", "--profile", "/profile.json", "--state-root", "/state", "--expected-repository-id", "repository"],
    cwd: "/installed", env: {}, startup_timeout_sec: 10, tool_timeout_sec: 2100, enabled_tools: ["passeur_status", "passeur_prepare"],
    project: "/project", profile: "/profile.json", state_root: "/state", repository_id: "repository", build_id: "build", development: false };
}
it("renders both diagnostics and safely encodes spaces and quotes", () => {
  const r = registration(); r.args[0] = '/installed "with spaces"/cli.js';
  const parsed = TOML.parse(renderCodexMcpToml(r));
  expect(parsed.mcp_servers).toMatchObject({ passeur_pumas: { args: r.args, enabled_tools: r.enabled_tools } });
});
it("normal updates preserve unrelated bytes and allow separately named projects", () => {
  const prefix = '# keep this comment\nmodel = "chosen"\n';
  const first = mergeCodexMcpToml(prefix, registration());
  const r = registration("passeur_tuldok"); r.args[r.args.indexOf("--project") + 1] = "/other"; r.project = "/other";
  const both = mergeCodexMcpToml(first, r);
  expect(both.startsWith(prefix)).toBe(true);
  const changed = registration(); changed.tool_timeout_sec = 2200;
  const updated = mergeCodexMcpToml(both, changed);
  expect(updated.startsWith(prefix)).toBe(true);
  expect(TOML.parse(updated).mcp_servers).toMatchObject({ passeur_pumas: { tool_timeout_sec: 2200 }, passeur_tuldok: { args: r.args } });
  expect(mergeCodexMcpToml(updated, changed)).toBe(updated);
});
it("rejects name collision until the exact old binding is authorized", () => {
  const source = '[mcp_servers.passeur_pumas]\ncommand = "other"\n';
  expect(() => mergeCodexMcpToml(source, registration())).toThrowError(expect.objectContaining({ code: "REGISTRATION_COLLISION" }));
  const parsed = TOML.parse(source).mcp_servers as TOML.TomlTable;
  const fingerprint = registrationFingerprint(parsed.passeur_pumas);
  expect(() => mergeCodexMcpToml(source, registration(), { replaceBinding: fingerprint })).toThrowError(expect.objectContaining({ code: "REGISTRATION_UNMANAGED" }));
  expect(TOML.parse(mergeCodexMcpToml(source, registration(), { replaceBinding: fingerprint, adoptUnmanaged: true })).mcp_servers).toMatchObject({ passeur_pumas: { command: "/node" } });
});
it("rejects a known competing state namespace for the same repository", () => {
  const source = renderCodexMcpToml(registration()); const r = registration("passeur_second");
  r.state_root = "/another"; r.args[r.args.indexOf("--state-root") + 1] = r.state_root;
  expect(() => mergeCodexMcpToml(source, r)).toThrowError(expect.objectContaining({ code: "STATE_BINDING_CONFLICT" }));
});
it("marker-like lines inside multiline strings cannot own a configuration edit", () => {
  const source = 'description = """\n# passeur:begin passeur_pumas\n# passeur:end passeur_pumas\n"""\n';
  expect(() => mergeCodexMcpToml(source, registration())).toThrow();
  expect(TOML.parse(source).description).toContain("passeur:begin");
});
it("invalid names and credential environment fields are rejected before serialization", () => {
  expect(() => renderCodexMcpToml(registration('bad.name'))).toThrowError(expect.objectContaining({ code: "SERVER_NAME_INVALID" }));
  const r = registration(); r.env = { API_TOKEN: "secret" };
  expect(() => renderCodexMcpToml(r)).toThrowError(expect.objectContaining({ code: "REGISTRATION_ENV_INVALID" }));
});
it("unrelated datetime, integer and array settings preserve TOML semantics", () => {
  const source = 'when = 2024-09-20T10:00:00Z\nlarge = 9223372036854775807\nvalues = ["a", "b"]\n';
  const parsed = TOML.parse(source, { integersAsBigInt: "asNeeded" }), updated = TOML.parse(mergeCodexMcpToml(source, registration()), { integersAsBigInt: "asNeeded" });
  expect(updated.when).toEqual(parsed.when); expect(updated.large).toEqual(parsed.large); expect(updated.values).toEqual(parsed.values);
});

it("configuration presence cannot verify a different resolved command or tool allowlist", async () => {
  const { verifyInspection } = await import("../../src/codex/config.js");
  const r = registration();
  const response = { name: r.server_name, enabled: true, disabled_reason: null,
    transport: { type: "stdio", command: r.command, args: r.args, cwd: r.cwd, env: null, env_vars: [] },
    enabled_tools: [...r.enabled_tools], disabled_tools: null, startup_timeout_sec: 10, tool_timeout_sec: 2100 };
  expect(() => verifyInspection(response, r)).not.toThrow();
  expect(() => verifyInspection({ ...response, transport: { ...response.transport, command: "/other" } }, r)).toThrowError(expect.objectContaining({ code: "CODEX_REGISTRATION_MISMATCH" }));
  expect(() => verifyInspection({ ...response, enabled_tools: ["delegate_to_muse"] }, r)).toThrowError(expect.objectContaining({ code: "CODEX_REGISTRATION_MISMATCH" }));
  expect(() => verifyInspection({ name: r.server_name }, r)).toThrowError(expect.objectContaining({ code: "CODEX_INSPECTION_UNSUPPORTED" }));
});

it("rolls back only its unchanged candidate when configuration inspection fails", async () => {
  const { mkdtemp, writeFile, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const { installCodexMcpRegistration } = await import("../../src/codex/config.js");
  const root = await mkdtemp(join(tmpdir(), "passeur-config-")), path = join(root, "config.toml");
  const original = '# retained comment\nmodel = "chosen"\n';
  try {
    await writeFile(path, original, { mode: 0o600 });
    await expect(installCodexMcpRegistration(registration(), { configPath: path, verify: async () => { throw new Error("inspection failed"); } })).rejects.toMatchObject({ code: "CODEX_INSPECTION_FAILED" });
    expect(await readFile(path, "utf8")).toBe(original);
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("preserves a newer external edit instead of restoring an old whole-file backup", async () => {
  const { mkdtemp, writeFile, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const { installCodexMcpRegistration } = await import("../../src/codex/config.js");
  const root = await mkdtemp(join(tmpdir(), "passeur-config-")), path = join(root, "config.toml");
  try {
    await writeFile(path, 'model = "before"\n');
    const newer = 'model = "external-edit"\n';
    await expect(installCodexMcpRegistration(registration(), { configPath: path, verify: async () => {
      await writeFile(path, newer); throw new Error("inspection failed after external write");
    } })).rejects.toMatchObject({ code: "CONFIG_ROLLBACK_CONFLICT" });
    expect(await readFile(path, "utf8")).toBe(newer);
  } finally { await rm(root, { recursive: true, force: true }); }
});
