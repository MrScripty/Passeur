# First evaluator provider: TypeSafe Jev

This is a candidate qualification dossier, not an installation or live acceptance report. Public documentation was checked on September 21, 2026, America/Vancouver. No credentials, provider inference, user source transmission or account-specific terms were used.

## Documented interface facts

TypeSafe documents `Choice`, `Score`, and `Noul` questions over text or structured text state. Choice selects a supplied option and returns its distribution; Score returns an ordinal-rubric result/distribution; Noul returns a yes-probability. Choice/Score also carry a confidence field. The system is not used here to generate prose, code or explanations. [Introduction](https://docs.typesafe.ai/introduction), [primitives](https://docs.typesafe.ai/primitives).

The HTTP endpoint is `POST https://api.typesafe.ai/v1/systemone`, authenticated with a bearer key. Its envelope names `state`, `model` and a map of typed `questions`; replies name the returned model, answers and usage. Each answer is correlated by its question key. Criteria and selected output types must match. Use the official JavaScript SDK at an exact qualified version rather than inventing an undocumented protocol. [API reference](https://docs.typesafe.ai/api), [JavaScript SDK](https://docs.typesafe.ai/sdk/javascript).

The model documentation currently names `jev-1.13.0` and states that moving aliases can resolve differently later. It is a qualification candidate for this plan; confirm access and exact returned identity before use. No local weights or offline execution capability is established by this dossier. Account limits, input constraints and pricing must be checked at deployment, not embedded as permanent product constants. [Models](https://docs.typesafe.ai/models).

The confidence field is derived from the answer distribution; it is not a separately measured accuracy result on Passeur. The documentation distinguishes it from answer probability and recommends domain-specific thresholds. [Confidence](https://docs.typesafe.ai/confidence).

The provider publishes limitations concerning indirection, irrelevant context, numeric precision and adversarial source content. Those motivate bounded state, exact code-owned arithmetic and independent adversarial/semantic tests; the plan does not assume robust program verification. [Model limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13).

The JavaScript retry policy can retry interrupted connections and timeouts. Configure the documented retry controls explicitly, initially with retries disabled. Explicitly configure service credentials, model, endpoint, logging and evaluation-only observation budget rather than inherit environment or SDK behavior accidentally. [Retry policy](https://docs.typesafe.ai/sdk/javascript/api/interfaces/RetryPolicy), [client configuration](https://docs.typesafe.ai/sdk/javascript/api/interfaces/TypeSafeClientConfig).

## Qualification inventory and closure gates

M0 records the selected SDK/protocol and unresolved qualification facts. Actual account, disclosure and semantic-quality evidence belongs to M5–M7 before live use or the corresponding acceptance claim; its absence does not block independent deterministic source work.

| Fact | Required evidence | Current status |
|---|---|---|
| Exact provider model available to the approved account | Authorized model check and a returned identity from an admitted live sample | Pending; no account used |
| Fixed SDK/runtime identity | Lockfile/source/integrity, Node compatibility, license and installed import test | Pending |
| Complete request/response decoding | Official schema examples plus independently constructed valid and invalid peer responses | Planned EV01 |
| Bounded request and response sizes | Deployed provider limits plus tighter Passeur policy and actual rejection tests | Pending |
| Retry behavior | HTTP request counts under timeout/disconnection/overload with configured retries disabled | Planned EV04 |
| Approved data use/retention | Operator-selected account/endpoint, accepted source-egress policy and actual applicable terms | Pending; no permission inferred |
| Workload usefulness | Pinned model, fixed questions, independent held-out labels, uncertainty and per-language results | Planned EV05/EV09 |
| No unintended logging/credential propagation | Process environment/log/artifact checks in the installed service | Planned EV03/EV10 |

Missing facts are specific gates, not a reason to fabricate an API or select an untested replacement. A request that asks to create the implementation plan does not itself authorize authenticated use, billing, key provisioning or source egress.

## Selected adapter boundaries

`src/evaluation/typesafe.ts` owns only provider mapping, request construction, response decoding and known provider errors. `src/evaluation/owner.ts` owns lifecycle, retries permitted by policy, budget reservation, stale-result classification and persistence. `policy.ts` owns thresholds and qualification; `questions.ts` owns the closed question catalog. The transport cannot choose task behavior or expand a context packet.

Required model outputs remain typed probabilities/categories. A scoring-only alternative could support a narrower subset through an explicitly qualified adapter; unsupported questions return `unsupported`, not a guessed Choice answer. A future provider does not inherit this model's thresholds, license/data permissions, output meanings or code-language competence.

## Claim limits

The provider's general speed, price and calibration statements are not Passeur benchmarks. The accepted performance claim must include candidate retrieval, source preparation, network time, evaluator cost, cache behavior, additional parent reading and missed/false notices. Live provider success proves connectivity and decoding; it does not prove the semantic judgments are correct.
