import type Parser from "tree-sitter";

/** Native binding-pattern initializers only; types and initializer bodies are not traversed. */
export function parameterDefaultValues(parameters: readonly Parser.SyntaxNode[]): Parser.SyntaxNode[] {
  const values: Parser.SyntaxNode[] = [];
  for (const parameter of parameters) {
    const direct = parameter.childForFieldName("value");
    if (direct) values.push(direct);
    const pattern = parameter.childForFieldName("pattern");
    if (!pattern) continue;
    const pending = [pattern];
    while (pending.length) {
      const node = pending.pop()!;
      if (node.type === "assignment_pattern" || node.type === "object_assignment_pattern") {
        const value = node.childForFieldName("right");
        if (value) values.push(value);
        // A nested binding on the left may itself contain an independent default.
        const left = node.childForFieldName("left");
        if (left) pending.push(left);
        continue;
      }
      // Computed keys and annotation expressions are not binding patterns.
      if (node.type === "pair_pattern") {
        const value = node.childForFieldName("value");
        if (value) pending.push(value);
      } else if (node.type === "object_pattern" || node.type === "array_pattern" || node.type === "rest_pattern") {
        for (let index = node.namedChildren.length - 1; index >= 0; index--) pending.push(node.namedChildren[index]!);
      }
    }
  }
  return values;
}
