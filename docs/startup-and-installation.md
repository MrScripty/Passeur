# Install and use Passeur

This procedure targets the [structural completion candidate](plans/structural-coordination-completion/plan.md), whose acceptance remains open. Read [compatibility](compatibility.md), [shared service](shared-service.md) and [task lifecycle](task-lifecycle.md) for the service and ownership contracts. The qualified service environment is Linux on local filesystems with the candidate's exact Node ABI, architecture, libc and native grammar bundle.

Build and install a reviewed candidate using the instructions below. Configure supported agents once, then install one unpinned Codex registration named `passeur`:

```sh
node /absolute/installed/runtime/dist/src/cli.js register-codex --server-name passeur --required
```

The registration has no fixed MCP working directory, project, profile or expected repository ID. Each host session starts an independent frontend with that session's repository context. The frontend joins or starts the service for its canonical repository. Linked worktrees share that service and preserve separate source views; unrelated repositories remain independent. There is no global current-repository lock. Opening a repository requires no registration, binding repair, or host restart. Start a fresh host session after registration so it loads the current MCP catalog.

For a first installation, run interactive `setup` or `configure --install-codex` once to create the installation-wide agent profile and registration. When upgrading an existing repository-pinned installation through unpinned `register-codex`, Passeur first keeps an existing valid default or migrates one unambiguous existing version-3 profile, then publishes the global registration. It refuses before changing registration when there is no safe candidate or existing profiles materially differ. Profile selection within each frontend is explicit profile, existing canonical-repository override, supported legacy worktree/main-worktree profile, then `$XDG_CONFIG_HOME/muse-bridge/default-profile.json` or `$HOME/.config/muse-bridge/default-profile.json`. Repository overrides remain available for advanced use; they are not needed when opening another repository.

An elected service generation retains its decoded execution profile and effective fingerprint. The profile file path is diagnostic provenance. Unpinned frontends join that service and use its agent catalog without matching or opening a second profile path. Explicit profile requests join when effective fingerprints match; different effective configurations require controlled service handover, while old qualified services without fingerprints remain available to unpinned frontends.

Old tool namespaces can remain in an already-running host because its catalog was loaded earlier. Inspect the exact active Codex configuration and each obsolete server before changing it; back up the file, then remove only exact, verified legacy registration names through the host's configuration command. Never delete server entries by a name prefix. See [attached-tool recovery](troubleshooting/attached-tools.md).

Use [installed acceptance](installed-acceptance.md) for the clean artifact, offline native parser probe and installed-host qualification. `passeur_status` is read-only and resolves frontend identity; `passeur_prepare` explicitly joins/starts the repository service and prepares state without inference. A frontend disconnect does not stop accepted work. Use explicit service-stop only for controlled service handover, and account for tasks under the existing [lifecycle contract](task-lifecycle.md).

The `probe:service` command can exercise local frontends and one repository service without inference after building. `probe:agents` performs separately authorized agent work; its accepted tasks remain alive when observation ends. The installed CLI's `doctor --project PATH` checks selected native artifacts without authenticating a worker; `--prepare --yes` separately requests service preparation. See [resource behavior](plans/structural-coordination-completion/reports/resource-behavior.md) for the controlled monitor baseline.

## Discoverable startup and installed runtime

## Availability and coordination

Passeur connects its fixed MCP catalog before it resolves the project, reads the execution profile, accesses task state, or loads Muse and the native parser bundle. A functioning Node/MCP installation is still required. A broken executable or missing essential dependency cannot expose its own tools.

`passeur_status` is read-only. On first call it resolves that frontend's repository, worktree/source view, selected profile and state namespace without starting a service or taking a lease. It reports frontend identity and, when connected, the service generation/build. `not_checked` is not success. Provider compatibility is deliberately not inferred from versions, configuration or a readiness check.

`passeur_models` queries Muse's current visible models using MSP `model/list` in a short-lived `muse serve --no-session-log` host. It initializes the protocol and closes its owned child after success, failure, cancellation or the 15-second query deadline; it starts no session, inference, task or repository service. Each MCP frontend admits at most two simultaneous catalog hosts; excess concurrent calls fail with `MODEL_CATALOG_BUSY` rather than creating an unbounded process queue. The response includes Muse-reported default flags, context/output token limits and verbatim decimal cost strings, and preserves the reported catalog source, provider and profile, so a bundled or configuration catalog is not represented as a provider catalog. Muse is resolved from `PATH`; catalog failure does not prevent MCP tool discovery.

Model pages contain at most two rows from a catalog of at most 1024 rows. Pass `next_offset` and the returned `catalog_sha256` as `expected_sha256` for continuation. Each page queries Muse again; a changed catalog requires restarting from offset zero. An empty catalog is a valid response; malformed or oversized native data returns a bounded error. Interactive `setup` uses the same live query and accepts `--muse-bin PATH` for the executable whose selected model it saves in the profile. Setup requires a nonempty catalog and never falls back to cached local JSON.

