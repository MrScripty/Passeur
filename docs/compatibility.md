# Compatibility record

Recorded September 19, 2026 on the current Linux environment.

| Surface | Version / evidence | Status |
|---|---|---|
| Node.js | 24.12.0 | Local version observed; satisfies package engines |
| Codex CLI | 0.155.1 | Local version observed |
| Muse CLI | 1.3.0 (`1.3.0-R3401.1`) | Local version observed |
| Muse SDK | 1.3.0, exact lockstep pin | Installed and adapter typechecked |
| MCP SDK | 1.30.0, exact pin | Installed and server typechecked |
| MCP protocol/capabilities | Negotiated at runtime | Delegation refuses to start without elicitation capability |
| Requested model | Explicit profile value; no default | Runtime must report the identical ID or the task fails; the installed 1.3 identifier remains to be established live |
| Review permissions | `muse serve --disable-write --disable-shell --sandbox-network restricted` | Configured; destructive-negative live fixture not yet run |
| Approval route | MCP form elicitation | Implemented; installed Codex accept/deny/dismiss policy tests remain |
| Task/MCP timeout | 30 minute task budget; recommended 35 minute MCP timeout | Deterministic task deadline implemented; installed long-wait trace remains |
| Subscription provenance | Per-profile `user_confirmed`, `provider_verified`, or `unverified` | Real tasks reject `unverified`; no provider machine proof claimed |
| Parent-loss cleanup | SDK owned-host close and host-death handling | Graceful close path implemented; abrupt parent-death descendant test remains |

Deterministic coverage now includes atomic concurrent admission, request-key attachment and conflicts, partial-record quarantine, lease-aware cleanup and explicit reconciliation, cancellation iterator settlement, revision drift, worktree-root confinement, untracked binary artifact copies, artifact allowlisting, worker-report parsing, and compact-result byte limits.

No live, billable Muse inference was run during implementation. The opt-in probes and installed-client cases in the design plan must be completed in a disposable repository before describing this environment as fully compatible. Update this record with dates, trace locations, effective model, approval policy, credential provenance, and negative-fixture observations after those runs.
