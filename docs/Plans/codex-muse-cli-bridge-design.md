# Codex–Muse CLI Bridge
## Design and implementation plan

**Status:** Proposed design; implementation and installed-runtime compatibility tests remain to be performed.
**Date:** September 19, 2026.
**Target:** Linux Mint; TypeScript on a supported Node.js LTS release.
**Working executable name:** `muse-bridge` — a proposed name, not an existing published package.
**Supersedes:** The earlier Electron/Svelte companion-app design. This document is the complete CLI-only replacement.

## 1. Product contract

The user talks to the real Codex CLI. Codex plans the work, chooses bounded assignments for Muse, reviews the returned evidence, and integrates accepted changes. Muse performs delegated work through the user's existing, subscription-linked Muse Code installation.

The bridge is ordinary orchestration code. It carries assignments, controls the worker lifecycle, routes human input, and returns results. It has no planning model, model-provider proxy, or additional conversation interface.

The required interaction is:

```text
User <-> Codex CLI
             |
             | delegate_to_muse(assignment)
             v
       Node MCP bridge
             |
             | Muse SDK -> local Muse CLI host
             v
         Muse worker
             |
             | terminal outcome and evidence
             v
       Original MCP call resolves
             |
             v
       Codex reviews and continues
```

The normal delegation consists of one outstanding tool request. The bridge does not return a job ID and ask Codex to check it repeatedly. While the request is pending, execution events and approval replies are handled by application code, not new model prompts.

**Meaning of “Codex waits”:** Codex awaits its outstanding delegation tool result. Its process and terminal remain responsive. The bridge does not freeze Codex with operating-system signals, end and recreate its conversation, or inject an unsolicited completion message into a new turn. A third-party MCP server cannot independently impose a global pause on every Codex activity. The installed-client test must demonstrate the intended sequential behavior.

**Success criterion:** A user asks Codex for a bounded task; Codex delegates to Muse; a necessary human permission decision is handled; Muse finishes; Codex consumes the result through the original tool call, without manual copying or automatic status-checking turns.

### Version-one boundary

Support one local user, one configured project per bridge instance, one active Codex owner for that project, and one Muse assignment at a time. Sequential assignments are supported. A fresh Muse task session is created for each assignment.

Exclude Electron, browser UI, embedded terminals, PTYs, Codex App Server, a permanent daemon, parallel scheduling, remote execution, automatic replay, multiple providers, and native Codex agent-tree integration. The worker is an external tool-backed agent, not a native Codex subagent.

## 2. Verified interfaces and compatibility decisions

These are documentation findings, not evidence that the user's installed binaries have passed the integration tests.

| Surface | Documented behavior | Design consequence |
|---|---|---|
| Codex MCP | Command-launched local stdio servers and configurable startup/tool deadlines. [S1] | Codex launches the bridge; no separate service is required. |
| Codex approvals | Configuration includes MCP elicitation prompts and human versus automated approval review. [S2] | Prefer prompts in Codex, but verify the actual handshake, form rendering, and reviewer behavior. |
| MCP elicitation | Supports capability-negotiated, structured user input nested within an operation. [S3] | Translate a live Muse permission request into a human prompt without completing the delegation call. |
| Muse TypeScript SDK | `@muse-code/sdk` drives `muse serve`, sessions, event streams, completion outcomes, and approval handlers. It is preview software and documents exact CLI/SDK version pairing. [S4] | Use one pinned adapter around the local runtime. |
| Muse authentication | An environment `META_API_KEY` precedes a stored key and stored browser session. [S5] | Audit credential provenance and prevent accidental environment overrides. |
| Muse subscription | The CLI-onboarding credential receives subscription coverage; additional keys are pay-as-you-go. [S6] | Use the existing onboarding credential, with no alternate-key or direct-API fallback. |
| Muse permissions | Approval review and execution sandboxing are separate controls; a read-only profile is documented. [S7] | Explicitly select and verify task permissions instead of inheriting remembered defaults. |

**Model selection:** Spark 1.3 is the requested worker model. Discover its exact supported identifier in the installed runtime. The configuration page checked for this design still illustrates `muse-spark-1.2`; it does not establish the correct 1.3 identifier or the options supported on the `serve` surface. Record requested and reported models and reject an unsupported selection instead of silently choosing a default. [S8]

Pin the Muse CLI and SDK to an exact tested pair. Pin other dependencies through the package lock. Use a supported Node LTS that satisfies all selected packages' engine requirements; do not select an obsolete runtime merely because it meets a minimum version.

### Compatibility record

Create `docs/compatibility.md` containing the tested OS, Node, Codex, Muse CLI, Muse SDK, and MCP SDK versions; negotiated protocol/capabilities; effective model and permissions; approval route; timeout observations; and subscription verification provenance. Retest the relevant cases after an upgrade. Do not require a generic compatibility framework.

## 3. Architecture and process ownership

Use a single Node package and one production server process:

```text
Codex CLI
  └─ muse-bridge serve --project /absolute/repository/path
       ├─ MCP stdio transport
       ├─ task coordinator and local task store
       ├─ permission/input router
       └─ Muse adapter
            └─ owned Muse CLI host for the active assignment

Optional, human-launched terminal utility:
  muse-bridge inspect / result / logs

Conditional fallback, only if native prompts are inadequate:
  muse-bridge approvals <-> private control socket in the running bridge
```

