# Evaluator design and operating contract

This report refines D13–D16 of [the plan](../plan.md). It describes a probabilistic advisory feature within Passeur's local coordination service. The native structural path remains deterministic. All listed capabilities are planned; actual qualification is governed by [evaluator verification](evaluator-verification.md).

## 1. Product effect and ownership

The feature helps a parent recognize relevant interactions earlier and spend less attention on unrelated observations. It evaluates already available intent, exact structural evidence, explicitly permitted short code excerpts and attributed agreements. It neither interrogates coding agents for more context nor becomes a new agent reasoning loop.

| Stage | Owning mechanism | What it may establish |
|---|---|---|
| Identify code versions | Git/source capture | Exact input/observed bytes and provenance |
| Extract declarations | Native Tree-sitter and qualified extractors | Written syntax, ranges, coverage and correspondence evidence |
| Select a candidate/context | Deterministic retrieval and disclosure policy | Authorized bounded evidence for one question |
| Evaluate | Fixed typed-question provider | A probabilistic hypothesis about that supplied evidence |
| Decide notice delivery | Deterministic policy with a qualification record | Optional advice inclusion/ranking under explicit limits |
| Decide development action | Parent/orchestrator | Whether to coordinate, instruct its worker, validate or integrate |

Evaluation output is not a second code version, resolved call graph, accepted requirement, process-liveness signal, permission grant or merge result. Even an apparently certain answer has no executable authority.

## 2. Four fixed question families

Questions are authored as versioned product configuration reviewed with their criteria and labeled examples. A task may request an admitted family for named authorized work, but cannot supply arbitrary system instructions, output schemas, provider URLs or scoring policies. Question map keys are correlation identifiers, not a substitute for writing the complete question in the provider's instructions.

| ID | Narrow question | Allowed input | Closed result vocabulary | Useful effect |
|---|---|---|---|---|
| EQ01 Intent relation | How do the two explicitly stated task intents relate, within the supplied context? | Existing objective/acceptance text, declared areas and selected notes | `independent`, `related_complementary`, `overlapping_work`, `possible_goal_tension`, `insufficient_context` | Flag duplicate effort or a possible shared decision before native execution |
| EQ02 Change relevance | Is the identified change relevant to the named receiving task's stated objective or watched responsibility? | Compact structural difference, recipient objective, exact watch/region context | `not_indicated`, `possibly_relevant`, `likely_relevant`, `insufficient_context` | Rank additional coordination notices without sending every overlap |
| EQ03 Behavioral interaction | Does the supplied pair of changes contain evidence of potentially incompatible behavior? | Exact per-task deltas and explicitly permitted relevant bodies/notes | `possible_disagreement`, `no_disagreement_evidence_in_supplied_context`, `insufficient_context` | Highlight interactions invisible in unchanged signatures; parent interprets them |
| EQ04 Agreement tension | Does the supplied observed change appear inconsistent with the exact acknowledged agreement text? | Agreement revision plus exact scoped change evidence | `possible_tension`, `apparently_consistent_in_supplied_context`, `insufficient_context` | Raise a review hypothesis without declaring a violation or changing the agreement |

These are hypotheses about supplied context, not propositions proven true for the repository. EQ03 is not “is this merge correct?” EQ04 is not “did this parent consent?” Exact acknowledgment, correspondence, arithmetic, timestamps and source identity stay in code.

The first provider mapping uses `Choice` for these closed answer sets, including explicit insufficient-context alternatives. A separately admitted ordinal `Score` may rank already eligible optional advice; a `Noul` probability may answer a specifically defined binary subquestion only when that exact primitive has been calibrated. Equivalent-looking questions expressed using different primitives do not share thresholds. Do not ask the same question several ways as a confidence vote.

Each question is independent. A batched question cannot read another question's answer. If a decision requires an earlier answer, stage it in code under the bounded expansion rule. Independent outputs need not satisfy imagined mathematical identities; the policy avoids combining them as independent probabilities or converting a mean rubric score into a measured defect count.

## 3. Candidate discovery and missed interactions

Evaluation cannot recover an interaction that never enters its candidate set. Capture that boundary in both telemetry and qualification.

