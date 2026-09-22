import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { canonicalHash, throwIfAborted } from "../core/async.js";
import { BridgeError, nativeCode } from "../core/errors.js";
import { gitWithoutLazyFetch, projectId } from "../workspace/project.js";
import { coordinationOid, coordinationTarget } from "../contracts/coordination-control.js";

export type WorkspaceFacts = Readonly<{
  workspace_id: string; root: string; git_dir: string; common_dir: string;
  repository_id: string; object_format: "sha1" | "sha256"; head_oid: string;
}>;
type DirectoryIdentity = Readonly<{ path: string; device: string; inode: string }>;
type Entry = { path: string; head: string | null; bare: boolean; prunable: boolean };
// Read-only commands, with optional locks/replace objects/fsmonitor and promisor fetching disabled.
const flags = ["--no-optional-locks", "--literal-pathspecs", "--no-replace-objects", "-c", "core.fsmonitor=false"];
const inspectGit = (root: string, args: string[], signal?: AbortSignal) => gitWithoutLazyFetch(root, [...flags, ...args], signal);
const changed = () => new BridgeError("COORDINATION_SOURCE_CHANGED", "Source identity changed during inspection; no coordination effect was accepted");

/** A bounded observation of actual Git membership, not an editor lock or process-liveness claim. */
export class CoordinationRepository {
  private constructor(private readonly common: DirectoryIdentity,
    readonly repositoryId: string, readonly objectFormat: "sha1" | "sha256", private readonly maxWorktrees: number) {}

  static async open(root: string, expectedRepository: string, maxWorktrees: number, signal?: AbortSignal): Promise<CoordinationRepository> {
    if (process.platform !== "linux") throw new BridgeError("COORDINATION_PLATFORM_UNSUPPORTED", "Workspace binding is qualified only for local Linux filesystems");
    if (!Number.isSafeInteger(maxWorktrees) || maxWorktrees < 1 || maxWorktrees > 4096) throw new BridgeError("COORDINATION_INVENTORY_LIMIT_INVALID", "An explicit worktree inventory limit from 1 to 4096 is required");
    if (!/^[a-f0-9]{24}$/.test(expectedRepository)) throw new BridgeError("COORDINATION_BINDING_CONFLICT", "Expected the existing canonical repository namespace");
    const anchor = await directory(root);
    await topLevel(anchor.path, signal);
    const common = await directory(line(await inspectGit(anchor.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal)));
    if (projectId(common.path) !== expectedRepository) throw new BridgeError("COORDINATION_BINDING_CONFLICT", "Source is outside the service repository");
    const format = line(await inspectGit(anchor.path, ["rev-parse", "--show-object-format=storage"], signal));
    if (format !== "sha1" && format !== "sha256") throw new BridgeError("COORDINATION_OBJECT_FORMAT_UNSUPPORTED", "Git storage object format is unsupported");
    const result = new CoordinationRepository(common, expectedRepository, format, maxWorktrees);
    await result.inspect(anchor.path, signal);
    return result;
  }

