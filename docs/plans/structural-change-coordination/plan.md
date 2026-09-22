# Passeur: code-only structural coordination

## Current authority

| Field | Value |
|---|---|
| Plan status | `Blocked` |
| Plan revision | `2A` — standalone code-only target |
| Acceptance status | `blocked` |
| Current phase | F4 service-session increment implemented; native qualification, actual runtime/public integration and objective acceptance remain blocked |
| Exactly one next integration slice | **M0-S1 — obtain the pinned dependency closure; integrate the tested metadata session with authenticated runtime/resource owners and qualify native analysis** |
| Canonical plan path | `docs/plans/structural-change-coordination/plan.md` |
| Implementation invocation | Explicit `start`; subsequent `continue` or `verify` only in the states allowed by Planning |
| Examined implementation | Passeur `81b7a2a308f6fe546b4a0b9e118180936e0360a2` |
| Adopted standards | MrScripty/Coding-Standards `366c1d90a24bbfb50973f62b155a5f3396c0f107` |
| Prepared | September 21, 2026, America/Vancouver |
| Product and acceptance owner | Passeur maintainer |
| Shared-source integration owner | Current implementation session for the supplied patch; maintainer owns repository integration |
| Composed-design review | Applicable; all eight probes in [design admission](reports/design-admission.md) |

[Execution ledger](execution-ledger.md) owns dated work/evidence. [Issues](issues.md) owns findings. [Contracts and workflow](reports/contracts-and-workflow.md) refines D1–D12. [Language qualification](reports/language-qualification.md) owns the required grammar/extraction matrix. [Implementation map](reports/implementation-map.md) owns exact slice write sets. [Verification](reports/verification.md) owns scenario procedures and oracle boundaries. [Sources and routing](reports/sources-and-routing.md) records examined sources and standards. None duplicates task-lifecycle authority.

This is a partially implemented plan. The maintainer committed F3 and requested
continuation. [F4 admission](reports/f4-admission.md) records the bounded
Blocked-to-Active transition for a service-owned metadata session; it does not
waive parser or installed qualification. F4 is implemented and locally verified
through its real Git/control/store and framed-transport boundaries, with fixture
principals and initialization/resource policy. [F4 verification](reports/f4-verification.md)
records 175 passing selected tests, corrected same-author findings and remaining
consumers. The overall plan returns to Blocked. No SC01–SC17 objective claim is
marked satisfied from this partial increment. Existing F0–F3 and shared-service
evidence retain their exact scope; no remote or installed runtime was changed.

This is a standalone implementation target. The implemented shared-service lifecycle retains its own authority and pending acceptance evidence. Before editing, inspect actual source, installed readers and durable state; choose explicit preservation, migration or rejection for any incompatible state. Plan selection grants no authority to erase records or rewrite history.

## 1. Objective and boundary

Enable two or more parent/orchestrators and their workers to work in one repository with isolated inputs, early factual visibility into overlapping work, compact task-attributed structural differences, and one clearly identified parent coordinating a given integration target.

The normal path is **submit → work independently → obtain exact Git result → parent integrates → account for resources**. Additional coordination is entered only for observed relevance or an explicit parent request:

**announce/register → compare declared areas → observe exact versions → extract syntax → filter relevance → parent retrieves bounded evidence → parent decides → coordinate reconciliation ownership → integrate externally**.

Git owns code versions. Parents own interpretation, worker instructions, task decomposition, checks, reconciliation choices, integration, and acceptance. Passeur owns its shared execution service, source observations, deterministic formatting, authorized coordination records, delivery of selected notices, and safe disposition of its own resources.

### Required outcome

A parent can see how each relevant task changed a function, method, type declaration, or other source region, labelled with that task's own input and observed version. The report is useful without an LLM-authored description. It remains truthful for different bases, newly added declarations, in-progress code, incomplete parsing, ambiguous matches, direct host edits, and more than two concurrent workers.

### In scope

Git-identified handoffs; registered managed/external work; reused assignment intent and declared work areas; pre-start advisory overlap; explicit syntax watches; capture of relevant in-progress file buffers; syntax-level declaration extraction and conservative matching; compact deterministic reporting; bounded observations and notifications to parents; scoped attributed notes; non-expiring cooperative reconciliation leadership; historical compatibility, installed packaging, tests, and skills.

**Required structural coverage:** Rust, TypeScript, JavaScript, Python, Lua, Kotlin, Zig, C#, C, C++, Odin, Svelte 5, and React through JSX/TSX. Every entry is an acceptance requirement. A partial language rollout is an implementation checkpoint, not completion of this objective.

