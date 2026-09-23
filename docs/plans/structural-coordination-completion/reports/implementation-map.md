# Exact implementation ownership

The lead owns shared schemas, task admission, metadata migration, package/lock changes, public catalogs, runtime composition and current plan state. Paths below are permitted owners, not instructions to create a class or file for every noun. Confirm placement against the receiving checkout during R0. Reuse existing implementations; add only the named missing responsibility. Record directly affected additional files before editing and re-plan only for material scope/authority/evidence changes.

## Active R1 `continue` write reservations — September 22, 2026

The current checkout has uncommitted R0/R1 material. These reservations prevent agents working in the shared checkout from changing the same files concurrently. The lead reviews and integrates every handoff. They do not advance the plan phase or accept any SC claim.

| Owner | Exclusive writes in this wave | Boundary |
|---|---|---|
| Sol medium R1 extraction | `src/observation/native-extraction.ts`, `tests/native/structural-native-functions.test.mjs`, optional Rust/TypeScript language fixtures | Real native Rust/TypeScript/TSX syntax and conservative masks; no shared model/catalog/public edits. |
| Sol medium R1 helper | `src/observation/helper.ts`, `helper-main.ts`, `helper-protocol.ts`, their two dedicated native tests | Child lifecycle and bounded protocol; never coding-worker controls. |
| Sol medium R1 source inventory | New `src/observation/source-inventory.ts` and `tests/core/structural-source-inventory.test.mjs` | Bounded exact-file/subtree enumeration from input commit and working tree; no runtime edits. |
| Sol medium R1 public runtime | `src/core/repository-runtime.ts`, `tests/core/structural-runtime.test.mjs`, `structural-public.test.mjs`, `coordination-managed-runtime.test.mjs` | Integrates inventory, current authorization and pre-capture capacity; no protocol/schema edits. |
| Sol medium R1 durable authority evidence | New `tests/core/structural-managed-store.test.mjs` and, only if coordinated, its own fixture | Actual TaskStore/adoption/source revocation evidence; no production edits. |
| Sol medium artifact integrity | `src/install/runtime.ts`, `src/contracts/runtime.ts`, new installation integration test | Hash production native closure and validate installed selection; no package/lock edits. |
| Sol medium public projections | New `tests/integration/structural-cli-mcp.test.ts` only | Exercise actual CLI and MCP routes through elected service and real native report/detail; report production gaps to lead. |
| Sol medium capture boundary | `src/observation/source.ts`, new `tests/core/structural-capture-boundary.test.mjs` only | Refuse nested Git/submodule crossing at capture time after inventory, with real Git evidence. |
| Lead | Shared contracts/model/catalog/CLI/MCP/service, package/lock, plan/evidence inventory, cross-lane integration and acceptance | One writer for shared changes after reviewing explicit interface requests. |

