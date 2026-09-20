# Evidence, recovery and resource retirement

> Current prerequisite policy: the MCP interface remains available for diagnosis even when coordination cannot be acquired. `passeur_prepare` and protected operations perform authorized preparation lazily. History reads never migrate/quarantine; offline recovery/finalization/cleanup do not require Muse availability or subscription verification. Any older eager-server-start/profile prerequisite below is superseded by [startup-and-installation.md](startup-and-installation.md). Resource-specific stopped-worker, commit-protection and explicit-disposition requirements remain binding.
>
> Permission/storage failure and unsupported versions are not corruption authority. Recovery validates the selected record family before quarantining proven incomplete/corrupt records. Retain bytes and the current namespace; never remove another owner's lock or substitute a new root. Detected lease compromise blocks new protected effects and leaves uncertain in-flight effects unresolved.

The repository-common state location is `$XDG_STATE_HOME/muse-bridge/repositories/<common-directory-hash>`, defaulting to `~/.local/state`. This is separate from the worktree root and configured project-specific profile.

Each task retains its assignment, immutable terminal result, mutable resource record, bounded event log, optional artifacts and operation receipts. A stopped worker's resource can still be pending or retained; a historical result path is not evidence the directory still exists. Inspect the current resource record.

```sh
muse-bridge inspect --project /absolute/repository
muse-bridge result --project /absolute/repository --task TASK_UUID
muse-bridge logs --project /absolute/repository --task TASK_UUID
```

Read commands do not run agents or quarantine records. Legacy imports occur once under the repository-owner lease when the server or an offline mutation starts. Stop older Passeur servers before upgrading. Known old stores are discovered from the configured project and registered linked worktree paths; an old store for a no-longer-registered path must be identified manually, not guessed or deleted.

Version-1 records remain historical and request keys remain reserved. Their resource state is `legacy_unclassified`; they do not establish permission to delete a similarly named worktree or branch. Handle historical Git resources through the standards-governed manual workflow. This update deliberately provides no guessed ownership migration.

## Interrupted execution

Queued tasks that never started are recorded as interrupted/not_started. Started tasks without a durable result are conservatively unconfirmed. A result saved before its terminal state repairs that state on restart. Inference is never automatically replayed.

Missing or corrupt records and unknown shutdown freeze new starts and retirement, while known healthy siblings can finish saving results. Quarantined records remain visible as an unresolved safety condition. Restoring/quarantining evidence is a lease-owned recovery action, not an effect of listing.

When a process has actually been reconciled, stop the active coordinator and use the explicit offline assertion:

```sh
muse-bridge reconcile --project /absolute/repository --task TASK_UUID \
  --yes --confirm-worker-stopped --owner "operator" \
  --reason "Describe the actual process and workspace reconciliation evidence"
```

This records a human assertion separately; it does not falsify the immutable worker-stop result. It does not clear unresolved quarantine, missing-result or other tasks' stop conditions. Do not use it before inspecting the actual owned process tree and worktree. A corrupt/unknown legacy record needs manual repair/classification rather than a bypass flag.

## Finalization

While the server owns the repository, use MCP `muse_finalize`. When it is stopped, use the same mechanism through the CLI:

```sh
muse-bridge finalize --project /absolute/repository --operations /absolute/dispositions.json --yes
```

The file contains `schema_version: 2` and up to eight `operations`. Each operation requires a stable `operation_key`, `task_id`, `expected_head`, and full `expected_branch_ref`.

- `integrated`: also supply `target_ref`, `accepted_commit` and `cleanup_authorized: true`. The complete task tip must be an ancestor of the accepted commit, retained by the target. No merge is performed.
- `retained`: supply `owner`, `reason`, and `next_action`. Resources remain explicitly accountable. No deletion occurs.
- `archived`: supply `archive_authorized: true` and `cleanup_authorized: true`; a reason is useful. Passeur creates `refs/passeur/archive/<task-id>` protecting the exact tip, then retires the active task resources. This is not permission to discard unique commits.

Idempotent identical operations return their receipts. Conflicting key reuse is refused. If removal partly succeeds, repeat the original operation after resolving the failure; its receipt drives only the remaining bookkeeping. Do not integrate the task again or launch a replacement worker to finish cleanup.

Dirty tracked, untracked and **ignored** content, locked worktrees, unknown/advanced heads and Git operations in progress prevent retirement. In particular, an ignored `node_modules` or build directory is not automatically disposable. Remove it using the repository's authorized artifact-cleanup procedure, or retain the workspace explicitly. There is no `--force` retirement or broad `git worktree prune`.

Squash/cherry-pick equivalence does not prove ancestry. Preserve its source-to-accepted mapping through the repository workflow and retain or explicitly archive the original task tip; do not falsely label it ancestrally integrated.

## Collect bulky evidence

The old record-deletion meaning of `cleanup` is superseded. After resource retirement (or a task requiring no Git resources), the offline command collects only artifacts and logs:

```sh
muse-bridge cleanup --project /absolute/repository --task TASK_UUID --yes
```

Assignment identity, terminal result, resource disposition and idempotency receipts remain. Pending, retained, historical and uncertain resources keep their evidence. The offline command must obtain the same common-repository lease; it cannot race the running server.
