---
name: passeur-agent-adapter
description: Configure a registered agent or implement and qualify a Passeur runtime adapter, including native lifecycle evidence, explicit input and same-session continuation, task-owned cancellation, and safe shutdown.
---

# Passeur agent adapter

Read AGENTS.md and the adopted Coding-Standards Core/Router. Written-plan implementation requires the explicit canonical plan path and operation; use that plan's current owner, write set and evidence. This skill does not authorize installation, personal configuration changes, accounts, publication, destructive cleanup or bypassing hooks.

Read [provider dossier](references/provider-dossier.md) and [conformance](references/conformance.md). Classify the request as configuration-only registration, a new adapter, or a shared-contract change. Another model behind an existing adapter is configuration, not a reason to duplicate runtime code.

## Owners and native facts

Use the current [adapter contract](../../../docs/agent-adapters.md), [task lifecycle](../../../docs/task-lifecycle.md) and [shared service](../../../docs/shared-service.md). RepositoryRuntime owns preparation/lease/composition; Coordinator and TaskControls own accepted execution/control. The input broker owns pending identity and answer intent; the front end owns human presentation. Adapters do not create another scheduler, task database or repository lease.

Verify the actual version-matched native SDK/protocol, flags, model reporting, credential route, permissions, turn/item/input observations, withdrawal, continuation and stop behavior. Types or a sample success are not runtime proof. Missing native facts block the relevant promise, not independent reversible implementation. Bound investigations to a decision and observable stopping condition.

Factory configuration is side-effect free. Optional SDK/process/authentication access belongs in execution, never MCP discovery. Keep provider semantics local and register once in builtins. Preserve the exact installed service dependency closure; frontend/server/agent/build identities are not interchangeable.

## One whole-assignment run

Own startup before awaiting it. The service task signal represents explicit stop or actual safety/failure authority, never frontend lifetime. No task/queue/approval/inactivity timer may kill work. Timers can bound observation or already-authorized cleanup only. Observe parent exit independently of pipe close and surviving descendants; a stale PID is not authority to signal.

Emit authoritative correlated turn and known operation start/finish evidence. A successful native terminal notification cannot settle pending tools or input. Do not infer empty obligations when coverage is absent. Keep unknown observations explicit. Quiescence/shutdown and successful code acceptance are distinct.

Produce/consume the canonical version2 PASSEUR_MESSAGE variants. A native question after a completed turn keeps the assignment alive and requests explicit input. An exact reply continues the same session/thread; invalid final output exposes needs-attention rather than an autonomous repair prompt. The input callback accepts a native-scope AbortSignal: genuine native failure withdraws that invocation without leaving a waiter attached to the service indefinitely.

Keep permission and clarification separate. Present permission through the actual host-associated human channel; no model-issued approve field. Validate native IDs, run/turn/control generation, exact operation and offered once/deny choices. Timeout/dismissal is not denial. Native withdrawal is not answer acknowledgment. Persist answer intent before dispatch and retain delivery unknown until authoritative settlement. Do not blindly resend an ambiguous side effect.

Use structured arguments, approved environment/credentials and native controls. Preserve ordinary Git hooks, signing, instructions and recursion isolation. No provider/model/API-key/permission fallback. A runtime unable to enforce no shell and no writes cannot advertise restrictive review.

## Verify and hand off

Test actual adapter behavior with independent controlled peers, and separately qualify installed SDK/native permissions, long waits, session continuation, caller absence, actual crash and descendant stop. Include silence, outstanding background items, host death while awaiting input, stale human replies and explicit cancellation. Expected results come from canonical contracts, not copied producer output.

Reuse the existing test/compiler/store machinery; add only a focused helper with deciding value. A new adapter should normally change its module, configuration, tests, dossier, dependency record and one composition entry. Unexplained core changes require a shared-contract decision.

Update both skills when public behavior changes. Structural validation is not fresh-session usability evidence. Report exact tested versions, candidate paths, commands/results, unexecuted claims and remaining support restrictions. Never claim live qualification or whole-codebase compliance from substitutes or build success.
