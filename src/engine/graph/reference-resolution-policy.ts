import { bareName, isExternalRefName } from "./builtins.js";

const OWNER_RECEIVERS = new Set(["this", "self", "cls", "super"]);

export type ReferenceBindingMatch = {
  importedName: string;
  fileId: string;
  kind: "exact" | "receiver";
};

export type ReferenceReceiver =
  | { kind: "none" }
  | { kind: "owner"; name: string }
  | { kind: "qualified"; name: string };

export type AnalyzedReference = {
  name: string;
  bareName: string;
  language?: string;
  receiver: ReferenceReceiver;
};

export type ReferenceResolutionContext = {
  reference: AnalyzedReference;
  owner: { fileId: string; containerName?: string };
  receiver: ReferenceReceiver;
  binding?: ReferenceBindingMatch;
  preferredFileIds: readonly string[];
};

export type ReferenceLookupPlan = {
  lookupName: string;
  preferredFileIds: string[];
  allowBareFallback: boolean;
  containerNames: string[];
};

export type LocalReferenceLookupPlan = Pick<
  ReferenceLookupPlan,
  "lookupName" | "containerNames"
>;

/** Owns reference receiver, binding and scope semantics for every resolver. */
export class ReferenceResolutionPolicy {
  analyzeReference(refName: string, language?: string): AnalyzedReference {
    const receiverName = qualifiedReceiver(refName);
    const receiver: ReferenceReceiver = !receiverName
      ? { kind: "none" }
      : OWNER_RECEIVERS.has(receiverName)
        ? { kind: "owner", name: receiverName }
        : { kind: "qualified", name: receiverName };
    return { name: refName, bareName: bareName(refName), language, receiver };
  }

  localLookupPlan(
    reference: AnalyzedReference,
    ownerContainerName?: string,
  ): LocalReferenceLookupPlan {
    if (reference.receiver.kind === "owner") {
      return {
        lookupName: reference.bareName,
        containerNames: ownerContainerName ? [ownerContainerName] : [],
      };
    }
    if (reference.receiver.kind === "qualified") {
      return {
        lookupName: reference.bareName,
        containerNames: [reference.receiver.name],
      };
    }
    return { lookupName: reference.name, containerNames: [] };
  }

  createContext(
    reference: AnalyzedReference,
    input: {
      sourceFileId: string;
      ownerContainerName?: string;
      preferredFileIds?: readonly string[];
      binding?: ReferenceBindingMatch;
    },
  ): ReferenceResolutionContext {
    return {
      reference,
      owner: {
        fileId: input.sourceFileId,
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
        lookupName: receiverAccess ? reference.bareName : binding.importedName,
        preferredFileIds: [binding.fileId],
        allowBareFallback: false,
        containerNames:
          receiverAccess && binding.importedName !== "*"
            ? [binding.importedName]
            : [],
      };
    }
    if (receiver.kind === "owner") {
      return {
        lookupName: reference.bareName,
        preferredFileIds: [owner.fileId, ...preferredFileIds],
        allowBareFallback: false,
        containerNames: owner.containerName ? [owner.containerName] : [],
      };
    }
    if (receiver.kind === "qualified") {
      return {
        lookupName: reference.bareName,
        preferredFileIds: [owner.fileId],
        allowBareFallback: false,
        containerNames: [receiver.name],
      };
    }
    return {
      lookupName: reference.name,
      preferredFileIds: [...preferredFileIds],
      allowBareFallback: true,
      containerNames: [],
    };
  }

  isExternal(reference: AnalyzedReference): boolean {
    return isExternalRefName(reference.name, reference.language);
  }
}

function qualifiedReceiver(refName: string): string | undefined {
  if (!refName.includes(".") && !refName.includes("/")) return undefined;
  return refName.split(/[./]/, 1)[0] || undefined;
}

export const referenceResolutionPolicy = new ReferenceResolutionPolicy();
