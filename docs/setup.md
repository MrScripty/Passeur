# Setup

Requirements are Node.js 20 or newer, Codex CLI, Muse Code CLI 1.3.0, and a Muse credential whose subscription billing path the user has verified. Task content is processed through Muse's normal provider connection.

Build the bridge:

```sh
npm install
npm run build
```

Create a profile. The subscription flag records the user's dated confirmation; it does not infer coverage from a successful login.

```sh
node dist/src/cli.js configure \
  --project /absolute/path/to/project \
  --profile /absolute/path/to/profile.json \
  --muse-bin /absolute/path/to/muse \
  --model VERIFIED_INSTALLED_MODEL_ID \
  --confirm-subscription
```

Add the printed MCP entry to Codex. Ensure Codex permits tool-call MCP elicitation and routes it to the human reviewer. Set `tool_timeout_sec = 2100`. Then run the non-billable checks:

```sh
node dist/src/cli.js doctor --project /absolute/path/to/project --profile /absolute/path/to/profile.json
```

Good review assignments name a narrow objective, relevant files and decisions, and observable acceptance criteria. For example: inspect `src/parser.ts` for unchecked bounds; cite exact locations; report only actionable correctness findings. Implementation assignments additionally require a clean source checkout, a full commit object ID, enabled implementation support, and a user-approved worktree root in the profile.

Real inference probes are opt-in and must use a disposable repository:

```sh
MUSE_BRIDGE_LIVE=1 npm run probe:muse -- /absolute/disposable/project muse-spark-1.3
```

The bridge never chooses a fallback model. Supply the exact model identifier supported by the installed runtime; a task fails if Muse reports a different identifier.

The wait probe is itself an MCP server. Register `dist/scripts/probe-wait.js`, call `wait_probe` with 70000 and then a several-minute delay, and inspect Codex traces to verify the same tool request remains pending without model polling.
