# F5 development review

Date: September 22, 2026. Baseline:
`accc19acab46da6e3310b878bcee0b77c37ecdd1`.
This is same-author development review, not the independent final review gate.

## Reproduced new-code findings

| ID | Reachable failure and independent test | Correction and final evidence |
|---|---|---|
| F5-R1 | A managed worktree was moved, detached, and its former path reused by another worktree. A path-only anchor wrongly allowed external enrollment. The test expected `COORDINATION_RESOURCE_UNAVAILABLE` and failed with missing rejection. | Require agreement of the canonical recorded resource path and one branch-retaining inventory row for nonretired unrelated claims. Red log: f5-resource-regression.txt. Final case passes. |
| F5-R2 | An independently registered nested worktree inside a managed workspace could be enrolled because equality alone did not express resource containment. | Component-aware overlap in either direction, preserving a positive prefix-sibling case. Expected `COORDINATION_WORKSPACE_MANAGED`; red log f5-resource-boundary-regressions.txt, final pass. |
| F5-R3 | A resource marked retired was ignored even though its task was nonterminal. | Read the TaskStore-owned task phase and require terminal before treating retirement as absence of a managed claim. Expected `COORDINATION_RESOURCE_UNAVAILABLE`; same red log, final pass. |

These were flaws in the new F5 implementation, not incidents attributed to the
committed baseline. The tests construct real Git worktrees and independently
select the expected ownership outcome; the decoder/branch observations do not
generate their own expected permission result.

## Additional review decisions

A namespace read suspends before lazy session creation. A closing runtime now
rechecks open-state after that read so it cannot create a session after shutdown
has selected the owners it will close. The overall shutdown and admission tests
exercise the runtime lifetime; no dedicated interleaving fixture is claimed for
that exact privateDirectory await point.

The canonical operator read now validates the opened descriptor and bounds its
read to 65 bytes; it does not use a separate size check followed by unbounded
readFile. Wrong size/type/permissions and symlink fixtures pass. Concurrent
operator rotation is an observation contract, not a cross-process transaction.

Public source/command authority continues to depend on the real elected listener
and its authenticated actor. The new internal method does not accept an actor
from its decoded payload. No generic RPC or parser substitute was introduced.

## Test-harness corrections and preservation

Initial new tests used a wrong receipt field/expectation; those assertions were
corrected to the existing canonical contract and are not production findings.
An early interrupted run left one known test-created directory; its disposal
was separately authorized and recorded in f5-development-cleanup.json. Fixtures
now release owned gates before shutdown even following a failed assertion.

The maintainer's fileURLToPath correction and I-F3-05 were preserved. The newly
committed transport compilation-root correction and I-F4-06 were recovered from
the pinned source rather than overwritten with an older ZIP overlay. All final
tests ran from a directory containing spaces.

## Remaining evidence

The actual RepositoryRuntime is exercised, but task inventory, lease/recovery
and principals use the existing injected test boundary. Complete application
compilation, real TaskStore/election/host checks, native parser support,
representative performance and independent final review remain required. The
selected new module closure passes strict available-tool checking; that does
not typecheck the entire modified runtime or bootstrap.
