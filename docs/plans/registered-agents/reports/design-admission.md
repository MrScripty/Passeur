# Composed-design admission

Applicability: applicable. Subject: the registered-agent source composition relative to Passeur 49724a8. This is design inspection, not native qualification or a certificate of whole-codebase compliance.

## 1. Independent concerns and dimensions

RepositoryRuntime answers where/when a connection is bound, who owns its coordination, how preparation/recovery/drain occur and why operational failures cannot hide the interface. Coordinator answers which admitted task owns cancellation, capacity and terminal publication. Registry answers which approved configuration an agent ID selects. Native adapters answer how a particular runtime executes and stops. Codecs/store answer which persisted facts can be trusted after restart. MCP/CLI project operations and operator authority. Skills/documentation guide maintainers without becoming another execution-policy owner.

These concerns change for different reasons: repository startup policy, scheduling semantics, operator registration edits, vendor protocol evolution, persisted compatibility, presentation and authoring guidance. Packaging them in one release does not merge authority.

## 2. Required versus accidental interleavings

Required: admitted request/configuration identity before effects; lease authority before repository mutation; first-owner cancellation plus duplicate subscribers; same-call waiting through native shutdown and terminal persistence; actual Git delivery after confirmed stop; resource protection before retirement. Snapshot policy/config identity is intentionally frozen at admission, while resource disposition is a later separate authority.

Removed accidental coupling: native SDK/credentials before tool discovery; one global Muse profile in every task; current profile/model controlling historical identity; Muse-specific report marker in generic prompts; provider-specific output shortening before public counts. Retained necessary coupling: one scheduler/store namespace for all agents sharing one repository; compatibility selection of the reserved Muse ID.

## 3. Knowledge required of callers, peers and composition

Callers know agent IDs, supported modes, assignment/base/target, request keys and explicit disposition—not provider flags or process teardown. Coordinator knows WorkerAdapter.run and immutable snapshot/policy, not native SDK/session types. Registry knows trusted config factories and capability restrictions, not mutable native sessions. Runtime knows lazy configuration, coordinator construction and repository lifetime, not provider choices inside a task. Native factories know options and how to build a task-owned adapter lazily.

The composition root names the two config-only definitions. Adding a provider should not change request scheduling, Git observation or persisted resource retirement. The authoring skill explains these boundaries rather than introducing executable configuration authority.

## 4. Representative change locality

Another model/profile: operator registration, native option validation if necessary, and configuration evidence. No scheduler change. New native runtime: adapter/config module, tests/dossier, one builtins entry and dependency closure if needed. Native approval encoding change: that adapter's decoder/mapping and fixtures; common approval semantics change only with an explicit shared-contract decision. Global queue/deadline change: neutral policy/coordinator and affected fixtures. Historical migration: existing codec/store/recovery family and consumers. New caller tool: MCP projection/allowlist and contract fixtures. Installed runtime packaging change: existing install owner and release evidence.

Unexpected required edits outside these semantic owners are a re-plan signal, not justification for more wrappers.

## 5. Stable interfaces and leaked knowledge

Stable: validated assignments, execution policy, worker events/results, selected identity, actual Git/resource contracts. Native SDK imports, permission vocabulary and authentication paths are private to each adapter. The v3 request/config hash is a specific identity protocol, not a general validator. Legacy hashes are retained only at their actual persisted/public consumers. The profile packages scheduling and registrations but their owners remain independently typed; an umbrella provider policy is not introduced.

Codex's consumed native schema projection is independently versioned by its adapter contract string. Future independent external adapter deployment is not promised; no plugin protocol or adapter loader is exposed now.

## 6. Independent evolution, evidence, failure and replacement

Config factories can fail independently and remain visible in the catalog without starting native processes. Ordinary task failure is isolated; unconfirmed process shutdown or missing terminal publication intentionally invokes shared containment because it threatens repository safety. Native transport can be tested with actual controlled processes; native guarantees still require installed runtime evidence. Migration codecs need genuine dependency-backed producer/consumer tests, not in-memory substitutes.

A provider can be removed while stored results remain readable. Runtime configuration changes require controlled restart but do not reinterpret admitted history. Model/provider fallback is not a replacement strategy.

## 7. Deletion tests

Deleting the registry puts approved selection, restrictions and snapshot construction into every caller/coordinator; keep it. Deleting native adapters distributes vendor/session/permission knowledge through task owners; keep them. Deleting neutral worker types restores vendor-dependent core imports; keep the interface. Deleting the new identity representation loses restart/retry authority; keep it. Deleting profile-edit helper would duplicate bounded backup/conflict/publication semantics in CLI branches; keep the cohesive operator operation. Deleting codec extensions leaves new persisted facts unvalidated; extend the existing authority rather than adding another framework.

Deleting the small native stdio transport distributes framing/backpressure/callback/process ownership into the Codex adapter; retain this provider-local mechanism. Deleting the common cancellation test helper duplicates only a narrow real shared invariant; keep it test-only and small. Deleting an external plugin ABI, dynamic loader, automatic routing engine, per-provider scheduler or generic workflow engine removes speculative complexity without losing the objective; none is introduced. Deleting the old core compactor removes a redundant and potentially misleading projection; it is removed. Legacy public tools remain only for actual existing consumers and route to the same path.

## 8. Necessary complexity and retained total

Necessary complexity is at native lifecycle/permission boundaries and persisted compatibility, not a framework spread through callers. Retain one runtime owner, one coordinator, one registry, two native adapters, current store/codecs, explicit operator edits, existing install/registration machinery, and a narrow authoring workflow. Four compatibility tool aliases do not retain old internal worker paths. New native configuration/contract details stay adapter-local.

Review source locality and evidence at final qualification. Passing tests does not itself prove simplicity. Required-real native controls, full dependency-backed compilation and independent review remain blockers; do not use this admission as proof that the installed implementation enforces them.
