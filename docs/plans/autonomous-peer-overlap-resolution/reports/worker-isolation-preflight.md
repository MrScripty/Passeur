# G2 worker isolation preflight

## Installed guest-local transport checkpoint — 2026-09-27

The opt-in `scripts/qualify-muse-sandbox-transport.mjs` stages a digest-pinned Muse 1.4.0-R4302.1 executable, local SDK 1.3.0 and pinned Node 24.12.0 into a private read-only runtime mount. A fresh disposable HOME is the only added writable mount. The current Bubblewrap wrapper preserves the workspace path and unshares networking. The guest creates a fake provider on its own loopback, prepares an empty mode-0700 sessions directory, and asks the installed native host for one persistent session and a metadata-only read; no turn or approval is submitted.

The first fresh run stopped before Muse because the guest already had loopback `UP` and lacked permission to run the unnecessary `ip link set lo up`. The second reached native catalog GET, then the SDK's file-ESM `getRandomValues` call failed under guest `/usr/bin/node` 18.19.1. Both roots remain retained. After read-only loopback checking and exact staged Node 24.12.0, the third fresh run passed: host `net:[4026531833]`, guest/native `net:[4026533700]`; native host made `GET /muse-code/models` to the guest provider; `session/start` and `session/read` returned idle session `01a0e4d4-1251-76a0-a318-8cd37a70fdba`, zero turns, no pending input, excluded history and a 6891-byte durable log under `/tmp/passeur-muse-sandbox-transport-Krfg5b/home`. The outer host reached a loopback sentinel before/after; the guest got `ECONNREFUSED` to that port and `ENETUNREACH` to a numeric external address. Direct, symlink and `/proc` protected canaries were absent. A separate direct guest HTTP client made the sole `/responses` POST; it is transport evidence, not native model inference. Focused tests passed 12/12 and the independent reviewer cleared P1/P2. Roots `/tmp/passeur-muse-sandbox-transport-WyIU9h`, `/tmp/passeur-muse-sandbox-transport-GxvjOp` and the passing root are retained because arbitrary descendant stop remains unverified.

The installed observation establishes guest-local fake-provider transport and sampled outer network/path separation for an idle host. It does not establish real credential protection, native file/shell-tool denial, approval behavior, protected private-Git commits, fresh-host resume, exact descendant stop, a Passeur service task or real worker inference. Those remain G2 requirements.

To reproduce this no-account diagnostic from the repository root, use `node scripts/qualify-muse-sandbox-transport.mjs` with the pinned Muse binary at `/home/jeremy/.local/bin/muse-bin-1.4.0-R4302.1`, local SDK 1.3.0, Node 24.12.0 and Bubblewrap available. The managed shell may reject Bubblewrap namespace creation with `EPERM`; that is a preflight failure, not a Muse result. A `transport_error` includes a typed guest stage/code and process exit facts when available. `transport_observed` requires the native catalog GET, idle durable read, distinct namespaces and sampled network/path denials. The command retains every fixture root after an attempted host start and never treats SDK close as descendant-stop proof. Inspect the exact root before any later cleanup; do not reuse it for a second writer while stop remains unverified.

## Same-host persistent read checkpoint — 2026-09-27

The isolated no-account `muse serve` diagnostic now has an opt-in `raw-precreated-read` mode. It prepares an empty private sessions directory under a fresh HOME, starts one persistent session and reads that session's metadata on the same host with `excludeItems: true`. Installed Muse 1.4.0-R4302.1 and SDK 1.3.0 returned idle status, a canonical `session.jsonl` path within that HOME, zero turns, no pending requests, excluded history and an empty string view cursor. The diagnostic initially rejected the valid empty cursor twice; after correcting the check, a fresh run passed. Focused tests passed 27/27. The fake endpoint saw only `GET /muse-code/models`. The passing root `/tmp/passeur-muse-serve-boundary-WCRCbO` and the earlier two rejected-read roots remain retained because full descendant stop was unverified. This is same-host durable read evidence only; fresh-host resume and native worker boundaries remain open.

Read-only follow-up found that the existing Bubblewrap worker has an unshared network namespace, so its loopback cannot reach the current fake provider on host loopback. A confined no-account transport candidate would start the fake listener and installed host in the same guest network namespace, then verify guest-positive fake catalog/Responses traffic and guest-negative external reachability. Do not infer credential isolation from a same-UID native shell sharing its mount view; real credential protection requires separate native evidence.

