import {
  analyzeForIndexing,
  type PreparedCodeAnalysis,
  type TextSource,
} from "../extraction/index.js";
import type { EntityFragment } from "../types.js";
import type { ReferenceTarget } from "../reference-target.js";
import { referenceResolutionPolicy } from "./reference-resolution-policy.js";
import {
  fileGraphFromFragments,
  type FileGraphInput,
  rawRef,
} from "./from-fragments.js";
import {
  isConfiguredProjectImportSpec,
  isExternalImportSpec,
} from "./imports/resolve-path.js";
import type { LocalEdge } from "./types.js";
import { resolveLocalReferenceCandidates } from "./local-reference-resolver.js";

type RelationOwner = {
  name?: string;
  startOffset: number;
  startLine: number;
  sites: readonly {
    name: string;
    target: ReferenceTarget;
    line: number;
    kind: string;
  }[];
};

/**
 * Build Phase-A graph input: symbols/CONTAINS from fragments, plus CALLS /
 * INHERITS / REFS from dedicated walks, plus import/include Refs.
 */
export async function extractFileGraph(
  source: TextSource,
  fragments: readonly EntityFragment[],
  preparedAnalysis?: Pick<
    PreparedCodeAnalysis,
    | "imports"
    | "calls"
    | "refs"
    | "inheritance"
    | "ownership"
    | "sourceLanguage"
  >,
): Promise<FileGraphInput> {
  const analysis =
    preparedAnalysis ??
    (source.kind === "text" && source.file.kind === "code"
      ? await analyzeForIndexing(source)
      : undefined);
  const sourceLanguage = analysis?.sourceLanguage ?? source.file.format;
  const base = fileGraphFromFragments(
    source.file.id,
    fragments,
    analysis?.ownership,
    sourceLanguage,
  );
  if (source.kind !== "text" || source.file.kind !== "code") {
    return base;
  }
  if (!analysis) return base;

  const refs = [...base.refs];
  const seenRefIds = new Set(refs.map((r) => r.id));
  const localEdges = new Map<string, LocalEdge>();
  const occurrences = new Map<string, number>();

  const configuredImport = (spec: string) =>
    isConfiguredProjectImportSpec(spec, sourceLanguage, source.file);
  const importSpecs = analysis.imports.filter(
    (spec) =>
      !isExternalImportSpec(spec.spec, sourceLanguage) ||
      configuredImport(spec.spec),
  );
  const externalImportedNames = new Set(
    analysis.imports
      .filter(
        (spec) =>
          isExternalImportSpec(spec.spec, sourceLanguage) &&
          !configuredImport(spec.spec),
      )
      .flatMap((spec) => (spec.bindings ?? []).map((binding) => binding.local)),
  );
  const importedReceiverNames = new Set(
    importSpecs.flatMap((spec) =>
      (spec.bindings ?? []).map((binding) => binding.local),
    ),
  );
  for (const [occurrence, spec] of importSpecs.entries()) {
    const ref = rawRef({
      type: "import",
      owner: source.file.id,
      refName: spec.spec,
      line: spec.line,
      occurrence,
      sourceLanguage,
      rustInlineModuleDepth: spec.rustInlineModuleDepth,
    });
    if (!seenRefIds.has(ref.id)) {
      seenRefIds.add(ref.id);
      refs.push(ref);
    }
    for (const [bindingIndex, binding] of (spec.bindings ?? []).entries()) {
      const bindingRef = rawRef({
        type: "import_binding",
        owner: source.file.id,
        refName: spec.spec,
        line: spec.line,
        occurrence: occurrence * 1_000 + bindingIndex + 1,
        importedName: binding.imported,
        localName: binding.local,
        sourceLanguage,
        rustInlineModuleDepth: spec.rustInlineModuleDepth,
      });
      if (!seenRefIds.has(bindingRef.id)) {
        seenRefIds.add(bindingRef.id);
        refs.push(bindingRef);
      }
    }
  }

  const idByOffset = indexPublicFragmentsByOffset(fragments);
  const nameToIds = new Map<string, string[]>();
  const nodeNameById = new Map<string, string>();
  const nodeKindById = new Map<string, string>();
  for (const node of base.nodes) {
    nodeKindById.set(node.id, node.kind);
    if (!node.name) {
      continue;
    }
    const list = nameToIds.get(node.name) ?? [];
    list.push(node.id);
    nameToIds.set(node.name, list);
    if (node.qualifiedName && node.qualifiedName !== node.name) {
      const qualified = nameToIds.get(node.qualifiedName) ?? [];
      qualified.push(node.id);
      nameToIds.set(node.qualifiedName, qualified);
    }
    nodeNameById.set(node.id, node.name);
  }
  const containerNameByChild = new Map<string, string>();
  const containerIdByChild = new Map<string, string>();
  for (const edge of base.edges) {
    if (edge.kind !== "CONTAINS") continue;
    const containerName = nodeNameById.get(edge.src);
    if (containerName) containerNameByChild.set(edge.dst, containerName);
    containerIdByChild.set(edge.dst, edge.src);
  }

  const inheritance = analysis.inheritance;
  absorbRelationOwners({
    owners: inheritance,
    edgeKind: "INHERITS",
    idByOffset,
    nameToIds,
    fragments,
    localEdges,
    occurrences,
    refs,
    seenRefIds,
    sourceLanguage,
    containerNameByChild,
    containerIdByChild,
    importedReceiverNames,
    externalImportedNames,
    nodeKindById,
  });

  const symbolRefs = analysis.refs;
  absorbRelationOwners({
    owners: symbolRefs,
    edgeKind: "REFS",
    idByOffset,
    nameToIds,
    fragments,
    localEdges,
    occurrences,
    refs,
    seenRefIds,
    sourceLanguage,
    containerNameByChild,
    containerIdByChild,
    importedReceiverNames,
    externalImportedNames,
    nodeKindById,
  });

  const calls = analysis.calls;
  absorbRelationOwners({
    owners: calls,
    edgeKind: "CALLS",
    idByOffset,
    nameToIds,
    fragments,
    localEdges,
    occurrences,
    refs,
    seenRefIds,
    sourceLanguage,
    containerNameByChild,
    containerIdByChild,
    importedReceiverNames,
    externalImportedNames,
    nodeKindById,
  });

  return {
    nodes: base.nodes,
    edges: [...base.edges, ...localEdges.values()],
    refs,
  };
}

