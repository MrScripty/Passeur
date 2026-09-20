# Standards route, baseline and source references

**Prepared:** September 20, 2026.  
**Passeur:** `MrScripty/Passeur@4f4ef0f12d116c7ac8f73474c0dd4e067e025ad3`.  
**Coding-Standards:** `MrScripty/Coding-Standards@366c1d90a24bbfb50973f62b155a5f3396c0f107`.

Repository files were inspected through the GitHub connector. This is read-only source/design evidence. No Passeur source was changed, application checks executed, personal registration installed or live inference run while preparing the bundle. The standards engine was not executed; do not report an automated conformance result.

## Baseline observations and precise authority

| Reference | Inspected owner | Observation |
| --- | --- | --- |
| P1 | `src/mcp/server.ts`, `src/cli.ts`, `src/core/profile.ts` | The lease, state initialization/import/recovery precede stdio connection. CLI project/worktree/profile/subscription prerequisites also precede the server. |
| P2 | `src/core/lease.ts` | mkdir is outside the catch; every exception from lockfile.lock becomes PROJECT_IN_USE. This is not literally a catch of every error in the entire function. |
| P3 | `src/codex/config.ts` | One constant registration name; a four-tool allowlist; config-only codex mcp get verification; handwritten TOML editing and backup restoration. |
| P4 | `passeur`, `src/cli.ts`, `package.json` | Checkout launcher uses dist/src/cli.js; generated registration captures its current import.meta.url. Existing scripts provide TypeScript/core/Vitest checks, not installed acceptance. |
| P5 | `src/store/task-store.ts`, `src/core/recovery.ts` | Recovery consumes partially validated persisted objects, and quarantineIncomplete catches all read failures before renaming. Recovery otherwise preserves interrupted/unconfirmed execution rather than replaying inference. |
| P6 | `src/workspace/project.ts` | Git common-directory identity is canonicalized and hashed. Supported non-Git directories use path identity for read-only work. This is not global GitHub-repository identity. |
| P7 | `src/core/coordinator.ts`, `.agents/skills/muse-bridge/SKILL.md`; referenced disposition boundary | Existing execution/resource responsibilities and same-call delegation form the preserved product boundary. Detailed changed consumers must be inspected before editing. |
| P8 | `docs/plans/parallel-worker-commit-handoff/plan.md`, `docs/compatibility.md` | Parallel-worker implementation is Verifying, with installed/runtime evidence outstanding. Do not replace this with accepted status based on the new plan. |
| P9 | Commit `4f4ef0f` | Corrects Muse client identifiers and adds a focused adapter regression; it does not itself prove live installed compatibility. |
| P10 | `AGENTS.md`, `tests/`, `tsconfig.core.json`, `tsconfig.json` | AGENTS routes to the existing skill; the current test/build structure determines affected tooling, not a universal new lint stack. |

Resolve a pinned source as `https://github.com/MrScripty/Passeur/blob/4f4ef0f12d116c7ac8f73474c0dd4e067e025ad3/<path>`.

The local Codex attachment incident is user-reported. Repository inspection supports reachable Passeur failure paths but cannot identify the exact local host startup trigger, current permissions, running executable or installed-version behavior.

## Selected standards route

Start with `CORE-STANDARDS.md` and `STANDARDS-ROUTER.md`. The following route follows observable changes; load each selected page's actual Requires closure and applicable detail before implementing that slice. The route is not a requirement to read unrelated descendants or a claim that every page below has been executed as a check.

