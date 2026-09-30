# Profile-upgrade baseline

## Source state and authority

- Baseline HEAD: `7df5c71ea5a2be1eb2f1268b9f14e7599b127e79`.
- Working tree contained five unrelated pre-existing untracked paths; they remain preserved and are excluded from the repair write sets.
- The prior repair was `e5d599e`. Its tests provisioned the installation default and therefore did not test upgrading a previously configured pinned installation.
- Read-only `codex mcp list` confirms the host currently has one enabled global `passeur` registration with no `cwd`, `--project`, or `--profile`; no `passeur_pumas` or `passeur_tuldok` registration is present. The registration points to the installed prior artifact at `/home/jeremy/.local/share/passeur/runtimes/6a43daa6eec45ddceadea0ba2e2a623d7fc8e81e330237c7762a7f1c63c33f63`, build ID `6a43daa6eec45ddceadea0ba2e2a623d7fc8e81e330237c7762a7f1c63c33f63`, source revision `6e61bd93e74686620f0cffc3e54bf00c8e5373f8`. Its actual strict hello requires the descriptor's old profile pathname. This supports exact prior-runtime qualification; neither the installed artifact nor personal registration was modified.
- Passeur’s active `passeur_agents` tool call returned `PROFILE_MIGRATION_REQUIRED` with message “Run migrate-profile with explicit authority; new tasks require profile version 3 without execution deadlines”. The tool could not provide a usable agent catalog/task route. No submission was attempted. Implementation uses the user-authorized GPT-6.1 Sol Medium fallback.
- Coding-Standards was available through supported application interface 45, implementation `0.2.0`, instance `24c356ca-b94a-4d14-a700-bf723f74aced`, catalog digest `sha256:8235cb21f7d1937be1a003eb2eef570345242194dac36d79463b16e26bb6d65d`. Current routing facts were read and route completed with zero unresolved questions for library/launcher, TypeScript/async, persistence, IPC, generated contracts, architecture, concurrency, contracts/evolution/protocols/schemas, cross-platform, diagnostics, resilience, security, implementation, planning, verification, build, documentation, tooling and commit. Core and Router precede the applicable canonical module reads. No required module was reported unavailable; this is not a repository-wide conformance claim.

## Exact live-service reproduction (before source changes)

The reproduction used the current `.passeur-core` frontend and `dist/src/cli.js`, a disposable Git repository, isolated HOME/XDG paths, one explicit version-3 repository profile, and no `default-profile.json`. A pinned frontend called `prepare` and connected to an elected live service. A fresh unpinned frontend in the same repository then produced:

| Operation | Result | Relevant context |
| --- | --- | --- |
| `passeur_agents` / `frontend.agents(0, 16)` | `PATH_NOT_FOUND` | `stage=profile.open`, global default pathname, `native_code=ENOENT` |
| task listing | `SERVICE_PROFILE_CONFLICT` | requested global default path versus the live service’s explicit repository profile path |
| `passeur_prepare` | `SERVICE_PROFILE_CONFLICT` | same pathname comparison before service handshake |
| coordination identity | `SERVICE_PROFILE_CONFLICT` | same pathname comparison before service handshake |

The live service was still connected. The fixture confirmed the installation default did not exist. Both profiles and state were inside an automatically removed `/tmp/passeur-pre-upgrade-repro-*` tree. The sandbox initially prevented flock-launched service qualification and dropped child stderr; the same existing integration test and reproduction passed with `require_escalated` local process execution. No personal configuration or live account was accessed.

## Findings

1. `agents()` falls back to the frontend-local `RepositoryRuntime.agents()` while disconnected. It independently loads the missing frontend candidate profile and surfaces `PATH_NOT_FOUND`, even when an authoritative live service already exists.
2. `#connect()` compares `descriptor.profile_path` with the resolved frontend candidate path. It refuses a valid live service solely because profile provenance differs, yielding `SERVICE_PROFILE_CONFLICT` for tasks, prepare and coordination.
3. `register-codex` can write a new unpinned global registration without proving or creating the installation default. `setup`/`configure` create that profile, but an existing configured installation upgraded by registration-only workflow need not run them.
4. The runtime does not retain one immutable profile snapshot shared by catalog and execution. Execution loads lazily; offline catalog can independently load configuration. No fingerprint distinguishes same effective configuration at different paths or changed contents at one path.
5. Prior global frontend tests create `default-profile.json` before frontends start. They cover routing after setup, not migration from an existing pinned installation with a live pre-upgrade service.
6. Running service work is service-owned; path-only rejection does not improve execution safety and can prompt needless service shutdown. The repair must preserve that work and each frontend’s independent control principal.
