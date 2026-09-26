# Passeur: shared service and evidence-driven task lifecycle

## Current authority

| Field | Value |
| --- | --- |
| Plan status | `Verifying` |
| Acceptance status | `blocked` |
| Current phase | M4 — pinned, native and installed acceptance of the source candidate |
| Exactly one next integration slice | **M4-S1 — run full pinned checks and qualify the real native/installed boundaries; route source defects back to their owner** |
| Canonical plan path | `docs/plans/shared-service-and-evidence-driven-lifecycle/plan.md` |
| Initial implementation operation | `start`; later invocations explicitly use `continue` or `verify` in the applicable Planning states |
| Source examined | Passeur `18c8eb9593c5f9e9faae48314ddc136ba366e109` |
| Standards authority | MrScripty/Coding-Standards `366c1d90a24bbfb50973f62b155a5f3396c0f107` |
| Prepared | September 20, 2026, America/Vancouver |
| Product/acceptance owner | Passeur maintainer |
| Plan/shared-source integration owner | One explicitly assigned lead implementer |
| Composed-design review | `applicable`; all eight probes answered in [design admission](reports/design-admission.md) |

[Execution ledger](execution-ledger.md) records dated work and evidence. [Issues](issues.md) owns findings and dispositions. [Sources and standards route](reports/sources-and-routing.md) records the examined authorities. [Verification scenarios](reports/verification-scenarios.md) and [skill requirements](reports/skill-requirements.md) refine the gates below without replacing their owning contracts.

Implementation was explicitly admitted with operation `start` by the request to implement this plan. Evidence is recorded in [implementation-evidence.md](reports/implementation-evidence.md); no live acceptance is implied. The maintainer reports existing end-to-end production use; that is context, not measured evidence for the proposed service, reconnect, or lifecycle changes. The particular lingering-owner incident has not been reproduced in this planning environment.

## 1. Objective

Allow multiple simultaneous Codex sessions to use Passeur against the same canonical repository, including linked worktrees, through one shared local coordination service. A long-running agent assignment continues independently of caller connections and individual tool calls. Passeur ends an assignment only from an explicit authorized control decision or authoritative execution evidence, never because an execution, approval, queue, or inactivity timer elapsed.

The user-visible path is:

**discover → prepare/attach → submit once → observe or wait → supply required input → reconnect when needed → obtain an identified deliverable → integrate externally → explicitly account for resources.**

The task's native session, known subordinate operations, input obligations, stop evidence, and durable outcome explain whether it is working, waiting, complete, failed, cancelled, or genuinely unresolved. Silence is not an outcome.

### Preserved responsibilities

The caller chooses tasks, dependencies, registered agents, exact implementation bases, and integration/acceptance timing. Workers read repository instructions, perform scoped checks, preserve hooks and signing policy, and make ordinary commits. Passeur owns admission, supervision, evidence, isolated workspaces, and safe resource disposition. It does not become a project-test runner, agent reasoning loop, autonomous repair system, merger, PR manager, or mandatory per-worker review gate.

Keep the registered-agent boundary, immutable admitted execution identity, repository-common store, ordinary failure isolation, meaningful resource limits, full-tip ancestry for integrated retirement, exact archive protection, and refusal to retire dirty, unknown, live, or uniquely unprotected work.

### Scope

In scope: connection/service/task lifetime separation; local service election and attachment; durable submit/wait/cancel/input controls; native Muse and Codex lifecycle mapping; explicit uncertainty; non-time-based execution; versioned storage/profile/tool migration; installed-runtime and named-registration integration; authoring/usage skill changes; process, IPC, Git, installed-host, and independent-review evidence.

Out of scope: remote or multi-user service access; arbitrary third-party plugin loading; new model-selection policy; OS-wide/account-wide scheduling; new inference loop; automatically resuming uncertain inference after a service crash; a durable distributed event bus; arbitrary process migration; upgrading running workers in place; a GUI; protecting against a malicious program with the same user's filesystem/process authority. No network exposure or weaker-platform fallback is introduced.

Initial new service support is **Linux on a qualified local filesystem**, matching the reported deployment. Existing historical data remains readable. Support for another platform requires an explicit equivalent service-lock, peer-isolation, native-lifecycle, and installation decision, not an inference from TypeScript portability.

## 2. Reconciliation and known failures

At the examined baseline, the source gives each MCP connection its own `RepositoryRuntime`, and connection shutdown eventually drains that runtime and releases the repository lease. The coordinator still creates absolute task deadlines. Human elicitation has a separate five-minute timer; the Git helper supplies a ninety-second default when no signal is given. These are reachable members of one lifecycle-authority problem, not independent numeric tuning issues. See source references R1–R8.

| Prior decision | New binding decision | Preserved part |
| --- | --- | --- |
| One prepared connection holds repository coordination until it closes | One repository service holds coordination; many front ends attach | Canonical repository/state namespace and exclusive mutation authority |
| Original pending request owns cancellation | Durable task control owns cancellation; requests own only their waits | Explicit, scoped cancellation and duplicate-execution prevention |
| Absolute task deadline includes queue and approvals | No task/queue/approval/inactivity deadline terminates execution | Finite admission, process and resource bounds |
| Same tool call must remain pending until completion | Durable acknowledgment plus stateful observation/wait | Convenient waits where supported; retained result identity |
| Closed client shuts down its runtime | Closed client detaches its observation/input-delivery channel | Proper front-end stream and callback cleanup |
| Daemon/service excluded | A repository-scoped service is required by this objective | No global agent framework or second task scheduler |
| One terminal native turn is enough to finish a run | Native turn termination must be interpreted with assignment outcome and outstanding obligations | Native protocol authority and truthful Git delivery |

M0 reconciles the registered-agent, discoverable-startup, and attached-tool plans with this authority. Transfer only the affected decisions and acceptance dependencies, and link the owner; do not mark their unrelated pending evidence satisfied. Historical terminal results, including `timed_out`, remain historical facts.

The runtime-lock report may involve an undelivered disconnect, a hanging drain, a live orphan front end, a stale legacy lease, or a durable safety freeze. Capture the exact build, process, phase, and error code before assigning cause. A new shared service resolves connection contention but does not excuse an unobserved shutdown failure.

## 3. Standards and implementation discipline

Read Core and Router at the adopted revision, then the applicable canonical owners. The route includes Planning, Implementation, Verification, Development Proportionality, Commit, Documentation, Build and Tooling; Architecture/Code Design; Contracts with protocol, schema and evolution details; Concurrency, Resilience, Security, Diagnostics, Dependencies/Licensing, Cross-Platform; TypeScript/Async; IPC, Persistence, Generated Contract where MCP schema projection applies, and Launcher. Follow `Requires`. The route and exclusions are in the source report.

