# Shared local repository service

## Boundaries

`src/service/client.ts` owns the Codex-facing client and its private reconnect credential. `server.ts` owns private IPC dispatch and connection actors. `bootstrap.ts` owns exact-build launch/discovery. `RepositoryRuntime` owns repository binding, legacy lease, preparation and lazy agent composition. Coordinator/TaskStore remain the only task scheduler and durable task authority. See [task lifecycle](task-lifecycle.md).

The same repository (including linked worktrees) and state namespace uses one service. Clients must agree on the operator-selected profile meaning and installed build/protocol. A mismatch is a diagnostic, never permission to kill another owner, choose a different state root or alter active configuration. The task captures its actual client source view; starting from a different worktree does not silently redirect reviews.

Front-end MCP discovery and status require neither service startup nor a provider. Status version 2 distinguishes front-end identity from a connected service's build/generation. Preparation and submit may start/attach lazily. Profile failures can be repaired before successful composition; the admitted service profile is fixed until controlled restart.

## Election and IPC

Initial support is Linux, qualified local filesystems and util-linux `flock`. The exact installed Node service is launched using nonblocking no-fork flock on a stable private file inside the existing repository state directory. The service checks its actual inode/device/PID lock in `/proc/locks`. It then uses the existing proper-lockfile repository lease for compatibility with legacy/offline owners. Release is in reverse order. Do not unlink the guard inode or use a heartbeat as proof that a living service died.

The protected socket root is `/tmp/passeur-<uid>` (0700) with a bounded per-binding socket name (0600). Canonical filesystem paths, user ownership and mode are verified. There is no TCP or alternate-root fallback. A descriptor contains the exact service generation, protocol/build/binding and process birth plus a private authentication token. The descriptor is a locator, not election authority. Same-user controls prevent accidental cross-session authority; they do not sandbox malicious same-UID code.

IPC version 1 is bounded JSON-lines over Node Unix sockets with complete operation schemas, response validation, correlation, authenticated handshakes and generation checks. Unknown/invalid variants never dispatch. Model inputs cannot choose an endpoint, process command, actor or credential. Side-effecting lost responses are resolved by durable keys, not blindly retried. Slow observers have bounded buffers/waiters; optional progress is distinct from durable control state.

Only the elected owner removes the stale socket/descriptor it owns. A suspended process retains the kernel guard even if its legacy heartbeat expires. A successor after actual death still reconciles possibly surviving native workers before mutation. No process fencing or transparent inference failover is claimed.

## Lifetime and shutdown

A front-end EOF/Stop/signal closes that front end only. Pending presentation claims are released. Accepted tasks, approvals and other clients remain service-owned. Host tool timeouts end observations, not tasks. Use `passeur_cancel` for actual task cancellation.

The service automatically exits only after a generation/epoch-checked empty state: no clients, startup reservation, task, native/input obligation, active operation or pending authoritative work. No idle-task timer exists. A bootstrap reservation is relinquished on handoff or requester closure.

`service-stop` closes admission and drains without an execution deadline. Named `--cancel-tasks` explicitly authorizes cancellation of those controlled tasks only; another client's work is not implicitly stopped. Service SIGTERM/SIGINT uses the same drain contract. Do not force-kill a hung shutdown or delete locks as a generic recovery command. Frozen-state shutdown retains durable reconciliation information.

## Native and platform qualification

Local process/socket/lock probes in the delivered report do not prove actual Codex host attachment, Muse descendant handling, pinned SDK compatibility, arbitrary filesystems, or billing. Run the required installed/native tests before switching a production registration. In particular, Muse's SDK close/exit/fold behavior and native in-turn input variants need version-matched qualification. Native completed-turn questions and Codex's documented request-user-input path are implemented; an unqualified Muse in-turn question route is not claimed supported.

## Operator reconnect credential

Explicit mutating CLI invocations share a private `operator-control.token` in the canonical repository store; actual MCP front ends never read this token. Read-only CLI inspection does not create it. This makes operator submit/attach followed by a separate wait/cancel invocation coherent without exposing credentials in arguments, environment, logs or model results. The file is non-disposable control authority: preserve it or deliberately human-adopt after loss, never regenerate an existing corrupt value.
