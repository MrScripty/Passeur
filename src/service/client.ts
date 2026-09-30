import { createConnection } from "node:net";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { SERVICE_CONTRACT, QUALIFIED_LEGACY_BUILD } from "../contracts/service.js";
import { effectiveProfileFingerprint, loadSharedProfile } from "../core/profile.js";
import type { Operation, Response, ServiceDescriptor, FrontendStatus } from "../contracts/service.js";
import { RepositoryRuntime, resolveRepositoryBinding, type LaunchIntent, type ResolvedBinding } from "../core/repository-runtime.js";
import type { RuntimeIdentity } from "../contracts/runtime.js";
import type { ResultRequest } from "../contracts/types.js";
import { BridgeError, diagnosticInfo, type ErrorInfo } from "../core/errors.js";
import { withAbort } from "../core/async.js";
import { IpcConnection, decodeFrame, type Frame } from "./transport.js";
import type { LaunchReservation } from "./bootstrap.js";
import { decodeCoordinationRequest, decodeCoordinationReply, type CoordinationReply } from "../contracts/coordination-service.js";
import { assertRequestCapacity, serviceRequestLane, type RequestLane } from "./request-capacity.js";

function assertServiceContract(descriptor: ServiceDescriptor): void {
  if (descriptor.service_contract === undefined && (descriptor.runtime.mode !== "installed" || descriptor.runtime.build_id !== QUALIFIED_LEGACY_BUILD)) {
    throw new BridgeError("SERVICE_BUILD_CONFLICT", "Legacy handshake requires the qualified prior installed service build");
  }
  if (descriptor.service_contract !== undefined && descriptor.service_contract !== SERVICE_CONTRACT) {
    throw new BridgeError("SERVICE_CONTRACT_CONFLICT", "The service contract is unsupported");
  }
}

