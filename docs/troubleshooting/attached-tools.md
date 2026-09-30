# Passeur tools absent or shown under an old name

Passeur uses one global Codex registration named `passeur`. Each host session starts a separate frontend in its own repository context. The registration name selects the MCP tool namespace; it does not select a repository or transfer task ownership.

The recorded Pumas/Tuldok incident observed old `passeur_pumas` and `passeur_tuldok` processes, stale mutable executables and restricted tool lists. That observation did not establish which host step hid the tools. The current source does not require those server names. An existing Codex process can retain the catalog it loaded earlier, so a namespace such as `mcp__passeur_pumas__…` may be a stale host catalog rather than evidence that the current frontend is bound to Pumas.

## Diagnose the current repository

Start from the affected agent session and call `passeur_status`. First-call status resolves its own launch directory, canonical repository identity, source/worktree view, profile selection and state namespace without starting a service. When connected, it also reports the service generation and build. Use these fields to compare sessions:

- Same repository ID and service generation means the sessions share a coordination domain. Different source views can still be linked worktrees.
- Different repository IDs mean the frontends are independent.
- Different effective profile fingerprints indicate a semantic profile mismatch. Different profile paths alone show different configuration provenance and can still refer to the same effective profile.
- Frontend and service build IDs identify whether the current connection uses compatible builds.

The launch input is not the resolved repository. If the resolved source view is wrong, inspect only this registration and the host session's launch context for a fixed `cwd` or `--project`. The normal registration omits both, and moving to a different repository should not require changing the registration.

If the tool catalog is absent or still carries an old namespace, start a fresh host session after checking the active Codex configuration. A host process does not rename tools that it already loaded. For a missing executable or failed initialization, follow [installation and startup](../startup-and-installation.md) and use the surfaced `stage`, `path`, `native_code` and `next_action` fields to identify the failure.

## Recover service discovery

When the current frontend reports a dead or unavailable service, call `passeur_prepare` from the affected repository. Preparation joins an existing service or uses the repository-scoped election guard to start one; it does not infer or adopt another frontend's tasks. A stale descriptor is re-observed and reconciled by bootstrap. Do not manually remove descriptors, sockets or leases, start a competing service, or inspect another repository's service first.

A profile conflict reports the requested and service-owned effective fingerprints, their provenance paths and the service generation. An ordinary unpinned frontend joins an existing service without reproducing the path from which that service loaded its profile. Agent discovery reads the live service's catalog. An explicit profile request with the same effective fingerprint joins even when its path differs; a changed file at the same path or another effective configuration requires the controlled service handover in [task lifecycle](../task-lifecycle.md). For a qualified pre-upgrade service with no retained fingerprint, unpinned use remains supported and explicit profile comparison reports that identity is unavailable. Joining the service never requires `passeur_attach`; attach remains a human-confirmed transfer of control over an existing task.

For a missing installation default, agent discovery returns `PROFILE_CONFIGURATION_REQUIRED` with the selected path and filesystem context when available. Explicit and repository override paths still report `PATH_NOT_FOUND` when absent. A registration-only upgrade migrates one unambiguous existing version-3 profile before publishing the unpinned global entry. If source profiles materially differ or contain an unsafe repository-specific implementation root, it preserves them and the prior registration and reports `PROFILE_DEFAULT_MIGRATION_REQUIRED`. Do not copy a profile between repositories or remove service state to work around the result.

## Retire old registrations safely

First identify the actual Codex configuration scope used by the host and back up that configuration file. Inspect each exact old name and confirm that its command and arguments are a Passeur registration before removing it:

```sh
codex mcp list
codex mcp get passeur_pumas --json
codex mcp get passeur_tuldok --json
```

Remove only an exact, confirmed obsolete Passeur entry, using the same Codex configuration scope:

```sh
codex mcp remove passeur_pumas
codex mcp remove passeur_tuldok
```

Keep the single global `passeur` registration and unrelated MCP entries. Never remove entries by a `passeur_*` prefix. Existing sessions naturally retain their old catalog until they exit; new sessions load the remaining global registration. Do not use this cleanup to change approvals, tool filters or service state.

An old server process or held lease alone does not prove that Passeur tools were delivered to the model. Preserve live tasks and use the task/service lifecycle procedures for any controlled handover. No inference is needed to verify registration, frontend binding or repository service attachment.
