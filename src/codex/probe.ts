import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { RuntimeStatusSchema, type RuntimeStatus } from "../contracts/runtime.js";
import { BridgeError, diagnosticInfo, safeText, type ErrorInfo } from "../core/errors.js";
import type { CodexMcpRegistration } from "./config.js";

export type VerificationCheck = { status: "passed" | "failed" | "blocked" | "not_run"; scope: string; error?: ErrorInfo };
export type ProbeReport = {
  configuration: VerificationCheck; transport: VerificationCheck; readiness: VerificationCheck; installed_workflow: VerificationCheck;
  server_name: string; status?: RuntimeStatus; stderr: string;
};
const CALL_TIMEOUT_MS = 10_000;
const CLOSE_TIMEOUT_MS = 10_000;
const ENVIRONMENT_KEYS = ["PATH", "HOME", "USER", "LANG", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME"] as const;
export function launchEnvironment(overrides: Record<string, string>): Record<string, string> {
  return { ...Object.fromEntries(ENVIRONMENT_KEYS.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]])), ...overrides };
}
async function boundedClose(client: Client): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([client.close(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new BridgeError("PROBE_SHUTDOWN_UNCONFIRMED", "Probe transport did not confirm child shutdown within its budget", { stage: "probe.close" })), CLOSE_TIMEOUT_MS);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** Direct MCP evidence only. Actual Codex attachment and agent/account behavior are separate claims. */
export async function probeRegistration(registration: CodexMcpRegistration, prepare = false): Promise<ProbeReport> {
  const report: ProbeReport = {
    server_name: registration.server_name, stderr: "",
    configuration: { status: "not_run", scope: "Codex configuration inspection is a separate operation" },
    transport: { status: "not_run", scope: "Exact command initialization, complete tool catalog, status and build/binding identity" },
    readiness: { status: "not_run", scope: "Coordination preparation only; no inference or provider compatibility proof" },
    installed_workflow: { status: "not_run", scope: "Actual Codex attachment and authorized Muse workflow" },
  };
  const client = new Client({ name: "passeur_probe", version: "0.1.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: registration.command, args: registration.args,
    cwd: registration.cwd, env: launchEnvironment(registration.env), stderr: "pipe" });
  const observeStderr = (chunk: Buffer | string) => { report.stderr = safeText(report.stderr + chunk.toString(), 8192); };
  transport.stderr?.on("data", observeStderr);
  try {
    await client.connect(transport, { timeout: registration.startup_timeout_sec * 1000 });
    if (transport.stderr && !transport.stderr.listeners("data").includes(observeStderr)) transport.stderr.on("data", observeStderr);
    const names = new Set<string>(), cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {}, { timeout: CALL_TIMEOUT_MS });
      for (const tool of page.tools) {
        if (names.has(tool.name)) throw new BridgeError("PROBE_DUPLICATE_TOOL", "Server returned duplicate tool names");
        names.add(tool.name);
      }
      cursor = page.nextCursor;
      if (cursor) {
        if (cursors.has(cursor) || cursors.size >= 64) throw new BridgeError("PROBE_CATALOG_INVALID", "Tool catalog pagination did not terminate within its bound");
        cursors.add(cursor);
      }
    } while (cursor);
    for (const expected of registration.enabled_tools) if (!names.has(expected)) throw new BridgeError("PROBE_TOOLS_MISSING", `Server did not advertise ${expected}`);
    const reply = await client.callTool({ name: "passeur_status", arguments: {} }, undefined, { timeout: CALL_TIMEOUT_MS });
    if (reply.isError) throw new BridgeError("PROBE_STATUS_FAILED", "Status tool returned an execution error");
    report.status = RuntimeStatusSchema.parse(reply.structuredContent);
    const status = report.status;
    if (status.runtime.build_id !== registration.build_id || (!registration.development && status.runtime.mode !== "installed")
      || status.binding.project_input !== registration.project || status.binding.profile_path !== registration.profile
      || status.binding.state_root !== registration.state_root || status.binding.expected_repository_id !== registration.repository_id) {
      throw new BridgeError("PROBE_IDENTITY_MISMATCH", "Running artifact or configured binding differs from the exact registration", { stage: "probe.status" });
    }
    report.transport.status = "passed";
    if (prepare) {
      const ready = await client.callTool({ name: "passeur_prepare", arguments: {} }, undefined, { timeout: 100_000 });
      if (ready.isError) {
        report.readiness.status = "blocked";
        const current = await client.callTool({ name: "passeur_status", arguments: {} }, undefined, { timeout: CALL_TIMEOUT_MS });
        if (!current.isError) {
          report.status = RuntimeStatusSchema.parse(current.structuredContent);
          if (report.status.coordination.failure) report.readiness.error = report.status.coordination.failure;
        }
      } else {
        report.status = RuntimeStatusSchema.parse(ready.structuredContent);
        if (report.status.coordination.state !== "ready" || report.status.coordination.authority !== "held") throw new BridgeError("PROBE_READINESS_INVALID", "Preparation did not establish held coordination authority");
        report.readiness.status = "passed";
      }
    }
  } catch (error) {
    if (report.transport.status === "passed") { report.readiness.status = "failed"; report.readiness.error = diagnosticInfo(error); }
    else { report.transport.status = "failed"; report.transport.error = diagnosticInfo(error); }
  } finally {
    try { await boundedClose(client); }
    catch (error) { report.transport.status = "failed"; report.transport.error = diagnosticInfo(error); }
    transport.stderr?.removeListener("data", observeStderr);
  }
  return report;
}
