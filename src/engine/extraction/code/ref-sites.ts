import type { LanguageAdapter } from "./adapter.js";
import {
  referenceTargetFromSyntax,
  memberReferenceTarget,
  type ReferenceTarget,
} from "../../reference-target.js";
import { isCallNode } from "./call-sites.js";
import type { TSNode } from "./tree-sitter/nodes.js";

export type RefSite = {
  /** Referenced name as written (may be qualified). */
  name: string;
  target: ReferenceTarget;
  /** 1-based source line. */
  line: number;
  /** REFS rel: type | return | member | decorates | value | function */
  kind: "type" | "return" | "member" | "decorates" | "value" | "function";
};

const MAX_REF_NAME_CHARS = 180;

const TS_PREDEFINED = new Set([
  "string",
  "number",
  "boolean",
  "void",
  "any",
  "never",
  "unknown",
  "null",
  "undefined",
  "object",
  "bigint",
  "symbol",
  "this",
  "true",
  "false",
]);

const PYTHON_PREDEFINED = new Set([
  "str",
  "int",
  "float",
  "bool",
  "bytes",
  "list",
  "dict",
  "tuple",
  "set",
  "None",
  "Any",
  "Optional",
  "Union",
  "List",
  "Dict",
  "Tuple",
  "Set",
  "Callable",
  "Type",
  "type",
  "object",
  "self",
  "cls",
]);

const HERITAGE_CONTEXTS = new Set([
  "class_heritage",
  "extends_clause",
  "implements_clause",
  "extends_type_clause",
  "superclass",
  "super_interfaces",
  "extends_interfaces",
  "base_class_clause",
]);
const C_FAMILY_DECLARATIONS = new Set(["declaration", "field_declaration"]);

/**
 * Walk an entity node for type / member / decorator references.
 * Skips nested indexed entities and call callees (owned by CALLS).
 */