Codex's MCP documentation and the stdio specification support the parent-launched arrangement. Reserve the bridge's stdin and stdout exclusively for MCP. Capture the Muse child's streams separately; diagnostic output belongs on stderr or in task files. The client may hide stderr, so it is not a reliable approval interface. [S1, S9]

### Component responsibilities

| Module | Owns | Does not own |
|---|---|---|
| MCP adapter | Schemas, request context, elicitation, cancellation mapping, response delivery | Muse policy or task planning |
| Coordinator | Task IDs, admission, deadlines, idempotency, state transitions, finalization | Model reasoning |
| Muse adapter | Exact SDK integration, runtime events, completion interpretation, stop operations | Conversation-level orchestration |
| Approval router | Request identity, available choices, human reply validation, expiry | Automated permission decisions |
| Workspace module | Review preflight, worktree preparation, revision evidence, change manifests | Merging into the user's branch |
| Task store | Atomic task/result records, bounded event logs, recovery reads | A distributed ledger or scheduling database |

The coordinator must remain transport-independent enough for deterministic tests. A small interface and a fake adapter are sufficient; do not build a provider plugin framework.

Start the MCP server and advertise tools without launching Muse or making a billable request. Launch a Muse host only after accepting an assignment. Prefer one owned host per assignment for straightforward cleanup. Reuse a host only after a measured need establishes that startup overhead matters.

Acquire a single-owner project lease before admitting work. A second owner receives `PROJECT_IN_USE`; it does not silently join or steal the first connection. Use a proven lock primitive/library and test abnormal termination. Do not implement stale-lock recovery using a PID alone.

### Project binding

Bind the project at server launch, not through model-provided arguments. Canonicalize the root. Store a user-controlled profile outside the repository containing the approved runtime path, model selection, permissions, task limits, worktree root, and billing-verification metadata.

Task requests cannot replace executables, credentials, endpoints, workspace roots, or global permission policies. Profile changes take effect between tasks, never halfway through one.

## 4. Codex-facing tools

Expose `delegate_to_muse` for normal work. Add `muse_result` when persisted-result recovery is implemented. Do not expose a start/status/wait/cancel polling suite or a model-callable “approve” tool.

The following types are **bridge-owned proposed contracts**, not Muse SDK APIs. Implement equivalent runtime schemas with unknown-field rejection, bounded strings/arrays, and validation before filesystem or process operations.

```ts
export type DelegateRequest = {
  schema_version: 1;
  request_key: string;
  mode: "review" | "implement";
  objective: string;
  context: string;
  acceptance_criteria: string[];
  context_files?: string[]; // Project-relative references, not arbitrary host paths.
  allowed_paths?: string[]; // Task scope; not by itself a security boundary.
  base_commit?: string; // Full commit object ID; required for implement mode.
};

export type ExecutionStatus =
  | "completed" | "blocked" | "failed"
  | "cancelled" | "timed_out" | "interrupted";

export type DelegateResult = {
  schema_version: 1;
  task_id: string;
  request_key: string;
  execution_status: ExecutionStatus;
  worker_stop: "confirmed" | "unconfirmed" | "not_started";
  worker_assessment: "met" | "partial" | "unmet" | "unknown";
  summary: string;
  blockers: string[];
  error?: { code: string; message: string };
  questions: string[];
  model: { requested: string; reported?: string };
  workspace: {
    kind: "source_read_only" | "task_worktree";
    base_commit?: string;
    worktree_path?: string;
    stale: boolean;
  };
  changed_files: string[];
  checks: Array<{
    command: string;
    cwd: string;
    exit_code: number | null;
    evidence: "runtime_observed" | "bridge_observed" | "worker_reported";
    artifact_id?: string;
  }>;
  artifacts: Array<{
    id: string;
    kind: "report" | "diff" | "manifest" | "log";
    path: string;
    bytes: number;
  }>;
  output_truncated: boolean;
};
```

For version one, allow `review` first. Until implementation workspaces are enabled, return a clear unsupported-mode result for `implement`.

### Context contract

Codex provides enough information for an independent worker: objective, relevant decisions, scope, required output, and acceptance criteria. Muse does not inherit the Codex conversation automatically.

The bridge deterministically wraps this material with task identity, workspace, applicable constraints, and the expected report format. Include relevant repository instructions from the selected revision; record their provenance. Resolve context references within the project, reject traversal, and validate symlink targets. Do not copy arbitrary environment files or the entire conversation.

Muse's documented project-context loading depends on workspace trust and includes repository instruction files. Preserve the intended instructions, but treat trust as a user decision rather than silently trusting every new worktree. [S8]

Initial design limits: 64 KiB for the textual assignment envelope and at most 50 context-file references. These are adjustable bridge limits, not provider context-window limits. Refer to large files rather than embedding them automatically.

### Result semantics

`execution_status = completed` means the agent run completed, not that the work was correct. `worker_assessment` records the worker's claim. Verification evidence records what was actually observed. Codex decides whether the acceptance criteria are satisfied.

