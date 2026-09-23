import { createHash } from "node:crypto";
import type Parser from "tree-sitter";
import { BridgeError } from "../core/errors.js";
import type { Declaration, Extraction, SourceFile } from "./model.js";
import { sourceReference } from "./source.js";
import { Utf8SourceRanges } from "./ranges.js";
import { loadNativeParser, nativeParserIdentity, type NativeDialect } from "./native-parser.js";
import { finishFamilyExtraction } from "./language-common.js";
import { extractLuaFamily, extractPythonFamily } from "./language-python-lua.js";
import { extractJavaScriptReactSvelte } from "./language-js-react-svelte.js";
import { extractKotlinZigOdin } from "./language-kotlin-zig-odin.js";
import { extractCFamily } from "./language-c-family.js";
import { parameterDefaultValues } from "./parameter-defaults.js";
import { nativeExtractorIdentity } from "./extractor-identity.js";

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const functionTypes = new Set(["function_item", "function_signature_item", "function_declaration", "function_signature",
  "method_definition", "method_signature", "arrow_function", "function_expression"]);
const typeTypes = new Set(["struct_item", "trait_item", "impl_item", "foreign_mod_item", "type_item", "enum_item",
  "mod_item", "class_declaration", "interface_declaration", "type_alias_declaration", "enum_declaration"]);
const memberTypes = new Set([...functionTypes, "field_declaration", "public_field_definition", "property_signature",
  "enum_variant", "enum_assignment", "property_identifier"]);
const commentTypes = new Set(["comment", "line_comment", "block_comment"]);
const opaqueRegionTypes = new Set(["use_declaration", "import_statement", "export_statement", "export_clause",
  "macro_definition", "macro_invocation"]);

function unwrapped(node: Parser.SyntaxNode): Parser.SyntaxNode {
  if (node.type === "export_statement") return node.childForFieldName("declaration") ?? node.childForFieldName("value") ?? node;
  return node;
}
function recoveredTopLevelFunction(node: Parser.SyntaxNode, dialect: NativeDialect): Parser.SyntaxNode | null {
  if (dialect !== "typescript" && dialect !== "tsx" || node.type !== "expression_statement" || node.namedChildren.length !== 1) return null;
  const candidate = node.namedChildren[0];
  if (candidate?.type !== "function_expression" || candidate.startIndex !== node.startIndex ||
      !candidate.childForFieldName("name") || !candidate.childForFieldName("parameters")) return null;
  const body = candidate.childForFieldName("body");
  // The TypeScript grammar reclassifies a declaration as an expression when only
  // the final brace is missing. Recover this one native shape, never an arbitrary
  // expression or damaged header.
  if (body?.type !== "statement_block" || !body.children.some(child => child.type === "}" &&
      child.isMissing && child.startIndex === body.endIndex)) return null;
  return candidate;
}
type MaskSpan = Readonly<{ start: number; end: number; text: string; marker: string; change: boolean }>;

function descendants(node: Parser.SyntaxNode, predicate: (node: Parser.SyntaxNode) => boolean,
  before = Number.POSITIVE_INFINITY): Parser.SyntaxNode[] {
  const found: Parser.SyntaxNode[] = [];
  const visit = (child: Parser.SyntaxNode): void => {
    if (child.startIndex >= before) return;
    if (predicate(child)) { found.push(child); return; }
    for (const nested of child.children) visit(nested);
  };
  visit(node);
  return found;
}

function syntaxDamage(node: Parser.SyntaxNode, start: number, end: number): boolean {
  if (!node.hasError && !node.isMissing) return false;
  return descendants(node, child => (child.type === "ERROR" || child.isMissing) &&
    (child.isMissing ? child.startIndex <= end : child.startIndex < end) && child.endIndex >= start).length > 0;
}

