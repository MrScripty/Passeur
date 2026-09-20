import { createHash } from "node:crypto";
import { BridgeError } from "./errors.js";

/** Only the caller's critical section is serialized; rejected work does not poison the queue. */
export class Mutex {
  #tail: Promise<void> = Promise.resolve();
  async run<T>(operation: () => T | Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }
  async idle(): Promise<void> { await this.run(() => undefined); }
}
export class KeyedMutex {
  #locks = new Map<string, { lock: Mutex; users: number }>();
  async run<T>(key: string, operation: () => T | Promise<T>): Promise<T> {
    let entry = this.#locks.get(key);
    if (!entry) { entry = { lock: new Mutex(), users: 0 }; this.#locks.set(key, entry); }
    entry.users++;
    try { return await entry.lock.run(operation); }
    finally { if (--entry.users === 0) this.#locks.delete(key); }
  }
}
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new BridgeError("REQUEST_CANCELLED", "Request cancelled");
}
/** Detaches a subscriber. It deliberately does not cancel the underlying operation. */
export function withAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  // The losing operation is handled even when the signal was already aborted.
  operation.catch(() => undefined);
  if (signal.aborted) return Promise.reject(signal.reason ?? new BridgeError("REQUEST_CANCELLED", "Request cancelled"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new BridgeError("REQUEST_CANCELLED", "Request cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
export async function settlesWithin(operation: Promise<unknown>, milliseconds: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation.then(() => true, () => false),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), Math.max(1, milliseconds)); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
export function stableHash(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => [key, canonical(val)]));
    return item;
  };
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
