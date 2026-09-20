# Plan: Parallel Workers and Committed Handoffs

> Startup/deployment supersession: [Discoverable Startup and Installed Runtime](../discoverable-startup-and-installed-runtime/plan.md) now owns MCP availability, operation-specific coordination readiness, runtime installation and named registration. The one-coordinator/many-worker contract remains. A missing profile/provider or blocked lease no longer prevents tool discovery. This plan retains its independent parallel execution and committed-resource acceptance claims; shared evidence is linked, never inferred from implementation status.

**Plan status:** `Verifying`
**Current phase:** M4 — Installed dependency and live acceptance
**Next slice:** Run the full pinned-dependency checks and the opt-in installed Codex/Muse acceptance cases.
**Acceptance status:** `pending installed-runtime evidence`
**Date:** September 20, 2026
**Repository:** `MrScripty/Passeur`
**Inspected baseline:** `d726cab8e8e76abd3ab56a7937f784ebed4b66cb`
**Canonical destination:** `docs/plans/parallel-worker-commit-handoff/plan.md`
**Execution ledger:** [execution-ledger.md](execution-ledger.md)
**Issues:** [issues.md](issues.md)
**Development decision:** `implement` — proceed through the bounded milestones below; live provider compatibility is a release check, not a reason to build another framework.

Source changes are implemented in the accompanying patch. Core verification evidence and remaining environment limits are recorded in execution-ledger.md and docs/compatibility.md. Live and pinned-dependency acceptance remains pending. This plan changes the existing CLI design only where stated below.

## 1. Objective and responsibility boundary

Allow Codex to delegate multiple independent assignments to Muse concurrently. Each implementation worker performs verification appropriate to its own assignment and creates a standards-compliant commit through the repository's ordinary Git workflow. Passeur returns identifiable committed work, keeps execution and resource ownership accurate, and retires its resources when the orchestrator supplies an authorized disposition.

**Passeur manages execution and deliverables. It does not own testing policy, code acceptance, feature grouping, or development strategy.**

| Concern | Owner | Passeur's involvement |
| --- | --- | --- |
| Task decomposition, dependencies, base selection, integration, broader testing and review timing | Codex, under user/repository authority | Carry explicit assignments and retain references to results. |
| Standards-compliant edits, scoped verification, staging and commits | Muse worker | Provide the assignment, workspace and normal runtime; capture output. |
| Verification obligations and commit conventions | Coding-Standards and the target repository | Preserve and reference applicable instructions; do not implement a second standards interpreter. |
| Mechanical commit checks | Repository scripts and Git hooks | Preserve their normal execution environment; do not install, replace or independently rerun them. |
| Worker concurrency, cancellation, approvals, task records, Git deliverable identity and owned-resource retirement | Passeur | Implement the mechanisms in this plan. |
| PRs, external review services, CI gates and merge into an authoritative branch | Repository workflow and Codex/user | Remain outside this implementation. |

A worker contribution need not form an independently working end-to-end application. Workers running at the same time need not concern the same feature. Passing a scoped check does not establish system-wide readiness. Codex may use a result without first reading its diff, and may review multiple contributions at a later boundary.

### In scope

- A bounded parallel worker pool in the existing Node/MCP process.
- Independent assignments and an explicit batch convenience for parallel launch without status polling.
- Scoped-verification and commit instructions in the worker handoff; mechanical identification of the resulting Git commits.
- Task-specific approvals, cancellation, persistence, recovery and compact results.
- Explicit, batchable disposition of committed outputs and safe retirement of Passeur-owned branches/worktrees.
- Contract migration, updated skills/documentation, and tests of Passeur's own behavior.

### Outside this change

No Passeur test runner, test-selection engine, combined-test gate, automated repair loop, merge queue, dependency planner, feature-grouping model, mandatory primary-model review, PR creator, CodeRabbit integration, provider framework, daemon or desktop UI. Passeur will not merge, cherry-pick, rebase, squash, push, or resolve conflicts through a new integration API in this change. Codex uses its existing Git tooling for those decisions and operations.

## 2. Baseline and supersession

The baseline coordinator has one `#active` execution and rejects a different concurrent assignment. It has useful safeguards for request-key idempotency, cancellation, incomplete executions and persistence failures. Preserve those safeguards while replacing their single-worker assumptions. [R1]

The current implementation returns worktree and artifact references but does not require a committed deliverable. Existing `cleanup` removes task records rather than closing the Git-resource lifecycle. The old design also describes mandatory review-oriented handoff guidance and a serial first release. [R1, R2]

