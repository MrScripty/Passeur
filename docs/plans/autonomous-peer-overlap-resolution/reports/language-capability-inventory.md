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
invoking the framework build. The current Linux x86-64 replay used disposable
`/tmp` roots for four native toolchains and pinned frontend packages; every
manifest build and all three exact functional cases per row passed. Without
those provision roots, missing toolchains and packages still have the blocked
outcomes recorded below.

| ID / route | Fixture and source coverage | Local toolchain / exact qualification build | Functional result | Parser / overlap result | Disposition |
| --- | --- | --- | --- | --- | --- |
| L01 Rust `.rs` | `tests/fixture-apps/rust/`; `Cargo.toml`, library, binary, integration tests | `cargo 1.92.0`; `cargo test --offline --quiet --manifest-path Cargo.toml --target-dir .build` | 3/3 exact CLI cases passed | authored Rust body-overlap oracle passed | qualified locally |
| L02 TypeScript `.ts`, `.mts`, `.cts` | `tests/fixture-apps/typescript/`; local `node-shim.d.ts` keeps the copy self-contained | `tsc 5.9.3`; `tsc -p tsconfig.json --outDir .build` | 3/3 exact CLI cases passed | authored TypeScript body/default/signature oracle passed | qualified locally |
| L03 JavaScript `.js`, `.mjs`, `.cjs` | `tests/fixture-apps/javascript/`; CommonJS and ESM routes | `node v24.12.0`; `node --check src/main.js` | 3/3 exact CLI cases passed | authored JavaScript body-overlap oracle passed | qualified locally |
| L04 Python `.py`, `.pyi` | `tests/fixture-apps/python/`; runtime module plus stub route | `Python 3.12.3`; `python3 -m py_compile main.py quote.py display.py` | 3/3 exact CLI cases passed | authored Python body-overlap oracle passed | qualified locally |
| L05 Lua `.lua` | `tests/fixture-apps/lua/`; module, CLI, and test source | official Lua 5.4.9 built in `/tmp`; `lua test.lua` | 3/3 exact CLI cases passed | authored Lua body-overlap oracle passed | qualified locally with isolated native root |
| L06 Kotlin `.kt`, `.kts` | `tests/fixture-apps/kotlin/`; JVM app, test, and script routes | official Kotlin/JVM 2.2.21, host JDK 17; `kotlinc Quote.kt Main.kt -include-runtime -d quote.jar` | 3/3 exact CLI cases passed | authored Kotlin body-overlap oracle passed | qualified locally with isolated native root and read-only JDK configuration |
| L07 Zig `.zig` | `tests/fixture-apps/zig/`; executable and native test source | official Zig 0.13.0; `zig test quote.zig` | 3/3 exact CLI cases passed | authored Zig body-overlap oracle passed | qualified locally with isolated native root |
| L08 C# `.cs` | `tests/fixture-apps/csharp/`; package-free .NET project | `.NET SDK 10.0.111`; offline `dotnet build` in copied root | 3/3 exact CLI cases passed | authored C# body-overlap oracle passed | qualified locally; first delegated .NET probe disclosed a certificate side effect (APR-010) |
| L09 C `.c`, explicit C `.h` | `tests/fixture-apps/c/`; C11 implementation and header override | `gcc 13.3.0`; strict C11 build | 3/3 exact CLI cases passed | authored C body-overlap oracle passed | qualified locally |
| L10 C++ `.cc`, `.cpp`, `.cxx`, `.hpp`, `.hh`, `.hxx`, explicit C++ `.h` | `tests/fixture-apps/cpp/`; C++17 aliases and headers | `g++ 13.3.0`; strict C++17 build | 3/3 exact CLI cases passed | authored C++ body-overlap oracle passed | qualified locally |
| L11 Odin `.odin` | `tests/fixture-apps/odin/`; two-source package and self-test | official Odin dev-2026-09 compiler with Zig 0.13.0 `zig cc` as Clang linker; `odin build . -out:quote-odin` | 3/3 exact CLI cases passed | authored Odin body-overlap oracle passed | qualified locally with isolated native root |
| L12 Svelte 5 `.svelte`, `.svelte.ts`, `.svelte.js` | `tests/fixture-apps/svelte5/`; actual component, reactive module, and Vite entry | Svelte 5.19.8, Vite 6.2.6, plugin 5.0.3, TypeScript 5.9.3 from pinned offline lock; `node scripts/build.mjs` | 3/3 exact CLI cases passed | authored Svelte embedded-script body-overlap oracle passed | qualified locally with isolated npm cache and sandboxed offline `npm ci` |
| L13 React JSX/TSX and JSX-in-`.js` | `tests/fixture-apps/react/`; JSX, TSX, `.js` JSX child, browser entries | React/react-dom 19.0.0, esbuild 0.25.12, TypeScript 5.9.3 from pinned offline lock; `node scripts/build.mjs` | 3/3 exact CLI cases passed | authored React/TSX body-overlap oracle passed | qualified locally with isolated npm cache and sandboxed offline `npm ci` |

