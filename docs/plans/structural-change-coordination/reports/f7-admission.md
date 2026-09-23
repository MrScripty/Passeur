# F7 admission — public metadata consumers

Operation: continue, governing plan docs/plans/structural-change-coordination/plan.md (2A).
Observed baseline: 18a26fdb54434f9c516f030112ce7d4a616974f1. The committed F6 record reports elected-listener and full pinned-suite success in the maintainer's checkout. Those results are not reruns in this environment.

The user's explicit continuation authorizes the current lead to admit the independent public metadata consumer slice: transition Blocked to Active for F7; native parser/installed acceptance remain blocked. No required claim is waived. Metadata is implemented without claiming syntax extraction, monitoring, managed announcements, operator adoption, or resource retirement.

Exact production writes: passeur (existing launcher action allowlist); src/cli.ts; src/cli/coordination.ts; src/mcp/server.ts; src/mcp/coordination.ts; src/mcp/coordination-operations.ts; src/codex/config.ts. Contract-bound constants may be exported from src/contracts/coordination-control.ts for the MCP projection without altering their values/meaning. src/contracts/coordination-service.ts owns the small borrowed client interface shared by both public consumers; there is no CLI-to-MCP dependency. Documentation writes: docs/coordination.md; .agents/skills/passeur-bridge/SKILL.md; plan.md/execution-ledger.md/issues.md and owning reports in the selected plan directory. Build/evidence: tsconfig.core.json; vitest.config.ts (one explicit new CLI-test include); tests/core/coordination-public.test.mjs; tests/core/coordination-cli.test.mjs; tests/core/coordination-launcher.test.mjs; focused public source fixtures; tests/core/coordination-mcp.test.mjs and tests/integration/coordination-cli-entry.test.mjs for actual MCP and CLI; new F7 evidence files. Additional directly affected paths will be recorded before editing. Plan 2B remains unselected and unchanged.

Authority: existing authenticated frontend and runtime. CLI confirmation precedes connection/credential creation; only operator CLI exposes initialization. MCP offers closed read/work/note/case groups and cannot initialize, adopt another parent, send worker instructions, or modify refs. Existing public task APIs remain unchanged. Metadata note contents are attributed untrusted data, not instructions/permission.

Evidence: real request files, canonical decoders, authenticated ServiceClient/runtime/Git/control transport with explicit fixture task/lease boundaries; framework conformance tests using actual SDK/Zod and existing application tests when dependencies are available. No substitute SDK/schema/parser implementations. Claim partial results precisely if the pinned package/compiled closure is unavailable. Public source is a candidate pending those checks, not deployment acceptance.

Design delta: add projections and a bounded CLI file reader, retaining existing state and lifetime owners. One material input/output contract per group; the complete existing decoder remains semantic authority. SDK-generated schema is a projection, not source of permissions. No new scheduler/store/protocol/validation framework. Link exact evidence at completion. Re-plan for a required policy change, a transport/resource authority gap, or a decoder/projection contradiction.


## Standards route and terminal evidence

Adopted revision 366c1d90a24bbfb50973f62b155a5f3396c0f107. Core and Router precede
Implementation, Planning, Verification/oracles, Development Proportionality,
Documentation, Build/Tooling, Commit; Contracts/schemas/protocols/evolution,
Architecture/Code Design, Security, Concurrency/Resilience, Diagnostics and
Cross-Platform; TypeScript/Async, Launcher, IPC and Generated Contract.
Dependencies is the generated-contract prerequisite; no dependency selection,
new FFI, frontend UI, distributed scheduling or evaluator boundary is introduced.
Existing persistence authority is consumed, not revised. Concurrent Plan
Integration is not selected: one integration owner and no outstanding competing
implementation proposal were admitted. The existing source route remains the
standards reference; [F7 design delta](design-admission.md#f7-composed-design-delta)
answers all eight probes. The exact updated write set is in implementation-map.

Final state: source implemented with selected evidence, overall Plan Blocked.
F7-V1 requires actual SDK/CLI and pinned full-check evidence before acceptance.
Current field values are in plan.md; dated work is in the ledger and F7 verification.
