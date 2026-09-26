# Passeur goal: autonomous peer overlap resolution with qualified multilingual parsing

## Current authority

- **Status:** Active
- **Explicit invocation:** `docs/plans/autonomous-peer-overlap-resolution/plan.md`, operation `start` (2026-09-26).
- **Review base:** `19f20379f9f00cfc09f0de22411b6804b63dc5a1`; current HEAD is `19f2037` and was not reset.
- **Coding-Standards admission:** Core and Router were read from the Coding-Standards MCP runtime interface 37, implementation `0.2.0`, implementation digest `sha256:3be495d3a56e81a70bd384754eeb117657a3f718cf6c36c618b73c3022db66e1`; refreshed route snapshot `snapshot:v1:e826fe18-01b2-4f53-b480-4b40f92378bf` selected 43 standards with zero unresolved fact categories. The route includes implementation, planning, verification, build, tooling, documentation, commit, TypeScript/Rust async and binding boundaries, IPC, persistence, generated contracts, concurrency, contracts, architecture, security, resilience, diagnostics, performance, cross-platform, replay, oracle, platform, and concurrent-plan-integration guidance.
- **Current acceptance:** blocked. Focused and contract evidence can proceed; installed/live native worker delivery and blinded autonomous runs remain blocked by the current Passeur service response `PROJECT_NEEDS_RECONCILIATION` for task `e4323220-4f72-4b5e-9194-4e7c308abcc4`. This is retained as unavailable evidence, not accepted evidence.
- **Current phase:** establish the admitted peer-overlap contract and implement one focused production vertical slice over existing observation, coordination, and adapter owners.
- **Exactly one next slice:** add the immutable, versioned peer-overlap evidence/proposal domain and its owner-authorized service projection, with focused deterministic tests and no claim of automatic native-worker delivery until an adapter-safe interaction boundary is qualified.

### Scope and admission

- **In scope for this admitted slice:** source-grounded deterministic overlap evidence; a bounded versioned peer proposal/application/verification payload; authenticated case/source-version checks at the existing coordination note boundary; ordinary non-agent reads; focused core tests; and truthful inventory/evidence updates.
- **Out of scope for this slice:** native worker-to-worker delivery, autonomous scheduling, semantic merge/application execution, functioning multilingual applications, live provider configuration, credentials, service reconciliation, and blinded runs. Those remain M3–M5 work and cannot be accepted from local simulations.
- **Assumptions:** existing source captures, work/case records, persistence, service authorization, and adapter lifecycle remain authoritative; evidence may be unavailable and must retain that state; no dependency installation or state-root mutation is authorized.
- **Admission decision:** `start` is admitted because the artifact was Planned, the review base is unchanged, the current checkout is not being reset, and the Coding-Standards MCP route has zero unresolved fact categories. `continue` is the only lawful operation while Active; `verify` is reserved for a later Implemented/Verifying state.

### Binding decisions

| Concern | Binding owner / decision | Rejected alternative and reason |
| --- | --- | --- |
| Syntax/source facts | `src/observation/*`; `selectPeerOverlapEvidence` consumes captured typed facts | No parser or whole-file prompt reconstruction in coordination |
| Proposal and version authority | `CoordinationControl` plus the existing persisted note records; marked records are strictly decoded and checked against the current case/work revisions | No second peer store or caller-only JSON convention |
| Application/verification status | Separate `peer_resolution_application` and `peer_resolution_verification` records, lead-authorized and case-versioned | No implication that acknowledgment means application or correctness |
| Worker delivery | Existing adapter/service lifecycle; currently unqualified and blocked | No direct sockets, injected prompts, or parent relay |
| Evidence disposition | `complete`, `incomplete`, and `unavailable` remain explicit; only executed local checks are accepted | No historical, simulated, or unavailable live evidence substitution |

### Oracle and isolation plan

- The independent oracle for this slice is the focused Node core test set: expected changed declarations/spans, byte/range validity, UTF-8 behavior, deterministic replay, source unavailability, structured participant/source-version rejection, stale acknowledgment, and separate application/verification records. Tests do not launch a service or model.
- Live worker and fixture claims require fresh disposable repositories, protected baseline hashes, ordinary adapter/service paths, retained queued/delivered/observed/acted records, and no parent resolution actions. Those environments are unavailable under APR-001/APR-002 and stay blocked.
- No contributor or experiment may edit the shared coordination owner concurrently. Read-only discovery workers used during `start` had no write set; this integration owner is the sole writer for shared contracts, plan records, and final staging.

### Slice write set, gate, and replan trigger

