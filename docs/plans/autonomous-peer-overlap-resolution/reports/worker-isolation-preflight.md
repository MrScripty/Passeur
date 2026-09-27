# G2 worker isolation preflight — offline only

**Plan and operation:** `docs/plans/autonomous-peer-overlap-resolution/plan.md`, `continue`. This is independent G2 preparation; it does not promote G1 or admit an installed/live run.

## Boundary recipe

`scripts/experiment-worker-sandbox.mjs` wraps a **new disposable host process** before Muse starts. The caller supplies a JSON configuration with an absolute `workspace`, nonempty absolute `denied` directory list, optional exact `mounts` (`source`, guest `target` under `/mounts`, `mode: ro|rw`), and a deliberately constructed `env` object. Run `node scripts/experiment-worker-sandbox.mjs CONFIG.json -- HOST ARG...`. The wrapper supplies a private mount namespace and user/PID/IPC/UTS namespaces, isolated `/proc`, `/dev`, and `/tmp`, a clean environment, read-only system executable paths, only the named worker worktree at `/workspace` by default, and exact additional mounts. `preserveWorkspacePath: true` instead binds a canonical worktree beneath `/tmp` at its original absolute path for Muse's `workspaceRoot`; the isolated `/tmp` contains only the constructed path and does not expose adjacent host directories. It does not bind `/`, `/home`, the repository containing production code, or a shared Git common directory. Writable source overlap and protected-source overlap fail before launch. Native stdout/stderr/stdin, cwd, child exit status, and ordinary Git hooks remain in the launched process path. The test uses fake data and a fake local Git repository only.

Each worker must receive a separately prepared worktree and private writable Git metadata. A linked worktree's `.git` pointer and `commondir` often refer to the shared repository; the offline fake host uses a self-contained `.git` inside its own workspace. The real host must either provide an equivalent private Git view compatible with Passeur's canonical repository identity and normal commit/finalize path, or identify narrowly scoped Git writes and prove they cannot affect another worker. This wrapper deliberately supplies no blanket write access to shared Git. Additional read-only runtime mounts must be exact, reviewed paths; the wrapper cannot infer native Muse runtime requirements.

## Observed result

- Environment: Linux, Node `v24.12.0`, Git `2.43.0`, Bubblewrap `0.9.0` at `/usr/bin/bwrap`.
- `node tests/core/experiment-worker-sandbox.test.mjs`: **4/4 pass** after the absolute-path addition. The parent process, under the same UID, successfully read fake oracle and sibling markers first. The sandboxed child wrote its own workspace and private Git mount, read an explicitly mounted runtime directory, could not write that read-only directory, and could not read sibling/oracle/control/pristine directories by direct host path, in-workspace absolute symlink, `/proc/self/root`, or `/proc/1/root`. A local Git commit executed its ordinary pre-commit hook; a command exit status of 37 remained 37. The new mode also confirmed that the child cwd and `HOME` equal the original host worktree path while a sibling path is absent.
- The exact namespace probe succeeded with `--unshare-user --unshare-pid --unshare-ipc --unshare-uts`. A separate attempt with `--unshare-all` failed on network namespace setup: `bwrap: loopback: Failed to create NETLINK_ROUTE socket: Operation not permitted`. Network isolation is unproven and the wrapper shares the host network namespace, which a provider connection may require.
- The preflight emits `DENY_SET_REQUIRED`, `SOURCE_INVALID`/`SOURCE_UNAVAILABLE`, `SOURCE_DENIED`, `WRITE_OVERLAP`, `TARGET_INVALID`/`TARGET_RESERVED`/`TARGET_OVERLAP`, `BWRAP_UNAVAILABLE`, and `BWRAP_NAMESPACE_UNAVAILABLE` before invoking the host. Protected path names and environment values should not be retained in published diagnostics.
- Independent review found that the initial source-overlap check mishandled `/` and skipped the implicit executable mounts. The wrapper now rejects a root workspace or mount source and checks resolved `/usr`, `/bin`, `/lib` and `/lib64` sources against protected directories. Direct regression probes pass for both cases; the 3/3 offline probe was rerun after this repair.

This proves filesystem denial for the sampled ordinary subprocess environment and mount layout. It does not establish a complete same-UID security boundary against network services, inherited secret-bearing standard streams, ptrace or other kernel channels, host-held file descriptors, source symlink changes between preflight and mount, host-side services exposing private files, or a privileged worker. The host must prevent those channels or qualify them before claiming blind-worker isolation. In particular, environment values passed through `--setenv` appear in the Bubblewrap argument vector and are unsuitable for real credentials without a separately reviewed credential route.

## Installed/native requirements still open

Read-only installed-host inventory found two concrete mismatches with the
offline fake host. The Muse adapter launches `muse_bin` with `cwd` set to the
task worktree and passes that same original absolute path as `workspaceRoot`.
The wrapper's new `preserveWorkspacePath` mode covers this path requirement in
an offline child; an actual Muse host has not yet consumed it. Passeur's managed
worktrees also use `.git` pointers into one shared Git common directory, while
the offline proof used private Git metadata. A real worker commit needs writes
to shared objects and refs, which this wrapper intentionally does not expose.
These must be solved and checked before a blinded installed run. The registered
personal Muse launcher can auto-update; a disposable registration must pin its
host identity. Authentication currently resolves through a personal Muse
configuration path; the wrapper's `--setenv` arguments are unsuitable for
passing its secret contents. The inventory checked path and permission facts
only, without reading credentials or starting Muse.

1. Establish a genuinely new disposable Muse MSP host invocation with the wrapper outside the adapter, before provider/native initialization. Preserve normal service attachment, accepted-task ownership, native input, continuation, and explicit cancellation.
2. Capture and review the exact new host executable, runtime libraries, sockets, cwd, environment/credential route, and Git common-dir layout. Mount only required paths; keep production, private control, oracle, pristine fixture, and sibling locations outside all source trees. Recheck the resolved mount sources immediately at launch; control source replacement or prove it cannot occur.
3. Prove both workers retain ordinary Git hooks and commits in the actual Passeur managed-worktree lifecycle without exposing shared Git writes. Confirm the wrapper's signal propagation and descendant stop behavior under real native host stop, not only command exit.
4. Run a fresh blinded installed trial only after G1 admission and this exact host/native preflight. Record attempts, versions, mount manifests, denied-path checks, native task/input evidence, and any unavailable observation. No provider, real credential, permission, production service, or recovery state was touched in this preflight.

## Standards evidence

Read Core and Router through the live Coding-Standards MCP, then routed actual facts for an offline launcher/tooling implementation, verification oracle, platform-specific filesystem behavior, diagnostics, dependencies, resilience, architecture, security, and concurrent plan integration. The route selected 20 canonical standards, zero unresolved fact categories, snapshot `snapshot:v1:f6f1ccea-9e25-40b9-8635-861ce452b4da`. MCP implementation `0.2.0`, interface `42`, catalog `sha256:bb76238dd7a939e9df2192f03cfad6d2c3dd42b32278fd328e1799ce421a8724`; runtime reported `installation_state: restart-required`, so this records reading authority, not a fresh installed-host acceptance claim.
