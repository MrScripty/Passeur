# Sources and routed standards

Checked September 20, 2026 (America/Vancouver). Source inspection is not installed-runtime qualification. The current user report supplies the production symptom and required behavior; no exact live error/trace from that incident was provided in this planning turn.

## Repository source authority

Passeur source revision: `18c8eb9593c5f9e9faae48314ddc136ba366e109`. File URLs below are immutable commit references, not mutable main links.

### R1 — Connection-owned runtime
Path: `src/core/repository-runtime.ts`. Owns lazy binding/preparation/lease and eventual drain/release; currently instantiated for a connection.

`https://github.com/MrScripty/Passeur/blob/18c8eb9593c5f9e9faae48314ddc136ba366e109/src/core/repository-runtime.ts`

### R2 — MCP connection lifecycle
Path: `src/mcp/server.ts`. Current connection shutdown invokes runtime shutdown; tools are composed before operational prerequisites.

`https://github.com/MrScripty/Passeur/blob/18c8eb9593c5f9e9faae48314ddc136ba366e109/src/mcp/server.ts`

### R3 — Repository lease
Path: `src/core/lease.ts`. Current cooperative lock uses a 30-second stale threshold and ten-second refresh; not process fencing.

`https://github.com/MrScripty/Passeur/blob/18c8eb9593c5f9e9faae48314ddc136ba366e109/src/core/lease.ts`

### R4 — Task execution deadline
Path: `src/core/coordinator.ts`. Current admission creates deadline_at and an aborting task timer; first request owns cancellation.

`https://github.com/MrScripty/Passeur/blob/18c8eb9593c5f9e9faae48314ddc136ba366e109/src/core/coordinator.ts`

### R5 — Human prompt timer
Path: `src/approvals/native.ts`. Current elicitation timer can expire after five minutes, including time before the serialized prompt runs.

`https://github.com/MrScripty/Passeur/blob/18c8eb9593c5f9e9faae48314ddc136ba366e109/src/approvals/native.ts`

### R6 — Profile/deadline contracts
Path: `src/contracts/agents.ts`. Execution policy and execution snapshot currently retain task_timeout_ms through the legacy profile schema.

`https://github.com/MrScripty/Passeur/blob/18c8eb9593c5f9e9faae48314ddc136ba366e109/src/contracts/agents.ts`

### R7 — Git helper deadline
Path: `src/workspace/project.ts`. The common Git helper defaults an absent signal to a 90-second timeout and its abort path signals Git/process-group work.

`https://github.com/MrScripty/Passeur/blob/18c8eb9593c5f9e9faae48314ddc136ba366e109/src/workspace/project.ts`

### R8a — Muse native adapter
Path: `src/muse/adapter.ts`. Consumes a native terminal promise and one report; native continuation/input lifetime must be qualified for the new design.

`https://github.com/MrScripty/Passeur/blob/18c8eb9593c5f9e9faae48314ddc136ba366e109/src/muse/adapter.ts`

### R8b — Codex native adapter
Path: `src/agents/codex/adapter.ts`. Consumes native completed-item/turn events; native request/continuation/settlement mapping changes in this plan.

`https://github.com/MrScripty/Passeur/blob/18c8eb9593c5f9e9faae48314ddc136ba366e109/src/agents/codex/adapter.ts`

### R8c — Shared worker interface
Path: `src/agents/types.ts`. run owns the current whole native run; common events currently lack the richer lifecycle/input/control distinctions proposed here.

`https://github.com/MrScripty/Passeur/blob/18c8eb9593c5f9e9faae48314ddc136ba366e109/src/agents/types.ts`

### R9 — Actual pinned build/check entrypoints
Path: `package.json`. MCP SDK 1.30.0, Muse SDK 1.3.0, proper-lockfile 4.1.2, smol-toml 1.8.0, Zod 4.1.11; TypeScript 5.9.3. The declared toolchain is not installed or executed by this planning package.

`https://github.com/MrScripty/Passeur/blob/18c8eb9593c5f9e9faae48314ddc136ba366e109/package.json`

## Standards authority