  async #assertRepository(): Promise<void> {
    if (!same(await directory(this.common.path), this.common)) throw changed();
  }
  async #entries(signal?: AbortSignal): Promise<Entry[]> {
    throwIfAborted(signal); await this.#assertRepository();
    const entries = listing(await inspectGit(this.common.path, ["worktree", "list", "--porcelain", "-z"], signal), this.maxWorktrees);
    if (new Set(entries.map(e => e.path)).size !== entries.length) throw new BridgeError("COORDINATION_GIT_OUTPUT_INVALID", "Duplicate worktree registration paths");
    return entries;
  }
  async #facts(path: string, entry: Entry, signal?: AbortSignal): Promise<WorkspaceFacts> {
    if (entry.bare || entry.prunable || !entry.head || /^0+$/.test(entry.head)) throw new BridgeError("COORDINATION_WORKSPACE_UNAVAILABLE", "The registration is bare, has no initial commit, or requires explicit worktree reconciliation");
    const root = await directory(path);
    await topLevel(root.path, signal);
    const common = await directory(line(await inspectGit(root.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal)));
    if (!same(common, this.common)) throw new BridgeError("COORDINATION_BINDING_CONFLICT", "Workspace does not share the service's canonical Git directory");
    const gitDir = await directory(line(await inspectGit(root.path, ["rev-parse", "--absolute-git-dir"], signal)));
    const suffix = relative(this.common.path, gitDir.path);
    if (gitDir.path !== this.common.path && (isAbsolute(suffix) || !suffix.startsWith("worktrees/") || suffix.split("/").length !== 2)) {
      throw new BridgeError("COORDINATION_WORKSPACE_UNAVAILABLE", "Unsupported linked-worktree administration layout");
    }
    const head = this.#oid(line(await inspectGit(root.path, ["rev-parse", "--verify", "HEAD"], signal)));
    if (entry.head !== head) throw changed();
    if (!same(await directory(root.path), root) || !same(await directory(gitDir.path), gitDir)) throw changed();
    await this.#assertRepository();
    return Object.freeze({ workspace_id: `git-worktree-v1:${canonicalHash({ repository: this.repositoryId, root, git_dir: gitDir })}`,
      root: root.path, git_dir: gitDir.path, common_dir: common.path, repository_id: this.repositoryId, object_format: this.objectFormat, head_oid: head });
  }
  async inspect(root: string, signal?: AbortSignal): Promise<WorkspaceFacts> {
    const canonical = (await directory(root)).path;
    const entries = await this.#entries(signal);
    const matches: Entry[] = [];
    for (const entry of entries) {
      try { if ((await directory(entry.path)).path === canonical) matches.push(entry); }
      catch (error) { if (nativeCode(error) !== "ENOENT") throw error; }
    }
    if (matches.length !== 1) throw new BridgeError("COORDINATION_WORKSPACE_UNREGISTERED", "Source is not exactly one live Git worktree in this repository");
    return this.#facts(canonical, matches[0]!, signal);
  }
  /** Resolve only identities derived by this boundary. An old metadata label is not source authority. */
  async resolveMany(ids: readonly string[], signal?: AbortSignal): Promise<ReadonlyMap<string, WorkspaceFacts>> {
    if (ids.length > this.maxWorktrees || ids.some(id => !/^git-worktree-v1:[a-f0-9]{64}$/.test(id))) {
      throw new BridgeError("COORDINATION_WORKSPACE_UNVERIFIED", "Work identity was not established by the repository binding contract or exceeds the inventory bound");
    }
    const wanted = new Set(ids), result = new Map<string, WorkspaceFacts>();
    if (!wanted.size) return result;
    const entries = await this.#entries(signal);
    for (const entry of entries) {
      if (entry.bare || entry.prunable || !entry.head || /^0+$/.test(entry.head)) continue;
      let facts: WorkspaceFacts;
      try { facts = await this.#facts(entry.path, entry, signal); }
      catch (error) { if (nativeCode(error) === "ENOENT") continue; throw error; }
      if (wanted.has(facts.workspace_id)) result.set(facts.workspace_id, facts);
      if (result.size === wanted.size) return result;
    }
    throw new BridgeError("COORDINATION_WORKSPACE_UNAVAILABLE", "A selected workspace is absent or its physical identity changed; retained control is preserved");
  }
  #oid(value: unknown): string {
    const oid = coordinationOid(value);
    if (oid.length !== (this.objectFormat === "sha1" ? 40 : 64)) throw new BridgeError("COORDINATION_OBJECT_FORMAT_CONFLICT", "Commit identity uses a different object format");
    return oid;
  }
  async commit(value: unknown, signal?: AbortSignal): Promise<string> {
    const oid = this.#oid(value); await this.#assertRepository();
    let type: string;
    try { type = line(await inspectGit(this.common.path, ["cat-file", "-t", oid], signal)); }
    catch (error) {
      if (error instanceof BridgeError && error.code === "GIT_ERROR") throw new BridgeError("COORDINATION_COMMIT_UNAVAILABLE", "Exact object cannot be inspected locally", { cause: error });
      throw error;
    }
    if (type !== "commit") throw new BridgeError("COORDINATION_COMMIT_REQUIRED", "Expected an exact commit object, not a peeled tag, tree or blob");
    return oid;
  }
  async retainedBetween(input: string, selected: string, head: string, signal?: AbortSignal): Promise<void> {
    const base = await this.commit(input, signal), candidate = await this.commit(selected, signal), current = await this.commit(head, signal);
    // A commit excluded by the descendant is reachable from that descendant. This has no merge-base ambiguity.
    for (const [ancestor, descendant] of [[base, candidate], [candidate, current]] as const) {
      const outside = await inspectGit(this.common.path, ["rev-list", "--max-count=1", ancestor, "--not", descendant], signal);
      if (outside !== "") throw new BridgeError("COORDINATION_SOURCE_LINEAGE_CONFLICT", "Selected commit must descend from admitted input and be retained by the observed workspace HEAD");
    }
  }
  async target(value: unknown, expected?: string, signal?: AbortSignal): Promise<string> {
    const ref = coordinationTarget(value); await this.#assertRepository();
    try { await inspectGit(this.common.path, ["check-ref-format", ref], signal); }
    catch (error) {
      if (error instanceof BridgeError && error.code === "GIT_ERROR") throw new BridgeError("COORDINATION_TARGET_INVALID", "Target is not a valid full local branch ref", { cause: error });
      throw error;
    }
    const output = await inspectGit(this.common.path, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)", ref], signal);
    const rows = output.split("\n").filter(Boolean).map(row => row.split("\0"));
    if (rows.some(row => row.length !== 3)) throw new BridgeError("COORDINATION_GIT_OUTPUT_INVALID", "Malformed exact-ref observation");
    const matches = rows.filter(row => row[0] === ref);
    if (matches.length !== 1) throw new BridgeError("COORDINATION_TARGET_UNAVAILABLE", "The exact local target ref does not exist");
    const row = matches[0]!;
    if (row[2] !== "") throw new BridgeError("COORDINATION_TARGET_SYMBOLIC", "A symbolic alias cannot create an independent reconciliation target");
    const oid = await this.commit(row[1], signal);
    if (expected !== undefined && oid !== this.#oid(expected)) throw new BridgeError("COORDINATION_TARGET_CHANGED", "Target no longer matches the selected observation; refresh the same case");
    return oid;
  }
}

