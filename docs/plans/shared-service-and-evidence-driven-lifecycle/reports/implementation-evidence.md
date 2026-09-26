# Shared-service implementation candidate — verification record

Date: September 20, 2026 (America/Vancouver). Source baseline: `18c8eb9593c5f9e9faae48314ddc136ba366e109`. Standards authority: `366c1d90a24bbfb50973f62b155a5f3396c0f107`.

## Disposition

Source implementation and regression tests are supplied for the shared-service/durable-task plan. Status is **Verifying**, with objective acceptance **blocked**. This is not a certified Coding-Standards-compliant codebase, a complete pinned build, or an installed/live acceptance result. Do not overwrite a working installation before completing the required migration and qualification.

The preparation environment could read repository content through the connected GitHub tool, but native Git/npm network access failed. The working copy is a reconstruction of affected files from the preceding delivered packages and pinned GitHub source reads, not a complete fresh clone. The delivery is therefore a guarded overlay for the complete existing checkout, not a standalone repository. Its application helper verifies every replacement's original bytes against the named Git baseline and refuses mismatch. No substitute packages or generated JavaScript are supplied as production dependencies.

## Implemented scope

One Linux repository service owns RepositoryRuntime, its atomic repository lease, registry, queue, store and Git administration. Stdio front ends attach using a private versioned Unix-socket protocol. Front-end EOF or wait cancellation does not forward task cancellation or service shutdown. Exact build/binding/generation mismatch is explicit. A process-lifetime flock guard prevents a paused living new service from being replaced solely on a heartbeat threshold; legacy proper-lockfile directory leases remain readable through exact sidecar evidence.

New submit/wait/tasks/input/cancel/attach controls use durable admission and control state. Request4, control2, snapshot2, result4, profile3 and frontend status2 have independently scoped contracts. Lost acknowledgment retries retain identity and source view. Owner and control-generation checks prevent accidental cross-session control. Input intent precedes native callback release; stale/dismissed prompts do not consent. Native failure does not leave an unobserved input waiter. Unacknowledged answer delivery remains unknown, even after process stop.

Execution/queue/approval deadlines and the implicit ninety-second task-owned Git deadline are removed. Observation waits and authorized cleanup retain bounded budgets. Existing historical timeout fields/results remain historical decoders only. Capacity remains finite, including worker/queue/client/waiter/input/receipt/frame limits. Old delegation tools return a migration error rather than silently changing cancellation/return semantics.

Muse and Codex retain native sessions/threads across explicit clarification replies. Assignment messages are explicit final/input-required/blocked variants. Known pending items prevent successful final settlement. Native exit/EOF is distinct from silence. Codex observes process exit independently from pipes inherited by descendants. Ordinary commits, actual Git delivery observation, and protected resource retirement remain under existing owners.

CLI/profile migration, named registration/catalog probes, installed artifact entrypoints, usage/authoring skills and recovery documentation are updated. The operator CLI has a private retained control token; actual MCP clients have separate connection credentials. No new dependency or lockfile version was selected.

## Executed evidence

### Current candidate addendum — September 25, 2026

The continuation records below are historical candidate reports and retain their original scopes. The later execution ledger records the clean candidate's complete `npm test` result and the final isolated lifecycle candidate's **647/647** core, **192/192** native, **14/14** lease-recovery and **11/11** focused IPC results. No installed acceptance claim is made for combined `cae3722`; the remaining pinned, host/provider, active-work and fresh-session gates stay blocked.

### September 25, 2026 continuation

The clean committed candidate `22cde5e` was built from a detached disposable worktree using the already provisioned dependency tree; no package installation was performed. Runtime candidate construction and installation produced build identity `7be9f78ad72de63fa9214175eca3747acefa1d5cbcd6fc60920485a62109cf08` and validated its compiled bytes, dependency closure and native parser inventory.

The installed `scripts/probe-service.ts` passed with two real stdio clients sharing one service generation and one repository authority. A subsequent fresh pair started another generation after the first probe exited. A disposable service-death probe killed the elected service and attached a fresh installed client to the same state root; the replacement acquired a new generation with the same installed build and held coordination authority. These probes used preparation/status only and launched no inference.

At the time of this historical continuation, the targeted installed integration set passed 6/6 and the targeted parallel/client/crash/recovery integration set passed 16/16. The source/native command passed 640/640 core and 192/192 native tests; its broad Vitest run remained incomplete because its final worker stayed open without output. The later clean-candidate complete `npm test` result is recorded in the execution ledger.

