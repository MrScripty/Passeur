# Controlled worker commit and exact-result verification

Operation: `continue` on the active plan. Test implementation: `c740d98` (`tests/integration/peer-worker-composition.test.ts`), final file SHA-256 `1f918540dabca35f293d787b8ad55f83b4ab01533c34b7fe2c25481e4ada8b23`.

## Source-to-candidate mapping

The disposable repository starts with `source.ts` returning no value and an unrelated tracked `README.md`. Two initially separate managed worktrees edit the same declaration to return 1 and 2. Passive source observation establishes the case. The worker interface supplies source-grounded values; worker 0 proposes 1, worker 1 counters with their sum 3, and both task principals acknowledge. Worker 1 applies the agreed one-file replacement to its own worktree. Both task-bound SDK peers inspect the same durable applied outcome before terminal completion.

After that inspection, worker 1 runs `git diff --check` and a subprocess execution of its workspace `run() === 3`, then performs ordinary `git add` and `git commit`. The fixture installed an executable default pre-commit hook before task submission and checks its marker after the commit. The applying task's Coordinator result reports `delivery.status === "committed"`; the recorded head equals the worker-observed HEAD and task branch tip, the recorded tree equals that commit's tree, the base is an ancestor, and the worktree is clean. Exact task/run, base, ref and worktree identities are asserted in the test. The dynamic fixture commit OID is bound through these equality checks during the run; the fixture is disposed afterward, so this report does not present that ephemeral OID as a retained live candidate.

The independent caller reads `source.ts` and `README.md` from the exact delivered commit, executes the committed source and requires `run() === 3`, and requires the unrelated README bytes to survive. A separately created commit with the same tree is rejected because its OID differs from the delivered identity. The original checkout still has its baseline `source.ts`; the other worker's managed edit is not silently integrated into its branch.

## Closure and retained evidence

The test captures the sole settled applying task operation, releases the settled case using its current lead, revision and generation, closes both managed-work records and finalizes both task resources as `retained` with exact expected heads and refs. A new TaskStore instance rereads the committed result, exact settled apply operation and resource states. Coordination reads confirm the closed case, both closed works and the application note selected by the peers' exact `application_note_id`; its applied status, proposal digest and application digest match their observed outcome. These checks run before fixture-owned cleanup. The test performs no parent-authored candidate commit, target integration, account access or action on historical Muse tasks.

## Qualification and limit

- Normal-permission `npm run build && npx vitest run tests/integration/peer-worker-composition.test.ts`: 4/4, 68.04 seconds on the initial candidate. After the independent retention finding was repaired, the affected scenario passed 1/1 in 16.67 seconds; three unchanged scenarios were skipped in that narrow run.
- `npm run check` and `git diff --check` passed on the final candidate. Independent Astra High closed its one P2 on reopened application evidence and found no remaining P1/P2. Ordinary repository commit hooks were preserved for `c740d98`.
- Two default-sandbox attempts returned `STRUCTURAL_HELPER_REPLY_INVALID` before any case or commit; they do not qualify the new path. Normal permission supplied the structural-helper environment required by the focused test.

This is controlled shared-Git composition with scripted SDK peers. It does not qualify the installed `muse serve` session, protected Git and credential boundaries, real model reasoning, a live committed pair, target integration or multilingual repeats. G2 installed admission remains the single next integration gate; the isolated SDK `session/start` still stops at `UnsafePath`.
