# Composed-design admission

Applicability: **applicable**. This introduces a process boundary, durable task-control semantics, a native-input continuation contract, and installed-client compatibility. This admission now indexes the implemented candidate and its remaining qualification limits. M1/M3 must compare the actual code with these predictions; it is not acceptance evidence for unseen source.

The plan owns the current decisions. This report supplies the eight Architecture probes. On implementation, durable service/task decisions move to the named canonical contract documents; retain links rather than copying current policy into several owners.

## 1. Independent concerns: what, who, how, when, where, why

| Concern | What/who | How/when/where/why |
| --- | --- | --- |
| Front-end connection | A client channel owns MCP capability, request association and human presentation | One stdio process per caller; begins/ends with that connection, without ownership of native execution |
| Service discovery/election | Installed service boundary owns a repository-local endpoint and incarnation | Protected Unix socket, process-lifetime guard and handshake; allows attachment without a second scheduler |
| Repository authority | RepositoryRuntime owns canonical binding, lease, lazy preparation, registry and administration | One namespace and preparation lifecycle per service, independent of any client conversation |
| Task execution/control | Coordinator owns admission, stable identity, capacity, state and stop decision | Durable records plus serialized transitions; remains alive through waits and detachments |
| Input broker | Task-control owner retains pending input and answer intent; front end presents it; adapter translates it | Human presence and native session validity have independent lifetimes, requiring correlated delivery and replay protection |
| Native protocol | Each adapter owns provider-specific state, evidence, continuation and cleanup | Session/turn/tool observations remain inside adapters; common task decisions consume normalized facts |
| Storage and recovery | Existing store owns supported decoding, atomic publication and reopening | Data outlives requests and processes; unknown effect outcomes stay explicit |
| Git delivery/disposition | Existing workspace/disposition owners retain exact commits and safely retire resources | Native completion cannot replace Git facts; no integration/acceptance engine is introduced |
| Installation and registration | Existing installed-artifact and Codex configuration owners bind exact runtimes and policy | New client/service compatibility must not change personal settings or running code implicitly |
| Contributor guidance | Repository skills guide use and extension | Guidance links canonical contracts; it does not execute security checks or own runtime policy |

## 2. Necessary and accidental interleavings

Necessary: a task's assignment, source view, selected adapter/configuration, native generation, input, stop intent, terminal evidence and resources share correlated identity. Answer-versus-cancel and complete-versus-cancel decisions share serialized transition authority. Admission publication and request-key uniqueness share one store owner. Git-resource retirement consumes truthful stop and protection facts.

Accidental and removed: request timeout as execution deadline; client EOF as task cancellation; a single mutable client-approval field on a shared runtime; provider startup before tool discovery; first client's worktree silently becoming all review input; heartbeat expiry becoming process-death proof; adapter logging queues deciding whether work has completed.

Time remains necessary for timestamps, observation budgets, native protocol validity and already-authorized shutdown escalation. It is not task termination authority. A pending operation can be old and still valid.

### Authority scope

The profile packages independently owned execution, observation/service configuration and adapter registrations; it does not make the registry own scheduling or native permissions. A descriptor references a build/configuration but does not grant repository authority. A client credential grants its explicit operation scope but does not become task content identity. A task result records an outcome but does not authorize integration or cleanup on its own.

### Version scope

Private IPC, public submit/wait/control envelopes, task-control storage, result representation, profile policy, execution snapshots and runtime status have separate change reasons. They are not bumped in lockstep merely because one product release contains them. Reuse the existing assignment schema only for unchanged semantics, and version the surrounding source-view/submission contract.

No mixed live execution across old connection-owned and new service-owned runtimes is promised. Supported historical reads are independent of that live compatibility decision.

## 3. Knowledge required of callers and composition

The model knows agent IDs, assignments, request keys, task IDs/observations, explicit input/cancel operations, and integration responsibility. It does not know socket paths, service PIDs, heartbeat intervals, vendor RPC IDs, auth secrets, or the ordering of preparation and native startup.

The front end knows its approved binding, IPC compatibility, its own connection grants, and MCP human presentation. It does not recreate task state or infer which process should be killed.

The coordinator knows validated assignment/source-view values, immutable selected execution identity, common lifecycle facts, pending obligations and explicit control. It does not know Muse/Codex events or flags.

The service composition root knows the installed binary, binding and interface owners, and constructs a single RepositoryRuntime. Adapters alone know their SDK/version, native session and permission/continuation details.

## 4. Representative change paths

| Representative change | Owners that must change | Owners that should not change merely for it |
| --- | --- | --- |
| Add another configured Muse model | Operator profile and validation/qualification data | Service, scheduler, state machine |
| Add a new native coding runtime | Adapter/config, one builtins entry, native tests/dossier and actual support matrix | Git/resource owner and service election |
| Update native approval protocol | That adapter and its native fixtures/qualification | Client ownership and common task state unless the shared meaning changes |
| Change wait presentation budget | Front-end/observation policy and request-level tests | Native task signal, task deadline (none), Git helpers |
| Add another concurrent caller | Connection actor and validated attachment | Number of coordinators and repository-wide capacity policy |
| Add another supported OS | Qualified service election/transport and process adapter/installation | Assignment semantics; no automatic port fallback |
| Change Git retirement guarantee | Git/disposition authority and record consumers | Provider heuristics or client conversation identity |
| Add native MCP Tasks projection later | Capability/protocol adapter with explicit mapping | Task database and native execution owner |
| Change profile while service is running | Explicit controlled configuration cutover | Existing task snapshots and currently accepted request identity |

