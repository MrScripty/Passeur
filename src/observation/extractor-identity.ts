import { canonicalHash } from "../core/async.js";
import { nativeParserIdentity, type NativeDialect } from "./native-parser.js";

/** The TypeScript/TSX declaration projection now masks defaults inside binding patterns. */
export function nativeExtractorIdentity(dialect: NativeDialect): string {
  return dialect === "typescript" || dialect === "tsx" ? "native-declarations@2" : "native-declarations@1";
}

// Historical captures remain retained. Only the unsafe compact projection is refused;
// explicit detail authorization and fresh extraction retain their own contracts.
const unmaskedParameterReports = new Set((["typescript", "tsx"] as const).map(dialect => canonicalHash({
  parser_identity: nativeParserIdentity(dialect), extractor_identity: "native-declarations@1",
})));
export function requiresParameterMaskRefresh(analysisDigest: string): boolean {
  return unmaskedParameterReports.has(analysisDigest);
}
