# Registered agents in Passeur

**Status:** Verifying — source candidate, not Accepted.  
**Objective acceptance:** blocked.  
**Current phase:** M5, pinned and installed qualification.  
**Exactly one next integration slice:** M5-S1 — apply to the full baseline checkout, provision approved pinned dependencies, run the complete checks, and disposition findings before live qualification.  
**Canonical plan:** `docs/plans/registered-agents/plan.md`. The next invocation supplies operation `verify` explicitly.

## 1. Objective, scope and authority

Expose approved named agent configurations through one repository-scoped Passeur runtime, with Muse as one native adapter and an implementation-only Codex app-server adapter as the second independently different integration. Preserve truthful task identity, permissions, cancellation, delivery and resource disposition. Include a usable agent skill that guides registration and future adapter implementation under MrScripty/Coding-Standards.

Baseline: Passeur `49724a8b65bf7540622934e4f25cc3178f9c00dc`; standards `366c1d90a24bbfb50973f62b155a5f3396c0f107`. This replaces the earlier registered-agent plan's `b0c162d` startup assumptions. [Reconciliation](reports/revision-reconciliation.md) owns this revision's comparison; [source authority](reports/baseline-and-sources.md) identifies the inspected sources.

The [discoverable-startup plan](../discoverable-startup-and-installed-runtime/plan.md) remains the owner of its original installed-host acceptance claims. It is not silently accepted or overwritten. This plan consumes that architecture and adds agent-specific claims. Evidence may be linked across the plans where it proves both; one missing claim cannot disappear by moving its narration.

In scope: neutral worker contracts, registered configuration, lazy resolution, v3 task/admission identity, supported history, neutral MCP tools and real Muse compatibility, operator profile edits, native adapter lifecycle, documentation/skills, bounded conformance and installed qualification.

Out of scope: another scheduler or repository lease, a general agent loop, autonomous provider/model routing, remote adapters/plugin ABI, state-root relocation, non-Git job expansion, automatic project tests/repair/merges/PRs, provider quota optimization, routine per-worker external review, and automatic dependency/credential installation. The caller still owns task decomposition and integration; workers own scoped checks and commits.

## 2. Binding design and owners

### D1 — Preserve the startup runtime

`RepositoryRuntime` retains binding, lazy preparation, the lease, recovery, execution composition and drain. MCP discovery/status never depends on native SDK loading, agent credentials or model catalogs in an otherwise functioning installation. `passeur_prepare` establishes coordination without inference. Existing status v1 is unchanged; its provider field remains `not_checked`.

Agent catalog reads are provisional until successful execution composition fixes the profile/registry for that runtime. Failed pre-admission profile reads remain retryable. Subsequent operator changes require controlled restart; no hot reload is introduced. An invalid/unavailable registration is isolated from other entries.

### D2 — One task owner, selected agent per admission

`Coordinator` owns one bounded FIFO queue and active map across all agents. Preserve original first-subscriber cancellation, absolute deadlines including queue time, independent batch outcomes and shared unsafe-stop/persistence containment. Configured global capacity remains the single scheduling limit; no per-agent scheduler or shared-account quota model is added.

`AgentRegistry` resolves static trusted `AdapterDefinition`s from `src/agents/builtins.ts`. Factories decode options without native startup/probing. Task input selects only an approved ID, not an executable or runtime options. Configuration can restrict a mode; it cannot invent an adapter capability.

### D3 — Current and historical identity

New neutral assignments/results use v3, agent profile uses v2, catalog and execution snapshot use their own v1 scopes. Status/preparation and unchanged disposition/read contracts are not renumbered for symmetry.

Persist the validated request and non-secret immutable execution snapshot before admission effects. Include selected agent/adapter/native-contract identity, safe configuration/fingerprint, requested model when authoritative, and effective execution policy. Snapshot configuration is primitive-only, bounded and does not include/hash credentials. A fingerprint proves chosen configuration identity, not immutable native executable bytes or reproducible inference.