**Plan and operation:** `docs/plans/autonomous-peer-overlap-resolution/plan.md`, `continue`. The earlier offline preparation below does not promote G1. The installed no-account checkpoint above remains narrower than protected or live worker admission.

## Boundary recipe

`scripts/experiment-worker-sandbox.mjs` wraps a **new disposable host process** before Muse starts. The caller supplies a JSON configuration with an absolute `workspace`, nonempty absolute `denied` directory list, optional exact `mounts` (`source`, guest `target` under `/mounts`, `mode: ro|rw`), and a deliberately constructed `env` object. Run `node scripts/experiment-worker-sandbox.mjs CONFIG.json -- HOST ARG...`. The wrapper supplies a private mount namespace and user/PID/IPC/UTS namespaces, isolated `/proc`, `/dev`, and `/tmp`, a clean environment, read-only system executable paths, only the named worker worktree at `/workspace` by default, and exact additional mounts. `preserveWorkspacePath: true` instead binds a canonical worktree beneath `/tmp` at its original absolute path for Muse's `workspaceRoot`; the isolated `/tmp` contains only the constructed path and does not expose adjacent host directories. It does not bind `/`, `/home`, the repository containing production code, or a shared Git common directory. Writable source overlap and protected-source overlap fail before launch. Native stdout/stderr/stdin, cwd, child exit status, and ordinary Git hooks remain in the launched process path. The test uses fake data and a fake local Git repository only.

Each worker must receive a separately prepared worktree and private writable Git metadata. A linked worktree's `.git` pointer and `commondir` often refer to the shared repository; the offline fake host uses a self-contained `.git` inside its own workspace. The real host must either provide an equivalent private Git view compatible with Passeur's canonical repository identity and normal commit/finalize path, or identify narrowly scoped Git writes and prove they cannot affect another worker. This wrapper deliberately supplies no blanket write access to shared Git. Additional read-only runtime mounts must be exact, reviewed paths; the wrapper cannot infer native Muse runtime requirements.

## Observed result

The observations in this section describe the initial wrapper before the later canonical-mount checkpoint added `--unshare-net`. The current wrapper's network namespace and host-positive/guest-negative loopback evidence are recorded in the active plan and acceptance matrix; the historical shared-network statement below is not its current behavior.

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

The subsequent G2 Git-isolation decision is recorded in the active plan. A
disposable linked-worktree probe showed that binding a task-private Git common
view at Git's expected absolute path permits an ordinary worker commit without
changing the host branch. A trusted post-stop import and host index refresh
restored a clean canonical worktree in that probe. It did not exercise
Passeur's retained publication intent, untrusted Git-data quarantine, crash
recovery, actual Muse or credential isolation; those remain requirements
before installed admission.