async function directory(value: string): Promise<DirectoryIdentity> {
  if (typeof value !== "string" || !isAbsolute(value) || Buffer.byteLength(value) > 4096 || value.includes("\0") || Buffer.from(value).toString("utf8") !== value) {
    throw new BridgeError("COORDINATION_SOURCE_PATH_INVALID", "A representable absolute source path is required");
  }
  const path = await realpath(value), info = await lstat(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) throw new BridgeError("COORDINATION_SOURCE_PATH_INVALID", "Source identity requires an existing directory");
  return Object.freeze({ path, device: info.dev.toString(), inode: info.ino.toString() });
}
function same(a: DirectoryIdentity, b: DirectoryIdentity): boolean { return a.path === b.path && a.device === b.device && a.inode === b.inode; }
function line(value: string): string {
  if (!value.endsWith("\n") || value.includes("\0")) throw new BridgeError("COORDINATION_GIT_OUTPUT_INVALID", "Expected one terminated Git value");
  // Paths can themselves contain newlines or trailing spaces. Remove only the command's terminator.
  return value.slice(0, -1);
}
async function topLevel(root: string, signal?: AbortSignal): Promise<void> {
  const bare = line(await inspectGit(root, ["rev-parse", "--is-bare-repository"], signal));
  if (bare !== "false") throw new BridgeError("COORDINATION_WORKSPACE_UNAVAILABLE", "Registration requires a non-bare worktree");
  const top = await realpath(line(await inspectGit(root, ["rev-parse", "--show-toplevel"], signal)));
  if (top !== root) throw new BridgeError("COORDINATION_WORKSPACE_ROOT_INVALID", "Register the complete worktree root, not a subdirectory");
}
function listing(value: string, maximum: number): Entry[] {
  if (!value.endsWith("\0\0")) throw new BridgeError("COORDINATION_GIT_OUTPUT_INVALID", "Worktree inventory lacks its record terminator");
  const entries: Entry[] = [];
  for (const record of value.slice(0, -2).split("\0\0")) {
    const fields = record.split("\0"), path = fields.shift();
    if (!path?.startsWith("worktree ")) throw new BridgeError("COORDINATION_GIT_OUTPUT_INVALID", "Worktree inventory lacks its path field");
    const entry: Entry = { path: path.slice(9), head: null, bare: false, prunable: false }, seen = new Set<string>();
    for (const field of fields) {
      const key = field.split(" ", 1)[0]!;
      if (seen.has(key)) throw new BridgeError("COORDINATION_GIT_OUTPUT_INVALID", "Worktree inventory repeats an identity field");
      seen.add(key);
      if (key === "HEAD") entry.head = coordinationOid(field.slice(5));
      else if (field === "bare") entry.bare = true;
      else if (key === "prunable") entry.prunable = true;
      else if (key !== "branch" && key !== "detached" && key !== "locked") throw new BridgeError("COORDINATION_GIT_OUTPUT_UNSUPPORTED", "Worktree inventory contains an unsupported field");
    }
    entries.push(entry);
    if (entries.length > maximum) throw new BridgeError("COORDINATION_INVENTORY_LIMIT", "Worktree inventory exceeds its explicit observation budget");
  }
  return entries;
}