function absorbRelationOwners(input: {
  owners: readonly RelationOwner[];
  edgeKind: "CALLS" | "INHERITS" | "REFS";
  idByOffset: Map<number, string>;
  nameToIds: Map<string, string[]>;
  fragments: readonly EntityFragment[];
  localEdges: Map<string, LocalEdge>;
  occurrences: Map<string, number>;
  refs: ReturnType<typeof rawRef>[];
  seenRefIds: Set<string>;
  sourceLanguage: string;
  containerNameByChild: ReadonlyMap<string, string>;
  containerIdByChild: ReadonlyMap<string, string>;
  importedReceiverNames: ReadonlySet<string>;
  externalImportedNames: ReadonlySet<string>;
  nodeKindById: ReadonlyMap<string, string>;
}): void {
  for (const owner of input.owners) {
    const ownerId =
      input.idByOffset.get(owner.startOffset) ??
      matchOwnerByNameLine(input.fragments, owner.name, owner.startLine);
    if (!ownerId) {
      continue;
    }

    for (const site of owner.sites) {
      if (isExternalImportedSite(site, input.externalImportedNames)) continue;
      const occurrence = nextOccurrence(
        input.occurrences,
        `${ownerId}\0${site.name}\0${site.kind}\0${site.line}`,
      );
      const siteRef = rawRef({
        owner: ownerId,
        refName: site.name,
        refKind: site.kind,
        line: site.line,
        occurrence,
        sourceLanguage: input.sourceLanguage,
        target: site.target,
      });
      const reference = referenceResolutionPolicy.analyzeReference(
        site.target,
        input.sourceLanguage,
      );
      const plan = referenceResolutionPolicy.localLookupPlan(
        reference,
        input.containerNameByChild.get(ownerId),
      );
      const rawLocalHits =
        reference.hints?.dispatch || reference.hints?.lexicallyBound
          ? []
          : resolveLocalReferenceCandidates(plan, ownerId, input);
      const localHits =
        input.edgeKind === "CALLS" && site.kind !== "new"
          ? rawLocalHits.filter((candidate) =>
              isConcreteFunctionFragment(
                input.fragments,
                input.nodeKindById,
                candidate,
              ),
            )
          : input.edgeKind === "REFS" && site.kind === "value"
            ? preferOwnerScopedValues(rawLocalHits, ownerId, input)
            : input.edgeKind === "REFS" && site.kind === "function"
              ? rawLocalHits.filter(
                  (candidate) =>
                    candidate !== ownerId &&
                    isFunctionFragment(input.fragments, candidate),
                )
              : rawLocalHits;
      // A callable may legitimately reference itself. Other relation kinds
      // must still reject self loops (for example a same-named type in an
      // inheritance clause).
      const targets =
        input.edgeKind === "CALLS"
          ? localHits
          : localHits.filter((id) => id !== ownerId);

      // A declaration's own type/name can appear in its syntax (for example
      // `typedef struct Row { ... } Row`). If local lookup proves that the only
      // candidate is the owner itself, this is declaration syntax rather than
      // a dependency. Do not persist it for the global resolver to recreate as
      // a self REFS/INHERITS edge.
      if (
        input.edgeKind !== "CALLS" &&
        localHits.length > 0 &&
        targets.length === 0
      ) {
        continue;
      }

      // Conditional module values (for example Python try/except feature
      // flags) may have multiple same-file definitions but represent one
      // logical dependency. Preserve the read against every definition so
      // impact works regardless of which branch is edited.
      if (
        input.edgeKind === "REFS" &&
        site.kind === "value" &&
        targets.length > 1 &&
        targets.every((id) => isValueFragment(input.fragments, id))
      ) {
        for (const dst of targets) {
          const key = `${ownerId}\0${dst}\0${site.kind}\0${input.edgeKind}\0${site.line}\0${occurrence}`;
          input.localEdges.set(key, {
            id: `${siteRef.id}:${dst}`,
            src: ownerId,
            dst,
            rel: site.kind,
            count: 1,
            first_line: site.line,
            ref_name: site.name,
            kind: input.edgeKind,
            source_language: input.sourceLanguage,
            target: site.target,
          });
        }
        continue;
      }

      if (targets.length === 1) {
        const dst = targets[0]!;
        const key = `${ownerId}\0${dst}\0${site.kind}\0${input.edgeKind}\0${site.line}\0${occurrence}`;
        input.localEdges.set(key, {
          id: siteRef.id,
          src: ownerId,
          dst,
          rel: site.kind,
          count: 1,
          first_line: site.line,
          ref_name: site.name,
          kind: input.edgeKind,
          source_language: input.sourceLanguage,
          target: site.target,
        });
        if (site.kind === "new") {
          const instantiateKey = `${key}\0INSTANTIATES`;
          input.localEdges.set(instantiateKey, {
            id: `${siteRef.id}:instantiates`,
            src: ownerId,
            dst,
            rel: "instantiates",
            count: 1,
            first_line: site.line,
            ref_name: site.name,
            kind: "INSTANTIATES",
            source_language: input.sourceLanguage,
            target: site.target,
          });
        }
        continue;
      }

      if (
        referenceResolutionPolicy.isExternal(reference) &&
        !(
          reference.receiver.kind === "qualified" &&
          input.importedReceiverNames.has(reference.receiver.name)
        )
      )
        continue;

      const ref = siteRef;
      if (!input.seenRefIds.has(ref.id)) {
        input.seenRefIds.add(ref.id);
        input.refs.push(ref);
      }
    }
  }
}