export function collectRefSites(
  node: TSNode,
  adapter?: LanguageAdapter | null,
  language = "typescript",
): RefSite[] {
  const sites: RefSite[] = [];
  const entityTypes = adapter?.entityTypes;
  const seen = new Set<string>();

  const push = (
    site: Omit<RefSite, "target"> & { target?: ReferenceTarget },
    origin: TSNode,
  ): void => {
    if (!site.name || isNoiseName(site.name, language)) {
      return;
    }
    // Different occurrences on one source line are distinct graph facts.
    // Range-based de-duplication still collapses overlapping extraction
    // branches that report the same AST node.
    const key = `${site.kind}\0${site.name}\0${origin.startIndex}\0${origin.endIndex}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    sites.push({
      ...site,
      target: site.target ?? referenceTargetFromSyntax(site.name),
    });
  };

  const visit = (current: TSNode | null, skipSelfEntity: boolean): void => {
    if (!current) {
      return;
    }

    if (
      !skipSelfEntity &&
      entityTypes?.has(current.type) &&
      adapter?.shouldIndexEntity?.(current) !== false &&
      !isWrappedRootDeclaration(node, current)
    ) {
      return;
    }

    // Decorators attached to this entity (or nested non-entity nodes).
    if (current.type === "decorator") {
      const name = decoratorName(current);
      if (name) {
        push(
          {
            name,
            line: current.startPosition.row + 1,
            kind: "decorates",
          },
          current,
        );
      }
      // Still walk children for nested type args.
    }

    if (current.type === "annotation" || current.type === "marker_annotation") {
      const nameNode =
        current.childForFieldName("name") ?? current.namedChildren[0];
      const name = nameNode ? normalizeRefName(nameNode.text) : undefined;
      if (name) {
        push(
          {
            name,
            line: current.startPosition.row + 1,
            kind: "decorates",
          },
          current,
        );
      }
    }

    if (current.type === "type_annotation" || current.type === "type") {
      const kind = isReturnTypeAnnotation(current) ? "return" : "type";
      for (const occurrence of typeNamesIn(current, language)) {
        if (!inHeritageContext(current)) {
          push(
            {
              name: occurrence.name,
              line: occurrence.node.startPosition.row + 1,
              kind,
            },
            occurrence.node,
          );
        }
      }
      // Children walked below for nested structures.
    }

    // Java, C/C++, Go and Rust expose many parameter/return types directly as
    // type_identifier nodes rather than wrapping them in `type` or
    // `type_annotation`. Capture those nodes only when their AST position is
    // type-bearing; this avoids turning declaration names and expressions into
    // type references.
    if (isDirectTypeReference(current)) {
      for (const occurrence of typeNamesIn(current, language)) {
        if (!inHeritageContext(current)) {
          push(
            {
              name: occurrence.name,
              line: occurrence.node.startPosition.row + 1,
              kind: isReturnTypePosition(current) ? "return" : "type",
            },
            occurrence.node,
          );
        }
      }
    }

    if (
      (language === "c" || language === "cpp") &&
      C_FAMILY_DECLARATIONS.has(current.type)
    ) {
      const typeNode = current.childForFieldName("type");
      if (typeNode) {
        for (const occurrence of typeNamesIn(typeNode, language)) {
          push(
            {
              name: occurrence.name,
              line: occurrence.node.startPosition.row + 1,
              kind: "type",
            },
            occurrence.node,
          );
        }
      }
    }

    // C represents `struct Name` / `enum Name` type uses as a complete
    // specifier node rather than a standalone type_identifier. A specifier
    // without a body is a reference to an existing tag; a body-bearing one is
    // the declaration itself and must not create a self-reference.
    if (
      (language === "c" || language === "cpp") &&
      ["struct_specifier", "union_specifier", "enum_specifier"].includes(
        current.type,
      ) &&
      !current.childForFieldName("body")
    ) {
      const name = current.childForFieldName("name");
      if (name) {
        push(
          {
            name: normalizeRefName(name.text) ?? "",
            line: current.startPosition.row + 1,
            kind: "type",
          },
          name,
        );
      }
    }

    // JSX component tags are executable symbol references. Intrinsic tags are
    // lowercase by language convention and intentionally remain external.
    if (
      (language === "jsx" || language === "tsx") &&
      (current.type === "jsx_opening_element" ||
        current.type === "jsx_self_closing_element")
    ) {
      const name = current.childForFieldName("name");
      const normalized = name ? (normalizeRefName(name.text) ?? "") : "";
      if (/^[A-Z]/.test(normalized)) {
        push(
          {
            name: normalized,
            line: current.startPosition.row + 1,
            kind: "member",
          },
          name ?? current,
        );
      }
    }

    // Component factories are also commonly passed through JSX props instead
    // of appearing as a tag (`<Route component={Profile} />`). Preserve that
    // direct value reference; nested member expressions are handled by the
    // normal member-reference branch above.
    if (
      (language === "jsx" || language === "tsx") &&
      current.type === "identifier" &&
      current.parent?.type === "jsx_expression" &&
      /^[A-Z]/.test(current.text)
    ) {
      push(
        {
          name: current.text,
          line: current.startPosition.row + 1,
          kind: "member",
        },
        current,
      );
    }

    // Member / property access that is not a call callee.
    if (
      (current.type === "member_expression" ||
        current.type === "attribute" ||
        current.type === "field_expression" ||
        current.type === "field_access") &&
      !isCallCallee(current) &&
      !isAssignmentTarget(current)
    ) {
      const target = memberTarget(current);
      if (target) {
        push(
          {
            name: target.raw,
            target,
            line: current.startPosition.row + 1,
            kind: "member",
          },
          current,
        );
      }
    }

    for (const child of current.namedChildren ?? []) {
      visit(child, false);
    }
  };

  visit(node, true);

  // Decorators may sit on a parent export_statement / decorated_definition.
  const parent = node.parent;
  if (
    parent?.type === "export_statement" ||
    parent?.type === "decorated_definition"
  ) {
    for (const child of parent.namedChildren ?? []) {
      if (child.type === "decorator") {
        const name = decoratorName(child);
        if (name) {
          push(
            {
              name,
              line: child.startPosition.row + 1,
              kind: "decorates",
            },
            child,
          );
        }
      }
    }
  }

  return sites;
}

function isAssignmentTarget(node: TSNode): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (
    parent.type !== "assignment_expression" &&
    parent.type !== "augmented_assignment_expression" &&
    parent.type !== "assignment"
  )
    return false;
  const left =
    parent.childForFieldName("left") ?? parent.childForFieldName("target");
  return sameNodeRange(left ?? undefined, node);
}

function isWrappedRootDeclaration(root: TSNode, current: TSNode): boolean {
  return (
    (root.type === "decorated_definition" ||
      root.type === "export_statement") &&
    current.parent?.startIndex === root.startIndex &&
    current.parent?.endIndex === root.endIndex
  );
}

function isDirectTypeReference(node: TSNode): boolean {
  if (
    node.type !== "type_identifier" &&
    node.type !== "scoped_type_identifier" &&
    node.type !== "qualified_type"
  ) {
    return false;
  }
  let current: TSNode = node;
  for (let depth = 0; depth < 4; depth += 1) {
    const parent = current.parent;
    if (!parent) return false;
    const name = parent.childForFieldName("name");
    if (name && sameNodeRange(name, current)) return false;
    if (
      parent.type.includes("parameter") ||
      parent.type.includes("declaration") ||
      parent.type.includes("field") ||
      parent.type.includes("return") ||
      parent.type.includes("constraint") ||
      parent.type.includes("type") ||
      parent.type === "function_item" ||
      parent.type === "function_definition" ||
      parent.type === "method_declaration"
    ) {
      return true;
    }
    current = parent;
  }
  return false;
}

function isReturnTypePosition(node: TSNode): boolean {
  const parent = node.parent;
  if (!parent) return false;
  const explicitReturn = parent.childForFieldName("return_type");
  if (sameNodeRange(explicitReturn ?? undefined, node)) return true;
  const genericType = parent.childForFieldName("type");
  if (!sameNodeRange(genericType ?? undefined, node)) return false;
  // In Java and C-family grammars `type` is also the field used by variable,
  // field and parameter declarations. Treat it as a return type only when its
  // owner is callable; otherwise class fields such as `Repository repo` become
  // misleading `return` change-surface edges.
  return (
    !parent.type.includes("parameter") &&
    /(?:method|function|callable|lambda)/.test(parent.type)
  );
}

function isReturnTypeAnnotation(node: TSNode): boolean {
  const parent = node.parent;
  if (!parent) {
    return false;
  }
  // TS/JS: function_declaration / method_definition / arrow_function → type_annotation after params
  if (
    parent.type.includes("function") ||
    parent.type === "method_definition" ||
    parent.type === "method_signature" ||
    parent.type === "arrow_function" ||
    parent.type === "function_declaration" ||
    parent.type === "generator_function_declaration" ||
    parent.type === "function_definition"
  ) {
    const params =
      parent.childForFieldName("parameters") ??
      parent.namedChildren.find(
        (c) =>
          c.type === "formal_parameters" ||
          c.type === "parameters" ||
          c.type === "parameter_list",
      );
    if (params && node.startIndex >= params.endIndex) {
      return true;
    }
    // Python: field name "return_type" or sibling type after parameters
    if (parent.childForFieldName("return_type") === node) {
      return true;
    }
    if (
      parent.type === "function_definition" &&
      node.type === "type" &&
      parent.childForFieldName("parameters") &&
      node.startIndex > (parent.childForFieldName("parameters")?.endIndex ?? 0)
    ) {
      return true;
    }
  }
  return false;
}

type TypeNameOccurrence = { name: string; node: TSNode };

function typeNamesIn(node: TSNode, language: string): TypeNameOccurrence[] {
  const out: TypeNameOccurrence[] = [];
  const visit = (current: TSNode | null): void => {
    if (!current) {
      return;
    }
    if (
      current.type === "predefined_type" ||
      current.type === "literal_type" ||
      current.type === "null" ||
      current.type === "undefined"
    ) {
      return;
    }
    if (
      current.type === "type_identifier" ||
      current.type === "identifier" ||
      current.type === "nested_type_identifier" ||
      current.type === "qualified_identifier" ||
      current.type === "member_expression" ||
      current.type === "scoped_type_identifier" ||
      current.type === "qualified_type"
    ) {
      // Avoid treating parameter names as types: only under type-ish parents.
      if (
        current.type === "identifier" &&
        current.parent &&
        !isTypeishParent(current.parent)
      ) {
        // keep walking
      } else {
        const name = normalizeRefName(current.text);
        if (name && !isNoiseName(name, language)) {
          out.push({ name, node: current });
          return; // don't also collect nested pieces of qualified name
        }
      }
    }
    if (current.type === "generic_type" || current.type === "template_type") {
      const nameNode =
        current.childForFieldName("name") ?? current.namedChildren[0];
      const name = nameNode ? normalizeRefName(nameNode.text) : undefined;
      if (name && !isNoiseName(name, language)) {
        out.push({ name, node: nameNode! });
      }
      // Still collect type arguments.
      for (const child of current.namedChildren ?? []) {
        if (child === nameNode) {
          continue;
        }
        visit(child);
      }
      return;
    }
    for (const child of current.namedChildren ?? []) {
      visit(child);
    }
  };
  visit(node);
  return out;
}

function isTypeishParent(parent: TSNode): boolean {
  return (
    parent.type === "type" ||
    parent.type === "type_annotation" ||
    parent.type === "generic_type" ||
    parent.type === "union_type" ||
    parent.type === "intersection_type" ||
    parent.type === "type_arguments" ||
    parent.type.includes("type")
  );
}

function decoratorName(node: TSNode): string | undefined {
  const call = node.namedChildren.find((c) => c.type === "call_expression");
  if (call) {
    const fn = call.childForFieldName("function") ?? call.namedChildren[0];
    return fn ? normalizeRefName(fn.text) : undefined;
  }
  const id =
    node.namedChildren.find(
      (c) =>
        c.type === "identifier" ||
        c.type === "member_expression" ||
        c.type === "decorator_member_expression",
    ) ?? node.namedChildren[0];
  if (!id) {
    return undefined;
  }
  return normalizeRefName(id.text.replace(/^@/, ""));
}

function memberTarget(node: TSNode): ReferenceTarget | undefined {
  const prop =
    node.childForFieldName("property") ??
    node.childForFieldName("field") ??
    node.namedChildren[node.namedChildren.length - 1];
  if (!prop) {
    return undefined;
  }
  if (
    prop.type !== "property_identifier" &&
    prop.type !== "identifier" &&
    prop.type !== "field_identifier" &&
    prop.type !== "property"
  ) {
    return undefined;
  }
  const member = normalizeRefName(prop.text);
  const receiver =
    node.childForFieldName("object") ??
    node.childForFieldName("argument") ??
    node.childForFieldName("value") ??
    node.namedChildren[0];
  if (!member || !receiver || receiver === prop) return undefined;
  return memberReferenceTarget(node.text, receiver.text, member);
}

function isCallCallee(node: TSNode): boolean {
  const parent = node.parent;
  if (!parent || !isCallNode(parent)) {
    return false;
  }
  const fn =
    parent.childForFieldName("function") ??
    parent.childForFieldName("name") ??
    parent.namedChildren[0];
  return sameNodeRange(fn, node);
}

/** Tree-sitter may return a fresh JS wrapper for the same syntax node. */
function sameNodeRange(left: TSNode | undefined, right: TSNode): boolean {
  return (
    left !== undefined &&
    left.type === right.type &&
    left.startIndex === right.startIndex &&
    left.endIndex === right.endIndex
  );
}

function inHeritageContext(node: TSNode): boolean {
  let current: TSNode | null = node;
  for (let i = 0; i < 8 && current; i++) {
    if (HERITAGE_CONTEXTS.has(current.type)) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function normalizeRefName(value: string): string | undefined {
  let text = value
    .replace(/\s+/g, " ")
    .replace(/^@/, "")
    .replace(/<[\s\S]*>$/, "")
    .trim();
  const angle = text.indexOf("<");
  if (angle > 0) {
    text = text.slice(0, angle).trim();
  }
  if (
    text.length === 0 ||
    text.length > MAX_REF_NAME_CHARS ||
    /[\n\r]/.test(text) ||
    !/^[A-Za-z_$][A-Za-z0-9_$]*(?:(?:\.|::)[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(
      text,
    )
  ) {
    return undefined;
  }
  return text;
}

function isNoiseName(name: string, language: string): boolean {
  const bare = name.split(/\.|::/).pop() ?? name;
  if (bare.length <= 1 && bare !== "_") {
    // keep single-letter type params? drop them — too noisy
    return bare.length <= 1;
  }
  if (TS_PREDEFINED.has(bare) || TS_PREDEFINED.has(name)) {
    return true;
  }
  if (
    (language === "python" || language === "py") &&
    (PYTHON_PREDEFINED.has(bare) || PYTHON_PREDEFINED.has(name))
  ) {
    return true;
  }
  return false;
}
