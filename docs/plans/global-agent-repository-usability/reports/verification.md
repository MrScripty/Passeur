# Verification and acceptance record

**Operation:** `verify`
**Candidate:** source/test/docs candidate reviewed on 2026-09-30
**Status:** scoped acceptance demonstrated; repository-wide suite has five failures outside the focused routing/diagnostic acceptance tests.

## Check results

- `npm run check` — passed on the final source, including the final readiness-error projection.
- `npm run build` — passed on the final source.
- `npx tsc -p tsconfig.core.json` — passed before the final `codex/probe.ts` projection-only change; `npm run check` after that change typechecks the complete TypeScript project.
- `npx tsc -p tsconfig.native.json` — passed on the final source.
- Focused core coverage — 57/57 passed: global profile precedence and launch snapshot, sterile Git identity, linked-worktree binding, task-owner isolation, stale attachment, bounded diagnostics, MCP projection, startup election, and service survival after frontend disconnect.
- Focused integration coverage — 16/16 passed for concurrent frontends, cross-repository separation, linked worktrees, restart/recovery, task survival/control, and MCP startup. The final registration readiness projection regression then passed 2/2.
- `git diff --check` — passed on the final candidate and independently repeated by the architecture reviewer.

The changed-path tests include real disposable service processes and Unix sockets. The normal sandbox denied those operations, so these focused process checks ran through the approved sandbox escalation with no network/provider test flags enabled.

## Full suite

The full command was:

```sh
env -u PASSEUR_RELAY_NETWORK_TEST -u PASSEUR_MUSE_INSTALLED_PROVIDER_TRANSPORT_TASK npm test
```

Its core phase completed with **1,424 passed, 5 failed, 23 skipped out of 1,452**. It stopped before the standalone native and full Vitest phases. Failures reported:

1. `tests/core/muse-credential-relay.test.mjs:28` — adapter staging omitted `core/protected-namespace.js` from its staged module closure.
2. `tests/core/peer-runtime-crash.test.mjs:45` — retained peer state was `dispatch_intent`, while the test expected `unknown` after a forced SIGKILL.
3. `tests/core/peer-runtime-evidence.test.mjs:924` — the artifact-eviction race did not observe the helper publication before its bounded wait expired.
4. `tests/core/peer-runtime-evidence.test.mjs:1162` — partial directed-enqueue extension did not consume every reserved slot.
5. `tests/core/peer-runtime-evidence.test.mjs:1167` — the late-worker race observed one final native receipt where the test expected three after two metadata conflicts.

These failures are in SDK adapter staging and peer task/evidence lifecycle tests, outside the functional frontend/profile routing and diagnostic projection paths. The only shared runtime change is retention of already-recorded diagnostic context on a later readiness failure; the adapter staging, peer delivery/settlement, and SIGKILL recovery logic were not changed. This run does **not** certify the full repository suite. The long race failures were not rerun individually; the user asked to avoid repeating the 50–70 second hold cases.

## Acceptance evidence

| Claim | Evidence | Result |
| --- | --- | --- |
| One global registration resolves arbitrary launch contexts | Real Codex CLI `0.159.2` app-server with one unpinned registration and four simultaneous sessions across two repositories | Demonstrated |
| Same repository shares one coordinator without sharing task control | Concurrent process integration plus distinct owner credentials and denied cross-owner control | Demonstrated |
| Independent repositories and linked worktrees remain correctly scoped | Real-host identities/generations and process integration across two repos plus linked worktree | Demonstrated |
| Frontend exit does not stop accepted service-owned work | Controlled worker held behind a release barrier, frontend shutdown, then completion observed through the service | Demonstrated |
| Missing/stale/dead/profile/build failures are diagnosable and recoverable through supported paths | Status/IPC/MCP projections, stale attachment and guarded-bootstrap tests; service startup remains owner of dead-descriptor election | Demonstrated within scoped tests |
| Human-confirmed task adoption remains separate from service discovery | Existing attach/owner regressions and same-repository independent owner test | Preserved |
| Old repository-named registrations are not required | Source contains no runtime registration-name routing; current operational docs require one `passeur` and exact safe cleanup only | Demonstrated |
| Independent architecture review | GPT-6.1 Sol High read-only final review; no unresolved P0/P1/P2 finding | Approved |

## Real-host boundary

The observed host was Codex CLI `0.159.2`, using one disposable configuration entry named `passeur` without fixed `cwd`, project or profile arguments. One app-server launched four independent Passeur frontends for four simultaneous host sessions: two on repository A's main worktree, one on its linked worktree, and one on unrelated repository B. The three A frontends reported one canonical repository ID/service generation and distinct main/linked source views; B reported a distinct repository ID/service generation. All selected the global profile source. No account, credential, inference turn or personal configuration was used.

This host evidence used the checkout's compiled development CLI, whose runtime identity is the non-unique `development-unidentified` sentinel. It proves actual host routing/session isolation, not installed immutable-artifact identity. The independent reviewer confirms this boundary. Reproducing that host protocol against a content-addressed installed candidate is outside the minimum user acceptance request and is not claimed.

The task-survival integration uses separate frontend objects against a separate service process; separate frontend processes are independently tested for concurrent election. A single fixture does not combine the submitting frontend process exiting with active task completion.