- **M2-S1 write set:** `src/observation/overlap.ts`, `src/coordination/peer-resolution.ts`, the existing `src/coordination/control.ts` integration, `tsconfig.core.json`, focused core tests, and this plan's evidence records. No adapter, fixture, service-state, or unrelated dirty file is included.
- **Gate:** core TypeScript compilation; direct focused overlap and coordination tests; full type check; diff check; exact staged diff review through the Coding-Standards commit guidance. A live/native gate remains blocked rather than waived.
- **Replan triggers:** a new store/scheduler/adapter transport, a changed source-grant model, a current-HEAD change overlapping this write set, service reconciliation, or evidence showing that marked note records cannot preserve the required version/provenance contract. Any trigger requires a new explicit plan slice before expansion.

### Acceptance claims

| ID | Observable claim | Evidence kind | Environment / mode | Status | Evidence location |
| --- | --- | --- | --- | --- | --- |
| A1 | Structured parser/domain API exposes source identity, ranges, declarations, containment, limitations, and deterministic overlap evidence to a non-agent consumer. | focused + integration | representative / local tests | partial: overlap domain and no-service consumer tests pass; broader extraction integration remains | `tests/core/peer-overlap.test.mjs`; `src/observation/overlap.ts` |
| A2 | Compact handoff selection is deterministic, source-grounded, bounded, and includes body/default/signature evidence needed by the observed overlap. | focused + contract | representative / local tests | partial: body/unavailable/budget evidence passes; default/signature fixture breadth remains | `tests/core/peer-overlap.test.mjs`; `src/observation/overlap.ts` |
| A3 | Peer case proposals, counter-proposals, exact acknowledgments, stale-version rejection, and bounded provenance are persisted under authenticated participant ownership. | contract + integration | representative / local tests | partial: versioned marked proposals/acks, stale checks, and downstream invalidation after withdrawal/supersession pass; worker/session principals and public projection remain | `tests/core/peer-resolution-contract.test.mjs`; `tests/core/coordination-control.test.mjs` |
| A4 | Agreed application is conditional on exact case/source/scope versions and records application and verification separately. | integration | representative / local tests | partial: acknowledged proposal chain, lead authorization, version checks, and withdrawal invalidation pass; real application/effect proof remains | `tests/core/coordination-control.test.mjs`; `src/coordination/control.ts` |
| A5 | Supported parser routes and functioning fixture baselines qualify for every current language/dialect promise. | system + contract | representative / offline fixtures | pending | `reports/language-capability-inventory.md` |
| A6 | Real installed adapters deliver overlap context to workers and workers autonomously negotiate and apply a compatible result without parent intervention. | system + user-workflow | required-real / installed service | blocked: service reconciliation and adapter capability | `issues.md` APR-001/APR-002 |
| A7 | Two-agent and three-agent blinded overlap matrices pass the required repeated runs, with same-file/different-symbol control and available mixed-provider coverage. | system + user-workflow | required-real / fresh disposable repositories | blocked: live service/provider evidence | `issues.md` APR-001/APR-002 |
| A8 | Inventory, evidence, runbook, and final commit records identify accepted, deferred, and blocked claims without substituting historical or simulated evidence. | contract | representative / repository records | pending until final verification and commit record | `execution-ledger.md`; `reports/acceptance-matrix.md` |

### Constraints, owners, and write set

- The existing `ObservationMonitor`, native extraction/comparison/correspondence, `CoordinationControl`/store, repository runtime, and concrete adapters remain the owners of their current lifecycles. No parallel parser, coordination store, scheduler, or parent-side integration path is admitted.
- The serial integration owner owns shared contracts, persisted schemas, MCP projections, active-plan records, inventories, fixtures/manifests, and final verification. Any implementation contributor must receive a disjoint primary write set and may not edit those shared owners.
- Initial implementation write set: `src/observation/`, `src/coordination/`, `src/contracts/coordination-*`, `src/store/coordination-store.ts`, `src/core/repository-runtime.ts`, `src/service/`, `src/mcp/`, and focused tests/docs under this plan. Existing unrelated dirty files and running sessions remain outside the write set.
- Fixture production sources, validation oracles, provider configuration, credentials, installed state, and disposable experiment repositories remain outside worker write authority and this repository's runtime dependency graph.

### Composed-design review

**Applicable.** The slice changes the composition of existing observation, coordination, persistence, service, and adapter boundaries and adds a durable peer-case contract. The retained artifact probe is:

