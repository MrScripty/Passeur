import type { LifecycleSnapshot, LifecycleResult } from "../contracts/tasks.js";
import type { Assignment, AgentResult, ExecutionSnapshot } from "../contracts/agents.js";
import type { DelegateResult, ResourceRecord, StoredResult } from "../contracts/types.js";
import type { Workspace } from "../workspace/worktree.js";
import { BridgeError } from "./errors.js";

export function baseResult(taskId: string, request: Assignment, snapshot: LifecycleSnapshot, workspace?: Workspace): LifecycleResult {
  return {
    schema_version: 4, native_evidence: { run_id: taskId, state: "not_started", obligations: [], coverage: "unknown" }, identity: { status: "admitted", snapshot: structuredClone(snapshot) }, task_id: taskId, request_key: request.request_key, execution_status: "failed", worker_stop: "not_started",
    worker_assessment: "unknown", summary: "", blockers: [], questions: [], model: snapshot.requested_model ? { requested: snapshot.requested_model } : {},
    workspace: workspace?.kind === "task_worktree"
      ? { kind: "task_worktree", base_commit: workspace.base_commit!, worktree_path: workspace.path, stale: false }
      : { kind: "source_read_only", stale: false },
    delivery: { status: request.mode === "review" ? "not_applicable" : "incomplete" },
    changed_files: [], checks: [], artifacts: [], output_truncated: false,
  };
}
export function resultReceipt(result: StoredResult, resource?: ResourceRecord): Record<string, unknown> {
  return {
    schema_version: result.schema_version, task_id: result.task_id, request_key: result.request_key,
    execution_status: result.execution_status, worker_stop: result.worker_stop,
    summary: result.summary.slice(0, 300),
    ...(result.error ? { error: { code: result.error.code, message: result.error.message.slice(0, 300) } } : {}),
    blockers: result.blockers.slice(0, 2).map((text) => text.slice(0, 256)),
    checks_reported: result.checks.length,
    ...(result.schema_version !== 1 ? { delivery: {
      status: result.delivery.status, base_commit: result.delivery.base_commit,
      head_commit: result.delivery.head_commit, tree_oid: result.delivery.tree_oid,
      branch_ref: result.delivery.branch_ref, target_ref: result.delivery.target_ref,
      ...(result.delivery.worktree_path && result.delivery.worktree_path.length <= 512 ? { worktree_path: result.delivery.worktree_path } : {}),
      commit_count: result.delivery.commits?.length,
      reason: result.delivery.reason?.slice(0, 300),
    } } : { delivery: { status: "legacy_unclassified" } }),
    ...((result.schema_version === 3 || result.schema_version === 4) ? { agent: result.identity.status === "admitted"
      ? { agent_id: result.identity.snapshot.agent_id, adapter_id: result.identity.snapshot.adapter_id,
        configuration_fingerprint: result.identity.snapshot.configuration_fingerprint, model: result.model }
      : result.identity } : {}),
    resource_state: resource?.state ?? "legacy_unclassified", details: result.schema_version !== 1 && result.schema_version !== 2 ? "passeur_result" : "muse_result", output_truncated: true,
  };
}
/** Bounds the actual serialized MCP result, rather than only the inner data. No duplicated structured content. */
export function toolPayload(data: unknown, isError = false): { content: Array<{ type: "text"; text: string }>; isError: boolean } {
  const payload = { content: [{ type: "text" as const, text: JSON.stringify(data) }], isError };
  if (Buffer.byteLength(JSON.stringify(payload)) > 24_576) throw new BridgeError("RESPONSE_TOO_LARGE", "Result retained; request a smaller retained-result range");
  return payload;
}
/** Keep per-child identities even when several individually valid receipts exceed the aggregate limit. */
export function batchToolPayload(results: Array<Record<string, unknown>>, isError = false, schemaVersion: 2 | 3 = 2) {
  try { return toolPayload({ schema_version: schemaVersion, results }, isError); }
  catch (error) {
    if (!(error instanceof BridgeError) || error.code !== "RESPONSE_TOO_LARGE") throw error;
    const smaller = results.map((entry) => {
      const source = entry.result && typeof entry.result === "object" ? entry.result as Record<string, unknown> : entry;
      const delivery = source.delivery as Record<string, unknown> | undefined;
      const problem = source.error as Record<string, unknown> | undefined;
      const summary = {
        task_id: source.task_id, execution_status: source.execution_status, worker_stop: source.worker_stop,
        state: source.state, resource_state: source.resource_state, disposition: source.disposition,
        ...(delivery ? { delivery: { status: delivery.status, head_commit: delivery.head_commit } } : {}),
        ...(problem ? { error: { code: String(problem.code).slice(0, 128), message: String(problem.message).slice(0, 96) } } : {}),
        details: schemaVersion === 3 ? "passeur_result" : "muse_result", output_truncated: true,
      };
      return entry.result ? { request_key: entry.request_key, result: summary } : { request_key: entry.request_key, operation_key: entry.operation_key, ...summary };
    });
    return toolPayload({ schema_version: schemaVersion, output_truncated: true, results: smaller }, isError);
  }
}
/** Preserve byte offsets without splitting a UTF-8 character between result pages. */
export function textChunk(buffer: Buffer, length: number, encoding: "utf8" | "base64"): { content: string; bytes: number } {
  const chunk = buffer.subarray(0, length);
  if (encoding === "base64") return { content: chunk.toString("base64"), bytes: chunk.length };
  for (let trim = 0; trim <= 3 && trim <= chunk.length; trim++) {
    const bytes = chunk.length - trim;
    if (!bytes && chunk.length) break;
    try { return { content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(chunk.subarray(0, bytes)), bytes }; }
    catch { /* A short incomplete trailing codepoint may belong to the next page. */ }
  }
  throw new BridgeError("INVALID_TEXT_RANGE", "UTF-8 range is too short, misaligned or binary; request base64 or continue at the returned next_offset");
}

/** Only the retained Muse v2 execution surface uses this explicit output projection. */
export function legacyMuseResult(result: AgentResult): DelegateResult {
  if (result.identity.status !== "admitted" || result.identity.snapshot.agent_id !== "muse" ||
      result.identity.snapshot.adapter_id !== "muse" || !result.model.requested) {
    throw new BridgeError("LEGACY_RESULT_UNREPRESENTABLE", "Read the versioned result through passeur_result");
  }
  const { identity: _identity, model, ...fields } = result;
  return { ...fields, schema_version: 2, model: { requested: model.requested!, ...(model.reported ? { reported: model.reported } : {}) } };
}
