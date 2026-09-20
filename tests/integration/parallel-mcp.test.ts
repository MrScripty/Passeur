import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it } from "vitest";
import { createMcpServer } from "../../src/mcp/server.js";
import { RepositoryRuntime } from "../../src/core/repository-runtime.js";
import { fixture, completed, deferred } from "../fixtures/bridge.js";

it("dispatches a real MCP batch to overlapping independent workers and returns bounded receipts", async () => {
  const f = await fixture(), held = deferred(), started = deferred(); let active = 0, peak = 0;
  const runtime = new RepositoryRuntime({ project: f.root }, {
    package_version: "0.1.0", build_id: "test", mode: "development", node_version: process.version,
    node_executable: process.execPath, pid: process.pid, started_at: new Date().toISOString(),
  }, {
    resolveBinding: async () => ({ project: f.root, repositoryId: "project", commonDir: f.root,
      stateRoot: f.store.root, storeRoot: f.store.root, profilePath: `${f.root}/profile.json` }),
    legacyRoots: async () => [], profile: async () => f.profile,
    worker: { run: async () => { peak = Math.max(peak, ++active); if (active === 2) started.resolve(); await held.promise; active--; return completed(); } },
  });
  const owner = createMcpServer(runtime);
  const client = new Client({ name: "passeur-fixture", version: "1.0.0" }, { capabilities: { elicitation: {} } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([owner.mcp.connect(serverTransport), client.connect(clientTransport)]);
    const response = client.callTool({ name: "delegate_to_muse_batch", arguments: { schema_version: 2, assignments: [f.request("a"), f.request("b")] } });
    await started.promise; expect(peak).toBe(2); held.resolve();
    const result = await response;
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(24_576);
    const blocks = result.content as Array<{ type: string; text?: string }>;
    const payload = JSON.parse(blocks.find((block) => block.type === "text")!.text!) as { results: Array<{ request_key: string }> };
    expect(payload.results.map((entry) => entry.request_key)).toEqual(["a", "b"]);
    expect(result.isError).not.toBe(true);
  } finally { held.resolve(); await owner.shutdown(); await client.close(); await owner.mcp.close(); await f.dispose(); }
}, 10_000);