type Pending = { lane: RequestLane; accept: (value: unknown) => void; reject: (error: unknown) => void };
export class ServiceClient {
  readonly #pending = new Map<string, Pending>();
  readonly connection: IpcConnection;
  readonly ready: Promise<void>;
  #resolveReady!: () => void;
  #rejectReady!: (error: unknown) => void;
  #clientId: string | undefined;
  readonly #parentId: string;
  readonly #repositoryId: string;
  constructor(readonly descriptor: ServiceDescriptor, binding: ResolvedBinding, ownerToken: string, requestedFingerprint?: string) {
    assertServiceContract(descriptor);
    const hello = decodeFrame({ kind: "hello", protocol: 1, token: descriptor.token, owner_token: ownerToken,
      repository_id: binding.repositoryId, state_root: binding.stateRoot, source_view: binding.project,
      ...(descriptor.service_contract === undefined
        ? descriptor.profile_path ? { profile_path: descriptor.profile_path } : {}
        : { service_contract: SERVICE_CONTRACT, ...(requestedFingerprint ? { profile_fingerprint: requestedFingerprint } : {}) }) });
    this.descriptor = Object.freeze({ ...descriptor });
    this.#parentId = createHash("sha256").update(ownerToken).digest("hex");
    this.#repositoryId = binding.repositoryId;
    this.ready = new Promise<void>((yes, no) => { this.#resolveReady = yes; this.#rejectReady = no; }); this.ready.catch(() => undefined);
    const socket = createConnection(descriptor.endpoint);
    this.connection = new IpcConnection(socket, (frame: Frame) => {
      if (frame.kind === "welcome" && !this.#clientId) {
        if (frame.generation !== this.descriptor.generation) throw new BridgeError("SERVICE_GENERATION_CHANGED", "The endpoint belongs to another service generation");
        this.#clientId = frame.client_id; this.#resolveReady(); return;
      }
      if (!this.#clientId || (frame.kind !== "response" && frame.kind !== "failure") || frame.generation !== this.descriptor.generation) throw new BridgeError("SERVICE_FRAME_INVALID", "Unexpected or stale service response");
      const request = this.#pending.get(frame.id);
      if (!request) throw new BridgeError("SERVICE_CORRELATION_INVALID", "Service response has no outstanding request");
      this.#pending.delete(frame.id);
      if (frame.kind === "failure") { request.reject(new BridgeError(frame.error.code, frame.error.message, frame.error)); return; }
      request.accept(frame.result);
    }, () => {
      const failure = this.connection.error instanceof BridgeError && !this.#clientId
        ? this.connection.error
        : new BridgeError("SERVICE_DISCONNECTED", "Service observation was lost; recover accepted operations by their original keys");
      this.#rejectReady(failure);
      for (const request of this.#pending.values()) request.reject(failure);
      this.#pending.clear();
    });
    socket.once("connect", () => {
      void this.connection.send(hello).catch((error) => this.connection.close(error));
    });
  }
  async call<K extends Operation>(operation: K, args: unknown, signal?: AbortSignal, onDispatch?: () => void): Promise<Response<K>> {
    signal?.throwIfAborted();
    const { operationSchemas, responseSchemas } = await import("../contracts/service.js");
    const parsed = operationSchemas[operation].safeParse(args);
    if (!parsed.success) throw new BridgeError("SERVICE_ARGUMENT_INVALID", "Operation arguments do not satisfy their contract");
    return this.#request(operation, parsed.data, value => {
      const result = responseSchemas[operation].safeParse(value);
      if (!result.success) throw new BridgeError("SERVICE_RESULT_INVALID", "The service response violates the requested operation contract");
      return result.data as Response<K>;
    }, serviceRequestLane(operation, parsed.data), signal, onDispatch);
  }
  coordinate(raw: unknown, signal?: AbortSignal): Promise<CoordinationReply> {
    try {
      signal?.throwIfAborted();
      const request = decodeCoordinationRequest(raw);
      return this.#request("coordination", request,
        value => decodeCoordinationReply(request, this.#parentId, this.#repositoryId, value),
        serviceRequestLane("coordination", request), signal);
    } catch (error) { return Promise.reject(error); }
  }
  async #request<T>(operation: string, args: unknown, decode: (value: unknown) => T,
    lane: RequestLane, signal?: AbortSignal, onDispatch?: () => void): Promise<T> {
    signal?.throwIfAborted(); await withAbort(this.ready, signal); signal?.throwIfAborted();
    if (this.connection.isClosed) throw new BridgeError("SERVICE_DISCONNECTED", "The service connection is closed");
    assertRequestCapacity(this.#pending.values(), lane);
    const id = randomUUID();
    let accept!: Pending["accept"], reject!: Pending["reject"];
    const result = new Promise<T>((yes, no) => {
      reject = no;
      accept = value => { try { yes(decode(value)); } catch (error) { no(error); } };
    });
    result.catch(() => undefined);
    this.#pending.set(id, { lane, accept, reject });
    const abort = () => { void this.connection.send({ kind: "cancel_wait", id, generation: this.descriptor.generation }).catch(() => undefined); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const writing = this.connection.send({ kind: "request", id, generation: this.descriptor.generation, operation, arguments: args });
      if (!this.connection.isClosed) onDispatch?.();
      void writing.catch((error) => { this.#pending.delete(id); reject(error); this.connection.close(error); });
      await withAbort(writing, signal);
      if (signal?.aborted) abort();
      // Detached observations keep their correlation/capacity until the reply or connection closure.
      return await withAbort(result, signal);
    } finally { signal?.removeEventListener("abort", abort); }
  }
  close(): void { this.connection.close(); }
}
function serviceProfileConflict(binding: ResolvedBinding, descriptor: ServiceDescriptor, requestedFingerprint?: string): BridgeError {
  return new BridgeError("SERVICE_PROFILE_CONFLICT",
    "The requested profile differs from the elected service profile", {
      stage: "service.profile", service_generation: descriptor.generation,
      ...(requestedFingerprint ? { requested_profile_fingerprint: requestedFingerprint } : {}),
      ...(descriptor.profile_fingerprint ? { service_profile_fingerprint: descriptor.profile_fingerprint } : {}),
      ...(binding.profilePath ? { path: binding.profilePath } : {}),
      ...(binding.profilePath ? { requested_profile_path: binding.profilePath } : {}),
      ...(descriptor.profile_path ? { service_profile_path: descriptor.profile_path } : {}),
      next_action: "Use the elected service's approved profile or drain it explicitly before a controlled profile change.",
    });
}
/** One host connection. Its owner token survives IPC reconnects, but is never exposed to the model. */
export class PasseurFrontend {
  readonly #ownerToken: string;
  readonly #lifetime = new AbortController();
  readonly #history: RepositoryRuntime;
  #client: ServiceClient | undefined;
  #connecting: Promise<ServiceClient | undefined> | undefined;
  #discovering: Promise<ServiceClient | undefined> | undefined;
  #binding: ResolvedBinding | undefined;
  #lastStatus: Response<"status"> | undefined;
  #failure: ErrorInfo | undefined;
  readonly #environment: Readonly<Record<string, string | undefined>>;
  constructor(readonly intent: LaunchIntent, readonly identity: RuntimeIdentity, readonly exactCli: string, ownerToken = randomBytes(32).toString("hex")) {
    if (!/^[a-f0-9]{64}$/.test(ownerToken)) throw new BridgeError("CONTROL_CREDENTIAL_INVALID", "Invalid private control credential");
    this.intent = Object.freeze({ ...intent });
    this.identity = Object.freeze({ ...identity });
    this.#ownerToken = ownerToken;
    const inheritedKeys = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "XDG_CONFIG_HOME", "XDG_STATE_HOME",
      "XDG_DATA_HOME", "XDG_CACHE_HOME", "TMPDIR", "PASSEUR_OBSERVATION_MONITOR"] as const;
    this.#environment = Object.freeze(Object.fromEntries(inheritedKeys.flatMap((key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key]]])));
    this.#history = new RepositoryRuntime(this.intent, this.identity, {}, this.#environment);
  }
  async #resolve(): Promise<ResolvedBinding> {
    return this.#binding ??= await resolveRepositoryBinding(this.intent, this.#environment, this.#lifetime.signal);
  }
  status(): FrontendStatus {
    const resolved = this.#binding ?? this.#history.binding;
    return { schema_version: 2, frontend: this.identity, binding: { project_input: this.intent.project,
      ...(this.intent.profilePath ? { profile_path: this.intent.profilePath } : {}), ...(this.intent.stateRoot ? { state_root: this.intent.stateRoot } : {}),
      ...(this.intent.expectedRepositoryId ? { expected_repository_id: this.intent.expectedRepositoryId } : {}) },
      ...(resolved ? { resolved: { project: resolved.project, source_view: resolved.project, repository_id: resolved.repositoryId,
        common_dir: resolved.commonDir, state_root: resolved.stateRoot, store_root: resolved.storeRoot,
        ...(resolved.profilePath ? { profile_path: resolved.profilePath } : {}),
        ...(resolved.profileSource ? { profile_source: resolved.profileSource } : {}) } } : {}),
      service: this.#failure ? { state: "unavailable", ...this.#failure }
        : this.#client?.connection.isClosed ? { state: "unavailable", code: "SERVICE_DISCONNECTED", message: "The previous service observation is stale" }
        : this.#lastStatus ? { state: "connected", status: this.#lastStatus } : { state: "not_checked" } };
  }
  async observeStatus(signal?: AbortSignal): Promise<FrontendStatus> {
    if (!this.#binding) {
      try { await withAbort(this.#resolve(), signal); this.#failure = undefined; }
      catch (error) { this.#failure = diagnosticInfo(error); return this.status(); }
    }
    if (this.#client && !this.#client.connection.isClosed) {
      try { this.#lastStatus = await this.#client.call("status", {}, signal); this.#failure = undefined; }
      catch (error) { const info = diagnosticInfo(error); this.#failure = info; this.#lastStatus = undefined; }
    }
    return this.status();
  }
  #prospectiveFailure(error: unknown): unknown {
    if (!this.intent.profilePath && this.#binding?.profileSource === "global" && error instanceof BridgeError && error.code === "PATH_NOT_FOUND") {
      return new BridgeError("PROFILE_CONFIGURATION_REQUIRED", "No installation profile is configured for a new repository service", {
        ...error.context, cause: error,
        next_action: "Configure the installation default or migrate one unambiguous existing profile before starting a service.",
      });
    }
    return error;
  }
  async #candidateSnapshot(): Promise<void> {
    try { await this.#history.profileSnapshot(); }
    catch (error) { throw this.#prospectiveFailure(error); }
  }
  async #connect(mode: "prepare" | "discover" = "prepare"): Promise<ServiceClient | undefined> {
    this.#lifetime.signal.throwIfAborted();
    if (this.#client && !this.#client.connection.isClosed) return this.#client;
    const inFlight = mode === "prepare" ? this.#connecting : this.#discovering;
    if (inFlight) return inFlight;
    const attempt = (async () => {
      let reservation: LaunchReservation | undefined;
      const budget = AbortSignal.timeout(10_000), signal = AbortSignal.any([budget, this.#lifetime.signal]);
      try {
        const binding = await this.#resolve();
        const { readDescriptor, existingOwner, launchService } = await import("./bootstrap.js");
        let descriptor: ServiceDescriptor | undefined;
        while (true) {
          signal.throwIfAborted();
          try { descriptor = await readDescriptor(binding); break; }
          catch (error) {
            if (!(error instanceof BridgeError) || error.code !== "SERVICE_DESCRIPTOR_CHANGED") throw error;
            await delay(25, undefined, { signal });
          }
        }
        const live = descriptor ? await existingOwner(descriptor) : false;
        if (!live) {
          if (mode === "discover") return this.#client && !this.#client.connection.isClosed ? this.#client : undefined;
          // Validate prospective configuration before election. The service publishes
          // only its own retained snapshot, never this candidate's identity.
          await this.#candidateSnapshot();
          reservation = await launchService(binding, this.exactCli, this.#environment);
        }
        while (true) {
          signal.throwIfAborted();
          let candidate: ServiceClient | undefined;
          let dispatched = false;
          try {
            descriptor = await readDescriptor(binding);
            if (descriptor && await existingOwner(descriptor)) {
              const legacy = descriptor.service_contract === undefined;
              assertServiceContract(descriptor);
              if (!legacy && descriptor.runtime.build_id !== this.identity.build_id) throw new BridgeError("SERVICE_BUILD_CONFLICT",
                "The running service build is outside the qualified compatibility window; preserve it for controlled handover");
              let requestedFingerprint: string | undefined;
              if (this.intent.profilePath) {
                if (!descriptor.profile_fingerprint) throw new BridgeError("SERVICE_PROFILE_IDENTITY_UNAVAILABLE",
                  "The running legacy service has no retained profile identity for an explicit compatibility check", {
                    stage: "service.profile", requested_profile_path: binding.profilePath,
                    service_profile_path: descriptor.profile_path, service_generation: descriptor.generation,
                    next_action: "Use an unpinned connection or arrange a controlled service handover.",
                  });
                requestedFingerprint = effectiveProfileFingerprint(await loadSharedProfile(binding.profilePath!));
                if (requestedFingerprint !== descriptor.profile_fingerprint) throw serviceProfileConflict(binding, descriptor, requestedFingerprint);
              }
              candidate = new ServiceClient(descriptor, binding, this.#ownerToken, requestedFingerprint);
              await withAbort(candidate.ready, signal);
              // This read-only probe may be retried if the service dies before
              // the frontend has attached. Mutating requests begin only after
              // this method returns a connected client.
              const status = await candidate.call("status", {}, signal, () => { dispatched = true; });
              if (this.#client && !this.#client.connection.isClosed) {
                candidate.close(); return this.#client;
              }
              this.#lastStatus = status; this.#failure = undefined; this.#client = candidate;
              return candidate;
            }
          } catch (error) {
            candidate?.close();
            if (!(error instanceof BridgeError && (error.code === "SERVICE_DESCRIPTOR_CHANGED" || error.code === "SERVICE_DISCONNECTED"))) throw error;
            if (dispatched && descriptor && await existingOwner(descriptor)) throw error;
          }
          // Discovery may have observed a live process that exits before the
          // handshake or status probe. Re-elect through the guarded launcher;
          // the flock reservation prevents competing frontends from creating
          // another service generation.
          if (!reservation && (!descriptor || !(await existingOwner(descriptor)))) {
            if (mode === "discover") return this.#client && !this.#client.connection.isClosed ? this.#client : undefined;
            await this.#candidateSnapshot();
            reservation = await launchService(binding, this.exactCli, this.#environment);
          }
          if (reservation) await Promise.race([delay(25, undefined, { signal }), reservation.failure]);
          else await delay(25, undefined, { signal });
        }
      } catch (error) {
        const info = budget.aborted && !this.#lifetime.signal.aborted ? { code: "SERVICE_ATTACH_UNAVAILABLE", message: "Service attachment exceeded its observation budget; no running task was cancelled" } : diagnosticInfo(error);
        this.#lastStatus = undefined; this.#failure = info; throw new BridgeError(info.code, info.message, info);
      } finally { reservation?.released(); }
    })();
    if (mode === "prepare") this.#connecting = attempt; else this.#discovering = attempt;
    const clear = () => {
      if (mode === "prepare" && this.#connecting === attempt) this.#connecting = undefined;
      if (mode === "discover" && this.#discovering === attempt) this.#discovering = undefined;
    };
    void attempt.then(clear, clear);
    return attempt;
  }
  async call<K extends Operation>(operation: K, args: unknown, signal?: AbortSignal): Promise<Response<K>> {
    const client = await withAbort(this.#connect(), signal);
    const result = await client!.call(operation, args, signal);
    if (operation === "status" || operation === "prepare") {
      this.#lastStatus = result as Response<"status">;
      this.#failure = undefined;
    }
    return result;
  }
  async coordinate(raw: unknown, signal?: AbortSignal): Promise<CoordinationReply> {
    signal?.throwIfAborted();
    const request = decodeCoordinationRequest(raw);
    const client = await withAbort(this.#connect(), signal);
    return client!.coordinate(request, signal);
  }
  async agents(offset: number, limit: number, signal?: AbortSignal) {
    const client = await withAbort(this.#connect("discover"), signal);
    if (client) return client.call("agents", { offset, limit }, signal);
    signal?.throwIfAborted();
    try { return await this.#history.agents(offset, limit); }
    catch (error) { throw this.#prospectiveFailure(error); }
  }
  async retained(request: ResultRequest) {
    const { textChunk } = await import("../core/result.js");
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
    await Promise.allSettled([this.#connecting, this.#discovering].filter(Boolean));
    this.#client?.close(); await this.#history.shutdown();
  }
}
