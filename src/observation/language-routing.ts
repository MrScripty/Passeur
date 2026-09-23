import type { NativeDialect } from "./native-parser.js";

/** Fixed source suffixes are data only; ambiguous `.h` needs an explicit dialect owner. */
const suffixes: readonly Readonly<{ suffix: string; dialect?: NativeDialect }>[] = Object.freeze([
  { suffix: ".svelte", dialect: "svelte5" },
  { suffix: ".svelte.ts", dialect: "typescript" },
  { suffix: ".svelte.js", dialect: "javascript" },
  { suffix: ".tsx", dialect: "tsx" },
  { suffix: ".mts", dialect: "typescript" },
  { suffix: ".cts", dialect: "typescript" },
  { suffix: ".jsx", dialect: "jsx" },
  { suffix: ".mjs", dialect: "javascript" },
  { suffix: ".cjs", dialect: "javascript" },
  { suffix: ".pyi", dialect: "python" },
  { suffix: ".kts", dialect: "kotlin" },
  { suffix: ".cpp", dialect: "cpp" },
  { suffix: ".cxx", dialect: "cpp" },
  { suffix: ".hpp", dialect: "cpp" },
  { suffix: ".hxx", dialect: "cpp" },
  { suffix: ".odin", dialect: "odin" },
  { suffix: ".rs", dialect: "rust" },
  { suffix: ".ts", dialect: "typescript" },
  { suffix: ".js", dialect: "javascript" },
  { suffix: ".py", dialect: "python" },
  { suffix: ".lua", dialect: "lua" },
  { suffix: ".kt", dialect: "kotlin" },
  { suffix: ".zig", dialect: "zig" },
  { suffix: ".cs", dialect: "csharp" },
  { suffix: ".cc", dialect: "cpp" },
  { suffix: ".hh", dialect: "cpp" },
  { suffix: ".h" },
  { suffix: ".c", dialect: "c" },
]);

function route(path: string): Readonly<{ suffix: string; dialect?: NativeDialect }> | undefined {
  return suffixes.find(entry => path.endsWith(entry.suffix));
}

export function isStructuralSourcePath(path: string): boolean { return route(path) !== undefined; }
export function sourceDialectForPath(path: string, override?: NativeDialect): NativeDialect | undefined {
  if (override !== undefined) {
    if (path.endsWith(".js") && !path.endsWith(".svelte.js") && override === "jsx") return override;
    if (path.endsWith(".h") && (override === "c" || override === "cpp")) return override;
    return undefined;
  }
  return route(path)?.dialect;
}
