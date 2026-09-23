import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type Parser from "tree-sitter";
import { BridgeError } from "../core/errors.js";

/** Fixed development grammar identities. Installed bundles must provide these same pinned artifacts. */
const grammars = Object.freeze({
  rust: { package: "tree-sitter-rust", version: "0.24.0" },
  typescript: { package: "tree-sitter-typescript", export: "typescript", version: "0.23.2" },
  tsx: { package: "tree-sitter-typescript", export: "tsx", version: "0.23.2" },
  javascript: { package: "tree-sitter-javascript", version: "0.25.0" },
  jsx: { package: "tree-sitter-javascript", version: "0.25.0" },
  python: { package: "tree-sitter-python", version: "0.25.0" },
  lua: { package: "@tree-sitter-grammars/tree-sitter-lua", version: "0.4.1" },
  kotlin: { package: "@tree-sitter-grammars/tree-sitter-kotlin", version: "1.1.0" },
  zig: { package: "tree-sitter-zig", version: "6479aa13f32f701c383083d8b28360ebd682fb7d", packageVersion: "1.1.2" },
  csharp: { package: "tree-sitter-c-sharp", version: "0.23.5" },
  c: { package: "tree-sitter-c", version: "0.24.1" },
  cpp: { package: "tree-sitter-cpp", version: "0.23.4" },
  odin: { package: "tree-sitter-odin", version: "1.3.0" },
  svelte5: { package: "@tree-sitter-grammars/tree-sitter-svelte", version: "1.0.2" },
} as const);
export type NativeDialect = keyof typeof grammars;
const require = createRequire(import.meta.url);

export function nativeParserIdentity(dialect: NativeDialect): string {
  const grammar = grammars[dialect];
  if (!grammar) throw new BridgeError("STRUCTURAL_DIALECT_UNSUPPORTED", "The selected native dialect is not packaged");
  return `tree-sitter@0.25.1/${grammar.package}@${grammar.version}${"export" in grammar ? `/${grammar.export}` : ""}`;
}

/** Grammar module loading belongs in the observation helper, never in service startup/discovery. */
export async function loadNativeParser(dialect: NativeDialect): Promise<Readonly<{ parser: Parser; identity: string }>> {
  const grammar = grammars[dialect];
  if (!grammar) throw new BridgeError("STRUCTURAL_DIALECT_UNSUPPORTED", "The selected native dialect is not packaged");
  let module: Record<string, unknown>, ParserClass: typeof Parser;
  try {
    const engineMetadataPath = require.resolve("tree-sitter/package.json");
    const packageRoot = resolve(dirname(engineMetadataPath), "../..");
    const { verifyInstalledNativePackages } = await import("../install/runtime.js");
    await verifyInstalledNativePackages(packageRoot, grammar.package, process.env.PASSEUR_NATIVE_BUILD_ID);
    const engine = JSON.parse(await readFile(engineMetadataPath, "utf8")) as Record<string, unknown>;
    const metadata = JSON.parse(await readFile(require.resolve(`${grammar.package}/package.json`), "utf8")) as Record<string, unknown>;
    if (engine.version !== "0.25.1" || metadata.name !== grammar.package ||
        metadata.version !== ("packageVersion" in grammar ? grammar.packageVersion : grammar.version)) {
      throw new BridgeError("STRUCTURAL_PARSER_IDENTITY_MISMATCH", "Installed native parser package identity differs from the fixed catalog");
    }
    ParserClass = (await import("tree-sitter")).default;
    // Scoped grammars in the later language set use ESM top-level await. One async loading route handles both forms.
    module = await import(pathToFileURL(require.resolve(grammar.package)).href) as Record<string, unknown>;
  } catch (cause) {
    if (cause instanceof BridgeError) throw cause;
    throw new BridgeError("STRUCTURAL_PARSER_UNAVAILABLE", `The ${dialect} grammar could not be loaded`, { cause });
  }
  const entry = (module.default ?? module) as Record<string, unknown>;
  const language = ("export" in grammar ? entry[grammar.export] : entry) as Parser.Language;
  const parser = new ParserClass();
  try { parser.setLanguage(language); }
  catch (cause) { throw new BridgeError("STRUCTURAL_PARSER_UNAVAILABLE", `The ${dialect} grammar is incompatible with the native binding`, { cause }); }
  return Object.freeze({ parser, identity: nativeParserIdentity(dialect) });
}
