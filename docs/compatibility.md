# Compatibility and verification record

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
