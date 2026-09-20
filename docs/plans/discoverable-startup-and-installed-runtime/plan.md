# Plan: Discoverable Startup and Installed Runtime

**Plan status:** `Verifying`  
**Current phase:** M3 — Complete pinned-dependency verification and installed-host acceptance  
**Next slice:** S3 — Apply/verify the source candidate with pinned dependencies, then execute authorized installed-host acceptance  
**Acceptance status:** `blocked`  
**Development decision:** `blocked` — required verification needs unavailable dependencies and host/account access  
**Repository:** `MrScripty/Passeur`  
**Prepared:** September 20, 2026  
**Inspected Passeur revision:** `4f4ef0f12d116c7ac8f73474c0dd4e067e025ad3`  
**Standards revision:** `366c1d90a24bbfb50973f62b155a5f3396c0f107`  
**Canonical path:** `docs/plans/discoverable-startup-and-installed-runtime/plan.md`

**Execution ledger:** [execution-ledger.md](execution-ledger.md)  
**Issues:** [issues.md](issues.md)  
**Standards and baseline:** [reports/standards-and-baseline.md](reports/standards-and-baseline.md)  
**Composed-design review:** [reports/design-admission.md](reports/design-admission.md)  
**Acceptance procedures:** [reports/acceptance-procedure.md](reports/acceptance-procedure.md)

Source changes and tests are supplied in the accompanying source-update archive. This plan is not an acceptance certificate. [Implementation evidence](reports/implementation-evidence.md) separates executed focused checks from blocked full dependency, artifact, protocol and host claims. The selected source files are guarded by inspected Git blob identities during application; unrelated shared history is not rewritten.

## 1. Objective

Make Passeur discoverable and diagnosable from Codex when a project, profile, state directory, coordination lease, or agent runtime is unavailable. Preserve exclusive coordination of Passeur's tasks and Git resources. Bind normal installations to an identifiable installed runtime rather than mutable development output, support explicitly named project registrations, and prove the real installed delegation path before reporting operational acceptance.

The operator must be able to distinguish **configuration installed**, **MCP transport working**, **repository coordination ready**, and **installed agent workflow verified**.

“Repository ownership” means a coordination lease among cooperating Passeur processes in the configured single-user state namespace. It grants neither filesystem permission nor GitHub ownership, and does not prevent unrelated editors or Git commands from changing files.

## 2. Scope and preserved contracts

### In scope

The MCP/CLI startup boundary; operation-specific readiness; lease acquisition, compromise and release; causal error projection; safe recovery classification; immutable installed runtime identity; named Codex registration; exact-command verification; operator documentation and the existing Muse-bridge skill; claim-matched process and installed-workflow evidence.

The failure family is systemic: operational prerequisites currently suppress discovery, and broad exception handling can manufacture incorrect authority or corruption diagnoses. Fix the bounded consumer family in section 8 rather than only the first failing call site.

### Preserved

Keep one process-level coordinator per canonical repository within the configured coordination namespace, multiple independent workers, request-key idempotency, task schema version 2, supported version-1 history, separate execution/delivery/disposition outcomes, scoped worker checks and ordinary commits, approval boundaries, and protected worktree/ref retirement. Preserve read-only assignments for supported non-Git directories.

Codex/user owns task decomposition, integration and broader acceptance. Workers own their assigned changes, checks and commits. Passeur manages execution and resources; it does not certify standards compliance of a worker's output.

### Out of scope

Additional agent adapters or a provider registry; a daemon or desktop application; multi-user or distributed coordination; transparent routing to another coordinator; state-root migration; a standards interpreter; project test selection; merge/PR automation; automatic repair loops; new per-worker review requirements; automatic runtime garbage collection; unrelated code cleanup. Product-development delegation is not an acceptance fixture.

## 3. Constraints, assumptions and authority

Use the existing Node/TypeScript runtime, MCP SDK and Muse adapter. The inspected runtime pins are MCP SDK 1.30.0, Muse SDK 1.3.0, proper-lockfile 4.1.2 and Zod 4.1.11. Keep these unless an actual compatibility defect requires an explicit dependency decision. Preserve the corrected Muse client identifier `muse_bridge`; it is not the Codex registration name.

