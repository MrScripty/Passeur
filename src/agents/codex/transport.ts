import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { TextDecoder } from "node:util";
import { BridgeError } from "../../core/errors.js";
import { settlesWithin, withAbort } from "../../core/async.js";

const MAX_FRAME_BYTES = 1_048_576;
const MAX_PENDING_REQUESTS = 32;
const MAX_CALLBACKS = 32;
type Id = string | number;
export type NativeMessage = { method: string; params: unknown; id?: Id };
type Response = { id: Id; result: unknown } | { id: Id; error: { code: number; message: string } };
type Pending = { resolve: (value: unknown) => void; reject: (error: unknown) => void };
export type TransportOptions = {
  command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv;
  request: (message: NativeMessage & { id: Id }) => Promise<unknown>;
  notification: (message: NativeMessage) => void | Promise<void>;
};
const idKey = (id: Id) => `${typeof id}:${id}`;
function id(value: unknown): value is Id {
  return (typeof value === "string" && value.length > 0 && value.length <= 256) || (typeof value === "number" && Number.isSafeInteger(value));
}
/** Codex's stdio framing is JSON-lines, without a jsonrpc field. Payload proof belongs to each operation. */
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
export function decodeEnvelope(value: unknown): NativeMessage | Response {
  if (!record(value)) throw new BridgeError("CODEX_PROTOCOL_INVALID", "Native frame must be an object");
  const frame: Record<string, unknown> = value;
  if ("method" in frame) {
    if (typeof frame.method !== "string" || !frame.method || frame.method.length > 256 ||
        Object.keys(frame).some((key) => !["method", "params", "id"].includes(key)) ||
        ("id" in frame && !id(frame.id))) throw new BridgeError("CODEX_PROTOCOL_INVALID", "Invalid native request envelope");
    return { method: frame.method, params: frame.params, ...("id" in frame ? { id: frame.id as Id } : {}) };
  }
  if (!id(frame.id) || Object.keys(frame).some((key) => !["id", "result", "error"].includes(key)) ||
      Number("result" in frame) + Number("error" in frame) !== 1) throw new BridgeError("CODEX_PROTOCOL_INVALID", "Invalid native response envelope");
  if ("result" in frame) return { id: frame.id, result: frame.result };
  const error = frame.error;
  if (typeof error !== "object" || error === null || Array.isArray(error) || !("code" in error) ||
      typeof error.code !== "number" || !Number.isSafeInteger(error.code) || !("message" in error) || typeof error.message !== "string") {
    throw new BridgeError("CODEX_PROTOCOL_INVALID", "Invalid native error envelope");
  }
  // Native error data is deliberately not exposed to ordinary diagnostics.
  return { id: frame.id, error: { code: error.code, message: "Codex rejected the native operation" } };
}

