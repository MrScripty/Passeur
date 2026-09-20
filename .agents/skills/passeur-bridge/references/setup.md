# Setup and diagnosis

Follow the canonical repository procedures in `docs/startup-and-installation.md`, `docs/registered-agents.md`, and `docs/installed-acceptance.md`. Use an exact installed runtime and an explicitly named MCP registration. Preserve the configured state namespace and unrelated user settings; registration authority does not authorize replacing another binding.

`passeur_status` observes. `passeur_prepare` acquires coordination without provider inference. Agent discovery reads configuration without native SDK startup. Missing providers must not hide the interface. A repaired pre-admission configuration failure can be retried; after execution composition fixes configuration, changes require a controlled restart.

Rebuilding source does not update an existing installed/running process. Check actual reported build identity and binding. Do not start another server to seize a held lease, change state roots, delete locks, broaden permissions or select another provider as fallback. Actual host attachment and live agent behavior remain separate from successful direct initialization/list/status.
