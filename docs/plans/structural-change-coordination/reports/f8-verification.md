# F8 verification — operator metadata recovery

## Complete-checkout integration — September 22, 2026

The maintainer checkout at the `3f8dbfc` affected-source baseline accepted the
supplied patch. `npm run check` and the full `npm test` passed: 438 core, 40
native and 100 frontend tests. This includes the real elected-process recovery
test and compiled-CLI entrypoint test that could not run in the sparse mirror.
The updated usage skill validated and `git diff --check` passed. This closes
the pinned/elected/compiled-CLI availability gap for this checkout only;
installed-host operation, native parsing, managed task linkage and independent
acceptance remain open. The selected sparse-mirror evidence below is retained
as package provenance, not substituted for the complete-checkout result.

## Candidate and actual outcome

Source baseline: `3f8dbfc278a806f0bae18e5bef8e30cf47737394`.
F8 source is implemented. **337 selected tests passed**: 33 new recovery tests
and 304 retained control/store/source/runtime/transport/handler tests. There
were zero failures, skips, cancellations or todos in that final run. The real
store/Git/client/runtime paths run where their fixtures provide them; excluded
boundaries are stated below. No objective SC01–SC17 claim is accepted.

The complete affected preimages were selected from the latest committed files,
not assumed equal to the earlier delivery. The current F7 complete-checkout
plan/ledger/report and committed path fix are preserved. See
[source identities](f8-source-integrity.json). This is a sparse mirror without
an upstream Git checkout, not a signed source archive or whole-repo audit.

## Commands and discovery

```sh
EVIDENCE_TYPESCRIPT=/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript \
  node docs/plans/structural-change-coordination/reports/transpile-selected.cjs "$PWD"

PASSEUR_TEST_RESOURCE_LOG=/mnt/data/passeur-f8/delivery-test-resources.jsonl \
  node --test --test-concurrency=1 $(find tests/core -name '*.test.mjs' \
    ! -name 'coordination-elected.test.mjs' \
    ! -name 'coordination-mcp.test.mjs' \
    ! -name 'structural-foundation.test.mjs' | sort)
```

The existing evidence-only transpiler erases types using actual available
TypeScript; it does not fabricate SDKs/contracts. The explicit exclusions are
not silently skipped tests: elected/SDK dependencies cannot load here, and the
seven unchanged original coordinator-foundation tests were not rerun. The full
repository `npm test` selects those actual gates. The existing Vitest include
already discovers the modified CLI `.mjs` test. New Node test filenames match
the existing `test:core` glob. Existing compiled sources import every changed
production owner; no new production compilation root is required.

[Final test output](f8-test-results.txt) and
[resource summary](f8-resource-summary.json) retain the selected evidence. Final
fixtures recorded 277 resource entries covering **266 distinct roots**; each
was absent after teardown. The fixture repositories are disposable test-owned
resources; no user repository/worktree was removed. Cold-process probes are
joined before their owning root is removed. Raw resource entries are packaged
as evidence; their digest is in the summary.

## Claims actually tested

