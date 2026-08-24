import type { LanguageAdapter } from "./adapter.js";
import {
  memberReferenceTarget,
  referenceTargetFromSyntax,
  type ReferenceTarget,
} from "../../reference-target.js";
import type { TSNode } from "./tree-sitter/nodes.js";
import {
  callNodeKey,
  type CallResolutionFact,
} from "./call-resolution-facts.js";
import { enrichTargetWithResolutionFact } from "./call-resolution-target.js";
import {
  dynamicCallTarget,
  isReflectionHelperCall,
} from "./dynamic-call-target.js";

export type CallSite = {
  /** Callee text as written, e.g. "formatDate" or "utils.formatDate". */
  name: string;
  target: ReferenceTarget;
  /** 1-based source line of the call. */
  line: number;
  kind: "call" | "new";
};

/**
 * Walk a function/method body for call sites.
 * Does not truncate or de-dupe by name — graph aggregation happens later.
 * Skips nested entity nodes so inner functions own their own calls.
 */
export function collectCallSites(
  node: TSNode,
  adapter?: LanguageAdapter | null,
  context?: {
    callableReturnTypes?: ReadonlyMap<string, string>;
    resolutionFacts?: ReadonlyMap<string, CallResolutionFact>;
  },
): CallSite[] {
  const sites: CallSite[] = [];
  const entityTypes = adapter?.entityTypes;
  const resolutionFacts =
    context?.resolutionFacts ??
    adapter?.extractCallResolutionFacts?.(node, context);

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

    if (isCallNode(current) && !isReflectionHelperCall(current)) {
      const target = extractCallTarget(current);
      if (target) {
        const enrichedTarget = enrichTargetWithResolutionFact(
          target,
          resolutionFacts?.get(callNodeKey(current)),
          callArity(current),
        );
        sites.push({
          name: enrichedTarget.raw,
          target: enrichedTarget,
          line: current.startPosition.row + 1,
          kind: isNewExpression(current) ? "new" : "call",
        });
      }
    }

    for (const child of current.namedChildren ?? []) {
      visit(child, false);
    }
  };

  visit(node, true);
  return sites;
}

function isWrappedRootDeclaration(root: TSNode, current: TSNode): boolean {
  return (
    (root.type === "decorated_definition" ||
      root.type === "export_statement") &&
    current.parent?.startIndex === root.startIndex &&
    current.parent?.endIndex === root.endIndex
  );
}

function callArity(node: TSNode): number | undefined {
  const args =
    node.childForFieldName("arguments") ??
    node.namedChildren.find((child) =>
      ["arguments", "argument_list", "value_arguments"].includes(child.type),
    );
  return args ? args.namedChildren.length : undefined;
}

export function isCallNode(node: TSNode): boolean {
  return (
    node.type === "call" ||
    node.type === "call_expression" ||
    node.type === "function_call_expression" ||
    node.type === "method_invocation" ||
    node.type === "object_creation_expression" ||
    node.type === "new_expression"
  );
}

function isNewExpression(node: TSNode): boolean {
  return (
    node.type === "new_expression" || node.type === "object_creation_expression"
  );
}

export function extractCallName(node: TSNode): string | undefined {
  return extractCallTarget(node)?.raw;
}

export function extractCallTarget(node: TSNode): ReferenceTarget | undefined {
  if (node.type === "method_invocation") {
    const reflection = dynamicCallTarget(
      node,
      normalizeCallName(node.text) ?? node.text,
    );
    if (reflection) return reflection;
    const name = node.childForFieldName("name");
    const receiver =
      node.childForFieldName("object") ?? node.childForFieldName("receiver");
    if (name) {
      const raw = normalizeCallName(
        receiver ? `${receiver.text}.${name.text}` : name.text,
      );
      return raw
        ? receiver
          ? memberReferenceTarget(raw, receiver.text, name.text)
          : referenceTargetFromSyntax(raw)
        : undefined;
    }
  }
  const target =
    node.childForFieldName("function") ??
    node.childForFieldName("name") ??
    node.childForFieldName("constructor") ??
    node.childForFieldName("type") ??
    node.namedChildren[0];

  if (!target) {
    return undefined;
  }

  const raw = normalizeCallName(callableTargetText(target));
  if (!raw) return undefined;
  return dynamicCallTarget(target, raw) ?? referenceTargetFromSyntax(raw);
}

function callableTargetText(node: TSNode): string {
  if (node.type === "generic_function") {
    const inner = node.childForFieldName("function") ?? node.namedChildren[0];
    return inner ? callableTargetText(inner) : node.text;
  }
  if (node.type === "template_function") {
    const inner = node.childForFieldName("name") ?? node.namedChildren[0];
    return inner ? callableTargetText(inner) : node.text;
  }
  if (node.type === "generic_type") {
    const inner = node.childForFieldName("type") ?? node.namedChildren[0];
    return inner ? callableTargetText(inner) : node.text;
  }
  if (node.type === "template_type") {
    const inner = node.childForFieldName("name") ?? node.namedChildren[0];
    return inner ? callableTargetText(inner) : node.text;
  }
  if (
    node.type === "scoped_identifier" ||
    node.type === "qualified_identifier"
  ) {
    const scope =
      node.childForFieldName("path") ?? node.childForFieldName("scope");
    const name = node.childForFieldName("name");
    if (scope && name)
      return `${callableTargetText(scope)}::${callableTargetText(name)}`;
  }
  return node.text;
}

const MAX_CALL_NAME_CHARS = 180;

function normalizeCallName(value: string): string | undefined {
  const cleaned = value
    .replace(/\s+/g, " ")
    .replace(/^new\s+/, "")
    .trim();

  if (
    cleaned.length === 0 ||
    cleaned.length > MAX_CALL_NAME_CHARS ||
    /[\n\r]/.test(cleaned) ||
    !/[A-Za-z_$][A-Za-z0-9_$]*/.test(cleaned)
  ) {
    return undefined;
  }

  return cleaned;
}