| Task fact | Selected canonical owners |
| --- | --- |
| Bounded implementation, evidence, sequencing and safety decisions | `workflows/implementation.md`, `workflows/verification.md`, `workflows/planning.md`, `workflows/development-proportionality.md` |
| Governed change history and durable guidance | `workflows/commit.md`, `workflows/documentation.md` |
| Runtime ownership, new composition and readiness | `topics/architecture.md`, `topics/code-design.md`, `topics/concurrency.md`, `topics/resilience.md` |
| Typed errors, status and trust-sensitive launch/state operations | `topics/diagnostics.md`, `topics/security.md`, `topics/contracts.md` |
| Serialized MCP/configuration and independently changing consumers | `profiles/boundaries/ipc.md`, `profiles/boundaries/generated-contract.md`, `topics/contracts/protocols.md`, `topics/contracts/schemas.md`, `topics/contracts/evolution.md` |
| Persisted record/recovery/configuration publication | `profiles/boundaries/persistence.md` |
| TypeScript and overlapping async invocations | `profiles/languages/typescript.md`, `profiles/languages/typescript/async.md` |
| Launcher/build/install/distribution/probe procedures | `profiles/applications/launcher.md`, `workflows/build.md`, `workflows/tooling.md`, `workflows/release.md`, applicable `workflows/release/operations.md` |
| Runtime closure, TOML adoption and shipped third-party content | `topics/dependencies.md`, `topics/licensing.md` |
| Canonical paths, actual filesystem/public support claims | `topics/cross-platform.md`, applicable `workflows/verification/platforms.md` |
| Independent negative/conformance evidence | `workflows/verification/oracles.md` |

Explicit exclusions: frontend, accessibility, Rust/C#/Godot-specific profiles, native FFI/language-binding profiles and unrelated performance optimization. Multiple participating agents do not select Concurrent Plan Integration; the plan selects serial authoritative writes. Re-route if that fact changes.

## Standards obligations embodied by this plan

Core establishes one authority, typed meaningful failures, owned asynchronous work and claim-matched evidence. Planning supplies the canonical artifact set, explicit invocation, one current next slice and pending/accepted distinction. Architecture supplies all eight composed-artifact probes; those are completed in design-admission.md for the proposed design. Development Proportionality favors the bounded production correction over another general framework or open-ended investigation.

Concurrency/TypeScript Async require observation of canceled and late completion, not merely an AbortSignal. Contracts/Persistence require complete actual boundary proof and preservation of supported historical representations. Diagnostics/Security require useful bounded disclosure without changing outcome meaning. Build/Release/Dependencies require an identifiable actual runtime closure and installed-artifact evidence, not a mutable dist path relabeled as installed.

No universal PR, new lint configuration, coverage threshold, branch-per-edit, commit count or custom standards enforcement engine is derived from these standards. A scope-relevant defect must be fixed or explicitly re-planned, not waved away as pre-existing; unrelated findings remain owned follow-ups.

Resolve a pinned standard as `https://github.com/MrScripty/Coding-Standards/blob/366c1d90a24bbfb50973f62b155a5f3396c0f107/<path>`.

## External protocol and tool references

Use the official source plus the installed consumer as independent authority. Documentation of a current option does not prove an older installed version supports it.

- OpenAI Codex MCP documentation: `https://developers.openai.com/codex/mcp/` (current redirect: `https://learn.chatgpt.com/docs/extend/mcp?surface=cli`). It distinguishes server startup timeout, tool timeout, enabled-tool filtering and an optional-server initial-catalog grace period. Verify the installed lifecycle/options instead of assuming a longer server timeout guarantees initial catalog inclusion.
- OpenAI configuration reference: `https://developers.openai.com/codex/config-reference/`. Use the supported command/args/cwd/environment contract for exact-launch verification; preserve unknown unrelated configuration.
- MCP Tools specification, 2025-06-18 reference: `https://modelcontextprotocol.io/specification/2025-06-18/server/tools`. Protocol errors and execution errors have different representations; tool execution failures use isError. Record the actual negotiated protocol and SDK behavior during testing rather than claiming this reference is the latest protocol.
- proper-lockfile primary documentation: `https://github.com/moxystudio/node-proper-lockfile`. It documents compromise callbacks and limitations, including cases involving manual removal or inconsistent stale/update settings. Passeur's plan does not turn this advisory mechanism into a universal fencing guarantee. Inspect the installed 4.1.2 implementation when mapping native errors.

## Relationship to other Passeur work

The parallel-worker plan remains authority for independent workers, committed handoffs and resource disposition until its own accepted changes say otherwise. This plan replaces only conflicting startup/deployment/verification assumptions and links overlapping evidence. Do not relabel all historical planning material or normalize the docs/Plans capitalization as unrelated cleanup.

Any later arbitrary-agent plan should consume the neutral readiness and installed-runtime boundaries. It need not be implemented first and is not silently included here.
