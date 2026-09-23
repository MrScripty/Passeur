# Native parser and language qualification

This report owns the required L01–L13 population for SC03–SC05 and its native-artifact contribution to SC14. All rows are **pending final acceptance**. R1/R2 selected exact native binding and grammar pins in the production catalog, including source-local patches for selected modern syntax; [dependency qualification](native-dependency-qualification.md) owns their revisions, provenance and generated hashes. Focused real-parser and production-dispatch fixtures exist for every row. The full final-source and installed public probe has not yet run, so those focused results do not advertise accepted support.

## R0 selected syntax targets (qualification pending)

These are the exact modern *acceptance targets* selected on September 22, 2026, not claims that the current grammars extract them. R1/R2 must test relevant written constructs against independently reviewed examples; an unrepresentable target remains a blocker requiring an upstream grammar change or an explicit maintainer scope decision. The isolated one-sample native load recorded in [dependency qualification](native-dependency-qualification.md) does not close any row.

| Row | Selected syntax target |
|---|---|
| L01 Rust | Rust 2024 edition |
| L02 TypeScript | TypeScript 5.9 syntax, distinct TS route |
| L03 JavaScript | ECMAScript 2025 syntax |
| L04 Python | Python 3.14 syntax |
| L05 Lua | Standard Lua 5.5 syntax |
| L06 Kotlin | Kotlin 2.3 language syntax |
| L07 Zig | Zig 0.15.1 syntax |
| L08 C# | C# 14 syntax |
| L09 C | C23 syntax without preprocessing |
| L10 C++ | C++23 syntax without preprocessing |
| L11 Odin | Odin `dev-2026-09` syntax; no compiler execution |
| L12 Svelte 5 | Svelte 5 component/snippet syntax plus explicit embedded JS/TS routes |
| L13 React | React 19.3 JSX/TSX source syntax through the selected JS/TSX grammars; no React runtime inference |

## 1. Receiving environment and native package contract

Record the selected Linux distribution/kernel, filesystem, architecture, libc, Node executable/version/native compatibility identifiers, npm, C/C++ build toolchain, native Node binding, Tree-sitter engine/grammar language ABI and any grammar generator/scanner dependencies. Begin with the actual repository's pinned application closure. The examined package pins TypeScript 5.9.3 and Node declarations 24.7.2; do not replace them with ambient versions for acceptance. Native runtime compatibility is a different claim from those TypeScript declarations.

The receiving operator authorizes provisioning into an isolated development/build location. Evaluate already-installed dependencies before mutating them. Resolve source identity, integrity, license/notice requirements and native build inputs for every grammar and external scanner. Reconcile all required grammars against one qualified engine/binding, detecting ABI disagreement before extractor implementation expands. A grammar that lacks a usable package may use its pinned upstream generated parser/scanner with reviewed build-time native binding code. Record and maintain that packaging decision; do not create a replacement language parser.

R1 first proves that all required candidates can be built/loaded on the admitted target. It then implements the Rust/TypeScript public reporting path. Build/load smoke establishes viability only; full language support requires the source-to-output cases below. Stop a capability claim when the necessary modern syntax is unrepresentable. An upstream patch or explicit narrowed support decision belongs to the maintainer; silently substituting a different parser technology or dropping a required language is not qualification.

The production bundle contains only qualified runtime artifacts and fixed query/extractor code. No runtime package installation, grammar discovery from a user's working directory, scanner generation, or implicit native compilation. Discovery/status and retained-task functions remain operable when the parser capability is unavailable.

For each grammar, retain: exact source commit/tag-to-commit resolution, package identity and lock integrity if used, source and generated native artifact digests, generator/scanner/build recipe identities, supported target and ABI, license/notice paths, extractor/query revision and test results. The native build inputs belong in the artifact's source hash and SBOM/third-party inventory, including non-npm components. Only claim byte-reproducible native binaries if that precise property was independently demonstrated; otherwise state the narrower recorded-input/artifact-identity guarantee.

## 2. Common extraction and range contract

Use the actual native parser, not authored declaration objects, in language acceptance tests. Expected outputs are independently written from source examples and language documentation, then reviewed separately from the extractor. Upstream parse corpora help test a grammar; they are not the oracle for Passeur's masking, matching or source attribution.