| Existing owner | Change |
| --- | --- |
| `src/core/coordinator.ts` | Concurrent admission/execution registry; result finalization remains task-local. |
| `src/contracts/index.ts` | Versioned committed-delivery, parallel-batch and disposition contracts. |
| `src/muse/adapter.ts` | Preserve owned startup/stop behavior; update reporting and task identity, not test policy. |
| `src/mcp/server.ts`, `src/approvals/native.ts` | Concurrent requests, explicit batch launch, correctly routed human input and drain-all shutdown. |
| `src/workspace/project.ts`, `src/workspace/worktree.ts` | Observe exact task commits; manage only owned resources. |
| `src/store/task-store.ts`, `src/core/recovery.ts`, `src/core/cleanup.ts` | Keep live siblings distinct from orphaned work; preserve receipts and govern retirement. |
| `src/cli.ts`, `src/diagnostics/doctor.ts` | Configuration, inventory and offline disposition through the same resource owner. |
| `skills/muse-bridge/`, `docs/design.md`, `docs/setup.md`, `docs/recovery.md` | Parallel, commit-oriented usage without mandatory per-worker Codex review. |

Add a supersession notice to `docs/Plans/codex-muse-cli-bridge-design.md`, linking to this plan. Mark its serial-worker boundary, uncommitted implementation handoff, per-worker review guidance and record-only cleanup as superseded. Keep valid credential, process-ownership and protocol guidance by reference. Do not rewrite unrelated historical material or migrate every documentation directory merely to normalize capitalization.

## 3. Binding decisions

| ID | Decision | Owner / reason |
| --- | --- | --- |
| D1 | One coordinator owns a configured repository; it can own multiple workers. | Passeur: prevent competing Git-resource owners without serializing implementation. |
| D2 | Every assignment has its own base, branch/workspace, budget, identity and outcome. | Codex selects the task; Passeur preserves the execution boundary. |
| D3 | A batch groups launch/wait operations only. | It carries no shared feature, dependency, test or integration meaning. |
| D4 | Muse runs scoped checks and creates its own commits through ordinary Git commands. | Repository policy owns correctness obligations; Passeur does not duplicate them. |
| D5 | Passeur verifies Git delivery facts, not standards compliance or test adequacy. | A commit receipt is not a correctness certificate. |
| D6 | Codex controls integration, optionally for many results at once, without mandatory diff ingestion. | No review or test is triggered merely because a worker finishes. |
| D7 | Execution completion and resource disposition are separate. | A stopped worker can leave a valid pending contribution; an integrated contribution can still need cleanup. |
| D8 | Retirement is explicit or covered by explicit standing cleanup authority, with exact ownership and commit protection. | Apply existing Coding-Standards Git-lifecycle rules rather than inventing a new policy. [R3] |
| D9 | Keep the existing CLI runtime, credential path and pinned SDK adapter. | Parallelism must not add model-provider or billing fallbacks. |

Initial product defaults: `max_workers = 2`, `max_queued_tasks = 8`, and at most eight assignments per batch. These are configurable capacity choices, not claims about Muse subscription entitlements. The limit covers all tasks owned by this coordinator, including separate single-task and batch requests. No machine-wide scheduler or separate build/test resource scheduler is introduced.

## 4. Task and tool contracts

### 4.1 Assignment

Publish request/result schema version 2 for the changed implementation-delivery contract. Keep the existing objective, context, acceptance criteria, context files, allowed paths and stable request key. Require an exact `base_commit` and an explicit local `target_ref` for implementation tasks. The target is intended-disposition metadata, not permission to modify that branch.

Use full validated Git object IDs and full branch refs. Resolve them against the configured repository; task arguments cannot substitute a repository root, executable, credential or global policy. Preserve the existing source-base admission rules in this change. Task branches may start from different admitted bases or intended targets.

Scoped verification instructions belong in the assignment's existing context and acceptance criteria. Do not add a Passeur-owned executable test-profile language. Codex supplies prerequisites through task sequencing and base selection; Passeur does not infer dependencies from filenames or assignment wording.

### 4.2 Committed handoff

Retain `execution_status`, `worker_stop`, reported assessment, checks, blockers and questions. Add a separate delivery descriptor; the following is an illustrative application type, not an SDK API:

```ts
type Delivery = {
  status:
    | "committed"
    | "no_changes_needed"
    | "incomplete"
    | "not_applicable";
  base_commit?: string;
  head_commit?: string;
  tree_oid?: string;
  branch_ref?: string;
  worktree_path?: string;
  reason?: string;
};
```

