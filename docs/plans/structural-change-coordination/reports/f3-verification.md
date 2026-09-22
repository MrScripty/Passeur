# F3 implementation evidence — repository-bound coordination

Date: September 22, 2026. Source baseline:
`7ad16cf1c40a4522938d31a6e64f8e29b3cc15f7`.
Adopted standards: `366c1d90a24bbfb50973f62b155a5f3396c0f107`.
Scope/admission: [F3 admission](f3-admission.md).
Source integrity: [f3-source-integrity.json](f3-source-integrity.json).

## Material result

`CoordinationRepository` verifies local Git worktrees, canonical common-dir
binding, physical root/admin identities, exact object formats/commit objects,
commit ancestry and direct target refs. `RepositoryCoordination` uses those
observations before executing existing metadata commands. It requires an
explicit trusted resource-authority callback for external registration and
rejects command-supplied workspace IDs, parent identities, or source paths.

Git work runs outside the coordination mutation lock; the final command
rechecks current leadership, revision and access. Source-reading capacity is
bounded independently from metadata release/revocation/settlement/receipt
operations. Cancellation before metadata acceptance cannot start native work;
no operation here launches a provider or performs integration. The source
owner closes admission and drains its started operations.

The existing v1 persisted format and old command meanings remain unchanged.
The canonical OID/target validators are exported, not copied. The control owner
adds permission-checked source snapshots and historical receipt lookup. The
new repository-operation shape is internal, not an advertised MCP/IPC API.
`tsconfig.core.json` includes the actual new roots.

## Verification executed

| Evidence | Observed result | Deciding boundary |
|---|---|---|
| `tests/core/coordination-repository.test.mjs` | 19 pass | Real Git SHA-1/SHA-256 objects, worktrees, aliases, roots/metadata identity, lineage and exact direct targets; hook/fsmonitor nonexecution; selected source limits. |
| `tests/core/coordination-bound.test.mjs` | 23 pass | Real Git observations composed with actual control/persistence; concurrent claims, revocation/revision races, capacity separation, authorization-source race, cold reopen and post-publication receipt loss. |
| Existing `coordination-control.test.mjs` | 30 pass | Existing authorization, sharing, note/receipt, leadership and capacity contracts. |
| Existing `coordination-store.test.mjs` | 22 pass | Existing actual file publication, decoding, interruption and reopening. |
| Existing `structural-primitives.test.mjs` | 26 pass | Existing source capture, comparison, compact report and notice-materiality behavior. |
| Combined selected suite | **120 pass; 0 fail/cancelled/skipped/todo** | These five test files, not the full application suite. |
| Strict import-closure check | Exit 0 | New modules and their actual imported dependencies, plus selected observation roots; TypeScript 5.8.3 and Node declarations 25.1.0. |
| Test resources | **104 unique recorded roots; all absent after teardown** | Only disposable repositories/stores created by these tests. |

Logs: [tests](f3-test-results.txt), [typecheck and tool identities](f3-typecheck.txt),
[resource records](f3-test-resources.jsonl),
[resource postcondition](f3-resource-summary.json),
[review regressions](f3-review-regressions.md).
The prior seven controlled-coordinator foundation tests were not rerun here.

Capability probe: [f3-environment.txt](f3-environment.txt).

Runtime: Node 22.16.0, Git 2.47.3, Linux/local filesystem. The available compiler
is 5.8.3, not the repository-pinned 5.9.3; Node declarations 25.1.0 differ from
pinned 24.7.2. A sparse byte-verified mirror was used, not a full checkout or
fully resolved npm environment. Existing tests were rerun against their actual
selected implementations; no generated parser or fabricated type declaration
was substituted. Supporting typecheck and focused tests do not close the
required pinned application check.

## Oracle and fidelity boundaries

Test commits and linked worktrees are created with ordinary Git in per-test
repositories. Expected object type, source/target identities and ancestry are
asserted against those constructed facts, independently of the new observer.
No Git hooks are bypassed. Fixture-local identity config is not personal config.

The parents are fixture principals, not authenticated host sessions. The
resource-authority callback uses an explicit fixture allow-set or a rejecting/
barrier callback. Tests show that the callback is required, awaited outside the
control lock, and followed by source revalidation. They do not implement or
qualify TaskStore-owned workspace admission, its complete race contract,
service election, connection authentication or user approval.

Source errors and target movement have their own expected diagnostics. Source
and sharing/race checks use actual Git and control operations around deliberate
barriers. A fresh child reopens real persisted state; a controlled exit after
accepted intent but before returning its receipt shows receipt recovery without
repeating a Git effect. This is not device power-loss or distributed atomicity
evidence. A parent settlement statement remains a statement, not proof that
external Git integration succeeded.

## Same-author review and limitations

Review found and corrected three new-code defects: registering a source replaced
during resource authorization, dependence on a subsequently removed opening
checkout, and rejecting a healthy source due to an unrelated unborn worktree.
Failing and final passing evidence is retained. This is same-author review, not
the independent external review required at the final integration boundary.

Git facts are observations, not pins or process fences. External writers can
change refs/workspaces after observation; this code performs no merge and
cannot prevent unmediated Git effects. Permission, expected control revision
and leadership are rechecked at the final metadata publication boundary, not
across a fabricated Git/JSON transaction. Physical IDs are bounded filesystem
observations; they are not a universal lifetime/provenance guarantee.

## Unfinished required consumers

No public coordination command is registered. RepositoryRuntime/service
composition, authenticated CLI/MCP operations, operator takeover, trusted
managed-task/workspace linkage, coordinated-submit v5, real resource-admission
and retirement ordering, live notice delivery, native parser/language
qualification and installed migration remain to be implemented and verified.
The native modules and full pinned dependencies remain unavailable here.
Performance budgets, native-provider/host workflow and independent review
remain pending. No SC01–SC17 objective claim is upgraded to satisfied by F3.

F3 source is implemented and locally verified at the above boundary. The whole
plan remains **Blocked / acceptance blocked**. The next gate is native M0 and
actual source/runtime composition; subsequent work must keep the complete
requested objective and its evidence requirements.

## Repository integration check — September 22, 2026

After applying the package to the complete Passeur checkout at `7ad16cf`,
`npm run check` passed. The first `npm test` run found two test-harness failures:
the cold-reopen child path used `URL.pathname` and retained `%20` for the space
in this checkout's directory. Using `fileURLToPath` made both focused tests pass.
The final `npm test` run passed: 216 core, 40 native and 97 frontend tests.
`git diff --check` also passed. This is whole-repository local test evidence;
it does not qualify the unimplemented native parser or installed user workflow.
