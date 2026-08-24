import type { ReferenceTarget } from "../../reference-target.js";
import type { LanguageAdapter } from "./adapter.js";
import {
  dynamicCallableAssignment,
  type DynamicCallableBinding,
} from "./dynamic-call-target.js";
import { isDeferredCallable } from "./callable-shape.js";
import { findIdentifierLeaf, type TSNode } from "./tree-sitter/nodes.js";

export type CallResolutionFact = {
  receiverTypes: ReadonlyMap<string, string>;
  /** Explicit union/choice annotations retained instead of collapsed to one type. */
  receiverCandidateTypes: ReadonlyMap<string, readonly string[]>;
  boundNames: ReadonlySet<string>;
  ownerFieldTypes: ReadonlyMap<string, string>;
  /** Declaring type + field name -> declared field type (for receiver chains). */
  declaredFieldTypes: ReadonlyMap<string, string>;
  /** Callable name -> declared return type, used by chained factory calls. */
  callableReturnTypes: ReadonlyMap<string, string>;
  dynamicReceivers: ReadonlyMap<string, readonly string[]>;
  genericBounds: ReadonlyMap<string, readonly string[]>;
  dynamicCallables: ReadonlyMap<string, ReferenceTarget>;
  language: string;
};

/** Build the type environment visible at each call site in source order. */
export function extractCallResolutionFacts(
  node: TSNode,
  adapter: LanguageAdapter,
  context?: {
    callableReturnTypes?: ReadonlyMap<string, string>;
  },
): ReadonlyMap<string, CallResolutionFact> {
  const resolutionRoot = callableResolutionRoot(node, adapter.format);
  const facts = new Map<string, CallResolutionFact>();
  const scopes: Map<string, string>[] = [
    initialBindings(resolutionRoot, adapter),
  ];
  const candidateScopes: Map<string, readonly string[]>[] = [
    initialBindingCandidates(resolutionRoot, adapter),
  ];
  const boundScopes: Set<string>[] = [
    initialBoundNames(resolutionRoot, adapter),
  ];
  const dynamicCallableScopes: Map<string, ReferenceTarget>[] = [new Map()];
  const ownerFieldTypes = collectOwnerFields(resolutionRoot, adapter.format);
  const declaredFieldTypes =
    adapter.collectDeclaredFieldTypes?.(resolutionRoot) ??
    new Map<string, string>();
  const callableReturnTypes = new Map([
    ...(context?.callableReturnTypes ?? []),
    ...(adapter.collectCallableReturnTypes?.(resolutionRoot) ?? []),
  ]);
  const ownerMethodReturns = collectOwnerMethodReturns(
    resolutionRoot,
    adapter.format,
  );
  for (const [name, returnType] of ownerMethodReturns)
    for (const receiver of ["this", "self", "cls"])
      callableReturnTypes.set(`${receiver}.${name}`, returnType);
  const dynamicReceivers = collectDynamicReceivers(resolutionRoot, adapter);
  const genericBounds = collectGenericBounds(resolutionRoot, adapter.format);

  const visit = (current: TSNode | null, skipSelfEntity: boolean): void => {
    if (!current) return;
    if (
      !skipSelfEntity &&
      adapter.entityTypes.has(current.type) &&
      adapter.shouldIndexEntity?.(current) !== false
    )
      return;

    const opensScope =
      !skipSelfEntity && opensLexicalScope(current.type, adapter.format);
    if (opensScope) {
      scopes.push(new Map());
      candidateScopes.push(new Map());
      boundScopes.push(new Set());
      dynamicCallableScopes.push(new Map());
    }

    if (DECLARATION_TYPES.has(current.type)) {
      // Initializers see the environment before their binding is introduced.
      for (const child of current.namedChildren ?? []) visit(child, false);
      const scope = scopes.at(-1)!;
      const boundScope = boundScopes.at(-1)!;
      for (const binding of declarationBindings(current, adapter.format))
        scope.set(binding.name, binding.type);
      for (const binding of declarationCandidateBindings(current))
        candidateScopes.at(-1)!.set(binding.name, binding.types);
      for (const name of declarationBindingNames(current)) boundScope.add(name);
      for (const binding of contextualDeclarationBindings(
        current,
        scopes,
        ownerMethodReturns,
        callableReturnTypes,
        adapter.format,
      )) {
        scope.set(binding.name, binding.type);
        candidateScopes.at(-1)!.set(binding.name, []);
      }
      if (opensScope) {
        scopes.pop();
        candidateScopes.pop();
        boundScopes.pop();
        dynamicCallableScopes.pop();
      }
      return;
    }

    if (current.type === "assignment") {
      for (const child of current.namedChildren ?? []) visit(child, false);
      for (const name of declarationBindingNames(current))
        candidateScopes.at(-1)!.set(name, []);
      for (const binding of contextualDeclarationBindings(
        current,
        scopes,
        ownerMethodReturns,
        callableReturnTypes,
        adapter.format,
      )) {
        scopes.at(-1)!.set(binding.name, binding.type);
        candidateScopes.at(-1)!.set(binding.name, []);
        boundScopes.at(-1)!.add(binding.name);
      }
      for (const binding of declarationCandidateBindings(current))
        candidateScopes.at(-1)!.set(binding.name, binding.types);
      updateDynamicCallableScope(
        dynamicCallableScopes.at(-1)!,
        current,
        dynamicCallableAssignment(current),
      );
      if (opensScope) {
        scopes.pop();
        candidateScopes.pop();
        boundScopes.pop();
        dynamicCallableScopes.pop();
      }
      return;
    }

    if (isCallNodeType(current.type)) {
      facts.set(callNodeKey(current), {
        receiverTypes: flattenScopes(scopes),
        receiverCandidateTypes: flattenScopes(candidateScopes),
        boundNames: flattenBoundScopes(boundScopes),
        ownerFieldTypes,
        declaredFieldTypes,
        callableReturnTypes,
        dynamicReceivers,
        genericBounds,
        dynamicCallables: flattenMapScopes(dynamicCallableScopes),
        language: adapter.format,
      });
    }
    for (const child of current.namedChildren ?? []) visit(child, false);
    if (opensScope) {
      scopes.pop();
      candidateScopes.pop();
      boundScopes.pop();
      dynamicCallableScopes.pop();
    }
  };

  visit(resolutionRoot, true);
  return facts;
}

