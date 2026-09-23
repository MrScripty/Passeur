# SC16 engineering evidence

Status: **pending implementation and measurement**. The maintainer specified bounded observation and controlled overload on documented supported environments, available task controls, preserved coding-worker lifetime/ownership, and representative CPU, memory, latency and parent-context measurements. The implementation lead selects limits and configuration. There are no maintainer-approved numeric performance targets to await.

## Limits selected so far

| Limit | Current value and owner | Evidence boundary |
|---|---|---|
| Source capture read ceiling | 8 MiB per source operation in `src/observation/source.ts`; caller may choose a lower `max_bytes` | Existing source tests cover rejection; this does not bound native parser RSS or aggregate caches. |
| Analysis concurrency | One helper child active in `src/observation/helper.ts` | Direct native helper check confirms extraction through a child; service integration remains pending. |
| Waiting analysis jobs | Four waiting jobs in the helper owner | A fifth waiting request is refused with `STRUCTURAL_ANALYSIS_CAPACITY`; close drains waiting jobs. |
| IPC and reply bytes | 9 MiB request through Node IPC; 1 MiB framed stdout reply in `src/observation/helper-protocol.ts` | The service checks stdout chunks before parsing the reply, and the child checks its serialized reply before sending. Node IPC still deserializes the bounded captured-source request in the child; a full native RSS limit and representative pressure run remain pending. |
| Per-job time | 30 seconds; timeout kills only the analysis child | Direct timeout/saturated-service evidence remains pending. This is not a coding-worker deadline. |
| Retained captured detail | At most 32 pairs and 64 MiB of captured source bytes in the current service process | Eviction/restart yields `STRUCTURAL_DETAIL_UNAVAILABLE`; this is a byte-accounting cap, not a full process RSS cap. |
| Detail response | At most 8192 captured UTF-8 bytes per request | Requires the active work owner and the same work revision; no path re-read. |

The lead must still qualify helper/native memory containment or observation, durable report/notice limits, overload outcomes and relevant configuration when those owners are implemented. Analysis overload may defer work or return an explicit incomplete result. These limits apply only to observation jobs, not coding workers, task ownership or task-control admission. A general adaptive resource scheduler is outside this plan.

## Measurements and acceptance

No representative SC16 CPU, memory, latency or parent-context measurements exist yet. Measure the final native/public/installed candidate and its feature-disabled baseline on named supported environments and representative corpora using [V15](verification-and-release.md#4-bounded-observation-and-representative-resource-measurements). Include saturated analysis while input, cancel and recovery controls remain usable, and observe actual coding-worker continuation/ownership. Record raw samples, environment, configured limits, overload results and limitations. Do not turn a parser-load or sparse fixture timing into SC16 acceptance.
