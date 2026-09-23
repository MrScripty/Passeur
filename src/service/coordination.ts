import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { canonicalHash, throwIfAborted, withAbort } from "../core/async.js";
import { BridgeError } from "../core/errors.js";
import { CoordinationStore } from "../store/coordination-store.js";
import { CoordinationControl, type CoordinationActor, type RetirementReservation } from "../coordination/control.js";
import { RepositoryCoordination, type BindingLimits, type CoordinationConnection, type ExternalWorkspaceAuthority, type ManagedWorkspaceAuthority } from "../coordination/bound-control.js";
import { decodeLimits, parentId, type Limits } from "../contracts/coordination-control.js";
import { COORDINATION_VIEW_BYTES, coordinationRequestLane, decodeCoordinationReply, decodeCoordinationRequest,
  type CoordinationReply, type CoordinationRequest, type CoordinationSelector } from "../contracts/coordination-service.js";

export type CoordinationServiceBinding = Readonly<{ store_root: string; repository_id: string }>;
/** Supplied by the elected runtime, never reconstructed from message arguments. */
export type CoordinationServiceAuthority = Readonly<{
  assertOwned: () => void;
  authorizeInitialization: (actor: CoordinationActor, limits: Readonly<Limits>) => Promise<void>;
  authorizeRecovery?: (actor: CoordinationActor) => Promise<void>;
  externalWorkspaces: ExternalWorkspaceAuthority;
  managedWorkspaces?: ManagedWorkspaceAuthority;
}>;
export type CoordinationServiceLimits = BindingLimits & Readonly<{ ordinary_requests: number; control_requests: number }>;
type Opened = { store: CoordinationStore; control: CoordinationControl };

/** Owns one metadata session and its pending work. It starts no listener, parser, or agent. */
export class CoordinationService {
  readonly #binding: CoordinationServiceBinding;
  readonly #authority: CoordinationServiceAuthority;
  readonly #limits: CoordinationServiceLimits;
  readonly #pending = new Set<Promise<unknown>>();
  #opened: Opened | undefined;
  #opening: Promise<Opened> | undefined;
  #bound: RepositoryCoordination | undefined;
  #bindingSource: Promise<RepositoryCoordination> | undefined;
  #ordinary = 0;
  #controls = 0;
  #draining = false;
  #closing = false;
  #close: Promise<void> | undefined;

