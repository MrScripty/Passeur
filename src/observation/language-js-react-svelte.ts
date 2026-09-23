import { createHash } from "node:crypto";
import type Parser from "tree-sitter";
import { BridgeError } from "../core/errors.js";
import type { Annotation, Declaration } from "./model.js";
import { loadNativeParser, type NativeDialect } from "./native-parser.js";
import type { NativeFamilyContext, NativeFamilyResult } from "./language-common.js";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const functions = new Set(["function_declaration", "generator_function_declaration", "function_expression",
  "generator_function", "arrow_function", "method_definition", "method_signature"]);
const types = new Set(["class_declaration", "class", "interface_declaration", "type_alias_declaration"]);
const variables = new Set(["lexical_declaration", "variable_declaration"]);
const fields = new Set(["field_definition", "public_field_definition"]);
const opaque = new Set(["import_statement", "import_declaration", "export_clause", "empty_statement",
  "comment", "jsx_element", "jsx_self_closing_element", "expression_statement"]);
const MAX_DECLARATIONS = 4096;
const MAX_WALK_NODES = 100_000;

type Region = Readonly<{ text: string; base: number; end: number; scope: readonly string[] }>;
type Span = Readonly<{ start: number; end: number; marker: string; digest: string }>;

function visit(root: Parser.SyntaxNode, action: (node: Parser.SyntaxNode) => void): void {
  const queue = [root];
  let visited = 0;
  while (queue.length) {
    const node = queue.pop()!;
    if (++visited > MAX_WALK_NODES) throw new BridgeError("STRUCTURAL_ANALYSIS_CAPACITY", "Native syntax walk exceeds its bound");
    action(node);
    for (let index = node.namedChildren.length - 1; index >= 0; index--) queue.push(node.namedChildren[index]!);
  }
}

function damaged(node: Parser.SyntaxNode, end: number): boolean {
  if (!node.hasError && !node.isMissing) return false;
  let bad = false;
  visit(node, child => {
    if ((child.type === "ERROR" || child.isMissing) &&
        (child.isMissing ? child.startIndex <= end : child.startIndex < end) && child.endIndex >= node.startIndex) bad = true;
  });
  return bad;
}

function mask(source: string, start: number, end: number, spans: readonly Span[]): string {
  let position = start;
  let result = "";
  for (const span of spans) {
    if (span.start < position || span.end > end) continue;
    result += source.slice(position, span.start) + span.marker;
    position = span.end;
  }
  return (result + source.slice(position, end)).trim();
}

function defaultSpans(parameters: Parser.SyntaxNode | null, headerEnd: number): Span[] {
  const spans: Span[] = [];
  if (!parameters) return spans;
  visit(parameters, child => {
    if (child.type !== "assignment_pattern" && child.type !== "object_assignment_pattern" &&
        child.type !== "required_parameter" && child.type !== "optional_parameter") return;
    const value = child.childForFieldName("right") ?? child.childForFieldName("value");
    if (value && value.endIndex <= headerEnd) spans.push({ start: value.startIndex, end: value.endIndex,
      marker: "<default>", digest: hash(value.text) });
  });
  return spans.sort((a, b) => a.start - b.start || b.end - a.end).filter((span, index, all) =>
    index === 0 || span.start >= all[index - 1]!.end);
}

function headerSpans(node: Parser.SyntaxNode, parameters: Parser.SyntaxNode | null, end: number): Span[] {
  const spans = defaultSpans(parameters, end);
  visit(node, child => {
    if (child.endIndex > end || child.startIndex < node.startIndex) return;
    if (child.type === "comment" || child.type === "decorator") spans.push({ start: child.startIndex,
      end: child.endIndex, marker: child.type === "comment" ? "<comment>" : "<attribute>", digest: hash(child.text) });
  });
  return spans.sort((a, b) => a.start - b.start || b.end - a.end).filter((span, index, all) =>
    index === 0 || span.start >= all[index - 1]!.end);
}

function unwrap(node: Parser.SyntaxNode): Parser.SyntaxNode {
  return node.type === "export_statement" ? node.childForFieldName("declaration") ?? node.childForFieldName("value") ?? node : node;
}