1. Independent concerns: syntax facts are produced by observation; recipient/proposal/decision/version authority is owned by coordination; persistence publishes immutable records; service projects authenticated operations; adapters own native worker interaction; agents choose semantics.
2. Required interleavings: capture publication precedes overlap case creation; grants precede source disclosure; proposal versions and source revisions are checked before acknowledgment/application; terminal worker lifecycle remains service-owned.
3. Caller knowledge: callers provide authenticated actor and exact work/case selectors; they do not reconstruct parser facts, authorize another participant, or integrate patches.
4. Representative changes: parser extraction changes stay in observation; agreement/application contract changes touch coordination, store codecs, service/MCP projection, fixtures, and tests; adapter changes touch the adapter plus lifecycle evidence.
5. Stable dependencies are typed source/evidence and coordination contracts; mutable transport, worker scheduling, and persisted state remain hidden behind their owners.
6. The peer evidence domain and coordination records can be tested independently; adapter delivery and live qualification remain independently blocked when native capability/evidence is unavailable.
7. Deleting the peer-case contract would move version, identity, provenance, and stale-application checks into callers, so it contains necessary complexity; no general plugin framework, semantic merger, or second scheduler is admitted.
8. Necessary complexity is bounded by existing store/service/adapter lifecycles. Re-run this probe if a new store, parser stack, autonomous scheduler, application engine, or materially broader propagation is proposed.

### Milestones

| Milestone | Goal / bounded write set | Gate | State |
| --- | --- | --- | --- |
| M1 | Current-state inventory, standards admission, plan records, and owner map. Plan/docs only. | MCP route/read evidence and repository/session inventory. | Complete; evidence retained in ledger |
| M2 | Deterministic peer-overlap evidence/proposal/acknowledgment/application contract over existing owners. Shared contracts, source, focused tests. | Focused TypeScript/core tests; stale/duplicate/auth/version cases; final encoded budget and proposal-chain checks. | Verifying; local gate passes, public/live qualification remains open |
| M3 | Safe worker-facing delivery seam and concrete adapter qualification. Adapter/service files and adapter tests. | Native lifecycle evidence; unsupported remains explicit. | Planned |
| M4 | Offline functioning multilingual fixture applications, protected baselines, and independent parser/overlap oracles. Fixture/evidence files only. | Every supported route build/run/parser assertions. | Planned |
| M5 | Installed blinded two-/three-agent matrix and final acceptance records. Disposable experiment artifacts and plan evidence. | Required-real system evidence and no parent interventions. | Blocked |

### Current blockers and replan triggers

- **APR-001:** the owning Passeur service requires operator-authorized native/publication reconciliation (`PROJECT_NEEDS_RECONCILIATION`, task `e4323220-4f72-4b5e-9194-4e7c308abcc4`). Until that state changes, installed/live evidence is unavailable and claims A6/A7 remain blocked.
- **APR-002:** adapters expose no qualified worker-to-worker delivery or same-session continuation seam. Adding one is a separate M3 slice requiring adapter-owned lifecycle evidence; this slice does not inject prompts or use direct peer sockets.
- **APR-003:** the M2 contract now supplies bounded body/source evidence and proposal-chain metadata, but broader parser extraction, task/session identity, retained artifact linkage, and public projections remain open. Revisit before marking A1–A4 accepted.
- Replan before expanding if service reconciliation, a new adapter transport, a new store/scheduler, current-HEAD overlap, or a source-grant/lifecycle contract change occurs.

### Plan records

- [Execution ledger](execution-ledger.md)
- [Issues and dispositions](issues.md)
- [Reports](reports/)
- [Language/capability inventory](reports/language-capability-inventory.md)
- [Acceptance matrix](reports/acceptance-matrix.md)

## Objective

Review and extend the current Passeur implementation until two or more real, concurrently editing subagents can discover overlapping changes through Passeur, receive a compact, deterministic and source-grounded handoff, communicate directly through Passeur, agree on a compatible resolution, apply it under current authority, and produce a functioning combined result without the spawning parent/coordinator supplying conflict-specific instructions or intervening in that resolution.

Qualify the parsing and coordination path against small, functioning applications for every explicitly supported language/dialect. Preserve pristine, protected application baselines so the complete experiment can be repeated. Keep the parsing domain modular and understandable for ordinary programmatic consumers, a future agent-facing facade, and Whip-Docs reference use.

This is implementation and qualification work, not merely a parser demonstration, a notification test, a successful merge, or an architecture proposal. Acceptance requires the observable end-to-end outcome.

## 1. Establish current state and apply Coding-Standards through its MCP

Repository: `MrScripty/Passeur`.

Review baseline: `19f20379f9f00cfc09f0de22411b6804b63dc5a1`. This is a discovery anchor, not permission to reset a newer checkout. Inspect current HEAD, repository instructions, dirty state, running service/build identity, concurrent ownership, and existing plans before editing. Preserve unrelated changes and existing sessions.