The coordinator derives Git identity from the owned workspace after runtime shutdown. It does not trust the model's claimed commit ID as proof. For `committed`, establish that the observed HEAD is a commit in this repository, the task branch still names that HEAD, the admitted base is an ancestor, and the intended deliverable has no leftover staged/unstaged tracked changes or nonignored untracked files. Record the complete `base_commit..head_commit` range; a task can legitimately produce more than one coherent commit.

A completed turn with uncommitted work is `delivery: incomplete`, not an accepted implementation. A failed turn may still have a useful commit: retain its identity without changing execution failure into success. Report known incomplete delivery to Codex; do not launch a new worker automatically to manufacture a commit.

A no-change outcome requires an explicit worker explanation and matching unchanged Git facts. Do not create empty commits simply to satisfy the handoff shape. Review tasks use `not_applicable` and do not need a commit.

`committed` means identifiable committed work, not that hooks ran, every check passed, the task was accepted, or the system works. Keep worker-reported evidence distinct from actually observed command outcomes; unavailable evidence remains unknown.

### 4.3 MCP surface

Keep `delegate_to_muse`, make it concurrency-safe, and continue holding each accepted request until that task ends. Add `delegate_to_muse_batch({schema_version: 2, assignments: [...]})`. It submits independent requests through the same coordinator and waits for their outcomes without returning a pollable job ID.

Validate the batch envelope, size and duplicate keys before admitting children. Each child then gets its own admission/result outcome; runtime or capacity failure in one does not roll back or hide others. Replaying the batch reuses each child's stable request key. No second durable batch workflow or dependency graph is required.

Use settled-result aggregation, not fail-fast behavior that loses successful siblings. Preserve input order in the response. A batch waits only for the assignments explicitly submitted in that call; it does not wait for every task in the repository. Concurrent single calls remain usable where the client dispatches them.

Keep `muse_result` for bounded evidence and recovery reads. Add `muse_finalize` for disposition/resource operations described in section 8. Do not expose a model-callable permission-approval tool or a start/status polling suite.

Normal responses contain task IDs, commit/ref references, short scoped-check summaries, limitations and resource state. Keep the total serialized tool payload bounded, including a batch's aggregate response, text/structured-content duplication and encoding overhead. Preserve identifiers and failure information first. Full diffs and logs remain available by reference; never generate an extra model summary or require Codex to read them.

## 5. Parallel execution and ownership

### 5.1 Admission and capacity

Replace the singleton execution with a registry keyed by task ID/request key and a bounded FIFO queue. Serialize only admission decisions: key lookup/hash comparison, capacity reservation and publication of the initial task record. Release that admission lock before awaiting workspace preparation or worker execution.

A matching active key attaches to the existing task; conflicting content returns `REQUEST_KEY_CONFLICT`. Distinct requests run concurrently up to the configured limit. A full queue returns a typed capacity result before creating a worktree or launching a host. Queued tasks remain cancellable and consume no host slot until started.

Track owner, request subscribers, deadlines, promise, controller and known resources per task. The first admitting request owns cancellation; later duplicate subscribers can detach but cannot cancel another request's worker. A batch cancellation cancels the tasks it newly owns, not tasks it merely attached to through duplicate keys.

### 5.2 Repository and worktree ownership

Keep one process-level ownership lease. Identify the underlying repository through its canonical Git common directory, while retaining the configured project root/profile separately. Two bridge instances aimed at different linked worktrees of the same repository must not become competing resource managers. This is not multi-user isolation. Git worktrees share repository administration and ordinary refs, despite their separate working directories and indexes. [S2]

Create one unique task branch/worktree per implementation assignment. Persist the intended path/ref and owner before creation so a crash between Git mutation and response can be reconciled. Preserve the current task-branch prefix to avoid cosmetic migration. Validate that the worktree root is outside the source checkout.

Coordinate Passeur's own administrative mutations such as worktree creation/removal and ref retirement. Do not hold that lock while workers edit, test, wait for approval, or run commit hooks. Workers use their own indexes and branches; they do not update target branches, shared Git configuration or sibling workspaces.

A worktree is edit isolation, not a security boundary. Preserve the runtime sandbox, record its actual limits, and verify the minimum permissions needed for commits in linked worktrees. Never relax permissions globally just to make a hook or commit pass.

### 5.3 Lifecycle, cancellation and failures

Extend execution phases with a real queued phase. Waiting for approval remains an active worker. Each task has one terminal outcome and one owned runtime startup/stop path.

Use one absolute task deadline from acceptance, including queue time, preparation, worker execution and hook waits. Preserve bounded cleanup separately and keep the enclosing MCP timeout longer than the latest task deadline plus cleanup/final-response allowance. Record the effective deadline; do not reset it on progress, duplicate attachment or approval. Queueing does not grant indefinite waiting. [S1]

