# F9 verification — managed task enrollment and selected-result retirement

## Complete-checkout integration — September 22, 2026

The supplied patch matched all 42 affected-source preconditions at the
`8ddf6d9` baseline. `npm run check` passed. The first full `npm test` exposed
an invalid synthetic result in the new real-TaskStore test: `completed` with
`stopped` native state still had `unknown` coverage. The actual persisted-result
codec rejected it. Changing only that fixture's coverage to `turn_scoped` made
the isolated test pass; the full suite then passed with 475 core, 40 native and
100 frontend tests. The actual TaskStore and SDK cases ran. The usage skill
validated and `git diff --check` passed. This closes the sparse mirror's
TaskStore/SDK/pinned availability gap for this checkout, not the installed-host,
parser, announcement-linkage or independent acceptance gates. The selected
evidence below remains package provenance.

## Candidate and outcome

Baseline: `8ddf6d9403ed4cc3f6f26a6d70c4b0940599020d`.
Selected final run: **372 tests passed**, zero failures, cancellations, skips or
todos. These are 35 new cases (14 control, 17 runtime, three authenticated
client cases and one additional public-group case) plus 337 retained cases.
The source directory contains spaces. Selected test files ran concurrently
with independent fixture roots; the repository's normal runner configuration
is unchanged. **298** distinct recorded temporary roots are absent after
teardown. [Output](f9-test-results.txt), [resource summary](f9-resource-summary.json),
[environment](f9-environment.txt) and [review](f9-review.md) retain exact scope.

F9 source is implemented. The real TaskStore/SDK and full pinned consumer gates
remain unavailable in this environment; no SC01–SC17 claim is accepted. The
previous complete-checkout F8 report/ledger is preserved as evidence for F8,
not substituted for the changed candidate. The sparse source mirror has verified
affected bytes but is not a complete Git checkout or upstream signed commit.

## Commands and discovery

```sh
EVIDENCE_TYPESCRIPT=/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript \
  node docs/plans/structural-change-coordination/reports/transpile-selected.cjs "$PWD"

PASSEUR_TEST_RESOURCE_LOG=/mnt/data/passeur-f9/final-resources.jsonl \
  node --test --test-concurrency=4 $(find tests/core -name '*.test.mjs' \
    ! -name 'coordination-elected.test.mjs' \
    ! -name 'coordination-mcp.test.mjs' \
    ! -name 'coordination-managed-store.test.mjs' \
    ! -name 'structural-foundation.test.mjs' | sort)
```

The existing evidence-only transpiler uses the actual available TypeScript
compiler to erase types. Execution of emitted code is not static type evidence.
The exclusions are explicit: elected/SDK/actual TaskStore dependencies are
absent here; seven unchanged original coordinator-foundation cases were not
rerun. Complete-checkout `npm test` discovers all those real gates through its
existing core glob. Production imports reach the new module, so no additional
compilation root is necessary. No SDK/schema/compiler declarations were fabricated.

The selected runtime tests execute actual RepositoryRuntime, native-owner check,
CoordinationService/Control/Store, source observer, real Git/worktrees and the
unchanged DispositionManager. TaskStore inventory/admission, lease/recovery and
principals are explicit fixture seams. Three authenticated tests use the real
ServiceClient, authentication/routing/IPC over Unix sockets with the existing
fixture listener. These are not live Codex/Muse, actual elected listener, full
TaskStore codec or installed-host evidence.

## Observable claims exercised

