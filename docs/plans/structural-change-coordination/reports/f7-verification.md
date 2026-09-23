# F7 verification — public metadata consumers

## Subject and authority

Governing plan: `docs/plans/structural-change-coordination/plan.md`, revision 2A.
Operation: explicit continuation after the maintainer committed F6; scoped
re-admission is in [F7 admission](f7-admission.md). Baseline:
`18a26fdb54434f9c516f030112ce7d4a616974f1`. Exact changed preimages were reconstructed
from connected content/previous delivery and verified against current Git blob
identities before packaging. This is a sparse source mirror, not a full clone.

## Implemented behavior

One explicit CLI request-file operation and four MCP groups (read, external work,
notes, reconciliation). Complete canonical validation precedes dispatch; CLI
mutations require --yes before connection/credential effects; MCP cannot initialize.
Ordinary task APIs, metadata persistence, authenticated transport and operation
lifetime remain with their existing owners. The MCP catalog and named registration
consume the same tool names. Requests never grant their own actor/permission.
No parser, model, compiler, project build, automatic retasking or merge runs through
these metadata operations. Development tests/typechecking are separate activities.

## Executed evidence

The final Node test selection includes **304 tests: 50 new and 254 retained**;
all passed with zero failures, skips, cancellations or todos. The new tests execute
the real file reader, canonical decoders, operation handlers, authenticated client,
runtime, source validation and coordination store. The listener/task-inventory/
lease/recovery boundaries are explicit existing test fixtures; no real-host or
production election claim is made from those substitutes.

New selected counts: public operation/transport tests 31; CLI file/handler tests
16; actual shell wrapper with an explicit argument receiver 3. Retained 254 cover the earlier control/store/Git/observation/runtime/client
contracts. Seven unchanged original coordinator foundation tests were not rerun.
The run directory includes spaces; the existing path conversion fix is preserved.
All **237** recorded distinct per-test roots are absent. Sources, branches and
commits inside those roots are explicitly disposable fixture-owned resources.

```sh
EVIDENCE_TYPESCRIPT=/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript \
  node docs/plans/structural-change-coordination/reports/transpile-selected.cjs "$PWD"
PASSEUR_TEST_RESOURCE_LOG=/path/to/f7-test-resources.jsonl \
  node --test --test-concurrency=1 $(find tests/core -name '*.test.mjs' \
    ! -name coordination-elected.test.mjs ! -name structural-foundation.test.mjs \
    ! -name coordination-mcp.test.mjs | sort)
```

Transpilation uses real source and is evidence execution only, not type checking
or a shipped runtime fallback. [Test output](f7-test-results.txt),
[resource summary](f7-resource-summary.json) and [resource log](f7-test-resources.jsonl)
retain the actual observations.

The actual import closure of `src/mcp/coordination-operations.ts` and
`src/cli/coordination.ts` passes strict available-tool checking (TypeScript 5.8.3,
Node declarations 25.1.0). See [command/result](f7-typecheck.txt). This excludes
the SDK/Zod-backed registration module and the entire CLI/server/config type graph;
it is not the repository's pinned TypeScript 5.9.3/@types/node 24.7.2 check.
No fabricated declarations or substitute SDKs were generated. New .mjs files
pass Node syntax checking; this alone proves no framework behavior.

## Required but unexecuted consumer evidence

`tests/core/coordination-mcp.test.mjs` contains four tests using the real SDK,
Zod schemas, complete catalog and actual metadata endpoint. It fails to import
locally because @modelcontextprotocol/sdk is absent: **no test assertion ran**.
`tests/integration/coordination-cli-entry.test.mjs` contains two actual compiled
CLI/elected-service cases in the existing built-application Vitest stage; Vitest
is absent locally, so no assertions ran. [Attempt output](f7-public-unavailable.txt)
records these loading failures. These are not passes or skips in the 304-test run.
The core compilation file list now includes every new core-test production root;
the CLI entry test uses the existing `npm test` build-before-Vitest ordering.
`vitest.config.ts` explicitly includes that new .mjs file; the original .test.ts
selection is preserved and Node core tests are not added to Vitest.

Required complete-checkout commands before accepting F7:

```sh
npm run check
npm test
```

That must include the generated SDK schema/catalog conformance, invalid public
requests causing no service preparation, actual CLI preconfirmation refusal,
persistent CLI operator identity and metadata operation through real election.
The existing elected-listener and old task/catalog tests remain selected. Actual
installed-host use, source/grammar extraction for all thirteen entries, managed
linkage, monitoring, retirement ordering, performance and external review remain
whole-plan requirements.

## Review and limits

The review checked decoder/projection group boundaries, no MCP initialization,
CLI byte/handle/cancellation lifetime, catalog and compilation consumers, and
preservation of current evidence. New test mistakes and mirror reconstruction
were corrected rather than changing valid production behavior. See issues.md
I-F7-04/05 and [review](f7-review.md). This is same-author development review,
not independent external review. No benchmark or universal compliance claim is made.

The committed F6 report and ledger's successful elected/pinned run are preserved
byte-exactly as prior-candidate evidence, not reused as proof of the F7 public
consumer. Plan state returns to Blocked, acceptance blocked, next gate F7-V1.
The plan was compacted to current authority and links; earlier history remains
in existing ledger/reports. No SC01–SC17 objective acceptance is inferred here.

Launcher discovery correction: the existing wrapper was a required consumer
outside the initial CLI source file list. Its exact new action is admitted in
F7 scope/map. Two tests fail on the original wrapper and pass after the one-word
allowlist addition; the old-command regression also passes. See
[baseline wrapper result](f7-launcher-before.txt). The captured final 304-test
run includes all three. No claim of end-to-end CLI execution is inferred from
a test-owned argument receiver.

The retained launcher-failure output removes trailing spaces from otherwise
blank presentation lines so the repository patch passes whitespace checks. Test
results, assertions, diagnostics and ordering are unchanged.

## Repository integration check — September 22, 2026

All 36 affected source preconditions matched the complete checkout at
`18a26fd`. The updated Passeur usage skill passed skill validation and its
public-metadata documentation link resolves. `npm run check` passed;
`npm test` passed with 405 core, 40 native and 99 frontend tests. The core run
included the four real SDK cases and the frontend run included the two compiled
CLI entrypoint cases that could not load in the sparse mirror. `git diff --check`
passed. These checks qualify F7's local SDK/CLI/pinned test gate; they do not
establish native parsing, installed-host behavior or complete Plan 2A acceptance.
