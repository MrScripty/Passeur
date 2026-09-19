import lockfile from "proper-lockfile";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DelegateRequestSchema, ResultRequestSchema, type DelegateResult, type Profile } from "../contracts/index.js";
import { Coordinator } from "../core/coordinator.js";
import { BridgeError } from "../core/errors.js";
import { nativeApprovalHandler } from "../approvals/native.js";
import { MuseSdkAdapter, type WorkerAdapter } from "../muse/adapter.js";
import { TaskStore } from "../store/task-store.js";

const instructions = `Use delegate_to_muse for bounded assignments with a clear scope and acceptance criteria. Supply self-contained context and a stable request_key. The call stays pending until the task ends; await that result. Human permissions are handled through the bridge's approval route. Treat worker claims as evidence to review, not as acceptance. Use muse_result to recover or inspect retained results, not for periodic status checks. Review and integrate accepted changes yourself.`;

function toolResult(result: DelegateResult, isError = result.execution_status !== "completed") {
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result as unknown as Record<string, unknown>, isError };
}
function operationalError(code: string, message: string) { return { content: [{ type: "text" as const, text: JSON.stringify({ error: { code, message } }) }], isError: true }; }

export async function serve(options: { project: string; projectId: string; profile: Profile; store: TaskStore; lockPath: string; worker?: WorkerAdapter }): Promise<void> {
  await options.store.initialize();
  let release: (() => Promise<void>) | undefined;
  try { release = await lockfile.lock(options.lockPath, { realpath: false, stale: 0, retries: 0 }); }
  catch { throw new BridgeError("PROJECT_IN_USE", "Another bridge owns this project"); }
  for (const record of await options.store.list()) {
    const state = await options.store.readState(record.task_id);
    if (state.phase === "terminal" || await options.store.readResult(record.task_id)) continue;
    const interrupted: DelegateResult = {
      schema_version: 1, task_id: record.task_id, request_key: record.request.request_key,
      execution_status: "interrupted", worker_stop: state.phase === "accepted" ? "not_started" : "unconfirmed", worker_assessment: "unknown",
      summary: "The bridge restarted before this task recorded a terminal result. The assignment was not replayed.",
      blockers: ["Reconcile the previous worker and workspace before creating a new assignment."],
      error: { code: "INTERRUPTED_ON_RESTART", message: `Recovered incomplete task from phase ${state.phase}` }, questions: [],
      model: { requested: options.profile.model }, workspace: { kind: record.request.mode === "review" ? "source_read_only" : "task_worktree", ...(record.request.base_commit ? { base_commit: record.request.base_commit } : {}), stale: true },
      changed_files: [], checks: [], artifacts: [], output_truncated: false,
    };
    await options.store.writeResult(record.task_id, interrupted);
    await options.store.writeState(record.task_id, { phase: "terminal", outcome: "interrupted", updated_at: new Date().toISOString(), reason: "INTERRUPTED_ON_RESTART" });
  }
  const mcp = new McpServer({ name: "muse-bridge", version: "0.1.0" }, { capabilities: { logging: {} }, instructions });
  const coordinator = new Coordinator(options.project, options.projectId, options.profile, options.store, options.worker ?? new MuseSdkAdapter());
  const lifecycle = new AbortController();

  mcp.registerTool("delegate_to_muse", {
    title: "Delegate a bounded assignment to Muse",
    description: "Run one Muse assignment and await its terminal result. Do not poll while this call is pending.",
    inputSchema: DelegateRequestSchema,
  }, async (request, extra) => {
    try {
      const capabilities = mcp.server.getClientCapabilities();
      if (!capabilities?.elicitation) return operationalError("ELICITATION_UNAVAILABLE", "The connected Codex client did not advertise MCP elicitation; refusing to start a task that could hide an approval prompt");
      const deadline = Date.now() + options.profile.task_timeout_ms;
      const progress = extra._meta?.progressToken === undefined ? {} : { progress: async (message: string) => { await extra.sendNotification({ method: "notifications/progress", params: { progressToken: extra._meta!.progressToken!, progress: 0, message } }); } };
      const result = await coordinator.delegate(request, {
        signal: AbortSignal.any([extra.signal, lifecycle.signal]),
        approve: nativeApprovalHandler(mcp.server, () => Math.max(1, deadline - Date.now())),
        ...progress,
      });
      return toolResult(result);
    } catch (error) { return error instanceof BridgeError ? operationalError(error.code, error.message) : operationalError("INTERNAL_ERROR", error instanceof Error ? error.message : String(error)); }
  });

  mcp.registerTool("muse_result", {
    title: "Read a retained Muse result",
    description: "Recover a terminal result or a bounded artifact section. This never starts work and is not a polling tool.",
    inputSchema: ResultRequestSchema,
    annotations: { readOnlyHint: true },
  }, async (request) => {
    try {
      const record = await options.store.find(request.task_id ? { task_id: request.task_id } : { request_key: request.request_key! });
      if (!record) return operationalError("RESULT_NOT_FOUND", "No task matches the supplied identifier");
      const state = await options.store.readState(record.task_id);
      if (state.phase !== "terminal") return operationalError("RESULT_NOT_READY", "The task has no terminal result yet");
      const text = await options.store.readSection(record.task_id, request.section, request.offset, request.limit);
      return { content: [{ type: "text" as const, text }], structuredContent: { task_id: record.task_id, section: request.section, offset: request.offset, bytes: Buffer.byteLength(text), content: text } };
    } catch (error) { return operationalError("RESULT_READ_FAILED", error instanceof Error ? error.message : String(error)); }
  });

  const transport = new StdioServerTransport();
  const shutdown = async () => { lifecycle.abort(new Error("MCP transport closed")); try { await mcp.close(); } finally { await release?.(); } };
  process.stdin.once("end", () => { void shutdown(); });
  process.once("SIGINT", () => { void shutdown().finally(() => process.exit(130)); });
  process.once("SIGTERM", () => { void shutdown().finally(() => process.exit(143)); });
  try { await mcp.connect(transport); } catch (error) { await release(); throw error; }
}
