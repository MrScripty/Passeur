import { isAbsolute, resolve } from "node:path";
import { BridgeError } from "../../core/errors.js";

// These decoders project the explicitly consumed native facts. Other documented native metadata is ignored,
// never retained or used as authorization. See docs/agents/codex.md for upstream schema identities.
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
export function object(value: unknown, operation: string): Record<string, unknown> {
  if (!record(value)) throw new BridgeError("CODEX_PROTOCOL_INVALID", `${operation} requires an object`);
  return value;
}
export function text(value: unknown, operation: string, max = 4096): string {
  if (typeof value !== "string" || !value || value.length > max) throw new BridgeError("CODEX_PROTOCOL_INVALID", `${operation} requires bounded text`);
  return value;
}
export function correlate(value: unknown, threadId: string, turnId: string): Record<string, unknown> {
  const event = object(value, "turn event");
  if (event.threadId !== threadId || event.turnId !== turnId) throw new BridgeError("CODEX_CORRELATION_INVALID", "Native event belongs to another thread or turn");
  return event;
}
export function assertAccount(value: unknown): void {
  const response = object(value, "account/read");
  if (response.requiresOpenaiAuth !== true || response.account === null || object(response.account, "account/read.account").type !== "chatgpt") {
    throw new BridgeError("CODEX_AUTH_UNAVAILABLE", "The configured runtime must use its existing ChatGPT login; API-key fallback is not allowed");
  }
}
export function assertConfiguration(value: unknown): void {
  const config = object(object(value, "config/read").config, "config");
  const features = object(config.features, "config.features");
  const servers = object(config.mcp_servers, "config.mcp_servers");
  if (Object.keys(servers).length || features.multi_agent !== false || features.apps !== false ||
      features.plugins !== false || config.web_search !== "disabled" || config.forced_login_method !== "chatgpt") {
    throw new BridgeError("CODEX_ISOLATION_UNAVAILABLE", "Effective configuration did not establish child-tool and credential isolation");
  }
}
export function assertNoMcp(value: unknown): void {
  const response = object(value, "mcpServerStatus/list");
  if (!Array.isArray(response.data) || response.data.length !== 0 || response.nextCursor !== null) {
    throw new BridgeError("CODEX_ISOLATION_UNAVAILABLE", "Child MCP availability is not empty and fully observed");
  }
}
export function threadStarted(value: unknown, workspace: string, model: string, networkAccess: boolean): { threadId: string; reportedModel: string } {
  const response = object(value, "thread/start");
  const thread = object(response.thread, "thread/start.thread");
  const sandbox = object(response.sandbox, "thread/start.sandbox");
  const cwd = text(response.cwd, "thread/start.cwd");
  if (!isAbsolute(cwd) || resolve(cwd) !== resolve(workspace) || response.model !== model || response.modelProvider !== "openai" ||
      response.approvalPolicy !== "on-request" || response.approvalsReviewer !== "user" ||
      sandbox.type !== "workspaceWrite" || sandbox.networkAccess !== networkAccess || !Array.isArray(sandbox.writableRoots) ||
      sandbox.writableRoots.some((root) => typeof root !== "string" || !isAbsolute(root) || resolve(root) !== resolve(workspace))) {
    throw new BridgeError("CODEX_CONFIGURATION_MISMATCH", "Codex did not establish the requested model, workspace, approval and sandbox policy");
  }
  return { threadId: text(thread.id, "thread.id", 256), reportedModel: model };
}
export function turnStarted(value: unknown): string {
  const turn = object(object(value, "turn/start").turn, "turn/start.turn");
  if (typeof turn.status !== "string" || !["inProgress", "completed", "failed", "interrupted"].includes(turn.status)) throw new BridgeError("CODEX_PROTOCOL_INVALID", "Unknown native turn status");
  return text(turn.id, "turn.id", 256);
}
export function terminalTurn(value: unknown, threadId: string, turnId: string): "completed" | "failed" | "interrupted" {
  const event = object(value, "turn/completed");
  const turn = object(event.turn, "turn/completed.turn");
  if (event.threadId !== threadId || turn.id !== turnId) throw new BridgeError("CODEX_CORRELATION_INVALID", "Terminal event belongs to another thread or turn");
  if (turn.status !== "completed" && turn.status !== "failed" && turn.status !== "interrupted") throw new BridgeError("CODEX_PROTOCOL_INVALID", "Terminal event lacks a terminal status");
  if (turn.status === "completed" && turn.error !== null) throw new BridgeError("CODEX_PROTOCOL_INVALID", "Completed turn contains an error");
  return turn.status;
}
export function approval(value: unknown, threadId: string, turnId: string, workspace: string, method: string) {
  const request = correlate(value, threadId, turnId);
  const itemId = text(request.itemId, "approval.itemId", 256);
  // An execpolicy proposal is only a hint. The adapter can answer "accept" for this command
  // without accepting the proposal; managed network grants and broader roots remain unsupported.
  const unsupported = [
    request.proposedNetworkPolicyAmendments != null && "proposedNetworkPolicyAmendments",
    request.networkApprovalContext != null && "networkApprovalContext",
    request.grantRoot != null && "grantRoot",
    request.additionalPermissions != null && "additionalPermissions",
    request.environmentId != null && "environmentId",
    request.kind !== undefined && request.kind !== "command" && "kind",
  ].filter((name): name is string => typeof name === "string");
  if (unsupported.length) throw new BridgeError("CODEX_APPROVAL_UNSUPPORTED", `This approval would extend the admitted permission contract (${unsupported.join(", ")})`);
  if (method === "item/commandExecution/requestApproval") {
    const cwd = text(request.cwd, "approval.cwd");
    if (!isAbsolute(cwd) || resolve(cwd) !== resolve(workspace)) throw new BridgeError("CODEX_APPROVAL_UNSUPPORTED", "The command requests a different working directory");
    return { itemId, command: text(request.command, "approval.command", 8192), cwd };
  }
  if (method === "item/fileChange/requestApproval") return { itemId, command: "Review the pending file changes in the assigned worktree", cwd: workspace };
  throw new BridgeError("CODEX_REQUEST_UNSUPPORTED", "This native request has no supported approval contract");
}