The actual native shell posture has a further condition. Current [Muse
permissions](https://dev.meta.ai/docs/muse-code/permissions?project_id=1775916636764246&team_id=1331104075427093)
and [immutable-guardrails guidance](https://dev.meta.ai/docs/cookbook/immutable-guardrails?project_id=1661600634933790&team_id=2096920474558192)
say default OS sandboxing mounts workspace `.git` read-only, independently of
approval. The installed 1.4.0-R4302.1 `muse serve --help` lists
`--disable-sandbox`; its documented use inside an already-isolated host is a
conditional candidate, not an admitted setting. It removes Muse's file-tool
workspace confinement and forces network egress within the namespace. The
current wrapper shares the host network namespace and does not isolate a
credential from worker tools, so neither an allow-once decision nor the
private-Git mount proves a real Muse commit or blinded isolation. Qualify a
version-matched native host with fake credentials, exact native tool/file
denial, network policy, Git hooks and a worker-created commit before a paid
pair or a claim that this replacement boundary is equivalent.

A disposable no-provider launch at `/tmp/passeur-muse-echo-jqdnha7o` mounted
only the installed static Muse binary directory read-only and used the
preserved absolute workspace path. The exact installed 1.4.0-R4302.1 binary
ran `exec --provider echo --disable-sandbox --no-session-log
--no-foreign-personal-context` inside the outer wrapper and returned `echo:
hello` with exit 0. This confirms startup and path compatibility for that
no-provider process. Echo did not invoke shell or file tools, authenticate,
exercise MSP, create a commit, or test network/credential denial. The
disposable canary directory remained outside the namespace.

The installed `muse exec` accepts a dummy API key on stdin and a loopback
`--base-url`; a disposable fake endpoint saw a first `/muse-code/models`
catalog request, then the CLI stopped because no catalog was served. This did
not invoke a model tool or reach an account. An SDK MSP diagnostic separately
requested `userShell` with an echo session; that user-initiated TUI escape
hatch wrote `.git/probe` under the default Muse host posture. It exercises a
different authority path from model shell tools and is explicitly excluded
from Git-write qualification. Passeur's Muse adapter does not request the
`userShell` capability. The diagnostic host was closed and its disposable Git
fixture removed. A bounded scripted fake catalog/response stream then induced
an actual installed model `tool.bash` call without a real account. With
`--approval-mode never` and no explicit `--disable-sandbox`, one disposable
run wrote `.git/probe`; another made a commit and ran the fixture's default
pre-commit hook. These are observed effects for that exact `exec` posture,
not proof that its effective sandbox was active or that the Passeur MSP host
can do the same. A proposed tool under `on-request` produced no file/tool
result during a bounded 20-second observation; the diagnostic did not capture
a completed native approval decision. The attempted `../outside-canary` write
was inside the temporary root and is not a valid denial control because Muse
documents temp writes. The fake endpoint saw catalog and Responses traffic on
loopback with a dummy stdin key; other network egress was not independently
denied or observed. Preserve APR-028 until an effective boundary and actual
approval posture are qualified.

The adapter-relevant `muse serve` route has a separate bounded no-account
diagnostic in `scripts/qualify-muse-serve-boundary.mjs`. It gives the host a
disposable `HOME`, fake Meta credential and loopback provider configuration,
then requests an MSP session through the local SDK 1.3.0 against installed Muse
1.4.0-R4302.1. On `node scripts/qualify-muse-serve-boundary.mjs inside deny`,
the fake endpoint saw `GET /muse-code/models`, then `session/start` returned
`-32603` with `read surviving deletion authority: deletion registry authority
is unavailable: UnsafePath`. There was no Responses request, worker turn,
approval or model tool. Focused diagnostic tests pass 4/4; an independent
Astra High review cleared three lifecycle findings for this retained diagnostic.
The SDK close does not attest to descendant stop, so the result reports
`descendants_unverified` and retains
`/tmp/passeur-muse-serve-boundary-E1SSEL`. This run establishes an exact
session-start blocker, not a native tool or isolation result. Resolve the
version/host condition before repeating the same probe; keep this fixture until
its remaining processes can be identified and safely stopped.

The [official SDK quickstart](https://meta-models.github.io/muse-code-sdk/next/generated/examples/quickstart-journey/)
sends `session/start` with only `workspaceRoot`. A reviewed raw variant of the
probe used that exact command shape with `maxAttempts: 1`, and validates the
returned UUIDv7 and workspace before reporting success. Its focused suite
passes 6/6. Installed command `node scripts/qualify-muse-serve-boundary.mjs
inside deny raw` reached the same catalog GET and the same `-32603 UnsafePath`
session-start failure; it retained
`/tmp/passeur-muse-serve-boundary-b5uoAF` with descendant stop unverified.
This rules out optional facade request fields as the sole cause. Published SDK
1.3.0 is still the current mirrored package; no documented deletion-registry
setting or recovery path was found in the inspected SDK and [sessions
guide](https://meta-models.github.io/muse-code-sdk/next/guides/msp-concepts/sessions-and-turns/).
The native root cause is unproven. Do not repeat either unchanged request until
a supported host-state correction or additional diagnostic evidence changes the
precondition.

A subsequent changed-state diagnostic used the same raw `{ workspaceRoot }`
request, disposable HOME/workspace and fake loopback provider, changing only
the installed host arguments to `serve --no-session-log`. The reviewed probe's
focused core suite passed 11/11. One installed Muse 1.4.0-R4302.1 / SDK 1.3.0
run returned `raw_session_started`, idle session
`01a0e493-6f60-7043-9a7f-31a6b4adb261`, after only
`GET /muse-code/models`. No turn, approval or model tool occurred. Bounded close
reported quiet captured descendants but retained stop proof
`descendants_unverified`, so `/tmp/passeur-muse-serve-boundary-v2T2fW` remains
retained. This localizes the failure to persistent-session behavior bypassed
by the flag; the deletion-registry cause and durable-session recovery are still
unknown. The memory-only result is not a usable worker lifecycle qualification.

A separate reviewed `raw-trace` probe kept persistent `serve` and the exact raw
request. It launched a metadata-only `strace` sidecar after host initialization,
but could not verify attachment. It returned `native_trace_unavailable` before
`session/start`; no persistent result or syscall path was observed. The fake
endpoint received only the catalog GET. Tracer PID 18203 exited code 1, the
retained trace is empty, and read-only Yama `ptrace_scope` is `1`; this is
consistent with restricted sibling attachment, without proving the sidecar's
exact error because its stderr was discarded. Bounded SDK close observed quiet
captured descendants but did not prove all descendants stopped. The fixture
`/tmp/passeur-muse-serve-boundary-ihvDfS` remains retained. The trace probe's
focused tests passed 15/15 after independent review and repair of a tracer
stop-reporting bug. No kernel policy was changed. Persistent MSP and protected
worker admission remain open.

An independently reviewed `strace -D -I 2` arrangement then preserved the
native child's PID/parent/process group and observed a separate tracer. The
first installed diagnostic conservatively stopped before `session/start`
because it compared `/proc/<host>/exe` to the Bash launcher rather than the
versioned binary; retain `/tmp/passeur-muse-serve-boundary-RamFNk` with tracer
stop unknown. A reviewed repair pinned the exact installed 1.4.0-R4302.1
binary path and SHA-256, while keeping the original launcher invocation.
Focused tests passed 23/23. One repaired no-account persistent raw request
reproduced `-32603 UnsafePath` at `session/start`. Exact tracer PID 23236 was
observed attached, detached and terminal before SDK close; host descendants
are still unverified. The root `/tmp/passeur-muse-serve-boundary-27vtab` and
its 1,344,659-byte metadata trace (SHA-256
`cbbafb2170021e074c6f1dfc03263b674e0168df7fc23f14ec5847dfe54bed71`)
remain retained locally. The last traced filesystem call before the error was
`stat` of the disposable HOME's missing `.local/share/muse/sessions` directory.
The session index had already been created and opened, with no subsequent
`mkdir sessions` in that trace. This path is a concrete diagnostic lead, not
proof of the deletion-registry cause. No turn, approval, model tool or real
account occurred.

The next reviewed counterfactual precreated an empty
`.local/share/muse/sessions` directory inside a fresh disposable HOME before
launching persistent `serve`. It also created the three missing ancestors;
all four were verified as real owner-owned mode-0700 directories, and the leaf
was empty. The focused suite passed 26/26 and independent Astra High review
found no P1/P2. One installed no-account raw `session/start` returned idle
session `01a0e4b6-f956-79b3-a6da-d5ee0c855170` with no turn, approval or
tool, and only the fake model-catalog GET. Its retained
`/tmp/passeur-muse-serve-boundary-yNEXWS` now contains a `session.jsonl` and
MSP view files. SDK close and sampled group observation were quiet, but
descendant stop remains unverified; the root was retained. This prepared
directory state is sufficient for startup on the installed host. It does not
prove a precise deletion-registry defect or a supported deployment setup, and
does not qualify restart recovery, permissions, isolation or real workers.

1. Establish a genuinely new disposable Muse MSP host invocation with the wrapper outside the adapter, before provider/native initialization. Preserve normal service attachment, accepted-task ownership, native input, continuation, and explicit cancellation.
2. Capture and review the exact new host executable, runtime libraries, sockets, cwd, environment/credential route, and Git common-dir layout. Mount only required paths; keep production, private control, oracle, pristine fixture, and sibling locations outside all source trees. Recheck the resolved mount sources immediately at launch; control source replacement or prove it cannot occur.
3. Prove both workers retain ordinary Git hooks and commits in the actual Passeur managed-worktree lifecycle without exposing shared Git writes. Confirm the wrapper's signal propagation and descendant stop behavior under real native host stop, not only command exit.
4. Run a fresh blinded installed trial only after G1 admission and this exact host/native preflight. Record attempts, versions, mount manifests, denied-path checks, native task/input evidence, and any unavailable observation. No provider, real credential, permission, production service, or recovery state was touched in this preflight.

## Standards evidence

Read Core and Router through the live Coding-Standards MCP, then routed actual facts for an offline launcher/tooling implementation, verification oracle, platform-specific filesystem behavior, diagnostics, dependencies, resilience, architecture, security, and concurrent plan integration. The route selected 20 canonical standards, zero unresolved fact categories, snapshot `snapshot:v1:f6f1ccea-9e25-40b9-8635-861ce452b4da`. MCP implementation `0.2.0`, interface `42`, catalog `sha256:bb76238dd7a939e9df2192f03cfad6d2c3dd42b32278fd328e1799ce421a8724`; runtime reported `installation_state: restart-required`, so this records reading authority, not a fresh installed-host acceptance claim.
