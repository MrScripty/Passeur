# Plan 2A implementation evidence — partial delivery

## Scope and result

Baseline: `f9a7c5d2d314580e5f7849982cf158397f9c11de`. Standards: `366c1d90a24bbfb50973f62b155a5f3396c0f107`. Execution date: September 21, 2026, America/Vancouver. This delivery implements F0/F1 only. The full Plan 2A is **Blocked** and is not a completed structural-coordination product.

## Source integrity and process

The connected repository reader supplied exact text at the named baseline. Ten materialized source/configuration files matched their Git blob hashes; see [source integrity](source-integrity.json). Direct clone and npm registry DNS failed; see [environment](environment.txt). The work area is an isolated sparse source mirror, not a full Git checkout. No user changes, live configuration, accounts, remote branches or installed runtimes were altered.

The user explicitly admitted `docs/plans/structural-change-coordination/plan.md` with operation `start`. The native M0 blocker caused a bounded re-plan for independently testable F0/F1. Source/tests changed within that declared write set. No parser emulation, guessed dependency pins, declaration stubs or evaluator calls were substituted. No shared history was rewritten. No local commit was fabricated from an incomplete upstream tree; the maintainer receives the exact cumulative patch and source preconditions for ordinary reviewed integration.

## Changed source

F0 changes `src/workspace/worktree.ts` and `src/core/coordinator.ts`:

1. Exact-base task worktree preparation preserves dirty parent checkout/index/untracked content.
2. After confirmed stop, final Git delivery/change/artifact collection does not inherit the cancelled execution signal. Unconfirmed stop remains protected.
3. Task creation intent retains the administration lock only during publication. Git checkout hooks execute outside that repository-wide lock; the task remains active and owns its unique resource.

F1 adds internal `src/observation/{model,source,match,report}.ts` and `src/coordination/notices.ts`:

- Exact commit/tree/blob reads, SHA-1/SHA-256 identity, UTF-8 byte-loss rejection, distinct commit absence and missing working capture.
- Linux descriptor-anchored sampling with no symlink traversal, no special-file reads, size/encoding/identity checks, exact captured-byte excerpts and explicit non-atomic semantics.
- Comparison of **already-extracted internal values**, including independent source pairs, conservative overload correspondence, ambiguity, incomplete headers, body/default markers and unrepresented-region visibility.
- Escaped per-work INPUT/OBSERVED reports bounded by real output byte budgets, with no body/default-digest rendering.
- A pure compact-evidence fingerprint that excludes capture/OID/position churn. It does not implement notifications or authorization.

`tsconfig.core.json` discovers these internal module roots. No public CLI/MCP operation, parser helper, persisted coordination schema, watcher or user-visible structural feature is registered.

## Evidence that ran

| Claim under test | Observation | Limit |
|---|---|---|
| Three foundation regressions | Same seven tests against unchanged baseline: 3 intended failures, 4 passes | Controlled worker and in-memory store; real coordinator/Git/hooks |
| Foundation corrections | Seven tests pass after patch | Not vendor conformance or TaskStore codecs |
| Source and internal structural primitives | Twenty-six tests pass | Hand-authored extraction values, not parser output |
| Combined focused run | 33 pass; 0 fail, skipped or cancelled | Selected source mirror, not complete application suite |
| New internal TypeScript import closure | Strict check exit 0 using TypeScript 5.8.3 and available Node types 25.1.0 | Not pinned TS 5.9.3 / Node 24.7.2 declarations |
| Exact changed-file inspection | Baseline hashes and cumulative diffs checked | Self-review, not independent external review |

The repository reading copy of the baseline log removes whitespace-only trailing indentation; its original output is preserved in the ZIP’s top-level `evidence/raw-baseline-test-output.txt`. Logs: [baseline failures](baseline-regressions.txt), [focused tests](focused-test-results.txt), [selected typecheck](selected-typecheck.txt). Timing in the test logs is execution evidence only, **not a performance benchmark**.

## Oracle boundaries

The foundation tests import the actual coordinator, task-control, input broker, workspace and Git code. Their registry/worker and store are explicitly controlled fixtures; no fixture claims persistence crash durability or native account behavior. Git repositories/hooks execute in real temporary directories with explicitly disposable fixture commits. Hooks are not bypassed.

The primitive tests use real SHA-1/SHA-256 repositories, symlinks, FIFO/directory handling and held file descriptors. Matching/reporting tests use independently authored declaration values. They prove transformation of those values, not whether a language parser extracts them accurately, whether default masking is correct, or whether the proposed native ABI works. All thirteen language qualification claims remain open.

The selected source was transpiled with the available TypeScript `transpileModule` for runtime testing. That only erases/types/transforms syntax. The [evidence-only helper](transpile-selected.cjs) records the procedure; it is outside production build paths. The independent strict check was limited to new internal modules and their real import closure. No substitute compiler or fake dependency is installed into the application.

## Not executed or not implemented

**Not implemented:** native parser helper and grammar bundle; real declaration extractors and value masking; actual CLI/MCP structural-report route; work announcement linkage; live monitoring/generation ownership; durable notice cursors/delivery; notes and agreements; reconciliation claims and case-aware retirement; configuration/version migration and installed parser packaging.

**Not executed:** full pinned `npm run check`, `npm test`, and `npm run build:runtime`; complete existing suites; supported-language corpus checks; actual two-parent/three-worker native workflow; representative performance/memory/context budgets; fresh-session skill acceptance; independent external review. No evaluator/provider calls or source transmissions occurred.

The existing core delivery/pool and disposition source were inspected for changed-family interactions, but the complete consumer population and pinned suites must still be verified in a full checkout. A zero-result connector code search was not treated as proof of no consumers.

## Required resumption

Resolve M0 native dependency and full-checkout prerequisites; inspect source drift; record the plan's owned unblock decision; use `continue` only after it is Active. Reconcile the internal values with the future authoritative wire schemas instead of copying definitions. Implement M1–M5, run all affected pinned checks, qualify every language and installed path, and complete external review before acceptance.

A maintainer with dependencies provisioned through the repository's authorized procedure should run:

```sh
npm run check
npm run test:core
npm test
npm run build:runtime
```

Passing those commands alone does not supply real provider/host or all parser-language evidence unless their actual scenarios are executed.

## Resource disposition

Only temporary test repositories, hook processes and in-memory fixtures were created. Each completed test closes owned handles, releases its controlled hook/worker, drains the coordinator and removes only its explicitly disposable test root. No user worktree or unique user commit is removed. No production background service remains running. The source mirror and delivery artifacts remain as the requested handoff. [Test-resource dispositions](test-resources.jsonl) record 19 test-created repository roots and their known heads/worktrees; every recorded root was confirmed absent after cleanup.

Plan 2B is included unchanged for reference. It is not admitted for implementation, and this patch introduces no evaluator dependency, credential path or network evaluation.
