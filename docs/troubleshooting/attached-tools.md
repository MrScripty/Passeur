# Passeur tools absent or shown under an old name

Passeur uses one global Codex registration named `passeur`. Each host session starts a separate frontend in its own repository context. The registration name selects the MCP tool namespace; it does not select a repository or transfer task ownership.

The recorded Pumas/Tuldok incident observed old `passeur_pumas` and `passeur_tuldok` processes, stale mutable executables and restricted tool lists. That observation did not establish which host step hid the tools. The current source does not require those server names. An existing Codex process can retain the catalog it loaded earlier, so a namespace such as `mcp__passeur_pumas__…` may be a stale host catalog rather than evidence that the current frontend is bound to Pumas.

## Diagnose the current repository

Start from the affected agent session and call `passeur_status`. First-call status resolves its own launch directory, canonical repository identity, source/worktree view, profile selection and state namespace without starting a service. When connected, it also reports the service generation and build. Use these fields to compare sessions:

- Same repository ID and service generation means the sessions share a coordination domain. Different source views can still be linked worktrees.
- Different repository IDs mean the frontends are independent.
- Different profile paths or service generations indicate a profile/service mismatch for the same repository.
- Frontend and service build IDs identify whether the current connection uses compatible builds.

The launch input is not the resolved repository. If the resolved source view is wrong, inspect only this registration and the host session's launch context for a fixed `cwd` or `--project`. The normal registration omits both, and moving to a different repository should not require changing the registration.

If the tool catalog is absent or still carries an old namespace, start a fresh host session after checking the active Codex configuration. A host process does not rename tools that it already loaded. For a missing executable or failed initialization, follow [installation and startup](../startup-and-installation.md) and use the surfaced `stage`, `path`, `native_code` and `next_action` fields to identify the failure.

## Recover service discovery

When the current frontend reports a dead or unavailable service, call `passeur_prepare` from the affected repository. Preparation joins an existing service or uses the repository-scoped election guard to start one; it does not infer or adopt another frontend's tasks. A stale descriptor is re-observed and reconciled by bootstrap. Do not manually remove descriptors, sockets or leases, start a competing service, or inspect another repository's service first.

A profile conflict reports both the requested/resolved profile and the profile recorded by the elected service. Compatible same-repository frontends must resolve to the same approved profile. Changing a profile while its service is active requires the controlled service handover in [task lifecycle](../task-lifecycle.md). Joining the service never requires `passeur_attach`; attach remains a human-confirmed transfer of control over an existing task.

`PATH_NOT_FOUND` includes the stage and exact affected path. The default agent configuration is selected once for the installation. Existing canonical-repository and supported legacy profiles remain overrides; a new repository falls back to the installation default. Repair the path named by the error and retry the same frontend when preparation failed before admission.

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
