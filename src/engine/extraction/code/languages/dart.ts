import type { LanguageAdapter } from "../adapter.js";
import type { TSNode } from "../tree-sitter/nodes.js";
import {
  extractCommonModifiers,
  extractGenericSignature,
  extractPrecedingDoc,
} from "../families/metadata.js";

const TYPE_DECLARATIONS = new Set([
  "class_definition",
  "enum_declaration",
  "extension_declaration",
  "mixin_declaration",
]);

export const DART_ADAPTER: LanguageAdapter = {
  format: "dart",
  entityTypes: new Set([...TYPE_DECLARATIONS, "function_body", "type_alias"]),
  scopeTypes: TYPE_DECLARATIONS,
  extractName(node) {
    const signature = dartCallableSignature(node);
    return (
      signature?.childForFieldName("name")?.text ??
      signature?.namedChildren.find((child) =>
        /^(?:identifier|type_identifier)$/.test(child.type),
      )?.text ??
      node.childForFieldName("name")?.text
    );
  },
  shouldIndexEntity(node) {
    return node.type !== "function_body" || dartCallableSignature(node) != null;
  },
  classifyNode(node) {
    return node.type === "function_body" ? "function" : undefined;
  },
  extractSignature(node) {
    const signature = dartCallableSignature(node);
    return signature
      ? extractGenericSignature(signature)
      : extractGenericSignature(node);
  },
  extractDoc(node) {
    return extractPrecedingDoc(dartCallableSignature(node) ?? node);
  },
  extractModifiers(node) {
    return extractCommonModifiers(dartCallableSignature(node) ?? node);
  },
};

function dartCallableSignature(node: TSNode): TSNode | undefined {
  if (node.type !== "function_body") return undefined;
  const previous = node.previousNamedSibling;
  if (!previous) return undefined;
  if (previous.type === "function_signature") return previous;
  if (previous.type === "method_signature") {
    return (
      previous.namedChildren.find((child) =>
        /(?:function|constructor)_signature$/.test(child.type),
      ) ?? previous
    );
  }
  if (previous.type === "declaration") {
    return previous.namedChildren.find((child) =>
      /(?:function|constructor)_signature$/.test(child.type),
    );
  }
  return undefined;
}
