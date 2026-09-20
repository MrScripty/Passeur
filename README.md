# Passeur

Passeur exposes repository-scoped agent delegation through MCP. Codex controls decomposition and integration; Muse workers perform their assigned work and ordinary commits; Passeur manages execution, approvals, retained evidence and owned worktree/ref disposition.

## Startup and installation

See [Startup and installation](docs/startup-and-installation.md) for the current CLI and deployment procedure. The interface now exposes `passeur_status` and `passeur_prepare` alongside `delegate_to_muse`, `delegate_to_muse_batch`, `muse_result` and `muse_finalize`.

Operational project, profile, state and provider failures do not prevent the tool catalog from being exposed by an otherwise functioning installation. Coordination readiness is not provider compatibility. One coordinator can manage multiple independent workers; a second connection stays available for diagnosis while execution authority is held elsewhere.

Normal registrations use explicit project names and version-specific installed runtimes. Development registration is explicit. No run action builds, installs, repairs state, changes permissions or selects another state namespace as a fallback.

## Development and evidence

After authorized dependency provisioning, run `npm ci`, `npm run check` and `npm test`. Tests exercise Passeur's own behavior; Passeur does not become a test runner or acceptance engine for delegated projects.

The startup implementation is a **source candidate awaiting full pinned-dependency and installed-host verification**, not an accepted release. See [implementation evidence](docs/plans/discoverable-startup-and-installed-runtime/reports/implementation-evidence.md). Complete [real installed acceptance](docs/installed-acceptance.md) before marking the plan Accepted.

Task schema 2, supported version-1 history, scoped worker commits, bounded results and protected dispositions remain. See [design](docs/design.md), [recovery](docs/recovery.md), [compatibility](docs/compatibility.md), and the [agent skill](.agents/skills/muse-bridge/SKILL.md).