Current Linux x86-64 qualification command and results:

```text
node scripts/qualify-fixture-apps.mjs --offline-dependency-root /tmp/passeur-fixture-deps-bE4NSiRH --offline-native-root /tmp/passeur-native-tools-UZZA1H59
status: passed; L01–L13 passed, each with normal, zero, and invalid cases passed; exit 0
node --test --test-isolation=none tests/core/fixture-app-protection.test.mjs
44/44 passed
node --test --test-isolation=none tests/native/fixture-app-oracles.test.mjs
27/27 passed
```

The npm root held copies of the Svelte and React package manifests, empty
user/global npm config files, an isolated home/cache, and integrity lockfiles
matching the committed byte-for-byte pins. The Svelte lock at
`tests/fixture-dependency-locks/svelte5/package-lock.json` has SHA-256
`776a71f80d56788845a0f010deb976e5a45a6933c246ef7f65a2da4fb64de8b4`;
the React lock at `tests/fixture-dependency-locks/react/package-lock.json` has
SHA-256 `979c435121d7532a3a618d1b6bffc843f1c29944e2ce9c0a861cbd8b16cf1994`.
The provision step used npm 11.6.2 and Node 24.12.0 with `HOME`,
`--userconfig`, `--globalconfig`, `--cache`, and `--prefix` all confined to
that `/tmp` root, plus `--ignore-scripts --no-audit --no-fund`. The qualifier
copied the cache and pinned locks into fresh fixture copies and ran
`npm ci --offline --ignore-scripts` inside network-isolated bubblewrap.
Reproduction commands are in `tests/fixture-apps/README.md`.

The native root held checksum-verified official archives and temporary
wrappers dispatching to the actual compilers/interpreter. Archive SHA-256
values were Lua 5.4.9 `2335b6c582a52654f94612bf10d2f4672805d05329aa6568b1d8cd9e5c6fb8e6`,
Zig 0.13.0 `d45312e61ebcc48032b77bc4cf7fd6915c11fa16e4aad116b66c9468211230ea`,
Kotlin 2.2.21 `a623871f1cd9c938946948b70ef9170879f0758043885bbd30c32f024e511714`,
and Odin dev-2026-09 `167c3e1d7056419dad2e04bb3bd98715b7ff286d4c125f3c5a5ee337c6254283`.
Odin's official compiler required Clang for linking; Zig's official `zig cc`
provided it. Kotlin needed the real JDK 17 installation and its
`/etc/java-17-openjdk` security configuration mounted read-only. None of the
archives, caches, outputs, or wrappers were installed globally or committed.

Historical unprovisioned baseline: L01–L04 and L08–L10 passed all functional
cases; L05–L07/L11 were blocked by missing executables (`ENOENT`); L12/L13
were blocked by their manifest-declared exit-127 dependency probes at `svelte`
and `react`, respectively. That qualifier returned `blocked`; no blocked row
was counted as accepted. The then-current parser/oracle and protection suites
passed 68/68 tests. Their checks included all 13 language routes, actual
fixture-source routing, deterministic two-edit overlap, protected-source and
host-socket/PID checks, loopback network denial, separate-session pipe cleanup,
copied-app package resolution, read-only shared package mounts, and resource
accounting. The current qualifier replaces the shared package mount with
copy-local dependencies. RSS peaks between observations remain a limitation
rather than claimed hard terminal evidence. The full exact fixture hash
record is the manifest, not a summary table.

This inventory does not claim compiler-complete symbol graphs, browser
interaction, live provider support, or the required blinded worker matrix.
