import type { Socket } from "node:net";
import { TextDecoder } from "node:util";
import { BridgeError } from "../core/errors.js";

export type Frame =
  | { kind: "hello"; protocol: 1; token: string; owner_token: string; repository_id: string; profile_path?: string; source_view: string; state_root: string }
  | { kind: "welcome"; protocol: 1; generation: string; client_id: string }
  | { kind: "request"; id: string; generation: string; operation: string; arguments: unknown }
  | { kind: "response"; id: string; generation: string; result: unknown }
  | { kind: "failure"; id: string; generation: string; error: { code: string; message: string } }
  | { kind: "cancel_wait"; id: string; generation: string };
const MAX_FRAME = 1_048_576, MAX_BUFFERED_WRITE = 4 * MAX_FRAME, MAX_CALLBACKS = 64;
function record(v: unknown): v is Record<string, unknown> { return typeof v === "object" && v !== null && !Array.isArray(v); }
function string(v: unknown, max = 4096): v is string { return typeof v === "string" && v.length > 0 && v.length <= max; }
/** Envelope decoding is transport proof only. The receiver still decodes the selected operation. */
export function decodeFrame(value: unknown): Frame {
  if (!record(value) || !string(value.kind, 32)) throw new BridgeError("SERVICE_FRAME_INVALID", "Invalid IPC envelope");
  const extra = (allowed: string[]) => Object.keys(value).some((key) => !allowed.includes(key));
  if (value.kind === "hello") {
    if (extra(["kind", "protocol", "token", "owner_token", "repository_id", "profile_path", "source_view", "state_root"]) || value.protocol !== 1 ||
      !string(value.token, 64) || !/^[a-f0-9]{64}$/.test(value.token) || !string(value.owner_token, 64) || !/^[a-f0-9]{64}$/.test(value.owner_token) ||
      !string(value.repository_id, 256) || !string(value.source_view) || !string(value.state_root) || value.profile_path !== undefined && !string(value.profile_path)) throw new BridgeError("SERVICE_HANDSHAKE_INVALID", "Unsupported or invalid service handshake");
    return { kind: "hello", protocol: 1, token: value.token, owner_token: value.owner_token, repository_id: value.repository_id,
      source_view: value.source_view, state_root: value.state_root, ...(value.profile_path === undefined ? {} : { profile_path: value.profile_path }) };
  }
  if (value.kind === "welcome") {
    if (extra(["kind", "protocol", "generation", "client_id"]) || value.protocol !== 1 || !string(value.generation, 64) || !string(value.client_id, 64)) throw new BridgeError("SERVICE_HANDSHAKE_INVALID", "Invalid service welcome");
    return { kind: "welcome", protocol: 1, generation: value.generation, client_id: value.client_id };
  }
  if (!string(value.id, 128) || !string(value.generation, 64)) throw new BridgeError("SERVICE_FRAME_INVALID", "IPC correlation is invalid");
  if (value.kind === "cancel_wait" && !extra(["kind", "id", "generation"])) return { kind: "cancel_wait", id: value.id, generation: value.generation };
  if (value.kind === "request" && !extra(["kind", "id", "generation", "operation", "arguments"]) && string(value.operation, 128) && "arguments" in value) return { kind: "request", id: value.id, generation: value.generation, operation: value.operation, arguments: value.arguments };
  if (value.kind === "response" && !extra(["kind", "id", "generation", "result"]) && "result" in value) return { kind: "response", id: value.id, generation: value.generation, result: value.result };
  if (value.kind === "failure" && !extra(["kind", "id", "generation", "error"]) && record(value.error) && Object.keys(value.error).every((k) => k === "code" || k === "message") && string(value.error.code, 128) && string(value.error.message, 2048)) return { kind: "failure", id: value.id, generation: value.generation, error: { code: value.error.code, message: value.error.message } };
  throw new BridgeError("SERVICE_FRAME_INVALID", "Invalid IPC variant");
}
/** Bounded JSON-lines framing. It has no task, permission or retry policy. */
export class IpcConnection {
  #buffer = Buffer.alloc(0);
  #callbacks = new Set<Promise<void>>();
  #writes = new Set<Promise<void>>();
  #closed = false;
  #fault: unknown;
  readonly closed: Promise<void>;
  #finish!: () => void;
  constructor(readonly socket: Socket, readonly receive: (frame: Frame) => Promise<void> | void, readonly onClosed: () => void = () => {}) {
    this.closed = new Promise<void>((resolve) => { this.#finish = resolve; });
    socket.on("data", (chunk: Buffer) => this.#consume(chunk));
    socket.on("error", (error) => this.close(error));
    socket.on("end", () => this.close(this.#buffer.length ? new BridgeError("SERVICE_FRAME_INVALID", "IPC input ended inside a frame") : undefined));
    socket.on("close", () => {
      if (!this.#closed) this.close();
      this.#finish();
    });
  }
  get isClosed(): boolean { return this.#closed; }
  get error(): unknown { return this.#fault; }
  #consume(chunk: Buffer): void {
    if (this.#closed) return;
    // Inspect frame boundaries before accumulating an unbounded caller-supplied buffer.
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf(10, start), stop = end < 0 ? chunk.length : end;
      if (this.#buffer.length + stop - start > MAX_FRAME) { this.close(new BridgeError("SERVICE_FRAME_LIMIT", "IPC frame exceeds its bound")); return; }
      this.#buffer = Buffer.concat([this.#buffer, chunk.subarray(start, stop)]);
      if (end < 0) return;
      const bytes = this.#buffer; this.#buffer = Buffer.alloc(0); start = end + 1;
      try {
        const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        const frame = decodeFrame(value);
        if (this.#callbacks.size >= MAX_CALLBACKS) throw new BridgeError("SERVICE_CALLBACK_LIMIT", "IPC connection callback capacity is full");
        const work = Promise.resolve().then(() => this.receive(frame)).catch((error) => this.close(error)).finally(() => this.#callbacks.delete(work));
        this.#callbacks.add(work);
      } catch (error) { this.close(error instanceof BridgeError ? error : new BridgeError("SERVICE_FRAME_INVALID", "IPC input is not valid bounded JSON")); return; }
    }
  }
  send(frame: Frame): Promise<void> {
    if (this.#closed) return Promise.reject(new BridgeError("SERVICE_CONNECTION_CLOSED", "The service connection is closed"));
    decodeFrame(frame);
    const bytes = Buffer.from(`${JSON.stringify(frame)}\n`);
    if (bytes.length > MAX_FRAME || this.socket.writableLength + bytes.length > MAX_BUFFERED_WRITE || this.#writes.size >= MAX_CALLBACKS) {
      this.close(new BridgeError("SERVICE_OUTPUT_LIMIT", "The observer is not consuming bounded responses"));
      return Promise.reject(new BridgeError("SERVICE_OUTPUT_LIMIT", "The observer connection exceeded its output capacity"));
    }
    const work = new Promise<void>((resolve, reject) => { this.socket.write(bytes, (error) => error ? reject(new BridgeError("SERVICE_WRITE_FAILED", "IPC response delivery failed")) : resolve()); });
    this.#writes.add(work);
    void work.then(() => this.#writes.delete(work), (error) => { this.#writes.delete(work); this.close(error); });
    return work;
  }
  close(error?: unknown): void {
    if (this.#closed) return;
    this.#closed = true; this.#fault = error;
    this.socket.destroy(); this.onClosed();
  }
  async drain(): Promise<void> { await Promise.allSettled([...this.#callbacks, ...this.#writes]); }
}
