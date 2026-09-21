# Lifecycle conformance

Use `tests/fixtures/adapter-conformance.ts` for pre-start cancellation. Add independent native peers for initialization, pending operations, completion versus question/blocker, exact human permission, denial, withdrawal, reply continuation, host death during input, explicit cancellation, actual exit with inherited pipes and unconfirmed descendants. A snapshot or heartbeat is an observation, never a crash/finish heuristic.

At the service boundary prove durable publication before acknowledgment, no execution replay after loss, source-view identity, multi-client owner isolation, same-key conflict, input/cancel/completion races, answered-intent interruption, no task-killing helper deadlines, paused election ownership and safe resource retirement. Slow observers and cancelled presentation calls cannot strand native waiters or block another client indefinitely.

Run full pinned checks and the exact installed-host workflow separately from unit/substitute tests. Record fake clock coverage as bridge timing logic, not a real multi-hour native run. A fresh session must apply this skill to an adapter change and record its actual dossier, scope and evidence. Frontmatter/link tests are a separate structural claim.
