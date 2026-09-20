# Setup and diagnosis

Follow the canonical repository procedures in `docs/startup-and-installation.md`, `docs/registered-agents.md`, and `docs/installed-acceptance.md`. Use an exact installed runtime and an explicitly named MCP registration. Preserve the configured state namespace and unrelated user settings; registration authority does not authorize replacing another binding.

`passeur_status` observes. `passeur_prepare` acquires coordination without provider inference. Agent discovery reads configuration without native SDK startup. Missing providers must not hide the interface. A repaired pre-admission configuration failure can be retried; after execution composition fixes configuration, changes require a controlled restart.

Rebuilding source does not update an existing installed/running process. Check actual reported build identity and binding. Do not start another server to seize a held lease, change state roots, delete locks, broaden permissions or select another provider as fallback. Actual host attachment and live agent behavior remain separate from successful direct initialization/list/status.

When a configured server process exists but tools are not callable, read `docs/troubleshooting/attached-tools.md`. Do not require the missing tools to repair their own deployment. Record the exact command/build and tool allowlist; refresh the installed build and the two existing named registrations offline under operator authority, then verify a fresh host's actual status calls. A live process or held repository lease alone does not prove MCP catalog attachment.

Use `register-codex --required` for a named connection required by that session, or `--optional` for an explicitly optional connection. Omission preserves the existing startup choice. Required initialization can block host startup; it does not grant approval or sandbox authority. Do not change the global optional grace as a default remedy. `startup_policy.inspection.status: not_reported` means the installed Codex inspection omitted that field, not that the policy was ignored or successfully applied to the model's catalog.
