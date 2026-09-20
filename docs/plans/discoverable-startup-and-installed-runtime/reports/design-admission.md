# Composed-design admission

**Status:** Proposed composition reviewed during planning; implemented-artifact review pending.  
**Canonical binding decisions:** [plan.md](../plan.md), section 4.  
**Applicability:** applicable. This change alters composition, readiness lifetime, runtime distribution and externally consumed diagnostics.

This report answers the Architecture artifact probe. It does not introduce independent binding policy or certify code that has not been implemented.

## 1. Independent concerns and their dimensions

| Concern | What / why | Who | How / where | When |
| --- | --- | --- | --- | --- |
| Control interface | Discover supported operations and expose truthful outcomes despite execution failure. | MCP adapter | Existing stdio SDK server; typed operation projection. | Process startup through transport closure. |
| Repository readiness | Establish and retain coordination prerequisites without scattering acquisition/retry order among callers. | Repository runtime | One process-owned preparation/authority lifecycle composing existing owners. | Explicit prepare or protected operation; ends at safe close. |
| Task execution | Admit independent tasks and preserve request identity, capacity, cancellation, delivery and worker stop. | Existing Coordinator | Existing pool, task registry and worker interface. | Admission through terminal execution. |
| Durable records | Authoritative task/result/resource/receipt/safety records and supported history. | TaskStore and its decoders | Existing filesystem persistence; complete boundary decoding and preservation. | Beyond one process, including recovery and read-only inspection. |
| Resource disposition | Protect useful commits and retire only stopped, accounted-for owned resources. | Existing DispositionManager/cleanup | Existing Git/resource invariants, under current coordination authority. | Explicit disposition, not automatically at every worker result. |
| Installed runtime | Stable executable/dependency closure and truthful build identity. | Build/install owner | Staged version-specific directory, final artifact manifest and dependency metadata. | Explicit build/install/upgrade, independent of task admission. |
| Codex binding | Name a project connection and establish what the host will launch. | Codex configuration adapter | Validated binding, grammar-aware TOML, conflict-aware update and bounded exact-command probe. | Explicit registration and verification. |
| Agent interaction | Preserve vendor-specific session, approval and stop semantics. | Existing Muse adapter | Pinned SDK interface and native process lifecycle. | Delegation only; live acceptance supplies compatibility evidence. |

These are responsibilities, not a requirement to create one new class, registry or service for each row.

## 2. Required and accidental interleavings

Required order: validated binding before authority; valid lease before task-state/resource mutations; durable task intent before worker startup; reconciliation before new admission; stopped/protected resources before retirement; complete staged artifact before installed publication; observed terminal work before clean shutdown.

Accidental order being removed: profile/subscription/state availability before tool discovery; successful inference configuration before historical reads or offline reconciliation; repository working directory existence before the MCP process can spawn; current source HEAD as identity for an already-running build; one hard-coded Codex name as identity for all projects.

### Canonical authority scope

The runtime owns readiness and its lease lifetime. It references repository identity, profile policy, task state and adapter contracts; it does not become canonical for their meanings. The artifact manifest owns identity and composition of installed bytes. It references dependency versions but does not own task schemas, user model selection, approval policy or Codex account state. Status is a projection, not a second authority or permanent state store.

### Version roles and actual consumers

| Contract | Consumer / deployment | Version and overlap treatment |
| --- | --- | --- |
| Readiness implementation interface | Coordinated Passeur modules | Replace coherently; no compatibility shim for old internal constructors. |
| MCP tool/status representation | Independently installed Codex and direct probe | Explicit diagnostic schema version and complete decoder; retain existing task tools/schema-v2 promises. Update allowlist and skill together. |
| Stored tasks and receipts | Current runtime, retained v1/v2 history, offline commands | Preserve actual supported representations. A new diagnostic schema does not bump task/resource versions. |
| Installed build manifest | Runtime identity reader, installer and registration probe | Version only the manifest representation; build identity changes with its declared build inputs. |
| Codex configuration | Installed Codex, user and Passeur writer | Match the installed consumer and destination grammar. Preserve unsupported unrelated fields rather than guessing them. |
| Muse session protocol | Independently installed Muse/SDK | Retain pinned contract and corrected machine identifier; real compatibility evidence is separate from package consistency. |

Changing a registration label does not invalidate repository/task identity. Moving the canonical Git common directory can invalidate the path-derived identity; that is not an automatic state migration. Changing the state root changes the admitted coordination namespace and requires controlled cutover. Installing new code changes the build identity but must not manufacture a new task/lock domain.

## 3. Caller and composition-root knowledge

The CLI supplies a validated launch intent: action, configured paths and selected installed identity. MCP handlers know their operation schema, caller cancellation and transport projection. They request the appropriate runtime operation rather than manually sequencing mkdir, locks, migration, profile checks and retries.

The runtime alone owns preparation concurrency and shutdown. It constructs the existing execution/resource owners after their prerequisites are established. The transport must not need Muse initialization to exist. Store readers know the record contract, not Codex startup policy. The registration adapter knows the installed command contract, not Coordinator internals.

The public interface must hide more ordering than it requires callers to learn. Do not expose an unchecked raw store/lease handle that encourages handlers to bypass authority, or add a generic `capabilities: string[]` framework merely to avoid a few explicit operations.

## 4. Representative change paths