Cancellation must work before admission, while queued, during startup, during a commit/hook, during output draining and during finalization. Propagate MCP cancellation to the owned tasks and suppress a response to a cancelled request as required by the protocol. [S3]

On disconnect/shutdown: close admission first, cancel queued tasks, request cancellation of every owned active host, drain task finalization, persist recoverable outcomes, then release the repository lease. The drain includes in-flight admission and workspace creation, not only already-running hosts.

A normal task failure does not cancel healthy siblings. If shutdown is unconfirmed or durable terminal evidence cannot be recorded, retain the existing safety behavior: freeze new starts and retirement mutations, surface the exact uncertainty, and require reconciliation. Known siblings may finish recording their own results; do not silently treat an uncertain slot as capacity for a replacement worker. A repository-wide ownership or storage failure may require coordinated shutdown, explicitly distinguished from ordinary task failure.

## 6. Muse, scoped verification and repository hooks

Update the assignment prompt and skill to direct Muse to read the applicable instructions, implement only its scope, run appropriate checks, inspect its staged changes and commit through the repository's normal workflow. The scope can be an incomplete component of a larger system. Any expected unimplemented surroundings or permitted deferred checks should be stated by Codex, not invented by Passeur.

If a required scoped check or hook fails, Muse may fix it within the same assignment and existing execution budget. If it requires a broader decision, Muse reports a blocker. Passeur adds no post-turn test/retry loop, automatic test repair, full-build prerequisite or primary-model review gate.

Preserve the repository's effective hook configuration and supported environment. Do not copy a private competing hook suite into each worktree, change `core.hooksPath`, install dependencies through a new Passeur bootstrap engine, set hook-bypass variables, or add `--no-verify`. Hooks may execute on worktree creation as well as commit, so repository trust/authorization is required before preparation. [S4]

`doctor` may report the configured hook location and accessibility, without running hooks or claiming compliance. Missing hooks are diagnostic information, not permission to fabricate success and not a reason to invent testing policy. A repository requiring hook installation must have its normal setup completed by the user/authorized worker. Test-specific environment, dependencies, signing requirements and shared test-resource coordination remain repository responsibilities.

Do not claim tamper-proof enforcement: local hooks can be bypassed. Standards govern bypass authority; repository CI/review can provide independent enforcement. The bridge preserves observed command evidence and worker claims without certifying that a successful commit proves all obligations were met. [S4, R3]

## 7. Approvals, persistence and recovery

Route each human request using task identity, workspace, session/turn identity and the vendor's approval ID. A response applies only to the still-live request that generated it. Include the task label in the existing elicitation message.

Use a small FIFO prompt arbiter if the installed client needs sequential human prompts. Serializing prompts must not stop other workers from executing already-authorized work. Approval waiters obey their task deadlines; late or cancelled decisions cannot authorize a sibling's action. Preserve the vendor's actual choice meanings and human review policy.

Keep the file-backed task store; no database or daemon is required. Serialize writes within a task, including event-size accounting. Admission/result/resource mutations use the appropriate owning locks; ordinary listing is read-only. Recovery/quarantine runs under the owner lease, not as a side effect of a concurrent inspection command.

Separate these records:

- Immutable assignment and terminal execution/delivery result.
- Mutable resource/disposition record with owned path/ref, exact head, intended target, retention owner and next action.
- Small mutation receipts for retirement operations and their verified effects.

Known queued/running tasks in this coordinator are live siblings, not incomplete historical executions. A persisted nonterminal task not owned by this process is unresolved until startup reconciliation says otherwise. Preserve the prior behavior that refuses replacement work after missing terminal evidence or uncertain shutdown. Do not replay inference on restart.

After a crash following worktree creation, identify the exact owned resources from the prewritten intent. After result-save/state-save interruption, reconcile state from the saved result. After retirement interruption, resume the pending resource operation; never repeat a model task to repair bookkeeping.

Retained metadata should let a fresh Codex session locate committed work without replaying the original prompt or reading the code into context. The result path is historical once resources are removed; `muse_result`/inspection must also surface current resource availability rather than implying that the old directory still exists.

## 8. Integration remains with Codex; retirement belongs to Passeur

### 8.1 No automatic integration decision

Codex receives commit and workspace references and may test there, integrate through Git, combine several results, defer review or request more work. Passeur neither requires nor initiates those decisions. It does not infer that concurrent outputs belong on the same branch.

No per-worker PR or Codex review is required by this plan. PR creation, external review and authoritative-branch controls are a separate repository workflow. A future merge helper is not needed to complete this change.

### 8.2 Explicit disposition

