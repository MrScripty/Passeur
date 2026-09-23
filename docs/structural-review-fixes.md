# Structural coordination: post-acceptance boundary fixes

## Authority and scope

This follow-up targets Passeur `b7d029e051a0c6248f64582ae31ea8db42b9faa4`.
It repairs announcement output size, nested TypeScript/TSX default masking,
and bounded source-selection starvation. The accepted completion plan and its
historical evidence are preserved. These new changes are a separate candidate;
prior acceptance is not verification of this patch.

The implementation remains code-only. Existing Git/source authority, current
parent permissions, worker lifetimes, parser backend, release-first retirement,
resource ceilings and external integration ownership remain in place. No new
dependency, evaluator, model call, project build or merge is introduced.

## Compact announcement responses

The MCP tools `passeur_announce` and `passeur_announcement` now return a public
**schema_version 2** receipt by default. Its `record` contains only `id`,
`revision`, `state`, `payload_digest`, and `task_id` when present. `payload`
contains the byte length and SHA-256 of the exact serialized assignment.
Creation does not echo the objective, context, acceptance text or source areas.
The original assignment size limits are unchanged.

The private service/CLI announcement representation remains schema 1; this is
an explicit MCP presentation revision, not a TaskStore migration. Callers that
consumed the previous MCP `.assignment` field must select a payload page instead.
Existing announcement references still use `record.id` and `record.revision`.

`passeur_announcement` accepts `view: "assignment"` for a UTF-8 JSON payload page.
Start at `offset: 0`. Continue with the returned `next_offset` and
`expected_sha256: <payload_sha256>`. The first page may also use the receipt's
`payload.sha256`. Accumulate `content` and parse JSON only after `eof: true`.

Each page is at most 4096 source bytes, reduced as necessary to end on a UTF-8
boundary. The page metadata plus both JSON-escaping layers fit the existing MCP
output bound. Continuation requires the expected payload digest; a wrong digest,
a split UTF-8 offset or a range beyond the payload returns a typed failure.
A metadata revision change alone does not change the immutable assignment hash.
The payload SHA-256 describes serialization; the existing canonical
`payload_digest` keeps its existing meaning. They are not interchangeable.

Every page performs a fresh authorized service read. A receipt, digest or prior
page is not a reusable read capability. Identical creation retries retain the
original announcement; no worker is started by creation or payload retrieval.

## Parameter defaults and retained report compatibility

The TypeScript/TSX extractor visits native binding-pattern nodes for nested
object and array defaults, including renamed nested properties. It masks their
initializer spans through the existing masking owner. It traverses neither type
annotations nor initializer bodies. The new walk leaves type annotations and their literal-type syntax unchanged.
Default-only changes keep the visible declaration stable and retain concealed
header-change evidence. This is syntax projection, not general secret detection.

TypeScript and TSX now identify this extraction as `native-declarations@2`.
Other language identities remain `native-declarations@1`. The actual helper reply
must match the expected dialect-specific identity; its content cache uses the
same identity. Updating a frontend alone does not update a running service or
helper. Build and select the complete corrected runtime through controlled cutover.

Previously retained compact reports from the known TypeScript/TSX v1 analyzer
return `STRUCTURAL_REPORT_REFRESH_REQUIRED`. Refresh the work and obtain its
**current report identity**; retrying an immutable old artifact ID will not turn
it into a new report. The old artifact and its exact source captures are not
rewritten or deleted by this check. Separately authorized detail and internal
rehydration retain their existing contracts. Report-only access does not gain
permission to fetch raw detail as a fallback.

## Bounded selection without permanent first-page starvation

Inventory retains at most 256 names per page. The first page prioritizes explicit
file selectors, bounded filesystem-event hints and changed names from immutable
input/current Git trees. A working-tree diff is deliberately not used: repository
clean filters are outside observation's execution authority. Uncommitted changes
are discovered through event hints and bounded inventory reconciliation.

Continuation advances through the ordinary lexical sequence instead of repeatedly
selecting its first page. Priorities may be observed once again in ordinary
traversal; existing report materiality handles that duplicate. The monitor analyzes
at most 16 paths per job and keeps one bounded inventory page across its batches.
A changed authority or filesystem invalidation abandons that sampled page; no
continuation is represented as an atomic workspace snapshot.

An explicit file watch remains a selector even when a broader declared subtree
contains it. Event hints are bounded and coalesced. Independent workspace jobs
continue through the existing queue, rather than starting parallel analysis workers.
Existing filesystem entry/depth, watcher, source-byte, artifact and native-helper
limits remain real coverage limits. More than 4096 encountered filesystem entries,
for example, is still reported as incomplete inventory rather than unlimited work.

