# Parent coordination

## Implementation status

F2-F5 provide the controls, Git binding, metadata session and runtime composition.
F6 adds the private `coordination` request on the existing elected listener and
`ServiceClient.coordinate` / `PasseurFrontend.coordinate`. It uses the same
connection-derived principal and runtime-owned operation. No second listener,
execution scheduler, schema implementation or authority store is introduced.

F7 adds `coordinate --request FILE` to the CLI and four MCP metadata tools.
They use the existing authenticated frontend, runtime and durable contracts.
The committed F6 elected/pinned checks retain their scope. F7's selected local
handler tests are not SDK/installed conformance; required public-consumer tests
and complete pinned checks remain the deployment gate.

Managed task linkage, forced metadata adoption, coordination-aware retirement,
parsers and live structural reporting remain unfinished and unadvertised.
This is a metadata capability, not the complete structural-coordination feature.

Plan authority: [Plan 2A](plans/structural-change-coordination/plan.md).
Evidence: [F5 verification](plans/structural-change-coordination/reports/f5-verification.md),
[F4 verification](plans/structural-change-coordination/reports/f4-verification.md),
[F3 verification](plans/structural-change-coordination/reports/f3-verification.md)
and retained [F2 verification](plans/structural-change-coordination/reports/f2-verification.md).
The evaluator-assisted plan is an unselected reference.

## Responsibilities

`CoordinationControl` serializes accepted commands, applies authorization and
transition rules, and returns durable operation receipts. It consumes the
canonical types and complete decoders in `contracts/coordination-control.ts`.
`CoordinationStore` owns initialization, bounded reads, conditional publication,
interruption handling and reopening. `store/atomic-json.ts` contains the shared
fsync/rename primitive; TaskStore re-exports the existing API without changing
that primitive's behavior.

The runtime now creates exactly one metadata session/control/store owner for
its canonical binding. The elected listener still needs to route authenticated
requests to it under the existing service election and mutation authority.
These modules neither acquire a second lease nor permit independent
concurrent processes to mutate the control file. A read/revision check by itself
is not cross-process fencing. Analysis and native execution remain separate.

## Preconditions before public integration

The caller supplies an authenticated parent actor from the existing trusted
service connection. A syntactically valid parent ID is not authentication.
Command payloads contain no actor field that can override that identity.

`RepositoryCoordination` is the service-facing source gate. The trusted
connection supplies its authenticated actor and source view separately from the
command. External-registration payloads cannot supply workspace/object-format
or actor identity. `CoordinationRepository` derives the workspace identity from
the canonical root/common/admin directories and their device/inode observations.
It accepts complete main or linked worktree roots, resolves aliases, and refuses
subdirectories, foreign clones, unavailable sources and unsupported metadata.
Repository-only inspection uses the common directory so removal of the opening
linked worktree does not break other workspaces.

Exact input and selected revisions must be local commit objects in the repository
object format. An input must be an ancestor of its selected result, and that
result must be retained by the observed workspace HEAD. Target refs must be
exact, direct local branches; symbolic aliases are rejected to avoid two names
claiming independent leadership over the same target. Explicit target OIDs are
rechecked. These are observations, not locks on changing Git state.

The facade requires an `ExternalWorkspaceAuthority` supplied by the resource
owner: repository membership alone does not permit enrollment of a managed
worker's directory. Its callback runs outside control locks, followed by another
physical-identity observation. F5 supplies the runtime task-resource inventory
policy. Its real TaskStore/elected-host qualification and public entrypoint remain
pending. Low-level `register_work` accepts verified metadata only and
must not be exposed directly to client payloads. Existing unverified metadata
labels remain readable/closable but cannot be used as source proof.

Permission-checked source snapshots are obtained under the control owner, then
Git is inspected without retaining that lock, then the command rechecks the
current authorization/revision/generation. An identical saved receipt is a
historical acknowledgment, not new authority or a repeated Git action.
Explicit receipt lookup, closure, access revocation and effect settlement remain
available after a checkout disappears and under source-operation saturation.
A missing or changed checkout does not silently close a registration.

`selectedCases` remains informational, not a Git pin or permission to retire a
worktree. The future resource owner must serialize case selection/retirement and
verify exact retained protection before any resource effect. Git, TaskStore and
coordination JSON are not one atomic transaction.

The caller chooses the trusted, existing private state root. The current threat
model excludes malicious same-user mutation of its ancestor directories during
validation/use. Stored records reject unsafe types, symlinks, hardlinks,
non-private permissions, foreign repository identity and replaced directory or
epoch. These checks are not a same-user adversarial sandbox.

