import {
  bareName,
  isExternalReceiverName,
  isExternalReceiverType,
  isExternalRefName,
} from "./builtins.js";
import type {
  ReferenceResolutionHints,
  ReferenceTarget,
} from "../reference-target.js";

const OWNER_RECEIVERS = new Set(["this", "self", "cls"]);

export type ReferenceBindingMatch = {
  importedName: string;
  fileId: string;
  kind: "exact" | "receiver";
};

export type ReferenceReceiver =
  | { kind: "none" }
  | { kind: "owner"; name: string; includeOwner: boolean }
  | { kind: "qualified"; name: string };

export type AnalyzedReference = {
  name: string;
  bareName: string;
  language?: string;
  receiver: ReferenceReceiver;
  hints?: ReferenceResolutionHints;
};

export type ReferenceResolutionContext = {
  reference: AnalyzedReference;
  owner: { fileId: string; containerId?: string; containerName?: string };
  receiver: ReferenceReceiver;
  binding?: ReferenceBindingMatch;
  preferredFileIds: readonly string[];
};

export type ReferenceLookupPlan = {
  lookupName: string;
  preferredFileIds: string[];
  allowBareFallback: boolean;
  containerScope:
    | { kind: "none" }
    | { kind: "owner-hierarchy"; includeOwner: boolean }
    | { kind: "owner-preferred" }
    | { kind: "named"; name: string };
};

export type LocalReferenceLookupPlan = Pick<
  ReferenceLookupPlan,
  "lookupName" | "containerScope"
> & {
  /** Full language-level name, used before receiver/container fallback. */
  qualifiedLookupName?: string;
};

/** Owns reference receiver, binding and scope semantics for every resolver. */
export class ReferenceResolutionPolicy {
  analyzeReference(
    input: string | ReferenceTarget,
    language?: string,
  ): AnalyzedReference {
    const target =
      typeof input === "string"
        ? {
            raw: input,
            member: bareName(input.replace(/->/g, ".")),
            receiver: legacyReceiver(input),
          }
        : input;
    const receiverName = target.receiver?.name;
    const receiver: ReferenceReceiver = !target.receiver
      ? { kind: "none" }
      : target.receiver.kind === "owner" || target.receiver.kind === "super"
        ? {
            kind: "owner",
            name: receiverName!,
            includeOwner: target.receiver.kind !== "super",
          }
        : { kind: "qualified", name: receiverName! };
    return {
      name: target.raw,
      bareName: target.member,
      language,
      receiver,
      hints: target.hints,
    };
  }

  localLookupPlan(
    reference: AnalyzedReference,
    ownerContainerName?: string,
  ): LocalReferenceLookupPlan {
    if (reference.receiver.kind === "owner") {
      return {
        lookupName: reference.bareName,
        containerScope: ownerContainerName
          ? {
              kind: "owner-hierarchy",
              includeOwner: reference.receiver.includeOwner,
            }
          : { kind: "none" },
      };
    }
    if (reference.receiver.kind === "qualified") {
      return {
        lookupName: reference.bareName,
        qualifiedLookupName: reference.name,
        containerScope: {
          kind: "named",
          name: reference.hints?.receiverType ?? reference.receiver.name,
        },
      };
    }
    return {
      lookupName: reference.name,
      containerScope: ownerContainerName
        ? { kind: "owner-preferred" }
        : { kind: "none" },
    };
  }

  createContext(
    reference: AnalyzedReference,
    input: {
      sourceFileId: string;
      ownerContainerId?: string;
      ownerContainerName?: string;
      preferredFileIds?: readonly string[];
      binding?: ReferenceBindingMatch;
    },
  ): ReferenceResolutionContext {
    return {
      reference,
      owner: {
        fileId: input.sourceFileId,
        containerId: input.ownerContainerId,
        containerName: input.ownerContainerName,
      },
      receiver: reference.receiver,
      binding: input.binding,
      preferredFileIds: input.preferredFileIds ?? [],
    };
  }

  lookupPlan(context: ReferenceResolutionContext): ReferenceLookupPlan {
    const { binding, owner, receiver, reference, preferredFileIds } = context;
    if (binding) {
      const receiverAccess = binding.kind === "receiver";
      return {
        lookupName: receiverAccess
          ? reference.bareName
          : binding.importedName === "*"
            ? reference.name
            : binding.importedName,
        preferredFileIds: [
          binding.fileId,
          ...preferredFileIds.filter((fileId) => fileId !== binding.fileId),
        ],
        allowBareFallback: false,
        containerScope:
          receiverAccess && binding.importedName !== "*"
            ? { kind: "named", name: binding.importedName }
            : { kind: "none" },
      };
    }
    if (receiver.kind === "owner") {
      return {
        lookupName: reference.bareName,
        preferredFileIds: [owner.fileId, ...preferredFileIds],
        allowBareFallback: false,
        containerScope: owner.containerName
          ? {
              kind: "owner-hierarchy",
              includeOwner: receiver.includeOwner,
            }
          : { kind: "none" },
      };
    }
    if (receiver.kind === "qualified") {
      return {
        // Preserve the full language-level identity, but do not degrade
        // `client.create()` to a workspace-wide lookup for `create`: an
        // untyped SDK/client receiver is not evidence that an unrelated local
        // method is its target. NameIndex normalizes `::`/`.` spellings for
        // real namespace/static members; imported namespaces use the binding
        // branch above.
        lookupName: reference.name,
        preferredFileIds: [owner.fileId, ...preferredFileIds],
        // `::` is also the canonical namespace/static separator in the
        // persisted C++/Rust symbol identity. Permit its scoped member lookup;
        // NameIndex still requires the named container and therefore cannot
        // borrow an unrelated local method. Chained object receivers using
        // `.`/`->` remain strict when their declared type is unknown.
        allowBareFallback: reference.name.includes("::"),
        containerScope: {
          kind: "named",
          name: reference.hints?.receiverType ?? receiver.name,
        },
      };
    }
    return {
      lookupName: reference.name,
      preferredFileIds: [...preferredFileIds],
      allowBareFallback: true,
      containerScope: owner.containerName
        ? { kind: "owner-preferred" }
        : { kind: "none" },
    };
  }

  isExternal(reference: AnalyzedReference): boolean {
    return isExternalRefName(reference.name, reference.language);
  }

  isExternalReceiver(reference: AnalyzedReference): boolean {
    return (
      reference.receiver.kind === "qualified" &&
      ((typeof reference.hints?.receiverType === "string" &&
        isExternalReceiverType(
          reference.hints.receiverType,
          reference.language,
        )) ||
        isExternalReceiverName(reference.receiver.name, reference.language))
    );
  }
}

function legacyReceiver(refName: string): ReferenceTarget["receiver"] {
  if (
    !refName.includes(".") &&
    !refName.includes("/") &&
    !refName.includes("->")
  )
    return undefined;
  const receiver = refName.split(/->|[./]/, 1)[0]?.replace(/\(\)$/, "");
  if (!receiver) return undefined;
  return {
    kind:
      receiver === "super"
        ? "super"
        : OWNER_RECEIVERS.has(receiver)
          ? "owner"
          : "qualified",
    name: receiver,
  };
}

export const referenceResolutionPolicy = new ReferenceResolutionPolicy();
