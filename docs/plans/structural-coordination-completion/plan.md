# Passeur: complete code-only structural coordination

## Current authority

| Field | Value |
|---|---|
| Plan status | **Active** — R0-S1 started under the explicit `start` invocation of September 22, 2026 |
| Acceptance status | **open**; SC01–SC17 remain unsatisfied and native/public/installed and real-host evidence is incomplete |
| Selected design | Plan 2A, code-only structural coordination |
| Current phase | R2 — all-language extraction; disjoint R3 admission implementation may proceed concurrently under the R1 gate |
| Exactly one next integration slice | **R5-S1 — clean installed native artifact and migration/cutover acceptance** |
| Canonical path | `docs/plans/structural-coordination-completion/plan.md` |
| Initial implementation operation | **start**; subsequent **continue** while Active; **verify** from Implemented/Verifying |
| Examined source | `MrScripty/Passeur` at `2de20c756a375c726311767cd78b968c1161fdad` |
| Standards authority | `MrScripty/Coding-Standards` at `366c1d90a24bbfb50973f62b155a5f3396c0f107` |
| Prepared | September 22, 2026, America/Vancouver |
| Product/acceptance owner | Passeur maintainer |
| Implementation/shared-source owner | This implementation session for admitted repository writes and SC16 engineering limits; maintainer retains product and acceptance authority |
| Composed-design review | Applicable; all eight probes in [design and standards](reports/design-and-standards.md) |

[Execution ledger](execution-ledger.md) owns dated evidence, [issues](issues.md) owns findings, [implementation map](reports/implementation-map.md) owns path authority, [native qualification](reports/native-language-qualification.md) owns the language population, [SC16 resource evidence](reports/resource-behavior.md) owns selected limits and measurements, and [verification and release](reports/verification-and-release.md) owns procedures. These documents refine this plan rather than create another task lifecycle.

This plan owns the **remaining** Plan 2A implementation and acceptance work as of the R0-S1 `start` invocation. It does not restart completed F0–F9 work. The old plan is Superseded for remaining planning authority only; its ledger/reports, inherited contracts, and unsatisfied claims remain historical evidence. R0 recorded the [receiving environment](reports/receiving-environment.md), [baseline checks](reports/baseline-checks.md), [native dependency qualification](reports/native-dependency-qualification.md), and [claim status](reports/claim-status.md). Under `continue`, R1 owns the parser bundle and real vertical report. The evaluator-assisted Plan 2B remains unchanged and unselected.

## 1. Starting point and completion objective

F9 is committed. Its repository integration report records `npm run check` and the full suite passing: **475 core, 40 native, 100 frontend tests**. It also records a correction to a new test's native-coverage fixture; preserve that corrected fixture. These are prior-candidate results, not evidence that the remaining feature is complete or that this author reran the suite. [Sources S1–S3](reports/design-and-standards.md#source-register).

Already implemented: shared durable execution; exact source/workspace checks; internal structural comparison/report primitives; external and explicit managed-work registration; sharing, attributed notes, agreements, target leadership and operator recovery; runtime/authenticated transport/CLI/MCP metadata consumers; metadata schema 3; selected-managed-result retirement exclusion. F9 requires explicit enrollment after a task workspace exists. Native extraction, automatic announcement/submission linkage, continuous structural observation, parent notice delivery, complete native packaging and objective acceptance remain.

The required completed workflow is:

**announce or submit → retain exact input/task identity → execute independently → observe changed source → extract syntax in a native helper → expose bounded task-attributed differences when relevant → parents coordinate and integrate externally → safely account for resources.**

The ordinary path remains submit, work, result, external integration, resource disposition. Extra narration from workers is not required.

### Preserved product boundaries

Git owns code contents and versions. Parent agents own development instructions, semantic interpretation, tests, reconciliation decisions and integration. Passeur owns its service, observation, authorized metadata and owned-resource disposition. The production observation path uses native Node Tree-sitter, not compilers, type checkers, language servers, inferred types, reference-type expansion, macro execution, a semantic dependency graph, evaluators, automatic project builds, patch application, or new reasoning loops. There is no live shared-source editor, exclusive file lease system, second daemon/scheduler, separate proposal-version database, or new publication authority.