Use the **Coding-Standards MCP** for planning, implementation, verification, and commits. Discover its actual tools and contracts; do not invent tool names or treat an introductory standards paragraph as compliance. Read Core, route from actual task facts, retrieve the applicable required closure, and record the adopted revision and route evidence. Include the actual TypeScript, concurrency, architecture/code-design, source/security, IPC, persistence, library/API, verification/oracle, performance, dependency, documentation, planning, and commit concerns, together with language/build concerns introduced by the fixture apps. Select modules from the Router rather than treating that indicative list as the authoritative route.

Start document discovery with the latest relevant inventory sections. Search only relevant architecture, plan, and context passages afterward. Return constraints, concrete gaps, and exact current file:line references. Read the existing compact-symbol and structural-coordination acceptance records before proposing replacements. Preserve the shared-service/lifecycle authority. Reconcile any new ownership decisions with existing active plans; retain accepted historical evidence rather than rewriting it as evidence for this goal.

Canonical new plan path: `docs/plans/autonomous-peer-overlap-resolution/plan.md`. When executing this goal, create and admit that plan with operation `start` if it does not exist. This goal authorizes subsequent lawful `continue` operations while Active and `verify` when Implemented/Verifying; record each operation explicitly. An existing incompatible, accepted, blocked, or superseded plan is not a reason to force `start` through. Resolve its actual state and authority under the MCP.

Use the standard plan/ledger/issues/reports structure. Record objective acceptance claims, composed-design review applicability, owners, bounded write sets, gates, current phase, and exactly one next integration slice. Keep investigation proportional: establish concrete gaps, make the smallest coherent production changes, and qualify them. Required unavailable MCP or live evidence remains explicitly blocked; continue independent work without declaring the affected claim accepted.

## 2. Preserve and extend the existing architecture

Trace the actual path from task admission and declared scope through source capture, language routing, native parsing, extraction, comparison, observation publication, delivery, peer interaction, application, and final verification. Document the current owner and missing behavior at each boundary.

Retain suitable existing source identities, captured UTF-8 ranges, declaration models, parser helpers, comparison logic, grants, work records, agreements, service ownership, and durable receipts. Extend their owners instead of introducing a parallel coordination store, parser stack, scheduler, or inference loop. New native/toolchain dependencies must remain outside ordinary MCP discovery and retained-result access.

Separate three concerns clearly: syntax/source analysis produces facts; coordination owns recipients, proposals, decisions, authority, and lifecycle; agent reasoning chooses how to reconcile requirements. A shared symbol is evidence of overlap, not proof of a semantic conflict. An acknowledgment is not proof of a correct merged program.

Preserve service-owned long-running assignments, canonical repository identity across linked worktrees, multiple parent sessions, explicit cancellation, and evidence-based terminal state. Elapsed time, silence, a parent disconnect, parser overload, or waiting for another worker must not terminate a valid assignment or transfer ownership. Observation debouncing and bounded resource policies are separate from task termination.

## 3. Provide a small, reusable parsing domain API

Expose one coherent programmatic boundary for immutable source analysis, declaration/containment inspection, comparison, and bounded overlap evidence. Adapt CLI, service, and MCP projections to that model; consumers must not parse human-readable reports to reconstruct facts.

Use domain names that describe what is represented: source snapshot/reference, language or dialect, declaration, containment, source span, correspondence, change, overlap evidence, and coverage/limitation. Keep task/parent identities in attribution or coordination wrappers rather than requiring them to parse a source buffer. Keep native Tree-sitter objects and grammar-specific node names behind the extraction boundary where possible. Avoid speculative plugin frameworks or a new published package unless a demonstrated consumer requires them.

The contract must state source identity and content hash; parser/extractor identity; UTF-8 half-open byte ranges; written signatures and declared annotations; declaration kind and enclosing scope; masked/omitted regions; and explicit incomplete, unsupported, ambiguous, absent, and unavailable outcomes. Distinguish snapshot-local identity from cross-revision correspondence. Names or line numbers alone must not manufacture identity across overloads, renames, insertions, separate scopes, or different input bases.

Add a small non-agent consumer test/example that analyzes supplied source and consumes structured declarations/containment and overlap evidence without launching a repository service, MCP server, coordinator, or model. Demonstrate comprehension at the caller, not merely separation into more files. Document parser/helper resource ownership and errors.

Whip-Docs remains an independently designed native Rust analysis system with agent-independent file-to-symbol expansion/display. Passeur is a TypeScript proof of concept only where the capability directly benefits Passeur. Supply portable behavior/contract examples and fixtures as reference material; this goal does not implement Whip-Docs, introduce a TypeScript runtime dependency there, or change its existing Svelte/Three.js presentation. Do not infer resolved dependencies or semantic safety from syntax-only results.