The v3 canonical hash uses deterministic code-unit key ordering. Existing v1/v2 request/disposition hashes retain the previous `stableHash` semantics. Equivalent retries are resolved before current profile/provider/approval prerequisites. Different explicit agent selection conflicts. New configuration uses a new key. Incomplete historical work requires reconciliation, never inference replay.

Recovery takes historical identity only from its original snapshot. Old unsnapshotted interrupted tasks have explicit unavailable identity and no fabricated model. Existing immutable results remain byte-preserved. New result reads/writes validate cross-record identity through the existing codecs/store; no new persistence framework or parallel decoder authority is introduced.

### D4 — Public tools and compatibility

Expose `passeur_status`, `passeur_prepare`, `passeur_agents`, `passeur_delegate`, `passeur_delegate_batch`, `passeur_result`, `passeur_finalize`. Catalog is paged, at most four registrations. Calls wait for their submitted work; retained reads do not become a polling workflow.

The actual four Muse tools remain v2 compatibility entrypoints selecting reserved agent `muse`. They delegate through the same canonical execution path. Historical keys retain original handling; unsupported output projection fails explicitly. Update registration allowlists, catalog assertions, docs and usage skill together. The existing server name, agent ID, Muse `muse_bridge` client identifier and installed build ID stay independent.

### D5 — Permission, evidence and native lifecycle

The neutral interface owns assignment/workspace/policy, task identity, cancellation, once-only human approvals, bounded metadata events and truthful terminal/stop evidence. Native SDKs, protocols, credentials, controls and model interpretation stay in adapters. Review requires both no-write and no-shell support. Implementation workers retain ordinary Git instructions/hooks/signing; worktree scope is not an OS security boundary.

A worker must provide the complete `PASSEUR_RESULT` report; missing/invalid reports fail. Native failure is not overwritten by an optimistic report. Preserve runtime-observed versus worker-reported checks. Emit bounded receipts from the full retained result; never remove commit evidence before computing counts.

Every adapter owns startup, native requests, callbacks, stream consumption and bounded shutdown. Cancellation acknowledgements do not establish descendant shutdown. Unknown stop freezes replacement execution and unsafe retirement while preserving independent healthy siblings' terminal evidence. No fallback provider, weaker permission, API key or guessed group kill is permitted.

### D6 — Operator edits and installation

Legacy profiles project to v2 in memory without writes. `migrate-profile` and `configure-agent` are explicit operator operations with complete candidate validation, unique exact-byte backups, cooperating-writer locks, conflict checks and atomic publication. Changed existing registrations require their exact replacement fingerprint. Noncooperating editors must remain quiescent. Unsupported/corrupt state is preserved, not guessed or rebuilt. Profile rollback is not permission to run old binaries over v3 task stores.

Preserve the baseline state/config namespaces, lease location, branches/archive refs, named registration controls and installed manifest mechanism. New compiled adapter modules enter the existing runtime closure. No new package dependencies or lockfile changes are needed. Real installed verification, not a development checkout build, proves the deployment path.

### D7 — Second adapter and skill

The Codex source candidate uses the official app-server v2 consumed projection at revision `7c1e485c871dd028a359e9e12d81cb38150b68c5`, Linux task-owned stdio processes, explicit ChatGPT login, a dedicated home, no inherited MCP/agent/app/plugin tools, native preflight checks, implementation-only capability and conservative stop evidence. It requires explicit experimental/account confirmation. It is not qualified for normal release until native control/credential/descendant evidence exists. The real CLI may reject or fail to establish requested controls; the adapter must block rather than infer them.

`.agents/skills/passeur-agent-adapter/SKILL.md` and its dossier/conformance references teach configuration-only reuse, exact native authority, ownership, lazy startup, migration, installed-artifact identity and evidence. It supplements Core/Router, does not become policy authority, and has a separate fresh-session behavioral qualification claim. `.agents/skills/passeur-bridge/` owns current use; `muse-bridge` becomes a compatibility route.

## 3. Constraints and design admission