| Claim | Actual path / oracle | Result / boundary |
|---|---|---|
| Exact authorized metadata recovery | Decoder → control → real-file store; independently specified expected deltas | v1 unchanged by inspection/refusal; first accepted recovery atomically produces v2 plus audit. |
| Source, authorship and party preservation | Direct assertions on input/workspace/areas, ordinary receipts, immutable notes and acknowledgments | Adoption changes only the selected authority/revision fields; no forged agreement. |
| Stale and competing controls | Same-state concurrent requests plus old-owner/revision/generation operations | Exactly one competing adoption; stale input refuses without publication; old receipts cannot repeat transfer. |
| Explicit external settlement | Actual case state plus CLI consent handler and runtime operator checks | Possible effects block adoption/release; separate settlement report then fresh revision needed; no process/Git proof inferred. |
| New lead disclosure | Selected input owned by another parent, with/without explicit sharing | No automatic selected-input sharing on adoption. |
| Version/history and capacity | Real snapshots, transition counterexamples, max-escaped audit fields, saturated slot sequence | Rewrite/downgrade/unrelated edits rejected; closure and settle/release fit reserved obligations; adoption may fail capacity. |
| Atomic failure and lost receipt | Authority loss at publication; real fresh child process exits after write but before reply, then another child reopens | No partial accepted migration before rename; published recovery is returned without repeating adoption. Not device power-loss proof. |
| Operator identity | Actual authenticated client/route/runtime/token file with fixture listener/lease/task inventory | Ordinary parent denied; extra approval field rejected; token replacement invalidates subsequent operator requests/pages. |
| Request lifecycle | Observer cancels while runtime-owned preparation proceeds; actual completion then store observation | Observer loss does not abort accepted metadata; no service shutdown is substituted for observer cancellation. |
| Bounded inspection | Paged inventory/view, changed-view digest and source-loss cases | Current authorization checked per request; no note bodies in inventory; source loss does not erase/disable metadata closure. |
| CLI/MCP boundary | Real request file/handler and canonical tool-group decoder | Missing --yes and incorrect settlement flag fail before connection; all four groups reject recovery. |
| Reply identity | Malformed operator/statement/hash/kind replies | Destination decoder rejects a different attributed acknowledgment. |
| Composition capability | Actual service construction and absent capability route | Noncallable callback rejected; missing optional recovery authority is typed unavailable before store access. |

## Required higher-boundary attempts

The existing `tests/core/coordination-elected.test.mjs` now exercises real
operator recovery and reopens v2 after elected-process restart. It requires the
actual `flock`, listener, TaskStore and complete contract/dependency closure.
The attempted run failed at import of the missing compiled service contract
before any assertion or service launch; see
[elected import result](f8-elected-unavailable.txt). It is not a passing test.

A third test in `tests/integration/coordination-cli-entry.test.mjs` runs the real
compiled CLI/elected service, checks missing consent, inappropriate settlement
flag, v2 adoption and receipt retry. The local load probe found missing Vitest
before assertions; see [CLI import result](f8-cli-unavailable.txt). Node's loader
probe is not a substituted Vitest run. Existing two CLI cases are preserved.
Use the actual pinned `npm run check` and `npm test` in the full checkout.

The four unchanged SDK/schema tests were not rerun locally. Pure tool-handler
rejection does not replace SDK conformance or actual installed-host behavior.
Previous F7 maintainer results remain valid for F7, not automatically for F8.

## Static verification

Strict TypeScript checking passed for the actual import closure of:
`src/coordination/control.ts`, `src/contracts/coordination-service.ts`,
`src/service/coordination.ts`, `src/cli/coordination.ts`, and
`src/mcp/coordination-operations.ts`, with ES2022/NodeNext, strict,
noUncheckedIndexedAccess and exactOptionalPropertyTypes.
[Exact command/result](f8-typecheck.txt).

Tools were available TypeScript 5.8.3 and Node types 25.1.0, not the repository
pins. The entire modified root CLI/runtime and complete application type graph
remain unverified because their real dependencies/source closure are absent.
No hand-written external declarations, replacement SDK or alternate parser was
used to obtain a pass. Runtime transpilation/execution is not type evidence.

## Development review and disposition

Same-author review checked the privileged route, runtime token authorization,
CLI-only consent, atomic version migration, exact deltas, immutable audit/key
namespace, source independence, capacity and requested-notification behavior.
It added the capability, cold-process and maximum-case-release cases. Existing
future-version fixtures moved from v2 to v3 because the contract intentionally
adds v2; unsupported-version rejection is retained. A case fixture's required
input sharing and an observer test's completion ordering were corrected to the
actual contract, without weakening behavior. The existing fileURLToPath source
was restored byte-exactly before the full selected run from a space-bearing path.

This is development review, not independent external review. Retained log text
normalizes only trailing presentation whitespace; raw logs are in package
evidence. No full compliance or performance certification follows from passing
these selected tests. Full pinned, elected/compiled CLI, installed workflow,
all-language native parser qualification, task linkage/retirement and final
independent review remain required. F8 returns the whole plan to Blocked while
retaining a usable source increment for maintainer verification/integration.
