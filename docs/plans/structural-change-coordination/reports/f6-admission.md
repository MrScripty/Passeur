# F6 admission — authenticated metadata transport and request admission

Date: September 22, 2026. Governing plan: `docs/plans/structural-change-coordination/plan.md`, revision 2A. Invocation: maintainer-requested `continue` after committing F5 as `c8cfa95cec000fde3bd8e39dbe13834780ebfd0b`. The owned re-plan admits Blocked → Active for F6 before implementation. Native parser qualification remains a separate blocked acceptance dependency, not a prerequisite for this metadata-only path.

## Outcome and scope

Connect the existing authenticated connection and RepositoryRuntime.coordinate through the elected listener and one bounded client request owner. The private operation is usable by the existing ServiceClient; CLI/MCP tool projection remains a subsequent consumer. Existing task/native lifetimes, external integration, request/result formats and storage meaning remain unchanged. No parser support or semantic report is advertised.

## Exact write set

`src/service/server.ts`, `src/service/client.ts`, new `src/service/peer-auth.ts`, `src/service/request-capacity.ts`, `src/service/coordination-route.ts`; `tsconfig.core.json`; affected usage skill/documentation; new focused/authenticated/elected/public adapter tests and fixtures; this plan, ledger, issues and linked evidence. Any directly affected additional path is recorded before editing. Runtime and durable-control semantics are read-only unless tests expose a design-changing issue.

## Standards route and preserved evidence

Core → Router; Planning, Implementation, Verification, independent oracles, Development Proportionality, Commit (patch/staged review, no upstream commit), Documentation, Build; Architecture/Code Design, Contracts/Protocols/Evolution/Schemas, Concurrency, Security, Diagnostics, Resilience, Cross-Platform; TypeScript/Async, IPC, Persistence (unchanged store consumed), Generated Contract (MCP envelope), Launcher. Read applicable Requires. No dependency replacement, language grammar selection, compiler semantic analysis, model invocation, provider account, installation, user configuration mutation or shared-history write is admitted.

The committed ledger records the maintainer's full pinned F5 check/test result. Preserve it as their prior integration evidence. This session must label its own sparse-checkout and unavailable dependency limits separately.

## Deciding evidence

Actual production authentication helper and client framing → real Unix socket → actual runtime metadata owner → real Git and coordination store. Tests explicitly substitute task inventory/lease/recovery; they cannot prove the excluded owners. Separate real elected-listener tests are added to the repository test path and remain unaccepted if its pinned dependencies are unavailable. Exercise wrong credentials/binding/source/actor, reply correlation and malformed replies, lost observation, saturation with release capacity, current source authority, and explicit no-effect boundaries. Each test owns its files/sockets and observes shutdown.

No native parser, full pinned application, installed host, representative performance, or independent external-review claim is waived. Source work can be implemented with these claims visibly open; do not report the full feature accepted.

## Consumer boundary decision

The listener and client are one completed metadata wire increment. CLI/MCP registration is not included: the complete pinned schema/SDK environment remains unavailable for its independent generated-interface and host requirements. No new internal parser, metadata database or task engine is introduced to bypass that boundary. The existing library schema catalogue and listener startup remain unchanged; metadata requests use their already owned decoder. New elected-listener coverage is included for the full repository to run, and its local unavailability must be reported, not replaced with the fixture listener.
