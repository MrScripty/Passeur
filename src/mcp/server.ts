import { AssignmentSchema, AgentBatchSchema, AgentCatalogSchema, AgentCatalogRequestSchema } from "../contracts/agents.js";
import { errorInfo } from "../core/errors.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BatchRequestSchema, DelegateRequestSchema, FinalizeRequestSchema, ResultRequestSchema } from "../contracts/index.js";
import type { ResultRequest } from "../contracts/types.js";
import { PrepareRequestSchema, RuntimeFailureSchema, RuntimeStatusSchema, StatusRequestSchema } from "../contracts/runtime.js";
import { RepositoryRuntime } from "../core/repository-runtime.js";
import { diagnosticInfo } from "../core/errors.js";
import { batchToolPayload, resultReceipt, textChunk, toolPayload } from "../core/result.js";
import { ApprovalQueue, nativeApprovalHandler } from "../approvals/native.js";

const instructions = `Use schema_version 3 and an explicit agent_id for neutral tasks. Discover configured agents through passeur_agents. The Muse compatibility tools retain version 2. Inspect passeur_status when diagnosis is needed; passeur_prepare establishes repository coordination without inference. Discovery and diagnostics do not acquire authority. Delegate independent assignments through passeur_delegate or passeur_delegate_batch; calls wait, so do not poll. Implementation names an exact base_commit and local target_ref. Workers perform scoped verification and ordinary commits using repository policy and hooks. Passeur does not test, review, merge or repair contributions. The calling agent owns broader acceptance and integration. Read retained evidence through passeur_result when useful and account for resources through passeur_finalize after integration or explicit retention/archive. A batch has no shared feature or test meaning.`;
function failure(error: unknown) {
  return toolPayload({ error: RuntimeFailureSchema.parse(diagnosticInfo(error)) }, true);
}

