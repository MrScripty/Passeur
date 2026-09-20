# Acceptance procedure and evidence record

**Status:** All implementation and installed acceptance is pending.  
**Claim authority:** [plan.md](../plan.md), section 5.  
**Evidence owner:** Implementer for automated runs; the authorized operator for host/account observations. Record the actual person/agent at execution.

The procedures below specify future evidence. They do not report tests as executed. Add dated observations and artifact references here after actual runs, without copying policy out of the plan.

## Evidence record fields

Record claim IDs, candidate revision/build ID, date, operator, exact command or manual actions, launch context, relevant platform/filesystem/Node/Git/Codex/Muse/SDK versions, actual input scope, result, exit/terminal status and bounded evidence location. Distinguish reported model/check claims from observed process/Git facts. Never retain access tokens, raw credentials, entire environment dumps or unnecessary product contents.

Temporary evidence roots and fixture processes belong to their creating test. Use distinct directories, configuration files, request keys and repositories for cases that may overlap. Cleanup awaits child termination and restores borrowed process state. A test that cannot observe its child stopping fails that claim rather than allowing a successful runner exit to hide it.

## A1–A2: Discoverability and error meaning

Launch the production compiled CLI through the actual MCP SDK Client and stdio transport. Test normal configuration and independently vary: absent/non-directory project, unreadable or malformed profile, unverified subscription, unwritable state directory, legitimate lease contention, malformed/unsupported stored record, unavailable Muse executable, and provider startup failure after a task is explicitly attempted.

Initialize, enumerate all expected tools and call status. Operational blockers must not suppress discovery; status states what is unchecked. Call the relevant operation and assert its exact failure family, native cause where available, operation stage and unchanged prohibited state. `muse_result` remains readable when only inference prerequisites fail. It must not initialize an absent store or turn an I/O failure into “no result.”

Exercise the diagnostic tool allowlist through generated registration too. Verify bounded output and stdout framing while stderr diagnostics are present. Feed independently constructed malformed/unsupported requests to the actual input boundary and prove they never dispatch; validate success and failure output variants at the consumer boundary.

Prove real EACCES/EPERM behavior using an unprivileged process and controlled paths. A chmod fixture run as root does not prove denied access. Injection covers the native-error classifier but is labeled focused evidence, not an OS-permission test. Do not change the user's actual permissions to manufacture a failure.

**Expected evidence:** typed MCP responses, complete tool catalog, recorded lack of unauthorized effects and process closure; not only caught exception text or mock calls.

## A3–A4: Authority and lifecycle

Start two production MCP processes with identical pinned namespace/repository binding. Both initialize and list tools. Prepare A; prepare B and observe genuine contention. B must retain its diagnostic/history surface and create no tasks, worktrees or recovery writes. Close A cleanly; prepare B without restarting B and observe valid acquisition.

Repeat using linked worktrees and a filesystem alias that resolves to the same canonical Git common directory. Separately show independent repositories can coordinate at the same time. Reject known managed bindings attempting different state roots for the same repository; do not claim this prevents arbitrary manually launched noncooperating software.

Use controlled barriers and owned process events for overlapping first calls. Prove one readiness transition, cancel the first waiter while another remains, and verify no task for the canceled caller. Correct a pre-admission profile/permission condition and retry on the same MCP process. Close the process during acquisition, initialization and active execution; observe late completion, owned release and no resurrection of readiness.

Exercise actual lock-library compromise detection in a disposable fixture and the runtime's containment path. Record its limits: manual lock deletion or an already-dispatched OS effect is not made safe by a callback that has not run. No new protected operation is admitted after detected invalidation; uncertain in-flight effects and worker stop remain unresolved. Real process tests cover normal EOF/signals and forced parent loss. Scripted workers can prove modeled cancellation, but actual Muse descendant cleanup belongs to A9.

For stale acquisition, create supported interrupted-task state before restart. Even if the lease is acquired, the next runtime must not replay a worker or admit replacement work before the existing reconciliation contract is met. Reuse current idempotency/parallel/disposition tests to prove no regression in duplicate subscribers, independent task failure and protected ref retirement.

**Expected evidence:** externally observed allowed/blocked mutations, task identities, process/lease lifetime and terminal state. Bounded OS observation is legitimate test machinery; fixed sleeps and successful retries alone are not the oracle.

## A5: Durable records and supported history

Exercise all persisted variants consumed by the bounded authority family: requests, state, results, resource records, disposition receipts and repository-safety records. Derive valid examples from the actual accepted producers and retained v1/v2 contracts, not permissive casts or current-schema guesses about history.

Create supported records through real writers, close the process and reopen through real readers. Include known historical absence/optionality only where the recorded contract authorizes it. Use independently authored negatives for wrong variant, unsupported version, malformed JSON, invalid identifiers/relationships and prohibited state combinations.

Differentiate unreadable records from proven malformed/incomplete records. Verify that EACCES, read-only storage, I/O failure and unsupported version leave authoritative bytes and directory identity intact. Proven corruption may enter only the accepted preserved quarantine/freeze outcome; record exact before/after facts. No public read path quarantines or migrates. Exercise interruption/partial publication and freeze/explicit reconciliation instead of guessing rollback.

The finite fixture set proves the selected contracts and reachable failure branches; do not claim universal fuzz/formal coverage. Add properties only when they decide a real unproved invariant more economically than existing checks.

## A6: Installed artifact

