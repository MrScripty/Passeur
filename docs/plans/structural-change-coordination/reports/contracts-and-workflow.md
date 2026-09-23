# Contracts and workflow

This report refines D1–D12 of [the plan](../plan.md). These are prospective contracts, not generated production schemas. Implement the schemas once in the named contract owners and derive public/IPC projections; do not maintain a parallel handwritten API definition here after acceptance.

## 1. End-to-end ownership

| Stage | Passeur action | Parent action |
|---|---|---|
| Attach | Verify common repository, source view, compatible service and actor | Select the approved registration |
| Announce | Register exact assignment/areas and return a revision-bound overlap view | Supply ordinary assignment; optionally inspect before start |
| Start | Admit once; prepare isolated workspace; start selected native runtime | Decide proceed, delay or revise |
| Work | Observe lifecycle and bounded source captures | Direct its own worker |
| Change report | Compute task-attributed structural differences, store evidence | Retrieve when useful |
| Interaction | Apply deterministic relevance/sharing rules | Interpret evidence and coordinate with another parent |
| Handoff | Retain existing Git/task result identity | Select exact commits |
| Reconciliation | Atomically record one lead and selected input revision for a target | Resolve requirements; perform or delegate permitted work |
| Integration | Observe external outcome and protect own resources | Choose checks; integrate via ordinary Git |
| Disposition | Verify retirement prerequisites and exact protection | Explicitly retain/archive/finalize |

A single parent with many workers uses the same path without cross-parent notes. Multiple parents need not discover/enumerate every peer. The shared index returns relevant authorized work only. Neither observing nor claiming a case changes a worker's instructions.

## 2. Source comparison contract

### Source roles

`input` identifies the immutable commit selected for a task or explicitly registered external-work epoch. `observed` is either another exact commit or an identified file capture. `target` is an optional separately observed integration destination. `previous_observation` is allowed only for an explicitly requested incremental report; it never overwrites admitted-input history.

Represent Git IDs as a full hex OID plus repository/object-format identity. Store exact path bytes where supported; the initial UTF-8 JSON representation rejects unrepresentable Git filenames with a bounded diagnostic rather than lossy replacement. Do not derive authorization from a ref name or supplied UUID.

A capture contains registration/workspace generation, capture ID/sequence, HEAD anchor, captured file identities, byte lengths/digests, mode, range encoding, and coverage. Capture identity is not a Git commit. Files can have different capture times; no collection-wide atomicity is implied. A returned source fragment is sliced from the exact captured bytes, not read again by live path.

### Same input

```text
src/provider.ts :: Provider.cancel
INPUT task A, task B @ <full B0>
  cancel(requestId: string): Promise<void>
OBSERVED task A @ <full A7>
  cancel(requestId: string, reason?: string): Promise<void>
OBSERVED task B @ <full B4>
  cancel(requestId: RequestId): Promise<CancelReceipt>
```

### Different inputs

```text
TASK A: INPUT <A0> → OBSERVED <A7>
  - cancel(id: string): Promise<void>
  + cancel(id: string, reason?: string): Promise<void>
TASK B: INPUT <B0> → OBSERVED <B4>
  - cancel(id: RequestId): Promise<void>
  + cancel(id: RequestId): Promise<CancelReceipt>
```

`RequestId` already present at B0 is not attributed to task B. A common merge ancestor may be requested separately, but is not silently substituted for either task's input. Group common declaration text from distinct input commits only with a label that retains both identities.

For independently added declarations, show `absent_in_input` independently for each task. For a malformed capture, show `extraction_incomplete`, not `deleted`. For an external rebase/HEAD replacement, show `workspace_history_changed` and require an explicit new external epoch. Managed tasks preserve admitted-base ancestry; this feature does not authorize rebasing live tasks.

### Attribution

`observed_in_work` references the task/registration and responsible parent. Optional `introduced_by_commit` references actual Git evidence. Neither becomes universal agent authorship. When imported history or unregistered edits may be included, report `authorship_not_established`. Blame is an on-demand historical tool, not the source of task ownership.