Provide `muse_finalize` with bounded per-task operations and matching offline CLI operations. Batch processing is per item, not all-or-nothing; return receipts or typed failures for each. Every mutation supplies a stable operation key and expected task head/ref. A repeated identical operation returns its receipt; conflicting reuse is rejected.

Support:

| Disposition | Required facts | Action |
| --- | --- | --- |
| `integrated` | Codex identifies the target ref and accepted commit; the full task tip is an ancestor of that commit and that commit is retained by the target ref. | Record the evidence; retire the clean stopped task worktree and redundant branch under explicit cleanup authority. |
| `retained` | Named owner, reason and next action/review condition. | Keep resources with that contract; no inferred deadline deletion. |
| `archived` | Explicit archive authority, exact head and a clean stopped workspace. | Create and verify a deterministic recovery ref, record it, then retire the redundant task worktree/branch. |

`integrated` is an acknowledgement of integration already performed, not a request for Passeur to merge. Check full-tip ancestry, not patch similarity. Squash/cherry-pick/reconstruction without ancestry is not automatically recognized as integration; leave it retained for explicit source-to-accepted lineage handling, or archive it under explicit authority. Do not grow a semantic patch-equivalence engine. [R3]

Rejected, abandoned and superseded are outcome reasons attached to a retention/archive decision. They are not automatic destructive authority. Permanent destruction of unique commits or uncommitted content is outside generic automation in this change.

### 8.3 Safe retirement sequence

Under resource ownership and a short mutation lock:

1. Persist the authorized operation intent, exact path/ref/head and selected commit protection.
2. Verify no active or uncertain worker owns the workspace; refuse changed tips, unknown ownership, another checkout using the ref, locked worktrees or in-progress Git operations.
3. Confirm commit reachability through the accepted target or verified archive ref. Inventory dirty/untracked content; ignored content is not automatically disposable. Use repository-declared disposable-artifact authority or retain the workspace for an explicit decision.
4. Use ordinary Git worktree removal for the owned path. Delete only the redundant task branch after the exact-head/retained-commit checks; conditional ref deletion can enforce the expected old OID. Do not force-remove dirty worktrees. [S2, S5]
5. Verify the task registration and branch are absent and protected commits still have their recorded disposition. Persist the receipt.

If integration is recorded but removal fails, record `cleanup_pending` and retry only retirement. Do not lose the result or reintegrate it. Expose outstanding resources in `inspect`/`muse_result`, including tasks awaiting disposition; branch count or age is never deletion authority.

Change the current `cleanup` command so it cannot erase the only record of live, pending, uncertain or retained Git resources. Bulky logs/artifacts may be collected after terminal resource accounting, but preserve a compact delivery/disposition/idempotency receipt. Archived refs are intentional recoverability resources with recorded ownership, not forgotten active branches.

While the MCP server owns the repository, mutations go through its handler. A separate offline CLI must acquire that same lease and refuse competing mutation. Do not add a control daemon or socket merely to bypass the owner.

## 9. Compatibility and rollout

Publish version-2 request/result contracts and update registered schemas, prompts, skills, examples and package documentation together. Unknown/new protocol fields remain validated at the boundary. Keep existing executable/package naming and SDK pins unless a demonstrated compatibility issue requires a separate decision.

Existing profiles may acquire the new bounded-concurrency defaults during a documented load/upgrade; never change a running instance's limit or permission posture halfway through an assignment. Operator setup must disclose the new default concurrency and allow it to be reduced.

Old version-1 task records remain readable as historical data. Their results do not prove committed delivery or authorization to retire Git resources. Label them `legacy_unclassified` in the resource projection and require explicit identification/disposition before mutation. Do not invent missing target, head or ownership facts from a similarly named current branch. Reject new version-1 implementation requests with an actionable contract-upgrade diagnostic rather than silently changing their meaning. Preserve old request keys to prevent accidental duplicate execution.

Retain the existing model-selection, credential-provenance, sandbox and process-cleanup compatibility checks. Parallel sessions against the actual subscription are an opt-in live check, not an entitlement assumption. No paid fallback, quota-reset scheduler or automatic account switching is introduced.

## 10. Simplicity and ownership review

**Applicability:** `applicable` — this changes execution ownership and introduces a resource-disposition contract.

