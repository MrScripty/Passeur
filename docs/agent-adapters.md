# Agent adapter contract

## Ownership

`RepositoryRuntime` owns configured repository binding, preparation, the lease, lazy composition, administrative operations and terminal drain. `Coordinator` owns task admission, retries, queue/capacity, deadlines, cancellation subscribers and terminal publication. `AgentRegistry` resolves approved immutable registrations. Workspace and disposition modules continue to observe Git and protect retained commits. An adapter owns native startup, execution, callbacks and stop evidence for one task.

Runtime-specific configuration, model catalogs, SDK types, authentication and native permission terminology belong to the adapter. The composition root `src/agents/builtins.ts` imports configuration-only definitions. A definition validates unknown options and returns a configured worker without loading its native SDK, starting a process, probing credentials, or executing callbacks in the scheduler's critical section.

## Registration and configuration

`src/contracts/agents.ts` owns profile v2, registration, assignment v3, catalog and admitted identity. Each registration names `agent_id`, `adapter_id`, `enabled`, a bounded description, optional restricted modes, and adapter-owned options. The catalog distinguishes configured, disabled, invalid, unsupported and unavailable entries. `runtime_readiness: not_checked` is deliberate: configuration is not a native qualification certificate.

Catalog pages contain at most four registrations. `offset`, `total` and `next_offset` are part of the contract. Discovery with an explicit profile is independent of repository preparation and provider startup. Before successful execution composition, corrected configuration may be reread. Afterwards that runtime's registry is fixed; editing configuration requires a controlled restart for new work. An unavailable adapter does not suppress unrelated catalog entries or retained results.

The `muse` agent ID is reserved for the actual Muse adapter because existing Muse tool entrypoints select it. Other registration IDs are independent of the caller's named MCP server entry and of vendor client identifiers. Preserve Muse's native `muse_bridge` identifier.

## Run contract

`src/agents/types.ts` defines the shared `WorkerAdapter.run(WorkerInput)` interface. It receives one validated assignment, the prepared workspace, task identity, neutral prompt, immutable execution policy, cancellation signal, human approval callback and bounded event sink. Native options are captured by the factory rather than passed through the coordinator.

A run owns every started operation through terminal observation, including initialization, native submission, asynchronous event handling, approval callbacks and shutdown. The returned promise covers bounded shutdown. `worker_stop` is `not_started`, `confirmed` or `unconfirmed`; cancellation or an interrupt acknowledgement alone does not prove stopped descendants. Shared safety containment freezes replacement starts and resource retirement when stop or persistence is uncertain. Ordinary task failure is sibling-local.

`review` means no writes **and no shell execution**. Filesystem read-only alone does not qualify that mode. `implement` uses Passeur's task worktree and ordinary Git policy. Allowed paths are assignment scope plus observed change reporting, not an OS sandbox. Neither the worktree nor the same-user coordination lease prevents arbitrary independent same-user processes from touching shared Git administration.

Each adapter implements native permission semantics without translating another vendor's terms into assumed equivalents. Approvals bind the current task/session/request to explicitly offered one-operation choices. Reject stale, unknown or persistent-choice escalation; permission failure never selects a weaker runtime or another credential.

## Identity, reports and persistence

The coordinator persists the v3 request and non-secret execution snapshot before admitting runtime effects. Configuration fingerprints use the v3 code-unit-ordered `canonicalHash`; old v1/v2 request keys and existing disposition hashes retain the historical `stableHash` contract. Configuration fingerprints describe selected configuration, not reproducible inference, immutable executable bytes, or a live billing fact.

Retries compare original request identity before consulting current registry readiness. An equivalent retry returns/attaches to the original task, including when the registration no longer exists. Different explicit agent selection conflicts. New configuration requires a new request key. Recovery never restarts inference and never obtains a historical model from current configuration.

Workers finish with `PASSEUR_RESULT` and a complete JSON report owned by `src/agents/report.ts`. Every reported check has an explicit command, cwd and nullable integer exit code. Missing or malformed reports fail; native turn failure remains failure even if the text claims success. Worker-reported checks and runtime-observed commands retain separate provenance. Native events are bounded metadata, not raw prompts, authentication output or environment dumps.

`src/store/record-codecs.ts` validates supported persisted representations and cross-record admitted identity. The existing TaskStore owns publication, reopening and immutable result bytes. MCP emits small receipts from full results, so commit/check counts are not derived from a destructively shortened copy. Full evidence remains available through bounded retained-result reads.

## Adding an adapter

Read `.agents/skills/passeur-agent-adapter/SKILL.md`. Normally change the adapter module/config decoder, one builtins entry, native contract tests, documentation and any explicitly justified dependency records. Reuse the common pre-start cancellation assertions in `tests/fixtures/adapter-conformance.ts`; add native-specific fixtures for that adapter's independently different semantics.

A new SDK dependency must remain in the installed runtime closure. Repository sources are not proof that an installed manifest includes them. Use the existing build/install/named-registration path. Never repair personal configuration, install dependencies, authenticate, use an account, or dispose of Git resources as an incidental effect of discovery or run startup.

## Current qualification

Muse retains its SDK 1.3 integration but its updated callback/model/permission behavior still requires pinned SDK and live qualification. The Codex adapter is an explicitly opted-in implementation candidate; see [Codex](agents/codex.md). Its Linux Node subprocess tests prove transport supervision against controlled peers, not native Codex sandbox, credential or plugin behavior. There is no automatic provider routing, external adapter executable ABI, new inference loop, or second scheduler.
