import { createHash } from "node:crypto";
import type Parser from "tree-sitter";
import { BridgeError } from "../core/errors.js";
import type { Declaration } from "./model.js";
import type { NativeFamilyContext, NativeFamilyExtractor, NativeFamilyResult } from "./language-common.js";

const digest = (text: string): string => createHash("sha256").update(text).digest("hex");
const LIMIT = 4096;
type Span = Readonly<{ start: number; end: number; marker: string; digest: string }>;

function mask(text: string, start: number, spans: readonly Span[]): string {
  let cursor = 0, result = "";
  for (const span of [...spans].sort((a, b) => a.start - b.start || b.end - a.end)) {
    const from = span.start - start, to = span.end - start;
    if (from < cursor || from < 0 || to > text.length) {
      throw new BridgeError("STRUCTURAL_EXTRACTION_INVALID", "Native masked value escaped its declaration header");
    }
    result += text.slice(cursor, from) + span.marker;
    cursor = to;
  }
  return (result + text.slice(cursor)).trim();
}

function damaged(node: Parser.SyntaxNode): boolean {
  return node.hasError || node.isMissing;
}

function headerDamaged(node: Parser.SyntaxNode, before: number): boolean {
  if (node.type === "ERROR" && node.startIndex < before) return true;
  if (node.isMissing && node.startIndex <= before) return true;
  return node.namedChildren.some(child => child.startIndex < before && headerDamaged(child, before));
}

function headerComments(node: Parser.SyntaxNode, start: number, end: number): Span[] {
  const found: Span[] = [];
  const walk = (child: Parser.SyntaxNode): void => {
    if (child.startIndex >= end) return;
    if (child.type === "comment" && child.startIndex >= start && child.endIndex <= end) {
      found.push({ start: child.startIndex, end: child.endIndex, marker: "<comment>", digest: digest(child.text) });
      return;
    }
    for (const nested of child.namedChildren) walk(nested);
  };
  walk(node);
  return found;
}

function typeDefaultNodes(node: Parser.SyntaxNode | null): Parser.SyntaxNode[] {
  if (!node) return [];
  const found: Parser.SyntaxNode[] = [];
  const visit = (child: Parser.SyntaxNode): void => {
    if (child.type === "default_type_parameter") {
      const value = child.childForFieldName("default");
      if (value) found.push(value);
      return;
    }
    for (const nested of child.namedChildren) visit(nested);
  };
  visit(node);
  return found;
}

function maskedTypeSyntax(node: Parser.SyntaxNode): string {
  return mask(node.text, node.startIndex, headerComments(node, node.startIndex, node.endIndex));
}

function bodyMarker(context: NativeFamilyContext, body: Parser.SyntaxNode | null,
  children: readonly Parser.SyntaxNode[], limitations: Set<string>): string | undefined {
  if (!body) return undefined;
  if (damaged(body)) { limitations.add("declaration_body_incomplete"); return undefined; }
  let cursor = body.startIndex, retained = "";
  for (const child of [...children].sort((a, b) => a.startIndex - b.startIndex)) {
    if (child.startIndex < cursor) continue;
    retained += context.file.text.slice(cursor, child.startIndex);
    cursor = child.endIndex;
  }
  return digest(retained + context.file.text.slice(cursor, body.endIndex));
}

function addDeclaration(output: Declaration[], node: Parser.SyntaxNode, context: NativeFamilyContext,
  enclosing: readonly string[], name: string | null, signature: string, parameters: readonly string[],
  result: Declaration["result"], headerComplete: boolean, defaultDigests: readonly string[],
  bodyDigest?: string, rangeStart = node.startIndex): void {
  if (output.length >= LIMIT) throw new BridgeError("STRUCTURAL_ANALYSIS_CAPACITY", "Native declaration inventory exceeds its bound");
  const range = context.ranges.byteRange(rangeStart, node.endIndex);
  output.push(Object.freeze({ key: `${node.type}:${name ?? "<anonymous>"}:${range.start_byte}`,
    kind: node.type, name, enclosing: Object.freeze([...enclosing]), range,
    signature: headerComplete ? signature : "<header extraction incomplete>",
    parameters: headerComplete ? Object.freeze([...parameters]) : [],
    result: headerComplete ? result : ({ state: "unavailable" } as const), header_complete: headerComplete,
    ...(bodyDigest ? { body_digest: bodyDigest } : {}), default_digests: Object.freeze([...defaultDigests]) }));
}