The plan follows the library's artifact model, lifecycle states, explicit invocation, eight-part composed-design admission, bounded write sets, and claim-matched evidence. One lead changes schemas, lifecycle authority, lockfiles, shared fixtures, and plan state. Concurrent Plan Integration is not selected merely because product sessions or read-only reviewers are concurrent; select it only if independently authorizing proposals can become stale before integration.

Each slice begins with repository status, its exact material write set, source/consumer context, and selected verification. Protect unrelated changes. Add regressions with the changed invariants; inspect the staged diff and sensitive/generated effects before an ordinary conventional commit. Do not prescribe commit counts or rewrite published history.

Apply obligations to the complete affected semantic family: service ownership, task lifecycle, input/control, storage, public projection, and their reachable consumers. Required violations there cannot be deferred while claiming acceptance. Adjacent optional improvements receive an owner and revisit trigger rather than expanding the change. A plan and green tests alone are not proof of general or future codebase compliance.

## 4. Runtime architecture and ownership

### D1. Three lifetimes with one task owner

A Codex registration launches a **stdio front end**. It owns its MCP connection, local IPC connection, request waits, and human-prompt presentation. It does not own the repository lease or native workers.

A **repository service** owns one `RepositoryRuntime`, one coordinator, one registry/configuration snapshot, one store, and one Git-resource administration path. It can outlive every client while unfinished tasks or native/resource obligations remain.

An **assignment execution** is service-owned from durable acceptance through native work, input pauses, finalization, and a recorded terminal outcome. Its cancellation signal is created by its task owner, not inherited from a caller request.

| Owner | Sole responsibility |
| --- | --- |
| `src/mcp/server.ts` and front-end connection owner | Client protocol, capability observation, request association, response projection, presentation cancellation |
| `src/service/` | Local discovery/launch, authenticated attachment, connection actors, service generation, service lifetime, shutdown entrypoint |
| `src/core/repository-runtime.ts` | Binding, repository lease/preparation, lazy registry/execution composition, administrative coordination |
| `src/core/coordinator.ts` | Durable admission identity, queue/capacity, task control/state transitions, terminal publication |
| Input broker | Pending input identity, per-client delivery claim, validated answer/withdrawal records; not human intent or native permission semantics |
| Adapters | Native session/turn/tool observation, native input translation/continuation, execution/stop evidence |
| Store and existing resource/disposition owners | Durable publication/recovery and exact Git-resource protection respectively |

These are responsibility boundaries, not a requirement to create a class for every noun. Keep coherent operations together. Extract only where lifetime or authority actually differs. The front end must not recreate task state in a local cache that can authorize execution.

### D2. Discoverable front end; lazy service work

MCP initialize, tool enumeration, and front-end status remain independent of repository preparation, profile validity, provider availability, and service startup. Connecting to a currently discovered service may enrich status, but an unavailable service must not hide tools or turn `not_checked` into success.

`passeur_prepare` requests service attachment/preparation without inference. Submission may do that lazily as well. Missing prerequisites before durable admission may be repaired and retried. After configuration is admitted by the service, it is fixed for that service lifetime; changes require a controlled restart/cutover.

A read-only history path remains available when the service cannot start; it uses existing validated store readers and grants no mutation authority. All online mutations go through the service. Explicit offline maintenance first proves that the service is absent and acquires the same ordered ownership guards. It must not race a running service.

### D3. Safe election is not heartbeat inference

Retain the existing repository lease during compatibility with old runtime/offline consumers. Add a **Linux process-lifetime election guard** at a stable file inside the same repository state directory. The selected initial mechanism is util-linux `flock` in nonblocking, no-fork command mode, launching the exact installed Node service with structured arguments; this is an OS deployment dependency, not a new daemon or native Node binding.

The election guard prevents two new service incarnations from owning the namespace even if a live process is suspended longer than a heartbeat threshold. The existing lease still prevents conflict with a supported legacy/offline owner. Acquisition order is election guard, then repository lease; release order is reversed. These are different invariants, not two task owners. Record the compatibility lock's future removal condition; do not migrate unrelated config-edit locks.

Qualify descriptor inheritance: native agents, shell/Git children, proxies, and unrelated processes must not inherit the election-lock descriptor. M0 tests the actual `flock`/Node invocation; an unavailable or incompatible mechanism yields `SERVICE_PLATFORM_UNSUPPORTED`, not an expiring-lock fallback. Keep the lock-file inode stable; never unlink it to recover a held lock.

Publish a service descriptor only after the service has acquired the guard and established its listening identity. It contains protocol version, service generation, repository/state binding, installed build, safe process-birth identity, configuration identity when available, and endpoint. It is a locator, not proof of ownership. Use a protected short Unix-domain socket path and an authenticated handshake. Validate path ownership, containment, filesystem semantics and permissions; no TCP/listener fallback.

The private IPC contract uses bounded, versioned request/response/event variants with complete operation-specific decoding, correlation and service-generation checks. Use Node Unix sockets and the existing protocol/transport facilities where their verified contract fits; any small owned framing code remains transport-only, not a second generic RPC framework. A private side-effecting response lost after dispatch is resolved through its durable operation key, not resent blindly. No model-provided executable, environment, endpoint or actor field bypasses the approved binding.

A startup handshake owns a temporary launch/attach reservation until handoff or observed requester closure. Retiring a failed bootstrap reservation cannot cancel existing tasks. Account for front-end loss before first attachment so a permanently abandoned reservation cannot prevent empty-service shutdown.

On concurrent launch, losers attach to the winner after a verified handshake, or report a retryable startup observation. On slow/unreachable discovery, keep the existing owner and return uncertainty. Elapsed time or connection refusal alone cannot authorize stealing ownership, deleting an endpoint, sending a process signal, or launching a second mutating owner.

After actual service death, the OS guard can become acquirable. A replacement still must acquire the repository lease and reconcile retained work before admitting mutation. Kernel lock release proves nothing about surviving worker descendants. Stale endpoint removal is allowed only under the new elected ownership, for the exact owned generation/path. Unsupported network filesystems and ambiguous legacy owners require explicit reconciliation.

### D4. Binding and client identity

Repository identity remains the canonical Git common directory plus the existing approved state namespace. Preserve supported non-Git review directories using their existing canonical directory identity. Alternate state roots are not a supported concurrency workaround.