Qualify modern stable syntax selected as of admission, including relevant versions/features introduced since January 2025. Record exact supported dialects and tool versions. Older syntax supported by the same grammar is welcome; dedicated pre-January-2025 compatibility work is not required. This is not a promise to support unknown future language versions.

### Excluded mechanisms

Compiler/type-checker/LSP integration; referenced-type expansion; inferred types or behavioral contracts; macro execution; a resolved call graph or semantic dependency system; an LLM/evaluator describing, scoring, or judging routine changes; a rich proposal-family database; managed publication refs or acceptance policy engine; code-writing/merging/retasking by Passeur; automatic project tests or builds; live shared-source/CRDT editing; exclusive per-file edit leases; arbitrary plugins; remote/multi-user operation; machine-wide build scheduling; protection from malicious same-user programs.

Reconciliation *leadership* is in scope; executing a merge is not. Exact Git references plus existing task results are the handoff, not a parallel source-history authority. A syntax occurrence index is evidence routing, not a dependency claim. Optional parent-authored notes remain attributed statements.

## 2. Binding decisions

### D1. Preserve execution authority; add a distinct observation owner

Retain one elected repository service, `RepositoryRuntime`, `Coordinator`, `TaskControls`, `InputBroker`, registered-agent adapters, TaskStore, and DispositionManager. Native tasks remain service-owned; disconnects and observation waits cannot cancel them. Parents alone choose development instructions.

Add a narrow structural-observation owner and a narrow coordination-control owner inside that service. Parser work runs in a service-owned helper process, not in a second service or task scheduler. CLI/MCP remain projections. The parser receives captured bytes, never provider credentials or the authority to modify a workspace. Ordinary model execution and observation do not share a cancellation signal.

All online **Passeur administrative** mutations use the existing service authority. This does not claim that all Git commands or file edits from external tools are intercepted.

### D2. Reuse task identity and Git, rather than create proposal versions

A managed work record references its durable task/parent identity and admitted commit. An external writer has a verified workspace registration and parent; it does not acquire fictional native liveness. Use a small work identity for announced/external activity where no task exists yet. A task or registration is not proof of sole authorship of every observed edit.

Every report contains independent pairs: `TASK A: INPUT A0 → OBSERVED A7`; `TASK B: INPUT B0 → OBSERVED B4`. Display a common input only when it really is the same identified input. A current integration target, if shown, is a separate role. Never compare line coordinates from unrelated bases as though they shared one coordinate system.

Full OIDs and object-format identity are retained; display abbreviations are unambiguous within the report. `git blame` is not attribution authority. The handoff identity is the full existing Git commit associated with its task or registered work. Captured working bytes remain separately identified observations.

### D3. Separate exact commits from advisory working captures

Commit observations read exact tree/blob objects. A working capture identifies the registered workspace generation, observed HEAD anchor, captured file bytes and content digest, path/mode, capture sequence, and limitations. It is not a commit or an atomic repository snapshot. Its captured bytes, not the live path, are parsed and used for any returned excerpt.

Distinguish absent-in-commit, missing-during-capture, unreadable, unsupported representation, parse-incomplete, and present. A concurrent save or rename can make capture unavailable; bounded retry is permissible only for this read-only observation. A stable-looking stat or two matching reads is not a transaction proof.

Use qualified Linux handle-based reads, verify the opened object's type and containment before reading contents, and retain the descriptor through capture. Symlink targets are not followed for source analysis. Committed symlink and submodule entries are reported as mode/object changes. No implicit object fetch, textconv, external diff, merge driver, project preprocessing, or build script executes during observation.

### D4. Report written declarations, not inferred meanings

Extract native-language declaration fragments: names and enclosing syntax, parameter order/names/patterns, explicit type annotations, explicit result declarations, receivers, visibility/modifiers, generics/constraints, directly changed named fields/types, imports/exports, and supported template regions.

Use `not_declared` for missing annotations. Do not expand a named type. If that type's declaration changed, report its own direct difference separately. Literal syntax within a type is retained as syntax; argument values, computed runtime values, body values, and default-expression values are not included by default. Changed default expressions receive a marker; exact source is available only through authorized detail retrieval.

Body-only changes and unmapped source changes remain visible as `body_changed`, `region_changed`, or incomplete coverage. A signature-only projection must not hide an edited implementation. Direct child changes do not automatically become a claim that every enclosing class/module was directly edited. No output labels a change as a behavioral conflict, breaking API, compatible, safe, or semantically urgent.

### D5. Conservative correspondence, not universal symbol identity

Use per-source declaration keys and deterministic matching within explicitly paired files. Match unchanged unique declarations first, then unambiguous same-name/kind/enclosing-syntax candidates. Handle overloads, forward declarations, duplicate names, nested/anonymous functions and changed containers explicitly.

