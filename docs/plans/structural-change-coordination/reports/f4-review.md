# F4 same-author development review

Scope: request/reply authority, content identity, cancellation/drain,
initialization/storage races, per-page disclosure, capacity and process evidence.
This is not independent external review or certification of the full codebase.

## R1 — reply receipt failed to bind command content

The initial new decoder checked action, operation key, owner and subject but
accepted a receipt with a different request hash. A literal receipt fixture
changed only this hash while satisfying unrelated preconditions. The failing
assertion is retained in [red evidence](f4-receipt-regression.txt): 17 passed,
one intended failure. No committed baseline defect is claimed.

Corrected applicable command receipts to compare against the existing canonical
hash of owner plus decoded command. Registration is not forced through this rule:
its stored hash includes verified physical metadata unavailable in the raw
external-registration command. That variant checks the mapped action, created
entity and owner/key; the source owner remains responsible for input identity.
The final 18 codec tests and full selected suite pass. The new decoder reuses
the authoritative receipt codec instead of copying it.

## R2 — newly authored child path was encoded incorrectly

The committed F3 test already contained the maintainer's fileURLToPath fix.
Source preimage checks detected and preserved it along with I-F3-05. Review then
found one new session test using URL.pathname. Running that exact new test from
a source directory containing spaces failed to resolve the percent-encoded child
path. [Red evidence](f4-path-regression.txt): one intended failure.

Changed the new test to fileURLToPath and inspected all added child launches.
The existing fixture file is byte-for-byte unchanged from the committed baseline.
All 175 final tests run from a space-containing source directory; no test name
or assertion was weakened to hide path handling.

## Test-peer corrections

The first test peer redundantly unlinked a socket after Node server.close had
already removed it, causing exit-code failures. The test now asserts absence
instead. Two initial expectations used guessed names (`leader` and a different
claimed-target error name); corrected them to the existing owning contract's
`lead` field and `COORDINATION_TARGET_HELD` diagnostic. Production code did not
change for those fixture issues. Fixture status failures were not counted as
product regressions. Exact leftover test directories were accounted for after
observed child exits; final teardown is successful.

## Remaining consumers and review boundary

The actual runtime, service dispatcher/client, CLI/MCP, initialization UI and
TaskStore-backed resource authority are not modified. The session's capacities
cannot override an outer transport or callback limit; end-to-end control
availability remains a required production-integration claim. Parser/host
qualification, future task/retirement consumers and independent review remain
blocked/pending rather than represented by these fixture tests.
