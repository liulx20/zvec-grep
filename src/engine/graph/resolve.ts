import type { NameIndex } from "./name-index.js";
import {
  referenceResolutionPolicy,
  type ImportBindingTarget,
} from "./reference-resolution-policy.js";
import type { PendingRef, RefResolveResult } from "./types.js";

export function resolveRef(
  ref: PendingRef,
  names: NameIndex,
  preferredFileIds: readonly string[] = [],
  binding?: ImportBindingTarget,
  sourceContainerName?: string,
): RefResolveResult {
  const plan = referenceResolutionPolicy.lookupPlan({
    refName: ref.ref_name,
    srcFile: ref.src_file,
    preferredFileIds,
    binding,
    sourceContainerName,
  });
  const hit = names.lookup(
    plan.lookupName,
    ref.src_file,
    plan.preferredFileIds,
    plan.allowBareFallback,
    plan.containerNames,
  );
  if (!hit)
    return referenceResolutionPolicy.isExternal(
      ref.ref_name,
      ref.source_language,
    )
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
