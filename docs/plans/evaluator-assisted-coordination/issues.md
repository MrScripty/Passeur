# Initial findings and dispositions

All findings below are planning/source observations unless explicitly stated otherwise. They are not reproduced runtime failures. Severity denotes consequence for this objective, not an independently verified incident priority. The lead rechecks exact source in M0 before changing implementation.

| ID | Finding / evidence | Relevance and owner | Disposition / required evidence |
|---|---|---|---|
| SCC-I01 | Baseline `src/workspace/worktree.ts::prepareWorkspace` requires a clean source checkout before creating an isolated exact-base task. | Concurrent parent work; workspace owner. | Fix in M1 after V12/V01 regression. Preserve source views; do not import dirty bytes. |
| SCC-I02 | Workspace retains execution signal; baseline final collection calls `observeDelivery(workspace)` using that signal. An already cancelled task may interrupt evidence collection despite confirmed stop. | Useful retained handoffs; coordinator/workspace lifetime family. | Reproduce in M0, fix the whole collection family in M1; V12. Not claimed confirmed solely from source. |
| SCC-I03 | Worktree preparation is performed through broad administrative coordination; Git hooks may run inside that duration. | Control responsiveness and independent work; resource owner. | Bound creation/retirement intents, release broad guard before hooks, test actual interleaving in V12. Preserve ownership; do not merely remove synchronization. |
| SCC-I04 | Parser existence and tags do not prove parameter/result extraction; Svelte snippet arguments include raw embedded regions. | Required thirteen-language guarantee; observation owner. | M0 packaging admission then L01–L13/V03–V05. Modern unsupported core constructs block the relevant row. |
| SCC-I05 | Exact native parser pins, Node/grammar ABI, scanner packaging and safe file-descriptor capture are not qualified here. | Deployment/security/performance. | Finite M0 decisions using disposable probes. No implicit install, executable grammar loading from projects or weakened capture. |
| SCC-I06 | Existing strict task/IPC outputs and owner-only access cannot be extended informally with cross-parent fields. | Disclosure and compatibility; contracts/security owners. | New versioned coordination surfaces; preserve old outputs/history. V09/V10/V14. |
| SCC-I07 | A target case identified only by its selected commits permits competing ownership when a worker advances. | Reconciliation coordination. | Stable repository/full-ref key plus case revision/generation; V11. |
| SCC-I08 | Existing lifecycle plan is implemented but required pinned/native/installed acceptance is still blocked in its retained record. | Inherited behavior, not a reason to redesign the service. | Keep claims with original owner, qualify only changed/depended-upon behavior; required-real evidence before SC12/SC15/SC17 acceptance. |
| SCC-I09 | New runtime analysis could accidentally invoke filters, lazy fetch, compilers/builds, coding-provider calls or unauthorized evaluator calls. | Domain boundary, CPU and authority. | Process-boundary no-effect tests V03/V06/V08; no source-aware tool launch merely from a model/path. |
| SCC-I10 | A bounded control aggregate must distinguish absent initial state from missing initialized authority and keep reliable receipts. | Persistence/claims. | M0 selects explicit enable marker/record protocol and key lifetime; V14 verifies interruption. Re-plan if real transaction/cardinality needs exceed aggregate. |

## Exclusions with revisit triggers

No compiler/type-resolution or authoritative inferred-dependency engine is included. Probabilistic judgments operate only under the evaluator contract; they do not replace exact type/symbol authority. No managed publisher, global proposal lifecycle or exclusive file lease is included. Revisit only if explicit new integration/authority requirements demand it, with a new composed-design review.

Heavy-build resource claims are not in this implementation. Repository/machine build coordination remains with the parent or an existing resource owner. Revisit on an explicit request for that capability, not merely because Rust fixtures appear in the parser suite.

Structural merge tools are optional tools of the integrating parent. This plan neither installs them nor changes Git merge configuration. Revisit only for a separately authorized tool integration with supported language and trust/evidence requirements.

Optional deeper lexical-reference hints are not required for baseline notifications. Implement them only within the syntax-only contract when specific queries provide material coordination value; do not let them delay the required exact-watch/direct-overlap path or turn into a resolved semantic graph.

Any incompatible source or durable state discovered during admission receives an explicit inventory and preserve/migrate/reject decision. Unknown state is not disposable, and its appearance does not authorize deletion.

## Evaluator-specific open qualification findings

| ID | Finding | Owner / disposition | Evidence |
|---|---|---|---|
| EVA-I01 | No account, live model call or application accuracy is established by the planning documents | Maintainer/provider owner; qualify before assisted acceptance, continue independent code work | EV01/EV05 |
| EVA-I02 | The documented confidence field summarizes a distribution, not measured Passeur correctness | Evaluation policy owner; calibrate by question/context/language on held-out cases | EV05 |
| EVA-I03 | Hosted evaluation may disclose source/intent from several owners | Security/operator; explicit per-source egress authority, private credentials, approved retention terms | EV03 |
| EVA-I04 | SDK retry or timeout defaults may repeat billable inference after an uncertain response | Provider adapter; explicitly disable automatic retries, retain unknown attempt and budget | EV04/EV07 |
| EVA-I05 | Relevant body behavior can be absent from a compact declaration-only packet | Context owner; abstain or use one explicitly allowed bounded expansion; never infer absent facts | EV02/EV05 |
| EVA-I06 | Candidate retrieval can omit disjoint-path interactions even with a good evaluator | Retrieval/policy owner; label uncovered population and measure end-to-end recall | EV02/EV09 |
| EVA-I07 | Untrusted source/notes can steer a model despite a closed response shape | Security/policy; injected-input tests; deterministic actions remain outside model authority | EV03/EV06 |
| EVA-I08 | A model update or changed rubric invalidates its qualification and cached policy decisions | Evaluation owner; pinned identity, versioned questions and explicit requalification | EV05/EV10 |