The service configuration is explicitly selected by operator-approved registration/configuration, not silently chosen by the first arbitrary client. Compatible clients can attach from different linked worktrees. They must use the same admitted execution/registry configuration; a different profile meaning produces a binding conflict, not a second service or live reconfiguration.

Keep the client's source view separate from service identity. A review from worktree A must not accidentally inspect worktree B because B started the service. The front end supplies its validated bound source view; the service verifies repository membership and captures it in admitted request identity. Implementation still uses an exact base and a separately prepared task worktree. Preserve source-change/staleness observations for review.

Distinguish installed build, service generation, client connection, durable task owner/control grant, assignment ID, request key, and native run/turn IDs. A caller-provided ID is not proof of authority. The service authenticates the private local connection and assigns its actor. Access/control capabilities stay in front-end/service-managed private storage or memory, never in prompts, ordinary logs, or shell arguments.

A new front end can observe/control a task through an existing verified reconnect credential. When the host supplies no supported stable conversation identity or that credential is lost, an explicit **human-confirmed attach/adoption** obtains authority. It may select a known task ID or the original request key, so loss of the submission receipt does not make recovery impossible. Do not infer ownership from a server name, current directory, PID alone, knowledge of a task ID, or another client's connection. Adoption increments a control generation and invalidates stale prompt claims; it does not repeat the task.

Same-user IPC controls prevent accidental cross-session operations and untrusted task arguments from claiming authority. They are not a security boundary against arbitrary malicious code running with the same user's privileges. Preserve narrow worker environment/tool isolation; do not pass service control credentials into workers.

## 5. Durable operations and caller contract

### D5. Submit once, observe independently

Add the following explicit tool operations, with one authoritative domain implementation used by the CLI and MCP:

| Operation | Contract |
| --- | --- |
| `passeur_submit` | Accept one assignment; return a durable task receipt promptly after publication, not a completed-work claim |
| `passeur_submit_batch` | Admit independent assignments under bounded configured capacity; return separate accepted/rejected entries, without shared acceptance or sibling rollback |
| `passeur_tasks` | Read paginated authorized task observations, including active/waiting/reconciliation states; find a lost receipt by request key |
| `passeur_wait` | Observe a particular task after a revision/cursor, until change, required input, terminal result, or the request's observation budget ends |
| `passeur_input` | For clarification, accept an explicit typed reply; for permission, present the exact pending operation to the human and relay that human decision |
| `passeur_cancel` | Persist an authorized task-specific stop intent with operation key and reason; return cancellation progress, not presumed stopped success |
| `passeur_attach` | Recover/share control only through existing valid credentials or a human-confirmed adoption flow; not automatic ownership by task ID |
| Existing status/prepare/agents/result/finalize | Preserve their distinct diagnosis, coordination, registry, retained-evidence and explicit disposition responsibilities, with necessary versioned projections |

A submit envelope owns the new submission/receipt semantics; retain the existing assignment schema where its objective/mode/base/path semantics remain unchanged. The new envelope additionally binds the validated client source view and request identity required for different worktrees. Specify canonical hashing at that envelope's authority; do not reuse the old assignment hash under a different meaning.

Within the repository namespace, equivalent retries under authorized ownership return the same task. The request key is independent of an ephemeral connection. A different agent, objective, source view, base or other material intent conflicts. Configuration changes do not rerun an existing task. A coincident key from a different owner returns a control conflict rather than silently sharing work or exposing input. Intentional sharing uses the explicit attach authority.

Admission atomically publishes the immutable request, resolved non-secret execution snapshot, initial control state and ownership before acknowledgment and before native side effects. Preserve an uncertain acknowledgment by key-based lookup. Cancellation of a submit request before publication may prevent admission; after publication it only prevents receipt delivery. This boundary must be observable and tested.

Do not promise exactly-once external effects across arbitrary crashes. Promise no automatic duplicate execution of an accepted/uncertain task, durable receipts, and explicit reconciliation of unknown outcomes.

### D6. Waits are observations

A wait returns a tagged observation such as `changed`, `input_required`, `terminal`, or `wait_elapsed`, plus current task revision and resumable observation position. `wait_elapsed` is not an execution status and never becomes `timed_out` in the task record. Cancelling or losing the wait removes its waiter and presentation work only.

Register each waiter and inspect its revision under the same state-owner ordering contract so completion cannot occur between an initial read and subscription and be missed. Publish committed state before notifying clients. A reconnect obtains a fresh authoritative snapshot; notification delivery is an optimization, not the only record of progress. A pruned observation cursor returns an explicit gap and current snapshot, not a fabricated contiguous event history.

Use service-to-proxy events and bounded waits; the model must not spin in a tight polling loop. Because a host may not schedule a new model turn on a notification, the usage skill must also describe how to wait/retrieve explicitly. No result, input, or cancellation correctness depends on waking the model automatically.

Use ordinary MCP tools as the baseline. Do not depend on unverified MCP Tasks support in the installed host. Native MCP Tasks may later be a capability-negotiated projection of the same task owner, not another store/scheduler. That projection is outside the initial implementation unless M0 demonstrates it is necessary to satisfy the real host workflow. Any such adoption needs its own status/cancellation/TTL mapping; never let a protocol TTL delete unfinished authority or kill work.

### D7. Human input without model-issued permission

The service input broker owns a durable pending request with task ID, run/turn generation, native request identity, input kind, operation digest, requested fields/offered choices, state revision, and one delivery claim. Native request details remain within their disclosure policy; ordinary status exposes only safe summaries.

`passeur_wait` may return `input_required`. The caller then invokes `passeur_input`; this tool initiates a fresh **request-associated** MCP elicitation through the attached front end. Do not depend on unsolicited server-to-client requests after the originating submit call ended, or on a generic remote `approve=true` field supplied by the model.

Permission and clarification have separate variants. Permission decisions originate from the supported human elicitation or explicit operator CLI path; the model cannot manufacture consent. A clarification can use a caller-supplied factual answer when the request permits it, but that answer grants no permission. Operator commands never silently bypass the owning host's approval policy.

Claim an input presentation or state transition under its owning synchronization, then release that guard before invoking a human prompt, provider callback or other externally controlled code. Never hold repository admission, task-control or store locks while waiting for a human. Per-client prompt serialization must not serialize all worker execution or block cancellation/recovery.

If the host times out, closes, dismisses an elicitation, or loses a delivery channel, release that delivery claim and leave the native operation **unapproved and pending** while it remains valid. An explicit human denial is a denial, not a dismissed prompt. It may cause the native agent to choose another permitted action; it is not automatically whole-task cancellation.

