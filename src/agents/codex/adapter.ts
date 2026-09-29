import { realpath, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { BridgeError, errorInfo, safeText } from "../../core/errors.js";
import { withAbort } from "../../core/async.js";
import { processIdentity } from "../../service/process.js";
import { parseWorkerMessage, finalReport } from "../report.js";
import { peerOperationResultPrompt, peerProposalCorrectionPrompt, peerProposalRejection, peerSupersededPrompt, peerDeliveryPrompt, MAX_CODEX_PEER_DELIVERY_PROMPT_BYTES } from "../report-format.js";
import type { WorkerAdapter, WorkerInput, WorkerRun } from "../types.js";
import { PeerDeliveryNativeSessionIdSchema, type PeerDeliveryEnvelope } from "../../contracts/peer-delivery.js";
import type { CodexOptions } from "./config.js";
import { CodexStdio, StartupStderrDiagnostic, type NativeMessage, type StartupStderrEvidence } from "./transport.js";
import { approval, assertAccount, assertSyntheticSeedAccount, assertConfiguration, assertEmptySkills, assertMcpItemStatus, assertNoMcp, assertProtectedConfiguration, assertProtectedProfile, correlate, object, protectedItemType, protectedThreadStarted, protectedUserEcho, terminalTurn, text, threadStarted, turnStarted, userQuestions } from "./protocol.js";
import { captureProtectedStartup, protectedCredentialExposure, protectedLaunch,
  protectedSeedAdmissionRefused, settleProtectedStop } from "./protected-runtime.js";
import { type Captured } from "../../core/protected-namespace.js";

type Terminal = "completed" | "failed" | "interrupted";
const empty = () => ({ worker_assessment: "unknown" as const, blockers: [] as string[], questions: [] as string[], checks: [] as WorkerRun["checks"] });
export function codexEnvironment(home: string): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = { CODEX_HOME: home };
  for (const name of ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "TERM", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) {
    if (process.env[name] !== undefined) output[name] = process.env[name];
  }
  return output;
}
export async function resolveCodexHome(configured: string, workspace: string, useCallerHome = false): Promise<string> {
  const home = await realpath(configured), root = await realpath(workspace);
  if (!(await stat(home)).isDirectory()) throw new BridgeError("CODEX_HOME_INVALID", "The Codex home is not a directory");
  const rel = relative(root, home);
  if (rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`))) {
    // relative() may be absolute across Windows drives; this adapter is Linux-only.
    throw new BridgeError("CODEX_HOME_INVALID", "Credentials and runtime state must remain outside the assignment workspace");
  }
  const caller = process.env.CODEX_HOME ?? (process.env.HOME ? join(process.env.HOME, ".codex") : undefined);
  let canonical: string | undefined;
  if (caller) {
    try { canonical = await realpath(caller); }
    catch (error) { if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error; }
  }
  if (useCallerHome) {
    if (!canonical || configured !== canonical || home !== canonical) {
      throw new BridgeError("CODEX_HOME_NOT_ISOLATED", "Caller Codex home opt-in requires the exact canonical current caller home");
    }
  } else if (canonical === home) {
    throw new BridgeError("CODEX_HOME_NOT_ISOLATED", "Use a dedicated operator-authenticated Codex home, not the calling agent's home");
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
function peerPrompt(envelope: PeerDeliveryEnvelope): string {
  const prompt = peerDeliveryPrompt(envelope, "codex");
  if (Buffer.byteLength(prompt, "utf8") > MAX_CODEX_PEER_DELIVERY_PROMPT_BYTES) throw new BridgeError("PEER_DELIVERY_UNSUPPORTED", "Peer continuation exceeds the bounded native prompt");
  return prompt;
}
const protectedStages = ["initialize", "account/read", "config/read", "permissionProfile/list", "skills/list",
  "thread/start", "mcpServerStatus/list", "turn/start"] as const;
type ProtectedStage = typeof protectedStages[number];
export function protectedNativeRejection(diagnostic: { code: string; message: string }, stage: string,
  protectedRun: boolean): { code: string; message: string } {
  if (!protectedRun || diagnostic.code !== "CODEX_NATIVE_REJECTED") return diagnostic;
  const finite = protectedStages.includes(stage as ProtectedStage) ? stage : "unknown";
  return { code: diagnostic.code, message: `Native operation rejected during ${finite}` };
}
export function failOnProtectedCredentialExposure(result: WorkerRun, statusFile: string): WorkerRun {
  if (!protectedCredentialExposure(statusFile)) return result;
  return { ...empty(), status: "failed", summary: "Protected synthetic credential appeared in native output",
    error: { code: "CODEX_PROTECTED_SECRET_EXPOSED", message: "Protected synthetic credential appeared in native output" },
    worker_stop: result.worker_stop };
}
export function failOnProtectedTerminalAuth(result: WorkerRun, denied?: AbortSignal): WorkerRun {
  if (!denied?.aborted || result.error?.code === "CODEX_PROTECTED_SECRET_EXPOSED") return result;
  const reason = denied.reason instanceof Error ? denied.reason.message : "";
  const upstream = reason === "CODEX_PROTECTED_UPSTREAM_UNAUTHORIZED";
  const tls = reason === "CODEX_PROTECTED_TLS_REFUSED";
  const code = tls ? "CODEX_PROTECTED_TLS_REFUSED" : upstream ?
    "CODEX_PROTECTED_UPSTREAM_UNAUTHORIZED" : "CODEX_PROTECTED_REFRESH_DENIED";
  const message = tls ? "Protected synthetic TLS session was refused" : upstream ?
    "Protected synthetic inference was unauthorized" : "Protected synthetic token refresh was denied";
  return { ...empty(), status: "failed", summary: message,
    error: { code, message },
    worker_stop: result.worker_stop };
}
/** Retain the namespace handle before an early terminal signal can skip initialize. */
export async function initializeAfterProtectedCapture(launch: Readonly<{ statusFile: string; nativePath: string;
  guestStartPermit?: boolean }> | undefined,
  retain: (captured: Captured) => void, initialize: () => Promise<unknown>, signal: AbortSignal,
  afterCapture?: () => void, capture = captureProtectedStartup,
  startProtectedGuest?: () => Promise<void>): Promise<unknown> {
  if (launch) {
    if (launch.guestStartPermit) {
      if (!startProtectedGuest) throw new BridgeError("CODEX_PROTECTED_LAUNCH_INVALID", "Protected guest start permit is unavailable");
      await startProtectedGuest();
    }
    retain(await capture(launch.statusFile, launch.nativePath));
    afterCapture?.();
    signal.throwIfAborted();
  }
  return initialize();
}
/** One assignment owns a native thread across explicitly requested user turns. */
export class CodexAdapter implements WorkerAdapter {
  /** The optional provider is only for a disposable, fixed-response installed qualification task. */
  constructor(private readonly options: CodexOptions,
    private readonly qualification?: Readonly<{ syntheticProvider: string; allowAnonymous: true;
      relay: Readonly<{ socketPath: string; port: number; tlsProxy?: Readonly<{
        caFile: string; accountHost: string; inferenceHost: string; firstParty?: true; directNoProxy?: true }>;
        startupDiagnostic?: (evidence: StartupStderrEvidence & Readonly<{ exitCode: number | null; exitSignal: NodeJS.Signals | null; exitObserved: boolean }>) => void }>;
      seedFile?: string; failAfterCapture?: true;
      lateExposure?: true; terminalAuthSignal?: AbortSignal }>) {}
  async run(input: WorkerInput): Promise<WorkerRun> {
    if (input.signal.aborted) return { ...empty(), status: "cancelled", summary: "Task cancelled before startup", worker_stop: "not_started" };
    const lifetime = new AbortController(), signal = AbortSignal.any([input.signal, lifetime.signal,
      ...(this.qualification?.terminalAuthSignal ? [this.qualification.terminalAuthSignal] : [])]);
    let transport: CodexStdio | undefined, threadId: string | undefined, current: NativeTurn | undefined, reportedModel: string | undefined;
    let protectedHost: { statusFile: string; nativePath: string } | undefined, protectedCapture: Captured | undefined;
    const protectedRun = input.private_git !== undefined;
    const realProtected = protectedRun && !!this.options.experimental_real_protected;
    let protectedStage = "unknown";
    let protectedCommands = 0;
    const startupStderr = this.qualification?.relay.tlsProxy?.firstParty && this.qualification.relay.startupDiagnostic
      ? new StartupStderrDiagnostic() : undefined;
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
        if (protectedRun) throw new BridgeError("CODEX_INPUT_UNSUPPORTED", "Protected worker received an unqualified input lifecycle event");
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
          await input.onEvent({ kind: "turn_settled", turn_id: turnId, native_session_id: threadId, terminal: terminal === "interrupted" ? "cancelled" : terminal });
          turn.settled = true; turn.finish(terminal);
        }
        return;
      }
      if (turn.settled || turn.terminal && message.method === "item/started") throw new BridgeError("CODEX_PROTOCOL_INVALID", "Native item start or duplicate completion arrived after terminal evidence");
      const event = correlate(message.params, threadId, turnId);
      const item = object(event.item, "item"), kind = text(item.type, "item.type", 128), id = text(item.id, "item.id", 256);
      if ((kind === "mcpToolCall" && (protectedRun || !this.options.use_caller_codex_home)) ||
          ["collabAgentToolCall", "dynamicToolCall"].includes(kind)) throw new BridgeError("CODEX_ISOLATION_VIOLATED",
        `An excluded native item type ${protectedItemType(kind)} was observed; retain the task for inspection`);
      if (kind === "mcpToolCall") assertMcpItemStatus(item, message.method as "item/started" | "item/completed");
      if (protectedRun && !["userMessage", "agentMessage", "commandExecution", "fileChange", "imageView", "reasoning", "plan"].includes(kind)) {
        throw new BridgeError("CODEX_ISOLATION_VIOLATED",
          `An unqualified native item type ${protectedItemType(kind)} was observed in the protected worker`);
      }
      if (protectedRun && kind === "userMessage") {
        // The installed protocol echoes submitted input as a lifecycle item. Its
        // content is neither read nor retained, and it cannot satisfy a tool check.
        if (message.method === "item/started") {
          if (turn.items.has(id) || turn.items.size >= 256) throw new BridgeError("CODEX_PROTOCOL_INVALID", "Duplicate or excessive native item starts");
          protectedUserEcho(message.params, threadId, turnId, "item/started", turn.echo, !!turn.terminal);
          turn.items.set(id, kind);
        } else {
          if (turn.items.get(id) !== kind) throw new BridgeError("CODEX_PROTOCOL_INVALID", "Native input echo lacks a matching start");
          protectedUserEcho(message.params, threadId, turnId, "item/completed", turn.echo, !!turn.terminal);
          turn.items.delete(id);
          if (turn.terminal === "completed" && !turn.items.size) {
            await input.onEvent({ kind: "turn_settled", turn_id: turnId, native_session_id: threadId, terminal: "completed" });
            turn.settled = true; turn.finish("completed");
          }
        }
        return;
      }
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
        if (protectedRun && status === "completed" && item.exitCode === 0) protectedCommands++;
        if (status !== "declined" && item.exitCode !== null && checks.length < 100) checks.push({ command: safeText(text(item.command, "command", 8192), 4096), cwd: text(item.cwd, "cwd"), exit_code: item.exitCode, evidence: "runtime_observed" });
      }
      turn.items.delete(id);
      await input.onEvent({ kind: "operation_finished", id });
      if (turn.terminal === "completed" && !turn.items.size) {
        await input.onEvent({ kind: "turn_settled", turn_id: turnId, native_session_id: threadId, terminal: "completed" });
        turn.settled = true; turn.finish("completed");
      }
    };
    try {
      if (this.options.experimental_real_protected && !protectedRun) {
        throw new BridgeError("CODEX_PRIVATE_GIT_REQUIRED", "Configured real protected Codex requires a prepared private Git view");
      }
      const home = await resolveCodexHome(this.options.codex_home, input.workspace,
        !!this.options.use_caller_codex_home && (!protectedRun || realProtected));
      signal.throwIfAborted();
      if (realProtected && (!this.options.use_caller_codex_home || this.qualification)) {
        throw new BridgeError("CODEX_CONFIGURATION_MISMATCH", "Real protected mode requires caller home without a synthetic qualification provider");
      }
      if (protectedRun && !this.qualification && !realProtected) {
        throw new BridgeError("CODEX_NATIVE_UNSUPPORTED", "Protected real-account Codex has not completed its qualification gate");
      }
      if (protectedRun) {
        const digest = createHash("sha256").update(await readFile(this.options.codex_bin)).digest("hex");
        if (digest !== "3e2584f3f3829a43a0495011a1cecb2facbe64a2403e2b682351fd9c2983f970") {
          throw new BridgeError("CODEX_NATIVE_UNSUPPORTED", "Protected worker requires the qualified installed Codex 0.157.1 executable");
        }
        if (realProtected) {
          const companion = join(dirname(this.options.codex_bin), "codex-code-mode-host");
          const companionDigest = createHash("sha256").update(await readFile(companion)).digest("hex");
          if (companionDigest !== "67b86142bac5cead11b8420cf32d3a2bf88c8868d71733f351ed7c5d95a953e0") {
            throw new BridgeError("CODEX_NATIVE_UNSUPPORTED", "Protected worker requires the matching Codex code mode host");
          }
        }
      }
      const provider = this.qualification?.syntheticProvider ?? "openai";
      if (this.qualification && (!protectedRun || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(provider))) {
        throw new BridgeError("CODEX_CONFIGURATION_MISMATCH", "Synthetic qualification provider is invalid");
      }
      const launch = protectedRun ? protectedLaunch(input, this.options.codex_bin, home,
        fileURLToPath(new URL("./protected-host.js", import.meta.url)),
        [...(this.qualification ? [] : ["-c", 'forced_login_method="chatgpt"']), "-c", 'default_permissions="passeur-boundary"',
          "-c", `model_provider=${JSON.stringify(provider)}`, "-c", "mcp_servers={}",
          "-c", "features.multi_agent=false", "-c", "features.apps=false", "-c", "features.plugins=false",
          "-c", "features.image_generation=false",
          "-c", 'web_search="disabled"', "app-server"],
        this.qualification?.relay, this.qualification?.seedFile, this.qualification?.lateExposure,
        realProtected) : undefined;
      if (launch) protectedHost = { statusFile: launch.statusFile, nativePath: launch.nativePath };
      transport = new CodexStdio({ command: launch?.command ?? this.options.codex_bin,
        args: launch?.args ?? argumentsFor(this.options), cwd: input.workspace, env: launch?.env ?? codexEnvironment(home),
        ...(startupStderr ? { startupStderr } : {}),
        notification: (message) => {
          const turn = current;
          if (!turn) {
            if (protectedRun && ["item/started", "item/completed", "turn/completed", "serverRequest/resolved"].includes(message.method)) {
              throw new BridgeError("CODEX_CORRELATION_INVALID", "Protected native event arrived outside an admitted turn");
            }
            return;
          }
          if (!["item/started", "item/completed", "turn/completed", "serverRequest/resolved"].includes(message.method)) return;
          const pending = events.then(() => handleEvent(message, turn));
          events = pending.catch((error: unknown) => { eventFailure ??= error; });
          return pending;
        },
        request: async (message) => {
          if (protectedRun) throw new BridgeError("CODEX_INPUT_UNSUPPORTED", "Protected worker received an unqualified native input or approval request");
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
      protectedStage = "initialize";
      const initialize = object(await initializeAfterProtectedCapture(launch,
        captured => { protectedCapture = captured; },
        () => transport!.request("initialize", { clientInfo: { name: "passeur_codex_worker", title: "Passeur worker", version: "0.1.0" }, capabilities: { experimentalApi: !!launch } }, signal),
        signal, () => {
          if (this.qualification?.failAfterCapture) throw new BridgeError("CODEX_FIXTURE_STARTUP_FAILURE", "Synthetic fixture stopped after native namespace capture");
        }, (statusFile, nativePath) => captureProtectedStartup(statusFile, nativePath, undefined,
          realProtected ? "inherited" : "isolated"), () => transport!.startProtectedGuest(signal)), "initialize");
      text(initialize.userAgent, "initialize.userAgent", 1024);
      startupStderr?.finish();
      const observedPid = protectedCapture?.nativePid ?? transport.pid;
      if (observedPid !== undefined) {
        const birth = await processIdentity(observedPid);
        await input.onEvent({ kind: "process_observed", ...birth });
      }
      await transport.notify("initialized", undefined, signal);
      protectedStage = "account/read";
      const account = await transport.request("account/read", { refreshToken: false }, signal);
      if (this.qualification) {
        const observed = object(account, "account/read");
        if (this.qualification.seedFile) assertSyntheticSeedAccount(account);
        else if (observed.account !== null || observed.requiresOpenaiAuth !== false) throw new BridgeError("CODEX_AUTH_UNAVAILABLE", "Synthetic qualification must remain anonymous");
      } else assertAccount(account);
      protectedStage = "config/read";
      const config = await transport.request("config/read", { includeLayers: !!launch, cwd: input.workspace }, signal);
      if (launch) {
        assertProtectedConfiguration(config, "passeur-boundary", !!this.qualification,
          { workspace: input.workspace, canonical: input.private_git!.view.canonical_common_dir,
            admin: join(input.private_git!.view.canonical_common_dir, input.private_git!.view.admin_relative),
            native: launch.nativePath,
            ...(this.qualification?.seedFile ? this.qualification.relay.tlsProxy ?
              { tls: this.qualification.relay.tlsProxy, provider } :
              { seededPort: this.qualification.relay.port, provider } : {}) });
        if (object(object(config, "config/read").config, "config").model_provider !== provider) throw new BridgeError("CODEX_CONFIGURATION_MISMATCH", "Protected provider changed before the turn");
        protectedStage = "permissionProfile/list";
        assertProtectedProfile(await transport.request("permissionProfile/list", { cwd: input.workspace }, signal));
        if (realProtected) {
          protectedStage = "skills/list";
          assertEmptySkills(await transport.request("skills/list", { cwds: [input.workspace], forceReload: true }, signal), input.workspace);
        }
      } else assertConfiguration(config, !!this.options.use_caller_codex_home);
      protectedStage = "thread/start";
      const threadResponse = await transport.request("thread/start", launch
        ? { model: this.options.model, modelProvider: provider, cwd: input.workspace, permissions: "passeur-boundary",
          ephemeral: true, allowProviderModelFallback: false }
        : { model: this.options.model, modelProvider: "openai", cwd: input.workspace,
          approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "workspace-write", ephemeral: true }, signal);
      const opened = launch ? protectedThreadStarted(threadResponse, input.workspace, this.options.model, provider)
        : threadStarted(threadResponse, input.workspace, this.options.model, this.options.network_access);
      threadId = opened.threadId; reportedModel = opened.reportedModel;
      protectedStage = "mcpServerStatus/list";
      if (protectedRun || !this.options.use_caller_codex_home) {
        assertNoMcp(await transport.request("mcpServerStatus/list", { threadId, limit: 1 }, signal));
      }
      if (realProtected) {
        protectedStage = "skills/list";
        assertEmptySkills(await transport.request("skills/list", { cwds: [input.workspace], forceReload: true }, signal), input.workspace);
      }
      let prompt = input.prompt;
      let peerTurn: PeerDeliveryEnvelope | undefined;
      let peerTurns = 0;
      let peerOperations = 0;
      let pendingPeerAwait: { case_id: string; operation_key: string } | undefined;
      while (true) {
        signal.throwIfAborted();
        let supersededPeer = false;
        if (peerTurn && !PeerDeliveryNativeSessionIdSchema.safeParse(threadId).success) {
          throw new BridgeError("PEER_DELIVERY_SESSION_ID_UNKNOWN", "Codex did not establish a bounded native thread identity for peer delivery");
        }
        const turn = newTurn(); current = turn;
        protectedStage = "turn/start";
        const id = turnStarted(await transport.request("turn/start", launch
          ? { threadId, permissions: "passeur-boundary", input: [{ type: "text", text: prompt }] }
          : { threadId, input: [{ type: "text", text: prompt }], model: this.options.model, cwd: input.workspace,
            approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", writableRoots: [input.workspace], networkAccess: this.options.network_access } }, signal));
        turn.id = id;
        await input.onEvent({ kind: "turn_started", turn_id: id, native_session_id: threadId });
        // Early native notifications wait on turn.ready. Retain the delivery receipt
        // before releasing them, so an early terminal cannot outrun the receipt.
        try { if (peerTurn) supersededPeer = await input.peer!.delivered(peerTurn.idempotency_key, id, threadId) === "superseded"; }
        finally { turn.open(id); }
        const terminal = await withAbort(Promise.race([turn.done, transport.failure]), signal);
        await events;
        if (eventFailure) throw eventFailure;
        if (transport.operationFailure) throw transport.operationFailure;
        if (!turn.settled) throw new BridgeError("CODEX_SETTLEMENT_UNKNOWN", "Native turn lacks complete settlement evidence");
        if (terminal !== "completed") {
          result = { ...empty(), checks, status: terminal === "interrupted" ? "interrupted" : "failed", summary: `Codex turn ${terminal}`, worker_stop: "unconfirmed", reported_model: reportedModel }; break;
        }
        let message;
        try { message = parseWorkerMessage(turn.report); }
        catch (error) {
          if (!(error instanceof BridgeError) || error.code !== "WORKER_MESSAGE_INVALID") throw error;
          if (peerTurn) throw new BridgeError("PEER_DELIVERY_OBSERVATION_MISSING", "Peer turn did not provide an exact disposition receipt");
          prompt = await withAbort(Promise.race([input.input("The completed native turn has no valid assignment disposition. Supply an explicit continuation instruction, or cancel the task.", true, undefined, undefined, signal), transport.failure]), signal);
          continue;
        }
        if (peerTurn) {
          if (message.peer_observed !== peerTurn.idempotency_key) {
            throw new BridgeError("PEER_DELIVERY_OBSERVATION_MISSING", "Peer turn did not acknowledge the exact delivered envelope");
          }
          supersededPeer = await input.peer!.observed(peerTurn.idempotency_key, id, threadId) === "superseded" || supersededPeer;
          peerTurn = undefined;
        }
        if (supersededPeer) {
          pendingPeerAwait = undefined;
          prompt = peerSupersededPrompt();
          continue;
        }
        if (message.kind === "peer_proposal_invalid") {
          if (pendingPeerAwait) throw new BridgeError("PEER_OPERATION_PENDING", "A pending peer await requires its exact retained continuation key");
          if (++peerOperations > 64) throw new BridgeError("PEER_OPERATION_CAPACITY", "Peer operation turn limit exceeded");
          prompt = peerProposalCorrectionPrompt(message.operation_kind, "The proposal fields violate the canonical worker contract");
          continue;
        }
        if (message.kind === "peer_operation") {
          if (!input.peer?.operation) throw new BridgeError("PEER_OPERATION_UNAVAILABLE", "This task has no authorized peer operation port");
          if (pendingPeerAwait && (message.operation.kind !== "await_change" ||
              message.operation.case_id !== pendingPeerAwait.case_id || message.operation.operation_key !== pendingPeerAwait.operation_key)) {
            throw new BridgeError("PEER_OPERATION_PENDING", "A pending peer await requires its exact retained continuation key");
          }
          if (++peerOperations > 64) throw new BridgeError("PEER_OPERATION_CAPACITY", "Peer operation turn limit exceeded");
          let operationResult;
          try { operationResult = await withAbort(Promise.race([input.peer.operation(message.operation), transport.failure]), signal); }
          catch (error) {
            const reason = message.operation.kind === "propose" || message.operation.kind === "counter_propose"
              ? peerProposalRejection(error) : undefined;
            if (!reason || message.operation.kind !== "propose" && message.operation.kind !== "counter_propose") throw error;
            prompt = peerProposalCorrectionPrompt(message.operation.kind, reason);
            continue;
          }
          prompt = peerOperationResultPrompt(input.task_id, message.operation, operationResult);
          pendingPeerAwait = operationResult.kind === "pending"
            ? { case_id: message.operation.case_id, operation_key: message.operation.operation_key } : undefined;
          continue;
        }
        if (pendingPeerAwait && message.kind === "final") throw new BridgeError("PEER_OPERATION_PENDING", "Pending peer change cannot be reported as completed work");
        if (message.kind === "input_required") {
          prompt = await withAbort(Promise.race([input.input(message.question, false, undefined, undefined, signal), transport.failure]), signal);
          continue;
        }
        if (message.kind === "blocked") {
          result = { ...empty(), status: "blocked", summary: message.reason, blockers: [message.reason], checks, worker_stop: "unconfirmed", reported_model: reportedModel }; break;
        }
        if (input.peer) {
          const next = await input.peer.next();
          if (next) {
            if (++peerTurns > 64) throw new BridgeError("PEER_DELIVERY_CAPACITY", "Peer continuation turn limit exceeded");
            prompt = peerPrompt(next);
            peerTurn = next;
            continue;
          }
        }
        const report = finalReport(message);
        if (protectedRun && protectedCommands === 0) throw new BridgeError("CODEX_PROTECTED_EFFECT_UNOBSERVED", "Protected worker did not emit a successful native command operation");
        result = { ...report, checks: [...checks, ...report.checks], status: "completed", worker_stop: "unconfirmed", reported_model: reportedModel }; break;
      }
    } catch (error) {
      const baseDiagnostic = error instanceof BridgeError ? errorInfo(error) : { code: "CODEX_RUNTIME_ERROR", message: "Native operation failed; raw diagnostics were not retained" };
      const diagnostic = protectedNativeRejection(baseDiagnostic, protectedStage, protectedRun);
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
      if (transport) {
        let closed = false;
        try {
          closed = transport.started ? await transport.close(Math.max(1, deadline - Date.now()),
            protectedHost ? Math.max(1, input.policy.stop_grace_ms / 2) : 250) : false;
        } catch { /* The captured namespace still requires its independent stop audit. */ }
        result.worker_stop = transport.started ? (protectedHost
          ? await settleProtectedStop(protectedCapture, protectedHost.statusFile, closed)
          : closed ? "confirmed" : "unconfirmed") : "not_started";
      }
      if (startupStderr && this.qualification?.relay.startupDiagnostic) {
        const exit = transport?.exitEvidence;
        try { this.qualification.relay.startupDiagnostic({ ...startupStderr.finish(), exitObserved: exit !== undefined,
          exitCode: exit?.code ?? null, exitSignal: exit?.signal ?? null }); }
        catch { /* Diagnostic reporting cannot change the native outcome. */ }
      }
      if (protectedHost && this.qualification?.seedFile) {
        result = failOnProtectedCredentialExposure(result, protectedHost.statusFile);
      }
      if (protectedHost && this.qualification?.relay.tlsProxy &&
          protectedSeedAdmissionRefused(protectedHost.statusFile)) {
        result = { ...empty(), status: "failed", summary: "Protected synthetic access token is stale",
          error: { code: "CODEX_PROTECTED_AUTH_STALE", message: "Protected synthetic access token is stale" },
          worker_stop: transport?.exitEvidence && !protectedCapture ? "not_started" : "unconfirmed" };
      }
      result = failOnProtectedTerminalAuth(result, this.qualification?.terminalAuthSignal);
    }
    return result;
  }
}
type NativeTurn = { id?: string; ready: Promise<string>; open: (id: string) => void; done: Promise<Terminal>; finish: (value: Terminal) => void;
  terminal?: Terminal; settled?: boolean; report?: string; items: Map<string, string>; echo: { id?: string; completed?: boolean } };
function newTurn(): NativeTurn {
  let open!: NativeTurn["open"], finish!: NativeTurn["finish"];
  const ready = new Promise<string>((yes) => { open = yes; });
  const done = new Promise<Terminal>((yes) => { finish = yes; });
  return { ready, open, done, finish, items: new Map(), echo: {} };
}
