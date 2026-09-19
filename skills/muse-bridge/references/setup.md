# Set up the Muse MCP bridge

Run commands from the repository root. The bridge requires Node.js 20 or newer, an installed Muse CLI, and an existing Muse credential whose subscription billing path the user has verified.

1. Install and build the pinned package:

   ```sh
   npm install
   npm run build
   ```

2. Establish the exact Muse model identifier supported by the installed runtime. Pass that identifier explicitly; the bridge has no fallback model.

3. Generate a project profile and proposed Codex MCP entry:

   ```sh
   node dist/src/cli.js configure \
     --project "$PWD" \
     --profile /absolute/path/to/muse-bridge-profile.json \
     --muse-bin /absolute/path/to/muse \
     --model VERIFIED_INSTALLED_MODEL_ID \
     --confirm-subscription
   ```

   Add `--worktree-root /absolute/approved/root` to enable implementation tasks. The command prints JSON containing `codex_config`; translate it into the equivalent `[mcp_servers.muse_bridge]` TOML entry in the user's Codex config. Preserve unrelated settings. The essential values are the absolute Node executable, `dist/src/cli.js`, `serve`, the canonical project and profile paths, `tool_timeout_sec = 2100`, and `enabled_tools = ["delegate_to_muse", "muse_result"]`.

4. Ensure Codex allows MCP tool-call elicitation and routes approval prompts to the human. The bridge refuses delegation when the client does not advertise elicitation.

5. Run local, non-inference diagnostics:

   ```sh
   node dist/src/cli.js doctor \
     --project "$PWD" \
     --profile /absolute/path/to/muse-bridge-profile.json
   ```

6. Restart Codex after changing its MCP configuration, then confirm that `delegate_to_muse` and `muse_result` appear. Initializing the server does not launch Muse inference.

Use `scripts/probe-wait.ts` to verify long same-call waiting. Run `scripts/probe-muse.ts` only in a disposable project with `MUSE_BRIDGE_LIVE=1` after confirming billing provenance. Record live compatibility evidence in `docs/compatibility.md`.

Codex MCP configuration fields and skill discovery can change. When updating this setup procedure, verify them against official OpenAI documentation and the CLI's generated `codex_config` output.
