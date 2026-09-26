# Execution ledger

## September 25, 2026 — M4-S1 clean-candidate full acceptance run

Operation: `verify`. Candidate: clean detached worktree at `c80fc68`, Node `v24.12.0`, Linux/local disposable paths only. The shared checkout's concurrent structural/reporting changes were not included, staged or committed by this run.

The complete `npm test` command passed with exit code 0: build succeeded, the full core suite passed **640/640**, the full native suite passed **192/192**, and Vitest passed **146 tests in 40 files** with **6 documented skips**. The run used the already provisioned dependency tree and did not install packages or access a live account. Real-process acceptance evidence also includes the previously recorded installed/parallel/recovery probes plus the escalated local IPC runs: structural capacity/startup **6/6**, coordination submission **1/1**, and crash-frontier continuation **7/7**.

This closes the previously unresolved broad Vitest result for this clean candidate. It does not close the plan's pinned dependency, live Codex/Muse host, native input/settlement, accepted active-work recovery, fresh-session skill, or independent external-review gates. The plan remains `Verifying` with acceptance `blocked` and next slice `M4-S1`.

## September 25, 2026 — M4-S1 installed and real-process continuation

Operation: `verify`. Candidate: clean detached worktree at `22cde5e`, installed build `7be9f78ad72de63fa9214175eca3747acefa1d5cbcd6fc60920485a62109cf08`, Node `v24.12.0`, Linux/glibc disposable paths only. No personal registration, profile, state root or user repository was changed.

Built the candidate with `npm run build:runtime` from already provisioned dependencies; the builder performed no package installation. Installed it into `/tmp/passeur-installed-22cde5e/<build_id>` after manifest, dependency-closure, compiled-byte and native parser inventory validation. The real `scripts/probe-service.ts` then started two installed front ends against one disposable Git fixture and state root: both reported `mode: installed`, the same build and service generation, `clients: 2`, and held coordination authority; after one client closed, the remaining client stayed connected. A second fresh installed pair started a new service generation against the same state after the first probe exited.

A separate disposable installed probe killed the elected service PID `873847` with `SIGKILL`, closed the old client, and attached a fresh installed client to the same state namespace. The replacement reported a different service generation, the same installed build, `mode: installed`, and coordination authority `held`. This proves the service-death/lease-recovery path for an empty prepared repository namespace; it does not prove recovery of active native work.

Targeted installed integration files passed **6/6**: `installed-runtime.test.ts`, `mcp-startup.test.ts`, and `registration-probe.test.ts`. Targeted real-process, parallel-client and durable-recovery integration files passed **16/16**: `mcp-startup.test.ts`, `parallel-mcp.test.ts`, `coordination-process-crash.test.ts`, `coordination-linkage-crash.test.ts`, and `recovery.test.ts`. The earlier full source/native suites remain recorded as 640/640 core and 192/192 native.

Limits: the probes use preparation and status only (`inference: not_run`, `actual_codex_attachment: not_run`); no live Codex/Muse account, host elicitation, provider input, native descendant, accepted task, Git delivery, or active-work service crash was exercised. The broad Vitest runner still has a silent open-worker issue and is not claimed green. After confirming no probe service remained, the disposable worktree, candidate, installation, fixture, profile and state paths were removed. Preserve the plan's blocked status until the required provider, fresh-session skill and host evidence is obtained.

## September 25, 2026 — M4-S1 source verification and recovery repair

Operation: `verify`. Candidate base: `b31c4fd` plus the bounded working-tree overlay. Plan status remains `Verifying`; acceptance remains `blocked`; the next slice remains M4-S1 because installed-runtime, pinned-dependency and host/native qualification are still open.

The source candidate repaired repository-service recovery for sequential and simultaneous compatible front ends. The repository lease now publishes protected owner evidence beside the lock directory so proper-lockfile heartbeats retain their invariant; reclaim requires a strict versioned record, matching lock device/inode and a process-birth observation proving the owner exited. Unknown, malformed, mismatched, legacy or live evidence still returns `PROJECT_IN_USE`. The service launcher reserves flock exit code 75 for election contention, so an elected child exit is reported as startup failure. Attachment retries descriptor/connection/handshake observation failures only before dispatch, and successful status observations clear stale frontend failure state. D14 was amended to record the evidence-qualified compatibility-lease exception.

Material write set: `docs/plans/shared-service-and-evidence-driven-lifecycle/plan.md`, this ledger, `issues.md`, `reports/admission.md`, `src/core/lease.ts`, new `src/core/process-identity.ts`, `src/service/bootstrap.ts`, `src/service/client.ts`, `src/service/process.ts`, `tests/core/coordination-authenticated.test.mjs`, new `tests/core/lease-recovery.test.mjs`, new `tests/core/service-attachment.test.mjs`, new `tests/core/service-bootstrap.test.mjs`, and `tests/native/shared-service.test.mjs`. The unrelated untracked `Passeur_Structural_Review_Fixes.zip` and `docs/plans/Passeur_Concurrent_Change_Coordination_Plan.md` remained outside the write set.

Evidence: `npm run check` passed; the focused TypeScript core/native compiles passed; the combined sequential suite passed **88/88** with `node --test --test-concurrency=1` across lease recovery, bootstrap, attachment, runtime-owner, coordination recovery/election/IPC and native shared-service cases. The suite includes a real 10.5-second production heartbeat, dead-owner recovery, strict malformed evidence cases, competing launchers, elected exit code 1, transient attachment replacement, post-dispatch no-replay and status-failure recovery. The repository `npm test` command also completed its build, full core suite (**640/640**) and full native suite (**192/192**); its final Vitest runner remained silent with an open worker and was interrupted after inspection, so the overall command is not claimed green. Astra high and Sol xhigh read-only reviews found no remaining blockers after repair; neither reviewer edited or committed.

Limits: these are source and local Linux process/IPC checks. They do not establish pinned installed artifacts, a fresh host session, actual Codex/Muse native input/settlement behavior, or transparent failover of uncertain native work. Automatic recovery is limited to the exact evidence-qualified compatibility lease; legacy lock records still require explicit reconciliation. No acceptance claim is promoted from this entry alone.

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