A match is `unique_syntax_correspondence`, not semantic identity. When correspondence is uncertain, show additions/removals and an ambiguity marker. Cross-file movement or renaming is a candidate relationship unless established by the selected exact-content/lineage rule. Parent scope names, line numbers, or fuzzy scores alone never establish identity.

The report remains useful without forcing every change into a function. Parse `ERROR`/missing-node coverage and unrecognized changed regions are propagated. A temporarily unparseable declaration is not reported as certainly deleted.

### D6. Tree-sitter is the parsing mechanism; extraction is a qualified product contract

Use the established Tree-sitter engine and pinned upstream grammars. The preferred production backend is the official native Node binding in a dedicated helper, with grammar modules packaged for the admitted Linux/Node target. M0 must qualify native loading for the required grammar set and representative extraction. Grammars without a usable package may use the upstream-generated parser/scanner and a reviewed build-time binding; this is packaging, not a new handwritten parser.

The selected production path is native Node Tree-sitter in a local helper process. Package native grammars/scanners for the admitted Linux/Node ABI. Runtime operation needs neither a browser nor a web application. A native packaging failure is a named qualification issue; resolve it through the qualified native binding/build path or re-plan the affected support claim. No second parser backend is shipped.

One built-in language catalog maps dialects to packaged parser/query/extractor artifacts. A manifest binds upstream commit, integrity, license, runtime ABI, generated artifact identity, extraction version and fixtures. Grammar existence, a successful parse, or a tags query alone does not satisfy argument/return extraction. No runtime downloads or compilation. Compiler APIs and language servers remain excluded even if they would fill a coverage gap.

### D7. Changed-content monitoring with explicit coverage

Monitor registered work, including qualified managed work while all clients are absent. Use filesystem notifications as invalidation hints plus bounded inventory reconciliation at attach, explicit refresh and lifecycle/checkpoint boundaries. Dirty roots with incomplete event coverage receive a qualified low-frequency sweep. Debounce and scan intervals schedule observations; they never govern task life, ownership, or release.

Use Git change discovery first, then parse changed or explicitly watched contents. Share immutable extraction caches across identical content/dialect/parser/query inputs; keep workspace-specific scopes and matching outside that cache. Use one analysis slot initially with a bounded queue; coalesce superseded file jobs and record their completion class. Add parallel slots only against an admitted measured budget.

Late results cannot overwrite a newer workspace generation or observation. Event loss yields a coverage gap and rescan, not a clean bill of health. Intermediate edits between samples may be missed; the guarantee is qualified observation of captured states, not audit of every keystroke. No repeated whole-repository compilation, quadratic all-agent comparison, or unbounded full graph reconstruction.

### D8. Explicit relevance and quiet-by-default delivery

Index declared areas, changed paths, declaration anchors and explicit watches. The default rules surface new declared file overlap during preflight; runtime notices require a watched declaration/region or both tasks changing a corresponding declaration/region. Broad directory overlap and unresolved name matches are queryable context, not repeated interrupts. Optional lexical reference hints are labelled unresolved and do not imply a compiler-resolved dependency.

A changed observation updates stored evidence first. Delivery happens to authorized parents through a pull cursor and bounded notices on the new coordination-aware response surface. No default autonomous model wake-up, subagent broadcast, explanation request, test invocation, or evaluation call. Parent-requested notes may explicitly address another parent; the service merely routes attributed text.

Coalesce by work/subject/recipient, notify once per materially changed compact evidence revision, and permit suppression/snooze through explicit parent settings without deleting evidence. Returning to the input state creates a resolved/reverted observation where relevant. Cursor gaps and service/index generations are explicit; absent notifications never imply no relevant work.

### D9. Announce before starting without mandatory bookkeeping

A direct submit reuses its assignment for an announcement; the new default remains advisory and does not require a second model-authored description. A parent wanting pre-start coordination can announce once, inspect overlap, then submit by announcement reference without repeating the prompt. The service atomically registers the announcement and snapshots relevant existing activity. New relevant overlap before a gated submit produces an unadmitted `coordination_changed` response; unrelated board changes do not force reapproval.

Expected areas, context files, watches and allowed write paths retain separate meanings. Preserve existing allowed-path checking and report its actual enforcement level. This plan adds no file-permission or exclusive-write grant machinery. One independent registered writer per physical workspace; other writers use other worktrees. External workspace registration does not start, stop, sandbox or clean up its host.

Announcements are not tasks and hold no inference slot. They survive disconnect as explicit records until withdrawn, linked, or owner/operator-retired. A stale announcement may be marked owner-unobserved, never silently deleted by age.

### D10. Scoped notes and one reconciliation lead per target

