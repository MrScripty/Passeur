# Dynamic repository routing

Status: Active

## Goal

Use one Codex-facing Passeur registration across repositories while preserving one elected Passeur service, lease, state store, and execution authority per canonical Git repository.

A Codex session supplies repository context through the working directory inherited by its stdio MCP process. Passeur resolves that directory through the existing canonical repository binding before service discovery or preparation. Linked worktrees continue to share the canonical Git common-directory identity and unrelated repositories continue to use separate service/state namespaces.

## Product contract

- A global Codex registration can start Passeur without a pinned `--project`, `--profile`, `--expected-repository-id`, or MCP `cwd`.
- An unpinned `serve` process uses its inherited current working directory as the project input.
- Explicit `--project` remains available for operator commands and intentionally pinned compatibility registrations.
- Repository state remains under the existing `<state-root>/muse-bridge/repositories/<repository-id>` authority.
- The default execution profile identity is repository-stable so linked worktrees resolve the same profile.
- Build/profile conflicts inside one repository remain explicit. Unrelated repositories never contend for the same service election or repository lease.
- Discovery remains lazy: tool listing and frontend status do not acquire a repository lease or start inference.

## Design

Retain `RepositoryRuntime`, `resolveRepositoryBinding`, service election, IPC, task storage, and lease ownership unchanged. Change only the binding source above them:

1. Codex dynamic registration records the runtime, state root, catalog, and startup policy, but omits a fixed MCP `cwd` and repository arguments.
2. Codex launches the stdio process in the active project directory. `serve` uses `process.cwd()` only when no explicit project was supplied.
3. `resolveRepositoryBinding` canonicalizes that project exactly as it does today.
4. The fallback profile path is keyed by canonical repository ID instead of an individual worktree path.
5. Existing explicitly pinned registrations continue to validate and run through the same transport contract. Replacing a named pinned registration with a dynamic registration still requires the existing explicit binding-replacement authority.

No multi-repository scheduler, global mutable runtime, alternate state namespace, lease relaxation, or tool-local repository selector is introduced.

## Standards admission

The existing repository runtime and service-election mechanisms already satisfy the required ownership and concurrency behavior. The mismatch is at the registration seam, where repository identity is selected too early. Reusing the existing binding owner is the smallest reversible production implementation that resolves the demonstrated mismatch.

The material write set is limited to the registration/binding owners, direct verification/probe code, focused regression tests, and current user/agent guidance.

## Verification

Acceptance requires:

- static type/check suite and repository tests pass;
- a dynamic registration serializes without `cwd` or repository pin arguments;
- Codex inspection accepts a null/omitted configured `cwd` only for an unpinned registration;
- a real stdio frontend launched with no `--project` reports its inherited project root;
- two frontends launched from linked worktrees share one service generation and default profile path;
- two unrelated repositories launched from the same global registration obtain different service generations;
- retained pinned-registration tests continue to pass;
- direct registration probing validates both build identity and the selected dynamic launch context without claiming actual host attachment.

## Re-plan triggers

Re-plan only if verification shows that the supported Codex host does not supply the active project as the fallback stdio working directory, the dynamic registration weakens repository/state isolation, or profile identity cannot be made repository-stable without a separate migration authority.
