# Design admission, standards route and sources

## 1. Authority and transfer

This is a new completion plan with initial state Planned, not an instruction to run `continue` against the old Blocked plan. Explicit `start` admits R0 under this canonical path. R0 supersedes the old plan's **remaining planning authority**, preserving its product constraints, baseline implementations, evidence and SC01–SC17 population. A milestone may be implemented without being accepted. The shared-service lifecycle remains a separately owned prerequisite; use its contracts without marking unrelated pending evidence satisfied.

R0 records the actual source and consumer environment. A newer checkout is not automatically invalid; review material drift, preserve unrelated changes and adjust exact writes/claims where necessary. Package archives and generated documentation are not proof of the current checkout. F9 is already committed in the examined source, so applying its patch again is wrong.

## 2. All eight composed-design probes

### Probe 1 — independent concerns and their dimensions

| Concern | What / why | Owner / where | How / when |
|---|---|---|---|
| Assignment execution | Authorized native work survives conversations | Existing runtime/coordinator/adapters | Durable admission, evidence-driven lifetime; unchanged except explicit linkage barrier |
| Source observation | Exact inputs and captured current files without author inference | Source reader and observation manager | Git objects or qualified file handles at explicit/observed boundaries |
| Syntax extraction | Compact written declarations across required languages | Native helper and language extractors | Fixed bundled grammars, bounded jobs over immutable captured buffers |
| Coordination admission | Announced work becomes one exact accepted task | Existing control/TaskStore with narrow immutable announcement payload | Revision-checked binding and crash reconciliation before native eligibility |
| Relevance and delivery | Inform parents only about configured concrete interactions | Observation index/notices | Deterministic rules, snapshots and acknowledged cursors, independently of model turns |
| Source access | Disclose only authorized current evidence/detail | Work/task sharing and public report owner | Access checks at publication and every retrieval; identities are not permissions |
| Resource retirement | Retain selected task results safely | Existing F9 guard and disposition owner | Release-first metadata exclusion plus unchanged Git protection |
| Distribution | Load the same qualified native set away from source | Existing builder/installer with native bundle input | Explicit build/provisioning and installed verification, never implicit runtime repair |

### Probe 2 — necessary and accidental interleavings

Necessary ordering: relevant-set decision versus gated admission; durable task identity versus link settlement/native start; task adoption versus enrollment/source access; case selection versus retirement; current capture generation versus helper completion; immutable report publication versus notice reference; authorization versus page retrieval; helper drain versus service shutdown. Each crosses explicitly named owners and must have a tested ordering point.

Accidental coupling to avoid: treating a client disconnect as task cancellation; using one version for grammar/query/task/store meanings; treating directory events as edits; using Git authors as parent IDs; making cursor delivery alter task outcome; holding metadata locks across Git, parsers, callbacks or human prompts. Timers schedule observations or limit disposable analysis, not authority or native assignment life.

### Probe 3 — knowledge required of callers and composition

Parents know task/work identities, exact selected inputs, their declared areas/watches, supported public operations and resumable cursors. They do not know AST node names, grammar package paths, helper handles or store layout. An ordinary coordinated submission reuses its assignment without another report.

The runtime knows helper lifetime/limits, configured language catalog and stable service interfaces. It does not branch on language grammar details or vendor-specific reasoning. Extractors know only their grammar/source coordinate contract and emit normalized syntax evidence. The public projection validates and formats, not interprets semantic intent.

### Probe 4 — representative change locality

A grammar/query update touches its bundle identity, extractor where needed, affected language fixtures and installed support claim; it does not change task history. A report-field change updates its canonical decoder and real CLI/MCP consumers with an explicit evolution decision. A new native agent adapter leaves parsing unchanged. A sharing-policy change affects authorization and delivery fixtures, not parsers. An announcement linkage change affects task/control persistence and recovery, not language queries. A resource-policy change remains with F9/disposition and case ordering.

The installed build identity necessarily changes with material native inputs. That does not mean every persisted task/control schema changes with it.

### Probe 5 — stable interfaces versus hidden representation

Stable interfaces carry captured source identities, typed extraction evidence, immutable report identity, authorized work references and bounded operation outcomes. Parser node handles stay inside the helper. Git ref formats and coordinate conversions remain with their exact owners. Opaque cursors are validated resumable positions, not authority grants.

The helper protocol must state byte/buffer bounds and cancellation/generation behavior; omitting those details would hide required lifecycle knowledge. The store protocol must expose uncertain publication rather than pretend several record writes form a transaction. These obligations are inherent and remain visible at the appropriate interface.