For each row include: unique and duplicate names; named and anonymous/nested declarations; parameter addition/removal/reorder; explicit versus absent type/result annotations; generic/receiver/modifier changes; direct type/member edits; defaults changed without showing their values; a body-only change; imports/exports or other non-declaration changes; add/add and delete cases; malformed/in-progress source; and ambiguous correspondence. Do not hide direct child edits by charging them to every ancestor's body. Conversely, a valid outer declaration must not make an unmapped edited region disappear.

Keep literal syntax in a type expression as syntax. Mask runtime initializer/default expressions and comments embedded in a compact header where they are not required declaration syntax. Include adversarial nested expressions, strings containing delimiters, comments containing declaration-like text, decorators/attributes with arguments, and multiline defaults. Preserve a default/initializer-change marker when the concealed expression changes. A hashing or normalization shortcut must not expose the original value through a supposedly compact report.

Qualify UTF-8 bytes ↔ native binding indices/columns ↔ display positions independently, using non-ASCII text before and inside the relevant construct. Cover BOM, CRLF, combining characters, emoji/non-BMP codepoints, escaped strings and a multibyte character at a page boundary. The source bytes remain unchanged. Public ranges are half-open byte intervals; a displayed signature may be masked and therefore is not a source-offset coordinate system.

Scope parse coverage to the changed declaration/region. Distinguish errors in the header, errors in an otherwise unrelated body, missing terminal tokens and wholly unsupported syntax. Incomplete source is not absence, and matching against a previous valid extraction must not impersonate a current parse.

## 3. Required language rows

Fixtures live under `tests/fixtures/structural/languages/<stem>/`. Each row has independently authored input, changed and incomplete sources plus a `cases.json` description and reviewed `expected.json`. Use actual source extensions and separate fixture files where embedding or module distinctions require them. Samples are parsed as text, never executed by observation.

| ID / stem | File routing and minimum distinguishing cases | Candidate grammar source |
|---|---|---|
| **L01 rust** | `.rs`; free/trait/impl functions, receivers, lifetimes, visibility, async/unsafe/extern, generic/where syntax, explicit returns, structs/enums/aliases. Include the selected modern edition, including relevant 2024-edition syntax. Distinct impl scopes and macro token regions; no expansion. | `tree-sitter/tree-sitter-rust` |
| **L02 typescript** | `.ts`, `.mts`, `.cts`; methods/functions/named arrows, overloads, optional/rest/destructured parameters, generics, written results, interfaces/aliases, imports/exports. Named-type edits stay separate from unchanged uses. | `tree-sitter/tree-sitter-typescript` — TypeScript dialect |
| **L03 javascript** | `.js`, `.mjs`, `.cjs`; generators/async, function assignments, ordered/defaulted/rest/destructured parameters, classes and imports/exports. Unannotated results remain not-declared; JSDoc is not resolved type authority. | `tree-sitter/tree-sitter-javascript` |
| **L04 python** | `.py`, `.pyi`; indentation/scopes, methods/classes, async/decorators, positional-only/keyword-only markers, varargs and explicit annotation/type-parameter syntax of the admitted modern version. Decorators and annotations are not executed. | `tree-sitter/tree-sitter-python` |
| **L05 lua** | `.lua`; local/global functions, named assignments, colon/dot method syntax, nesting, varargs and table/body edits. Standard Lua has no ordinary written result/parameter type declarations; do not silently route to a different dialect. | `tree-sitter-grammars/tree-sitter-lua` |
| **L06 kotlin** | `.kt`, `.kts`; receivers, functions/constructors, properties/accessors, annotations, type parameters, modifiers and explicit results. Include selected modern constructor/context forms required by consumers; inferred results stay not-declared. | `tree-sitter-grammars/tree-sitter-kotlin`; compare `fwcd/tree-sitter-kotlin` only if the first candidate cannot meet the admitted contract |
| **L07 zig** | `.zig`; functions/containers, comptime/noalias syntax, error unions, pointer/array/function types and named bindings. Preserve `anytype` as written. No comptime execution or type resolution. | `tree-sitter-grammars/tree-sitter-zig` |
| **L08 csharp** | `.cs`; classes/records/partial declarations, methods/constructors/properties, generics/constraints, ref/out/in/params and explicit results. Repeated members in partial declarations remain source observations, not a merged semantic type. | `tree-sitter/tree-sitter-c-sharp` |
| **L09 c** | `.c`; `.h` with declared dialect. Function declarations/definitions and complex declarators, function pointers, typedef/struct/union/enum, selected modern attributes and preprocessor alternatives. No preprocessing. | `tree-sitter/tree-sitter-c` |
| **L10 cpp** | `.cc`, `.cpp`, `.cxx`, `.hpp`, `.hh`, `.hxx`; `.h` with declared dialect. Namespaces/classes, constructors/destructors/operators, overloads, trailing returns, templates/requires, attributes and modern declared constructs. `auto`/`decltype` stay written syntax; no instantiation. | `tree-sitter/tree-sitter-cpp` |
| **L11 odin** | `.odin`; procedures, named/multiple results, procedure groups, parameter modifiers/defaults, polymorphic syntax, records/unions/enums and named bindings. Prove result-list extraction, not just recognition of a proc node. | `tree-sitter-grammars/tree-sitter-odin` |
| **L12 svelte5** | `.svelte`, `.svelte.js`, `.svelte.ts`; component scripts/module context, JS/TS selection, runes as expressions, named snippets/parameters, render and template-only edits, style-region changes. Explicit props syntax only; no inference from a named props type. | `tree-sitter-grammars/tree-sitter-svelte` plus its independently qualified embedded JS/TS dependencies |
| **L13 react** | `.jsx`, `.tsx`, explicitly configured JSX-bearing `.js`; JS/JSX and TS/TSX grammar routes, component functions, destructured/explicit props annotations, imports and JSX-only body changes. No inference through hooks, wrappers or higher-order components. | JavaScript grammar and `tree-sitter/tree-sitter-typescript` TSX dialect |