## 3. Extraction and rendering

A declaration observation includes source identity; parser/dialect/extractor identity; declaration kind/name; enclosing syntax; exact ranges; parameter/result syntax; supported modifiers, generics and constraints; direct type/member changes; body/region change markers; matching evidence; and parse/coverage limitations.

Preserve native syntax instead of translating every language into a fictitious universal function type. Arrays of parameter/result components provide compact fields where the extractor proves them. When a component cannot be decomposed correctly, retain the exact declaration fragment plus field-level incompleteness; do not fill plausible values. Mandatory qualification rows must establish the required decompositions.

Return-annotation states are `declared`, `not_declared`, and `unavailable`; `not_declared` is not void/unit/any. Preserve explicit receivers, overload/definition distinctions and enclosing generic syntax. A directly edited type alias or record is its own source change. Following its references to derive effective consumer types is excluded.

Default/initializer expressions are masked in the default view. Show default-present/default-changed markers; parent detail retrieval may return the exact source under current access policy. Type literals such as `[u8; 32]` or `'accepted' | 'stopped'` are written type syntax and may be included. Do not evaluate const expressions, infer literal argument values, or inspect runtime data.

`body_changed` means source-body difference, not behavior change. Prefer grammar-aware token comparison for formatting/comment-only classification where qualified; otherwise report byte changes without semantic labels. Do not remove whitespace inside tokens, Python indentation, annotations, directives or string literal types. Every changed source region is covered by a declaration/body marker, a non-declaration region marker, or explicit incomplete coverage. Comments may be labelled comment-only; they are not silently forgotten if they are the only observed change.

Direct changed spans are separated from enclosing context. Two methods changing in the same class do not automatically mean both workers directly changed the class declaration. Anonymous callback edits may be attributed to a containing region with exact source ranges, not an invented function name.

Default report ordering is stable by Git path, enclosing declaration key, task and endpoint. Output is paginated and byte-bounded. Normal responses include compact structural changes and exact source links/IDs, not full bodies, prose summaries, blame or entire raw patches. Escape control characters and delimiters; source text is data, never tool instructions. A size limit returns a smaller complete page with an omission/cursor field, never invalid truncated JSON.

## 4. Declaration correspondence

The matching scope is the explicit input/observed file pair. Internal declaration keys are source-scoped and can change after a rename; they are not global semantic IDs.

First match unique unchanged declaration syntax within compatible enclosing contexts. Next allow a unique same-name/kind/context candidate when the language-specific overload/declarator rules make correspondence unambiguous. Use exact source anchoring/change ranges as evidence, not as an identity that persists across unrelated versions. In an overload set, remove matched unchanged overloads before considering the remaining candidates. Multiple possible correspondences yield `ambiguous` and visible unmatched changes.

File renames are Git evidence with their heuristic origin or exact-content proof recorded. A rename-plus-edit does not automatically establish that every contained symbol survived. Declarations added in separate inputs can be grouped as same-location/name candidates without being called one old symbol. Treat a declaration versus definition, C function pointer versus function, Rust impl method versus free function, and nested same-name declaration as different syntax categories.

Cross-task grouping uses common source lineage/qualified correspondence or reports `possible_correspondence`. Never intersect raw line numbers from different inputs. No fuzzy confidence score decides an authority transition. Reports expose extraction/matching versions so a new algorithm produces a new report identity.

## 5. Parse and capture failure semantics

Inspect both `ERROR` nodes and missing-token recovery. A valid header with an incomplete body can have `header_complete/body_incomplete` coverage; an invalid header cannot yield an asserted complete parameter list. Local error recovery may leave some declarations reportable; enumerate uncovered changed regions and preserve file-level status. A disappeared capture is not a confirmed Git deletion.

For filesystem captures, open without following the final symlink and without blocking on nonregular objects, verify the opened descriptor's regular-file type, actual contained identity and registered root before content access, then retain that descriptor. Qualify Linux `/proc/self/fd` identity handling or an equivalent anchored mechanism, including rename/deleted descriptors; unknown containment rejects capture. Resolve and validate existing ancestors, but do not claim lexical checks alone prevent concurrent replacement. No device/FIFO reads. Restrict permissions, bytes and retention. Threat model excludes malicious same-UID programs but includes accidental concurrent saves, file replacement and symlink changes.

