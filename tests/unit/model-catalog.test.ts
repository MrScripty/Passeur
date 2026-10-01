import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { discoverMuseModels, museModelsPage, MuseModelsRequestSchema } from "../../src/muse/models.js";
import { createMcpServer } from "../../src/mcp/server.js";
import type { PasseurFrontend } from "../../src/service/client.js";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const model = (id: string, isDefault = false) => ({ modelId: id, displayLabel: `Live ${id}`, description: "Current Muse catalog", isDefault, releaseDate: null, contextLimit: 200000, outputLimit: 32000, cost: { input: "1.25", cached: "0.125", output: "10", currency: "USD" } });
const catalog = (count = 3) => ({ source: "providerCatalog", providerId: "live-provider", profileId: null,
  models: Array.from({ length: count }, (_, i) => model(`live-${i}`, i === Math.min(1, count - 1))) });
async function fixture(config: object = { catalog: catalog() }) {
  const root = await mkdtemp(join(tmpdir(), "passeur-live-models-")); roots.push(root);
  const bin = join(root, "muse");
  await copyFile(resolve("tests/fixtures/model-catalog/host.mjs"), bin); await chmod(bin, 0o755);
  await writeFile(join(root, "catalog.json"), JSON.stringify(config));
  const trace = async () => (await readFile(join(root, "trace.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  return { root, bin, trace };
}
function assertClosed(events: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["trace"]>>) {
  for (const started of events.filter(e => e.event === "started")) {
    expect(started.args).toEqual(["serve", "--no-session-log"]);
    expect(() => process.kill(started.pid, 0)).toThrow();
  }
  expect(events.filter(e => e.method).map(e => e.method)).not.toContain("session/start");
  expect(events.filter(e => e.method).map(e => e.method)).not.toContain("turn/start");
}
describe("Live Muse model discovery", () => {
  it("queries the owned MSP host without a session and closes it", async () => {
    const f = await fixture(); const result = await discoverMuseModels({ museBin: f.bin });
    expect(result).toMatchObject({ source: "providerCatalog", provider_id: "live-provider", models: [{ model_id: "live-0", context_limit: 200000, output_limit: 32000, cost: { input: "1.25", cached: "0.125", output: "10", currency: "USD" } }, { model_id: "live-1" }, { model_id: "live-2" }] });
    const events = await f.trace(); assertClosed(events);
    expect(events.filter(e => e.method).map(e => e.method)).toEqual(["initialize", "initialized", "model/list"]);
    expect(events.find(e => e.method === "model/list").params).toEqual({});
  });
  it.each([
    { config: { error: "SECRET_TOKEN=do-not-expose", catalog: catalog() }, code: "MODEL_CATALOG_UNAVAILABLE" },
    { config: { catalog: { ...catalog(), models: [model("a"), model("a")] } }, code: "MODEL_CATALOG_INVALID" },
    { config: { catalog: catalog(1025) }, code: "MODEL_CATALOG_INVALID" },
    { config: { catalog: { ...catalog(), models: [{ ...model("a"), contextLimit: -1 }] } }, code: "MODEL_CATALOG_INVALID" },
  ])("closes and sanitizes failed native queries", async ({ config, code }) => {
    const f = await fixture(config);
    const failure = await discoverMuseModels({ museBin: f.bin }).catch(error => error);
    expect(failure).toMatchObject({ code }); expect(String(failure)).not.toContain("do-not-expose");
    assertClosed(await f.trace());
  });
  it.each(["initialize", "model/list"])("closes the host when cancelled during %s", async hang => {
    const f = await fixture({ catalog: catalog(), hang }); const controller = new AbortController();
    const operation = discoverMuseModels({ museBin: f.bin, signal: controller.signal });
    void operation.catch(() => undefined);
    await vi.waitFor(async () => expect((await f.trace()).some(e => e.method === hang)).toBe(true));
    controller.abort(); await expect(operation).rejects.toMatchObject({ code: "MODEL_CATALOG_CANCELLED" });
    assertClosed(await f.trace());
  });
  it("returns bounded live pages through public MCP without preparing the repository", async () => {
    const f = await fixture({ catalog: catalog(20) }); vi.stubEnv("PATH", `${f.root}:${process.env.PATH}`);
    const call = vi.fn(() => { throw Error("Repository service must not be called"); });
    const frontend = { identity: { package_version: "fixture" }, call, shutdown: async () => {} } as unknown as PasseurFrontend;
    const owner = createMcpServer(frontend), client = new Client({ name: "models-test", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([owner.mcp.connect(st), client.connect(ct)]);
      const tools = await client.listTools(); expect(tools.tools.find(t => t.name === "passeur_models")?.annotations?.readOnlyHint).toBe(true);
      const parse = (value: Awaited<ReturnType<Client["callTool"]>>) => JSON.parse((value.content as { text: string }[])[0]!.text);
      const first = parse(await client.callTool({ name: "passeur_models", arguments: { limit: 2 } }));
    expect(first).toMatchObject({ source: "providerCatalog", total: 20, next_offset: 2,
      models: [{ model_id: "live-0", is_default: false }, { model_id: "live-1", is_default: true }] });
      const second = parse(await client.callTool({ name: "passeur_models", arguments: { offset: 2, limit: 2, expected_sha256: first.catalog_sha256 } }));
      expect(second.models[0].model_id).toBe("live-2");
      const past = parse(await client.callTool({ name: "passeur_models", arguments: { offset: 21, expected_sha256: second.catalog_sha256 } }));
      expect(past.error.code).toBe("MODEL_CATALOG_OFFSET_INVALID");
      await writeFile(join(f.root, "catalog.json"), JSON.stringify({ catalog: { ...catalog(20), models: catalog(20).models.map(m => ({ ...m,
        displayLabel: "\n".repeat(512), description: "\n".repeat(1024), releaseDate: "\n".repeat(512),
        cost: { input: "1".repeat(512), cached: "2".repeat(512), output: "3".repeat(512), currency: "U".repeat(256) } })) } }));
      const full = await client.callTool({ name: "passeur_models", arguments: {} });
      expect(Buffer.byteLength(JSON.stringify(full))).toBeLessThan(24_576);
      expect(parse(full).models).toHaveLength(2);
      await writeFile(join(f.root, "catalog.json"), JSON.stringify({ error: "api_key=private-secret", catalog: catalog() }));
      const unavailable = await client.callTool({ name: "passeur_models", arguments: {} });
      expect(unavailable.isError).toBe(true); expect(parse(unavailable).error.code).toBe("MODEL_CATALOG_UNAVAILABLE");
      expect(JSON.stringify(unavailable)).not.toContain("private-secret");
      const invalid = await client.callTool({ name: "passeur_models", arguments: { limit: 1000 } }); expect(invalid.isError).toBe(true);
      await writeFile(join(f.root, "catalog.json"), JSON.stringify({ catalog: { ...catalog(), source: "configCatalog" } }));
      const changed = parse(await client.callTool({ name: "passeur_models", arguments: { offset: 2, expected_sha256: first.catalog_sha256 } }));
      expect(changed.error.code).toBe("MODEL_CATALOG_REFRESH_REQUIRED"); expect(call).not.toHaveBeenCalled(); assertClosed(await f.trace());
    } finally { await owner.shutdown(); await client.close(); await owner.mcp.close(); }
  });
  it("propagates MCP cancellation to the catalog host without touching tasks", async () => {
    const f = await fixture({ catalog: catalog(), hang: "model/list" }); vi.stubEnv("PATH", `${f.root}:${process.env.PATH}`);
    const call = vi.fn();
    const owner = createMcpServer({ identity: { package_version: "fixture" }, call, shutdown: async () => {} } as unknown as PasseurFrontend);
    const client = new Client({ name: "cancel-models-test", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair(); const controller = new AbortController();
    try {
      await Promise.all([owner.mcp.connect(st), client.connect(ct)]);
      const request = client.callTool({ name: "passeur_models", arguments: {} }, undefined, { signal: controller.signal });
      void request.catch(() => undefined);
      await vi.waitFor(async () => expect((await f.trace()).some(e => e.method === "model/list")).toBe(true));
      controller.abort(); await expect(request).rejects.toThrow();
      await vi.waitFor(async () => assertClosed(await f.trace())); expect(call).not.toHaveBeenCalled();
    } finally { await owner.shutdown(); await client.close(); await owner.mcp.close(); }
  });
  it("caps concurrent Muse hosts per frontend and reopens capacity after cancellation", async () => {
    const f = await fixture({ catalog: catalog(), hang: "model/list" }); vi.stubEnv("PATH", `${f.root}:${process.env.PATH}`);
    const owner = createMcpServer({ identity: { package_version: "fixture" }, shutdown: async () => {} } as unknown as PasseurFrontend);
    const client = new Client({ name: "bounded-models-test", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const controllers = [new AbortController(), new AbortController(), new AbortController()];
    const parse = (value: Awaited<ReturnType<Client["callTool"]>>) => JSON.parse((value.content as { text: string }[])[0]!.text);
    try {
      await Promise.all([owner.mcp.connect(st), client.connect(ct)]);
      const request = (index: number) => client.callTool({ name: "passeur_models", arguments: {} }, undefined, { signal: controllers[index]!.signal });
      const first = request(0), second = request(1);
      void first.catch(() => undefined); void second.catch(() => undefined);
      await vi.waitFor(async () => {
        const events = await f.trace();
        expect(events.filter(e => e.method === "model/list")).toHaveLength(2);
      });
      const saturated = await client.callTool({ name: "passeur_models", arguments: {} });
      expect(saturated.isError).toBe(true); expect(parse(saturated).error.code).toBe("MODEL_CATALOG_BUSY");
      expect((await f.trace()).filter(e => e.event === "started")).toHaveLength(2);
      controllers[0]!.abort(); controllers[1]!.abort();
      await expect(first).rejects.toThrow(); await expect(second).rejects.toThrow();
      await vi.waitFor(async () => assertClosed(await f.trace()));

      const replacement = request(2); void replacement.catch(() => undefined);
      await vi.waitFor(async () => expect((await f.trace()).filter(e => e.method === "model/list")).toHaveLength(3));
      controllers[2]!.abort(); await expect(replacement).rejects.toThrow();
      await vi.waitFor(async () => assertClosed(await f.trace()));
    } finally { controllers.forEach(controller => controller.abort()); await owner.shutdown(); await client.close(); await owner.mcp.close(); }
  });
  it("awaits catalog child retirement when the MCP frontend shuts down", async () => {
    const f = await fixture({ catalog: catalog(), hang: "model/list" }); vi.stubEnv("PATH", `${f.root}:${process.env.PATH}`);
    const owner = createMcpServer({ identity: { package_version: "fixture" }, shutdown: async () => {} } as unknown as PasseurFrontend);
    const client = new Client({ name: "close-models-test", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([owner.mcp.connect(st), client.connect(ct)]);
      const request = client.callTool({ name: "passeur_models", arguments: {} });
      void request.catch(() => undefined);
      await vi.waitFor(async () => expect((await f.trace()).some(e => e.method === "model/list")).toBe(true));
      await owner.shutdown(); assertClosed(await f.trace()); expect((await request).isError).toBe(true);
    } finally { await owner.shutdown(); await client.close(); await owner.mcp.close(); }
  });
  it("saves a live model selected through the interactive setup CLI", async () => {
    const f = await fixture(); const profile = join(f.root, "profile.json");
    const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
    const command = [process.execPath, "--import", "tsx", resolve("src/cli.ts"), "setup", "--project", process.cwd(), "--profile", profile, "--muse-bin", f.bin].map(quote).join(" ");
    const child = spawn("script", ["-qec", command, "/dev/null"], { stdio: "pipe" });
    let output = "", step = 0;
    const answers = [["Select model [2]:", "\n"], ["Enable implementation worktrees?", "n\n"],
      ["Have you verified", "y\n"], ["Install a named Codex", "n\n"]];
    child.stdout.on("data", chunk => {
      output += String(chunk);
      while (answers[step] && output.includes(answers[step]![0]!)) child.stdin.write(answers[step++]![1]!);
    });
    child.stderr.on("data", chunk => { output += String(chunk); });
    try {
      const code = await new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
      expect(code, output).toBe(0); expect(output).toContain("Live live-1 (live-1) [default]");
      const saved = JSON.parse(await readFile(profile, "utf8"));
      expect(saved.agents[0].options.model).toBe("live-1"); assertClosed(await f.trace());
    } finally { child.kill("SIGKILL"); }
  }, 10_000);
  it("requires a snapshot identity for continuations and accepts an empty native catalog", async () => {
    const f = await fixture({ catalog: catalog(0) }); const value = await discoverMuseModels({ museBin: f.bin });
    expect(museModelsPage(value, MuseModelsRequestSchema.parse({}))).toMatchObject({ models: [], total: 0, next_offset: null });
    expect(MuseModelsRequestSchema.safeParse({ offset: 1 }).success).toBe(false);
  });
});
