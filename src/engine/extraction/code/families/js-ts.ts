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
const RETURNED_FUNCTION_ALIASES = new WeakSet<TSNode>();

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

  return hasFunctionValue(node) || isTypedClassField(node);
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

  const bindings = destructuredBindingNodes(node);
  if (bindings.length > 0) return bindings;

  const objectEntities = exportedObjectFunctionEntities(node);

  return objectEntities.length > 0 ? [node, ...objectEntities] : [node];
}

export function extractJavascriptTypescriptName(
  node: TSNode,
): string | undefined {
  if (BINDING_IDENTIFIER_TYPES.has(node.type)) return node.text;

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
  if (node.type === "assignment_expression") {
    const left = node.childForFieldName("left");
    const receiver = left?.childForFieldName("object")?.text;
    return receiver ? [...breadcrumb, receiver] : breadcrumb;
  }

  const objectName = BINDING_IDENTIFIER_TYPES.has(node.type)
    ? undefined
    : exportedObjectVariableName(node);
  return objectName
    ? [...breadcrumb, objectName, ...nestedFunctionOwners(node)]
    : breadcrumb;
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
  if (BINDING_IDENTIFIER_TYPES.has(node.type)) return "value";

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
      : isTypedClassField(node)
        ? "value"
        : node.type === "variable_declarator" && isModuleValue(node)
          ? "value"
          : undefined;
  }

  return undefined;
}

function isTypedClassField(node: TSNode): boolean {
  return (
    (node.type === "field_definition" ||
      node.type === "public_field_definition") &&
    node.childForFieldName("type") !== null
  );
}

const BINDING_IDENTIFIER_TYPES = new Set([
  "identifier",
  "shorthand_property_identifier_pattern",
]);

function destructuredBindingNodes(node: TSNode): TSNode[] {
  if (!isModuleValue(node)) return [];
  const pattern = node.childForFieldName("name");
  if (!pattern || !/^(?:array|object)_pattern$/.test(pattern.type)) return [];

  const bindings: TSNode[] = [];
  collectBindingNodes(pattern, bindings);
  return bindings;
}

function collectBindingNodes(node: TSNode, out: TSNode[]): void {
  if (BINDING_IDENTIFIER_TYPES.has(node.type)) {
    out.push(node);
    return;
  }
  if (/^(?:pair|pair_pattern)$/.test(node.type)) {
    const value = node.childForFieldName("value");
    if (value) collectBindingNodes(value, out);
    return;
  }
  if (/^(?:assignment_pattern|rest_pattern)$/.test(node.type)) {
    const binding =
      node.childForFieldName("left") ??
      node.childForFieldName("argument") ??
      node.namedChildren[0];
    if (binding) collectBindingNodes(binding, out);
    return;
  }
  if (!/(?:pattern|array|object)/.test(node.type)) return;
  for (const child of node.namedChildren) collectBindingNodes(child, out);
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

export function extractJavascriptTypescriptModifiers(
  node: TSNode,
): ReturnType<typeof extractCommonModifiers> {
  const modifiers = extractCommonModifiers(node);
  if (isExportedVariableDeclarator(node) && !modifiers.includes("exported"))
    modifiers.push("exported");
  return modifiers;
}

function hasFunctionValue(node: TSNode): boolean {
  if (RETURNED_FUNCTION_ALIASES.has(node)) return true;
  if (hasCallableType(node)) return true;
  const value =
    node.childForFieldName("value") ??
    node.namedChildren.find((child) =>
      JS_TS_FUNCTION_VALUE_TYPES.has(child.type),
    );

  return value !== undefined && containsFunctionValue(value);
}

function hasCallableType(node: TSNode): boolean {
  const annotation = node.childForFieldName("type")?.namedChildren[0];
  return (
    annotation?.type === "function_type" ||
    (annotation?.type === "object_type" &&
      annotation.namedChildren.some((child) => child.type === "call_signature"))
  );
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
        const value = child.childForFieldName("value");
        if (value)
          collectReturnedObjectFunctions(value, entities, localBindings);
        continue;
      }
      if (
        child.type === "shorthand_property_identifier" ||
        child.type === "shorthand_property_identifier_pattern"
      ) {
        const binding = localBindings.get(child.text);
        if (binding && !entities.includes(binding)) entities.push(binding);
        continue;
      }
      if (child.type === "pair") {
        const value = child.childForFieldName("value");
        const binding =
          value?.type === "identifier"
            ? localBindings.get(value.text)
            : undefined;
        if (binding) {
          if (!entities.includes(binding)) entities.push(binding);
          RETURNED_FUNCTION_ALIASES.add(child);
          entities.push(child);
          continue;
        }
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

function nestedFunctionOwners(node: TSNode): string[] {
  const pairs: TSNode[] = [];
  let current = node.parent;
  while (current && current.type !== "variable_declarator") {
    if (current.type === "pair") pairs.push(current);
    current = current.parent;
  }
  if (!pairs.some(hasFunctionValue)) return [];
  return pairs
    .map(extractJavascriptTypescriptName)
    .filter((name): name is string => Boolean(name))
    .reverse();
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
  if (
    node.type === "identifier" ||
    node.type === "shorthand_property_identifier"
  ) {
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
