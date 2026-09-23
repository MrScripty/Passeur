# Verification, release and final acceptance

This report turns SC01–SC17 into runnable claims. It does not record successful execution. The receiving lead records actual results, exact candidate/builds, required environment, inputs, expected/observed effects, commands, limitations and resource disposition. Reuse one path test for overlapping claims when it genuinely traverses those boundaries; add focused tests for distinct races, contracts and failure outcomes.

## 1. First complete-checkout run

Confirm the current material source rather than assuming a patch archive equals HEAD. F9 is already committed at the examined baseline; do not apply its ZIP again. Preserve the committed real-TaskStore test correction: a successful stopped native result requires the owning codec's settled coverage, not an invalid test record rejected before the target assertion.

Record `git status --short`, actual HEAD and diff from the examined baseline, Node/npm versions, the resolved package closure and relevant build tools. With provisioning already satisfied, run:

```sh
npm run check
npm test
git diff --check
```

The complete `npm test` path includes application build, core, native and configured frontend/SDK/CLI suites. Verify new test filenames and compilation roots against the actual `package.json`, `tsconfig*.json` and `vitest.config.ts`. Do not use the earlier sparse-mirror transpiler or its exclusion list as acceptance. A required test that fails to load is an unexecuted claim, not a pass or skip. Keep test counts as run observations, not fixed quotas.

If dependencies need provisioning, first record exact identities and explicit operator authority, then use the repository's selected lock-preserving procedure (`npm ci` for an unchanged complete npm lock, after reviewing its install/build-script authority). Normal build/run/test commands must not quietly repair or change dependency selections. Keep registry credentials out of logs and fixtures.

## 2. Required path and scenario matrix

| Procedure | Claims | Start → result and decisive evidence |
|---|---|---|
| **V01 source identity** | SC01, SC02, SC06 | Real SHA-1 and SHA-256 repositories and linked worktrees → public structural report. Common and different bases, add/add, deletion, imported commits, three variants, dirty parent, changed HEAD and retired original checkout. Independently inspect exact blob bytes/OIDs; each change is attributed to its own input pair. |
| **V02 language extraction** | SC03–SC05 | Actual captured source → native helper → expected declarations/masks/coverage for all L01–L13. Use reviewed expected values and exact source ranges. Hand-authored Extraction objects remain unit fixtures only. Include invalid code, same-signature body edits, default changes, direct referenced-type edits and ambiguous correspondence. |
| **V03 source trust** | SC02, SC06, SC10 | Authorized work read → report/detail; hostile or racing path inputs → exact refusal. Symlinks, ancestor replacement, FIFO/device, binary/invalid UTF-8, submodule, too-large input, replaced editor file, escaped terminal text, range/page boundary. Sentinels prove no unrelated file/secret or configured filter is read/executed. |
| **V04 helper ownership** | SC05, SC07, SC12 | Real child IPC → correlated extraction or incomplete outcome. Wrong dialect/catalog/generation/digest, malformed/truncated/oversized output, delayed reply after supersession, crash and stalled pure computation. Observe helper terminal state and bounded retry/queue cleanup. Another native assignment and its controls remain intact. |
| **V05 automatic linkage** | SC02, SC09, SC14 | Actual public coordinated submission → announced work → TaskStore admission → one controlled native execution → managed workspace/result. Simultaneous equivalent/conflicting keys, shared and different bases, board disabled, saturated admission, optional preflight/reference flow, zero extra model-written coordination descriptions. Inspect the durable request/link before worker launch. |
| **V06 linkage interruption** | SC09, SC12, SC14 | Fresh processes die at each declared publication frontier, then reopen real stores. Cases include payload-only staging, announcement committed, binding reservation, task admission committed, metadata link settled, lost acknowledgment and native-start intent. Reconcile exact identity; no second inference, disappearing accepted task or blank-state reset. |
| **V07 watcher correctness** | SC07, SC08 | Real Linux events and bounded inventory → current public report. Replacement saves, file/directory rename, new/deleted file, missed event, null filename, watch capacity exhaustion, disconnected parent, malformed edit followed by repair. Inject delivery loss separately to test gap handling; actual watcher behavior still needs system evidence. |
| **V08 quiet delivery** | SC08, SC10 | Explicit watch or two corresponding changed regions → one material notice to an authorized parent. Repeated saves, timestamps, unchanged compact state and unrelated directories add no repeated notice. Reversion resolves the observation. Lost reply may redeliver the same identity; persisted acknowledgment and explicit gaps survive reopen. |
| **V09 current authority** | SC02, SC10, SC11 | Real authenticated clients in different worktrees → sharing/revocation, task adoption, metadata adoption and operator recovery. Stale clients cannot read new reports through old handles/cache/cursors. Cross-parent metadata visibility does not silently confer raw-source detail or task control. Notes remain attributed and agreements retain exact parties. |
| **V10 retirement integration** | SC06, SC11, SC13 | Real task/result/control codecs, case selection and DispositionManager → selected refusal, retained result, release-first archival/retirement. Race automatic enrollment/selection/adoption/capture against retirement, including stale preflight after a completed retirement attempt. Verify source commits and refs before/after. Never remove external workspaces. |
| **V11 capacity and lifecycle** | SC07, SC08, SC12 | Fill real listener/client/session/helper/notification capacity while jobs, native input and hooks wait. Authorized observation/input/cancel/recovery remain bounded and available through the actual path. All clients may detach while accepted work continues. Normal service drain differs from observer cancellation; a parser failure never supplies task cancellation. |
| **V12 persisted compatibility** | SC01, SC09, SC14 | Historical metadata v1/v2/v3 and supported task/result fixtures → read/migrate/reopen. Invalid/rejected requests leave source bytes untouched. New representation updates all consumers and rejects unsupported older binaries after controlled cutover. Corruption, disk-full/publication failure and stale operation keys retain uncertainty, not destructive reset. |
| **V13 installed artifact** | SC04, SC14 | Clean candidate → separate installation → all-language report through actual executable/stdio/socket path, with source/development modules unavailable and runtime network/build invocation prevented. Missing or mismatched native component affects only its capability. Verify complete native hashes, query files, SBOM/notices and registration preservation. |
| **V14 live parent/worker use** | SC10–SC12, SC15 | Actual named host sessions and registered native adapters → two parents/three workers, overlapping and independent work, optional preflight, checkpoint, input pause, detach/reconnect/adoption, structural notice, external integration, retirement. Record exact builds/providers and operator authority. No fixture provider satisfies this claim. |
| **V15 resource behavior** | SC07, SC08, SC12, SC16 | Same-machine feature-disabled baseline and enabled candidate on named representative corpora → recorded CPU, memory, latency and parent-context costs, plus bounded overload and available control/worker behavior. Includes native memory, full serialization/IPC and active worker/control load; see section 4. |
| **V16 independent review** | SC17 | Identified final native/public/installed candidate and evidence → Astra high subagent review, findings/dispositions and affected reverification. Reviewer examines native trust, source/range fidelity, queue/drain, crash linkage, sharing/cursors, migration, package closure and skills. Same-author review is development evidence, not this gate. |

