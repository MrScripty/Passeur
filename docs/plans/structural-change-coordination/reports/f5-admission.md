# F5 admission — runtime-owned metadata coordination

Date: September 22, 2026. Source: `accc19acab46da6e3310b878bcee0b77c37ecdd1`.
Operation: maintainer-requested continuation of Plan 2A at
`docs/plans/structural-change-coordination/plan.md`.

The maintainer committed F4 and requested further implementation. The selected
bounded re-plan moves Blocked to Active for actual RepositoryRuntime composition
of the existing metadata session and managed-workspace exclusion. Native parser,
full pinned build, public host and installed acceptance remain separately blocked.
No acceptance requirement is waived and Plan 2B is an unchanged reference.

## Owned outcome

RepositoryRuntime supplies its actual binding, lifetime, lease checks and task
resource inventory to CoordinationService. Metadata activity neither loads a
provider nor assumes a valid execution profile. Existing operator credentials
are read through one canonical owner for initialization authorization; a request
cannot invent operator authority. Registered external sources must not be
managed task resources, including moved and aliased paths. Observer loss and
drain preserve admitted work and protected controls. All operations remain
internal pending real public transport/host and managed-task-linkage integration.

## Exact write set

- `src/core/repository-runtime.ts`
- `src/core/coordination-resources.ts` (new)
- `src/service/operator-token.ts` (new; canonical bounded credential reader)
- `src/service/bootstrap.ts` (credential reader re-export only)
- `src/workspace/worktree.ts` (read-only inventory extraction/re-export only)
- `src/workspace/inventory.ts` (new; unchanged inventory implementation)
- `tests/core/coordination-runtime.test.mjs` (new)
- `tests/core/coordination-resources.test.mjs` (new)
- `tests/core/operator-token.test.mjs` (new)
- `tests/fixtures/structural/runtime-fixture.mjs` (new)
- `tsconfig.core.json` (new source roots only)
- `docs/coordination.md`
- This plan's `plan.md`, `execution-ledger.md`, `issues.md`,
  `reports/contracts-and-workflow.md`, `reports/design-admission.md`,
  `reports/implementation-map.md`, `reports/implementation-evidence.md`,
  and new `reports/f5-*` evidence.

Add directly affected paths here before editing; re-plan only when the ownership,
risk or evidence changes. Existing source transport and dependency manifests are
read-only. No substitute parser, validator, compiler declaration or provider is
introduced to bypass missing dependencies.

## Proof boundary

Use the real RepositoryRuntime, TaskControls, metadata session/control/store,
Git worktrees and credentials. Existing RuntimeDependencies supplies a test-owned
task-resource inventory, lease and recovery seam; these tests do not claim the
actual TaskStore codecs, election, host authentication or native execution.
Run the retained 175 tests where actual import dependencies are available.
Strict-check the new dependency-free production closure with the available
compiler and report the distinct full-root/pinned check limitation. Run in a
checkout path containing spaces. Verify patch preimages, applied bytes and
fixture disposal. Same-author review is not external acceptance review.

## Standards route

Core and Router; Planning, Implementation, Verification and its independent-oracle
rules, Development Proportionality, Commit, Documentation; Architecture/Code
Design, Contracts/Evolution, Security, Concurrency, Resilience, Cross-platform,
Diagnostics; TypeScript/Async and Persistence. Runtime integration specializes
existing ownership; no new parser, dependency, model, publisher or scheduler is
selected. Requirements retain their adopted revision
`366c1d90a24bbfb50973f62b155a5f3396c0f107`.

## Stop and completion conditions

Source ownership ambiguity refuses only the affected enrollment rather than
inventing permission. A changed authority or unsupported mechanism is an explicit
finding. Deliver a coherent tested increment with remaining consumers documented;
return the whole plan to Blocked when unavailable native/public/installed evidence
remains. No universal standards-compliance or completed-plan claim is made.
