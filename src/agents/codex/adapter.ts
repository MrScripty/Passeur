import { realpath, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { BridgeError, errorInfo, safeText } from "../../core/errors.js";
import { withAbort } from "../../core/async.js";
import { parseWorkerReport } from "../report.js";
import type { WorkerAdapter, WorkerInput, WorkerRun } from "../types.js";
import type { CodexOptions } from "./config.js";
import { CodexStdio, type NativeMessage } from "./transport.js";
import { approval, assertAccount, assertConfiguration, assertNoMcp, correlate, object, terminalTurn, text, threadStarted, turnStarted } from "./protocol.js";

type Terminal = "completed" | "failed" | "interrupted";
const empty = () => ({ worker_assessment: "unknown" as const, blockers: [] as string[], questions: [] as string[], checks: [] as WorkerRun["checks"] });
function environment(home: string): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = { CODEX_HOME: home };
  for (const name of ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "TERM", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) {
    if (process.env[name] !== undefined) output[name] = process.env[name];
  }
  return output;
}
async function isolatedHome(configured: string, workspace: string): Promise<string> {
  const home = await realpath(configured), root = await realpath(workspace);
  if (!(await stat(home)).isDirectory()) throw new BridgeError("CODEX_HOME_INVALID", "The dedicated Codex home is not a directory");
  const rel = relative(root, home);
  if (rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`))) {
    // relative() may be absolute across Windows drives; this adapter is Linux-only.
    throw new BridgeError("CODEX_HOME_INVALID", "Credentials and runtime state must remain outside the assignment workspace");
  }
  const host = process.env.CODEX_HOME ?? (process.env.HOME ? join(process.env.HOME, ".codex") : undefined);
  if (host) {
    let canonical: string | undefined;
    try { canonical = await realpath(host); }
    catch (error) { if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error; }
    if (canonical === home) throw new BridgeError("CODEX_HOME_NOT_ISOLATED", "Use a dedicated operator-authenticated Codex home, not the calling agent's home");
  }
  return home;
}
function argumentsFor(options: CodexOptions): string[] {
  const overrides = [
    'forced_login_method="chatgpt"', 'model_provider="openai"', 'mcp_servers={}',
    'features.multi_agent=false', 'features.apps=false', 'features.plugins=false', 'web_search="disabled"',
    'approvals_reviewer="user"', `sandbox_workspace_write.network_access=${options.network_access}`,
    'sandbox_workspace_write.writable_roots=[]',
  ];
  return [...overrides.flatMap((value) => ["-c", value]), "app-server"];
}
/** Local stdio app-server implementation. It does not host an agent loop or attach to a shared daemon. */
export class CodexAdapter implements WorkerAdapter {
  constructor(private readonly options: CodexOptions) {}
  async run(input: WorkerInput): Promise<WorkerRun> {
    if (input.signal.aborted) return { ...empty(), status: input.signal.reason instanceof BridgeError && input.signal.reason.code === "TASK_TIMEOUT" ? "timed_out" : "cancelled", summary: "Task cancelled before startup", worker_stop: "not_started" };
    const lifetime = new AbortController();
    const signal = AbortSignal.any([input.signal, lifetime.signal]);
    let transport: CodexStdio | undefined, threadId: string | undefined, turnId: string | undefined;
    let turnRequested = false, lastReport: string | undefined, reportedModel: string | undefined;
    let terminalObserved = false;
    const checks: WorkerRun["checks"] = [];
    let resolveTurn!: (id: string) => void;
    const turnReady = new Promise<string>((resolve) => { resolveTurn = resolve; });
    let resolveDone!: (terminal: Terminal) => void;
    const done = new Promise<Terminal>((resolve) => { resolveDone = resolve; });
    let eventChain = Promise.resolve();
    let eventFailure: unknown;
    let result: WorkerRun = { ...empty(), status: "failed", summary: "Codex did not start", worker_stop: "not_started" };
    const handleEvent = async (message: NativeMessage): Promise<void> => {
      const currentTurn = await withAbort(turnReady, signal);
      if (!threadId) throw new BridgeError("CODEX_CORRELATION_INVALID", "A turn event arrived without a thread");
      signal.throwIfAborted();
      if (message.method === "turn/completed") {
        const terminal = terminalTurn(message.params, threadId, currentTurn);
        if (terminalObserved) throw new BridgeError("CODEX_PROTOCOL_INVALID", "Native turn completed more than once");
        terminalObserved = true; resolveDone(terminal); return;
      }
      if (terminalObserved) throw new BridgeError("CODEX_PROTOCOL_INVALID", "Native item arrived after terminal state");
      const event = correlate(message.params, threadId, currentTurn);
      const item = object(event.item, "item/completed.item");
      const kind = text(item.type, "item.type", 128);
      text(item.id, "item.id", 256);
      if (kind === "agentMessage") lastReport = text(item.text, "agentMessage.text", 131_072);
      if (kind === "commandExecution") {
        if (item.exitCode !== null && (typeof item.exitCode !== "number" || !Number.isSafeInteger(item.exitCode))) throw new BridgeError("CODEX_PROTOCOL_INVALID", "Native command exit code is invalid");
        const status = text(item.status, "commandExecution.status", 64);
        if (!["completed", "failed", "declined"].includes(status)) throw new BridgeError("CODEX_PROTOCOL_INVALID", "A completed item has an invalid command status");
        if (status !== "declined" && item.exitCode !== null && checks.length < 100) checks.push({ command: safeText(text(item.command, "commandExecution.command", 8192), 4096),
          cwd: text(item.cwd, "commandExecution.cwd"), exit_code: item.exitCode, evidence: "runtime_observed" });
      }
      if (["mcpToolCall", "collabAgentToolCall", "dynamicToolCall"].includes(kind)) throw new BridgeError("CODEX_ISOLATION_VIOLATED", "An excluded tool was observed; retain the task for inspection");
      await input.onEvent({ kind: "item", item_kind: kind });
    };
    try {
      const home = await isolatedHome(this.options.codex_home, input.workspace);
      signal.throwIfAborted();
      transport = new CodexStdio({ command: this.options.codex_bin, args: argumentsFor(this.options), cwd: input.workspace, env: environment(home),
        notification: (message) => {
          if (!turnRequested || !["item/completed", "turn/completed"].includes(message.method)) return;
          const pending = eventChain.then(() => handleEvent(message));
          eventChain = pending.catch((error: unknown) => { eventFailure ??= error; });
          return pending;
        },
        request: async (message) => {
          if (!turnRequested || !threadId) throw new BridgeError("CODEX_REQUEST_UNSUPPORTED", "Native request arrived outside an admitted turn");
          const currentTurn = await withAbort(turnReady, signal);
          signal.throwIfAborted();
          if (terminalObserved) throw new BridgeError("STALE_APPROVAL", "The task no longer accepts approvals");
          const requested = approval(message.params, threadId, currentTurn, input.workspace, message.method);
          if (await realpath(requested.cwd) !== await realpath(input.workspace)) throw new BridgeError("CODEX_APPROVAL_UNSUPPORTED", "Approval cwd resolves outside the task workspace");
          const commandApproval = message.method === "item/commandExecution/requestApproval";
          if (commandApproval && !this.options.allow_command_escalation) return { decision: "decline" };
          const approvalId = `codex:${typeof message.id}:${message.id}`;
          await input.onEvent({ kind: "approval_requested", approval_id: approvalId, tool: message.method });
          const decision = await input.approve({ id: approvalId, task_id: input.task_id, workspace: input.workspace,
            tool: message.method, raw_args: requested.command,
            subject: { item_id: requested.itemId, cwd: requested.cwd,
              warning: commandApproval ? "Codex may run this exact command outside its sandbox. This grants no persistent rule or session permission." : "Approve this pending file-change operation only." },
            choices: [{ id: "accept", label: "Approve this operation once", decision: "approved", scope: "once" },
              { id: "decline", label: "Decline", decision: "denied", scope: "once" }],
          }, signal);
          signal.throwIfAborted();
          if (terminalObserved) throw new BridgeError("STALE_APPROVAL", "The turn ended before the approval decision");
          if (decision.choice_id !== "accept" && decision.choice_id !== "decline") throw new BridgeError("APPROVAL_INVALID", "The approval decision was not offered");
          return { decision: decision.choice_id };
        },
      });
      result.worker_stop = "unconfirmed";
      const initialize = object(await transport.request("initialize", {
        clientInfo: { name: "passeur_codex_worker", title: "Passeur worker", version: "0.1.0" }, capabilities: { experimentalApi: false },
      }, signal), "initialize");
      text(initialize.userAgent, "initialize.userAgent", 1024);
      await transport.notify("initialized", undefined, signal);
      assertAccount(await transport.request("account/read", { refreshToken: false }, signal));
      assertConfiguration(await transport.request("config/read", { includeLayers: false, cwd: input.workspace }, signal));
      const opened = threadStarted(await transport.request("thread/start", {
        model: this.options.model, modelProvider: "openai", cwd: input.workspace,
        approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "workspace-write", ephemeral: true,
      }, signal), input.workspace, this.options.model, this.options.network_access);
      threadId = opened.threadId; reportedModel = opened.reportedModel;
      assertNoMcp(await transport.request("mcpServerStatus/list", { threadId, limit: 1 }, signal));
      turnRequested = true;
      turnId = turnStarted(await transport.request("turn/start", {
        threadId, input: [{ type: "text", text: input.prompt }], model: this.options.model, cwd: input.workspace,
        approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", writableRoots: [input.workspace], networkAccess: this.options.network_access },
      }, signal));
      resolveTurn(turnId);
      const terminal = await withAbort(Promise.race([done, transport.failure]), signal);
      await eventChain;
      if (eventFailure) throw eventFailure;
      if (transport.operationFailure) throw transport.operationFailure;
      if (terminal === "completed") {
        const report = parseWorkerReport(lastReport);
        result = { ...report, checks: [...checks, ...report.checks], status: "completed", worker_stop: "unconfirmed", reported_model: reportedModel };
      } else result = { ...empty(), checks, status: terminal === "interrupted" ? "cancelled" : "failed",
        summary: `Codex turn ${terminal}`, worker_stop: "unconfirmed", reported_model: reportedModel };
    } catch (error) {
      const diagnostic = error instanceof BridgeError ? errorInfo(error) : { code: "CODEX_RUNTIME_ERROR", message: "Codex runtime operation failed; native details were not retained" };
      const timeout = input.signal.aborted && input.signal.reason instanceof BridgeError && input.signal.reason.code === "TASK_TIMEOUT";
      result = { ...empty(), checks, status: input.signal.aborted ? (timeout ? "timed_out" : "cancelled") :
        ["CODEX_AUTH_UNAVAILABLE", "CODEX_ISOLATION_UNAVAILABLE", "CODEX_CONFIGURATION_MISMATCH", "CODEX_HOME_NOT_ISOLATED"].includes(diagnostic.code) ? "blocked" : "failed",
        summary: diagnostic.message, error: diagnostic, worker_stop: transport?.started ? "unconfirmed" : "not_started",
        ...(reportedModel ? { reported_model: reportedModel } : {}) };
    } finally {
      const deadline = Date.now() + input.policy.stop_grace_ms;
      lifetime.abort(new BridgeError("WORKER_STOPPING", "The worker run is closing"));
      if (transport && turnId && threadId && !terminalObserved) {
        const interrupt = new AbortController();
        const timer = setTimeout(() => interrupt.abort(), Math.min(1000, Math.max(1, input.policy.stop_grace_ms / 4)));
        try { await transport.request("turn/interrupt", { threadId, turnId }, interrupt.signal); }
        catch { /* The process close below owns stop evidence; an interrupt acknowledgment never does. */ }
        finally { clearTimeout(timer); }
      }
      if (transport) {
        const stopped = await transport.close(Math.max(1, deadline - Date.now()));
        result.worker_stop = transport.started ? (stopped ? "confirmed" : "unconfirmed") : "not_started";
      }
    }
    return result;
  }
}