For deliberate inspection, `passeur_structural_report` also accepts optional
`paths: ["src/z.ts"]`, with one to four distinct exact paths. The authenticated
runtime checks them against that work's current declared areas, then performs
normal Git/boundary/capture checks. It snapshots the small selection before
asynchronous work. The selector is available through MCP/private IPC; ordinary
CLI behavior remains unchanged. Omitted `paths` preserves bounded default selection.
This does not remove the existing single-report text-size bound or add unrestricted
whole-repository reads. Existing scope and detail permissions continue to apply.

## Verification and deployment gate

New focused tests cover compact receipts, exact UTF-8 paging, bounded/fair name
selection and native-node traversal rules. Node-shaped unit fixtures establish
traversal only; they are not grammar or installed-parser evidence.

The patch also supplies required actual SDK/TaskStore, real Git/watchers,
retained-artifact, scoped runtime and native TypeScript/TSX tests. Run:

```sh
npm run check
npm test
```

Then rebuild the installed candidate and rerun affected installed structural and
MCP tests, including report-only versus detail grants, service restart and a
large declared scope. Run the native default cases through the production
TypeScript and TSX routes, not a different extractor. Verify masks with independent
sentinels and unchanged literal-type assertions. Recheck observation costs and
control responsiveness on the newly reachable large-scope path; existing limits
are engineering choices, not new maintainer-approved numeric performance targets.

If an older fixture asserts the former TypeScript/TSX extraction identity, first
establish that it is a current-output expectation rather than historical data.
Preserve historical v1 fixtures for rejection/refresh tests. Do not weaken a
validator or mark a failed import as passing evidence.

## Receiving integration evidence

The archive's read-only verifier passed against the complete `b7d029e` checkout:
all 24 affected paths matched their declared preimages and the patch applied
without whitespace errors. The receiving checkout then passed [the TypeScript
check](structural-review-fixes-evidence/check.log) and [the complete repository
suite](structural-review-fixes-evidence/npm-test.log): 622 core, 191 native and
146 integration tests passed; six integration cases were skipped by their
existing gates. These results belong to this follow-up, not to the previously
accepted completion plan.

Two existing current-output tests were updated for exact-file priority order.
The CLI/MCP fixture now waits for its prior service to release the election
lock before reserving one generation for report and exact-detail retrieval.
Independent read-only review identified two bounded-priority gaps; exact file
selectors now precede event hints, non-source hints do not consume priority
capacity, and the global priority set remains capped at 256. The reviewer
confirmed those repairs and reported no further actionable finding.

## Clean installed qualification

The committed source `c3a8675c4c6cab457020254d267cf31de700c211` built and
installed as `396e2491901a5de712d4f81c30663b125301b92696fe3db0334176178109c1e4`
with `source_dirty:false`. The [manifest](structural-review-fixes-evidence/installed-manifest.json)
and [build log](structural-review-fixes-evidence/build.log) record its exact inputs.
The [source-hidden installed probe](structural-review-fixes-evidence/installed-probe.json)
passed 30 suffix routes, 106 independently authored public oracles, 13 canonical
and 21 variant native oracles; it verified separate network/PID namespaces and
no development source visible to the child. The [installed startup gates](structural-review-fixes-evidence/test-installed.log)
passed six cases.

Three existing test files were also run with only their production import paths
redirected to this installed artifact: [compact receipts/pages, native TypeScript
and TSX defaults, and a 270-file real-Git watcher/inventory](structural-review-fixes-evidence/installed-targeted.log).
Those direct module checks do not claim source-hidden service execution. Separately,
the actual installed stdio MCP endpoint [created and retrieved](structural-review-fixes-evidence/installed-mcp-pages.json)
a 30,733-byte assignment in eight bounded pages, preserved its retry receipt,
and refused an invalid continuation. Its disposable Git fixture and service were
stopped and removed after the run.

This follow-up did not redeploy Passeur, rerun live coding workers, or remeasure
representative CPU, memory and control latency on the newly reachable large
scope. The installed package is qualified for the named checks above; those
unrun claims remain open for any deployment or wider performance assertion.
The clean build checkout was disposable; the artifact and installed package are
retained under `/tmp/passeur-structural-review-artifacts` and
`/tmp/passeur-structural-review-installed` for review. No user worktree, account
or personal registration was changed.
