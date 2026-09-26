import { createHash } from "node:crypto";
import type Parser from "tree-sitter";
import { BridgeError } from "../core/errors.js";
import type { Declaration } from "./model.js";
import type { NativeFamilyContext, NativeFamilyResult } from "./language-common.js";

type Node = Parser.SyntaxNode;
type Span = Readonly<{ start: number; end: number; marker: string; value: string }>;
const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
const comments = new Set(["line_comment", "block_comment", "comment", "multiline_comment"]);
const containers = new Set(["struct_declaration", "enum_declaration", "union_declaration", "opaque_declaration"]);
const odinContainers = new Set(["struct_declaration", "enum_declaration", "union_declaration"]);
const MAX_DECLARATIONS = 4096;

function first(node: Node, type: string): Node | undefined { return node.namedChildren.find(child => child.type === type); }
function byType(node: Node, types: ReadonlySet<string>): Node | undefined {
  return node.namedChildren.find(child => types.has(child.type));
}
function damage(node: Node, start: number, end: number): boolean {
  if (!node.hasError && !node.isMissing) return false;
  if ((node.type === "ERROR" || node.isMissing) && node.startIndex <= end && node.endIndex >= start) return true;
  return node.children.some(child => child.startIndex <= end && child.endIndex >= start && damage(child, start, end));
}
function masked(source: string, start: number, end: number, spans: readonly Span[]): string {
  const ordered = [...spans].filter(span => span.start >= start && span.end <= end)
    .sort((a, b) => a.start - b.start || b.end - a.end);
  let cursor = start, out = "";
  for (const span of ordered) {
    if (span.start < cursor) continue;
    out += source.slice(cursor, span.start) + span.marker;
    cursor = span.end;
  }
  return (out + source.slice(cursor, end)).trim();
}
function maskValue(node: Node): Span { return { start: node.startIndex, end: node.endIndex, value: node.text, marker: "<default>" }; }
function parameterValues(parameters: Node | undefined): Span[] {
  if (!parameters) return [];
  const spans: Span[] = [];
  const children = parameters.namedChildren;
  for (let index = 0; index < children.length; index++) {
    const child = children[index]!;
    if (child.type === "parameter" || child.type === "class_parameter") {
      const next = children[index + 1];
      if (next && next.type !== "parameter" && next.type !== "class_parameter" &&
          parameters.text.slice(child.endIndex - parameters.startIndex, next.startIndex - parameters.startIndex).includes("=")) {
        spans.push(maskValue(next));
      } else {
        const value = child.namedChildren.at(-1);
        if (value && value !== child.namedChildren[0] &&
            child.text.slice(0, value.startIndex - child.startIndex).includes("=")) spans.push(maskValue(value));
      }
    }
  }
  return spans;
}
function maskedParameters(source: string, parameters: Node | undefined, spans: readonly Span[]): string[] {
  if (!parameters) return [];
  return parameters.namedChildren.filter(node => node.type === "parameter" || node.type === "class_parameter")
    .map(node => {
      const trailing = spans.find(span => span.start >= node.endIndex &&
        source.slice(node.endIndex, span.start).trim().startsWith("="));
      return masked(source, node.startIndex, trailing?.end ?? node.endIndex, spans);
    });
}
function headerComments(node: Node, end: number): Span[] {
  const spans: Span[] = [];
  const visit = (child: Node): void => {
    if (child.startIndex >= end) return;
    if (comments.has(child.type)) {
      spans.push({ start: child.startIndex, end: child.endIndex, marker: "<comment>", value: child.text });
      return;
    }
    for (const nested of child.namedChildren) visit(nested);
  };
  visit(node);
  return spans;
}
function containsNested(node: Node, types: ReadonlySet<string>): boolean {
  return node.namedChildren.some(child => types.has(child.type) || containsNested(child, types));
}
function containsZigLocalDeclaration(node: Node): boolean {
  return node.namedChildren.some(child =>
    (child.type === "variable_declaration" && /^(?:pub\s+)?(?:const|var)\b/.test(child.text.trim())) ||
    containsZigLocalDeclaration(child));
}
function bodyDigest(source: string, body: Node | undefined, excluded: readonly Node[]): string | undefined {
  if (!body || damage(body, body.startIndex, body.endIndex)) return undefined;
  const start = odinContainers.has(body.type) ? body.children.find(child => child.type === "{")?.startIndex ?? body.startIndex
    : body.startIndex;
  let cursor = start, remaining = "";
  for (const child of [...excluded].sort((a, b) => a.startIndex - b.startIndex)) {
    if (child.startIndex < cursor || child.endIndex > body.endIndex) continue;
    remaining += source.slice(cursor, child.startIndex);
    cursor = child.endIndex;
  }
  return hash(remaining + source.slice(cursor, body.endIndex));
}

