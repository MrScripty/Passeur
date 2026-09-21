import { randomUUID } from "node:crypto";
import { canonicalHash, withAbort } from "./async.js";
import { BridgeError } from "./errors.js";
import { TaskControls, owns, type ClientActor } from "./task-control.js";
import type { InputData, PendingInput, ControlReceipt } from "../contracts/tasks.js";

type Pending = { task_id: string; resolve: (answer: string) => void; reject: (error: unknown) => void };
/** Durable input authority; presentation is a separate, cancellable client request. */
export class InputBroker {
  readonly #pending = new Map<string, Pending>();
  constructor(readonly controls: TaskControls, readonly maxPending: number) {}
  get pendingCount(): number { return this.#pending.size; }
  async request(taskId: string, data: InputData, nativeId: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    if ([...this.#pending.values()].filter((p) => p.task_id === taskId).length >= this.maxPending) throw new BridgeError("INPUT_CAPACITY_EXCEEDED", "The task's pending input capacity is reached");
    const id = randomUUID();
    let resolve!: Pending["resolve"], reject!: Pending["reject"];
    const answer = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
    answer.catch(() => undefined);
    // Reserve before publication: a fast client can never answer before the native waiter exists.
    this.#pending.set(id, { task_id: taskId, resolve, reject });
    let published = false;
    try {
      await this.controls.requestInput(taskId, data, nativeId, id); published = true;
      return await withAbort(answer, signal);
    } finally {
      this.#pending.delete(id);
      if (published && signal.aborted) await this.controls.change(taskId, (state) => {
        const input = state.inputs.find((i) => i.input_id === id);
        if (input && input.state === "pending") { input.state = "withdrawn"; delete input.claim; }
      });
    }
  }
  async claim(taskId: string, id: string, actor: ClientActor, generation: number): Promise<PendingInput> {
    return this.controls.change(taskId, (state) => {
      owns(state, actor, generation);
      const input = state.inputs.find((i) => i.input_id === id);
      if (!input || input.state !== "pending" || state.cancel || (state.phase === "terminal" || state.phase === "finalizing" || state.settled_outcome !== undefined)) throw new BridgeError("STALE_INPUT", "The native input request is no longer pending");
      if (!this.#pending.has(id)) throw new BridgeError("INPUT_RUNTIME_UNAVAILABLE", "Native input is unavailable after interruption; reconcile rather than resend");
      if (input.claim && input.claim.client_id !== actor.client_id) throw new BridgeError("INPUT_ALREADY_PRESENTED", "Another attached client is presenting this input");
      input.claim ??= { id: randomUUID(), client_id: actor.client_id, control_generation: generation };
      return structuredClone(input);
    });
  }
  async dismiss(taskId: string, id: string, actor: ClientActor, claimId: string): Promise<void> {
    await this.controls.change(taskId, (state) => {
      const input = state.inputs.find((i) => i.input_id === id);
      if (input?.claim?.id === claimId && input.claim.client_id === actor.client_id) delete input.claim;
    });
  }
  async answer(taskId: string, id: string, actor: ClientActor, generation: number, claimId: string, operationKey: string, answer: string): Promise<ControlReceipt> {
    const contents = { taskId, id, generation, answer };
    let dispatch = false;
    const receipt = await this.controls.change(taskId, (state) => {
      owns(state, actor, generation);
      const old = this.controls.receipt(state, operationKey, "input", contents); if (old) return old;
      const input = state.inputs.find((i) => i.input_id === id);
      if (!input || input.state !== "pending" || input.claim?.id !== claimId || input.claim.client_id !== actor.client_id || state.cancel || (state.phase === "terminal" || state.phase === "finalizing" || state.settled_outcome !== undefined)) throw new BridgeError("STALE_INPUT", "The answer does not match a currently claimed native request");
      if (!this.#pending.has(id)) throw new BridgeError("INPUT_RUNTIME_UNAVAILABLE", "Native request cannot be answered; preserve its delivery uncertainty");
      if (input.digest !== canonicalHash(input.data) || input.run_id !== state.native.run_id || input.turn_id !== state.native.turn_id) throw new BridgeError("STALE_INPUT", "Native operation or turn changed");
      if (input.data.kind === "permission" && !input.data.approval.choices.some((c) => c.id === answer && (c.scope === "once" || c.decision.startsWith("denied")))) throw new BridgeError("INPUT_ANSWER_INVALID", "Permission answer was not offered for this operation");
      if (input.data.kind === "clarification" && input.data.choices && !input.data.choices.includes(answer)) throw new BridgeError("INPUT_ANSWER_INVALID", "Reply must match one offered native choice; no answer intent was published");
      if (!answer.length || Buffer.byteLength(answer) > 16_384) throw new BridgeError("INPUT_ANSWER_INVALID", "Answer violates the bounded input contract");
      const next: ControlReceipt = { operation_key: operationKey, kind: "input", hash: canonicalHash(contents), outcome: "answer_intent", at: new Date().toISOString(), generation, input_id: id };
      input.answer = answer; input.operation_key = operationKey; input.state = "answer_intent"; delete input.claim;
      state.receipts.push(next); if (!state.inputs.some((i) => i.state === "pending")) state.phase = "active"; dispatch = true;
      return next;
    });
    // Intent is durable before this external native callback is released. No retry re-dispatches it.
    if (dispatch) {
      const pending = this.#pending.get(id);
      if (pending) pending.resolve(answer);
      else {
        await this.controls.change(taskId, (state) => { const input = state.inputs.find((i) => i.input_id === id); if (input?.state === "answer_intent") input.state = "delivery_unknown"; state.phase = "needs_attention"; });
        throw new BridgeError("INPUT_DELIVERY_UNKNOWN", "Answer intent is durable but native delivery is unknown; do not resend");
      }
    }
    return receipt;
  }
  async withdraw(taskId: string, nativeId: string): Promise<void> {
    const ids: string[] = [];
    await this.controls.change(taskId, (state) => {
      for (const input of state.inputs) if (input.native_id === nativeId && input.turn_id === state.native.turn_id && input.state === "pending") {
        input.state = "withdrawn"; delete input.claim; ids.push(input.input_id);
      }
    });
    for (const id of ids) this.#pending.get(id)?.reject(new BridgeError("NATIVE_INPUT_WITHDRAWN", "The native runtime withdrew the pending request"));
  }
  async settleTurn(taskId: string, turnId: string): Promise<void> {
    await this.controls.change(taskId, (state) => {
      for (const input of state.inputs) if (input.turn_id === turnId && input.state === "answer_intent") input.state = "settled";
    });
  }
}
