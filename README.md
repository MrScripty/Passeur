# Passeur

A local TypeScript/Node MCP bridge: Codex delegates independent assignments to concurrent Muse CLI workers. Each implementation worker performs its scoped verification and ordinary Git commits. Passeur identifies the committed work and manages its processes, worktrees and disposition records.

Passeur does not select or run a delegated repository's tests, require a Codex review after each worker, group tasks by feature, merge contributions, create PRs, or implement a repair loop. Repository instructions/hooks and the workers own scoped verification. Codex owns integration, broader testing and acceptance.

## Setup

Use a supported Node runtime satisfying the pinned dependencies, Git, Codex CLI and the compatible authenticated Muse CLI. Dependency versions have not changed in this update.

```sh
npm ci
npm run check
npm test
npm run build
```

Configure a project interactively, then start its MCP server:

```sh
./passeur setup /path/to/project
./passeur start /path/to/project
```

The project defaults to the current directory. Setup offers to install the Codex MCP registration automatically, preserving unrelated Codex settings and backing up an existing configuration. For a profile created by an earlier version, run `./passeur register-codex /path/to/project`. Restart Codex afterward and use `/mcp` to confirm the tools appear.

See [setup](docs/setup.md) for profiles and MCP registration. New execution requests use **schema version 2**. Existing profile files keep version 1 and acquire documented defaults: two active workers, eight queued tasks. Lower `max_workers` explicitly when required by your machine or account.

## Tools

| Tool | Purpose |
| --- | --- |
| `delegate_to_muse` | Await one independent task through its original MCP call. |
| `delegate_to_muse_batch` | Submit up to eight independent assignments and await their separate outcomes; no common feature or test gate is implied. |
| `muse_result` | Read retained evidence and current resource availability in bounded ranges. |
| `muse_finalize` | Record external integration, retain, or explicitly archive a stopped task; safely retire only owned resources. |

For implementation, supply the exact `base_commit` and full local `target_ref`. The target is metadata, not permission for Passeur to modify it. Results distinguish execution status, Git delivery facts and resource disposition. A `committed` result is not certification of correctness, hooks or standards compliance.

Codex can run tools against a returned worktree or integrate the commit without loading the entire diff into model context. After integration, it acknowledges the accepted ref/commit through `muse_finalize`. Unrelated workers continue running.

See [design](docs/design.md), [recovery and retirement](docs/recovery.md), and [compatibility](docs/compatibility.md). Live subscription, sandbox, human approval and installed-client behavior must be verified in a disposable repository; local fake-worker tests do not establish those facts.
