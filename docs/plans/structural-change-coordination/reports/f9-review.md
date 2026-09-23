# F9 development review

## Selected invariants

Review covered current native-task owner versus metadata owner, exact admitted
input/resource identity, literal scope/objective projection, default private
sharing, generated work-tool input shape, immutable enrollment receipts,
metadata v3 evolution, selected-input retention, native adoption/enrollment
ordering, stale source preflight, shutdown, source loss and observer cancellation.
Git and TaskStore/coordination JSON are not one transaction. Existing hooks,
signing, native lifetime and DispositionManager policies remain unchanged.

## Reproduced production finding

A new `CoordinationControl.reserveRetirement` could complete its awaited
snapshot read after `close()` had selected shutdown, then grant a reservation.
The independent gated read test failed by observing `granted` instead of the
required closed error. Rechecking closing state after the read prevents it.
[Before](f9-close-before.txt) and [after](f9-close-after.txt) retain the exact
regression. It is also in the final 372-test suite. This is a new-code finding,
not a reported defect in the committed baseline.

## Fixture corrections, not changed product rules

The managed fixture initially spread dynamic runtime/operator getters into
fixed values. One test accidentally used the ordinary-parent default rather
than its intended operator. Explicit getters and an owner assertion corrected
that fixture; runtime authorization was not weakened.

Unsupported-version fixtures were moved from 3 to 4 because schema 3 is now an
intentional managed-enrollment format. A missed object-literal case failed in
the retained suite and was corrected. Exact migration, refusal and immutable
history cases independently cover the new supported states.

The committed `fileURLToPath` fixture correction and full-checkout F8 record
were restored and blob-verified from the current revision. Those are preserved
upstream changes, not included as new code fixes. The original disposition and
Git helper bytes are unchanged.

## Locality and retained scope

Parents submit only task ID/key. Runtime derives task/source facts, control owns
immutable metadata, Git observation owns branch/input checks, and disposition
owns effects. One runtime association reservation and one control resource epoch
contain their distinct interleavings without holding a metadata mutex across
external work. No new scheduler, DB, parser backend, semantic summary or model
call. Release-first retirement deliberately avoids a new protection-ref policy.

## Unclosed gates

This was same-author development review. Independent external review is not
claimed. Actual new TaskStore and SDK cases cannot load locally; root runtime
and generated MCP type graph, full pinned checks, installed/native operation,
all-language parsing and performance acceptance remain required. The selected
suite proves only its declared source/runtime/fixture boundaries.
