import type { ExploreEdge, ExploreNode } from "./types.js";

/**
 * Find off-spine members of large polymorphic families that can be rendered as
 * signatures. One ranked exemplar remains complete, as do explicit roots and
 * call-path nodes. This policy is graph-language agnostic: language adapters
 * only need to project their implementation relationship as INHERITS.
 */
export function polymorphicSiblingSkeletonNodeIds(
  rankedFileIds: readonly string[],
  nodes: readonly ExploreNode[],
  edges: readonly ExploreEdge[],
  pathNodeIds: ReadonlySet<string>,
): Set<string> {
  const rankedFiles = new Set(rankedFileIds);
  const fileByNode = new Map(
    nodes.map((node) => [node.id, node.entity?.file.id] as const),
  );
  const roots = new Set(
    nodes.filter((node) => node.isRoot).map((node) => node.id),
  );
  const families = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.kind !== "INHERITS") continue;
    const family = families.get(edge.dst) ?? new Set<string>();
    family.add(edge.src);
    families.set(edge.dst, family);
  }

  const skeletonRoots = new Set<string>();
  for (const family of families.values()) {
    if (family.size < 3) continue;
    const selected = [...family].filter((id) => {
      const fileId = fileByNode.get(id);
      return fileId ? rankedFiles.has(fileId) : false;
    });
    if (selected.length < 2) continue;
    selected.sort(
      (left, right) =>
        rankedFileIds.indexOf(fileByNode.get(left) ?? "") -
          rankedFileIds.indexOf(fileByNode.get(right) ?? "") ||
        left.localeCompare(right),
    );
    const exemplar =
      selected.find((id) => roots.has(id) || pathNodeIds.has(id)) ??
      selected[0]!;
    for (const id of selected) {
      if (id !== exemplar && !roots.has(id) && !pathNodeIds.has(id))
        skeletonRoots.add(id);
    }
  }

  return includeContainedSymbols(skeletonRoots, roots, pathNodeIds, edges);
}

function includeContainedSymbols(
  skeletonRoots: ReadonlySet<string>,
  roots: ReadonlySet<string>,
  pathNodeIds: ReadonlySet<string>,
  edges: readonly ExploreEdge[],
): Set<string> {
  const skeleton = new Set(skeletonRoots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges) {
      if (
        edge.kind !== "CONTAINS" ||
        !skeleton.has(edge.src) ||
        skeleton.has(edge.dst) ||
        roots.has(edge.dst) ||
        pathNodeIds.has(edge.dst)
      )
        continue;
      skeleton.add(edge.dst);
      changed = true;
    }
  }
  return skeleton;
}
