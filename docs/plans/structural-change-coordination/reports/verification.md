# Verification procedures and acceptance evidence

These are procedures, not executed results. SC01–SC17 remain pending. The named evidence kind describes the actual boundary traversed; a test directory or fixture name does not establish fidelity. Required-real host/provider checks remain distinct from controlled peers.

## Evidence record

For each executed claim retain candidate/material revision, installed build and parser bundle, exact inputs and expected outcome, environment/toolchain, command/procedure, observed result, artifacts, executor, limits and resource disposition. A failed negative case counts only when it reaches the intended boundary with other preconditions valid. Test expectations are independently authored from native source examples and language specifications, not copied from current extractor output.

Production code consumes runtime-validated inputs. Tests can use fakes only where the fake boundary is explicitly excluded from the claim. Pairwise agreement between two renderers proves consistency, not correctness of their shared extraction logic. A compiler is not needed or launched in the monitoring path; offline language-specification review can inform test expectations without becoming a runtime dependency.

## V01 — exact comparison roles (SC01)

Create real disposable Git histories for two and three tasks: a common base, different admitted bases with an already changed annotation, separate additions of the same declaration, deletion in one branch, target advancement unrelated to either task, and explicit incremental observation. Assert full endpoint identities, absence states, source roles and per-task fragments. A difference inherited at Task B's base must not be shown as B's introduced change. Same-source comparison should be empty with complete coverage, not an error. Check mixed committed and captured working observations and retained report reopening. The independent oracle is the constructed Git DAG plus literal authored source at each OID.

## V02 — attribution without authorship invention (SC02)

Use the same Git author for two workers and different Git authors within one task. Incorporate an externally created commit into a task branch and edit an external registered workspace. Assert observed-task/parent association comes from Passeur identity and that `authorship_not_established` remains possible. No blame-derived agent association is accepted. Change an external worktree's HEAD outside its registered epoch and assert explicit history-change handling; do not silently substitute current HEAD for the admitted input.

## V03 — syntax only (SC03)

For independently reviewed function/type samples, change parameter order, names/patterns, optional/rest/receiver/modifier syntax, explicit results, constraints and directly edited aliases. Include unannotated JS/Python, a named result type whose definition changes without the function annotation changing, values changing in bodies/defaults, and literal syntax in a type. Assert exact native syntax and `not_declared`/default-changed/body-changed states. The annotation referencing an edited alias is not expanded or reported as effectively changed. Spy on the *process boundary* to prove no compiler, LSP, project script, provider or evaluator is invoked; a local mock function count alone does not prove this.

## V04 — all languages and installed parser bundle (SC04)

Run every L01–L13 fixture against the exact selected grammar/binding/query/extractor bundle. Each `cases.json` identifies its native syntax authority and expected extracted/range/matching result. Cover the modern features admitted in M0, not only minimal language examples. A row is satisfied only when required declarations/parameters/results and failure coverage pass; a parse success or tags list is insufficient.

Test Svelte 5 script languages, snippets/defaults/destructuring and template-only changes; JSX/TSX component parameters and template-only changes; C/C++ dialect ambiguity and complex declarators; Odin multiple results; Kotlin modern receiver/result syntax; Rust macros as unexpanded regions. Use non-BMP Unicode and CRLF for embedded source mapping. Install the built artifact in a source-free directory with network/provisioning unavailable and run the same report operations. Verify generated parser identities and required notices against the bundle manifest. A missing required grammar blocks the support row; file-only output is the truthful runtime limitation, not acceptance.

## V05 — conservative matching and coverage (SC05)

Use duplicate/nested names, overloaded members, forward declaration versus definition, rename-plus-body-edit, moved declarations, independent same-name additions, anonymous callbacks, edited type fields, module statements, directives and style/template regions. Expected correspondence comes from explicit authored examples. Ambiguous cases must remain ambiguous, not selected by a fuzzy score.

Provide malformed headers, missing tokens, a valid header with invalid body, and a temporarily empty/truncated save. Assert both error-node and missing-node recovery affect coverage. Every changed region maps to a declaration/body/region marker or named incomplete range. Do not call a disappeared malformed declaration a confirmed deletion. Test parameter/default redaction and that truncation cannot form a false valid signature. Cold report reading must return the recorded fragments, not reparsed current bytes.

## V06 — real capture and path safety (SC06)

Use real Linux filesystem operations for concurrent rename/replace/save, symlink creation at ancestors and the final component, a FIFO/device-like rejected fixture, paths outside the registered root, deleted descriptors, unsupported filename encoding, and oversized files. Capture only after opened-object containment/type is established. Instrument the observation boundary to prove rejected external objects are not read. A final-component no-follow flag alone does not prove ancestor containment.

The positive oracle is the byte sequence actually retained through the qualified file descriptor; the report hash, ranges and fragments must agree with those bytes. Mixed-time file captures are labelled non-atomic. Deliberately mutate the live file after capture and verify report/details do not switch to it. Test blob/worktree differences caused by attributes/line endings without executing project filters. Missing objects in a partial repository remain unavailable; no network fetch is attempted.