The required installed acceptance environment is the user's Linux deployment, local Git/filesystem behavior, installed Codex and Muse, and authorized account. Record exact observed versions during acceptance. Preserve other existing supported behavior, but do not infer Windows/macOS, network-filesystem, sandbox or process-tree guarantees from Linux evidence. Re-plan before extending the support claim.

The supported safety model assumes cooperating processes use the same canonical repository identity, lease settings and configured state namespace. Preserve the current identity algorithm, state layout and lease location. Managed registrations pin the absolute state root; reject conflicting known managed bindings for the same repository. Never resolve permission failure by choosing another state root. Manually configured alternate roots are not a supported parallel ownership domain; moving state requires a separately authorized cutover.

Installation, changes to personal Codex configuration, live account use, permission changes and destructive cleanup require the corresponding operator authority. This document does not grant those actions. Automated checks use disposable repositories and isolated configuration by default.

## 4. Binding decisions

### D1 — Transport availability is independent of execution readiness

**Owner:** MCP composition and the repository runtime owner.

Before connecting stdio, decode the command shape and load only infrastructure essential to the executable/MCP interface. Defer project canonicalization, Git/worktree discovery, profile reads, subscription checks, state access, recovery and provider loading from the transport bootstrap path. Merely moving the lease call is insufficient.

Register the fixed supported tool catalog immediately. An operationally blocked supported tool remains advertised with a typed failure contract; this is temporary unavailability, not an advertised placeholder. Essential executable, SDK or transport failure can still terminate startup with a bounded stderr diagnostic and nonzero outcome.

Introduce two supported tools:

| Tool | Contract |
| --- | --- |
| `passeur_status` | Read-only bounded status and runtime identity. It reports observed readiness or `not_checked`; it neither acquires a lease nor initializes, migrates, repairs or writes state. |
| `passeur_prepare` | Explicitly establish coordination readiness through the same gate used by mutating operations. It may initialize/import/reconcile supported state under authority, but never launches inference. Its result states what was checked. |

Add both tools to the generated Codex allowlist in S1. Do not leave diagnostics available only inside the server while registration filters them out.

### D2 — Each operation requests only its own prerequisites

**Owner:** repository runtime; individual operation owners retain authorization policy.

A small process-owned runtime object hides preparation ordering and lifecycle. It composes the existing TaskStore, Coordinator and DispositionManager rather than duplicating them. Public tool handlers receive validated operation inputs and context, not authority to select arbitrary project paths, executables or state roots.

| Operation | Required capability |
| --- | --- |
| Initialize/list tools/status | Healthy control interface; configuration and execution may remain unchecked or blocked. |
| `muse_result` and CLI history/inspection | Resolve the configured store and decode the requested readable records. No lease, inference credentials or migration. Observations across mutable resource records are not promised as a transaction-wide snapshot. |
| Prepare/recovery/offline reconciliation | Valid project/state binding, coordination lease and applicable recovery authority. No working Muse session or verified inference subscription is required. |
| Finalize/cleanup | Coordination authority and the existing resource-specific safety/disposition checks. No inference prerequisite. |
| Single/batch delegation | Valid execution profile, subscription policy and client approval capability, followed by coordination readiness and normal task admission/adapter execution. |

Keep project, profile and store identity fixed for one ready runtime. A safe failed pre-admission attempt may reread a repaired profile or permission condition. Changing a live worker's profile or re-binding a ready runtime requires a new controlled process lifecycle; no active-worker hot reload is introduced.

### D3 — One owned readiness lifecycle

**Owner:** `src/core/repository-runtime.ts` (new).

Use a closed state model equivalent to `idle -> preparing -> ready | blocked`, with `frozen`, `closing` and `closed` transitions where applicable. Ready means the named coordination capability, not proof that Muse inference has succeeded. Keep agent compatibility evidence separate.

