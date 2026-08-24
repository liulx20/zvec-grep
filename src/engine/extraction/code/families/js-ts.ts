import type { CodeSymbolType } from "../../../types.js";
import type { TSNode } from "../tree-sitter/nodes.js";
import {
  extractCommonModifiers,
  extractGenericSignature,
  extractPrecedingDoc,
} from "./metadata.js";

const JS_TS_FUNCTION_VALUE_DECLARATION_TYPES = new Set([
  "assignment_expression",
  "field_definition",
  "public_field_definition",
  "variable_declarator",
]);

const JS_TS_FUNCTION_VALUE_TYPES = new Set([
  "arrow_function",
  "function_expression",
]);

const DEFAULT_EXPORT_BINDING_CACHE = new WeakMap<TSNode, ReadonlySet<string>>();

export function shouldIndexJavascriptTypescriptEntity(node: TSNode): boolean {
  if (node.type === "method_definition" && isObjectMember(node)) {
    return false;
  }

  if (node.type === "pair") {
    return (
      hasFunctionValue(node) && exportedObjectVariableName(node) !== undefined
    );
  }

  if (!JS_TS_FUNCTION_VALUE_DECLARATION_TYPES.has(node.type)) {
    return true;
  }

  if (
    node.type === "variable_declarator" &&
    exportedObjectFunctionEntities(node).length > 0
  ) {
    return true;
  }

  if (node.type === "variable_declarator" && isModuleValue(node)) return true;

  return hasFunctionValue(node);
}

export function hasJavascriptTypescriptFunctionValue(node: TSNode): boolean {
  return hasFunctionValue(node);
}

export function resolveJavascriptTypescriptEntities(
  node: TSNode,
): readonly TSNode[] {
  if (node.type !== "variable_declarator") {
    return [node];
  }

  const objectEntities = exportedObjectFunctionEntities(node);

  return objectEntities.length > 0 ? [node, ...objectEntities] : [node];
}