## 4. Construct minimal sufficient, deterministic overlap handoffs

Implement an explicit selection policy for the smallest source evidence sufficient to describe the observed overlap. Define minimality relative to that policy and acceptance cases, not as an unprovable globally smallest prompt that will always be sufficient for every model.

A compact initial handoff must identify the case/evidence revision; participating task/work identities; minimally necessary task intents; each exact input and observed source version; affected declarations/scopes; the structural reason for overlap; current limitations; and the permitted next actions. Include the relevant changed source spans with their before/after attribution. Reference immutable captures and hashes rather than mutable file paths alone.

Signature changes need the relevant signatures. Body-only conflicts need the relevant changed body expressions/statements and sufficient enclosing context; `body_changed` by itself is not an adequate resolution handoff. Initializer, default, attribute, or embedded-script changes need their relevant evidence when they are the overlap. Preserve compact inspection's existing masking contract: provide source details only through an appropriately authorized evidence projection rather than silently broadening report grants.

Exclude unrelated declarations, bulk initializers, whole-file dumps, full task transcripts, and duplicated common context. Every included or expanded span must have a reason. Preserve separate spans, source-side labels, byte offsets, and omitted-region markers; concatenating excerpts must not imply that nonadjacent code was adjacent.

Support progressive, bounded expansion from retained source. Agents must be able to request necessary enclosing or related source without repeated whole-file retrieval. Omitted critical context, unavailable captures, unsupported syntax, or exceeded budgets must produce explicit needs-detail/incomplete/unavailable outcomes rather than a misleadingly complete handoff. Recheck authorization for detail reads and expansions.

For identical captured inputs, parser/extractor versions, policy, and budget, the evidence payload and selection/order must be deterministic. Separate transport timestamps or delivery IDs from content-addressed evidence identity. Keep ambiguity and different input bases explicit; do not manufacture a shared ancestor or conflate independently added declarations. Cover addition/addition collisions and rename/edit cases conservatively.

Test encoded bytes, snippet counts, unrelated-source exclusion, deterministic replay, and documented selection minimality. Measure total delivered context, including expansions and retransmissions, against whole-file and existing per-work-report baselines. Report actual tokens when available and label estimates otherwise. Optimize useful evidence and successful resolution, not small initial packets that force expensive repeated retrieval.

## 5. Deliver and resolve overlaps automatically between workers

Close the current parent-facing observation boundary using the real production runtime/adapter path. Tool availability, a queue entry, or a notice visible to the parent is not delivery to a worker.

Automatically establish observation for managed editing tasks from their authorized scope and capture actual changes. Establish narrowly scoped cooperation permissions through normal production task configuration/admission, without a parent needing to supply a conflict decision after detection. Do not grant blanket source access merely because tasks share a repository.

Deliver actionable overlap context to affected workers at a supported safe interaction boundary without requiring a task prompt to mention other workers, instruct notice polling, or teach a test-specific protocol. Record queued, delivered, and worker-observed/acted-on evidence separately. Handle a busy or temporarily disconnected worker through durable, bounded delivery rather than injected concurrent turns or lost messages. Qualify the actual adapters used; unsupported delivery is an explicit capability outcome, not simulated success.

Authenticate each participating task/session distinctly, including siblings of the same parent. Reuse existing authority mechanisms where suitable; a shared parent ID, caller-supplied worker label, or note text must not allow one sibling to impersonate another, acknowledge both parties, or inherit unrestricted parent controls. Keep task evidence/source permissions separate from parent cancellation, adoption, recovery, and unrelated task administration.

Provide a bounded case-scoped conversation: workers can inspect evidence, request detail, propose a resolution, counter-propose, acknowledge the exact proposal/version, and record responsibility for application and verification. Use concise structured decisions and necessary explanations rather than forwarding entire histories. Label peer/source content as data with provenance, separate from trusted service actions; source comments or peer messages cannot grant authority or execute commands.

Bind agreements and application to exact source/case versions, affected scope, responsible executor, and verification requirements. Revalidate the current versions and authority immediately before applying an agreed change. A new edit, revised proposal, third participant, revoked grant, changed task ownership, or replaced workspace must invalidate or supersede the affected agreement as appropriate. Notification coalescing must not conceal such invalidation even when a new body edit renders the same compact summary.

Choose and implement the smallest safe existing-compatible application path: a designated peer may perform authorized reconciliation, or existing service-owned mechanics may apply exact agreed results. The spawning parent must not write the fix, select the semantic compromise, manually relay messages, or integrate conflicting patches on the successful autonomous path. Preserve both tasks' requested behavior, unrelated edits, and atomicity/conditional-write guarantees at the application boundary.