Concurrent first requests share one process-owned preparation attempt. A caller cancellation detaches that waiter and prevents its task admission; it does not cancel preparation needed by another caller. Shutdown cancels the process-owned attempt and observes its terminal result. Late acquisition or other uncancellable completion must be observed and any unused valid lease released, without publishing stale readiness.

Preparation has a bounded budget with an explicit millisecond unit and owner. Preserve the existing bounded subprocess mechanisms. Do not mistake cancellation of a waiter for cancellation of an underlying operation. Retry only a safe pre-admission blocked condition on a subsequent explicit prepare/tool request; there is no automatic retry/restart loop.

Acquire authority before task-state initialization, migration, recovery or resource mutations. Lease-directory bootstrap is part of acquisition, not permission to modify task records. After successful preparation, keep the valid lease for the coordinator lifetime, including periods with no workers; do not use per-tool leases. Short admission/administration synchronization must not span worker inference, human approval or external hooks.

A failed preparation with no active execution releases valid provisional ownership after its owned work settles, allowing offline repair. Persisted unresolved execution remains a safety barrier regardless of whether this process still holds the lease.

### D4 — Lease loss is containment, not a restart strategy

**Owner:** lease adapter and repository runtime.

Preserve the existing shared stale/update policy unless evidence requires a new admitted policy. A stale lock is not evidence of stopped workers: normal retained-state reconciliation remains mandatory after acquisition.

Handle proper-lockfile compromise explicitly. Invalidate local authority before admitting further mutations; close admission, cancel owned execution and observe shutdown. Already-dispatched filesystem/process operations may have uncertain outcomes: retain that distinction and require reconciliation. Do not write a new shared success/safety record using invalid authority or claim that an advisory lease fences every in-flight OS effect.

Unify EOF, transport closure and process signals behind one idempotent shutdown promise. Close admission, stop/drain owned work, preserve terminal or unresolved evidence while authority remains valid, then release. Unconfirmed worker stop stays unconfirmed. Do not delete another process's lock, auto-steal authority or automatically replay inference.

### D5 — Preserve failure meaning and authoritative records

**Owner:** failure-domain owners; MCP/CLI project their outcomes.

Distinguish real contention, permission denial, read-only/full/unavailable storage, malformed profile, unsupported profile/state version, corrupt state, reconciliation requirement, lease compromise, shutdown and provider startup failure. Keep `PROJECT_IN_USE` for actual contention only. Include directory creation as well as lock acquisition in typed error handling.

Preserve original causes internally and bounded safe fields externally: domain code, stage/operation, native code when known, relevant configured path when authorized, and an applicable next action. Unknown owner identity remains unknown. A permission error must not become “another coordinator.”

Use canonical complete decoders for the stored representations consumed by readiness, recovery and disposition: request, task state, result, resource, disposition receipt and safety record. Reuse existing contract schemas where they apply; derive or prove persisted projections rather than copying permissive shapes. Decode supported historical variants explicitly without inventing mandatory fields absent from their real contracts. Preserve unsupported future versions separately from malformed data.

Narrow `quarantineIncomplete()` to proven corruption/incompleteness under its existing preservation-and-freeze contract. Permission failures, storage failures and unsupported versions must not rename, erase, reset or replace authoritative records. Read-only operations never quarantine. Unknown partial publication is a recovery condition, not an empty store.

Tool execution failures use the MCP execution-error representation, including `isError: true`; protocol request errors remain protocol errors. A successful status observation can report blocked execution without falsely reporting a failed diagnostic operation. Prove emitted structured data against its destination contract.

Diagnostics remain available in memory and stderr when state storage is unwritable. Keep stdout protocol-only. Bound diagnostic buffering and response size, redact before projection, and report channel failures without converting the original operation into success. No telemetry service or general event framework is added.

### D6 — An installed artifact is an explicit runtime, not a checkout

**Owner:** build/install procedure and runtime identity contract.

Create a version/build-specific install directory containing the compiled runtime, the exact locked production dependency closure, required licenses and a machine-readable dependency inventory/SBOM. Do not link runtime code or dependencies back to mutable development output. Node remains an external runtime dependency whose resolved executable and actual version are recorded.

