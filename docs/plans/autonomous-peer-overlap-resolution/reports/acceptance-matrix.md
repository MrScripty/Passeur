# Acceptance matrix — autonomous peer overlap resolution

This is the current claim index. A passing parser, historical coordination run,
or parent-led reconciliation does not satisfy the required-real worker claims.

| Claim | Required evidence | Current evidence | Disposition |
| --- | --- | --- | --- |
| Structured parsing domain and ordinary consumer | Focused API test/example using supplied source, no service/model | `tests/core/peer-overlap.test.mjs`; `npm run build`; `npm run check`; source capture hash/range validation in `src/observation/overlap.ts` | Partial: local overlap consumer passes; public extraction integration remains |
| Deterministic compact overlap handoff | Independent expected selections, replay, byte/range and body/default assertions | `tests/core/peer-overlap.test.mjs` — deterministic ordering, body spans, UTF-8, unavailable source, explicit too-small budget, bounded incomplete payload | Partial: default/signature fixture breadth and progressive expansion remain |
| Authenticated bounded peer conversation | Durable case/proposal/ack records, stale/version/duplicate/third-party/revocation tests | `tests/core/peer-resolution-contract.test.mjs`, `tests/core/coordination-control.test.mjs` — strict records, exact case members, source versions, counter lineage, stale ack, retained-note compatibility, and stale downstream state after withdrawal/supersession | Partial: worker/session principals and full public projection remain |
| Conditional application and verification | Exact source/case/scope version checks and separate application/verification records | `tests/core/coordination-control.test.mjs` — acknowledged proposal required, exact sources/scope, lead-only application, applied application required for verification, and withdrawal invalidation | Partial: no Git/application effect or functional verification owner is qualified |
| Language fixture applications | Offline build/run, parser and overlap oracle for Rust, Python, C, C++, C#, Kotlin, Zig, TypeScript, TSX, JavaScript, JSX, Lua, Odin, Svelte 5 | Existing parser fixtures only; M4 pending | Pending |
| Installed native worker delivery | Actual configured adapter, safe interaction boundary, queued/delivered/observed/acted evidence | Blocked by service reconciliation; adapter boundary not qualified | Blocked |
| Blinded repeated two-/three-worker resolution | Fresh disposable repositories, 3 repeats each, no parent conflict actions | Not run; service reconciliation blocker | Blocked |
| Records and commit integrity | Current plan/ledger/issues/inventory, staged diff, hooks, coherent commit | Plan/ledger/issues/matrix/inventory updated in this slice; final staged diff and commit recorded after standards-gated verification | Pending until commit |