Select candidates from exact watches and structural/path overlaps first. For EQ01 also use a bounded index of authorized active/recent-unintegrated work within the selected repository/target cohort, retrieving task text by deterministic token/field relevance. A parent may explicitly select an otherwise omitted peer for assessment. Broader same-target candidate coverage can be configured within an admitted request/token budget; it is not an unbounded all-pairs scan on every save.

The candidate record identifies the retrieval method, query, examined population bounds, returned work IDs, ranking and omissions. No candidate found means `no_candidate_selected`, not “no possible interaction.” Measure retrieval recall separately from model accuracy on retrieved pairs. Include same-feature tasks with different filenames and weak vocabulary overlap in the acceptance corpus.

Use a stable work-pair/subject identity for coalescing. A newer commit changes evidence revision, not peer ownership. Repository graphs may contain cycles; no acyclicity assumption is imported into lexical/reference occurrences. This feature does not create an authoritative dependency closure from model scores.

## 4. Evidence packet and context tiers

Build one immutable evaluation packet from already captured source/records. The packet includes repository/work IDs under permitted disclosure, each task's `input` and `observed` endpoints, exact fragment IDs/ranges, capture coverage, selected objective/note revisions, omission reasons, question/rubric identity, candidate-selection method and a content digest. Current access is separate from historical packet identity.

| Tier | Contents | Default and limits |
|---|---|---|
| `intent_only` | Approved existing objectives, criteria, declared areas and explicitly selected note text | Suitable for pre-start EQ01; bounded text, no source bodies |
| `structural` | Compact declaration differences, body-change markers, language/coverage and task text | Default for EQ02; masks default-expression/runtime values as in structural reports |
| `bounded_source` | Small exact input/observed body hunks and local enclosing source selected by deterministic extraction | Requires explicit source-egress permission for that provider/use; used for EQ03/EQ04 |

Local availability, readability by a parent, inclusion in a Git repository, or permission to run a coding model does not itself authorize sending these fields to a different provider. All material from multiple parents must satisfy each source's sharing/egress policy. If it cannot, use only a separately valid smaller question or return `context_not_authorized`; do not silently pretend the full question was assessed.

The native reporter keeps raw bodies and literal values out of its default parent response. Permitting a narrowly bounded evaluator source packet does not enlarge that response or authorize arbitrary repository export. Expressions that remain in a permitted code excerpt are treated as source, not executed or evaluated runtime values. Secrets and private configuration are excluded by source-scope policy; heuristic redaction is an additional control, not proof that arbitrary source is safe to export.

The packet states truncation and every missing required component. A deterministic prerequisite rejects EQ03 when only signatures/body-change booleans are available and the case requires implementation behavior. A model's confidence cannot make absent material present. EQ01 may still be evaluated against an independently sufficient intent packet.

For an insufficient result, code may perform at most one pre-authorized expansion to `bounded_source` and one additional assessment under the same explicit budget. The model does not request paths, fetch links or issue commands. If context is still insufficient, stop and retain the limitation. Do not wake a coding agent to explain the change merely to satisfy the evaluator.

## 5. Example: unchanged interface, potentially changed assumption

Consider an illustrative function whose signature remains `cancel(id): Promise<void>`. One task's permitted body excerpt changes when that promise settles. Another task's permitted excerpt removes a workspace after awaiting it. The exact structural report states only that the two bodies changed. EQ03 may identify a possible behavioral disagreement from those snippets. It cannot prove the repository-wide effect if unseen callers, process ownership or omitted conditions matter.

A default parent view would contain:

```text
STRUCTURAL FACTS
  Task A: INPUT A0 -> OBSERVED A7, cancel, body changed
  Task B: INPUT B0 -> OBSERVED B4, retireWorkspace, body changed
  Declared interfaces: unchanged in the compared fragments

MODEL ADVICE
  Question: EQ03 / rubric revision <identity>
  Hypothesis: possible_disagreement
  Evidence: packet <identity>; omitted context listed separately
  Model: <exact returned model>
  Answer distribution: <retained values>
  Application qualification: <record or unqualified>
```

Formatting is deterministic. There is no generated explanation and no claim that the functions are proven dependent. A parent can inspect exact source fragments or choose a deliberate follow-up.

