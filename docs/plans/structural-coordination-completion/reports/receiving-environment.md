# R0-S1 receiving environment — September 22, 2026

## Material and authority

- Explicit invocation: `docs/plans/structural-coordination-completion/plan.md`, operation `start`. This implementation session is the serial repository lead. Product/acceptance authority remains with the maintainer.
- Checkout: `main` at `2de20c756a375c726311767cd78b968c1161fdad`, the examined committed F9 revision. `git worktree list --porcelain` found one worktree for this checkout. Tracked source had no local modifications before R0. The untracked completion-plan directory and `docs/plans/Passeur_Concurrent_Change_Coordination_Plan.md` preceded this implementation; the latter is preserved untouched.
- Standards: local `MrScripty/Coding-Standards` HEAD `366c1d90a24bbfb50973f62b155a5f3396c0f107`, matching the adopted revision. Core, Router, Planning, Implementation, Verification, Development Proportionality and Documentation were read for R0. Route additional canonical modules and their Requires when the affected source boundary is admitted.
- The committed F0–F9 implementation, F9 native-coverage fixture correction, historical evidence and existing selected-result retirement guard remain in place. The old plan was marked Superseded only for its remaining Plan 2A authority. Plan 2B was neither selected nor edited.

## Actual receiving machine

| Fact | Observation |
|---|---|
| OS/filesystem | Linux x86_64; checkout on local ext4, mounted read/write, nosuid,nodev |
| libc | Ubuntu glibc 2.39 (`ldd` 2.39) |
| Node | v24.12.0, module ABI 137, N-API 10, linux/x64 |
| npm | 11.6.2 |
| Toolchain present | `make`, `gcc`, `g++`, `python3`, `pkg-config`, `git`, `node-gyp` |
| Repository npm closure | `node_modules` present; `npm ls --depth=0 --offline` resolves all direct package pins in `package.json`/`package-lock.json`, including TypeScript 5.9.3 and `@types/node` 24.7.2 |
| Native parser closure | `npm ls tree-sitter tree-sitter-rust tree-sitter-typescript --all --offline` is empty; no Tree-sitter `.node` module was found in `node_modules` |
| Named Passeur frontends | Read-only status found `pumas` and `tuldok` frontends bound to other repository identities. Their service state was `not_checked`; this proves neither a Passeur-checkout host registration nor live-account acceptance access. No service was prepared or task submitted. |

The selected R0 test/build authority covers existing commands. The first `npm test` attempt could not bind local Unix sockets in the default sandbox (`listen EPERM` under `/tmp/passeur-session-*/auth.sock`); an approved elevated test invocation completed successfully. This is an execution-environment boundary, not a source change. The [baseline record](baseline-checks.md) preserves both attempts.

Read-only upstream preflight identifies official [`tree-sitter` 0.25.1 on npm](https://www.npmjs.com/package/tree-sitter?activeTab=versions) as a candidate native Node binding; the [official Node binding](https://github.com/tree-sitter/node-tree-sitter) uses grammar packages and a native addon. The [TypeScript grammar](https://github.com/tree-sitter/tree-sitter-typescript) provides distinct TypeScript and TSX dialects. These are candidate identities, not selected lock pins or evidence that Node 24 and every required grammar build/load together. R1 must prove that contract on this machine before support is advertised.

## R0 decisions and remaining proof

1. **Native provisioning:** the user explicitly authorized pinned repository native dependencies, lockfile changes and their install/build scripts. At intake, the lock did not contain the parser binding or grammars. Exact pins, license inspection, isolated build/load probes and the subsequent restored-lock fresh install are recorded in [native dependency qualification](native-dependency-qualification.md). The native packages are now declared in the repository; installed parser artifacts remain unfinished. Personal configuration was not changed by this intake.
2. **Actual language targets:** exact intended syntax versions are selected for all L01–L13 in [the language report](native-language-qualification.md). The selected repository lock and production subset passed isolated install/load checks. Full extraction, modern feature support and installed artifacts remain R1/R2/R5 gates. Candidate URLs and TypeScript compilation do not establish language support.
3. **Real host and review:** the user authorized use of existing named-host registrations and live accounts for SC15 and selected an Astra high subagent for independent review of the final native/public/installed candidate. No Passeur-checkout registration, three-worker native run or final-candidate review has yet occurred. Read-only frontend status for other repositories does not close SC15 or SC17.
4. **SC16 resource design:** the maintainer specified bounded observation, controlled overload, available task controls and preserved coding-worker ownership without fixed CPU, memory, latency or context targets. The implementation lead owns engineering limits, defaults, configuration and verification. Record chosen limits and representative measurements as evidence; no maintainer approval of numeric budgets is a gate.

R0 intake is complete for R1 source work. Final-candidate review and SC16 engineering measurements remain R6 evidence. No production parser or public capability is advertised by this intake.
