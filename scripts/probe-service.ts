/** Exact installed front-end/service path; no inference, personal configuration edit, or task stop. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parseArgs } from "node:util";
import { isAbsolute } from "node:path";
import { FrontendStatusSchema } from "../src/contracts/service.js";
import { CODEX_ENABLED_TOOLS } from "../src/codex/config.js";
const { values } = parseArgs({ options: { project: { type: "string" }, profile: { type: "string" }, runtime: { type: "string" }, "state-root": { type: "string" }, yes: { type: "boolean" } }, strict: true });
for (const key of ["project", "profile", "runtime", "state-root"] as const) if (!values[key] || !isAbsolute(values[key]!)) throw new Error(`--${key} requires an absolute path; --runtime is the installed CLI file`);
if (!values.yes) throw new Error("--yes authorizes repository preparation/import/reconciliation, not inference or shutdown of existing tasks");
function body(reply: unknown) {
  if (!reply || typeof reply !== "object") throw new Error("No response body");
  const result = reply as Record<string, unknown>;
  if (result.isError === true) throw new Error("Probe operation failed; inspect the service through its status and diagnostics");
  if (result.structuredContent !== undefined) return result.structuredContent;
  if (!Array.isArray(result.content)) throw new Error("No response body");
  const item: unknown = result.content[0];
  if (!item || typeof item !== "object" || !("text" in item) || typeof item.text !== "string") throw new Error("No text body");
  return JSON.parse(item.text) as unknown;
}
const clients = [new Client({ name: "passeur_service_probe_a", version: "1" }, { capabilities: {} }), new Client({ name: "passeur_service_probe_b", version: "1" }, { capabilities: {} })];
try {
  for (const client of clients) {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [values.runtime!, "serve", "--project", values.project!, "--profile", values.profile!, "--state-root", values["state-root"]!], stderr: "inherit" }));
    const names = (await client.listTools()).tools.map((item) => item.name);
    if (CODEX_ENABLED_TOOLS.some((name) => !names.includes(name))) throw new Error("The installed catalog does not match this probe");
  }
  const statuses = await Promise.all(clients.map(async (client) => FrontendStatusSchema.parse(body(await client.callTool({ name: "passeur_prepare", arguments: {} }, undefined, { timeout: 100000 })))));
  const first = statuses[0]!, second = statuses[1]!;
  if (first.frontend.mode !== "installed" || second.frontend.mode !== "installed" || first.service.state !== "connected" || second.service.state !== "connected" || first.service.status.generation !== second.service.status.generation) throw new Error("The two installed front ends did not observe the same service generation");
  await clients[0]!.close();
  const remaining = FrontendStatusSchema.parse(body(await clients[1]!.callTool({ name: "passeur_status", arguments: {} })));
  if (remaining.service.state !== "connected" || remaining.service.status.generation !== first.service.status.generation) throw new Error("The remaining client lost its shared service");
  console.log(JSON.stringify({ observed_at: new Date().toISOString(), statuses, remaining, inference: "not_run", actual_codex_attachment: "not_run" }, null, 2));
} finally { await Promise.allSettled(clients.map((client) => client.close())); }