An Astra high planner, Luna high document scout and Sol xhigh architecture/security/lifecycle reviewer are read-only. The lead orchestrates directly. The final Astra high review is reserved for the exact final candidate at R6. R2/R3 shared-contract parallel expansion waits for the R1 gate in [the plan](../plan.md#3-milestones-and-gates).

All slices may update this plan directory's current plan, ledger, issues and their own reports. Historical F0–F9 reports remain immutable evidence except for an attributed correction/addendum at their owning source.

## Active R2/R3 `continue` write reservations — September 22, 2026

R1-S1 is committed as `7632a2e`; its gate evidence is recorded in the ledger. The plan remains Active and selects R2-S1 as the next integration slice. C5 permits disjoint R3 admission substrate work concurrently after R1, but its public/control integration remains with the lead until interfaces stabilize. All SC claims remain pending.

| Owner | Exclusive writes in this wave | Boundary |
|---|---|
| Sol medium R2 framework and Python/Lua | `src/observation/native-extraction.ts`, new `language-common.ts`, new `language-python-lua.ts`, unique Python/Lua native test and fixture directories | Establish reusable native extractor interface while preserving Rust/TS; no catalog/helper/public edits. |
| Sol medium R2 JS/React/Svelte | New `language-js-react-svelte.ts`, unique native test and `javascript`, `react`, `svelte5` fixture directories | Consume common native context; no shared catalog/helper/public edits; prove embedded ranges rather than wrapping invisible text. |
| Sol medium R2 Kotlin/Zig/Odin | New `language-kotlin-zig-odin.ts`, unique native test and `kotlin`, `zig`, `odin` fixture directories | Consume common native context; no shared catalog/helper/public edits. |
| Sol medium R2 C/C++/C# | New `language-c-family.ts`, unique native test and `c`, `cpp`, `csharp` fixture directories | Consume common native context; no shared catalog/helper/public edits; no preprocessing. |
| Sol medium R2 Rust/TypeScript oracles and narrow recovery | Existing `tests/native/structural-native-functions.test.mjs`, `rust` and `typescript` fixture directories; after framework handoff, `src/observation/native-extraction.ts` | Expand L01/L02 cases and map conservative TS incomplete-header recovery and Rust 2024 foreign module AST once pinned grammar supports it. No other family/catalog edits. |
| Sol medium R2 grammar qualification and repair | `package.json`, `package-lock.json`, `src/observation/native-parser.ts`, `src/install/runtime.ts`, `scripts/build-runtime.ts` if needed, new `vendor/native-grammars/**`, unique grammar tests, native dependency qualification report | First probed exact upstream sources read-only in `/tmp`; now owns reproducible pinned native upgrades/patch and full artifact identity. Delay shared dependency install until family test owners release the environment. |
| Sol medium R3 backend admission | `src/contracts/tasks.ts`, `src/core/coordinator.ts`, `src/store/task-store.ts`, `src/store/record-codecs.ts`, optional new `src/store/announcement-store.ts`, unique linkage/announcement core tests | Durable private payload and exact task linkage before native eligibility; public/metadata integration returns to lead. |
| Sol medium R3 metadata gate | `src/contracts/coordination-control.ts`, `src/coordination/control.ts`, `src/coordination/bound-control.ts`, optional `src/store/coordination-store.ts`, unique gated-preflight core test | Metadata bind under canonical ordering precedes TaskStore admission; exact settlement follows admission; no backend/public edits. |
| Sol medium R3 public integration | `src/core/repository-runtime.ts`, `src/contracts/service.ts`, `src/service/server.ts`, `src/cli.ts`, `src/mcp/server.ts`, `src/codex/config.ts`, unique new coordinated submission public tests | Compose exact reserve → metadata bind → TaskStore admission → metadata settle → native eligibility, while preserving legacy operations. Lead released these shared public paths after R2 routing changes. |
| Lead | Shared catalog/helper/public/service/metadata, compiler/package inputs, plan/evidence and integration | Wire R2 families only after interface handoff; own cross-slice contract decisions and acceptance. |

Independent, bounded SC06/SC16 hardening has also been assigned without advancing the current R2-S1 plan phase:

| Owner | Exclusive writes | Boundary |
|---|---|---|
| Sol medium mount boundary | `src/observation/source.ts`, `source-inventory.ts`, unique mount-boundary core test | Refuse Linux bind mount crossings within declared source; preserve root mount support and Git/no-follow proof. |
| Sol medium resource bounds | `src/observation/helper.ts`, unique native resource test, representative benchmark script/workload | Fixed child RSS overload outcome and measurement; never signal coding workers or build an adaptive scheduler. |

The Sol xhigh reviewer and Astra high planner remain read-only. New families receive disjoint paths after the common interface is established. No reviewer edits source.

## R4 preparatory write reservations under Active `continue`

R2-S1 remains the selected integration slice. These R4 components are admitted disjoint preparation; their source and focused checks do not advance SC07, SC08, SC10, SC12, or SC16.

| Owner | Exclusive writes | Boundary |
|---|---|---|
| Sol medium monitor | New `src/observation/monitor.ts`, unique native monitor tests | One service-wide bounded watcher/inventory/analysis owner with generation-safe invalidation. |
| Sol medium observation store | New `src/contracts/observation.ts`, `src/store/observation-store.ts`, unique core store/notice tests | Durable artifacts, recipient cursors, authority rechecks, bounded retention. |
| Sol medium source grants | `src/contracts/coordination-control.ts`, `src/coordination/control.ts`, `bound-control.ts`, `src/service/coordination.ts`, unique grant tests | Explicit current-owner report/detail grants, metadata schema evolution and revocation. No public runtime writes. |
| Sol medium public observation integration | `src/core/repository-runtime.ts`, `src/contracts/service.ts`, `src/service/server.ts`, `src/cli.ts`, `src/mcp/server.ts`, `src/codex/config.ts`, unique integration tests | Compose monitor, helper, store, grants, public notice/read operations and lifecycle hooks. No metadata writes. |
| Lead | `src/service/request-capacity.ts`, compiler inputs, docs and integrated acceptance | Notice pull/ack use the control lane; observation analysis stays bounded separately. |

The R4 store owner also owns `listCurrent`, `notifyExisting`, generation-bound retained evidence, and authorized per-path cursor gaps in `src/store/observation-store.ts` and `src/contracts/observation.ts`. The Sol medium correspondence owner added `src/observation/correspondence.ts` and its unique core test; runtime composition remains with the public integration owner. The public acceptance owner writes only `tests/integration/structural-notifications.test.ts` and `structural-sharing.test.ts`. A Sol xhigh reviewer examines these paths read-only.

## R5 preparatory write reservations under Active `continue`

R5 preparation does not select or verify an installed candidate until R2/R3/R4 source freezes and the identified build is clean.

| Owner | Exclusive writes | Boundary |
|---|---|---|
| Sol medium installed acceptance | `scripts/probe-structural.ts`, `tests/integration/structural-installation.test.ts` | Real relocated CLI/MCP language route probe, native tamper, separate network/build-source isolation; final clean candidate held by lead. |
| Sol medium migration evidence | `tests/integration/structural-migration.test.ts`, `tests/fixtures/structural/compatibility/**` | Historical metadata/task/result reopen and rejection; no production migration mutation. |
| Sol medium doctor capability | `src/diagnostics/doctor.ts`, unique doctor integration test | Lazy explicit installed native readiness; no discovery prerequisite. |
| Sol medium cutover acceptance | Unique structural-cutover integration/probe files | Actual older-reader/incompatible cutover and disposable publication-failure evidence. |
| Sol medium docs and bridge skill | `docs/structural-reporting.md`, `coordination.md`, `shared-service.md`, `compatibility.md`, `recovery.md`, repository `.agents/skills/passeur-bridge/SKILL.md` | Public candidate guidance; lead applied the skill file through the host-writable mount after reviewing the exact patch. |

## R0-S1 — adoption and environment

**Documentation writes:** this plan directory; the status/remaining-authority sections only of `docs/plans/structural-change-coordination/plan.md`, its `execution-ledger.md` and `issues.md`; `AGENTS.md` only if its actual plan routing must change. The independent shared-service plan is read-only unless an affected authoritative decision genuinely conflicts; record and obtain a bounded reconciliation decision rather than copying its policy.

**Read before source edits:** current `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.core.json`, `tsconfig.native.json`, `vitest.config.ts`; `src/observation/model.ts`, `source.ts`, `match.ts`, `report.ts`; `src/coordination/control.ts`, `bound-control.ts`, `repository.ts`, `notices.ts`; `src/core/managed-coordination.ts`, `coordination-resources.ts`, `repository-runtime.ts`, `coordinator.ts`, `task-control.ts`, `disposition.ts`; `src/store/task-store.ts`, `record-codecs.ts`, `coordination-store.ts`; current service/public consumers and F9 tests.

**Evidence outputs:** `reports/receiving-environment.md`, `reports/baseline-checks.md`, `reports/claim-status.md`. These are produced by the receiving lead, not fabricated in this handoff. Confirm real package and installed artifacts rather than treating a lockfile entry as load/build satisfaction. Production remains unchanged during intake.

## R1-S1 — native Rust/TypeScript vertical report

**Existing production owners:** `src/observation/model.ts`, `source.ts`, `match.ts`, `report.ts`; `src/core/repository-runtime.ts`; `src/service/client.ts`, `server.ts`; `src/contracts/service.ts`, `runtime.ts`, `coordination-service.ts`; `src/mcp/server.ts`, `coordination.ts`, `coordination-operations.ts`; `src/cli.ts`, `src/cli/coordination.ts`; `src/codex/config.ts`; `src/install/runtime.ts`; `scripts/build-runtime.ts`; package/lock/compiler inputs as required by actual imports and native dependencies.

**Prospective narrow production paths:** `src/observation/languages.ts`, `protocol.ts`, `helper.ts`, `helper-main.ts`, `ranges.ts`; `src/observation/extractors/rust.ts`, `typescript.ts`; `src/observation/queries/rust.scm`, `typescript.scm`; `src/store/observation-store.ts`; `src/contracts/observation.ts`; `scripts/build-parsers.ts`; `parsers/manifest.json` (fully populated accepted identities, not placeholder output). The manifest owns parser build/package facts only. Source annotations do not justify a new general schema generator.

**Evidence paths:** `tests/core/structural-protocol.test.mjs`, `structural-ranges.test.mjs`, `structural-native.test.mjs`, `structural-report-access.test.mjs`; `tests/native/structural-helper.test.mjs`; `tests/integration/structural-public.test.ts`; language fixture stems under `tests/fixtures/structural/languages/`. Reuse existing source, managed-store and SDK fixtures; a new test peer remains test-only. Register every compiled root/import and runner pattern.

**Durable docs:** `docs/structural-reporting.md`, `docs/coordination.md`, `docs/compatibility.md`; current usage-skill references where the new report is taught. Update actual named-tool registration and shell routing only for implemented callable operations.

## R2-S1 — all-language extraction

**Per-language primary paths:** `src/observation/extractors/<stem>.ts`, `src/observation/queries/<stem>.scm`, and `tests/fixtures/structural/languages/<stem>/` for exactly `rust`, `typescript`, `javascript`, `python`, `lua`, `kotlin`, `zig`, `csharp`, `c`, `cpp`, `odin`, `svelte5`, `react`. Share JS/TS primitives within their owning extractor family when the semantics are identical; preserve dialect routing.

**Lead-only paths:** language catalog, range/protocol/model shared contracts, parser manifest/build files, dependency locks, runtime packaging, existing structural test entrypoints and the support table in `docs/structural-reporting.md`. Additional native binding inputs are named individually during R1 package qualification; never authorize arbitrary third-party parser loading.

**Evidence:** extend the real native/language suite and add `tests/core/structural-embedding.test.mjs`. Handwritten source/expectations are reviewed per row. No worker edits another language's expectations just to accommodate a shared extractor change without that row's review.

## R3-S1 — automatic admission/linkage

**Production owners:** `src/contracts/tasks.ts`, `coordination-control.ts`, `coordination-service.ts`, `service.ts`; `src/core/coordinator.ts`, `repository-runtime.ts`, `task-control.ts`, `managed-coordination.ts`, `prior-task.ts`, `recovery.ts`; `src/coordination/control.ts`, `bound-control.ts`; `src/store/task-store.ts`, `record-codecs.ts`, `coordination-store.ts`; `src/service/coordination.ts`, `client.ts`, `server.ts`; root CLI and MCP server/coordination consumers. A cohesive `src/coordination/announcements.ts` or `src/store/announcement-store.ts` is permitted only if it owns the identified immutable-payload/linkage responsibility rather than another task store.

**Evidence:** `tests/core/coordination-announcements.test.mjs`, `coordination-linkage-recovery.test.mjs`; `tests/integration/coordination-submission.test.ts`; extend existing `coordination-managed-store.test.mjs`, `coordination-mcp.test.mjs`, elected/client/disposition cases and historical record fixtures. The real coordinator/store path must start a controlled worker only after its linkage barrier.

**Docs/skills:** `docs/coordination.md`, `docs/task-lifecycle.md` only for changed submission/input identity, `docs/compatibility.md`, `docs/recovery.md`; `.agents/skills/passeur-bridge/SKILL.md` and its actual affected reference. Native adapter implementations are read-only unless a concrete lifecycle issue is demonstrated; automatic bookkeeping must not require new vendor reasoning callbacks.

## R4-S1 — monitoring and notices

**Production owners:** prospective `src/observation/monitor.ts`, `cache.ts`, `index.ts`; existing/new helper/model/report/source owners; `src/coordination/notices.ts`, `control.ts`; observation store and relevant coordination contracts; `src/core/repository-runtime.ts`, `managed-coordination.ts`; existing service/CLI/MCP consumers. Update task/resource lifecycle hooks only where actual observer ownership changes. Keep watcher/parse resource accounting separate from task execution state.

**Evidence:** `tests/core/structural-notices.test.mjs`, `structural-observation-store.test.mjs`; `tests/native/structural-monitor.test.mjs`; `tests/integration/structural-notifications.test.ts`, `structural-sharing.test.ts`. Extend existing retirement, shutdown, transport-capacity and recovery suites for the new consumer paths. Test-owned event-loss injection supplements, not replaces, actual filesystem events.

**Docs/skills:** `docs/structural-reporting.md`, `docs/coordination.md`, `docs/shared-service.md` for observer-owned lifetime; current usage skill for pull/cursor and detail handling.

## R5-S1 — installed native workflow

**Production/build owners:** `src/install/runtime.ts`, `src/contracts/runtime.ts`, `src/observation/languages.ts`/helper loading, `scripts/build-runtime.ts`, `scripts/build-parsers.ts`, parser manifest, package/lock files; `src/diagnostics/doctor.ts`; existing bootstrap/client/server, CLI and registration owners only for real capability/cutover effects. Persisted schema fixes return to R3's canonical owners, not ad hoc installer rewriting.

**Evidence:** `tests/integration/structural-installation.test.ts`, `structural-migration.test.ts`; `scripts/probe-structural.ts`; actual fixture versions under `tests/fixtures/structural/compatibility/`. Extend runtime/registration tests. Ordinary runtime operations do not provision dependencies.

**Docs:** `README.md`, `docs/design.md`, `docs/startup-and-installation.md`, `docs/installed-acceptance.md`, `docs/compatibility.md`, `docs/recovery.md`, `docs/registered-agents.md`; affected usage/setup skills. Real personal registration edits remain operator-authorized operations, not repository patches.

## R6-S1 — acceptance

**Evidence/measurement paths:** `scripts/benchmark-structural.ts`, `tests/fixtures/structural/workload.json`, existing scenario/probe files, and this plan's result/review/claim-status reports. Register an explicit performance command rather than accidentally executing host-specific benchmarks under every ordinary test run. Any new CI workflow requires a named claim, execution environment and trigger; no blanket pipeline is authorized.

**Defects:** return to their source/contract owner and update the affected tests. **Docs:** final support/runbook/skill corrections, existing plan status and historical transfer index. **Protected paths:** unrelated repositories, user worktrees/configuration, live credentials and Plan 2B remain untouched.

## Parallel contribution and integration

Use an isolated feature branch/worktree when it provides concrete risk or conflict isolation. Record its owner and final disposition. One lead integrates shared contracts and migrations. Language workers receive exact primary/adjacent/forbidden paths, input/result commit identities and an output/oracle contract. A discovered shared-contract change is returned to the lead rather than independently redefined.

Preserve ordinary conventional commits, hooks/signing and published history. No fixed number of commits or exact-parent chain is required. Retain protected worker refs until ordinary integration/archive evidence permits cleanup. Review the complete material candidate independently at the final boundary, with affected re-review after semantic changes.