A persistent host's exit code or a sentence saying “done” is not the completion signal. Use the SDK's terminal turn outcome; a settled completion promise can represent an unsuccessful ending. [S4]

Ask Muse to end its assigned turn with a concise report. Parse it when valid, but preserve an honest `unknown` assessment when it is not. Do not launch an extra model call solely to repair report JSON or summarize logs. Derive change lists and observable checks from trusted runtime/bridge evidence where available.

Return at most 24 KiB of serialized result by default. Retain task identity, execution/stop status, blockers, failing checks, and artifact references before trimming optional prose. Keep the complete bounded local report separately. Never turn truncation into invalid JSON or omit a critical stop failure.

`muse_result` accepts a task ID or request key and a bounded section such as `result`, `manifest`, or a recorded artifact range. It never launches work and never accepts an arbitrary filesystem path. An active task returns `RESULT_NOT_READY` without instructions to poll. It can also retrieve retained details after a normal completion when Codex needs evidence beyond the compact response.

Use valid MCP tool results for operational failures; reserve protocol errors for malformed/unsupported protocol requests. Adopt a documented `isError` mapping and keep the result's semantic status authoritative. Do not advertise the delegation tool as unconditionally read-only or side-effect-free merely because review mode exists.

## 5. Pending-call execution and deadlines

The normal path is:

1. Validate the request and resolve the project/profile.
2. Check the request key, project ownership, admission limit, and preflight requirements.
3. Persist the accepted assignment before launching anything.
4. Prepare the workspace; start the owned Muse runtime and task session.
5. Submit one self-contained assignment; consume events and route human requests.
6. Await a terminal outcome or a stop condition.
7. Stop/close the owned runtime, collect available evidence, and persist the result.
8. Resolve the original MCP call, provided it has not been cancelled or disconnected.

An asynchronous wait must leave the Node event loop free for transport messages, cancellation, approval replies, and deadline handling. No synchronous “wait until done” loop.

Codex documents a 60-second default MCP tool timeout. Start with these proposed application settings: a 30-minute wall-clock task budget and a 35-minute MCP timeout. Include preparation and approval waits in the task budget, reserve finalization time, and verify SDK-side deadlines as well. These are configurable product defaults, not provider limits. [S1]

Trigger stopping early enough to allow bounded cleanup before the 30-minute bridge deadline. A useful initial allocation is up to 60 seconds for final stop/collection within that budget. A user approval request expires at the earlier of five minutes or the remaining task deadline. Tune these after real use.

Optional MCP progress notifications use a client-supplied progress token; they do not complete the tool call. Emit sparse state changes, not a transcript or artificial percentage. Do not depend on progress extending the client timeout. [S10]

The waiting test must inspect available Codex traces, not infer inactivity from a quiet terminal. It passes when there are no automatic status tools or bridge-triggered model turns during the assigned wait, and one result resumes the same call. Where traces cannot establish model-request counts, report that observability limit. This design makes no blanket claim that all account usage stops or that unrelated background agents are paused.

If the actual client repeatedly yields long tools to the model, record the incompatibility. Do not hide it with a polling loop or quietly replace the CLI with App Server. Use a supported client version/configuration, or document a separate architecture change.

## 6. Human approvals and questions

### Preferred path: a prompt inside Codex

At MCP initialization, inspect negotiated capabilities. Attempt form elicitation only when the client advertises it. Also check the effective Codex approval policy: a supported feature can still be auto-rejected or reviewed by an automated reviewer. The intended path is a direct human response, not another model deciding the permission. [S2, S3]

For each Muse request, preserve task/session/turn identity, vendor request ID, action, workspace, offered choices, and expiry. Show the complete security-relevant command or operation and its requested scope. Prefer an explicit allow-once or deny decision where Muse offers those choices. Do not invent a choice or select one by array position.

Use a simple enum form containing the actual supported decision mapping. Submitting the form is not itself approval: accept only a valid returned choice. `decline`, dismissal, invalid content, timeout, and stale replies never become authorization. Resolve or deny a still-live request through the Muse adapter; otherwise stop the task safely. An action denial can let Muse take another permitted approach, but repeated requests for the same denied action should terminate as blocked rather than create a prompt loop.

Avoid displaying the same approval simultaneously through two routes. Queue multiple pending approvals and retain their individual identities. Cancellation invalidates all unresolved replies.

Login, account recovery, and secrets stay in the normal Muse authentication flow outside the bridge. Do not request keys, passwords, or tokens in MCP forms. [S3]

### Conditional fallback: terminal approvals

Only implement this path if the installed client's prompt behavior fails the compatibility test or a required form cannot be represented safely.

`muse-bridge approvals --project /absolute/repository/path` runs in a separate human terminal and attaches to the active bridge through a private Unix socket. It shows pending requests and sends one validated decision. The server remains owned by Codex; this does not introduce a daemon. The terminal command subscribes to events rather than involving Codex in status checks.

Before starting a task that may require this route, require an attached approval terminal. If it disconnects, keep actions denied/pending for a short bounded reconnect grace, then stop as blocked. Do not let a worker wait indefinitely for a hidden prompt.

Protect the socket and state directory with owner-only permissions; bind requests to project, server instance, task, and request identity. Do not expose approval mutation as an MCP tool. Do not put credentials or authorization tokens into the model-visible context.

