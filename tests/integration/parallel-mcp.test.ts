import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it } from "vitest";
import { createMcpServer } from "../../src/mcp/server.js";
import { PasseurFrontend } from "../../src/service/client.js";
import { CODEX_ENABLED_TOOLS } from "../../src/codex/config.js";
it("the real MCP catalog exposes durable operations and rejects obsolete execution before service startup", async () => {
  const frontend = new PasseurFrontend({ project: "/unused-no-service-start" }, { package_version: "0.1.0", build_id: "fixture", mode: "development",
    node_version: process.version, node_executable: process.execPath, pid: process.pid, started_at: new Date().toISOString() }, "/unused-cli");
  const server = createMcpServer(frontend), client = new Client({ name: "catalog-fixture", version: "1" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.mcp.connect(st), client.connect(ct)]);
    expect((await client.listTools()).tools.map(t => t.name).sort()).toEqual([...CODEX_ENABLED_TOOLS].sort());
    const result = await client.callTool({ name: "passeur_delegate", arguments: { schema_version: 3, agent_id: "muse", request_key: "obsolete", mode: "review", objective: "No execution", context: "", acceptance_criteria: ["Reject old API"] } });
    expect(result.isError).toBe(true); expect(JSON.stringify(result)).toContain("TASK_API_UPGRADE_REQUIRED"); expect(frontend.status().service.state).toBe("not_checked");
    const permission = await client.callTool({ name: "passeur_input", arguments: { schema_version: 1, kind: "permission", task_id: crypto.randomUUID(), input_id: crypto.randomUUID(), operation_key: "forged", control_generation: 1, answer: "accept" } });
    expect(permission.isError).toBe(true); expect(frontend.status().service.state).toBe("not_checked");
  } finally { await client.close(); await server.shutdown(); await server.mcp.close(); }
});