function maskHeader(header: string, headerStart: number, headerEnd: number, outer: Parser.SyntaxNode,
  parameters: Parser.SyntaxNode | null, ownValue: Parser.SyntaxNode | null,
  typeDefaults: readonly (Parser.SyntaxNode | null)[], prefix: readonly Parser.SyntaxNode[] = []):
  { signature: string; parameters: string[]; digests: string[] } {
  const parameterNodes = parameters?.namedChildren.filter(parameter => !commentTypes.has(parameter.type)) ?? [];
  const values = [...parameterDefaultValues(parameterNodes), ownValue, ...typeDefaults]
    .filter((value): value is Parser.SyntaxNode => value !== null && value.startIndex >= headerStart && value.endIndex <= headerEnd);
  const spans: MaskSpan[] = values.map(value => ({ start: value.startIndex, end: value.endIndex, text: value.text,
    marker: "<default>", change: true }));
  for (const hidden of [...prefix, ...descendants(outer, node => commentTypes.has(node.type) ||
    node.type === "decorator" || node.type === "attribute_item", headerEnd)]) {
    if (hidden.startIndex >= headerStart && hidden.endIndex <= headerEnd) spans.push({ start: hidden.startIndex, end: hidden.endIndex,
      text: hidden.text, marker: commentTypes.has(hidden.type) ? "<comment>" : "<attribute>", change: true });
  }
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const replacements: MaskSpan[] = [];
  for (const span of spans) {
    const previous = replacements.at(-1);
    if (previous && span.start < previous.end) {
      if (span.end > previous.end) throw new BridgeError("STRUCTURAL_EXTRACTION_INVALID", "Native masked syntax spans overlap");
      continue;
    }
    replacements.push(span);
  }
  const apply = (value: string, start: number, selected: readonly MaskSpan[]): string => {
    let cursor = 0, result = "";
    for (const span of selected) {
      const a = span.start - start, b = span.end - start;
      if (a < cursor || b > value.length) throw new BridgeError("STRUCTURAL_EXTRACTION_INVALID", "Native default span escaped its declaration header");
      result += value.slice(cursor, a) + span.marker;
      cursor = b;
    }
    return result + value.slice(cursor);
  };
  const signature = apply(header, headerStart, replacements);
  const maskedParameters = parameterNodes.map(parameter => {
    const local = replacements.filter(span => span.start >= parameter.startIndex && span.end <= parameter.endIndex);
    return apply(parameter.text, parameter.startIndex, local);
  }) ?? [];
  return { signature: signature.trim(), parameters: maskedParameters, digests: replacements.filter(span => span.change).map(span => digest(span.text)) };
}