## V07 — bounded monitoring and superseded results (SC07)

Drive the actual helper and watcher interface with controlled save sequences. Prove only changed/explicitly watched files are parsed, identical bases are shared, queue entries coalesce per file/generation, and late results cannot become current after a new capture or work epoch. Compare incremental parse extraction with a full parse of the same captured bytes for consistency, while independent V03/V04 fixtures still own correctness.

Inject watcher overflow/missed events, disable a watch, create an untracked scoped file and rename a directory. Assert a coverage gap and bounded inventory repair, never “no changes” from missing events. Under continuous edits, enforce fair per-work scheduling and expose incomplete coverage rather than starving quiet work or growing memory. Event hints/inventory sweep count is measured, not guessed. Mid-save states may be reported incomplete; the contract does not promise all transient keystrokes.

## V08 — notices without model work (SC08)

Use two parents, three workers and actual coordination-facing transport. Cases: unrelated edits, broad folder-only overlap, same declaration modified by both, one watched declaration changed, default-only value changes, unresolved same-name references, repeated identical report views, reversion to input, muted notice, lost response and reconnect cursor gap.

Assert the policy-selected recipient and exact bounded structural payload, not a prose semantic conclusion. Observe provider/evaluator launch/invocation boundaries: source monitoring adds **zero** inference requests, explanation requests, automatic worker messages and automatic model wake-ups. Existing parent-requested worker execution is excluded from that zero count and recorded separately. Authorization is evaluated again before delivering details. Reading/acknowledgment/retry must not discard an undelivered notice or force every parent to fetch the whole board.

## V09 — announcement/start races (SC09)

At the real coordination store boundary, race two announcements for the same path. One committed ordering must expose the other's already registered work; no check-then-register gap can let both receive an authoritative empty view. Race a third announcement between a gated parent's view and submit: a relevant new overlap returns `coordination_changed` before task admission; unrelated state changes do not require another parent decision.

Advisory inline submission continues normally and reuses the existing objective. Announce-then-start by reference does not require a second prompt copy. Crash before task publication, after task publication but before linkage projection, and after receipt send loss. Reopen and assert at most one native execution for the accepted identity. A durable accepted/uncertain task is recovered by its key, not resubmitted. Observe resource/worker counts: unstarted announcements use no inference slot.

## V10 — attribution, agreements and disclosure (SC10)

Exercise all sharing policies selected by M0 with authorized and unauthorized parents. Knowing a task/case/note ID is not enough. Structural fragments and relay metadata obey current sharing; full prompts, credentials, approvals and unrelated reports remain private. Revocation followed by retained-report/detail access must deny new disclosure without rewriting history.

One party's proposed agreement remains a proposal until every required named party acknowledges the exact revision. Silence, a forged actor, a changed note revision, task adoption and a dismissed human prompt cannot create agreement or permission. Source comments or parent text containing tool-like instructions are rendered as attributed data. Required-real host/operator adoption/handoff behavior is tested separately from controlled permission fixtures.

## V11 — leadership and coordination recovery (SC11)

Race three parents claiming the same canonical repository/full target ref. Assert one active case and one lead. Revise one selected input commit and the observed target; case identity remains constant, case revision advances, and new input hashes cannot obtain parallel leadership. Different declared targets remain independent.

Race update/release/transfer under expected revision/generation. Verify idempotent retry, lost acknowledgments, process crash/reopen, explicit operator adoption, stale old-owner request, and re-claim after explicit closure. Advance clocks or remove all connections: neither expires the claim. Leadership grants no control over peer tasks and performs no merge, reset, ref update, commit, push or source edit. A claimed case with an unmediated integration of unknown outcome cannot be silently transferred as safe; recovery records target uncertainty.

## V12 — supervision stays responsive (SC12)

Start actual controlled native work and capture task/process identity. Then crash or wedge the parser helper, exceed an analysis budget, overflow observation queues, hold a parent wait, detach every client, and hold a Git hook. Assert known agent work continues; explicit control/input channels remain available; no observation timeout turns into task cancellation. Every started helper job settles as completed, failed, superseded or cancelled analysis.

Reproduce the cancelled-workspace-signal delivery path: a worker commits, an explicit cancellation is accepted, shutdown is confirmed, and final collection still identifies the partial Git result. For unconfirmed stop, preserve resources and state instead of pretending delivery is stable. Qualify moving worktree creation/hooks outside a broad administrative critical section with concurrent independent submission and cancellation. Controlled peers prove Passeur ordering; the actual named provider's liveness/stop/approval claims remain inherited required-real acceptance.

## V13 — case input protection and cleanup (SC13)

Select exact task commits in a case, then race owned-worktree/ref retirement. The owning resource order must either reject selection/retirement or prove retained/archive protection before removing a reachability root. Record protected OIDs before mutation and verify their continued reachability afterward; `fsck` success alone is not the oracle.