This is a local single-user workflow, not proof of human identity against malicious same-user processes. Agents with unrestricted host access could impersonate terminal tooling. Enforce the selected sandbox boundaries and document that limit; an `isatty` check alone is not a security boundary.

### Domain questions are different

A worker may need a requirement clarified rather than permission to run a command. If the selected SDK supports a reliable structured user-question channel, route a bounded non-secret question through the same human-input abstraction. Otherwise end as `blocked`, include the exact question, and let Codex ask the user. That is a meaningful continuation, not polling. A later assignment includes the answer and an explicit link to the previous task.

Do not assume the interactive Muse TUI can attach to an arbitrary SDK session. There is no PTY scraping or terminal-keystroke automation in this plan.

## 7. Subscription and permission preflight

The bridge uses the user's authenticated Muse CLI, not a Meta model API client. Leave the onboarding credential in Muse's supported storage. Never extract it for use by Codex or a custom provider implementation.

Build a minimal child environment from explicitly allowed values. Preserve the paths needed for the existing Muse login, but remove unintended `META_API_KEY` overrides and unrelated service secrets. Inspect effective credential provenance through supported diagnostics; removing an environment variable does not eliminate the possibility of a stored-key override. Do not delete, replace, or rewrite the user's authentication state. [S5]

Before enabling real assignments, establish that the selected account/credential path is subscription-linked. Where the provider supplies no supported machine-readable proof, require a dated user confirmation based on the account's usage/billing view. Record `user_confirmed`, `provider_verified`, or `unverified` accurately. A successful login is not proof of subscription coverage. Revalidate after known account, credential, runtime, or configuration changes. [S6]

There is no alternate-key retry, direct model API, automatic purchase, or pay-as-you-go fallback in the bridge. Quota exhaustion, authentication failure, or billing uncertainty returns a blocked result with an actionable explanation. The bridge cannot guarantee a provider-side spending rule that the provider does not expose or enforce.

Keep Muse's effective execution sandbox enabled. Select read-only permissions for review mode and an explicit human-review profile for implementation mode. Muse documents an automated approval reviewer as well as manual review, and remembers permission choices; therefore do not rely on a remembered default to produce human prompts. The local adapter must verify the effective settings on the SDK/serve surface. [S7]

Use the narrowest practical worker toolset. Prevent the bridge from being registered back into Muse, and exclude recursive cross-agent delegation. Disable optional automated reviewers, observers, or child-agent features where supported and unnecessary for the assignment. Record limitations rather than claiming that a prompt alone enforces tool restrictions. The one-worker product scope should not secretly become an unbounded hierarchy.

Read-only task scope, write confinement, network permission, and secret access are separate concerns. A sandbox that prevents writes may still permit reads. Never describe a worktree or owner-only directory as sufficient protection from a same-user unrestricted agent. Keep credential values out of prompts, results, logs, and diagnostics, and test actual access boundaries with harmless fixtures.

“Local bridge” does not mean offline inference. The bridge should warn during setup that task material processed by Muse may leave the machine through its normal provider connection. Do not add separate telemetry or transcript uploading.

## 8. Workspace contract

### Review mode: first useful release

Use the configured project with an enforced read-only worker profile. Record the checked-out commit and the relevant dirty/untracked-file state. A review may include the user's current uncommitted text, but report that explicitly rather than describing it as a committed snapshot.

Record digests for the scoped input files before and after the run and detect source changes. Set `workspace.stale` when drift is observed. This check is best-effort for a live checkout, not a guarantee of an immutable snapshot. Exact snapshot review can be added later when required.

Review mode initially covers inspection and analysis. Tests or tools that write caches, generate files, install dependencies, or modify the project belong in an appropriately provisioned implementation/scratch workspace. Do not relax read-only permissions merely to make a review command succeed.

### Implementation mode: isolated task worktree

Require a clean source checkout, including no untracked non-ignored files, and an explicit full commit object ID. Resolve and validate the commit with Git without assuming a fixed object-ID length. An intentionally older committed base is allowed only when the assignment states that choice; normally use the clean current HEAD.

Create a bridge-owned task branch and worktree under a user-approved root. Git documents that linked worktrees share repository administration; they provide separate working directories, not a complete security boundary. [S11]

Configure the worker's allowed writes to its task worktree and required scratch locations. Keep the original working directory and repository administration protected under the effective policy. The bridge performs worktree administration outside worker-generated shell strings, using fixed executable paths and argument arrays.

Do not automatically stash, checkpoint, or commit the user's dirty checkout. Return `DIRTY_SOURCE` with the specific condition. The user/Codex can then make an explicit checkpoint decision. Likewise, do not copy the user's ignored secrets or development environment into a worktree.

Handle workspace trust and dependency setup explicitly. First-use trust is surfaced to the user. Necessary installation commands pass through the selected approval and network policy. Unsupported submodule, LFS, or unusual checkout configurations receive an explicit preflight error rather than an incomplete task view.

### Artifacts and integration

The retained worktree is the authoritative implementation artifact. Collect a manifest covering modified, created, deleted, renamed, symlink, and relevant binary files. Include file modes and hashes where needed to review completeness. A tracked-file `git diff` alone is not the complete output when new files exist.