## Work and sharing

`register_work` records immutable input/format, intent, expected areas, workspace
identity and owner. `share_work` changes the exact reader set at an expected
revision. `close_work` closes metadata only. It does not stop a native task,
delete a source directory, assert inactivity, or revoke all existing readers.
A separate sharing update can revoke those readers, including after closure.

A reader may inspect shared metadata and add its own attributed notes. Reading
does not grant control of the work. `overlaps` reports only exact-file/subtree
relationships between currently disclosed active records. It is not a semantic
assessment and does not implement atomic announcement-to-task admission.

## Notes and agreements

A note has immutable text, author, subject, exact agreement parties and source
work references. Ordinary notes have no agreement parties. An agreement proposal
starts without any acknowledgment, including from its author. Each named party
acknowledges the exact note using its own authorized actor; the note becomes
`acknowledged` only when all parties have done so. This is agreement metadata,
not a permission grant or proof of behavioral compatibility.

Withdrawal preserves the original text and prior acknowledgments. It prevents
new acknowledgments and projects `withdrawn`. Authors may withdraw their own
existing statement after source access is revoked because withdrawal reveals
no new source content.

Case notes retain the work references present when posted. Every later read or
acknowledgment checks both the current subject and those original work records.
Removing an input from a case cannot bypass sharing revoked on its older notes.
Notes are source-provided information, not executable instructions.

## Reconciliation leadership

At most one case is active for a full target ref within this repository store.
The lead, members, expected revision and leadership generation are explicit.
Changing selected input commits updates the same case; it cannot create a
second slot for the same target. A claim conflict returns no private case data.

The current lead may transfer to a different existing member with current input
access. Transfer advances the generation. An earlier receipt is historical
acknowledgment, not a reusable leadership credential. After closure a new case
has a new ID and a higher generation; membership in it gives no access to old
case notes. Silence, elapsed time, connection loss and process restart do not
release or transfer a claim.

An explicit `begin_external_integration` records that an unmediated Git effect
may be in progress. While that marker is set, transfer, input replacement and
release are refused. `record_external_settlement` is the current lead's report
that its external operation settled; it is not native stop evidence or proof
that Git integration succeeded. Passeur performs no Git effect here. Operator
forced adoption and recovery after a lost lead are not implemented by these increments.

## Persistence and recovery

Explicit initialization creates a complete staged directory containing
`initialized.json` and `control.json`, syncs it, then publishes the directory
under the current authority. Read-only `open` never enables a missing store.
An empty existing directory, missing initialized file, unsupported version,
corruption, or foreign binding is preserved and reported rather than reset.

Every accepted command and its receipt occupy one control replacement. The
record revision advances once; operation keys are scoped by authenticated
parent. Identical retries return the saved receipt. Different intent under the
same key conflicts. Cross-record state and immutable history are checked on
construction/publication/reopen. Returned objects do not alias authoritative
state.

A failed publication is reported as unacknowledged/uncertain and blocks further
mutation through that store instance. Its owner closes it, inspects or reopens
under current service authority, and looks up the original operation key. A
missing acknowledgment does not authorize repeating a Git, model, or other
external effect. An incomplete initialization stage is retained for explicit
inspection; its existence is not an enabled empty store.

The store's primitive is temp-file sync, rename, directory sync. Tests cover
specific filesystem/process interruption points, not sudden device power loss
or all storage hardware. Git, TaskStore and this control aggregate are not one
transaction.

## Capacity and shutdown

Limits bound retained works, cases, notes, receipts, note bytes and the total
serialized record. The version-1 record has a 2 MiB representation bound and
4096 maximum entities per configured collection. Admission reserves receipt
slots and conservatively sized bytes for active-work closure, complete reader
revocation, agreement withdrawal, and pending-effect settlement/case release.
No age-based pruning is implemented. Exhaustion preserves records and refuses
new allocation; migration/retention policy remains an explicit future owner.

`close` stops new control admission and drains accepted operations before
closing the store. No timer terminates native tasks or releases claims. The
control owner does not import a parser, native provider, evaluator, project
compiler, Git integration command or model scheduler.

## Verification boundary

F2 tests use real private files and process reopening with fixture source
metadata. F3 additionally creates and inspects actual Git repositories, SHA-1
and SHA-256 commits, linked worktrees and targets, and uses the actual control
store. Parent identities and resource-admission policy remain controlled
fixture inputs. Evidence does not establish real host authentication, service
election, managed workspace ownership, retirement safety, public CLI/MCP
workflow, performance qualification or installed native-agent behavior.

