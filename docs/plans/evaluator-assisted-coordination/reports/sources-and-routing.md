# Sources, standards route and adoption boundary

## 1. Examined authorities

| ID | Source | What it establishes / limitation |
|---|---|---|
| P01 | [Passeur repository instructions](https://github.com/MrScripty/Passeur/blob/f9a7c5d2d314580e5f7849982cf158397f9c11de/AGENTS.md) | Explicit plan path/operation, routed standards, preserved lifecycle authority |
| P02 | [Shared service](https://github.com/MrScripty/Passeur/blob/f9a7c5d2d314580e5f7849982cf158397f9c11de/docs/shared-service.md), [task lifecycle](https://github.com/MrScripty/Passeur/blob/f9a7c5d2d314580e5f7849982cf158397f9c11de/docs/task-lifecycle.md), [design](https://github.com/MrScripty/Passeur/blob/f9a7c5d2d314580e5f7849982cf158397f9c11de/docs/design.md) | Existing shared owner, durable tasks, parent-owned development and external integration |
| P03 | [Workspace implementation](https://github.com/MrScripty/Passeur/blob/f9a7c5d2d314580e5f7849982cf158397f9c11de/src/workspace/worktree.ts), [coordinator](https://github.com/MrScripty/Passeur/blob/f9a7c5d2d314580e5f7849982cf158397f9c11de/src/core/coordinator.ts), [Git helpers](https://github.com/MrScripty/Passeur/blob/f9a7c5d2d314580e5f7849982cf158397f9c11de/src/workspace/project.ts) | Dirty-source and cancellation-collection source paths; source inspection is not runtime reproduction |
| P04 | [TaskStore](https://github.com/MrScripty/Passeur/blob/f9a7c5d2d314580e5f7849982cf158397f9c11de/src/store/task-store.ts), [task controls](https://github.com/MrScripty/Passeur/blob/f9a7c5d2d314580e5f7849982cf158397f9c11de/src/core/task-control.ts), [contracts](https://github.com/MrScripty/Passeur/blob/f9a7c5d2d314580e5f7849982cf158397f9c11de/src/contracts/tasks.ts) | Existing atomic file publication, immutable records, idempotency/control and strict versions |
| P05 | [Service dispatch](https://github.com/MrScripty/Passeur/blob/f9a7c5d2d314580e5f7849982cf158397f9c11de/src/service/server.ts), [service contract](https://github.com/MrScripty/Passeur/blob/f9a7c5d2d314580e5f7849982cf158397f9c11de/src/contracts/service.ts) | Actual message/actor/response boundaries to extend without parallel authority |
| P06 | [Compatibility](https://github.com/MrScripty/Passeur/blob/f9a7c5d2d314580e5f7849982cf158397f9c11de/docs/compatibility.md), [lifecycle plan](https://github.com/MrScripty/Passeur/blob/f9a7c5d2d314580e5f7849982cf158397f9c11de/docs/plans/shared-service-and-evidence-driven-lifecycle/plan.md) | Baseline remains Verifying/acceptance blocked; inherited required-real evidence is not silently closed |
| P07 | [Package](https://github.com/MrScripty/Passeur/blob/f9a7c5d2d314580e5f7849982cf158397f9c11de/package.json), [runtime build](https://github.com/MrScripty/Passeur/blob/f9a7c5d2d314580e5f7849982cf158397f9c11de/scripts/build-runtime.ts) | Existing pinned toolchain and installed consumer path; a new runtime parser dependency must be packaged explicitly |

The default-branch commit observed during planning was the same Passeur baseline named above. The standards default branch was likewise `366c1d90a24bbfb50973f62b155a5f3396c0f107`. Implementation still inspects actual checkout state and intervening changes; neither statement imposes an exact-HEAD-only rule or authorizes discarding later work.

## 2. Standards route

Read [Core](https://github.com/MrScripty/Coding-Standards/blob/366c1d90a24bbfb50973f62b155a5f3396c0f107/CORE-STANDARDS.md), then [Router](https://github.com/MrScripty/Coding-Standards/blob/366c1d90a24bbfb50973f62b155a5f3396c0f107/STANDARDS-ROUTER.md); use [Planning](https://github.com/MrScripty/Coding-Standards/blob/366c1d90a24bbfb50973f62b155a5f3396c0f107/workflows/planning.md) and the [plan template](https://github.com/MrScripty/Coding-Standards/blob/366c1d90a24bbfb50973f62b155a5f3396c0f107/templates/PLAN-TEMPLATE.md). The following route follows the concrete planning/implementation boundary. Load selected Requires prerequisites and exact applicable details before changing their owning source; do not read every unrelated module by default.

| Group | Selected canonical owners | Applicability |
|---|---|---|
| Planning/development | `workflows/planning.md`, `implementation.md`, `verification.md`, `development-proportionality.md` | Sequencing, code changes, claim-based acceptance and bounded investigation |
| Change/distribution | `workflows/commit.md`, `documentation.md`, `build.md`, `tooling.md`, `release.md` | Shared source/fixtures, parser build inputs, installation, published support/migration |
| Architecture | `topics/architecture.md`, `code-design.md`, `architecture/replay.md` | Distinct state/lifecycle owners, all-eight-probe composition, exact retained report identity; replay promise is only the declared retained report/source availability, not reconstruction of arbitrary evicted workspaces |
| Contracts | `topics/contracts.md`, `contracts/schemas.md`, `contracts/protocols.md`, `contracts/evolution.md` | Complete decoding, generated MCP projections, independently deployed private IPC, persisted history |
| Concurrency/operation | `topics/concurrency.md`, `resilience.md`, `diagnostics.md`, `performance.md` | Helper/job lifetime, supersession, coalescing, recovery, typed limitations and measurable resource bounds |
| Trust/dependencies | `topics/security.md`, `dependencies.md`, `licensing.md`, `cross-platform.md` | File capture, parent authority, native parser/scanner artifacts, paths and supported local Linux filesystem |
| Boundaries | `profiles/boundaries/ipc.md`, `persistence.md`, `generated-contract.md` | New helper/service protocol, durable coordination updates and generated tool schemas |
| Application/language | `profiles/applications/launcher.md`, `profiles/languages/typescript.md`, `profiles/languages/typescript/async.md` | Installed helper launch, TypeScript implementation and async invocation authority |
| Oracle/platform details | `workflows/verification/oracles.md`, `workflows/verification/platforms.md` | Independent source/range expectations, exact negative-failure tests and required platform/runtime evidence |

The listed Core/Router, Planning, Architecture/Code Design, Contracts/Evolution, Concurrency, Persistence, Security, Commit and task-source authorities were read in this conversation. This planning pass refreshed relevant current revisions and read the TypeScript Async, IPC, Dependencies, Licensing, Performance and Independent Test Oracles owners. No executable standards-engine route or full compliance audit was run here. M0 records the executable route when available and resolves any material routing gap rather than asserting closure from this table alone.

Conditional additions: if implementation writes a new native Node binding or changes external-scanner/FFI ownership, route Interop/Language Binding and applicable implementation-language profiles before that write. Consuming an approved upstream grammar is not permission to handwrite a new parser. Writing Rust/C/C++ source is not currently proposed merely because those languages are parsed. User-workflow tests use actual CLI/MCP hosts, not a new GUI; frontend/Godot/GUI profiles are excluded unless scope changes. Accessibility is reassessed only for a materially new interaction obligation, not assumed from the existence of text.

Concurrent Plan Integration is initially not selected for one serial integration owner with non-authorizing research and disjoint implementation tasks. Select it if real authorizing proposals can become stale against mutable plan/shared authority. That workflow profile is not the runtime algorithm for Passeur's code coordination.

Mandatory violations in the affected semantic family must be closed or handled through an explicitly authorized exception before the associated acceptance claim passes. Nearby unrelated improvements do not expand the plan automatically. No plan or test suite certifies the whole present/future codebase.

## 3. Primary technical references

| ID | Reference | Role |
|---|---|---|
| T01 | [Git diff](https://git-scm.com/docs/git-diff) | Explicit source endpoints and raw diff escape hatch; no ambiguous comparison base |
| T02 | [Git objects](https://git-scm.com/book/en/v2/Git-Internals-Git-Objects) | Git owns contents, tree and commit identity; metadata does not create another source history |
| T03 | [Tree-sitter native Node binding](https://github.com/tree-sitter/node-tree-sitter/blob/master/README.md) | Established native parsing and incremental tree editing; inspected README blob `395c44357f47935a31ab28cc03b1298677aa4b66` |
| T05 | [Tree-sitter code navigation](https://tree-sitter.github.io/tree-sitter/4-code-navigation.html) | Language-specific definition/reference captures; not proof of resolved types or call targets |
| T06 | [Tree-sitter query syntax](https://tree-sitter.github.io/tree-sitter/using-parsers/queries/1-syntax.html) | Explicit error and missing-node recovery, grammar querying |
| T07 | [Svelte 5 snippets](https://svelte.dev/docs/svelte/snippet), [Svelte grammar](https://github.com/tree-sitter-grammars/tree-sitter-svelte/blob/master/grammar.js) | Required snippet/embedded syntax; inspected grammar blob `c39de050514ae72205c82e6fff229e81546d2bb2` has raw-text embedded regions |
| T08 | [React JSX](https://react.dev/learn/writing-markup-with-jsx), [TypeScript/TSX grammar](https://github.com/tree-sitter/tree-sitter-typescript) | Framework/dialect routing and source syntax, no inferred props |

These documentation snapshots inform design, not an installed dependency pin. M0's grammar manifest records actual approved full source revisions, ABI, artifact digests and licensing. No “latest” runtime resolution is permitted by these links.

## 4. Evidence scope

The source baseline and adopted standards identify the implementation authority. Technical references identify parsing, Git and language contracts; they are not proof that the planned installed runtime has been built or qualified. All planned behavior is justified by Passeur's stated responsibilities and acceptance claims. Native parser packages, generated scanners and extraction queries require their actual source, license, artifact and ABI qualification before distribution. This package contains planning documents only.

## 5. Evaluation authority and technical sources

[Provider qualification](evaluator-provider.md) records the retrieved current API facts and what remains unqualified. These facts establish a candidate interface only. Evaluation's probability distributions, thresholds, capture/disclosure authority, retry behavior, retention and versioning are explicit product contracts; no website claim of calibrated behavior proves Passeur's use case.

The selected standards route additionally applies Contracts/Protocols/Evolution to provider responses, Security to source egress and adversarial content, Persistence to dispatch/budget receipts, Resilience to missing/uncertain evaluations, Performance to cost/quality/attention budgets, and Verification/Independent Oracles to held-out semantic qualification. These use the same adopted standards revision. Evaluation owns neither native execution nor task acceptance.
