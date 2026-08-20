import {
  analyzeForIndexing,
  type PreparedCodeAnalysis,
  type TextSource,
} from "../extraction/index.js";
import type { EntityFragment } from "../types.js";
import { isExternalRefName } from "./builtins.js";
import {
  fileGraphFromFragments,
  type FileGraphInput,
  rawRef,
} from "./from-fragments.js";
import { isExternalImportSpec } from "./imports/resolve-path.js";
import type { LocalEdge } from "./types.js";

type RelationOwner = {
  name?: string;
  startOffset: number;
  startLine: number;
  sites: readonly {
    name: string;
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
    "imports" | "calls" | "refs" | "inheritance"
  >,
): Promise<FileGraphInput> {
  const base = fileGraphFromFragments(source.file.id, fragments);
  if (source.kind !== "text" || source.file.kind !== "code") {
    return base;
  }
  const analysis = preparedAnalysis ?? (await analyzeForIndexing(source));

  const refs = [...base.refs];
  const seenRefIds = new Set(refs.map((r) => r.id));
  const localEdges = new Map<string, LocalEdge>();

  const importSpecs = analysis.imports.filter(
    (spec) => !isExternalImportSpec(spec.spec, source.file.format),
  );
  for (const [occurrence, spec] of importSpecs.entries()) {
    const ref = rawRef({
      owner: source.file.id,
      refName: spec.spec,
      refKind: "import",
      line: spec.line,
      occurrence,
      ownerIsFile: true,
    });
    if (!seenRefIds.has(ref.id)) {
      seenRefIds.add(ref.id);
      refs.push(ref);
    }
  }

  const idByOffset = indexPublicFragmentsByOffset(fragments);
  const nameToIds = new Map<string, string[]>();
  for (const node of base.nodes) {
    if (!node.name) {
      continue;
    }
    const list = nameToIds.get(node.name) ?? [];
    list.push(node.id);
    nameToIds.set(node.name, list);
  }

  const inheritance = analysis.inheritance;
  absorbRelationOwners({
    owners: inheritance,
    edgeKind: "INHERITS",
    idByOffset,
    nameToIds,
    fragments,
    localEdges,
    refs,
    seenRefIds,
  });

  const symbolRefs = analysis.refs;
  absorbRelationOwners({
    owners: symbolRefs,
    edgeKind: "REFS",
    idByOffset,
    nameToIds,
    fragments,
    localEdges,
    refs,
    seenRefIds,
  });

  const calls = analysis.calls;
  absorbRelationOwners({
    owners: calls,
    edgeKind: "CALLS",
    idByOffset,
    nameToIds,
    fragments,
    localEdges,
    refs,
    seenRefIds,
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
  refs: ReturnType<typeof rawRef>[];
  seenRefIds: Set<string>;
}): void {
  const occurrences = new Map<string, number>();
  for (const owner of input.owners) {
    const ownerId =
      input.idByOffset.get(owner.startOffset) ??
      matchOwnerByNameLine(input.fragments, owner.name, owner.startLine);
    if (!ownerId) {
      continue;
    }

    for (const site of owner.sites) {
      if (isExternalRefName(site.name)) {
        continue;
      }

      const bare = bareName(site.name);
      const localHits =
        input.nameToIds.get(site.name) ?? input.nameToIds.get(bare) ?? [];
      const targets = localHits.filter((id) => id !== ownerId);

      if (targets.length === 1) {
        const dst = targets[0]!;
        const key = `${ownerId}\0${dst}\0${site.kind}\0${input.edgeKind}`;
        const existing = input.localEdges.get(key);
        if (existing) {
          existing.count += 1;
          existing.first_line = Math.min(existing.first_line, site.line);
        } else {
          input.localEdges.set(key, {
            src: ownerId,
            dst,
            rel: site.kind,
            count: 1,
            first_line: site.line,
            ref_name: site.name,
            kind: input.edgeKind,
          });
        }
        continue;
      }

      const ref = rawRef({
        owner: ownerId,
        refName: site.name,
        refKind: site.kind,
        line: site.line,
        occurrence: nextOccurrence(
          occurrences,
          `${ownerId}\0${site.name}\0${site.kind}\0${site.line}`,
        ),
      });
      if (!input.seenRefIds.has(ref.id)) {
        input.seenRefIds.add(ref.id);
        input.refs.push(ref);
      }
    }
  }
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

function bareName(refName: string): string {
  const parts = refName.split(".");
  return parts[parts.length - 1] ?? refName;
}
