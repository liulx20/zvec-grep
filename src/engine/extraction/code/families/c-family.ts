import type { CodeSymbolType } from "../../../types.js";
import { findIdentifierLeaf, type TSNode } from "../tree-sitter/nodes.js";
import type { LanguageAdapter } from "../adapter.js";
import {
  extractCommonModifiers,
  extractGenericSignature,
  extractPrecedingDoc,
} from "./metadata.js";

const C_FAMILY_FUNCTION_TYPES = new Set([
  "declaration",
  "field_declaration",
  "function_definition",
  "macro_type_specifier",
]);

const C_FAMILY_FUNCTION_DECLARATION_TYPES = new Set([
  "declaration",
  "field_declaration",
]);

export function createCFamilyAdapter(
  format: string,
  entityTypes: readonly string[],
  scopeTypes: readonly string[] = [],
): LanguageAdapter {
  const scopes = new Set(scopeTypes);
  // tree-sitter-cpp parses `class EXPORT_API Name { ... }` as a
  // function_definition because the unknown export macro sits between the
  // class keyword and name. Treat only that recognizable shape as a scope;
  // ordinary function definitions remain leaves.
  if (format === "cpp") scopes.add("function_definition");
  return {
    format,
    entityTypes: new Set(entityTypes),
    scopeTypes: scopes,
    shouldEnterScope(node) {
      return (
        node.type !== "function_definition" || Boolean(exportedClass(node))
      );
    },
    shouldIndexEntity(node) {
      if (
        [
          "class_specifier",
          "struct_specifier",
          "union_specifier",
          "enum_specifier",
        ].includes(node.type) &&
        !node.childForFieldName("body")
      )
        return false;
      if (!C_FAMILY_FUNCTION_DECLARATION_TYPES.has(node.type)) {
        if (node.type === "macro_type_specifier") {
          return extractCFunctionName(node.text) !== undefined;
        }

        return true;
      }
      return (
        findDescendantByType(node, "function_declarator") !== null ||
        isModuleValueDeclaration(node)
      );
    },
    resolveEntities(node) {
      if (!isModuleValueDeclaration(node)) return [node];
      return node.namedChildren.filter(
        (child) => child.type === "init_declarator",
      );
    },
    extractName(node) {
      const exported = exportedClass(node);
      if (exported) return exported.name;
      if (C_FAMILY_FUNCTION_TYPES.has(node.type)) {
        const name = extractRawCFunctionName(node);
        return name ? lastQualifiedPart(name) : undefined;
      }

      const name = node.childForFieldName("name");
      if (name) {
        return findIdentifierLeaf(name)?.text ?? name.text;
      }

      if (node.type === "type_definition") {
        const declarator = node.childForFieldName("declarator");
        return declarator ? findIdentifierLeaf(declarator)?.text : undefined;
      }

      if (node.type === "init_declarator") {
        const declarator = node.childForFieldName("declarator");
        return declarator ? findIdentifierLeaf(declarator)?.text : undefined;
      }

      return undefined;
    },
    classifyNode: classifyCFamilyNode,
    scopeBreadcrumb: cFamilyScopeBreadcrumb,
    extractSignature: extractGenericSignature,
    extractDoc: extractPrecedingDoc,
    extractModifiers: extractCommonModifiers,
  };
}

function cFamilyScopeBreadcrumb(
  node: TSNode,
  breadcrumb: readonly string[],
): readonly string[] {
  if (!C_FAMILY_FUNCTION_TYPES.has(node.type)) {
    return breadcrumb;
  }

  const name = extractRawCFunctionName(node);
  const qualifier = name ? qualifierParts(name) : [];

  if (qualifier.length === 0) {
    return breadcrumb;
  }

  const parts =
    breadcrumb.length > 0 && breadcrumb[breadcrumb.length - 1] === qualifier[0]
      ? qualifier.slice(1)
      : qualifier;

  return [...breadcrumb, ...parts];
}

