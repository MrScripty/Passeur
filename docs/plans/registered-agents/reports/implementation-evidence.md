# Registered-agent implementation evidence

Date: September 20, 2026. Subject: the changed-file candidate against `49724a8b65bf7540622934e4f25cc3178f9c00dc`; no new repository commit or accepted release is claimed. Exact candidate content is identified by the ZIP manifest and per-file hashes.

## Executed in this environment

| Check | Result | Actual scope |
| --- | --- | --- |
| Production baseline reconstruction | All source subtree/blob identities checked before implementation | Actual Passeur production source, not an assumed code sketch. Changed test baselines were separately checked and reconciled. |
| Owner regression selection | 32 passed | Real registry/coordinator/RepositoryRuntime with explicit test-only in-memory store/profile/lease substitutes; real disposable Git commits/workspaces in relevant cases. Does not prove real disk codecs, SDK or installed native agents. |
| Native transport/projection regressions | 15 passed | Real Node subprocesses and production Codex framing/projection/supervision code against controlled peers. Not actual Codex account, permission or inference conformance. |
| Native TypeScript compile | Passed with available global TypeScript 5.8.3 | Strict standalone native modules and dependency closure, with installed Node declarations. Not the pinned 5.9.3 full repository check. |
| Source parser/transpiler | No diagnostics in reconstructed candidate's 64 TypeScript files | Syntax/transpilation only. Does not prove module resolution, Zod semantics, SDK typing or full checkout completeness. |
| Skill/plan/import structure | Passed | Skill frontmatter/names/local links, current plan links and local production import resolution. Not fresh-session behavioral evaluation. |
| Guarded package application | 5 passed | Synthetic disposable Git repositories: original backups, idempotence, changed-file conflict refusal, payload integrity, traversal/symlink refusal, staged-change refusal and preservation of unrelated edits/history. Not application to a downloaded complete 49724a8 checkout. |

Environment: Linux, Node 22.16.0, npm 10.9.2, Git 2.47.3, available global TypeScript 5.8.3. Exact outputs accompany the package under `verification/`.

Commands actually used for the available checks:

```sh
# Syntax-only transpilation through the installed TypeScript compiler API, then:
node --test --test-concurrency=1 tests/core/registered-agents.test.mjs tests/core/runtime-owner.test.mjs
# Strict standalone native check; explicit global declaration path was needed here:
tsc -p tsconfig.native.json --typeRoots /opt/nvm/versions/node/v22.16.0/lib/node_modules/ts-node/node_modules/@types --outDir /mnt/data/work/native-test-build
PASSEUR_NATIVE_BUILD=/mnt/data/work/native-test-build node --test tests/native/*.test.mjs
# Separate package safety checks:
python verification/test_apply.py
```

The owner tests consume transpiled production modules from `.passeur-core/`; that output is not shipped. The package contains a portable syntax-only helper under `verification/` that locates a supplied/local compiler and states its limited proof target. It never replaces production packages with fake SDKs.

## Not executed or not established

The full global TypeScript attempt exits 2 because the complete pinned external packages are unavailable. The container cannot directly retrieve the dependencies and the local baseline reconstruction lacks the unchanged lockfile and some untouched tests/scripts. Full `npm ci`, pinned `npm run check`, complete `npm test`, build/install artifact generation and actual MCP/Zod/Muse SDK consumer verification therefore remain blocked. Authored tests for migration, v3 codecs, complete adapters and genuine MCP paths were not represented as passing.

No installed Codex/Muse CLI inference, live credentials/account, provider billing/provenance verification, actual host attachment, human approval, native sandbox/plugin/tool enforcement, native descendant qualification or installed-artifact dependency closure was exercised. Controlled peer tests cannot satisfy those claims. A fresh authoring-skill session and independent external review were not run.

## Findings and dispositions

The first native run exposed a startup error/pipe-write race (14 passed, 1 failed). The owned spawn-readiness fix passes the final 15-case run. The baseline Muse client-name regression and current queued-deadline ordering were preserved when reconciling older archive tests. Full global typecheck also exposed an environment-map weak-type mismatch, corrected without changing runtime binding semantics. The removed result compactor no longer undercounts full retained commit/check evidence; the new pinned regression remains awaiting dependencies.

No personal configuration, provider installation, live account or GitHub repository was modified. Source is packaged for review/application, not committed or integrated. Temporary Git/process fixtures are owned by the tests; surviving controlled descendants are explicitly handled by their fixture owner. The guarded applier preserves original bytes and records partial publication rather than trying reset/stash/rollback against unrelated work.

## Required next acceptance

Apply the package only after its preflight passes on the actual full baseline checkout; retain the existing lockfile and unchanged pins. Under authorized provisioning run `npm ci`, `npm run check`, `npm test`, `npm run build:runtime` and the affected installed suites. Resolve failures before proceeding. Then execute the existing installed-host procedure plus the registered-agent extension with actual account/permission/process evidence; evaluate the skill in a fresh session and obtain independent review before merge.

Plan status stays Verifying, acceptance blocked. Passing the listed partial checks does not establish a Coding-Standards-compliant release.
