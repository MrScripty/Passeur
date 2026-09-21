# Durable task lifecycle

This is the lifecycle-breaking shared-service candidate. Acceptance and support limitations are recorded in [compatibility](compatibility.md), not inferred from this contract.

## Ownership and versions

The service owns each accepted task. A front end owns only its connection, request waits and input presentations. `Coordinator.submit` publishes request version 4, lifecycle snapshot version 2 and initial control version 2 through one TaskStore directory-publication boundary before returning an acknowledgment or starting native work. The unchanged assignment schema is version 3; submit/wait/control envelopes are independently versioned at 1. Profile version 3 supplies capacity and shutdown policy without an execution deadline. Old profile/request/result versions remain historical read contracts.

Request equality includes the source view, assignment, agent, base and scope. A retry under the same authorized owner and equivalent key returns the original task. A changed request conflicts. A coincident key from another owner does not expose the task. Front-end credentials are private; a later connection without them needs explicit human-confirmed adoption by ID or original request key. Adoption changes the control generation and invalidates stale presentation claims. It does not restart work.

## Operations

`passeur_submit` and `passeur_submit_batch` return durable receipts, not completion. `passeur_tasks` reads authorized observations. `passeur_wait` returns changed/input-required/terminal/wait-elapsed plus a revision. Its timeout or cancellation removes the waiter only. Submit cancellation before publication can prevent admission; afterward it only prevents delivery of the receipt.

`passeur_cancel` persists a keyed task stop intent. Its accepted receipt does not prove stopped descendants. Completion and cancellation are serialized through TaskControls: a successful settlement already accepted remains complete, while a prior stop intent cannot be overwritten by late success. Actual native failures remain in the result's evidence/error fields even during cancellation.

`passeur_attach` is a human-confirmed transfer of control, not discovery by guessing a task ID. `passeur_input` inspects/claims a pending request; permission requires fresh request-associated human elicitation and cannot be supplied in a model's answer field. Clarification may accept an explicit factual answer. Dismissal, timeout or connection loss releases presentation ownership without granting or denying the native operation. Explicit human denial returns only that operation's offered denial choice.

Input answers are recorded as intent before releasing the native waiter. A native turn settlement can account for that intent. A failure/crash without acknowledgment leaves delivery unknown, never presumed delivered from process shutdown. Repeating an operation key returns its receipt and cannot resend the native side effect. Recovery requires actual native evidence or explicit operator reconciliation.

## Evidence rather than inactivity

Phase, native state, known obligations, input state, client attachment, execution outcome and shutdown evidence are distinct. Known items remain outstanding until corresponding native settlement. An empty stream, elapsed time, low CPU use or missed probe cannot finish or kill a task. A failed observation reports uncertainty. A quiet accepted task retains its slot and native resources.

Workers use `PASSEUR_MESSAGE` plus the version-2 contract in `src/agents/report.ts`: `final`, `input_required`, or `blocked`. Successful native turn termination and an explicit final message are both necessary; pending native items/input must also settle. Malformed final output asks for an explicit continuation instruction and keeps the session rather than auto-reprompting or inventing success. A reply starts another turn in that same session/thread. This is protocol continuation, not an autonomous repair loop.

Muse's fold snapshots account for known in-progress items even after the turn iterator ends. Their 200 ms inspection interval is an observation interval with no expiration or cancellation decision. Codex tracks item starts/completions and keeps observing known items after a success notification. Native EOF/exit and failure are distinguished from silence. The pinned native SDK and its settlement guarantees still require real qualification.

## Stop, failure and recovery

There is no new task/queue/approval/inactivity deadline. `stop_grace_ms` bounds only an already-authorized per-runtime cleanup. The Git helper no longer invents a ninety-second operation deadline, including during hooks. Resource/admission bounds remain; oversized frames and loss of authoritative storage are genuine failures, not timeouts.

Native uncertain shutdown or answer delivery freezes unsafe replacement work and retains resources. Service restart never replays possibly submitted inference. Never-started recovered work stays needs-attention: explicitly cancel it, then use a deliberate new key. Interrupted native work requires process/workspace reconciliation; stored PIDs are accompanied by boot and process-start identity and are not signal authority alone.

Results version 4 are immutable and published before terminal control. Interrupted publication is recoverable without rewriting completed evidence. Git delivery and resource disposition remain distinct from execution. Passeur observes actual commits; it does not certify code quality, select tests, integrate code or create PRs.

Control receipts and input history are bounded. Exhausting a declared capacity produces an explicit refusal before another protected transition. The default is 512 control receipts, with a reserved cancellation opportunity and a profile maximum of 4096. This is not a claim of unlimited interaction history.
