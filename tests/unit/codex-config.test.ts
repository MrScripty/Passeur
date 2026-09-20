import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installCodexMcpRegistration, mergeCodexMcpToml, renderCodexMcpToml, type CodexMcpRegistration } from "../../src/codex/config.js";

const registration: CodexMcpRegistration = {
  command: "/path with spaces/node",
  args: ["/repo/dist/src/cli.js", "serve", "--project", "/repo"],
  startup_timeout_sec: 10,
  tool_timeout_sec: 2100,
  enabled_tools: ["delegate_to_muse", "delegate_to_muse_batch", "muse_result", "muse_finalize"],
};
const temporaryRoots: string[] = [];
afterEach(async () => { await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("Codex MCP registration", () => {
  it("renders a copy-safe TOML table", () => {
    expect(renderCodexMcpToml(registration)).toContain('command = "/path with spaces/node"');
    expect(renderCodexMcpToml({ ...registration, args: ['quote"inside'] })).toContain('args = ["quote\\\"inside"]');
  });

  it("appends a new server without changing existing settings", () => {
    const original = 'model = "gpt"\n\n[mcp_servers.existing]\ncommand = "existing"\n';
    const merged = mergeCodexMcpToml(original, registration);
    expect(merged).toContain(original);
    expect(merged).toContain("[mcp_servers.muse_bridge]");
  });

  it("updates only the existing Passeur table", () => {
    const original = 'model = "gpt"\n\n[mcp_servers.muse_bridge]\ncommand = "old"\ntool_timeout_sec = 1\n\n[[skills.config]]\npath = "/keep/SKILL.md"\n\n[mcp_servers.keep]\ncommand = "keep"\n';
    const merged = mergeCodexMcpToml(original, registration);
    expect(merged).not.toContain('command = "old"');
    expect(merged).toContain('[[skills.config]]\npath = "/keep/SKILL.md"');
    expect(merged).toContain('[mcp_servers.keep]\ncommand = "keep"');
    expect(merged.match(/\[mcp_servers\.muse_bridge\]/g)).toHaveLength(1);
  });

  it("refuses to discard nested settings owned by an existing server", () => {
    const original = '[mcp_servers.muse_bridge]\ncommand = "old"\n[mcp_servers.muse_bridge.env]\nTOKEN = "keep"\n';
    expect(() => mergeCodexMcpToml(original, registration)).toThrow(/nested settings/);
  });

  it("backs up and verifies an atomic install", async () => {
    const root = await mkdtemp(join(tmpdir(), "passeur-codex-config-")); temporaryRoots.push(root);
    const path = join(root, "config.toml"), original = 'model = "gpt"\n';
    await writeFile(path, original);
    let verified = false;
    const result = await installCodexMcpRegistration(registration, { configPath: path, verify: async () => { verified = true; } });
    expect(verified).toBe(true);
    expect(result.backupPath && await readFile(result.backupPath, "utf8")).toBe(original);
    expect(await readFile(path, "utf8")).toContain("[mcp_servers.muse_bridge]");
  });

  it("restores the previous file when Codex verification fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "passeur-codex-config-")); temporaryRoots.push(root);
    const path = join(root, "config.toml"), original = 'model = "gpt"\n';
    await writeFile(path, original);
    await expect(installCodexMcpRegistration(registration, { configPath: path, verify: async () => { throw new Error("invalid TOML"); } })).rejects.toThrow(/restored/);
    expect(await readFile(path, "utf8")).toBe(original);
  });
});