/** Pure composition. Project/profile/state/provider work happens only in runtime operations. */
export function createMcpServer(runtime: RepositoryRuntime) {
  const identity = runtime.status().runtime;
  const mcp = new McpServer({ name: "passeur", version: identity.package_version }, { capabilities: { logging: {} }, instructions });
  const lifecycle = new AbortController();
  const approvals = new ApprovalQueue();
  // The task's signal supplies its absolute deadline; this is only the elicitation request ceiling.
  const approve = nativeApprovalHandler(mcp.server, () => runtime.approvalTimeoutMs(), approvals);
  const context = (signal: AbortSignal) => {
    runtime.observeApproval(Boolean(mcp.server.getClientCapabilities()?.elicitation));
    return { signal: AbortSignal.any([signal, lifecycle.signal]), approve };
  };
  mcp.registerTool("passeur_status", {
    title: "Inspect Passeur runtime and readiness", description: "Read running build, configured binding and observed blockers. Never acquires a lease, repairs state or launches a worker.",
    inputSchema: StatusRequestSchema, annotations: { readOnlyHint: true },
  }, async () => {
    try {
      runtime.observeApproval(Boolean(mcp.server.getClientCapabilities()?.elicitation));
      return toolPayload(RuntimeStatusSchema.parse(runtime.status()));
    } catch (error) { return failure(error); }
  });
  mcp.registerTool("passeur_prepare", {
    title: "Prepare repository coordination", description: "Acquire repository coordination and reconcile supported retained state. No inference. Successful readiness retains the lease until this connection closes.",
    inputSchema: PrepareRequestSchema,
  }, async (_request, extra) => {
    try { return toolPayload(RuntimeStatusSchema.parse(await runtime.prepare(AbortSignal.any([extra.signal, lifecycle.signal])))); }
    catch (error) { return failure(error); }
  });
  mcp.registerTool("passeur_agents", {
    title: "List registered agents", description: "Read configured agents and configuration limitations without acquiring coordination or probing a vendor. Runtime readiness is not established by this observation.",
    inputSchema: AgentCatalogRequestSchema, annotations: { readOnlyHint: true },
  }, async (request) => {
    try { return toolPayload(AgentCatalogSchema.parse(await runtime.agents(request.offset, request.limit))); }
    catch (error) { return failure(error); }
  });
  mcp.registerTool("passeur_delegate", {
    title: "Delegate to a registered agent", description: "Await one schema-version-3 assignment selected by agent_id. No automatic provider fallback, testing or integration.",
    inputSchema: AssignmentSchema,
  }, async (request, extra) => {
    try {
      const result = await runtime.delegate(request, context(extra.signal));
      return toolPayload(resultReceipt(result, await runtime.resource(result.task_id)), result.execution_status !== "completed");
    } catch (error) { return failure(error); }
  });
  mcp.registerTool("passeur_delegate_batch", {
    title: "Delegate independent registered-agent tasks", description: "Await up to eight independent v3 assignments; each chooses an agent. Sibling failures do not imply cancellation.",
    inputSchema: AgentBatchSchema,
  }, async (request, extra) => {
    try {
      const settled = await runtime.delegateBatch(request.assignments, context(extra.signal));
      const results = await Promise.all(settled.map(async (entry) => entry.result
        ? { request_key: entry.request_key, result: resultReceipt(entry.result, await runtime.resource(entry.result.task_id)) }
        : { request_key: entry.request_key, error: entry.error }));
      return batchToolPayload(results, settled.some((entry) => !entry.result || entry.result.execution_status !== "completed"), 3);
    } catch (error) { return failure(error); }
  });
  mcp.registerTool("delegate_to_muse", {
    title: "Delegate an independent Muse task", description: "Await one scoped worker. Implementation delivers commits, not whole-system acceptance. Use schema_version 2.",
    inputSchema: DelegateRequestSchema,
  }, async (request, extra) => {
    try {
      const result = await runtime.delegateMuse(request, context(extra.signal));
      return toolPayload(resultReceipt(result, await runtime.resource(result.task_id)), result.execution_status !== "completed");
    } catch (error) { return failure(error); }
  });
  mcp.registerTool("delegate_to_muse_batch", {
    title: "Delegate independent Muse tasks in parallel", description: "Submit one to eight independent assignments and await only their results. No shared acceptance or fail-fast cancellation is implied.",
    inputSchema: BatchRequestSchema,
  }, async (request, extra) => {
    try {
      const run = context(extra.signal);
      const settled = await Promise.all(request.assignments.map(async (assignment) => {
        try { return { request_key: assignment.request_key, result: await runtime.delegateMuse(assignment, run) }; }
        catch (error) { return { request_key: assignment.request_key, error: errorInfo(error) }; }
      }));
      const results = await Promise.all(settled.map(async (entry) => entry.result
        ? { request_key: entry.request_key, result: resultReceipt(entry.result, await runtime.resource(entry.result.task_id)) }
        : { request_key: entry.request_key, error: entry.error }));
      return batchToolPayload(results, settled.some((entry) => !entry.result || entry.result.execution_status !== "completed"));
    } catch (error) { return failure(error); }
  });
  for (const tool of ["passeur_result", "muse_result"] as const) mcp.registerTool(tool, {
    title: "Read retained agent evidence", description: "Read bounded historical evidence without launching a worker, acquiring a lease, or migrating state. Resource records are current observations, not a transactional snapshot.",
    inputSchema: ResultRequestSchema, annotations: { readOnlyHint: true },
  }, async (request) => {
    try {
      const retainedRequest: ResultRequest = {
        encoding: request.encoding, offset: request.offset, limit: request.limit,
        ...(request.task_id !== undefined ? { task_id: request.task_id } : {}),
        ...(request.request_key !== undefined ? { request_key: request.request_key } : {}),
        ...(request.section !== undefined ? { section: request.section } : {}),
        ...(request.artifact_id !== undefined ? { artifact_id: request.artifact_id } : {}),
      };
      const { task_id, resource, buffer } = await runtime.retained(retainedRequest);
      let length = buffer.length;
      while (true) {
        const chunk = textChunk(buffer, length, request.encoding);
        try { return toolPayload({ task_id, resource: resource ?? { state: "legacy_unclassified" },
          ...(request.artifact_id ? { artifact_id: request.artifact_id } : { section: request.section ?? "result" }),
          offset: request.offset, bytes: chunk.bytes, next_offset: request.offset + chunk.bytes,
          eof: buffer.length === 0, encoding: request.encoding, content: chunk.content }); }
        catch (error) { if (length <= 1) throw error; length = Math.floor(length / 2); }
      }
    } catch (error) { return failure(error); }
  });
  for (const tool of ["passeur_finalize", "muse_finalize"] as const) mcp.registerTool(tool, {
    title: "Record resource dispositions", description: "Account for external integration, explicit retention or archive; safely retire only owned stopped resources. No inference, tests or merge.",
    inputSchema: FinalizeRequestSchema,
  }, async (request, extra) => {
    try {
      const settled = await runtime.finalize(request.operations, AbortSignal.any([extra.signal, lifecycle.signal]));
      const results = settled.map((entry) => entry.receipt ? {
        task_id: entry.task_id, operation_key: entry.operation_key, state: entry.receipt.state,
        disposition: entry.receipt.operation.disposition, resource_state: entry.receipt.resource.state,
        protection_ref: entry.receipt.resource.protection_ref, protected_commit: entry.receipt.resource.protected_commit,
      } : { task_id: entry.task_id, operation_key: entry.operation_key, error: entry.error });
      return batchToolPayload(results, settled.some((entry) => entry.error));
    } catch (error) { return failure(error); }
  });
  let shutdown: Promise<void> | undefined;
  return { mcp, runtime, shutdown: () => shutdown ??= (async () => {
    lifecycle.abort(new Error("MCP connection closed"));
    await runtime.shutdown();
  })() };
}

/** Own EOF, transport closure and signals through one observed terminal path. */
export async function serve(runtime: RepositoryRuntime): Promise<void> {
  const owner = createMcpServer(runtime);
  let closing: Promise<void> | undefined;
  let finish!: () => void;
  const ended = new Promise<void>((resolve) => { finish = resolve; });
  let failure: unknown;
  const close = () => closing ??= (async () => {
    try { await owner.shutdown(); }
    catch (error) { failure = error; }
    try { await owner.mcp.close(); }
    catch (error) { failure ??= error; }
    finally { finish(); }
  })();
  const end = () => { void close(); };
  const interrupt = () => { process.exitCode = 130; end(); };
  const terminate = () => { process.exitCode = 143; end(); };
  process.stdin.once("end", end);
  process.once("SIGINT", interrupt); process.once("SIGTERM", terminate);
  owner.mcp.server.onclose = end;
  try {
    await owner.mcp.connect(new StdioServerTransport());
    await ended;
    if (failure) throw failure;
  } catch (error) { await close(); throw error; }
  finally {
    process.stdin.removeListener("end", end);
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", terminate);
  }
}
