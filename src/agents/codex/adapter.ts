import { realpath, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { BridgeError, errorInfo, safeText } from "../../core/errors.js";
import { withAbort } from "../../core/async.js";
import { processIdentity } from "../../service/process.js";
import { parseWorkerMessage, finalReport } from "../report.js";
import type { WorkerAdapter, WorkerInput, WorkerRun } from "../types.js";
import type { CodexOptions } from "./config.js";
import { CodexStdio, type NativeMessage } from "./transport.js";
import { approval, assertAccount, assertConfiguration, assertNoMcp, correlate, object, terminalTurn, text, threadStarted, turnStarted, userQuestions } from "./protocol.js";

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
/** One assignment owns a native thread across explicitly requested user turns. */
export class CodexAdapter implements WorkerAdapter {
  constructor(private readonly options: CodexOptions) {}
  async run(input: WorkerInput): Promise<WorkerRun> {
    if (input.signal.aborted) return { ...empty(), status: "cancelled", summary: "Task cancelled before startup", worker_stop: "not_started" };
    const lifetime = new AbortController(), signal = AbortSignal.any([input.signal, lifetime.signal]);
    let transport: CodexStdio | undefined, threadId: string | undefined, current: NativeTurn | undefined, reportedModel: string | undefined;
    const checks: WorkerRun["checks"] = [];
    let events = Promise.resolve();
    let eventFailure: unknown;
    const nativeInputs = new Map<string, string[]>();
    let result: WorkerRun = { ...empty(), status: "failed", summary: "Codex did not start", worker_stop: "not_started" };
    const withdraw = async (key: string) => {
      const pending = nativeInputs.get(key);
      if (pending) for (const nativeId of pending) await input.onEvent({ kind: "input_withdrawn", native_id: nativeId });
    };
    const handleEvent = async (message: NativeMessage, turn: NativeTurn): Promise<void> => {
      const turnId = await withAbort(turn.ready, signal);
      if (!threadId) throw new BridgeError("CODEX_CORRELATION_INVALID", "Native event arrived without a thread");
      signal.throwIfAborted();
      if (message.method === "serverRequest/resolved") {
        const value = object(message.params, "serverRequest/resolved");
        if (text(value.threadId, "threadId", 256) !== threadId) throw new BridgeError("CODEX_CORRELATION_INVALID", "Resolved request belongs to another thread");
        const id = value.requestId;
        if (typeof id !== "string" && (typeof id !== "number" || !Number.isSafeInteger(id))) throw new BridgeError("CODEX_PROTOCOL_INVALID", "Resolved request has no valid identity");
        // This notification may also mean withdrawal. It never supplies an approval decision.
        await withdraw(`${typeof id}:${id}`); return;
      }
      if (message.method === "turn/completed") {
        const terminal = terminalTurn(message.params, threadId, turnId);
        if (turn.terminal) throw new BridgeError("CODEX_PROTOCOL_INVALID", "Native turn completed more than once");
        turn.terminal = terminal;
        for (const key of nativeInputs.keys()) await withdraw(key);
        // A success notification alone cannot settle a known outstanding operation.
        // Keep observing its matching completion without introducing a timeout.
        if (terminal !== "completed" || !turn.items.size) {
          await input.onEvent({ kind: "turn_settled", turn_id: turnId, terminal: terminal === "interrupted" ? "cancelled" : terminal });
          turn.settled = true; turn.finish(terminal);
        }
        return;
      }
      if (turn.settled || turn.terminal && message.method === "item/started") throw new BridgeError("CODEX_PROTOCOL_INVALID", "Native item start or duplicate completion arrived after terminal evidence");
      const event = correlate(message.params, threadId, turnId);
      const item = object(event.item, "item"), kind = text(item.type, "item.type", 128), id = text(item.id, "item.id", 256);
      if (["mcpToolCall", "collabAgentToolCall", "dynamicToolCall"].includes(kind)) throw new BridgeError("CODEX_ISOLATION_VIOLATED", "An excluded tool was observed; retain the task for inspection");
      if (message.method === "item/started") {
        if (turn.items.has(id) || turn.items.size >= 256) throw new BridgeError("CODEX_PROTOCOL_INVALID", "Duplicate or excessive native item starts");
        turn.items.set(id, kind);
        await input.onEvent({ kind: "operation_started", id, operation: kind }); return;
      }
      if (!turn.items.has(id) || turn.items.get(id) !== kind) throw new BridgeError("CODEX_PROTOCOL_INVALID", "Completed native item does not match an observed start");
      if (kind === "agentMessage") turn.report = text(item.text, "agentMessage.text", 131_072);
      if (kind === "commandExecution") {
        const status = text(item.status, "commandExecution.status", 64);
        if (!["completed", "failed", "declined"].includes(status) || item.exitCode !== null && (typeof item.exitCode !== "number" || !Number.isSafeInteger(item.exitCode))) throw new BridgeError("CODEX_PROTOCOL_INVALID", "Invalid command terminal evidence");
        if (status !== "declined" && item.exitCode !== null && checks.length < 100) checks.push({ command: safeText(text(item.command, "command", 8192), 4096), cwd: text(item.cwd, "cwd"), exit_code: item.exitCode, evidence: "runtime_observed" });
      }
      turn.items.delete(id);
      await input.onEvent({ kind: "operation_finished", id });
      if (turn.terminal === "completed" && !turn.items.size) {
        await input.onEvent({ kind: "turn_settled", turn_id: turnId, terminal: "completed" });
        turn.settled = true; turn.finish("completed");
      }
    };
    try {
      const home = await isolatedHome(this.options.codex_home, input.workspace);
      signal.throwIfAborted();
      transport = new CodexStdio({ command: this.options.codex_bin, args: argumentsFor(this.options), cwd: input.workspace, env: environment(home),
        notification: (message) => {
          const turn = current;
          if (!turn || !["item/started", "item/completed", "turn/completed", "serverRequest/resolved"].includes(message.method)) return;
          const pending = events.then(() => handleEvent(message, turn));
          events = pending.catch((error: unknown) => { eventFailure ??= error; });
          return pending;
        },
        request: async (message) => {
          const turn = current;
          if (!turn || !threadId) throw new BridgeError("CODEX_REQUEST_UNSUPPORTED", "Native request arrived outside an admitted turn");
          const turnId = await withAbort(turn.ready, signal);
          signal.throwIfAborted();
          if (turn.terminal) throw new BridgeError("NATIVE_INPUT_WITHDRAWN", "Native turn has already ended");
          const key = `${typeof message.id}:${message.id}`;
          const baseId = `codex:${key}`;
          const inputs: string[] = []; nativeInputs.set(key, inputs);
          try {
            if (message.method === "item/tool/requestUserInput") {
              const questions = userQuestions(message.params, threadId, turnId);
              const answers: Record<string, { answers: string[] }> = {};
              for (const question of questions) {
                const nativeId = `${baseId}:${question.id}`;
                if (nativeId.length > 256) throw new BridgeError("CODEX_INPUT_UNSUPPORTED", "Native input identity exceeds the supported bound");
                inputs.push(nativeId);
                const answer = await input.input(question.prompt, false, nativeId, question.free ? undefined : question.options, signal);
                if (!question.free && !question.options.includes(answer)) throw new BridgeError("CODEX_INPUT_INVALID", "Reply must name one offered native choice");
                if (turn.terminal) throw new BridgeError("NATIVE_INPUT_WITHDRAWN", "Native turn ended before the reply");
                answers[question.id] = { answers: [answer] };
              }
              return { answers };
            }
            const requested = approval(message.params, threadId, turnId, input.workspace, message.method);
            if (await realpath(requested.cwd) !== await realpath(input.workspace)) throw new BridgeError("CODEX_APPROVAL_UNSUPPORTED", "Approval cwd resolves outside the task workspace");
            const commandApproval = message.method === "item/commandExecution/requestApproval";
            if (commandApproval && !this.options.allow_command_escalation) return { decision: "decline" };
            inputs.push(baseId);
            const decision = await input.approve({ id: baseId, task_id: input.task_id, workspace: input.workspace,
              tool: message.method, raw_args: requested.command,
              subject: { item_id: requested.itemId, cwd: requested.cwd, warning: commandApproval ? "This operation may run outside the sandbox. No persistent grant is offered." : "Approve only this pending file change." },
              choices: [{ id: "accept", label: "Approve this operation once", decision: "approved", scope: "once" }, { id: "decline", label: "Decline", decision: "denied", scope: "once" }],
            }, signal);
            signal.throwIfAborted();
            if (turn.terminal) throw new BridgeError("NATIVE_INPUT_WITHDRAWN", "The turn ended before the permission decision");
            if (!["accept", "decline"].includes(decision.choice_id)) throw new BridgeError("APPROVAL_INVALID", "Permission decision was not offered");
            return { decision: decision.choice_id };
          } finally { nativeInputs.delete(key); }
        },
      });
      result.worker_stop = "unconfirmed";
      const initialize = object(await transport.request("initialize", { clientInfo: { name: "passeur_codex_worker", title: "Passeur worker", version: "0.1.0" }, capabilities: { experimentalApi: false } }, signal), "initialize");
      text(initialize.userAgent, "initialize.userAgent", 1024);
      if (transport.pid !== undefined) {
        const birth = await processIdentity(transport.pid);
        await input.onEvent({ kind: "process_observed", ...birth });
      }
      await transport.notify("initialized", undefined, signal);
      assertAccount(await transport.request("account/read", { refreshToken: false }, signal));
      assertConfiguration(await transport.request("config/read", { includeLayers: false, cwd: input.workspace }, signal));
      const opened = threadStarted(await transport.request("thread/start", { model: this.options.model, modelProvider: "openai", cwd: input.workspace,
        approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "workspace-write", ephemeral: true }, signal), input.workspace, this.options.model, this.options.network_access);
      threadId = opened.threadId; reportedModel = opened.reportedModel;
      assertNoMcp(await transport.request("mcpServerStatus/list", { threadId, limit: 1 }, signal));
      let prompt = input.prompt;
      while (true) {
        signal.throwIfAborted();
        const turn = newTurn(); current = turn;
        const id = turnStarted(await transport.request("turn/start", { threadId, input: [{ type: "text", text: prompt }], model: this.options.model, cwd: input.workspace,
          approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", writableRoots: [input.workspace], networkAccess: this.options.network_access } }, signal));
        turn.id = id;
        await input.onEvent({ kind: "turn_started", turn_id: id }); turn.open(id);
        const terminal = await withAbort(Promise.race([turn.done, transport.failure]), signal);
        await events;
        if (eventFailure) throw eventFailure;
        if (transport.operationFailure) throw transport.operationFailure;
        if (terminal !== "completed") {
          result = { ...empty(), checks, status: terminal === "interrupted" ? "interrupted" : "failed", summary: `Codex turn ${terminal}`, worker_stop: "unconfirmed", reported_model: reportedModel }; break;
        }
        let message;
        try { message = parseWorkerMessage(turn.report); }
        catch (error) {
          if (!(error instanceof BridgeError) || error.code !== "WORKER_MESSAGE_INVALID") throw error;
          prompt = await withAbort(Promise.race([input.input("The completed native turn has no valid assignment disposition. Supply an explicit continuation instruction, or cancel the task.", true, undefined, undefined, signal), transport.failure]), signal);
          await input.onEvent({ kind: "turn_settled", turn_id: id, terminal: "completed" }); continue;
        }
        if (message.kind === "input_required") {
          prompt = await withAbort(Promise.race([input.input(message.question, false, undefined, undefined, signal), transport.failure]), signal);
          await input.onEvent({ kind: "turn_settled", turn_id: id, terminal: "completed" }); continue;
        }
        if (message.kind === "blocked") {
          result = { ...empty(), status: "blocked", summary: message.reason, blockers: [message.reason], checks, worker_stop: "unconfirmed", reported_model: reportedModel }; break;
        }
        const report = finalReport(message);
        result = { ...report, checks: [...checks, ...report.checks], status: "completed", worker_stop: "unconfirmed", reported_model: reportedModel }; break;
      }
    } catch (error) {
      const diagnostic = error instanceof BridgeError ? errorInfo(error) : { code: "CODEX_RUNTIME_ERROR", message: "Native operation failed; raw diagnostics were not retained" };
      if (transport?.started && !transport.exitEvidence) await input.onEvent({ kind: "runtime_unknown", reason: "Native protocol access failed while process termination is unconfirmed" });
      result = { ...empty(), checks, status: input.signal.aborted ? "cancelled" : ["CODEX_AUTH_UNAVAILABLE", "CODEX_ISOLATION_UNAVAILABLE", "CODEX_CONFIGURATION_MISMATCH", "CODEX_HOME_NOT_ISOLATED"].includes(diagnostic.code) ? "blocked" : "failed",
        summary: diagnostic.message, error: diagnostic, worker_stop: transport?.started ? "unconfirmed" : "not_started", ...(reportedModel ? { reported_model: reportedModel } : {}) };
    } finally {
      const deadline = Date.now() + input.policy.stop_grace_ms;
      lifetime.abort(new BridgeError("WORKER_STOPPING", "The task has explicit terminal, failure or cancellation authority"));
      if (transport && current?.id && threadId && !current.settled) {
        const interrupt = new AbortController();
        const timer = setTimeout(() => interrupt.abort(), Math.min(1000, Math.max(1, input.policy.stop_grace_ms / 4)));
        try { await transport.request("turn/interrupt", { threadId, turnId: current.id }, interrupt.signal); }
        catch { /* The owned process close, not interrupt acknowledgement, supplies stop evidence. */ }
        finally { clearTimeout(timer); }
      }
      if (transport) result.worker_stop = transport.started ? (await transport.close(Math.max(1, deadline - Date.now())) ? "confirmed" : "unconfirmed") : "not_started";
    }
    return result;
  }
}
type NativeTurn = { id?: string; ready: Promise<string>; open: (id: string) => void; done: Promise<Terminal>; finish: (value: Terminal) => void;
  terminal?: Terminal; settled?: boolean; report?: string; items: Map<string, string> };
function newTurn(): NativeTurn {
  let open!: NativeTurn["open"], finish!: NativeTurn["finish"];
  const ready = new Promise<string>((yes) => { open = yes; });
  const done = new Promise<Terminal>((yes) => { finish = yes; });
  return { ready, open, done, finish, items: new Map() };
}