Initial service support remains qualified Linux/local filesystems. Support claims name the actual CPU architecture, libc and Node/native compatibility set. Do not infer portability from TypeScript. Required structural coverage is all thirteen entries: Rust, TypeScript, JavaScript, Python, Lua, Kotlin, Zig, C#, C, C++, Odin, Svelte 5 and React through JSX/TSX. Modern syntax is selected and tested explicitly; special support effort for versions predating January 2025 is unnecessary.

## 2. Decisions governing the remaining implementation

### C1. One observation owner; reuse existing execution and metadata owners

Compose a service-owned observation manager in `RepositoryRuntime`. It owns captures, helper work, report storage, watcher reconciliation and notice publication. Reuse `CoordinationService`/`CoordinationControl`, TaskStore, task controls and the existing disposition guard. Public operations remain projections through the existing authenticated listener and frontend.

The initial parser helper has one active analysis slot and a bounded queue. It receives captured source buffers and fixed dialect/extractor identities, not paths to execute, parent credentials, provider sessions or arbitrary module names. Use Node child-process IPC with a small closed versioned message contract and explicit buffer/message bounds. Native work is isolated from the service event loop. Resolve packaged modules from the installed bundle, not the analyzed repository.

Model code owns source/extraction meaning; the helper protocol owns transport and job correlation. Reconcile the existing internal `observation/model.ts` with the new runtime decoders instead of copying it into another semantic authority. The parser bundle manifest references independently owned grammar, extractor, protocol and artifact identities; it does not become an umbrella version for every concern.

### C2. Accurate source pairs and syntax-only reports

Each task has its own **INPUT** and **OBSERVED** source identities. Retain full OIDs and object format. A shared input is rendered once only when identical; an integration target is a separate role. Supports different bases, add/add, removal, imported commits and more than two participants. Attribution means observed in this work/task, not sole authorship inferred from blame.

For example, a valid compact report may show a common `INPUT @ B0`, `TASK A @ A7` and `TASK B @ B4`, each with its own declaration. A different-base report contains two independent pairs rather than one manufactured baseline.

Extract written names/scopes, parameters/patterns/order, explicit annotations/results, modifiers, receivers, generics/constraints and directly changed types/members. Unwritten results are `not_declared`. Preserve body-only, default-expression and unmapped-region change markers without including their values by default. A directly edited named type is its own change; do not calculate propagated effects on users of its unchanged name. No output claims semantic safety, incompatibility or urgency.

Correspondence is conservative syntax matching. Duplicates, overloads, moved/renamed code and incomplete parses retain ambiguity or unmatched results. A returned syntax tree is not proof of complete extraction. Qualify `ERROR` and missing-token detection, including declaration-local coverage; unrelated parse damage need not hide valid declarations elsewhere. Full source differences remain authorized on-demand detail, not routine model context.

All public source ranges are half-open UTF-8 byte intervals. Qualify the native binding's actual index/column units before mapping them. Do not assume JavaScript string indices, parser columns and byte offsets are interchangeable. Preserve BOM, CRLF, combining text and non-BMP characters; embedded-source mappings exclude any synthetic wrapper bytes. Rendering/redaction never becomes the origin for source coordinates.

### C3. Exact capture, authorization and retention

Reuse the source reader's no-follow, local-object, explicit-size and byte-identity protections. Working captures are identified per-file samples, not atomic repository snapshots. Report absence in an immutable tree separately from missing/unreadable/incomplete working content. Keep symlinks/submodules as metadata changes. Avoid filters, fsmonitor commands, textconv, external diff drivers, implicit fetch, preprocessing or repository code execution.