Before dispatching an answer, prove control generation, active native request/turn, exact operation/choices, request revision, and nonterminal state. Serialize answer/cancel/withdrawal races at their owner. One accepted operation key yields one committed answer intent. Identical repeats return its receipt; different content conflicts. A late answer to a withdrawn/replaced request is rejected.

Persist answer intent before native dispatch and acknowledgment afterward. A crash between them creates a delivery-unknown state; reconcile using native identity/query semantics before any resend. Unsupported exactly-once native delivery cannot be replaced by an optimistic retry. Secrets are not solicited into ordinary form fields or retained diagnostics.

MCP or native request timeouts may still end a particular presentation/exchange. They do not authorize consent, denial, completion, or task termination. If a native platform itself irreversibly ends its session, record the observed native terminal/failure, retain useful work, and disclose the limitation. Do not pretend Passeur can override an external platform's behavior.

## 6. Evidence-driven task state

### D8. Separate progress, native evidence, and outcome

Use a closed, validated task state transition model. The following are the required distinctions, not a license for arbitrary combinations of string flags:

| Dimension | Meaning |
| --- | --- |
| Phase | `queued`, `starting`, `active`, `awaiting_input`, `needs_attention`, `stopping`, `finalizing`, `terminal` |
| Activity observation | Known agent work, known outstanding tool/process/dependency work, or unknown; observed IDs/counts where the native contract supplies them |
| Runtime evidence | Not started, observed live session/process, known stopped, or unknown; source/generation of observation retained |
| Task outcome | Native/assignment completion, failed/blocked terminal disposition, cancelled, interrupted, or unavailable until terminal |
| Stop evidence | Existing `not_started`, `confirmed`, `unconfirmed`, with provenance; independent of successful report |
| Client association | Attached/detached and control/input-delivery ownership; never interpreted as execution status |

`needs_attention` means a nonterminal assignment cannot be progressed safely from current facts. It is not falsely reported completion. Terminal `blocked` means a native terminal/explicit assignment disposition says the task cannot proceed within its contract; it is distinct from a live task waiting for an answer.

Pending input and pending tools may coexist. Keep a bounded set of known outstanding obligations, not one exclusive activity label that loses one of them. Native event/protocol ownership determines what is observed; an adapter cannot infer a tool completion from silence or reset every pending counter on an arbitrary agent message.

### D9. Completion contract

Successful execution finalization requires all of the following evidence:

1. A native terminal signal is correlated to the current run/turn and classified as successful, rather than merely a method named `completed`.
2. The assignment explicitly supplies a completed disposition under the versioned worker-message/report contract. A finished turn that requests more information is not assignment completion.
3. Required native/tool/input obligations are accounted for by authoritative events or a documented native settlement guarantee. The stream and callback ordering contract is respected. Absence of an event is not an empty pending set when the adapter lacks coverage.
4. No unresolved cancel/failure/authority conflict makes success invalid under the transition contract.
5. Native shutdown/quiescence is observed as required for stable Git collection. The existing Git observer determines committed/no-change/incomplete delivery independently of worker claims.

The adapter evidence must distinguish a complete task from a task waiting after a turn. Extend the structured worker message into explicit variants: a final report, an input-required request, or an explicit terminal blocker. The actual schema and marker are owned once and changed with producer/parser/fixtures together. Preserve old report bytes as historical evidence.

Do not classify free text by punctuation, a keyword such as “done,” or another LLM judge. A native successful turn with an invalid/ambiguous assignment report does not prove completion; retain the session and expose `needs_attention` or a supported explicit clarification path. It must be possible for the owner to supply input or cancel; no unbounded automatic reprompt/repair loop is introduced.

The `WorkerAdapter.run()` promise can continue to own a whole assignment while its internal native session spans multiple user turns. Add typed lifecycle evidence and input callbacks; do not expose vendor session objects to the coordinator or create a general plugin workflow engine. An exact user reply may start the supported next native turn; this is protocol continuation, not autonomous task replanning.

### D10. Unknown is not crashed

A quiet stream, low CPU use, elapsed duration, failed health probe, missed heartbeat, or lost connection never establishes crash or completion. Report last known observation and uncertainty without applying a task-killing watchdog.

Observe real child `exit`/signal/error events separately from stream `close`: descendants may keep stdout open after the runtime dies. Conversely, a broken protocol stream can occur while a process remains alive. Record those distinct facts. Corrupted protocol, unexpected native exit, and actual provider terminal error follow their owned failure/containment contracts, not a generic timeout conversion.

If a true failure requires retiring a per-task runtime, its explicit failure/stop policy authorizes bounded cleanup. A still-running/uncertain descendant remains unconfirmed and protected. Do not return “all stopped” because the parent, SDK promise, or output stream ended.

### D11. Cancellation and race semantics

`passeur_cancel` persists an operation-keyed stop intent for the identified task/control generation. Cancellation acknowledgment means the intent is accepted. A task is stopped only when subsequent evidence proves it; after an incomplete stop it remains stopping/needs attention with retained resources and containment.

The coordinator serializes acceptance of native terminal evidence and explicit cancellation. Completion accepted before a cancellation remains completed and the cancel receipt says already terminal. A cancellation accepted before successful settlement cannot be overwritten by a late native success; retain that success as evidence/partial deliverable while classifying the task under its cancel contract. Real failure concurrent with stop remains observable, not erased by a generic cancelled label.

A missing caller never supplies cancellation intent. Host cancellation of an observation or elicitation request cancels that request only. The usage skill must make explicit task cancellation discoverable so a user's Stop expectation is not silently lost.

### D12. Time and capacity policy

Remove all task-deadline creation and TASK_TIMEOUT-triggered worker aborts from new execution. Remove queue age cancellation, approval timer cancellation, and inherited time limits in task-owned Git/helper/native operations. `task_timeout_ms` and `deadline_at` remain readable only in historical versioned data; never turn them into an enormous duration, reset-on-progress timeout, “optional default,” or hidden alternate deadline.

Audit the complete affected path: profiles/snapshots, coordinator timers, approval queue, adapters/native RPC defaults, `RepositoryRuntime` preparation, Git helper including hooks, front-end/IPC cancellation, host registration timeout, probes, and installed scripts. Separate read-only diagnostic budgets from native side-effect ownership. A timed-out mutating native exchange produces unknown-outcome reconciliation; it is not safe to discard its promise and repeat it.

Allowed time budgets belong to observations, client waits, safe pre-admission diagnostics, connection establishment, or an already-authorized stop attempt. Their expiry reports a specific observation/control outcome. After acceptance, a service-owned startup/preparation operation is observed until it settles or receives valid stop/failure authority; it is not orphaned because the submitting request ended.