Record ignored/generated output separately and do not export secrets or large dependency trees. Detect changes outside declared task scope and flag them for review; narrow `allowed_paths` is only an enforceable boundary if the runtime actually enforces it.

The bridge does not merge, cherry-pick, or overwrite the user's branch. Codex reviews the result, checks that the source has not diverged, and integrates accepted work through the ordinary repository workflow. When exporting a patch, prove it includes the intended new files and binaries rather than silently omitting them.

Failed, cancelled, and timed-out tasks can still contain useful changes. Preserve and label them. Worktree deletion is an explicit human action after integration or discard, not a side effect of receiving a tool result.

Ensure Codex can read the compact result and relevant artifacts under its own permissions. Use bounded `muse_result` retrieval where appropriate; never disable Codex's sandbox merely to expose logs. Integrating a worktree still requires the user's normal filesystem/Git permissions.

## 9. Lifecycle, cancellation, and recovery

### State model

Use a small explicit reducer. Execution status and response-delivery status are separate.

```text
accepted -> preparing -> running -> finalizing -> terminal
                           |
                           +-> awaiting_input -> running
                           |
                           +-> stopping -> finalizing -> terminal

Terminal outcome:
  completed | blocked | failed | cancelled | timed_out | interrupted

Independent stop evidence:
  confirmed | unconfirmed | not_started

Independent delivery evidence:
  not_attempted | send_attempted | transport_failed
```

Stopping/failure transitions must also work during preparation and finalization. There is one terminal outcome per task. Do not label “response sent” as proof that Codex received or consumed it.

### Cancellation sources

Codex request cancellation, transport EOF, bridge termination, deadline expiry, and an explicit user control action all enter the same stop path with a recorded reason. Keep ownership scoped to the active task and owned host.

Request supported Muse cancellation first, then close the owned runtime. Verify the exact SDK stop surface during implementation rather than inventing a method name. Use a bounded grace period, followed by tested termination of only bridge-owned processes if necessary. Do not use process-name-wide kill commands or trust reused PIDs.

A cancellation request is not stop confirmation. If cleanup cannot prove that the worker stopped, return/persist `worker_stop = unconfirmed`, flag the project for intervention, and refuse another assignment until reconciled. Preserve partial artifacts even on this path.

For client-cancelled MCP requests, suppress a late tool response and retain the result locally. A local user cancellation can return a structured cancelled result when the original MCP request remains active. MCP documents cancellation races and advises against responding to an already-cancelled request. [S12]

### Parent death and terminal closure

Version one is parent-owned: closing Codex should stop its active worker, not turn the task into detached work. Test graceful EOF, interrupt, termination, and abrupt bridge death separately.

Do not assume a JavaScript `finally` block handles an uncatchable kill. The compatibility test must establish whether SDK transport loss terminates the Muse host and its running command descendants. If it does not, add the smallest Linux-specific process-supervision measure that fixes the observed orphan problem and test it. This may be a narrow supervisor around the owned process tree; it is not permission to build a general service manager.

Until stop-on-parent-loss is proven, restrict live tests to a disposable workspace. Recovery must not silently start a replacement for an old worker whose state is unknown.

### Deadlines and suspend/resume

Persist the wall-clock deadline, use appropriate elapsed-time accounting while running, and reconcile both after laptop suspend or transport interruption. Approval waits count toward the deadline. No automatic deadline extension, fresh prompt submission, or retry because a timer fired.

If completion and cancellation race, commit one terminal outcome through the coordinator and treat subsequent events as late evidence. Never attach a stale approval to a new task.

## 10. Persistence and idempotency

For this single-writer release, use private task directories containing JSON records and bounded newline-delimited event logs. A SQLite database is not required. This avoids adding a native dependency solely for a small local task history.

Proposed layout:

```text
~/.config/muse-bridge/
  projects/<project-id>.json

~/.local/state/muse-bridge/
  projects/<project-id>/
    tasks/<task-id>/
      request.json
      state.json
      result.json
      events.ndjson
      artifacts/
    compatibility.json

<user-approved-worktree-root>/
  <project-id>/<task-id>/
```

Use the corresponding XDG locations when defined. Use owner-only directory/file permissions and validate roots before writing. Task IDs are bridge-generated safe identifiers; model-supplied request keys never become raw pathnames.

Write accepted requests and terminal results atomically, with crash-appropriate flushing at critical boundaries. A result becomes durable before MCP delivery is attempted. On restart, validate a complete saved result even if the last state-file update was interrupted. A partial event-log tail is not a complete result.

Keep request-key uniqueness under the project lease. An index may accelerate lookup, but the task records are authoritative; rebuilding an index must not launch work.

### Request-key rules

The logical key is `(project_id, request_key)` plus a canonical hash of the submitted assignment. Persist it before worker launch.

| Situation | Required behavior |
|---|---|
| Same key, same request, task active | Attach to the same task only under valid ownership; never spawn again. |
| Same key, same request, task terminal | Return the saved result, including its original revision and profile provenance. |
| Same key, different request | Return `REQUEST_KEY_CONFLICT`. |
| New intentional attempt | Require a new key and optionally record the predecessor task ID. |
| Restart with incomplete task | Mark interrupted/reconcile; do not resubmit its prompt automatically. |

