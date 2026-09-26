# Passeur: compact symbol representation follow-on

## Current authority

| Field | Value |
| --- | --- |
| Plan status | **Accepted** |
| Operation | **verify** |
| Adopted standards revision | `366c1d90a24bbfb50973f62b155a5f3396c0f107` |
| Scope | Native multilingual declaration extraction, single-state inspection, comparison rendering, and the existing authenticated public consumer |
| Canonical path | `docs/plans/compact-symbol-representation/plan.md` |
| Integration owner | This session; shared lifecycle and coordination plans remain read-only |
| Source of objective | `/home/jeremy/.codex/attachments/08354ac7-1b10-4179-8503-bdbe175f804f/pasted-text-1.txt` |

This is a bounded follow-on to the accepted structural-reporting work. It does
not reopen or alter the shared-service lifecycle authority, Whip-Docs files,
runtime ownership, source authorization, task controls, parser packaging, or
the concurrent coordination plan owned by another session.

## Objective and concrete gap

Preserve the existing Tree-sitter, declaration model, comparison, report, and
authenticated Passeur consumer boundaries while making ordinary TypeScript and
TSX variable/constant declarations visible and adding a distinct single-state
inspection view. Initializer values remain concealed, explicit written type
annotations remain visible, and inspection, comparison, additions/removals,
body-only changes, ambiguity, and incomplete coverage retain distinct meanings.

The current gap is executable: `src/observation/native-extraction.ts:211-220`
only emits lexical bindings whose values are arrow/function expressions and
marks ordinary bindings as `unmapped_top_level_syntax`; the focused regression
at `tests/native/structural-native-functions.test.mjs:56-60` codifies that
absence. The accepted completion claim for all language rows is therefore
insufficient evidence for this newly requested ordinary-variable requirement.

## Admitted write set

- `src/observation/native-extraction.ts` — TypeScript/TSX lexical declaration
  extraction and the shared native dispatch boundary.
- `src/observation/language-python-lua.ts` — explicit incomplete coverage for
  omitted Python function-local bindings.
- `src/observation/language-kotlin-zig-odin.ts` and
  `src/observation/language-c-family.ts` — explicit incomplete coverage for
  omitted local bindings in the qualified native families.
- `tests/native/structural-native-functions.test.mjs` — independently authored
  native source-to-output and comparison regressions for ordinary declarations.
- `tests/native/structural-python-lua.test.mjs` — Python local-binding coverage
  regression.
- `src/observation/comparison.ts`, `src/observation/report.ts` — shared
  single-state extraction composition and bounded compact renderer.
- `tests/core/structural-primitives.test.mjs` — renderer/inspection contract
  regressions.
- `src/contracts/service.ts`, `src/core/repository-runtime.ts`,
  `src/service/server.ts`, `src/mcp/server.ts`, `src/cli.ts` — existing
  structural-report consumer extension with an explicit comparison/input/
  observed view; no new source-access authority.
- `tests/core/structural-public.test.mjs`,
  `tests/core/structural-report-selection.test.mjs`,
  `tests/integration/structural-cli-mcp.test.ts` — intended Passeur consumer
  evidence.
- `docs/structural-reporting.md` — explicit local/nested coverage and limitation
  statement for the compact representation.
- `docs/plans/compact-symbol-representation/plan.md` — this plan and status.
- `docs/plans/compact-symbol-representation/reports/inventory.md` — feature
  inventory and acceptance evidence.

No other session may edit these paths for this slice. The lifecycle
plan/ledger/issues/report files, concurrent lifecycle working changes, and the
untracked concurrent-coordination plan remain outside this write set and must
be preserved.

## Contract and coverage decisions

The TypeScript/TSX route represents top-level lexical declarators, including
multiple declarators, identifier and destructuring bindings, explicit type
annotations, and initializer-change markers. Named arrow/function bindings
continue to use function declarations with parameters/results and concealed
bodies. Direct nested function/type declarations retain their existing
containment behavior. Local ordinary variable declarations inside function
bodies are not silently invented as declarations in this slice; if their
syntax is encountered outside the admitted top-level/direct nested categories,
the extraction remains `incomplete` with an explicit limitation. No inferred
type, result, semantic dependency, or initializer text is emitted.

The existing public path remains the intended consumer:
`RepositoryRuntime.structuralReport` resolves authorized source, invokes the
native helper, compares input/observed pairs, and renders bounded text. Its
backward-compatible `view` selector is `comparison` (default), `input`, or
`observed`; comparison shows represented differences while inspection shows
every extracted declaration, including unchanged declarations, through the same
source and authorization boundary. No new source-access path is admitted.

The multilingual contract is inherited from the qualified native route and is
explicitly bounded here as follows:

| Language route | Functions/methods | Containers and members | Top-level or direct named bindings | Local/nested disposition |
| --- | --- | --- | --- | --- |
| Rust | functions, methods and foreign declarations | structs, traits, impls, modules, enums, aliases, fields and variants | `const`/`static` items are not represented; the route reports unsupported top-level syntax as incomplete | recognized local `let`/`const`/loop/match/closure forms are not inventoried and report `nested_declaration_coverage_unavailable`; direct nested functions/types are retained and macro expansion is not performed |
| TypeScript/TSX | functions, methods, generators and named arrows | classes, interfaces, enums, namespaces/modules, fields and properties | top-level `const`/`let`/`var`, identifier/object/array bindings and function-valued declarators | direct nested declarations retain scope; ordinary function-local and loop-local bindings, plus declaration-like initializer/default nesting, are explicit incomplete limits |
| JavaScript/JSX, React, Svelte 5 | functions, generators, methods, components/snippets and supported embedded scripts | classes, fields/properties and qualified Svelte component regions | function-valued assignments are represented; ordinary top-level bindings are not, except the selected Svelte `$props`/export forms | direct member/function children are selected; ordinary local or nested bindings are not a complete inventory and unsupported direct cases report incomplete coverage; no runtime/framework inference |
| Python | functions, async functions and methods | classes, direct class assignments, type aliases and supported annotations | top-level assignments and direct class bindings | direct nested functions/classes are retained; conditional/deeper nested declarations and function-local assignments, imports, loops, matches and comprehensions are omitted and report explicit limits; no execution or inference |
| Lua | functions, methods and nested functions | table assignment is retained as a binding; colon/dot method syntax is written through | local/global named assignments | direct nested functions and variable declarations are selected; deeper arbitrary locals/table members are not expanded; no written type/result inference |
| Kotlin | functions, methods and constructors | classes/objects, type aliases, properties and direct members | selected top-level properties | direct container members are selected; nested local declarations are outside the inventory and nested declaration syntax reports an explicit limit; no compiler/type evaluation |
| Zig | functions and methods/receivers | containers, enums/unions and direct fields | selected top-level variable declarations/constants | direct container members are selected; function-local declarations are not inventoried and remain a selected-syntax limitation, with no compiler/type evaluation |
| Odin | procedures and receiver procedures | structs, enums/unions and direct fields/variants | selected top-level constants and named bindings | direct container members are selected; function-local declarations are not inventoried and remain a selected-syntax limitation, with no compiler/type evaluation |
| C | functions and function declarators | structs/unions/enums, namespaces where grammar supplies them, and direct fields | supported top-level declarations and aliases | direct container members are selected; function-local declarations are not recursively inventoried; preprocessing and macro alternatives are not expanded or semantically merged |
| C++ | functions, methods, constructors/destructors and operators | structs/classes, namespaces, enums and direct fields | supported declarations and aliases | direct container members are selected; function-local declarations are not recursively inventoried; preprocessing, templates and instantiation are not semantically expanded |
| C# | methods, constructors, operators and accessors | classes/records/interfaces/enums, namespaces, fields and properties | supported fields/properties and declarations | direct container members are selected; function-local declarations are not recursively inventoried and partial declarations are not semantically merged |

The inherited population and grammar evidence is [native-language-qualification.md](../structural-coordination-completion/reports/native-language-qualification.md)
and its language-specific native tests. S1 adds the missing ordinary
TypeScript/TSX lexical coverage and the single-state inspection projection; it
does not replace those routes with a new parser or claim unsupported syntax as
complete.

## Acceptance claims

1. Real TypeScript and TSX grammars produce ordinary declarations,
   names, scopes, ranges, explicit types, and concealed initializers.
2. Single-state inspection includes unchanged declarations and explicitly
   reports body/default omission and extraction limitations.
3. A changed initializer is distinguished from a changed written declaration;
   additions/removals and unchanged declarations are preserved by the existing
   comparison logic.
4. The authenticated structural report consumer exposes comparison and
   input/observed inspection views without leaking initializer values or
   changing source authorization/detail behavior.
5. Unsupported or incomplete local/nested syntax is explicit where the route
   reports a limitation; selected-syntax `complete` status is not a claim of
   a compiler-complete local symbol graph. The S1 TypeScript/TSX and Python
   paths report their newly qualified local/nested gaps directly.

Focused native and public tests are the blocking evidence. `npm run check`,
`npm run test:native`, the affected core/public test, and `git diff --check`
are supporting gates. Final review is read-only and must inspect the exact
candidate diff; the final inventory records commands and limitations.

## Slice state

| Slice | State | Exit gate |
| --- | --- | --- |
| S1 compact extraction and inspection | **Accepted** | Native/core/public/CLI checks, refreshed build, documentation/inventory update, Sol xhigh repair review, Astra high final review, and Luna max orchestration audit completed |