Git discovery and object reads use structured arguments, explicit OIDs, NUL-safe output, disabled external diff/textconv, and a no-network object policy. For live observations, inventory from safe tree/index listings plus filesystem capture; do not invoke `git status` or a worktree diff blindly when it would execute configured clean filters. Disable incidental index-lock/refresh effects where the qualified Git mechanism permits it. Qualified no-lazy-fetch behavior is explicit, not assumed from an offline environment. Exclude `.git`, Passeur state, parser caches and unrequested ignored/generated areas from watch traversal; an explicit additional watch still requires safe containment and disclosure authority. Status/index refresh effects must be explicitly classified; observation does not mutate refs, stage content or create commits. Git filters/attributes can cause worktree bytes to differ from blobs; annotate raw worktree comparison and do not execute filters to normalize them. Unsupported encoding/object representation returns an explicit limitation.

## 6. Analysis helper and scheduling

A dedicated Node helper owns native parser allocations and synchronous parse/query work. The service starts it lazily through the existing installed runtime owner. It is not launched by a model-supplied executable path. Its environment excludes provider credentials/control tokens. It loads only the pinned artifact manifest; source files cannot request imports or plugins. Inputs are captured buffers plus approved dialect/extractor selection; outputs are fully validated observations.

Use a small, closed protocol for `parse`, `cancel`, `result`, and shutdown/health, with job ID, source digest, parser bundle identity, limits and explicit result class. Reuse existing bounded transport conventions where appropriate; do not create a generic RPC system. Grammar/ABI errors are distinct from malformed source. An exit or crash affects analysis coverage, not native inference. Repeated crashing input is suppressed by its content/bundle key until explicit retry or a changed input; no infinite restart loop.

Start with one bounded analysis slot. Pending work is keyed by workspace/file and latest capture generation. Superseding queued work discards only disposable analysis requests, not authoritative notes/tasks. In-flight pure computation may finish and be classified superseded, or be explicitly interrupted through the qualified helper mechanism. Parser/job cancellation is not coding-task cancellation. A wedged helper can be disposed under its pure-analysis resource policy with an `analysis_incomplete` result; no associated workspace or native agent is terminated.

Cache extraction by content bytes, dialect and parser/query/extractor identities. Enclosing path/source and task attribution are attached after cache lookup. Reuse base extraction across tasks. Bound retained trees and captures; release them on eviction/shutdown. Incremental reparse uses an exact edit between retained buffers when qualified; full parsing of one bounded changed file is the valid alternative, not reparsing the repository.

On attach/refresh/checkpoint/completion, reconcile registered file inventory. Watch events are hints. Unknown events or watch failure produce a gap and bounded rescan. Observe new files under announced scopes as well as tracked modifications; directory enumeration limits produce incomplete coverage, not an empty set. Repeated saves without a changed structural fingerprint do not create repeated parent notices. For notice materiality, exclude timestamps, capture sequence, OID-only advancement and repetition of an unchanged `body_changed` marker. Those still update retrievable evidence. Notify again only for a policy-selected new relationship, changed compact declaration/coverage state, reversion/resolution, or an explicit detailed watch; do not let report identity itself become a reason for every-save delivery.

## 7. Work, disclosure, notices and notes

The work registry reuses managed assignment objective, agent ID, source view, request key and allowed paths; it does not ask workers to restate them. Expected change areas are optional parent-provided metadata; absent areas are unknown, not a whole-repository dependency set. An external writer explicitly supplies its starting commit and workspace registration.

Before cross-parent disclosure, the operator/parent selects the supported sharing policy. Default task privacy remains intact. Shared coordination summaries disclose only authorized work ID, structural subject, exact permitted source fragments, evidence level and a parent relay reference. Full prompts, reports, pending approvals and credentials remain private unless specifically shared. Current access is checked on every detail read and note delivery. A model-supplied owner ID or case ID does not confer access.

