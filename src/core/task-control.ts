import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { canonicalHash, KeyedMutex } from "./async.js";
import { BridgeError } from "./errors.js";
import type { TaskControl, TaskObservation, CurrentDurableRequest, ControlReceipt, InputData, PendingInput } from "../contracts/tasks.js";
import type { PeerDeliverySlotBundle, PeerDeliverySlotReservation } from "../contracts/peer-delivery.js";

/** The store publishes a whole control invariant. Callbacks and native execution run outside these locks. */
export interface ControlStore {
  readControl(id: string): Promise<TaskControl>;
  writeControl(id: string, state: TaskControl): Promise<void>;
  durableRequest(id: string): Promise<CurrentDurableRequest>;
}
export type ClientActor = { owner_id: string; client_id: string };
export type WaitResult = { kind: "changed" | "terminal" | "input_required" | "wait_elapsed"; task: TaskObservation };
type Waiter = { resolve: () => void };
const now = () => new Date().toISOString();
export function initialControl(id: string, owner: string): TaskControl {
  return { schema_version: 2, task_id: id, revision: 1, owner_id: owner, control_generation: 1,
    phase: "queued", updated_at: now(), native: { run_id: randomUUID(), state: "not_started", obligations: [], coverage: "unknown" },
    inputs: [], receipts: [], telemetry_omitted: false };
}
export function owns(state: TaskControl, actor: Pick<ClientActor, "owner_id">, generation?: number): void {
  if (state.owner_id !== actor.owner_id) throw new BridgeError("TASK_CONTROL_CONFLICT", "This connection does not control the task; use human-confirmed attach");
  if (generation !== undefined && generation !== state.control_generation) throw new BridgeError("STALE_CONTROL", "Task control changed; read a fresh observation");
}
function observation(record: CurrentDurableRequest, state: TaskControl): TaskObservation {
  return { schema_version: 1, task_id: record.task_id, request_key: record.request.request_key,
    agent_id: record.request.agent_id, source_view: record.source_view, revision: state.revision,
    control_generation: state.control_generation, phase: state.phase, ...(state.outcome ? { outcome: state.outcome } : {}),
    native: { ...structuredClone(state.native), obligations: structuredClone(state.native.obligations.slice(0, 4)), obligations_count: state.native.obligations.length, obligations_truncated: state.native.obligations.length > 4 }, updated_at: state.updated_at,
    inputs: state.inputs.filter((i) => i.state === "pending" || i.state === "answer_intent" || i.state === "delivery_unknown")
      .sort((a, b) => Number(b.state === "pending") - Number(a.state === "pending")).slice(0, 8).map((i) => ({ input_id: i.input_id, kind: i.data.kind, state: i.state, summary: (i.data.kind === "clarification" ? i.data.question : `Permission: ${i.data.approval.tool}`).slice(0, 512) })),
    inputs_count: state.inputs.filter((i) => ["pending", "answer_intent", "delivery_unknown"].includes(i.state)).length,
    ...(state.attention ? { attention: state.attention } : {}), telemetry_omitted: state.telemetry_omitted };
}
export class TaskControls {
  readonly #locks = new KeyedMutex();
  readonly #publicationContext = new AsyncLocalStorage<string>();
  readonly #publications = new Map<string, { token: string; done: Promise<void>; release: () => void }>();
  readonly #waiters = new Map<string, Set<Waiter>>();
  #waiting = 0;
  constructor(readonly store: ControlStore, public maxWaiters: number, public maxReceipts: number) {}
  async withTaskMutation<T>(id: string, mutation: () => Promise<T>): Promise<T> {
    try {
      for (;;) {
        await this.#awaitPublication(id);
        const outcome = await this.#locks.run(id, async () => this.#publications.has(id)
          ? { busy: true as const } : { busy: false as const, result: await mutation() });
        if (!outcome.busy) return outcome.result;
      }
    }
    finally { for (const waiter of this.#waiters.get(id) ?? []) waiter.resolve(); }
  }
  /** Reserve publication under short task locks; callbacks run after all locks release. */
  async withTaskPublication<T>(ids: readonly string[], publication: () => Promise<T>): Promise<T> {
    const ordered = [...new Set(ids)].sort();
    const token = randomUUID();
    let release!: () => void;
    const done = new Promise<void>(resolve => { release = resolve; });
    for (;;) {
      for (const id of ordered) await this.#awaitPublication(id);
      const reserve = (index: number): Promise<boolean> => index === ordered.length
        ? (async () => {
          if (ordered.some(id => this.#publications.has(id))) return false;
          for (const id of ordered) this.#publications.set(id, { token, done, release });
          return true;
        })() : this.#locks.run(ordered[index]!, () => reserve(index + 1));
      if (await reserve(0)) break;
    }
    try { return await this.#publicationContext.run(token, publication); }
    finally {
      for (const id of ordered) if (this.#publications.get(id)?.token === token) this.#publications.delete(id);
      release();
    }
  }
  async #awaitPublication(id: string): Promise<void> {
    const reservation = this.#publications.get(id);
    if (!reservation) return;
    if (reservation.token === this.#publicationContext.getStore()) {
      throw new BridgeError("COORDINATION_TASK_BUSY", "Task mutation re-entered its own peer publication");
    }
    await reservation.done;
  }
  /** Release only exact unconsumed slots while the caller owns this task's publication fence. */
  async releasePeerDeliverySlotsInPublication(bundle: PeerDeliverySlotBundle): Promise<void> {
    const id = bundle.recipient_task_id, token = this.#publicationContext.getStore();
    if (!token || this.#publications.get(id)?.token !== token)
      throw new BridgeError("PEER_DELIVERY_RESERVATION_SCOPE", "An active recipient publication fence is required");
    await this.#locks.run(id, async () => {
      if (this.#publications.get(id)?.token !== token)
        throw new BridgeError("PEER_DELIVERY_RESERVATION_SCOPE", "Recipient publication fence expired");
      const old = await this.store.readControl(id);
      if (old.schema_version !== 3) return;
      const draft = structuredClone(old);
      const operationSlots = draft.peer_delivery_reservations.filter(item => item.operation_key === bundle.operation_key);
      if (!operationSlots.length) return;
      const sources = new Set(bundle.sources.map(source => source.work_id));
      if (sources.size !== bundle.sources.length || operationSlots.length !== bundle.sources.length ||
        operationSlots.some(slot => !sources.has(slot.source_work_id)))
        throw new BridgeError("PEER_DELIVERY_RESERVATION_MANIFEST", "Publication release must name the full exact source manifest");
      for (const source of bundle.sources) {
        const expected: Omit<PeerDeliverySlotReservation, "state" | "delivery_id"> = {
          schema_version: 1, operation_key: bundle.operation_key, request_digest: bundle.request_digest,
          case_id: bundle.case_id, expected_case_revision: bundle.expected_case_revision,
          case_revision: bundle.case_revision, case_generation: bundle.case_generation,
          recipient_task_id: bundle.recipient_task_id, recipient_run_id: bundle.recipient_run_id,
          recipient_control_generation: bundle.recipient_control_generation,
          recipient_workspace: bundle.recipient_workspace,
          recipient_workspace_fingerprint: bundle.recipient_workspace_fingerprint,
          source_work_id: source.work_id, source_work_revision: source.work_revision,
        };
        const slot = draft.peer_delivery_reservations.find(item => item.operation_key === bundle.operation_key &&
          item.source_work_id === source.work_id);
        if (!slot) throw new BridgeError("PEER_DELIVERY_RESERVATION_MANIFEST", "Publication release omits a reserved source");
        const { state: _state, delivery_id: _deliveryId, ...identity } = slot;
        if (canonicalHash(identity) !== canonicalHash(expected))
          throw new BridgeError("PEER_DELIVERY_KEY_CONFLICT", "Publication release names different reserved evidence");
        if (slot.state === "consumed")
          throw new BridgeError("PEER_DELIVERY_RESERVATION_CONSUMED", "A consumed delivery slot cannot be released");
        slot.state = "released";
      }
      if (canonicalHash(old) !== canonicalHash(draft)) {
        draft.revision = old.revision + 1; draft.updated_at = now();
        await this.store.writeControl(id, draft);
      }
    });
    for (const waiter of this.#waiters.get(id) ?? []) waiter.resolve();
  }
  async change<T>(id: string, change: (draft: TaskControl) => T | Promise<T>): Promise<T> {
    for (;;) {
      await this.#awaitPublication(id);
      const outcome = await this.#locks.run(id, async () => {
      if (this.#publications.has(id)) return { busy: true as const };
      const old = await this.store.readControl(id), draft = structuredClone(old);
      const value = await change(draft);
      if (canonicalHash(old) !== canonicalHash(draft)) {
        draft.revision = old.revision + 1; draft.updated_at = now();
        await this.store.writeControl(id, draft);
      }
      return { busy: false as const, value };
      });
      if (outcome.busy) continue;
    // A signal is advisory. The committed snapshot is authoritative, even if a peer disconnects.
    for (const waiter of this.#waiters.get(id) ?? []) waiter.resolve();
      return outcome.value;
    }
  }
  receipt(state: TaskControl, key: string, kind: ControlReceipt["kind"], contents: unknown): ControlReceipt | undefined {
    const existing = state.receipts.find((r) => r.operation_key === key);
    if (existing && (existing.kind !== kind || existing.hash !== canonicalHash(contents))) throw new BridgeError("OPERATION_KEY_CONFLICT", "Operation key belongs to another control intent");
    if (!existing && state.receipts.length >= this.maxReceipts - (kind === "cancel" ? 0 : 1)) throw new BridgeError("CONTROL_CAPACITY_EXCEEDED", "Task control receipt capacity is exhausted; preserve its evidence");
    return existing;
  }
  async read(id: string, actor: ClientActor): Promise<TaskObservation> {
    return this.#locks.run(id, async () => {
      const state = await this.store.readControl(id); owns(state, actor);
      return observation(await this.store.durableRequest(id), state);
    });
  }
  async cancel(id: string, actor: ClientActor, generation: number, operation_key: string, reason: string): Promise<ControlReceipt> {
    const contents = { id, generation, reason };
    return this.change(id, (state) => {
      owns(state, actor);
      const saved = state.receipts.find((r) => r.operation_key === operation_key);
      if (saved) { this.receipt(state, operation_key, "cancel", contents); return saved; }
      owns(state, actor, generation);
      // Accepted cancellation is task-specific and immutable; another key observes that intent.
      if (state.cancel) {
        const receipt = state.receipts.find((r) => r.operation_key === state.cancel!.operation_key);
        if (!receipt) throw new BridgeError("CONTROL_CORRUPT", "Cancellation has no durable receipt");
        return { ...receipt, outcome: state.phase === "terminal" || state.settled_outcome ? "already_terminal" : "accepted" };
      }
      this.receipt(state, operation_key, "cancel", contents);
      const terminal = state.phase === "terminal" || state.settled_outcome !== undefined;
      const receipt: ControlReceipt = { operation_key, kind: "cancel", hash: canonicalHash(contents),
        outcome: terminal ? "already_terminal" : "accepted", at: now(), generation };
      state.receipts.push(receipt);
      if (!terminal && !state.cancel) {
        state.cancel = { operation_key, reason, at: receipt.at }; state.phase = "stopping";
        for (const input of state.inputs) { delete input.claim; if (input.state === "pending") input.state = "withdrawn"; }
        for (const delivery of state.peer_deliveries ?? []) {
          if (delivery.state === "queued") { delivery.state = "cancelled"; delivery.disposition_at = now(); }
          else if (delivery.state === "dispatch_intent" || delivery.state === "delivered") { delivery.state = "unknown"; delivery.disposition_at = now(); }
        }
      }
      return receipt;
    });
  }
  /** Preflight is serialized with native changes; cancel still validates at the commit point. */
  async preflightCancel(id: string, actor: ClientActor, generation: number, operation_key: string,
    reason: string): Promise<{ transition: boolean; receipt?: ControlReceipt }> {
    return this.#locks.run(id, async () => {
      const state = await this.store.readControl(id);
      owns(state, actor, generation);
      const contents = { id, generation, reason };
      const saved = state.receipts.find(receipt => receipt.operation_key === operation_key);
      if (saved) { this.receipt(state, operation_key, "cancel", contents); return { transition: false, receipt: saved }; }
      if (state.cancel) {
        const receipt = state.receipts.find(item => item.operation_key === state.cancel!.operation_key);
        if (!receipt) throw new BridgeError("CONTROL_CORRUPT", "Cancellation has no durable receipt");
        return { transition: false, receipt: { ...receipt,
          outcome: state.phase === "terminal" || state.settled_outcome ? "already_terminal" : "accepted" } };
      }
      this.receipt(state, operation_key, "cancel", contents);
      return { transition: state.phase !== "terminal" && !state.settled_outcome };
    });
  }
  async adopt(id: string, actor: ClientActor, operation_key: string): Promise<ControlReceipt> {
    const contents = { id, owner_id: actor.owner_id };
    return this.change(id, (state) => {
      const old = this.receipt(state, operation_key, "attach", contents); if (old) return old;
      state.owner_id = actor.owner_id; state.control_generation++;
      for (const input of state.inputs) delete input.claim;
      const receipt: ControlReceipt = { operation_key, kind: "attach", hash: canonicalHash(contents), outcome: "adopted", at: now(), generation: state.control_generation };
      state.receipts.push(receipt); return receipt;
    });
  }
  async releaseClient(id: string, clientId: string): Promise<void> {
    await this.change(id, (state) => { for (const input of state.inputs) if (input.claim?.client_id === clientId) delete input.claim; });
  }
  async wait(id: string, actor: ClientActor, after: number, budget: number, signal: AbortSignal): Promise<WaitResult> {
    signal.throwIfAborted();
    let wake!: () => void;
    const notified = new Promise<void>((resolve) => { wake = resolve; });
    const waiter: Waiter = { resolve: wake };
    let registered = false, timer: NodeJS.Timeout | undefined;
    try {
      const initial = await this.#locks.run(id, async () => {
        signal.throwIfAborted();
        const state = await this.store.readControl(id); owns(state, actor);
        if (after > state.revision) throw new BridgeError("CURSOR_INVALID", "Observation revision is newer than authoritative state");
        const task = observation(await this.store.durableRequest(id), state);
        if (state.phase === "terminal" || state.revision > after || task.inputs.some((i) => i.state === "pending")) return task;
        if (this.#waiting >= this.maxWaiters) throw new BridgeError("WAITER_CAPACITY_EXCEEDED", "The observation waiter limit is reached");
        let set = this.#waiters.get(id); if (!set) this.#waiters.set(id, set = new Set());
        set.add(waiter); this.#waiting++; registered = true;
        return undefined;
      });
      if (!initial) {
        signal.addEventListener("abort", wake, { once: true });
        if (signal.aborted) wake();
        timer = setTimeout(wake, budget);
        await notified; signal.throwIfAborted();
      }
      const task = initial ?? await this.read(id, actor);
      return { kind: task.phase === "terminal" ? "terminal" : task.inputs.some((i) => i.state === "pending") ? "input_required"
        : task.revision > after ? "changed" : "wait_elapsed", task };
    } finally {
      if (timer) clearTimeout(timer); signal.removeEventListener("abort", wake);
      if (registered) { this.#waiters.get(id)?.delete(waiter); this.#waiting--; if (!this.#waiters.get(id)?.size) this.#waiters.delete(id); }
    }
  }
  async requestInput(id: string, data: InputData, nativeId: string, inputId = randomUUID()): Promise<PendingInput> {
    return this.change(id, (state) => {
      if (state.cancel || state.phase === "terminal" || state.phase === "finalizing") throw new BridgeError("STALE_INPUT", "Task is no longer accepting input requests");
      const input: PendingInput = { input_id: inputId, native_id: nativeId, run_id: state.native.run_id,
        turn_id: state.native.turn_id ?? state.native.run_id, data: structuredClone(data), digest: canonicalHash(data), revision: state.revision + 1, state: "pending" };
      if (state.inputs.some((i) => i.native_id === nativeId && i.turn_id === input.turn_id && i.state === "pending")) throw new BridgeError("DUPLICATE_NATIVE_INPUT", "Native request is already pending");
      state.inputs.push(input); state.phase = data.kind === "clarification" && data.attention ? "needs_attention" : "awaiting_input";
      return input;
    });
  }
}