Support small attributed notes attached to work, a structural subject or a reconciliation case. Reuse assignment intent without semantic paraphrase. An agreed constraint is a parent-authored statement with explicit acknowledgments from named parties, not an inferred contract. Source comments and notes are untrusted content, not executable instructions or permission.

Maintain at most one active reconciliation case per canonical repository/full target ref. One parent holds its leadership generation. Input commits and target observation are revisioned fields of that case, not its identity: changing A7 to A8 cannot create a competing ownership slot. Work continues in other worktrees. No timer releases the claim.

Claim/update/release are atomic, authorized, idempotent operations. Handoff requires current-owner consent or explicit operator adoption with expected generation. A losing claimant sees only authorized owner/case metadata. Leadership does not grant control over another task or permission to modify any ref. Target changes stale the selected input set; they do not silently create a new case or stop workers. Parents perform reconciliation and integration externally.

### D11. Keep persistence proportional to the selected invariants

Extend the existing store's atomic-publication mechanism. Use one bounded repository coordination-control aggregate for the coherent admission/registration/claim/acknowledgment invariant, with revision-checked serialized updates. It contains small control metadata and bounded attributed notes, not syntax trees, whole diffs, duplicate task histories or Git source versions. Immutable report artifacts and disposable parser/index caches are separate.

This selects atomic JSON publication, not SQLite. Each authoritative control transition fits one atomic record replacement; there are no cross-record SQL-like transactions to emulate. If real cardinality/latency or independently required transactions invalidate that contract, re-plan this storage decision rather than invent a transaction engine. Every started write is owned and observed through its publication outcome.

Announcement-to-task linkage is recorded in the new durable request before native startup; interrupted linkage is reconciled by exact work ID/request key and existing accepted task, never duplicate submission. Metadata changes do not rewrite old task requests or results. Notes/claims/receipts are not disposable caches. Cache eviction may lose detailed working-buffer history only under the declared availability contract and must return `detail_unavailable` or a cursor gap.

Existing task refs/disposition protect task work. An active case that names a task result prevents Passeur-owned retirement until the case releases it or another exact protecting ref is verified. This is a case-to-resource check, not a transitive proposal pin graph. External edits/ref deletions remain outside Passeur's prevention guarantee.

### D12. Failure, resource and compatibility behavior

Analysis failures degrade observation only. They do not cancel accepted inference, grant permission, become semantic success, or trigger the native-stop safety freeze. Genuine loss of control-store authority blocks dependent coordination mutations; known healthy tasks can continue saving execution evidence through their existing owner.

Analysis is pure disposable computation: explicit cancellation/supersession or a declared analysis-only resource limit may stop its helper job, with an incomplete/superseded result. No such condition stops a coding worker. Capture buffers, parser allocations, queue entries, helper processes, watchers, waiters and notifications have bounds and disposal owners. Required controls remain available under observation saturation.

Introduce independently versioned coordination contracts and new submit/observation projections where semantics change. Retain baseline submit v1 and historical request/result bytes as uncoordinated/legacy-readable behavior; do not add fields to strict old responses. Use explicit coordinated request v5 only for the new linkage, retaining unchanged assignment v3 and result v4 meaning unless the implementation proves another actual contract change. Update all affected decoders and admission/result checks together.

Installed/runtime status states parser-bundle identity and per-language qualification separately from service/task readiness. Failure to load grammars does not hide the MCP catalog or disable task result retrieval. Controlled cutover uses compatible builds and the same repository/state binding; old binaries cannot be assumed safe writers of new authority. Unexpected durable records require an explicit supported-state decision; they are not deleted or treated as an empty store.

## 3. Required foundation corrections

Before accepting the end-to-end path, remove the unrelated dirty-source precondition for exact-base isolated work; reproduce and correct cancelled execution signals leaking into stable delivery/artifact collection; and replace broad administrative locking around Git hooks with durable resource intent plus narrow state transitions. Preserve authority checks and confirmed-stop requirements.

Also ensure analysis and observer saturation cannot block existing input/cancellation/recovery. These are bounded invariant families, not opportunistic repository cleanup. The inspected source supports the first finding and the cancellation path; runtime reproduction is still required. The shared-service plan retains its native/installed acceptance ownership.

## 4. Milestones

M0 is `Blocked`; M1–M5 remain `Planned`. F0/F1 are limited internal increments, not accepted replacements for those milestones. [Implementation map](reports/implementation-map.md) supplies each exact write set and shared-file owner. New directly affected paths are recorded before editing; re-plan only when they change scope, authority, risk, composition or evidence, not merely file count.

### M0 / M0-S1 — Baseline and boundary admission

