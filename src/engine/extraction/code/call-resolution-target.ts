import type { ReferenceTarget } from "../../reference-target.js";
import type { CallResolutionFact } from "./call-resolution-facts.js";
import { normalizeType } from "./call-resolution-facts.js";

const VIRTUAL_LANGUAGES = new Set(["java", "cpp", "typescript", "tsx"]);

/** Project a call-site environment onto the durable reference target IR. */
export function enrichTargetWithResolutionFact(
  target: ReferenceTarget,
  fact: CallResolutionFact | undefined,
  arity: number | undefined,
): ReferenceTarget {
  const arityHints = arity === undefined ? {} : { callArity: arity };
  const receiver = target.receiver?.name;
  if (!receiver) {
    const dynamicCallable = fact?.dynamicCallables.get(target.member);
    if (dynamicCallable)
      return {
        ...dynamicCallable,
        hints: { ...dynamicCallable.hints, ...arityHints },
      };
    const lexicalSource = fact?.lexicalCallableSources.get(target.member);
    const lexicalHints = fact?.boundNames.has(target.member)
      ? {
          lexicallyBound: true as const,
          ...(lexicalSource
            ? {
                lexicalSource,
                resolutionDependencies: [lexicalSource],
              }
            : {}),
        }
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
  const receiverTail = receiverSegmentName(
    receiver.split(".").pop() ?? receiver,
  );
  const lexicallyBoundReceiver =
    target.receiver?.kind === "qualified" &&
    (fact.boundNames.has(receiver) || fact.boundNames.has(receiverTail));
  const indexedRoot = /^(?:this\.)?([A-Za-z_]\w*)\s*\[/.exec(receiver)?.[1];
  const dynamicTypes =
    fact.dynamicReceivers.get(receiver) ??
    fact.dynamicReceivers.get(receiverTail);
  const annotatedTypes =
    fact.receiverCandidateTypes.get(receiver) ??
    fact.receiverCandidateTypes.get(receiverTail);
  const factoryReceiverType = inferFactoryReceiverType(target, fact);
  const receiverType =
    target.hints?.receiverType ??
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
        factoryReceiverType ??
        fact.ownerFieldTypes.get(receiverTail)));
  if (!receiverType)
    return lexicallyBoundReceiver
      ? {
          ...target,
          hints: {
            ...target.hints,
            ...arityHints,
            lexicallyBound: true,
          },
        }
      : target;
  const bounds = fact.genericBounds.get(receiverType);
  const dynamicDispatch = Boolean(dynamicTypes?.length);
  return {
    ...target,
    hints: {
      ...target.hints,
      receiverType,
      ...(factoryReceiverType === receiverType &&
      !target.hints?.receiverTypeEvidence
        ? {
            receiverTypeEvidence: {
              source: "text_fallback" as const,
              confidence: 0.4,
            },
          }
        : {}),
      ...arityHints,
      ...(bounds ? { genericBounds: [...bounds] } : {}),
      candidateTypes: dynamicTypes?.length
        ? [...dynamicTypes]
        : annotatedTypes?.length
          ? [...annotatedTypes]
          : bounds
            ? [receiverType, ...bounds]
            : [receiverType],
      ...(bounds?.length
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
  let currentType = initialType;
  for (const field of segments.slice(1)) {
    const declaringType = currentType.split(".").pop() ?? currentType;
    const next =
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
  if (
    ["javascript", "jsx", "typescript", "tsx"].includes(fact.language) &&
    /^[A-Z]/.test(tail)
  )
    return normalizeType(factory);
  return factory === tail ? fact.callableReturnTypes.get(tail) : undefined;
}

function isOwnerFieldReceiver(receiver: string): boolean {
  return /^(?:this|self|cls)\./.test(receiver);
}

function receiverSegmentName(value: string): string {
  return value.replace(/[!?]+$/g, "");
}

function dispatchForLanguage(
  language: string,
): "interface" | "trait" | "virtual" {
  if (language === "rust") return "trait";
  if (language === "go" || language === "java") return "interface";
  return "virtual";
}
