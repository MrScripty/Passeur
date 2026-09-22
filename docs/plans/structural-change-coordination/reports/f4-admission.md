# F4 admission — service-owned metadata session and closed request contract

Date: September 22, 2026. Baseline: `81b7a2a308f6fe546b4a0b9e118180936e0360a2`.
Canonical plan: `docs/plans/structural-change-coordination/plan.md`.

The maintainer committed F3 and explicitly requested continuation. This bounded
re-plan resumes independent Plan 2A work with operation `continue` after an
owned Blocked-to-Active transition; parser and installed acceptance are not
waived. The service-facing boundary is the next independently verifiable part
of M1/M4. Code drafts are admitted only within the write set below before they
become part of the delivered candidate.

## Decision and constraints

Implement one service-owned session that composes the existing source gate,
control owner and durable store. It provides explicit initialization through a
required authorization callback, complete versioned request/reply decoding,
current-authority reads, digest-bound UTF-8 pages, separate request capacity
for release/recovery, lazy source binding and observed drain/shutdown. Existing
Git, coordination persistence and task meanings remain unchanged. Native
parsing is still unavailable: the environment has no tree-sitter module and
registry access fails DNS. No parser surrogate is admitted.

This increment deliberately leaves `RepositoryRuntime`, `server.ts`,
`client.ts`, `cli.ts` and MCP registration unchanged. Their pinned dependency
closure is unavailable here and their authenticated composition, existing
request limits, resource authority and graceful shutdown need a separately
verified integration boundary. The new implementation is not registered or
advertised as an available public capability. Tests prove its actual selected
service-to-Git/control/store path with explicitly supplied fixture principals
and authorization; they do not prove host authentication or service election.

## Exact write set

New production: `src/contracts/coordination-service.ts`,
`src/service/coordination.ts`.
Existing production: `src/contracts/coordination-control.ts` only to expose the
existing receipt decoder to its independently consumed service projection;
`src/coordination/bound-control.ts` and `src/coordination/control.ts` only for
necessary, regression-backed lifecycle/capacity findings at this boundary;
`tsconfig.core.json` for the actual import root.
New tests: `tests/core/coordination-service.test.mjs`,
`tests/core/coordination-service-contract.test.mjs`,
`tests/core/coordination-service-ipc.test.mjs`,
`tests/fixtures/structural/service-fixture.mjs`,
`tests/fixtures/structural/service-reopen.mjs` and
`tests/fixtures/structural/service-peer.mjs` if required for the selected real
transport/reopen claims. Existing fixture changes are confined to these
fixtures and `tests/fixtures/structural/repository-fixture.mjs` if needed.
Documentation: `docs/coordination.md`; the current plan, ledger and issues;
its contracts/workflow, implementation-map, design-admission and
implementation-evidence reports; new f4 admission, verification, review,
source-integrity, test/typecheck/resource/environment evidence.
The original transport may be read and exercised without modification.
Plan 2B stays unselected and byte-for-byte unchanged.

## Standards and verification

Apply the adopted Core/Router, Planning, Implementation, Verification and its
independent-oracle details, Development Proportionality, Commit/Documentation,
Architecture/Code Design, Contracts/Protocol/Evolution, Concurrency,
Security, Persistence, IPC and TypeScript/Async owners. No new dependency,
compiler analysis, user configuration, runtime install or remote write is
part of this increment. Boundary decoders are complete in both directions and
check cross-field operation/subject/actor/range relations.

Use real Git and coordination files, concurrent principals, independent
literal reply cases, malformed variants, unauthorized initialization, lost
observers, interrupted writes, lazy source failure, sharing revocation between
pages, long UTF-8 views, saturation, drain races and fresh-process reopening.
Record compiler/runtime versions and supporting type-check scope. A fixture
callback is not real operator consent, task resource admission or election.
The finish condition is selected source/test closure and an explicit record of
incomplete production consumers, not an expanded series of unrelated probes.
