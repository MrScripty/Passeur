---
name: muse-bridge
description: Set up or troubleshoot Passeur's Codex MCP registration, delegate independent tasks to parallel Muse CLI workers, locate committed results, and account for Passeur-owned resources.
---

# Passeur / Muse Bridge

Codex owns decomposition, dependencies, base selection, integration, broader testing and acceptance. Muse owns its scoped implementation, verification and ordinary standards-compliant commits. Passeur manages execution and deliverable resources; it does not test, repair, merge or create PRs.

Read [setup](references/setup.md) for installation or migration. Use schema version 2 for execution.

## Bootstrap Codex

When setup is requested or the Passeur tools are unavailable, read the setup reference. With an existing profile, offer to run `./passeur register-codex <project>` after receiving authority to update the user's Codex configuration. This preserves unrelated settings, backs up an existing config and verifies the registered server. Tell the user to restart Codex after success; the current session cannot acquire newly registered MCP tools.

## Delegate

Supply a stable unique request key, bounded objective, self-contained context, scoped acceptance criteria and useful relative file references. Implementation requires an exact base commit and a full local target ref. The target is metadata, not permission for Passeur to modify it.

Use `delegate_to_muse` for one assignment or `delegate_to_muse_batch` for up to eight independent assignments. Concurrent tasks need not be related. A batch groups only submission/waiting, not feature acceptance or testing. Requests remain pending until their tasks finish. Do not poll; request retained evidence only when needed.

Muse should read repository instructions, perform appropriate scoped checks, respect Git hooks, stage intentionally and commit on its owned branch. Unfinished surrounding work is not a requirement to complete another task. Failed required scoped checks are repaired within the assignment or reported as blockers. Passeur adds no verification or automatic repair loop.

## Consume results

Use the returned commit/ref/worktree references. The files can be tested or integrated without loading the entire diff into context. There is no mandatory primary-model review at each worker completion; decide when larger review or testing is useful.

Distinguish execution status, delivery status, reported checks and current resource state. `committed` is a Git identity claim, not proof of hooks, correctness or standards compliance. A failed run can leave useful committed work. Uncommitted residue is incomplete delivery. A no-change result needs a worker explanation and matching Git facts.

## Integrate and account for resources

Integrate through the repository's normal Git workflow when appropriate. Passeur does not choose the mechanism or combine contributions automatically.

Then use `muse_finalize` with explicit expected task head/ref and a stable operation key to acknowledge integrated work, retain it with an owner/reason/next action, or archive it under explicit authority. Integrated retirement requires full-tip ancestry into the accepted target. Merely claiming integration or matching patches is insufficient.

Passeur removes only its clean, stopped, accounted-for resources. Resolve ignored build outputs through repository cleanup policy first. Unknown shutdown freezes replacement execution until manual reconciliation. Healthy unrelated workers need not be cancelled for ordinary task failure or retirement.

Read `docs/recovery.md` for legacy history, partial retirement and offline reconciliation. `cleanup` now collects bulky evidence only after resources are accounted for; it preserves identity and disposition receipts.