Native parsers, providers, evaluators, compilers and project tests are not called
by these coordination operations. Test/toolchain commands are development
verification, not application behavior. The selected suite and exact remaining
gates are recorded in F3 verification.


## Service-owned metadata session (F4)

`service/coordination.ts::CoordinationService` owns one metadata session under
the elected repository runtime. It composes the existing `CoordinationStore`,
`CoordinationControl` and lazy `RepositoryCoordination`; it does not own a
listener, election, worker, parser, model or project build. The production
`RepositoryRuntime` has not yet been wired to instantiate it. The actual
initialization and managed-workspace policies remain the runtime/resource
owners' obligations. Tests supply explicit policies rather than silent defaults.

The constructor takes the resolved canonical repository/store binding,
`assertOwned`, an asynchronous initialization-authorization callback, the
external-workspace authority, and explicit ordinary/control/source capacities.
A trusted connection supplies the parent ID and source view outside the command.
The request contains neither actor nor credentials nor a model-issued approval.
`identity` and `status` do not implicitly enable persistent coordination.
Only `initialize` runs the required authorization callback, outside store locks,
then rechecks authority and publishes/reopens the accepted limits. Conflicting
limits require a separate explicit supported migration. `ready` means metadata
state is readable; it does not certify source, native provider or parser readiness.

`contracts/coordination-service.ts` owns request/reply version 1. Its closed
variants are identity, status, initialize, command and read. Commands reuse the
existing repository-command decoder; no raw physical workspace metadata is
accepted. Replies validate their operation, parent, repository, subject, key,
encoding and range relations. Command receipts reuse the existing receipt
codec. Their content hashes are checked where the caller's command is the
hash input. External registration is the explicit exception: its internal
hash additionally contains verified workspace/object-format facts; the public
reply checks the mapped action, owner/key and created work identity instead.
Receipts prove acknowledgment, not current authorization or source liveness.

Reads select one authorized work, note, case, overlap result or own receipt.
Each page rereads current control authority. Page identity binds repository,
store epoch, parent, selector and the exact serialized view. Continuations
require that identity. Changed selected views return `COORDINATION_VIEW_CHANGED`;
revoked sharing returns the same not-found outcome as unavailable subjects before
revealing a changed hash. Unrelated updates do not invalidate unchanged views.
UTF-8 pages use byte offsets and never split a returned code point. These are
revision-bound current views, not immutable historical snapshots. A missing own
receipt is the selected JSON null variant. They do not expose raw control files.

The 8192-byte page maximum and 24576-byte serialized-message maximum are separate
bounds: JSON escaping and metadata consume response space too. A reply exceeding
its full message bound returns an explicit size error; the caller can request a
smaller page. Read views are bounded by the existing 2 MiB control record plus
projection allowance. No per-client historical snapshot cache is introduced.

Admission separates ordinary operations from explicitly bounded release/recovery
capacity. Own-receipt reads, closing work/cases, complete sharing revocation,
note withdrawal and reporting external settlement use the latter. Authorization
and transition checks still apply. Source inspection is separately bounded.
This class does not override the existing outer transport/client callback limits;
actual runtime integration must reserve adequate end-to-end control capacity.

Arguments/actor are copied and decoded before suspension. Cancellation before
admission prevents work. Afterwards the caller stops observing while the service
tracks publication/completion. The service removes pending entries only after
the operation settles. `beginDrain` prevents new ordinary mutation but retains
reads and release/recovery; `close` closes all admission, waits owned operations,
then closes its bound/control/store owner. It does not kill tasks or release
case ownership because of elapsed time. Lost source directories do not disable
metadata closure or receipt reads, including on fresh-process reopening.

### Pending production consumers

The existing runtime/server/client, CLI/MCP registration and protocol negotiation
are unchanged. A test peer runs the actual existing `IpcConnection` and new
session over a real Unix socket but deliberately supplies fixture identity,
initialization permission and resource policies. It does not prove production
authentication/election, real host consent, provider behavior, managed task
linkage, retirement protection, installed packaging or performance. No dormant
public flag or command claims this capability is available. Those consumers
must be completed and qualified together before the feature is advertised.


## Runtime composition (F5)

`RepositoryRuntime.coordinate` is an internal entrypoint, not an independently
advertised tool. The caller must supply the trusted connection's actor and
source view separately from the completely decoded request. Ordinary payloads
cannot select their own actor or initialization permission. Task adoption does
not confer initialization, workspace, leadership or target privileges.

Identity reads resolve the binding without preparing task execution. Other
reads require the already-existing canonical private service namespace; loss
of that namespace is unavailable, not a new empty control store. Mutations use
the existing preparation/lease path and may perform its supported task-state
preparation before metadata initialization is authorized. They never load an
execution profile, agent registry or native provider merely to manage metadata.

