import type { Node, Tree } from "web-tree-sitter";

type RecursiveNodeMembers =
  | "child"
  | "childForFieldId"
  | "childForFieldName"
  | "children"
  | "descendantsOfType"
  | "firstChild"
  | "firstNamedChild"
  | "lastChild"
  | "lastNamedChild"
  | "namedChild"
  | "namedChildren"
  | "nextNamedSibling"
  | "nextSibling"
  | "parent"
  | "previousNamedSibling"
  | "previousSibling";

/** Runtime nodes expose dense child arrays; model that invariant once. */
export type TSNode = Omit<Node, RecursiveNodeMembers> & {
  child(index: number): TSNode | null;
  childForFieldId(fieldId: number): TSNode | null;
  childForFieldName(fieldName: string): TSNode | null;
  children: TSNode[];
  descendantsOfType(types: string | string[]): TSNode[];
  firstChild: TSNode | null;
  firstNamedChild: TSNode | null;
  lastChild: TSNode | null;
  lastNamedChild: TSNode | null;
  namedChild(index: number): TSNode | null;
  namedChildren: TSNode[];
  nextNamedSibling: TSNode | null;
  nextSibling: TSNode | null;
  parent: TSNode | null;
  previousNamedSibling: TSNode | null;
  previousSibling: TSNode | null;
};

export type TSTree = Omit<Tree, "rootNode"> & { rootNode: TSNode };

export function findIdentifierLeaf(node: TSNode): TSNode | null {
  const wrappers = new Set([
    "array_declarator",
    "function_declarator",
    "init_declarator",
    "parenthesized_declarator",
    "pointer_declarator",
    "reference_declarator",
  ]);

  let current: TSNode | null = node;

  for (let depth = 0; current && depth < 16; depth++) {
    if (current.type === "identifier" || current.type.endsWith("_identifier")) {
      return current;
    }

    if (
      current.type === "destructor_name" ||
      current.type === "operator_name"
    ) {
      return current;
    }

    if (wrappers.has(current.type)) {
      current =
        current.childForFieldName("declarator") ??
        current.namedChildren[0] ??
        null;
      continue;
    }

    return null;
  }

  return null;
}
