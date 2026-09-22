# Evaluator verification and acceptance procedures

These procedures refine EA01–EA10. Every claim starts pending. No live evaluator or benchmark was run while authoring the plan. Structural evidence remains governed by SC01–SC17 in [verification](verification.md).

## EV01 — real contract, typed answers and model identity (EA01)

Exercise the actual adapter through an independent HTTP peer specifying valid Choice distributions, uncertainty, rate limits and malformed replies. Preserve unrelated preconditions when testing missing keys, wrong question IDs, output variants, invalid options, duplicate/extra data, nonfinite/out-of-range numbers, probability totals outside the declared tolerance, oversized responses and wrong returned model. Assert the precise failure and absence of actionable advice; generic throws alone are insufficient.

Use the exact qualified SDK and installed Node package. Verify that state/options are encoded from the fixed schema and that raw provider data never bypasses the validated representation. An explicitly authorized live call must then establish the documented model/answer/usage behavior. Controlled peers do not satisfy that live portion. Test that moving aliases are not silently used as fixed model identities.

## EV02 — candidate coverage and source-grounded packets (EA02)

Construct independent task pairs: same-file unrelated work, different-file complementary changes, overlapping goals with no declared shared files, undeclared missing context, identical signatures with materially different body assumptions, and ambiguous objective text. Identify the true relevant population before the retrieval algorithm ranks it. Measure which pairs are selected and which remain outside coverage.

Use real Git commits with different admitted bases and captured worktree buffers. The packet must retain each input/observed identity, authorized source span, task/note revision and omission. Mutate a live file after capture: evaluation still sees the captured bytes. Supply only declarations to a body-dependent question: return insufficient prerequisites or withhold that question, never a fabricated compatibility result.

Test redacted/default-masked packets, unsupported dialect forms, truncated contexts, inaccessible peer objectives, one permitted source expansion and a forbidden second expansion. Verify no import traversal, compiler, runtime introspection or arbitrary model-selected file read. The oracle is independently constructed source/authority and case labels, not the response from the evaluator.

## EV03 — egress, consent, credentials and hostile input (EA03)

Run separate principals with different task-sharing and external-data policies. A parent may read a peer's approved summary without being authorized to export the peer's body to the evaluator. Assert that mixed-source packets cannot dispatch unless every included source satisfies the exact endpoint/content-tier policy.

Race revocation with queued and dispatched requests. Before dispatch, no payload leaves; after dispatch, record that recall is not guaranteed, block future unauthorized use and keep response handling appropriately restricted. Capture actual outbound bytes and destination identity, not merely a mock authorization function call.

Test injected source comments, note text requesting another file, fabricated approval fields, option text containing executable-looking commands, redirect attempts and wrong endpoints. Outputs never cause tools, actor changes, expanded access, task stops, merges or ref updates. Inspect child environments and logs for key propagation and body leakage. A heuristic injection detector is not the sole oracle or enforcement barrier.

## EV04 — paid calls, budgets, duplicate requests and restart (EA04)

Submit simultaneous identical requests through two clients using the same authorized work context. Verify one dispatch and a shared retained result where policy allows, with separate current read authorization. Different intent, model, rubric, material source, privacy tier or qualification must not incorrectly reuse a cache entry.

Count actual HTTP attempts for SDK timeout, response-body interruption, overload, explicit cancellation and service crash. With automatic retries disabled, no uncertain attempt repeats silently. Persist dispatch/budget reservation before sending; reopen after crashes on each side of that boundary. Unknown remote execution retains an uncertain receipt and conservative spend reservation until the admitted reconciliation action. Local operation keys alone must not be asserted to provide remote idempotency.

Fill global/per-parent request, token, money and concurrency limits. Refuse before dispatch; required task cancellation/input remains available. Test unavailable token/pricing information without guessed billing. Repeated saves that do not change the admitted evaluation input cause no new calls. Include both single-flight success and a failed request that does not poison later independently authorized attempts.

## EV05 — independent labels, calibration and language qualification (EA05)

Before tuning, record the case population, allowable loss tradeoffs, labels, adjudicators and split strategy. Split by task family/repository so near-duplicate code or notes cannot leak between tuning and held-out evaluation. Include real representative cases with operator permission and independently authored fixtures for rare failure boundaries. Fix the evaluation policy before revealing the held-out results.

For EQ01, label declared intent relation rather than eventual code correctness. For EQ02, label whether the supplied change merits the receiving parent's attention for its actual assignment. For EQ03, independently identify concrete potential incompatibility in the supplied evidence and acknowledge missing context. For EQ04, decide relation to the exact acknowledged agreement, not inferred consent. Preserve uncertain/adjudicator-disagreement labels. Provider-generated labels or a model reviewing its own output are not independent acceptance evidence.

Cover Rust, TypeScript, JavaScript, Python, Lua, Kotlin, Zig, C#, C, C++, Odin, Svelte 5 and JSX/TSX. Each applicable core code-form/question/context row needs actual model evidence, even though the parser tests already passed. Evaluate signature-stable body changes, async lifetime, parameter/default meaning, error handling, versioned records, duplicate requirements, false same-name matches, templates/macros presented without expansion, and incomplete captures. Cases are bounded; no claim of universal semantic verification follows.

