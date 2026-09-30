# Dynamic repository routing execution ledger

## 2026-09-29 — admission and implementation

- Passeur baseline: `46f5e8651240eb84e752940885073f6f338b9145`.
- Coding-Standards baseline: `39d55dc330d44ecf940364ceada9d2527f7c7ea0`.
- Demonstrated mismatch: repository service/state/election/lease were already keyed by canonical repository identity, while Codex registration pinned one project/profile/cwd before the frontend reached that owner.
- Development decision: implement the smallest reversible seam repair; retain `RepositoryRuntime`, service election, IPC, task state and repository lease.
- Upstream design observation: current Codex source at `8c3612fb638d356579c446de68421288164484dc` models stdio `cwd` as optional and constructs the local stdio launcher with the runtime local process cwd when no server cwd is selected. This resolved the design-selection uncertainty; real-host acceptance remains separate.

Implemented on `feat/dynamic-repository-routing`:

- unpinned Codex registration and inherited-cwd `serve` routing;
- pinned-registration compatibility;
- canonical repository-ID default profile with deterministic main-worktree legacy fallback;
- explicit-profile/expected-repository setup/configure preservation through pinned registration;
- symmetric dynamic/pinned state-root conflict protection;
- direct probe support for dynamic launch context;
- focused registration, state, linked-worktree/profile and unrelated-repository tests;
- current design/install/README/agent guidance.

Material findings repaired during implementation:

1. An initial repository-ID-only profile change would have hidden legacy default profiles. Repaired by canonical legacy fallback with new-key precedence.
2. An initial setup/configure path could have silently ignored an explicit custom profile under global registration. Repaired by retaining a pinned registration for explicit profile/repository identity.
3. Initial dynamic state-root validation was one-directional. Replaced with explicit structural `PasseurBinding` classification and symmetric state-namespace checks.
4. A new test coupled to a library-specific TOML table type. Replaced with an ordinary record assertion under the repository's strict TypeScript settings.

## 2026-09-29 — source and environment verification

Observed:

- Branch remained based directly on the admitted Passeur baseline; unrelated main history was not changed.
- Registration consumers are bounded to CLI construction, Codex config merge/inspection, direct probe, and their tests.
- A local TypeScript 5.8.3 strict/exact-optional minimal fixture passed for the new optional registration object construction and `PasseurBinding` shape. This is supporting inference evidence only, not the repository compile claim.
- The shell cannot resolve external hosts and the npm cache does not contain Passeur's dependency closure.
- A temporary branch-only GitHub Actions workflow was added solely to seek executable evidence; the repository/account exposed zero workflow runs. It was removed from the candidate and is not retained product machinery.
- Direct branch archive download was unavailable under the execution environment's network/download policy.

Not executed and therefore not claimed:

- `npm ci --legacy-peer-deps`;
- `npm run check`;
- focused Vitest integration/unit tests;
- `npm test`;
- installed runtime build;
- fresh real Codex two-repository host workflow;
- independent final review.

Disposition: source implementation is complete; plan transitioned to **Verifying** with acceptance **blocked** on V1. No merge to `main` is authorized by this evidence.


## 2026-09-29 — CodeRabbit review repair

Independent draft review raised four valid findings and each was repaired within the admitted routing slice:

1. Registration binding parsing now uses Node `parseArgs` with the same string-option semantics as the CLI, so separate and inline forms participate in validation, same-binding comparison and state-namespace conflict checks.
2. Legacy profile lookup no longer infers the main worktree from the common-dir basename. Workspace Git ownership now resolves the current top-level/per-worktree/common dirs, uses shared `core.worktree` for submodules when present, validates Git's listed main worktree, and retains the current legacy key only when a reverse main path is unavailable.
3. Temporary integration repositories now run Git with inherited `GIT_*` variables removed, preventing caller repository-location/index/object overrides from redirecting fixture mutation.
4. The focused verification recipe now runs `npm run build` after the no-emit type check and before integration tests that launch `dist/src/cli.js`.

Added regression coverage for inline project/profile/repository/state arguments, inline state-root conflicts, separate-Git-dir legacy lookup, submodule linked-worktree legacy lookup, and isolated Git fixture execution. Acceptance remains blocked until the documented executable and real-host gates run.
