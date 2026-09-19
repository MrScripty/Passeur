# Muse Bridge implementation

This package implements the CLI-only architecture in `Plans/codex-muse-cli-bridge-design.md`. Codex launches one stdio MCP server bound to one canonical project. The server owns a project lease, admits one task at a time, persists the accepted request before worker launch, and resolves the original `delegate_to_muse` call after a terminal result is durable.

`src/muse/adapter.ts` is the only production module importing `@muse-code/sdk`. Every assignment owns a fresh `muse serve` host and session. Review hosts start with shell and non-shell writes disabled and restricted networking. Implementation hosts use a bridge-created Git worktree. Muse approvals are mapped to MCP form elicitation and only a server-offered choice ID can be returned.

The task state and delivery state remain distinct. A result is written before the MCP handler returns it. Reusing an identical request key returns that saved result; changed input under the same key fails. Incomplete tasks are never relaunched automatically.

The public Muse SDK 1.3.0 has no per-turn cancellation method. Cancellation therefore closes the assignment-owned host. Its documented close path uses stdin EOF followed by bounded SIGTERM/SIGKILL escalation. A close failure remains `worker_stop: unconfirmed` and must be reconciled before trusting another run.

Review mode records HEAD, project dirtiness, and digests explicitly referenced context files before and after execution. This is drift detection, not an immutable snapshot. Implementation mode requires a clean source checkout, an exact commit ID, and a worktree root outside the source checkout. It creates a retained worktree and branch, then returns hashed manifest entries, a tracked binary diff, and retrievable copies of untracked files without integrating them.
