# Internal parent coordination

## Implementation status

F2 implements the internal coordination-control owner and real-file store.
F3 adds a repository-bound operation facade that verifies physical worktrees,
exact commits/ancestry and direct target refs before source-dependent controls.
No CLI/MCP operation is registered for these methods yet. Actual service and
resource-authority composition, native parsing, managed task/announcement
linkage, operator adoption and retirement guards remain unimplemented.
This is not yet a usable end-to-end multi-parent feature.

Plan authority: [Plan 2A](plans/structural-change-coordination/plan.md).
Evidence: [F3 verification](plans/structural-change-coordination/reports/f3-verification.md)
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

The future composition root must create exactly one control/store owner for
the canonical repository under the existing service election and mutation
authority. These modules neither acquire a second lease nor permit independent
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
physical-identity observation. The actual service/resource implementation is
still pending. Low-level `register_work` accepts verified metadata only and
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