/** Consumed request_user_input contract, pinned to the official v2 generated schema. */
export function userQuestions(value: unknown, thread: string, turn: string): Array<{ id: string; prompt: string; options: string[]; free: boolean }> {
  const request = correlate(value, thread, turn);
  text(request.itemId, "itemId", 256);
  if (typeof request.isBlocking !== "boolean" || request.autoResolutionMs !== null && (typeof request.autoResolutionMs !== "number" || !Number.isSafeInteger(request.autoResolutionMs) || request.autoResolutionMs < 0)) throw new BridgeError("CODEX_INPUT_INVALID", "Native question lifecycle is invalid");
  if (!Array.isArray(request.questions) || !request.questions.length || request.questions.length > 16) throw new BridgeError("CODEX_INPUT_INVALID", "Native questions exceed their bound");
  const questions = request.questions.map((raw) => {
    const q = object(raw, "question"), id = text(q.id, "question.id", 128), header = text(q.header, "question.header", 512), question = text(q.question, "question.text", 4096);
    if (typeof q.isOther !== "boolean" || typeof q.isSecret !== "boolean") throw new BridgeError("CODEX_INPUT_INVALID", "Native question controls are invalid");
    if (q.isSecret) throw new BridgeError("CODEX_INPUT_UNSUPPORTED", "Secrets cannot be supplied through retained task input");
    if (q.options !== null && (!Array.isArray(q.options) || q.options.length > 16)) throw new BridgeError("CODEX_INPUT_INVALID", "Native choice list is invalid");
    const options = q.options === null ? [] : q.options.map((rawOption: unknown) => {
      const option = object(rawOption, "question.option");
      text(option.description, "option.description", 2048);
      return text(option.label, "option.label", 256);
    });
    if (new Set(options).size !== options.length) throw new BridgeError("CODEX_INPUT_INVALID", "Duplicate native choice labels");
    return { id, prompt: `${header}\n${question}${options.length ? `\nChoices: ${options.join(" | ")}` : ""}`, options, free: q.isOther || q.options === null };
  });
  if (new Set(questions.map((q) => q.id)).size !== questions.length) throw new BridgeError("CODEX_INPUT_INVALID", "Duplicate native question identities");
  return questions;
}
