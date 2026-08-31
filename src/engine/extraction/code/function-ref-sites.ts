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

const GENERAL_VALUE_CONTEXTS = new Set([
  "for_in_statement",
  "for_of_statement",
  "object",
  "object_expression",
  "spread_element",
  "subscript_expression",
]);
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
  "value_argument",
  ...GENERAL_VALUE_CONTEXTS,
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
    const qualified = reference
      ? referenceTargetFromSyntax(reference.raw).receiver?.kind === "qualified"
      : false;
    const valueKind = functionValueKind(current);
    if (
      name &&
      (candidateNames.has(name) || qualified) &&
      !shadowed.has(name) &&
      valueKind
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
          kind: registration ? "function" : valueKind,
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
  if (node.type === "identifier" || node.type === "simple_identifier")
    return { name: node.text, raw: node.text };
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
      "navigation_expression",
      "qualified_identifier",
      "selector_expression",
      "scoped_identifier",
    ].includes(node.type)
  ) {
    let member =
      node.childForFieldName("field") ??
      node.childForFieldName("property") ??
      node.childForFieldName("name") ??
      node.namedChildren.at(-1);
    if (member?.type === "navigation_suffix")
      member = member.namedChildren.at(-1);
    if (member)
      return { name: member.text, raw: node.text.replace(/::/g, ".") };
  }
  return undefined;
}

function functionValueKind(node: TSNode): "value" | "function" | undefined {
  const parent = node.parent;
  if (!parent || isDeclarationName(node) || isCallCallee(node)) return;
  if (isBoundFunctionReceiver(node) || node.type === "method_reference")
    return "function";
  if (/type|annotation|parameter|declarator/.test(parent.type)) return;
  if (isAssignmentValue(node) || GENERAL_VALUE_CONTEXTS.has(parent.type))
    return "value";
  if (VALUE_CONTEXTS.has(parent.type) || isAddressOf(node)) return "function";
}

function isAssignmentValue(node: TSNode): boolean {
  let parent = node.parent;
  while (
    parent &&
    !/function|method|constructor|closure|lambda/.test(parent.type)
  ) {
    if (/assignment/.test(parent.type)) {
      const value =
        parent.childForFieldName("right") ?? parent.childForFieldName("value");
      return contains(value, node);
    }
    parent = parent.parent;
  }
  return false;
}

function contains(parent: TSNode | null, child: TSNode): boolean {
  return Boolean(
    parent &&
    parent.startIndex <= child.startIndex &&
    parent.endIndex >= child.endIndex,
  );
}

function isBoundFunctionReceiver(node: TSNode): boolean {
  const member = node.parent;
  if (!member || !/member|attribute/.test(member.type)) return false;
  const receiver =
    member.childForFieldName("object") ?? member.namedChildren.at(0);
  const property =
    member.childForFieldName("property") ?? member.namedChildren.at(-1);
  if (!sameNode(node, receiver) || property?.text !== "bind") return false;
  const call = member.parent;
  if (!call || !/call|invocation/.test(call.type)) return false;
  const callee =
    call.childForFieldName("function") ??
    call.childForFieldName("name") ??
    call.childForFieldName("method");
  return sameNode(member, callee);
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

function sameNode(
  left: TSNode | null | undefined,
  right: TSNode | null | undefined,
): boolean {
  return Boolean(
    left &&
    right &&
    left.startIndex === right.startIndex &&
    left.endIndex === right.endIndex,
  );
}