| Check | Observed result | Boundary actually proved |
| --- | --- | --- |
| Selected coordinator, registry and runtime-owner Node suites | **42 passed** | Production orchestration/control code with explicitly substituted profile/lease/store/native boundaries; selected real disposable Git effects |
| Native Node suites | **40 passed** | Actual Unix socket framing/closure, Linux process identity/flock behavior, Codex transport with controlled subprocess peers, startup policy, presentation queue and Git-helper timing |
| Selected native TypeScript compilation | Passed with **TypeScript 5.8.3** and available Node declarations | Seven native-owned module roots plus their native-only dependencies; not the pinned full project |
| Source syntax transpilation | 50 source files, no syntax diagnostics | Syntax only; no SDK/module resolution or complete type proof |
| Changed/available TypeScript test syntax | 24 test files, no syntax diagnostics | Syntax only; dependency-backed tests not executed |
| Available script syntax | 5 scripts, no syntax diagnostics | Syntax only |
| Initial flock descriptor probe | Owner-held while suspended; conflicting acquisition refused; acquisition after exit passed; surviving child did not keep the guard | Actual util-linux/Linux local process/descriptor behavior, not Muse descendant behavior |

Exact Node: 22.16.0. Actual compiler: 5.8.3. No compiler-version substitution is represented as pinned 5.9.3 success. Logs are linked in this report directory. The final delivery also records archive/application checks in `delivery-checks.json`.

Commands executed against the preparation copy:

```text
node --test --test-concurrency=1 tests/core/registered-agents.test.mjs tests/core/runtime-owner.test.mjs tests/core/durable-lifecycle.test.mjs
node --test tests/native/*.test.mjs
tsc -p <local native-only verification configuration>
```

The 42-test group deliberately uses MemoryStore or controlled injected boundaries where stated. It does not prove Zod decoding, real atomic durable publication, native billing, permission enforcement or full service startup. The 40-test group uses real Node subprocesses/sockets for its selected boundaries, not an actual authenticated Muse/Codex runtime. Advancing a simulated clock past prior timeouts proves bridge control logic; it is not a real multi-hour execution claim.

Full TypeScript compilation was attempted with available Node declarations and failed to resolve the unavailable pinned MCP, Muse, Zod, smol-toml, proper-lockfile and Vitest dependencies. Cascading unknown/implicit-type diagnostics cannot establish compatibility with those missing APIs. Those failures were not suppressed through production stubs, casts or relaxed compiler flags.

## Added or updated but not executed here

Dependency-backed real-store/profile migration and reopening tests; full v4 record/control producer-consumer checks; Muse facade and Codex adapter lifecycle/continuation fixtures under Vitest; skill structure tests through the repository runner; complete repository core/Git suites requiring Zod; installed model-callable host and provider workflows.

`tests/integration/durable-store.test.ts` includes persisted admission/control, immutable history, interrupted answer intent and malformed control rejection. `tests/integration/mcp-startup.test.ts` exercises actual built front-end processes, same repository/worktree election, another repository and repaired startup. `scripts/probe-service.ts` performs an explicitly authorized installed two-client, preparation-only probe. These are runnable intended evidence paths after complete dependencies/build are present, not completed evidence in this report.

## Required blockers and limits

1. Run the complete pinned checkout gates (`npm ci`, `npm run check`, `npm test`, runtime build) and resolve every failure before installation. Do not take the partial successes above as a release gate. The complete original checkout/lockfile remains authoritative.
2. Qualify Muse SDK1.3.0/CLI against the added host-exit/connection/fold observations. Official main-branch SDK source and generated documentation were inspected, but the exact pinned package could not be installed. Completed-turn explicit questions are implemented; native in-turn Muse user-input variants are not comprehensively mapped or claimed qualified. Establish their exact supported API and implement/limit that capability explicitly before accepting SS-05/SS-06. SDK-internal request/approval timers and descendant handling need real evidence too.
3. Qualify actual Codex app-server version, native request-user-input/permission/withdrawal behavior, human elicitation with request association, host Stop semantics, multi-turn same-session continuation, dedicated auth/recursion isolation, and descendant stop. No account use or live inference occurred.
4. The installed dependency closure and two-client shared-service preparation path now have disposable evidence. Still qualify two real installed Codex sessions and source-independent installed model-callable behavior; the current probe does not prove host tools, service election on every target filesystem, all-client-loss behavior with native runtimes, or active-task recovery.
5. Obtain fresh-session use of the revised adapter skill and independent external review at the completed candidate boundary. Neither was performed by the authoring session. No plan claim is marked Accepted from self-review.

## Source authority and design review

The existing plan's eight-part composition probe was updated with the actual owner paths. Additional actual paths (`src/service/process.ts`, `src/agents/report-format.ts` and selected regression files) localize existing admitted concerns rather than introduce new services. Shared core contracts, registry, lockfiles and plan authority had one serial author; no worker contributions or shared history were rewritten.

The source patch preserves configured roots, named registrations, required/optional startup policy, approval settings and historical data. Installation/migration remain operator actions. No personal configuration, active production process, live task, real worktree, user credential, GitHub branch or remote repository was mutated. Only synthetic disposable test repositories/processes were created. Fixture cleanup was scoped to those discard-authorized synthetic roots, not a repository-wide prune. Packaging tests operate in separate synthetic Git roots; their commits are test data, not claimed implementation commits.

Independent whole-codebase standards acceptance remains pending. Source inspection and tests cover the changed families but are not an audit certificate for every maintained boundary or future change.
