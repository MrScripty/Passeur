# Structural reporting — implementation status

**Not yet available through CLI or MCP.** The governing [Plan 2A](plans/structural-change-coordination/plan.md) is partially implemented and blocked on native dependency qualification. No language-support claim is made by this source increment.

The existing coordinator now permits isolated exact-base work from a dirty parent checkout, collects confirmed-stopped delivery independently of task cancellation, and lets a long checkout hook run without retaining the broad administration lock. See [implementation evidence](plans/structural-change-coordination/reports/implementation-evidence.md) for real Git regressions and their controlled-boundary limits.

New `src/observation/` modules supply internal source reads, captured byte identities, conservative transformation of already-extracted declaration values, and bounded formatting. `src/coordination/notices.ts` supplies only a materiality fingerprint. They are not a parser, a public contract, a watcher or a notification service.

Source identities separate each work item's INPUT from its OBSERVED commit/capture. Live captures are explicitly sampled files, never atomic workspace snapshots. Source APIs require an authorized complete worktree root and Git-relative paths; symlink contents and special files are not analyzed. Working roots inside a worktree subdirectory are rejected to prevent contradictory relative-path semantics. Excerpts use captured bytes, not later live contents.

The future helper decoder must validate untrusted messages and establish extraction/default-masking provenance before these internal values can be used. The current tests' authored declaration fixtures are not a fallback implementation and are never registered in production. Future integration must preserve all thirteen required languages, parent-only development decisions, quiet notifications and code-only operation.

The evaluator-assisted [Plan 2B](plans/evaluator-assisted-coordination/plan.md) is an included, unselected alternative. No evaluator is implemented or invoked.