function isExternalImportedSite(
  site: RelationOwner["sites"][number],
  externalImportedNames: ReadonlySet<string>,
): boolean {
  if (externalImportedNames.has(site.name)) return true;
  const receiver = site.target.receiver?.name;
  return receiver !== undefined && externalImportedNames.has(receiver);
}

function preferOwnerScopedValues(
  candidates: readonly string[],
  ownerId: string,
  input: {
    fragments: readonly EntityFragment[];
    containerIdByChild: ReadonlyMap<string, string>;
  },
): string[] {
  const ownerContainer = input.containerIdByChild.get(ownerId);
  if (!ownerContainer) return [...candidates];
  const scoped = candidates.filter(
    (candidate) =>
      isValueFragment(input.fragments, candidate) &&
      input.containerIdByChild.get(candidate) === ownerContainer,
  );
  return scoped.length > 0 ? scoped : [...candidates];
}

function isFunctionFragment(
  fragments: readonly EntityFragment[],
  id: string,
): boolean {
  return fragments.some(
    (fragment) =>
      (fragment.group ?? fragment.id) === id &&
      fragment.metadata?.kind === "code" &&
      fragment.metadata.symbolType === "function",
  );
}

function isConcreteFunctionFragment(
  fragments: readonly EntityFragment[],
  nodeKindById: ReadonlyMap<string, string>,
  id: string,
): boolean {
  // An abstract declaration is a dispatch contract, not a concrete runtime
  // target. Keep the occurrence unresolved so the semantic resolver can
  // project concrete implementations or an explicit dynamic boundary.
  return (
    nodeKindById.get(id) !== "abstract_method" &&
    isFunctionFragment(fragments, id)
  );
}

function isValueFragment(
  fragments: readonly EntityFragment[],
  id: string,
): boolean {
  const fragment = fragments.find((item) => (item.group ?? item.id) === id);
  return (
    fragment?.metadata?.kind === "code" &&
    fragment.metadata.symbolType === "value"
  );
}

function nextOccurrence(counts: Map<string, number>, key: string): number {
  const occurrence = counts.get(key) ?? 0;
  counts.set(key, occurrence + 1);
  return occurrence;
}

function indexPublicFragmentsByOffset(
  fragments: readonly EntityFragment[],
): Map<number, string> {
  const map = new Map<number, string>();
  for (const fragment of fragments) {
    if (fragment.group && fragment.group !== fragment.id) {
      continue;
    }
    if (fragment.range.kind !== "text") {
      continue;
    }
    map.set(fragment.range.startOffset, fragment.group ?? fragment.id);
  }
  return map;
}

function matchOwnerByNameLine(
  fragments: readonly EntityFragment[],
  name: string | undefined,
  startLine: number,
): string | null {
  if (!name) {
    return null;
  }
  for (const fragment of fragments) {
    if (fragment.group && fragment.group !== fragment.id) {
      continue;
    }
    if (fragment.metadata?.kind !== "code") {
      continue;
    }
    if (fragment.range.kind !== "text") {
      continue;
    }
    if (
      fragment.metadata.symbolName === name &&
      fragment.range.startLine === startLine
    ) {
      return fragment.group ?? fragment.id;
    }
  }
  return null;
}
