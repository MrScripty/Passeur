# F3 admission — repository-bound coordination

Date: September 22, 2026. Examined commit:
`7ad16cf1c40a4522938d31a6e64f8e29b3cc15f7`.
Canonical plan: `docs/plans/structural-change-coordination/plan.md`.
The user requested continuation after committing F2. This owned re-plan
transitions Blocked to Active only for F3; `continue` does not silently waive
a Blocked state or the native M0 gates.

## Decision

The selected native parser is absent. Direct registry access still fails DNS;
the repository archive route did not yield a downloadable artifact. The
connected repository permits pinned source reads. Implement the independent
repository-binding and service-facing operation boundary: derive real physical
workspace identities, check exact commit objects/ancestry and direct target
refs, and apply the existing coordination rules after source validation.
Preserve the full objective and the still-blocked parser/language/installed
claims. No parser surrogate, public tool or second service is introduced.

The source mirror includes the committed Git no-lazy-fetch correction, verified
by Git blob identity. Uploaded overlays are inputs, not current-source proof.
The current task-owned checkout and source-inspection implementations remain
unchanged except for any separately recorded necessary finding.

## Exact write set

New production: `src/coordination/repository.ts`,
`src/coordination/bound-control.ts`.
Existing production: `src/contracts/coordination-control.ts` for the canonical
repository-command decoder/validation exports; `src/coordination/control.ts`
for repository identity, explicit receipt lookup, and source-preparation
preflight snapshots; `tsconfig.core.json` for these import roots.
New tests: `tests/core/coordination-repository.test.mjs`,
`tests/core/coordination-bound.test.mjs` and
`tests/fixtures/structural/repository-fixture.mjs`,
`tests/fixtures/structural/bound-reopen.mjs`.
Documentation: `docs/coordination.md`; this plan's plan, ledger, issues,
contracts-and-workflow, design-admission, implementation-map and
implementation-evidence reports; the new f3-admission, f3-verification,
f3-test-results, f3-typecheck, f3-source-integrity, f3-test-resources,
f3-resource-summary, f3-environment and f3-review-regressions records.
Plan 2B is retained unselected and unchanged.

## Authority and evidence boundaries

Git validation runs outside the control store's mutation lock. The final
control transition still rechecks authorization, expected revision and current
leadership. An observed Git state is not a transaction across a live checkout,
Git refs and JSON. In particular, source verification is not a pin, a merge,
permission to integrate or protection from concurrent external Git writes.

The composition root must supply the authenticated actor, its verified source
view, current repository lease authority and existing owned-workspace admission
checks. F3 will not claim to provide MCP authentication, task admission/linkage,
service election, lifecycle fencing, operator adoption or retirement exclusion.
Only the real source-to-control boundary is eligible for this slice's evidence.
Metadata release, revocation and receipt lookup must remain possible after a
source checkout disappears. Neither failure nor disconnection releases a claim.

## Standards route and stopping rule

Use the adopted Core/Router, Planning, Implementation, Verification and its
independent-oracle detail, Development Proportionality, Commit/Documentation,
Architecture/Code Design, Contracts/Evolution, Concurrency, Security,
Cross-Platform, Persistence, TypeScript/Async, and the applicable Git protocol
facts. The current conversation contains the governing modules. No new
external dependency, compiler analysis, global configuration or standards
engine is authorized by this source increment.

Pass strict checking of the actual new import closure and real Git/store tests
for aliases, different repositories, SHA-1/SHA-256, absent/wrong-type objects,
non-descendant revisions, direct/symbolic/stale targets, revoked access,
concurrent ownership, receipt replay, cold reopen and release after source
loss. Negative tests must reach the named boundary. Record all qualification
limits; missing full pinned/native/host evidence remains blocked. An unexpected
semantic ownership/consumer defect is a re-plan trigger, not a silent local
fallback.
