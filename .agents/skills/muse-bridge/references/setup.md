# Passeur setup and diagnosis

The canonical procedure is [docs/startup-and-installation.md](../../../../docs/startup-and-installation.md). The opt-in host procedure is [docs/installed-acceptance.md](../../../../docs/installed-acceptance.md).

Normal registration selects a version-specific installed runtime and an explicit server name, for example `passeur_pumas` or `passeur_tuldok`. Use `muse_bridge` only when deliberately retaining that connection name. Keep the vendor SDK client identifier independent.

Run `register-codex --project ABSOLUTE_PATH --profile ABSOLUTE_FILE --state-root ABSOLUTE_ROOT --server-name NAME` from the selected installed CLI after authority to edit Codex configuration. This validates resolved configuration and directly launches/list/status-checks the registered MCP command; it is not actual Codex attachment or live Muse acceptance.

Use `--verify-readiness --yes` only when preparation/import/reconciliation is authorized. Access failures remain typed, installed-but-blocked results; they do not justify global sandbox changes or a different state root.

Unmarked legacy registrations need explicit adoption and, for a differing binding, the returned replacement fingerprint. Adoption can remove formatting/comments; review the backup and selected semantics. Managed updates preserve outside text. Close other configuration writers. A rollback conflict preserves newer edits rather than restoring stale whole-file content.

Development registration requires `--development-runtime` and remains labeled developmental. Missing builds are never built implicitly by `serve`. Compare the reported process build ID to the selected installed artifact when diagnosing old code.

After registration, start a new Codex session and inspect actual tool attachment. When tools are absent, use the installed CLI's `doctor` and direct registration evidence; an absent host namespace cannot call its own status tool. Do not infer the exact host attachment cause from an unrelated shell check.
