# F6 verification: authenticated metadata transport

Date: September 22, 2026. Baseline: `c8cfa95cec000fde3bd8e39dbe13834780ebfd0b`.
Plan 2A source increment F6 is implemented; objective acceptance is blocked.

## Actual path and exclusions

The selected path is actual ServiceClient.coordinate → real Unix socket/framing →
production authenticateServicePeer and routeCoordination → actual
RepositoryRuntime.coordinate → real Git/control/coordination files. The listener
is a fixture so invalid/corrupted/dropped responses can be injected independently.
Lease/recovery, task-resource inventory and native worker behavior retain the
explicit fixture boundaries from prior increments. It proves those included
owners and their cross-component behavior, not excluded election, TaskStore
codecs, host approval, installation or live native-provider behavior.

The production elected listener is changed to invoke these exact owners. Its
separate `coordination-elected.test.mjs` uses actual flock, runRepositoryService,
RepositoryRuntime, TaskStore, legacy status calls and real reconnect/reopen. That
test was attempted but cannot load the missing legacy compiled contract/dependency
closure in this sparse mirror. No behavioral assertions executed; it is NOT
counted as a skip or passing proof. See f6-elected-unavailable.txt. Run it with
`npm run test:core` in the complete pinned checkout before accepting that path.

## Executed checks

Source path: `/mnt/data/passeur-f6-work/repo with spaces`.
Runtime: Node 22.16.0; Git 2.47.3; available TypeScript 5.8.3 and Node declarations
25.1.0. These are not the repository's pinned TypeScript 5.9.3/types 24.7.2.

Evidence-only transpilation:

```sh
EVIDENCE_TYPESCRIPT=/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript \
node docs/plans/structural-change-coordination/reports/transpile-selected.cjs "$PWD"
```

Transpilation is not a typecheck or production fallback. The final selected run:

```sh
PASSEUR_TEST_RESOURCE_LOG=/mnt/data/passeur-f6-work/f6-test-resources.jsonl \
node --test --test-concurrency=1 \
  tests/core/coordination-authenticated.test.mjs \
  tests/core/coordination-request-capacity.test.mjs \
  tests/core/coordination-bound.test.mjs tests/core/coordination-control.test.mjs \
  tests/core/coordination-repository.test.mjs tests/core/coordination-resources.test.mjs \
  tests/core/coordination-runtime.test.mjs tests/core/coordination-service-contract.test.mjs \
  tests/core/coordination-service-ipc.test.mjs tests/core/coordination-service.test.mjs \
  tests/core/coordination-store.test.mjs tests/core/operator-token.test.mjs \
  tests/core/structural-primitives.test.mjs
```

Result: **254 passed, zero failures/skips/cancellations/todos**. This includes
20 new authenticated-client tests, five new capacity/route tests and 229 retained
regressions. The seven original unchanged coordinator-foundation tests are not
part of this run. File scheduling matches the repository's core command;
concurrency inside the admission/claim/disconnect tests remains exercised.
All **215** recorded per-case temporary roots are absent after teardown.

The actual new helper closure was checked with strict, noUncheckedIndexedAccess,
exactOptionalPropertyTypes, NodeNext/ES2022 and the available Node declarations:
`peer-auth.ts`, `request-capacity.ts`, `coordination-route.ts`; exit 0.
This does NOT check the complete modified listener/client type graph or pinned
application. No substitute contracts, zod or SDK declarations were generated.
Node syntax checks pass for new .mjs tests and fixtures, including the unavailable
elected test; syntax success is not execution proof.

## Observed scenarios

Token-derived identity and no implicit initialization; operator-only enable;
foreign repository/state/profile rejection; actor/approval payload rejection;
separate linked-worktree principals and sharing; managed-workspace exclusion;
one accepted target claimant; lost acknowledgment recovered with original token
and operation key; observer cancellation while runtime publication survives;
ordinary/control saturation independence; exact destination receipt/content,
parent/repository and page-range validation; closed-client refusal; immutable
request and handshake context. No model/parser/compiler/project-build call is
made by the metadata path. Development compiler/tests are separate activities.

## Evidence limits and remaining gates

The required full elected-listener test, complete changed-module type graph,
legacy ServiceClient.call regression path and full pinned npm suite remain
unverified here. Native Tree-sitter/zod/MCP/proper-lockfile resolution fails with
MODULE_NOT_FOUND; npm registry DNS fails EAI_AGAIN. Parser, all-language extraction,
CLI/MCP/registration, task linkage, retirement, actual installed/native host,
representative performance and independent review remain required.

The committed F5 report/ledger records a successful prior pinned integration;
that evidence was preserved byte-for-byte and is not reused as proof of F6.
No SC01–SC17 objective acceptance claim is closed by this partial run.
Patch/overlay validation and test-subject identities are supplied separately.
No upstream commit, push, installation, user-config change or account use occurred.

## Repository integration check — September 22, 2026

All 29 affected source preconditions matched the complete checkout at
`c8cfa95`. `npm run check` passed. `npm test` passed with 351 core, 40 native
and 97 frontend tests; the core run included the actual elected-listener test
that could not load in the sparse mirror. `git diff --check` passed. These
results qualify the F6 pinned/elected test gate in this checkout, not native
parser extraction, CLI/MCP workflow, installed behavior or complete Plan 2A
acceptance.
