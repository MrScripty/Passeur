# Codex implementation adapter — qualification candidate

## Authority and scope

Owner: `src/agents/codex/`. The adapter uses a task-owned local Codex app-server over stdio. It implements neither an agent loop nor a remote/shared daemon. It is Linux-only and advertises `implement`, not restrictive review. Ordinary support is not yet qualified; explicit `experimental_opt_in: true` and `subscription_confirmed: true` are required for operator-directed qualification.

The native protocol was checked against the official `openai/codex` source revision `7c1e485c871dd028a359e9e12d81cb38150b68c5`. Canonical generated files are under `codex-rs/app-server-protocol/schema/typescript/v2/`: `ThreadStartParams.ts`, `ThreadStartResponse.ts`, `SandboxMode.ts`, `AskForApproval.ts`, `CommandExecutionRequestApprovalParams.ts`, `ConfigReadParams.ts` and `ListMcpServerStatusParams.ts`. Official app-server documentation is at `https://developers.openai.com/codex/app-server`.

The consumed projection uses native `sandbox: "workspace-write"` and `approvalPolicy: "on-request"`; returned sandbox policy uses `type: "workspaceWrite"`. Stdio is newline-delimited JSON without a `jsonrpc` field. `protocol.ts` owns decoders for the specific native fields used to authorize or classify work. Extra native metadata is deliberately not retained or used as authority. This is a narrow handwritten projection against upstream authority, not generated full-protocol bindings. Native evolution outside that projection requires explicit revision and qualification rather than permissive shape fallback.

## Operator configuration

A registration has `adapter_id: "codex"`. Its strict options are:

| Field | Meaning |
| --- | --- |
| `codex_bin` | Approved executable path/name, never supplied by a task. |
| `codex_home` | Absolute dedicated, operator-authenticated CLI home outside the task workspace and distinct from the calling agent's home. |
| `model` | Exact operator-selected native model ID. |
| `network_access` | Requested native workspace-write network policy; defaults false. |
| `allow_command_escalation` | Defaults false. Enabling permits human approval of one exact native command, potentially outside the sandbox; not a persistent rule. |
| `subscription_confirmed` | Must be true; an operator assertion, not provider billing proof. |
| `experimental_opt_in` | Must be true; authorizes use of the unqualified implementation candidate, not a relaxation of its enforced checks. |

No credentials are copied from the caller or saved in task snapshots. Authentication is an explicit operator action outside Passeur. Native `account/read` must report ChatGPT rather than API-key authentication. Command environment excludes alternate API keys and hook-bypass variables. No API-key, account, model, provider or permission fallback is provided.

## Effective controls

Startup requests disabled MCP registrations, multi-agent tools, apps/plugins and web search, plus user-routed approvals and the selected sandbox. Before submitting a turn, the adapter checks effective `config/read`, the actual thread model/workspace/approval/sandbox projection, and an empty complete MCP inventory. Missing/mismatched facts block the task. Unsupported policy amendments, external environment grants and persistent permissions are rejected. Command escalation is declined automatically unless explicitly enabled; it still requires the current task-correlated human decision. File changes use one-operation approval.

These preflight checks do not prove that an arbitrary installed Codex build enforces every requested feature flag. In particular, plugin/tool availability must be inspected during native qualification; a reported `disabledPluginIds` list is not substituted for enforcement. Required real-runtime controls remain acceptance blockers. A worktree and isolated CLI configuration are not protection against arbitrary same-user shell activity.

## Lifecycle and diagnostic bounds

One run owns its process from spawn through initialization, account/config checks, thread/turn, correlated callbacks and close. RPC frames are bounded at 1 MiB; outstanding requests and callbacks are bounded at 32 each. UTF-8 decoding is strict; malformed or unmatched messages fail explicitly. Native stderr is drained without retaining potentially sensitive text.

On cancellation, a bounded `turn/interrupt` is attempted and then close owns stop evidence. The adapter signals only its owned child handle. It observes process-group disappearance but never sends a guessed negative-PID signal after parent exit. Surviving descendants or undrained callbacks/writes produce `unconfirmed`; the repository freezes replacement execution and retains resources for operator reconciliation. Parent loss is not claimed to terminate every descendant automatically.

## Evidence and remaining qualification

`tests/native/` exercises actual Node subprocesses implementing controlled protocol peers. `tests/unit/codex-adapter.test.ts` drives the real adapter with a separately scripted peer and strict report parsing when dependencies are installed. Controlled peers prove the selected local projection and lifecycle, not the native Codex implementation.

Before supported release: install the declared pinned dependencies; execute the full adapter/MCP/store suites; run the exact installed Codex build with a dedicated authenticated home; inspect effective tool isolation and native permissions; verify ordinary hooks/commits, approvals, cancellation and descendants with an independent observer; record actual versions and limits. Use the shared installed-host procedure and opt-in registered-agent probe. This package did not perform live inference, native credential use, fresh-session skill evaluation or independent external review.

No new package dependency was added. Node's process/stream APIs implement the small app-server stdio framing module; this is not a general JSON-RPC framework or a claim of transport coverage beyond the documented subset.
