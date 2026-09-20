import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BatchRequestSchema, DelegateRequestSchema, FinalizeRequestSchema, ResultRequestSchema, type Profile } from "../contracts/index.js";
import { Coordinator } from "../core/coordinator.js";
import { DispositionManager } from "../core/disposition.js";
import { acquireRepositoryLease } from "../core/lease.js";
import { reconcileStoredTasks } from "../core/recovery.js";
import { errorInfo } from "../core/errors.js";
import { batchToolPayload, resultReceipt, textChunk, toolPayload } from "../core/result.js";
import { ApprovalQueue, nativeApprovalHandler } from "../approvals/native.js";
import { MuseSdkAdapter, type WorkerAdapter } from "../muse/adapter.js";
import { TaskStore } from "../store/task-store.js";

const instructions = `Use schema_version 2. Delegate independent work through delegate_to_muse or delegate_to_muse_batch. Calls stay pending; do not poll. Implementation assignments name an exact base_commit and local target_ref. Muse performs its scoped verification and ordinary commits using repository policy and hooks. Passeur does not test, review, merge, or automatically repair contributions. No per-worker Codex review is required. Codex decides broader verification and integration timing. Results identify committed work; request full evidence through muse_result only when useful. After external integration, use muse_finalize to account for owned resources, or explicitly retain/archive them. A batch has no shared feature or test meaning.`;
type Options = { project: string; projectId: string; profile: Profile; store: TaskStore; worker?: WorkerAdapter };
function failure(error: unknown) { const info = errorInfo(error); return toolPayload({ error: { code: info.code, message: info.message.slice(0, 2048) } }, true); }

