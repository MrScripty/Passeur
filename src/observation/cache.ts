import { randomUUID } from "node:crypto";
import { BridgeError } from "../core/errors.js";
import type { SourceFile } from "./model.js";

export type CachedPair = Readonly<{ work_id: string; work_revision: number; input: SourceFile; observed: SourceFile }>;
const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
const MAX_CAPTURE_PAIRS = 32;
const pairBytes = (pair: CachedPair) => (pair.input.status === "present" ? pair.input.byte_length : 0)
  + (pair.observed.status === "present" ? pair.observed.byte_length : 0);

/** Bounded current-process source evidence. Eviction/restart makes old working detail unavailable. */
export class CapturedPairCache {
  #entries = new Map<string, CachedPair>();
  #bytes = 0;

  put(pair: CachedPair): string {
    const bytes = pairBytes(pair);
    if (bytes > MAX_CAPTURE_BYTES) throw new BridgeError("STRUCTURAL_CAPTURE_TOO_LARGE", "A captured pair exceeds the retained detail limit");
    while (this.#entries.size >= MAX_CAPTURE_PAIRS || this.#bytes + bytes > MAX_CAPTURE_BYTES) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      const removed = this.#entries.get(oldest)!;
      this.#entries.delete(oldest); this.#bytes -= pairBytes(removed);
    }
    const id = randomUUID();
    this.#entries.set(id, Object.freeze(pair));
    this.#bytes += bytes;
    return id;
  }

  get(id: string): CachedPair {
    const found = this.#entries.get(id);
    if (!found) throw new BridgeError("STRUCTURAL_DETAIL_UNAVAILABLE", "The exact captured detail was evicted or belongs to another service generation");
    return found;
  }

  clear(): void { this.#entries.clear(); this.#bytes = 0; }
}
