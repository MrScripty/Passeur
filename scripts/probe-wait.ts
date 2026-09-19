import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "muse-bridge-wait-probe", version: "0.1.0" });
server.registerTool("wait_probe", { description: "Delay one MCP response to verify same-call waiting", inputSchema: { delay_ms: z.number().int().min(1_000).max(600_000) } }, async ({ delay_ms }, extra) => {
  await new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, delay_ms); extra.signal.addEventListener("abort", () => { clearTimeout(timer); reject(extra.signal.reason); }, { once: true }); });
  return { content: [{ type: "text", text: JSON.stringify({ waited_ms: delay_ms, completed_at: new Date().toISOString() }) }] };
});
await server.connect(new StdioServerTransport());