Distinguish notification acknowledgment, proposal acceptance, application, and functional verification. Duplicate delivery/retries must be idempotent; out-of-order or stale responses must not reopen or apply an obsolete decision. Keep resource bounds and an auditable outcome for unresolvable requirements, unavailable evidence, unsupported adapters, lost authority, or explicit cancellation. Escalation is truthful fallback, not a successful autonomous-resolution result. Silence is never agreement or ownership release.

## 6. Build and protect functioning multilingual fixture applications

Derive the authoritative language/dialect/extension population from current code and public promises. The reviewed population is Rust, Python, C, C++, C#, Kotlin, Zig, TypeScript, TSX, JavaScript, JSX, Lua, Odin, and Svelte 5. Keep TSX/JSX and embedded Svelte source independently visible in the coverage matrix. Include newly supported routes discovered during current-state review rather than silently shrinking scope.

Create a small functioning application for each language/dialect under an appropriately named fixture-app directory. A suitable common domain is an in-memory order/quote calculator: integer monetary arithmetic, quantities, validation, and a compact result. Use idiomatic console programs for ordinary languages and a small actual component application for JSX, TSX, and Svelte 5. The component applications must build, render, and exercise meaningful behavior, not merely parse isolated markup. Kotlin does not require Android; the other fixtures do not require network services or databases.

Each app needs a real entry point, its minimal build/run metadata, documented qualified toolchain versions, deterministic sample input/output, baseline functional tests, and independently authored expected parsing/overlap assertions. Exercise ordinary declarations, relevant containers/members, and small cross-function/module relationships rather than only a single trivial function. Keep intentionally malformed parser cases separate from functioning baseline applications.

Test declared extension aliases and dialect overrides as applicable, including C/C++ `.h`, JSX-in-`.js`, Svelte scripts, and `.svelte.ts`/`.svelte.js`. Do not label a compiler-complete symbol graph as supported merely because its grammar loads. Record required fixture constructs, qualified extraction, and explicit limitations. Repair gaps that prevent this goal's app/overlap acceptance; represent broader unsupported language constructs truthfully.

Programs run offline on small fixed inputs and use bounded CPU/memory and minimal local I/O. Toolchain provisioning may occur in setup; app execution must not download anything. Prefer standard libraries and existing tooling. Every added dependency needs a concrete purpose, owner, version/license/provisioning disposition, resource justification, and verification; keep fixture-only tooling out of Passeur's runtime/discovery dependencies.

Commit pristine fixture baselines and a manifest of their paths, versions, content hashes, entry points, and expected commands. Materialize each experiment from a known clean baseline into a disposable Git repository with separate linked worktrees for the agents, sharing that experiment's one canonical repository/service. Production Passeur code, golden fixture sources, the harness, and independent acceptance oracles stay outside worker write authority. Use the runtime's actual sandbox/write boundary or equivalent isolation; instructions and `chmod` alone are not protection against a same-user process.

Keep run-specific changes, builds, service state, and transcripts outside pristine fixtures. Verify golden hashes and repository state before and after every run. A detected baseline mutation fails the run even if the final app works. Handle fixture upgrades as deliberate reviewed source changes, not test side effects. Cleanup must target only exact registered disposable resources, after worker-stop and result-retention evidence; never reset or broadly clean the user's active repository or unrelated worktrees.

## 7. Qualify parser, evidence, and coordination behavior

Run real parser/helper tests against each functioning app and its realistic edited variants. Independently check declarations, written signatures/annotations, containment, exact source ranges, captured-side identity, comparison, compact projection, and overlap selection. Coverage expectations must not be generated solely by the implementation under test.

Include unchanged code, unrelated symbols in one file, same-symbol edits, signature/body/default changes, additions/deletions, nested/repeated names, overloads and language-specific structures, Unicode and line shifts, embedded scripts, malformed intermediate edits, missing files, and conservative correspondence failure. Explicitly exercise existing disclosed gaps such as ordinary JavaScript bindings and Rust constants/statics where fixture correctness or handoffs depend on them. Check that unrelated child edits do not incorrectly appear as direct parent-body edits.

Add focused deterministic tests for delivery, independently authenticated siblings, proposal/acknowledgment semantics, stale/version-racing application, duplicate/out-of-order messages, a third participant, capture eviction, revoked access, workspace replacement, restart/reattachment, and missed/coalesced watcher events. A valid body-only edit must advance the relevant evidence/version even when routine notice wording is coalesced. Parser overload must leave control/cancellation paths responsive and required outcomes explicit.

