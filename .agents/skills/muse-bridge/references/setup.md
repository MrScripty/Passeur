# Setup reference

Follow `docs/setup.md` for build, project profile and MCP registration. The executable remains `muse-bridge`; dependency pins and the normal Muse credential path are unchanged.

Register all four tools: `delegate_to_muse`, `delegate_to_muse_batch`, `muse_result`, `muse_finalize`. New execution uses `schema_version: 2`; implementation also names `base_commit` and `target_ref`. Profile version remains 1; missing capacity fields mean two active workers and eight queued tasks. Account/provider limits still need live verification.

Use a clean repository root and an approved task-worktree root outside the source checkout. Preserve repository hooks, dependencies, signing and trust setup. Doctor reports configuration without running hooks, tests or inference. It does not certify subscription coverage.

1. Build the bridge with `npm ci`, `npm run check`, `npm test`, and `npm run build`.

2. Setup reads the installed Muse model catalog and asks the user to select a model. It uses the `muse` executable found on `PATH`.

3. Generate a project profile and install its Codex MCP entry:

   ```sh
   ./passeur setup /absolute/path/to/project
   ```

   Enable implementation worktrees when prompted and supply an approved root outside the source checkout. Accept the Codex registration prompt to update `~/.codex/config.toml` without copying terminal output. Passeur preserves unrelated settings, backs up an existing config, verifies the entry through the Codex CLI and restores the previous config if verification fails.

   For an existing profile, register it directly:

   ```sh
   ./passeur register-codex /absolute/path/to/project
   ```

   Non-interactive configuration can add `--install-codex`. Decline the interactive registration prompt only when another workflow owns Codex configuration; Passeur then prints copy-safe TOML as a fallback.

4. Ensure Codex allows MCP tool-call elicitation and routes approval prompts to the human. The bridge refuses delegation when the client does not advertise elicitation.

5. Run local, non-inference diagnostics:

   ```sh
   ./passeur doctor /absolute/path/to/project
   ```

6. Restart Codex after changing its MCP configuration, then use `/mcp` to confirm that all four tools appear. Initializing the server does not launch Muse inference.

Start the configured server with `./passeur start /absolute/path/to/project`. The project defaults to the current directory.

Stop older coordinators before starting the updated server. State and the owner lease now use the Git common directory so linked worktrees cannot run competing managers. Legacy path-keyed records are imported under this lease; old results remain historical and cannot authorize guessed cleanup.

Use `scripts/probe-wait.ts` to verify long same-call waiting. Run `scripts/probe-parallel.ts` only in a disposable project with `MUSE_BRIDGE_LIVE=1` after confirming billing provenance. A successful local test suite does not establish installed Codex elicitation, backend parallelism, sandbox enforcement or actual subscription billing. Record live compatibility evidence in `docs/compatibility.md`.

Codex MCP configuration fields and skill discovery can change. When updating this setup procedure, verify them against official OpenAI documentation and the CLI's generated `codex_config` output.