Keep finite, configurable repository-wide worker, queue, accepted-task, client, waiter and outstanding-input limits, and bounded IPC/result sizes. Waiting tasks count against their owned resources; quiet work does not free a worker slot. Reject excess admission before publishing a task. Existing counts may be retained as defaults, not hard-coded eight-task architecture ceilings for the new interface. Do not add provider-specific or cross-repository scheduling here.

A slow/disconnected observer must not stall native execution or grow memory indefinitely. Separate durable control transitions from optional telemetry. Coalesce/drop bounded nonessential progress with an omission indicator; recover from current state. Never silently drop an approval, terminal outcome, cancellation intent, or ownership transition. A genuine failure to preserve authoritative evidence blocks unsafe new mutation; it is not presented as success.

## 7. Persistence, crash handling and service shutdown

### D13. Extend the existing store, not a second task database

Keep immutable admitted request/execution identity, immutable terminal results, and separate mutable resource disposition. Introduce versioned task-control/input state with a monotonic task revision and idempotent operation receipts through the existing store/atomic-publication owner. A small task-owned control record may consolidate phase, input and cancel invariants that must change together. Do not create a competing event-sourced system for ordinary logs.

Before native startup publish run intent and generation. Before side-effecting native submission retain the relevant native identifiers whenever the protocol can supply them. Publish terminal result before projecting terminal state; recover interrupted publication through the declared supported versions. Fully decode inbound and outbound IPC/MCP/persisted variants and cross-field identity/generation relations. Reuse existing record codecs and schema authority.

There is an unavoidable possible crash between external effect and receipt publication. Record it as uncertain and reconcile; a generation token in Passeur's store does not fence an already-running native agent. Do not claim transparent failover, process-tree fencing, or exactly-once model execution.

### D14. Recovery depends on evidence, not the clock

Client loss leaves service-owned tasks unchanged except for attached observers and input-delivery claims. Service loss is different. A replacement must establish service/repository authority and classify each unfinished task before scheduling replacements.

Known terminal result: reopen immutable evidence. Known never-started accepted work: preserve it and require the explicit supported queue-recovery action selected by the operator; do not silently discard it. Submitted/possibly-started work: reconnect only through a verified native resumability contract without repeating submission, otherwise retain interruption/uncertainty and require reconciliation. Lost native process identity or a remaining descendant blocks stable delivery/retirement.

Persist `boot identity + process start identity + PID` or the qualified platform equivalent for observations; never signal a reused PID based on a stale integer. The service generation correlates messages, not permission to kill a process. Discovery metadata cannot substitute for store recovery or native proof.

The service may freeze new repository mutations when worker stop or terminal publication is uncertain; healthy known siblings can finish saving their evidence. Preserve separate outcomes for permission failure, unavailable dependencies, unsupported versions, invalid state, and genuinely interrupted publication. Clock-only deletion/rebuild of authority, lock-directory removal, or inference replay is not a recovery strategy. A replacement may reconcile one exact compatibility lease only when a protected versioned owner record matches that lock instance and a qualified process-birth observation proves the recorded owner exited; missing, malformed, mismatched, legacy, or still-live evidence requires explicit reconciliation and blocks new mutation.

### D15. Shutdown decisions

Front-end EOF/SIGINT/SIGTERM closes that front end and its connections only. Service SIGTERM and explicit operator stop are service-control events, not proxy events; handle them through one observed shutdown path. Service launch uses independent standard streams and a process lifetime that the host cannot accidentally own through its child pipes. Qualify this against actual Codex shutdown behavior, including parent group termination.

Normal operator `service stop` closes admission and drains existing tasks without a work deadline. A separate explicit `cancel-tasks` choice names the affected tasks, persists their stop intents and begins cancellation. Bound only each already-authorized stop attempt. On incomplete drain report the exact outstanding obligations; do not free ownership and report clean shutdown while unsafe work is merely forgotten.

Automatic service exit is permitted only from an atomically checked empty state: no clients or launch/attach reservations, unfinished tasks, active native sessions/descendants, input obligations, admissions, Git/resource mutations, or pending authoritative writes. No idle-work timer is required in the initial design. A connect racing empty shutdown either attaches before admission closes or retries a new service with the same task keys; it cannot submit into a disappearing unrecorded owner.

Explicit shutdown from a frozen state can retain durable reconciliation evidence and stop the service, but a subsequent service still refuses unsafe execution. Release the existing lease only under its owner contract, then close the process-lifetime guard by ending the service. A shutdown deadline does not confer deletion, force-kill, or unique-commit disposal authority.

## 8. Native adapters and skills

Muse and Codex must each qualify: native turn/assignment termination; pending approvals and ordinary questions; tool/process start/finish or documented settlement; session continuation after a reply; stream loss; native exit; explicit cancel; stop uncertainty; and operation during absence of a front end. Document native protocol/version limits separately from the common contract.

Codex currently consumes only completed items and turns for the relevant path. Add the documented start/input/withdrawal/terminal observations actually needed, validated against the selected installed protocol. Its native `serverRequest/resolved` is not automatically evidence that a particular human answer was accepted: the native contract can also clear requests on turn lifecycle changes. Preserve that distinction. Native auto-resolution hints never authorize a default approval.

Muse's SDK promise and approval callback likewise need qualification for long waits and continuation. Do not assume undocumented events, session durability, SDK-internal timeouts, or descendant guarantees. Missing evidence blocks only the affected advertised support claim and its release; independent deterministic work can continue. Do not replace the named provider with a different one silently.

Update `.agents/skills/passeur-agent-adapter/` and `.agents/skills/passeur-bridge/` as part of the implementation. The first teaches adapters to implement native evidence and continuation without timers or a second task engine. The second teaches submit/wait/input/cancel, reconnection, exact source-view identity and external integration. Historical Muse entrypoints link to the current migration route. Detailed requirements are in the skill report. A fresh session must use the revised authoring skill for the second adapter; structural checks alone do not prove usability.

## 9. Compatibility, rollout and rollback

Treat the change as an intentional lifecycle-breaking release. Do not call it configuration-only or silently reuse old schemas with changed cancellation/response meaning.

