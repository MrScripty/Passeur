---
name: muse-bridge
description: Configure or diagnose Passeur MCP registrations, prepare repository coordination, delegate independent Muse work, read retained evidence and account for owned resources.
---

# Passeur / Muse Bridge

Codex owns decomposition, dependencies, base selection, integration and broader acceptance. Muse owns its scoped implementation, verification and ordinary commits. Passeur owns execution/resources; it does not test, repair, merge, create PRs or certify worker-code correctness.

Read [setup](references/setup.md) before installation, registration or troubleshooting. Obtain authority before changing personal configuration, installing packages, spending inference allowance, changing permissions or retiring resources.

## Diagnose before delegation

Use `passeur_status` to inspect the running build and observed readiness. It is read-only and does not prove Muse compatibility. `not_checked` means no observation. `passeur_prepare` explicitly acquires authority and initializes/imports/reconciles supported state without inference. Delegation also prepares automatically.

Tools remain listed when the profile/state/provider is operationally unavailable. Interpret the returned failure: genuine contention, permission, unsupported version and corruption are different. Preserve the configured state namespace and authoritative records. A second coordinator may diagnose but must wait for safe owner handover before executing. Do not delete locks, auto-kill unknown owners or substitute another state directory.

A repaired pre-admission failure can be retried in the same Passeur process. Running code does not change when source or installed artifacts are rebuilt. Rebinding a ready process or replacing its active execution profile requires controlled shutdown/restart. New Codex namespace attachment must be checked in the actual installed host; registration is not proof of live attachment.

## Delegate and consume

Use task schema 2 and a stable unique request key. Include a bounded objective, self-contained context, scoped acceptance criteria and useful relative file references. Implementation requires an exact base commit and full local target ref. The target is disposition metadata, not permission to modify it.

`delegate_to_muse` awaits one task. `delegate_to_muse_batch` awaits up to eight independent tasks without introducing feature grouping or fail-fast cancellation of siblings. Calls remain pending; do not poll. Request full retained evidence only when useful.

Workers read repository instructions, change only their scope, run required scoped checks, preserve hooks, inspect staged changes and commit on the assigned branch. Surrounding unfinished components do not authorize expansion. Report a blocker when required work exceeds the assignment. No automatic Passeur repair or per-worker primary-model review is introduced.

Distinguish execution status, committed-delivery identity, worker-reported checks and current resource state. A commit is not a correctness certificate; failed execution can leave useful committed work. Uncommitted residue is incomplete delivery.

## Integrate and account

Integrate through normal user/repository Git authority. Use `muse_finalize` for explicit integrated, retained or archived dispositions with the expected task head/ref and stable operation key. Preserve the whole task tip under a verified protecting ref; patch similarity alone is not integration authority.

Read `docs/recovery.md` for offline recovery and historical records. History and administrative operations do not require a working inference profile. Unknown worker shutdown remains unresolved, and corrupt/unsupported/unreadable records are never replaced with an empty successful state. Cleanup collects eligible bulky evidence only and preserves identity/disposition receipts.

Use `docs/installed-acceptance.md` for opt-in real-host verification. Report configuration, direct MCP transport, readiness and live workflow evidence separately; no simulated or unrun check becomes accepted.