/** JS/JSX and TSX declarations use the native grammar's written syntax only. */
export async function extractJavaScriptReactSvelte(context: NativeFamilyContext): Promise<NativeFamilyResult> {
  const { file, dialect, ranges } = context;
  if (!["javascript", "jsx", "tsx", "svelte5"].includes(dialect)) {
    throw new BridgeError("STRUCTURAL_DIALECT_UNSUPPORTED", "The JS/React/Svelte extractor does not own this dialect");
  }
  const declarations: Declaration[] = [];
  const limitations = new Set<string>();
  const embeddedParsers = new Map<NativeDialect, Parser>();
  const embeddedParser = async (selected: NativeDialect): Promise<Parser> => {
    const existing = embeddedParsers.get(selected);
    if (existing) return existing;
    const { parser } = await loadNativeParser(selected);
    embeddedParsers.set(selected, parser);
    return parser;
  };

  const add = (outer: Parser.SyntaxNode, node: Parser.SyntaxNode, region: Region, enclosing: readonly string[],
    boundName?: Parser.SyntaxNode, startOverride?: number): void => {
    if (declarations.length >= MAX_DECLARATIONS) throw new BridgeError("STRUCTURAL_ANALYSIS_CAPACITY", "Native declaration inventory exceeds its bound");
    const nameNode = boundName ?? node.childForFieldName("name");
    const name = nameNode?.text ?? null;
    const parameters = node.childForFieldName("parameters") ?? (node.type === "arrow_function" ? node.childForFieldName("parameter") : null);
    const body = node.childForFieldName("body");
    const start = startOverride ?? outer.startIndex;
    const end = outer.endIndex;
    const headerEnd = body ? body.startIndex : end;
    const localSource = region.text;
    const validRange = start >= 0 && end <= region.text.length && headerEnd >= start && headerEnd <= end;
    if (!validRange) throw new BridgeError("STRUCTURAL_EXTRACTION_INVALID", "Native declaration escaped its mapped source region");
    const isFunction = functions.has(node.type);
    const anonymousDefaultExport = outer.type === "export_statement" && outer.text.startsWith("export default") &&
      (node.type === "function_declaration" || node.type === "generator_function_declaration");
    const headerComplete = (name !== null || node.type === "function_expression" || anonymousDefaultExport) &&
      (!isFunction || !!parameters) &&
      !damaged(outer, headerEnd);
    if (!headerComplete) limitations.add("declaration_header_incomplete");
    const spans = headerSpans(outer, parameters, headerEnd);
    const signature = headerComplete ? mask(localSource, start, headerEnd, spans) : "<header extraction incomplete>";
    const parameterList = parameters?.type === "formal_parameters" ? parameters.namedChildren : parameters ? [parameters] : [];
    const parameterText = headerComplete ? parameterList.map(parameter =>
      mask(localSource, parameter.startIndex, parameter.endIndex, spans.filter(span =>
        span.start >= parameter.startIndex && span.end <= parameter.endIndex))) : [];
    const resultNode = node.childForFieldName("return_type");
    const typeAlias = node.type === "type_alias_declaration";
    const declaredResult = resultNode ?? (typeAlias ? node.childForFieldName("value") : null);
    const bodyDamaged = !!body && damaged(body, body.endIndex);
    if (bodyDamaged) limitations.add("declaration_body_incomplete");
    const byteRange = ranges.byteRange(region.base + start, region.base + end);
    const directChildren: Parser.SyntaxNode[] = [];
    if (body && (body.type === "statement_block" || body.type === "class_body")) {
      for (const child of body.namedChildren) {
        const actual = unwrap(child);
        if (functions.has(actual.type) || types.has(actual.type) || variables.has(actual.type) || fields.has(actual.type)) directChildren.push(child);
      }
      if (body.type === "class_body" && body.namedChildren.some(child => !directChildren.includes(child) &&
          child.type !== "comment")) limitations.add("unmapped_member_syntax");
      visit(body, child => {
        if (child === body || directChildren.includes(child)) return;
        if ((functions.has(child.type) || types.has(child.type)) &&
            !directChildren.some(direct => child.startIndex >= direct.startIndex && child.endIndex <= direct.endIndex)) {
          limitations.add("nested_declaration_coverage_unavailable");
        }
      });
    }
    let bodyDigest: string | undefined;
    if (body && !bodyDamaged) {
      let cursor = body.startIndex;
      let directBody = "";
      for (const child of directChildren) {
        directBody += localSource.slice(cursor, child.startIndex);
        cursor = child.endIndex;
      }
      bodyDigest = hash(directBody + localSource.slice(cursor, body.endIndex));
    }
    const result: Annotation = !headerComplete ? { state: "unavailable" } : declaredResult ?
      { state: "declared", syntax: mask(localSource, declaredResult.startIndex, declaredResult.endIndex,
        spans.filter(span => span.start >= declaredResult.startIndex && span.end <= declaredResult.endIndex)) } :
      { state: "not_declared" };
    const declaration: Declaration = { key: `${node.type}:${name ?? "<anonymous>"}:${byteRange.start_byte}`,
      kind: node.type, name, enclosing: [...enclosing], range: byteRange, signature,
      parameters: parameterText, result, header_complete: headerComplete,
      ...(bodyDigest === undefined ? {} : { body_digest: bodyDigest }), default_digests: spans.map(span => span.digest) };
    declarations.push(Object.freeze(declaration));
    if (body && !bodyDamaged) for (const child of directChildren) addTop(child, region, [...enclosing, name ?? "<anonymous>"]);
  };

  const addField = (node: Parser.SyntaxNode, region: Region, enclosing: readonly string[]): void => {
    if (declarations.length >= MAX_DECLARATIONS) throw new BridgeError("STRUCTURAL_ANALYSIS_CAPACITY", "Native declaration inventory exceeds its bound");
    const nameNode = node.childForFieldName("property") ?? node.childForFieldName("name");
    const value = node.childForFieldName("value"), type = node.childForFieldName("type");
    const headerComplete = !!nameNode && !damaged(node, node.endIndex);
    if (!headerComplete) limitations.add("declaration_header_incomplete");
    let spans = headerSpans(node, null, node.endIndex);
    if (value) spans = spans.filter(span => span.end <= value.startIndex || span.start >= value.endIndex);
    if (value) spans.push({ start: value.startIndex, end: value.endIndex, marker: "<default>", digest: hash(value.text) });
    spans.sort((a, b) => a.start - b.start || b.end - a.end);
    const range = ranges.byteRange(region.base + node.startIndex, region.base + node.endIndex);
    const result: Annotation = !headerComplete ? { state: "unavailable" } : type ?
      { state: "declared", syntax: mask(region.text, type.startIndex, type.endIndex,
        spans.filter(span => span.start >= type.startIndex && span.end <= type.endIndex)) } : { state: "not_declared" };
    const declaration: Declaration = { key: `${node.type}:${nameNode?.text ?? "<anonymous>"}:${range.start_byte}`,
      kind: node.type, name: nameNode?.text ?? null, enclosing: [...enclosing], range,
      signature: headerComplete ? mask(region.text, node.startIndex, node.endIndex, spans) : "<header extraction incomplete>",
      parameters: [], result, header_complete: headerComplete, body_digest: hash(""),
      default_digests: spans.map(span => span.digest) };
    declarations.push(Object.freeze(declaration));
  };

  const addTop = (outer: Parser.SyntaxNode, region: Region, enclosing: readonly string[]): void => {
    const node = unwrap(outer);
    if (functions.has(node.type) || types.has(node.type)) { add(outer, node, region, enclosing); return; }
    if (fields.has(node.type)) { addField(node, region, enclosing); return; }
    if (variables.has(node.type)) {
      let mapped = 0;
      for (const declarator of node.namedChildren.filter(child => child.type === "variable_declarator")) {
        const value = declarator.childForFieldName("value"), name = declarator.childForFieldName("name");
        if (value && functions.has(value.type) && name?.type === "identifier") {
          add(node.namedChildren.filter(child => child.type === "variable_declarator").length === 1 ? outer : declarator,
            value, region, enclosing, name); mapped++;
        } else if (region.scope.some(part => part === "module script" || part.startsWith("instance script ")) && name &&
                   ((value?.type === "call_expression" && value.childForFieldName("function")?.text === "$props" &&
                     value.childForFieldName("arguments")?.text === "()") ||
                    (outer.type === "export_statement" && /^let\b/.test(node.text) && name.type === "identifier"))) {
          if (declarations.length >= MAX_DECLARATIONS) throw new BridgeError("STRUCTURAL_ANALYSIS_CAPACITY", "Native declaration inventory exceeds its bound");
          const scopeStart = outer.startIndex, scopeEnd = outer.endIndex;
          const initialization = value ? { start: value.startIndex, end: value.endIndex,
            marker: "<initializer>", digest: hash(value.text) } : null;
          const spans = [...headerSpans(outer, name, scopeEnd).filter(span => !initialization ||
            span.end <= initialization.start || span.start >= initialization.end),
            ...(initialization ? [initialization] : [])]
            .sort((a, b) => a.start - b.start || b.end - a.end);
          const validHeader = !damaged(outer, scopeEnd);
          if (!validHeader) limitations.add("declaration_header_incomplete");
          const range = ranges.byteRange(region.base + scopeStart, region.base + scopeEnd);
          const type = declarator.childForFieldName("type");
          const rune = value?.type === "call_expression";
          const declaration: Declaration = { key: `${rune ? "svelte_props_binding" : "svelte_exported_prop"}:${rune ? "$props" : name.text}:${range.start_byte}`,
            kind: rune ? "svelte_props_binding" : "svelte_exported_prop", name: rune ? "$props" : name.text,
            enclosing: [...enclosing], range, signature: validHeader ? mask(region.text, scopeStart, scopeEnd, spans) : "<header extraction incomplete>",
            parameters: name.type === "object_pattern" ? name.namedChildren.map(parameter => mask(region.text,
              parameter.startIndex, parameter.endIndex, spans.filter(span => span.start >= parameter.startIndex &&
                span.end <= parameter.endIndex))) : [],
            result: !validHeader ? { state: "unavailable" } : type ? { state: "declared",
              syntax: mask(region.text, type.startIndex, type.endIndex,
                spans.filter(span => span.start >= type.startIndex && span.end <= type.endIndex)) } : { state: "not_declared" },
            header_complete: validHeader, ...(rune && value ? { body_digest: hash(value.text) } : {}),
            default_digests: [...spans.filter(span => span.marker !== "<initializer>").map(span => span.digest),
              ...(!rune && initialization ? [initialization.digest] : [])] };
          declarations.push(Object.freeze(declaration)); mapped++;
        } else limitations.add("unmapped_binding_syntax");
      }
      if (mapped === 0) limitations.add("unmapped_binding_syntax");
      return;
    }
    if (node.type === "expression_statement") {
      const assignment = node.namedChildren.find(child => child.type === "assignment_expression");
      const right = assignment?.childForFieldName("right"), left = assignment?.childForFieldName("left");
      if (right && functions.has(right.type) && left &&
          (left.type === "identifier" || left.type === "member_expression")) {
        add(outer, right, region, enclosing, left);
      }
      return;
    }
    if (!opaque.has(node.type) && node.type !== "export_statement") limitations.add("unmapped_top_level_syntax");
  };

  const parseProgram = (root: Parser.SyntaxNode, region: Region): void => {
    if (root.hasError) limitations.add("embedded_parse_error_or_missing_token");
    for (const node of root.namedChildren) addTop(node, region, region.scope);
  };

  if (dialect !== "svelte5") {
    parseProgram(context.root, { text: file.text, base: 0, end: file.text.length, scope: [] });
  } else {
    const svelteRoot = context.root;
    const sourceBytes = Buffer.from(file.text, "utf8");
    let scriptIndex = 0;
    let snippetDialect: NativeDialect = "javascript";
    let templateVisits = 0;
    const mappedRaw = (raw: Parser.SyntaxNode, owner: Parser.SyntaxNode): boolean => {
      if (raw.startIndex < owner.startIndex || raw.endIndex > owner.endIndex ||
          file.text.slice(raw.startIndex, raw.endIndex) !== raw.text) return false;
      const range = ranges.byteRange(raw.startIndex, raw.endIndex);
      return sourceBytes.subarray(range.start_byte, range.end_byte).equals(Buffer.from(raw.text, "utf8"));
    };
    const checkEmbedded = async (raw: Parser.SyntaxNode | undefined, owner: Parser.SyntaxNode,
      shape: "expression" | "binding"): Promise<void> => {
      if (!raw || !mappedRaw(raw, owner)) { limitations.add("embedded_template_region_unavailable"); return; }
      const prefix = shape === "expression" ? "(" : "function _(";
      const suffix = shape === "expression" ? ")" : "){}";
      const parser = await embeddedParser(snippetDialect);
      const parsed = parser.parse(prefix + raw.text + suffix);
      const first = parsed?.rootNode.namedChildren[0];
      const syntax = shape === "expression" ? first?.namedChildren[0] : first?.childForFieldName("parameters");
      const valid = !!parsed && !parsed.rootNode.hasError && parsed.rootNode.namedChildren.length === 1 &&
        (shape === "expression" ? first?.type === "expression_statement" &&
          syntax?.type === "parenthesized_expression" && syntax.startIndex === 0 &&
          syntax.endIndex === prefix.length + raw.text.length + suffix.length :
          first?.type === "function_declaration" && syntax?.type === "formal_parameters" &&
          syntax.startIndex === prefix.length - 1 && syntax.endIndex === prefix.length + raw.text.length + 1);
      if (!valid) limitations.add(shape === "expression" ?
        "embedded_expression_parse_error_or_missing_token" : "embedded_binding_parse_error_or_missing_token");
    };
    const scanTemplate = async (node: Parser.SyntaxNode, enclosing: readonly string[], depth = 0): Promise<void> => {
      if (depth > 256) throw new BridgeError("STRUCTURAL_ANALYSIS_CAPACITY", "Svelte template nesting exceeds its bound");
      if (++templateVisits > MAX_WALK_NODES) throw new BridgeError("STRUCTURAL_ANALYSIS_CAPACITY", "Svelte syntax walk exceeds its bound");
      if (node.type === "script_element") {
        const startTag = node.namedChildren.find(child => child.type === "start_tag");
        const raw = node.namedChildren.find(child => child.type === "raw_text");
        if (!raw || !startTag) { limitations.add("embedded_script_unavailable"); return; }
        const attributes = startTag.namedChildren.filter(child => child.type === "attribute");
        const attributeName = (attribute: Parser.SyntaxNode): string | undefined =>
          attribute.namedChildren.find(child => child.type === "attribute_name")?.text;
        const attributeValue = (attribute: Parser.SyntaxNode): string | undefined =>
          attribute.namedChildren.find(child => child.type === "quoted_attribute_value")?.namedChildren
            .find(child => child.type === "attribute_value")?.text;
        const lang = attributeValue(attributes.find(attribute => attributeName(attribute) === "lang") ?? startTag);
        const moduleContext = attributes.some(attribute => attributeName(attribute) === "module" ||
          (attributeName(attribute) === "context" && attributeValue(attribute) === "module"));
        if (lang && lang !== "js" && lang !== "javascript" && lang !== "ts" && lang !== "typescript") {
          limitations.add("embedded_script_dialect_unsupported"); return;
        }
        const selected: NativeDialect = lang === "ts" || lang === "typescript" ? "typescript" : "javascript";
        if (!moduleContext) snippetDialect = selected;
        const parser = await embeddedParser(selected);
        const parsed = parser.parse(raw.text);
        if (!parsed) { limitations.add("embedded_script_parse_unavailable"); return; }
        parseProgram(parsed.rootNode, { text: raw.text, base: raw.startIndex, end: raw.endIndex,
          scope: [...enclosing, moduleContext ? "module script" : `instance script ${++scriptIndex}`] });
        return;
      }
      if (node.type === "snippet_statement") {
        if (declarations.length >= MAX_DECLARATIONS) throw new BridgeError("STRUCTURAL_ANALYSIS_CAPACITY", "Native declaration inventory exceeds its bound");
        const start = node.namedChildren.find(child => child.type === "snippet_start");
        const nameNode = start?.namedChildren.find(child => child.type === "snippet_name");
        const rawParams = start?.namedChildren.find(child => child.type === "svelte_raw_text");
        const bodyStart = start?.endIndex ?? node.startIndex;
        let headerComplete = !!start && !!nameNode && !damaged(start, start.endIndex);
        let parameterText: string[] = [], spans: Span[] = [];
        if (rawParams && headerComplete) {
          const wrapper = `function _(${rawParams.text}){}`;
          const parser = await embeddedParser(snippetDialect);
          const parsed = parser.parse(wrapper);
          const fn = parsed?.rootNode.namedChildren[0];
          const params = fn?.childForFieldName("parameters");
          const prefix = "function _(".length;
          if (!parsed || parsed.rootNode.hasError || !params ||
              params.startIndex !== prefix - 1 || params.endIndex !== prefix + rawParams.text.length + 1) {
            limitations.add("snippet_parameters_unavailable");
            headerComplete = false;
          } else {
            const localSpans = headerSpans(params, params, params.endIndex);
            spans = localSpans.map(span => ({ ...span, start: rawParams.startIndex + span.start - prefix,
              end: rawParams.startIndex + span.end - prefix }));
            parameterText = params.namedChildren.map(parameter => mask(file.text,
              rawParams.startIndex + parameter.startIndex - prefix, rawParams.startIndex + parameter.endIndex - prefix,
              spans.filter(span => span.start >= rawParams.startIndex + parameter.startIndex - prefix &&
                span.end <= rawParams.startIndex + parameter.endIndex - prefix)));
          }
        }
        if (!headerComplete) { limitations.add("declaration_header_incomplete"); parameterText = []; spans = []; }
        const range = ranges.byteRange(node.startIndex, node.endIndex);
        const nested = node.namedChildren.filter(child => child.type === "snippet_statement");
        let cursor = bodyStart, body = "";
        for (const child of nested) { body += file.text.slice(cursor, child.startIndex); cursor = child.endIndex; }
        body += file.text.slice(cursor, node.endIndex);
        const result: Annotation = headerComplete ? { state: "not_declared" } : { state: "unavailable" };
        const declaration: Declaration = { key: `snippet:${nameNode?.text ?? "<anonymous>"}:${range.start_byte}`,
          kind: "snippet_statement", name: nameNode?.text ?? null, enclosing: [...enclosing], range,
          signature: headerComplete ? mask(file.text, start!.startIndex, start!.endIndex, spans) : "<header extraction incomplete>",
          parameters: parameterText, result,
          header_complete: headerComplete, ...(damaged(node, node.endIndex) ? {} : { body_digest: hash(body) }),
          default_digests: spans.map(span => span.digest) };
        declarations.push(Object.freeze(declaration));
        if (damaged(node, node.endIndex)) limitations.add("declaration_body_incomplete");
        for (const child of node.namedChildren) if (child !== start) await scanTemplate(child,
          [...enclosing, nameNode?.text ?? "<anonymous>"], depth + 1);
        return;
      }
      if (node.type === "render_tag" || node.type === "expression") {
        await checkEmbedded(node.namedChildren.find(child => child.type === "svelte_raw_text"), node, "expression");
        return;
      }
      if (["if_start", "else_if_start", "await_start", "key_start"].includes(node.type)) {
        await checkEmbedded(node.namedChildren.find(child => child.type === "svelte_raw_text"), node, "expression");
        return;
      }
      if (node.type === "each_start") {
        const raws = node.namedChildren.filter(child => child.type === "svelte_raw_text");
        await checkEmbedded(raws[0], node, "expression");
        await checkEmbedded(raws[1], node, "binding");
        if (raws.length > 2) limitations.add("unmapped_template_embedded_syntax");
        return;
      }
      if (node.type === "then_start" || node.type === "catch_start") {
        const raw = node.namedChildren.find(child => child.type === "svelte_raw_text");
        if (raw) await checkEmbedded(raw, node, "binding");
        return;
      }
      if (node.type === "svelte_raw_text") {
        limitations.add("unmapped_template_embedded_syntax");
        return;
      }
      if (node.type === "style_element") return;
      for (const child of node.namedChildren) await scanTemplate(child, enclosing, depth + 1);
    };
    await scanTemplate(svelteRoot, []);
  }
  return { declarations, limitations: [...limitations] };
}
