# Implementation admission and bounded owner inventory

User invocation: implement the supplied canonical `docs/plans/shared-service-and-evidence-driven-lifecycle/plan.md`; operation `start`. Source and standards revisions match the plan. Reconstructed affected-file overlay; no clean full clone was available. The package helper verifies exact original Git bytes before application.

| Family | Canonical owners | Disposition |
| --- | --- | --- |
| Service election/lifetime | service/bootstrap, process, server; existing repository-runtime and lease | New guarded local process + existing lease, no alternate namespace or competing task owner; real native guard tests passed, composed service qualification blocked |
| Frontend and public operations | service/client, mcp/server, contracts/service/tasks | Submit/wait/explicit control replaces pending-delegate lifetime; full SDK/host contract gates blocked |
| Durable task/control | coordinator, task-control, input-broker, TaskStore, record-codecs | One publication/control authority, lost acknowledgment and cancellation/input races covered by controlled tests; real codecs/reopening tests supplied, not run |
| Native lifecycle | Muse adapter; Codex adapter/protocol/transport; agents/types/report | Existing whole-assignment interface with correlated events/input; no timer heuristic; actual pinned APIs and Muse native in-turn input coverage remain qualification work |
| Git delivery/resources | workspace/project/worktree; existing disposition/cleanup | Remove default task-owned Git timeout; preserve ordinary hooks, ancestry and retirement safeguards; real synthetic Git tests passed |
| Profiles/install/registration | existing profile/edit/install, CLI, codex config/probe | Explicit profile3/API migration, exact installed identity, startup-policy preservation; source tests/probes updated, full artifact gate blocked |
| Guidance and acceptance | docs, both skills, plan/ledger/issues | Current owner links and evidence limits supplied; fresh skill session/external review blocked |

No dependencies or CI provider were added. System flock is an explicitly selected Linux runtime requirement, not a downloaded library. TypeScript strict settings are preserved. Core/Router and the supplied plan's routed canonical workflow, architecture, contracts, security, concurrency, persistence, IPC, language, build/launcher and evidence owners govern this work. No frontend/native-FFI/Rust profile is selected from this TypeScript-local change.

Actual additional write paths from the admitted implementation remain: src/service/process.ts and src/agents/report-format.ts; tests/core/durable-lifecycle.test.mjs; tests/native/shared-service.test.mjs and lifetime-observations.test.mjs; tests/integration/durable-store.test.ts and existing startup/probe consumers. Existing docs/agents/codex.md is the actual native documentation owner, not the plan's proposed docs/adapters path. Test placement follows existing runners instead of creating an extra harness.

The September 25 verification overlay adds this exact bounded set: docs/plans/shared-service-and-evidence-driven-lifecycle/plan.md, execution-ledger.md, issues.md, this report, src/core/lease.ts, src/core/process-identity.ts, src/service/bootstrap.ts, src/service/client.ts, src/service/process.ts, tests/core/coordination-authenticated.test.mjs, tests/core/lease-recovery.test.mjs, tests/core/service-attachment.test.mjs, tests/core/service-bootstrap.test.mjs, and tests/native/shared-service.test.mjs. It preserves the unrelated untracked archive and concurrent coordination plan. The overlay adds no dependencies, configuration, credentials, external services or alternate task owner.

Default development outcome was implement for reversible source changes; missing native/pinned facts block their claims rather than widening investigation or inventing fallback APIs. The source can be reviewed/applied independently, but ordinary production rollout is not admitted until the required qualification passes.
