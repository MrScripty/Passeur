# Global Passeur profile upgrade and service attachment

## Current authority

| Field | Value |
| --- | --- |
| Plan status | `Active` |
| Acceptance status | Profile/path repair and pre-upgrade routing qualification remain accepted; live model-catalog integration and installed-host cutover are in progress |
| Current phase | M0–M5 and prior V1 complete; M6 and final V2 pending |
| Exactly one next slice | M6 — publish the approved installation default, install/register the current candidate, safely restart this repository service, and qualify fresh Codex sessions in this and an unseen repository |
| Canonical plan path | `docs/plans/global-passeur-profile-upgrade/plan.md` |
| Current invocation | `continue` — add the live Muse model catalog and complete the installed-host cutover and fresh-host qualification |
| Previous repair commit | `63b480ac6566ca962e19e29e5867673b8ffc7507` |
| Continuation baseline | `2c3fe209ffc4c487558d19955544830e6af4bcae` |
| Prior repair | `e5d599e` — global frontend routing; upgrade acceptance was overstated and is amended by this plan |
| Design authority | GPT-6.1 Sol High composed-design handoff in [review](reports/composed-design-review.md) |
| Baseline evidence | [failure reproduction and inventory](reports/baseline.md) |
| Inventory | [profile and connection ownership inventory](reports/inventory.md) |
| Execution ledger | [contributors and implementation evidence](reports/execution-ledger.md) |
| Verification | [acceptance and test evidence](reports/verification.md) |

This plan owns profile migration, service profile identity, connection behavior and upgrade qualification. The shared-service plan remains authoritative for repository election, service-owned accepted work, task control, and resource lifecycle. The prior global-routing plan remains historical evidence for routing behavior, with the upgrade qualification limits amended here. This continuation adds a live Muse catalog and the actual installed-host cutover; the earlier review and commit do not cover those additions.

## 1. Objective

An upgraded global Passeur registration must be usable from an existing repository and a previously unseen repository without manually creating a profile, ending an otherwise valid service, deleting service state, or configuring one Passeur registration per repository. A frontend joining a repository connects to the repository service independently of how that service’s effective profile was located. The elected service generation owns one immutable decoded execution-profile snapshot. A profile path is provenance; it is not service identity.

The registration update must establish a usable installation default before publishing a new unpinned registration. It may migrate one unambiguous existing effective profile. It must refuse deterministically when available profiles have materially different execution configuration, preserving source profiles and the prior registration. An unpinned frontend joins a valid service without selecting or opening a candidate profile. Explicit profile intent may request a controlled conflict when its effective configuration differs.

Joining a service does not adopt another frontend’s task. Each frontend retains its own authenticated task-control principal. The service continues to own accepted work after a frontend process exits.

## 2. Reproduction and root causes

The pre-change reproduction starts a live service from an explicit repository profile, with an isolated HOME/XDG configuration and no installation default. A fresh unpinned frontend in that repository selects `default-profile.json`, which does not exist. `agents` returns `PATH_NOT_FOUND` from its disconnected local catalog fallback. `tasks`, `prepare`, and coordination identity return `SERVICE_PROFILE_CONFLICT` because `#connect()` compares the candidate pathname with the live descriptor’s old pathname. The complete bounded output is in [baseline](reports/baseline.md).

The two errors have different causes: offline discovery treats the unpinned candidate as authoritative even while a live repository service owns the catalog; attachment treats pathname equality as execution compatibility. The registration-only update compounds this by writing the global unpinned Codex entry without creating or migrating the installation profile it now requires. Existing tests provisioned that default before the global frontend, so they did not exercise an installation upgrade.

The current Passeur MCP session is not an available implementation delegate: `passeur_agents` returned `PROFILE_MIGRATION_REQUIRED` for the selected shared profile and requires explicit profile migration before admitting new work. Under the user-authorized role constraint, implementation falls back to GPT-6.1 Sol Medium. No task submission was retried through that unavailable Passeur session.

## 3. Adopted profile and service contract

