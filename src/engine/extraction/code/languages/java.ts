import { createNameFieldAdapter } from "../families/name-field.js";
import type { TSNode } from "../tree-sitter/nodes.js";

const BASE_JAVA_ADAPTER = createNameFieldAdapter(
  "java",
  [
    "annotation_type_declaration",
    "class_declaration",
    "constructor_declaration",
    "enum_declaration",
    "field_declaration",
    "interface_declaration",
    "method_declaration",
    "record_declaration",
  ],
  [
    "annotation_type_declaration",
    "class_declaration",
    "enum_declaration",
    "interface_declaration",
    "record_declaration",
  ],
);

export const JAVA_ADAPTER = {
  ...BASE_JAVA_ADAPTER,
  shouldIndexEntity(node: TSNode) {
    return node.type !== "field_declaration" || isStaticFinalField(node);
  },
  resolveEntities(node: TSNode): readonly TSNode[] {
    if (node.type !== "field_declaration") return [node];
    return node.namedChildren.filter(
      (child) => child.type === "variable_declarator",
    );
  },
  classifyNode(node: TSNode) {
    return node.type === "variable_declarator" ? ("value" as const) : undefined;
  },
};

function isStaticFinalField(node: TSNode): boolean {
  const modifiers = node.namedChildren.find(
    (child) => child.type === "modifiers",
  );
  if (!modifiers) return false;
  const words = new Set(
    modifiers.children
      .map((child) => child.text)
      .filter((text) => /^[A-Za-z_]+$/.test(text)),
  );
  return words.has("static") && words.has("final");
}
