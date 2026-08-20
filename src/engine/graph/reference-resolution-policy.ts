import { bareName, isExternalRefName } from "./builtins.js";

const LOCAL_RECEIVERS = new Set(["this", "self", "cls", "super"]);

export type ImportBindingTarget = {
  importedName: string;
  fileId: string;
};

export type ReferenceLookupPlan = {
  lookupName: string;
  preferredFileIds: string[];
  allowBareFallback: boolean;
};

/** Central policy for receiver classification, fallback scope and externals. */
export class ReferenceResolutionPolicy {
  localCandidateNames(refName: string): string[] {
    const classification = this.classify(refName);
    return classification.allowLocalBareFallback &&
      classification.bare !== refName
      ? [refName, classification.bare]
      : [refName];
  }

  lookupPlan(input: {
    refName: string;
    srcFile: string;
    preferredFileIds?: readonly string[];
    binding?: ImportBindingTarget;
  }): ReferenceLookupPlan {
    const classification = this.classify(input.refName);
    if (input.binding) {
      return {
        lookupName:
          input.binding.importedName === "*"
            ? classification.bare
            : input.binding.importedName,
        preferredFileIds: [input.binding.fileId],
        allowBareFallback: true,
      };
    }
    if (classification.localReceiver) {
      return {
        lookupName: classification.bare,
        preferredFileIds: [input.srcFile, ...(input.preferredFileIds ?? [])],
        allowBareFallback: true,
      };
    }
    return {
      lookupName: input.refName,
      preferredFileIds: [...(input.preferredFileIds ?? [])],
      allowBareFallback: !classification.qualified,
    };
  }

  isExternal(refName: string, language?: string): boolean {
    return isExternalRefName(refName, language);
  }

  private classify(refName: string): {
    bare: string;
    qualified: boolean;
    localReceiver: boolean;
    allowLocalBareFallback: boolean;
  } {
    const qualified = refName.includes(".") || refName.includes("/");
    const receiver = qualified ? refName.split(/[./]/, 1)[0] : undefined;
    const localReceiver = receiver ? LOCAL_RECEIVERS.has(receiver) : false;
    return {
      bare: bareName(refName),
      qualified,
      localReceiver,
      allowLocalBareFallback: !qualified || localReceiver,
    };
  }
}

export const referenceResolutionPolicy = new ReferenceResolutionPolicy();