1. **Repository attachment identity** consists of canonical repository identity, state namespace, authenticated source/worktree view, service generation, and a supported service contract. Each remains derived or authenticated by its current owner. No global repository lock or current-repository router is added.
2. **Service execution profile** is one immutable, decoded version-3 profile snapshot per service generation. A versioned SHA-256 fingerprint over canonical effective configuration identifies the snapshot. The snapshot includes lifecycle/execution policy and the complete agent registry configuration, including agent identity, adapter identity, enabled state, modes, description, and opaque adapter options. Paths and provenance are excluded. Agent entries and set-like modes are normalized deterministically. Adapter options are compared conservatively as canonical JSON; secrets are never emitted in diagnostics.
3. **Admission time** is the first successful config-only snapshot load. Both catalog and execution use that same frozen snapshot. Loading does not prepare a coordinator, acquire a repository lease, start a provider, or inspect/reconcile task state. A failed load is not cached and can be retried before profile admission. A descriptor can advertise an identity only after the runtime retains that exact snapshot.
4. **Unpinned clients** may attach to a live, valid service without loading an installation or repository candidate profile. Repository overrides and the installation default are prospective choices for a new service generation. If no service exists, the selected candidate is loaded before service admission.
5. **Explicit profile clients** decode the requested candidate and compare fingerprints against the service-owned identity. The same configuration at a different path joins. The same path changed after service admission conflicts with the live snapshot. A materially different explicit profile conflicts with bounded requested/service paths, fingerprints, and generation. A legacy service without a known snapshot identity cannot satisfy explicit-profile compatibility by hashing its current file; report identity unavailable.
6. **Catalog discovery** calls a live repository service’s catalog when a valid service is present. With verified service absence it can load the prospective profile for offline catalog display. Listing agents never starts a service, inference, or repository lease. A live incompatible or unreachable service does not silently produce a possibly incorrect local catalog. Discovery and prepare connection races must preserve the caller’s requested connection mode.
7. **Registration migration** runs under the Codex configuration writer authority and before global registration publication. An existing valid default is retained. With no default, inspect structurally verified Passeur-managed pinned registrations and the bounded supported profile directory. A single effective version-3 profile group may be durably published create-only at the default path before the TOML edit. Multiple materially different groups return `PROFILE_DEFAULT_MIGRATION_REQUIRED`; no candidate returns a specific configuration requirement. Version-1/2 lifecycle semantics remain explicitly migration-gated. Preserve all source profiles, repository overrides, task state and running services.
8. **Build and protocol compatibility** remain distinct. New services declare the supported service contract separately from their build. Legacy handshake shape and build compatibility are supported only for a reviewed and qualified prior implementation; do not accept arbitrary same-version services. No compatibility path stops work, replays mutations, changes repository state, or transfers task ownership.

## 4. Milestones and ownership

| Slice | Owner | Bounded write set | Gate | State |
| --- | --- | --- | --- | --- |
| M0 — admission and reproduction | Lead | This plan and baseline/design reports | Exact live-service upgrade pair reproduced; standards interface available; composed design recorded | Complete |
| M1 — immutable profile snapshot and fingerprint | GPT-6.1 Sol Medium | `src/core/profile.ts`, `src/core/repository-runtime.ts`, focused core profile tests | One snapshot feeds catalog/execution; fingerprint excludes path, includes effective configuration; failed load remains retryable | Complete |
| M2 — service attachment, legacy handshake, and catalog authority | GPT-6.1 Sol Medium | `src/contracts/runtime.ts`, `src/contracts/service.ts`, `src/service/client.ts`, `src/service/server.ts`, `src/service/transport.ts`, `src/service/peer-auth.ts`, `src/core/errors.ts`, focused service tests | Unpinned live join is path-independent; explicit compatibility uses effective identity; service catalog is authoritative; task principals stay independent | Complete |
| M3 — registration/profile migration | GPT-6.1 Sol Medium | `src/codex/config.ts`, `src/codex/profile-migration.ts`, registration-focused tests; `src/cli.ts` only if needed and coordinated with lead | Migration is deterministic, durable, bounded, and precedes unpinned registration publication | Complete |
| M4 — integration and acceptance evidence | Lead | New integration tests and this plan’s evidence/docs | Actual old-service upgrade with active task; complete frontend-process restart; existing and unseen repositories; explicit conflicts and migration ambiguity | Complete |
| V1 — independent review, repair, and commit | GPT-6.1 Sol High read-only reviewer; lead integrates | Review report, verification, inventory, execution ledger, prior-plan addendum | All material findings fixed and reverified; no unrelated changes staged | Complete for the previous profile-upgrade candidate |
| M5 — live Muse model catalog | GPT-6.1 Sol Medium (fallback after Passeur task failed before native start); lead integrates | `src/muse/models.ts`, `src/mcp/server.ts`, `src/codex/config.ts`, `src/cli.ts`, focused tests/fixture and startup documentation | `passeur_models` queries Muse via MSP `model/list`; bounded paging, catalog change detection, cancellation/closure and at most two concurrent owned hosts per frontend; setup selects Muse-reported default; no hardcoded catalog | Complete after read-only Sol High review and 52/52 focused tests |
| M6 — installed global cutover and cleanup | Lead | Approved user profile/configuration through supported CLI; plan and reports | Shared installation default uses the approved existing policy and Muse-reported default; sole global `passeur` registration points at clean installed candidate; service is gracefully stopped without task cancellation and restarted by a fresh host; same and unseen repositories use the registered catalog; no stale repository-specific registration remains | Pending |
| V2 — final architecture/lifecycle review | GPT-6.1 Sol High, read-only; lead integrates | Exact integrated M5/M6 candidate, docs and evidence | Review covers model-query ownership, registration/profile cutover, service restart, host freshness and legacy-artifact disposition; repair and reverify any material finding | Pending |

M1 exports the following narrow API for M2 and M3:

```ts
effectiveProfileFingerprint(profile: SharedProfile): string
RepositoryRuntime.profileSnapshot(): Promise<Readonly<{
  profile: SharedProfile;
  profilePath?: string;
  fingerprint: string;
}>>
```