**Goal:** establish sufficient concrete facts for the selected design. **Writes:** plan package; `AGENTS.md`; only affected status/authority/ledger/issues sections of the shared-service plan. Production read-only.

Confirm source/status, source/consumer inventory, modern dialect matrix, package licenses/ABI, parser child loading for all candidate grammars, Svelte snippet argument extraction path, descriptor capture safety and native host constraints. Reproduce the foundation paths with disposable resources. Qualify the selected native binding and generated scanner path; dependency installation and build-time provisioning remain explicitly authorized. Select exact parser/runtime/artifact pins and initial performance budgets; do not leave the production manifest with placeholders. Missing live accounts block their acceptance claims, not independent deterministic work.

**Gate:** no unresolved ownership/schema/capture contradiction; M1 paths, parser/backend decision and source identities are concrete. **Re-plan:** unsafe capture, unavailable required grammar packaging, compiler required for the selected extraction, materially changed source, incompatible existing new-plan state.

### M1 / M1-S1 — Git-to-structural-report vertical path

**Goal:** real CLI/MCP clients retrieve exact per-task structural reports through the shared service/helper using Rust and TypeScript first. Implement source identity/capture contracts, helper protocol, declaration matching/reporting, basic work linkage, report storage, versioned public projection and the directly affected foundation corrections. Keep unfinished language coverage visibly unqualified.

**Gate:** real Git/source buffers → real helper parser → validated report → actual transport consumer; common/different bases, add/add, body-only edits, ambiguous matches and cancelled collection scenarios pass. **Re-plan:** source identity lost at a boundary, parser work blocks supervision, attribution inferred from blame, result changes with mutable paths.

### M2 / M2-S1 — Complete required language surface

**Goal:** all thirteen requested entries satisfy the qualification matrix, including Svelte 5 embedded scripts/snippets and JSX/TSX. Add language-specific extraction, source-offset mapping, default-value masking, error coverage and fixtures through the same parser contract. Share JS/TS machinery where it owns the same syntax; preserve dialect differences.

**Gate:** every required row and its named modern constructs passes independent source-to-output checks; missing coverage remains a failed required claim, not file-level acceptance. **Re-plan:** source-to-output oracle is derived from the extractor, syntax requires semantic evaluation, or a new backend/grammar fork changes packaging ownership.

### M3 / M3-S1 — Preflight and low-noise live observations

**Goal:** parents see relevant pre-start overlap and runtime structural changes without additional worker/model calls. Implement announcement reference submission, watcher/inventory reconciliation, changed-content cache, generations, inverted routing index, explicit watches, durable snapshots/cursors, coalescing and query-first delivery.

**Gate:** concurrent announce races, differing source views, delayed parse, event loss, repeat saves, unparseable edits, disconnected parents, and observer saturation produce the specified results. Demonstrate zero added inference/evaluator calls for monitoring. **Re-plan:** all-agent scans or whole-repository reparse is required on every edit; notification requires a fabricated host wake-up; monitoring changes task outcomes.

### M4 / M4-S1 — Parent notes and reconciliation ownership

**Goal:** two independent parents can coordinate one target without competing reconciliations. Add authorized scoped notes, explicit acknowledgment, one lead per target, generation-checked transfer/recovery and exact-input case updates. Support external writers without claiming process supervision. Add case-aware resource-retirement checks.

**Gate:** simultaneous claims yield one lead; new input commits stay in the same case; stale/disconnected owners cannot silently regain authority; ordinary tasks keep running; private details remain private; no merge or code-writing effect occurs. **Re-plan:** task adoption grants target privileges; claim identity is input-hash-only; authorship is inferred; source rewrite required to update a case.

### M5 / M5-S1 — Installed workflow, performance and acceptance

**Goal:** complete two-parent and three-or-more-worker workflows on the qualified installed runtime, with all languages packaged and accurate skills. Finish explicit version/configuration migration, actual host retrieval/reconnect, parser isolation and resource evidence, independent review and final resource accounting.

**Gate:** all required claims below satisfied; affected inherited lifecycle claims have their required evidence; full pinned checks and installed artifact tests pass; final material candidate reviewed independently before merge; every plan-created resource accounted for. **Re-plan:** representative workload exceeds admitted budgets, native/installed evidence contradicts simulations, or required consumers still use rejected representations.

## 5. Objective acceptance

All statuses are initially `pending`; evidence links are procedures in [verification](reports/verification.md), not results. Compound claims require every part. Source completeness alone yields `Implemented`; execution/awaiting environment yields `Verifying`, never premature `Accepted`.

