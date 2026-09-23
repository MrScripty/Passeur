import { BridgeError } from "../core/errors.js";

export type InventorySelection = Readonly<{
  /** Undefined starts a priority-first cycle; the empty string starts its ordinary continuation. */
  after_path?: string;
  priority_paths?: readonly string[];
}>;
export type SelectedInventory = Readonly<{ paths: string[]; next_path?: string }>;

/** A bounded page of names. The inventory owner, not this selector, proves scope and filesystem identity. */
export class SourcePathPage {
  readonly #limit: number;
  readonly #after: string | undefined;
  readonly #priority: ReadonlyMap<string, number>;
  readonly #paths = new Set<string>();
  #overflow = false;

  constructor(limit: number, selection: InventorySelection = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256 ||
        selection.priority_paths !== undefined && selection.priority_paths.length > 256) {
      throw new BridgeError("STRUCTURAL_INVENTORY_LIMIT_INVALID", "Inventory selection must fit its bounded page and priority limits");
    }
    if (selection.after_path !== undefined && (typeof selection.after_path !== "string" ||
        Buffer.byteLength(selection.after_path, "utf8") > 4096 || selection.after_path.includes("\0"))) {
      throw new BridgeError("STRUCTURAL_INVENTORY_CURSOR_INVALID", "Invalid source inventory continuation");
    }
    this.#limit = limit;
    this.#after = selection.after_path;
    const priority = new Map<string, number>();
    for (const path of selection.after_path === undefined ? selection.priority_paths ?? [] : []) {
      if (!priority.has(path)) priority.set(path, priority.size);
    }
    this.#priority = priority;
  }

  #compare(a: string, b: string): number {
    const left = this.#priority.get(a), right = this.#priority.get(b);
    if (left !== undefined || right !== undefined) {
      if (left === undefined) return 1;
      if (right === undefined) return -1;
      return left - right;
    }
    return a < b ? -1 : a > b ? 1 : 0;
  }

  add(path: string): void {
    if (this.#after !== undefined && path <= this.#after || this.#paths.has(path)) return;
    if (this.#paths.size < this.#limit) { this.#paths.add(path); return; }
    this.#overflow = true;
    const largest = [...this.#paths].sort((a, b) => this.#compare(a, b)).at(-1)!;
    if (this.#compare(path, largest) < 0) { this.#paths.delete(largest); this.#paths.add(path); }
  }

  removeBeneath(boundary: string): void {
    for (const path of this.#paths) if (path === boundary || path.startsWith(`${boundary}/`)) this.#paths.delete(path);
  }

  result(sourceHasMore = false): SelectedInventory {
    const paths = [...this.#paths].sort((a, b) => this.#compare(a, b));
    // Priorities can jump ahead of the ordinary cursor. Continue after only the
    // ordinary prefix so intermediate paths are never skipped. A priority may
    // therefore reappear once in ordinary traversal; publication deduplicates it.
    const ordinary = paths.filter(path => !this.#priority.has(path));
    const next = ordinary.at(-1) ?? this.#after ?? "";
    return { paths, ...((this.#overflow || sourceHasMore) && paths.length ? { next_path: next } : {}) };
  }
}