/** Testable MCP composition; process lease and transport are owned by serve(). */
export function createMcpServer(options: Options) {
  const mcp = new McpServer({ name: "muse-bridge", version: "0.1.0" }, { capabilities: { logging: {} }, instructions });
  const coordinator = new Coordinator(options.project, options.projectId, options.profile, options.store, options.worker ?? new MuseSdkAdapter());
  const disposition = new DispositionManager(options.project, options.projectId, options.store, coordinator);
  const lifecycle = new AbortController(), approvals = new ApprovalQueue();
  const approve = nativeApprovalHandler(mcp.server, () => options.profile.task_timeout_ms, approvals);
  const missingElicitation = () => !mcp.server.getClientCapabilities()?.elicitation;
  mcp.registerTool("delegate_to_muse", {
    title: "Delegate an independent Muse task",
    description: "Await one scoped worker. Implementation delivers commits, not whole-system acceptance. Use schema_version 2; earlier requests must be upgraded.",
    inputSchema: DelegateRequestSchema,
  }, async (request, extra) => {
    try {
      if (missingElicitation()) return toolPayload({ error: { code: "ELICITATION_UNAVAILABLE", message: "Human approval elicitation is not advertised by this client" } }, true);
      const signal = AbortSignal.any([extra.signal, lifecycle.signal]);
      const result = await coordinator.delegate(request, { signal, approve });
      return toolPayload(resultReceipt(result, await options.store.readResource(result.task_id)), result.execution_status !== "completed");
    } catch (error) { return failure(error); }
  });
  mcp.registerTool("delegate_to_muse_batch", {
    title: "Delegate independent Muse tasks in parallel",
    description: "Submit one to eight independent assignments and await only these results. No grouping, testing, merging, or fail-fast cancellation of siblings is implied.",
    inputSchema: BatchRequestSchema,
  }, async (request, extra) => {
    try {
      if (missingElicitation()) return toolPayload({ error: { code: "ELICITATION_UNAVAILABLE", message: "Human approval elicitation is not advertised" } }, true);
      const settled = await coordinator.delegateBatch(request.assignments, { signal: AbortSignal.any([extra.signal, lifecycle.signal]), approve });
      const results = await Promise.all(settled.map(async (entry) => entry.result
        ? { request_key: entry.request_key, result: resultReceipt(entry.result, await options.store.readResource(entry.result.task_id)) }
        : { request_key: entry.request_key, error: { code: entry.error!.code, message: entry.error!.message.slice(0, 300) } }));
      return batchToolPayload(results, settled.some((entry) => !entry.result || entry.result.execution_status !== "completed"));
    } catch (error) { return failure(error); }
  });
  mcp.registerTool("muse_result", {
    title: "Read retained Muse evidence",
    description: "Read historical results or bounded artifacts plus current resource state. This never launches a worker and is not a polling mechanism.",
    inputSchema: ResultRequestSchema, annotations: { readOnlyHint: true },
  }, async (request) => {
    try {
      const record = await options.store.find(request.task_id ? { task_id: request.task_id } : { request_key: request.request_key! });
      if (!record) return toolPayload({ error: { code: "RESULT_NOT_FOUND", message: "No matching task" } }, true);
      const result = await options.store.readResult(record.task_id);
      if (!result) return toolPayload({ error: { code: "RESULT_NOT_READY", message: "No terminal result is available" } }, true);
      const resource = await options.store.readResource(record.task_id);
      const buffer = request.artifact_id
        ? await options.store.readArtifact(record.task_id, request.artifact_id, request.offset, request.limit)
        : await options.store.readSlice(record.task_id, request.section ?? "result", request.offset, request.limit);
      const encoding = request.encoding;
      let length = buffer.length;
      while (true) {
        const chunk = textChunk(buffer, length, encoding);
        try { return toolPayload({ task_id: record.task_id, resource: resource ?? { state: "legacy_unclassified" },
          ...(request.artifact_id ? { artifact_id: request.artifact_id } : { section: request.section ?? "result" }),
          offset: request.offset, bytes: chunk.bytes, next_offset: request.offset + chunk.bytes,
          eof: buffer.length === 0, encoding, content: chunk.content }); }
        catch (error) { if (length <= 1) throw error; length = Math.floor(length / 2); }
      }
    } catch (error) { return failure(error); }
  });
  mcp.registerTool("muse_finalize", {
    title: "Record resource dispositions",
    description: "Acknowledge external integration, retain, or explicitly archive stopped tasks; safely retire only owned resources. Does not merge or test code.",
    inputSchema: FinalizeRequestSchema,
  }, async (request, extra) => {
    const results = [];
    for (const operation of request.operations) {
      if (extra.signal.aborted || lifecycle.signal.aborted) break;
      try {
        const receipt = await disposition.finalize(operation);
        results.push({ task_id: operation.task_id, operation_key: operation.operation_key, state: receipt.state,
          disposition: operation.disposition, resource_state: receipt.resource.state,
          protection_ref: receipt.resource.protection_ref, protected_commit: receipt.resource.protected_commit });
      } catch (error) {
        const info = errorInfo(error);
        results.push({ task_id: operation.task_id, operation_key: operation.operation_key, error: { code: info.code, message: info.message.slice(0, 512) } });
      }
    }
    return batchToolPayload(results, results.some((entry) => "error" in entry));
  });
  let shutdown: Promise<void> | undefined;
  return { mcp, coordinator, disposition, shutdown: () => shutdown ??= (async () => {
    lifecycle.abort(new Error("MCP connection closed"));
    await coordinator.shutdown(new Error("MCP connection closed"));
  })() };
}
export async function serve(options: Options & { lockPath: string; legacyStoreRoots?: string[] }): Promise<void> {
  const release = await acquireRepositoryLease(options.lockPath);
  let owner: ReturnType<typeof createMcpServer> | undefined;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    try { await owner?.shutdown(); await owner?.mcp.close(); } finally { await release(); }
  })();
  try {
    await options.store.initialize();
    for (const root of options.legacyStoreRoots ?? []) await options.store.importLegacy(root);
    await reconcileStoredTasks(options.store, options.profile.model);
    owner = createMcpServer(options);
    const end = () => { void close().catch((error) => console.error(errorInfo(error).message)); };
    process.stdin.once("end", end);
    process.once("SIGINT", () => { void close().finally(() => { process.exitCode = 130; }); });
    process.once("SIGTERM", () => { void close().finally(() => { process.exitCode = 143; }); });
    owner.mcp.server.onclose = end;
    await owner.mcp.connect(new StdioServerTransport());
  } catch (error) { await close(); throw error; }
}
