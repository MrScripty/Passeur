# Discoverable startup and installed runtime

## Availability and coordination

Passeur connects its fixed six-tool MCP interface before it resolves the project, reads the execution profile, accesses task state, or loads Muse. A functioning Node/MCP installation is still required. A broken executable or missing essential dependency cannot expose its own tools.

`passeur_status` is read-only. It returns the running identity, configured binding and observed coordination/profile/approval state. `not_checked` is not success. Provider compatibility is deliberately not inferred from versions, configuration or a readiness check.

`passeur_prepare` acquires coordination authority and initializes/imports/reconciles supported state, without inference. Calling it is an explicit request to perform that preparation. Delegation enters the same readiness path automatically. History and offline administration do not require a working Muse session or a verified subscription profile. A malformed/missing execution profile blocks delegation, not the interface.

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

The source update was not fully dependency-checked in its preparation environment. See the plan's `reports/implementation-evidence.md`; live acceptance remains outstanding.

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

The installed directory includes compiled code, locked production dependencies, licenses in their packages, a CycloneDX inventory and a runtime manifest. Node is an external dependency. Existing build directories are not overwritten. No automatic garbage collection removes older installations.

`--allow-dirty` on `build:runtime` creates an explicitly developmental candidate, not an installable production artifact. Development checkout registration requires `--development-runtime`; it is not an implicit fallback.

## Register projects explicitly

For an existing profile:

```sh
node /absolute/installed/runtime/dist/src/cli.js register-codex \
  --project /absolute/Pumas-Library --profile /absolute/pumas-profile.json \
  --state-root "$HOME/.local/state" --server-name passeur_pumas
```

Use `passeur_tuldok` for a distinct project's registration. The generator pins Node, the installed CLI, working directory, project, profile, state namespace and expected repository identity. `muse_bridge` is supported when explicitly supplied as a registration name; the unrelated Muse SDK client identifier remains `muse_bridge`.

For first-time configuration, `setup` is interactive. `configure --model EXACT_ID` creates a new profile and refuses to overwrite an existing one. `--confirm-subscription` records the operator's confirmation, not provider billing proof. `--worktree-root` enables implementation tasks with a root outside the source checkout.

Registration changes personal Codex configuration only when the operator requests that command. Keep external configuration editors closed during the operation. `--config-path` must identify the `config.toml` of the CODEX_HOME being verified. Passeur serializes its own writers but does not claim an atomic compare-and-swap against arbitrary external editors.

Existing Passeur-managed blocks preserve all outside text. A conflicting binding requires the exact fingerprint returned by the diagnostic via `--replace-binding`. An unmarked existing table additionally requires `--adopt-unmanaged`: **that explicit adoption may reformat TOML and remove comments**, while preserving parsed settings and an original backup. It is not automatic. Known same-repository bindings to conflicting state namespaces are refused; do not use a new state root as a permission workaround.

Registration verifies Codex's resolved configuration and launches the exact configured command for MCP initialization, complete tool enumeration and status/identity comparison. The direct probe uses its declared controlled inherited environment; it does not prove an arbitrary Codex host sandbox has identical access.

Add `--verify-readiness --yes` to explicitly prepare/reconcile the repository during verification. A correct registration with blocked readiness remains installed-but-blocked. Live inference is never silently run by registration.

## Evidence and diagnostics

Configuration, direct transport, target readiness and installed-host workflow are separate results. Required failed checks produce a nonzero command outcome. Optional unrun checks remain `not_run`.

Start a new Codex session after registering and verify the actual namespace/tool catalog there. Current-session attachment behavior belongs to the installed Codex version; Passeur does not hot-attach tools or change global startup/approval/sandbox policy.

`doctor --project PATH` returns read-only observations. `doctor --project PATH --prepare --yes` also exercises readiness. Compare runtime build IDs, not the checkout's current source revision, when diagnosing stale running processes.

`PROJECT_IN_USE` means actual lock contention. Filesystem, unsupported-version, corruption, recovery and provider errors have separate meanings. Repair access to the configured state location; preserve authoritative records. Unknown future record versions and access failures do not authorize quarantine. Proven corruption is preserved by the existing quarantine-and-freeze recovery contract. Offline `reconcile` still needs explicit owner, reason, task and stopped-worker evidence.

Responses/stderr are bounded and redact common credential patterns. Do not put secrets in profile notes, paths, task diagnostics or environment fields. Stdout of `serve` is protocol-only.

## Compatibility and rollback

This source change keeps task schema 2, supported schema-1 history, retained results, explicit dispositions and the existing worker adapter. It does not move state. Stop/drain existing known coordinators before switching registrations to a different installed build. Rollback selects an existing previous runtime explicitly; it does not reset records or imply every older runtime can interpret newer state.

The artifact installation contract is not tamper-proof against a user editing their own files. Linux evidence does not establish Windows/macOS, network-filesystem, multi-user or process-fencing guarantees. Complete [installed acceptance](installed-acceptance.md) before treating the setup as operationally accepted.


## Registered-agent extension

The installed allowlist now includes seven neutral operations (`passeur_status`, `passeur_prepare`, `passeur_agents`, `passeur_delegate`, `passeur_delegate_batch`, `passeur_result`, `passeur_finalize`) and the four supported legacy Muse operations. Re-register the exact new installed runtime under the existing server name/binding through the procedure above. Do not leave an old six-tool allowlist and mistake hidden neutral tools for a missing provider.

Agent profiles remain lazily loaded. [Registered-agent configuration](registered-agents.md) owns explicit profile edits, version migration and controlled restart requirements. The existing package manifest/install code supplies the adapter dependency closure; verify the actual installed candidate without relying on its source checkout. Build/runtime identity, server name, agent ID and native vendor client identifier remain distinct.
