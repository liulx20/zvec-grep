import type { TSNode } from "./tree-sitter/nodes.js";
import { findIdentifierLeaf } from "./tree-sitter/nodes.js";
import { FUNCTION_POINTER_ARRAY_CONTAINER } from "../../reference-target.js";

export type CFunctionPointerRegistration = {
  containerType: string;
  field: string;
};

/**
 * Recover the `(struct type, function-pointer field)` key for a concrete
 * function used in a C/C++ initializer or direct field assignment.
 *
 * Direct field assignment and designated initialization already provide a
 * precise `(container type, field)` slot while the value is independently
 * known to be a function. They therefore remain valid when the struct lives in
 * an included header. Positional initialization still requires the local field
 * declaration because its array index has no field name of its own.
 */
export function cFunctionPointerRegistration(
  node: TSNode,
  language: string,
): CFunctionPointerRegistration | undefined {
  if (language !== "c" && language !== "cpp") return undefined;
  const root = syntaxRoot(node);

  const assignment = ancestor(node, (item) =>
    ["assignment_expression", "assignment"].includes(item.type),
  );
  if (assignment) {
    const left =
      assignment.childForFieldName("left") ??
      assignment.childForFieldName("target") ??
      assignment.namedChildren[0];
    const field = fieldAccess(left);
    const containerType = field
      ? receiverTypeInEnclosingCallable(assignment, field.receiver)
      : undefined;
    if (field && containerType) return { containerType, field: field.field };
  }

  const declaration = ancestor(node, (item) => item.type === "declaration");
  const containerType = declarationType(declaration);
  if (!declaration || !containerType) return undefined;

  const designated = ancestor(node, (item) =>
    ["initializer_pair", "designated_initializer"].includes(item.type),
  );
  if (designated) {
    const field = designatedField(designated);
    if (field) return { containerType, field };
  }

  const entry = nearestInitializerEntry(node);
  if (entry) {
    const valueIndex = entry.namedChildren.findIndex((child) =>
      contains(child, node),
    );
    if (valueIndex < 0) return undefined;
    const fields = structFields(root, containerType);
    const field = fields[valueIndex];
    if (field?.functionPointer) return { containerType, field: field.name };
  }

  // A bare array has no nominal container or field (`ops[index](...)`). The
  // reserved container key keeps it in the same durable slot model without
  // conflating it with a real struct named `array`.
  const arrayName = declarationArrayName(declaration);
  return arrayName
    ? { containerType: FUNCTION_POINTER_ARRAY_CONTAINER, field: arrayName }
    : undefined;
}

type StructField = { name: string; functionPointer: boolean };

function structFields(root: TSNode, typeName: string): StructField[] {
  const found: StructField[] = [];
  const visit = (node: TSNode): boolean => {
    if (
      ["struct_specifier", "class_specifier"].includes(node.type) &&
      node.childForFieldName("body") &&
      node.childForFieldName("name")?.text === typeName
    ) {
      const body = node.childForFieldName("body")!;
      for (const declaration of body.namedChildren) {
        if (!declaration.type.includes("field_declaration")) continue;
        const name = findIdentifierLeaf(
          declaration.childForFieldName("declarator") ?? declaration,
        )?.text;
        if (!name) continue;
        found.push({
          name,
          functionPointer: /\(\s*\*\s*[A-Za-z_]\w*\s*\)/.test(declaration.text),
        });
      }
      return true;
    }
    for (const child of node.namedChildren) if (visit(child)) return true;
    return false;
  };
  visit(root);
  return found;
}

function declarationType(node: TSNode | undefined): string | undefined {
  if (!node) return undefined;
  const type =
    node.childForFieldName("type") ??
    node.namedChildren.find((child) =>
      ["struct_specifier", "class_specifier", "type_identifier"].includes(
        child.type,
      ),
    );
  if (!type) return undefined;
  return (
    type.childForFieldName("name")?.text ??
    type.text.replace(/^struct\s+|^class\s+/, "").trim()
  );
}

function declarationArrayName(node: TSNode): string | undefined {
  const declarator = node.childForFieldName("declarator");
  if (!declarator) return undefined;
  const visit = (current: TSNode): string | undefined => {
    if (current.type === "array_declarator") {
      return findIdentifierLeaf(
        current.childForFieldName("declarator") ?? current,
      )?.text;
    }
    for (const child of current.namedChildren) {
      const found = visit(child);
      if (found) return found;
    }
    return undefined;
  };
  return visit(declarator);
}

function designatedField(node: TSNode): string | undefined {
  const designator =
    node.childForFieldName("designator") ??
    node.childForFieldName("field") ??
    node.namedChildren.find((child) => /designator/.test(child.type));
  return designator?.text.replace(/^\./, "").trim();
}

function nearestInitializerEntry(node: TSNode): TSNode | undefined {
  let current = node.parent;
  while (current) {
    if (
      current.type === "initializer_list" &&
      current.parent?.type === "initializer_list"
    )
      return current;
    if (current.type === "declaration") return undefined;
    current = current.parent;
  }
  return undefined;
}

function fieldAccess(
  node: TSNode | undefined,
): { receiver: string; field: string } | undefined {
  if (!node || !["field_expression", "field_access"].includes(node.type))
    return undefined;
  const receiver =
    node.childForFieldName("argument") ??
    node.childForFieldName("object") ??
    node.namedChildren[0];
  const field =
    node.childForFieldName("field") ??
    node.childForFieldName("property") ??
    node.namedChildren.at(-1);
  return receiver && field
    ? { receiver: receiver.text, field: field.text }
    : undefined;
}

function receiverTypeInEnclosingCallable(
  node: TSNode,
  receiver: string,
): string | undefined {
  const callable = ancestor(node, (item) =>
    ["function_definition", "function_declaration"].includes(item.type),
  );
  if (!callable) return undefined;
  const parameters = callable
    .childForFieldName("declarator")
    ?.childForFieldName("parameters");
  for (const parameter of parameters?.namedChildren ?? []) {
    const name = findIdentifierLeaf(
      parameter.childForFieldName("declarator") ?? parameter,
    )?.text;
    if (name !== receiver) continue;
    const type =
      parameter.childForFieldName("type") ?? parameter.namedChildren[0];
    return (
      type?.childForFieldName("name")?.text ??
      /(?:struct|class)\s+([A-Za-z_]\w*)/.exec(type?.text ?? "")?.[1]
    );
  }
  return undefined;
}

function syntaxRoot(node: TSNode): TSNode {
  let current = node;
  while (current.parent) current = current.parent;
  return current;
}

function ancestor(
  node: TSNode,
  predicate: (candidate: TSNode) => boolean,
): TSNode | undefined {
  let current = node.parent;
  for (let depth = 0; current && depth < 16; depth++, current = current.parent)
    if (predicate(current)) return current;
  return undefined;
}

function contains(parent: TSNode, child: TSNode): boolean {
  return (
    parent.startIndex <= child.startIndex && parent.endIndex >= child.endIndex
  );
}