Initialization compares the supplied principal with the SHA-256 identity of the
existing private operator credential. `service/operator-token.ts` owns its
bounded handle-based read and existing explicit-create procedure; bootstrap
re-exports the established function. The runtime never creates a credential as
a side effect of an initialization request. An absent, malformed or changed
credential does not grant permission. This is the current local same-user
operator contract, not a security boundary against malicious same-user code.

The request and principal are copied before suspension. Admitted work is tracked
by the runtime independently of its observer's abort signal. Runtime admission
has distinct ordinary/control lanes before preparation so outstanding ordinary
requests cannot consume all release/receipt capacity. Drain rejects new metadata
work while keeping supported reads/releases available. Shutdown closes the
session and observes owned operations before releasing its lease. There is no
new task deadline. Metadata readiness does not assert lease, parser, provider,
source or application readiness; each protected mutation still checks authority.

### External enrollment and managed resources

`core/coordination-resources.ts` consumes the TaskStore-owned decoded inventory.
Matching managed paths, canonical aliases, containing/nested workspaces and
branch-located moved work are refused. Missing resource records, legacy/unknown
claims, missing branch/path anchors and contradictory task/resource state leave
enrollment unavailable. A retired label is usable only with terminal task state.
`not_applicable` cannot also claim a workspace or branch.

A moved managed worktree whose former path has been reused is not treated as
unowned. Admission of unrelated new external work requires the nonretired
resource's recorded path and one retained-branch inventory entry to agree.
Ambiguity refuses source-dependent enrollment; it does not terminate workers,
release coordination claims or prevent source-independent metadata closure.

Read-only worktree inventory now has the narrow `workspace/inventory.ts` owner;
`workspace/worktree.ts` re-exports the same function and type. The inventory
implementation is unchanged. Git/source facts remain observations, not locks
against external ref edits. F5 does not provide task enrollment or serialize
case selection against resource retirement; those consumers remain required.

### Resource and evidence limits

Initial runtime safety caps are 16 ordinary requests, four control requests,
four source operations, 256 worktree rows and 4096 resource records per
inspection. They are not measured performance guarantees. TaskStore.list still
owns its complete inventory read before the resource-row cap is checked;
large-store latency/memory and public transport capacity require qualification.
No claim is made that these local caps bound an entire unconnected host path.

See F5 verification for actual runtime/metadata/Git execution with fixture task
inventory, election/recovery and principals. Public authentication, actual
TaskStore codecs, parser extraction, installed behavior and complete pinned
application checking were not replaced by those tests. Plan 2B is unselected.

## Authenticated metadata wire (F6)

The existing hello handshake establishes the repository/state/profile binding,
canonical source view and parent identity derived from the private owner token.
`service/peer-auth.ts` owns those checks; the listener retains duplicate,
in-flight, closed-connection and generation decisions. A syntactically valid
actor supplied in metadata arguments is rejected. The new route cannot grant
operator initialization permission or access to another parent's private work.

`ServiceClient.coordinate` captures and decodes its argument before suspension.
Its pending request stores the destination decoder for that exact request,
parent and repository. The server routes the closed variant to
`RepositoryRuntime.coordinate` and checks the correlated reply. Code-generation
or a second hand-copied metadata schema is unnecessary. Existing task operations
continue to use their existing `contracts/service.ts` schemas and meanings.
Loading those legacy schemas and bootstrap helpers is lazy; an import failure
remains a failure, never a permissive decoder or alternate execution path.

The pending maps are the sole request-capacity owners. Each connection has 32
ordinary slots and four protected control slots. Valid metadata receipt/release
operations use the already-owned classification; native cancel/input/attach/stop
operations use protected slots as well. Lane selection grants no permission.
These ceilings do not claim protection from arbitrary malformed-frame flooding,
machine-wide scheduling, or a measured throughput guarantee. Excess valid
requests receive a correlated failure without consuming a slot or closing the
otherwise usable connection. Duplicate outstanding IDs still close the invalid
connection so an error cannot be confused with its original pending response.

An observer's cancellation sends `cancel_wait`; the client retains correlation
and capacity until a reply or connection closure accounts for it. Already
admitted runtime work remains owned independently. Lost acknowledgments use
existing operation keys and receipts; reconnect does not resend automatically.
No code modification, merge, model inference, tests, builds or worker message
is an effect of the metadata route. Parent token knowledge remains a same-user
application boundary, not defense against arbitrary same-UID programs.

