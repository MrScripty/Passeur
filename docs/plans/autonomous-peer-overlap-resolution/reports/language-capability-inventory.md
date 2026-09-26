# Language and capability inventory — M4-S1 qualification

The M4 fixture population is enumerated by `tests/fixture-apps/manifest.json`.
That manifest records a SHA-256 digest for every file in each protected
fixture root. `node scripts/qualify-fixture-apps.mjs` copies each root to a
temporary directory, builds and runs the exact local commands inside a
bubblewrap boundary (`--unshare-net`, private temporary root, PID/IPC
namespaces, selected read-only runtime mounts, and copy-local writes), and
verifies the application and oracle trees are unchanged. The
independent parser and overlap expectations are in
`tests/oracles/fixture-apps/` and are exercised by
`tests/native/fixture-app-oracles.test.mjs`. Component build probes validate
the names and exact versions of their checked runtime/build packages before
invoking the framework build; missing packages remain explicit exit-127
evidence.

| ID / route | Fixture and source coverage | Local toolchain / exact qualification build | Functional result | Parser / overlap result | Disposition |
| --- | --- | --- | --- | --- | --- |
| L01 Rust `.rs` | `tests/fixture-apps/rust/`; `Cargo.toml`, library, binary, integration tests | `cargo 1.92.0`; `cargo test --offline --quiet --manifest-path Cargo.toml --target-dir .build` | 3/3 exact CLI cases passed | authored Rust body-overlap oracle passed | qualified locally |
| L02 TypeScript `.ts`, `.mts`, `.cts` | `tests/fixture-apps/typescript/`; local `node-shim.d.ts` keeps the copy self-contained | `tsc 5.9.3`; `tsc -p tsconfig.json --outDir .build` | 3/3 exact CLI cases passed | authored TypeScript body/default/signature oracle passed | qualified locally |
| L03 JavaScript `.js`, `.mjs`, `.cjs` | `tests/fixture-apps/javascript/`; CommonJS and ESM routes | `node v24.12.0`; `node --check src/main.js` | 3/3 exact CLI cases passed | authored JavaScript body-overlap oracle passed | qualified locally |
| L04 Python `.py`, `.pyi` | `tests/fixture-apps/python/`; runtime module plus stub route | `Python 3.12.3`; `python3 -m py_compile main.py quote.py display.py` | 3/3 exact CLI cases passed | authored Python body-overlap oracle passed | qualified locally |
| L05 Lua `.lua` | `tests/fixture-apps/lua/`; module, CLI, and test source | manifest build `lua test.lua`; `lua` executable unavailable (`ENOENT`) | not run | authored Lua body-overlap oracle passed | blocked: Lua toolchain unavailable |
| L06 Kotlin `.kt`, `.kts` | `tests/fixture-apps/kotlin/`; JVM app, test, and script routes | manifest build `kotlinc Quote.kt Main.kt -include-runtime -d quote.jar`; `kotlinc` unavailable (`ENOENT`) | not run | authored Kotlin body-overlap oracle passed | blocked: Kotlin compiler unavailable |
| L07 Zig `.zig` | `tests/fixture-apps/zig/`; executable and native test source | manifest build `zig test quote.zig`; `zig` executable unavailable (`ENOENT`) | not run | authored Zig body-overlap oracle passed | blocked: Zig toolchain unavailable |
| L08 C# `.cs` | `tests/fixture-apps/csharp/`; package-free .NET project | `.NET SDK 10.0.111`; offline `dotnet build` in copied root | 3/3 exact CLI cases passed | authored C# body-overlap oracle passed | qualified locally; first delegated .NET probe disclosed a certificate side effect (APR-010) |
| L09 C `.c`, explicit C `.h` | `tests/fixture-apps/c/`; C11 implementation and header override | `gcc 13.3.0`; strict C11 build | 3/3 exact CLI cases passed | authored C body-overlap oracle passed | qualified locally |
| L10 C++ `.cc`, `.cpp`, `.cxx`, `.hpp`, `.hh`, `.hxx`, explicit C++ `.h` | `tests/fixture-apps/cpp/`; C++17 aliases and headers | `g++ 13.3.0`; strict C++17 build | 3/3 exact CLI cases passed | authored C++ body-overlap oracle passed | qualified locally |
| L11 Odin `.odin` | `tests/fixture-apps/odin/`; two-source package and self-test | manifest build `odin build . -out:quote-odin`; `odin` executable unavailable (`ENOENT`) | not run | authored Odin body-overlap oracle passed | blocked: Odin toolchain unavailable |
| L12 Svelte 5 `.svelte`, `.svelte.ts`, `.svelte.js` | `tests/fixture-apps/svelte5/`; actual component, reactive module, and Vite entry | exact offline Node dependency probe exited 127 at the first required package, `svelte`; no package installation or network access was attempted | not run | authored Svelte embedded-script body-overlap oracle passed | blocked: declared dependency set unavailable; no packages installed |
| L13 React JSX/TSX and JSX-in-`.js` | `tests/fixture-apps/react/`; JSX, TSX, `.js` JSX child, browser entries | exact offline Node dependency probe exited 127 at the first required package, `react`; host `esbuild` metadata is present at 0.25.12 but React was absent and the remaining package checks were not reached | not run | authored React/TSX body-overlap oracle passed | blocked: declared dependency set unavailable; no packages installed |

Qualification summary: L01–L04 and L08–L10 passed all functional cases;
L05–L07 and L11 were blocked by missing executables; L12–L13 were blocked by
their manifest-declared dependency probes. The qualifier returned `blocked`
because blocked rows remain unresolved; no blocked row is counted as accepted.
The parser/oracle and protection suites passed 68/68 tests, including all 13
language routes, actual fixture-source routing, deterministic two-edit overlap
checks, protected-source and host-socket/PID checks, loopback network denial,
separate-session pipe cleanup, copied-app package resolution, writable
copy-local Vite cache with read-only installed packages, invocation-safe
terminal waited-child CPU accounting, aggregate sampled RSS enforcement, and
short-lived reaped-child/root-process CPU regressions. RSS peaks between
observations are retained as a limitation rather than claimed as hard terminal
evidence. The full exact hash record is the manifest, not a summary table.

This inventory does not claim compiler-complete symbol graphs, browser
interaction, live provider support, or the required blinded worker matrix.
