# Initial findings and dispositions

All findings below are planning/source observations unless explicitly stated otherwise. They are not reproduced runtime failures. Severity denotes consequence for this objective, not an independently verified incident priority. The lead rechecks exact source in M0 before changing implementation.

| ID | Finding / evidence | Relevance and owner | Disposition / required evidence |
|---|---|---|---|
| SCC-I01 | Baseline `src/workspace/worktree.ts::prepareWorkspace` requires a clean source checkout before creating an isolated exact-base task. | Concurrent parent work; workspace owner. | Fix in M1 after V12/V01 regression. Preserve source views; do not import dirty bytes. |
| SCC-I02 | Workspace retains execution signal; baseline final collection calls `observeDelivery(workspace)` using that signal. An already cancelled task may interrupt evidence collection despite confirmed stop. | Useful retained handoffs; coordinator/workspace lifetime family. | Reproduce in M0, fix the whole collection family in M1; V12. Not claimed confirmed solely from source. |
| SCC-I03 | Worktree preparation is performed through broad administrative coordination; Git hooks may run inside that duration. | Control responsiveness and independent work; resource owner. | Bound creation/retirement intents, release broad guard before hooks, test actual interleaving in V12. Preserve ownership; do not merely remove synchronization. |
| SCC-I04 | Parser existence and tags do not prove parameter/result extraction; Svelte snippet arguments include raw embedded regions. | Required thirteen-language guarantee; observation owner. | M0 packaging admission then L01–L13/V03–V05. Modern unsupported core constructs block the relevant row. |
| SCC-I05 | Exact native parser pins, Node/grammar ABI, scanner packaging and safe file-descriptor capture are not qualified here. | Deployment/security/performance. | Finite M0 decisions using disposable probes. No implicit install, executable grammar loading from projects or weakened capture. |
| SCC-I06 | Existing strict task/IPC outputs and owner-only access cannot be extended informally with cross-parent fields. | Disclosure and compatibility; contracts/security owners. | New versioned coordination surfaces; preserve old outputs/history. V09/V10/V14. |
| SCC-I07 | A target case identified only by its selected commits permits competing ownership when a worker advances. | Reconciliation coordination. | Stable repository/full-ref key plus case revision/generation; V11. |
| SCC-I08 | Existing lifecycle plan is implemented but required pinned/native/installed acceptance is still blocked in its retained record. | Inherited behavior, not a reason to redesign the service. | Keep claims with original owner, qualify only changed/depended-upon behavior; required-real evidence before SC12/SC15/SC17 acceptance. |
| SCC-I09 | New runtime analysis could accidentally invoke filters, lazy fetch, compilers/builds or provider calls. | Domain boundary, CPU and authority. | Process-boundary no-effect tests V03/V06/V08; no source-aware tool launch merely from a model/path. |
| SCC-I10 | A bounded control aggregate must distinguish absent initial state from missing initialized authority and keep reliable receipts. | Persistence/claims. | M0 selects explicit enable marker/record protocol and key lifetime; V14 verifies interruption. Re-plan if real transaction/cardinality needs exceed aggregate. |

## Exclusions with revisit triggers

No compiler/type-resolution or inferred dependency engine is included. Revisit only if the user adopts a different semantic-analysis product boundary and a measured benefit justifies it. No managed publisher, global proposal lifecycle or exclusive file lease is included. Revisit only if explicit new integration/authority requirements demand it, with a new composed-design review.

Heavy-build resource claims are not in this implementation. Repository/machine build coordination remains with the parent or an existing resource owner. Revisit on an explicit request for that capability, not merely because Rust fixtures appear in the parser suite.

Structural merge tools are optional tools of the integrating parent. This plan neither installs them nor changes Git merge configuration. Revisit only for a separately authorized tool integration with supported language and trust/evidence requirements.

Optional deeper lexical-reference hints are not required for baseline notifications. Implement them only within the syntax-only contract when specific queries provide material coordination value; do not let them delay the required exact-watch/direct-overlap path or turn into a resolved semantic graph.

Any incompatible source or durable state discovered during admission receives an explicit inventory and preserve/migrate/reject decision. Unknown state is not disposable, and its appearance does not authorize deletion.

## I-ENV-01 — native qualification and complete checkout unavailable

Severity: acceptance blocker. Owner: implementation environment / maintainer-provided qualified build environment. Evidence: direct GitHub DNS failure; npm registry EAI_AGAIN; no native Node parser modules present; global TypeScript 5.8.3. Disposition: native M0/M1/M2 gates blocked; implement only the independently bounded F0/F1 work. Full pinned compiler/test/install/host checks and independent final review remain required. Revisit when the full checkout and pinned dependencies are actually available.


## I-F0-01 — Exact-base delegation was coupled to parent checkout cleanliness