Do not claim global exactly-once execution. A crash between starting an external side effect and recording its observation can leave uncertainty. This design prevents routine duplicate launches and makes uncertain outcomes explicit.

`muse_result` and the terminal `result` command return saved material without inference. Recovery of a Muse session does not recreate a broken Codex MCP request. Automatic cross-process resume remains outside version one.

### Retention and output controls

Bound individual event records and total logs; proposed initial limits are 256 KiB per stored event and 20 MiB of diagnostic logs per task. Preserve terminal status and evidence summaries separately so log truncation cannot erase failure information. Stop or degrade logging safely under disk pressure; do not report success when persistence failed before delivery.

Render terminal output as untrusted text, stripping unsafe control sequences from human-facing summaries. Redact known secret fields before persistence, but do not claim regex redaction guarantees the absence of all secrets. Diagnostic exports are explicit and previewable. Keep full native Muse retention settings visible because bridge cleanup does not necessarily remove vendor-managed session records.

Provide explicit cleanup by task. Retained worktrees and unintegrated artifacts require an extra confirmation. Do not silently delete work based only on its age.

## 11. CLI, configuration, and repository structure

These commands are proposed product commands to implement; they are not available until the package exists.

```text
muse-bridge configure --project <path>
muse-bridge doctor --project <path>
muse-bridge doctor --project <path> --live
muse-bridge serve --project <path> --profile <profile-file>
muse-bridge inspect --project <path>
muse-bridge result --project <path> --task <id>
muse-bridge logs --project <path> --task <id> --follow
muse-bridge cleanup --project <path> --task <id>

Conditional fallback only:
muse-bridge approvals --project <path>
```

`configure` resolves executables and the project, prepares a reviewed profile, and prints a proposed Codex configuration change. Preserve unrelated settings and back up any file before an explicitly approved write. Configuration never purchases access or silently changes either CLI's global permissions.

`doctor` is local and non-billable by default: versions, paths, profile validation, previous compatibility evidence, and supported non-inference diagnostics. Clearly mark checks that require an actual MCP connection. `--live` is explicit opt-in and runs only a bounded disposable task after credential confirmation.

Inspection/result/log commands read task records without starting an agent. `logs --follow` follows local output; it does not ask a model for progress. In the preferred native-prompt configuration, no control socket is needed for these reads.

Example Codex MCP entry, after replacing paths with the installation's actual values:

```toml
[mcp_servers.muse_bridge]
command = "/absolute/path/to/node"
args = [
  "/absolute/path/to/muse-bridge/dist/cli.mjs",
  "serve",
  "--project", "/absolute/path/to/repository",
  "--profile", "/absolute/path/to/project-profile.json"
]
startup_timeout_sec = 10
tool_timeout_sec = 2100
enabled_tools = ["delegate_to_muse", "muse_result"]
```

The MCP server configuration fields above are documented by Codex; the executable and argument contract are this design. Emit only tools available in the installed bridge release. [S1]

Document the required human-prompt behavior separately from the MCP entry. Verify that MCP elicitation is allowed and that the effective reviewer is the user. Do not overwrite an existing granular approval policy wholesale to achieve this. [S2]

### Repository layout

```text
src/
  cli.ts                  command parsing and composition
  contracts/              runtime schemas and shared result types
  mcp/                    server, tools, client capability handling
  core/                   coordinator, state reducer, admission, deadlines
  muse/                   the only imports of @muse-code/sdk
  approvals/              native elicitation and conditional terminal route
  workspace/              validation, worktrees, manifests
  store/                  atomic records, request keys, bounded logs
  diagnostics/            version checks and redacted reports
  control/                conditional approval socket; omit when unnecessary

tests/
  unit/
  integration/            fake Muse adapter and mock MCP client
  live/                   explicitly enabled installed-CLI tests

scripts/
  probe-wait.ts
  probe-muse.ts

docs/
  design.md
  compatibility.md
  setup.md
  recovery.md
```

Use strict TypeScript, a runtime schema validator, the official MCP TypeScript SDK, and the pinned Muse SDK. Resolve the exact MCP package/import surface against the selected SDK release; do not copy guessed imports. Keep development dependencies and the production package small. No database, HTTP server, frontend bundler, PTY library, or Electron rebuild is required by this architecture.

### Suggested Codex server guidance

Return concise server instructions and a tool description that establish this workflow. Keep crucial guidance at the beginning. A proposed text is:

```text
Use delegate_to_muse for bounded assignments with a clear scope and acceptance
criteria. Supply self-contained context and a stable request_key. The call stays
pending until the task ends; await that result. Human permissions are handled
through the bridge's approval route. Treat worker claims as evidence to review,
not as acceptance. Use muse_result to recover or inspect retained results, not
for periodic status checks. Review and integrate accepted changes yourself.
```

Include examples of good assignments in `docs/setup.md`: a scoped read-only audit, test generation for an identified module, or a small implementation against a known commit. Prefer positive workflow instructions over a large list of prohibitions. Codex retains responsibility for choosing when delegation is worthwhile.

## 12. Implementation sequence

Build the smallest working path first. Resolve only uncertainties that could change the architecture or undermine billing, permissions, or lifecycle safety. Broader optimization and platform work follow observed needs.

