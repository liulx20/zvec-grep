import type { ReferenceTarget } from "../../reference-target.js";
import type { TSNode } from "./tree-sitter/nodes.js";

export type DynamicCallableBinding = {
  name: string;
  target: ReferenceTarget;
};

/** Preserve runtime-selected call semantics before the AST is flattened. */
export function dynamicCallTarget(
  callable: TSNode,
  raw: string,
): ReferenceTarget | undefined {
  const reflection = reflectionCallTarget(callable, raw);
  if (reflection) return reflection;

  if (callable.type === "subscript_expression") {
    const receiver =
      callable.childForFieldName("object") ?? callable.namedChildren[0];
    const index =
      callable.childForFieldName("index") ?? callable.namedChildren[1];
    if (!receiver || !index) return undefined;
    const key = stringLiteralValue(index.text);
    return target(raw, receiver.text, "computed_member", key);
  }

  if (isCallExpression(callable)) {
    const functionNode =
      callable.childForFieldName("function") ?? callable.namedChildren[0];
    const argumentsNode =
      callable.childForFieldName("arguments") ?? callable.namedChildren[1];
    const args = argumentsNode?.namedChildren ?? [];
    if (functionNode?.text !== "getattr" || args.length < 2) return undefined;
    const receiver = args[0];
    const keyNode = args[1];
    if (!receiver || !keyNode) return undefined;
    return target(
      raw,
      receiver.text,
      "getattr",
      stringLiteralValue(keyNode.text),
    );
  }

  return undefined;
}

/** Reflection helper calls are implementation plumbing for the outer dispatch. */
export function isReflectionHelperCall(node: TSNode): boolean {
  if (node.type !== "method_invocation") return false;
  const name = node.childForFieldName("name")?.text;
  if (name === "getMethod" || name === "getDeclaredMethod") {
    return enclosingInvocationName(node) === "invoke";
  }
  if (name === "getClass") {
    const parentName = enclosingInvocationName(node);
    return parentName === "getMethod" || parentName === "getDeclaredMethod";
  }
  return false;
}

/** Extract `handler = getattr(target, key)` without flattening away its scope. */
export function dynamicCallableAssignment(
  node: TSNode,
): DynamicCallableBinding | undefined {
  if (node.type !== "assignment") return undefined;
  const left = node.childForFieldName("left");
  const right = node.childForFieldName("right");
  if (
    !left ||
    !right ||
    !IDENTIFIER.test(left.text) ||
    !isCallExpression(right)
  )
    return undefined;
  const fn = right.childForFieldName("function") ?? right.namedChildren[0];
  const argsNode =
    right.childForFieldName("arguments") ?? right.namedChildren[1];
  const args = argsNode?.namedChildren ?? [];
  if (fn?.text !== "getattr" || args.length < 2 || !args[0] || !args[1])
    return undefined;
  const key = stringLiteralValue(args[1].text) ?? stringPrefix(args[1]);
  return {
    name: left.text,
    target: target(right.text, args[0].text, "getattr", key),
  };
}

function reflectionCallTarget(
  callable: TSNode,
  raw: string,
): ReferenceTarget | undefined {
  if (callable.type !== "method_invocation") return undefined;
  if (callable.childForFieldName("name")?.text !== "invoke") return undefined;
  const lookup = callable.childForFieldName("object");
  const lookupName = lookup?.childForFieldName("name")?.text;
  if (
    !lookup ||
    lookup.type !== "method_invocation" ||
    (lookupName !== "getMethod" && lookupName !== "getDeclaredMethod")
  ) {
    return undefined;
  }
  const lookupArgs = lookup.childForFieldName("arguments");
  const keyNode = lookupArgs?.namedChildren[0];
  const receiver = lookup.childForFieldName("object");
  if (!receiver) return undefined;
  const receiverName =
    receiver.type === "method_invocation" &&
    receiver.childForFieldName("name")?.text === "getClass"
      ? (receiver.childForFieldName("object")?.text ?? receiver.text)
      : receiver.text;
  return target(
    raw,
    receiverName,
    "reflection",
    keyNode ? stringLiteralValue(keyNode.text) : undefined,
  );
}

function enclosingInvocationName(node: TSNode): string | undefined {
  const parent = node.parent;
  if (parent?.type !== "method_invocation") return undefined;
  const object = parent.childForFieldName("object");
  if (
    !object ||
    object.startIndex !== node.startIndex ||
    object.endIndex !== node.endIndex
  ) {
    return undefined;
  }
  return parent.childForFieldName("name")?.text;
}

function target(
  raw: string,
  receiver: string,
  form: "computed_member" | "getattr" | "reflection",
  key: string | undefined,
): ReferenceTarget {
  return {
    raw,
    member: key ?? "<dynamic>",
    receiver: { kind: "qualified", name: receiver },
    hints: {
      dynamicDispatch: {
        form,
        ...(key ? { key } : {}),
      },
    },
  };
}

function isCallExpression(node: TSNode): boolean {
  return node.type === "call" || node.type === "call_expression";
}

function stringLiteralValue(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length < 2) return undefined;
  const quote = trimmed[0];
  return (quote === '"' || quote === "'") && trimmed.at(-1) === quote
    ? trimmed.slice(1, -1)
    : undefined;
}

function stringPrefix(node: TSNode): string | undefined {
  if (node.type !== "binary_operator") return undefined;
  const left = node.childForFieldName("left") ?? node.namedChildren[0];
  return left ? stringLiteralValue(left.text) : undefined;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