A report/detail request resolves an authorized work/task and a captured source identity; it does not accept an arbitrary filesystem path as read authority. Recheck current access on every page, detail fetch and notice pull, including after ownership transfer. Legacy metadata sharing remains metadata-only. Structural reports and raw-source details require an explicit source-evidence grant with the selected disclosure scope and recipients, issued by the current authorized source owner. Use the existing per-work authorization owner rather than a second general permission system. Revoke or invalidate stale source grants when their task-control/workspace generation changes. Cache keys establish content identity, never permission.

Bound report pages, captures, cache bytes, stored reports, notices and cursor state separately from the small authoritative control aggregate. Immutable source artifacts are published before a durable notice points to them. Failed notice publication may leave a reclaimable unreferenced artifact, not a fabricated delivered notice. Eviction returns explicit `detail_unavailable` or a gap. Never regenerate an old working report from whatever the path contains now. Committed evidence may be reconstructed from retained local Git objects without requiring the old worktree to still exist.

### C4. Native helper lifecycle and failure containment

Every queued/inflight job has an owner, input digest, helper generation and terminal outcome. Latest workspace/capture generation wins. Reuse results for identical content/dialect/grammar/extractor inputs; keep mutable incremental trees local to the helper/job owner. Index workspaces separately so branches never share a mutable source view.

Helper startup/loading, malformed replies, crashes, output overflow and unsupported artifacts yield bounded observation outcomes. A failed pure analysis job may be explicitly cancelled or stopped by its declared analysis-only budget. Coding workers, permission requests and repository ownership never inherit that signal or budget. A V8 heap flag alone is not proof of a native-memory bound; qualify the selected native-memory containment/observation mechanism and describe its limits.

Close helper admission, account for jobs, observe helper exit and dispose captures/watchers during shutdown. Metadata history or unacknowledged notices alone need not keep an idle process alive forever. An external registration grants no process-supervision claim: it may be observed while the service exists and on explicit refresh; last-client loss need not keep a service alive solely for an external editor. Managed tasks retain the inherited service lifetime and observation obligations. Reattachment explicitly reconciles the missed interval.

### C5. Pre-start announcements and durable submission linkage

Introduce a separately versioned coordinated submission envelope supporting an inline assignment or an exact announcement reference. Reuse the assignment schema for unchanged fields. Existing v1 submissions retain their published semantics; new coordinated submission is the normal path when the operator has enabled this capability. No silent downgrade from a failed coordinated request to an ordinary uncoordinated one. An unavailable parser alone does not reject an otherwise valid coordinated task: publish truthful observation-unavailable status while metadata admission and native execution retain their separate contract.

An ordinary coordinated submit reuses its objective and declared areas automatically, returning advisory overlap without a required extra conversation. Optional announce-first work permits inspection before execution; submitting its reference does not require repeating the prompt. Keep expected areas, context files, explicit watches and allowed write paths distinct. Omitted scope means limited preflight evidence, not inferred scope.

Keep a full announced assignment in one private immutable payload owned by the admission/store concern; the bounded control record stores its reference, identity and small projection. That payload is authoritative pre-submission input, not a duplicate mutable task history. Publishing an announcement makes its immutable payload reachable; incomplete staging is not visible as accepted metadata.

At submission, reserve bounded task capacity and establish a durable binding decision for an exact task ID, request key, announcement revision and owner. Under metadata ordering, compare the gated request's relevant authorized overlap set. Unrelated notes or activity do not invalidate its acknowledgment. A new relevant overlap before that decision yields an **unadmitted** `coordination_changed` result; later overlaps are observations, not retroactive cancellation.

The TaskStore admission must contain the immutable linkage before native startup. Native eligibility requires the corresponding link to be settled. A crash between admission and link settlement leaves the accepted task queued/needs-attention, never a second execution. Reconcile by exact task ID/request key and declared identities. A missing or contradictory admission cannot be repaired by guessing that submission never happened. Test each publication frontier, including lost receipts, queue recovery and duplicate concurrent requests.

Use owned reservations and captured revisions rather than holding control/admission locks through Git, native callbacks or human decisions. Known pre-admission failure releases only its own reservation and leaves a useful announcement or explicit disposition. An accepted task survives caller loss. No announcement age triggers withdrawal. Operators can inspect/withdraw unresolved announcements through explicit authority and preserve linked tasks.

