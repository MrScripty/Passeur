# Verification status — dynamic repository routing

**Candidate state:** source implemented; objective acceptance blocked.

## Satisfied design-selection evidence

Current Codex source was inspected for the external assumption that makes unpinned registration viable: stdio server `cwd` is optional and the local stdio launcher receives the runtime local process cwd. This supports the selected design. It is not evidence that the user's installed Codex host has completed the routing workflow.

Source review also confirms that Passeur service path/election/store/lease authority remains repository-scoped and was not replaced by this change.

## Required executable evidence

Run from the exact branch in a supported complete checkout:

```sh
npm ci --legacy-peer-deps
npm run check
npm run build
npx vitest run tests/unit/codex-config.test.ts \
  tests/integration/mcp-startup.test.ts \
  tests/integration/registration-probe.test.ts
npm test
```

Then build/install the exact candidate through the repository's existing installation procedure. Register one unpinned server in the selected shared state namespace. In fresh Codex sessions rooted in two unrelated repositories, verify `passeur_status.binding.project_input` reflects each session, prepare both, and verify repository/service identities are distinct. Repeat from a linked worktree and verify it shares the original repository service/profile. Preserve the actual status/build/generation evidence.

Finally obtain independent read-only review of the exact checked candidate, concentrating on registration replacement authority, state namespace uniqueness, profile compatibility and frontend/service lifecycle.

## Current environment result

The current execution environment cannot run the repository dependency-backed gates: shell network access is unavailable, the npm dependency cache is absent, and no GitHub Actions run is available for this repository through the connected account. A temporary verification workflow produced no run and was removed. Therefore DR-A1–DR-A6 remain blocked/pending as stated in the plan. No passing test, build, installed-host, or user-workflow claim is made.


## Review repairs

The first CodeRabbit source review identified four valid issues. The candidate now parses registration binding options with Node `parseArgs` semantics (including `--flag=value`), resolves legacy profile roots through Git main-worktree metadata for ordinary worktrees, submodules and separate Git directories with current-worktree fallback when Git exposes no reverse main path, scrubs inherited `GIT_*` variables from temporary fixture Git subprocesses, and builds `dist/src/cli.js` before focused integration tests in this procedure. These repairs have source/regression coverage but remain subject to the executable gates above.