Adopted revision: `366c1d90a24bbfb50973f62b155a5f3396c0f107`. Core/Router and the selected canonical rules, not legacy navigation summaries, govern implementation.

Core and Router were available in this conversation at the same rechecked revision. The plan/template, architecture, contract, concurrency, implementation, verification, proportionality, commit, persistence/IPC, TypeScript/Async, security and documentation content inform this plan. M0 resolves the full conditional reading route against actual implementation facts; this report does not claim execution of the separate standards engine.

- `CORE-STANDARDS.md` — `https://github.com/MrScripty/Coding-Standards/blob/366c1d90a24bbfb50973f62b155a5f3396c0f107/CORE-STANDARDS.md`
- `STANDARDS-ROUTER.md` — `https://github.com/MrScripty/Coding-Standards/blob/366c1d90a24bbfb50973f62b155a5f3396c0f107/STANDARDS-ROUTER.md`
- `templates/PLAN-TEMPLATE.md` — `https://github.com/MrScripty/Coding-Standards/blob/366c1d90a24bbfb50973f62b155a5f3396c0f107/templates/PLAN-TEMPLATE.md`
- `workflows/planning.md` — `https://github.com/MrScripty/Coding-Standards/blob/366c1d90a24bbfb50973f62b155a5f3396c0f107/workflows/planning.md`
- `workflows/implementation.md` — `https://github.com/MrScripty/Coding-Standards/blob/366c1d90a24bbfb50973f62b155a5f3396c0f107/workflows/implementation.md`
- `workflows/verification.md` — `https://github.com/MrScripty/Coding-Standards/blob/366c1d90a24bbfb50973f62b155a5f3396c0f107/workflows/verification.md`
- `workflows/development-proportionality.md` — `https://github.com/MrScripty/Coding-Standards/blob/366c1d90a24bbfb50973f62b155a5f3396c0f107/workflows/development-proportionality.md`
- `workflows/commit.md` — `https://github.com/MrScripty/Coding-Standards/blob/366c1d90a24bbfb50973f62b155a5f3396c0f107/workflows/commit.md`
- `workflows/documentation.md` — `https://github.com/MrScripty/Coding-Standards/blob/366c1d90a24bbfb50973f62b155a5f3396c0f107/workflows/documentation.md`
- `topics/architecture.md` — `https://github.com/MrScripty/Coding-Standards/blob/366c1d90a24bbfb50973f62b155a5f3396c0f107/topics/architecture.md`
- `topics/contracts.md` — `https://github.com/MrScripty/Coding-Standards/blob/366c1d90a24bbfb50973f62b155a5f3396c0f107/topics/contracts.md`
- `topics/contracts/evolution.md` — `https://github.com/MrScripty/Coding-Standards/blob/366c1d90a24bbfb50973f62b155a5f3396c0f107/topics/contracts/evolution.md`
- `topics/concurrency.md` — `https://github.com/MrScripty/Coding-Standards/blob/366c1d90a24bbfb50973f62b155a5f3396c0f107/topics/concurrency.md`
- `topics/security.md` — `https://github.com/MrScripty/Coding-Standards/blob/366c1d90a24bbfb50973f62b155a5f3396c0f107/topics/security.md`
- `profiles/boundaries/ipc.md` — `https://github.com/MrScripty/Coding-Standards/blob/366c1d90a24bbfb50973f62b155a5f3396c0f107/profiles/boundaries/ipc.md`
- `profiles/boundaries/persistence.md` — `https://github.com/MrScripty/Coding-Standards/blob/366c1d90a24bbfb50973f62b155a5f3396c0f107/profiles/boundaries/persistence.md`
- `profiles/languages/typescript.md` — `https://github.com/MrScripty/Coding-Standards/blob/366c1d90a24bbfb50973f62b155a5f3396c0f107/profiles/languages/typescript.md`
- `profiles/languages/typescript/async.md` — `https://github.com/MrScripty/Coding-Standards/blob/366c1d90a24bbfb50973f62b155a5f3396c0f107/profiles/languages/typescript/async.md`

### Conditional route

