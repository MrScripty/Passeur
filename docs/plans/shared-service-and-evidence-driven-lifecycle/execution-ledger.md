# Execution ledger

## September 20, 2026 — Plan prepared

Operation: planning only. Plan state: `Planned`; next integration slice: M0-S1.

Examined Passeur main `18c8eb9593c5f9e9faae48314ddc136ba366e109` and Coding-Standards main `366c1d90a24bbfb50973f62b155a5f3396c0f107`. The maintainer reports current end-to-end production operation, lock/reconnect friction and premature time-limit failures. Those observations establish requirements; this planning session did not reproduce the live incidents.

The plan supersedes connection-owned repository lifetime, request-owned task cancellation, absolute task/approval timeouts and mandatory same-call waiting for the new implementation. It preserves canonical coordination/state, registered adapters, Git delivery and protected resource disposition. It also accounts for the Git helper's existing ninety-second default cancellation path.

Prepared a five-milestone implementation sequence (M0–M4), fourteen acceptance claims, sixteen scenario families, the full composed-design review, and requirements for updating both existing agent skills. The proposed Linux service guard and installed-host/native behavior require actual qualification in M0/implementation; no successful probe is claimed here.

No Passeur production source, repository branch, GitHub state, user configuration, credentials, live agents or worktrees were changed. No code compilation, application test, installed-host test, external code review or live inference was performed. Local package checks establish only Markdown reference/structure and ZIP consistency.

Material implementation entries should record the operation and candidate, coherent write set, decisions/deviations, focused evidence and its limits, current acceptance/next-slice changes, findings disposition and actual commit/resource facts. Do not create a ledger entry merely because another commit was made.

## September 20, 2026 — Source implementation and partial verification

Admitted `start` at the supplied canonical plan path, then implemented the actual shared-service/durable lifecycle owners. M0–M3 source changes are supplied; current phase M4, status Verifying, overall acceptance blocked, next integration slice M4-S1. Material fixes during verification included cancellation/settlement serialization, private control scoping, bounded batch receipts, native input lifetime cleanup, known background-item settlement, inherited-pipe/parent-exit handling and preservation of unknown answer delivery after crash.

Executed 42 selected controlled coordinator/runtime/registry tests and 40 native socket/process/guard/transport/timing tests. Seven native module roots compiled with available TypeScript5.8.3. Syntax checks passed for 50 source, 24 available test and 5 script files. Full pinned dependencies/typecheck/application tests could not run because network/package access was unavailable. The complete evidence and limitations are in reports/implementation-evidence.md; command logs are retained there.

Updated actual owner/write-set placement, native/usage skills and explicit migration. No ordinary production capability is accepted from these tests. Added dependency-backed store, multi-client and native fixtures remain unexecuted. Native Muse in-turn input variants/pinned SDK, live Codex/Muse, host permission/Stop, installed artifacts, fresh-session skill use and external review remain blocked. No user repository commit or remote mutation was made; the reviewed outcome is a source overlay with exact-byte application guards. Synthetic test repository commits are not production commit evidence.
