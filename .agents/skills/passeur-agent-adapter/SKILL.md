---
name: passeur-agent-adapter
description: Configure a registered agent or implement, update, and qualify a Passeur runtime adapter. Use for native protocol integration, capability mapping, lifecycle handling, migration impact, and conformance evidence. Ordinary task delegation belongs to the passeur-bridge usage skill.
---

# Passeur Agent Adapter

Implement a runnable coding agent behind Passeur's existing worker interface. Start from [the provider dossier](references/provider-dossier.md) and use [the conformance reference](references/conformance.md) for the evidence relevant to the selected change.

## Establish the owned change

Read `AGENTS.md`, the adopted Coding-Standards Core and Router, `docs/agent-adapters.md`, and the relevant source owners. Written-plan work requires the explicitly supplied canonical repository-relative `plan.md` and operation (`start`, `continue` or `verify`). Consume the plan's current authority and write set; a delegated worker does not change shared plan lifecycle. Missing admission facts are a prerequisite to report, not permission to infer the newest plan.

Inspect repository state before editing. Choose the smallest coherent outcome:

- **Registration:** an installed adapter already supports this runtime and controls. Reuse it with operator-approved configuration; another model is not automatically another adapter.
- **Adapter:** materially different native protocol, controls or lifecycle require a new implementation and its decoder, tests and documentation.
- **Shared contract:** the requested capability changes assignment modes, persistence, scheduling or public guarantees. Identify the owning decision and affected consumers before expanding core behavior.

Confirm the exact write set and required evidence. Code authoring does not automatically authorize personal-configuration edits, dependency installation, native authentication, billable inference, publication or resource deletion. Keep unrelated work intact.

## Locate the existing owners

`src/core/repository-runtime.ts` owns repository binding, lazy preparation, the coordination lease, execution composition and drain. `src/core/coordinator.ts` owns admitted tasks, retries, queueing, deadlines, cancellation subscribers and terminal results. `src/agents/registry.ts` owns static approved registration resolution; `src/agents/builtins.ts` is its narrow factory composition root. `src/agents/types.ts` owns the worker interface. `src/contracts/agents.ts` and `src/store/record-codecs.ts` own the affected public/persisted representations. Git delivery and disposition remain with the workspace/disposition owners.

An adapter does not acquire the repository lease, create another scheduler, prepare the store or decide tests, repairs, integration and acceptance. Its worker performs the assigned implementation, scoped checks and ordinary commits under repository instructions.

## Establish native facts before promising support

Use official, version-matched protocol/SDK authority. Identify executable/client, authentication route, actual option names, consumed response fields, model reporting, approval correlation, terminal signals and process ownership. A successful example is not a protocol definition. Keep native types, model identifiers, billing facts and permission encodings inside the adapter.

Declare precisely which modes are implementable. Review requires no writes **and no shell**; filesystem read-only alone is insufficient. A returned configuration flag is evidence about configuration, not complete proof of installed enforcement. Parent cancellation is not descendant termination. Missing real facts block the corresponding qualification claim, not independent deterministic implementation.

For any investigation, name the uncertainty, the implementation decision it could change, consequence, least costly check and stopping condition. Once the admitted reversible design is sufficient, implement rather than growing a provider framework.

## Preserve discovery and the installed runtime

A definition's `configure(unknown)` validates local options and returns a configured worker without loading the native SDK, opening a process, discovering models or checking credentials. Load optional native code in the worker execution path. `passeur_status`, tool discovery, preparation, retained reads and administrative operations must remain usable with an unavailable provider.

Before successful execution composition, corrected profile/configuration failures may be retried. Afterwards the runtime's registry is fixed. Agent discovery exposes configuration and `runtime_readiness: not_checked`; it does not authenticate or infer. A registration may restrict capabilities, never invent stronger ones.

Keep the caller's MCP **server name**, Passeur **agent ID**, vendor **client identifier**, and installed **build identity** separate. Preserve Muse's `muse_bridge` native identifier. Register source adapters once at `builtins.ts`; preserve the existing build/install/named-registration workflow. Rebuilding source does not modify an already installed or running runtime. Verify dependency closure in the actual installed artifact, with no silent development fallback.

## Implement one owned run

Use an official client where it provides the required controls. Justify any narrow native transport against authoritative framing and schemas; do not invent flags, infer a schema from sample output, scrape a PTY or build another reasoning loop.

Own startup before awaiting initialization. Keep all mutable session, output, approval and cancellation state local to the invocation. Decode consumed native fields before they authorize work; an SDK declaration or cast is not runtime proof. Emit only bounded, non-sensitive common events. Keep worker-reported checks separate from runtime observations and requested model distinct from actual reported evidence.

Apply workspace, permission and credential policy with structured arguments and supported native controls. Preserve Git identity, hooks, signing and repository instructions. Native child configuration must prevent unintended inherited Passeur delegation; a prompt instruction alone is not proof. A dedicated CLI home is prepared/authenticated by the operator, not by silently copying the caller's credentials. No API-key, provider, model, permission or transport fallback is implicit.

Bind approvals to the active task/session/request and offered one-operation choices. Reject stale/unknown decisions, session-wide grants and unsupported escalations. The worker does not supply its own human approval. Denial or absent elicitation remains explicit.

Observe cancellation during startup, submission, output and approvals. Track completion/failure of all owned work and bounded stop. Return truthful `not_started`, `confirmed` or `unconfirmed` evidence. Interruption acknowledgement, closed output and a resolved top-level promise are not process-tree proof. Preserve uncertainty so the coordinator can freeze unsafe replacement work and retain resources.

Use the common `PASSEUR_RESULT` report contract and existing Git observer. Do not manufacture successful checks, an empty commit or a successful result from malformed output. The adapter never assigns a task branch's delivery or cleanup authority from an agent's claim alone.

## Preserve admitted identity and compatibility

The registry factory supplies only non-secret primitive configuration for snapshots. New v3 canonical request/configuration identity uses `canonicalHash`; historical request and disposition contracts retain their original hash semantics. Do not hash secrets or infer immutable executable/model behavior from a configuration digest.

Retries attach/read under the original admitted identity before current-agent prerequisites. Missing registrations must not force inference replay or block retained reads. Persisted decoding and recovery extend existing owners. Internal coordinated changes replace their consumers together; real historical/public compatibility is explicit, not an indefinite speculative shim.

## Verify and hand off

Reuse `tests/fixtures/adapter-conformance.ts` for common pre-start cancellation. Add independent native fixtures for the particular approval, framing, terminal and stop contracts. Exercise the actual adapter with controlled peers, and use real installed runtime/account evidence for native guarantees. Do not treat two fake workers, typechecking or startup-only smoke as live multi-agent acceptance.

Run affected checks, inspect the staged/material diff, and record exact versions, subject, commands, expected/observed outcomes and limits. Validate this skill's frontmatter, local references and discoverability. Fresh-session use of the skill is a separate behavioral claim; authoring or structural validation alone does not prove it.

Normally a new adapter changes its source/config decoder, tests, documentation, dependency records and one composition entry. An unexplained coordinator/workspace/disposition change is a reason to revisit the shared abstraction. Keep unavailable qualification visible and capabilities limited to the published support matrix. Finish with the changed owners, verification performed, remaining blockers, installed support status and next owned acceptance action.