function pythonAssignment(node: Parser.SyntaxNode | undefined, outer: Parser.SyntaxNode, context: NativeFamilyContext,
  enclosing: readonly string[], output: Declaration[], limitations: Set<string>): boolean {
  if (node?.type !== "assignment") return false;
  const left = node.childForFieldName("left"), right = node.childForFieldName("right");
  if (!left || left.type !== "identifier" || damaged(node)) {
    limitations.add("unmapped_member_syntax"); return true;
  }
  const spans: Span[] = [
    ...(right ? [{ start: right.startIndex, end: right.endIndex,
      marker: "<default>", digest: digest(right.text) }] : []),
    ...headerComments(outer, outer.startIndex, outer.endIndex).filter(comment => !right ||
      comment.start < right.startIndex || comment.end > right.endIndex),
  ];
  const signature = mask(context.file.text.slice(outer.startIndex, outer.endIndex), outer.startIndex, spans);
  const annotation = node.childForFieldName("type");
  addDeclaration(output, outer, context, enclosing, left.text, signature, [],
    annotation ? { state: "declared", syntax: maskedTypeSyntax(annotation) } : { state: "not_declared" },
    true, spans.map(span => span.digest));
  return true;
}

/** Python 3.14 selected syntax: declarations, classes, annotations, aliases and direct members. */
export const extractPythonFamily: NativeFamilyExtractor = (context): NativeFamilyResult => {
  const output: Declaration[] = [], limitations = new Set<string>();
  const visit = (outer: Parser.SyntaxNode, enclosing: readonly string[], depth: number): void => {
    if (depth > 64) throw new BridgeError("STRUCTURAL_ANALYSIS_CAPACITY", "Native declaration nesting exceeds its bound");
    const node = outer.type === "decorated_definition" ? outer.childForFieldName("definition") : outer;
    if (!node) { limitations.add("unmapped_member_syntax"); return; }
    if (node.type === "function_definition" || node.type === "class_definition") {
      const isFunction = node.type === "function_definition";
      const nameNode = node.childForFieldName("name"), body = node.childForFieldName("body");
      const params = isFunction ? node.childForFieldName("parameters") : null;
      const start = outer.startIndex, headerEnd = body?.startIndex ?? node.endIndex;
      const decorators = outer === node ? [] : outer.namedChildren.filter(child => child.type === "decorator");
      const defaultNodes = [
        ...(params?.namedChildren.map(child => child.childForFieldName("value"))
          .filter((value): value is Parser.SyntaxNode => !!value) ?? []),
        ...typeDefaultNodes(node.childForFieldName("type_parameters")),
      ];
      const spans: Span[] = [...decorators.map(child => ({ start: child.startIndex, end: child.endIndex,
        marker: "<attribute>", digest: digest(child.text) })),
        ...defaultNodes.map(child => ({ start: child.startIndex, end: child.endIndex,
          marker: "<default>", digest: digest(child.text) })),
        ...headerComments(node, start, headerEnd).filter(comment => !defaultNodes.some(value =>
          comment.start >= value.startIndex && comment.end <= value.endIndex))];
      const header = mask(context.file.text.slice(start, headerEnd), start, spans);
      const headerComplete = !!nameNode && (!isFunction || !!params) &&
        !headerDamaged(node, headerEnd) && !decorators.some(damaged);
      if (!headerComplete) limitations.add("declaration_header_incomplete");
      const parameters = params?.namedChildren.map(parameter => mask(parameter.text, parameter.startIndex,
        spans.filter(span => span.start >= parameter.startIndex && span.end <= parameter.endIndex))) ?? [];
      const direct: Parser.SyntaxNode[] = [];
      if (body) for (const child of body.namedChildren) {
        const unwrapped = child.type === "decorated_definition" ? child.childForFieldName("definition") : child;
        if (unwrapped?.type === "function_definition" || unwrapped?.type === "class_definition") direct.push(child);
        else if (!isFunction && child.type === "assignment") direct.push(child);
        else if (!isFunction && child.type === "expression_statement" &&
          child.namedChildren[0]?.type === "assignment") direct.push(child);
        else if (!isFunction && child.type !== "comment" && child.type !== "pass_statement") limitations.add("unmapped_member_syntax");
      }
      const bodyDigest = bodyMarker(context, body, direct, limitations);
      addDeclaration(output, outer, context, enclosing, nameNode?.text ?? null, header, parameters,
        isFunction && node.childForFieldName("return_type") ?
          { state: "declared", syntax: maskedTypeSyntax(node.childForFieldName("return_type")!) } : { state: "not_declared" },
        headerComplete, spans.map(span => span.digest), bodyDigest, start);
      for (const child of direct) {
        if (child.type === "expression_statement" || child.type === "assignment") {
          pythonAssignment(child.type === "assignment" ? child : child.namedChildren[0], child,
            context, [...enclosing, nameNode?.text ?? "<anonymous>"], output, limitations);
        } else visit(child, [...enclosing, nameNode?.text ?? "<anonymous>"], depth + 1);
      }
      return;
    }
    if (node.type === "type_alias_statement") {
      const left = node.childForFieldName("left"), right = node.childForFieldName("right");
      const headerComplete = !!left && !!right && !damaged(node);
      if (!headerComplete) limitations.add("declaration_header_incomplete");
      const defaults = typeDefaultNodes(left);
      const spans = [...defaults.map(value => ({ start: value.startIndex, end: value.endIndex,
        marker: "<default>", digest: digest(value.text) })),
        ...headerComments(node, node.startIndex, node.endIndex).filter(comment => !defaults.some(value =>
          comment.start >= value.startIndex && comment.end <= value.endIndex))];
      const aliasName = left?.namedChildren[0]?.type === "generic_type" ?
        left.namedChildren[0].namedChildren[0]?.text ?? null : left?.text ?? null;
      addDeclaration(output, node, context, enclosing, aliasName,
        mask(node.text, node.startIndex, spans), [],
        right ? { state: "declared", syntax: maskedTypeSyntax(right) } : { state: "unavailable" },
        headerComplete, spans.map(span => span.digest));
      return;
    }
    if ((node.type === "assignment" || node.type === "expression_statement") &&
      pythonAssignment(node.type === "assignment" ? node : node.namedChildren[0], node, context,
        enclosing, output, limitations)) return;
    if (!["comment", "import_statement", "import_from_statement", "future_import_statement"].includes(node.type)) {
      limitations.add(enclosing.length ? "unmapped_member_syntax" : "unmapped_top_level_syntax");
    }
  };
  for (const node of context.root.namedChildren) visit(node, [], 0);
  return { declarations: output, limitations: [...limitations] };
};