Test limits and failure behavior through the public boundary as well as internal units. Mocks are appropriate for bounded race/failure tests, but remain separate from the live acceptance population. Do not add a failing behavior solely to manufacture a green test or relax assertions around actual supported behavior.

## 8. Run real, blinded multi-agent editing experiments

Use actual configured native agents/providers through the installed candidate Passeur service, its real monitoring/parsing, real worker delivery, real tools, and real edits. Record exact source/build/toolchain/provider identities. A development import test or mocked provider is not installed/live acceptance.

Give each worker only its own normal development task and ordinary production tool access. Initial prompts, controllable bootstrap instructions, fixture documents, accessible plans, filenames, environment data, and harness messages must not reveal other workers, their assignments, an expected conflict, a negotiation script, or a requirement to poll Passeur. Keep other task specifications and combined acceptance oracles outside the worker's initial access. Capture the actual prompts and controllable instruction surfaces to substantiate this. Generic production tool descriptions are allowed; scenario-specific coaching is not. Record any context surface that cannot be inspected rather than claiming knowledge of hidden provider internals.

Example independent tasks on the quote calculator: worker A adds a merchandise percentage discount; worker B adds a flat delivery charge and an itemized result. Both naturally change the same calculation function/result contract, while neither is told the other exists. The independent combined oracle checks that both features survive and compose correctly—for example, merchandise 10,000 cents, a 20% merchandise discount, and delivery 500 cents produce a total of 8,500 cents. Tasks may specify their own relevant function/scope normally; they may not describe the other assignment. A three-worker scenario adds another compatible requirement affecting the same logic.

The harness may provision fixtures, submit independent tasks, establish a neutral simultaneous start, collect evidence, and run immutable acceptance checks. After launch it must not fabricate overlap events, call resolution tools for workers, inject peer explanations, rewrite patches, supply a compromise, or perform conflict resolution/integration. Initial overlap policy/configuration must be the normal production path, not a hidden test-only mediator.

Prove actual concurrent execution and observed overlapping edits. A staged sequential edit, two tasks that happened not to overlap, a clean textual merge alone, or a parent manually relaying notices does not pass. Successful traces must connect actual edits to detection, evidence construction, automatic worker delivery, peer proposal and independent acknowledgments, version-checked application, and the verified combined artifact.

Run at least one genuine two-agent overlap scenario against every language/dialect app. Include a three-agent overlapping scenario, a same-file/different-symbol control that does not trigger unnecessary conflict negotiation, and a mixed-provider scenario when both requested production adapters are available. Explicitly qualify any unavailable required provider claim instead of using a mock replacement. Run the principal two-agent and three-agent scenarios three times each from fresh baselines, retaining all attempts; this is bounded repeatability evidence, not a population-wide reliability claim.

The spawn/orchestration process observes passively after launch. On a successful case there are zero parent conflict messages, semantic decisions, manual worker-input answers, corrective patches, or conflict-integration actions. A safety intervention or explicit run cancellation is recorded as such and the case does not count as an autonomous pass. Test-run abort policies must remain distinct from production worker lifecycle and must not conceal a timeout-based worker kill.

Check the baseline, each independent requirement, their interaction, existing behavior, final build/run output, and unchanged protected sources. Keep validation oracles outside agent edit permissions. Retain useful failed-run artifacts and concise auditable transcripts/tool calls, not hidden model reasoning or credentials. Report all attempts and failures; repeated runs must not hide earlier failures behind one selected success.

## 9. Use implementation agents efficiently

Separate the agents implementing Passeur from the deliberately overlapping agents used as test subjects. Implementation contributors receive disjoint write sets; overlap experiments occur only inside disposable fixture workspaces.


Use subagents generously to parrelize work as much as resonably possible. If the codex session does not support at least 8 parellel workers, update the codex config to allow more workers and ask the user to restart the session.

Use **GPT-6 Astra High** for planning and final review. Use **GPT-6 Luna Max** primarily for orchestration: verify state, maintain constraints, assign disjoint write sets, resolve routine implementation coordination, inspect concise handoffs, integrate accepted contributions, and run final acceptance.

Use **GPT-6 Luna High** for bounded, read-only document discovery starting from the latest inventory and relevant architecture/plan/context passages. Return constraints, demonstrated gaps, and exact file:line references rather than broad document dumps.

Prefer **Muse Spark 1.3 Contributor through the Passeur MCP** for suitable bounded implementation work to reduce Codex cost. Use **GPT-6 Sol Medium** implementation subagents where appropriate. Muse is not the planning or review route. These are the requested allocation rules, not a substitute for verifying actual available model/adapter IDs or contributor output.