Generate build identity from the actual selected build inputs: source revision, package version, dependency-resolution identity and relevant build/toolchain facts. Keep dirty development builds explicitly labeled; normal installed candidates must identify a clean selected source. Build identity is captured during construction, not inferred later from the user's current checkout HEAD.

Stage and validate the complete candidate before publication into the supported install root. Publish a new unique identity; never overwrite an installed build in place. Treat immutability as an installer contract, not a security guarantee against a user editing their own files. Do not add a content-addressed store, signing infrastructure or perpetual integrity scan without a separate requirement.

Normal registration resolves an exact installed CLI path. A convenience alias may follow a selected version for interactive use, but registrations must not follow that mutable alias. Running old processes keep their old identity; upgrading affects new launches only. Retain the previous runtime for explicit rollback. Neither `serve` nor a failed launch builds, installs, changes permissions or falls back to development output.

### D7 — Registration is named, scoped and independently verifiable

**Owner:** Codex registration adapter.

Accept an explicit `--server-name`, including the user's `passeur_pumas` and `passeur_tuldok`. Preserve `muse_bridge` only when intentionally selected for an existing registration. Distinguish registration name, repository identity, agent SDK client identifier and build identity.

Bind the generated command to the exact Node/installed-CLI paths, absolute project/profile/state inputs and expected repository identity. The process working directory is the installed runtime directory, not a project directory that may later be missing. Record allowed environment inputs without copying credentials into TOML or diagnostic output.

Validate name and binding semantics before destination encoding. Use an established grammar-aware TOML implementation for the supported edit/serialization surface; do not extend the current regex parser into a second TOML implementation. In S2, record and pin the selected dependency against preservation, Node/ESM, licensing and conformance requirements. This bounded selection does not delay S1.

Preserve unrelated configuration, comments where the chosen editing contract promises them, permissions and original backups. Reject conflicting names/bindings unless explicit replacement authority names the old and new binding. Serialize cooperating Passeur writers and require quiescent editing by noncooperating configuration writers. A reread followed by rename is not an atomic compare-and-swap against arbitrary external editors.

Rollback only an unchanged candidate under the accepted write contract; a subsequent conflicting edit must be preserved and reported. Do not restore a whole stale backup over newer user configuration. Never change global approval, sandbox or MCP startup policy merely to make a probe pass.

### D8 — Setup reports the evidence actually obtained

**Owner:** registration verifier and diagnostics projection.

Report separate outcomes for configuration, direct MCP transport, target-repository readiness and actual installed-host/agent workflow. Each outcome is `passed`, `failed`, `blocked` or `not_run`, with evidence scope and observed runtime identity. A command fails when its requested required verification level did not pass; an optional unrun live check is explicitly unverified, not implicit success.

The direct probe launches the exact registered command/arguments/cwd/environment, completes initialization, enumerates the expected catalog, calls `passeur_status`, validates build/binding identity, and closes/drains the child. Give the probe bounded startup/call/shutdown budgets and no inference authority. A correct configuration plus working transport with blocked repository readiness remains an installed-but-blocked registration, not a syntax failure to roll back automatically.

`codex mcp get` proves configuration inspection only. A direct SDK probe does not prove Codex attachment. Test the installed host separately, including its actual startup/catalog behavior and enabled-tool filtering. Use current official documentation as reference, but verify options against the installed version rather than assuming it implements every current setting.

## 5. Objective acceptance

All claims below remain required. Broad acceptance is blocked; focused evidence does not satisfy a broader claim. Detailed fixtures, authoritative observations and live procedures are in [the acceptance procedure](reports/acceptance-procedure.md). Evidence is reused across claims only where it actually proves both.

