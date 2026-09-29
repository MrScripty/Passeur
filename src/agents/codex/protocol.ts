import { isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
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
/** Only tagged native v0.157.1 item names may enter retained diagnostics. */
export function protectedItemType(value: unknown): string {
  const types = ["userMessage", "hookPrompt", "agentMessage", "functionCallOutput", "plan", "reasoning",
    "commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "collabAgentToolCall",
    "subAgentActivity", "webSearch", "imageView", "sleep", "imageGeneration", "enteredReviewMode",
    "exitedReviewMode", "contextCompaction"];
  return typeof value === "string" && types.includes(value) ? value : "unknown";
}
/** A userMessage is the native echo of this turn's input, never a tool effect. */
export function protectedUserEcho(value: unknown, threadId: string, turnId: string,
  phase: "item/started" | "item/completed", state: { id?: string; completed?: boolean }, terminal = false): string {
  const event = correlate(value, threadId, turnId);
  const item = object(event.item, "userMessage");
  if (item.type !== "userMessage") throw new BridgeError("CODEX_CORRELATION_INVALID", "Native input echo changed item type");
  const id = text(item.id, "userMessage.id", 256);
  if (phase === "item/started") {
    if (terminal || state.id !== undefined) throw new BridgeError("CODEX_PROTOCOL_INVALID", "Duplicate or late native input echo");
    state.id = id;
  } else if (state.id !== id || state.completed) {
    throw new BridgeError("CODEX_PROTOCOL_INVALID", "Native input echo completed without its exact start");
  } else state.completed = true;
  return id;
}
export function assertAccount(value: unknown): void {
  const response = object(value, "account/read");
  if (response.requiresOpenaiAuth !== true || response.account === null || object(response.account, "account/read.account").type !== "chatgpt") {
    throw new BridgeError("CODEX_AUTH_UNAVAILABLE", "The configured runtime must use its existing ChatGPT login; API-key fallback is not allowed");
  }
}
/** A seeded no-account fixture must identify only the disposable synthetic persona. */
export function assertSyntheticSeedAccount(value: unknown): void {
  const response = object(value, "account/read");
  const account = object(response.account, "account/read.account");
  if (response.requiresOpenaiAuth !== true || account.type !== "chatgpt" ||
      account.email !== "passeur-synthetic@example.invalid") {
    throw new BridgeError("CODEX_AUTH_UNAVAILABLE", "Seeded qualification did not identify the synthetic persona");
  }
}
export function assertConfiguration(value: unknown): void {
  const config = object(object(value, "config/read").config, "config");
  const features = object(config.features, "config.features");
  const servers = object(config.mcp_servers, "config.mcp_servers");
  // Labels are fixed policy categories; never include native values or server names in this diagnostic.
  const mismatches = [
    Object.keys(servers).length > 0 && "mcp_servers",
    features.multi_agent !== false && "features.multi_agent",
    features.apps !== false && "features.apps",
    features.plugins !== false && "features.plugins",
    config.web_search !== "disabled" && "web_search",
    config.forced_login_method !== "chatgpt" && "forced_login_method",
  ].filter((label): label is string => typeof label === "string");
  if (mismatches.length) {
    throw new BridgeError("CODEX_ISOLATION_UNAVAILABLE",
      `Effective configuration did not establish child-tool and credential isolation (${mismatches.join(", ")})`);
  }
}
/** The installed experimental named profile is required before any protected turn. */
export function assertProtectedConfiguration(value: unknown, profile = "passeur-boundary", synthetic = false,
  policy?: Readonly<{ workspace: string; canonical: string; admin: string; native: string;
    seededPort?: number; provider?: string; tls?: Readonly<{ accountHost: string; inferenceHost: string; firstParty?: true }> }>): void {
  const response = object(value, "config/read");
  const config = object(response.config, "config");
  const features = object(config.features, "config.features");
  const servers = object(config.mcp_servers, "config.mcp_servers");
  if (Object.keys(servers).length || features.multi_agent !== false || features.apps !== false ||
      features.plugins !== false || features.image_generation !== false || config.web_search !== "disabled" ||
      (!synthetic && config.forced_login_method !== "chatgpt")) {
    throw new BridgeError("CODEX_ISOLATION_UNAVAILABLE", "Protected effective configuration did not establish tool and credential isolation");
  }
  if (config.default_permissions !== profile || config.sandbox_mode != null ||
      config.sandbox_workspace_write != null || config.permission_profile != null || config.permissionProfile != null) {
    throw new BridgeError("CODEX_CONFIGURATION_MISMATCH", "The protected named profile is not the sole effective permission selector");
  }
  if (!synthetic) return; // The real-account profile has a separate, unqualified gate.
  if (!policy || !Array.isArray(response.layers) || !response.layers.length) {
    throw new BridgeError("CODEX_CONFIGURATION_MISMATCH", "Protected configuration layers are unavailable");
  }
  const origins = object(response.origins, "config/read.origins");
  const selectorOrigin = object(origins.default_permissions, "default_permissions origin");
  if (object(selectorOrigin.name, "default_permissions source").type !== "sessionFlags") {
    throw new BridgeError("CODEX_CONFIGURATION_MISMATCH", "Protected permission selector has another source");
  }
  const expected = { [profile]: { workspace_roots: { [policy.workspace]: true, [policy.canonical]: true },
    filesystem: { ":root": "deny", ":minimal": "read", ":slash_tmp": "deny", ":tmpdir": "deny",
      [policy.native]: "read", [policy.admin]: "write", ":workspace_roots": { ".": "write" } }, network: { enabled: false } } };
  let user = 0, session = 0, emptySystem = 0;
  const bootstrap = policy.tls?.firstParty ? undefined : policy.tls ? `https://${policy.tls.accountHost}` :
    policy.seededPort !== undefined ? `http://127.0.0.1:${policy.seededPort}` : undefined;
  const inference = policy.tls?.firstParty ? undefined : policy.tls ? `https://${policy.tls.inferenceHost}/v1` :
    policy.seededPort !== undefined ? `http://127.0.0.1:${policy.seededPort}/v1` : undefined;
  if (bootstrap !== undefined &&
      (config.chatgpt_base_url !== bootstrap ||
      object(object(config.model_providers, "config.model_providers")[policy.provider!], "seeded provider").requires_openai_auth !== true ||
      object(object(config.model_providers, "config.model_providers")[policy.provider!], "seeded provider").base_url !== inference ||
      policy.tls && object(config.analytics, "config.analytics").enabled !== false)) {
    throw new BridgeError("CODEX_CONFIGURATION_MISMATCH", "Effective synthetic account bootstrap differs from sealed policy");
  }
  if (policy.tls?.firstParty && (policy.provider !== "openai" ||
      config.chatgpt_base_url != null && config.chatgpt_base_url !== "https://chatgpt.com/backend-api/codex" ||
      object(config.analytics, "config.analytics").enabled !== false)) {
    throw new BridgeError("CODEX_CONFIGURATION_MISMATCH", "Synthetic first-party policy changed the built-in provider or origin");
  }
  for (const raw of response.layers) {
    const layer = object(raw, "config/read.layer"), name = object(layer.name, "config/read.layer.name");
    if (layer.disabledReason != null) continue;
    if (name.type === "user" && name.file === "/mounts/home/config.toml" && name.profile == null) {
      user++;
      const userConfig = object(layer.config, "user layer");
      if (!isDeepStrictEqual(userConfig.permissions, expected) || bootstrap !== undefined &&
          (userConfig.chatgpt_base_url !== bootstrap ||
          object(object(userConfig.model_providers, "user model_providers")[policy.provider!], "user provider").requires_openai_auth !== true ||
          object(object(userConfig.model_providers, "user model_providers")[policy.provider!], "user provider").base_url !== inference ||
          policy.tls && object(userConfig.analytics, "user analytics").enabled !== false)) {
        throw new BridgeError("CODEX_CONFIGURATION_MISMATCH", "The loaded user permission policy differs from the sealed artifact");
      }
      if (policy.tls?.firstParty && (userConfig.chatgpt_base_url != null ||
          userConfig.model_providers != null ||
          object(userConfig.analytics, "user analytics").enabled !== false)) {
        throw new BridgeError("CODEX_CONFIGURATION_MISMATCH", "The sealed first-party profile overrides its origin or provider");
      }
    } else if (name.type === "sessionFlags") {
      session++;
      const flags = object(layer.config, "session flags");
      if (flags.default_permissions !== profile || flags.permissions != null ||
          object(flags.features, "session feature flags").image_generation !== false) {
        throw new BridgeError("CODEX_CONFIGURATION_MISMATCH", "Session flags changed the protected policy");
      }
    } else if (name.type === "system" && name.file === "/etc/codex/config.toml" &&
        Object.keys(object(layer.config, "system layer")).length === 0) {
      emptySystem++;
    } else if (name.type !== "packagedDefaults") {
      throw new BridgeError("CODEX_CONFIGURATION_MISMATCH", "An unqualified native config layer is active");
    } else if (object(layer.config, "packaged defaults").permissions != null) {
      throw new BridgeError("CODEX_CONFIGURATION_MISMATCH", "Packaged defaults changed the protected policy");
    }
  }
  if (user !== 1 || session !== 1 || emptySystem > 1) {
    throw new BridgeError("CODEX_CONFIGURATION_MISMATCH", "Protected policy has incomplete native layer evidence");
  }
}
export function assertProtectedProfile(value: unknown, profile = "passeur-boundary"): void {
  const response = object(value, "permissionProfile/list");
  if (!Array.isArray(response.data) || response.nextCursor != null) throw new BridgeError("CODEX_CONFIGURATION_MISMATCH", "Protected profile inventory is incomplete");
  const matches = response.data.filter(item => record(item) && item.id === profile);
  if (matches.length !== 1 || !record(matches[0]) || matches[0].allowed !== true) {
    throw new BridgeError("CODEX_CONFIGURATION_MISMATCH", "Protected named profile is unavailable");
  }
}
export function protectedThreadStarted(value: unknown, workspace: string, model: string,
  provider = "openai", profile = "passeur-boundary"): { threadId: string; reportedModel: string } {
  const response = object(value, "thread/start");
  const thread = object(response.thread, "thread/start.thread");
  const cwd = text(response.cwd, "thread/start.cwd");
  if (!isAbsolute(cwd) || resolve(cwd) !== resolve(workspace) || response.model !== model ||
      response.modelProvider !== provider || object(response.activePermissionProfile, "activePermissionProfile").id !== profile) {
    throw new BridgeError("CODEX_CONFIGURATION_MISMATCH", "Protected native thread did not select the exact model, provider, workspace and profile");
  }
  return { threadId: text(thread.id, "thread.id", 256), reportedModel: model };
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
  // without accepting the proposal. Codex's reserved local environment identifies the task-owned
  // app-server executor; other environments, managed network grants and broader roots are unsupported.
  const unsupported = [
    request.proposedNetworkPolicyAmendments != null && "proposedNetworkPolicyAmendments",
    request.networkApprovalContext != null && "networkApprovalContext",
    request.grantRoot != null && "grantRoot",
    request.additionalPermissions != null && "additionalPermissions",
    request.environmentId != null && request.environmentId !== "local" && "environmentId",
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
