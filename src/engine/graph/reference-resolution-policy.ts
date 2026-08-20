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

export type ReferenceResolutionContext = {
  reference: { name: string; bareName: string; language?: string };
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

/** Owns reference receiver, binding and scope semantics for every resolver. */
export class ReferenceResolutionPolicy {
  createContext(input: {
    refName: string;
    sourceFileId: string;
    sourceLanguage?: string;
    ownerContainerName?: string;
    preferredFileIds?: readonly string[];
    binding?: ReferenceBindingMatch;
  }): ReferenceResolutionContext {
    const receiverName = qualifiedReceiver(input.refName);
    const receiver: ReferenceReceiver = !receiverName
      ? { kind: "none" }
      : OWNER_RECEIVERS.has(receiverName)
        ? { kind: "owner", name: receiverName }
        : { kind: "qualified", name: receiverName };
    return {
      reference: {
        name: input.refName,
        bareName: bareName(input.refName),
        language: input.sourceLanguage,
      },
      owner: {
        fileId: input.sourceFileId,
        containerName: input.ownerContainerName,
      },
      receiver,
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

  isExternal(context: ReferenceResolutionContext): boolean {
    return isExternalRefName(
      context.reference.name,
      context.reference.language,
    );
  }
}

function qualifiedReceiver(refName: string): string | undefined {
  if (!refName.includes(".") && !refName.includes("/")) return undefined;
  return refName.split(/[./]/, 1)[0] || undefined;
}

export const referenceResolutionPolicy = new ReferenceResolutionPolicy();