| ID | Observable criterion | Kind | Environment | Mode | Status | Procedure |
|---|---|---|---|---|---|---|
| SC01 | Independent inputs/observed versions and target roles remain exact across common/different bases, adds and retries | contract + integration | representative real Git/store | automated | pending | V01 |
| SC02 | Attribution identifies observed work/task and parent, including imported commits and external writers, without invented authorship | contract + integration | representative | automated | pending | V02 |
| SC03 | Parameters/results/modifiers/direct types are extracted as written; named types and runtime values are not inferred | contract | representative pinned parsers | automated | pending | V03 |
| SC04 | Every required language/framework row, including modern Svelte 5 and React syntax, passes its independent qualification cases | contract + release-artifact | representative selected dialects/bundle | automated | blocked | V04 |
| SC05 | Bodies, unmapped regions, parse errors and ambiguous correspondence remain visible and bounded | contract + integration | representative parsers | automated | pending | V05 |
| SC06 | Captured bytes/ranges are coherent for that observation; unsafe paths and mutable-source substitution are rejected | system + contract | representative Linux/filesystem | automated | pending | V06 |
| SC07 | Monitoring is incremental/bounded; late results and event loss cannot produce false current/complete reports | system | representative real helper/watchers | automated | pending | V07 |
| SC08 | Relevance, coalescing, cursors and quiet delivery produce zero routine inference/evaluator calls or subagent broadcasts | integration + system | representative process boundary | automated | pending | V08 |
| SC09 | Announce and gated start handle concurrent parents without a check/register race or duplicate task execution | integration + contract | representative real store/Git | automated | pending | V09 |
| SC10 | Notes and structural details obey sharing policy; statements/acknowledgments cannot manufacture permission or agreement | contract + user-workflow | representative plus required-real host for adoption | either | pending | V10 |
| SC11 | One target case has one lead; input revision changes do not bypass it; explicit transfer and restart preserve ownership | system + contract | representative real processes/store | automated | pending | V11 |
| SC12 | Analysis failure, silence/disconnection, overload and long hooks preserve task lifetime, controls and final evidence | system | representative plus inherited required-real adapters | either | blocked | V12 |
| SC13 | Exact commits needed by active cases remain protected during Passeur-owned retirement; external workspaces are not deleted | integration | representative real Git | automated | pending | V13 |
| SC14 | Old task/result semantics remain readable; new operation decoders, installed cutover and rollback limits are truthful | contract + release-artifact | representative historic fixtures/artifact | automated | blocked | V14 |
| SC15 | End-to-end two-parent/three-worker workflow is usable with updated skills and no required routine coordination narration | user-workflow | required-real installed host and qualified adapters | either | blocked | V15 |
| SC16 | Measured cold/warm, multi-worktree, memory, IPC and model-context budgets meet the admitted performance contract | system | representative named machine/corpus | automated | blocked | V16 |
| SC17 | Staged scope, routed standards, full pinned checks, independent final review and plan-resource disposition are complete | contract + release-artifact + user-workflow | representative plus required-real independent reviewer | either | blocked | V17 |

## 6. Standards, implementation discipline and stopping rules

Read Core then Router at the adopted revision and follow selected `Requires`; the exact route and exclusions are in sources/routing. Keep each invariant with its owner, fully decode incoming/outgoing/persisted variants, preserve historical meanings, and update the affected producer/consumer family with its tests. Select independent test oracles for extraction and disclosure rather than snapshots regenerated from the implementation being tested.

One lead owns schemas, shared store/service code, package locks, parser-bundle manifest, generated contract inputs, active plan state and integration. Language extraction/fixture work can be delegated after the common contract is stable, with nonoverlapping primary write sets and serial integration. Product concurrency does not automatically select the Concurrent Plan Integration workflow profile; select it if the actual development workflow admits outstanding authorizing proposals against mutable shared plan state.

Use a branch such as `feat/structural-change-coordination`, with the lead integrating to `main`. This isolation is justified by IPC/persistence/native packaging risk. The request to write this plan is not permission to execute it, use accounts, provision dependencies, edit host configuration, push, delete worktrees, bypass hooks or rewrite history. An implementation invocation names this canonical path and `start` explicitly.

Each slice inspects repository status, states exact writes and tests, protects unrelated changes, verifies its coherent outcome, reviews the staged diff, then uses ordinary conventional commits. No prescribed commit count. Independent review is at the completed candidate/final PR boundary, not every worker completion or commit.

Re-plan only for a material design/authority/support/consumer/evidence change, a repeated invariant-family defect, or measured propagation/cost contradicting admission. Investigate only a named decision-changing uncertainty with a cheapest adequate method and observable stop. Passing a parser smoke is not adequate language coverage; passing tests is not evidence of semantic compatibility outside the stated claims.

