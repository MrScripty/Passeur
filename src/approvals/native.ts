import { withAbort } from "../core/async.js";
import { BridgeError } from "../core/errors.js";

type Job = { signal: AbortSignal; execute: () => Promise<void>; abandon: () => void };
/** A connection-scoped presentation actor. No task/store/admission lock is held during external prompts. */
export class ApprovalQueue {
  #queue: Job[] = [];
  #running = false;
  readonly #presentations = new Set<Promise<unknown>>();
  run<T>(signal: AbortSignal, prompt: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    if (this.#queue.length + this.#presentations.size >= 32) return Promise.reject(new BridgeError("PRESENTATION_CAPACITY", "Too many queued human presentations"));
    let resolve!: (v: T) => void, reject!: (e: unknown) => void;
    const result = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    const abort = () => { const index = this.#queue.indexOf(job); if (index >= 0) this.#queue.splice(index, 1); reject(signal.reason); };
    const job: Job = { signal, abandon: () => { signal.removeEventListener("abort", abort); }, execute: async () => {
      try {
        signal.throwIfAborted(); const native = Promise.resolve().then(prompt); this.#presentations.add(native);
        void native.then(() => this.#presentations.delete(native), () => this.#presentations.delete(native));
        const value = await withAbort(native, signal); signal.throwIfAborted(); resolve(value);
      }
      catch (error) { reject(error); }
    } };
    signal.addEventListener("abort", abort, { once: true });
    this.#queue.push(job); this.#pump();
    return result.finally(() => job.abandon());
  }
  #pump(): void {
    if (this.#running) return;
    const job = this.#queue.shift(); if (!job) return;
    this.#running = true;
    void job.execute().finally(() => { job.abandon(); this.#running = false; this.#pump(); });
  }
}