| Claim | Path and oracle | Boundary |
|---|---|---|
| Current owner enrolls exactly one existing implementation task | Public decoder/handler → authenticated client/runtime → actual Git → metadata store; independent expected task/input/scope assertions | No new native run; fixture task records supply the TaskStore interface. |
| Private, literal source attribution | Exact UTF-8 prefix/default sharing/path-origin assertions; no context/acceptance text copied | No semantic summary or inferred function relationship. |
| Prepared source and branch requirements | SHA-1/SHA-256 repositories; queued, review, missing, mismatched, detached, retiring/retired resources | Git facts are observations, not editor fencing. |
| Version evolution and immutable attribution | Real-file v1/v2 → v3 only on successful enrollment; rejected/ordinary reads preserve earlier bytes; future version 4 rejected | Task request/result bytes and historical operator receipts preserved. |
| Lost receipt and reopen | Child publishes v3 then deliberately exits before reply; a fresh child reopens/replays the same enrollment receipt | No second enrollment; not device power-loss durability. |
| Owner transfer separation | Current native owner required; operator/reader alone denied; later metadata adoption preserves source attribution | Enrollment receipt is historical acknowledgment, not renewed native authority. |
| Selected-result retention | Real DispositionManager refuses selected result before effects; release then archives exact tip and removes only owned resources | Closure of Work alone does not unselect; retained disposition remains allowed. |
| Case selection/retirement races | Controlled preflight → retirement start/end → stale token refusal; active reservation excludes selection | Metadata mutex is not held across Git; unrelated notes/closure still work. |
| Task association races | Enrollment/adoption/disposition exclusive per task; observer cancellation preserves admitted operation | No timer releases authority or kills worker. |
| Shutdown | Control closes during gated snapshot; new reservation rejected; already issued tokens accounted for | New-code regression failed before fix, passed afterward. |
| Recovery/resource uncertainty | Persisted cleanup_pending/corruption refuses new selection/retirement; never-enabled board leaves ordinary retirement available | No empty-state fallback or automatic task replay. |
| Public projection | New work-group variant accepted; forged source/actor/internal fields and other tool groups rejected | Real SDK consumer has its own unexecuted local gate below. |

## Required full-checkout tests

New `tests/core/coordination-managed-store.test.mjs` seeds an isolated fixture
through actual TaskStore request/control/result/resource codecs, constructs a
real RepositoryRuntime with its default lease/recovery, then enrolls/selects/
refuses retirement/releases/archives and reads its actual stored receipt.
It invokes no model. Its local execution failed on a missing compiled task
contract before any test assertion: [load failure](f9-taskstore-unavailable.txt).
No fake TaskStore or replacement contract is used to turn that into a pass.

`tests/core/coordination-mcp.test.mjs` adds one SDK call through the existing
McpServer registration to the managed authenticated runtime fixture, and checks
the generated input exposes task ID without writable source metadata. Its four
retained SDK cases also stay intact. The local file failed on missing
`@modelcontextprotocol/sdk` before assertions: [load failure](f9-sdk-unavailable.txt).
The one new real-store test and one new SDK case are not counted among 372.
The four old SDK cases and the unchanged elected test were not rerun locally.

F9-V1 requires `npm run check` and `npm test` in the complete pinned checkout,
including these two new consumer cases, existing elected/compiled CLI and native
regressions. Actual installed-host use, independent final review and parser
qualification remain separate requirements even after that succeeds.

## Static checking and source integrity

[Strict checking](f9-typecheck.txt) passes the actual import closure of
`src/core/managed-coordination.ts`, `src/service/coordination.ts`, and
`src/mcp/coordination-operations.ts` with ES2022/NodeNext, strict,
noUncheckedIndexedAccess and exactOptionalPropertyTypes. The available compiler
is TypeScript 5.8.3 with Node declarations 25.1.0, not pins 5.9.3/24.7.2.
This closure includes changed metadata control/source/session contracts.
The entire modified root runtime/task-control/MCP schema type graph remains
unverified here because its real dependency/source closure is absent.

[Source identities](f9-source-integrity.json) identify preimages and material
source/test outputs. The delivery manifest binds every changed file and patch.
Package applicability and byte identity are not product acceptance or source
signature verification. No synthetic signed upstream commit is created.

## Resource accounting and limits

The final resource log has 309 entries covering 298 distinct roots; all are
absent. Test processes settle before their fixture-owned repositories are
removed. One earlier interrupted development run left a known fixture root;
its recorded Git identity/head and absence of live owned processes authorized
only that root's removal. The raw resource log and interrupted-run disposition
are in package evidence; the summary binds the log bytes.

The exact release-first policy has no alternate protecting-ref override.
No automatic announcement/reference submission, native grammar loading,
structural monitoring, model messages, evaluation calls or project builds are
added. This feature coordinates evidence/ownership; it does not merge code or
certify semantic correctness. Source completeness and green selected tests do
not certify general or future Coding-Standards compliance. Plan 2A remains
Blocked, Plan 2B remains unchanged/unselected, and no remote publication,
account operation, installation, personal configuration or user-worktree
cleanup occurred.
