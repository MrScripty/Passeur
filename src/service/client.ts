import { createConnection } from "node:net";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { operationSchemas, responseSchemas, type Operation, type Response, type ServiceDescriptor, type FrontendStatus } from "../contracts/service.js";
import { RepositoryRuntime, resolveRepositoryBinding, type LaunchIntent, type ResolvedBinding } from "../core/repository-runtime.js";
import type { RuntimeIdentity } from "../contracts/runtime.js";
import type { ResultRequest } from "../contracts/types.js";
import { BridgeError, diagnosticInfo } from "../core/errors.js";
import { withAbort } from "../core/async.js";
import { textChunk } from "../core/result.js";
import { IpcConnection, type Frame } from "./transport.js";
import { readDescriptor, existingOwner, launchService, type LaunchReservation } from "./bootstrap.js";

type Pending = { operation: Operation; resolve: (value: unknown) => void; reject: (error: unknown) => void };
export class ServiceClient {
  readonly #pending = new Map<string, Pending>();
  readonly connection: IpcConnection;
  readonly ready: Promise<void>;
  #resolveReady!: () => void;
  #rejectReady!: (error: unknown) => void;
  #clientId: string | undefined;
  constructor(readonly descriptor: ServiceDescriptor, binding: ResolvedBinding, ownerToken: string) {
    this.ready = new Promise<void>((yes, no) => { this.#resolveReady = yes; this.#rejectReady = no; }); this.ready.catch(() => undefined);
    const socket = createConnection(descriptor.endpoint);
    this.connection = new IpcConnection(socket, (frame: Frame) => {
      if (frame.kind === "welcome" && !this.#clientId) {
        if (frame.generation !== descriptor.generation) throw new BridgeError("SERVICE_GENERATION_CHANGED", "The endpoint belongs to another service generation");
        this.#clientId = frame.client_id; this.#resolveReady(); return;
      }
      if (!this.#clientId || (frame.kind !== "response" && frame.kind !== "failure") || frame.generation !== descriptor.generation) throw new BridgeError("SERVICE_FRAME_INVALID", "Unexpected or stale service response");
      const request = this.#pending.get(frame.id);
      if (!request) throw new BridgeError("SERVICE_CORRELATION_INVALID", "Service response has no outstanding request");
      this.#pending.delete(frame.id);
      if (frame.kind === "failure") { request.reject(new BridgeError(frame.error.code, frame.error.message)); return; }
      const parsed = responseSchemas[request.operation].safeParse(frame.result);
      if (!parsed.success) { request.reject(new BridgeError("SERVICE_RESULT_INVALID", "The service response violates the requested operation contract")); return; }
      request.resolve(parsed.data);
    }, () => {
      const failure = new BridgeError("SERVICE_DISCONNECTED", "Service observation was lost; recover accepted operations by their original keys");
      this.#rejectReady(failure);
      for (const request of this.#pending.values()) request.reject(failure);
      this.#pending.clear();
    });
    socket.once("connect", () => {
      void this.connection.send({ kind: "hello", protocol: 1, token: descriptor.token, owner_token: ownerToken,
        repository_id: binding.repositoryId, state_root: binding.stateRoot, source_view: binding.project,
        ...(binding.profilePath ? { profile_path: binding.profilePath } : {}) }).catch((error) => this.connection.close(error));
    });
  }
  async call<K extends Operation>(operation: K, args: unknown, signal?: AbortSignal): Promise<Response<K>> {
    signal?.throwIfAborted(); await withAbort(this.ready, signal); signal?.throwIfAborted();
    const parsed = operationSchemas[operation].safeParse(args);
    if (!parsed.success) throw new BridgeError("SERVICE_ARGUMENT_INVALID", "Operation arguments do not satisfy their contract");
    if (this.#pending.size >= 32) throw new BridgeError("SERVICE_REQUEST_LIMIT", "The front end already has its maximum outstanding requests");
    const id = randomUUID();
    let resolve!: Pending["resolve"], reject!: Pending["reject"];
    const result = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; }); result.catch(() => undefined);
    this.#pending.set(id, { operation, resolve, reject });
    const abort = () => { void this.connection.send({ kind: "cancel_wait", id, generation: this.descriptor.generation }).catch(() => undefined); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const writing = this.connection.send({ kind: "request", id, generation: this.descriptor.generation, operation, arguments: parsed.data });
      void writing.catch((error) => this.connection.close(error));
      await withAbort(writing, signal);
      if (signal?.aborted) abort();
      // The pending ID remains reserved after detachment until a reply or closure accounts for it.
      return await withAbort(result, signal) as Response<K>;
    } finally { signal?.removeEventListener("abort", abort); }
  }
  close(): void { this.connection.close(); }
}
/** One host connection. Its owner token survives IPC reconnects, but is never exposed to the model. */
export class PasseurFrontend {
  readonly #ownerToken: string;
  readonly #lifetime = new AbortController();
  readonly #history: RepositoryRuntime;
  #client: ServiceClient | undefined;
  #connecting: Promise<ServiceClient> | undefined;
  #binding: ResolvedBinding | undefined;
  #lastStatus: Response<"status"> | undefined;
  #failure: { code: string; message: string } | undefined;
  constructor(readonly intent: LaunchIntent, readonly identity: RuntimeIdentity, readonly exactCli: string, ownerToken = randomBytes(32).toString("hex")) {
    if (!/^[a-f0-9]{64}$/.test(ownerToken)) throw new BridgeError("CONTROL_CREDENTIAL_INVALID", "Invalid private control credential");
    this.#ownerToken = ownerToken;
    this.#history = new RepositoryRuntime(intent, identity);
  }
  async #resolve(): Promise<ResolvedBinding> {
    return this.#binding ??= await resolveRepositoryBinding(this.intent, process.env, this.#lifetime.signal);
  }
  status(): FrontendStatus {
    return { schema_version: 2, frontend: this.identity, binding: { project_input: this.intent.project,
      ...(this.intent.profilePath ? { profile_path: this.intent.profilePath } : {}), ...(this.intent.stateRoot ? { state_root: this.intent.stateRoot } : {}),
      ...(this.intent.expectedRepositoryId ? { expected_repository_id: this.intent.expectedRepositoryId } : {}) },
      service: this.#client?.connection.isClosed ? { state: "unavailable", code: "SERVICE_DISCONNECTED", message: "The previous service observation is stale" }
        : this.#lastStatus ? { state: "connected", status: this.#lastStatus } : this.#failure ? { state: "unavailable", ...this.#failure } : { state: "not_checked" } };
  }
  async observeStatus(signal?: AbortSignal): Promise<FrontendStatus> {
    if (this.#client && !this.#client.connection.isClosed) {
      try { this.#lastStatus = await this.#client.call("status", {}, signal); }
      catch (error) { const info = diagnosticInfo(error); this.#failure = { code: info.code, message: info.message }; this.#lastStatus = undefined; }
    }
    return this.status();
  }
  async #connect(): Promise<ServiceClient> {
    this.#lifetime.signal.throwIfAborted();
    if (this.#client && !this.#client.connection.isClosed) return this.#client;
    if (this.#connecting) return this.#connecting;
    const attempt = (async () => {
      const binding = await this.#resolve();
      let descriptor = await readDescriptor(binding), reservation: LaunchReservation | undefined;
      if (descriptor && await existingOwner(descriptor) && descriptor.profile_path !== binding.profilePath) throw new BridgeError("SERVICE_PROFILE_CONFLICT", "Use the same approved profile path for clients of this repository service");
      const live = descriptor ? await existingOwner(descriptor) : false;
      if (!live) reservation = await launchService(binding, this.exactCli);
      const budget = AbortSignal.timeout(10_000), signal = AbortSignal.any([budget, this.#lifetime.signal]);
      let candidate: ServiceClient | undefined;
      try {
        while (true) {
          signal.throwIfAborted();
          descriptor = await readDescriptor(binding);
          if (descriptor && await existingOwner(descriptor)) {
            if (descriptor.profile_path !== binding.profilePath) throw new BridgeError("SERVICE_PROFILE_CONFLICT", "The elected service has a different approved profile");
            if (descriptor.runtime.build_id !== this.identity.build_id) throw new BridgeError("SERVICE_BUILD_CONFLICT", "The running service uses another build; drain it explicitly before a controlled upgrade");
            candidate = new ServiceClient(descriptor, binding, this.#ownerToken);
            await withAbort(candidate.ready, signal);
            const status = await candidate.call("status", {}, signal);
            this.#lastStatus = status; this.#failure = undefined; this.#client = candidate;
            return candidate;
          }
          if (reservation) await Promise.race([delay(25, undefined, { signal }), reservation.failure]);
          else throw new BridgeError("SERVICE_UNAVAILABLE", "The previously observed service is unavailable; retry attachment without deleting its lock or endpoint");
        }
      } catch (error) {
        candidate?.close();
        const info = budget.aborted && !this.#lifetime.signal.aborted ? { code: "SERVICE_ATTACH_UNAVAILABLE", message: "Service attachment exceeded its observation budget; no running task was cancelled" } : diagnosticInfo(error);
        this.#failure = { code: info.code, message: info.message }; throw new BridgeError(info.code, info.message);
      } finally { reservation?.released(); }
    })();
    this.#connecting = attempt;
    void attempt.then(() => { if (this.#connecting === attempt) this.#connecting = undefined; }, () => { if (this.#connecting === attempt) this.#connecting = undefined; });
    return attempt;
  }
  async call<K extends Operation>(operation: K, args: unknown, signal?: AbortSignal): Promise<Response<K>> {
    const client = await withAbort(this.#connect(), signal);
    const result = await client.call(operation, args, signal);
    if (operation === "status" || operation === "prepare") this.#lastStatus = result as Response<"status">;
    return result;
  }
  async agents(offset: number, limit: number, signal?: AbortSignal) {
    if (this.#client && !this.#client.connection.isClosed) return this.#client.call("agents", { offset, limit }, signal);
    return this.#history.agents(offset, limit);
  }
  async retained(request: ResultRequest) {
    // An immutable historical read remains possible without starting a provider or acquiring a service lease.
    const id = request.task_id ?? await this.#history.retainedTaskId(request.request_key!);
    await this.#history.authorizeTask(id, { owner_id: createHash("sha256").update(this.#ownerToken).digest("hex"), client_id: randomUUID() });
    const result = await this.#history.retained(request), chunk = textChunk(result.buffer, result.buffer.length, request.encoding);
    return { task_id: result.task_id, offset: request.offset, bytes: chunk.bytes, next_offset: request.offset + chunk.bytes,
      eof: result.buffer.length === 0, encoding: request.encoding, content: chunk.content };
  }
  async shutdown(): Promise<void> {
    this.#lifetime.abort(new BridgeError("FRONTEND_CLOSED", "The front end detached"));
    this.#client?.close();
    if (this.#connecting) await this.#connecting.catch(() => undefined);
    this.#client?.close(); await this.#history.shutdown();
  }
}