/** Extract only declarations whose written headers are represented by the pinned Kotlin, Zig, and Odin grammars. */
export function extractKotlinZigOdin(context: NativeFamilyContext): NativeFamilyResult {
  const { file, dialect, root, ranges } = context;
  if (dialect !== "kotlin" && dialect !== "zig" && dialect !== "odin") {
    throw new BridgeError("STRUCTURAL_DIALECT_UNSUPPORTED", "This extractor does not own the selected dialect");
  }
  const declarations: Declaration[] = [];
  const limitations = new Set<string>();
  const source = file.text;
  const localBindingTypes = dialect === "kotlin"
    ? new Set(["property_declaration", "variable_declaration", "for_statement", "when_expression", "lambda_literal", "catch_block"])
    : dialect === "zig" ? new Set(["for_statement", "if_statement", "while_statement", "switch_expression", "payload"])
      : new Set(["variable_declaration", "short_variable_declaration", "const_declaration", "assignment_statement", "for_statement", "range_statement"]);
  const push = (node: Node, name: string | null, enclosing: readonly string[], headerEnd: number,
    parameters: Node | undefined, result: Node | undefined, body: Node | undefined,
    defaultSpans: readonly Span[] = [], attributeSpans: readonly Span[] = [], nested: readonly Node[] = []): void => {
    if (declarations.length >= MAX_DECLARATIONS) throw new BridgeError("STRUCTURAL_ANALYSIS_CAPACITY", "Native declaration inventory exceeds its bound");
    const spans = [...defaultSpans, ...attributeSpans, ...headerComments(node, headerEnd)];
    const headerComplete = !!name && !!headerEnd && !damage(node, node.startIndex, headerEnd);
    if (!headerComplete) limitations.add("declaration_header_incomplete");
    if (body && damage(body, body.startIndex, body.endIndex)) limitations.add("declaration_body_incomplete");
    const hasLocalBinding = dialect === "zig"
      ? containsZigLocalDeclaration(body ?? node) || containsNested(body ?? node, localBindingTypes)
      : containsNested(body ?? node, localBindingTypes);
    if (body && (dialect === "kotlin" && node.type === "function_declaration" ||
      dialect === "zig" && node.type === "function_declaration" ||
      dialect === "odin" && node.type === "procedure_declaration") && hasLocalBinding) {
      limitations.add("unmapped_local_syntax");
    }
    const range = ranges.byteRange(node.startIndex, node.endIndex);
    const digest = bodyDigest(source, body, nested);
    declarations.push(Object.freeze({
      key: `${node.type}:${name ?? "<anonymous>"}:${range.start_byte}`, kind: node.type, name, enclosing, range,
      signature: headerComplete ? masked(source, node.startIndex, headerEnd, spans) : "<header extraction incomplete>",
      parameters: headerComplete ? maskedParameters(source, parameters, spans) : [],
      result: headerComplete ? result ? { state: "declared" as const,
        syntax: masked(source, result.startIndex, result.endIndex, headerComments(result, result.endIndex)) }
        : { state: "not_declared" as const } : { state: "unavailable" as const },
      header_complete: headerComplete, ...(digest ? { body_digest: digest } : {}),
      default_digests: spans.map(span => hash(span.value)),
    }));
  };
  const ignored = (node: Node): boolean => comments.has(node.type) ||
    ["package_header", "package_declaration", "import", "import_declaration"].includes(node.type);

  const kotlin = (node: Node, enclosing: readonly string[]): void => {
    const nameNode = node.childForFieldName("name") ??
      (node.type === "type_alias" ? node.childForFieldName("type") : undefined) ??
      (node.type === "property_declaration" ? first(node, "variable_declaration")?.namedChildren[0] : undefined) ??
      first(node, "identifier");
    const name = node.type === "secondary_constructor" ? "constructor" : nameNode?.text ?? null;
    const body = byType(node, new Set(["class_body", "enum_class_body", "function_body", "block", "getter", "setter"]));
    const parameterHolder = first(node, "function_value_parameters") ?? first(node, "primary_constructor");
    const parameters = parameterHolder?.type === "primary_constructor" ? first(parameterHolder, "class_parameters") : parameterHolder;
    const children = node.namedChildren;
    const result = node.type === "type_alias" ? children.find(child => child.startIndex > (nameNode?.endIndex ?? 0) &&
      child.type !== "identifier") : node.type === "property_declaration" ? first(node, "variable_declaration")?.namedChildren
      .find(child => child.type.endsWith("type")) : node.type === "function_declaration" ?
        children.find(child => child.startIndex > (parameters?.endIndex ?? 0) && child !== body &&
          (child.type.endsWith("type") || child.type === "nullable_type")) : undefined;
    const defaults = parameterValues(parameters);
    if (node.type === "property_declaration") {
      const variable = first(node, "variable_declaration");
      const initializer = children.find(child => child.startIndex >= (variable?.endIndex ?? 0) && child !== variable &&
        source.slice(variable?.endIndex ?? 0, child.startIndex).includes("="));
      if (initializer) defaults.push(maskValue(initializer));
    }
    const modifiers = first(node, "modifiers");
    const attrs = modifiers?.namedChildren.filter(child => child.type === "annotation").map(child =>
      ({ start: child.startIndex, end: child.endIndex, marker: "<attribute>", value: child.text })) ?? [];
    const headerEnd = body?.startIndex ?? node.endIndex;
    const nested = body?.namedChildren.filter(child => ["function_declaration", "secondary_constructor", "property_declaration", "class_declaration", "type_alias", "enum_entry"].includes(child.type)) ?? [];
    push(node, name, enclosing, headerEnd, parameters, result, body, defaults, attrs, nested);
    if (body && node.type === "function_declaration" && containsNested(body,
      new Set(["function_declaration", "class_declaration", "object_declaration", "type_alias"]))) {
      limitations.add("nested_declaration_coverage_unavailable");
    }
    if (body && ["class_declaration", "object_declaration"].includes(node.type)) {
      for (const child of body.namedChildren) {
        if (["function_declaration", "secondary_constructor", "property_declaration", "class_declaration", "type_alias", "enum_entry"].includes(child.type)) kotlin(child, [...enclosing, name ?? "<anonymous>"]);
        else if (!ignored(child)) limitations.add("unmapped_member_syntax");
      }
    }
  };

  const zig = (node: Node, enclosing: readonly string[], containerName?: string): void => {
    if (node.type === "function_declaration") {
      const name = node.childForFieldName("name")?.text ?? null;
      const parameters = first(node, "parameters");
      const body = node.childForFieldName("body") ?? first(node, "block");
      const result = node.childForFieldName("type") ?? node.namedChildren.find(child =>
        child.startIndex >= (parameters?.endIndex ?? 0) && child !== body);
      push(node, name, enclosing, body?.startIndex ?? node.endIndex, parameters, result, body);
      return;
    }
    if (node.type === "container_field") {
      const name = node.childForFieldName("name")?.text ?? first(node, "identifier")?.text ?? null;
      const result = node.childForFieldName("type");
      const initializer = result ? node.namedChildren.find(child => child.startIndex > result.endIndex) : undefined;
      push(node, name, enclosing, node.endIndex, undefined, result ?? undefined, undefined,
        initializer ? [maskValue(initializer)] : []);
      return;
    }
    if (node.type !== "variable_declaration") { limitations.add("unmapped_top_level_syntax"); return; }
    const nameNode = first(node, "identifier");
    const value = node.namedChildren.find(child => child.startIndex > (nameNode?.endIndex ?? 0));
    if (value?.type === "builtin_function" && value.text.startsWith("@import")) return;
    const container = value && containers.has(value.type) ? value : undefined;
    const open = container?.children.find(child => child.type === "{");
    const body = container;
    const members = container?.namedChildren.filter(child => child.startIndex > (open?.startIndex ?? 0)) ?? [];
    const isAlias = value && ["builtin_type", "pointer_type", "array_type", "optional_type"].includes(value.type);
    if (value?.type === "identifier") limitations.add("ambiguous_constant_type_value");
    push(node, nameNode?.text ?? null, enclosing, open?.startIndex ?? node.endIndex,
      undefined, isAlias ? value : undefined, body,
      !container && !isAlias && value ? [maskValue(value)] : [], [], members);
    if (container) for (const member of members) {
      if (member.type === "function_declaration" || member.type === "container_field") zig(member, [...enclosing, containerName ?? nameNode?.text ?? "<anonymous>"]);
      else if (!comments.has(member.type)) limitations.add("unmapped_member_syntax");
    }
  };

  const odin = (node: Node, enclosing: readonly string[]): void => {
    const attributes = first(node, "attributes");
    const nameNode = node.namedChildren.find(child => child !== attributes);
    const name = nameNode?.type === "member_expression" ? nameNode.text : nameNode?.text ?? null;
    const attrs = attributes ? [{ start: attributes.startIndex, end: attributes.endIndex,
      marker: "<attribute>", value: attributes.text }] : [];
    if (node.type === "procedure_declaration") {
      const proc = first(node, "procedure");
      const parameters = proc && first(proc, "parameters");
      const result = proc && first(proc, "type");
      const body = proc && first(proc, "block");
      push(node, name, enclosing, body?.startIndex ?? node.endIndex, parameters, result, body, parameterValues(parameters), attrs);
      return;
    }
    if (node.type === "overloaded_procedure_declaration") {
      push(node, name, enclosing, node.endIndex, undefined, undefined, undefined, [], attrs);
      return;
    }
    if (odinContainers.has(node.type)) {
      const open = node.children.find(child => child.type === "{");
      const members = node.namedChildren.filter(child => child !== attributes && child !== nameNode);
      push(node, name, enclosing, open?.startIndex ?? node.endIndex, undefined, undefined, node, [], attrs, members);
      for (const member of members) {
        if (member.type === "field" || (node.type === "enum_declaration" && member.type === "identifier") ||
            (node.type === "union_declaration" && member.type === "type")) {
          const fieldName = member.namedChildren[0]?.text ?? member.text;
          push(member, fieldName, [...enclosing, name ?? "<anonymous>"], member.endIndex, undefined,
            member.type === "field" ? first(member, "type") : member.type === "type" ? member : undefined, undefined);
        } else if (!comments.has(member.type)) limitations.add("unmapped_member_syntax");
      }
      return;
    }
    if (node.type === "const_declaration") {
      const value = node.namedChildren.find(child => child.startIndex >= (nameNode?.endIndex ?? 0) && child !== nameNode);
      const typeLike = value && ["identifier", "type", "pointer_type", "array_type"].includes(value.type);
      push(node, name, enclosing, node.endIndex, undefined, typeLike ? value : undefined, undefined,
        value && !typeLike ? [maskValue(value)] : [], attrs);
      return;
    }
    limitations.add("unmapped_top_level_syntax");
  };

  for (const node of root.namedChildren) {
    if (ignored(node)) continue;
    if (dialect === "kotlin") {
      if (["function_declaration", "class_declaration", "object_declaration", "type_alias", "property_declaration"].includes(node.type)) kotlin(node, []);
      else limitations.add("unmapped_top_level_syntax");
    } else if (dialect === "zig") {
      if (["function_declaration", "variable_declaration"].includes(node.type)) zig(node, []);
      else limitations.add("unmapped_top_level_syntax");
    } else {
      if (["procedure_declaration", "overloaded_procedure_declaration", "struct_declaration", "enum_declaration", "union_declaration", "const_declaration"].includes(node.type)) odin(node, []);
      else limitations.add("unmapped_top_level_syntax");
    }
  }
  return { declarations, limitations: [...limitations].sort() };
}
