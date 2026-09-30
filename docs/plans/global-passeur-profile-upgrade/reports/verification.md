# Verification and acceptance record

**Operation:** `verify` — implementation, acceptance evidence and independent review recorded; commit remains.
**Candidate:** source, tests and documentation in the current working tree on 2026-09-30.
**Status:** scoped automated and real-host acceptance passed; Sol High approved the repaired candidate after the migration race was fixed. The ordinary commit remains.

## Check results

- `npm run check` — passed after all implementation/test changes.
- `npm run build` — passed after all implementation/test changes.
- `node --test --test-concurrency=1 tests/core/global-binding.test.mjs tests/core/service-attachment.test.mjs tests/core/profile-snapshot.test.mjs tests/core/service-profile-identity.test.mjs` — **29/29 passed**. Includes precedence, linked-worktree canonical identity/source view, immutable snapshots, path-independent fingerprints, changed-profile conflicts, service-owned catalog discovery, distinct task principals, the exact qualified legacy build handshake and bounded diagnostics.
- `npx vitest run tests/unit/codex-profile-migration.test.ts tests/unit/codex-config.test.ts` — **41/41 passed**. Includes unambiguous durable migration, existing default preservation, ambiguity refusal, unsafe path/symlink/race bounds, late appearance of a previously missing pinned profile, and global registration publication after migration.
- Isolated `register-codex` CLI upgrade using the actual Codex CLI `mcp get` inspector and MCP transport — **passed**. Starting from a managed pinned prior-build entry and one old profile, it created the installation default, published the unpinned global entry, and returned `configuration.status=passed` plus `transport.status=passed`. The temporary Codex config and profile were removed afterward.
- `npx vitest run tests/integration/profile-upgrade.test.ts tests/integration/global-frontend.test.ts tests/integration/recovery.test.ts tests/integration/service-attachment-recovery.test.ts tests/unit/codex-profile-migration.test.ts` — **5 files, 22/22 passed**. Includes the actual old-build service with active accepted work, frontend-process exit/restart, registration migration with no default precreated, existing-service attachment, unrelated-repository service startup, control isolation and service recovery.
- The isolated upgrade integration uses the actual installed prior runtime build `6a43daa6eec45ddceadea0ba2e2a623d7fc8e81e330237c7762a7f1c63c33f63`; it does not relabel a current descriptor.
- `git diff --check` — passed after the migration race repair; rerun before commit.

## Independent review and repair

GPT-6.1 Sol High's initial read-only review of manifest `e91392a253c2329ee8f5648e6c7f5582495ae0f4d69f2c1ed809b4c95a380c4a` found one P2 migration race: a missing managed pinned profile was included in path discovery but not revalidated if the file appeared before publication. The migration now records absent candidates and verifies they remain absent at both validation passes. A regression creates a materially different pinned profile during migration and verifies the operation fails without publishing a default or temporary artifact. After repair, the focused migration/config and upgrade/recovery suites passed 41/41 and 22/22.

The same reviewer performed a read-only bounded re-review of repaired manifest `9bac760e51425faffbf6fb9ffe1e33ee0077e7c6c1c5f84b0e1e455f82ed6c4a`, confirmed the manifest matched the worktree, and approved the scoped architecture/lifecycle/security review with no remaining P0/P1/P2 findings. The reviewer did not rerun tests or host sessions; those results above are lead-provided. The prior architecture disposition remains valid because the repair only revalidates migration inputs and does not change service, profile-snapshot, authentication, election or task-control boundaries.

## Real-host qualification

Two simultaneous ephemeral Codex CLI `0.159.2` agent sessions used the single unpinned `passeur` registration. A pre-upgrade pinned registration and old repository-specific profile were created under temporary HOME/XDG/Codex paths; `installCodexMcpRegistration` migrated that profile and published one global unpinned entry before the sessions. No default profile was manually copied or precreated. The existing old service remained live. Codex sessions used `--ephemeral` and invocation-only config overrides; personal Codex configuration and authentication were not changed.

| Session | Canonical repository | Observed result |
| --- | --- | --- |
| Existing pre-upgrade repository | `8eab452df5547ae5c1ce322c` | Agent discovery attached to the live service; status was `connected`, build `6a43daa6eec45ddceadea0ba2e2a623d7fc8e81e330237c7762a7f1c63c33f63`, generation `da2262cb-0838-4878-8f3e-7f5e2e7f1c1e`. |
| Previously unseen repository | `59998e0c612bec844c8125ee` | Prepare succeeded; coordination was `ready` / `held`; status was `connected`, build `development-unidentified`, generation `10fdf65a-3ca5-46f6-b266-0033d0138278`. |

Both sessions saw the migrated empty agent registry, as expected from the intentionally empty fixture profile. This host check establishes real Codex tool exposure, registration migration, connection to the pre-upgrade service, and independent service startup in a new repository. It does not claim provider execution.

## Broad-suite limitation

`npm run test:core` was attempted but did not complete. It reported failures across existing Codex-native, coordination, provider and peer-lifecycle tests, including a Node 24 `InternalCallbackScope::Close()` assertion, and then stalled on `tests/core/peer-delivery-completion-restart.test.mjs`; the stalled run was stopped. The failure set was not triaged as part of this profile repair, and no repository-wide pass is claimed. The focused changed-path suites above completed cleanly.

## Acceptance matrix

| Criterion | Evidence | Status |
| --- | --- | --- |
| Exact `PATH_NOT_FOUND` cause | Fresh unpinned frontend opened nonexistent installation default in disconnected `agents()` fallback | Demonstrated |
| Exact `SERVICE_PROFILE_CONFLICT` cause | `#connect()` compared old live service profile pathname with new candidate pathname | Demonstrated |
| Profile ownership separated from path | One immutable service-generation snapshot and versioned effective fingerprint; provenance retained separately | Demonstrated |
| Existing service stays authoritative | Unpinned frontend joins actual qualified old build without needing its candidate default; service catalog returned | Demonstrated |
| Registration upgrade establishes default | Writer migrates a sole unambiguous managed pinned profile before publishing global TOML; ambiguous profiles refuse safely | Demonstrated |
| Discovery is coherent and non-invasive | Live service catalog is authoritative; offline catalog only after verified absence; does not launch inference/service | Demonstrated |
| Active task remains owned | Prior service accepted controlled long-running work; submitting frontend process exited; owner reconnected and explicitly cancelled only after survival/control checks | Demonstrated |
| Task-control security remains intact | Independent principal cannot list or control the old principal’s task; no implicit takeover | Demonstrated |
| Same/different paths and changed contents | Equal effective profile joins across paths; edited same path conflicts against retained snapshot; different explicit profile conflicts | Demonstrated |
| Existing and unseen repositories through one global registration | Concurrent real Codex sessions connected to old service and prepared a separate new service after migration | Demonstrated |
| Linked worktree model | Canonical binding/source-view and legacy profile precedence tests pass | Demonstrated |
| Ordinary recovery and election | Targeted attachment recovery and repository-scoped election tests pass | Demonstrated |
| Independent Sol High final review | Repaired manifest `9bac760e51425faffbf6fb9ffe1e33ee0077e7c6c1c5f84b0e1e455f82ed6c4a`, read-only review | Approved; no remaining P0/P1/P2 findings |
| Ordinary commit | Normal commit and hooks | Pending |

The previous global-routing acceptance report has been amended to preserve what it proved while explicitly excluding the pre-upgrade scenario; this follow-up supplies the missing migration evidence.
