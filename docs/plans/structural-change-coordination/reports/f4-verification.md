# F4 verification — metadata service session

Date: September 22, 2026.
Baseline: `81b7a2a308f6fe546b4a0b9e118180936e0360a2`.
Plan: `docs/plans/structural-change-coordination/plan.md` (2A).
Status: F4 implemented with scoped local evidence; objective/acceptance blocked.

## Subject and actual proof path

The changed production subject is the coordination-service decoder and session,
plus the export of the existing receipt decoder. The selected path is:

validated request → service session → repository/source gate → actual Git and
control/store → authorized metadata view or receipt → correlated validated reply.

Five process scenarios add actual `IpcConnection` JSON-lines frames over a Unix
socket between separate clients and a test-owned child process. The production
transport is unchanged. The fixture implements identity mapping and explicit
initialization/resource policy solely to isolate the session boundary. It is
not `runRepositoryService`, not a provider stand-in, and not evidence of the
real host/election/registration path. No public tool is registered or advertised.

Each selected test uses its actual boundary: literal independently authored
request/reply expectations for codec tests; real repository/store fixtures for
session behavior; real process restart and transport for the five IPC scenarios.
The old structural primitive tests still use hand-authored extraction fixtures,
not real parser output. Their passing is not language support.

## Commands and environment

[Environment](f4-environment.txt) records Node 22.16.0, Git 2.47.3, Linux x86_64,
TypeScript 5.8.3 and absent native/provider/protocol dependencies. Node declaration
version is 25.1.0. These are available tools, not the repository's TypeScript
5.9.3 / @types/node 24.7.2 pins. Package.json/lockfile are not changed.
The working directory is a partial source mirror with verified selected bytes.
A local package marker/types link supplied module/type resolution only and is
excluded from the patch. No synthetic SDK or parser was used.

Strict selected import-closure check and compilation:

```sh
tsc --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes \
  --skipLibCheck --module NodeNext --moduleResolution NodeNext \
  --target ES2022 --types node --rootDir . --outDir .passeur-core \
  src/service/coordination.ts src/service/transport.ts \
  src/observation/report.ts src/observation/match.ts src/coordination/notices.ts
```

Result: exit 0. [Typecheck log](f4-typecheck.txt). This compiles real imported
source, not ambient declarations pretending to be the application. It is not
`npm run check`, the pinned build, or verification of absent application modules.
`tsconfig.core.json` adds the new real roots for later pinned repository runs.

Final selected test run from a copied source path containing spaces:

```sh
PASSEUR_TEST_RESOURCE_LOG=/absolute/path/f4-test-resources.jsonl \
node --test --test-concurrency=1 \
  tests/core/coordination-control.test.mjs \
  tests/core/coordination-store.test.mjs \
  tests/core/coordination-repository.test.mjs \
  tests/core/coordination-bound.test.mjs \
  tests/core/structural-primitives.test.mjs \
  tests/core/coordination-service-contract.test.mjs \
  tests/core/coordination-service.test.mjs \
  tests/core/coordination-service-ipc.test.mjs
```

Result: **175 passed**, zero failures, skips, cancellations or todos.
[Complete TAP](f4-test-results.txt). Files are run with the repository core
suite's file-concurrency convention; relevant overlap is explicitly caused
inside cases using gates, concurrent calls and separate client processes.
The run does not imply every repository test passed. The seven F0 coordinator
foundation tests and full application/native/installed suites were not rerun.
The maintainer's committed F3 URL conversion and issue record were preserved.

## Cases and deciding observations

| Suite | Count | Selected evidence |
|---|---:|---|
| New service contract | 18 | Closed variants; field/actor/repository/subject/key/hash relationships; input copying; getters/prototypes rejected; version/selector/range/text bounds; response mismatch diagnostics |
| New session | 32 | Explicit authorized initialization; concurrent opening/configuration; source-gated SHA-1/SHA-256 registration; author/access separation; Unicode paging; changed view and cross-parent cursor refusal; source loss/corruption; saturation; detached operations; drain/close; fresh-process reopening |
| New framed-process path | 5 | Separate clients share one owner; one target lead; publication then lost response with receipt-only recovery; malformed payload refusal without connection loss; new process release after source loss |
| Retained F2/F3/observation | 120 | Control/store 52; repository/bound-source 42; structural primitives 26. Each retains its prior proof limits. |

The long-view case asserts the view really exceeds the 24576-byte service-message
bound and reconstructs it through bounded pages. The Unicode case asserts exact
assembled content and byte positions; success is not inferred from exit alone.
Revocation is rechecked per page before disclosure. Unrelated metadata updates
preserve unchanged selected-view identities. View digests are not credentials.

The lost-response test closes the peer only *after* `session.handle` completes
its durable command. A new client reads the own receipt and entity, then asserts
no extra entity or revision. It does not resend the mutating operation or claim
exactly-once execution of arbitrary external effects.

Two independent parents race for one target. One succeeds, one receives the
existing `COORDINATION_TARGET_HELD` outcome, and the actual durable record has
one case/leader. There is no heartbeat or lease-expiration inference.

## Review and resources

[Same-author review](f4-review.md) includes the failing receipt-content and
path-with-spaces cases followed by fixes. It is not independent external review.
[Final resources](f4-test-resources.jsonl): **141 recorded roots**, all absent.
[Resource summary](f4-resource-summary.json) and
[development fixture accounting](f4-development-resources.json) identify the
five known roots retained after initial failed fixture teardown. Those peers
had exited before their exact test-owned directories were removed. All final
peer tests assert observed code-0 exit and absent socket after close.

Only test-created repositories/worktrees are disposable. The copied path-space
source fixture and packaging apply-check directories are derived verification
artifacts, not user repositories, accepted branches or real installations. No
user commit, worktree, account, remote branch or runtime was mutated.

## Acceptance limits

SC01–SC17 remain unsatisfied as objective claims. This proves the selected
metadata boundary, not the whole coordination application. Remaining work:
actual runtime ownership/permissions and registered operations, managed task
and announcement linkage, native parsers/extractors for all thirteen entries,
live monitoring/notifications, operator recovery, resource-retirement ordering,
full pinned checks, actual installed host/providers, representative performance
and independent final review. Disk process-reopen evidence is not device
power-loss durability; fixture principals are not live host authentication.

No speed, throughput or memory improvement is inferred from TAP durations.
No compiler, parser, evaluator, Git merge/push or project build is performed by
the tested session. The test/compiler commands here are development evidence,
not newly introduced application policy.

## Repository integration check — September 22, 2026

The package preconditions matched the complete checkout at `81b7a2a`.
`npm run check` passed. The first full `npm test` run found that
`tsconfig.core.json` did not emit the unchanged `src/service/transport.ts`
module imported by the new IPC test. Adding that source to the core build made
all five focused IPC tests pass. The final `npm test` run passed: 271 core,
40 native and 97 frontend tests. `git diff --check` also passed. These checks
do not establish native parser or installed user-workflow acceptance.
