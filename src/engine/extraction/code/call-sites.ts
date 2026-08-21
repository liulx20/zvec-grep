import type { LanguageAdapter } from "./adapter.js";
import {
  memberReferenceTarget,
  referenceTargetFromSyntax,
  type ReferenceTarget,
} from "../../reference-target.js";
import type { TSNode } from "./tree-sitter/nodes.js";

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
): CallSite[] {
  const sites: CallSite[] = [];
  const entityTypes = adapter?.entityTypes;
  const resolutionContext = collectResolutionContext(node, adapter);

  const visit = (current: TSNode | null, skipSelfEntity: boolean): void => {
    if (!current) {
      return;
    }

    if (
      !skipSelfEntity &&
      entityTypes?.has(current.type) &&
      adapter?.shouldIndexEntity?.(current) !== false
    ) {
      return;
    }

    if (isCallNode(current)) {
      const target = extractCallTarget(current);
      if (target) {
        const enrichedTarget = enrichReferenceTarget(
          target,
          resolutionContext,
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

type ResolutionContext = {
  receiverTypes: ReadonlyMap<string, string>;
  genericBounds: ReadonlyMap<string, readonly string[]>;
  language?: string;
};

function enrichReferenceTarget(
  target: ReferenceTarget,
  context: ResolutionContext,
  arity: number | undefined,
): ReferenceTarget {
  const receiver = target.receiver?.name;
  if (!receiver)
    return arity === undefined
      ? target
      : { ...target, hints: { ...target.hints, callArity: arity } };
  const receiverType = context.receiverTypes.get(receiver) ??
    context.receiverTypes.get(receiver.split(".").pop() ?? receiver);
  if (!receiverType) return target;
  const bounds = context.genericBounds.get(receiverType);
  return {
    ...target,
    hints: {
      receiverType,
      ...(arity === undefined ? {} : { callArity: arity }),
      ...(bounds ? { genericBounds: [...bounds] } : {}),
      candidateTypes: bounds ? [receiverType, ...bounds] : [receiverType],
      ...(bounds && bounds.length > 0
        ? { dispatch: dispatchForLanguage(context.language) }
        : context.language === "java" ||
            context.language === "cpp" ||
            context.language === "typescript" ||
            context.language === "tsx"
          ? { dispatch: "virtual" as const }
        : {}),
    },
  };
}

function callArity(node: TSNode): number | undefined {
  const args = node.childForFieldName("arguments") ??
    node.namedChildren.find((child) =>
      ["arguments", "argument_list", "value_arguments"].includes(child.type),
    );
  return args ? args.namedChildren.length : undefined;
}

function dispatchForLanguage(
  language?: string,
): "interface" | "trait" | "virtual" {
  if (language === "rust") return "trait";
  if (language === "go" || language === "java") return "interface";
  return "virtual";
}

function collectResolutionContext(
  node: TSNode,
  adapter?: LanguageAdapter | null,
): ResolutionContext {
  const language = adapter?.format;
  const entityTypes = adapter?.entityTypes;
  const receiverTypes = new Map<string, string>();
  const genericBounds = collectGenericBounds(node, language);
  const parameterTypes = new Set([
    "parameter_declaration",
    "formal_parameter",
    "receiver_parameter",
    "parameter",
    "required_parameter",
    "optional_parameter",
    "variadic_parameter_declaration",
  ]);
  const declarationTypes = new Set([
    "variable_declarator",
    "variable_declaration",
    "local_variable_declaration",
    "lexical_declaration",
    "let_declaration",
    "field_declaration",
    "property_declaration",
    "public_field_definition",
    "short_var_declaration",
  ]);
  const visit = (current: TSNode): void => {
    if (
      !sameSyntaxNode(current, node) &&
      entityTypes?.has(current.type) &&
      adapter?.shouldIndexEntity?.(current) !== false
    ) {
      return;
    }
    if (parameterTypes.has(current.type)) {
      const binding = parameterBinding(current, language);
      if (binding) receiverTypes.set(binding.name, binding.type);
      return;
    }
    if (declarationTypes.has(current.type)) {
      for (const binding of declarationBindings(current, language)) {
        receiverTypes.set(binding.name, binding.type);
      }
    }
    for (const child of current.namedChildren ?? []) visit(child);
  };
  const receiver = node.childForFieldName("receiver");
  if (receiver) {
    const binding = parameterBinding(receiver, language);
    if (binding) receiverTypes.set(binding.name, binding.type);
  }
  for (const child of node.namedChildren ?? []) visit(child);
  let parent = node.parent;
  for (let depth = 0; parent && depth < 3; depth++, parent = parent.parent) {
    if (/class|struct|impl/.test(parent.type)) {
      const visitFields = (current: TSNode): void => {
        if (
          !sameSyntaxNode(current, node) &&
          /method|function|constructor/.test(current.type)
        )
          return;
        if (declarationTypes.has(current.type)) {
          for (const binding of declarationBindings(current, language))
            receiverTypes.set(binding.name, binding.type);
        }
        for (const child of current.namedChildren ?? []) visitFields(child);
      };
      visitFields(parent);
      break;
    }
  }
  return { receiverTypes, genericBounds, language };
}

function sameSyntaxNode(left: TSNode, right: TSNode): boolean {
  return (
    left.type === right.type &&
    left.startIndex === right.startIndex &&
    left.endIndex === right.endIndex
  );
}

function declarationBindings(
  node: TSNode,
  language?: string,
): { name: string; type: string }[] {
  const text = node.text.trim();
  const results: { name: string; type: string }[] = [];
  const explicit = text.match(
    /(?:^|\b(?:const|let|var)\s+)([A-Za-z_]\w*)\s*:\s*([A-Za-z_][^\s=;,)]*)/,
  );
  if (explicit) results.push({ name: explicit[1]!, type: normalizeType(explicit[2]!) });
  const cFamily = text.match(
    /^\s*([A-Za-z_][^\s=;,)]*)\s+([A-Za-z_]\w*)\s*(?:[=;,)])?/,
  );
  if (cFamily && !/^(?:const|let|var|return|new)$/.test(cFamily[1]!)) {
    results.push({ name: cFamily[2]!, type: normalizeType(cFamily[1]!) });
  }
  const constructed = text.match(
    /([A-Za-z_]\w*)\s*(?::=|=)\s*(?:new\s+|&)?([A-Za-z_][\w.:]*)\s*(?:\{|\(|::new)/,
  );
  if (constructed) {
    results.push({ name: constructed[1]!, type: normalizeType(constructed[2]!) });
  }
  if (language === "go") {
    const go = text.match(/^\s*var\s+([A-Za-z_]\w*)\s+([A-Za-z_][\w.]*)/);
    if (go) results.push({ name: go[1]!, type: normalizeType(go[2]!) });
  }
  return results;
}

function parameterBinding(
  node: TSNode,
  language?: string,
): { name: string; type: string } | undefined {
  const name =
    node.childForFieldName("name")?.text ??
    node.childForFieldName("pattern")?.text;
  const type = node.childForFieldName("type")?.text;
  if (name && type) return { name, type: normalizeType(type) };
  const text = node.text.trim().replace(/^\(|\)$/g, "");
  const match = language === "go"
    ? text.match(/^([A-Za-z_]\w*)\s+\*?([A-Za-z_]\w*(?:\[[^\]]+\])?)$/)
    : language === "rust"
      ? text.match(/^(?:mut\s+)?([A-Za-z_]\w*)\s*:\s*&?(?:mut\s+)?([^=]+)$/)
      : text.match(/(?:^|\s)([A-Za-z_]\w*)\s*$/);
  if (!match) return undefined;
  if (language === "go" || language === "rust") {
    return { name: match[1]!, type: normalizeType(match[2]!) };
  }
  const inferredType = text.slice(0, text.lastIndexOf(match[1]!)).trim();
  return inferredType
    ? { name: match[1]!, type: normalizeType(inferredType) }
    : undefined;
}

function collectGenericBounds(
  node: TSNode,
  language?: string,
): Map<string, readonly string[]> {
  const result = new Map<string, readonly string[]>();
  const genericTypes = new Set([
    "type_parameters",
    "type_parameter_list",
    "template_parameter_list",
  ]);
  let owner: TSNode | null = node;
  let genericNode: TSNode | undefined;
  for (let depth = 0; owner && depth < 3 && !genericNode; depth++) {
    genericNode = owner.childForFieldName("type_parameters") ??
      owner.namedChildren.find((child) => genericTypes.has(child.type));
    owner = owner.parent;
  }
  const text = genericNode?.text ?? "";
  const separator = language === "java" ? /\s+extends\s+/ : /\s*:\s*/;
  const inner =
    (text.startsWith("<") && text.endsWith(">")) ||
    (text.startsWith("[") && text.endsWith("]"))
      ? text.slice(1, -1)
      : text;
  for (const part of inner.split(",")) {
    const trimmed = part.trim();
    const constrained =
      language === "go"
        ? trimmed.match(/^([A-Za-z_]\w*)\s+(.+)$/)
        : language === "cpp"
          ? trimmed.match(/^([A-Za-z_]\w*)\s+([A-Za-z_]\w*)$/)
          : null;
    if (constrained && language === "go") {
      result.set(constrained[1]!, [normalizeType(constrained[2]!)]);
      continue;
    }
    if (
      constrained &&
      language === "cpp" &&
      constrained[1] !== "typename" &&
      constrained[1] !== "class"
    ) {
      result.set(constrained[2]!, [normalizeType(constrained[1]!)]);
      continue;
    }
    const pieces = trimmed.split(separator);
    const name = pieces.shift()?.replace(/^(?:typename|class)\s+/, "").trim();
    if (!name || pieces.length === 0) continue;
    const bounds = pieces.join(":").split(/[+&]/).map(normalizeType).filter(Boolean);
    if (bounds.length > 0) result.set(name, bounds);
  }
  return result;
}

function normalizeType(value: string): string {
  return value
    .replace(/\b(?:const|volatile|mut|typename|class)\b/g, "")
    .replace(/[&*]/g, "")
    .replace(/<.*>|\[.*\]/g, "")
    .trim()
    .split(/\s+/)
    .pop() ?? "";
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

  const raw = normalizeCallName(target.text);
  return raw ? referenceTargetFromSyntax(raw) : undefined;
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
