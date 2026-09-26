# Compact symbol representation inventory

## Baseline at `start`

| Item | Current evidence | Disposition |
| --- | --- | --- |
| Tree-sitter/native helper | `src/observation/helper-main.ts:1-22` delegates to `extractNativeFunctions`; pinned parser identity remains the existing owner | Preserve |
| Declaration model | `src/observation/model.ts:46-70` already retains kind, name, enclosing scope, UTF-8 byte range, signature, parameters, result, body/default markers and limitations | Reuse |
| Comparison | `src/observation/match.ts:43-123` already distinguishes unchanged, modified, body/default-only, added, removed, ambiguous and unobserved states | Reuse |
| Intended Passeur consumer | `src/core/repository-runtime.ts:1148-1227` performs authorized capture, native comparison and bounded report projection | Preserve |
| Single-state inspection gap | `src/observation/report.ts:31-68` renders only comparison changes; unchanged declarations have no public compact inspection projection | Add input/observed view using the same capture/authorization path |
| Concrete gap | `src/observation/native-extraction.ts:211-220` drops ordinary TypeScript/TSX lexical declarators; `tests/native/structural-native-functions.test.mjs:56-60` expects incomplete coverage | Repair in S1 |
| Source authorization | `src/core/repository-runtime.ts:1173-1221` and existing report/detail tests recheck current work authority | Preserve; no new access path |

## S1 evidence

- The candidate scope is exactly the admitted feature write set: native
  extraction and tests, shared inspection/comparison renderer and tests, the
  existing service/CLI/MCP structural-report consumer and public tests,
  reporting documentation, and this plan/inventory. The feature slice does
  not edit lifecycle source, Whip-Docs, the coordination plan, the ZIP, or
  dependency/configuration files.
- Exact final native gate: `npm run test:native` — **211 passed, 0 failed**.
  This includes ordinary TypeScript/TSX declarations, masking/ranges,
  generator and namespace metadata, namespace comparison, Python local/nested
  limits, Rust local limits, all selected grammar routes, helper framing,
  authenticated native reports and resource bounds.
- Exact final core/public gate: `npm run test:core` — **652 passed, 0
  failed**. This includes the authenticated inspection, authorization,
  retained-capture and source-range paths.
- Exact production refresh: `npm run build` — passed before the consumer
  verification below. Feature-owned structural/report outputs in `dist` and
  the core/native build outputs were refreshed from the current source;
  generated artifacts attributable only to concurrent lifecycle edits remain
  outside this feature acceptance claim.
- Exact final CLI/MCP gate:
  `./node_modules/.bin/vitest run tests/integration/structural-cli-mcp.test.ts`
  — **2 passed, 0 failed**.
- Exact feature-scoped typechecks and hygiene:
  `./node_modules/.bin/tsc -p tsconfig.core.json --noEmit`,
  `./node_modules/.bin/tsc -p tsconfig.native.json --noEmit`, and
  `git diff --check` — all passed. Elevated execution was required because
  sandboxed child Node processes return `EPERM`; the elevated native/core and
  public gates pass.
- Current whole-worktree `npm run check` also passes after the concurrent
  lifecycle test was repaired. That untracked test and the concurrent
  lifecycle edits remain outside this feature commit; the feature's admitted
  core/native typechecks above independently pass as well.
- Current explicit limits are language-qualified in the plan: TS/TSX local,
  loop and hidden declaration-like syntax; Python local/import/match/
  comprehension and conditional nested bindings; Rust constants/statics and
  local bindings; ordinary JavaScript top-level bindings; selected direct
  syntax limits in the other native families; unsupported computed/error
  bindings; parser damage; and file-level incomplete comparison. The
  representation does not infer types, results, dependencies, or authorship.
- Final read-only reviewer dispositions and the feature commit hash are
  recorded below after the last exact-candidate review.

## Concurrent ownership disposition

- Lifecycle commit `4543e35` records the other session's completed lifecycle
  evidence; current `HEAD` is `f2cd090` (`docs: update lifecycle verification
  blockers`). Its current uncommitted working set is preserved and excluded
  from this slice: `src/core/lease.ts`, `src/core/process-identity.ts`,
  `src/service/client.ts`, `tests/core/lease-recovery.test.mjs`,
  `tests/integration/coordination-process-crash.test.ts`,
  `docs/shared-service.md`,
  `docs/plans/shared-service-and-evidence-driven-lifecycle/plan.md`,
  `docs/plans/shared-service-and-evidence-driven-lifecycle/issues.md`,
  `docs/plans/shared-service-and-evidence-driven-lifecycle/execution-ledger.md`,
  `docs/plans/shared-service-and-evidence-driven-lifecycle/reports/implementation-evidence.md`,
  and the untracked `tests/integration/service-attachment-recovery.test.ts`.
- `src/core/repository-runtime.ts` and `src/service/server.ts` are shared
  historical paths, but the current diff in this candidate contains only the
  admitted structural-report view changes; no lifecycle hunk from the other
  session is staged. The untracked `Passeur_Structural_Review_Fixes.zip` and
  `docs/plans/Passeur_Concurrent_Change_Coordination_Plan.md` are preserved.

## Deferred findings

The Sol xhigh review also identified unrelated lifecycle/publication findings in
`src/core/repository-runtime.ts:386,443,482,499` and
`src/observation/monitor.ts:340`. They remain deferred to the shared-service and
observation owners; this representation-only slice does not change worktree
identity or monitor publication state.

The same review identified conservative file-level comparison behavior when an
otherwise valid declaration is adjacent to unrelated parse damage
(`src/observation/match.ts:30,95`). This slice preserves that explicit
`unobserved`/incomplete outcome rather than widening the comparison contract.

## Final review dispositions

- Astra high (`01a0dba0-dd0a-73c3-bbd9-7e2584053777`): functional review
  clean after the final catch/global and native-family repairs; the remaining
  evidence note was closed by the refreshed feature build and CLI/MCP gate,
  with concurrent lifecycle generated artifacts explicitly excluded above.
- Luna max (`01a0dba0-dd64-7e11-b6b4-8cb4a74f6647`): orchestration boundary
  clean; feature-only scope and all current lifecycle exclusions verified.
- Sol xhigh (`01a0dba7-9123-7a71-9d0c-a80a3d1a0c45`): clean; all 21
  independent repair probes and the refreshed gates passed with no edits or
  commit.

## Commit

Feature-only commit: `f91af87` (`feat(structural): add compact source
inspection views`). Concurrent lifecycle changes and preserved untracked
artifacts remain outside the commit.