Use an independent **GPT-6 Sol Extra High**, read-only, for important architecture, security, and lifecycle changes; reuse that reviewer for narrow repair verification. Reviewers never edit. Parallelize independent discovery, fixture implementation, protocol work, test/oracle work, and reviews of stable candidates where dependencies permit. Review exact immutable candidates, and refresh review for changed relevant code before integration. Keep shared contract and integration ownership explicit rather than letting nominally disjoint workers change the same authority indirectly.

## 10. Acceptance, evidence, inventory, and commits

Acceptance requires every required language app to build/run and pass its real parsing/overlap assertions; compact handoffs to satisfy deterministic selection, source correctness, authorization, and measured context requirements; ordinary non-agent API consumption to work; and the live blinded matrix to prove autonomous resolution and functional preservation without parent intervention.

Run focused regression checks, the affected core/native/public and installed gates, current type checks, app-specific build/runtime tests, and the exact-candidate live suite. The reviewed package already provides `npm run check`, `npm test`, `npm run test:core`, `npm run test:native`, and installed verification entrypoints; verify current commands and required environments rather than relying on these names or historical pass counts alone. Public/persisted/adapter contract changes require the corresponding consumer and retained-state dispositions.

Provide a language/extension/capability matrix and an objective acceptance matrix, with exact commands, environment/build identities, outcomes, artifact references, unresolved limitations, and all live attempts. Measure handoff bytes/tokens including expansions, notices and duplicate suppression, peer turns/tool calls, first-delivery latency, resolution outcome, resource use, and parent interventions. Publish distributions or simple per-run measurements only to the extent the sample supports them. State budgets/measurement methods before claiming efficiency and avoid treating a smaller payload as improvement when correctness or completion degrades.

Update the canonical plan, execution ledger, issues, and inventory with what is implemented, accepted, deferred, or blocked; the exact evidence; owners; and final commit identities. Include a concise parsing-domain/API guide, an actual worker-delivery/negotiation flow, deterministic evidence-selection rules, fixture provisioning/reset/replay instructions, and a command-driven live-test runbook.

Use the Coding-Standards MCP for commit preparation and verification as well as planning/code work. Review the exact staged diff, preserve hooks and unrelated changes, and commit coherent verified outcomes under existing repository/review rules. Do not stage runtime secrets, private live state, unrelated generated files, or worker experiment modifications as pristine fixtures. Make no unrequested remote publication, history rewrite, or destructive cleanup.

The final handoff must give implementation and evidence locations, tests actually executed, standards/reviewer outcomes, all unresolved limitations, and commit IDs. Passing parsing tests, historical multi-parent tests, or a scripted parent-led reconciliation cannot substitute for this goal's blinded autonomous worker-to-worker proof.

## Repository review anchors

These are inspected starting points, not a claim that tests were rerun for this goal or that current HEAD will remain unchanged:

- `AGENTS.md`: required standards routing, explicit plan admission, lifecycle authority, and discovery/native dependency constraints.
- `docs/plans/compact-symbol-representation/reports/inventory.md`: compact inspection feature acceptance and explicitly deferred findings; feature commit `f91af87`.
- `docs/plans/structural-coordination-completion/reports/claim-status.md`: historical SC01–SC17 evidence, including real two-parent/three-worker work, with recorded limits.
- `docs/structural-reporting.md`: exact language routes, source grants, capture/detail limits, incomplete coverage, and the explicit parent-notice rather than automatic-worker-instruction boundary.
- `docs/coordination.md:1–155`: parent identity, source authority, metadata agreements, reconciliation leadership, and externally performed integration.
- `src/observation/model.ts`, `language-routing.ts`, `comparison.ts`, `report.ts`, and `native-extraction.ts:1–125`: existing typed facts, routing, parser/extraction composition, masking, and bounded rendering.
- `src/observation/monitor.ts:1–210` and `src/core/repository-runtime.ts:1070–1345`: monitoring, retained evidence access, source authorization, and service composition.
- `src/agents/types.ts`: current worker lifecycle/input/event boundary; inspect the concrete adapters before choosing a delivery mechanism.
- `tests/native/structural-native-functions.test.mjs:1–150`: existing real-parser regression examples, not functional app acceptance.
- `tests/integration/structural-notifications.test.ts:1–135`: current public notification tests, explicit refresh/pull and watcher behavior, and suppression of repeated body-only notice wording while exact artifacts advance.
- `package.json`: current build/test commands and pinned parser/runtime dependencies.

Historical authoring note: the pre-start review described a GitHub-only standards read and did not itself execute the Coding-Standards MCP, repository suites, or live sessions. The current 2026-09-26 start record supersedes that statement for execution evidence; the current MCP/runtime results and unavailable live evidence are recorded above and in the execution ledger.