| ID | Observable criterion | Kind | Environment | Mode | Status | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| A1 | Real stdio initialization, tool listing and status survive operational project/profile/state/lease/provider failures. | system | representative | automated | blocked | [Scope and blockers](reports/implementation-evidence.md) |
| A2 | Error/status contracts preserve causal distinctions, disclosure limits and correct MCP outcome projection. | contract | not-applicable | automated | blocked | [Scope and blockers](reports/implementation-evidence.md) |
| A3 | Two processes targeting one canonical repository/linked worktrees in one namespace remain discoverable; at most one holds valid coordination authority. Independent repositories operate independently. | system | representative | automated | blocked | [Scope and blockers](reports/implementation-evidence.md) |
| A4 | Concurrent preparation, waiter cancellation, safe retry, process closure, stale-state recovery and detected lease compromise preserve admission and terminal-state invariants. | system | representative | automated | blocked | [Scope and blockers](reports/implementation-evidence.md) |
| A5 | Supported history remains readable; malformed/unsupported/unreadable state is distinguished; permission failure does not quarantine or replace it. | contract | representative | automated | blocked | [Scope and blockers](reports/implementation-evidence.md) |
| A6 | A complete installed runtime operates without its source checkout; old/new process identities remain accurate; failed installation preserves the prior artifact. | release-artifact | representative | automated | blocked | [Scope and blockers](reports/implementation-evidence.md) |
| A7 | Named registrations preserve unrelated settings, reject collisions and unsafe edits, and conform to the actual TOML/Codex configuration contract. | contract | representative | automated | blocked | [Scope and blockers](reports/implementation-evidence.md) |
| A8 | The user's exact installed registration passes bounded direct initialization/list/status verification with the recorded launch context. | system | required-real | either | blocked | [Scope and blockers](reports/implementation-evidence.md) |
| A9 | Actual installed Codex -> Passeur -> Muse completes the disposable delegation, approval, cancellation and retained-delivery procedure. | user-workflow | required-real | either | blocked | [Scope and blockers](reports/implementation-evidence.md) |
| A10 | Actual Pumas/Tuldok registrations attach and report the correct runtime/binding; authorized preparation proves readiness or reports genuine contention with safe handover. | user-workflow | required-real | manual | blocked | [Scope and blockers](reports/implementation-evidence.md) |

Static/compiler/test/build checks are supporting gates. They do not replace A8–A10. The objective remains `Verifying` with blocked claims when the required host or account is unavailable.

## 6. Milestones and exact write sets

S1 and S2 source work is `Implemented`, not Accepted. S3 is `Verifying` with blocked required evidence. A documented execution-environment re-plan allowed reversible source preparation while retaining every original acceptance gate; it did not declare those gates passed. Each milestone remains one coherent slice rather than a required single commit.

The plan, ledger, issues and these three report files may be updated when authority, lifecycle, evidence or findings materially change. Test/build outputs belong only in declared generated or disposable locations. The exact write sets below include planned new files; listing a file does not authorize unrelated changes inside it. Add a directly affected file transparently; re-plan when its addition changes an owner, contract, risk or acceptance scope.

### M1 / S1 — Discoverable interface and safe coordination

**Status:** `Implemented`

**Goal:** A blocked repository cannot hide Passeur's supported tools, and every affected mutation obeys one readiness/authority lifecycle.

**Allowed production write set:**

```text
AGENTS.md
src/cli.ts
src/mcp/server.ts
src/core/repository-runtime.ts           (new)
src/core/lease.ts
src/core/errors.ts
src/core/profile.ts
src/core/coordinator.ts
src/core/disposition.ts
src/core/cleanup.ts
src/core/recovery.ts
src/core/result.ts
src/contracts/runtime.ts                (new)
src/contracts/index.ts
src/contracts/types.ts
src/store/record-codecs.ts              (new)
src/store/task-store.ts
src/diagnostics/doctor.ts
src/codex/config.ts                     (diagnostic allowlist only)
src/workspace/project.ts                (deferred/cancellable identity only)
tsconfig.core.json                     (include/resolution consequences only)
docs/design.md
docs/recovery.md
docs/setup.md
.agents/skills/muse-bridge/SKILL.md
.agents/skills/muse-bridge/references/setup.md
docs/plans/parallel-worker-commit-handoff/plan.md
```

**Allowed test write set:**