  constructor(binding: CoordinationServiceBinding, authority: CoordinationServiceAuthority, limits: CoordinationServiceLimits) {
    if (!isAbsolute(binding.store_root) || binding.store_root.includes("\0") || !/^[a-f0-9]{24}$/.test(binding.repository_id)) {
      throw new BridgeError("COORDINATION_SERVICE_BINDING_INVALID", "The service requires its resolved repository/store binding");
    }
    if (typeof authority.assertOwned !== "function" || typeof authority.authorizeInitialization !== "function"
      || typeof authority.externalWorkspaces?.assertExternalRegistration !== "function"
      || authority.managedWorkspaces !== undefined && (typeof authority.managedWorkspaces.acquireRegistration !== "function" || typeof authority.managedWorkspaces.inspectSelection !== "function")
      || authority.authorizeRecovery !== undefined && typeof authority.authorizeRecovery !== "function") {
      throw new BridgeError("COORDINATION_SERVICE_AUTHORITY_UNAVAILABLE", "Service, initialization, and resource authorities must be supplied explicitly");
    }
    for (const value of [limits.ordinary_requests, limits.control_requests]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 64) throw new BridgeError("COORDINATION_SERVICE_CAPACITY_INVALID", "Explicit request capacities must be from 1 to 64");
    }
    this.#binding = Object.freeze({ ...binding }); this.#authority = Object.freeze({ ...authority }); this.#limits = Object.freeze({ ...limits });
  }
  get pendingCount(): number { return this.#pending.size; }
  get draining(): boolean { return this.#draining; }

  /** Request loss detaches the observer; the admitted operation remains owned until it settles. */
  handle(connection: CoordinationConnection, raw: unknown, signal?: AbortSignal): Promise<CoordinationReply> {
    let request: CoordinationRequest, actor: CoordinationActor, captured: CoordinationConnection;
    try {
      throwIfAborted(signal);
      actor = Object.freeze({ owner_id: parentId(connection.owner_id) });
      if (typeof connection.source_view !== "string" || !isAbsolute(connection.source_view) || connection.source_view.includes("\0")) {
        throw new BridgeError("COORDINATION_SOURCE_VIEW_INVALID", "Use the source view supplied by the authenticated service connection");
      }
      captured = Object.freeze({ ...actor, source_view: connection.source_view });
      request = decodeCoordinationRequest(raw);
      if (this.#closing) throw new BridgeError("COORDINATION_SERVICE_CLOSED", "Coordination no longer accepts requests");
      if (this.#draining && (request.kind === "initialize" || request.kind === "command" && coordinationRequestLane(request) === "ordinary")) {
        throw new BridgeError("COORDINATION_SERVICE_DRAINING", "New coordination work is closed; reads and release/recovery controls remain available");
      }
    } catch (error) { return Promise.reject(error); }
    const lane = coordinationRequestLane(request), control = lane === "control";
    if (control ? this.#controls >= this.#limits.control_requests : this.#ordinary >= this.#limits.ordinary_requests) {
      return Promise.reject(new BridgeError(control ? "COORDINATION_CONTROL_CAPACITY" : "COORDINATION_SERVICE_CAPACITY", "The selected request lane is at capacity; no operation was started"));
    }
    if (control) this.#controls++; else this.#ordinary++;
    const operation = this.#dispatch(captured, request).then(value => decodeCoordinationReply(request, actor.owner_id, this.#binding.repository_id, value));
    this.#pending.add(operation);
    const settled = () => { this.#pending.delete(operation); if (control) this.#controls--; else this.#ordinary--; };
    void operation.then(settled, settled);
    return withAbort(operation, signal);
  }

  async #open(initialize?: Limits): Promise<Opened> {
    if (this.#opened) {
      // A read checks the anchored directory/marker again instead of trusting prior initialization.
      const state = await this.#opened.store.snapshot();
      if (initialize && canonicalHash(state.limits) !== canonicalHash(initialize)) throw new BridgeError("COORDINATION_CONFIG_CONFLICT", "Existing limits require an explicit supported migration");
      return this.#opened;
    }
    if (this.#opening) {
      try { await this.#opening; }
      catch (error) {
        if (!(initialize && error instanceof BridgeError && error.code === "COORDINATION_NOT_ENABLED")) throw error;
      }
      return this.#open(initialize);
    }
    const attempt = (async () => {
      const store = initialize
        ? await CoordinationStore.initialize(this.#binding.store_root, this.#binding.repository_id, initialize, this.#authority.assertOwned)
        : await CoordinationStore.open(this.#binding.store_root, this.#binding.repository_id, this.#authority.assertOwned);
      const opened = { store, control: new CoordinationControl(store) };
      this.#opened = opened; return opened;
    })();
    this.#opening = attempt;
    const clear = () => { if (this.#opening === attempt) this.#opening = undefined; };
    void attempt.then(clear, clear);
    return attempt;
  }
  async #source(opened: Opened, source: string): Promise<RepositoryCoordination> {
    if (this.#bound) return this.#bound;
    if (!this.#bindingSource) {
      const opening = RepositoryCoordination.open(source, opened.control, this.#authority.externalWorkspaces, this.#limits, undefined, this.#authority.managedWorkspaces);
      this.#bindingSource = opening;
      void opening.then(bound => { this.#bound = bound; this.#bindingSource = undefined; }, () => { this.#bindingSource = undefined; });
    }
    return this.#bindingSource;
  }
  async #dispatch(connection: CoordinationConnection, request: CoordinationRequest): Promise<CoordinationReply> {
    const repository_id = this.#binding.repository_id, actor = Object.freeze({ owner_id: connection.owner_id });
    if (request.kind === "identity") return { schema_version: 1, kind: "identity", repository_id, parent_id: actor.owner_id };
    if (request.kind === "initialize") {
      this.#authority.assertOwned();
      // A permission callback runs outside control/store locks and cannot mutate admitted limits.
      const limits = Object.freeze(decodeLimits(request.limits));
      await this.#authority.authorizeInitialization(actor, limits);
      this.#authority.assertOwned();
      const opened = await this.#open(limits);
      return this.#status(opened);
    }
    if (request.kind === "recover_metadata" || request.kind === "recovery_read") {
      if (!this.#authority.authorizeRecovery) throw new BridgeError("COORDINATION_OPERATOR_AUTHORITY_UNAVAILABLE", "The composition owner has not supplied operator recovery authority");
      await this.#authority.authorizeRecovery(actor);
      this.#authority.assertOwned();
    }
    let opened: Opened;
    try { opened = await this.#open(); }
    catch (error) {
      if (request.kind === "status" && error instanceof BridgeError && error.code === "COORDINATION_NOT_ENABLED") {
        return { schema_version: 1, kind: "status", repository_id, state: "not_enabled" };
      }
      throw error;
    }
    if (request.kind === "status") return this.#status(opened);
    if (request.kind === "recover_metadata") {
      const receipt = await opened.control.recoverAuthorized(actor, request.recovery);
      return { schema_version: 1, kind: "recovery_receipt", repository_id, receipt };
    }
    if (request.kind === "recovery_read") {
      const value = await opened.control.inspectRecoveryAuthorized(actor, request.selector);
      return this.#page(opened.store.epoch, actor.owner_id, request, value);
    }
    if (request.kind === "read") {
      const value = await this.#view(opened.control, actor, request.selector);
      return this.#page(opened.store.epoch, actor.owner_id, request, value);
    }
    this.#authority.assertOwned();
    const command = request.command;
    const sourceRequired = command.kind === "register_managed_work" || command.kind === "register_external_work" || command.kind === "claim_target"
      || command.kind === "select_inputs" || command.kind === "begin_external_integration";
    const receipt = sourceRequired
      ? await (await this.#source(opened, connection.source_view)).execute(connection, command)
      : await opened.control.execute(actor, command);
    return { schema_version: 1, kind: "receipt", repository_id, receipt };
  }
  async #status(opened: Opened): Promise<CoordinationReply> {
    const state = await opened.store.snapshot();
    return { schema_version: 1, kind: "status", repository_id: this.#binding.repository_id, state: "ready",
      epoch: state.epoch, revision: state.revision, limits: state.limits };
  }
  #view(control: CoordinationControl, actor: CoordinationActor, selector: CoordinationSelector): Promise<unknown> {
    switch (selector.kind) {
      case "work": return control.work(actor, selector.id);
      case "case": return control.reconciliation(actor, selector.id);
      case "note": return control.note(actor, selector.id);
      case "overlaps": return control.overlaps(actor, selector.id);
      case "receipt": return control.receipt(actor, selector.operation_key).then(value => value ?? null);
    }
  }
  #page(epoch: string, owner: string, request: Extract<CoordinationRequest, { kind: "read" | "recovery_read" }>, value: unknown): CoordinationReply {
    const bytes = Buffer.from(JSON.stringify(value));
    if (bytes.length > COORDINATION_VIEW_BYTES) throw new BridgeError("COORDINATION_VIEW_TOO_LARGE", "The selected view exceeds its supported bound");
    const context = canonicalHash({ schema_version: 1, repository: this.#binding.repository_id, epoch, owner, selector: request.selector, ...(request.kind === "recovery_read" ? { purpose: "operator-recovery" } : {}) });
    const hash = createHash("sha256").update(context).update(bytes).digest("hex");
    if (request.expected_hash !== null && request.expected_hash !== hash) throw new BridgeError("COORDINATION_VIEW_CHANGED", "This authorized view changed; restart at offset zero");
    if (request.offset > bytes.length) throw new BridgeError("COORDINATION_RANGE_INVALID", "Read offset exceeds this view");
    let content: string;
    try {
      // A streaming decode retains an incomplete trailing codepoint; its bytes belong to the next page.
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(request.offset, request.offset + request.limit), { stream: true });
    } catch (cause) { throw new BridgeError("COORDINATION_RANGE_INVALID", "Read offset is not a UTF-8 boundary", { cause }); }
    const length = Buffer.byteLength(content), next_offset = request.offset + length;
    if (!length && next_offset !== bytes.length) throw new BridgeError("COORDINATION_RANGE_INVALID", "The range cannot make progress");
    return { schema_version: 1, kind: "page", repository_id: this.#binding.repository_id, selector: request.selector, hash,
      offset: request.offset, bytes: length, next_offset, total_bytes: bytes.length, eof: next_offset === bytes.length, content };
  }
  /** The resource owner holds this reservation through its Git effect; no metadata mutex is retained. */
  reserveRetirement(taskId: string): Promise<RetirementReservation | undefined> {
    if (this.#closing) return Promise.reject(new BridgeError("COORDINATION_SERVICE_CLOSED", "Coordination no longer accepts resource operations"));
    const operation = (async () => {
      let opened: Opened;
      try { opened = await this.#open(); }
      catch (error) {
        if (error instanceof BridgeError && error.code === "COORDINATION_NOT_ENABLED") return undefined;
        throw error;
      }
      return opened.control.reserveRetirement(taskId);
    })();
    // Track lazy open as well as reservation admission, so close cannot miss an owner created after suspension.
    this.#pending.add(operation);
    const settled = () => { this.#pending.delete(operation); };
    void operation.then(settled, settled);
    return operation;
  }
  beginDrain(): void { this.#draining = true; }
  close(): Promise<void> {
    this.#closing = true; this.#draining = true;
    this.#close ??= (async () => {
      // Closing stops admission first; pending commands retain ownership through publication/receipt failure.
      await Promise.allSettled([...this.#pending]);
      if (this.#bound) await this.#bound.close();
      else if (this.#opened) await this.#opened.control.close();
    })();
    return this.#close;
  }
}
