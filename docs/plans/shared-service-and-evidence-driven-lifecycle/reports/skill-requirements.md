# Skill revision contract

These are implementation requirements for the existing repository skills, not a parallel runtime policy and not already-installed skill changes. The plan owns their sequencing: update the authoring skill alongside the M1 common contract, then evaluate it in the fresh M2 session.

## Adapter-authoring skill

Update `.agents/skills/passeur-agent-adapter/SKILL.md`, its existing `references/provider-dossier.md` and `references/conformance.md`, and its `agents/openai.yaml` only where the discoverability text changes.

The skill must guide a fresh implementer to:

1. Read repository instructions, adopted Core/Router and the explicitly supplied canonical plan/operation. Establish a bounded registration-only, native-adapter, or shared-contract write set.
2. Identify verified native authorities for task versus turn completion, tools/subprocesses, input/permission requests, withdrawals, continuations, failure and process exit. Record unavailable coverage rather than inferring it from output frequency or CPU usage.
3. Implement one task-owned adapter run across supported native turns. Keep the session alive through input where supported, continue from the exact supplied answer, and return only a truthful assignment/stop outcome. There is no adapter-local autonomous repair loop.
4. Use the common lifecycle/input callbacks and store owner. The adapter supplies facts; it does not make another service, task scheduler, input database or acceptance engine.
5. Use native terminal status and settlement semantics; a callback named `completed`, an empty tool list or a quiet stream is not by itself a completion proof. Decode current run/turn identity and reject stale events.
6. Keep execution signal authority separate from caller presentation/wait cancellation. No task/approval/inactivity deadline is introduced, including native client defaults. A time budget may bound an observation or an already-authorized stop attempt, not declare work failed merely for being long.
7. Correlate permission with a human-owned response to the exact native operation. Distinguish deny, dismiss, timeout, withdraw and clarification. No worker or model field grants itself permission. Reconcile unknown answer-delivery outcomes before resending.
8. Preserve credential, sandbox, network, Git hook/signing and recursion-isolation boundaries. Never pass service/reconnect credentials to the worker. No silent model/provider/API-key or permission fallback.
9. Keep configuration-only factories free of native startup, auth, model discovery and long-lived resources. A missing adapter runtime cannot hide front-end tools, status or history.
10. Own every started native operation, callback, stream and process. Parent exit, stream close, native turn end and descendant stop remain different facts. Unknown stop prevents stable delivery/retirement rather than becoming synthetic success.
11. Provide unit/contract, real-process and required-real evidence for each advertised capability. Tests against controlled peers prove mappings, not installed permission, billing or session lifetime. Only advertise qualified behavior or an explicit candidate/unavailable state.
12. Review change locality: native source/configuration, one factory entry, protocol fixtures, support documentation and the skill dossier should normally suffice. Broad coordinator/Git changes require a shared-contract decision.

The provider dossier gains: native request/response schema/version source; internal/request timeouts and their exact consequences; cancellation ownership; input withdrawal semantics; observed versus guaranteed subordinate settlement; native continuation; client-detachment behavior; process-death/descendant evidence; external limitations; and test/live evidence identifiers.

The conformance reference gains the plan's V4–V11 scenarios where relevant. Keep one small existing conformance helper where it reduces duplicated tests; do not generate a provider framework or test DSL.

## Usage skill

Update `.agents/skills/passeur-bridge/SKILL.md` and its setup reference, plus the legacy Muse skill's migration link. It must explain the actual implemented public tools and demonstrate:

- Submit with a stable request key and explicit selected agent. An accepted receipt is not completed work; losing the receipt is repaired by identity lookup, not a new task.
- Wait or inspect without a tight loop; a wait timeout/Stop action affects the wait unless explicit task cancellation is invoked.
- Handle `input_required` through the dedicated operation. The human authorizes permission; ordinary clarification answers do not grant execution rights.
- Detach/reconnect and explicitly attach/adopt when the host lacks a valid reconnect context. Another client's task ID is not implicit control authority.
- Inspect native/phase/stop evidence and limitations rather than guessing from elapsed time, quiet output or heartbeat.
- Distinguish front-end and service build identities. New installed client code does not mutate a running service. Preserve named registrations and required/optional/approval policy.
- Consume committed or truthful partial results; integrate externally and finalize only with exact protected-resource evidence.

Present legacy delegation tools as migration entrypoints where they no longer admit new execution. Do not teach an old long-pending/timer-based path as a fallback or claim an MCP Tasks projection exists before implementation and negotiation.

## Acceptance

Structural validation checks metadata and references. Behavioral validation requires fresh-session evidence of the named workflow and second native adapter. A reviewed SKILL.md, a checklist or self-report alone does not establish this claim. The skills guide development and operation; executable boundaries remain the authority for safety.