| Probe | Admission |
| --- | --- |
| Independent concerns and dimensions | Codex owns what/when to implement and integrate; the repository owns verification policy; workers perform it in their worktrees; Passeur owns when/how its processes and resources exist. |
| State, identity, values, time and policy | Task identity and deadlines are canonical in the coordinator/store; Git owns commit identity; resource state references Git evidence. Hook configuration and acceptance decisions remain external authorities. |
| Version roles and compatibility | Version 2 changes delivery promises. Version-1 support is read-only historical interpretation, not a second execution architecture. Task/request identities survive upgrades. |
| Caller/composition-root knowledge | Callers know assignments, bases, results and disposition intent. They need not know pool internals, SDK shutdown ordering, ref deletion mechanics or event-file layout. |
| Representative change paths | Changing tests touches repository scripts/hooks, not Passeur. Changing a worker limit touches profile/coordinator. Changing the SDK touches its adapter. Changing retirement safety touches the resource owner and its tests. |
| Stable interfaces versus hidden ordering | The existing worker adapter remains the runtime seam. Admission, durable publication, cancellation and retirement ordering stay behind owning modules, not copied into CLI/MCP callers. |
| Independent evolution and failure | Test the pool with held fake workers; test commits/retirement with disposable Git repositories; test the SDK separately. Ordinary worker failure is task-local. Shared ownership/storage failures are explicit. |
| Necessary complexity and deletion result | Removing the pool recreates concurrency bookkeeping in callers. Removing disposition receipts recreates orphan/unsafe-cleanup risk. Removing a test engine, merge queue, separate service or provider framework loses no required behavior, so none is added. |

No new general-purpose workflow engine, database, version registry or distributed scheduler is admitted. Keep helper extraction proportional to ownership, not a prescribed number of modules. [R5]

## 11. Implementation milestones

Milestones express acceptance boundaries, not one-commit rules. M1–M3 source work is implemented with core evidence; M4 is verifying, with pinned-dependency and installed-runtime gates pending. Update the ledger when a slice is accepted or material evidence changes; do not mirror every commit into planning documents.

### M1 — Committed worker deliverables

**Goal:** An implementation worker returns a real commit and scoped-verification report, without Passeur taking over testing.

**Allowed write set:** `src/contracts/index.ts`; `src/core/coordinator.ts`; `src/muse/adapter.ts`; `src/workspace/project.ts`; `src/workspace/worktree.ts`; `src/store/task-store.ts`; `src/core/recovery.ts`; `src/mcp/server.ts`; `skills/muse-bridge/SKILL.md`; `skills/muse-bridge/references/setup.md`; `docs/design.md`; `docs/Plans/codex-muse-cli-bridge-design.md`; this plan directory; `tests/unit/contracts.test.ts`; `tests/unit/worker-report.test.ts`; `tests/integration/coordinator.test.ts`; new `tests/integration/committed-delivery.test.ts`.

**Work:** Implement the version-2 delivery contract and honest historical projection. Update Muse's prompt to perform scoped checks, respect hooks, stage intentionally and commit. Observe Git identity and residual work after shutdown; persist pending resource ownership separately. Remove mandatory per-worker Codex review language. Preserve failure evidence, reference deletion/rename handling and result bounds.

**Gate:** A fake worker running ordinary Git commands in a disposable task worktree creates a commit through a repository hook. A rejecting hook prevents the commit; Passeur does not bypass or rerun it. A component-only change can return committed delivery without the entire application being complete. Missing commits/residual changes are not reported as complete delivery. Source checkout remains unchanged.

### M2 — Bounded parallel delegation

**Goal:** Independent workers overlap in real execution while waiting and recovery remain correct.

**Allowed write set:** `src/core/coordinator.ts`; optional internal `src/core/worker-pool.ts`; `src/core/state.ts`; `src/core/recovery.ts`; `src/contracts/index.ts`; `src/core/profile.ts`; `src/store/task-store.ts`; `src/mcp/server.ts`; `src/approvals/native.ts`; `src/muse/adapter.ts`; `src/workspace/project.ts`; `src/workspace/worktree.ts`; `src/cli.ts`; `src/diagnostics/doctor.ts`; `tests/unit/adapter-lifecycle.test.ts`; new `tests/unit/worker-pool.test.ts`; new `tests/integration/parallel-mcp.test.ts`; new `tests/integration/parallel-recovery.test.ts`; shared fake-runtime fixtures under `tests/fixtures/`; this plan directory.

**Work:** Add repository-owner identity, active registry, bounded queue, shared single/batch admission and distinct ownership for duplicate subscribers. Route approvals by task, implement drain-all shutdown, and make listing read-only. Replace singleton-specific reconciliation checks without weakening incomplete-execution safety. Track worktree creation intent for crash recovery.

**Gate:** Hold two fake workers concurrently and prove both start before either is released. Prove capacity bounds, independent failure/cancellation, exact key deduplication, queue expiry, batch partial outcomes and correct approval routing. Killing the server during admission or execution leaves recoverable records and no replay. No model polling or combined-test invocation is introduced.