The snapshot is immutable, loaded once after the first successful decode, and retried after a failed load. `#execution()` and `agents()` consume this API. Loading it remains configuration-only. M2 must use this helper and must not edit M1-owned files. M3 may consume the exported fingerprint/decode helper but must not edit M1/M2 files. If a contract seam requires another owner’s file, stop that slice and coordinate before editing it.

## 5. Required qualification

Automated tests must prove equal configuration joins at the same and different paths; changed content at the same path conflicts against the retained snapshot; a materially different repository override conflicts only for a new generation or explicit intent; missing installation defaults do not block unpinned attachment to a live service; a live catalog remains authoritative; discovery alone creates no service/lease/inference; a genuinely different explicit profile reports both identities and paths; migration preserves an existing default, migrates one unambiguous source, refuses multiple different sources, and leaves existing files/config intact on refusal; a frontend process restart joins correctly; active tasks remain service-owned through registration/profile upgrade; and an unrelated repository receives its own service/configuration domain without using the old repository’s override.

Service compatibility must be tested with a real service from the actual prior supported build or a checked-in, reproducible build artifact. Relabeling a current descriptor is insufficient. Unknown builds remain controlled conflicts. The test records frontend build, service build, service contract, profile provenance/fingerprint, canonical repository ID, worktree view and generation.

Run focused tests, type checks/build, core and relevant broader integration suites, then a fresh-host qualification with two simultaneous supported agent sessions through one global `passeur` registration in an existing pre-upgrade repository and a previously unseen repository. The qualification uses disposable HOME/XDG/Codex configuration, performs migration through the registration writer, and uses ephemeral Codex sessions with invocation-only MCP overrides. It does not change personal Codex configuration or authentication. The user explicitly requires real-host sessions for this repair; do not use an account or credential beyond an already-authenticated local Codex CLI session.

## 6. Acceptance and operation history

Automated and real-host qualification demonstrates profile ownership semantics, deterministic registration migration, actual old-service compatibility, live accepted-task survival, complete frontend-process restart, two repository domains, and explicit-profile conflict. The independent Sol High read-only review approved the repaired candidate after its one migration-race finding was fixed and reverified. The repair is committed as `63b480ac6566ca962e19e29e5867673b8ffc7507`.

Operation history: `start` admitted M0 and the profile repair on 2026-09-30 under the user’s explicit request. `continue` records each implementation slice and qualification result, including the user-required ephemeral real-host sessions. `verify` records the prior exact-candidate review disposition and ordinary commit. This plan does not change the shared-service plan’s task/resource authority, authorize dependency installation or authentication changes, publish work, or rewrite shared history. Personal-profile and global-registration changes for M6 are separately authorized by the user’s follow-up in this conversation.

## 7. Live model catalog and installed-host continuation

The host-global Codex registration currently has one `passeur` entry and no `passeur_pumas` or `passeur_tuldok` entries, but it still selects the previous installed build. The connected repository service is still on that build. The current Codex host cannot reload a changed MCP tool catalog in place; a fresh Codex session is required to expose `passeur_models`. A same-namespace local descriptor probe reported `observed_dead`, while the live MCP frontend reported `connected`; that CLI observation is not service-death evidence because its process namespace differs from the active host. Use the supported MCP/service lifecycle for cutover.

The new read-only `passeur_models` tool performs a bounded live MSP `model/list` request using an owned short-lived `muse serve --no-session-log` process. It does not depend on a Passeur profile, repository binding, session, task, inference, or repository service. Setup uses the same live provider result and defaults to the row Muse marks as default. The live query during this continuation reported four models from `providerCatalog` / provider `meta`, Muse profile `tbh`; `muse-spark-1.3-contributor` was the marked default. The catalog is evidence with a query time, not a constant to copy into code.

The user explicitly approved creating `/home/jeremy/.config/muse-bridge/default-profile.json` from this repository’s existing approved Passeur policy, changing only the worktree root to `/home/jeremy/.local/share/passeur/worktrees`, retaining existing repository overrides, updating the one global registration, and starting this repository’s service. The source profile is `muse-spark-1.3-contributor`, which the live catalog marked default. Preserve the prior installed artifact while any already-running host may still load it. Remove no repository profiles, task state, descriptors or lease files manually. The cutover must use the supported registration and graceful service-stop workflows, cancel no tasks, and verify the resulting profile and service identities in new host sessions.

The old-runtime compatibility code remains narrowly supported so a current frontend can safely join a valid pre-upgrade service. This is required transition support until the existing service is drained; it does not retain or require old named MCP registrations. Fresh sessions must use the one updated global registration. No user-facing profile, state-root or descriptor action is part of normal operation.

Operation `continue` was reopened on 2026-09-30 after the user reported that the previous repair’s fresh host still lacked `passeur_models` and the local installation did not yet exercise the new registration/tool catalog. The user selected a separate read-only `passeur_models` tool, approved promoting the existing Passeur policy as the default with Muse’s live default model and a shared worktree root, and authorized the global registration and service cutover. Completion remains pending until M6, V2, documentation/evidence updates and the ordinary commit are complete.
