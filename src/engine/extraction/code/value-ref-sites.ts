import type { LanguageAdapter } from "./adapter.js";
import type { RefSite } from "./ref-sites.js";
import type { TSNode } from "./tree-sitter/nodes.js";

const DECLARATION_TYPES = new Set([
  "assignment",
  "const_item",
  "const_spec",
  "field_declaration",
  "init_declarator",
  "lexical_declaration",
  "let_declaration",
  "local_variable_declaration",
  "short_var_declaration",
  "static_item",
  "var_spec",
  "variable_declaration",
  "variable_declarator",
]);

const PARAMETER_CONTAINER_TYPES = new Set([
  "formal_parameters",
  "parameter_list",
  "parameters",
]);

/**
 * Collect reads of durable module/package values from one indexed entity.
 *
 * A same-named parameter or local declaration makes the target ambiguous for
 * this entity. In that case the collector deliberately drops every edge to
 * the outer value instead of inventing a scope-insensitive dependency.
 */
export function collectValueRefSites(
  node: TSNode,
  adapter: LanguageAdapter,
  valueNames: ReadonlySet<string>,
): RefSite[] {
  if (valueNames.size === 0) return [];
  const shadowed = new Set<string>();
  const sites: RefSite[] = [];

  const visit = (current: TSNode | null, skipSelfEntity: boolean): void => {
    if (!current) return;
    if (
      !skipSelfEntity &&
      adapter.entityTypes.has(current.type) &&
      adapter.shouldIndexEntity?.(current) !== false
    )
      return;

    if (
      (isParameterName(current) || isLocalDeclarationName(current, node)) &&
      valueNames.has(current.text)
    )
      shadowed.add(current.text);

    if (
      isReadableIdentifier(current) &&
      valueNames.has(current.text) &&
      !isDeclarationName(current)
    ) {
      sites.push({
        name: current.text,
        target: { raw: current.text, member: current.text },
        line: current.startPosition.row + 1,
        kind: "value",
      });
    }
    for (const child of current.namedChildren ?? []) visit(child, false);
  };
  visit(node, true);
  return sites.filter((site) => !shadowed.has(site.name));
}

function isReadableIdentifier(node: TSNode): boolean {
  return node.type === "identifier";
}

function isParameterName(node: TSNode): boolean {
  if (!/^(?:identifier|shorthand_property_identifier)$/.test(node.type))
    return false;
  let parent = node.parent;
  for (let depth = 0; parent && depth < 3; depth++, parent = parent.parent) {
    if (PARAMETER_CONTAINER_TYPES.has(parent.type)) return true;
    if (/block|body/.test(parent.type)) return false;
  }
  return false;
}

function isLocalDeclarationName(node: TSNode, root: TSNode): boolean {
  if (node.startIndex === root.startIndex && node.endIndex === root.endIndex)
    return false;
  if (!isDeclarationName(node)) return false;
  return hasExecutableAncestor(node, root);
}

function isDeclarationName(node: TSNode): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (!DECLARATION_TYPES.has(parent.type)) return false;
  const declared =
    parent.childForFieldName("name") ??
    parent.childForFieldName("left") ??
    parent.childForFieldName("pattern");
  return sameNode(node, declared);
}

function hasExecutableAncestor(node: TSNode, root: TSNode): boolean {
  let parent = node.parent;
  while (parent) {
    if (/function|method|constructor|closure|lambda/.test(parent.type))
      return true;
    if (sameNode(parent, root)) return false;
    parent = parent.parent;
  }
  return false;
}

function sameNode(left: TSNode | null, right: TSNode | null): boolean {
  return Boolean(
    left &&
    right &&
    left.startIndex === right.startIndex &&
    left.endIndex === right.endIndex,
  );
}
