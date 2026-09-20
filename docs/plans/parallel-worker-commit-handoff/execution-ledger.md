# Execution ledger

## 2026-09-20 — Source implementation and isolated verification

Baseline: `d726cab8e8e76abd3ab56a7937f784ebed4b66cb`. Delivery selected by the user: local changed-file ZIP, with no GitHub writes.

Implemented M1 committed Git handoff, M2 independent bounded concurrency/batching, M3 explicit retirement/retention/archive records, and M4 source-facing setup/skills/diagnostics and live-probe entry point. No delegated-project testing engine, merge operation, PR creator or repair loop was introduced.

The existing lifecycle regression obligations were migrated into the core Node suite and version-2 Vitest tests, rather than treating old version-1 behavior as current. Missing ignored-artifact disposal authority remains an explicit retention/refusal case. Legacy tasks stay readable/unclassified; they are not silently granted retirement authority.

Local evidence: strict production-core TypeScript compilation with TypeScript 5.8.3 and Node types; 53 Node core tests against actual compiled production modules, injected workers and disposable Git repositories passed. The actual dependency pins remain TypeScript 5.9.3 and the existing vendor SDKs. See docs/compatibility.md and the ZIP verification report for the exact scope.

Full npm install, repository-wide pinned typecheck/build/Vitest, actual MCP transport tests and live Codex/Muse execution are not established in this container. GitHub/npm DNS access is unavailable. No replacement vendor SDK or runtime shim is delivered as product code.

All temporary core test repositories/worktrees are created under disposable fixture roots and removed by test teardown. No remote refs were created. The delivered code changes are not committed in the user's repository.

Next: install the pinned dependencies, run check/test/build, then perform the disposable installed-runtime acceptance cases. Objective acceptance remains pending.

A directly affected installation fix copies the skill directory contents idempotently, so reinstalling actually updates the version-2 guidance instead of creating a nested stale copy. Seven synthetic installer tests and a repeated skill-install check passed. Eight injected adapter/approval control-flow probes also passed; vendor bootstrap was disabled only in that isolated verification harness.
