# Source authority and baseline reconciliation

Current implementation baseline: Passeur `49724a8b65bf7540622934e4f25cc3178f9c00dc`. Standards remain `366c1d90a24bbfb50973f62b155a5f3396c0f107`. Production-source subtree identities were verified before editing; see the package evidence. Native Codex source identity and consumed official schemas are in `docs/agents/codex.md`.

The retained original admission below is **historical evidence only**, not current implementation authority. In particular, its old direct-MCP composition and partial-decoder observations were superseded by the startup baseline and this plan's explicit reconciliation. Current owners and behavior are in `plan.md`, `revision-reconciliation.md` and `docs/agent-adapters.md`.

---

## Original b0c162d admission (historical)

Prepared September 20, 2026. This record supports design admission. It is not an implementation report or a completed compliance audit.

## Examined revisions

| Repository | Revision |
| --- | --- |
| MrScripty/Passeur | `b0c162d779f52b1c7bb19274013d56d634020513` |
| MrScripty/Coding-Standards | `366c1d90a24bbfb50973f62b155a5f3396c0f107` |

Revalidate the current checkout, instructions, active contracts, and source drift when implementation is admitted. Record the adopted revision and material changes rather than applying a changed standards library implicitly.

## Passeur source observations

The following are source observations, not claims that the production paths were executed here.

| Owner/source at examined revision | Observation relevant to this plan |
| --- | --- |
| `docs/design.md` | One coordinator per canonical Git repository, global queue/capacity, worker-owned checks/commits, Passeur-owned lifecycle/delivery/disposition; current scope excludes merge/test/repair ownership. |
| `src/muse/types.ts` | A worker interface already receives assignment, workspace, signal, approvals, and events; it remains located under the vendor directory and consumes the shared Muse-specific profile. |
| `src/core/coordinator.ts` | One injected worker handles all assignments; request hashing, queue/deadline/cancellation ownership already exist. The common assignment prompt still uses a Muse-named report marker. |
| `src/muse/adapter.ts` | The SDK adapter owns startup/session/turn, native permissions and approvals, model checking, events, and bounded cleanup. Its native implementation is not an arbitrary-agent interface. |
| `src/contracts/types.ts` and `index.ts` | Execution requests/results use v2; the profile uses v1 with one executable/model and subscription policy. Handwritten type and schema projections require coordinated change. |
| `src/store/task-store.ts` | Immutable result publication and atomic JSON machinery exist, but several record readers perform partial field checks followed by complete type assertions. |
| `src/core/recovery.ts` | Restart recovery does not replay inference, but currently receives a model from its caller when constructing an interrupted result. |
| `src/mcp/server.ts` | Four Muse-named tools, a default Muse adapter, and same-call waiting are the current surface. Human elicitation is checked before current delegation. |
| `src/cli.ts`, `src/codex/config.ts` | Setup, tool allowlists, and diagnostics have Muse-specific assumptions; existing state/config roots and caller registration are real migration-sensitive identities. |
| `AGENTS.md` and `.agents/skills/muse-bridge/SKILL.md` | The current repository agent instructions route bridge use/setup and describe worker/caller responsibility. The adapter-authoring workflow is a new deliverable. |
| `package.json` | The project declares pinned TypeScript, SDK, schema, test, and locking dependencies and the check/test/build commands. Declared minimum Node support must be reconciled with the actual pinned dependency requirements. |
| `docs/compatibility.md` | The earlier implementation report distinguishes partial core/substitute verification from full pinned and live-runtime evidence still not executed or pending in that environment. Those historical statements do not prove the current machine's state. |

