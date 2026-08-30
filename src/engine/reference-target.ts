export type ReferenceReceiverTarget = {
  kind: "owner" | "super" | "qualified";
  name: string;
};

/** Reserved nominal container used to key C/C++ bare callback arrays. */
export const FUNCTION_POINTER_ARRAY_CONTAINER = "@array";

export type ReferenceResolutionHints = {
  receiverType?: string;
  /** How the receiver type was obtained; controls resolver trust boundaries. */
  receiverTypeEvidence?: {
    source:
      | "ast_type"
      | "binding"
      | "ast_assignment"
      | "text_fallback"
      | "cross_file_text_fallback";
    confidence: number;
  };
  candidateTypes?: string[];
  /** Symbol names whose declarations were followed to infer receiverType. */
  resolutionDependencies?: string[];
  genericBounds?: string[];
  dispatch?: "static" | "virtual" | "interface" | "trait" | "dynamic";
  callArity?: number;
  /** The callable or its receiver is a parameter/local binding. */
  lexicallyBound?: boolean;
  /** Factory callable from which a destructured local callable originated. */
  lexicalSource?: string;
  /** Runtime-selected call target retained from the source AST. */
  dynamicDispatch?: {
    form: "computed_member" | "getattr" | "reflection";
    /** Literal dispatch key when statically visible; absent for runtime keys. */
    key?: string;
    /** Namespace/value aliases from which the computed receiver was derived. */
    receiverSources?: string[];
  };
  /** High-precision C/C++ callback registration keyed by its storage slot. */
  functionPointerRegistration?: {
    containerType: string;
    field: string;
  };
};

export type ReferenceTarget = {
  raw: string;
  member: string;
  receiver?: ReferenceReceiverTarget;
  /** Optional semantic facts supplied by language-specific analysis. */
  hints?: ReferenceResolutionHints;
};

const OWNER_RECEIVERS = new Set(["this", "self", "cls"]);

/** Build a structured target while the source-language syntax is available. */
export function referenceTargetFromSyntax(raw: string): ReferenceTarget {
  const normalized = raw.replace(/->|::/g, ".");
  const separator = normalized.lastIndexOf(".");
  if (separator < 0) return { raw, member: normalized };
  const receiverRaw = normalized.slice(0, separator).replace(/\(\)$/, "");
  const member = normalized.slice(separator + 1);
  const kind =
    receiverRaw === "super"
      ? "super"
      : OWNER_RECEIVERS.has(receiverRaw)
        ? "owner"
        : "qualified";
  return { raw, member, receiver: { kind, name: receiverRaw } };
}

/** Compatibility fallback for persisted references created before target IR. */
export const referenceTargetFromRaw = referenceTargetFromSyntax;

export function memberReferenceTarget(
  raw: string,
  receiver: string,
  member: string,
): ReferenceTarget {
  const parsed = referenceTargetFromSyntax(`${receiver}.${member}`);
  return { ...parsed, raw };
}