Prepared workspaces attach through F9's existing managed-enrollment logic; allow a pre-workspace announcement without inventing a workspace identity. Task adoption and metadata adoption remain distinct. Define which observation audience must be invalidated on task-control changes, keeping original attribution and existing notes intact; historical readers must not gain current-source authority accidentally.

### C6. Incremental monitoring and low-noise parent delivery

Filesystem events invalidate observations; they are not an authoritative edit log. Use bounded Git inventory reconciliation on attach, explicit refresh, lifecycle/checkpoint boundaries and event-coverage loss. A qualified low-frequency sweep covers otherwise unobservable dirty roots. Debounce/sweep intervals schedule observations, not task termination or ownership expiry. Replacement-file saves, directory renames, watch exhaustion and omitted filenames produce recapture/reconciliation or an explicit coverage limitation.

Process changed or explicitly watched content. Use an inverted index of declared paths and syntax anchors rather than all-agent pairwise rescanning. Cross-task declaration comparison requires a stated correspondence basis; similar names or unrelated line numbers are not proof. Different-base pairs stay separate when no safe correspondence is available.

Publish evidence before notification. Default notices arise from explicit watches or two tasks changing a corresponding declaration/region; broad directory overlap and unresolved names remain queryable context. Coalesce by subject/work/recipient. Timestamp, commit advancement, cursor movement and repeated saves with identical compact evidence do not independently produce messages. Changed bodies/defaults remain visible as markers; successive undisplayed internal edits need not each interrupt a parent. A resolved/reverted state is reported where relevant.

Add bounded report retrieval and notice-pull actions to the existing public surface. Extend existing response envelopes only with explicit versioning; do not add fields to strict legacy outputs. Reuse response/pagination validation and current authorization. A disconnected/slow parent cannot stall workers. Retrieval has an explicit acknowledgment/cursor contract: interrupted delivery can repeat the same notice identity, but cannot silently consume it. Pruned cursors return a gap and current snapshot.

No routine model calls, evaluator calls, worker broadcasts or autonomous model wake-ups. Parent-authored notes stay attributed data. Parents choose whether to ask for context, instruct workers or reconcile.

### C7. Preserve F9's conservative resource policy

An active case selecting managed work blocks destructive retirement until its input is removed or the case releases it. Keep the exact `COORDINATION_RESULT_SELECTED` refusal and allow retained disposition. Closing a work row does not remove case protection. There is no alternate protecting-ref override in this completion scope.

Reuse task-association, case-selection and retirement ordering across automatic linkage, enrollment, adoption and recovery. Report/detail readers hold bounded observation ownership during capture; retirement either waits for those owned reads or causes a typed unavailable result without reading a replacement path. It must not hold the metadata mutex through Git effects. Observation does not pin every historical capture or freeze every task indefinitely.

### C8. Versioning, packaging and acceptance are implementation work

Inventory actual readers before assigning new schema versions. Preserve supported metadata v1/v2/v3 and task request/result meanings. Add explicit representations for announcements, task linkage, report/detail authority and cursors rather than optional hidden fields with changed behavior. Publish migrations under existing service ownership, retain receipts, and test interruption/reopen/downgrade refusal. Uncertain native runs are never replayed to repair observation state.

Build native artifacts during explicitly authorized provisioning/build, never during discovery or normal execution. Extend the actual runtime builder's input hashing, copy list, dependency inventory, notices, manifest and installation checks to include native grammar binaries/scanners, query files, helper output and extraction identities. The examined builder currently hashes selected source inputs and verifies startup identity; those are not sufficient evidence of the new parser bundle. [Source S5](reports/design-and-standards.md#source-register).

Keep parser readiness separate from metadata/task readiness. A missing native bundle must not hide legacy tools, break retained-result access, prevent task cancellation or falsely advertise a qualified language. A fully advertised reporting capability requires its actual consumer path to pass.