| Surface | Selected evolution |
| --- | --- |
| Task submission/wait/control | New separately versioned tool envelopes; reuse unchanged assignment schema only for its unchanged fields |
| Legacy `passeur_delegate*` / `delegate_to_muse*` | Remain discoverable migration entrypoints that reject **new execution** with `TASK_API_UPGRADE_REQUIRED` and no side effects; point to submit/wait/cancel. Do not execute old timer semantics in the new service or return a receipt as an old terminal result |
| Existing result retrieval | Preserve supported historical source representations; new result/observation formats are explicitly versioned |
| Result and task-control records | New versions for lifecycle, owner, native generation/input and stop-intent semantics; never add such fields to strict v3 outputs without a new result contract |
| Profiles | Explicit profile v3 migration from supported v1/v2: remove task deadline, add service/observation/resource policy, preserve adapter/permission settings; write exact backup and atomic validated replacement |
| Execution snapshots | New version for changed policy; historical snapshots keep their original meaning and bytes |
| Runtime status | Explicit version for separate front-end build/connection and service build/generation/coordination; do not masquerade a front-end build as the running service |
| Private IPC | Version 1 handshake; accept only an implemented/tested compatibility range; mismatch is diagnostic, never permission to kill or replace a live service |
| Named host registration | Preserve server names, project/profile/state bindings, required/optional policy, human approval/denial settings, explicit adoption/replacement and exact installed entrypoint behavior |

Legacy history can be read before profile migration; a new submit with an old unmigrated execution profile returns the migration prerequisite. Old historical keys remain version-aware; ambiguous reuse points to history and does not re-execute. Source worktrees, refs and cleanup receipts retain their protection rules.

Before cutover, inventory the actual installed front ends, active service/legacy processes, task states, state/config paths and build identities. Install a complete candidate without overwriting the running runtime. Close old connection-owned runtimes normally after accounting for tasks. Under explicit migration authority, validate/backup profile and durable formats, then update **existing** named registrations to the new installed front end. Never solve conflict by a second state root or duplicate registration.

New front ends attach to the already running service only if protocol, repository/state and configuration are compatible. An incompatible service remains alive; report its identity and the required controlled upgrade. The new front end may not automatically kill old work to start its own build. All new mutation/maintenance paths obey the election guard, and rolling legacy binaries are not a supported concurrent writer after cutover.

Rollback is not merely restoring a profile backup. Once new durable records exist, an old binary cannot mutate them safely. Stop/drain under the current capable reader, retain records/refs, and select a compatible version or a separately verified downgrade. Never delete task records or worktrees to make old code start.

## 10. Milestones and exact write ownership

Every milestone begins `Planned`. Each is a coherent integration unit, not a fixed commit. One lead owns shared files and contract versions. Proposed new paths below become exact write authority after M0 verifies current placement; a directly affected additional file is recorded, with re-planning only when ownership, contract, scope, risk or evidence changes.

### M0 / M0-S1 — Admission and bounded evidence

**Current lifecycle:** `Implemented` — source candidate only; no objective acceptance. Native/pinned gates remain blocked as mapped in the evidence report.

**Goal:** make this design implementable against actual native, deployment and consumer facts.

**Write set:** `AGENTS.md`; this plan directory; the authority/status sections of `docs/plans/registered-agents/plan.md` and `docs/plans/discoverable-startup-and-installed-runtime/plan.md`, and the ledger/issues they own only where reconciling affected decisions. Other production code is read-only.

Inspect actual source/status, retained contract versions, installed build and host behavior. Capture a non-destructive reproduction of session end versus process/lease state. Verify current Muse/Codex input/settlement/continuation mechanisms, MCP request-associated elicitation, host Stop/wait behavior, and the Linux election-guard/file-descriptor mechanism. Use disposable processes/repositories; live credentials and global configuration changes require separate operator authority.

Record a finite consumer/timer/authority inventory, including the hidden Git helper deadline. Route standards and document the protocol/binding/source-view decisions. Qualify the socket path/filesystem and system dependency. Complete the actual supported-version and native capability matrix.

**Gate:** no unresolved ownership/migration contradiction; exact M1 write set and selected native contract are available. Missing live credentials may block acceptance evidence but do not require another speculative design cycle. Missing necessary native continuation/enforcement requires a bounded decision before advertising that mode.

**Re-plan:** incompatible installed protocol; inability to keep human permission distinct; required lock/IPC primitive unavailable; unrelated dirty changes overlap; user changes lifetime/ownership semantics.

### M1 / M1-S1 — One complete shared-service Muse path

**Current lifecycle:** `Implemented` — source candidate only; no objective acceptance. Native/pinned gates remain blocked as mapped in the evidence report.

**Goal:** two clients can submit, wait, detach, reattach with authority, answer input, and obtain a Muse task's delivery through one service with no task-killing deadline.

**New production write set:** `src/service/bootstrap.ts`, `src/service/server.ts`, `src/service/client.ts`, `src/service/transport.ts`, `src/service/process.ts`, `src/contracts/service.ts`, `src/contracts/tasks.ts`, `src/core/task-control.ts`, `src/core/input-broker.ts`.

**Existing production write set:** `src/cli.ts`, `passeur`; `src/mcp/server.ts`; `src/core/repository-runtime.ts`, `src/core/coordinator.ts`, `src/core/lease.ts`, `src/core/state.ts`, `src/core/async.ts`, `src/core/prior-task.ts`, `src/core/recovery.ts`, `src/core/result.ts`, `src/core/profile.ts`, `src/core/profile-edit.ts`; `src/core/disposition.ts`, `src/core/cleanup.ts` only for service/control and record-consumer changes; `src/contracts/index.ts`, `src/contracts/types.ts`, `src/contracts/agents.ts`, `src/contracts/runtime.ts`; `src/store/task-store.ts`, `src/store/record-codecs.ts`; `src/agents/types.ts`, `src/agents/registry.ts`, `src/agents/builtins.ts`, `src/agents/report.ts`, `src/agents/report-format.ts`; `src/muse/adapter.ts`, `src/muse/config.ts`; `src/approvals/native.ts`; `src/workspace/project.ts`, `src/workspace/worktree.ts`; relevant compilation inputs `tsconfig.json`, `tsconfig.core.json`, `tsconfig.native.json` only when required by changed ownership.

**Evidence write set:** new `tests/integration/shared-service.test.ts`, `tests/integration/durable-tasks.test.ts`, `tests/integration/task-input.test.ts`, `tests/native/service-election.test.mjs`, `tests/native/task-lifetime.test.mjs`, `tests/unit/task-control.test.ts`; actual affected fixtures and existing coordinator/store/runtime-owner/adapter/approval/record/MCP tests enumerated in M0. New test peers live under `tests/fixtures/shared-service/` and never become production fallback runtimes.

