# Baseline and standards route

**Operation:** `start` on `docs/plans/global-agent-repository-usability/plan.md`
**Source:** `6e61bd93e74686620f0cffc3e54bf00c8e5373f8`
**Date:** 2026-09-30

## Observed state and failure classification

- The current global Codex configuration has one unpinned `passeur` entry; no current `passeur_pumas` or `passeur_tuldok` entries were found. Values were inspected with personal paths redacted. No configuration was changed.
- Existing MCP host sessions can retain their loaded tool catalog. Old `mcp__passeur_pumas__…` or `mcp__passeur_tuldok__…` tools are therefore compatible with stale host catalog state, but current source registration/configuration does not require those names. The checked-in attached-tools recovery procedure still requires editing both named registrations and is stale operational guidance.
- The active Passeur Muse request to list agents returned `PROFILE_MIGRATION_REQUIRED` for the selected checkout profile. No file was edited. This reproduces a profile compatibility gate in the current environment, not the historical `PATH_NOT_FOUND` or old named-tool catalog.
- `PATH_NOT_FOUND` is not reproduced through the active host in this baseline. Source binding currently chooses the canonical repository profile path and does not fall back to an installation default; a missing selected file is a plausible path to that code. Exact path/stage loss through service and MCP projection obscures diagnosis.
- `observed_dead` is not freshly reproduced in the active `passeur_status` response (`service: not_checked`). Source treats descriptor process identity as an observation; bootstrap owns later election/recovery. Existing stale-descriptor tests are the appropriate reproduction/qualification path.
- Profile conflict is structurally reproducible from the service client when an elected descriptor profile differs, but current messages do not state the requested and service profile paths.
- Production Git identity discovery inherits the process environment; the Git wrapper has a sterile option that the repository identity path does not select.
- Existing tests already cover dynamic registration serialization, concurrent clients, linked worktrees, unrelated repositories, legacy profiles and bootstrap recovery. Missing claims include distinct task-owner authority, accepted work after the submitting frontend exits, richer concurrent cross-repository activity, explicit current source view in status, and real-host parallel sessions.

## Installed Codex host baseline

The local host is Codex CLI `0.159.2`. In a disposable `$CODEX_HOME` with no saved credentials, a single unpinned `[mcp_servers.passeur]` entry (no `cwd`, project or profile) was loaded by the real `codex app-server`. Three simultaneous ephemeral threads used two unrelated temporary Git repositories and a linked worktree. Each `passeur_status` tool call arrived through the configured `passeur` server and started a separate Passeur frontend process. The reported `project_input` matched that thread's cwd for all three threads; the linked worktree retained its own source path. This is a direct host observation of launch-context isolation, not service-sharing acceptance.

Calling `passeur_prepare` from the second repository with no installation or repository profile returned only `SERVICE_START_FAILED` and the generic message “Guarded service startup exited with code 1”. The underlying path/stage was not projected. This is an actual-host reproduction of absent-profile startup failure and its diagnostic loss. The test used a new temporary Codex home, no auth files, OSS/local-provider selection, and no inference turn. Codex emitted an unauthenticated Responses websocket connection attempt that the execution sandbox denied; no account or credential was available to that process.

This agrees with the installed version's public source: `mcpServer/tool/call` resolves a thread and invokes that thread's MCP runtime, while the thread runtime context derives its local process cwd from that session's configured cwd ([Codex v0.159.2 MCP request processor](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/app-server/src/request_processors/mcp_processor.rs), [thread MCP runtime](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/core/src/session/mcp.rs)). The source supports the observed host behavior; the temporary-host run is the qualification evidence.

## Repository planning inputs

The shared-service plan is `Verifying`, acceptance blocked at M4-S1. It owns task/service lifecycle, service election, leases, records and resources. The dynamic-repository-routing plan is also `Verifying`, acceptance blocked at V1; its DR-I02 rejects a global profile because no profile registry exists. The present user explicitly revises that product decision by requesting a global agent/repository user model. It does not transfer lifecycle ownership or accept prior blocked criteria.

No root `CONTEXT.md` or general source inventory exists. The available plan inventories were located; relevant architecture references are in the shared-service plan and dynamic-routing plan. Initial `git status` had four unrelated untracked paths, including the native-location fixture directory and three plan/report files; all are to remain untouched.

## Coding-Standards application evidence

The supported Coding-Standards Engine returned interface version 45, implementation `0.2.0`, instance `24c356ca-b94a-4d14-a700-bf723f74aced`, catalog digest `sha256:8235cb21f7d1937be1a003eb2eef570345242194dac36d79463b16e26bb6d65d`, implementation digest `sha256:edd54c3390d6f273c85a1130ac304ef3c18cd3223cc1028bf103e047f69adaff`.

The routed module closure was: `core`, `router`, `workflow.implementation`, `workflow.verification`, `topic.dependencies`, `profile.language.typescript`, `topic.concurrency`, `topic.contracts`, `topic.contracts.evolution`, `topic.contracts.protocols`, `topic.contracts.schemas`, `topic.resilience`, `topic.security`, `workflow.build`, `workflow.development-proportionality`, `profile.application.library`, `topic.code-design`, `workflow.documentation`, `workflow.commit`, `profile.language.typescript.async`, `topic.architecture`, `profile.boundary.persistence`, `topic.cross-platform`, `topic.diagnostics`, `profile.application.launcher`, `profile.boundary.ipc`, `topic.security.untrusted-execution`, `profile.boundary.generated-contract`, `workflow.planning`, `workflow.tooling`, and `workflow.verification.platforms`.

Core and Router were read first. Each routed canonical module was read using the Engine. The route had zero unresolved policy/questions. Normative guidance was available for every selected module; the Engine marked Core, Router, Implementation, Verification, Concurrency, Security, Development Proportionality, Untrusted Execution, Planning and Tooling as `application_exposure=current`, with the other listed modules `unreviewed`. The latter is a local attestation state, not an unavailable module. No exact guidance module was unavailable. This records the guidance applied; it does not claim that the repository is certified compliant.

The shared-service plan records adopted source revision `366c1d90a24bbfb50973f62b155a5f3396c0f107`; this task retains it as the plan baseline and records the live Engine catalog separately so the two identifiers are not conflated.
