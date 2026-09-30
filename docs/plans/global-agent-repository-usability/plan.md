# Global Passeur frontend, repository-local coordination

## Current authority

| Field | Value |
| --- | --- |
| Plan status | `Active` |
| Acceptance status | Functional criteria evidenced; final scoped commit pending. Full-suite exceptions are recorded in [verification](reports/verification.md). |
| Current phase | V1 — final verification, review and commit |
| Exactly one next slice | **V1 — stage only the scoped candidate, inspect it, run ordinary hooks and commit** |
| Canonical plan path | `docs/plans/global-agent-repository-usability/plan.md` |
| Current invocation | `verify` — complete final evidence and ordinary commit |
| Source baseline | `6e61bd93e74686620f0cffc3e54bf00c8e5373f8` |
| Lifecycle authority | [shared-service plan](../shared-service-and-evidence-driven-lifecycle/plan.md), Verifying/blocked at M4-S1 |
| Prior routing decision | [dynamic-routing plan](../dynamic-repository-routing/plan.md); this user-authorized objective supersedes its DR-I02 decision against an installation-level default profile |
| Coding-Standards | Interface 45; catalog `sha256:8235cb21f7d1937be1a003eb2eef570345242194dac36d79463b16e26bb6d65d`; source revision inherited from lifecycle plan: `366c1d90a24bbfb50973f62b155a5f3396c0f107` |
| Composed-design review | Qualified admission recorded in [design review](reports/composed-design-review.md); independent final read-only GPT-6.1 Sol High review approved with no unresolved P0/P1/P2 finding |
| Baseline evidence | [failure and state inventory](reports/baseline.md) |
| Verification evidence | [check results, acceptance map and limits](reports/verification.md) |
| Execution ledger | [implementation and host evidence](reports/execution-ledger.md) |

This plan owns repository-independent frontend routing and its observability. The shared-service plan continues to own service election, runtime/task/resource lifecycle and task-control security. This plan does not replace that authority or accept its blocked claims.

## 1. Objective

One globally installed, unpinned `passeur` registration must work from any supported agent session and repository. Every frontend resolves its own launch context and joins or starts only the coordination service for that canonical repository. Frontends in the same repository share coordination while retaining separate session identity and task-control authority. Unrelated repositories proceed independently. Linked worktrees share the canonical repository domain while keeping their distinct source views.

Normal operation is: start an agent in a repository, start the global `passeur` frontend, and use Passeur. A user configures supported agents once at the installation level; opening another repository does not require a new registration, profile copy, binding, restart or service operation. Optional explicit CLI bindings remain for maintenance and controlled tests. Task attach remains an explicit control transfer and is never a prerequisite for joining a repository service.

## 2. Baseline, reproduction and root-cause hypotheses

The checkout is at `6e61bd93`. Its source already gives each `PasseurFrontend` a private binding and owner credential, derives repository state and service election from the canonical repository ID, and keeps a frontend source view separate from the service runtime. These owners and the shared service are preserved.

The current configured global Codex state has one unpinned `passeur` registration and no `passeur_pumas` or `passeur_tuldok` entries. The installed host may retain a previously loaded tool catalog; that is a host-process lifecycle artifact, not Passeur repository identity. The source and an incident runbook still describe named registrations, so operational guidance is stale. No current host evidence establishes why an older session exposed those namespaces.

The active Passeur `agents` request reproduced `PROFILE_MIGRATION_REQUIRED` for the profile selected in the Passeur checkout. A fresh `PATH_NOT_FOUND` was not reproduced through that installed host. Source inspection shows that a repository without its selected profile can reach `PATH_NOT_FOUND`; the current binding has no installation-level default profile. Historical `observed_dead` descriptor output is a process-identity observation, not proof that manual deletion is required. Existing bootstrap election/recovery remains repository-scoped and must be qualified under races.

The bounded diagnostics already created by `diagnosticInfo()` are narrowed to code/message at the service frame and narrowed again in client/status/MCP projections. Profile conflicts omit both profile paths. Status can report launch inputs as if effective and does not clearly show the current frontend's source/worktree view alongside service identity. Production Git identity discovery inherits ambient `GIT_*` variables even though the Git wrapper supports a sterile mode.

The adopted architecture is a per-frontend immutable launch snapshot, deterministic profile selection, canonical repository identity, repository-scoped store/election, authenticated service connection, and independent frontend task owner. Add no global current-repository map, global repository mutex, routing daemon, second profile registry, second task owner or alternate state namespace.

## 3. Binding and configuration decisions