### M3 — Accountable result disposition and retirement

**Goal:** Committed work can be integrated externally and its temporary resources retired without losing evidence or interrupting siblings.

**Allowed write set:** `src/core/cleanup.ts`; new `src/core/disposition.ts`; `src/core/coordinator.ts`; `src/core/recovery.ts`; `src/contracts/index.ts`; `src/store/task-store.ts`; `src/workspace/project.ts`; `src/workspace/worktree.ts`; `src/mcp/server.ts`; `src/cli.ts`; `tests/integration/cleanup.test.ts`; new `tests/integration/disposition.test.ts`; new `tests/integration/retirement-recovery.test.ts`; this plan directory.

**Work:** Add `muse_finalize` and the shared offline CLI path, explicit integrated/retained/archived decisions, operation-key receipts and exact-head retirement. Separate resource cleanup from artifact/log collection. Preserve historical results and pending inventories. Implement no merge operation or application-test gate.

**Gate:** With task A integrated through ordinary Git, retirement removes A's owned worktree/ref and proves commit reachability while task B continues running. Wrong/advanced heads, dirty or locked worktrees, unknown ownership and unconfirmed shutdown refuse deletion. A crash after removal but before the receipt converges on retry. Archive protects the exact head before deletion; a merely claimed or patch-equivalent integration cannot authorize retirement.

### M4 — User-facing workflow, installation and live acceptance

**Goal:** Codex can use the installed bridge for parallel committed tasks and later resource accounting without extra review or test machinery.

**Allowed write set:** `src/cli.ts`; `src/diagnostics/doctor.ts`; `skills/muse-bridge/SKILL.md`; `skills/muse-bridge/references/setup.md`; `skills/muse-bridge/agents/openai.yaml`; `docs/design.md`; `docs/setup.md`; `docs/recovery.md`; `docs/compatibility.md`; `scripts/probe-wait.ts`; `scripts/probe-muse.ts`; new opt-in `scripts/probe-parallel.ts`; package manifest/lock only for packaging or a necessary tested dependency change; new `tests/integration/cli-parallel.test.ts`; this plan directory.

**Work:** Update MCP tool allowlists, versioned examples, capacity/deadline guidance, hook diagnostics and resource inventory commands. Document one task, unrelated tasks, batch waiting, external integration, retirement and failure recovery. Provide a short orchestrator skill with no required per-worker review. Keep live probes opt-in and disposable.

**Gate:** Run local typecheck/tests/build, then a real two-worker Codex/Muse smoke under the intended credentials. Verify overlapping runtime execution, ordinary repository hook behavior, compact committed results, human input routing, cancellation and recovery, and external integration followed by retirement. Record exact versions and observed limits. If live execution is unavailable, leave the objective `Implemented`/`Verifying`, not `Accepted`; do not claim unrun results.

## 12. Objective acceptance and evidence plan

These tests validate **Passeur's implementation as a repository**. They do not add a production test service to Passeur or make it run these suites in delegated repositories.

| ID | Observable criterion | Evidence / environment | Status |
| --- | --- | --- | --- |
| A1 | At least two independent assignments execute concurrently; configured capacity is respected. | Deterministic held-worker MCP test, then installed-runtime overlap trace. | pending |
| A2 | Muse supplies scoped checks and ordinary commits; Passeur starts no independent test/review/repair process. | Real Git hook fixtures and observed process calls; component-only and docs-only tasks. | pending |
| A3 | Commit identity, full delivery range and incomplete/no-change states reflect Git, not model claims. | Disposable repositories with valid, missing, mismatched, multi-commit and dirty results. | pending |
| A4 | A failing/cancelled task does not silently cancel a healthy sibling; unknown shared safety state prevents replacement. | Fault injection at queue, startup, approval, commit, output, persistence and shutdown boundaries. | pending |
| A5 | Integration stays orchestrator-owned; retirement protects commits and closes only owned resources. | Actual Git ancestry/ref/worktree checks, interrupted mutations and concurrent sibling tests. | pending |
| A6 | Old records remain readable, version-2 calls are coherent, aggregate outputs are bounded and retries do not duplicate work. | Schema/migration fixtures and cold-process recovery tests. | pending |
| A7 | Actual CLI handoff uses the intended local Muse credential/model path without polling or mandatory Codex diff review. | Opt-in installed Codex/Muse run; report any observability limitation explicitly. | pending |