### Probe 6 — independent evolution and failure

Syntax extraction is verifiable with real parsers independently of native agents. Task linkage is verifiable with the actual store/coordinator and controlled native work independently of parsing. Installed/language/host tests then prove the composed path. A helper or grammar failure degrades observation without failing healthy coding tasks. A control-store authority failure prevents unsafe coordination changes; it is not a successful empty board.

Parsers and extractors can change under their own identities. Mutable incremental trees and configuration-sensitive indexes are not shared between independent workspaces merely because file contents once matched. Recovery does not re-run accepted inference.

### Probe 7 — deletion result

| Mechanism | What happens if removed |
|---|---|
| Native helper process | Parsing/native memory failures and synchronous work move into service supervision; required isolation disappears. |
| Grammar/extractor catalog | Dialect selection and artifact identity leak into every caller or become ambient package discovery. |
| Byte/embedded range owner | Correct offsets/redaction correspondence are duplicated and Unicode/Svelte mismatches become likely. |
| Immutable announcement payload | Reference submission must duplicate prompts in mutable metadata or cannot recover exact intended work. |
| Durable linkage barrier | Crashes can leave accepted unlinked work or repeat execution. |
| Disposable caches/index | Correctness can remain by recomputation, but performance/relevance cost rises; retain only measured useful caching. |
| Notice cursor/materiality state | Delivery becomes repetitive or silently lossy; model-context cost and reconnect correctness regress. |
| Existing F9 retirement guard | Selected results may lose their owned workspace/ref while reconciliation still depends on them. |

No semantic graph, new inference loop, managed merge/publication authority or general plugin engine is admitted. Deleting such proposed machinery would remove scope rather than expose a necessary responsibility here.

### Probe 8 — cumulative complexity and admission result

The necessary complexity is a multilingual native parser boundary, honest source/range representation, durable announcement linkage, and low-noise observation across independently living parents/workers. It is contained by the existing task/control/Git owners plus one analysis path, not a second agent framework. Complexity already implemented in F0–F9 is reused; thin public handlers are not replaced by another metadata API stack.

Admission accepts a real Rust/TypeScript vertical path before language expansion, and the complete native/installed/host gates before objective acceptance. It does not claim the design is simple because there are few modules, or correct because a large test count passes. Revisit composition only for measured broad propagation, unsupported native mechanisms or changed authority—not to start another speculative redesign cycle.

## 3. Standards reading and application route

Use the adopted revision `366c1d90a24bbfb50973f62b155a5f3396c0f107`. Read Core and Router first, then the canonical modules applicable to the slice and all their Requires. The table is a task-specific route, not a substitute for Router applicability or a requirement that each language worker read every topic.

| Slice condition | Canonical reading |
|---|---|
| All planned implementation and evidence | `CORE-STANDARDS.md`, `STANDARDS-ROUTER.md`; `workflows/planning.md`, `implementation.md`, `verification.md`, `development-proportionality.md` |
| Source commits/worktrees and durable documentation | `workflows/commit.md`, `documentation.md` |
| New helper/composition/public data contracts | `topics/architecture.md`, `code-design.md`, `contracts.md`; `topics/contracts/protocols.md`, `schemas.md`, `evolution.md`; `profiles/languages/typescript.md`, `typescript/async.md` |
| Immutable reports/detail replay | `topics/architecture/replay.md`; preserve source closure and unavailable retained details |
| Processes, IPC, shutdown and permission | `topics/concurrency.md`, `resilience.md`, `security.md`, `diagnostics.md`, `cross-platform.md`; `profiles/boundaries/ipc.md`; applicable `profiles/applications/launcher.md` |
| Announcements, linkage, migrations and durable cursors | `profiles/boundaries/persistence.md` and Contracts evolution; one accepted publication contract per invariant |
| Native dependency/build/package artifacts | `topics/dependencies.md`, `licensing.md`; `workflows/build.md`, `tooling.md`, `release.md`; `workflows/release/operations.md` when its release/rollback conditions apply |
| Generated public schemas/manifests | `profiles/boundaries/generated-contract.md` and its Requires; no copied independent semantic validators |
| Authored/adapted native wrapper, handles or foreign-memory boundary | `profiles/boundaries/interop.md`, `language-bindings.md` when those actual mechanisms change; inspect native API ownership even when consuming established bindings |
| New negative/extraction oracles and platform claims | `workflows/verification/oracles.md`, `verification/platforms.md` |
| Bounded resource behavior and representative CPU/memory/latency/context measurements | `topics/performance.md` |