Implementation involves process/message, durable-state, TypeScript async, generated MCP-schema projections, and Linux filesystem/process boundaries. Select their profiles and contract protocol/schema details, together with Build, Tooling, Dependencies/Licensing, Diagnostics, Resilience, Cross-Platform, Launcher and affected verification-oracle/platform guidance. Follow each selected canonical module's Requires closure. Record actual engine/router output when the adopting checkout provides that mechanism; do not substitute a hand-picked smaller list when observable facts select more.

Exclude GUI/frontend/accessibility, Rust, C#, FFI/language bindings and unrelated framework rules. Native platform process-lock tooling alone is not permission to invent an FFI layer. Concurrent product sessions do not select Concurrent Plan Integration for development unless authorizing proposals actually have stale shared-authority risk.

### Requirement-to-plan mapping

| Standard concern | Plan coverage |
| --- | --- |
| Planning artifact/state/explicit operation | Current-authority fields, ledger/issues/reports, one next slice, M0–M4, evidence statuses |
| Composed design and one authority per concern | D1–D4 and all eight probes in design-admission.md |
| Strict input/output and persisted proof | D5–D7, D13, public/version table, V6/V9/V12 |
| Work/cancellation/ordering ownership | D1, D6–D12, D14–D15, V2/V4/V5/V9/V10 |
| Security and permission | D3/D4/D7, IPC peer/binding checks, human authority, V6/V8/V9 |
| Failure and durable recovery | D10/D13–D15, no unknown-outcome retry, V9–V12 |
| Evidence fidelity | Fourteen claims, sixteen scenario families, independent native/process/Git observations |
| Proportionality | Finite M0 decisions; no global scheduler, sidecar, model judge or general standards verifier |
| Documentation and skills | Named canonical lifecycle/service docs, existing runbooks/skills, source-to-consumer migration |
| Commit/integration and created resources | Selected objective branch, staged review, final-unit external review, exact protected-OID disposition |

## External primary-source reference checks

These references explain protocol/platform behavior; they do not certify what is installed on the operator's machine. Pin/record actual versions at qualification. The design intentionally avoids depending on an unverified client extension.

### E1 — Codex MCP configuration

`https://developers.openai.com/codex/mcp/`

The fetched official documentation redirects to the current ChatGPT Learn documentation. It documents separate startup and tool-call timeout settings and per-server required/allow/deny controls. This supports separating caller request lifetime from service-owned task lifetime; it does not prove a particular host sends a distinct user-Stop signal.

### E2 — Codex app-server native events/input

`https://developers.openai.com/codex/app-server/`

The fetched official documentation describes thread/turn lifecycle, terminal status variants, started/completed items, native user-input requests and request-resolution notifications. Native input can be cleared by lifecycle changes as well as an answer. Version-specific mapping and live effects remain qualification work.

### E3 — MCP Tasks and lifecycle

`https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks`

`https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle`

`https://modelcontextprotocol.io/specification/2025-11-25/architecture`

Tasks are capability-negotiated and distinguish working, input-required and terminal states; their notification/result/TTL/cancel semantics are not interchangeable with arbitrary local task semantics. This plan uses explicit ordinary tools initially, with native Tasks outside the initial implementation. The base architecture assigns capability/consent policy to the host and isolated client connections. The elicitation-specific page could not be fetched in this planning environment; no unverified ability to issue unsolicited prompts is relied upon. M0 verifies actual request association and host capability.

### E4 — Linux service election primitive

`https://man7.org/linux/man-pages/man1/flock.1.html`

This upstream-project manual documents nonblocking command mode, no-fork execution that retains the lock, descriptor inheritance/closure implications and filesystem limitations. The selected initial process-lifetime guard must be qualified with the actual util-linux/Node/filesystem combination. There is no automatic NFS/CIFS or non-Linux support claim.

## Review boundaries

This package does not reproduce upstream libraries or font/software assets. It supplies original implementation decisions with sources. It does not include native SDK generated output, patches, production code, test results or live approval evidence. Standards adoption is explicit; evolving external documents must not silently change an accepted in-flight native compatibility contract.