```text
tests/unit/repository-runtime.test.ts    (new)
tests/unit/lease-errors.test.ts          (new)
tests/unit/persisted-records.test.ts     (new)
tests/unit/contracts.test.ts
tests/unit/compact-result.test.ts
tests/unit/codex-config.test.ts
tests/integration/mcp-startup.test.ts    (new)
tests/integration/lease-lifecycle.test.ts (new)
tests/integration/parallel-mcp.test.ts
tests/integration/coordinator.test.ts
tests/integration/recovery.test.ts
tests/integration/task-store.test.ts
tests/integration/cleanup.test.ts
tests/fixtures/bridge.ts
tests/fixtures/runtime-process.ts       (new; test-only)
tests/core/helpers.mjs
tests/core/delivery.test.mjs             (record/fixture compatibility only)
tests/core/pool.test.mjs
tests/core/store.test.mjs
tests/core/disposition.test.mjs
```

Preflight the worktree/index, repository instructions, current consumers and selected standards route. Wire a concise Coding-Standards entrypoint into AGENTS while preserving the existing skill instruction. Establish real failing startup/authority regressions, implement D1–D5 as one vertical path, and update the diagnostic allowlist and operator guidance with it. Replace the startup assumption in the older active plan by reference; retain its independent task/resource acceptance obligations.

**Gate:** A1–A5 pass; existing task/parallel/disposition regressions and affected TypeScript checks pass. Both real stdio processes remain reachable while only one coordinates. A repaired pre-admission condition succeeds without restarting the same MCP process. No incomplete decoder, ineffective authority guard, forgotten promise or false stop assertion is accepted.

**Re-plan:** Correct recovery requires changing a supported historical schema, moving state, stronger fencing than the admitted cooperative model, or a new lifecycle owner. New provider/daemon/general scheduler work is not an implicit continuation.

### M2 / S2 — Deterministic installation and named registration

**Status:** `Implemented`

**Goal:** A registration refers to a stable installed runtime and verifies the interface it actually launches.

**Allowed write set:**

```text
src/cli.ts
passeur
src/install/runtime.ts                  (new)
src/codex/config.ts
src/codex/probe.ts                      (new)
src/contracts/runtime.ts
src/diagnostics/doctor.ts
scripts/build-runtime.ts                (new)
package.json
package-lock.json
tsconfig.json                          (declared build inputs/outputs only)
.gitignore                             (new generated install/build outputs only)
tests/unit/codex-config.test.ts
tests/unit/launcher.test.ts             (new)
tests/integration/installed-runtime.test.ts (new)
tests/integration/registration-probe.test.ts (new)
README.md
docs/setup.md
docs/compatibility.md
.agents/skills/muse-bridge/SKILL.md
.agents/skills/muse-bridge/references/setup.md
```

Implement D6–D8 using the existing package/build tooling, adding only selected installation/probe procedures. Resolve the bounded TOML dependency decision before editing its consumer. Reject undeclared launcher actions instead of silently interpreting them as another action, while preserving explicitly supported positional project syntax.

Exercise staging failure, missing dependencies, checkout removal, old-process/new-install identity, unsafe replacement, name collisions, configuration concurrency and exact subprocess launch. Host-state writes remain opt-in; default verification uses isolated Codex configuration. Keep setup wording and skill commands accurate as each capability becomes available.

**Gate:** A6–A7 and the automated representative form of the A8 procedure pass, with S1 safety regressions unchanged. Production runtime and dependency inventory have no development-checkout references. Direct probe success is labeled transport evidence, not live host acceptance.

**Re-plan:** The chosen TOML implementation cannot satisfy preservation/conformance; artifact installation needs unsupported filesystem guarantees; or packaging changes the selected SDK/dependency contract. Record the failed requirement rather than silently substituting another runtime/layout.

### M3 / S3 — Installed workflow acceptance and closure

**Status:** `Verifying`

**Goal:** Establish that the installed bridge works in Codex with the intended Muse runtime and real project registrations, then close the plan from evidence.

**Allowed write set:**

