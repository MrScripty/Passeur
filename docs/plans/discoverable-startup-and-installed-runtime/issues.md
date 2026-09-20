# Issues and dispositions

Severity describes consequence in the admitted scope, not an independently verified incident frequency. Source observations are recorded in reports/standards-and-baseline.md. Owners below are responsibility roles; the implementing invocation records actual participants.

| ID | Severity / evidence | Relationship and owner | Disposition | Required verification / revisit trigger |
| --- | --- | --- | --- | --- |
| F1 | High operability: P1 shows project/profile/state/lease prerequisites before MCP discovery. | Direct objective; runtime/MCP owner. | Fix in S1. | A1, A3–A4; operational blockers keep tools/status available. |
| F2 | High diagnostic/safety ambiguity: P2 maps arbitrary lock exceptions to contention. | Direct objective; lease/error owner. | Fix in S1. | A2; actual EACCES differs from ELOCKED and retains stage/cause. |
| F3 | High recovery risk: P5 catches arbitrary record-read failures before quarantine; readers use incomplete shape checks/casts. | Same authoritative-state failure family; TaskStore/recovery owner. | Fix in S1 for the bounded persisted population. | A5; real reopen, supported historical variants, no quarantine on permission/unsupported version. |
| F4 | High deployment ambiguity: P3/P4 register one mutable development CLI and verify configuration only. | Direct objective; installation/Codex adapter owner. | Fix in S2. | A6–A8; installed closure, exact running identity and real stdio probe. |
| F5 | Medium multi-project usability: P3 owns a single fixed name. | Direct objective; Codex adapter owner. | Fix in S2. | A7, A10; explicit names, collision handling and unrelated config preservation. |
| F6 | High acceptance gap: P8 records installed/live checks as pending. | Direct objective; verification operator. | Verify in S3; do not mark resolved from source fixes. | A8–A10 and any separately linked older-plan claims. |
| F7 | Coordination safety limitation: changing ambient state roots changes the current lease namespace. | Related constraint; repository maintainer. | Fix managed-binding determinism in S2; defer physical lease relocation/state migration. | Revisit when migration or multi-user coordination is actually required; no silent alternate-root workaround. |
| F8 | Host lifecycle uncertainty: exact local attachment trigger is not observable from repository code. | Required-real evidence; Codex integration operator. | Measure at S3; defer any unproven Codex workaround. | A9/A10 fail with captured phase/version evidence; no global policy changes on speculation. |
| F9 | Future arbitrary agents and concurrent clients of one repository. | Separate feature; product/architecture owner. | Deferred, outside this plan. | Revisit after stabilization acceptance or explicit changed product requirement. |
| F10 | Compatibility correction already in P9. | Preserved adapter contract; Muse adapter owner. | Retain regression; verify installed path, not reimplement. | A9 with actual installed runtime; a name-format unit check alone is insufficient. |

A new issue enters the current slice only when required for its admitted contract and covered by its write set, or through an explicit re-plan. Unknown owner/authority, a real unsafe outcome, or a failing required claim cannot be closed by documenting it as a generic future improvement.

## Implementation findings and evidence blockers

| ID | Severity / owner | Evidence and disposition | Required closure |
| --- | --- | --- | --- |
| I1 | Blocking / integration owner | Full repository archive and pinned package provisioning were unavailable in the preparation container. A baseline-checked source update preserves unrelated content. | Apply against the actual checkout; run npm ci, check, full tests and build before acceptance. |
| I2 | Blocking / installed acceptance owner | No authorized actual Codex/Muse/account or Pumas/Tuldok access was available for runtime execution. | Execute A8–A10; retain actual identities, transcripts, receipts and cleanup evidence. |
| I3 | Material / runtime owner | Preparation originally depended on profile-location configuration. Fixed: profile location is optional for coordination/history and required only by execution/configuration. | Full dependency-backed runtime tests remain required. |
| I4 | Material / lease owner | proper-lockfile stops its heartbeat before release unlink; release failure cannot safely retain a held-authority assertion. Fixed: invalidate authority and report failed release. | Focused controlled test passed; real lock-library/process evidence remains blocked. |
| I5 | Material / config owner | Explicit adoption of an unmarked TOML table uses semantic serialization, which may remove comments/formatting. It is not automatic; a backup and explicit adoption authority are required. | Validate with actual smol-toml/Codex and review resulting user config. |
| I6 | Verification / build owner | New smol-toml 1.6.1 lock metadata is explicit, but npm resolver/SRI confirmation could not run here. | npm ci must verify the selected published bytes; do not substitute an unlocked package. |