**Current blockers:** I-ENV-01 prevents native parser/dependency qualification and full application verification in this environment. The connected reader supplied a byte-verified source subset, not a complete Git checkout. Real native/host evidence, independent external review, and representative performance qualification also remain outstanding. These limits are not replaced by the focused F0/F1/F2/F3 checks.

## 7. Final acceptance and compaction

Accept only after all non-deferred milestones are `Accepted` or explicitly superseded, SC01–SC17 are satisfied, required inherited claims are proved, changed meanings receive affected re-review, and plan-created branches/worktrees/processes/artifacts have recorded disposition. Retain exact head reachability and protection evidence for cleanup; inspect only plan-created resources.

Move durable reporting/coordination contracts into `docs/structural-reporting.md` and `docs/coordination.md` under their admitted write owner, then compact this plan to a decision/evidence index. The new design provides factual coordination support; it does not certify delivered project code.

## Implementation admission and bounded re-plan — September 21, 2026

The maintainer explicitly requested implementation of Plan 2A and delivery of changed files. Operation `start` is admitted for this canonical path. The lead implementer for this working copy is the current implementation session. Plan 2B is included for reference only; no evaluator code, account use or source disclosure is authorized.

Connected repository reads confirmed baseline `f9a7c5d2d314580e5f7849982cf158397f9c11de`. Direct GitHub cloning and npm registry access fail with DNS resolution errors in this execution environment. The local Node Tree-sitter binding and required grammar artifacts are absent. The available TypeScript is 5.8.3 rather than the pinned 5.9.3. These are actual M0 qualification blockers, not permission to invent parser results, publish a guessed grammar lock, or claim full acceptance.

Independent, reversible work is split out without weakening the requested target:

- **F0-S1:** reproduce and fix the three inherited workspace-lifetime defects using verified baseline source, real disposable Git repositories/hooks, and a controlled worker/store boundary. Production write set: `src/core/coordinator.ts`, `src/workspace/worktree.ts`. Test: `tests/core/structural-foundation.test.mjs`; its test-only support `tests/fixtures/structural/foundation-store.mjs`. No execution, result, input, or persisted schema changes.
- **F1-S1:** implement native-independent captured-source identity, declaration correspondence, bounded report formatting, and notice materiality as internal components. Production write set: `src/observation/model.ts`, `source.ts`, `match.ts`, `report.ts`, `src/coordination/notices.ts`; test: `tests/core/structural-primitives.test.mjs`; compilation discovery: `tsconfig.core.json`. The model is in-process only, not an accepted public/IPC codec. No incomplete parser or coordination tool is advertised.
- Both slices may update this plan's ledger/issues, this re-plan, `reports/implementation-evidence.md`, `reports/source-integrity.json`, `reports/focused-test-results.txt`, `reports/environment.txt`, the implementation-map inventory, and `docs/structural-reporting.md`.

The material reason for F0/F1 separation is independent verification while the native prerequisite is unavailable. F0/F1 completion does not satisfy M1's real parser/transport path or M2's language claims. The next native slice remains M0-S1; its actual dependency/ABI/package evidence is still required before that path is advertised. Original SC01–SC17 claims and all thirteen required language entries remain in force.

The original ownership decomposition is retained: task lifecycle remains with the coordinator, source capture with its observation owner, and pure matching/rendering with the observation implementation. F1 introduces no execution scheduler, persistence database, public compatibility promise, code writer, or parser implementation. Deleting these internal components would move the same planned source/correspondence/formatting logic into the eventual helper/transport owners; their tests prove only their selected in-process and filesystem contracts.

### Delivered increment state

| Increment | Source state | Evidence and remaining acceptance |
|---|---|---|
| F0-S1 | Implemented | Seven controlled coordinator/workspace tests pass; three reproduce failures against the verified baseline. Real Git and hooks execute; the native worker and store are test-controlled. Full pinned suites and external review remain required. |
| F1-S1 | Implemented internally | Twenty-six source/matching/reporting/materiality tests pass. New modules and their real import closure pass strict TypeScript 5.8.3 checking with available Node declarations. This is not the pinned application check or parser/transport qualification. |
| M0-S1 | Blocked | Native Node Tree-sitter/grammars and pinned dependency resolution unavailable. Source-to-output language evidence cannot be run. |
| M1–M5 | Planned | Helper/parser, CLI/MCP path, full language coverage, watchers, verified admission/task linkage, public notes/claims, retirement guards, installation and acceptance remain. F2 implements internal coordination controls/store; F3 adds the real-Git source gate. Actual service/task/retirement consumers and native analysis remain pending. |

