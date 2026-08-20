import { isExternalRefName } from "./builtins.js";
import type { NameIndex } from "./name-index.js";
import type { PendingRef, RefResolveResult } from "./types.js";

export function resolveRef(
  ref: PendingRef,
  names: NameIndex,
  preferredFileIds: readonly string[] = [],
): RefResolveResult {
  if (isExternalRefName(ref.ref_name)) {
    return { status: "external" };
  }

  const hit = names.lookup(ref.ref_name, ref.src_file, preferredFileIds);
  if (!hit) {
    return { status: "failed" };
  }

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