**Documentation/skill write set:** `docs/design.md`, new `docs/task-lifecycle.md` and `docs/shared-service.md`; `.agents/skills/passeur-agent-adapter/SKILL.md` and its existing provider-dossier/conformance references; `.agents/skills/passeur-bridge/SKILL.md`; plan evidence.

Implement the full vertical path, including durable publication, task-owned input, versioned observations, wait isolation, current native completion classification, shared capacity and safe resource evidence. Keep unqualified provider paths unavailable until upgraded; no production stub or silent old lifecycle fallback. Do not publish this intermediate candidate into the live installation before migration gates pass.

**Gate:** two real local client processes and one real service use real storage/Git and the actual changed transport. A controlled native peer proves the adapter path, input, timeout-detachment and cancellation without claiming live Muse conformance. Required authorized Muse qualification proves the named native behavior before its user-visible support is accepted. Fault cases from scenarios V1–V9 pass at their declared fidelity. Review actual locality against design admission.

**Re-plan:** state authority leaks into proxies; a timer still controls task lifetime; elected service can be duplicated after a pause; reconnect changes request identity; native session cannot represent pending input as designed.

### M2 / M2-S1 — Codex lifecycle and reusable adapter contract

**Current lifecycle:** `Implemented` — source candidate only; no objective acceptance. Native/pinned gates remain blocked as mapped in the evidence report.

**Goal:** the second existing adapter satisfies the same task contract using its own native signals, not Muse assumptions.

**Write set:** `src/agents/codex/adapter.ts`, `src/agents/codex/protocol.ts`, `src/agents/codex/transport.ts`, `src/agents/codex/config.ts`; `src/agents/builtins.ts` only for qualification wiring; `tests/unit/codex-adapter.test.ts`, existing native Codex protocol/transport tests identified in M0, new `tests/native/codex-lifecycle.test.mjs`, `tests/fixtures/codex/`; `tests/fixtures/adapter-conformance.ts`, `tests/unit/adapter-conformance.test.ts`, `tests/unit/adapter-skill.test.ts`; `docs/agents/codex.md`, `docs/agent-adapters.md`; existing skill references and plan reports. The lead alone changes `package.json`/`package-lock.json` if a verified native-contract dependency change is necessary.

A fresh skill-aware session implements or independently completes the adapter using the M1 skill. Cover native operation starts/completions, pending input/withdrawal, genuine termination, multi-turn clarification, explicit cancellation and unknown stream/process state. Retain command/sandbox/auth restrictions and worker recursion isolation. Do not expand into unsupported review mode.

**Gate:** real adapter through independently specified controlled peers passes conformance; named live Codex scenarios pass or remain visibly blocked. Mixed Muse/Codex work shares the same coordinator without provider-specific state logic. The fresh-session skill report records actual decisions and limitations.

**Re-plan:** the common contract requires a vendor switch; experimental/native version facts contradict the selected controls; proposed fallback broadens auth/permissions or turns silence into lifecycle proof.

### M3 / M3-S1 — Explicit migration and installed caller integration

**Current lifecycle:** `Implemented` — source candidate only; no objective acceptance. Native/pinned gates remain blocked as mapped in the evidence report.

**Goal:** an operator can move the existing Pumas/Tuldok-style named registrations to the new lifetime model without losing data, settings or active work.

**Write set:** `src/cli.ts`, `passeur`, existing profile-edit/record migration owners from M1; `src/install/runtime.ts`, `scripts/build-runtime.ts`; `src/codex/config.ts`, `src/codex/probe.ts`, `src/codex/startup-policy.ts`; `src/diagnostics/doctor.ts`; `scripts/probe-installed.ts`, `scripts/probe-agents.ts`, `scripts/probe-parallel.ts`, `scripts/probe-wait.ts`, `scripts/probe-muse.ts`; new `scripts/probe-service.ts`; `package.json` and lockfile under the lead only when necessary. Tests: existing installation/registration/startup tests, new `tests/integration/lifecycle-migration.test.ts`, `tests/integration/service-installation.test.ts`, versioned fixtures under `tests/fixtures/shared-service/`. Docs: `README.md`, `docs/startup-and-installation.md`, `docs/installed-acceptance.md`, `docs/setup.md`, `docs/recovery.md`, `docs/registered-agents.md`, `docs/compatibility.md`; current usage/setup and legacy Muse skill references; plan evidence.

Implement profile/store/tool version handling, new CLI controls/help, exact build identities for both front end and service, and service-aware non-inference registration probes. Preserve required/optional policy and human-approval settings. A probe may observe the catalog/status; it does not claim host tool exposure, submit inference, or stop another session. Validate migration interruption and data-aware rollback refusal.

**Gate:** installed artifact operates without source checkout; two front ends share its service; incompatible builds/configurations report explicit conflicts; old history reads and new writes use the correct codecs; legacy execution entrypoints reject before side effects; affected examples execute against the candidate. Real user registration edits remain opt-in.

**Re-plan:** migration relies on old binaries honoring an unknown marker, dropping task identity, rewriting terminal evidence, preserving unsafe dual execution, or overwriting a newer personal config edit.

### M4 / M4-S1 — Objective acceptance and external review

**Current lifecycle:** `Verifying` — source candidate only; no objective acceptance. Native/pinned gates remain blocked as mapped in the evidence report.

**Goal:** prove the actual multi-session, long-horizon workflow and close mandatory findings.

**Write set:** scenario tests/probes already admitted; final reports under this plan; `docs/compatibility.md`, applicable support/runbook/skill corrections; plan/ledger/issues. Source defects return to the owning slice. A new CI/workflow file needs an explicit named claim/trigger before admission.

Run the pinned repository commands and installed real-client scenarios. Demonstrate long silent execution, native subprocess/hook waits, pending human input beyond previous limits, host request timeout, all clients absent, reconnect/adoption, simultaneous starts, paused service, explicit stop, genuine native crash and service crash. Verify retained exact Git OIDs, refusal of unsafe cleanup and usable recovery. Qualify only tested platforms/providers.

Use independent external review once the completed verification unit/candidate is ready for its final PR/integration boundary, not per commit or per worker. Review specifically the IPC trust, election/lease ordering, timers/cancellation, native evidence, idempotency/publication races, migration and skill usability. Bind findings to the material candidate; changed semantics require affected re-review, mere evidence recording does not.

**Gate:** every required claim below satisfied, findings dispositioned, admitted mandatory violations closed or explicitly qualified by an authorized exception, created resources accounted for. Only then `Accepted` and next slice `none`. When source is implemented but real evidence is unavailable, use `Implemented`/`Verifying` with blocked claims; never turn simulations into acceptance.

## Source candidate verification index

