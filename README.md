# Passeur

Passeur exposes repository-scoped registered-agent delegation through MCP. The caller selects independent assignments, agents and integration timing. Workers perform scoped checks and ordinary Git commits. Passeur owns execution, approval handoff, retained evidence and protected worktree/ref disposition.

## Registered agents

Muse is a registered runtime adapter rather than the whole bridge. Several named configurations can reuse one adapter. A second Codex app-server implementation is included as a Linux, implementation-only, explicitly opted-in qualification candidate. Passeur adds no agent reasoning loop, automatic provider routing, test selection, repair or merge engine.

Use `passeur_agents` to inspect configured agents in bounded pages, then `passeur_delegate` or `passeur_delegate_batch` with schema v3 and an explicit `agent_id`. Read retained evidence with `passeur_result` and account for resources through `passeur_finalize`. `passeur_status` and `passeur_prepare` retain their independent startup/coordination semantics. Existing Muse v2 tools remain compatibility entrypoints sharing the same coordinator.

[Configure and use registered agents](docs/registered-agents.md) covers profile migration, operator edits, retries and compatibility. [Adapter contract](docs/agent-adapters.md) defines ownership; [the adapter-authoring skill](.agents/skills/passeur-agent-adapter/SKILL.md) guides future integrations.

## Startup and installed runtime

Follow [startup and installation](docs/startup-and-installation.md). Missing agent/profile/repository prerequisites do not hide the tool catalog in an otherwise functioning installation. Factories do not start native SDKs at discovery. One runtime retains the configured repository lease, lazy preparation and terminal drain; all agents share one coordinator and bounded queue.

Use named caller registrations bound to exact installed builds and the existing state namespace. Rebuilding source does not update a running process. No run action installs dependencies, authenticates, rewrites personal configuration, changes permissions or selects another state root as fallback.

## Development and qualification

After authorized provisioning in the complete checkout, run `npm ci`, `npm run check`, `npm test` and `npm run build:runtime`. `npm run test:native` runs the standalone Codex transport/projection checks with controlled Node peers. Tests exercise Passeur's behavior, not delegated project acceptance.

This is a **source implementation candidate with blocked full pinned and installed-native acceptance**, not a certified compliant release. Read [implementation evidence](docs/plans/registered-agents/reports/implementation-evidence.md) for actual executed checks and their limits. Native Muse/Codex permissions, billing provenance, tool isolation and descendants require real qualification; a configured entry is not that evidence.

The existing startup plan's installed-host claims remain required. Follow [installed-host acceptance](docs/installed-acceptance.md), [recovery](docs/recovery.md), and [compatibility](docs/compatibility.md). No live account or personal configuration was used to produce this source package.