| Change | Semantically necessary owners | Unnecessary propagation to reject |
| --- | --- | --- |
| Correct lock-error classification | Lease adapter, error projector, focused/system tests | Task schema, Muse model catalog, artifact layout. |
| Alter coordination retry/shutdown semantics | Runtime and affected Coordinator lifecycle; process tests | Codex TOML parser or provider registry. |
| Add a diagnostic field | Diagnostic contract, emitting/consuming projections and relevant docs | Bump every task/result/manifest version. |
| Change installed directory layout | Installer and its command/manifest consumers; artifact tests | Task identity, lock namespace or agent prompt policy. |
| Register another project name | Binding/configuration adapter | Change SDK client identifier or worker task keys. |
| Change a supported Muse model | Existing execution-profile/adapter policy and actual compatibility evidence | MCP transport bootstrap or lease algorithm. |
| Change supported persisted record form | Record authority plus real recovery/read/write consumers | Treat the current tool schema as complete historical authority. |

Some changes legitimately cross owners, such as shutdown and a new independently consumed diagnostic field. The test is whether the same hidden policy is being copied into unrelated callers, not whether all changes touch one file.

## 5. Stable interfaces versus hidden knowledge

Stable dependencies carry validated operation requests, typed outcomes, immutable runtime identity and decoded supported records. No caller should infer readiness from a Boolean that actually means transport connectivity, infer ownership from a pathname's existence, or infer compatibility from a version string alone.

Native lock error shapes stay inside the lease adapter. Protocol formatting stays at MCP/CLI boundaries. Codex launch environment interpretation stays in its binding/probe adapter. The build procedure supplies identity to runtime; runtime does not inspect mutable development Git metadata to recreate it.

## 6. Independent evolution, verification, failure and replacement

A profile or agent failure leaves transport and permitted history reads useful. A coordination failure does not destroy the diagnostic surface. An installation failure leaves the previous published runtime untouched. A configuration edit/probe failure does not alter task records or silently relax approval policy.

Test readiness through existing modules and real stdio/process boundaries. Test packaging without live inference. Test live adapter compatibility separately using the actual host/account. A direct probe and a manual Codex observation may reuse fixture facts but do not stand in for each other.

The current worker adapter interface remains. No extra provider abstraction is introduced based on hypothetical future agents. A later agent-registration plan can reference the neutral readiness boundary without forcing this stabilization to implement that framework.

## 7. Deletion test for new permanent mechanisms

| Mechanism | Result of deleting it | Decision |
| --- | --- | --- |
| Repository runtime owner | Required ordering, single-flight preparation and shutdown ownership spread across CLI and tool handlers. | Retain one deep owner. |
| `passeur_status` | No reliable control-plane diagnosis of blocked execution or running identity from Codex. | Retain bounded read-only projection. |
| `passeur_prepare` | Controlled no-inference readiness verification must be hidden inside an unrelated tool or inferred from a real task. | Retain explicit coordination operation, sharing the same implementation as protected calls. |
| Persisted-record decoders | Recovery and disposition again consume unproven representations or duplicate partial validation. | Retain at the existing durable boundary, reusing canonical schemas. |
| Build manifest/identity | Operator cannot distinguish installed and running code without consulting mutable source or guessing. | Retain only build identity/composition fields actually consumed. |
| Explicit installer procedure | Normal registration again depends on a mutable checkout or an undocumented manual runtime copy. | Retain one owned staging/publication procedure. |
| Exact-command probe | Configuration presence remains indistinguishable from a launchable MCP server. | Retain bounded SDK-based probe, not a new protocol framework. |
| Grammar-aware TOML dependency | Passeur must own difficult standardized parsing/encoding it currently approximates. | Adopt an established implementation for the declared edit surface. |
| Global registry, daemon, custom integrity service or generalized retry engine | This objective's complexity disappears rather than reappearing elsewhere. | Do not introduce. |

## 8. Necessary complexity and cumulative result

The unavoidable complexity is safe authority during recovery/concurrency, immutable installation across running processes, external-host compatibility and preservation of user configuration. Contain it respectively in the runtime/store owners, build/install owner and Codex adapter, while retaining existing task and vendor owners.

The complete artifact remains one Node/MCP application with two diagnostic/readiness operations, one runtime readiness owner, stronger existing durable decoding, one installed-artifact procedure and one direct transport probe. No new always-running process, database, scheduler, model-provider registry, telemetry backend or standards engine is retained.

The implemented-artifact review must compare this report with actual caller knowledge, dependency directions, mutation paths and change propagation. Passing tests alone does not prove simplicity. A material replacement requires a new current review rather than inheriting this report's conclusion.

## Source-candidate implementation review

The implemented composition retains the admitted single runtime owner, existing coordinator/store/disposition owners, operation-specific prerequisites, separate install/config/probe boundaries and no daemon/provider registry. Necessary mutation guards are passed to existing Git/resource operations; lease-loss detection does not claim fencing of already-dispatched effects. Profile location was removed from coordination prerequisites.

Permanent additions are the runtime owner and diagnostic/manifest contracts, persisted decoders, artifact build/install procedure and direct registration probe. TOML grammar is delegated to smol-toml rather than a local parser. Distribution-only patch/export code is not part of the application. Removing any of the runtime boundaries would reintroduce startup-order, state-decoding or deployed-artifact knowledge in callers. No agent framework, universal verifier, migration framework, or automatic updater was added.

Full dependency-resolved composed-artifact verification is blocked. This review describes observed source composition and does not approve unseen runtime/vendor behavior or replace the acceptance matrix.