The implementation source, tests and documentation are present; [actual evidence](reports/implementation-evidence.md) and [admission/write-set reconciliation](reports/admission.md) identify what ran. M0–M3 source state does not mean their real gates passed. Muse native in-turn input coverage and exact pinned SDK observations remain an explicit SS-05/06 qualification blocker and may require an owning adapter revision before acceptance. Full pinned checks, actual service/store/host paths, fresh skill use and external review were not available here.

## 11. Objective acceptance claims

All claims begin pending. Each evidence record identifies revision/build, inputs, expected/observed effects, native/OS/dependency versions, execution owner, command/procedure and limitations. The detailed scenario map is in the verification report.

| ID | Observable criterion | Kind | Environment | Mode | Status | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| SS-01 | Two clients, including different linked worktrees, share exactly one repository service/coordinator; no competing owner appears during simultaneous start or a live-owner pause | system | representative Linux/local filesystem, real processes | automated | blocked | V1–V3 |
| SS-02 | Closing or timing out any client/request never cancels accepted work or another client's tasks; last-client loss does not end working/waiting tasks | system + contract | representative actual IPC/processes; controlled native work | automated | blocked | V4–V5 |
| SS-03 | Durably accepted requests retain exact identity across lost acknowledgments, retries and reconnects; conflicting intent/control cannot attach or execute | contract + integration | representative real store/reopening | automated | blocked | V6 |
| SS-04 | No task-killing timer exists across queue, startup, execution, approval or task-owned Git/hook paths; elapsed clocks cannot change execution outcome | focused + system | simulated clocks plus representative subprocesses and native qualification | either | blocked | V4,V7,V8,V13 |
| SS-05 | Completed, input-required, tool/dependency waiting, terminal failure and unknown liveness are distinguished using native authority; a completed turn/question is not final delivery | contract + system | controlled peers plus required-real Muse/Codex versions | either | blocked | V7–V10,V13 |
| SS-06 | Permission needs a correlated human decision; timeout/dismissal is not denial/consent; stale answers and cross-session control fail safely | contract + user-workflow | required-real host elicitation, representative broker/storage | either | blocked | V8–V9,V13 |
| SS-07 | Explicit cancel, completion and input races produce truthful durable outcomes; no shutdown acknowledgment is mistaken for descendant stop | integration + system | representative processes and required-real runtimes | either | blocked | V9–V11 |
| SS-08 | Crash/lease loss/restart never blindly replays inference or retires uncertain work; surviving descendants, unknown publication and PID reuse are handled safely | system + persistence contract | representative real processes/filesystem and injected publication failures | automated | blocked | V10–V11 |
| SS-09 | Supported old data is preserved, explicit migration publishes valid new states, incompatible clients/binaries fail visibly, and rollback does not destroy authority | contract + integration | representative historical fixtures and real store | automated | blocked | V12 |
| SS-10 | Source view, task Git bases, delivery observation and final resource protection remain correct under mixed clients and adapters | integration + system | representative real Git; required-real agent workflow | either | blocked | V6,V11,V13 |
| SS-11 | Front-end discovery survives service/profile/provider failure; named installed registrations preserve startup/approval policy and operate without development output | release-artifact + user-workflow | representative installed artifact; required-real Codex host | either | blocked | V12–V13 |
| SS-12 | Full pinned checks pass; standards-required boundary evidence and resource bounds are not bypassed; slow observers cannot exhaust memory or lose control authority | supporting static + integration | representative pinned toolchain/processes | automated | blocked | V14 |
| SS-13 | Revised usage and adapter skills validate and a fresh session applies the authoring skill successfully without hidden context or timer heuristics | contract + user-workflow | required-real fresh skill-aware session | either | blocked | V15 |
| SS-14 | Independent review, changed-claim reverification, final PR/integration authority and plan-created resource dispositions are recorded | review + affected claim kinds | required-real material candidate/review | either | blocked | V16 |

A compound claim is satisfied only when every required part has its named evidence. Fake clocks prove selected timing logic, not a native provider's long-horizon behavior. An independent process probe proves process effects, not billing or human intent. None of these gates claims that a worker's delivered code is correct beyond its own task/repository acceptance.

## 12. Governance, stopping rules and final acceptance

Use an objective branch such as `feat/shared-service-lifecycle` targeting `main`, with the lead as integration owner. This isolation is justified by live-runtime, storage, permission and lifecycle migration risk. Do not push, change user configuration, use accounts, delete worktrees or rewrite history merely because the plan exists. Worker branches are optional when they supply actual conflict isolation; shared contracts remain serial.

M1 is serial. After its common contracts stabilize, native adapter work and bounded nonoverlapping documentation/test work can proceed with explicit primary/adjacent/forbidden paths, output/evidence contracts and serial integration order. A worker reports a needed shared-contract change instead of inventing one. Product concurrency is not permission for uncontrolled concurrent implementation edits.

Record exact path/head/disposition for task-created implementation and test worktrees. Before removal, prove protection by a retained or verified archive ref and check the protected OID set afterward. No global prune, force removal, disposal of unique commits, hook bypass or unrequested history rewrite.

Investigate only material decision-changing uncertainty: native continuation/settlement, real host input/Stop behavior, lock inheritance/election, durable publication/recovery, or installed data compatibility. Each investigation has its decision, consequence, cheapest adequate method and observable stop. Implementation of the admitted reversible design is the default after those facts suffice. Do not create a new standards engine, sandbox, database, protocol generator or broad fuzz framework without a separate marginal-value/ownership decision.

Re-plan when current source/standards or actual consumers materially invalidate scope; a required native control is absent; the exact ownership/safety guarantee is unsupported; one local fix reveals a systemic authority family; a lower-fidelity oracle is being substituted; or representative changes spread vendor/service knowledge outside the admitted owners. Update the current decision, affected write sets/gates and design admission; retain superseded reasoning in the ledger, not beside an active contradiction.

Initial blockers: no global implementation blocker is asserted from this planning-only review. Real native/runtime/host, filesystem and account evidence are prerequisites to their acceptance claims. M0 must not invent missing native facts; mark a particular decision/claim blocked if its required mechanism cannot be established.

Final acceptance requires all non-deferred milestones accepted or explicitly superseded, all required claims satisfied, mandatory affected-boundary findings closed, support limitations accurate, installed consumer migration proven, independent review dispositioned, and every plan-created resource accounted for. Then compact this plan into a decision/evidence index, linking durable contracts in `docs/task-lifecycle.md`, service ownership in `docs/shared-service.md`/`docs/design.md`, and existing operational runbooks. No universal or future compliance certification is implied.