/** Helper-side native extraction for the initial Rust/TypeScript/TSX declaration slice. */
export async function extractNativeFunctions(file: SourceFile, dialect: NativeDialect): Promise<Extraction> {
  if (file.status !== "present") {
    return emptyNativeExtraction(file, dialect);
  }
  if (Buffer.byteLength(file.text, "utf8") !== file.byte_length || digest(file.text) !== file.content_sha256) {
    throw new BridgeError("STRUCTURAL_SOURCE_INVALID", "Native extraction requires the exact captured source bytes");
  }
  const { parser, identity } = await loadNativeParser(dialect);
  const ranges = new Utf8SourceRanges(file.text);
  const tree = parser.parse(file.text);
  if (!tree) throw new BridgeError("STRUCTURAL_PARSER_UNAVAILABLE", "Native parser returned no tree");
  if (dialect !== "rust" && dialect !== "typescript" && dialect !== "tsx") {
    const context = { file, dialect, root: tree.rootNode, ranges, parserIdentity: identity };
    const family = dialect === "python" ? extractPythonFamily : dialect === "lua" ? extractLuaFamily
      : dialect === "javascript" || dialect === "jsx" || dialect === "svelte5" ? extractJavaScriptReactSvelte
      : dialect === "kotlin" || dialect === "zig" || dialect === "odin" ? extractKotlinZigOdin : extractCFamily;
    const result = await family(context);
    return finishFamilyExtraction(context, result);
  }
  const limitations = new Set<string>();
  if (tree.rootNode.hasError) limitations.add("parse_error_or_missing_token");
  const declarations: Declaration[] = [];
  const add = (outer: Parser.SyntaxNode, node: Parser.SyntaxNode, enclosing: string[], bindingName?: Parser.SyntaxNode,
    prefix: readonly Parser.SyntaxNode[] = []): void => {
    const isFunction = functionTypes.has(node.type), isType = typeTypes.has(node.type);
    if (declarations.length >= 4096) throw new BridgeError("STRUCTURAL_ANALYSIS_CAPACITY", "Native declaration inventory exceeds its bound");
    const nameNode = bindingName ?? node.childForFieldName("name") ?? (node.type === "impl_item" ? node.childForFieldName("type") : null)
      ?? (node.type === "property_identifier" ? node : null);
    const implTrait = node.type === "impl_item" ? node.childForFieldName("trait") : null;
    const foreignAbi = node.type === "foreign_mod_item" ? node.namedChildren.find(child => child.type === "extern_modifier") : null;
    const name = foreignAbi?.text ?? (nameNode ? implTrait ? `${implTrait.text} for ${nameNode.text}` : nameNode.text : null);
    const parameters = node.childForFieldName("parameters"), body = node.childForFieldName("body");
    const start = prefix[0]?.startIndex ?? outer.startIndex;
    const headerEnd = body && node.type !== "enum_variant" ? body.startIndex : outer.endIndex;
    const header = file.text.slice(start, headerEnd);
    const typeAlias = node.type === "type_alias_declaration" || node.type === "type_item";
    const typeDefaults = node.childForFieldName("type_parameters")?.namedChildren.map(parameter => {
      const value = parameter.childForFieldName("default_type") ?? parameter.childForFieldName("value");
      return value?.type === "default_type" ? value.lastNamedChild ?? value : value;
    }) ?? [];
    const defaults = maskHeader(header, start, headerEnd, outer, parameters,
      typeAlias ? null : node.childForFieldName("value"), typeDefaults, prefix);
    const validHeader = (name !== null || node.type === "function_expression") && (!isFunction || !!parameters) &&
      !syntaxDamage(outer, outer.startIndex, headerEnd) &&
      !prefix.some(attribute => attribute.hasError);
    if (!validHeader) limitations.add("declaration_header_incomplete");
    const result = node.childForFieldName("return_type") ?? (typeAlias ? node.childForFieldName("value") ?? node.childForFieldName("type")
      : !isFunction && !isType ? node.childForFieldName("type") : null);
    const range = ranges.byteRange(start, outer.endIndex);
    let bodyDigest = digest("");
    const bodyMembers: { node: Parser.SyntaxNode; prefix: Parser.SyntaxNode[]; start: number }[] = [];
    if (body && isType) {
      let pending: Parser.SyntaxNode[] = [];
      for (const member of body.namedChildren) {
        if (member.type === "decorator" || member.type === "attribute_item" || (pending.length && commentTypes.has(member.type))) {
          pending.push(member); continue;
        }
        if (memberTypes.has(member.type) || typeTypes.has(member.type)) {
          bodyMembers.push({ node: member, prefix: pending, start: pending[0]?.startIndex ?? member.startIndex });
          pending = [];
        } else { limitations.add("unmapped_member_syntax"); pending = []; }
      }
      if (pending.length) limitations.add("unmapped_member_syntax");
    }
    if (body && syntaxDamage(body, body.startIndex, body.endIndex)) {
      limitations.add("declaration_body_incomplete");
      bodyDigest = "";
    } else if (body && isType) {
      let cursor = body.startIndex, remaining = "";
      for (const member of bodyMembers) {
        remaining += file.text.slice(cursor, member.start);
        cursor = member.node.endIndex;
      }
      bodyDigest = digest(remaining + file.text.slice(cursor, body.endIndex));
    } else if (body && node.type !== "enum_variant") {
      let cursor = body.startIndex, remaining = "";
      for (const child of body.namedChildren) {
        if (!functionTypes.has(child.type) && !typeTypes.has(child.type)) continue;
        remaining += file.text.slice(cursor, child.startIndex);
        cursor = child.endIndex;
      }
      bodyDigest = digest(remaining + file.text.slice(cursor, body.endIndex));
    }
    if (body && isFunction) {
      const direct = new Set(body.namedChildren.filter(child => functionTypes.has(child.type) || typeTypes.has(child.type)));
      const deep = descendants(body, child => child !== body && (functionTypes.has(child.type) ||
        typeTypes.has(child.type) || (child.type === "variable_declarator" &&
          ["arrow_function", "function_expression"].includes(child.childForFieldName("value")?.type ?? ""))));
      if (deep.some(child => !direct.has(child))) limitations.add("nested_declaration_coverage_unavailable");
    }
    const declaration: Declaration = { key: `${node.type}:${name ?? "<anonymous>"}:${range.start_byte}`,
      kind: node.type, name, enclosing, range,
      signature: validHeader ? defaults.signature : "<header extraction incomplete>",
      parameters: validHeader ? defaults.parameters : [],
      result: validHeader ? result ? { state: "declared", syntax: maskHeader(result.text, result.startIndex,
        result.endIndex, result, null, null, []).signature } : { state: "not_declared" } : { state: "unavailable" },
      header_complete: validHeader, ...(bodyDigest ? { body_digest: bodyDigest } : {}), default_digests: defaults.digests };
    declarations.push(Object.freeze(declaration));
    if (body && isType) for (const member of bodyMembers) add(member.node, member.node,
      [...enclosing, name ?? "<anonymous>"], undefined, member.prefix);
    if (body && isFunction) for (const child of body.namedChildren) {
      if (functionTypes.has(child.type) || typeTypes.has(child.type)) add(child, child, [...enclosing, name ?? "<anonymous>"]);
    }
  };
  const addLexical = (outer: Parser.SyntaxNode, lexical: Parser.SyntaxNode, enclosing: string[]): void => {
    const items = lexical.namedChildren.filter(child => child.type === "variable_declarator");
    for (const item of items) {
      const value = item.childForFieldName("value"), binding = item.childForFieldName("name");
      if (value && (value.type === "arrow_function" || value.type === "function_expression") && binding?.type === "identifier") {
        add(items.length === 1 ? outer : item, value, enclosing, binding);
      } else limitations.add("unmapped_top_level_syntax");
    }
    if (items.length === 0) limitations.add("unmapped_top_level_syntax");
  };
  let pendingAttributes: Parser.SyntaxNode[] = [];
  for (const outer of tree.rootNode.namedChildren) {
    if (outer.type === "attribute_item" || (pendingAttributes.length && commentTypes.has(outer.type))) {
      pendingAttributes.push(outer); continue;
    }
    const node = recoveredTopLevelFunction(outer, dialect) ?? unwrapped(outer);
    if (functionTypes.has(node.type) || typeTypes.has(node.type)) add(outer, node, [], undefined, pendingAttributes);
    else if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
      if (pendingAttributes.length) limitations.add("unmapped_top_level_syntax");
      addLexical(outer, node, []);
    } else if (!commentTypes.has(node.type) && !opaqueRegionTypes.has(node.type)) limitations.add("unmapped_top_level_syntax");
    pendingAttributes = [];
  }
  if (pendingAttributes.length) limitations.add("unmapped_top_level_syntax");
  const excluded = [...declarations.map(d => d.range)].sort((a, b) => a.start_byte - b.start_byte);
  const bytes = Buffer.from(file.text, "utf8");
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
  return Object.freeze({ dialect, parser_identity: identity, extractor_identity: nativeExtractorIdentity(dialect),
    source: sourceReference(file), coverage: limitations.size ? "incomplete" : "complete",
    declarations: Object.freeze(declarations), remainder_digest, limitations: Object.freeze([...limitations].sort()) });
}

/** Non-present endpoints are represented without launching a parser or reading a replacement path. */
export function emptyNativeExtraction(file: Exclude<SourceFile, { status: "present" }>, dialect: NativeDialect): Extraction {
  const absent = file.status === "absent_in_commit";
  return Object.freeze({ dialect, parser_identity: nativeParserIdentity(dialect), extractor_identity: nativeExtractorIdentity(dialect),
    source: sourceReference(file), coverage: absent ? "complete" : "unavailable", declarations: [],
    ...(absent ? { remainder_digest: digest("") } : {}), limitations: absent ? [] : ["source_not_present"] });
}