The protocol version remains 1: an old listener returns its existing unsupported
operation outcome. The normal frontend still requires matching build identities;
there is no automatic replacement of a running incompatible service.

See [F6 verification](plans/structural-change-coordination/reports/f6-verification.md).
The required complete-repository test uses the actual guarded listener/runtime,
real TaskStore and legacy status call. Its successful loading and execution are
required before claiming that complete path or shipping public projections.


## Public metadata consumers (F7)

The public consumers preserve coordination-service v1. The complete existing
decoder owns identity syntax, UTF-8 bounds, variants and cross-field semantics;
MCP input schemas project that contract and invoke it before dispatch. Runtime
permission remains independent. Sources, task identities and operator tokens
cannot be supplied as authority fields in a metadata payload.

### Operator CLI

`passeur coordinate --project PATH --request FILE [--profile FILE] [--state-root PATH] [--yes]`
reads one bounded UTF-8 JSON request. Commands and initialization require
`--yes`. Validation and confirmation checks occur before frontend connection or
credential creation. The file is opened once with Linux no-follow/nonblocking
flags, verified through that handle, bounded to 65,536 encoded bytes, and decoded
through the stricter 24,576-byte message contract. File metadata checks detect
observed races; they do not claim a transactional snapshot of a live editor.
Symlinks at the selected file, nonregular objects and malformed input are refused.

For identity/status/reads the existing operator credential is required unless
`--yes` explicitly permits its creation. The CLI never silently substitutes a
fresh ephemeral principal for a missing persistent operator identity. This is
application policy for the existing same-user local service, not a security
boundary against arbitrary same-UID programs.

An example operator initialization file is:

```json
{"schema_version":1,"kind":"initialize","limits":{"works":32,"cases":16,"notes":32,"receipts":256,"note_bytes":16384}}
```

The limits are explicit choices, not inferred defaults. Reusing initialization
with conflicting limits does not reconfigure or erase existing authority.
After explicit enable, an identity request is:

```json
{"schema_version":1,"kind":"identity"}
```

The CLI emits the validated reply as JSON. It does not automatically retrieve
all pages, issue repeat commands, start workers or run tests. Shutdown detaches
its frontend; an admitted operation remains runtime-owned. Preserve the request
and operation key when the reply is uncertain.

### MCP tools

| Tool | Selected metadata operations |
|---|---|
| `passeur_coordination` | Identity, metadata status and one authorized read page. |
| `passeur_work` | External source-view registration, explicit sharing, closure. |
| `passeur_notes` | Post note, acknowledge exact parties, author withdrawal. |
| `passeur_reconciliation` | Claim target, select inputs, begin/settle reported external effect, consented transfer or release. |

The tool root contains exactly one `request` field; its value is the existing
service request. The separate groups expose operation-specific input shapes and
refuse commands from another group. Initialization is absent from all MCP
schemas and rejected by their callable handler. A model cannot add `approved`,
`actor`, `workspace_id`, or a forged control capability.

Registration of tools is inert: no service start, configuration read, parser or
provider loading occurs merely during tool enumeration. A subsequent read may
attach/start the service, as its description states. Existing host tool-approval
and deny policy remains effective; metadata acknowledgments are not native
human approval. Passeur emits no new model calls or routine agent messages.

`read.content` is a JSON fragment. Concatenate unchanged-hash pages using returned
byte offsets; do not parse each fragment as a separate document. Revoked access
is checked on every page. A changed view refuses continuation; refresh from zero.
The outer tool payload is independently bounded; request a smaller page on
`RESPONSE_TOO_LARGE`. Command acknowledgment never means code acceptance.

### Registration and capability boundary

The named-registration catalog includes the four tools from their registration
owner. Applying this code does not edit any personal configuration. An explicit
normal re-registration updates an existing named server while retaining its
approval/denial settings. Incompatible service builds still require controlled
cutover. Existing task tools and persisted metadata retain their meanings.

Only a parent's own external workspace is enrollable here. Managed worker task
linkage, pre-start announcement reference submission, live watches/reports and
forced recovery are not exposed. Source-derived context does not become a
semantic judgment. Reconciliation leadership does not grant task ownership or
permission to update the target. Keep the original resource-protection contract.

### Verification boundary

The focused F7 tests cover the real file reader, canonical decoder, public
operation handlers and authenticated client/runtime/Git/store path with explicitly
fixture listener/task/lease seams. SDK/schema/catalog and real compiled CLI tests
use real dependencies and are supplied as separate required gates; they are not
replaced by fixture SDK objects. See [F7 verification](plans/structural-change-coordination/reports/f7-verification.md).