`passeur_prepare` acquires coordination authority and initializes/imports/reconciles supported state, without inference. Calling it is an explicit request to perform that preparation. Delegation enters the same readiness path automatically. History and offline administration do not require a working Muse session or a verified subscription profile. Missing or invalid execution profiles keep MCP tool discovery, status, and `passeur_models` available, but block a new service generation and explicit profile compatibility checks. An unpinned frontend can still list agents from an existing valid repository service without opening a prospective profile.

One process owns coordination per canonical local repository in the configured single-user state namespace. Linked worktrees share that identity. The lease protects Passeur task/resource administration, not filesystem permissions or arbitrary external Git operations. Multiple workers may run under one coordinator. A competing bridge remains discoverable and reports contention. Stop the known owner through its normal lifecycle before handover; do not delete its lock.

A failed, pre-admission preparation can retry after repair in the same MCP process. A ready runtime keeps its binding/profile fixed. Profile changes affecting active work require a controlled new process. Detected lost authority freezes admission and cancels/drains owned work. Cancellation and expired locks never prove that a worker stopped.

## Verify the source update

After dependency provisioning has been authorized, use the pinned lock:

```sh
npm ci
npm run check
npm test
```

`npm test` first builds the real CLI, then runs the core and Vitest suites. The new real-stdio tests require that compiled CLI. A narrower check is `npm run test:installed`. These are tests of Passeur, not a new policy for delegated product projects.

These commands check the selected source, not installed or live acceptance. The [completion claim status](plans/structural-coordination-completion/reports/claim-status.md) records the current candidate and remaining evidence.

## Build and install a runtime

Select and commit the reviewed source through the repository's normal workflow first. Normal runtime candidates require clean Git inputs and already provisioned pinned dependencies; neither build nor serve installs packages.

```sh
npm run build:runtime -- --source "$PWD" --output "$PWD/.passeur-build"
```

The command returns a candidate path identified by its build ID. Install that exact path into a user-owned root outside the candidate:

```sh
node dist/src/cli.js install \
  --artifact /absolute/path/to/candidate \
  --install-root "$HOME/.local/share/passeur/runtimes" --yes
```

The installed directory includes compiled code and helper, locked production dependencies and native grammar artifacts, package licenses, a CycloneDX inventory and a runtime manifest with native identities. Node is an external dependency. Existing build directories are not overwritten. No automatic garbage collection removes older installations.

`--allow-dirty` on `build:runtime` creates an explicitly developmental candidate, not an installable production artifact. Development checkout registration requires `--development-runtime`; it is not an implicit fallback.

## Register Passeur once

The one local Codex registration is repository-unpinned:

```sh
node /absolute/installed/runtime/dist/src/cli.js register-codex \
  --server-name passeur --required
```

This pins the installed executable, build and tool policy while omitting MCP `cwd`, `--project`, `--profile` and `--expected-repository-id`. Each host session starts a separate frontend in its own working directory. That frontend resolves its canonical repository and connects to that repository's service. Linked worktrees share canonical identity and keep separate source views; unrelated repositories retain independent state and service election.

Run `setup` or `configure --install-codex` once for a first installation. When an existing pinned installation is updated using unpinned `register-codex`, the registration workflow migrates one safe, unambiguous version-3 profile into the installation default before writing the new registration. Multiple materially different profiles are preserved and reported as a migration requirement; Passeur does not pick a repository's specialized configuration arbitrarily. Profile selection is explicit CLI profile, existing canonical-repository override, supported legacy main/worktree profile, then the installation default under `muse-bridge/default-profile.json`. A new repository needs no profile copy. Repository overrides and explicit CLI bindings remain available for controlled maintenance.

Explicit project/profile CLI bindings remain available for controlled maintenance and tests. They are unnecessary for normal multi-repository use. Configuration updates still honor the exact existing-binding fingerprint and preserve unrelated policy; this routing change does not bypass configuration ownership. The unrelated Muse SDK client identifier `muse_bridge` remains distinct from the global Codex server name `passeur`.

### Required versus optional host startup

Use `--required` when this named Passeur connection is a prerequisite for the intended Codex session. It writes `required = true` only for that server. Initialization failure then blocks Codex startup/resume rather than allowing the session to proceed without this connection. Use `--optional` to choose optional startup explicitly. Omitting both flags preserves the existing selected server's boolean policy; a new registration defaults to optional. The flags are mutually exclusive. On `configure`, they require `--install-codex`; interactive `setup` applies the choice only if registration is requested.

