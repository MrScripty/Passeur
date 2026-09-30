# Dynamic repository routing

**Status:** Verifying  
**Current phase:** objective verification  
**Current acceptance:** blocked  
**Next slice:** V1 — execute the locked repository checks and real Codex host routing workflow against this exact branch, repair only failures attributable to this slice, obtain independent final review, then decide acceptance.

## Objective and scope

Use one Codex-facing Passeur registration across repositories while preserving one elected Passeur service, lease, state store, execution authority, and profile identity per canonical repository.

A local Codex session supplies repository context through the working directory inherited by its stdio MCP process. Passeur resolves that directory through the existing canonical repository binding before service discovery or preparation. Linked worktrees converge on one repository identity; unrelated repositories retain independent repository services.

In scope: Codex registration/binding, default profile identity/migration compatibility, direct registration probing, focused routing/state regressions, and current user/agent guidance. Out of scope: a multi-repository daemon, new scheduler, tool-local repository selector, state-root migration, provider changes, worker sandbox changes, or relaxation of repository leases.

Implementation baseline: Passeur `46f5e8651240eb84e752940885073f6f338b9145`. Standards baseline and final review baseline: Coding-Standards `39d55dc330d44ecf940364ceada9d2527f7c7ea0`.

## Product contract and binding decisions

1. **Registration owner — `src/codex/config.ts`.** An unpinned registration contains runtime/build, state root, catalog and startup policy, but no MCP `cwd`, `--project`, `--profile`, or `--expected-repository-id`. Construction rejects accidental fixed routing fields.
2. **Frontend launch owner — `src/cli.ts`.** `serve`/`start` use inherited `process.cwd()` only when no explicit project was supplied. Explicit `register-codex --project` remains a pinned compatibility path.
3. **Repository identity owner — `resolveRepositoryBinding`.** Canonical Git common-directory identity, repository store root, service election and repository lease remain unchanged.
4. **Profile owner — workspace Git identity + `resolveRepositoryBinding`.** `src/workspace/project.ts` owns canonical main-worktree resolution from Git metadata; repository binding owns profile selection. New default profiles key by canonical repository ID. If that file is absent and an applicable legacy worktree default exists, main and linked worktrees reuse it; repository-ID profiles take precedence.
5. **Explicit profile intent.** Setup/configure install the unpinned registration only when using the repository-default profile. Explicit `--profile` or `--expected-repository-id` retains a pinned registration; no repository→custom-profile registry is invented.
6. **State authority.** Dynamic and pinned Passeur `serve` registrations may coexist only in the same state namespace where their reachability overlaps. The registration editor rejects dynamic↔pinned state-root splits in either direction.
7. Existing binding replacement, unmanaged-adoption authority, build/profile conflicts, lazy discovery, IPC, task state and lease semantics are preserved.

No second repository authority, router daemon, global mutable `RepositoryRuntime`, alternate lease, or duplicate state store is introduced.

## Objective acceptance claims

| ID | Observable criterion | Kind | Environment | Mode | Status |
| --- | --- | --- | --- | --- | --- |
| DR-A1 | Unpinned registration serializes/inspects with omitted or null `cwd`; fixed routing fields are rejected; pinned registration behavior remains valid. | contract | not-applicable | automated | blocked |
| DR-A2 | Frontends launched with the same unpinned command from a main worktree and linked worktree share repository ID/profile/service generation; an unrelated directory obtains a different service generation. | system | representative Linux/local FS | automated | blocked |
| DR-A3 | Dynamic↔pinned registrations cannot create a known second state namespace; same-state coexistence remains valid. | focused | not-applicable | automated | blocked |
| DR-A4 | Existing canonical main-worktree legacy default profiles are reused by linked worktrees, while a new repository-ID profile takes precedence once present. | integration | representative local FS/Git | automated | blocked |
| DR-A5 | Existing full Passeur type/build/core/native/Vitest suite remains green. | integration | representative supported build environment | automated | blocked |
| DR-A6 | A fresh supported Codex host with one unpinned registration started from two unrelated project sessions reports the correct `project_input` and attaches to distinct repository services without registration changes. | user-workflow | required-real installed Codex host | manual or automated | blocked |
| DR-A7 | Independent final review finds no unresolved architecture, state-authority, compatibility, or lifecycle defect in the exact verified candidate. | contract/review | not-applicable | manual | pending |

The current environment established the external design assumption from current Codex source: its stdio MCP transport permits an absent configured `cwd` and supplies the runtime's local process cwd to the local stdio launcher. That observation admits the design; it does not satisfy DR-A6.

## Constraints and assumptions

- Passeur's qualified shared service remains Linux/local-filesystem scoped.
- The local Codex host must provide its active project cwd as the stdio fallback when server `cwd` is absent. A host that cannot do this must use an explicit pinned registration.
- One selected state root is the durable namespace for repositories reachable by the global router.
- Custom repository-specific profile paths remain explicit pinned configuration until a separately justified repository-profile registry exists.
- Source edits are reversible and preserve the existing repository runtime/service/lease owners.

## Composed-design review

**Applicable.** This change moves the repository-selection seam across the Codex registration/process boundary and changes profile identity selection. The complete artifact probe is recorded in [reports/composed-design-review.md](reports/composed-design-review.md). Result: the selected design reuses the existing deep repository-binding/runtime owners; no new permanent module, service, registry or state authority is required.

## Milestones

| Milestone | Goal / write set | Gate | State |
| --- | --- | --- | --- |
| M0 | Admit routing seam and product contract; write plan. | Existing repository/service ownership remains valid. | Implemented |
| M1 | Implement registration, launch-context, profile compatibility and state-invariant repairs; add focused tests. Writes: `src/cli.ts`, `src/codex/config.ts`, `src/codex/probe.ts`, `src/workspace/project.ts`, `src/core/repository-runtime.ts`, affected tests. | Source/contract review; no duplicate runtime/state owner. | Implemented |
| M2 | Update current design/install/README/agent guidance and plan artifacts. | Documentation agrees with source and lifecycle. | Implemented |
| V1 | Execute DR-A1–DR-A6 and independent final review on exact candidate. | All required claims satisfied. | Blocked |

## Blockers

- The available shell has no outbound dependency access and no Passeur dependency cache. The repository has no active GitHub Actions workflow/runs through the connected account. Therefore `npm ci`, `npm run check`, focused Vitest integration tests and `npm test` cannot be truthfully claimed here.
- Actual fresh Codex host attachment across two project sessions is not available in this execution environment.
- Independent final review has not yet been performed.

These are verification blockers, not evidence for a source-design failure. See [execution-ledger.md](execution-ledger.md) and [issues.md](issues.md).

## Re-plan triggers

Re-plan if executable verification shows that the supported Codex host does not supply the active project as fallback stdio cwd, routing changes repository/state isolation, profile compatibility cannot remain deterministic without another authority, explicit-profile consumers require global routing, or the implementation propagates repository-routing knowledge beyond the admitted registration/binding owners.

## Plan artifacts

- [Execution ledger](execution-ledger.md)
- [Issues](issues.md)
- [Composed-design review](reports/composed-design-review.md)
- [Verification status](reports/verification.md)
