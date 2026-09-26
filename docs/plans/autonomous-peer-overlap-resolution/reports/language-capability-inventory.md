# Language and capability inventory — initial baseline

The current parser route advertises and exercises these language/dialect families:

| Family | Required visible routes | Existing source/fixture evidence | Goal qualification |
| --- | --- | --- | --- |
| Rust | `.rs` | `src/observation/language-routing.ts`, `language-common.ts`, `tests/fixtures/structural/languages/rust/` | Pending functioning app and overlap oracle |
| Python | `.py`, `.pyi` route population | `language-python-lua.ts`, `tests/fixtures/structural/languages/python/` | Pending functioning app, `.pyi` fixture, and overlap oracle |
| C / C++ | `.c`, `.h`, `.cc`, `.cpp`, `.cxx`, `.hpp`, `.hh`, `.hxx`, exact dialect overrides | `language-c-family.ts`, C/C++ fixtures | Pending header alias and app qualification |
| C# | `.cs` | C-family route and C# fixtures | Pending functioning app and overlap oracle |
| Kotlin | `.kt`, `.kts` route population | `language-kotlin-zig-odin.ts`, Kotlin fixtures | Pending functioning app, `.kts` fixture, and overlap oracle |
| Zig | `.zig` | Kotlin/Zig/Odin route and fixtures | Pending functioning app and overlap oracle |
| TypeScript | `.ts`, `.cts`, `.mts` | TypeScript fixtures and route | Pending functioning app and overlap oracle |
| TSX | `.tsx` | React/JS/Svelte route and React fixtures | Pending actual component app |
| JavaScript / JSX | `.js`, `.mjs`, `.cjs`, `.jsx`, exact JSX-in-`.js` override | React/JS/Svelte route and fixtures | Pending ordinary-binding limitation and actual component app |
| Lua | `.lua` | Python/Lua route and fixtures | Pending functioning app and overlap oracle |
| Odin | `.odin` | Kotlin/Zig/Odin route and fixtures | Pending functioning app and overlap oracle |
| Svelte 5 | `.svelte`, `.svelte.ts`, `.svelte.js` | React/JS/Svelte route and Svelte fixtures | Pending actual component app and embedded-script qualification |

This inventory deliberately does not claim compiler-complete symbol graphs or
live provider support. Exact toolchain versions, build commands, hashes, and
baseline paths belong in the M4 qualification report once the fixture apps are
created and independently verified.
