import { createCFamilyAdapter } from "../families/c-family.js";
import type { TSNode } from "../tree-sitter/nodes.js";

const BASE_CPP_ADAPTER = createCFamilyAdapter(
  "cpp",
  [
    "alias_declaration",
    "declaration",
    "field_declaration",
    "function_definition",
    "macro_type_specifier",
    "class_specifier",
    "struct_specifier",
    "union_specifier",
    "enum_specifier",
  ],
  [
    "namespace_definition",
    "class_specifier",
    "struct_specifier",
    "union_specifier",
  ],
);

export const CPP_ADAPTER = {
  ...BASE_CPP_ADAPTER,
  extractModifiers(node: TSNode) {
    const modifiers = new Set(BASE_CPP_ADAPTER.extractModifiers?.(node) ?? []);
    if (containsPureVirtualDeclaration(node)) modifiers.add("abstract");
    return [...modifiers];
  },
};

function containsPureVirtualDeclaration(node: TSNode): boolean {
  if (
    node.type !== "class_specifier" &&
    node.type !== "struct_specifier" &&
    node.type !== "declaration" &&
    node.type !== "field_declaration"
  )
    return false;
  return /\bvirtual\b[^;{}]*=\s*0\s*;/s.test(node.text);
}
