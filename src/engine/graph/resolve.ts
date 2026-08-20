import type { NameIndex } from "./name-index.js";
import {
  referenceResolutionPolicy,
  type ReferenceBindingMatch,
} from "./reference-resolution-policy.js";
import type { PendingRef, RefResolveResult } from "./types.js";

export function resolveRef(
  ref: PendingRef,
  names: NameIndex,
  preferredFileIds: readonly string[] = [],
  binding?: ReferenceBindingMatch,
  sourceContainerName?: string,
): RefResolveResult {
  const reference = referenceResolutionPolicy.analyzeReference(
    ref.ref_name,
    ref.source_language,
  );
  const context = referenceResolutionPolicy.createContext(reference, {
    sourceFileId: ref.src_file,
    preferredFileIds,
    binding,
    ownerContainerName: sourceContainerName,
  });
  const plan = referenceResolutionPolicy.lookupPlan(context);
  const hit = names.lookup(
    plan.lookupName,
    ref.src_file,
    plan.preferredFileIds,
    plan.allowBareFallback,
    plan.containerNames,
  );
  if (!hit)
    return referenceResolutionPolicy.isExternal(reference)
      ? { status: "external" }
      : { status: "failed" };

  const edgeKind =
    ref.ref_kind === "extends" ||
    ref.ref_kind === "implements" ||
    ref.ref_kind === "overrides"
      ? "INHERITS"
      : ref.ref_kind === "call" || ref.ref_kind === "new"
        ? "CALLS"
        : "REFS";

  return { status: "resolved", dst: hit.id, edgeKind };
}