Provision locked dependencies through an explicitly authorized clean build context and construct the candidate using the new owned procedure. Validate the final dependency closure, notices/inventory and identity. Install into a disposable versioned root. Move the source checkout outside the executable's reach, then initialize/list/status and perform non-live fixture behavior through the installed command.

Prove no runtime module resolves through development `dist`, `node_modules`, TypeScript tooling or source symlinks. Deliberately omit a required production dependency in a test candidate and assert rejection, not fallback. Interrupt staging/publication at the supported boundary and show the predecessor remains intact; do not publish a partial candidate under a valid build identity.

Run build A, install build B and observe both identities without rebuilding/restarting A. Re-register explicitly to B and verify a new launch uses B. Test explicit rollback to retained A without touching task-state identity. A bitwise reproducible-build or tamper-proof claim is not part of this objective.

## A7: Named configuration contract

Use isolated Codex homes and an established independent TOML parser/actual Codex consumer. Exercise two named project entries, intentional legacy-name use, existing-name conflict, unsupported owned settings, and unrelated settings/comments within the declared preservation contract.

Use path/name values containing the destination grammar's meaningful spaces, quotes, Unicode, separators and metacharacters. Invalid semantic values or unsupported representations must fail before publishing executable configuration. Confirm command arguments remain separate; no shell evaluation or whole-environment credential serialization is allowed.

Exercise overlapping cooperating writers under the selected coordination mechanism, edit conflicts detected before publication, and a verification failure followed by a later conflicting edit. The rollback procedure must preserve the latter and report a conflict. This does not prove arbitrary external-editor atomicity; quiescent external editing is a documented mutation precondition.

A missing target-project path must not prevent the installed server from spawning: its cwd remains the runtime directory. The direct probe must then identify the blocked target correctly.

## A8: Exact installed registration

After operator authorization, obtain the named registration actually used by the installed Codex configuration. Record the exact executable, arguments, working directory and selected non-sensitive environment values. Launch that command, not a convenient source helper.

Perform MCP initialization, complete tool enumeration, status decoding and expected build/binding comparison. Bound startup, calls and cleanup, and capture process exit. Do not call prepare or inference merely to prove transport. A separate explicitly selected readiness check may acquire/reconcile the target under its declared authority.

A direct launch made outside Codex does not reproduce a restricted host environment automatically. Record this boundary and proceed to A9/A10. Configuration presence, a successful `--version`, or SDK-only linked/in-memory transports cannot close A8.

## A9: Real Codex-to-Passeur-to-Muse path

Obtain explicit live-account and disposable-fixture authority, including an inference budget and allowed commands/files. Install/register the candidate against a disposable Git repository using the actual operator configuration path. Restart/reopen the installed Codex as required by its observed lifecycle and record tool availability through that interface.

Delegate a bounded task through the actual MCP tool to actual Muse. The task uses schema version 2, an exact base and local target ref, performs its scoped check and creates an ordinary commit through the repository's hooks. Observe the returned terminal execution/delivery identities and verify the actual Git commit/ref/worktree. Request retained evidence through `muse_result` once useful; do not replace same-call completion with a polling workflow.

Run two independent small assignments in one controlled acceptance session to preserve the real parallel path. Exercise an actual human approval allow and deny where the installed operation requests them; choose a fixture that reaches the approval contract rather than fabricating a callback. Exercise owning-request cancellation and parent/session shutdown with observable descendant stopping. Unknown stop is not a pass.

Integrate or retain/archive fixture outputs using the existing explicit disposition authority. Record exact protected commits and task-created resource outcomes. Do not let Passeur run a new acceptance/merge policy engine to pass its own test. Passeur's probe may validate fixture facts, but host interactions/approval decisions must come from the real installed path.

Reuse the older parallel-worker plan's cases/report when the same candidate, context and observations satisfy them. A simple successful task does not retroactively prove all its parallel, signing, sandbox or abrupt-loss claims. Account login confirmation is not provider billing proof; retain that limitation.

## A10: Actual project integration without product delegation

With the operator, verify the real bindings named `passeur_pumas` and `passeur_tuldok`. Do not infer current filesystem paths solely from previous conversation text; use the actual registrations and confirm the intended binding before changing it.

From actual Codex, observe both tool namespaces and status. Confirm expected installed build, absolute project/profile/state binding, canonical repository identity and actual capability state. After explicit authorization for readiness/state access, prepare each project. A genuine existing coordinator may legitimately block preparation; prove safe handover after that owner is intentionally closed, or retain a blocked acceptance claim if handover is not authorized.

Do not kill unknown owners, delete lockfiles, change sandbox permissions or clear safety records to obtain a green result. Do not infer host visibility from a terminal-launched direct probe. A repairable pre-admission fault in a controlled fixture must recover in the same attached process; target projects need not be deliberately damaged to repeat that test.

No real product inference or implementation is needed here. A9 proves live execution in disposable scope; A10 proves actual attachment, binding and authorized readiness at the user's targets.

## Installed evidence and final disposition

No observations are recorded yet. Before acceptance, append the actual claim results, environment and redacted artifacts here and summarize them in the ledger. Keep claim statuses in plan.md current; missing required-real capability becomes `blocked`, not `satisfied`.

Final review confirms the actual implementation's ownership and composed-design shape, all required claims, deferred issue owners/triggers, exact staged/cumulative change scope, and disposition of all plan-created resources. The evidence report is not authority to delete unrelated branches, worktrees, configuration or installations.
