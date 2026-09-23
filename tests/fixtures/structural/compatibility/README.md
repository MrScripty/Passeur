# Persisted compatibility fixture

`metadata-v1.json` is an independently written v1 metadata record. Its fixed
repository and epoch are intentional: the integration test copies its exact
bytes into a private test store, opens it with the current reader, and checks
that inspection does not rewrite it. Later versions in that test are produced
by the real persistence owner and reopened, so the test exercises publication
as well as decoding. This fixture is separate from historical evidence retained
by earlier plans.

The `task-v1-*` files are independently written, immutable historical request,
state and result records. Their old deadline and model fields are retained as
history; opening them grants no current native execution authority.