Severity: behavior defect; source and reproduced runtime evidence. Owner: `prepareWorkspace`. Fixed in F0 by reading only the admitted commit for task inputs. The real Git fixture preserves parent staged, unstaged and untracked bytes. Full pinned regression suite remains required.

## I-F0-02 — Execution cancellation reached terminal delivery collection

Severity: retained-evidence defect; reproduced with a committed result and confirmed stop. Owner: coordinator finalization. Fixed in F0 by passing a collection workspace without the execution signal to delivery, changes and artifact creation. Unconfirmed stop still skips collection and preserves the safety freeze.

## I-F0-03 — A checkout hook held repository-wide administration

Severity: cross-task blocking defect; reproduced with an explicitly gated real checkout hook. Owner: coordinator workspace preparation. Fixed in F0 by retaining the short durable-intent publication guard while Git/hooks execute outside it. Active-task ownership remains in place. Full resource-disposition/native qualification remains required.

## I-ENV-02 — Limited checkout, package and compiler evidence

Severity: acceptance blocker; owner: maintainer/native qualification. Connected text retrieval is available but direct cloning/npm DNS failed. Native parser packages, full dependency installation, pinned TypeScript 5.9.3 checks, complete application tests and installed artifacts were not available. Available compiler/declarations were TypeScript 5.8.3 and Node 25.1.0 types. Disposition: block M0/M1 and affected SC claims; proceed only with the delivered independent internal increments. Revisit when a complete checkout and authorized dependency resolution are available.

## I-ACC-01 — Real host, parser and external-review claims remain open

Severity: acceptance blocker; owner: the plan's acceptance owner. No real provider/host accounts, parser extraction corpus, representative performance workload or independent reviewer was used. Disposition: preserve the original claim scope and require those gates before full acceptance. The controlled store does not prove persistence codecs or crash recovery.

## F2 current dispositions — September 22, 2026

| ID | Finding / evidence | Owner / disposition | Remaining evidence |
|---|---|---|---|
| I-F2-01 | A case input revision could otherwise detach an old note from revoked source access. Tests now retain original work_refs and recheck them on read/ack. | Coordination note owner; fixed in this increment. This is a bounded disclosure-invariant family, including current subject, historical context, parties and reads. | Public projections and real-host access still need conformance. |
| I-F2-02 | Reserving only receipt counts can leave insufficient serialized bytes for required release/revocation. Capacity checks now reserve bytes as well as slots. | Control admission owner; fixed for declared release paths; count and byte tests pass. | Representative cardinality/performance and eventual retention migration remain unqualified. |
| I-F2-03 | An external Git operation may continue after a parent disappears; changing a logical leader cannot stop it. | Control case owner; explicit possible-effect marker blocks handoff/release until lead-reported settlement. No fencing claim. | Operator recovery and real Git consumer protocol remain pending. |
| I-F2-04 | Internal syntactic IDs do not prove authentication, worktree membership or object existence. | Future service/workspace composition; new operations remain internal/unregistered. | Required real service/CLI/MCP, membership and retirement-race evidence before public support. |
| I-F2-05 | No native grammar bundle, full pinned dependency closure, installed host or independent review is available here. | Environment/maintainer; inherited I-ENV-01 remains blocking for the objective. F2 has only scoped compiler/real-file/process evidence. | Native M0, all language rows, full pinned checks, actual user workflow and external review. |

F2 implements the internal parts of SCC-I07 and SCC-I10; it does not close their
full consumer/path claims. Notes and cases are not yet exposed or connected to
retirement. None of these dispositions marks SC09–SC15 satisfied.

## F3 current dispositions — September 22, 2026

**I-ENV-01 remains blocked for native/full acceptance.** Direct registry access
still fails and the pinned native dependency bundle/full checkout are absent.
F3 is an explicitly scoped independent increment, not a parser substitute.

| ID | Finding and bounded family | Disposition and deciding evidence |
|---|---|---|
| I-F3-01 | New registration could use stale physical identity if source changed while the resource-authority callback was pending. Owner: source-gated admission. | Corrected in F3: re-observe after the callback; reject physical replacement; recheck input retention after HEAD change. The explicit race failed before correction and passes in final tests. |
| I-F3-02 | New repository observation initially depended on the opening linked checkout's continued existence. Owner: repository observation lifetime. | Corrected: use retained canonical common-directory identity for repository reads. Remove only the fixture's opening linked worktree and prove other-workspace operations continue. |
| I-F3-03 | New inventory interpretation initially refused healthy work when an unrelated unborn worktree existed. Owner: selected-source qualification. | Corrected: inventory retains that entry; selected unborn source is unavailable; other valid source remains usable. Independent fixture fails before correction and passes after. |
| I-F3-04 | Real host actor/resource authority, native analysis, public projections, task linkage and retirement ordering are unfinished consumers. Owner: M1/M3/M4 composition and resource integration. | Retain as required before advertisement/acceptance. Internal actors and resource policy are fixtures, not live proof; F3 exposes no public command. Revisit at next service integration. |
| I-F3-05 | The cold-reopen fixture path used `URL.pathname`, which retained `%20` in this checkout's directory name. Node could not find the child fixture; two tests failed during repository integration. Owner: F3 test harness. | Replaced the pathname conversion with `fileURLToPath`. Both tests and the full repository suite pass in this checkout; no production behavior changed. |

