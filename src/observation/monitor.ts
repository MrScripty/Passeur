import { watch, type FSWatcher } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import { BridgeError } from "../core/errors.js";
import type { Region } from "../contracts/coordination-control.js";
import { listDeclaredSourcePaths } from "./source-inventory.js";

const MAX_WORKSPACES = 32;
const MAX_WATCHERS = 128;
const MAX_WATCH_DEPTH = 16;
const MAX_WATCH_ENTRIES = 2048;
const MAX_WAITERS = 16;
const MAX_PATHS = 256;
const QUIET_MS = 150;
const SWEEP_MS = 60_000;

export type ObservationWorkspace = Readonly<{
  work_id: string;
  work_revision: number;
  control_generation: number;
  workspace_id: string;
  workspace_generation: number;
  root: string;
  input_commit_oid: string;
  areas: readonly Region[];
}>;

export type ObservationJob = Readonly<{
  workspace: ObservationWorkspace;
  generation: number;
  capture_id: string;
  paths: readonly string[];
  limitations: readonly string[];
  reason: string;
  signal: AbortSignal;
}>;

export type ObservationAnalysis<T> =
  | Readonly<{ kind: "artifact"; evidence_id: string; artifact: T; limitations?: readonly string[] }>
  | Readonly<{ kind: "incomplete"; limitation: string; limitations?: readonly string[] }>;

export type ObservationOutcome = Readonly<{
  work_id: string;
  workspace_id: string;
  generation: number;
  capture_id: string;
  status: "published" | "unchanged" | "incomplete" | "superseded";
  limitations: readonly string[];
}>;

export type ObservationMonitorOptions<T> = Readonly<{
  analyze: (job: ObservationJob) => Promise<ObservationAnalysis<T>>;
  /** Publish the immutable artifact before creating a durable notice. Recheck isCurrent at that point. */
  publish: (job: ObservationJob, artifact: T, isCurrent: () => boolean) => Promise<void>;
}>;

type Waiter = { resolve: (outcome: ObservationOutcome) => void; reject: (reason: unknown) => void };
type WorkspaceState = {
  key: string;
  workspace: ObservationWorkspace;
  generation: number;
  lastEvidence?: string;
  lastOutcome?: ObservationOutcome;
  reason: string;
  dirty: boolean;
  queued: boolean;
  timer?: NodeJS.Timeout;
  watchers: FSWatcher[];
  coverage: Set<string>;
  waiters: Waiter[];
  active?: AbortController;
};

function keyOf(workspace: ObservationWorkspace): string { return JSON.stringify([workspace.work_id, workspace.workspace_id]); }
function within(root: string, path: string): boolean {
  const rest = relative(root, path);
  return rest !== ".." && !rest.startsWith(`..${sep}`) && !rest.startsWith(sep);
}
function declared(path: string, areas: readonly Region[]): boolean {
  return areas.some(area => area.path === path ||
    (area.kind === "subtree" && path.startsWith(`${area.path}/`)) ||
    area.path.startsWith(`${path}/`));
}
function outcome(state: WorkspaceState, captureId: string, status: ObservationOutcome["status"], limitations: readonly string[]): ObservationOutcome {
  return Object.freeze({ work_id: state.workspace.work_id, workspace_id: state.workspace.workspace_id,
    generation: state.generation, capture_id: captureId, status, limitations: Object.freeze([...new Set(limitations)].sort()) });
}

/** Linux fs events are hints. Reconciliation and exact source capture own evidence. */
export class ObservationMonitor<T> {
  readonly #options: ObservationMonitorOptions<T>;
  readonly #states = new Map<string, WorkspaceState>();
  readonly #queue: WorkspaceState[] = [];
  readonly #sweep: NodeJS.Timeout;
  #watcherCount = 0;
  #running = false;
  #closed = false;
  #idle: Promise<void> = Promise.resolve();

