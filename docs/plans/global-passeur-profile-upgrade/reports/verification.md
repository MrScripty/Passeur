# Verification and acceptance record

**Operation:** `verify` — M6 installed-host cutover, final V2 review and evidence commit recorded.
**Candidate:** M5 source commit `c69cb4f460b8fc154f70c7bc17c65f9269cf5006`, installed build `35452931cd3700f5d77cdb9b8c2b25952696347b14fc85fe36252cb4a02edbd9`, plus the approved host configuration migration; M6 evidence commit `6deb15b2314e17dc2d0b0ccbe2cf85fc62219388`.
**Status:** focused code checks, installed-host qualification and the 2026-10-01 current-state re-audit passed. V1 and final read-only V2 reviews passed with no P0/P1/P2 findings. The scoped repair is committed; the documented worktree/runtime/full-suite limits remain.

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
| Independent Sol High V1 review | Repaired manifest `9bac760e51425faffbf6fb9ffe1e33ee0077e7c6c1c5f84b0e1e455f82ed6c4a`, read-only review | Approved; no remaining P0/P1/P2 findings |
| Previous profile-upgrade commit | `63b480ac6566ca962e19e29e5867673b8ffc7507` | Complete |
| Live model-catalog feature and concurrency bound | M5 source commit `c69cb4f460b8fc154f70c7bc17c65f9269cf5006`; live pages returned four provider rows; 52/52 changed-path tests | Demonstrated |
| Installation default and one global registration | Approved profile created; current config has one unpinned `passeur` on installed build `35452931…` with `passeur_models`; named registrations absent | Demonstrated |
| Fresh-host entry into existing and unseen repositories | Concurrent Codex 0.159.2 hosts connected to candidate generations `34097ad4…` and `deac27f3…`; existing override and unseen global profile resolved independently | Demonstrated |
| Graceful service restart | Old generations drained with `outstanding:false`; installed candidate started as `fd29dd0e…`; no task cancellation | Demonstrated |
| Legacy session behavior | Cached old conversation frontend re-elected prior build after cutover; drained again. Current host requires a new Codex session to load the updated registration. | Host limitation recorded |
| Final V2 Sol High review | HEAD `c69cb4f…` plus five documentation/evidence diffs; read-only architecture/lifecycle review | PASS; no unresolved P0/P1/P2 findings |
| Final M6 evidence commit | `6deb15b2314e17dc2d0b0ccbe2cf85fc62219388` | Complete |

The previous global-routing acceptance report has been amended to preserve what it proved while explicitly excluding the pre-upgrade scenario; this follow-up supplies the missing migration evidence.

## Live-catalog and installed-host continuation

The earlier acceptance is retained for its stated scenarios. This continuation supplies the previously missing upgrade from an already-configured host and a live old service.

- Before cutover, the active frontend was build `6a43daa6eec45ddceadea0ba2e2a623d7fc8e81e330237c7762a7f1c63c33f63`; service generation `7876ef0d-2d60-485f-8c62-7345432c7e37` was connected. It reported one MCP client, one terminal failed task with `native.state=not_started`, and no outstanding accepted work. Coordination metadata separately returned `not_enabled`.
- The supported `configure` command created `/home/jeremy/.config/muse-bridge/default-profile.json` mode `0600` from the user-approved current-repository policy, with only the worktree root changed to `/home/jeremy/.local/share/passeur/worktrees`. The repository override remained unchanged. The effective model matched Muse's live `is_default` row. `register-codex` updated the existing single global `passeur` registration to build `35452931cd3700f5d77cdb9b8c2b25952696347b14fc85fe36252cb4a02edbd9`, enabled `passeur_models`, and retained its prior required-startup policy. `codex mcp list` and `codex mcp get passeur --json` confirmed no named Passeur registrations and preserved the unrelated Codex entries.
- Two actual `codex exec --ephemeral --json` hosts started concurrently through that registered MCP entry. In the existing repository, status/prepare/agents/catalog all succeeded with repository ID `f05f262f16530a5c1a94ecc5`, profile source `legacy` (the preserved override), candidate service build `35452931…`, and generation `34097ad4-9233-4ed0-a7da-9d95e2e02260`. In a previously unseen Git repository, they succeeded with ID `6e35314f8c4fd233cd8c2d9a`, profile source `global` at `default-profile.json`, candidate service build `35452931…`, and generation `deac27f3-6c0d-48e1-bab0-f594146ecc93`. Both reported configured Passeur agent ID `muse`; readiness was `not_checked`.
- Both hosts paged through the live Muse catalog using its returned digest. Source was `providerCatalog`, provider `meta`, profile `tbh`, total four: `muse-spark-1.3`, `muse-spark-1.3-contributor` (Muse default), `muse-spark-1.2`, and `muse-spark-1.2-contributor`. This is a live provider response, not a model list in code. No task or inference was submitted.
- The old generation was stopped by the supported `service-stop`; it returned `draining` with `outstanding:false`, and no task cancellation was named. This shell initially could not reach the service socket from its restricted namespace; the supported command succeeded in the host namespace. A later call from this conversation's cached old MCP frontend re-elected build `6a43…`, generation `57dc5064-8cb0-4941-9559-90ad23d49944`. It was drained with `outstanding:false`. The installed candidate's supported `service-start` then returned connected generation `fd29dd0e-d72f-4702-b627-a3e31801534d`, build `35452931…`, and repository ID `f05f262f16530a5c1a94ecc5`. A later descriptor check observed no active service after the one-shot CLI client exited. Fresh hosts had already demonstrated on-demand candidate startup in both repositories. The active conversation host still has the old MCP tool catalog and must be replaced by a fresh Codex host before further Passeur use.
- `passeur_coordination` status still returns `state:"not_enabled"`. `passeur_prepare` and service status work independently; metadata was not initialized as part of the service restart.
- The retained current-repository override has a malformed nested worktree root with literal quote characters. The root is rejected by workspace creation. User-approved preservation means qualification here covers catalog, attachment, agents and preparation, not new task implementation requiring a worktree. The unseen repository uses the approved shared installation root.
- M5 checks remain green: `npm run check`, `npm run build`, the 7-file changed-path Vitest suite (**52/52**) and model-catalog unit suite (**13/13**). `git diff --check` passed after the M5 repair; rerun after evidence edits. The earlier bounded Sol High M5 review approved the cap-of-two catalog-host fix. It is not the required V2 review.
- Runtime disposition at M6: candidate `35452931…` is the global registration. `6a43…` was loaded in this conversation. `488ba…` had no known registration or service-descriptor reference but was retained pending a host-wide process check; see the 2026-10-01 re-audit below.

