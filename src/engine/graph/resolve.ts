import { bareName, isExternalRefName } from "./builtins.js";
import type { NameIndex } from "./name-index.js";
import type { PendingRef, RefResolveResult } from "./types.js";

export function resolveRef(
  ref: PendingRef,
  names: NameIndex,
  preferredFileIds: readonly string[] = [],
  lookupName = ref.ref_name,
): RefResolveResult {
  const localReceiver = hasLocalReceiver(lookupName);
  const effectiveLookupName = localReceiver ? bareName(lookupName) : lookupName;
  const effectivePreferred = localReceiver
    ? [ref.src_file, ...preferredFileIds]
    : preferredFileIds;
  const hit = names.lookup(
    effectiveLookupName,
    ref.src_file,
    effectivePreferred,
    !isQualifiedName(effectiveLookupName),
  );
  if (!hit)
    return isExternalRefName(ref.ref_name, ref.source_language)
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

function hasLocalReceiver(name: string): boolean {
  const receiver = name.split(/[./]/, 1)[0];
  return (
    receiver === "this" ||
    receiver === "self" ||
    receiver === "cls" ||
    receiver === "super"
  );
}

function isQualifiedName(name: string): boolean {
  return name.includes(".") || name.includes("/");
}