Use real Git as the oracle for commits, hooks and reachability; fake workers only for execution timing and failures. Use the actual MCP transport in integration tests. Fake-client success does not prove installed Codex behavior, provider concurrency support, sandbox enforcement or subscription billing. Preserve the existing lifecycle regressions, including genuine finalization exceptions separate from legitimate file deletion.

Run only focused checks for each implementation slice, followed by the affected suite and final objective checks. Live paid/subscription checks are manual/explicit opt-in, never automatic on every commit. Add findings to `issues.md`; adjacent improvements do not automatically expand this plan. [R5]

## 13. Repository isolation, blockers and closure

### Developing this change

Use an owned private development branch such as `work/passeur-parallel-handoff` from the inspected or explicitly reconciled base, targeting Passeur's `main`. The implementation agent owns its declared edits; Codex/user remains the integration owner. Any helper workers return scoped commits; one integration owner edits canonical plan/ledger state. Parallel implementation is optional and requires disjoint agreed write sets; this plan itself does not require implementing its own scheduler to develop it.

The user selected a ZIP patch delivery for this implementation. No remote branch, commit or PR is created here. The integration owner may apply the patch on a work branch and submit a PR for the selected external review, rather than committing directly to `main`. This is the delivery procedure for this change, not Passeur product functionality. Do not change branch protection, reviewer installation or review schedules without explicit authority. No rewriting shared history is implied.

Record a terminal disposition for every development worktree/branch created by this effort. Cleanup authority is limited to the effort's clean stopped resources with verified retained/archive commits and explicit authorization. Unknown, dirty or uniquely committed resources remain protected; no repository-wide prune is authorized. [R3]

### Blockers and bounded uncertainties

No identified blocker to beginning M1. The live environment must still establish parallel Muse session behavior, linked-worktree commit permissions/hooks and installed Codex waiting/approval behavior. Resolve these with the smallest real probe during the relevant milestone. Lack of live credentials blocks a live acceptance claim, not unrelated deterministic implementation.

### Re-plan triggers

Re-plan only if the runtime cannot provide separately owned concurrent sessions, the client cannot support the required pending-call/input behavior, repository hook/permission configuration prevents the normal commit path without a policy change, or the user requests automatic integration, a daemon, multi-owner access or a Passeur verification engine. Do not add those mechanisms as silent fallbacks.

### Final acceptance

- Acceptance status: `pending`.
- Current phase: M4 installed dependency and live acceptance.
- Next slice: Execute the remaining pinned-dependency and installed-runtime acceptance cases.
- Deferred follow-ups: automated integration/replacement-lineage tooling, multi-owner scheduling and PR-service integration are outside this plan; they are not prerequisites for acceptance.
- Final status: `Verifying`.

## Sources and authority

User requirements in this conversation select the product boundary. Repository sources establish the inspected baseline; standards and vendor sources establish the relevant existing obligations/mechanisms. Proposed tool names and types in this document are not claims of currently implemented interfaces.

- **[R1] Passeur baseline:** https://github.com/MrScripty/Passeur/tree/d726cab8e8e76abd3ab56a7937f784ebed4b66cb — inspected coordinator, MCP server, task store, contracts, Muse adapter, workspace/cleanup code and tests.
- **[R2] Existing plan:** https://github.com/MrScripty/Passeur/blob/d726cab8e8e76abd3ab56a7937f784ebed4b66cb/docs/Plans/codex-muse-cli-bridge-design.md
- **[R3] Coding-Standards, commit/worktree policy:** https://github.com/MrScripty/Coding-Standards/blob/366c1d90a24bbfb50973f62b155a5f3396c0f107/workflows/commit.md
- **[R4] Coding-Standards, planning/template/architecture:** https://github.com/MrScripty/Coding-Standards/tree/366c1d90a24bbfb50973f62b155a5f3396c0f107 — `workflows/planning.md`, `templates/PLAN-TEMPLATE.md`, `topics/architecture.md`.
- **[R5] Coding-Standards, proportionality:** https://github.com/MrScripty/Coding-Standards/blob/366c1d90a24bbfb50973f62b155a5f3396c0f107/workflows/development-proportionality.md
- **[S1] OpenAI, command-launched MCP and configuration:** https://developers.openai.com/codex/mcp/
- **[S2] Git, worktrees and shared repository state:** https://git-scm.com/docs/git-worktree
- **[S3] MCP, request cancellation:** https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation
- **[S4] Git, hooks and normal invocation:** https://git-scm.com/docs/githooks
- **[S5] Git, expected-old-value ref updates/deletion:** https://git-scm.com/docs/git-update-ref

Sources checked September 20, 2026. Recheck the relevant installed interfaces during implementation; do not upgrade dependencies solely because documentation has advanced.