## 6. Probability, confidence and qualification

Preserve the provider's returned probability distribution and confidence independently. A confidence statistic describing concentration is not measured Passeur accuracy. A high score does not confer permission, establish correctness, or satisfy an acceptance claim.

The qualification key binds provider/model identity, request/question schema, rubric/criteria wording, context assembly, redaction rules, candidate retrieval, language/dialect/form, output interpretation and delivery-policy version. Changes to those material inputs require the relevant requalification. Updating only display punctuation need not invalidate a semantic qualification when the meaning and packet remain unchanged; record the equivalence rather than over-invalidating blindly.

Thresholds are selected from held-out, independently labeled decisions. Define the cost of a false notice, missed material interaction, abstention and extra context before tuning. Labels can be `insufficient_context` or genuinely ambiguous; adjudication preserves disagreement rather than treating every record as a binary fact. Report per-language/per-question results, not only an aggregate that hides weak rows.

For EQ03, the claim is useful detection of plausible interactions in the admitted evidence domain, not complete semantic verification. A test that compares provider output to a label generated by the same provider is not an independent oracle. Parser accuracy, a well-formed response, or a live API success cannot stand in for decision usefulness.

## 7. Modes, protected notices and delivery

`disabled` makes no evaluator call and exposes only deterministic structural/coordination behavior. `shadow` records authorized model judgments and metrics but does not change parent delivery. `advisory` permits optional labels and ranking only for a qualified scope. A deployment can disable a particular question/language/context scope while other independently qualified scopes remain active; the advertised support matrix identifies that limit.

The deterministic lane includes explicit watches, direct structural changes already selected by the base notification contract, control/claim conflicts, native input and uncertainty notices. It is never held hostage to a score or suppressed by a low relevance answer. Parent suppression settings remain their own explicit authority; a model cannot invent them.

The advisory lane may add a relevant semantic notice for a different-file interaction, prioritize a subset of optional advice, or suppress repetition of already delivered model-only advice. Source facts always remain queryable. A low-scored omitted advisory item is not recorded as compatible, resolved, complete or safe.

An unqualified/uncertain evaluation is retained as such. It does not automatically notify every parent. The explicit policy may surface one bounded `evaluation_unavailable` or `insufficient_context` summary where the parent requested an assessment, otherwise it remains accessible through status/retrieval. Continue mandatory deterministic messages immediately.

Notices are tied to existing authorized parent/work identities. A model may not select an arbitrary recipient. Cached advice is rechecked against present source-sharing policy before disclosure. Delivery uses existing request-associated polling/wait/cursors; it does not promise that notifications wake the host model.

## 8. Runtime, cost and caching

EvaluationOwner is an asynchronous service-owned component, not a general agent scheduler. Its bounded queue is independent from native coding-worker slots. The parser helper has no evaluator key or network authority. Provider I/O occurs outside coordination, task, admission and storage locks.

For each distinct eligible packet, atomically reserve request count, input budget, estimated cost and concurrency before dispatch. Parent-scope and repository-scope limits are explicit. Time windows used for metering or refill are accounting policy, not task-lifetime authority. A missing price/token-estimation capability uses a conservatively approved request bound or returns `budget_unavailable`; it does not invent a monetary estimate. Define how maximum provider tokens and question multiplicity enter the estimate.

Single-flight key = exact packet digest + fixed question/rubric + model + provider-contract + qualification/context-policy identities. This prevents duplicate simultaneous calls for the same work. Cache result evidence with its raw distribution, usage and validity scope. A mutable model alias is not an immutable cache identity. Record returned model and reject unexpected drift before advice affects delivery.

No periodic reassessment of unchanged code or unchanged intents. Rate/debounce schedules may coalesce observations; they never force a paid call. More source content with the same declaration-only compact report can invalidate a body-level judgment only when the body was a material input to that judgment. Cache/source identities and notice-materiality identities are separate.

A paid evaluation does not need the originating tool call to remain connected. Its owner observes completion and stores the result even if the parent detaches, subject to approved retention. Parent observation cancellation removes the waiter. Explicit evaluator cancellation may cancel queued work or interrupt an HTTP observation, but neither proves that a dispatched remote request was unexecuted or unbilled.

