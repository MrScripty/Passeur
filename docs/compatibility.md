# Shared-service lifecycle candidate — September 20, 2026

Status: **Verifying; acceptance blocked.** This candidate replaces connection-owned delegation with one Linux repository service and durable tasks. It requires explicit profile3 migration and the submit/wait/input/cancel/attach API. Legacy delegation tools reject new execution; historical results remain readable.

Executed: 42 selected controlled coordinator/runtime/registry tests; 40 native Node tests; selected native TypeScript5.8.3 compilation; source/test/script syntax checks. Full pinned5.9.3/MCP/Muse/Zod/Vitest application verification did not run. No native account, actual two-session Codex host, required-real permissions/continuation/descendants, installed artifact, external review or fresh-session skill qualification is implied.

Read [the complete implementation evidence](plans/shared-service-and-evidence-driven-lifecycle/reports/implementation-evidence.md), [installed acceptance](installed-acceptance.md), and [lifecycle contract](task-lifecycle.md). Muse native in-turn input variants and the exact pinned exit/fold API need qualification before their support can be claimed. Do not replace a functioning production install without completing these gates and controlled migration.

The preserved dependency pins are unchanged. The system runtime adds an explicit Linux/util-linux flock requirement; another platform needs a separately qualified equivalent, not silent fallback. Build/package version does not by itself identify a compatible service; compare the actual installed build and service protocol/generation.

## Historical candidate evidence (not acceptance for this change)

# Attached-tool registration correction — September 20, 2026

Baseline: `68c3e455ec35061c04b13a27d1ca9e438ec81f95`. This bounded correction adds explicit per-server `--required`/`--optional` registration, preserves existing startup and approval/denial policy during updates, and distinguishes written policy from host-reported policy and actual model-tool exposure. No task, profile, status, result, registry or resource schema changes; no package or lockfile change.

Evidence and exact limits: [attached-tool correction report](reports/attached-tool-registration-fix.md). The incident in Pumas-Library `d436ee6d09b07eafd2fe6ec259c4e3d9a648dbf5` remains operationally blocked until [the host recovery procedure](troubleshooting/attached-tools.md) records successful actual status calls for both named servers. Source changes and standalone test results do not close Pumas TIPC-I10, RA-07/RA-11, or the startup plan's installed-host claims.

---

# Registered-agent implementation candidate — September 20, 2026

Baseline: `49724a8b65bf7540622934e4f25cc3178f9c00dc`. New neutral execution/result v3, profile v2 and paged catalog v1; unchanged status/preparation and resource disposition versions. Existing Muse v2 tools and supported old profile/history reads remain explicit compatibility paths. The reserved Muse client identifier is `muse_bridge`.

Current evidence and unresolved native/pinned checks are in [the registered-agent implementation report](plans/registered-agents/reports/implementation-evidence.md). Codex is a Linux implementation-only, explicitly opted-in candidate, not an accepted compatibility promise. Native effective controls and actual account/provenance behavior are not established by controlled peer tests.

The records below are historical observations with their original limits. They are not success evidence for this new candidate.

---

# Compatibility and verification record

## Discoverable-startup source candidate — September 20, 2026

Source implementation and test sources are provided, but full pinned-dependency, real MCP, installed-artifact and actual Codex/Muse acceptance have not run in the preparation environment. The focused lifecycle/error checks passed with controlled dependency boundaries; they do not upgrade the historical observations below. See [implementation evidence](plans/discoverable-startup-and-installed-runtime/reports/implementation-evidence.md) and [installed acceptance](installed-acceptance.md).

Runtime pins remain MCP SDK 1.30.0, Muse SDK 1.3.0, proper-lockfile 4.1.2 and Zod 4.1.11. Grammar-aware configuration uses smol-toml 1.8.0; the pinned npm resolution, integrity and zero-advisory audit were verified during integration. A version pin or successful registration is not actual host/provider compatibility evidence.

## Parallel-worker implementation — September 20, 2026

Source baseline: `d726cab8e8e76abd3ab56a7937f784ebed4b66cb`.

| Surface | Evidence in the implementation container | Status |
| --- | --- | --- |
| Node | 22.16.0 | Executed locally |
| Git | 2.47.3 | Real disposable repositories, hooks, commits, worktrees, ancestry and retirement executed |
| TypeScript production core | Global TypeScript 5.8.3 with installed Node declarations; strict, exact optional properties, unchecked-index checks | Passed; not the full pinned 5.9.3 repository check |
| Core regressions | 53 Node tests against compiled production core and scripted workers | All passed |
| Adapter/approval control flow | Eight isolated probes with an injected client starter / elicitation server; real SDK bootstrap disabled in this test-only harness | All passed; not vendor SDK conformance |
| Changed TypeScript files | Parser/transpiler syntax diagnostics | Passed; syntax is not module resolution or SDK typechecking |
| Patch helper | Seven synthetic-repository checks plus repeatable skill installation | Passed; not application to a downloaded full baseline checkout |
| Complete pinned dependency installation | Container DNS cannot resolve GitHub or npm | Not run |
| Full npm run check / npm test / npm run build | Requires missing pinned packages and complete baseline checkout | Not run here; required after application |
| Real MCP transport test | Added Vitest test using SDK Client and linked transports | Added but not executed here |
| Installed Codex / Muse inference | No account credentials or live CLI run used | Not run |
| Actual parallel subscription sessions | Must be checked with the real account and CLI pair | Pending |
| Human approvals, signing/hooks permissions and sandbox enforcement | Fake fixtures do not establish installed behavior | Pending |
| Abrupt parent loss and actual runtime descendants | Process-level live acceptance remains necessary | Pending |

Dependency versions remain unchanged: Muse SDK 1.3.0, MCP SDK 1.30.0, proper-lockfile 4.1.2, Zod 4.1.11, and the original development dependencies. These pins describe the target, not installed packages in this container.

The core tests cover overlapping independent workers, queue/capacity, duplicate cancellation ownership, absolute deadlines, shutdown during admission, persistence uncertainty, ordinary hooks and committed delivery, missing/uncommitted/no-change cases, partial results, deletion/rename/filename artifacts, explicit dispositions, sibling-safe retirement, archive protection, receipt recovery, read-only history, legacy import, response bounds and UTF-8 paging. No project test runner or integration gate is added to Passeur.

## Earlier local observations retained as historical evidence

The previous implementation record reported Node 24.12.0, Codex 0.155.1 and Muse CLI 1.3.0 (`1.3.0-R3401.1`) on its author's machine. It explicitly did not run live billable inference. Those values were not re-observed in this container and do not prove this update's installed compatibility.

## Required next acceptance

After applying the patch, install the unchanged pins and run typecheck, complete tests and build. Then use the disposable opt-in parallel probe and the real Codex interface to establish same-call waiting, independent sessions, actual requested model, subscription credential provenance, human approval decisions, linked-worktree hook/commit/signing permissions and process-tree cleanup. Record exact versions, evidence locations and known limits. Do not mark the objective Accepted until the named evidence exists.
