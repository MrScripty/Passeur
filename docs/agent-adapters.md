# Agent adapter contract

Follow [the authoring skill](../.agents/skills/passeur-agent-adapter/SKILL.md). `src/agents/types.ts` owns the internal whole-assignment worker interface; `report.ts` and `report-format.ts` own explicit assignment messages. `builtins.ts` contains the static factory composition; registry factories validate local configuration without SDK startup, authentication or model probing.

A `run` owns native startup, sessions/turns, subordinate obligations, callbacks, explicit input, terminal evidence and cleanup. Configuration stays adapter-local. The service's task signal represents explicit cancellation or actual safety/failure authority, not client or wait lifetime. `input(..., signal)` may use the narrower native invocation signal so genuine native failure withdraws that input waiter without cancelling unrelated work.

Emit correlated turn_started/turn_settled and operation_started/operation_finished where the native protocol supplies them. Missing coverage is not an empty operation set. A successful turn followed by pending tools remains active. Native exit/EOF, failed observation and actual failure are distinct; no heartbeat or duration establishes success/crash. `stop_grace_ms` applies only after a reason to stop exists.

A version-2 PASSEUR_MESSAGE is final, input_required, or blocked. Preserve the same session/thread across explicitly answered clarification turns. Invalid/ambiguous output requests an explicit continuation or cancellation instead of autonomously repairing the prompt. An answer is never native permission unless it came through the permission channel. Propagate native withdrawal and correlate offered once/deny choices; session-wide grants remain excluded.

Native terminal evidence accounts for answered input intents. Process exit alone does not acknowledge an answer. Preserve delivery_unknown after native/transport interruption and never resend automatically. SDK promises and native callbacks must be observed through settlement; a signal-aborted wrapper does not prove child stop.

Muse uses the SDK's host exit/connection and fold item observations; pinned compatibility and in-turn native question coverage remain required-real qualification. Codex uses documented app-server requests/notifications, per-turn item tracking, explicit request-user-input decoding and process-group observation. Neither adapter is claimed qualified solely by controlled peers or source inspection.

Preserve approved authentication, environment, sandbox/network restrictions, ordinary hooks and recursion isolation. A capability absent from the native runtime is unsupported, not an opportunity to weaken review mode. Review requires no shell and no writes. Consumer/support changes require the corresponding live evidence and explicit plan adoption.
