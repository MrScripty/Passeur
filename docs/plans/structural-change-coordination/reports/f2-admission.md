# F2 admission — durable coordination control

Date: September 22, 2026. Baseline: `43e3a78a1736539e0fd565899c1bd1c52eae9b42`.
Canonical plan: `docs/plans/structural-change-coordination/plan.md`.
The user explicitly requested `continue` after committing the foundation increment. The prior Blocked state is not treated as executable: this owned re-plan admits only F2, transitions the plan to Active, then continues. Native parser and installed acceptance claims remain blocked.

## Decision and boundary

Direct dependency downloads still fail DNS and the selected native parser packages are absent. The existing GitHub connection permits verified source reads. Repeating provisioning attempts cannot currently qualify the parser. Implement the independent durable coordination owner already admitted in D9–D11/M3–M4. Keep all new operations internal until actual service/MCP, human adoption, task linkage, and resource-guard consumers have been integrated and verified. Do not advertise unavailable tools, fabricate grammars, or claim that internal operations satisfy end-to-end SC09–SC15.

The complete coherent increment implements validated external-work metadata registrations (physical membership remains a caller precondition) with explicit read sharing, immutable attributed notes with exact-party acknowledgment, and stable target leadership. It preserves one authoritative JSON aggregate, selected resource limits, current-authority checks, exact expected revisions, operation-key idempotency, explicit initialization, conservative reopening, and no clock-based release. It records externally selected commit identities but does not create protection or perform retirement; that integration remains blocked and no removal operation is introduced. No model, parser, compiler of user projects, Git merge, or task execution is invoked by control transitions.

## Exact write set

Existing source: `src/store/task-store.ts` only to extract and re-export its unchanged atomic JSON primitive; `tsconfig.core.json` for new module discovery.
New source: `src/store/atomic-json.ts`, `src/store/coordination-store.ts`, `src/contracts/coordination-control.ts`, `src/coordination/control.ts`.
New evidence: `tests/core/coordination-control.test.mjs`, `tests/core/coordination-store.test.mjs`, `tests/fixtures/structural/coordination-reopen.mjs`, `tests/fixtures/structural/coordination-fixture.mjs`.
Documentation: `docs/coordination.md`; this plan's `plan.md`, `execution-ledger.md`, `issues.md`, `reports/implementation-map.md`, `reports/design-admission.md`, `reports/contracts-and-workflow.md`, `reports/implementation-evidence.md`; new `reports/f2-admission.md`, `reports/f2-verification.md`, `reports/f2-test-results.txt`, `reports/f2-typecheck.txt`, `reports/f2-source-integrity.json`.
The earlier F0/F1 code is read-only unless a reachable regression is recorded and the write set updated. Plan 2B is reference only and unchanged.

## Composed-design delta and dependencies

The control owner contains pure authorization/transition rules; the store contains durable read/publication/init/reopen. The shared atomic writer is moved intact, preserving its exported name from TaskStore for existing consumers. Domain construction is separate from the transport and native execution. New record decoding is the sole authority for these internal/persisted control values; a future wire projection must consume it rather than copy its rules. This avoids a new runtime dependency while implementing only owned product fields, not a standardized parser or schema dialect.

The store must be instantiated once per elected repository service under its existing mutation authority. It does not elect a second owner, add a lease, or claim unsupported cross-process writers. Real-file tests use this declared ordering; cold-process tests exercise reopen rather than unqualified concurrent ownership. The consumer-facing control owner exposes asynchronous methods and closes/drains its accepted operations. Private source paths are trusted state-root inputs, not agent-selected paths. Same-user malicious replacement is excluded, while unsafe on-disk types, symlinks, corruption, binding mismatch and missing initialized state are rejected.

## Gate

Pass strict compilation of the actual new import closure with the available toolchain, real filesystem publication/reopen tests, malformed-input and cross-owner cases, concurrent same-owner and competing claims, distinct stale generation/revision behavior, missing/corrupt store preservation, receipt replay after lost acknowledgment and handoff, private-note disclosure, and capacity behavior. Record the toolchain mismatch and absence of full repository/native/installed/independent review explicitly. End F2 as Implemented/locally verified only; final plan acceptance remains blocked.
