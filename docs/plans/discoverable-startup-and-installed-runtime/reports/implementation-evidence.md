# Implementation evidence — source candidate

## Result and delivery boundary

The archive contains authored production replacements/new modules, focused/integration test sources, documentation and exact baseline-checked edits for existing owners. It applies to the inspected Passeur source without changing Git refs, personal configuration or dependencies. It can export a full updated tracked-source ZIP from an existing checkout. It does not contain a full fetched repository, `node_modules`, an installed runtime or fabricated vendor implementations.

No code in the GitHub repository or on the user's machine was changed by preparation of this archive. A normal implementation branch/commit should be selected by the integration owner under repository policy when applying. The archive helper itself does not create branches or commits.

## Executed evidence

| Check | Result | Scope / limitations |
| --- | --- | --- |
| Production runtime/lease/error lifecycle checks | 21 passed | Actual authored production logic, with injected lock/persistence boundaries and the hash-verified original async helper. Proves those modeled lifecycle cases only, not real proper-lockfile, Zod, MCP or Muse conformance. |
| Source-update installer/export tests | 8 passed | Real disposable Git/files/ZIP operations on synthetic repository fixtures: baseline refusal, staged overlap, symlinks/traversal, export, backup, rollback and unrelated-file preservation. Not full application against a fetched Passeur checkout. |
| TypeScript parser/transpiler checks | Passed | Global TypeScript 5.8.3 syntax diagnostics, not pinned TypeScript 5.9.3 semantic/module-resolution checking. See final runner output for file count. |
| Actual Bash launcher adapter tests | 5 passed | Argument boundaries, explicit actions, missing-runtime refusal and child exit propagation with a test-only Node stand-in. Not application execution. |
| Shell/Python syntax checks | Passed | Bash launcher and distribution helper syntax. Not actual installed application execution. |

The actual tool environment was Linux with Node 22.16.0, npm 10.9.2 and Git 2.47.3. Raw focused evidence and repeatable runners are in the distribution archive's `verification/` directory. Test substitutes exist only in tests/verification, not production fallbacks.

## Not executed / blocking

`npm ci`, the full pinned `npm run check`, `npm test`, `npm run build`, actual Zod/TOML decoding, real MCP stdio tests, actual complete runtime build/install, and real Codex/Muse/account or Pumas/Tuldok workflows were not run. Required package/network and host/account access were unavailable. New test files are test implementations, not passing evidence. No source-only or controlled test result satisfies A1–A10 in full.

The manifest and source transforms were inspected against retrieved file contracts. Complete source-graph and pinned vendor type compatibility still require the full checkout checks. The helper validates actual original bytes before any transformation or publication; a different input is a refusal, not a best-effort patch.

## Implementation decisions and changes

One repository runtime owns binding, preparation, the valid lease, lazy execution composition and shutdown. Status reads do not acquire authority. History and administration have no inference-profile prerequisite. The runtime preserves unresolved process outcomes and blocks mutations after detected loss of authority; already-dispatched OS effects cannot be fenced by an advisory callback.

Store codecs validate selected known persisted record variants. Recovery preflights records before quarantine so an operational or unsupported-version failure cannot be treated as corruption. Missing/unsupported/corrupt/permission outcomes remain separate. Supported historical data is retained; compatibility tests must be run with pinned dependencies.

Runtime candidates contain compiled application code and its exact production dependency closure. Node remains external. Build identity records source and lock identities and relevant tool versions. Installation changes an explicit candidate into a separate installed marker and never overwrites a published build. This is installer immutability, not tamper resistance or a byte-reproducibility claim.

TOML selection: `smol-toml` 1.6.1, BSD-3-Clause, Node >=18, ESM/CJS/types, no declared runtime dependencies. Its official versioned manifest/API were inspected. This avoids extending the previous handwritten grammar parser. The lock entry pins the npm tarball and SRI; resolver/SRI execution is blocked, not asserted. The earlier considered @iarna/toml package is not added.

Normal managed updates preserve outside bytes; explicit unmarked adoption preserves supported TOML values but can reformat/remove comments. Configuration verification compares the resolved stdio shape emitted by Codex, rather than merely checking command exit. Current official Codex source was inspected for this representation; installed older/newer variants not supporting it must fail explicitly. It does not establish user host attachment.

Direct MCP probes preserve configured executable/arguments/cwd/environment overrides but have a declared controlled inherited environment. Actual host launch context/permissions are separately required-real evidence. Probes never invoke inference without the separate operator procedure.

Configuration uses the selected parser's `integersAsBigInt: "asNeeded"` mode so unrelated large TOML integers are not silently rounded. This API was checked against the versioned upstream source; actual dependency-backed roundtrip tests still must run.

## Remaining integration procedure

Apply/export the source update against its inspected inputs. Inspect the full diff and dependency change. Provision with explicit authority and run pinned typecheck/full tests/build. Resolve failures within their owner without weakening assertions or changing state namespaces. Only then build/install the real candidate and execute the actual-host acceptance procedure with authorized accounts. Record exact resource dispositions and evidence links. Keep the plan Verifying until all required claims pass.