```text
scripts/probe-installed.ts              (new; opt-in fixture validation)
scripts/probe-muse.ts                   (compatibility evidence alignment only)
scripts/probe-parallel.ts               (existing claim reuse only)
package.json                           (expose the selected probe procedure only)
docs/setup.md
docs/compatibility.md
docs/design.md
docs/recovery.md
.agents/skills/muse-bridge/SKILL.md
.agents/skills/muse-bridge/references/setup.md
docs/plans/parallel-worker-commit-handoff/plan.md
docs/plans/parallel-worker-commit-handoff/execution-ledger.md
docs/plans/parallel-worker-commit-handoff/issues.md
```

Run the installed procedures with explicit installation/configuration/live-account authority. Use real Codex attachment and actual tool calls, not a direct Coordinator call presented as end-to-end evidence. Keep automated fixture validation separate from manual host/approval observation when the installed interface requires it. Store bounded redacted observations in the acceptance report and link overlapping evidence from the older plan without marking untested claims accepted.

Review the composed implementation at the completed boundary, collect the review round's findings, and resolve in-scope issues before final acceptance. Do not add a fresh investigation cycle after the admitted claims pass unless a named finding changes the decision or its safety.

**Gate:** A8–A10 pass with exact artifact/host/SDK/model identities and terminal cleanup evidence; all non-deferred claims are satisfied; docs and the skill describe the implemented behavior. A skipped or simulated live run is not acceptance.

**Re-plan:** The installed host cannot expose the required tools/approval behavior, provider semantics differ materially, an actual safety failure appears, or the proposed public workflow must change. Otherwise missing credentials/host access blocks the named verification claim rather than changing product scope.

## 7. Evidence and oracle ownership

The test oracle for lease exclusivity is actual acquisition and externally observed prohibited/allowed effects across OS processes, not a mocked method count. The stored-state oracle is the accepted historical/current record contract and preservation of bytes/references after real reopening. The configuration oracle is the destination TOML grammar plus Codex's actual consumer; local generator/parser agreement alone is insufficient.

Real MCP Client/stdio interaction proves transport behavior. Actual Codex observations prove host attachment. Actual Muse execution proves the installed adapter path. Scripted workers and injected failure boundaries remain valuable only for the precise lifecycle contracts they model. Detailed coverage and fixture isolation are specified in the linked acceptance procedure.

Use the current repository's selected commands after explicitly authorized dependency provisioning: `npm ci`, `npm run check`, `npm test`, `npm run build`. Preserve required hooks. Record actual command, cwd, environment, exit status and claim scope; do not claim these commands were run while preparing this plan.

## 8. Systemic finding audit

**Invariant family:** The control interface remains reachable during operational unavailability, while each protected operation establishes current authority and retains the actual outcome.

**Bounded population:** CLI serve/bootstrap and offline mutation branches; MCP's six planned tools; lease acquisition/release/compromise; Coordinator admission/shutdown; DispositionManager and cleanup; TaskStore's stored request/state/result/resource/receipt/safety readers and recovery; profile loading; Codex registration/rendering/verification; installed runtime identity; docs and skill projections of these promises.

Every selected consumer is fixed in S1/S2, exercised in S3, or explicitly preserved by a matching regression. The existing Muse execution contract remains, including its corrected identifier; its live compatibility is verified rather than reimplemented. No adjacent model-discovery, scheduling, Git-integration or provider-framework expansion is admitted.

**Alternatives disposition:** Moving one lease call leaves earlier bootstrap failures; removing authority loses resource safety; a daemon introduces an unnecessary deployment owner; changing state roots risks split coordination; generic retry/error middleware hides outcome ownership. The admitted design instead consolidates readiness, uses operation-specific prerequisites and strengthens the existing durable decoding boundary.

**Stopping condition:** The named mutation/read/diagnostic consumers have evidence-backed dispositions, the claim matrix passes at its required boundaries, and the composed design still matches its admission. Repository-wide enumeration is not a stopping requirement.

## 9. Simplicity and ownership review

**Applicability:** `applicable`.

