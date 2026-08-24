import type { TSNode } from "./tree-sitter/nodes.js";

const PARAMETER_LIST_TYPES = new Set([
  "parameters",
  "formal_parameters",
  "parameter_list",
]);

/** Extract callable arity from the language AST instead of signature text. */
export function extractCallableArity(
  node: TSNode,
  language: string,
): number | undefined {
  const parameters = findParameterList(node);
  if (!parameters) return undefined;
  const entries = parameters.namedChildren.filter(
    (child) =>
      !child.type.includes("comment") && child.type !== "type_parameters",
  );
  if (entries.length === 1 && /^(?:void)?$/.test(entries[0]!.text.trim()))
    return 0;
  // The persisted schema currently stores one exact arity. A declaration
  // with defaults/rest/splat can accept several call arities, so persisting
  // one number would incorrectly remove valid overload/dispatch candidates.
  // Keep its arity unknown until the schema can represent min/max bounds.
  if (entries.some((parameter) => isFlexibleParameter(parameter, language)))
    return undefined;
  return entries.reduce(
    (count, parameter, index) =>
      count + parameterArity(parameter, language, index),
    0,
  );
}

function isFlexibleParameter(node: TSNode, language: string): boolean {
  if (/(?:optional|default|rest|splat|variadic)/.test(node.type)) return true;
  const text = node.text.trim();
  if (/^(?:\*|\.\.\.)/.test(text) || /\.\.\.(?:\s|$)/.test(text)) return true;
  if (language === "typescript" || language === "tsx") {
    if (/^[A-Za-z_$][\w$]*\s*\?\s*:/.test(text)) return true;
  }
  return /(^|[^=!<>])=([^=>]|$)/.test(text);
}

