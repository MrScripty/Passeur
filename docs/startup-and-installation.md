# Shared-service installation and cutover

This procedure targets the [structural completion candidate](plans/structural-coordination-completion/plan.md), whose acceptance remains open. Read [compatibility](compatibility.md), [shared service](shared-service.md) and [structural reporting](structural-reporting.md) first. The supported service environment is qualified Linux on local filesystems, with the candidate's exact Node ABI, architecture, libc and native grammar bundle.

1. Review the complete source and lockfile. Provision the exact pinned dependencies under explicit authority with `npm ci`, then run `npm run check` and `npm test`. Commit the reviewed result through ordinary hooks before building a clean candidate. The native Node binding and pinned grammar packages are build inputs. Linux and util-linux flock are required for service execution.
2. Build a clean candidate with `npm run build:runtime -- --source "$PWD" --output /absolute/disposable/artifact-output`. Use an output root outside the source tree. Install its returned candidate path into a separate user-owned root using the CLI procedure below. Neither build, discovery nor normal execution installs dependencies. Do not overwrite an installed build or redirect a running process.
3. Account for tasks and close old connection-owned servers normally. Do not delete their leases or select another state root.
4. From the selected installed CLI, run `migrate-profile --project ABSOLUTE_PROJECT --profile ABSOLUTE_PROFILE --yes` when the profile needs migration. It writes a validated profile3 and exact backup. Current structural metadata v6 and coordinated task v5 require a capable reader; an older reader must refuse without changing bytes. A backup is evidence, not a downgrade path.
5. Update the existing named registration using `register-codex` with its unchanged project/profile/state/server-name binding and explicit `--runtime`. Required/optional policy and existing permission settings are preserved unless an authorized flag changes them. Use the existing fingerprint/adoption procedure for conflicting unmanaged entries.
6. Start fresh Codex clients. Call `passeur_status` (frontend and service identities differ), `passeur_prepare`, then the task and coordination tools. Two compatible linked worktree clients share one service; materially different profiles/builds conflict visibly. Verify the actual installed native parser separately with `doctor`; parser readiness does not determine task readiness or retained-result access.

The old four delegation entrypoints now reject execution and direct clients to submit/wait/input/cancel. Registration probes enumerate this catalog and inspect status2 without creating tasks. `probe:service -- --project PATH --profile FILE --state-root ROOT --runtime ABSOLUTE_INSTALLED_CLI --yes` exercises two real local front ends/one service without inference after building. `probe:agents` is separately opt-in live work and leaves accepted tasks alive when its observation finishes; retain the returned IDs and explicitly adopt/control them from the real host.

`service-stop --project PATH --profile FILE --state-root ROOT --operation-key KEY --yes` closes service admission and drains without a task deadline. To explicitly cancel named tasks, use `--cancel-tasks ID[,ID...] --yes --operation-key KEY` only with the required task-control authority. Ordinary front-end exit never forwards a service-stop request.

## Installed acceptance

Use [installed acceptance](installed-acceptance.md) for the clean artifact, relocated offline all-language probe, schema cutover, named host and resource runs. The installed CLI's `doctor --project PATH` reports each grammar's selected-artifact readiness without preparing or authenticating a worker; `--prepare --yes` separately requests task preparation. The installed parser manifest records source pins, native hashes, Node ABI/N-API and libc. A mismatched or missing component produces a capability diagnostic. It does not authorize a fallback to development modules.

`PASSEUR_OBSERVATION_MONITOR=off` disables the optional background monitor for the SC16 same-machine baseline; the default is `on`. Set it on the service environment before startup and restore normal monitoring after measurement. It is an observation setting, not a worker lifetime or task-control limit. See [resource behavior](plans/structural-coordination-completion/reports/resource-behavior.md).

## Historical installation reference

The artifact installation, named-registration edit and backup mechanics below remain the reference. Earlier task/profile and connection-owned descriptions are superseded by [task lifecycle](task-lifecycle.md).

# Discoverable startup and installed runtime

## Availability and coordination

Passeur connects its fixed MCP catalog before it resolves the project, reads the execution profile, accesses task state, or loads Muse and the native parser bundle. A functioning Node/MCP installation is still required. A broken executable or missing essential dependency cannot expose its own tools.

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

## Register projects explicitly

For an existing profile:

```sh
node /absolute/installed/runtime/dist/src/cli.js register-codex \
  --project /absolute/Pumas-Library --profile /absolute/pumas-profile.json \
  --state-root "$HOME/.local/state" --server-name passeur_pumas --required
```

Use `passeur_tuldok` for a distinct project's registration. The generator pins Node, the installed CLI, working directory, project, profile, state namespace and expected repository identity. `muse_bridge` is supported when explicitly supplied as a registration name; the unrelated Muse SDK client identifier remains `muse_bridge`.

### Required versus optional host startup

Use `--required` when this named Passeur connection is a prerequisite for the intended Codex session. It writes `required = true` only for that server. Initialization failure then blocks Codex startup/resume rather than allowing the session to proceed without this connection. Use `--optional` to choose optional startup explicitly. Omitting both flags preserves the existing selected server's boolean policy; a new registration defaults to optional. The flags are mutually exclusive. On `configure`, they require `--install-codex`; interactive `setup` applies the choice only if registration is requested.

Codex's [MCP documentation](https://developers.openai.com/codex/mcp/) distinguishes the initial optional-server catalog grace (documented default: 1000 ms) from each server's startup timeout. Required servers use their startup timeout. Merely setting `startup_timeout_sec = 10` does not opt an optional server out of that grace. Passeur does not change `mcp_optional_startup_grace_ms`, global approvals, sandbox policy, or unrelated server tables. Re-registration also preserves existing per-server approval/denial settings; a denial conflicting with the requested catalog is reported, not silently removed.

Registration output includes `startup_policy`: the required/optional value observed in the written configuration, the available host-inspection evidence, and `host_attachment: not_run`. Codex versions that omit `required` from `mcp get --json` produce `inspection.status: not_reported`, not invented success or an assumed false value. A reported contradictory value fails verification. Neither a matched field nor a successful standalone MCP probe proves the model received the tools in the actual host.

For a running server whose tools are not callable, follow [attached-tool recovery](troubleshooting/attached-tools.md). Reconcile the exact installed runtime and registration offline before attempting another session; this does not require the missing MCP tools.

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

The structural candidate adds metadata schema v6 and coordinated task schema v5 while retaining supported historical meanings. Stop/drain existing known coordinators before switching registrations to a different installed build. An old binary must refuse unsupported new records without rewriting them. Rollback selects an existing previous runtime only where that reader is compatible with the actual state; it does not reset records. Follow [recovery](recovery.md) for uncertain native work.

The artifact installation contract is not tamper-proof against a user editing their own files. Linux evidence does not establish Windows/macOS, network-filesystem, multi-user or process-fencing guarantees. Complete [installed acceptance](installed-acceptance.md) before treating the setup as operationally accepted.


## Registered-agent extension

The installed MCP catalog includes the task, coordination and structural operations as well as supported legacy entrypoints. Re-register the exact new installed runtime under the existing server name/binding through the procedure above. Confirm the complete actual catalog in a fresh host session; an older allowlist can hide new tools.

Agent profiles remain lazily loaded. [Registered-agent configuration](registered-agents.md) owns explicit profile edits, version migration and controlled restart requirements. The existing package manifest/install code supplies the adapter dependency closure; verify the actual installed candidate without relying on its source checkout. Build/runtime identity, server name, agent ID and native vendor client identifier remain distinct.