No natural-language intent classifier is introduced. Declared areas produce deterministic overlap. Runtime routing uses exact file/declaration watches and direct observed overlap. Lexical call/import occurrences may be queried as unresolved syntax hints but are not resolved-call edges or default urgency signals. No graph traversal predicts downstream behavioral impact.

Maintain report/evidence revision separately from notice-delivery revision. A delivered report is immutable; a mutable latest pointer may advance. The parent reads changes since an opaque cursor carrying source/index epoch and monotonic sequence. A cursor from a reset/evicted range produces `gap` plus current snapshot. Reading does not necessarily acknowledge; an explicit cursor acknowledgment is idempotent. Failed sends do not clear notices. Notifications are at-most-coalesced hints; authoritative current state remains retrievable.

Default delivery is response-associated to the responsible parent, using a new versioned response or the changes tool. Do not require protocol unsolicited requests or host turn wakeups. Optional explicit subscriptions must be separately host-qualified and cannot become required for correctness. No model is invoked to fill missing descriptions. A parent note is presented verbatim/bounded with author and source subject; it never becomes Passeur-authored explanation.

Notes are optional `intent`, `question`, `statement`, `agreement_proposal`, `acknowledgment`, or `resolution_update` records. Agreement status follows exact named acknowledgments; silence does not count. A declaration watch can report changes against a named agreement, but the service does not evaluate the agreement's prose. Revocation/closure affects future access and actions without rewriting already retained statement history.

## 8. Public operation design

Keep ordinary use on existing submit/wait/result/finalize. Add only the following owning surfaces; each action below has its own closed schema, not a generic arbitrary command payload.

| Tool | Supported contract |
|---|---|
| `passeur_work` | Announce/update/withdraw prospective work; register/update/close external work; inspect authorized work. An announcement retains the full assignment once. |
| `passeur_changes` | Read paginated structural reports or request bounded refresh for named authorized work/endpoints; acknowledge a returned cursor. Refresh is observation, not task execution. |
| `passeur_watch` | Set/remove explicit file/declaration/region interests and delivery preferences under the parent's authority. |
| `passeur_notes` | Read/post/acknowledge a bounded note for a named shared work/subject/case. |
| `passeur_reconciliation` | Observe/claim/update/release/transfer a target's coordination case. It never runs Git merge or commands. |

Submit envelope v2 is a discriminated union: `inline` carries the unchanged assignment plus optional coordination settings; `announced` carries announcement ID, expected immutable announcement revision and optional preflight receipt. This avoids copying the objective into a second tool call. Legacy envelope v1 remains supported with its original output/identity contract and an explicit uncoordinated projection.

New coordinated durable request v5 records the immutable announcement/work linkage before native startup. Equivalent retries include that identity. Materially changed task/source/base intent conflicts. New coordination-aware response versions carry a bounded cursor/count; old strict observation/result schemas remain unchanged. Internal-coordinated producers/consumers change together; IPC handshake/capability version changes are explicitly negotiated or rejected.

Define declared operation keys, expected revisions/generations, ownership, actual response-budget admission and typed failures at each new surface. A lost submit acknowledgment uses the already accepted key, never an inference retry. A lost note/claim acknowledgment uses its operation receipt. Record byte limits in owning schemas/configuration once; do not duplicate defaults in MCP and service code.

## 9. Reconciliation ownership and resources

Case identity is repository binding plus full target ref. A unique active case exists per target; it contains a stable case ID, leadership generation, parent, current selected task/commit set, observed target OID, revision, status, and operation receipts. Different branches are different declared targets; the service does not infer that two branch workflows will eventually merge elsewhere.

The claim linearization point is the atomic control-record publication. Update/cancel/release/transfer checks current owner/generation and expected case revision. Parent knowledge of a task or commit does not grant control. Updating selected commits increments the case revision only. A stale parent cannot create a second case by changing one input hash. Reopening after explicit closure receives a new case generation under the same target authority.