## 9. Provider dispatch, persistence and unknown outcomes

Use a small versioned evaluation control aggregate in the existing state namespace for shared budget reservations, keyed active operations and receipts. It owns only evaluation invocation/accounting invariants. Structural/coordination control remains in its existing owner. Large immutable results/packets are separate artifacts; no SQL/task database or cross-file transaction engine is introduced.

Prepare immutable packet artifact and validate it before an atomic evaluator-control record names it. Acknowledge accepted evaluation only after the control record and packet identity are durable. Publication of a record naming missing/incomplete data is invalid. Recovery may remove explicitly disposable unreferenced staging artifacts but never authoritative requests or uncertain cost reservations.

Durable transition vocabulary distinguishes `queued`, `dispatch_intent`, `responded`, `unavailable`, `cancelled_before_dispatch`, and `delivery_unknown`; application of a result has separate current/stale/withheld qualification. A crash after dispatch intent creates possible remote execution. Code does not blindly resend. A confirmed provider rejection or a later explicitly authorized new attempt follows its owned retry/budget contract. Use provider idempotency only after actual support is established; local operation keys alone do not make remote billing exactly once.

Disable SDK automatic retries initially and explicitly set endpoint/model/logging/time-budget options. A provider rate limit is not a coding-task failure. A bounded independently authorized retry may be enabled only after distinguishing confirmed pre-execution rejection from an ambiguous connection/body failure. The receipt records every attempt; no hidden request multiplier is allowed.

A late response is decoded and retained if current retention permits, then classified against work/context/permission/qualification generations. It cannot overwrite newer advice. Failed parsing/oversize output becomes an explicit error, not an alternate model call. Credential, network and provider failures do not freeze healthy task execution; only loss of a genuinely required authoritative store blocks its dependent mutations.

## 10. Security and privacy

Treat HTTP responses, model outputs and included source/notes as untrusted. Full decoding verifies expected question IDs, selected variants, exact option sets, numeric finite/range/sum constraints with a declared floating-point tolerance, requested/returned model, usage fields and bounds. Code chooses any ranking arithmetic. The model cannot submit a path, tool call, role or authority token through an output.

Evaluate only source that policy explicitly permits for the selected endpoint/account. Resolve credentials through private service configuration; do not place them in command arguments, prompts, ordinary logs, parser-helper environments or worker environments. Explicitly control SDK log levels so request/response bodies are not unexpectedly logged.

Endpoint changes require operator approval and a new disclosure decision. Automatic redirects to unapproved destinations are rejected. Use normal certificate/hostname validation. The plan grants no permission to contact a local-network address merely because a source file names one. A future local evaluator is a separately configured provider; it is not inferred from JEV access or from a running model server.

Source comments can contain instructions that try to steer an assessment. Include hostile examples in qualification and clearly delimit source data, but do not claim delimiting makes the model immune. Deterministic downstream restrictions prevent an influenced verdict from gaining executable authority. Advice remains a potentially wrong claim that a parent interprets.

Retention and provider data handling are accepted before live source transmission. Do not assume zero retention, training exclusion, local execution, or contractual protection from a marketing statement. Deleting a local artifact does not recall provider data. Revocation before dispatch prevents transmission; revocation afterward prevents further use/disclosure to the extent locally controllable and records that boundary honestly.

## 11. Adoption and stop rules

M5 implements the real protocol/control path with independently specified test peers. M6 establishes application usefulness with the actual pinned provider. M7 qualifies installed operation and fresh-session use. Simulated scores can prove control flow, never the semantic benefit or required live capability.

The current public provider is a candidate. If unavailable to the user, keep the affected real claim blocked and the semantic surface explicitly unqualified. Continue reversible implementation that does not require missing authority; do not invent a model, install an unrelated substitute, or silently label code-only operation as the completed assisted objective.

Advisory deployment requires accepted false-notice/missed-interaction/cost/latency/attention limits for the named workload. If the model does not meet them, preserve deterministic operation and revisit the narrowly failed question/context decision. The existence of an evaluator is not sufficient justification to spend on every source change.
