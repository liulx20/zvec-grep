import type { LanguageAdapter } from "../adapter.js";
import type { TSNode } from "../tree-sitter/nodes.js";
import {
  extractCommonModifiers,
  extractGenericSignature,
  extractPrecedingDoc,
} from "../families/metadata.js";

export const RUST_ADAPTER: LanguageAdapter = {
  format: "rust",
  entityTypes: new Set([
    "enum_item",
    "const_item",
    "function_item",
    "function_signature_item",
    "impl_item",
    "struct_item",
    "static_item",
    "trait_item",
    "type_item",
    "union_item",
  ]),
  scopeTypes: new Set(["impl_item", "mod_item", "trait_item"]),
  extractName(node) {
    if (node.type === "impl_item") {
      return node.childForFieldName("type")?.text;
    }

    return node.childForFieldName("name")?.text;
  },
  shouldIndexEntity(node) {
    if (node.type !== "const_item" && node.type !== "static_item") return true;
    return !hasFunctionAncestor(node);
  },
  classifyNode(node) {
    if (node.type === "const_item" || node.type === "static_item")
      return "value";
    return undefined;
  },
  extractSignature: extractGenericSignature,
  extractDoc: extractPrecedingDoc,
  extractModifiers: extractCommonModifiers,
};

function hasFunctionAncestor(node: TSNode): boolean {
  let parent = node.parent;
  while (parent) {
    if (
      parent.type === "function_item" ||
      parent.type === "closure_expression" ||
      parent.type === "impl_item" ||
      parent.type === "trait_item"
    )
      return true;
    parent = parent.parent;
  }
  return false;
}
