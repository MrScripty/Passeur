# F5 verification — actual runtime metadata composition

Date: September 22, 2026. Baseline: `accc19acab46da6e3310b878bcee0b77c37ecdd1`.
Canonical plan: `docs/plans/structural-change-coordination/plan.md`, revision 2A.
F5 is Implemented with scoped local evidence. Objective and acceptance: Blocked.

## What was actually executed

Internal request → **actual RepositoryRuntime** → actual metadata session →
actual repository/Git observations → actual CoordinationControl/CoordinationStore
→ retained request/reply contract. The fixture uses the existing RuntimeDependencies
seam only for task-resource inventory, lease, recovery and forbidden profile load.
Actual TaskControls, operator credential files, metadata files and Git worktrees
execute. This is not the elected service listener or a host-authenticated user path.

The retained five framed IPC cases use unchanged IpcConnection over real Unix
sockets in separate processes. Their actor/initialization/resource policy remains
fixture-owned. The seven original foundation cases execute the actual coordinator,
Git and hooks with controlled native workers and store. Primitive structural
fixtures remain hand-authored extraction inputs, not a parser or language proof.

## Environment and commands

Available: Node 22.16.0, TypeScript 5.8.3, Node declarations 25.1.0.
The repository pins TypeScript 5.9.3 and @types/node 24.7.2; those are not replaced.
[Environment](f5-environment.txt) records missing Tree-sitter, Zod and MCP modules
and a registry DNS failure. No dependencies were installed. The source mirror is
partial; [source identities](f5-source-integrity.json) pin selected baseline bytes.

Execution-only transpilation used the retained evidence script and actual source:

```sh
EVIDENCE_TYPESCRIPT=/absolute/path/to/available/typescript \
node docs/plans/structural-change-coordination/reports/transpile-selected.cjs \
  '/absolute/path/Passeur checkout'
```

This transpiles without typechecking; it is not a production fallback or accepted
build. Generated output stays outside the patch. [Executed source identities](f5-test-subject.json)
bind the final run to the included source and test files. The resulting real modules were
then executed from a directory containing spaces:

```sh
PASSEUR_TEST_RESOURCE_LOG=/absolute/path/f5-test-resources.jsonl \
node --test --test-concurrency=1 \
  tests/core/coordination-*.test.mjs \
  tests/core/structural-*.test.mjs \
  tests/core/operator-token.test.mjs
```

[Final TAP](f5-test-results.txt): **236 passed**, zero failures/cancellations/skips/todos.
The core runner uses its existing serial suite policy; individual cases explicitly
exercise pending-operation, source-change, lease-loss and shutdown interleavings.

| Evidence group | Count | Actual scope |
|---|---:|---|
| New runtime composition | 23 | Binding/authority/no-profile behavior, request lanes, cancellation, drain, shutdown, restart and source loss |
| New resource ownership | 22 | Real Git worktrees plus decoded fixture task records, moves/reuse/nesting/unknown/retired cases |
| New canonical credential owner | 9 | Real private file creation/read, bounds, malformed bytes, symlinks, permissions, replacement |
| Retained F1–F4 suites | 175 | Existing control/store/repository/session/framing and internal observation regressions |
| Original F0 foundation suite | 7 | Actual coordinator/Git/hooks with controlled worker/store |
| Total | 236 | Selected path only, not the complete repository suite |

Strict typechecking of the actual **new dependency-free module closure**:

```sh
tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext \
  --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --skipLibCheck \
  --types node --typeRoots /absolute/path/to/available/node-declarations \
  src/core/coordination-resources.ts src/service/operator-token.ts \
  src/workspace/inventory.ts
```

[Typecheck](f5-typecheck.txt): exit 0. This does **not** check the complete modified
RepositoryRuntime/bootstrap type graph. The actual configured core check was
attempted without synthetic declarations and remains unavailable due to missing
source/dependencies; [attempt](f5-core-check-unavailable.txt), exit 2. The original
unqualified attempt is retained in [full-check log](f5-full-check-unavailable.txt).
No stub types, alternate schema library or parser were used to claim a pass.
Trailing terminal-profile diagnostics in raw logs are not test assertions or
application outcomes; the TAP/typecheck results above are their explicit records.

## Review, data and resource authority

[Review](f5-review.md) identifies three new-code defects and exact intended
refusals. Red tests changed one ownership condition at a time with real valid Git
inputs. Their final passing cases appear in the full suite. The final expected
outcomes were not generated from the implementation. Other tests use explicit
receipt fields, errors, ownership and lifecycle invariants from the existing
contracts rather than a guessed generic failure.

[Resources](f5-resource-summary.json): 202 records, 202 unique
roots, **all absent** after teardown. [Per-case dispositions](f5-test-resources.jsonl)
identify exact disposable roots and observed heads where applicable. Only fixture
resources are discard-authorized. [Development cleanup](f5-development-cleanup.json)
accounts for one known root left by an early interrupted test; no global prune
or user worktree deletion occurred.

The source path contains spaces. The current committed fileURLToPath fixture
and transport tsconfig root are retained. The unchanged inventory implementation
was extracted/re-exported, and the seven original foundation regressions were rerun.

## Remaining acceptance

The actual TaskStore resource decoder path, elected service authentication,
operator CLI/MCP presentation, managed task/announcement linkage, case-retirement
ordering, native parser/all 13 language extractors, installed artifact, representative
performance and independent external review remain required. Fixed safety caps
are not qualified workload budgets. TaskStore.list still reads its complete
inventory before the consumer's resource-row cap; no whole-path memory/latency
claim is made. Coordination status.ready means metadata readiness, not a fresh
lease/source/parser or native-provider guarantee.

Public coordination tools remain unregistered. No model calls, tests or builds
are initiated by the feature. Development tests are separate from application
behavior. Git observations are not source fencing or a transaction with the
coordination store. No SC01–SC17 claim is closed merely by these selected tests.
No remote publication, installation or user-account/configuration action occurred.

## Repository integration check — September 22, 2026

The package applied to the complete checkout at `accc19a` with all 34 affected
preconditions matching. This checkout has the pinned TypeScript 5.9.3 and
`@types/node` 24.7.2. `npm run check` passed; `npm test` passed with 325 core,
40 native and 97 frontend tests. `git diff --check` passed. These results
qualify the repository test/typecheck gate that was unavailable in the sparse
mirror. They do not qualify native parser extraction, actual public host wiring,
installed behavior or full Plan 2A acceptance.
