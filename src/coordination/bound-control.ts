import { BridgeError } from "../core/errors.js";
import { throwIfAborted } from "../core/async.js";
import { validateSourcePath } from "../observation/source.js";
import { decodeRepositoryCommand, parentId, type Receipt, type Selection } from "../contracts/coordination-control.js";
import { CoordinationControl, type CoordinationActor } from "./control.js";
import { CoordinationRepository, type WorkspaceFacts } from "./repository.js";

/** Supplied by the authenticated service connection; no command may supply its own actor or source view. */
export type CoordinationConnection = Readonly<{ owner_id: string; source_view: string }>;
/** Task/workspace authority is separate from Git membership; the service must consult its actual resource owner. */
export interface ExternalWorkspaceAuthority {
  assertExternalRegistration(actor: CoordinationActor, workspace: WorkspaceFacts, signal?: AbortSignal): Promise<void>;
}
export type BindingLimits = Readonly<{ max_worktrees: number; max_source_operations: number }>;

/** Service-facing source gate. The service owns one instance, election, actor authentication, and final shutdown. */
export class RepositoryCoordination {
  readonly #pending = new Set<Promise<unknown>>();
  #sourceOperations = 0;
  #closing = false;
  #close: Promise<void> | undefined;
  private constructor(readonly repository: CoordinationRepository, private readonly control: CoordinationControl,
    private readonly externalAuthority: ExternalWorkspaceAuthority, private readonly sourceCapacity: number) {}

  static async open(root: string, control: CoordinationControl, externalAuthority: ExternalWorkspaceAuthority,
    limits: BindingLimits, signal?: AbortSignal): Promise<RepositoryCoordination> {
    if (!Number.isSafeInteger(limits.max_source_operations) || limits.max_source_operations < 1 || limits.max_source_operations > 64) {
      throw new BridgeError("COORDINATION_SOURCE_CAPACITY_INVALID", "An explicit source-operation limit from 1 to 64 is required");
    }
    if (typeof externalAuthority?.assertExternalRegistration !== "function") throw new BridgeError("COORDINATION_WORKSPACE_AUTHORITY_UNAVAILABLE", "External registration requires its service resource authority");
    const repository = await CoordinationRepository.open(root, control.repositoryId, limits.max_worktrees, signal);
    return new RepositoryCoordination(repository, control, externalAuthority, limits.max_source_operations);
  }

  async execute(connection: CoordinationConnection, raw: unknown, signal?: AbortSignal): Promise<Receipt> {
    // Decode/copy synchronously so a caller cannot change request identity during asynchronous Git work.
    const actor: CoordinationActor = Object.freeze({ owner_id: parentId(connection.owner_id) });
    const sourceView = connection.source_view, command = decodeRepositoryCommand(raw);
    return this.#track(async () => {
      throwIfAborted(signal);
      if (command.kind === "register_external_work") {
        return this.#source(async () => {
          const workspace = await this.repository.inspect(sourceView, signal);
          for (const area of command.areas) validateSourcePath(area.path);
          await this.repository.retainedBetween(command.input_oid, command.input_oid, workspace.head_oid, signal);
          // This code can read TaskStore/resource ownership. It runs outside the coordination-store lock.
          await this.externalAuthority.assertExternalRegistration(actor, workspace, signal);
          const current = await this.repository.inspect(sourceView, signal);
          if (current.workspace_id !== workspace.workspace_id) throw new BridgeError("COORDINATION_SOURCE_CHANGED", "The approved workspace identity changed during resource authorization");
          if (current.head_oid !== workspace.head_oid) await this.repository.retainedBetween(command.input_oid, command.input_oid, current.head_oid, signal);
          throwIfAborted(signal);
          return this.control.execute(actor, { ...command, kind: "register_work", workspace_id: workspace.workspace_id, object_format: workspace.object_format });
        });
      }
      if (command.kind !== "claim_target" && command.kind !== "select_inputs" && command.kind !== "begin_external_integration") {
        // Revocation, settlement and release work after source loss and under source-operation saturation.
        return this.control.execute(actor, command);
      }
      const prepared = await this.control.prepareSourceCommand(actor, command);
      if (prepared.kind === "recorded") return prepared.receipt;
      return this.#source(async () => {
        await this.repository.inspect(sourceView, signal);
        if (command.kind === "claim_target") await this.repository.target(command.target, undefined, signal);
        else {
          const item = prepared.target;
          if (!item) throw new BridgeError("COORDINATION_STATE_INVALID", "A source operation lost its permission-checked case");
          const target = command.kind === "select_inputs" ? command.target_oid : item.target_oid;
          const inputs: Selection[] = command.kind === "select_inputs" ? command.inputs : item.inputs;
          if (target === null || command.kind === "begin_external_integration" && !inputs.length) {
            throw new BridgeError("COORDINATION_INPUTS_REQUIRED", "Record exact intended inputs and target observation first");
          }
          await this.repository.target(item.target, target, signal);
          const workspaces = await this.repository.resolveMany(prepared.works.map(w => w.workspace_id), signal);
          for (const input of inputs) {
            const work = prepared.works.find(w => w.id === input.work_id)!;
            const workspace = workspaces.get(work.workspace_id)!;
            if (work.object_format !== workspace.object_format) throw new BridgeError("COORDINATION_OBJECT_FORMAT_CONFLICT", "Work metadata contradicts its repository object format");
            await this.repository.retainedBetween(work.input_oid, input.commit_oid, workspace.head_oid, signal);
          }
          // This is fresh evidence for a metadata transition, not a lock against external ref changes.
          await this.repository.target(item.target, target, signal);
        }
        throwIfAborted(signal);
        // Rechecks authorization, case revision, leadership and shared inputs after read-only inspection.
        return this.control.execute(actor, command);
      });
    });
  }

  async receipt(actor: CoordinationActor, operationKey: unknown): Promise<Receipt | undefined> {
    const owner = Object.freeze({ owner_id: parentId(actor.owner_id) });
    return this.#track(() => this.control.receipt(owner, operationKey));
  }
  async #source<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#sourceOperations >= this.sourceCapacity) throw new BridgeError("COORDINATION_SOURCE_CAPACITY", "Source inspection is at capacity; metadata controls remain available");
    this.#sourceOperations++;
    try { return await operation(); } finally { this.#sourceOperations--; }
  }
  #track<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closing) return Promise.reject(new BridgeError("COORDINATION_CLOSED", "Repository coordination is closing"));
    const promise = operation(); this.#pending.add(promise);
    void promise.then(() => this.#pending.delete(promise), () => this.#pending.delete(promise));
    return promise;
  }
  close(): Promise<void> {
    this.#closing = true;
    this.#close ??= (async () => { await Promise.allSettled([...this.#pending]); await this.control.close(); })();
    return this.#close;
  }
}
