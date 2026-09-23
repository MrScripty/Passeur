# F8 admission — explicit operator metadata recovery

## Current authority and decision

User invocation: continue Plan 2A after committing F7. Canonical plan:
`docs/plans/structural-change-coordination/plan.md`. Source:
`3f8dbfc278a806f0bae18e5bef8e30cf47737394`; standards:
`366c1d90a24bbfb50973f62b155a5f3396c0f107`.

The current plan was Blocked on native qualification. The continuation is a
bounded re-admission (Blocked → Active), not permission to pretend native M0
passed or to run `continue` against an unchanged blocked authority. The
independent chosen outcome is recovery for already-exposed parent metadata
whose originating credential can be lost. This was an existing recovery gap in
F2–F7, not a new semantic-analysis product. The public metadata consumer and
pinned suite now have maintainer-recorded F7 evidence; that does not qualify F8.

Development decision: implement this reversible, bounded metadata/CLI extension
with an intentional v2 migration at first recovery. Missing native packages
cannot change these contracts. The irreversible consequence is discarding or
misassigning authority; exact operator authentication, stale checks, immutable
receipts and migration tests address it. No speculative recovery engine,
provider, model, source edit, timer or generic policy framework is introduced.

## Exact write authority

Production: `src/contracts/coordination-control.ts`,
`src/contracts/coordination-service.ts`, `src/coordination/control.ts`,
`src/service/coordination.ts`, `src/core/repository-runtime.ts`,
`src/cli/coordination.ts`, `src/cli.ts`, `src/mcp/coordination-operations.ts`.

Tests: new `tests/core/coordination-recovery.test.mjs`,
`tests/core/coordination-recovery-runtime.test.mjs`,
`tests/fixtures/structural/recovery-reopen.mjs`; affected
`tests/core/coordination-store.test.mjs`,
`tests/core/coordination-elected.test.mjs`,
`tests/integration/coordination-cli-entry.test.mjs`.

Durable docs: `docs/coordination.md`,
`.agents/skills/passeur-bridge/SKILL.md`; current plan, ledger and issues under the
canonical directory. New evidence files in its `reports/`: `f8-admission.md`,
`f8-verification.md`, `f8-test-results.txt`, `f8-typecheck.txt`,
`f8-environment.txt`, `f8-elected-unavailable.txt`, `f8-cli-unavailable.txt`,
`f8-source-integrity.json`, `f8-resource-summary.json`.

Unrelated source, profiles, credentials, lockfiles, native adapters, parser
bundle, source workspaces, installed registrations and Plan 2B remain unchanged.
The current F7 complete-checkout records and previous fixture-path correction
are byte-verified preimages, not reverted to the older delivery archive.

## Contract and verification gates

The canonical request decoder gains explicit operator variants; ordinary
commands, MCP schemas and task controls retain their authority. Runtime operator
checks use the existing private credential on each request. Initialization and
recovery share that credential reader but not a consent field. CLI checks
`--yes` before connection; settlement also requires its separate flag. Native
stop or accepted code is never inferred from an operator metadata receipt.

A v1 record migrates only in the atomic publication of its first successful
recovery. Old data and ordinary command semantics remain readable. Version-2
history is immutable; unsupported rollback refuses instead of erasing it.

Focused gates: exact deltas, stale/competing requests, note/party preservation,
key/revision integrity, reserved bytes/slots, real-file atomic failure and cold
reopen, authenticated runtime operator denial, cancellation of observation,
source loss, CLI consent, MCP exclusion and request-correlated replies. Use the
actual elected listener and compiled CLI as required higher-boundary tests.
Run selected existing regressions and changed-module static checks. No previous
suite pass or failed import closes a new gate. Independent review and full plan
acceptance remain separate. New tests use existing runners and fixtures.

## Eight composed-design probes

1. **Independent concerns:** codec owns representations/invariants; control owns
   metadata transitions; store owns publication; runtime owns operator identity
   and task-independent lifetime; CLI owns explicit invocation consent. Native
   task control and physical Git/resource safety remain referenced, not owned.
2. **Interleavings:** lookup, stale checks, metadata changes and audit publication
   share the control ordering contract. Operator authentication completes before
   entry; no human callback runs under control locks. Observer loss does not
   abandon accepted work. External operations are not made atomic with JSON.
3. **Caller knowledge:** operator needs exact subject/epoch/owner/revision and a
   statement, plus generation for cases. Normal parents learn no storage schema
   details and receive no new automatic messages. CLI passes existing envelope.
4. **Locality:** a new recovery action touches canonical codec/control/tests;
   credential policy changes remain at the runtime/credential owner. Formatting
   and paging remain with existing service contract. No scheduler knowledge is
   introduced into persistence or recovery.
5. **Dependencies:** callers use closed requests/replies and an explicit optional
   service authorization capability. Absent recovery capability fails only the
   new recovery route; it is not an allow-all fallback. Runtime supplies it.
6. **Evolution/failure:** v1 remains unchanged until migration; v2 requires a
   compatible reader. Ordinary functionality continues in v2. Missing source
   does not block authorized metadata closure. Invalid/unavailable credentials
   fail before administrative inspection or publication.
7. **Deletion:** removing recovery leaves inaccessible metadata ownership and no
   safe lost-credential path; removing audit/transition constraints loses exact
   replay and the ability to explain changed authority. These responsibilities
   are contained in existing owners; no new production service/registry exists.
8. **Cumulative cost:** two operator request variants, five explicit recovery
   actions and one persisted-version extension. No semantic graph, evaluator,
   automatic rebuild, new database, credentials or general workflow language.

## Standards route and boundaries

Read Core/Router and applicable Planning, Implementation, Verification and
oracles, Development Proportionality, Documentation and Commit; Architecture/
Code Design, Contracts/protocol/evolution, Concurrency, Security, Resilience,
Diagnostics, Cross-Platform, TypeScript/Async, Persistence, IPC and Launcher.
The MCP schema generator and language parser artifacts are unchanged. No new
third-party source or dependency is selected. Concurrent Plan Integration is
not selected: one implementer proposes one current slice, without independently
authorizing stale proposals. Product parent concurrency is not that trigger.

## Stopping and disposition

Re-plan on a real need to authorize process/resource effects, rewrite notes,
weaken operator verification, permit silent history loss, or claim rollback to
v1 after migration. Missing pinned/native/installed evidence blocks those claims,
not the independent implementation. Return the overall plan to Blocked if its
remaining required gates are unavailable. Deliver an ordinary patch for the
maintainer; no remote commit or user-worktree cleanup is authorized.
