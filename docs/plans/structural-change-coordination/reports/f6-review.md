# F6 development review

Review kind: same-author source/test review, not independent external review.
Baseline: c8cfa95cec000fde3bd8e39dbe13834780ebfd0b.

Examined complete pending-request ownership, both admission lanes, credential
immutability, disconnect/send/response ordering, reply decoding and the actual
listener insertion. Legacy task schemas remain the unchanged authority. Test-only
listeners and runtime seams are explicitly labelled and do not ship as fallback
services. There is no new task deadline, retry replay, native parser substitute,
code mutation, automatic provider call, or inference-context expansion.

## Development corrections

The initial observer-cancellation test waited for a successful wire response after
cancelling that observation. The expected behavior was wrong: the wire may report
observation cancellation while service-owned work still publishes. The case now
waits on actual runtime settlement and verifies the saved receipt and continued
connection usability. The test run was externally stopped after hanging; its
single known `/tmp/passeur-session-fnmG60` fixture root was removed after confirming
no associated Node process remained. This was test-owned discard authority, not
user-worktree cleanup. The final run's 215 roots all passed normal teardown.

A second test released 32 wire requests simultaneously and expected all to pass
an independently limited 16-request runtime. It now checks the exact
COORDINATION_SERVICE_CAPACITY rejection where applicable, successful release
capacity and continued connection usability. No production limit/assertion was
weakened. These were new test-oracle corrections, not baseline product defects.

Two further tests cover bounded control-lane saturation with ordinary reads still
available, and mutation of handshake input/binding during asynchronous validation.
Both pass against the final candidate. All new JavaScript fixtures/tests pass
Node syntax checking. Test URL conversion uses fileURLToPath; full selected tests
run from a source directory containing spaces.

A source-contract review of the unexecuted elected fixture found its runtime
identity omitted the required node_version, node_executable, pid and started_at
fields. The fixture now constructs those from its actual process and validates
through RuntimeIdentitySchema. Its graceful-exit wait has a bounded observation
budget; that budget grants no task termination authority. This correction was
made by inspecting the canonical schema, not claimed as a reproduced runtime
failure or a successful elected test.

## Remaining review boundary

Actual elected listener/runtime/TaskStore integration, full static graph, legacy
client behavior and installed publication must be checked in the pinned complete
checkout. The new elected test exercises those real production owners and is not
counted as passed here; module loading fails before its behavioral assertions.
Independent final review remains required at the complete candidate boundary.
