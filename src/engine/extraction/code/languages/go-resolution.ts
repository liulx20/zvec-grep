import type { TSNode } from "../tree-sitter/nodes.js";

/** Declaring type + field name -> declared type for Go receiver chains. */
export function collectGoDeclaredFieldTypes(
  node: TSNode,
): ReadonlyMap<string, string> {
  const fields = new Map<string, string>();
  const visit = (current: TSNode): void => {
    if (current.type === "type_spec") {
      const owner = current.childForFieldName("name")?.text;
      const type = current.childForFieldName("type");
      if (owner && type?.type === "struct_type")
        collectStructFields(owner, type, fields);
      return;
    }
    for (const child of current.namedChildren ?? []) visit(child);
  };
  visit(syntaxRoot(node));
  return fields;
}

/** Callable name -> first declared result type for chained factory calls. */
export function collectGoCallableReturnTypes(
  node: TSNode,
): ReadonlyMap<string, string> {
  const returns = new Map<string, string>();
  const visit = (current: TSNode): void => {
    if (
      current.type === "function_declaration" ||
      current.type === "method_declaration"
    ) {
      const name = current.childForFieldName("name")?.text;
      const result = current.childForFieldName("result");
      const returnType = result ? firstReturnType(result.text) : undefined;
      if (name && returnType) returns.set(name, returnType);
      return;
    }
    for (const child of current.namedChildren ?? []) visit(child);
  };
  visit(syntaxRoot(node));
  return returns;
}

function collectStructFields(
  owner: string,
  struct: TSNode,
  fields: Map<string, string>,
): void {
  const visit = (current: TSNode): void => {
    if (current.type === "field_declaration") {
      const type = current.childForFieldName("type");
      if (!type) return;
      const names = (current.namedChildren ?? [])
        .filter(
          (child) =>
            child.endIndex <= type.startIndex &&
            /^(?:field_)?identifier$/.test(child.type),
        )
        .map((child) => child.text);
      for (const name of names)
        fields.set(`${owner}.${name}`, normalizeGoType(type.text));
      return;
    }
    for (const child of current.namedChildren ?? []) visit(child);
  };
  visit(struct);
}

function firstReturnType(result: string): string | undefined {
  const first = result
    .trim()
    .replace(/^\(|\)$/g, "")
    .split(",", 1)[0]
    ?.trim();
  if (!first) return undefined;
  const type = first.split(/\s+/).at(-1);
  return type ? normalizeGoType(type) : undefined;
}

function normalizeGoType(value: string): string {
  return value
    .replace(/^\*+/, "")
    .replace(/\[.*\]$/, "")
    .trim();
}

function syntaxRoot(node: TSNode): TSNode {
  let root = node;
  while (root.parent) root = root.parent;
  return root;
}
