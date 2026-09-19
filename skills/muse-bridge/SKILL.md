---
name: muse-bridge
description: Set up and use this repository's Muse MCP bridge when an agent needs to configure Codex delegation, delegate a bounded review or implementation task to Muse, recover a retained Muse result, or diagnose bridge setup.
---

# Muse Bridge

Use the real Codex conversation as the owner of the work. Muse receives one bounded assignment through `delegate_to_muse`; await that tool call until it returns, review its evidence, and integrate accepted changes through the normal repository workflow.

## Choose the path

- For installation, MCP registration, version checks, or setup failures, read [references/setup.md](references/setup.md).
- For an ordinary assignment, follow the delegation workflow below.
- For interrupted work or evidence beyond the compact response, use `muse_result` once or the local `inspect`, `result`, and `logs` commands. Read `docs/recovery.md` when shutdown is unconfirmed or a task record is incomplete.

## Delegate

Delegate when a self-contained task benefits from an independent worker. Keep responsibility for planning, acceptance, and integration in Codex.

Build `delegate_to_muse` input with:

- a unique, stable `request_key`; reuse it only for the identical request;
- `review` for inspection and analysis, or `implement` for changes in an isolated worktree;
- a bounded objective and the decisions Muse cannot infer from this conversation;
- concrete acceptance criteria;
- project-relative `context_files` and `allowed_paths` where they sharpen scope;
- the full commit object ID for `implement` mode.

The call remains pending through Muse execution and human permission prompts. Await it. Do not start a polling loop. A human approval form authorizes only the exact live choice returned by Muse.

Treat `execution_status: completed` as the end of the worker run. Assess the result from `worker_assessment`, checks, changed files, artifacts, staleness, and stop evidence. Inspect the retained worktree before integrating implementation results. Preserve failed or partial work when it is useful.

Use `muse_result` for recovery or a bounded artifact read after a task has ended. An active task returning `RESULT_NOT_READY` is a state report, not a reason to poll.

When `worker_stop` is `unconfirmed`, reconcile the process and workspace before attempting another assignment. The bridge intentionally blocks replacement work until that task record is explicitly cleaned up.
