# Parallel workers and committed handoffs

## Current startup and deployment boundary

The discoverable-startup implementation replaces eager startup prerequisites described in older sections below. MCP discovery/status are composed before project, profile, state, recovery and provider access. RepositoryRuntime owns one lazy, single-flight preparation lifecycle and a lease retained through safe shutdown. Read-only history and administrative recovery do not depend on inference credentials or a working provider. Lease loss blocks new mutations and preserves unresolved in-flight outcomes; it is not process fencing.

The runtime composes the existing task coordinator, TaskStore and DispositionManager; it introduces neither a daemon nor another task authority. Execution/delivery/disposition contracts below remain. The caller supplies validated operations, not a replaceable project/state binding or preparation ordering.

Version-specific artifacts own build identity and production dependency closure; the Codex adapter owns named configuration and resolved launch verification. Operational procedures are in [startup-and-installation.md](startup-and-installation.md); evidence is in the [implementation report](plans/discoverable-startup-and-installed-runtime/reports/implementation-evidence.md). Configuration, direct MCP transport, coordination readiness and actual host/provider acceptance remain separate claims.

The current design is governed by [the parallel-worker plan](plans/parallel-worker-commit-handoff/plan.md). The original CLI plan remains historical for the earlier serial release. Its serial limit, uncommitted handoff, mandatory per-worker review language and record-only cleanup are superseded.

## Responsibility

Codex supplies independent assignments, exact bases, target refs and scoped acceptance criteria. Muse reads applicable repository instructions, implements the assignment, performs scoped checks and commits through ordinary Git. Repository scripts and hooks own mechanical checks. Codex decides integration and broader review/testing.

Passeur owns capacity, pending MCP calls, approvals, deadlines, cancellation, delivery identity and its own Git-resource lifecycle. It does not run project tests, rewrite a worker's report with a model, infer dependencies or features, automatically repair, or merge. Concurrency is an execution property, not a shared acceptance boundary.

## Owner and scheduler

A single coordinator leases the canonical Git common-directory identity. Different linked worktrees of the same repository cannot run competing coordinators. Profiles still belong to configured project paths. The common repository task store lives outside the source checkout.

One registry and bounded FIFO queue serve both individual and batch calls. Defaults are two active tasks plus eight queued tasks; batches contain at most eight assignments. The first admitting request owns a task's cancellation. Duplicate same-key subscribers attach to the original execution and can detach without cancelling it. Conflicting input under the same key is rejected. Batch cancellation affects newly owned tasks, not an earlier task to which it merely attached.

Deadlines are absolute from acceptance and include queue time, preparation, approvals and hooks. Closing admission precedes cancellation of queued/running tasks and draining in-flight admission, resource creation, runtime cleanup and terminal persistence. Ordinary task failures do not cancel siblings. Missing terminal persistence or unconfirmed process shutdown freezes replacement starts and retirement; healthy known siblings may finish saving results.

## Runtime and hooks

Each task owns a Muse startup handle before initialization completes, then a client/session/turn. Cancellation and bounded stop handling cover startup, submission and output consumption. The pinned SDK adapter remains the only production vendor runtime boundary.

The runtime inherits a deliberate environment without alternate API keys or hook-bypass variables. Passeur does not alter Git identity, signing, `core.hooksPath`, test scripts or package dependencies. A hook failure is handled by the worker within its task or reported as a blocker. Commit success does not prove a hook ran or the task is semantically correct.

A worktree is edit isolation, not an OS security boundary. In particular, Git administration and refs are shared. Installed-runtime permission/descendant tests remain required; a local lease does not stop arbitrary same-user shell processes.

## Delivery

After the runtime stops, Passeur observes Git rather than trusting a claimed commit ID. A committed delivery requires an exact task ref/HEAD, ancestry from the admitted base, at least one new commit, and no staged, unstaged or nonignored untracked residue. The complete base-to-head range and tree OID are retained. A task may legitimately produce multiple coherent commits.

No-change delivery requires an explicit worker explanation and unchanged Git facts. A failed execution may still contain committed work without becoming a successful execution. Review tasks have no commit requirement. Full reports and artifacts stay on disk; normal tool results contain bounded references and short limitations.

## Resource lifecycle

Execution results are immutable. Separate resource records track creation intent, pending delivery, explicit retention, cleanup in progress and retirement. Creation intent is saved before `git worktree add`.

`muse_finalize` acknowledges integration already performed by Codex, retains a task with owner/reason/next action, or archives the exact head under explicit authority. It never integrates code. Every operation supplies an idempotency key, exact expected task ref and head. Receipts survive retries.

For integrated retirement, the full task tip must be an ancestor of the accepted commit, which must remain reachable through the named target. Squash or cherry-pick equivalence does not establish this; retain or explicitly archive the source instead. Archive refs use `refs/passeur/archive/<task-id>` and are created and verified before removal.

Retirement refuses changed heads, unknown ownership, live or uncertain workers, locked worktrees, in-progress Git operations and dirty/untracked/ignored content. There is no force-remove, automatic prune or permanent discard of unique work. Repository-approved cleanup of disposable build outputs happens outside Passeur before retrying retirement. Passeur removes only its owned worktree and redundant branch, conditionally deletes the expected ref, verifies protection and saves the receipt. Partial retirement resumes bookkeeping on retry, not inference or integration.