function classifyCFamilyNode(node: TSNode): CodeSymbolType | undefined {
  if (node.type === "init_declarator") return "value";
  if (exportedClass(node)) return "class";
  if (node.type === "type_definition") {
    return typedefWrapsClassLikeBody(node) ? "class" : "alias";
  }

  if (node.type === "alias_declaration") {
    return "alias";
  }

  if (
    node.type === "field_declaration" &&
    findDescendantByType(node, "function_declarator")
  ) {
    return isFunctionPointerDeclaration(node) ? "value" : "function";
  }

  return undefined;
}

function isModuleValueDeclaration(node: TSNode): boolean {
  if (node.type !== "declaration") return false;
  if (!node.namedChildren.some((child) => child.type === "init_declarator"))
    return false;
  let parent = node.parent;
  while (parent) {
    if (/function|method|class|struct|union/.test(parent.type)) return false;
    parent = parent.parent;
  }
  return true;
}

function isFunctionPointerDeclaration(node: TSNode): boolean {
  const declarator = findDescendantByType(node, "function_declarator");
  // Only the function's own declarator determines whether this is a function
  // pointer. Searching the complete function_declarator also sees pointer
  // parameters (`void close(handle_t* h, close_cb cb)`) and incorrectly turns
  // the enclosing API declaration into a value.
  let current = declarator?.childForFieldName("declarator") ?? null;
  for (let depth = 0; current && depth < 12; depth += 1) {
    if (current.type === "pointer_declarator") return true;
    if (
      current.type !== "parenthesized_declarator" &&
      current.type !== "reference_declarator" &&
      current.type !== "array_declarator"
    )
      return false;
    current =
      current.childForFieldName("declarator") ??
      current.namedChildren[0] ??
      null;
  }
  return false;
}

function exportedClass(
  node: TSNode,
): { kind: "class" | "struct" | "union"; name: string } | undefined {
  if (node.type !== "function_definition") return undefined;
  const match = node.text.match(
    /^\s*(?:template\s*<[^>{}]*>\s*)?(class|struct|union)\s+(?:(?:[A-Z_][A-Z0-9_]*(?:\([^)]*\))?|__declspec\s*\([^)]*\))\s+)*([A-Za-z_][A-Za-z0-9_]*)\s*(?:final\s*)?(?=[:{])/s,
  );
  if (!match) return undefined;
  return {
    kind: match[1] as "class" | "struct" | "union",
    name: match[2],
  };
}

function extractRawCFunctionName(node: TSNode): string | undefined {
  const declarator =
    node.childForFieldName("declarator") ??
    findDescendantByType(node, "function_declarator");
  const name = declarator ? findIdentifierLeaf(declarator)?.text : undefined;

  return isSimpleCIdentifier(name)
    ? name
    : extractCFunctionName(declarator?.text ?? node.text);
}

function qualifierParts(name: string): string[] {
  const parts = name.split("::").filter((part) => part.length > 0);

  return parts.length > 1 ? parts.slice(0, -1) : [];
}

function lastQualifiedPart(name: string): string {
  return (
    name
      .split("::")
      .filter((part) => part.length > 0)
      .at(-1) ?? name
  );
}

function typedefWrapsClassLikeBody(node: TSNode): boolean {
  return ["struct_specifier", "union_specifier", "enum_specifier"].some(
    (type) => {
      const child = findDescendantByType(node, type);
      return (
        child?.childForFieldName("body") !== null &&
        child?.childForFieldName("body") !== undefined
      );
    },
  );
}

function isSimpleCIdentifier(value: string | undefined): value is string {
  return (
    value !== undefined &&
    /^~?[A-Za-z_][A-Za-z0-9_]*(?:::[~A-Za-z_][A-Za-z0-9_]*)*$/.test(value)
  );
}

function extractCFunctionName(text: string): string | undefined {
  const matches = [...text.matchAll(/([~A-Za-z_][~A-Za-z0-9_:]*)\s*\(/g)];
  const [last] = matches.slice(-1);

  return last?.[1];
}

function findDescendantByType(node: TSNode, type: string): TSNode | null {
  if (node.type === type) {
    return node;
  }

  for (const child of node.namedChildren) {
    const found = findDescendantByType(child, type);
    if (found) {
      return found;
    }
  }

  return null;
}