The native path resumes after M0 qualification and an owned transition back to `Active`. Independent work requires a bounded re-plan like F2, with exact source scope and evidence; a `continue` request alone does not erase a Blocked state. Review actual source drift before admitting further implementation. `verify` becomes applicable only after the complete objective has actually reached `Implemented` or `Verifying`. Plan 2B stays an unselected reference, not a second implementation authority.

## F2 delivered increment — September 22, 2026

Baseline `43e3a78a1736539e0fd565899c1bd1c52eae9b42` incorporates the maintainer's
F0/F1 commit. The user's explicit continuation request was admitted through
[the F2 re-plan](reports/f2-admission.md): Blocked → Active for the independently
verifiable internal owner, without treating the native blocker as resolved.
F2 is now `Implemented` with scoped local evidence; the overall plan returns
to `Blocked` because the remaining selected path is unavailable here.

**Goal:** implement the real-file coordination owner for metadata registration,
sharing, attributed notes/agreements and stable target leadership.
**Exact writes:** [F2 admission](reports/f2-admission.md).
**Gate exercised:** 52 new real-file/control tests and 26 existing observation
tests pass; strict checking of their actual module closure passes with the
available, non-pinned toolchain.
**Changed contracts:** new internal/persisted coordination v1; one unchanged
atomic JSON primitive extracted and re-exported for existing TaskStore consumers.
No existing task, result, CLI, MCP or IPC schema is changed.
**Remaining gate:** service authentication/composition, verified source/task
linkage, operator adoption, target/ref checks, retirement reservation, native
parsers, pinned full checks, installed host and independent review.
**Re-plan trigger:** those consumers require new authority or transaction
semantics not represented by this internal contract.

See [internal coordination](../../coordination.md) for implemented behavior,
[F2 verification](reports/f2-verification.md) for exact proof boundaries, and
[the current eight-probe delta](reports/design-admission.md#f2-composed-design-delta)
for ownership and deletion analysis. SC09–SC15 remain unsatisfied: internal
store tests do not establish the actual user workflow. No automatic parser
substitute, evaluator, integration operation or public stub is introduced.

## F3 delivered increment — September 22, 2026

**Goal:** bind source-dependent coordination commands to real repository,
worktree, commit/ancestry and target observations while preserving authority
and metadata recovery. **State:** Implemented, scoped local verification;
full objective remains Blocked. **Writes:** [F3 admission](reports/f3-admission.md).
**Gate exercised:** 42 new real-Git/control tests plus 78 retained tests pass;
strict actual-import-closure checking passes on the available non-pinned tools.
**Changed contract:** new internal repository command projection; persisted
v1, task/result meanings and public CLI/MCP/IPC remain unchanged.
**Remaining gate:** trusted host/resource composition, managed task/announcement
linkage, operator recovery, retirement reservation, native grammars/extractors,
full pinned checks, live host workflow, performance and independent review.

[F3 verification](reports/f3-verification.md) supplies the evidence limits;
[the F3 design delta](reports/design-admission.md#f3-composed-design-delta)
records all eight probes. Public tools remain unregistered. Git observations
are not source pins, live-editor fences or a cross-store transaction. Source
loss/saturation does not disable metadata closure, revocation, settlement or
historical receipt lookup. Plan 2B is retained unchanged and unselected.


## F4 delivered increment — September 22, 2026

**Goal:** compose repository-bound controls and the durable store into one
service-owned metadata session with complete request/reply decoding, explicit
authorized initialization, bounded current-authority reads, retained command
receipts, independent control capacity and observed shutdown.
**State:** Implemented with scoped local evidence; objective remains Blocked.
**Writes and admission:** [F4 admission](reports/f4-admission.md).
**Gate exercised:** 55 new tests plus 120 retained regressions pass, including
actual Unix-socket transport in separate processes and all selected cases in a
source path containing spaces. The compiler check uses available, non-pinned
tools and the real selected import closure.
**Preserved meanings:** coordination state v1, task/result records, Git code
identity and external integration. No public command is registered.
**Remaining gate:** actual runtime election/actor/resource authority,
CLI/MCP projection, task linkage, source observation/parser qualification,
notification delivery, retirement ordering, installed workflow/performance,
full pinned checks and independent review.
**Re-plan trigger:** the actual consumers require different permission,
publication, capacity or lifetime facts than this tested session represents.

See [F4 evidence](reports/f4-verification.md),
[request/session contract](../../coordination.md#service-owned-metadata-session-f4)
and [all eight design probes](reports/design-admission.md#f4-composed-design-delta).
A fixture listener is not a production service fallback. Initialization needs a
runtime-owned permission callback; a valid request cannot grant it. Detached
observers do not abandon admitted operations. Metadata readiness does not imply
parser/provider/source readiness. Plan 2B remains unselected and unchanged.