Include reconstructed/cherry-picked candidates with no full-tip ancestry, dirty/untracked/ignored residue, changed branch heads, locked worktrees, uncertain native workers, and external registered workspaces. The original source commits remain protected through the explicit permitted disposition; external workspace removal is never a side effect of closing a registration or case.

## V14 — versions, packaging and old state (SC14)

Round-trip actual supported baseline request/result/control fixtures and reject unknown versions. New request v5 linkage and public envelope variants are decoded at producer/consumer/store boundaries. Legacy v1 submit keeps its original identity/response meaning and is not silently represented as fully coordinated. Coherent internal changes update all consumers in one candidate. Retained v4 results linked to a new request version require explicit cross-field proof.

Test first enable, repeated enable, incompatible running service, interrupted new control initialization, corrupt/missing control after initialization, valid derived-cache deletion/rebuild, and rejection of destructive reset. The initialized marker/control publication protocol must distinguish “never enabled” from “lost authority”; its exact owner is part of M0's storage admission. A parser cache being absent is not the same condition.

Install without a source checkout and load all parser artifacts. Verify lazy catalog/status/history when parser or native provider is missing. Cutover changes named registrations only with operator authority; an incompatible service is diagnosed, not killed. Old binaries are not claimed safe mutators of new coordination state. No command silently deletes records/refs or changes state root to make rollback work.

## V15 — actual parent workflow and skills (SC15)

With authorized installed hosts/adapters, use two independent parent sessions and at least three workers across two languages, plus the installed per-language coverage suite. Include one parent with two workers, another with one, a direct external writer registration, pre-start overlap, long quiet work, one structural notice, explicit parent note, a checkpoint retrieved by another parent, and one target lead.

The parents choose any instruction changes, checks and integration outside Passeur. Passeur carries only factual notices and explicitly authored messages. Close/reopen a parent and recover the same tasks/case; complete work and account for exact resources. A fresh skill-aware session performs the workflow without relying on hidden conversation history. Record every extra tool/model interaction and whether it was necessary for an actual coordination decision. Fake MCP clients do not satisfy this user-workflow claim.

## V16 — measured resource and context budget (SC16)

M0 fixes the representative machine, Node/grammar bundle, storage, corpus manifest and workload sizes **before** acceptance measurements. Record cold startup/all-language lazy load, warm single-file parse, multi-worktree shared-base reuse, burst saves, huge/rejected files, malformed code, Svelte embedding, and helper restart. Measure process CPU, service/helper peak RSS, parse jobs/bytes, queue/capture/cache limits, control-response latency, source scans and delivered payload bytes. Measure against the admitted Passeur workload and resource budget. Record cold/warm configuration, sampling variation and consumer impact; unmeasured performance claims remain pending.

Starting engineering policy for qualification (not measured performance): one parser slot; up to 64 queued latest-file jobs; 2 MiB per captured file; 16 MiB aggregate queued capture buffers; 128 MiB reusable extraction/capture cache. Large generated files may exceed this domain and must return a limit/coverage result. Parser-native allocation overhead is separately measured; JavaScript cache bounds alone do not bound process RSS. M0 may change these proposed values with a named capacity/consumer rationale before they become the sole config/schema authority.

A normal notice should fit a proposed 4 KiB page budget with a returned continuation, within the actual outer tool payload bound. This is a byte budget, not a token guarantee. Main-service control responsiveness under burst load is a separate budget selected on the representative machine; acceptance remains pending until its numeric limit and observed percentile/sample distribution are recorded. A tiny absolute time target invented on another machine is not evidence.

Prove bounded behavior at limits and zero additional monitoring-induced model calls. Model context savings are reported as bytes/observations delivered versus the corresponding available raw source difference, with query/detail costs included. Cache hit rate and repeated-suppression counts explain results; no unmeasured universal efficiency claim is accepted.

## V17 — final scope, standards and resource acceptance (SC17)

Run the actual pinned repository commands after explicitly authorized dependency provisioning: `npm run check`, `npm test`, `npm run build:runtime`, plus parser-bundle and installed-path checks added by this plan. Record what each command proves. A subset passing while full pinned checks are unavailable leaves the corresponding claim blocked.

Review the material candidate independently at the final PR/integration boundary, including syntax/matching accuracy, source identity, trust/credential isolation, parent-only instruction authority, multi-owner claim races, persistence, resource protection, notification cost and all required language coverage. Record findings and affected re-verification; unrelated evidence-only commits do not invalidate an unchanged reviewed subject. Complete staged scope/repository-state review, ordinary hooks/signing, lifecycle evidence, plan-created resource dispositions and an all-eight-probe composition review against observed change locality.

## Evidence-boundary summary

Language specifications and independently authored source examples decide extraction expectations. Real Git repositories decide endpoint/ancestry/retirement properties. Actual filesystem and independent processes decide race, containment and IPC effects. Controlled peers decide only their modeled lifecycle. Named native hosts/providers decide live conformance. Instrumentation decides CPU/RSS/context-cost observations. No single source, snapshot, compiler success, suite label or test count proves all these claims.