Source/ref validation never promises a transaction with external Git commands.
A stale/missing source does not release ownership or authorize replay. F3
failures above concern new code and are not claimed as baseline incidents.
See [F3 evidence](reports/f3-verification.md) and its exact scenario logs.


## F4 current dispositions — September 22, 2026

| ID | Finding / scope | Disposition / evidence |
|---|---|---|
| I-F4-01 | New reply validation initially checked key/action/subject but not the caller-computable command content hash. Owner: service destination codec. | Fixed across applicable reply commands. The independent wrong-hash receipt test failed before correction and passes afterward. Registration hashes include source-derived facts and are explicitly not recomputed from a different public shape. No baseline defect is claimed. |
| I-F4-02 | A new cold-reopen test initially used URL.pathname despite the committed fixture conversion rule. Owner: test harness. | Reproduced from a path containing spaces; replaced with fileURLToPath. All 175 final tests run from that path. Original I-F3-05 and committed test bytes are preserved. |
| I-F4-03 | Fixture listener cleanup tried to unlink a Unix socket already removed by Node; two expected names did not match the existing control contract. Owner: F4 test-only peer. | Corrected fixture cleanup to assert absent after observed server close and restored exact contract field/error expectations. Five known disposable roots retained by failed teardown were removed only after peer exit; final teardown evidence is complete. |
| I-F4-04 | Production election/actor authentication, operator initialization workflow, managed-workspace resource authority and outer transport admission remain unconnected. Owner: runtime/CLI/MCP/resource integration. | New session stays internal and unregistered. Actual framed transport is tested with explicit fixture identities/policies, not claimed production support. Revisit in next pinned-runtime integration slice. |
| I-F4-05 | Native Tree-sitter, full pinned dependency closure, actual installed/native host, independent reviewer and representative performance environment remain absent. Owner: inherited M0/acceptance. | Full plan and acceptance remain Blocked. Independent code/session evidence does not satisfy SC01–SC17 or advertise any structural language support. |
| I-F4-06 | The new framed IPC test imports the existing production transport from `.passeur-core`, but the package's core TypeScript file list omitted `src/service/transport.ts`. The test file could not load in the complete repository. Owner: core test build. | Added the transport source to `tsconfig.core.json`; all five focused IPC tests and the full repository suite pass. No production transport code changed. |

The source-gated behavior, command generation, note disclosure and persistent
coordination schema keep their existing owners. No timer releases authority,
no parser substitute is used, and no receipt/view digest is treated as consent.


## F5 current dispositions — September 22, 2026

| ID | Finding and owner | Disposition / required evidence |
|---|---|---|
| I-F5-01 | New managed-resource check accepted a reused former path after a managed worktree moved and detached. | Fixed with branch/path agreement; independently written negative fixture failed then passes. Details: F5-R1 in f5-review.md. |
| I-F5-02 | Equality-only comparison missed nested/containing physical workspaces. | Fixed with component-aware overlap and positive prefix-sibling tests; F5-R2. |
| I-F5-03 | Retired resource label alone did not establish terminal task state. | Require the actual inventory owner's task phase; F5-R3. |
| I-F5-04 | Namespace read can complete after shutdown selects the owners to close. | Open-state recheck before lazy session construction; lifetime construction review and general shutdown tests. No dedicated private-await race proof claimed. |
| I-F5-05 | Complete Runtime/TaskStore/public host and native parser dependencies are unavailable in this mirror. | Runtime executes with explicit task-inventory/lease/recovery seams; 236 focused tests do not close full pinned/native/installed claims. No substitute definitions or parser. |
| I-F5-06 | TaskStore.list performs a whole inventory read before the new 4096-record consumer cap. | Actual inventory implementation is retained. Large-store memory/latency and public saturation remain unqualified; measure at M0/M1 before performance acceptance, rather than claiming a bound on the complete path. |
| I-F5-07 | Public listener authentication, task linkage and case-aware retirement are not connected. | Keep the new entrypoint internal; implement and verify complete public/resource paths before advertisement. |

The existing I-F3-05 fixture path fix and I-F4-06 transport build-root correction
were preserved from the current commit. The new findings are about F5 code;
they are not attributed to the committed baseline. Operator access remains a
same-user application policy, not protection from arbitrary same-UID code.
