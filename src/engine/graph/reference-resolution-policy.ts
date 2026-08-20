import { bareName, isExternalRefName } from "./builtins.js";

const LOCAL_RECEIVERS = new Set(["this", "self", "cls", "super"]);

export type ImportBindingTarget = {
  importedName: string;
  fileId: string;
  match: "exact" | "receiver";
};

export type ReferenceLookupPlan = {
  lookupName: string;
  preferredFileIds: string[];
  allowBareFallback: boolean;
  containerNames: string[];
};

/** Central policy for receiver classification, fallback scope and externals. */
export class ReferenceResolutionPolicy {
  lookupPlan(input: {
    refName: string;
    srcFile: string;
    preferredFileIds?: readonly string[];
    binding?: ImportBindingTarget;
    sourceContainerName?: string;
  }): ReferenceLookupPlan {
    const classification = this.classify(input.refName);
    if (input.binding) {
      const receiverAccess = input.binding.match === "receiver";
      return {
        lookupName: receiverAccess
          ? classification.bare
          : input.binding.importedName,
        preferredFileIds: [input.binding.fileId],
        allowBareFallback: false,
        containerNames:
          receiverAccess && input.binding.importedName !== "*"
            ? [input.binding.importedName]
            : [],
      };
    }
    if (classification.localReceiver) {
      return {
        lookupName: classification.bare,
        preferredFileIds: [input.srcFile, ...(input.preferredFileIds ?? [])],
        allowBareFallback: true,
        containerNames: input.sourceContainerName
          ? [input.sourceContainerName]
          : [],
      };
    }
    if (classification.qualified && classification.receiver) {
      return {
        lookupName: classification.bare,
        preferredFileIds: [input.srcFile],
        allowBareFallback: false,
        containerNames: [classification.receiver],
      };
    }
    return {
      lookupName: input.refName,
      preferredFileIds: [...(input.preferredFileIds ?? [])],
      allowBareFallback: !classification.qualified,
      containerNames: [],
    };
  }

  isExternal(refName: string, language?: string): boolean {
    return isExternalRefName(refName, language);
  }

  private classify(refName: string): {
    bare: string;
    qualified: boolean;
    localReceiver: boolean;
    receiver?: string;
  } {
    const qualified = refName.includes(".") || refName.includes("/");
    const receiver = qualified ? refName.split(/[./]/, 1)[0] : undefined;
    const localReceiver = receiver ? LOCAL_RECEIVERS.has(receiver) : false;
    return {
      bare: bareName(refName),
      qualified,
      localReceiver,
      receiver,
    };
  }
}

export const referenceResolutionPolicy = new ReferenceResolutionPolicy();