An observed need to change multiple unrelated owners for one adapter or wait tweak is evidence against this admission, not permission to add more forwarding layers.

## 5. Stable interfaces and hidden knowledge

Stable interfaces carry validated operations, correlated task identity, immutable selected configuration, normalized lifecycle evidence, input promises and explicit stop intent. They hide election, native initiation/continuation, and request-to-human presentation details while retaining material uncertainty and failure information.

No interface promises that a process is dead because a lease expired, that a worker completed because its stream is silent, or that a cancel reply means the operating system killed descendants. These would conceal obligations rather than simplify them.

## 6. Independent evolution, verification, failure and replacement

Native mappings can be verified against their protocol and controlled peers independently of the service. Service startup/election needs real processes and the actual filesystem/guard primitive. Durable records need real read/write/reopening tests. MCP presentation needs the actual host for human input and Stop behavior. Their evidence is complementary, not interchangeable.

An unavailable provider cannot hide all tools. A failed client cannot stop another client's work. A slow observer loses its observation connection or receives a bounded gap without deciding task outcome. An ordinary native failure is task-local. Shared mutation authority loss, unknown descendants or missing terminal persistence may freeze new repository mutation; this wider containment reflects a real shared Git/state invariant.

A service process is replaceable only after the lifecycle contract establishes absence/quiescence or explicit interrupted recovery. Replacing it is not a way to resolve a temporarily unresponsive healthy worker.

## 7. Deletion tests

| Retained mechanism | What happens if removed | Decision |
| --- | --- | --- |
| Shared repository service | Connection-owned coordinators contend again; disconnected clients cannot leave owned work running | Keep: directly required by concurrent sessions |
| Thin stdio front end | Existing Codex stdio registration path is lost or ownership/protocol adaptation leaks into clients | Keep: deployment continuity and client-specific input |
| Process-lifetime election guard | Paused heartbeat owner can be replaced without process death proof | Keep on Linux; qualify actual inheritance/lifetime |
| Existing repository lease | Supported old/offline cooperative paths can conflict during cutover | Keep for the named compatibility population; remove only through a later explicit completed migration |
| Service descriptor/generation | Clients cannot locate/correlate the owner/build without probing arbitrary processes | Keep as a derived locator, never a second authority |
| Durable task-control/operation receipts | Lost acknowledgments or input/cancel races can duplicate native effects or change ownership | Keep in the existing store, not a new database |
| Pending-input broker | A human prompt is again tied to one tool call, or clients duplicate/reroute consent | Keep as one task-control concern |
| Native lifecycle evidence/continuation | No distinction between turn completion, task completion and input waiting | Keep inside adapters with common consumed facts |
| Wait revision/cursor and snapshot | Lost events can strand observers or force tight polling, stale prompts and ambiguous retries | Keep the smallest observation contract; no durable full-event bus |
| New public/control/profile/result versions | Old consumers silently receive changed cancellation and outcome semantics | Keep versions only at changed public/durable boundaries |
| Global daemon, distributed queue, per-task sidecar, GUI, provider router, model-based completion judge | Complexity disappears without losing the admitted objective | Do not introduce |
| Permanent custom standards/compliance verifier | Does not prove native/operational outcomes and duplicates standards process | Do not introduce |

## 8. Inherent and cumulative complexity

This design retains one new shared process boundary, a small local authenticated IPC path, a Linux lifetime-election mechanism, task-control/input records, explicit observation/control tools, and two native lifecycle mappings. It reuses installed-runtime packaging, schema tooling, the task store, coordinator capacity, Git delivery, existing historical readers and resource receipts.

Two locks exist only for distinct service-incarnation and current legacy/offline-coordination promises, with one ordered owner. That additional compatibility cost is explicit. Do not add another leader election, global registry, per-provider scheduler, task sidecar or durable event framework to conceal an unresolved primitive.

The implementation review must confirm that removing a retained mechanism redistributes required complexity, whereas excluded machinery contributes no necessary behavior. More files/tests are not simplicity evidence. If M0 discovers that the actual Linux lock/host lifetime needs a different composition, replace this admission before implementation of that owner.

## Actual artifact reconciliation

The eight probes above remain applicable. Actual owner paths are service/client, bootstrap, process and server; repository-runtime; coordinator/task-control/input-broker; existing TaskStore/record-codecs; native adapters; existing workspace/disposition; and current skill/docs owners. No second scheduler, task database, protocol router, generated schema framework or plugin ABI was introduced.

The process helper contains Linux identity/private-path/guard evidence that would otherwise be duplicated in bootstrap and recovery; deleting it would relocate required owner knowledge. report-format owns one shared worker message grammar rather than keeping prompt/parser strings independent. The private operator control token gives separate CLI invocations one explicit operator identity; actual MCP sessions retain separate credentials. Deleting that token without a replacement would break CLI retry/control and needs human adoption, so it is authoritative, not a disposable cache.

Input observation/claim/answer delivery and explicit task cancellation are separate from human presentation. A native-scope signal cleans up input waiters after actual host death without linking task life to a front end. Native pending-item snapshots use an observation interval only; no expiry grants stop authority. The service's empty-state epoch protects admission versus automatic shutdown. Kernel election and the legacy lease have distinct interoperability purposes, as admitted; the descriptor grants neither of them.

Current representative change locality matches the selected boundaries in the source. Real independent-evolution, durable schema and native behavior gates remain blocked; syntax and tests do not prove the whole artifact simple or standards-accepted. Remaining qualification is enumerated in implementation-evidence.md rather than another abstraction layer.