## 3. Milestones and gates

Every milestone begins Planned. Exact writes are in [the map](reports/implementation-map.md). These are semantic integration units, not fixed commit counts. New required paths are recorded before editing; re-plan for changed authority, guarantees, scope or evidence—not mere file count.

| Slice | Goal and executable exit gate |
|---|---|
| **R0-S1 — Receiving-environment admission (Implemented)** | Adopt this explicit path; preserve F9 and supersede only the old remaining planning authority. Establish full checkout, exact tool/dependency satisfaction, native-build and test authority, real-host permissions, review ownership, and lead-owned SC16 resource design. Run baseline pinned checks and record actual modern support targets. The [R0 report](reports/receiving-environment.md) records the receiving machine and decisions; developer-selected limits and representative measurements are R4/R6 engineering evidence. |
| **R1-S1 — Real native vertical report (Implemented; SC claims pending)** | Resolve and pin the actual native binding and all thirteen grammar candidates; prove build/load viability across the requested set early. Implement complete Rust/TypeScript capture → helper → extraction → report → authenticated CLI/MCP retrieval using existing registered/enrolled work. Include report/detail authorization and disposable-helper lifecycle. No fabricated extraction provider in production. Gate includes real native parsing, Unicode ranges, common/different bases, add/add, body-only, errors and cancellation. |
| **R2-S1 — All required language extraction (Implemented; SC claims pending installed acceptance)** | Complete every L01–L13 row, embedding, default masking and conservative matching with independently reviewed expected output. Package grammars and queries through the same native contract. A partial language milestone is not full acceptance. |
| **R3-S1 — Automatic announcement/submission linkage (Implemented; SC claims pending final acceptance)** | Add versioned inline/reference submission, advisory/gated preflight, durable binding and prepared-workspace attachment. Exercise actual TaskStore and coordinator admission, simultaneous parents, source-view differences, publication failure, recovery and ownership races. No extra native run on a retry. |
| **R4-S1 — Live observation and quiet delivery (Implemented; SC claims pending installed/live acceptance)** | Integrate real watchers, helper jobs, caches, generation-safe snapshots, per-recipient notices/cursors and current-source authorization. Demonstrate public retrieval, event loss, replaced files, delayed results, disconnected parents, no-op edit storms, saturation and zero observation-origin model/build calls. |
| **R5-S1 — Native release artifact and migration** | Finish complete native bundle production/identity, fresh installation away from source, schema migrations, controlled running-service cutover and data-aware rollback refusal. Run actual parser reports offline from the installed artifact for all languages. Preserve named-host approval/deny settings. |
| **R6-S1 — Objective acceptance and external review** | Run all SC01–SC17 claims on the final material candidate: real two-parent/three-worker workflow, installed host and supported native adapters, representative performance, independent review, affected re-verification and resource accounting. Only then accept and set next slice to none. |

R1 precedes shared-contract parallel expansion. After R1, disjoint language work and admission/linkage work may proceed concurrently under one integration owner; monitoring integrates only after the relevant source/link/report contracts stabilize. The actual workflow selects Concurrent Plan Integration only when independently authorizing proposals may become stale; product concurrency alone does not select it.

## 4. Objective acceptance population

Retain the original **SC01–SC17 identifiers** so prior evidence can be traced. All remaining statuses are pending at handoff. Baseline results are references, not substituted final acceptance. Exact procedures, path boundaries and evidence requirements are in [verification and release](reports/verification-and-release.md).