Measure precision/recall of relevant notices, false-notice and missed-interaction rates, abstention/coverage, calibration or reliability by output bucket, and performance variation across languages. A raw confidence statistic is not a substitute. Thresholds and qualification mask name exact model, question/criteria, context/retrieval, language and policy identities. Do not choose a confidence constant because another example used it. Where evidence is too sparse or quality insufficient, mark that assisted row unqualified and its required claim blocked.

## EV06 — separation of fact and model authority (EA06)

Use adversarial provider outputs that confidently declare safe merges, assign parents, demand cancellation, invent symbols and claim consent. Either decoding rejects them or the controlled closed-set verdict is retained only as advice. Snapshot authoritative task state, grants/notes/claims and Git refs before and after: none changes because of the verdict.

Feed a wrong but schema-valid judgment with maximal concentration. Structural facts remain unchanged, and parent output labels it model advice. Parent actions still require their own authorized commands. Code-evaluable facts such as source identity, exact parameter changes, counter values and target generation are never sent to the model as a replacement for deterministic checks.

## EV07 — failure, supersession and non-time-based worker lifetime (EA07)

Run actual controlled native work while evaluator requests stall, exceed their own observation budgets, fail authentication, disconnect, return invalid data or finish after the source/rubric changed. Native task identity, pending inputs, stop evidence, workspace and resource authority remain unchanged. Deterministic notices are not delayed by model I/O.

Cancel the evaluator's queued operation and its parent wait separately. A queued cancellation can establish no dispatch; a remote request observation stopping cannot establish no charge or execution. Reopen service state after loss with pending calls, retain unknown effects and avoid silent replay. Stale results never overwrite the current advice generation. Healthy task evidence is still persisted when evaluation is degraded; no repository native-stop freeze is created solely from a scoring outage.

## EV08 — quiet delivery and protected observations (EA08)

With evaluation disabled, verify zero scoring calls and the same structural behavior. In shadow mode, verify authorized scoring is recorded but has no effect on actual notice selection. In advisory mode, verify only qualified optional hypotheses/ranking change.

Low relevance, high confidence, `insufficient_context` and missing results may never suppress exact watches, direct structural notices selected by the deterministic contract, input obligations or reconciliation ownership conflicts. Repeated identical advice causes no repeated parent interruption. A source/intent change that genuinely changes advice creates one bounded update, not a chain of follow-up model requests.

Prove default delivery is associated with an existing parent interaction. No native subagent is messaged, and no host turn is fabricated. Each parent retrieves only its authorized structural facts/advice. Advice uses fixed labels and exact evidence references, not generated prose presented as fact. An actual installed host workflow must demonstrate usable retrieval without hidden session context.

## EV09 — whether evaluation is worth its cost (EA09)

Define the objective and metric before running: useful interactions found early, missed interactions, false notices, added parent/context work, evaluator cost, response latency and resource contention. Choose acceptance tradeoffs with the maintainer for the representative work mix. Do not invent a universal percentage or inherit provider marketing numbers.

Measure deterministic-only operation and evaluator-assisted operation on the same labeled cases, preserving extraction, cache state and task distribution. Include end-to-end candidate selection, packet creation, provider time, invalidation, cache hits and parent retrieval, not only API latency. Include cross-file and body-only cases that deterministic declarations cannot explain, plus unrelated same-file changes that could waste parent attention.

Account for request multiplicity, retries explicitly authorized, billable unknowns, local CPU/memory, and additional parent tokens or delivered bytes. A model that adds a confident label without improving the accepted usefulness/cost tradeoff does not pass. Report cold/warm behavior and measured variability on the selected machine and actual model. Increased recall at unacceptable false-notice cost is not silently called improvement.

## EV10 — packaging, changes and fresh-session use (EA10)

Install the exact artifact without a source checkout. Verify native grammars still load and default disabled evaluation needs no credentials or outbound access. Explicit enablement, endpoint/data policy, shadow qualification and advisory rollout must be discoverable in the usage skill. An incompatible provider/model/rubric invalidates its qualification without hiding tools, changing worker lifetimes or erasing history.

Upgrade and roll back through supported record/configuration versions. Simulate moving model aliases, unexpected provider response identity, expired credentials, removed policy, an absent result artifact and missing initialized evaluation authority. Return the owned diagnostic; do not recreate missing authoritative state as empty or choose another model automatically.

A fresh skill-aware parent session must identify a structural change, deliberately retrieve a semantic hypothesis, recognize insufficient/unqualified advice, and retain its own direction/acceptance authority. Record an authorized real model workflow and independent completed-candidate review. Document-only validation does not close these claims.

## Final evidence record

Each result records material code/artifact revision, parser/SDK/model/question/context-policy identities, source/corpus and split IDs, commands or operator procedure, environment, expected/observed effects, sample limitations, usage/budget reconciliation and created-resource disposition. Status is `satisfied` only when every required part of the named claim passes. Missing provider access or insufficient labels remains `blocked`, not simulated acceptance.