### Phase 0 — Prove the integration contract

Build a minimal MCP wait probe and a Muse adapter probe in a disposable project. Record exact versions and evidence in `docs/compatibility.md`.

Prove these design-changing assumptions:

- A deliberately delayed tool call, held beyond 60 seconds with an increased timeout, returns through the original Codex request without automatic status polling. Repeat with a several-minute wait.
- The pinned SDK controls the local Muse runtime, selects the requested supported model, and returns a terminal outcome under the confirmed subscription-linked account path.
- A real permission request reaches the human through Codex and resumes only after the selected valid reply. Check denial, dismissal, and Codex policy auto-rejection as well as approval.
- Cancellation and parent/transport loss stop the owned runtime and a harmless command descendant, or reveal a specific supervision gap to fix.
- Review permissions actually prevent a harmless fixture write; documented configuration is not enough.

**Deliverable:** Reusable probes, a compatibility record, and a narrow decision on any unsupported behavior. No desktop UI, generic orchestration framework, or database.

**Exit:** The blocking handoff, credential/model path, human-input route, and bounded process ownership are established for the chosen environment. Implement the terminal approval fallback only if this test requires it. Provider verification may remain explicitly user-confirmed where no supported automated check exists.

### Phase 1 — Single-worker read-only vertical slice

Implement the MCP tool/schema, coordinator, project binding, minimal durable task records, Muse adapter, and the selected approval path. Include basic cancellation and a finite deadline immediately; these are not optional afterthoughts.

Use one repository review with explicit acceptance criteria. Return a compact report with task identity, model evidence, observed checks, and any staleness.

**Exit:** The complete success criterion in section 1 works from the user's real Codex CLI. The bridge starts automatically. Repeating the same request key does not launch another worker. No manual result copying or polling is required.

### Phase 2 — Reliable lifecycle and recovery

Complete stop escalation, deadline accounting, denial/dismissal handling, request-key conflicts, output limits, interrupted-task reconciliation, and persisted-result retrieval. Add `inspect`, `result`, and local log viewing. Add `muse_result` to Codex for recovery and bounded evidence retrieval.

Test crashes before launch, during work, during approval, and after result persistence but before delivery. Keep unknown stop states visible and block replacement work until resolved.

**Exit:** Success, failure, timeout, cancellation, quota/authentication problems, and disconnect all leave an accurate record. No branch silently changes billing, retries the assignment, loses useful partial work, or claims receipt by Codex without evidence.

### Phase 3 — Implementation workspaces

Implement clean-source checks, explicit commit validation, task worktrees, workspace trust, dependency setup, artifact manifests, and integration guidance. Start with a small change in a disposable Git repository, including a new file and a failing test.

**Exit:** Muse changes only the intended task workspace under the effective policy. The original checkout stays unchanged. The returned artifacts account for the intended new/modified/deleted/binary content, failing checks remain failures, and Codex can review and integrate the result deliberately.

### Phase 4 — Repeatable installation

Package the Node CLI; add reviewed configuration generation, non-billable diagnostics, explicit live verification, recovery documentation, and cleanup. Confirm the installed build resolves the correct binaries under the environment inherited from Codex.

**Exit:** A fresh terminal on Linux Mint can run the installed package and complete delegation, human approval, cancellation, recovery, and implementation tests without development-only assumptions. No Electron, PTY, browser, or separate startup service is present.

Ordinary CI runs deterministic unit/integration tests with fake worker events. Real subscription tests are explicit opt-in and do not run on every commit. Full package/release workflows run at release or manual checkpoints. Evaluate completion against the current phase rather than implementing future requirements to call a slice done.

## 13. Acceptance matrix

| Case | Expected result |
|---|---|
| Cold start | Codex launches the bridge; initialization does not start inference. |
| Long task | Original call remains pending and resolves once; no automatic model status loop. |
| Human approval | Correct task/action/choices appear; only a valid live human reply authorizes the action. |
| Denied/dismissed approval | Action remains unauthorized; alternate permitted work or a blocked result follows. |
| Elicitation unavailable | Preflight selects the tested fallback or reports the missing route before hidden waiting. |
| Automated approval reviewer configured | Diagnostics surface the mismatch; human-review operation is not falsely claimed. |
| Approval timeout | Deadline applies; task is stopped/blocked; a late approval is ignored. |
| Worker asks a requirement question | Supported input route or a blocked result; no pretend permission or fabricated answer. |
| Runtime completes unsuccessfully | Failed outcome is preserved despite a settled completion promise. |
| Test fails | Exit code/evidence survives normalization; task completion is not reported as test success. |
| Worker claims success without evidence | Assessment stays worker-reported; unknown verification is not promoted to observed. |
| Model unavailable or mismatched | Clear error/diagnostic; no silent model fallback. |
| Credential override present | Sanitized launch and explicit provenance check; no secret copied to Codex. |
| Quota/authentication problem | Blocked result; no alternate key, API fallback, or automatic replay. |
| Same request repeated | At most one admitted worker; prior terminal result is reusable. |
| Same key, changed assignment | `REQUEST_KEY_CONFLICT`, without starting Muse. |
| Second project owner | Clear `PROJECT_IN_USE`; no ownership theft. |
| Codex cancels | Cancellation propagates; no late response to the cancelled request. |
| Codex/bridge dies | Owned worker/descendants stop, or stop uncertainty is explicit and replacement is blocked. |
| Task deadline | Bounded shutdown; retained partial artifacts; meaningful timeout result when transport remains live. |
| Crash after result save | Result is retrievable without inference or duplicate work. |
| Dirty implementation source | `DIRTY_SOURCE`; no stash, commit, or source edit by the bridge. |
| Review source changes | Staleness is detected for scoped inputs and disclosed. |
| Worktree implementation | Source checkout preserved; changes and new files fully represented. |
| Out-of-scope access | Enforced restrictions reject the fixture operation; unsupported enforcement is disclosed. |
| New worktree trust/dependencies | Human/policy route is explicit; no uncontrolled inherited hooks or secrets. |
| Completion/cancellation/input race | One terminal outcome; stale messages cannot affect the next task. |
| Output flood/disk full | Bounded storage and clear persistence failure; no corrupted success result. |
| Malicious paths/control sequences | Traversal and symlink escapes rejected; terminal summaries sanitized. |
| Laptop suspend | Deadlines reconciled; no replacement task or fresh model prompt launched automatically. |
| Installed package | The same contract passes outside the development checkout. |