Development is serial under one implementation owner; no concurrent authorizing proposals are introduced. Apply Core/Router plus planning, implementation, verification, proportionality, commit/documentation; TypeScript/async, launcher, IPC, persistence and generated-contract projection where applicable; architecture/code-design, contracts/schema/evolution/protocol, concurrency, resilience, security, diagnostics, cross-platform, tooling/build/dependency and licensing for their changed concerns. Use each route's Requires closure. Do not invent a universal lint preset, global validator, or fixed file-count rule.

**Composed-design review: applicable.** The complete eight-part probe and authority-scope decisions are in [design admission](reports/design-admission.md). Re-run it only when the actual composition or change propagation materially changes. Factories are the current required substitution boundary, justified by actual Muse/Codex mechanisms, not a hypothetical plugin marketplace.

Choose `implement` for reversible contract-satisfying work. Additional investigation needs a named decision, consequence, least costly check and stop condition. Missing pinned/native evidence blocks the corresponding acceptance, not all independent source work. Preserve all material findings in [issues](issues.md); a mandatory applicable defect cannot be relabeled optional while claiming whole-codebase compliance.

## 4. Objective acceptance claims

Status for every required claim is **blocked** until its full named boundary is proven. Executed narrower evidence is recorded separately, never substituted for the missing boundary. Current overall acceptance is blocked, not satisfied.

| ID | Observable criterion | Kind | Environment | Mode | Status / evidence |
| --- | --- | --- | --- | --- | --- |
| RA1 | Resulting owned modules, contracts and changed consumers follow the adopted standards; findings have valid dispositions. | integration + design review | representative full checkout | either | blocked; owner/design inspection performed, full pinned review pending |
| RA2 | Actual MCP catalog and neutral/legacy calls preserve seven neutral/four compatibility tools and startup independence. | contract + system | representative, genuine pinned MCP SDK | automated | blocked; SDK tests authored, dependency installation unavailable |
| RA3 | Admission/retries preserve original agent/config identity across config changes, conflicts, incomplete results and process restart. | contract + integration | representative real codecs/store | automated | blocked; owner substitute tests pass, real schema/store tests pending |
| RA4 | Supported profile/task history remains readable; explicit migration preserves backups and conflicting edits. | contract | representative real filesystem/decoder/lock | automated | blocked; migration/negative fixtures authored |
| RA5 | Mixed registrations share capacity, deadlines, cancellation ownership and independent outcomes. | integration + system | controlled owners plus representative SDK/native adapters | automated | blocked; owner scenarios including real Git commits pass, full adapter path pending |
| RA6 | Each advertised native mode enforces its permissions/credentials and once-only human approvals. | system | required-real installed Muse/Codex/account | either | blocked; no live account use; experimental Codex remains unqualified |
| RA7 | Actual installed caller delegates to both agents with identifiable artifacts and bounded evidence. | user-workflow + release-artifact | required-real host and installed runtimes | either | blocked; opt-in procedure added, not executed |
| RA8 | Actual native shutdown, descendants, Git delivery and explicit resource retirement preserve safety. | system | representative Git plus required-real native runtimes | either | blocked; controlled process/Git evidence does not prove native descendants |
| RA9 | Full declared pinned check/test/build and package-installed paths pass. | release-artifact | representative full baseline and pinned dependencies | automated | blocked; global standalone compiler evidence only |
| RA10 | Authoring skill is structurally usable and guides a fresh session to a correct bounded integration. | contract + user-workflow | local structural check + representative fresh agent session | either | blocked; structural evidence separate, behavioral session pending |
| RA11 | Independent external review of the completed verification unit, final resource dispositions and source integration are recorded. | integration review | representative full candidate | manual | blocked; no PR, external reviewer or target integration performed |

## 5. Milestones and exact write sets

The full exact changed/new/deleted path inventory is [write set](reports/write-set.md), generated from the candidate package. It is an allowed boundary, not permission for unrelated edits. Each milestone below names semantic ownership within that bounded population. Historical source from the baseline remains outside write authority unless listed. Test fixture/output directories are disposable only within their task-owned temporary roots.

