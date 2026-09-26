import { createHash } from "node:crypto";
import type Parser from "tree-sitter";
import type { Declaration } from "./model.js";
import type { NativeFamilyContext, NativeFamilyResult } from "./language-common.js";

const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
const cContainers = new Set(["struct_specifier", "union_specifier", "enum_specifier", "namespace_definition", "class_specifier"]);
const csContainers = new Set(["namespace_declaration", "file_scoped_namespace_declaration", "class_declaration", "struct_declaration",
  "interface_declaration", "record_declaration", "enum_declaration", "extension_declaration"]);
const csMembers = new Set(["method_declaration", "constructor_declaration", "destructor_declaration", "operator_declaration",
  "conversion_operator_declaration", "property_declaration", "indexer_declaration", "field_declaration", "event_declaration"]);
const cDeclarators = new Set(["function_declarator", "pointer_declarator", "reference_declarator", "parenthesized_declarator",
  "array_declarator", "attributed_declarator", "init_declarator"]);
const comments = new Set(["comment", "line_comment", "block_comment"]);
const cOpaque = new Set(["preproc_include", "preproc_def", "preproc_function_def", "preproc_call", "using_declaration",
  "using_directive", "static_assert_declaration"]);

type Span = { start: number; end: number; replacement: string; original: string };

function field(node: Parser.SyntaxNode, name: string): Parser.SyntaxNode | null { return node.childForFieldName(name); }
function first(node: Parser.SyntaxNode, type: string): Parser.SyntaxNode | undefined {
  return node.namedChildren.find(child => child.type === type);
}
function damaged(node: Parser.SyntaxNode, start: number, end: number): boolean {
  if (!node.hasError && !node.isMissing) return false;
  const visit = (child: Parser.SyntaxNode): boolean => {
    if ((child.type === "ERROR" || child.isMissing) && child.startIndex <= end && child.endIndex >= start) return true;
    return child.namedChildren.some(visit);
  };
  return visit(node);
}
function declaratorName(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  let cursor: Parser.SyntaxNode | null = node;
  for (let depth = 0; cursor && depth < 16; depth++) {
    if (!cDeclarators.has(cursor.type)) return cursor;
    cursor = field(cursor, "declarator") ?? cursor.namedChildren[0] ?? null;
  }
  return null;
}
function callable(node: Parser.SyntaxNode | null): Parser.SyntaxNode | null {
  if (!node) return null;
  if (node.type === "function_declarator") {
    const inner = field(node, "declarator");
    // `int (*callback)(int)` describes a pointer value, not a function declaration.
    if (inner?.type === "parenthesized_declarator" && inner.namedChildren.some(child => child.type === "pointer_declarator")) return null;
    return node;
  }
  return node.namedChildren.map(callable).find((child): child is Parser.SyntaxNode => child !== null) ?? null;
}
function parameterNodes(node: Parser.SyntaxNode | null): Parser.SyntaxNode[] {
  return node?.namedChildren.filter(child => !comments.has(child.type)) ?? [];
}
function containsAny(node: Parser.SyntaxNode, types: ReadonlySet<string>): boolean {
  return node.namedChildren.some(child => types.has(child.type) || containsAny(child, types));
}
function defaultValue(parameter: Parser.SyntaxNode): Parser.SyntaxNode | null {
  const explicit = field(parameter, "default_value") ?? field(parameter, "value");
  if (explicit) return explicit;
  // These grammars expose the initializer as the final named child after an `=` token.
  const equal = parameter.children.find(child => child.type === "=" && !child.isNamed);
  return equal ? parameter.namedChildren.find(child => child.startIndex >= equal.endIndex) ?? null : null;
}
function masking(text: string, start: number, end: number, spans: readonly Span[]): { signature: string; digests: string[] } {
  const ordered = spans.filter(span => span.start >= start && span.end <= end).sort((a, b) => a.start - b.start || b.end - a.end);
  let cursor = start, signature = "";
  const digests: string[] = [];
  for (const span of ordered) {
    if (span.start < cursor) continue;
    signature += text.slice(cursor, span.start) + span.replacement;
    digests.push(hash(span.original));
    cursor = span.end;
  }
  return { signature: (signature + text.slice(cursor, end)).trim(), digests };
}
function syntaxSpans(node: Parser.SyntaxNode, start: number, end: number): Span[] {
  const spans: Span[] = [];
  const visit = (child: Parser.SyntaxNode): void => {
    if (child.startIndex < start || child.endIndex > end) return;
    if (comments.has(child.type) || child.type === "attribute_declaration" || child.type === "attribute_list") {
      spans.push({ start: child.startIndex, end: child.endIndex,
        replacement: comments.has(child.type) ? "<comment>" : "<attribute>", original: child.text });
      return;
    }
    for (const nested of child.namedChildren) visit(nested);
  };
  for (const child of node.namedChildren) visit(child);
  return spans;
}