/** Extract a declared callable return type without counting implicit receivers. */
export function extractCallableReturnType(
  signature: string,
  symbolName: string | undefined,
  language?: string,
): string | undefined {
  const suffix = /\)\s*(?::|->)\s*([^\s{][^{]*)\s*(?:\{|:)?$/.exec(signature);
  if (suffix?.[1]) return normalizeReturnType(suffix[1], language);

  const go = /^func\b[\s\S]*\)\s*(\([^)]*\)|[^\s{]+)\s*(?:\{|$)/.exec(
    signature,
  );
  if (go?.[1]) {
    const first = go[1]
      .replace(/^\(|\)$/g, "")
      .split(",", 1)[0]
      ?.trim();
    if (first) return normalizeReturnType(first.split(/\s+/).at(-1)!, language);
  }

  if (symbolName && ["c", "cpp", "java"].includes(language ?? "")) {
    const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const prefix = new RegExp(`^(.*?)\\b${escaped}\\s*\\(`).exec(
      signature,
    )?.[1];
    const candidate = prefix
      ?.replace(
        /\b(?:public|protected|private|static|final|virtual|inline|constexpr|consteval|constinit|extern|friend|abstract|synchronized|native|strictfp|default|override)\b/g,
        " ",
      )
      .trim()
      .split(/\s+/)
      .at(-1);
    if (candidate && candidate !== symbolName)
      return normalizeReturnType(candidate, language);
  }
  return undefined;
}

/**
 * Whether a direct invocation returns a deferred container rather than the
 * callable's eventual/yielded value. The current call-resolution IR does not
 * encode `await`/iteration, so using that value type would create false edges.
 */
export function isDeferredCallable(node: TSNode, language: string): boolean {
  if (
    !new Set(["javascript", "jsx", "typescript", "tsx", "python"]).has(language)
  )
    return false;
  const callable = callableSyntaxNode(node);
  if (/generator/.test(callable.type)) return true;
  const body = callable.childForFieldName("body");
  const headerLength = body
    ? Math.max(0, body.startIndex - callable.startIndex)
    : Math.min(callable.text.length, 512);
  const header = callable.text.slice(0, headerLength);
  return (
    /\basync\s+(?:(?:function|def)\b|[A-Za-z_$]|\()/.test(header) ||
    /\bfunction\s*\*/.test(header) ||
    /^\s*(?:static\s+)?\*/.test(header)
  );
}

function callableSyntaxNode(node: TSNode): TSNode {
  if (/(?:function|method|lambda)/.test(node.type)) return node;
  const queue = [...(node.namedChildren ?? [])];
  for (let visited = 0; queue.length > 0 && visited < 32; visited++) {
    const current = queue.shift()!;
    if (/(?:function|method|lambda)/.test(current.type)) return current;
    queue.push(...(current.namedChildren ?? []));
  }
  return node;
}

/** Infer a nominal type only when every return constructs the same type. */
export function inferConstructedCallableReturnType(
  node: TSNode,
  language: string,
): string | undefined {
  if (
    !new Set(["javascript", "jsx", "typescript", "tsx", "python"]).has(
      language,
    ) ||
    isDeferredCallable(node, language)
  )
    return undefined;

  const types = new Set<string>();
  let sawReturn = false;
  let unsupportedReturn = false;
  const visit = (current: TSNode): void => {
    if (unsupportedReturn) return;
    if (
      (current.startIndex !== node.startIndex ||
        current.endIndex !== node.endIndex) &&
      /(?:function|method|class|lambda)/.test(current.type)
    )
      return;
    if (current.type === "return_statement") {
      sawReturn = true;
      const match =
        language === "python"
          ? /^\s*return\s+((?:[A-Za-z_]\w*\.)*[A-Z][A-Za-z0-9_]*)\s*\(/.exec(
              current.text,
            )
          : /^\s*return\s+new\s+([A-Za-z_$][\w$.:]*)\s*(?:<[^;=(){}]+>)?\s*\(/.exec(
              current.text,
            );
      if (!match) unsupportedReturn = true;
      else types.add(match[1]!);
      return;
    }
    for (const child of current.namedChildren ?? []) visit(child);
  };
  visit(node);
  return sawReturn && !unsupportedReturn && types.size === 1
    ? types.values().next().value
    : undefined;
}

function normalizeReturnType(
  value: string,
  language?: string,
): string | undefined {
  let normalized = value
    .trim()
    .replace(/[;:]$/, "")
    .replace(/^(['"])(.*)\1$/, "$2")
    .replace(/^(?:const\s+)+/, "")
    .replace(/^[*&]+|[&*]+$/g, "")
    .replace(/\[.*\]$/, "")
    .trim();
  if (language === "cpp" || language === "rust") {
    const wrappers =
      language === "cpp"
        ? /^(?:std::)?(?:unique_ptr|shared_ptr|weak_ptr|optional)<(.+)>$/
        : /^(?:Box|Arc|Rc|Pin)<(.+)>$/;
    for (;;) {
      const wrapped = wrappers.exec(normalized)?.[1]?.trim();
      if (!wrapped) break;
      normalized = wrapped;
    }
  } else {
    normalized = normalized.replace(/<.*>$/, "");
  }
  normalized = normalized.replace(/^[*&]+|[&*]+$/g, "").trim();
  return normalized || undefined;
}

function findParameterList(node: TSNode): TSNode | undefined {
  const direct = node.childForFieldName("parameters");
  if (direct) return direct;
  const body = node.childForFieldName("body");
  const queue = [...(node.namedChildren ?? [])];
  for (let depth = 0; queue.length > 0 && depth < 64; depth++) {
    const current = queue.shift()!;
    if (body && sameSyntaxNode(current, body)) continue;
    if (PARAMETER_LIST_TYPES.has(current.type)) return current;
    queue.push(...(current.namedChildren ?? []));
  }
  return undefined;
}

function parameterArity(node: TSNode, language: string, index: number): number {
  const text = node.text.trim();
  if (
    language === "rust" &&
    (node.type === "self_parameter" || /^(?:&\s*)?(?:mut\s+)?self\b/.test(text))
  )
    return 0;
  if (language === "python" && index === 0 && /^(?:self|cls)\b/.test(text))
    return 0;
  if (language === "go") {
    const typeNode = node.childForFieldName("type");
    const names = node.namedChildren.filter(
      (child) =>
        (!typeNode || !sameSyntaxNode(child, typeNode)) &&
        /identifier$/.test(child.type),
    );
    if (names.length > 0) return names.length;
  }
  return 1;
}

function sameSyntaxNode(left: TSNode, right: TSNode): boolean {
  return (
    left.type === right.type &&
    left.startIndex === right.startIndex &&
    left.endIndex === right.endIndex
  );
}