1. The global registration omits `cwd`, `--project`, `--profile` and `--expected-repository-id`. The launched process captures its initial cwd and relevant environment; moving the host to another repository creates another frontend with a new context.
2. Repository discovery scrubs Git location/configuration override variables from the identity probe while preserving the required executable environment. Canonical Git common-directory identity remains the repository key. The resolved worktree path remains the frontend's source view.
3. Profile resolution is per frontend and deterministic: explicit launch profile; existing canonical repository profile; existing supported legacy worktree/main-worktree profile; then the installation default at `$XDG_CONFIG_HOME/muse-bridge/default-profile.json` (or `$HOME/.config/muse-bridge/default-profile.json`). Repository profiles remain optional overrides for existing supported behavior; an arbitrary new repository does not need one. A configured profile is read-only during launch. Existing schema migration remains explicit and preserves the original bytes/backup contract.
4. The one-time setup/configure path writes the installation default when no explicit profile path is supplied. Explicit `--profile` remains an advanced/pinned operation. Registration naming is not part of repository identity. Existing old named registrations can be removed only by an explicit, exact structural config migration; never delete all `passeur_*` names by prefix.
5. The XDG/HOME state-root default and repository-ID-derived state namespace stay unchanged. All service descriptors, sockets, election guards and store mutations stay under that repository namespace. There is no global repository lock.
6. Service profile compatibility remains strict. A mismatch must identify the requested/resolved profile and elected service profile with bounded safe context. Connecting to a service does not transfer task control.
7. Status separates frontend/build identity, launch inputs, resolved repository binding/source view/profile provenance/state namespace, and connected service identity/generation/build. An unresolved field is reported as unresolved; launch input is never labeled as an effective binding.
8. `stage`, `path`, `native_code` and `next_action` survive the service protocol, client reconstruction, frontend/status storage and MCP projection. Secret redaction and strict bounded decoding remain in force.

## 4. Preserved ownership and compatibility

The repository service continues to own accepted work after a submitting frontend disconnects. Frontends in one repository use separate authenticated owner identities; each may submit and control its own work. Another frontend may use the same service without attaching to anyone else's task. Human-confirmed `passeur_attach` remains for transfer/adoption only.

Canonical repository identity and source/worktree view remain distinct. Same-repository service election remains serialized by the existing repository-specific guard/lease. A dead process or stale descriptor is reconciled through elected bootstrap ownership; no global lock, manual descriptor deletion, heartbeat stealing, duplicate coordinator or mutation replay is introduced. Cross-repository service errors and election waits must not block or redirect another repository.

Retain only compatibility needed by actual consumers: explicit CLI project/profile binding, currently supported legacy profile lookup/migration, and stale host catalogs until their processes naturally reload. Remove the architectural dependency on named MCP registrations. Add exact structural cleanup guidance/tooling only if supported by the config editor's ownership checks and backup behavior.

## 5. Acceptance claims

| ID | Observable criterion | Evidence required | State |
| --- | --- | --- | --- |
| GAU-1 | One unpinned global `passeur` registration resolves each launch independently, with no global repository affinity or lock. | Registration/config contract, concurrent process tests, and one-registration Codex host sessions | passed |
| GAU-2 | A repository with no local profile uses the installation default; optional repository override and explicit CLI profile remain deterministic. | Profile precedence/setup tests, missing-path projection and provenance assertions | passed |
| GAU-3 | Concurrent same-repository frontends attach to one service, retain distinct task ownership, and accepted work survives the submitting frontend. | Concurrent process election, distinct owner/control test, and service-owned completion after frontend shutdown | passed |
| GAU-4 | Concurrent unrelated repositories have independent identity, profiles, stores and service elections; blocked activity in one does not block another. | Concurrent process integration and actual Codex sessions across two repository IDs/generations | passed |
| GAU-5 | Linked worktrees share canonical service identity but report and use their own source view. | Worktree binding/status tests and actual Codex host session | passed |
| GAU-6 | Restart, stale descriptor, dead service, profile mismatch, missing path and old registration remnants have deterministic recovery or bounded actionable failures. | Bootstrap/attachment recovery tests, failure projections and safe exact-name cleanup docs | passed |
| GAU-7 | Status distinguishes effective frontend binding from launch inputs and names connected service generation/build. | Versioned contract tests and live process/host status assertions | passed |
| GAU-8 | Typed bounded diagnostics survive all connection and MCP boundaries; profile conflict reports both effective paths. | IPC/status/MCP/startup/readiness projection, redaction, UTF-8 bound and long-path tests | passed |
| GAU-9 | Existing task-control authority and resource/lifecycle guarantees remain intact. | Separate frontend owner/control test and focused lifecycle/service regressions | passed |
| GAU-10 | Documentation presents one global registration and removes routine named-registration repair guidance. | README, setup, skill and troubleshooting review; historical report clearly marked superseded | passed |
| GAU-11 | Multiple simultaneous real Codex/agent host sessions use Passeur across two independent repositories without repository-specific registration. | Host version, exact one-entry configuration/command, four concurrent session bindings and service identities | passed |
| GAU-12 | An independent read-only GPT-6.1 Sol High architecture/lifecycle review finds no unresolved P0/P1 issue on the exact candidate. | Final report with 27-file candidate identity and disposition | passed |
| GAU-13 | The reviewed repair is committed through ordinary hooks. | Commit identity and clean owned diff; unrelated files preserved | pending |