| Milestone | Coherent goal and owned write subset | Gate / state |
| --- | --- | --- |
| M0 | Reconcile startup architecture, standards, scope, source identity and plan/AGENTS authority. Writes: AGENTS and this plan directory. | Source admission recorded; Implemented, full RA1 review pending |
| M1 | Complete neutral Muse vertical path. Writes: agent contracts/types/registry/builtins/report, affected core/runtime/result/recovery/profile/workspace/store/MCP, Muse config/adapter, approvals, CLI/launcher and registration allowlist; corresponding existing/new fixtures/tests. | RA2–RA5 affected paths; Implemented, pinned contract verification pending |
| M2 | Deliver usage/authoring skills, dossier/conformance references, adapter guide and shared cancellation helper. Writes: listed `.agents/`, `docs/agent-adapters.md`, helper and paired adapter test consumers. | RA10 structure + behavior; Implemented, fresh-session evaluation pending |
| M3 | Implement Codex native projection/transport/adapter/config and controlled process fixtures. Writes: `src/agents/codex/`, corresponding native/adapter tests, `docs/agents/codex.md`, native tsconfig/script wiring. | RA6/RA8 with genuine native evidence; Implemented as explicit experimental candidate, qualification blocked |
| M4 | Regress mixed tasks, historical identity, profile edits, record proof and installed probe path. Writes: migration/record/owner/MCP tests, probe scripts, README/current docs/compatibility. | RA3–RA8; Implemented source, Verifying required boundaries |
| M5 | Full pinned checks, installed/account/skill qualification, independent external review and package application/integration evidence. Writes: narrow issue fixes admitted by owner plus plan evidence; no general cleanup. | RA1–RA11 all satisfied before Accepted; Verifying |

Milestones are dependency/acceptance units, not required one-commit units. Completed source does not make a milestone accepted. Read-only review may run independently; shared contracts, active plans, lockfile and integration remain serial. Use a short-lived branch such as `feat/registered-agents`, targeting `main`, owned by the implementing maintainer. This package edits no actual repository branch or remote history. Review the completed verification unit externally before merge; not every worker or commit. Follow Commit for exact staged scope, ordinary hooks and terminal resource protection.

## 6. Current next slice, blockers and re-plan triggers

M5-S1 starts from the full baseline checkout and the package's guarded application check. Preserve unrelated work; stop on a mismatched file instead of forcing replacement. With authorized dependency provisioning, run `npm ci`, `npm run check`, `npm test`, `npm run build:runtime`, and affected installed suites. Record actual pinned versions and all failures. A missing local runtime cache is not permission to replace SDKs with stubs or change pins.

Current blockers: complete dependency-backed checks were unavailable in the implementation container; no live installed Codex/Muse/account, real host interaction, fresh authoring session or independent external reviewer was used. Detailed impact and owner: [issues](issues.md). Current source compilation without external modules is not a full TypeScript success claim.

Re-plan for a changed native protocol/control, required mode that cannot be enforced, altered public/persisted consumers, shared state/lease ownership change, prohibited provider fallback, invalid baseline or required evidence, material structure/change propagation beyond the admission, or a systemic consumer invariant defect. Record and bound the affected family, replace the active decision, update downstream gates and next slice, and re-run composition admission when appropriate. Stop an investigation when its named decision is resolved.

## 7. Completion and records

[Execution ledger](execution-ledger.md) records actual work and verification; [implementation evidence](reports/implementation-evidence.md) distinguishes executed and unavailable checks. [Issues](issues.md) owns blockers and revisit triggers. No new ADR is required: `docs/agent-adapters.md` owns durable architecture and links this result index. No metadata-only commit topology is prescribed.

Accept only after all non-deferred milestones are Accepted/Superseded, every objective claim has matching evidence, all required defects are resolved, explicit resource dispositions and exact source review are recorded, and external review/integration authority is satisfied. Do not claim a Coding-Standards-compliant release from this source ZIP alone.