/**
 * Python decorators wrap the callable AST node. Resolution still belongs to
 * the decorated entity, but parameters, lexical scopes and calls live on the
 * inner function. Starting at the wrapper causes the normal nested-entity
 * guard to skip the entire body.
 */
function callableResolutionRoot(node: TSNode, language: string): TSNode {
  if (language !== "python" || node.type !== "decorated_definition")
    return node;
  return (
    node.namedChildren.find((child) => child.type === "function_definition") ??
    node
  );
}

export function enrichTargetWithResolutionFact(
  target: ReferenceTarget,
  fact: CallResolutionFact | undefined,
  arity: number | undefined,
): ReferenceTarget {
  const arityHints = arity === undefined ? {} : { callArity: arity };
  const receiver = target.receiver?.name;
  if (!receiver) {
    const dynamicCallable = fact?.dynamicCallables.get(target.member);
    if (dynamicCallable) {
      return {
        ...dynamicCallable,
        hints: { ...dynamicCallable.hints, ...arityHints },
      };
    }
    const lexicalHints = fact?.boundNames.has(target.member)
      ? { lexicallyBound: true as const }
      : {};
    return Object.keys(arityHints).length === 0 &&
      Object.keys(lexicalHints).length === 0
      ? target
      : {
          ...target,
          hints: { ...target.hints, ...arityHints, ...lexicalHints },
        };
  }
  if (!fact) return target;
  const receiverTail = receiver.split(".").pop() ?? receiver;
  const indexedRoot = /^(?:this\.)?([A-Za-z_]\w*)\s*\[/.exec(receiver)?.[1];
  const dynamicTypes =
    fact.dynamicReceivers.get(receiver) ??
    fact.dynamicReceivers.get(receiverTail);
  const annotatedTypes =
    fact.receiverCandidateTypes.get(receiver) ??
    fact.receiverCandidateTypes.get(receiverTail);
  const receiverType =
    dynamicTypes?.[0] ??
    annotatedTypes?.[0] ??
    (isOwnerFieldReceiver(receiver)
      ? fact.ownerFieldTypes.get(receiverTail)
      : (fact.receiverTypes.get(receiver) ??
        fact.receiverTypes.get(receiverTail) ??
        (indexedRoot
          ? (fact.receiverTypes.get(`${indexedRoot}.$element`) ??
            fact.ownerFieldTypes.get(`${indexedRoot}.$element`))
          : undefined) ??
        inferDeclaredFieldChainType(receiver, fact) ??
        inferFactoryReceiverType(target, fact) ??
        fact.ownerFieldTypes.get(receiverTail))) ??
    inferChainedReceiverType(receiver, fact);
  if (!receiverType) return target;
  const bounds = fact.genericBounds.get(receiverType);
  const dynamicDispatch = Boolean(dynamicTypes?.length);
  return {
    ...target,
    hints: {
      ...target.hints,
      receiverType,
      ...arityHints,
      ...(bounds ? { genericBounds: [...bounds] } : {}),
      candidateTypes: dynamicTypes?.length
        ? [...dynamicTypes]
        : annotatedTypes?.length
          ? [...annotatedTypes]
          : bounds
            ? [receiverType, ...bounds]
            : [receiverType],
      ...(bounds && bounds.length > 0
        ? { dispatch: dispatchForLanguage(fact.language) }
        : annotatedTypes && annotatedTypes.length > 1
          ? { dispatch: dispatchForLanguage(fact.language) }
          : dynamicDispatch
            ? { dispatch: dispatchForLanguage(fact.language) }
            : VIRTUAL_LANGUAGES.has(fact.language)
              ? { dispatch: "virtual" as const }
              : {}),
    },
  };
}

function updateDynamicCallableScope(
  scope: Map<string, ReferenceTarget>,
  node: TSNode,
  binding: DynamicCallableBinding | undefined,
): void {
  const left = node.childForFieldName("left");
  if (!left || !/^[A-Za-z_$][\w$]*$/.test(left.text)) return;
  if (binding) scope.set(binding.name, binding.target);
  else scope.delete(left.text);
}

function flattenMapScopes<T>(
  scopes: readonly Map<string, T>[],
): Map<string, T> {
  const result = new Map<string, T>();
  for (const scope of scopes)
    for (const [key, value] of scope) result.set(key, value);
  return result;
}

export function callNodeKey(node: TSNode): string {
  return `${node.type}:${node.startIndex}:${node.endIndex}`;
}

const VIRTUAL_LANGUAGES = new Set(["java", "cpp", "typescript", "tsx"]);
const PARAMETER_TYPES = new Set([
  "parameter_declaration",
  "formal_parameter",
  "receiver_parameter",
  "parameter",
  "required_parameter",
  "optional_parameter",
  "typed_parameter",
  "typed_default_parameter",
  "variadic_parameter_declaration",
]);
const DECLARATION_TYPES = new Set([
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

function initialBindings(
  node: TSNode,
  adapter: LanguageAdapter,
): Map<string, string> {
  const bindings = new Map<string, string>();
  const parameters =
    node.childForFieldName("parameters") ??
    node.namedChildren.find((child) => /parameters/.test(child.type));
  const collect = (current: TSNode): void => {
    if (PARAMETER_TYPES.has(current.type)) {
      const binding = parameterBinding(current, adapter.format);
      if (binding) bindings.set(binding.name, binding.type);
      return;
    }
    for (const child of current.namedChildren ?? []) collect(child);
  };
  if (parameters) collect(parameters);
  else collectSignatureParameters(node, node, adapter, bindings);

  const receiver = node.childForFieldName("receiver");
  if (receiver) {
    const binding = parameterBinding(receiver, adapter.format);
    if (binding) bindings.set(binding.name, binding.type);
  }
  return bindings;
}

function initialBindingCandidates(
  node: TSNode,
  adapter: LanguageAdapter,
): Map<string, readonly string[]> {
  const bindings = new Map<string, readonly string[]>();
  const parameters =
    node.childForFieldName("parameters") ??
    node.namedChildren.find((child) => /parameters/.test(child.type));
  const collect = (current: TSNode): void => {
    if (PARAMETER_TYPES.has(current.type)) {
      const binding = rawParameterBinding(current, adapter.format);
      if (!binding) return;
      const candidates = normalizeTypeCandidates(binding.type);
      if (candidates.length > 1) bindings.set(binding.name, candidates);
      return;
    }
    for (const child of current.namedChildren ?? []) collect(child);
  };
  if (parameters) collect(parameters);
  const receiver = node.childForFieldName("receiver");
  if (receiver) collect(receiver);
  return bindings;
}

function initialBoundNames(
  node: TSNode,
  adapter: LanguageAdapter,
): Set<string> {
  const names = new Set<string>();
  const parameters =
    node.childForFieldName("parameters") ??
    node.namedChildren.find((child) => /parameters/.test(child.type));
  if (!parameters) return names;

  const collect = (current: TSNode): void => {
    if (PARAMETER_TYPES.has(current.type)) {
      const name = parameterBindingName(current, adapter.format);
      if (name) names.add(name);
      return;
    }
    if (
      current.parent?.startIndex === parameters.startIndex &&
      current.parent?.endIndex === parameters.endIndex &&
      /^(?:identifier|shorthand_property_identifier)$/.test(current.type)
    ) {
      names.add(current.text);
      return;
    }
    for (const child of current.namedChildren ?? []) collect(child);
  };
  collect(parameters);
  return names;
}

function collectDynamicReceivers(
  node: TSNode,
  adapter: LanguageAdapter,
): Map<string, readonly string[]> {
  const receivers = new Map<string, readonly string[]>();
  if (adapter.format !== "rust") return receivers;
  const parameters =
    node.childForFieldName("parameters") ??
    node.namedChildren.find((child) => /parameters/.test(child.type));
  const collect = (current: TSNode): void => {
    if (PARAMETER_TYPES.has(current.type)) {
      const binding = parameterBinding(current, adapter.format);
      const traits = extractDynTraits(current.text);
      if (binding && traits.length > 0) receivers.set(binding.name, traits);
      return;
    }
    for (const child of current.namedChildren ?? []) collect(child);
  };
  if (parameters) collect(parameters);
  return receivers;
}

function extractDynTraits(typeText: string): string[] {
  const traits: string[] = [];
  for (const match of typeText.matchAll(/\bdyn\s+([A-Za-z_]\w*(?:::\w+)*)/g))
    traits.push(match[1]!.split("::").pop()!);
  return [...new Set(traits)];
}

function collectSignatureParameters(
  current: TSNode,
  root: TSNode,
  adapter: LanguageAdapter,
  bindings: Map<string, string>,
): void {
  const body = root.childForFieldName("body");
  if (body && sameSyntaxNode(current, body)) return;
  if (
    !sameSyntaxNode(current, root) &&
    adapter.entityTypes.has(current.type) &&
    adapter.shouldIndexEntity?.(current) !== false
  )
    return;
  if (PARAMETER_TYPES.has(current.type)) {
    const binding = parameterBinding(current, adapter.format);
    if (binding) bindings.set(binding.name, binding.type);
    return;
  }
  for (const child of current.namedChildren ?? [])
    collectSignatureParameters(child, root, adapter, bindings);
}

function collectOwnerFields(
  node: TSNode,
  language: string,
): Map<string, string> {
  const bindings = new Map<string, string>();
  let parent = node.parent;
  for (let depth = 0; parent && depth < 5; depth++, parent = parent.parent) {
    if (!isOwnerContainer(parent.type)) continue;
    if (language === "python") collectPythonConstructorFields(parent, bindings);
    if (["javascript", "jsx", "typescript", "tsx"].includes(language))
      collectJavaScriptConstructorFields(parent, bindings);
    const visit = (current: TSNode): void => {
      // Owner fields live outside every executable body, including the
      // current method. Entering it lets later locals overwrite a field type.
      if (/method|function|constructor/.test(current.type)) {
        const getter = current.text.match(
          /^\s*(?:(?:public|private|protected|static)\s+)*get\s+([A-Za-z_]\w*)\s*\([^)]*\)\s*:\s*([^\s{]+)/,
        );
        if (getter) bindings.set(getter[1]!, normalizeType(getter[2]!));
        return;
      }
      if (DECLARATION_TYPES.has(current.type)) {
        for (const binding of declarationBindings(current, language))
          bindings.set(binding.name, binding.type);
      }
      for (const child of current.namedChildren ?? []) visit(child);
    };
    visit(parent);
    break;
  }
  return bindings;
}

function isOwnerContainer(nodeType: string): boolean {
  return /^(?:class(?:_declaration|_definition|_specifier)?|struct(?:_item|_specifier|_declaration)?|impl_item)$/.test(
    nodeType,
  );
}

function collectPythonConstructorFields(
  classNode: TSNode,
  bindings: Map<string, string>,
): void {
  const body = classNode.childForFieldName("body");
  const constructor = body?.namedChildren.find(
    (child) =>
      child.type === "function_definition" &&
      child.childForFieldName("name")?.text === "__init__",
  );
  if (!constructor) return;
  collectConstructedOwnerFields(
    constructor.text,
    /\bself\.([A-Za-z_]\w*)\s*=\s*(?:await\s+)?((?:[A-Za-z_$]\w*\.)*[A-Z][A-Za-z0-9_$]*)\s*\(/g,
    bindings,
  );
  const parameters = new Map<string, string>();
  const inferredFields = new Map<string, Set<string>>();
  const explicitlyTypedFields = new Map<string, string>();
  const collectParameter = (current: TSNode): void => {
    if (PARAMETER_TYPES.has(current.type)) {
      const binding = parameterBinding(current, "python");
      if (binding) parameters.set(binding.name, binding.type);
      return;
    }
    for (const child of current.namedChildren ?? []) collectParameter(child);
  };
  const parameterList = constructor.childForFieldName("parameters");
  if (parameterList) collectParameter(parameterList);

  const visit = (current: TSNode): void => {
    if (
      current !== constructor &&
      /^(?:function_definition|class_definition|lambda)$/.test(current.type)
    )
      return;
    if (current.type === "assignment") {
      const left = current.childForFieldName("left")?.text.trim();
      const right = current.childForFieldName("right")?.text.trim();
      const field = /^self\.([A-Za-z_]\w*)$/.exec(left ?? "")?.[1];
      const parameterType = right ? parameters.get(right) : undefined;
      if (field && parameterType) {
        const candidates = inferredFields.get(field) ?? new Set<string>();
        candidates.add(parameterType);
        inferredFields.set(field, candidates);
      }
      const constructedType = right
        ? /^(?:await\s+)?((?:[A-Za-z_$]\w*\.)*[A-Z][A-Za-z0-9_$]*)\s*\(/.exec(
            right,
          )?.[1]
        : undefined;
      if (field && constructedType && !bindings.has(field))
        bindings.set(field, normalizeType(constructedType));

      const annotated = current.text.match(
        /^self\.([A-Za-z_]\w*)\s*:\s*([^=\n]+)/,
      );
      if (annotated)
        explicitlyTypedFields.set(annotated[1]!, normalizeType(annotated[2]!));
    }
    for (const child of current.namedChildren ?? []) visit(child);
  };
  visit(constructor);
  for (const [field, type] of explicitlyTypedFields)
    if (!bindings.has(field)) bindings.set(field, type);
  for (const [field, types] of inferredFields)
    if (!bindings.has(field) && types.size === 1)
      bindings.set(field, types.values().next().value!);
}

function collectJavaScriptConstructorFields(
  classNode: TSNode,
  bindings: Map<string, string>,
): void {
  const body = classNode.childForFieldName("body");
  const constructor = body?.namedChildren.find((child) => {
    if (!/method|constructor/.test(child.type)) return false;
    return (
      child.childForFieldName("name")?.text === "constructor" ||
      /^\s*constructor\s*\(/.test(child.text)
    );
  });
  if (!constructor) return;
  collectConstructedOwnerFields(
    constructor.text,
    /\bthis\.([A-Za-z_$][\w$]*)\s*=\s*new\s+([A-Za-z_$][\w$.:]*)\s*(?:<[^;=(){}]+>)?\s*\(/g,
    bindings,
  );
  const visit = (current: TSNode): void => {
    if (
      current !== constructor &&
      /^(?:function|function_declaration|function_expression|arrow_function|method_definition|class|class_declaration|class_expression)$/.test(
        current.type,
      )
    )
      return;
    if (/assignment/.test(current.type)) {
      const match = current.text.match(
        /^this\.([A-Za-z_$][\w$]*)\s*=\s*new\s+([A-Za-z_$][\w$.:]*)\s*(?:<[^;=(){}]+>)?\s*\(/,
      );
      if (match && !bindings.has(match[1]!))
        bindings.set(match[1]!, normalizeType(match[2]!));
    }
    for (const child of current.namedChildren ?? []) visit(child);
  };
  visit(constructor);
}

function collectConstructedOwnerFields(
  constructorText: string,
  pattern: RegExp,
  bindings: Map<string, string>,
): void {
  for (const match of constructorText.matchAll(pattern)) {
    const field = match[1];
    const type = match[2];
    if (field && type && !bindings.has(field))
      bindings.set(field, normalizeType(type));
  }
}

function inferDeclaredFieldChainType(
  receiver: string,
  fact: CallResolutionFact,
): string | undefined {
  const segments = receiver.split(".").filter(Boolean);
  if (segments.length < 2) return undefined;
  const initialType =
    fact.receiverTypes.get(segments[0]!) ??
    fact.ownerFieldTypes.get(segments[0]!);
  if (!initialType) return undefined;
  let currentType: string = initialType;
  for (const field of segments.slice(1)) {
    const declaringType = currentType.split(".").pop() ?? currentType;
    const next: string | undefined =
      fact.declaredFieldTypes.get(`${currentType}.${field}`) ??
      fact.declaredFieldTypes.get(`${declaringType}.${field}`);
    if (!next) return undefined;
    currentType = next;
  }
  return currentType;
}

function inferFactoryReceiverType(
  target: ReferenceTarget,
  fact: CallResolutionFact,
): string | undefined {
  // The constructor node already proves the produced nominal type; do not
  // require a synthetic constructor return signature to resolve an outer
  // chained call such as `new GsonBuilder().create()`.
  const constructed = /^new\s+([A-Za-z_$][\w$.:]*)\s*(?:[<(]|$)/.exec(
    target.receiver?.name ?? "",
  )?.[1];
  if (constructed) return normalizeType(constructed);

  const receiverExpression = target.raw.slice(
    0,
    Math.max(0, target.raw.lastIndexOf(`.${target.member}`)),
  );
  const factory =
    /([A-Za-z_$][\w$]*(?:(?:::|\.)[A-Za-z_$][\w$]*)*)\s*\([^()]*\)\s*$/.exec(
      receiverExpression,
    )?.[1];
  if (!factory) return undefined;
  const tail = factory.split(/::|\./).at(-1)!;
  const exact =
    fact.callableReturnTypes.get(factory) ??
    fact.callableReturnTypes.get(factory.replace(/\./g, "::")) ??
    fact.callableReturnTypes.get(factory.replace(/::/g, "."));
  if (exact) return exact;
  return factory === tail ? fact.callableReturnTypes.get(tail) : undefined;
}

function collectOwnerMethodReturns(
  node: TSNode,
  language: string,
): Map<string, string> {
  const returns = new Map<string, string>();
  let parent = node.parent;
  for (let depth = 0; parent && depth < 3; depth++, parent = parent.parent) {
    if (!/class|struct|impl/.test(parent.type)) continue;
    const ownerType =
      parent.childForFieldName("name")?.text ??
      parent.childForFieldName("type")?.text;
    const visit = (current: TSNode): void => {
      if (/method|function/.test(current.type)) {
        if (isDeferredCallable(current, language)) return;
        const name = current.childForFieldName("name")?.text;
        const returnType = current.childForFieldName("return_type")?.text;
        const signatureReturn =
          returnType ??
          current.text
            .slice(0, Math.max(0, current.text.indexOf("{")))
            .match(/\)\s*:\s*([^\s{]+)|\)\s*->\s*([^\s{]+)/)
            ?.slice(1)
            .find(Boolean);
        if (name && signatureReturn) {
          const normalized = normalizeType(signatureReturn);
          returns.set(
            name,
            isSelfReturnType(normalized) && ownerType
              ? normalizeType(ownerType)
              : normalized,
          );
        }
        return;
      }
      for (const child of current.namedChildren ?? []) visit(child);
    };
    visit(parent);
    break;
  }
  return returns;
}

function isSelfReturnType(value: string): boolean {
  return /^(?:Self|self|this)$/.test(value);
}

function isOwnerFieldReceiver(receiver: string): boolean {
  return /^(?:this|self|cls)\./.test(receiver);
}

function flattenScopes<T>(
  scopes: readonly ReadonlyMap<string, T>[],
): Map<string, T> {
  const result = new Map<string, T>();
  for (const scope of scopes)
    for (const [name, value] of scope) result.set(name, value);
  return result;
}

function flattenBoundScopes(
  scopes: readonly ReadonlySet<string>[],
): Set<string> {
  const result = new Set<string>();
  for (const scope of scopes) for (const name of scope) result.add(name);
  return result;
}

function opensLexicalScope(type: string, language: string): boolean {
  if (language === "python") return false;
  return new Set([
    "statement_block",
    "compound_statement",
    "block",
    "for_statement",
    "for_in_statement",
    "enhanced_for_statement",
    "while_statement",
    "catch_clause",
  ]).has(type);
}

function declarationBindings(
  node: TSNode,
  language: string,
): { name: string; type: string }[] {
  const text = node.text.trim();
  const results: { name: string; type: string }[] = [];
  const typed = text.match(
    /^(?:(?:public|private|protected|readonly|static|declare|const|let|var)\s+)*([A-Za-z_]\w*)\s*[!?]?\s*:\s*([^=;,]+)/,
  );
  if (typed) results.push({ name: typed[1]!, type: normalizeType(typed[2]!) });
  const explicit = text.match(
    /(?:^|\b(?:const|let|var)\s+)([A-Za-z_]\w*)\s*:\s*([A-Za-z_][^\s=;,)]*)/,
  );
  if (explicit)
    results.push({ name: explicit[1]!, type: normalizeType(explicit[2]!) });
  const cFamily = text.match(
    /^\s*([A-Za-z_][^\s=;,)]*)\s+([A-Za-z_]\w*)\s*(?:[=;,)])?/,
  );
  if (cFamily && !/^(?:const|let|var|return|new)$/.test(cFamily[1]!)) {
    results.push({ name: cFamily[2]!, type: normalizeType(cFamily[1]!) });
    const elementType = collectionElementType(cFamily[1]!);
    if (elementType)
      results.push({ name: `${cFamily[2]!}.$element`, type: elementType });
  }
  if (language === "java") {
    const javaField = text.match(
      /^\s*(?:(?:public|protected|private|static|final|volatile|transient)\s+)*([A-Za-z_][\w.<>, ?[\]]*)\s+([A-Za-z_]\w*)\s*(?:[=;])?/,
    );
    if (javaField)
      results.push({
        name: javaField[2]!,
        type: normalizeType(javaField[1]!),
      });
  }
  const constructed = constructedBinding(text, language);
  if (constructed) results.push(constructed);
  const arrayLiteral = text.match(
    /(?:^|\b(?:const|let|var)\s+)([A-Za-z_]\w*)\s*=\s*\[/,
  );
  if (arrayLiteral) results.push({ name: arrayLiteral[1]!, type: "Array" });
  const mapConstructor = text.match(
    /(?:^|\b(?:const|let|var)\s+)([A-Za-z_]\w*)\s*=\s*new\s+Map\s*<[^,]+,\s*([^>]+)>/,
  );
  if (mapConstructor)
    results.push({
      name: `${mapConstructor[1]!}.$value`,
      type: normalizeType(mapConstructor[2]!),
    });
  if (language === "go") {
    const go = text.match(/^\s*var\s+([A-Za-z_]\w*)\s+([A-Za-z_][\w.]*)/);
    if (go) results.push({ name: go[1]!, type: normalizeType(go[2]!) });
  }
  return results;
}

function constructedBinding(
  text: string,
  language: string,
): { name: string; type: string } | undefined {
  // Explicit `new` and composite literals carry a nominal type in their
  // syntax. An arbitrary `value = Factory()` does not: treating the callable
  // name as a type produced false hints such as `chi.NewRouter`.
  const explicit = text.match(
    /([A-Za-z_]\w*)\s*(?::=|=)\s*new\s+([A-Za-z_][\w.:]*)\s*(?:<[^;=(){}]+>)?\s*\(/,
  );
  if (explicit)
    return { name: explicit[1]!, type: normalizeType(explicit[2]!) };

  const composite = text.match(
    /([A-Za-z_]\w*)\s*(?::=|=)\s*&?([A-Za-z_][\w.:]*)\s*\{/,
  );
  if (composite)
    return { name: composite[1]!, type: normalizeType(composite[2]!) };

  // Python class construction has no `new` keyword. A qualified callable
  // whose final segment starts with an upper-case letter is the strongest
  // syntax-level nominal signal available without executing imports. Keep
  // lower-case factories out of this path: their return annotations are
  // handled by `callableReturnTypes`, and guessing their type from the
  // callable name creates false receiver hints.
  if (language === "python") {
    const pythonConstructor = text.match(
      /([A-Za-z_]\w*)\s*=\s*(?:await\s+)?((?:[A-Za-z_]\w*\.)*[A-Z][A-Za-z0-9_]*)\s*\(/,
    );
    if (pythonConstructor)
      return {
        name: pythonConstructor[1]!,
        type: normalizeType(pythonConstructor[2]!),
      };
  }

  if (language !== "go") return undefined;
  const goFactory = text.match(
    /([A-Za-z_]\w*)\s*(?::=|=)\s*(?:[A-Za-z_]\w*\.)*New([A-Z][A-Za-z0-9_]*)\s*\(/,
  );
  return goFactory
    ? { name: goFactory[1]!, type: normalizeType(goFactory[2]!) }
    : undefined;
}

function declarationCandidateBindings(
  node: TSNode,
): { name: string; types: readonly string[] }[] {
  const annotated = node.text
    .trim()
    .match(/(?:^|\b(?:const|let|var)\s+)([A-Za-z_$][\w$]*)\s*:\s*([^=;\n]+)/);
  if (!annotated) return [];
  const types = normalizeTypeCandidates(annotated[2]!);
  return [{ name: annotated[1]!, types: types.length > 1 ? types : [] }];
}

function declarationBindingNames(node: TSNode): string[] {
  const result = new Set<string>();
  const direct =
    node.childForFieldName("name") ??
    node.childForFieldName("pattern") ??
    node.childForFieldName("left");
  if (direct && /^[A-Za-z_$][\w$]*$/.test(direct.text)) result.add(direct.text);
  for (const match of node.text.matchAll(
    /(?:^|\b(?:const|let|var)\s+)([A-Za-z_$][\w$]*)\s*(?::|:=|=)/g,
  ))
    result.add(match[1]!);
  return [...result];
}

function collectionElementType(typeText: string): string | undefined {
  const outer = typeText
    .match(/^([\w:]+)\s*</)?.[1]
    ?.split("::")
    .pop();
  if (
    !outer ||
    !new Set([
      "array",
      "deque",
      "list",
      "map",
      "set",
      "unordered_map",
      "unordered_set",
      "vector",
      "Array",
      "Map",
      "Set",
      "Vec",
    ]).has(outer)
  )
    return undefined;
  const identifiers = [...typeText.matchAll(/[A-Za-z_]\w*/g)].map(
    (match) => match[0],
  );
  const wrappers = new Set([
    outer,
    "std",
    "unique_ptr",
    "shared_ptr",
    "weak_ptr",
    "Box",
    "Arc",
    "Rc",
    "const",
  ]);
  const leaf = identifiers.filter((name) => !wrappers.has(name)).at(-1);
  return leaf ? normalizeType(leaf) : undefined;
}

function contextualDeclarationBindings(
  node: TSNode,
  scopes: readonly ReadonlyMap<string, string>[],
  ownerMethodReturns: ReadonlyMap<string, string>,
  callableReturnTypes: ReadonlyMap<string, string>,
  language: string,
): { name: string; type: string }[] {
  const text = node.text.trim();
  const constructed = constructedBinding(text, language);
  if (constructed) return [constructed];
  const assignment = text.match(
    /(?:^|\b(?:const|let|var)\s+)([A-Za-z_]\w*)\s*=\s*(.+)/s,
  );
  if (!assignment) return [];
  const name = assignment[1]!;
  const initializer = assignment[2]!;
  const mapGet = initializer.match(/^([A-Za-z_]\w*)\.get\s*\(/);
  if (mapGet) {
    const valueType = lookupBinding(scopes, `${mapGet[1]!}.$value`);
    if (valueType) return [{ name, type: valueType }];
  }
  const ownerCall = initializer.match(/^this\.([A-Za-z_]\w*)\s*\(/);
  if (ownerCall) {
    const returnType = ownerMethodReturns.get(ownerCall[1]!);
    if (returnType) return [{ name, type: returnType }];
  }
  const factoryCall = initializer.match(
    /^(?:await\s+)?(?:new\s+)?([A-Za-z_$][\w$]*)\s*\(/,
  );
  if (factoryCall) {
    const returnType = callableReturnTypes.get(factoryCall[1]!);
    if (returnType) return [{ name, type: returnType }];
  }
  if (/^this\.(?:db|database\.db)\.prepare\s*\(/.test(initializer))
    return [{ name, type: "StatementSync" }];
  return [];
}

function inferChainedReceiverType(
  receiver: string,
  fact: CallResolutionFact,
): string | undefined {
  const sqliteRoot = /^(?:this\.)?(db|database\.db)\b/.exec(receiver)?.[1];
  if (!sqliteRoot) return undefined;
  const rootType =
    sqliteRoot === "db" ? fact.ownerFieldTypes.get("db") : undefined;
  if (rootType && !["DatabaseSync", "NodeDatabaseSync"].includes(rootType))
    return undefined;
  if (/\.prepare\s*\(/.test(receiver)) {
    if (/\.all\b/.test(receiver)) return "Array";
    return "StatementSync";
  }
  return undefined;
}

function lookupBinding(
  scopes: readonly ReadonlyMap<string, string>[],
  name: string,
): string | undefined {
  for (let index = scopes.length - 1; index >= 0; index--) {
    const value = scopes[index]!.get(name);
    if (value) return value;
  }
  return undefined;
}

function parameterBinding(
  node: TSNode,
  language: string,
): { name: string; type: string } | undefined {
  const binding = rawParameterBinding(node, language);
  return binding
    ? { name: binding.name, type: normalizeType(binding.type) }
    : undefined;
}

function rawParameterBinding(
  node: TSNode,
  language: string,
): { name: string; type: string } | undefined {
  const declarator = node.childForFieldName("declarator");
  const name =
    node.childForFieldName("name")?.text ??
    node.childForFieldName("pattern")?.text ??
    (declarator ? findIdentifierLeaf(declarator)?.text : undefined) ??
    node.namedChildren.find((child) => child.type === "identifier")?.text;
  const type = node.childForFieldName("type")?.text;
  if (name && type) return { name, type };
  const text = node.text.trim().replace(/^\(|\)$/g, "");
  const match =
    language === "go"
      ? text.match(/^([A-Za-z_]\w*)\s+\*?([A-Za-z_]\w*(?:\[[^\]]+\])?)$/)
      : language === "rust"
        ? text.match(/^(?:mut\s+)?([A-Za-z_]\w*)\s*:\s*&?(?:mut\s+)?([^=]+)$/)
        : text.match(/(?:^|\s)([A-Za-z_]\w*)\s*$/);
  if (!match) return undefined;
  if (language === "go" || language === "rust")
    return { name: match[1]!, type: match[2]! };
  const inferredType = text.slice(0, text.lastIndexOf(match[1]!)).trim();
  return inferredType ? { name: match[1]!, type: inferredType } : undefined;
}

function parameterBindingName(
  node: TSNode,
  language: string,
): string | undefined {
  const direct =
    node.childForFieldName("name") ??
    node.childForFieldName("pattern") ??
    node.namedChildren.find((child) => child.type === "identifier");
  if (direct && /^[A-Za-z_$][\w$]*$/.test(direct.text)) return direct.text;
  const text = node.text.trim().replace(/^\(|\)$/g, "");
  const match =
    language === "go"
      ? text.match(/^([A-Za-z_]\w*)\s+/)
      : language === "rust"
        ? text.match(/^(?:mut\s+)?([A-Za-z_]\w*)\s*:/)
        : text.match(/^([A-Za-z_$][\w$]*)\s*(?::|=|$)/);
  return match?.[1];
}

function collectGenericBounds(
  node: TSNode,
  language: string,
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
    genericNode =
      owner.childForFieldName("type_parameters") ??
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
    const name = pieces
      .shift()
      ?.replace(/^(?:typename|class)\s+/, "")
      .trim();
    if (!name || pieces.length === 0) continue;
    const bounds = pieces
      .join(":")
      .split(/[+&]/)
      .map(normalizeType)
      .filter(Boolean);
    if (bounds.length > 0) result.set(name, bounds);
  }
  return result;
}

function dispatchForLanguage(
  language: string,
): "interface" | "trait" | "virtual" {
  if (language === "rust") return "trait";
  if (language === "go" || language === "java") return "interface";
  return "virtual";
}

function normalizeType(value: string): string {
  const trimmed = value.trim();
  if (/\[\s*\]$/.test(trimmed)) return "Array";
  const wrapped = /^(?:(?:typing\.)?(?:Union|Optional))\s*\[(.*)\]$/.exec(
    trimmed,
  )?.[1];
  const choices = (wrapped ?? (trimmed.includes("|") ? trimmed : ""))
    .split(wrapped ? /\s*,\s*/ : /\s*\|\s*/)
    .filter(Boolean)
    .filter(
      (candidate) =>
        !/^(?:null|undefined|None|NoneType)$/.test(candidate.trim()),
    );
  if (choices.length > 0) return normalizeType(choices[0]!);
  return (
    trimmed
      .replace(/\b(?:const|volatile|mut|typename|class)\b/g, "")
      .replace(/[&*]/g, "")
      .replace(/<.*>|\[.*\]/g, "")
      .trim()
      .split(/\s+/)
      .pop() ?? ""
  );
}

function normalizeTypeCandidates(value: string): string[] {
  const trimmed = value.trim();
  const wrapped = /^(?:(?:typing\.)?(?:Union|Optional))\s*\[(.*)\]$/.exec(
    trimmed,
  )?.[1];
  const parts = (wrapped ?? trimmed).split(wrapped ? /\s*,\s*/ : /\s*\|\s*/);
  const ignored = new Set(["null", "undefined", "None", "NoneType"]);
  return [
    ...new Set(
      parts
        .map(normalizeType)
        .filter((candidate) => candidate && !ignored.has(candidate)),
    ),
  ];
}

function isCallNodeType(type: string): boolean {
  return [
    "call",
    "call_expression",
    "function_call_expression",
    "method_invocation",
    "object_creation_expression",
    "new_expression",
  ].includes(type);
}

function sameSyntaxNode(left: TSNode, right: TSNode): boolean {
  return (
    left.type === right.type &&
    left.startIndex === right.startIndex &&
    left.endIndex === right.endIndex
  );
}
