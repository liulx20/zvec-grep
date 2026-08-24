import type { LanguageAdapter } from "./adapter.js";
import type { RefSite } from "./ref-sites.js";
import type { TSNode } from "./tree-sitter/nodes.js";
import { referenceTargetFromSyntax } from "../../reference-target.js";
import {
  callNodeKey,
  type CallResolutionFact,
} from "./call-resolution-facts.js";
import { enrichTargetWithResolutionFact } from "./call-resolution-target.js";
import { cFunctionPointerRegistration } from "./c-function-pointer-registration.js";

const VALUE_CONTEXTS = new Set([
  "argument_list",
  "arguments",
  "array",
  "array_expression",
  "array_initializer",
  "assignment_expression",
  "assignment_statement",
  "initializer_list",
  "initializer_pair",
  "designated_initializer",
  "method_reference",
  "pair",
  "return_statement",
]);

/** Capture a known function name used as a value rather than invoked. */
export function collectFunctionRefSites(
  node: TSNode,
  adapter: LanguageAdapter,
  candidateNames: ReadonlySet<string>,
  language: string,
  resolutionFacts?: ReadonlyMap<string, CallResolutionFact>,
): RefSite[] {
  if (candidateNames.size === 0) return [];
  const shadowed = new Set<string>();
  const effectiveResolutionFacts =
    resolutionFacts ?? adapter.extractCallResolutionFacts?.(node);
  const sites: RefSite[] = [];
  const seen = new Set<string>();
  const visit = (current: TSNode, skipSelfEntity: boolean): void => {
    if (
      !skipSelfEntity &&
      adapter.entityTypes.has(current.type) &&
      adapter.shouldIndexEntity?.(current) !== false
    )
      return;
    if (
      current.type === "identifier" &&
      candidateNames.has(current.text) &&
      (isParameterName(current) || isLocalDeclarationName(current, node))
    )
      shadowed.add(current.text);
    const reference = functionReference(current, language);
    const name = reference?.name;
    if (
      name &&
      candidateNames.has(name) &&
      !shadowed.has(name) &&
      isFunctionValuePosition(current)
    ) {
      const key = `${name}\0${current.startIndex}\0${current.endIndex}`;
      if (!seen.has(key)) {
        seen.add(key);
        const call = enclosingCallNode(current);
        const target = enrichTargetWithResolutionFact(
          referenceTargetFromSyntax(reference.raw),
          call ? effectiveResolutionFacts?.get(callNodeKey(call)) : undefined,
          undefined,
        );
        const registration = cFunctionPointerRegistration(current, language);
        sites.push({
          name,
          target: registration
            ? {
                ...target,
                hints: {
                  ...target.hints,
                  functionPointerRegistration: registration,
                },
              }
            : target,
          line: current.startPosition.row + 1,
          kind: "function",
        });
      }
    }
    for (const child of current.namedChildren ?? []) visit(child, false);
  };
  visit(node, true);
  // Shadowing is entity-wide for this conservative function-value relation.
  // Filter after the walk so a declaration appearing after an occurrence has
  // the same behavior as the previous dedicated pre-pass.
  return sites.filter((site) => !shadowed.has(site.name));
}

function enclosingCallNode(node: TSNode): TSNode | undefined {
  let current = node.parent;
  for (let depth = 0; current && depth < 5; depth++, current = current.parent) {
    if (/call|invocation/.test(current.type)) return current;
    if (/function|method|constructor|closure|lambda/.test(current.type)) break;
  }
  return undefined;
}

function functionReference(
  node: TSNode,
  language: string,
): { name: string; raw: string } | undefined {
  if (node.type === "identifier") return { name: node.text, raw: node.text };
  if (
    (language === "javascript" ||
      language === "jsx" ||
      language === "typescript" ||
      language === "tsx") &&
    node.type === "shorthand_property_identifier"
  )
    return { name: node.text, raw: node.text };
  if (
    [
      "attribute",
      "field_access",
      "field_expression",
      "member_expression",
      "method_reference",
      "qualified_identifier",
      "selector_expression",
      "scoped_identifier",
    ].includes(node.type)
  ) {
    const member =
      node.childForFieldName("field") ??
      node.childForFieldName("property") ??
      node.childForFieldName("name") ??
      node.namedChildren.at(-1);
    if (member)
      return { name: member.text, raw: node.text.replace(/::/g, ".") };
  }
  return undefined;
}

function isFunctionValuePosition(node: TSNode): boolean {
  const parent = node.parent;
  if (!parent || isDeclarationName(node) || isCallCallee(node)) return false;
  if (node.type === "method_reference") return true;
  if (/type|annotation|parameter|declarator/.test(parent.type)) return false;
  if (VALUE_CONTEXTS.has(parent.type)) {
    return true;
  }
  return isAddressOf(node);
}

function isAddressOf(node: TSNode): boolean {
  const parent = node.parent;
  return Boolean(
    parent &&
    (parent.type === "pointer_expression" ||
      parent.type === "unary_expression") &&
    parent.text.trimStart().startsWith("&"),
  );
}

function isCallCallee(node: TSNode): boolean {
  const parent = node.parent;
  if (!parent || !/call|invocation/.test(parent.type)) return false;
  const callee =
    parent.childForFieldName("function") ??
    parent.childForFieldName("name") ??
    parent.childForFieldName("method");
  return sameNode(node, callee);
}

function isParameterName(node: TSNode): boolean {
  let parent = node.parent;
  for (let depth = 0; parent && depth < 4; depth++, parent = parent.parent) {
    if (/parameters?|formal_parameter/.test(parent.type)) return true;
    if (/block|body/.test(parent.type)) return false;
  }
  return false;
}

function isLocalDeclarationName(node: TSNode, root: TSNode): boolean {
  if (!isDeclarationName(node)) return false;
  let parent = node.parent;
  while (parent && !sameNode(parent, root)) {
    if (/function|method|constructor|closure|lambda/.test(parent.type))
      return true;
    parent = parent.parent;
  }
  return false;
}

function isDeclarationName(node: TSNode): boolean {
  const parent = node.parent;
  if (!parent) return false;
  const declared =
    parent.childForFieldName("name") ??
    parent.childForFieldName("left") ??
    parent.childForFieldName("pattern");
  return sameNode(node, declared);
}

function sameNode(left: TSNode | null, right: TSNode | null): boolean {
  return Boolean(
    left &&
    right &&
    left.startIndex === right.startIndex &&
    left.endIndex === right.endIndex,
  );
}
