# Execution ledger

**Operation:** `verify`.
**Source baseline:** `6e61bd93e74686620f0cffc3e54bf00c8e5373f8`
**Date:** 2026-09-30

**Repair commit:** `e5d599e` (`Make Passeur frontend repository agnostic`)

## Implementation

- Added one installation-wide profile fallback with precedence: explicit path, canonical repository profile, supported legacy worktree/main-worktree profile, then `muse-bridge/default-profile.json`. Setup/configure selects the installation default unless the operator supplies an explicit profile path. Existing repository overrides remain untouched.
- Captured a frontend's launch intent and relevant environment at construction. Canonical Git identity and main-worktree discovery use the sterile Git wrapper so ambient `GIT_*` values cannot redirect them.
- Added read-only frontend binding resolution to status. The response separates launch inputs, resolved project/source view, canonical repository/common directory, state/store namespace and profile provenance from connected service generation/build.
- Preserved bounded diagnostic context from domain failures through service IPC, client errors/status, and MCP projections. Profile conflicts state both resolved and elected-service profile paths. Guarded service launch captures only strict, bounded diagnostic JSON from stderr and otherwise returns a safe fallback.
- The final diagnostic contract carries separate requested/elected profile path fields so either value remains visible when paths or messages are long. Startup stderr accepts a schema-valid UTF-8 failure line up to the aggregate 64 KiB bound. The service child receives the frontend's captured allowlisted environment; ambient secrets remain excluded.
- Kept canonical repository state, service discovery/election, descriptor, guard, socket and task/resource authority repository-scoped. No global current-repository cache, lock, router or service was introduced.
- Updated user setup, bridge skill and attached-tools recovery guidance for one global registration. Named registrations remain only in historical evidence and exact-name cleanup examples; runtime routing does not depend on them.

## Focused verification

Implementation checks completed:

- `npm run check` — passed.
- `npm run build` — passed.
- `npx tsc -p tsconfig.core.json` — passed.
- `npx tsc -p tsconfig.native.json` — passed on the final source.
- `git diff --check` — passed.
- `node --test tests/core/global-binding.test.mjs tests/core/service-attachment.test.mjs tests/core/service-bootstrap.test.mjs tests/core/runtime-owner.test.mjs tests/core/durable-lifecycle.test.mjs tests/core/coordination-elected.test.mjs` — 57/57 passed on the final candidate (sandbox escalation was required for local process/socket tests).
- `node --test tests/core/service-bootstrap.test.mjs tests/core/service-attachment.test.mjs` — 16/16 passed after the bootstrap diagnostic follow-up.
- `npx vitest run tests/integration/global-frontend.test.ts tests/integration/mcp-startup.test.ts tests/integration/service-attachment-recovery.test.ts tests/integration/registration-probe.test.ts tests/integration/agent-migration.test.ts` — 15/15 passed before the bootstrap follow-up.
- `npx vitest run tests/integration/global-frontend.test.ts tests/integration/service-attachment-recovery.test.ts tests/integration/mcp-startup.test.ts tests/integration/registration-probe.test.ts tests/integration/agent-migration.test.ts` — 16/16 passed before the final readiness-error projection regression was added (sandbox escalation was required for local process/socket tests).
- After that final readiness-error projection change, `npx vitest run tests/integration/registration-probe.test.ts` — 2/2 passed.

Disposable process tests exercise concurrent same-repository frontends, a linked worktree, an unrelated repository, repository-specific service generations, distinct frontend principals, denied cross-owner task control, independent service discovery, and accepted work completing after its submitting frontend disconnects. The full-suite outcome and limits are recorded below.

## Real Codex host qualification

The local host was Codex CLI `0.159.2`. A disposable Codex home/config contained exactly one unpinned `[mcp_servers.passeur]` registration invoking the candidate checkout's `dist/src/cli.js serve`; it had no `cwd`, `--project`, `--profile` or expected repository ID. No personal Codex config, credentials, account-backed session or inference turn was used.

One real `codex app-server` created four simultaneous ephemeral agent threads and invoked `passeur_status` and `passeur_prepare` through the configured MCP registration. Each host session launched an independent Passeur frontend process. Two sessions used repository A's main worktree, one used a linked worktree of A, and one used independent repository B. A's three sessions reported canonical repository ID `12178bb097df0a243a347a93` and service generation `74f2653e-2d5f-4a33-980c-b9a3fdae4efa`; their main/linked source views remained distinct. B reported repository ID `a934e8197a36350e86c7338d` and service generation `bcd3ecc1-b42f-49b8-8088-ececf326aca0`. All selected `profile_source=global`, and each frontend build identity matched its connected service runtime build identity. All temporary host configuration, repositories and processes were removed after observation.

The host run used the source development identity `development-unidentified`, rather than a packaged installed artifact. It demonstrates real host launch-context isolation and same/cross-repository service routing through the one registration; exact installed-artifact qualification is not claimed. The host app-server used OSS/local-provider selection and made no model turn. Codex's unauthenticated local-provider startup attempted a network connection that the sandbox denied; no account or credential was available to the process.

## Qualification limits and commit

- Full `env -u PASSEUR_RELAY_NETWORK_TEST -u PASSEUR_MUSE_INSTALLED_PROVIDER_TRANSPORT_TASK npm test` completed its core phase with 1,424/1,452 passed, five failed and 23 skipped, then stopped before native and full Vitest phases. The exact failures and proof boundary are in [verification](verification.md). The slow race cases were not repeated individually, per user direction.
- Independent read-only GPT-6.1 Sol High architecture/lifecycle review reports no unresolved P0/P1/P2 finding. Final 27-file source/test/docs candidate SHA-256: `30525febcfadb5a05ae9adc40ff520e8cbcde320435357d211896f8996a773b1`; tracked diff SHA-256: `c3fa53dab29716136acdb93f7426967f9b41a7d1474ade0c9c33c6dca36f3495`. The reviewer independently ran `git diff --check`.
- Repair commit `e5d599e` completed through the ordinary commit path after the staged diff passed `git diff --cached --check`. Unrelated user files remained unstaged. The final plan acceptance record is committed separately as documentation only.

## Independent architecture/lifecycle review

GPT-6.1 Sol High reviewed the final source/test/docs candidate read-only on branch `main`, baseline HEAD `6e61bd93e74686620f0cffc3e54bf00c8e5373f8`. Final candidate identity is the 27-file SHA-256 and tracked diff SHA-256 recorded above, using sorted repository-relative path, NUL, file bytes, NUL. The reviewer confirms this candidate hash remained unchanged through its final pass and approves the architecture with no unresolved P0/P1/P2 issue.

The review explicitly checked that per-frontend credentials, authenticated source-view membership, repository/store-scoped guard/socket paths, no mutation replay during attachment retry, service-owned accepted work, lazy runtime preparation, and guarded stale/dead recovery remain intact. It also recorded a qualification limit: accepted-task survival is tested against a separate service process after a frontend object's shutdown; separate frontend processes are independently tested for election, but process-exit and active task completion are not combined in a single fixture.
