# Passeur architecture

The [shared-service plan](plans/shared-service-and-evidence-driven-lifecycle/plan.md) owns the current implementation effort. Durable authority is documented in [shared service](shared-service.md), [task lifecycle](task-lifecycle.md), and [adapter authoring](agent-adapters.md). Earlier connection-owned/absolute-deadline sections are superseded, not alternative execution modes.

One local service per canonical repository/state namespace owns `RepositoryRuntime`, its legacy lease, registry, coordinator, TaskStore and DispositionManager. Multiple stdio front ends attach as authenticated connection actors. A front end neither starts independent native inference nor owns the service's lifetime. Each accepted assignment captures the actual client source view, exact base and non-secret agent snapshot.

The caller owns task decomposition, selection, integration, broader testing and acceptance. A worker owns scoped changes, applicable instructions/checks and ordinary commits. Passeur owns admission, explicit control, execution evidence and its own resources. A batch introduces neither a shared acceptance boundary nor sibling cancellation.

Execution results are immutable. Resource records independently account for pending delivery, retention, archive and retirement. Full-tip ancestry into the accepted reachable target proves integrated retirement. Squash/cherry-pick similarity does not: retain or explicitly archive source commits. Retirement refuses changed heads, dirty/untracked/ignored content, active/unknown workers, ambiguous ownership and unprotected commits. Passeur does not force-remove, automatically prune or discard unique work.

Worktrees isolate edits, not OS authority or shared Git administration. Processes outside Passeur can still edit files or refs. Loss of the service lease is not process fencing. An uncertain native stop or publication freezes unsafe replacement work until explicit reconciliation.

Build identity, front-end identity and service generation remain separate. Installed artifacts include the compiled service modules and the locked production dependency closure. Rebuilding a checkout does not replace installed/running code. Named caller registration ownership and required/optional policy remain in the existing Codex configuration adapter.
