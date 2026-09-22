# F2 implementation evidence

Date: September 22, 2026. Source baseline:
`43e3a78a1736539e0fd565899c1bd1c52eae9b42`.
Standards authority: `366c1d90a24bbfb50973f62b155a5f3396c0f107`.
Scope and authorized re-plan: [F2 admission](f2-admission.md).

## Material result

Four new production modules implement internal coordination-control v1 and
real-file persistence. TaskStore now imports/re-exports its unchanged atomic
JSON function from the shared module. Its name, function body and publication
semantics are preserved. Existing task/result/IPC/CLI/MCP contracts were not
changed. tsconfig.core.json includes the new internal roots.

Two new test files and two test-only fixtures exercise the control/store.
Existing structural-primitives tests are rerun unchanged. Source identity and
preimage verification are recorded in [f2-source-integrity.json](f2-source-integrity.json).

## Executed verification

| Evidence | Observed result | What it establishes |
|---|---|---|
| tests/core/coordination-control.test.mjs | 30 pass | Current-actor authorization, sharing, immutable statements, exact-party acknowledgments, case revisions/generations, stable target uniqueness, replay, closure and release reserve. |
| tests/core/coordination-store.test.mjs | 22 pass | Real initialization/publication/read/reopen, identity/shape/version rejection, preservation of incomplete/corrupt state, file-type checks, receipt/transition invariants, and selected interruption points. |
| tests/core/structural-primitives.test.mjs | 26 pass, unchanged | Existing source-capture, conservative comparison, reporting and notice-materiality regressions. |
| Combined run | 78 pass; zero failures, cancelled tests, skips or todos | These three files under the described environment, not the entire repository. |
| Strict TypeScript check | Exit 0 | Actual import closure of new owner/store plus existing structural primitives under TypeScript 5.8.3 and Node declarations 25.1.0. |
| Atomic writer comparison | Exact function-body equality with verified original | Mechanism unchanged by extraction; not a substitute for the still-required full TaskStore consumer tests. |
| Fixture cleanup | 62 created roots recorded; all absent after teardown | Test-owned paths removed after their assertions; no user worktrees or global prune. |

Logs: [test results](f2-test-results.txt), [compiler result](f2-typecheck.txt).
Elapsed suite duration is diagnostic and is not performance qualification.

## Commands and environment

Observed tools: Node v22.16.0, TypeScript 5.8.3, Node declarations 25.1.0,
Git 2.47.3, Linux local working filesystem. No selected native parser modules,
complete installed dependency tree or current application build are available.
Direct dependency access still fails; no package installation was performed.

The scoped compiler invocation used the actually available Node declarations:

```sh
tsc --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes \
  --skipLibCheck --target ES2022 --module NodeNext --moduleResolution NodeNext \
  --typeRoots /opt/nvm/versions/node/v22.16.0/lib/node_modules/ts-node/node_modules/@types \
  --types node --rootDir . --outDir .passeur-core \
  src/contracts/coordination-control.ts src/coordination/control.ts \
  src/store/coordination-store.ts src/observation/source.ts \
  src/observation/match.ts src/observation/report.ts src/coordination/notices.ts

node --test tests/core/coordination-control.test.mjs \
  tests/core/coordination-store.test.mjs tests/core/structural-primitives.test.mjs
```

The absolute typeRoots is an evidence-environment path, not a change to project
configuration or an instruction to replace the repository's pinned compiler.
The package retains TypeScript 5.9.3 and its existing dependency contract.
In a complete authorized checkout, run the owning pinned compilation/tests;
test:core discovers the new .test.mjs files via its existing pattern.

## Independent oracles and interruption claims

Assertions encode named domain postconditions: exactly one active target case,
unchanged prior bytes on refusal, a particular typed rejection, exact note
parties, generation change, and a saved receipt after reopening. Expected
outcomes are not regenerated from implementation outputs. Tests inspect real
files and run separate Node processes for the following interruption cases.

A child exits after the durable command but before returning its receipt. A
fresh child reopens the store and obtains that exact receipt without repeating
the state transition. Another child exits at a known pre-rename authority
check. The test establishes both the complete staged record and unchanged
published control; a fresh owner retries the operation against the published
state. These cases do not prove arbitrary kernel/storage failure behavior,
concurrent writer election, or device power-loss durability. The authority
check count is tied to the unchanged atomic primitive and identifies the tested
interruption point; it is not a production recovery heuristic.

Controls use synthetic fixture parent identities and workspace/commit metadata.
Tests do not prove those identities came from authenticated connections or
that named commits exist. Those facts must be supplied by verified consumers.
Store tests exercise CoordinationStore, not the existing TaskStore class or
its historical codecs. Real observation regressions use Git as before.

## Local findings and review

The current reviewer is the implementation author, not an independent external
reviewer. A source review covered authority-before-effect, loss of immutable
history, note disclosure after changing inputs, replay after handoff, cardinality
and byte reserve, symlink/foreign-state preservation and no unmediated effects.
The note-context and byte-reserve regressions led to the fixes recorded in
issues.md. No parser/code-analysis stub or new public tool was exposed to make
a test pass. Source controls import no model, provider or Git merger.

The sparse mirror contains the previous changed-file artifact plus connected
source reads, with preimages and hashes recorded. It is not a complete clone.
No repository commit was fabricated; the final patch is supplied for maintainer
integration and whole-repository checks with ordinary hooks/signing policy.

## Remaining gates

F2 does not close SC09–SC15: announcement-to-task identity, real parent
connection authorization and disclosure, CLI/MCP contracts, operator adoption,
case-aware retirement serialization and complete user workflow remain pending.
The native helper, all thirteen parser/extractor qualifications, live monitoring,
notification delivery, pinned full application checks, installed-host behavior,
representative performance and independent review remain outstanding. The seven
previous F0 foundation tests were not rerun in this continuation.

The code is an implemented internal increment. The overall plan stays Blocked
with blocked acceptance, rather than being marked Implemented or Accepted.