function luaAssignment(node: Parser.SyntaxNode, outer: Parser.SyntaxNode, context: NativeFamilyContext,
  enclosing: readonly string[], output: Declaration[], limitations: Set<string>): boolean {
  if (node.type !== "assignment_statement") return false;
  const names = node.namedChildren.find(child => child.type === "variable_list");
  const values = node.namedChildren.find(child => child.type === "expression_list");
  if (!names || !values || names.namedChildren.length !== 1 || values.namedChildren.length !== 1 || damaged(node)) {
    limitations.add("unmapped_top_level_syntax"); return true;
  }
  const name = names.namedChildren[0]!, value = values.namedChildren[0]!;
  if (!["identifier", "dot_index_expression"].includes(name.type)) {
    limitations.add("unmapped_top_level_syntax"); return true;
  }
  if (value.type === "function_definition") {
    limitations.add("unmapped_top_level_syntax"); return true;
  }
  const span = { start: value.startIndex, end: value.endIndex, marker: "<default>", digest: digest(value.text) };
  addDeclaration(output, outer, context, enclosing, name.text,
    mask(outer.text, outer.startIndex, [span]), [], { state: "not_declared" }, true, [span.digest]);
  return true;
}

/** Standard Lua 5.5 syntax; ordinary Lua has no written parameter or result types. */
export const extractLuaFamily: NativeFamilyExtractor = (context): NativeFamilyResult => {
  const output: Declaration[] = [], limitations = new Set<string>();
  const visit = (outer: Parser.SyntaxNode, enclosing: readonly string[], depth: number): void => {
    if (depth > 64) throw new BridgeError("STRUCTURAL_ANALYSIS_CAPACITY", "Native declaration nesting exceeds its bound");
    const declaration = outer.type === "variable_declaration" ? outer.namedChildren[0] : outer;
    if (!declaration) { limitations.add("unmapped_top_level_syntax"); return; }
    if (declaration.type === "assignment_statement") {
      const names = declaration.namedChildren.find(child => child.type === "variable_list");
      const values = declaration.namedChildren.find(child => child.type === "expression_list");
      const value = values?.namedChildren[0];
      if (value?.type === "function_definition" && names?.namedChildren.length === 1 &&
        values?.namedChildren.length === 1 && names.namedChildren[0]?.type === "identifier") {
        const name = names.namedChildren[0]!.text, params = value.childForFieldName("parameters");
        const body = value.childForFieldName("body");
        const headerEnd = body?.startIndex ?? value.endIndex;
        const headerComplete = !!params && !headerDamaged(declaration, headerEnd);
        if (!headerComplete) limitations.add("declaration_header_incomplete");
        const children = body?.namedChildren.filter(child => child.type === "function_declaration" ||
          child.type === "variable_declaration") ?? [];
        const bodyDigest = bodyMarker(context, body, children, limitations);
        const comments = headerComments(outer, outer.startIndex, headerEnd);
        addDeclaration(output, outer, context, enclosing, name,
          mask(context.file.text.slice(outer.startIndex, headerEnd), outer.startIndex, comments),
          params?.namedChildren.map(child => mask(child.text, child.startIndex,
            comments.filter(span => span.start >= child.startIndex && span.end <= child.endIndex))) ?? [],
          { state: "not_declared" }, headerComplete, comments.map(span => span.digest), bodyDigest);
        for (const child of children) visit(child, [...enclosing, name], depth + 1);
        return;
      }
      luaAssignment(declaration, outer, context, enclosing, output, limitations);
      return;
    }
    if (declaration.type === "function_declaration") {
      const nameNode = declaration.childForFieldName("name"), params = declaration.childForFieldName("parameters");
      const body = declaration.childForFieldName("body");
      const headerEnd = body?.startIndex ?? declaration.endIndex;
      const headerComplete = !!nameNode && !!params && !headerDamaged(declaration, headerEnd);
      if (!headerComplete) limitations.add("declaration_header_incomplete");
      const children = body?.namedChildren.filter(child => child.type === "function_declaration" ||
        child.type === "variable_declaration") ?? [];
      const bodyDigest = bodyMarker(context, body, children, limitations);
      const comments = headerComments(outer, outer.startIndex, headerEnd);
      addDeclaration(output, outer, context, enclosing, nameNode?.text ?? null,
        mask(context.file.text.slice(outer.startIndex, headerEnd), outer.startIndex, comments),
        params?.namedChildren.map(child => mask(child.text, child.startIndex,
          comments.filter(span => span.start >= child.startIndex && span.end <= child.endIndex))) ?? [],
        { state: "not_declared" }, headerComplete, comments.map(span => span.digest), bodyDigest);
      for (const child of children) visit(child, [...enclosing, nameNode?.text ?? "<anonymous>"], depth + 1);
      return;
    }
    if (declaration.type !== "comment") limitations.add("unmapped_top_level_syntax");
  };
  for (const node of context.root.namedChildren) visit(node, [], 0);
  return { declarations: output, limitations: [...limitations] };
};