Automated tests do not substitute for GAU-11. If the host or required account-backed behavior is unavailable, record the exact limitation and leave acceptance blocked rather than inventing an equivalent claim.

## 6. Standards and design admission

Coding-Standards was routed through interface 45 using the library + launcher, TypeScript + async, generated-contract/IPC/persistence, and architecture/concurrency/contracts/cross-platform/diagnostics/resilience/security facts. Core and Router were read first, followed by the selected canonical module closure. All selected modules were available as normative reads; `application_exposure=unreviewed` is an attestation state, not unavailable guidance. No module is claimed unavailable and no repository-wide conformance claim is made. The selected IDs and application result are recorded in [the baseline report](reports/baseline.md).

The current lifecycle plan is Verifying, so its `continue` operation cannot authorize this separate architecture goal. This new task-specific artifact is `Planned`→`Active` under explicit `start`; it delegates no authority over task lifecycle or resource ownership.

The eight-probe design admission is in [the composed-design review](reports/composed-design-review.md). It qualifies the design for implementation subject to real-host evidence; it does not imply acceptance.

Operation history: `start` admitted M0 and this plan on 2026-09-30 under the user's explicit end-to-end implementation request. `continue` executed M1–M4. The current `verify` invocation records final evidence and proceeds to the requested commit, subject to the remaining V1 gate.

## 7. Write sets and milestones

**Lead owner:** one implementation lead. Keep changes in the following coherent family and preserve unrelated state.

| Slice | Bounded write set | Gate | State |
| --- | --- | --- | --- |
| M0 — admission | This plan and its reports | Baseline/failure classification and design review recorded | Implemented |
| M1 — binding and profile | `src/core/repository-runtime.ts`, `src/workspace/project.ts`, relevant `src/cli.ts` setup/launch behavior, binding/profile tests | New repo uses global default; old repository identity and task/service owners unchanged | Completed |
| M2 — status and diagnostics | `src/contracts/runtime.ts`, `src/contracts/service.ts`, `src/service/client.ts`, `src/service/server.ts`, `src/service/transport.ts`, `src/mcp/server.ts`, affected projections/tests | Every relevant boundary preserves bounded typed context; status distinguishes launch and resolved/service data | Completed |
| M3 — concurrency qualification | Focused integration fixtures/tests under `tests/integration/` and relevant core tests | Same repo, unrelated repos, worktrees, frontend/service restarts, stale descriptor and task survival demonstrated | Completed |
| M4 — compatibility and operations | `src/codex/config.ts` only if exact safe cleanup is justified; README and affected setup/recovery/attached-tools docs; this plan's evidence | One global registration instructions; no routine named registration repair; docs match supported behavior | Completed |
| V1 — real host, review, commit | Evidence reports and owned source/docs only | Focused checks, real-host qualification and independent review complete; final staged-diff review and ordinary commit remain | Active |

Do not add dependencies, mutate personal configuration, authenticate, use live accounts, or publish. Qualification uses disposable repositories and local/test profiles unless a separately permitted existing tool path is explicitly available. Normal hooks run at commit.

## 8. Verification and re-plan rules

Add regression coverage only for behavior changed here. Run the relevant focused tests, full type/build/core/native/Vitest suite when dependencies permit, then real-host checks. Record exact commands, results, candidate/build identity, host/session/repository identities, and limitations in `reports/execution-ledger.md` and `reports/verification.md`.

Re-plan if the host does not provide its active project context to the stdio frontend, the existing repository guard permits duplicate active coordinators, a safe installation-default profile cannot preserve existing configured behavior, cross-repository work shares mutable service state, or diagnostics require exposing credentials/ambient environment. A failure that disproves one of these assumptions is a design trigger, not grounds to weaken ownership or isolation.

The plan is complete only when all acceptance claims are evidenced and the requested commit exists. Partial checks or removal of the currently observed Pumas/Tuldok symptom do not imply acceptance.