/** C, C++, and C# written declarations from the already selected native grammar. */
export function extractCFamily(context: NativeFamilyContext): NativeFamilyResult {
  const { file, dialect, root, ranges } = context;
  if (dialect !== "c" && dialect !== "cpp" && dialect !== "csharp") throw new Error("C-family extractor received another dialect");
  const declarations: Declaration[] = [], limitations = new Set<string>();
  const csharp = dialect === "csharp";
    const localBindingTypes = csharp
      ? new Set(["local_declaration_statement", "local_function_statement", "for_statement", "foreach_statement",
      "using_statement", "fixed_statement", "lambda_expression", "declaration_pattern", "var_pattern",
      "declaration_expression", "catch_clause"])
    : new Set(["declaration", "for_statement", "for_range_loop", "range_based_for_statement", "lambda_expression", "catch_clause"]);
  const add = (node: Parser.SyntaxNode, enclosing: readonly string[], prefix?: Parser.SyntaxNode,
    declaredName?: Parser.SyntaxNode, outer: Parser.SyntaxNode = node, fieldInitializer?: Parser.SyntaxNode | null): void => {
    if (declarations.length >= 4096) { limitations.add("declaration_inventory_limit"); return; }
    const isContainer = (csharp ? csContainers : cContainers).has(node.type);
    const body = field(node, "body") ?? (csharp ? field(node, "accessors") ?? first(node, "extension_body") ??
      (node.type === "property_declaration" && field(node, "value")?.type === "arrow_expression_clause" ? field(node, "value") : null) : null);
    const declarator = field(node, "declarator");
    const fn = csharp ? null : callable(declarator);
    const parameters = csharp ? field(node, "parameters") ?? first(node, "parameter_list") : fn ? field(fn, "parameters") : null;
    const receiver = node.type === "extension_declaration" ? first(node, "receiver_parameter") : undefined;
    const parameterItems = receiver ? [receiver] : parameterNodes(parameters ?? null);
    const nameNode = declaredName ?? (csharp ? node.type === "extension_declaration" ? receiver?.childForFieldName("type") ?? null : field(node, "name") :
      isContainer || node.type === "alias_declaration" ? field(node, "name") : fn ? declaratorName(fn) :
      declarator ? declaratorName(declarator) : null);
    const name = nameNode?.text ?? null;
    const start = prefix?.startIndex ?? outer.startIndex;
    const headerEnd = body?.startIndex ?? node.endIndex;
    const spans = syntaxSpans(outer, start, headerEnd);
    if (prefix) spans.push({ start: prefix.startIndex, end: prefix.endIndex,
      replacement: "<attribute>", original: prefix.text });
    for (const parameter of parameterItems) {
      const value = defaultValue(parameter);
      if (value) spans.push({ start: value.startIndex, end: value.endIndex, replacement: "<default>", original: value.text });
    }
    let outsideInitializer: string | undefined;
    if (csharp) {
      const value = fieldInitializer ?? (field(node, "value") === body ? null : field(node, "value"));
      if (value && value.startIndex < headerEnd) spans.push({ start: value.startIndex, end: value.endIndex,
        replacement: "<default>", original: value.text });
      else if (value) outsideInitializer = hash(value.text);
    } else {
      const value = field(declarator ?? node, "value");
      if (value && value.startIndex < headerEnd) spans.push({ start: value.startIndex, end: value.endIndex,
        replacement: "<default>", original: value.text });
    }
    const masked = masking(file.text, start, headerEnd, spans);
    const valid = name !== null && !damaged(outer, outer.startIndex, headerEnd) && (!prefix || !prefix.hasError);
    if (!valid) limitations.add("declaration_header_incomplete");
    const trailing = fn?.namedChildren.find(child => child.type === "trailing_return_type");
    const resultType = csharp ? field(node, "returns") ?? (!isContainer ? field(node, "type") ??
      first(node, "variable_declaration")?.childForFieldName("type") ?? null : null) :
      trailing?.lastNamedChild ??
      (node.type === "function_definition" || node.type === "declaration" || node.type === "field_declaration" ||
        node.type === "alias_declaration" || node.type === "type_definition" ? field(node, "type") : null);
    const range = ranges.byteRange(start, outer.endIndex);
    const children = body && isContainer ? body.namedChildren.filter(child =>
      (csharp ? csContainers.has(child.type) || csMembers.has(child.type) : cContainers.has(child.type) ||
        ["declaration", "field_declaration", "function_definition", "template_declaration", "type_definition", "alias_declaration"].includes(child.type))) : [];
    if (body && !isContainer && containsAny(body, localBindingTypes)) limitations.add("unmapped_local_syntax");
    let bodyDigest: string | undefined;
    if (body) {
      if (damaged(body, body.startIndex, body.endIndex)) limitations.add("declaration_body_incomplete");
      else {
        let cursor = body.startIndex, direct = "";
        for (const child of children) { direct += file.text.slice(cursor, child.startIndex); cursor = child.endIndex; }
        bodyDigest = hash(direct + file.text.slice(cursor, body.endIndex));
      }
    }
    const declaration: Declaration = Object.freeze({ key: `${node.type}:${name ?? "<anonymous>"}:${range.start_byte}`,
      kind: node.type, name, enclosing, range,
      signature: valid ? masked.signature : "<header extraction incomplete>",
      parameters: valid ? parameterItems.map(parameter => masking(file.text, parameter.startIndex,
        parameter.endIndex, spans).signature) : [],
      result: valid ? resultType ? { state: "declared" as const,
        syntax: masking(file.text, resultType.startIndex, resultType.endIndex, spans).signature } :
        { state: "not_declared" as const } : { state: "unavailable" as const },
      header_complete: valid, ...(bodyDigest ? { body_digest: bodyDigest } : {}),
      default_digests: outsideInitializer ? [...masked.digests, outsideInitializer] : masked.digests });
    declarations.push(declaration);
    if (body && isContainer) walk(body, [...enclosing, name ?? "<anonymous>"]);
  };
  const walk = (parent: Parser.SyntaxNode, enclosing: readonly string[]): void => {
    let pending: Parser.SyntaxNode | undefined;
    let currentScope = enclosing;
    for (const node of parent.namedChildren) {
      if (comments.has(node.type)) continue;
      if (csharp) {
        if (node.type === "attribute_list") {
          if (pending) limitations.add("unmapped_attribute_syntax");
          pending = node; continue;
        }
        if (node.type === "field_declaration") {
          const variables = node.namedChildren.filter(child => child.type === "variable_declaration")
            .flatMap(child => child.namedChildren.filter(nested => nested.type === "variable_declarator"));
          if (variables.length !== 1) limitations.add("unmapped_member_syntax");
          const variable = variables[0];
          if (variable) add(node, currentScope, pending, field(variable, "name") ?? undefined, node, defaultValue(variable));
        } else if (csContainers.has(node.type) || csMembers.has(node.type)) {
          add(node, currentScope, pending);
          if (node.type === "file_scoped_namespace_declaration") currentScope = [...currentScope, field(node, "name")?.text ?? "<anonymous>"];
        }
        else if (node.type === "global_statement") limitations.add("unmapped_top_level_syntax");
        else if (!cOpaque.has(node.type) && node.type !== "using_directive" &&
          node.type !== "extern_alias_directive") limitations.add("unmapped_member_syntax");
      } else if (node.type === "template_declaration") {
        const wrapped = node.namedChildren.find(child => child.type !== "template_parameter_list" && child.type !== "requires_clause");
        if (wrapped) {
          if (wrapped.type === "function_definition" || wrapped.type === "declaration" || cContainers.has(wrapped.type)) {
            add(wrapped, enclosing, pending, wrapped.type === "function_definition" || wrapped.type === "declaration" ?
              declaratorName(callable(field(wrapped, "declarator")) ?? field(wrapped, "declarator") ?? wrapped) ?? undefined :
              field(wrapped, "name") ?? undefined, node);
          } else limitations.add("unmapped_template_syntax");
        } else limitations.add("unmapped_template_syntax");
      } else if (node.type === "preproc_if" || node.type === "preproc_ifdef" || node.type === "preproc_else" || node.type === "preproc_elif") {
        limitations.add("preprocessor_alternatives_unresolved");
        const branch = `${node.type}@${ranges.byteOffset(node.startIndex)}`;
        walk(node, [...enclosing, branch]);
      } else if (node.type === "identifier" && parent.type.startsWith("preproc_")) continue;
      else if (cContainers.has(node.type)) add(node, enclosing, pending);
      else if (node.type === "function_definition" || node.type === "declaration" || node.type === "field_declaration") {
        if (callable(field(node, "declarator"))) add(node, enclosing, pending ?? undefined);
        else if (node.type === "declaration" && field(node, "declarator")) add(node, enclosing, pending ?? undefined);
        else if (node.type === "field_declaration") add(node, enclosing, pending ?? undefined);
        else limitations.add("unmapped_declaration_syntax");
      } else if (node.type === "type_definition" || node.type === "alias_declaration") add(node, enclosing, pending);
      else if (node.type !== "access_specifier" && !cOpaque.has(node.type)) limitations.add("unmapped_top_level_syntax");
      pending = undefined;
    }
    if (pending) limitations.add("unmapped_attribute_syntax");
  };
  walk(root, []);
  return { declarations, limitations: [...limitations] };
}