  constructor(options: ObservationMonitorOptions<T>) {
    if (process.platform !== "linux") throw new BridgeError("STRUCTURAL_MONITOR_UNSUPPORTED", "Filesystem observation requires supported Linux local filesystems");
    this.#options = options;
    this.#sweep = setInterval(() => {
      for (const state of this.#states.values()) this.#invalidate(state, "periodic_reconciliation", false);
    }, SWEEP_MS);
    this.#sweep.unref();
  }

  async attach(workspace: ObservationWorkspace, signal?: AbortSignal): Promise<ObservationOutcome> {
    signal?.throwIfAborted();
    if (this.#closed) throw new BridgeError("STRUCTURAL_MONITOR_CLOSED", "Observation admission is closed");
    if (!workspace.work_id || !workspace.workspace_id || !Number.isSafeInteger(workspace.work_revision) ||
      !Number.isSafeInteger(workspace.control_generation) || !Number.isSafeInteger(workspace.workspace_generation) ||
      workspace.work_revision < 0 || workspace.control_generation < 0 || workspace.workspace_generation < 1) {
      throw new BridgeError("STRUCTURAL_MONITOR_WORKSPACE_INVALID", "Observation requires current work and workspace identities");
    }
    const root = await realpath(workspace.root);
    signal?.throwIfAborted();
    if (this.#closed) throw new BridgeError("STRUCTURAL_MONITOR_CLOSED", "Observation admission is closed");
    const snapshot: ObservationWorkspace = Object.freeze({ ...workspace, root,
      areas: Object.freeze(workspace.areas.map(area => Object.freeze({ ...area }))) });
    const key = keyOf(snapshot);
    let state = this.#states.get(key);
    if (!state) {
      if (this.#states.size >= MAX_WORKSPACES) throw new BridgeError("STRUCTURAL_MONITOR_CAPACITY", "Observation workspace capacity is full");
      state = { key, workspace: snapshot, generation: 0, reason: "attach", dirty: false, queued: false,
        watchers: [], coverage: new Set(), waiters: [] };
      this.#states.set(key, state);
    } else {
      if (state.workspace.input_commit_oid !== snapshot.input_commit_oid ||
        state.workspace.work_revision !== snapshot.work_revision ||
        state.workspace.control_generation !== snapshot.control_generation ||
        state.workspace.workspace_generation !== snapshot.workspace_generation ||
        state.workspace.root !== snapshot.root ||
        JSON.stringify(state.workspace.areas) !== JSON.stringify(snapshot.areas)) delete state.lastEvidence;
      state.workspace = snapshot;
    }
    const pending = this.#request(state, "attach", false);
    if (!signal) return pending;
    const abort = () => this.detach(workspace.work_id, workspace.workspace_id);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try { return await pending; }
    finally { signal.removeEventListener("abort", abort); }
  }

  invalidate(workId: string, workspaceId: string, path?: string): void {
    const state = this.#states.get(JSON.stringify([workId, workspaceId]));
    if (!state || this.#closed) return;
    if (path !== undefined && !declared(path, state.workspace.areas)) return;
    this.#invalidate(state, "filesystem_event", true);
  }

  refresh(workId: string, workspaceId: string): Promise<ObservationOutcome> {
    return this.reconcile(workId, workspaceId, "explicit_refresh");
  }

  reconcile(workId: string, workspaceId: string, reason = "checkpoint"): Promise<ObservationOutcome> {
    if (this.#closed) return Promise.reject(new BridgeError("STRUCTURAL_MONITOR_CLOSED", "Observation admission is closed"));
    const state = this.#states.get(JSON.stringify([workId, workspaceId]));
    if (!state) return Promise.reject(new BridgeError("STRUCTURAL_MONITOR_WORKSPACE_UNAVAILABLE", "Observation workspace is not attached"));
    return this.#request(state, reason, false);
  }

  status(workId: string, workspaceId: string): ObservationOutcome | undefined {
    return this.#states.get(JSON.stringify([workId, workspaceId]))?.lastOutcome;
  }

  detach(workId: string, workspaceId: string): void {
    const key = JSON.stringify([workId, workspaceId]);
    const state = this.#states.get(key);
    if (!state) return;
    this.#states.delete(key);
    state.generation++;
    state.active?.abort(new BridgeError("STRUCTURAL_ANALYSIS_CANCELLED", "Observation workspace detached"));
    if (state.timer) clearTimeout(state.timer);
    this.#closeWatchers(state);
    this.#settle(state, outcome(state, randomUUID(), "superseded", ["workspace_detached"]));
  }

  #request(state: WorkspaceState, reason: string, quiet: boolean): Promise<ObservationOutcome> {
    if (state.waiters.length >= MAX_WAITERS) return Promise.reject(new BridgeError("STRUCTURAL_MONITOR_CAPACITY", "Observation request capacity is full"));
    const promise = new Promise<ObservationOutcome>((resolve, reject) => { state.waiters.push({ resolve, reject }); });
    this.#invalidate(state, reason, quiet);
    return promise;
  }

  #invalidate(state: WorkspaceState, reason: string, quiet: boolean): void {
    state.generation++;
    state.reason = reason;
    state.dirty = true;
    state.active?.abort(new BridgeError("STRUCTURAL_ANALYSIS_CANCELLED", "Observation capture was superseded"));
    if (state.timer) clearTimeout(state.timer);
    if (quiet) {
      state.timer = setTimeout(() => { delete state.timer; this.#enqueue(state); }, QUIET_MS);
      state.timer.unref();
    } else this.#enqueue(state);
  }

  #enqueue(state: WorkspaceState): void {
    if (this.#closed || this.#states.get(state.key) !== state || state.queued) return;
    state.queued = true;
    this.#queue.push(state);
    void this.#pump();
  }

  async #pump(): Promise<void> {
    if (this.#running || this.#closed) return;
    this.#running = true;
    this.#idle = (async () => {
      while (!this.#closed && this.#queue.length) {
        const state = this.#queue.shift()!;
        state.queued = false;
        if (this.#states.get(state.key) !== state || !state.dirty) continue;
        state.dirty = false;
        await this.#run(state);
        if (state.dirty && !state.timer) this.#enqueue(state);
      }
    })();
    try { await this.#idle; }
    finally { this.#running = false; if (!this.#closed && this.#queue.length) void this.#pump(); }
  }

  async #run(state: WorkspaceState): Promise<void> {
    const generation = state.generation;
    const captureId = randomUUID();
    const controller = new AbortController();
    state.active = controller;
    const current = () => !this.#closed && this.#states.get(state.key) === state &&
      state.generation === generation && !controller.signal.aborted;
    const limitations = new Set(state.coverage);
    const workspace = state.workspace;
    try {
      const inventory = await listDeclaredSourcePaths(workspace.root, workspace.input_commit_oid,
        workspace.areas, MAX_PATHS, controller.signal);
      for (const limitation of inventory.limitations) limitations.add(limitation);
      if (!current()) return;
      await this.#replaceWatchers(state);
      for (const limitation of state.coverage) limitations.add(limitation);
      if (!current()) return;
      const job: ObservationJob = Object.freeze({ workspace, generation, capture_id: captureId,
        paths: Object.freeze(inventory.paths), limitations: Object.freeze([...limitations].sort()),
        reason: state.reason, signal: controller.signal });
      const result = await this.#options.analyze(job);
      if (!current()) return;
      if (result.kind === "incomplete") {
        state.lastOutcome = outcome(state, captureId, "incomplete", [...limitations, result.limitation, ...(result.limitations ?? [])]);
      } else if (state.lastEvidence === result.evidence_id) {
        state.lastOutcome = outcome(state, captureId, "unchanged", [...limitations, ...(result.limitations ?? [])]);
      } else {
        await this.#options.publish(job, result.artifact, current);
        if (!current()) return;
        state.lastEvidence = result.evidence_id;
        state.lastOutcome = outcome(state, captureId, "published", [...limitations, ...(result.limitations ?? [])]);
      }
    } catch (error) {
      if (!current()) return;
      const code = error instanceof BridgeError ? error.code : "STRUCTURAL_OBSERVATION_UNAVAILABLE";
      state.lastOutcome = outcome(state, captureId, "incomplete", [...limitations, code]);
    } finally {
      if (state.active === controller) delete state.active;
      if (current() && state.lastOutcome) this.#settle(state, state.lastOutcome);
    }
  }

  async #replaceWatchers(state: WorkspaceState): Promise<void> {
    this.#closeWatchers(state);
    state.coverage.clear();
    const root = state.workspace.root;
    const dirs = new Set<string>([root]);
    let entries = 0;
    const visit = async (path: string, depth: number): Promise<void> => {
      if (depth > MAX_WATCH_DEPTH) { state.coverage.add("watch_depth_limit"); return; }
      if (dirs.size >= MAX_WATCHERS || entries >= MAX_WATCH_ENTRIES) {
        state.coverage.add("watch_capacity_limit"); return;
      }
      let children;
      try { children = await readdir(path, { withFileTypes: true }); }
      catch { state.coverage.add("watch_directory_unavailable"); return; }
      entries += children.length;
      if (entries > MAX_WATCH_ENTRIES) { state.coverage.add("watch_entry_limit"); return; }
      for (const child of children) {
        if (!child.isDirectory() || child.isSymbolicLink() || child.name === ".git") continue;
        const absolute = join(path, child.name);
        const rel = relative(root, absolute).split(sep).join("/");
        if (!within(root, absolute) || !declared(rel, state.workspace.areas)) continue;
        dirs.add(absolute);
        if (state.workspace.areas.some(area => area.kind === "subtree" &&
          (rel === area.path || rel.startsWith(`${area.path}/`))) ||
          state.workspace.areas.some(area => area.path.startsWith(`${rel}/`))) {
          await visit(absolute, depth + 1);
        }
      }
    };
    await visit(root, 0);
    for (const dir of [...dirs].sort()) {
      if (this.#watcherCount >= MAX_WATCHERS) { state.coverage.add("watch_capacity_limit"); break; }
      try {
        const watcher = watch(dir, { persistent: false }, (_event, name) => {
          if (this.#closed || this.#states.get(state.key) !== state) return;
          if (!name) { state.coverage.add("watch_event_name_missing"); this.#invalidate(state, "event_coverage_loss", true); return; }
          const path = relative(root, resolve(dir, name.toString())).split(sep).join("/");
          if (path === "" || declared(path, state.workspace.areas)) this.#invalidate(state, "filesystem_event", true);
        });
        watcher.on("error", () => {
          state.coverage.add("watch_failed");
          this.#invalidate(state, "event_coverage_loss", false);
        });
        state.watchers.push(watcher);
        this.#watcherCount++;
      } catch { state.coverage.add("watch_unavailable"); }
    }
  }

  #closeWatchers(state: WorkspaceState): void {
    for (const watcher of state.watchers.splice(0)) { watcher.close(); this.#watcherCount--; }
  }

  #settle(state: WorkspaceState, result: ObservationOutcome): void {
    for (const waiter of state.waiters.splice(0)) waiter.resolve(result);
  }

  async close(): Promise<void> {
    if (this.#closed) return this.#idle;
    this.#closed = true;
    clearInterval(this.#sweep);
    for (const state of this.#states.values()) {
      if (state.timer) clearTimeout(state.timer);
      state.active?.abort(new BridgeError("STRUCTURAL_ANALYSIS_CANCELLED", "Observation manager closed"));
      this.#closeWatchers(state);
      this.#settle(state, outcome(state, randomUUID(), "superseded", ["monitor_closed"]));
    }
    this.#states.clear();
    this.#queue.length = 0;
    await this.#idle;
  }
}