An operator adoption is an explicit authorized handoff; time, missing heartbeat, connection refusal and a PID are not ownership evidence. It cannot stop external code. Once the parent has started unmediated Git integration, a new ownership generation cannot undo/fence it; transfer must record that uncertainty and stop cooperating case actions until the operator reconciles the actual target. Case leadership serializes cooperating decisions, not the entire filesystem.

Selected commits are externally protected by their task/ref owners. Before Passeur retires one of its worktrees/refs, it checks active case references under the same resource-reservation ordering and either refuses or verifies an exact retained/archive ref. Case selection racing retirement must yield one documented outcome, never an unprotected selected input. No generic proposal GC or force pruning is added. External workspaces remain external. Parent-owned integration uses ordinary hooks, signing, target revalidation and the existing finalization evidence.

## 10. Persistence and recovery

`coordination/control.json` contains schema version, repository binding, monotonic revision, bounded work registrations/announcements/sharing, target cases, note/ack metadata, and idempotent operation receipts. One coordination owner performs validate → authorize → expected-revision check → mutate copy → atomic fsync/rename publication → acknowledge/notify. Internal record writes are asynchronous; no human/provider/parser/Git hook runs within that critical section. Internal disk serialization is bounded and measured.

Parser caches and the inverted relevance index are derived and reconstructible; control records are not. Immutable report artifacts retain the compact evidence and its exact source identities. Working-buffer/raw-hunk availability is explicitly limited by retention; a report does not promise whole-repository replay. Detail eviction cannot substitute current path contents. An active case can retain the exact compact evidence it references.

Before applying a task-linked operation, publish the announcement intent. The task request records that work ID before native start. If the post-admission projection fails, discover the accepted task through its recorded identity; do not repeat native submission or mark never-started. Cross-store atomicity is not claimed. Recovery reports unknown effects and retains authority. First enable publishes a complete empty control record and a supported initialization marker through a staged directory publication under the elected owner; neither is visible as initialized until both are complete. Reopening an initialized directory with missing/corrupt control refuses fresh-empty initialization. Enable is explicit operator-owned state mutation, not a consequence of read-only discovery. A missing/corrupt control file after initialized coordination is not permission to start with an empty board. Retain receipts long enough for their explicitly supported key lifetime; reject additional allocation rather than silently reuse keys.

Persistent limits use capacity, explicit closure and archival disposition. Silence/age never releases claims or tasks. Derived captures/notices can coalesce or expire under their advertised availability contract with a gap indicator. Service shutdown drains authoritative writes; report-only helper computation may be cancelled as disposable analysis. Durable closed cases/notes need not keep an otherwise empty service alive. Explicit unresolved claims remain durable across service restart without fabricating a running parent.

## F2 implemented boundary (September 22, 2026)

The surrounding workflow describes the full target. F2 implements only the
internal/persisted coordination v1 boundary in
`src/contracts/coordination-control.ts`, `src/coordination/control.ts` and
`src/store/coordination-store.ts`. [docs/coordination.md](../../../coordination.md)
is the durable explanation of this implemented contract; the source decoder is
the representation authority. Full transport/task/retirement consumers are
pending, so no public operation is registered and existing strict schema
versions remain unchanged.

A trusted future caller must establish actor authentication, physical source
membership and Git identity before using the internal metadata operations.
Note context is captured as exact work references independent of changing case
inputs; each read checks current access to that context. Consent handoff changes
case generation. Records of external-effect settlement remain parent reports,
not execution/Git proof. Explicit initialization and record publication use the
existing atomic primitive; multi-store transactions are not implied.

F2 does not yet implement preflight-to-task atomic admission, operator adoption,
active-case resource retirement protection, notification delivery or structural
analysis. The full prospective consumer obligations continue to apply before
those paths can be advertised. Evidence and the scoped stopping decision are in
[F2 verification](f2-verification.md).

## F3 implemented source boundary (September 22, 2026)

F3 implements external work registration and source checks through
`RepositoryCoordination` and `CoordinationRepository`; the internal operation
shape is owned by `decodeRepositoryCommand`. The durable v1 record retains its
meaning. Existing `register_work` is internal verified-metadata admission, not a
client operation. An authenticated service actor/source view and an actual
resource-owner callback are still required at composition.

