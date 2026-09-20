# Reconciliation with 49724a8

The supplied plan targeted `b0c162d`; the intervening startup implementation established a new ownership boundary. This package uses the actual `49724a8b65bf7540622934e4f25cc3178f9c00dc` production source, reconstructed from prior implementation artifacts and checked against Git subtree/blob hashes before edits.

| Earlier assumption | Revised implementation |
| --- | --- |
| MCP composes coordinator directly | Preserve RepositoryRuntime and its lazy execution composition, lease and drain. |
| Startup-fixed registry; invalid profile is startup failure | Provisional lazy reads, retryable failed pre-admission configuration, fixed registry only after successful composition. |
| Five neutral tools | Retain status/prepare; seven neutral plus four compatibility tools, one execution path. |
| New persisted validation foundation needed | Extend existing record-codecs and TaskStore with v3 and cross-record admitted identity. |
| Coordinator-only retry changes | Runtime performs historical lookup before execution prerequisites and hands live subscribers to the coordinator owner. |
| Old registration workflow | Preserve named server bindings, installed identity, exact runtime path and existing replacement authority. |
| General adapter tutorial | Add runtime owner, lazy-loading, server/agent/vendor identity separation and installed-artifact qualification. |
| Core compaction before receipt | Return the full internal result; only the MCP receipt is bounded, avoiding invalid shortened delivery/counts. |
| One reused hash for all identities | Keep old request/disposition hashing unchanged; use deterministic code-unit ordering for new v3/config identity. |

The Codex native generated schema uses hyphenated `workspace-write`/`on-request` in thread-start input, distinct from returned `workspaceWrite`. The implementation follows those sources and rejects mismatched effective settings. Required native control/credential behavior remains unqualified.

The startup plan's pending installed-host claims remain active under its existing owner. No source candidate or substitute test result upgrades that plan to Accepted. Existing state roots, lease location, Muse client identifier and ref namespaces remain unchanged.
