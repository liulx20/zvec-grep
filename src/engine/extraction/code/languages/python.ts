import type { CodeEntityModifier } from "../../../types.js";
import type { TSNode } from "../tree-sitter/nodes.js";
import type { LanguageAdapter } from "../adapter.js";
import {
  extractCommonModifiers,
  extractGenericSignature,
  extractPrecedingDoc,
} from "../families/metadata.js";

export const PYTHON_ADAPTER: LanguageAdapter = {
  format: "python",
  entityTypes: new Set([
    "class_definition",
    "decorated_definition",
    "function_definition",
    "assignment",
    "type_alias_statement",
  ]),
  scopeTypes: new Set(["class_definition", "decorated_definition"]),
  extractName(node) {
    if (node.type === "assignment") {
      const left = node.childForFieldName("left");
      return left?.type === "identifier" ? left.text : undefined;
    }
    if (node.type === "type_alias_statement") {
      return node.childForFieldName("name")?.text;
    }
    if (node.type === "decorated_definition") {
      const inner = node.namedChildren.find(
        (child) =>
          child.type === "function_definition" ||
          child.type === "class_definition",
      );
      return inner ? this.extractName(inner) : undefined;
    }

    return node.childForFieldName("name")?.text;
  },
  shouldIndexEntity(node) {
    if (node.type !== "assignment") return true;
    const left = node.childForFieldName("left");
    return left?.type === "identifier" && !hasFunctionAncestor(node);
  },
  classifyNode(node) {
    if (node.type === "type_alias_statement") return "alias";
    if (node.type === "assignment")
      return isPythonTypeAliasAssignment(node) ? "alias" : "value";
    return undefined;
  },
  shouldEnterScope(node) {
    if (node.type !== "decorated_definition") {
      return true;
    }

    return node.namedChildren.some(
      (child) => child.type === "class_definition",
    );
  },
  enterScopeNode(node) {
    if (node.type !== "decorated_definition") {
      return node;
    }

    return (
      node.namedChildren.find((child) => child.type === "class_definition") ??
      node
    );
  },
  extractSignature(node) {
    return extractGenericSignature(innerPythonDefinition(node) ?? node);
  },
  extractDoc: extractPrecedingDoc,
  extractModifiers(node) {
    const modifiers = new Set<CodeEntityModifier>(extractCommonModifiers(node));
    const definition = innerPythonDefinition(node) ?? node;

    if (/^\s*async\s+def\b/m.test(node.text)) {
      modifiers.add("async");
    }

    if (/^\s*@staticmethod\b/m.test(node.text)) {
      modifiers.add("static");
    }

    if (
      (definition.type === "function_definition" &&
        (hasPythonDecorator(node, "abstractmethod") ||
          isAbstractPythonStub(definition))) ||
      (definition.type === "class_definition" &&
        hasAbstractPythonBase(definition))
    ) {
      modifiers.add("abstract");
    }

    return [...modifiers];
  },
};

function hasPythonDecorator(node: TSNode, decoratorName: string): boolean {
  if (node.type !== "decorated_definition") return false;
  return node.namedChildren
    .filter((child) => child.type === "decorator")
    .some((decorator) => {
      const normalized = decorator.text
        .replace(/^\s*@/, "")
        .split("(", 1)[0]
        ?.trim()
        .split(".")
        .at(-1);
      return normalized === decoratorName;
    });
}

function hasAbstractPythonBase(node: TSNode): boolean {
  const superclasses = node.childForFieldName("superclasses");
  if (!superclasses) return false;
  return superclasses.namedChildren.some((base) => {
    const normalized = base.text.replaceAll(/\s/g, "");
    const leaf = normalized.split(".").at(-1);
    return (
      leaf === "ABC" ||
      leaf === "Protocol" ||
      /^(?:metaclass=)?(?:[A-Za-z_]\w*\.)?ABCMeta$/.test(normalized)
    );
  });
}

function isAbstractPythonStub(definition: TSNode): boolean {
  const owner = pythonOwnerClass(definition);
  if (!owner || !hasAbstractPythonBase(owner)) return false;
  const body = definition.childForFieldName("body");
  if (!body || body.namedChildren.length !== 1) return false;
  const [statement] = body.namedChildren;
  if (!statement) return false;
  if (statement.type === "pass_statement") return true;
  if (statement.type === "raise_statement")
    return /^raise\s+(?:[A-Za-z_]\w*\.)?NotImplementedError(?:\b|\s*\()/u.test(
      statement.text.trim(),
    );
  return (
    statement.type === "expression_statement" && statement.text.trim() === "..."
  );
}

function pythonOwnerClass(node: TSNode): TSNode | undefined {
  let parent = node.parent;
  while (parent) {
    if (parent.type === "class_definition") return parent;
    if (parent.type === "function_definition" || parent.type === "lambda")
      return undefined;
    parent = parent.parent;
  }
  return undefined;
}

const PYTHON_TYPE_ALIAS_WRAPPERS = new Set([
  "Annotated",
  "ClassVar",
  "Final",
  "Literal",
  "NotRequired",
  "Optional",
  "ReadOnly",
  "Required",
  "Type",
  "Union",
]);

function isPythonTypeAliasAssignment(node: TSNode): boolean {
  if (hasFunctionAncestor(node)) return false;
  const left = node.childForFieldName("left");
  const right = node.childForFieldName("right");
  if (!left || left.type !== "identifier" || !right) return false;
  if (/^\s*[A-Za-z_]\w*\s*:\s*(?:typing\.)?TypeAlias\s*=/.test(node.text))
    return true;
  if (right.type !== "subscript") return false;
  const value = right.childForFieldName("value") ?? right.namedChildren[0];
  const wrapper = value?.text.split(".").at(-1);
  return wrapper !== undefined && PYTHON_TYPE_ALIAS_WRAPPERS.has(wrapper);
}

function hasFunctionAncestor(node: TSNode): boolean {
  let parent = node.parent;
  while (parent) {
    if (
      parent.type === "function_definition" ||
      parent.type === "lambda" ||
      parent.type === "class_definition"
    )
      return true;
    parent = parent.parent;
  }
  return false;
}

function innerPythonDefinition(node: TSNode): TSNode | undefined {
  if (node.type !== "decorated_definition") {
    return undefined;
  }

  return node.namedChildren.find(
    (child) =>
      child.type === "function_definition" || child.type === "class_definition",
  );
}