Each candidate path denotes `https://github.com/<path>`. Repository availability and support must be checked at R1; none is an instruction to consume a moving default branch in production. Choose exact language edition/version/features during admission, not a vague claim to every version newer than January 2025. Legacy syntax accepted by the same implementation needs no separate mechanism.

Ambiguous `.h` and JSX-bearing `.js` use explicit declarative routing or return a routing limitation. Trying parsers until one emits fewer errors does not establish authoritative dialect. Overrides cannot select executable module paths. Configurations have an owner, version and cache invalidation identity.

## 4. Svelte and embedded syntax

Treat component scripts, snippet headers and template expressions as explicitly mapped source regions. The Svelte parse may expose raw text rather than detailed embedded parameters; that is not sufficient extraction evidence. Qualify the actual selected grammar's node shapes. Parse appropriate embedded content with the selected native JS/TS grammar. If a contextual wrapper is required, represent its synthetic spans separately and prove that no output range, name or text originates from those spans.

Include components with both module and instance scripts; TS script selection; comments and multibyte characters before the script; multiple snippets with repeated names in different scopes; snippet default/destructuring syntax supported by the admitted Svelte version; render edits; template-only changes; malformed closing tags and braces; and a style-only edit. `.svelte.js`/`.svelte.ts` route to their actual script grammar without inventing a component template. JSX/TSX use the correct separate dialect, not Svelte parsing.

The Svelte and React primary documentation is linked in the source register. It specifies syntax examples, not Passeur extractor correctness.

## 5. Artifact and performance proof

All language fixtures also run through the installed helper from a package outside the source checkout. Clear development module search paths and make a disposable source copy unavailable; do not move a user's checkout. Exercise native loading with networking and build tools unavailable. Missing/wrong-architecture/wrong-ABI artifacts yield a parser-capability diagnostic while legacy discovery, task controls and retained results remain functional.

Measure cold grammar loading, changed-file extraction, cache reuse and cumulative RSS for the full set. A V8-only measurement excludes native tree/scanner memory. Use one active slot first and bound source, AST/output, IPC and cache resources. The existing source ceiling is eight MiB; reconcile that ceiling with the helper's complete encoded-message/allocation bounds rather than assuming the public IPC limit is adequate for raw source. Broad performance acceptance follows the separate workload contract, not tiny syntax fixtures.