[Passeur source tree at the examined revision](https://github.com/MrScripty/Passeur/tree/b0c162d779f52b1c7bb19274013d56d634020513).

## Coding-Standards authorities read for plan admission

The authoritative revision is linked below. Canonical owners, rather than legacy uppercase navigation pages, define the obligations. The implementation route additionally follows the current Router and each selected module's `Requires` closure; this source list is not permission to skip applicable modules later.

| Canonical source | Relevant obligation used by this plan |
| --- | --- |
| `CORE-STANDARDS.md` | Preserve the actual objective, bound write scope, assign coherent ownership, validate boundaries, avoid fabricated results, and require claim-matched acceptance evidence. |
| `STANDARDS-ROUTER.md` | Route from observable task facts; load only applicable modules and their prerequisites. |
| `workflows/planning.md` | One plan directory with separate current authority/ledger/issues/reports; explicit path and operation; one next slice; milestone gates; objective claims; composed-design applicability. |
| `workflows/implementation.md` | Coherent scoped changes, no reachable incomplete behavior, exact admitted ownership and verification, explicit planning authority. |
| `workflows/verification.md` | Evidence kind, required environment, and execution mode are independent; simulated native behavior cannot establish required-real guarantees. |
| `workflows/commit.md` | Staged review, coherent commits, justified isolation, explicit integration/history authority, and exact protected-resource disposition. |
| `workflows/development-proportionality.md` | Implement a sufficient reversible design; further investigation needs a decision-relevant uncertainty and stopping condition. |
| `topics/architecture.md` | Full composed-design artifact probe, caller knowledge/locality/deletion tests, independently scoped authority, explicit composition. |
| `topics/contracts.md` and `topics/contracts/evolution.md` | Complete boundary proof, separate contract classes, real consumer-derived migration, internal coordinated replacement, no implicit fallback. |
| `topics/concurrency.md` | Task/failure/shutdown ownership, no external callbacks under locks, explicit coordination and test-resource isolation. |
| `topics/security.md` | Distinguish validity and authorization; approved credential routes; bounded safe diagnostics; structured executable arguments; real filesystem authority. |
| `profiles/languages/typescript.md` and `profiles/languages/typescript/async.md` | Derive contract projections from authority; types/casts are not runtime decoding; own each invocation and asynchronous completion. |
| `profiles/boundaries/ipc.md` | Complete action-specific decoding before dispatch and explicit malformed/unsupported/unavailable outcomes. |
| `profiles/boundaries/persistence.md` | Authoritative source/destination states, validated durable publication, real reopening/interruption evidence, and explicit migration authority. |

[Coding-Standards at the examined revision](https://github.com/MrScripty/Coding-Standards/tree/366c1d90a24bbfb50973f62b155a5f3396c0f107).

The plan selects additional conditional detail for implementation where relevant: documentation, code design, protocol/schema projections, diagnostics, resilience, launcher, tooling, dependencies/licensing, generated contracts/build, and actual supported filesystem/process platforms. Admission records their exact applicability; future implementers must read those canonical owners before making the affected decisions.

## External protocol and skill sources

- [Agent Skills specification](https://agentskills.io/specification): authoring format, required name/description frontmatter, matching skill directory, progressive references, and lean skill instructions.
- [Official Codex skills documentation](https://developers.openai.com/codex/skills): repository skill placement and optional client-facing `agents/openai.yaml` metadata.
- [Official Codex app-server documentation](https://developers.openai.com/codex/app-server): a documented native integration candidate with initialization, task/event flow, native approvals, and interrupt handling.

These external pages are moving documentation, not an installed-client qualification record. Pin the actual native version/schema used at execution. In particular, a successful interrupt acknowledgment is not evidence that all runtime processes or descendants have terminated. The plan deliberately requires independent process observation.

## Interpretation boundaries

Passeur's current public/retained contracts govern existing users and historical records. Internal abstractions may be replaced atomically when all actual consumers change together. The proposed neutral tool names, v3 execution envelope, profile v2, new registration commands, and worker-side Codex adapter are design decisions in this plan, not descriptions of code already present.

The objective-branch/final-PR external-review workflow is an explicitly selected project workflow. The examined standards do not require a PR or external service for every commit or every completed worker. Coding-Standards governs the development process and acceptance evidence; Passeur's runtime does not become a standards enforcement or delegated-project testing engine.

## Work not performed

Preparation did not run Passeur's dependency installation, typecheck, test suite, build, live CLI inference, billing validation, native permission tests, process-tree tests, or final external review. It did not inventory every production owner exhaustively; M0 owns that finite compliance baseline. No maintainer credentials, account configuration, persistent store, or GitHub repository was modified.

The included agent skill is complete authored guidance, but its behavioral qualification and use for the second real adapter remain M2/M3 acceptance work. Package syntax/link validation cannot substitute for that workflow evidence.