M6 installed-host acceptance is demonstrated for an existing pre-upgrade repository and a previously unseen repository through the sole global registration. GPT-6.1 Sol High completed the independent read-only V2 architecture/lifecycle review; no P0/P1/P2 findings remain. No repository-wide core-suite pass is claimed; see the broad-suite limitation above.

## Final V2 review

GPT-6.1 Sol High reviewed HEAD `c69cb4f460b8fc154f70c7bc17c65f9269cf5006` plus the five documentation/evidence diffs, read-only. It confirmed the installed runtime manifest matches clean M5 source, the single global registration and `passeur_models` allowlist, mode-0600 default policy, profile-fingerprint and service ownership boundaries, bounded live catalog child lifecycle, the recorded simultaneous-host and service-cutover evidence, and the bounded limitations. Disposition: **PASS**, no unresolved P0/P1/P2 findings. The reviewer did not edit files or rerun the lead-provided tests and host sessions. The final status change records this disposition only.

## 2026-10-01 current-state re-audit

Two new ephemeral Codex hosts ran concurrently through the actual active global registration. Each called `passeur_prepare`, `passeur_status`, `passeur_agents` and `passeur_models`. The existing repository connected to installed build `35452931…` at repository ID `f05f262f16530a5c1a94ecc5`, profile source `legacy`, generation `ec5a99b4-4274-4751-933d-fa5bc6e16028`. A temporary unseen Git repository connected to the same build at repository ID `907cad01ec2f3cb72435b070`, profile source `global`, generation `c793444e-b3ca-4aad-ae0c-94cfcf68cc4c`. Both were connected with admission `open`, coordination `ready`/`held` and valid profiles. The separate service generations confirm repository separation. Both later retired after their one-shot clients exited; supported `service-status` returned `absent` for each, matching on-demand lifecycle. No task was submitted.

The current complete Muse `model/list` response from both hosts was source `bundledCatalog`, provider `meta`, profile `tbh`, total one: `muse-spark-1.3-contributor`, `is_default:false`, digest `7638b2739afa696b1ebf84183928d9148f8b343248c9a72b5eec87e89dcea72a`. Passeur's `src/muse/models.ts` launches Muse and returns its live response without supplying or merging a local list. The installed Muse 1.4.2 generated stable MSP schema defines `model/list` as a query of models that host accepts in `session/setModel`; its `ModelCatalogSource` explicitly distinguishes `bundledCatalog` from `providerCatalog`. This current response is a Muse-sourced bundled catalog, not a current provider-discovered list. The earlier four-row provider catalog is retained as historical evidence only. A concurrent Codex model-manager refresh timeout was seen, but no evidence establishes its relation to Muse's reported source.

Runtime cleanup: `codex mcp list` still reports one unpinned global `passeur` registration on build `35452931…`, no named Passeur registrations, and unrelated entries unchanged. A host-wide process inventory found 20 active Passeur frontends on prior build `6a43…`; it remains installed so those loaded sessions are not broken. No active Passeur process referenced intermediate build `488ba…`; Codex configuration and Passeur service-state searches found no registration or descriptor reference. Its exact immutable runtime directory was removed; old Codex session logs remain as historical records. The temporary unseen Git repository was removed after its service reported absent. No profiles, service descriptors, leases, tasks or control tokens were deleted.

The current Passeur host used for this investigation still has its old tool catalog; the fresh Codex processes above loaded the updated catalog including `passeur_models`. Existing host catalogs are not reloaded in place. A new session is required after registration/runtime updates, while new sessions now resolve this existing repository and unseen repositories independently through the one global registration.
