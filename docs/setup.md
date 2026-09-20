# Setup and version-2 usage

Build with the pinned dependencies in a supported Node environment:

```sh
npm ci
npm run check
npm test
npm run build
```

`npm test` runs the dependency-light Node core tests followed by the Vitest schema/SDK/MCP-boundary tests. These validate Passeur itself. They are not tests Passeur invokes on delegated projects. `npm run test:core` runs only the production-core tests.

## Configure

Use a clean repository root, a Muse executable/model identifier verified against the installed runtime, and the normal subscription-linked credential. The confirmation is a dated user assertion, not provider billing proof.

The interactive setup reads the installed Muse model catalog and creates a profile with the default capacity of two workers and eight queued tasks. The project directory defaults to the current directory. Accept its final prompt to install the MCP entry directly into Codex without copying configuration text.

```sh
./passeur setup /absolute/path/to/project
```

For a profile created previously, install or repair only its Codex registration:

```sh
./passeur register-codex /absolute/path/to/project
```

Passeur updates only `[mcp_servers.muse_bridge]` in `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`), preserves unrelated text, and writes `config.toml.passeur-backup` before replacing an existing file. It verifies the result with `codex mcp get muse_bridge --json`; failed verification restores the previous config. Existing nested `muse_bridge` tables require manual migration so their settings are not silently discarded.

For non-interactive configuration or explicit capacity limits, run:

```sh
node dist/src/cli.js configure \
  --project /absolute/repository \
  --profile /absolute/passeur-profile.json \
  --muse-bin /absolute/path/to/muse \
  --model VERIFIED_INSTALLED_MODEL_ID \
  --worktree-root /absolute/task-worktrees \
  --max-workers 2 --max-queued-tasks 8 \
  --confirm-subscription \
  --install-codex
```

The worktree root must be outside the source checkout. Existing profiles are not overwritten. They keep `schema_version: 1`; absent capacity fields resolve to two workers/eight queued tasks. Edit them deliberately and restart the coordinator to change the limit. Concurrency is not a claim about provider quota or entitlement.

The repository-local agent skill is in `.agents/skills/muse-bridge`. It directs Codex to `register-codex` when the Passeur tools are missing. If another workflow owns Codex configuration, omit `--install-codex`; `configure` prints both structured JSON and copy-safe TOML. The installed entry is equivalent to:

```toml
[mcp_servers.muse_bridge]
command = "/absolute/path/to/node"
args = ["/absolute/Passeur/dist/src/cli.js", "serve", "--project", "/absolute/repository", "--profile", "/absolute/passeur-profile.json"]
startup_timeout_sec = 10
tool_timeout_sec = 2100
enabled_tools = ["delegate_to_muse", "delegate_to_muse_batch", "muse_result", "muse_finalize"]
```

The 35-minute tool timeout assumes the profile's 30-minute absolute task budget plus bounded shutdown/response allowance. A queued task's deadline is not restarted. Increase the client timeout deliberately if increasing the task budget.

Allow MCP elicitation and route permissions to the human reviewer. Prompt serialization applies only to human prompts; authorized work by other tasks continues. Run `doctor` for non-inference diagnostics:

```sh
node dist/src/cli.js doctor --project /absolute/repository --profile /absolute/passeur-profile.json
```

Doctor reports versions, capacity and effective hook configuration; it neither executes tests/hooks nor proves billing, model availability, signing or sandbox behavior. Complete repository trust, dependency, hook and signing setup through its normal workflow. Passeur preserves that policy rather than installing a second hook suite.

## Delegate independently or in a batch

```json
{
  "schema_version": 2,
  "assignments": [
    {
      "schema_version": 2,
      "request_key": "parser-2026-01",
      "mode": "implement",
      "objective": "Implement the parser boundary change and commit it.",
      "context": "Verify parser-specific behavior. The UI is not part of this task.",
      "acceptance_criteria": ["Parser-focused checks pass", "An ordinary compliant commit is created"],
      "allowed_paths": ["src/parser", "tests/parser"],
      "base_commit": "REPLACE_WITH_EXACT_COMMIT_OID",
      "target_ref": "refs/heads/work/parser"
    }
  ]
}
```

The example is a template: replace the OID and target with real values. Add independent assignments with their own bases/targets to `delegate_to_muse_batch`, or use the single assignment with `delegate_to_muse`. Batch membership implies no common feature, broader test or integration barrier beyond awaiting those explicitly submitted tasks. Keep keys stable for identical retries; choose a new key for intentional rework.

Worker completion does not trigger mandatory Codex review. Codex decides when to inspect code, integrate through Git, or run broader tests. A successful runtime with `delivery.status: incomplete` is not committed delivery. A `committed` result is a Git fact, not certification of test adequacy or standards compliance.

## Disposition after external integration

Use `muse_finalize` or the offline CLI with an operation file:

```json
{
  "schema_version": 2,
  "operations": [{
    "operation_key": "retire-parser-01",
    "task_id": "REPLACE_WITH_TASK_UUID",
    "disposition": "integrated",
    "expected_head": "REPLACE_WITH_TASK_HEAD",
    "expected_branch_ref": "refs/heads/muse-bridge/REPLACE_WITH_TASK_UUID",
    "target_ref": "refs/heads/work/parser",
    "accepted_commit": "REPLACE_WITH_ACCEPTED_COMMIT",
    "cleanup_authorized": true
  }]
}
```

Passeur verifies reachability before removing its clean stopped task resources. This is not a request to merge. Refer to [recovery](recovery.md) for retention, archive, incomplete cleanup and legacy history. Normal replies are bounded; `muse_result` gives paginated evidence and current resource state. Use base64 for binary artifacts and `next_offset` for subsequent byte ranges.

## Live probes

Only in a disposable project after confirming credential/model policy:

```sh
MUSE_BRIDGE_LIVE=1 npm run probe:parallel -- \
  --project /absolute/disposable/repository \
  --profile /absolute/passeur-profile.json \
  --confirm-disposable
```

The probe launches the compiled production stdio server, requests two independent committed outputs, declines any permission requests, and leaves resources for explicit disposition. It does not certify concurrency at the provider backend. The real Codex checks must additionally demonstrate overlapping local worker sessions, correct human decisions, same-call waiting, cancellation during commits/hooks, descendant cleanup and subscription behavior. Keep these checks opt-in; do not run them on every commit.