Rust source fixtures alone do not create a new Rust runtime/build product. Select language-specific Rust/native rules only when actual implementation or build artifacts invoke them. No frontend UI/accessibility/Godot profile is selected for a CLI/MCP-only feature. Concurrent Plan Integration is conditional on outstanding authorizing implementation proposals, not the product's multi-agent behavior.

The reviewer checks both process and produced code: exact write ownership, native dependency authority, one canonical contract per meaning, complete decoding, resource/cancellation ordering, failure fidelity, migration semantics, claim-matched evidence, changed consumer closure and ordinary history preservation. No document or green partial suite certifies unrelated/future compliance.

## Source register

Sources were inspected on September 22, 2026, America/Vancouver. Repository references are pinned; upstream documentation explains mechanisms but does not qualify selected native artifacts. URLs below are usable by the receiving developer.

- **S1 — committed baseline:** [Passeur commit 2de20c7](https://github.com/MrScripty/Passeur/commit/2de20c756a375c726311767cd78b968c1161fdad). This is F9, not the earlier 8ddf6d9 preimage.
- **S2 — current old plan:** [structural-change-coordination/plan.md](https://github.com/MrScripty/Passeur/blob/2de20c756a375c726311767cd78b968c1161fdad/docs/plans/structural-change-coordination/plan.md). Owns the inherited code-only objective and release-first resource policy until R0 transfer.
- **S3 — F9 integration evidence:** [f9-verification.md](https://github.com/MrScripty/Passeur/blob/2de20c756a375c726311767cd78b968c1161fdad/docs/plans/structural-change-coordination/reports/f9-verification.md). Distinguishes 372 selected package tests from the recorded 475 core / 40 native / 100 frontend full-checkout run and its corrected coverage fixture.
- **S4 — source/extraction primitives:** [model.ts](https://github.com/MrScripty/Passeur/blob/2de20c756a375c726311767cd78b968c1161fdad/src/observation/model.ts) and [source.ts](https://github.com/MrScripty/Passeur/blob/2de20c756a375c726311767cd78b968c1161fdad/src/observation/source.ts). Internal values need real helper/public decoding; source capture has an eight-MiB ceiling and exact local-object checks.
- **S5 — actual runtime builder:** [src/install/runtime.ts](https://github.com/MrScripty/Passeur/blob/2de20c756a375c726311767cd78b968c1161fdad/src/install/runtime.ts) and [scripts/build-runtime.ts](https://github.com/MrScripty/Passeur/blob/2de20c756a375c726311767cd78b968c1161fdad/scripts/build-runtime.ts). Current source hash/copy/inventory/startup checks must be extended for native artifact inputs and real parser use.
- **S6 — standards authority:** [Coding-Standards at adopted revision](https://github.com/MrScripty/Coding-Standards/tree/366c1d90a24bbfb50973f62b155a5f3396c0f107). Core/Router and the applicable modules listed above govern this work; the connected repository's latest observed revision matched this adopted revision.
- **N1 — native binding:** [official Node Tree-sitter](https://github.com/tree-sitter/node-tree-sitter). Documents native parsing and tree editing; R1 pins and qualifies the actual runtime and grammar set.
- **N2 — parsing and error nodes:** [Tree-sitter basic parsing](https://tree-sitter.github.io/tree-sitter/using-parsers/2-basic-parsing.html) and [query syntax](https://tree-sitter.github.io/tree-sitter/using-parsers/queries/1-syntax.html). C and Node coordinate contracts must be distinguished; ERROR and missing tokens both matter.
- **N3 — filesystem observation:** [Node 22 filesystem documentation](https://nodejs.org/docs/latest-v22.x/api/fs.html#caveats). Watch behavior has platform/inode/filename limitations. Qualify the deployed version and actual replacement-file/event-gap path; no assumption of an exact edit log.
- **N4 — Svelte snippets:** [Svelte snippet syntax](https://svelte.dev/docs/svelte/snippet). Language syntax authority for independently authored embedded fixtures, not an extractor implementation.
- **N5 — JSX:** [React JSX documentation](https://react.dev/learn/writing-markup-with-jsx). Framework syntax context; JS/JSX and TS/TSX parser routes remain explicit.

The uploaded F9 ZIP and its verification attachment were inspected as delivery context. They predate the repository's complete-checkout integration addendum and fixture correction. Use the committed sources as authority; do not overwrite them with the earlier package. No native parser was built or tested during preparation of this handoff.
