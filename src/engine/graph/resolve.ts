import type { NameIndex } from "./name-index.js";
import {
  CALLABLE_SYMBOL_KIND_SET,
  INHERITABLE_SYMBOL_KIND_SET,
} from "./symbol-kinds.js";
import {
  referenceResolutionPolicy,
  type AnalyzedReference,
  type ReferenceBindingMatch,
} from "./reference-resolution-policy.js";
import type { PendingRef, RefResolveResult } from "./types.js";

const CALL_TARGET_KINDS: ReadonlySet<string> = new Set([
  ...CALLABLE_SYMBOL_KIND_SET,
  ...INHERITABLE_SYMBOL_KIND_SET,
]);

export function resolveRef(
  ref: PendingRef,
  names: NameIndex,
  preferredFileIds: readonly string[] = [],
  binding?: ReferenceBindingMatch,
  sourceContainerName?: string,
  sourceContainerId?: string,
  hierarchyContainerIds: readonly string[] = [],
  analyzedReference?: AnalyzedReference,
): RefResolveResult {
  const reference =
    analyzedReference ??
    referenceResolutionPolicy.analyzeReference(
      ref.target ?? ref.ref_name,
      ref.source_language,
    );
  const context = referenceResolutionPolicy.createContext(reference, {
    sourceFileId: ref.src_file,
    ownerContainerId: sourceContainerId,
    preferredFileIds,
    binding,
    ownerContainerName: sourceContainerName,
  });
  const plan = referenceResolutionPolicy.lookupPlan(context);
  const containerNames =
    plan.containerScope.kind === "named" ? [plan.containerScope.name] : [];
  const containerIds =
    plan.containerScope.kind === "owner-hierarchy" ||
    plan.containerScope.kind === "owner-preferred"
      ? hierarchyContainerIds.length > 0
        ? hierarchyContainerIds
        : ["__unresolved_container__"]
      : [];
  // A namespace/module import selects a top-level export from that module,
  // not an arbitrary same-named method contained in the same source file.
  // This distinction is essential for Rust `use crate::{server};
  // server::run()` and is equally valid for namespace imports in JS/TS.
  const namespaceHit =
    binding?.kind === "receiver" && binding.importedName === "*"
      ? names.uniqueTopLevelCandidate(
          plan.lookupName,
          binding.fileId,
          allowedKinds(ref.ref_kind),
        )
      : null;
  const defaultExportHit =
    binding?.kind === "exact" && binding.importedName === "default"
      ? names.defaultExport(binding.fileId, allowedKinds(ref.ref_kind))
      : null;
  if (defaultExportHit) {
    return {
      status: "resolved",
      dst: defaultExportHit.id,
      edgeKind: ref.ref_kind === "call" ? "CALLS" : "REFS",
      evidence: "preferred_file",
    };
  }
  if (namespaceHit) {
    return {
      status: "resolved",
      dst: namespaceHit.id,
      edgeKind: isInheritanceRef(ref.ref_kind)
        ? "INHERITS"
        : ref.ref_kind === "call" || ref.ref_kind === "new"
          ? "CALLS"
          : "REFS",
      evidence: "preferred_file",
    };
  }
  let hit = names.lookupWithEvidence(
    plan.lookupName,
    ref.src_file,
    plan.preferredFileIds,
    plan.allowBareFallback,
    containerNames,
    containerIds,
    allowedKinds(ref.ref_kind),
  );
  if (!hit && plan.containerScope.kind === "owner-preferred") {
    hit = names.lookupWithEvidence(
      plan.lookupName,
      ref.src_file,
      plan.preferredFileIds,
      plan.allowBareFallback,
      containerNames,
      [],
      allowedKinds(ref.ref_kind),
    );
  }
  if (!hit)
    return referenceResolutionPolicy.isExternal(reference)
      ? { status: "external" }
      : { status: "failed" };

  const edgeKind = isInheritanceRef(ref.ref_kind)
    ? "INHERITS"
    : ref.ref_kind === "call" || ref.ref_kind === "new"
      ? "CALLS"
      : "REFS";

  return {
    status: "resolved",
    dst: hit.entry.id,
    edgeKind,
    evidence: hit.evidence,
  };
}

function allowedKinds(kind: string): ReadonlySet<string> | undefined {
  if (kind === "extends" || kind === "implements")
    return INHERITABLE_SYMBOL_KIND_SET;
  if (kind === "overrides") return CALLABLE_SYMBOL_KIND_SET;
  if (kind === "function") return CALLABLE_SYMBOL_KIND_SET;
  // Python/JS/TS/Java class construction is represented syntactically as a
  // call, while C-family `new` sites are tagged explicitly. A cross-file class
  // such as `Graphiti(...)` must therefore remain a valid call target.
  if (kind === "call") return CALL_TARGET_KINDS;
  if (kind === "new") return INHERITABLE_SYMBOL_KIND_SET;
  return undefined;
}

function isInheritanceRef(kind: string): boolean {
  return kind === "extends" || kind === "implements" || kind === "overrides";
}