Codex's [MCP documentation](https://developers.openai.com/codex/mcp/) distinguishes the initial optional-server catalog grace (documented default: 1000 ms) from each server's startup timeout. Required servers use their startup timeout. Merely setting `startup_timeout_sec = 10` does not opt an optional server out of that grace. Passeur does not change `mcp_optional_startup_grace_ms`, global approvals, sandbox policy, or unrelated server tables. Re-registration also preserves existing per-server approval/denial settings; a denial conflicting with the requested catalog is reported, not silently removed.

Registration output includes `startup_policy`: the required/optional value observed in the written configuration, the available host-inspection evidence, and `host_attachment: not_run`. Codex versions that omit `required` from `mcp get --json` produce `inspection.status: not_reported`, not invented success or an assumed false value. A reported contradictory value fails verification. Neither a matched field nor a successful standalone MCP probe proves the model received the tools in the actual host.

For a running server whose tools are not callable, follow [attached-tool recovery](troubleshooting/attached-tools.md). Reconcile the exact installed runtime and registration offline before attempting another session; this does not require the missing MCP tools.

For first-time configuration, `setup` is interactive. `configure --model EXACT_ID` creates a new profile and refuses to overwrite an existing one. `--confirm-subscription` records the operator's confirmation, not provider billing proof. `--worktree-root` enables implementation tasks with a root outside the source checkout.

Registration changes personal Codex configuration only when the operator requests that command. Keep external configuration editors closed during the operation. `--config-path` must identify the `config.toml` of the CODEX_HOME being verified. Passeur serializes its own writers but does not claim an atomic compare-and-swap against arbitrary external editors.

Existing Passeur-managed blocks preserve all outside text. A conflicting binding requires the exact fingerprint returned by the diagnostic via `--replace-binding`. An unmarked existing table additionally requires `--adopt-unmanaged`: **that explicit adoption may reformat TOML and remove comments**, while preserving parsed settings and an original backup. It is not automatic. Known same-repository bindings to conflicting state namespaces are refused; do not use a new state root as a permission workaround.

Registration verifies Codex's resolved configuration and launches the exact configured command for MCP initialization, complete tool enumeration and status/identity comparison. For an unpinned registration the direct probe runs in the selected project when invoked through setup/configure, or in the caller's current directory for a standalone unpinned register command. This confirms the dynamic binding path only for that controlled launch; it does not prove an arbitrary Codex host sandbox has identical access.

Add `--verify-readiness --yes` to explicitly prepare/reconcile the repository during verification. A correct registration with blocked readiness remains installed-but-blocked. Live inference is never silently run by registration.

## Evidence and diagnostics

Configuration, direct transport, target readiness and installed-host workflow are separate results. Required failed checks produce a nonzero command outcome. Optional unrun checks remain `not_run`.

Start a new Codex session after registering and verify the actual namespace/tool catalog there. Current-session attachment behavior belongs to the installed Codex version; Passeur does not hot-attach tools or change global startup/approval/sandbox policy.

`doctor --project PATH` returns read-only observations. `doctor --project PATH --prepare --yes` also exercises readiness. Compare runtime build IDs, not the checkout's current source revision, when diagnosing stale running processes.

`PROJECT_IN_USE` means actual lock contention. Filesystem, unsupported-version, corruption, recovery and provider errors have separate meanings. Repair access to the configured state location; preserve authoritative records. Unknown future record versions and access failures do not authorize quarantine. Proven corruption is preserved by the existing quarantine-and-freeze recovery contract. Offline `reconcile` still needs explicit owner, reason, task and stopped-worker evidence.

Responses/stderr are bounded and redact common credential patterns. Do not put secrets in profile notes, paths, task diagnostics or environment fields. Stdout of `serve` is protocol-only.

## Compatibility and rollback

The structural candidate adds metadata schema v6 and coordinated task schema v5 while retaining supported historical meanings. Stop/drain existing known coordinators before switching registrations to a different installed build. An old binary must refuse unsupported new records without rewriting them. Rollback selects an existing previous runtime only where that reader is compatible with the actual state; it does not reset records. Follow [recovery](recovery.md) for uncertain native work.

The artifact installation contract is not tamper-proof against a user editing their own files. Linux evidence does not establish Windows/macOS, network-filesystem, multi-user or process-fencing guarantees. Complete [installed acceptance](installed-acceptance.md) before treating the setup as operationally accepted.


## Registered-agent extension

The installed MCP catalog includes the task, coordination and structural operations as well as supported legacy entrypoints. Re-register the exact new installed runtime under the existing server name/binding through the procedure above. Confirm the complete actual catalog in a fresh host session; an older allowlist can hide new tools.

Agent profiles remain lazily loaded. [Registered-agent configuration](registered-agents.md) owns explicit profile edits, version migration and controlled restart requirements. The existing package manifest/install code supplies the adapter dependency closure; verify the actual installed candidate without relying on its source checkout. Build/runtime identity, server name, agent ID and native vendor client identifier remain distinct.
