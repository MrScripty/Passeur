# F9 admission — managed enrollment and retirement

Invocation: `continue`, canonical plan
`docs/plans/structural-change-coordination/plan.md`. The maintainer's continuation
revisits the native-blocked plan for an independent, useful runtime path.
Source baseline: `8ddf6d9403ed4cc3f6f26a6d70c4b0940599020d`.
Adopted standards: `366c1d90a24bbfb50973f62b155a5f3396c0f107`.

## Selected scope

Re-admit Active for explicit enrollment of an existing managed implementation
task and coordination-aware retirement. This is not automatic announcement or
announcement-reference submission. Those remain required later; task request,
result, native execution and ordinary submit meanings remain unchanged.

Enrollment must resolve the actual task under current control, acquire a
runtime-owned per-task association reservation, verify its workspace and input,
and publish one immutable task attribution. Task adoption/retirement cannot
race that publication. Existing data remains readable. The first successful
managed enrollment upgrades metadata storage to v3; earlier runtimes must not
mutate it. No native dependency, toolchain or account provisioning is authorized.

Retirement and case selection share metadata-owner ordering. Active selections
refuse retirement. A runtime-owned reservation covers the Git/resource operation
without holding the metadata mutex across external work. Changed reservation
generations invalidate source preflight. Unknown publication or corrupt state
is not treated as an empty board. Native task control and metadata ownership
remain separate after adoption.

## Exact write authority

Production: `src/contracts/coordination-control.ts`,
`src/contracts/coordination-service.ts`, `src/coordination/control.ts`,
`src/coordination/bound-control.ts`, `src/coordination/repository.ts`,
`src/service/coordination.ts`,
`src/core/repository-runtime.ts`, `src/core/task-control.ts` (owner parameter
type only), new `src/core/managed-coordination.ts`,
`src/mcp/coordination.ts`, `src/mcp/coordination-operations.ts`.
Evidence: exact files are enumerated in the F9 implementation map; managed
control/runtime/authenticated/real-store cases and fixture peers; affected
store/SDK tests. The actual elected test is unchanged. Reflection of required
root paths is not a new framework or permanent compilation substitute.
Documentation: `docs/coordination.md`, `.agents/skills/passeur-bridge/SKILL.md`,
this plan's `plan.md`, ledger, issues and F9 reports. Existing Plan 2B stays
unselected and unchanged. A directly affected additional owner is recorded
before editing; scope is not enlarged by file count alone.

## Evidence contract

Use real Git/worktrees and the real metadata store. Assert native-control
rejection, matching immutable admission, selected-result refusal, both ordering
races, reopened storage, old bytes preserved until migration, permission and
SDK projection. Controlled TaskStore/election/native seams prove only their
specified interfaces, not their implementation. Add complete-checkout tests for
actual TaskStore/runtime and SDK consumers. The unchanged operator CLI uses
the same complete decoder and is covered again by required full pinned checks. Full pinned checking is attempted, not
substituted by transpilation. Parser/installed/performance/final independent
claims remain with the original acceptance owners.

A single implementation owner produces a patch for maintainer integration.
No parallel authorizing proposals are outstanding; Concurrent Plan Integration
is not selected. Archive reconstruction is a sparse source mirror, not an
upstream checkout or fabricated commit. Preserve committed integration evidence.
