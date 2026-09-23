import { createHash } from "node:crypto";
import type Parser from "tree-sitter";
import { BridgeError } from "../core/errors.js";
import type { Declaration, Extraction, SourceFile } from "./model.js";
import type { NativeDialect } from "./native-parser.js";
import { Utf8SourceRanges } from "./ranges.js";
import { sourceReference } from "./source.js";

export type PresentSourceFile = Extract<SourceFile, { status: "present" }>;

/** Stable boundary for independently implemented native language families.
 *
 * A family sees only the exact captured source and its already parsed tree. It returns
 * direct declarations and explicit coverage limitations. It must bound its own walk
 * and output, mask initializer/default values, and use `ranges` for every byte range.
 * `finishFamilyExtraction` owns common parser-error and remainder evidence.
 */
export type NativeFamilyContext = Readonly<{
  file: PresentSourceFile;
  dialect: NativeDialect;
  root: Parser.SyntaxNode;
  ranges: Utf8SourceRanges;
  parserIdentity: string;
}>;
export type NativeFamilyResult = Readonly<{
  declarations: readonly Declaration[];
  limitations: readonly string[];
}>;
export type NativeFamilyExtractor = (context: NativeFamilyContext) => NativeFamilyResult | Promise<NativeFamilyResult>;

export function finishFamilyExtraction(context: NativeFamilyContext, result: NativeFamilyResult): Extraction {
  if (result.declarations.length > 4096) {
    throw new BridgeError("STRUCTURAL_ANALYSIS_CAPACITY", "Native declaration inventory exceeds its bound");
  }
  let outputBytes = 0;
  for (const declaration of result.declarations) {
    const size = Buffer.byteLength(declaration.signature, "utf8") +
      declaration.parameters.reduce((sum, parameter) => sum + Buffer.byteLength(parameter, "utf8"), 0) +
      (declaration.result.state === "declared" ? Buffer.byteLength(declaration.result.syntax, "utf8") : 0);
    if (size > 65536 || (outputBytes += size) > 4194304) {
      throw new BridgeError("STRUCTURAL_ANALYSIS_CAPACITY", "Native declaration output exceeds its bound");
    }
  }
  const limitations = new Set(result.limitations);
  if (context.root.hasError) limitations.add("parse_error_or_missing_token");
  const bytes = Buffer.from(context.file.text, "utf8");
  const excluded = result.declarations.map(declaration => declaration.range)
    .sort((a, b) => a.start_byte - b.start_byte || b.end_byte - a.end_byte);
  const outside: Uint8Array[] = [];
  let cursor = 0;
  for (const range of excluded) {
    if (range.end_byte <= cursor) continue;
    if (range.start_byte < cursor) { cursor = range.end_byte; continue; }
    outside.push(bytes.subarray(cursor, range.start_byte));
    cursor = range.end_byte;
  }
  outside.push(bytes.subarray(cursor));
  const remainder_digest = createHash("sha256").update(Buffer.concat(outside)).digest("hex");
  return Object.freeze({ dialect: context.dialect, parser_identity: context.parserIdentity,
    extractor_identity: "native-declarations@1", source: sourceReference(context.file),
    coverage: limitations.size ? "incomplete" : "complete",
    declarations: Object.freeze([...result.declarations]), remainder_digest,
    limitations: Object.freeze([...limitations].sort()) });
}