Test cancellation and human input at their real ownership boundaries. Mocking a terminal worker can prove handling of that observation, not native settlement. A failed parent SDK call is not proof that a worker remained alive; observe the worker's actual continued work or native state. The new helper's pure-computation budget is distinct from the coding-worker lifetime.

## 3. Independent oracles and negative tests

For every negative case start with an otherwise valid input and reach the intended boundary. Assert its exact typed failure and decisive structured fields, not merely an exception or nonzero exit. Wrong-mode, malformed metadata or expired authority must not accidentally make a supposed source-race test pass before source inspection occurs.

Expected declaration text and source ranges are reviewed against independently authored examples and the selected language documentation. Do not generate goldens from the extractor and then assert equality. Native parser/grammar agreement is not independent evidence for default masking or consumer behavior. Mutations and property tests prove only their sampled domain; keep the unexamined domain explicit.

For side-effect absence, combine process ownership/census, guarded command probes and filesystem/network controls suited to the claim. A spy on one helper method does not prove that package loading or another subprocess performed no build or inference. Development compilation is allowed under development authority; observation must not launch a project compiler, test runner, evaluator or model.

Keep disposable test repositories, ports/sockets, credentials and temporary roots independent under parallel runs. Restore borrowed environment state and join all owned children before teardown. Preserve normal Git hooks in user work; fixture-only hooks may deliberately wait, record invocation or fail. Retain failed-run resource identities and clean up only those verified fixture resources.

## 4. Bounded observation and representative resource measurements

The implementation lead selects straightforward bounded analysis limits, defaults and configuration for documented supported environments, then verifies overload behavior and measures the candidate. The maintainer specified no fixed CPU, memory, latency or context-volume targets, and numeric approval is not an acceptance gate. Optional analysis may be deferred or reported incomplete under pressure. Analysis limits must never terminate coding workers or release their ownership. Record chosen limits, measurements and limitations in [SC16 engineering evidence](resource-behavior.md). The report records these fields:

| Metric | Workload and evidence to record |
|---|---|
| Discovery/task-control latency | Cold and warm metadata/discovery, input/cancel/recovery while analysis and observers are saturated; p50/p95/p99 plus worst bounded failure behavior. |
| Useful report latency | Edit/capture to retrievable compact report, separately from debounce and optional pull interval; small/median/large/malformed files and embedded Svelte. |
| Memory | Parent service plus all helpers' RSS/native allocations, queue buffers, resident grammars, captures, caches and slow-reader output. Include plateau after repeated edits and grammar switching. |
| CPU and filesystem work | Idle registered work, sustained edit rate, large dirty tree, watch-gap rescan, number of Git subprocesses/parsed bytes, one changed file versus unchanged whole repository. |
| Fairness/capacity | Two parents/three workers minimum and the maximum configured supported load; one hot file or expensive language cannot starve another work's latest observation. |
| Model-facing context | Actual serialized payload and delivered text size, repeats and details fetched. Routine monitoring adds zero inference/evaluator requests. Token estimates, if used, name their tokenizer and are not byte measurements. |
| Artifact/startup | Cold native load, all-language runtime footprint, missing artifact handling and installed startup unaffected by unused parsing. |

Record machine/CPU/RAM/storage/filesystem, process limits, kernel/Node/native builds, corpus revisions/licensing, size distribution, edit replay, warm-up, samples/variability, raw observations and baseline. Use both independent workload generators for stress and named representative source corpora for workflow impact; generated tiny snippets alone are not a repository benchmark. Existing fixed safety caps are not measured performance guarantees.

Begin with one analysis slot and a bounded queue. Keep the design straightforward; a general adaptive resource scheduler is outside this scope. Grammar parsing/AST memory is counted even when V8 reports little growth. Verify helper-only containment; a cgroup or process limit must not include coding workers by accident. Record observation gaps/superseded work rather than queuing unbounded history. Demonstrate that task controls remain usable while analysis is saturated.

## 5. Release artifact and operator cutover

Extend the existing builder, not a parallel installer. In a clean, reviewed source checkout with explicitly provisioned dependencies, the existing entry point is:

```sh
npm run build:runtime -- --source "$PWD" --output /absolute/disposable/artifact-output
```

Use an output root outside the selected source. The completed builder must include all helper, native, query and catalog artifacts and verify their identities. Installation through the existing explicit CLI into a disposable test root must succeed without fetching or compiling dependencies. Test runtime reporting from a directory unrelated to both source and artifact, with development module search paths cleared.

Construct tests for missing scanner, wrong architecture/libc/ABI, altered query/catalog/native bytes, wrong manifest, and compatible/unsupported historical metadata. A successful `--version` is only identity/startup evidence; all-language extraction and actual MCP/CLI retrieval are mandatory. Verify relocation and paths containing spaces/non-ASCII. Preserve registered server names and approval/denial/required policy.

Real cutover requires explicit operator authority: inventory active frontends/service/workers, freeze new admission through the supported path, drain without task-killing deadlines, account for uncertain workers, prepare a complete new artifact without overwriting the running one, and migrate only with a capable reader under the same ownership guards. Incompatible clients report a conflict instead of killing the old service or selecting a second state root. Backups preserve evidence but do not authorize rolling state backward. New metadata/task versions may require forward-compatible recovery rather than an old binary.

## 6. Required-real workflow and final gate

Use the actual installed parent host and both existing supported native adapters where their support is advertised. Secure operator authorization for accounts, source use and fixture tasks before making native calls. Start two parent sessions in different linked worktrees and three workers: two edit one identifiable declaration differently, the third performs independent work. Demonstrate factual compact notices, no message for independent activity, optional reference submission, a real native input pause, all-parent detachment, reconnect/adoption, one reconciliation lead, parent-directed external integration and F9 release-first retirement.

Include a quiet native interval, subprocess/hook wait and pending human presentation beyond the relevant previously removed timer boundaries. Use actual native evidence for liveness/settlement. Host-imposed session limits are recorded as platform behavior, not relabelled as Passeur success. Qualify both supported adapters independently; do not silently replace one with a convenient provider. Update the usage skill and exercise it from a fresh session without the design conversation.

Run the final pinned application/native/core/SDK/CLI suite, native language corpus, installation, performance and required-real procedures against the identified material candidate. Run independent review at the completed unit/final integration boundary, not after every commit. Changed source semantics trigger affected review/tests; appending unchanged evidence does not invalidate the reviewed code.

Accept only when SC01–SC17 and their required inherited lifecycle guarantees are satisfied, mandatory findings are closed or explicitly excepted by authorized policy, support claims match the measured matrix, and every plan-created branch/worktree/process/artifact has a recorded disposition. A new missing environment is recorded precisely; it is not an excuse to fabricate substitute conformance or a reason to keep unrelated finished source indefinitely unimplemented.