Physical workspace identity and exact commit/target observations are checked
outside the store lock; current permissions and expected case revision are
checked again by the final transition. Exact source facts do not confer process
control, authorship, managed-task ownership or ref publication authority. No
cross-Git/JSON atomicity, pin or live-editor fencing is claimed. Scope paths are
validated before registration; old metadata labels cannot become source proof.

The parser and public consumers remain unfinished. Details live in
[the durable contract](../../../coordination.md); evidence is
[F3 verification](f3-verification.md). Earlier F2 statements describe that
increment's source-proof boundary, not an alternative public registration API.


## F4 service-session contract refinement

The implemented metadata-session boundary is owned by
`src/contracts/coordination-service.ts` and `src/service/coordination.ts`.
Its externally meaningful behavior and unresolved production consumers are
specified in [service-owned metadata session](../../../coordination.md#service-owned-metadata-session-f4).
This internal/prospective wire version does not alter the registered service
operation catalog or historical coordination state v1. Current task/request/result
versions remain intact. Complete runtime decoding occurs at request and reply
boundaries; validated control entities retain their existing meaning.

Initialization is explicitly authorized outside mutation locks. Reads are
current-authority pages with content-bound continuation, not permission tokens
or a durable source-version database. Operation cancellation detaches an admitted
observer without cancelling its mutation. Pending work is owned through close.
The current selected evidence is [F4 verification](f4-verification.md).


## F5 current runtime consumer

`RepositoryRuntime.coordinate(raw, actor, sourceView, signal)` is the internal
consumer of the unchanged coordination request/reply v1. Its trusted actor/source
are separate arguments supplied by the future elected listener. It copies and
validates them before suspension, acquires bounded lane admission, and tracks
accepted work independently of observer cancellation. Decode/admission refusal
has no metadata effect. Existing task preparation can occur for an admitted
mutation before metadata initialization permission is evaluated.

The runtime owns one lazy CoordinationService. Identity reads do not create the
state root. Other reads require the existing canonical private service namespace;
missing namespace is unavailable. Metadata initialization additionally requires
the existing canonical operator principal. No request creates or replaces a
credential or manufactures human consent. Supported drain-time reads/releases
retain their lane; closing rejects new entry and observes owned session work
before releasing lease authority.

External registration consumes TaskStore-decoded resource claims and real Git
inventory, including canonical containment and moved-branch anchors. Unknown,
missing, contradictory, nonterminal-retired or reused-path resource facts refuse
enrollment. This check is not a reservation against arbitrary external mutation.
Actual task admission/linkage and retirement-case serialization remain unimplemented.

Canonical detailed behavior: [runtime composition](../../../coordination.md#runtime-composition-f5).
Versioning: no stored task/result/control or public IPC/MCP schema changes here.
Bootstrap and worktree inventory retain their old exported APIs through re-exports.
The parser/host/native/full-pinned acceptance claims stay with their owning gates.

## F6 private metadata transport refinement

The new private operation name is `coordination`; its payload and result are the
existing `CoordinationRequest` and request-correlated `CoordinationReply`, both
version 1. CLI/MCP projections remain outside this increment. Source view and
actor come from the authenticated hello, never from the operation. No framing,
task, result or persisted-control schema is reinterpreted.

Authentication is checked once by the connection owner; every metadata operation
still passes the canonical request decoder and current runtime/source/permission
owners. Destination validation checks the original request, parent, repository,
command receipt and page continuation. The client keeps the correlation until an
answer or closure even after its observer detaches. Private unknown operation
handling remains compatible; matching-build policy governs normal frontend reuse.

Capacity uses the actual pending maps: 32 ordinary plus four protected requests
per connection. Metadata classification delegates to coordinationRequestLane;
native cancel/input/attach/stop are protected as well. Saturation is a per-request
error; duplicate active request IDs remain connection faults. No autonomous
message, inference, merge or resource-retirement effect is introduced.
