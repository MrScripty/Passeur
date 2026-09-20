import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import type { FinalizeOperation, FinalizeReceipt, ResourceRecord } from "../contracts/types.js";
import { Mutex, stableHash } from "./async.js";
import { BridgeError, errorInfo } from "./errors.js";
import { TaskStore } from "../store/task-store.js";
import { deleteProtectedRef, exactCommit, git, isAncestor, refHead, sourceStatus, validateBranchRef, validateOid } from "../workspace/project.js";
import { worktreeEntries } from "../workspace/worktree.js";
export type ResourceGuard = { administration: Mutex; isActive: (taskId: string) => boolean; assertMutationAllowed: () => Promise<void> };
const now = () => new Date().toISOString();

/** Acknowledges externally performed integration. Never merges, cherry-picks, tests, or reviews code. */
export class DispositionManager {
  constructor(readonly project: string, readonly projectId: string, readonly store: TaskStore, readonly guard: ResourceGuard, readonly assertAuthority?: () => void) {}
  async finalize(operation: FinalizeOperation): Promise<FinalizeReceipt> {
    return this.guard.administration.run(async () => {
      validateOid(operation.expected_head);
      await validateBranchRef(this.project, operation.expected_branch_ref);
      const hash = stableHash(operation);
      const prior = await this.store.readOperation(operation.task_id, operation.operation_key);
      if (prior && prior.request_hash !== hash) throw new BridgeError("OPERATION_KEY_CONFLICT", "The operation key belongs to a different disposition");
      if (prior?.state === "done") return prior;
      await this.guard.assertMutationAllowed();
      if (this.guard.isActive(operation.task_id)) throw new BridgeError("TASK_ACTIVE", "A live worker still owns the resource");
      const request = await this.store.find({ task_id: operation.task_id });
      const result = await this.store.readResult(operation.task_id);
      const state = await this.store.readState(operation.task_id);
      let resource = await this.store.readResource(operation.task_id);
      if (!request || request.project_id !== this.projectId || !result || state.phase !== "terminal") throw new BridgeError("RESULT_NOT_READY", "The task needs a durable terminal result owned by this repository");
      if (request.request.schema_version !== 2 || !resource || resource.state === "legacy_unclassified") throw new BridgeError("LEGACY_UNCLASSIFIED", "Historical tasks require explicit resource classification; no ownership is inferred");
      if (result.worker_stop === "unconfirmed" && !resource.stop_reconciled) throw new BridgeError("RECONCILIATION_REQUIRED", "Worker shutdown is unconfirmed");
      if (resource.project_id !== this.projectId || resource.task_id !== operation.task_id || !resource.worktree_path || resource.branch_ref !== operation.expected_branch_ref) throw new BridgeError("RESOURCE_OWNERSHIP_INVALID", "Expected branch/path does not match the recorded task resource");
      if (resource.state === "retired" && !prior) throw new BridgeError("RESOURCE_RETIRED", "Use the original operation key to retrieve the retirement receipt");
      if (resource.state === "cleanup_pending" && resource.operation_key !== operation.operation_key) throw new BridgeError("CLEANUP_PENDING", "Resume the pending retirement with its original operation key");
      if (resource.head_commit && resource.head_commit !== operation.expected_head) throw new BridgeError("HEAD_CHANGED", "The submitted head no longer matches the retained result");
      const currentRef = await refHead(this.project, resource.branch_ref!);
      if (currentRef !== operation.expected_head && !(prior && currentRef === undefined)) throw new BridgeError("HEAD_CHANGED", "Task branch changed; no resources were removed");
      await exactCommit(this.project, operation.expected_head);
      const registered = await worktreeEntries(this.project);
      const own = registered.find((entry) => resolve(entry.path) === resolve(resource!.worktree_path!));
      if (registered.some((entry) => entry.branch === resource!.branch_ref && entry !== own)) throw new BridgeError("BRANCH_IN_USE", "Another worktree uses this branch");
      if (own && (own.head !== operation.expected_head || own.branch !== resource.branch_ref || own.locked || own.prunable)) throw new BridgeError("WORKTREE_UNSAFE", "Worktree is changed, locked, detached, or prunable; explicit reconciliation is required");
      const exists = await lstat(resource.worktree_path).then((info) => {
        if (info.isSymbolicLink()) throw new BridgeError("WORKTREE_UNSAFE", "Owned worktree path was replaced by a symlink");
        return true;
      }).catch((error) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; });
      if ((!own || !exists) && !(prior && !own && !exists)) throw new BridgeError("RESOURCE_OWNERSHIP_INVALID", "Resource is missing or no longer registered; no broad prune is performed");
      if (operation.disposition === "retained") {
        if (!operation.owner?.trim() || !operation.reason?.trim() || !operation.next_action?.trim()) throw new BridgeError("RETENTION_CONTEXT_REQUIRED", "Retention requires owner, reason, and next_action");
        resource = { ...resource, state: "retained", head_commit: operation.expected_head, disposition: "retained", owner: operation.owner, reason: operation.reason, next_action: operation.next_action, updated_at: now() };
        await this.store.writeResource(operation.task_id, resource);
        const receipt: FinalizeReceipt = { operation, request_hash: hash, state: "done", resource, updated_at: now() };
        await this.store.writeOperation(operation.task_id, receipt);
        return receipt;
      }
      if (operation.cleanup_authorized !== true) throw new BridgeError("CLEANUP_AUTHORITY_REQUIRED", "Explicit cleanup_authorized is required");
      if (exists) {
        if ((await sourceStatus(resource.worktree_path, true)).length || (await git(resource.worktree_path, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"])).length) throw new BridgeError("WORKTREE_NOT_CLEAN", "Dirty, untracked, or ignored files remain; remove disposable artifacts through the repository's authorized workflow first");
        for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "BISECT_START"]) {
          const path = (await git(resource.worktree_path, ["rev-parse", "--path-format=absolute", "--git-path", name])).trim();
          try { await lstat(path); throw new BridgeError("GIT_OPERATION_ACTIVE", `Git operation is in progress: ${name}`); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
      }
      const protectionRef = operation.disposition === "archived" ? `refs/passeur/archive/${operation.task_id}` : operation.target_ref;
      if (!protectionRef) throw new BridgeError("INTEGRATION_EVIDENCE_REQUIRED", "Expected target ref and accepted commit");
      if (operation.disposition === "integrated") await this.#verifyIntegrated(operation);
      else if (operation.archive_authorized !== true) throw new BridgeError("ARCHIVE_AUTHORITY_REQUIRED", "Explicit archive_authorized is required");
      resource = { ...resource, state: "cleanup_pending", operation_key: operation.operation_key, head_commit: operation.expected_head,
        disposition: operation.disposition, protection_ref: protectionRef, protected_commit: operation.expected_head, updated_at: now(),
        ...(operation.reason ? { reason: operation.reason } : {}),
      };
      let receipt: FinalizeReceipt = { operation, request_hash: hash, state: "intent", resource, updated_at: now() };
      // Durable intent precedes the first ref mutation or removal.
      await this.store.writeOperation(operation.task_id, receipt);
      await this.store.writeResource(operation.task_id, resource);
      try {
        if (operation.disposition === "archived") {
          const archive = await refHead(this.project, protectionRef);
          if (archive && archive !== operation.expected_head) throw new BridgeError("ARCHIVE_REF_CONFLICT", "Existing archive ref names different work");
          this.assertAuthority?.();
          if (!archive) await git(this.project, ["update-ref", protectionRef, operation.expected_head, "0".repeat(operation.expected_head.length)]);
        }
        await this.#verifyProtection(operation, protectionRef);
        this.assertAuthority?.();
        if (own) await git(this.project, ["worktree", "remove", resource.worktree_path!]);
        await this.#verifyProtection(operation, protectionRef);
        const branch = await refHead(this.project, resource.branch_ref!);
        if (branch !== undefined) {
          if (branch !== operation.expected_head) throw new BridgeError("HEAD_CHANGED", "Task ref changed during retirement");
          await deleteProtectedRef(this.project, resource.branch_ref!, operation.expected_head, protectionRef, undefined, this.assertAuthority);
        }
        if ((await worktreeEntries(this.project)).some((entry) => resolve(entry.path) === resolve(resource!.worktree_path!)) || await refHead(this.project, resource.branch_ref!)) throw new BridgeError("RETIREMENT_INCOMPLETE", "Owned registration or branch still exists");
        await this.#verifyProtection(operation, protectionRef);
        resource = { ...resource, state: "retired", updated_at: now() };
        await this.store.writeResource(operation.task_id, resource);
        receipt = { ...receipt, state: "done", resource, updated_at: now() };
        await this.store.writeOperation(operation.task_id, receipt);
        return receipt;
      } catch (error) {
        const pending = { ...resource, state: "cleanup_pending" as const, updated_at: now() };
        await this.store.writeResource(operation.task_id, pending).catch(() => undefined);
        await this.store.writeOperation(operation.task_id, { ...receipt, state: "cleanup_pending", resource: pending, error: errorInfo(error), updated_at: now() }).catch(() => undefined);
        throw error;
      }
    });
  }
  async #verifyIntegrated(operation: FinalizeOperation): Promise<void> {
    if (!operation.target_ref || !operation.accepted_commit) throw new BridgeError("INTEGRATION_EVIDENCE_REQUIRED", "target_ref and accepted_commit are required");
    await validateBranchRef(this.project, operation.target_ref);
    if (operation.target_ref === operation.expected_branch_ref) throw new BridgeError("INVALID_TARGET", "Task branch cannot retain itself during retirement");
    const accepted = await exactCommit(this.project, operation.accepted_commit);
    const target = await refHead(this.project, operation.target_ref);
    if (!target || !await isAncestor(this.project, operation.expected_head, accepted) || !await isAncestor(this.project, accepted, target)) throw new BridgeError("INTEGRATION_NOT_RETAINED", "Target does not retain the entire task tip through the accepted commit; patch equivalence is not proof");
  }
  async #verifyProtection(operation: FinalizeOperation, ref: string): Promise<void> {
    if (operation.disposition === "integrated") return this.#verifyIntegrated(operation);
    if (await refHead(this.project, ref) !== operation.expected_head) throw new BridgeError("ARCHIVE_NOT_RETAINED", "Archive ref does not retain the exact task tip");
    await exactCommit(this.project, operation.expected_head);
  }
}