The full eight-part Architecture probe, including independent concerns, authority scopes, version roles, caller knowledge, representative changes, deletion tests and retained complexity, is recorded in [design-admission.md](reports/design-admission.md). Its initial result admits this proposed composition, not unseen code. Recheck the actual artifact at S1/S2 completion; replace the review when the composition materially changes.

Durable architecture belongs in the existing `docs/design.md`; this plan does not create a second ADR authority. After acceptance, retain this plan as an evidence/decision index and link the durable owner.

## 10. Implementation governance

Use one serial implementation/integration owner. The Concurrent Plan Integration profile is not selected: no overlapping authorizing proposals are planned. Read-only reviews are allowed; adding parallel write proposals requires explicit ownership and applicable routing first.

Use a short-lived implementation branch, suggested name `fix/discoverable-startup-and-installed-runtime`, targeting `main`. Isolation is selected because readiness, persisted-state handling and personal configuration have material rollback/review risk, not merely because a plan exists. The implementer owns its changes; the repository maintainer owns integration. Preserve pushed/shared history. Select the integration mechanism through Commit; no commit count, topology chain or mandatory cherry-pick is prescribed.

Per commit, inspect state, stage only the declared coherent change, review the exact index and sensitive/generated effects, and run its selected checks. Review the cumulative range at completed milestone/pre-push/integration boundaries. External review, when selected by repository policy, occurs at the completed review boundary rather than every worker task; Passeur itself does not create or manage that policy.

Do not require an extra worktree. For any task-created branch/worktree or acceptance fixture, record its exact identity, protected commit disposition and terminal retained/removed outcome. Cleanup authority covers only those owned resources with proven protection; it does not authorize pruning historical or user work.

## 11. Blockers, re-planning and final acceptance

**Implementation/verification blocker:** full pinned dependency installation, full typecheck/test/build and installed artifact/protocol execution are unavailable in this preparation environment. Apply the baseline-checked update in a provisioned checkout before accepting source compatibility.  
**Required-real evidence:** blocked on authorized access to the user's installed host, accounts and real project registrations.  
**Deferred matters:** see issues F7–F9; none may be used as a fallback to satisfy this objective.

Re-plan for a changed objective/authority boundary; unsupported required filesystem/process semantics; a supported historical record rejected by the new decoder; a needed state-root migration; new dependencies changing deployment; contradictory error/protocol meaning; or cumulative machinery/caller knowledge exceeding the composed-design review. Record the trigger, replace the active decision, update downstream gates and exactly one next slice. A newly located file inside the same bounded concern is not automatically a new design.

Choose the least costly adequate investigation only when its answer can change the current decision. Name the decision, consequence and stopping condition. Otherwise implement the admitted reversible correction and record unrelated findings for their owner.

At source completion use `Implemented`, then `Verifying` for objective evidence. Mark `Accepted` only when every required claim is satisfied, every milestone is Accepted/Superseded, all remaining issues have explicit owners/triggers, the actual composed artifact has been reviewed, and final evidence/resource disposition is recorded. Do not equate compiler success, a registration entry, tool listing or worker commit with that result.

**Next implementation invocation:**

```text
Plan: docs/plans/discoverable-startup-and-installed-runtime/plan.md
Operation: verify
Slice: S3 — full dependency/protocol/artifact checks, then authorized installed-host evidence
```

This is an instruction to the implementing agent, not an existing Passeur CLI command. Begin by applying the exact source update, inspect repository state, provision the selected dependencies with authority, and run the real stdio regressions. Do not start product delegation as a substitute for acceptance.

## Implemented write-set refinements

The source candidate also updates `passeur`, `README.md`, `docs/startup-and-installation.md`, `docs/installed-acceptance.md`, and `tests/core/runtime-owner.test.mjs`; `src/workspace/worktree.ts` carries the authority guard adjacent to the already selected Git boundary. The build/install manifest owns candidate-versus-installed identity and npm toolchain provenance. The existing design document remains the durable architecture owner. `smol-toml` 1.6.1 is the selected TOML dependency; version/license/integrity and unresolved resolver evidence are recorded in the evidence report. Distribution-only `apply.py`, source transforms and focused verification tools are outside the application runtime.