### Test approach

Use a scripted fake Muse adapter to emit text, command evidence, approvals, failures, and delayed completion. Use a mock MCP client to accept, decline, dismiss, disconnect, or cancel at precise points. Test the state reducer and request-key behavior with deterministic schedules and fake clocks. Keep at least one real long-wait test because a fake client cannot prove Codex's behavior.

Negative tests must verify the denied operation did not occur, not merely that an error was printed. Process cleanup tests must observe owned descendants. Result-integrity tests must compare exported manifests to actual workspace content.

## 14. First implementation assignment

The following can be given directly to an implementation agent together with this document:

```text
Implement the Codex–Muse CLI Bridge described in this plan for Linux Mint.

Keep the real Codex CLI as the user's conversation interface. Build one Node/
TypeScript MCP server that Codex launches automatically. Use the authenticated
local Muse Code runtime through an exact tested SDK/CLI pair. Keep one delegation
call pending until its terminal result; handle execution and human input without
status-polling model turns. Use the existing subscription-linked credential path
and provide no alternate model API or paid fallback.

Start with Phase 0 in a disposable project. Record exact versions and evidence
for long-call waiting, requested model selection, subscription provenance, human
approval, cancellation/parent loss, and read-only enforcement. Prefer native
Codex MCP elicitation. Build terminal approvals only when the compatibility
probe establishes that they are needed.

Then ship the Phase 1 read-only vertical slice with a finite deadline, basic
cancellation, durable results, and request-key deduplication. Use fake worker
events for routine tests. Complete later phases as separate acceptance-driven
increments. Keep workspace integration under Codex/user control.

Use the current SDK's actual types and documented methods. Keep SDK-specific
logic inside the Muse adapter. When a required capability is unsupported,
record the concrete failure and the smallest design change needed; do not hide
it with polling, unrestricted permissions, or a replacement chat interface.

Deliver working source, tests, setup/recovery instructions, the compatibility
record, and a summary of completed acceptance cases and remaining limitations.
```

## 15. Sources and verification scope

The following primary documentation was checked for this plan on September 19, 2026. Citations establish documented interfaces and constraints; proposed limits, schemas, component boundaries, and implementation phases are design decisions. No live test was run against the user's machine or account while preparing this document.

The pinned MCP specification references below are the 2025-11-25 revision, not a claim that every client implements every feature or that this is the newest revision. Negotiate and record the actual supported version.

```text
[S1] OpenAI — Codex Model Context Protocol configuration
https://developers.openai.com/codex/mcp/
Current redirected documentation:
https://learn.chatgpt.com/docs/extend/mcp?surface=cli

[S2] OpenAI — Configuration Reference
https://developers.openai.com/codex/config-reference/
Current redirected documentation:
https://learn.chatgpt.com/docs/config-file/config-reference
Relevant keys: approval_policy.granular.mcp_elicitations, approvals_reviewer.

[S3] Model Context Protocol — Elicitation, 2025-11-25
https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation

[S4] Meta — Muse Code TypeScript SDK README
https://raw.githubusercontent.com/meta-models/muse-code-sdk/main/clients/sdk-ts/README.md

[S5] Meta — Authentication and billing
https://dev.meta.ai/docs/muse-code/auth

[S6] Meta — Muse Code subscriptions
https://dev.meta.ai/docs/muse-code/subscriptions

[S7] Meta — Permissions and safety
https://dev.meta.ai/docs/muse-code/permissions

[S8] Meta — Configuration and context
https://dev.meta.ai/docs/muse-code/configuration

[S9] Model Context Protocol — Transports, 2025-11-25
https://modelcontextprotocol.io/specification/2025-11-25/basic/transports

[S10] Model Context Protocol — Progress, 2025-11-25
https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/progress

[S11] Git — git-worktree
https://git-scm.com/docs/git-worktree

[S12] Model Context Protocol — Cancellation, 2025-11-25
https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation
```