export function extractJavascriptTypescriptName(
  node: TSNode,
): string | undefined {
  if (node.type === "assignment_expression") {
    const left = node.childForFieldName("left");
    return (
      left?.childForFieldName("property")?.text ??
      left?.childForFieldName("field")?.text ??
      left?.text.split(".").at(-1)
    );
  }
  if (node.type === "pair") {
    return node.childForFieldName("key")?.text.replace(/^['"`]|['"`]$/g, "");
  }

  return (
    node.childForFieldName("name")?.text ?? findNamedIdentifierChild(node)?.text
  );
}

export function javascriptTypescriptScopeBreadcrumb(
  node: TSNode,
  breadcrumb: readonly string[],
): readonly string[] {
  const objectName = exportedObjectVariableName(node);

  if (node.type === "assignment_expression") {
    const left = node.childForFieldName("left");
    const receiver = left?.childForFieldName("object")?.text;
    return receiver ? [...breadcrumb, receiver] : breadcrumb;
  }

  return objectName ? [...breadcrumb, objectName] : breadcrumb;
}

export function extractJavascriptTypescriptSignature(
  node: TSNode,
): string | undefined {
  if (node.type === "assignment_expression") {
    const name = extractJavascriptTypescriptName(node);
    const value = node.childForFieldName("right");
    const valueSignature = value ? extractGenericSignature(value) : undefined;
    return name && valueSignature
      ? `${name}: ${valueSignature}`
      : valueSignature;
  }
  if (node.type === "pair") {
    const key = extractJavascriptTypescriptName(node);
    const value = node.childForFieldName("value");
    const valueSignature = value ? extractGenericSignature(value) : undefined;

    return key && valueSignature
      ? `${key}: ${valueSignature}`
      : extractGenericSignature(node);
  }

  return extractGenericSignature(node);
}

export function classifyJavascriptTypescriptNode(
  node: TSNode,
): CodeSymbolType | undefined {
  if (
    node.type === "variable_declarator" &&
    exportedObjectFunctionEntities(node).length > 0
  ) {
    return "value";
  }
  if (
    node.type === "pair" ||
    JS_TS_FUNCTION_VALUE_DECLARATION_TYPES.has(node.type)
  ) {
    return hasFunctionValue(node)
      ? "function"
      : node.type === "variable_declarator" && isModuleValue(node)
        ? "value"
        : undefined;
  }

  return undefined;
}

function isModuleValue(node: TSNode): boolean {
  let parent = node.parent;
  while (parent) {
    if (/function|method|class|arrow_function/.test(parent.type)) return false;
    parent = parent.parent;
  }
  return true;
}

export const extractJavascriptTypescriptDoc = extractPrecedingDoc;

export const extractJavascriptTypescriptModifiers = extractCommonModifiers;

function hasFunctionValue(node: TSNode): boolean {
  const value =
    node.childForFieldName("value") ??
    node.namedChildren.find((child) =>
      JS_TS_FUNCTION_VALUE_TYPES.has(child.type),
    );

  return value !== undefined && containsFunctionValue(value);
}

function containsFunctionValue(node: TSNode): boolean {
  if (JS_TS_FUNCTION_VALUE_TYPES.has(node.type)) {
    return true;
  }

  if (node.type !== "call_expression" && node.type !== "arguments") {
    return false;
  }

  return node.namedChildren.some((child) => containsFunctionValue(child));
}

function exportedObjectFunctionEntities(node: TSNode): TSNode[] {
  if (!isExportedVariableDeclarator(node)) {
    return [];
  }

  const value = node.childForFieldName("value");
  if (!value) return [];
  const entities: TSNode[] = [];
  collectReturnedObjectFunctions(
    value,
    entities,
    collectLocalFunctionBindings(value),
  );
  return entities;
}

function collectReturnedObjectFunctions(
  node: TSNode,
  entities: TSNode[],
  localBindings: ReadonlyMap<string, TSNode>,
): void {
  if (node.type === "object" || node.type === "object_expression") {
    for (const child of node.namedChildren) {
      if (
        (child.type === "pair" && hasFunctionValue(child)) ||
        child.type === "method_definition"
      ) {
        entities.push(child);
        continue;
      }
      if (
        child.type === "shorthand_property_identifier" ||
        child.type === "shorthand_property_identifier_pattern"
      ) {
        const binding = localBindings.get(child.text);
        if (binding) entities.push(binding);
        continue;
      }
      if (child.type === "pair") {
        const value = child.childForFieldName("value");
        if (value)
          collectReturnedObjectFunctions(value, entities, localBindings);
      }
    }
    return;
  }
  if (!OBJECT_FACTORY_TRAVERSAL_TYPES.has(node.type)) return;
  for (const child of node.namedChildren) {
    collectReturnedObjectFunctions(child, entities, localBindings);
  }
}

function collectLocalFunctionBindings(
  root: TSNode,
): ReadonlyMap<string, TSNode> {
  const unique = new Map<string, TSNode>();
  const ambiguous = new Set<string>();
  const visit = (node: TSNode): void => {
    const isFunctionDeclaration = node.type === "function_declaration";
    const isFunctionVariable =
      node.type === "variable_declarator" && hasFunctionValue(node);
    if (isFunctionDeclaration || isFunctionVariable) {
      const name = extractJavascriptTypescriptName(node);
      if (name) {
        if (unique.has(name)) {
          unique.delete(name);
          ambiguous.add(name);
        } else if (!ambiguous.has(name)) {
          unique.set(name, node);
        }
      }
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return unique;
}

const OBJECT_FACTORY_TRAVERSAL_TYPES = new Set([
  "arguments",
  "arrow_function",
  "call_expression",
  "function_expression",
  "parenthesized_expression",
  "return_statement",
  "statement_block",
]);

function exportedObjectVariableName(node: TSNode): string | undefined {
  let current: TSNode | null = node;
  while (current) {
    if (
      current.type === "variable_declarator" &&
      isExportedVariableDeclarator(current)
    ) {
      return extractJavascriptTypescriptName(current);
    }
    current = current.parent;
  }
  return undefined;
}

function isExportedVariableDeclarator(node: TSNode): boolean {
  if (node.type !== "variable_declarator") {
    return false;
  }

  if (isDirectlyExportedVariable(node)) return true;

  const name = extractJavascriptTypescriptName(node);
  if (!name) return false;
  let root: TSNode = node;
  while (root.parent) root = root.parent;
  let exportedBindings = DEFAULT_EXPORT_BINDING_CACHE.get(root);
  if (!exportedBindings) {
    const collected = new Set<string>();
    for (const child of root.namedChildren) {
      if (
        child.type === "export_statement" &&
        /^export\s+default\b/.test(child.text.trimStart())
      ) {
        collectDefaultExportReferences(child, collected);
      }
    }
    exportedBindings = collected;
    DEFAULT_EXPORT_BINDING_CACHE.set(root, exportedBindings);
  }
  return exportedBindings.has(name);
}

function isDirectlyExportedVariable(node: TSNode): boolean {
  let current = node.parent;
  while (current) {
    if (current.type === "export_statement") return true;
    if (
      current.type === "arrow_function" ||
      current.type === "function_expression" ||
      current.type === "function_declaration" ||
      current.type === "method_definition"
    ) {
      return false;
    }
    current = current.parent;
  }
  return false;
}

function collectDefaultExportReferences(node: TSNode, out: Set<string>): void {
  if (node.type === "shorthand_property_identifier") {
    out.add(node.text);
    return;
  }
  if (node.type === "pair") {
    const value = node.childForFieldName("value");
    if (!value) return;
    if (value.type === "identifier") out.add(value.text);
    else collectDefaultExportReferences(value, out);
    return;
  }
  for (const child of node.namedChildren) {
    collectDefaultExportReferences(child, out);
  }
}

function isObjectMember(node: TSNode): boolean {
  return (
    node.parent?.type === "object" || node.parent?.type === "object_expression"
  );
}

function findNamedIdentifierChild(node: TSNode): TSNode | undefined {
  return node.namedChildren.find(
    (child) =>
      child.type === "identifier" ||
      child.type === "property_identifier" ||
      child.type === "type_identifier",
  );
}