/** One task owns this Linux process group, its RPCs, stream buffers and callbacks. No daemon attachment. */
export class CodexStdio {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<string, Pending>();
  readonly #callbacks = new Set<Promise<void>>();
  readonly #writes = new Set<Promise<void>>();
  readonly #serverRequests = new Set<string>();
  readonly #options: TransportOptions;
  readonly #exit: Promise<void>;
  readonly #ready: Promise<void>;
  readonly failure: Promise<never>;
  #fail!: (error: unknown) => void;
  #fault: unknown;
  #operationFault: unknown;
  #buffer: Buffer = Buffer.alloc(0);
  #sequence = 0;
  #closing: Promise<boolean> | undefined;
  #closed = false;
  #accepting = true;
  constructor(options: TransportOptions) {
    if (process.platform !== "linux") throw new BridgeError("CODEX_PLATFORM_UNSUPPORTED", "Codex process-group supervision is currently implemented for Linux");
    this.#options = options;
    this.failure = new Promise<never>((_resolve, reject) => { this.#fail = reject; });
    this.failure.catch(() => undefined);
    this.#child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, stdio: "pipe", detached: true, shell: false });
    this.#ready = new Promise<void>((resolve, reject) => {
      this.#child.once("spawn", resolve);
      this.#child.once("error", () => reject(new BridgeError("CODEX_START_FAILED", "Codex could not start from the configured executable and workspace")));
    });
    this.#ready.catch(() => undefined);
    this.#exit = new Promise<void>((resolve) => {
      this.#child.once("close", () => {
        this.#closed = true;
        if (this.#buffer.length) this.#failAll(new BridgeError("CODEX_PROTOCOL_INVALID", "Native output ended with an incomplete frame"));
        else if (this.#accepting) this.#failAll(new BridgeError("CODEX_RUNTIME_EXITED", "Codex exited before the owned operation ended"));
        resolve();
      });
    });
    this.#child.once("error", () => this.#failAll(new BridgeError("CODEX_START_FAILED", "Codex could not start from the configured executable and workspace")));
    this.#child.stdin.on("error", () => { if (this.#accepting) this.#failAll(new BridgeError("CODEX_WRITE_FAILED", "Native input stream failed")); });
    this.#child.stdout.on("error", () => this.#failAll(new BridgeError("CODEX_READ_FAILED", "Native output stream failed")));
    this.#child.stdout.on("data", (chunk: Buffer) => this.#consume(chunk));
    // Drain without retaining raw authentication, prompts, filesystem content or diagnostics.
    this.#child.stderr.on("data", () => undefined);
    this.#child.stderr.on("error", () => this.#failAll(new BridgeError("CODEX_READ_FAILED", "Native diagnostic stream failed")));
  }
  get operationFailure(): unknown { return this.#operationFault; }
  get started(): boolean { return this.#child.pid !== undefined; }
  get pid(): number | undefined { return this.#child.pid; }
  #failAll(error: unknown): void {
    if (this.#accepting) this.#operationFault ??= error;
    this.#fault ??= error;
    for (const pending of this.#pending.values()) pending.reject(this.#fault);
    this.#pending.clear();
    this.#fail(this.#fault);
  }
  #consume(chunk: Buffer): void {
    if (this.#fault) return;
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    try {
      let end: number;
      while ((end = this.#buffer.indexOf(10)) >= 0) {
        if (end > MAX_FRAME_BYTES) throw new BridgeError("CODEX_FRAME_TOO_LARGE", "Native frame exceeds the supported limit");
        const line = this.#buffer.subarray(0, end); this.#buffer = this.#buffer.subarray(end + 1);
        if (line.length === 0) throw new BridgeError("CODEX_PROTOCOL_INVALID", "Native output contains an empty frame");
        let raw: unknown;
        try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)); }
        catch { throw new BridgeError("CODEX_PROTOCOL_INVALID", "Native output contains invalid UTF-8 or JSON"); }
        this.#dispatch(decodeEnvelope(raw));
      }
      if (this.#buffer.length > MAX_FRAME_BYTES) throw new BridgeError("CODEX_FRAME_TOO_LARGE", "Unterminated native frame exceeds the supported limit");
    } catch (error) { this.#buffer = Buffer.alloc(0); this.#failAll(error); }
  }
  #dispatch(message: NativeMessage | Response): void {
    if (!("method" in message)) {
      const pending = this.#pending.get(idKey(message.id));
      if (!pending) throw new BridgeError("CODEX_PROTOCOL_INVALID", "Native response has no matching request");
      this.#pending.delete(idKey(message.id));
      if ("error" in message) pending.reject(new BridgeError("CODEX_NATIVE_REJECTED", message.error.message));
      else pending.resolve(message.result);
      return;
    }
    if (!this.#accepting) return;
    if (this.#callbacks.size >= MAX_CALLBACKS) throw new BridgeError("CODEX_CALLBACK_OVERLOAD", "Native callbacks exceeded the owned capacity");
    const requestId = message.id;
    if (requestId !== undefined) {
      const key = idKey(requestId);
      if (this.#serverRequests.has(key)) throw new BridgeError("CODEX_PROTOCOL_INVALID", "Native approval/request ID was reused while outstanding");
      this.#serverRequests.add(key);
    }
    const notification = requestId === undefined ? this.#options.notification(message) : undefined;
    if (requestId === undefined && notification === undefined) return;
    const callback = Promise.resolve().then(async () => {
      if (requestId === undefined) await notification;
      else {
        try {
          const result = await this.#options.request({ ...message, id: requestId });
          if (this.#accepting) await this.#write({ id: requestId, result });
        } catch (error) {
          if (this.#accepting) await this.#write({ id: requestId, error: { code: -32602, message: "Passeur refused this native request" } });
          throw error;
        }
      }
    }).catch((error) => this.#failAll(error)).finally(() => {
      this.#callbacks.delete(callback);
      if (requestId !== undefined) this.#serverRequests.delete(idKey(requestId));
    });
    this.#callbacks.add(callback);
  }
  #write(frame: unknown): Promise<void> {
    if (this.#fault) return Promise.reject(this.#fault);
    if (!this.#accepting || this.#closed) return Promise.reject(new BridgeError("CODEX_TRANSPORT_CLOSED", "Native transport is closing"));
    const bytes = Buffer.from(`${JSON.stringify(frame)}\n`, "utf8");
    if (bytes.length > MAX_FRAME_BYTES) return Promise.reject(new BridgeError("CODEX_FRAME_TOO_LARGE", "Outbound native frame exceeds the supported limit"));
    const writing = new Promise<void>((resolve, reject) => {
      this.#child.stdin.write(bytes, (error) => error ? reject(new BridgeError("CODEX_WRITE_FAILED", "Native input write failed")) : resolve());
    });
    this.#writes.add(writing);
    void writing.then(() => this.#writes.delete(writing), () => this.#writes.delete(writing));
    return writing;
  }
  async request(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    await withAbort(this.#ready, signal);
    if (this.#pending.size >= MAX_PENDING_REQUESTS) throw new BridgeError("CODEX_REQUEST_OVERLOAD", "Native request capacity exceeded");
    if (!this.#accepting || this.#fault) throw this.#fault ?? new BridgeError("CODEX_TRANSPORT_CLOSED", "Native transport is closing");
    if (this.#sequence === Number.MAX_SAFE_INTEGER) throw new BridgeError("CODEX_REQUEST_OVERLOAD", "Native request identity space exhausted");
    const requestId = `passeur:${++this.#sequence}`;
    let resolve!: Pending["resolve"], reject!: Pending["reject"];
    const response = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
    response.catch(() => undefined);
    this.#pending.set(idKey(requestId), { resolve, reject });
    const writing = this.#write({ id: requestId, method, params });
    // A detached writer remains tracked. Its late failure is not discarded, and its
    // request ID remains reserved until response or close because publication may have occurred.
    void writing.catch((error) => this.#failAll(error));
    await withAbort(writing, signal);
    // Cancellation detaches this wait; the owned RPC remains observed until reply or transport close.
    return withAbort(response, signal);
  }
  async notify(method: string, params: unknown, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await withAbort(this.#ready, signal);
    const writing = this.#write({ method, ...(params === undefined ? {} : { params }) });
    void writing.catch((error) => this.#failAll(error));
    return withAbort(writing, signal);
  }
  #groupGone(): boolean {
    const pid = this.#child.pid;
    if (pid === undefined) return this.#closed;
    try { process.kill(-pid, 0); return false; }
    catch (error) { return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH"; }
  }
  close(graceMs: number): Promise<boolean> {
    return this.#closing ??= (async () => {
      this.#accepting = false;
      this.#failAll(new BridgeError("CODEX_TRANSPORT_CLOSED", "Native transport closed"));
      const deadline = Date.now() + Math.max(1, graceMs);
      this.#child.stdin.end();
      await settlesWithin(this.#exit, Math.min(250, Math.max(1, graceMs / 4)));
      if (!this.#closed && this.#child.pid !== undefined) {
        try { this.#child.kill("SIGTERM"); }
        catch (error) {
          if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH")) return false;
        }
      }
      await settlesWithin(this.#exit, Math.max(1, deadline - Date.now()));
      const callbacksStopped = await settlesWithin(Promise.allSettled([...this.#callbacks, ...this.#writes]), Math.max(1, deadline - Date.now()));
      // Signal only the owned ChildProcess handle, not a possibly recycled PGID after parent exit.
      // Remaining descendants make shutdown unconfirmed; there is no guessed group kill or SIGKILL fallback.
      const confirmed = this.#closed && this.#groupGone() && callbacksStopped;
      if (!confirmed) {
        this.#child.unref(); this.#child.stdin.destroy(); this.#child.stdout.destroy(); this.#child.stderr.destroy();
      }
      return confirmed;
    })();
  }
}