| ID | Observable criterion | Kind | Environment / mode | Owning remaining gate |
|---|---|---|---|---|
| SC01 | Exact per-task input/observed/target roles across different bases, adds and retries | Contract + integration | Real Git/store; automated | R1, R3 |
| SC02 | Truthful task/parent attribution and authority for imported edits, external and managed work | Contract + integration | Representative; automated | R1, R3, R4 |
| SC03 | Written parameters/results/modifiers/types extracted without inferred relationships or default values | Contract | Pinned native parsers; automated | R1, R2 |
| SC04 | Every L01–L13 required row passes source-to-output and installed-bundle qualification | Contract + release-artifact | Representative selected dialects; automated | R2, R5 |
| SC05 | Body/unmapped/error/ambiguous changes remain visible and bounded | Contract + integration | Real parsers; automated | R1, R2 |
| SC06 | Safe identified captures/ranges; no mutable-path substitution or unauthorized detail | System + contract | Qualified Linux/filesystem; automated | R1, R4 |
| SC07 | Incremental monitoring handles event gaps, saturation and late results truthfully | System | Real helpers/watchers; automated | R4 |
| SC08 | Relevance/cursors/coalescing create zero routine inference or worker broadcasts | Integration + system | Actual process/public path; automated | R4, R6 |
| SC09 | Announce/gated start races and interrupted linkage do not duplicate execution | Integration + contract | Actual store/coordinator/Git; automated | R3 |
| SC10 | Notes, structural evidence and details obey current sharing; acknowledgment is not permission | Contract + user-workflow | Representative plus real host; either | R4, R6 |
| SC11 | One lead per target survives changed inputs, transfer and restart | System + contract | Actual processes/store; automated | Preserve F2–F9, reverify R3–R6 |
| SC12 | Observation failure, disconnect, overload and long waits preserve native lifetime and controls | System | Representative plus real supported adapters; either | R4, R6; inherited lifecycle claims |
| SC13 | Selected task results remain protected; external workspaces are not retired | Integration | Actual Git/store/disposition; automated | Preserve F9, reverify R3–R6 |
| SC14 | Historical meanings, migrations, artifact cutover and rollback restrictions are truthful | Contract + release-artifact | Historical fixtures and installed candidate; automated | R3, R5 |
| SC15 | Two-parent/three-worker installed workflow works from revised skills without routine narration | User-workflow | Required-real installed host/adapters; either | R6 |
| SC16 | Passeur’s observation subsystem has bounded resource use and controlled overload behavior on documented supported environments. Verification demonstrates that analysis does not compromise task-control availability or worker lifecycle. Representative measurements record CPU, memory, latency, and parent-context costs, with limitations stated explicitly. | System | Documented supported environments and representative workloads; automated | R4/R6 limits and measurement |
| SC17 | Required standards, full pinned checks, independent review and resource disposition close | Contract + release-artifact + user-workflow | Representative plus independent reviewer; either | R6 |

## 5. Implementation discipline and completion

Read Core and Router, then the applicable canonical owners and their Requires as routed in the source report. Each slice starts with actual repository status, exact writes, consumer versions and selected evidence. Preserve unrelated edits, historical reports, ordinary hooks/signing and the maintainer's committed fixture fixes.

Verification targets the real affected path. A parser import is not an extractor test; extractor tests are not the installed workflow; test-runner exit is not resource settlement; a model score or test name is not a proof of semantic correctness. Expected outputs must be independently authored/reviewed rather than regenerated from the subject under test. Record every failed attempt and correct either the actual defect or an independently demonstrated fixture error without weakening the claim.

Use the existing runners and artifact owners. Keep new dependencies, helpers, manifests and state limited to their current purpose. Do not create another standards engine, generalized RPC framework, semantic graph or second task database. Readiness diagnostics name the missing capability; development uncertainty does not require invented production error taxonomies.

After R0, use Active while admitted work remains executable. A blocked native/language/host claim names its exact requirement and owner; continue independent work only within its admitted contract. Once source is complete use Implemented, then Verifying during objective acceptance. Accepted requires every required claim and affected inherited guarantee, closed mandatory findings, reviewed material candidate and accounted resources. A support reduction requires an explicit maintainer decision, not a skipped row or weakened oracle.

Final delivery includes source/tests, reproducible native build inputs, supported-version matrix, usable skills/runbooks, updated evidence/issue records and the reviewed integration candidate. Compact this plan after acceptance into a decision/evidence index. Do not certify unrelated or future codebase compliance, and do not close unrelated pending shared-service claims by association.
