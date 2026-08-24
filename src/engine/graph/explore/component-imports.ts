import type { GraphReader } from "../types.js";
import type { ExploreSubgraphStorage } from "./types.js";

export type ExploreRankingLink = {
  src: string;
  dst: string;
  weight: number;
};

export type ComponentImportEvidence = {
  nodeIds: string[];
  rankingLinks: ExploreRankingLink[];
};

/**
 * Components are represented by a synthetic root outside their embedded
 * script scope. Resolved import bindings therefore act as weak ranking
 * evidence, without being exposed as source-level graph edges.
 */
export function collectComponentImportEvidence(
  graph: GraphReader,
  storage: ExploreSubgraphStorage,
  rootIds: readonly string[],
  limit: number,
  weight: number,
): ComponentImportEvidence {
  if (!graph.importedSymbols || limit <= 0)
    return { nodeIds: [], rankingLinks: [] };
  const componentRoots = rootIds.filter((id) => {
    const metadata = storage.getEntity(id)?.entity.metadata;
    return metadata?.kind === "code" && metadata.symbolType === "component";
  });
  if (componentRoots.length === 0) return { nodeIds: [], rankingLinks: [] };

  const nodeIds: string[] = [];
  const rankingLinks: ExploreRankingLink[] = [];
  const perRootLimit = Math.max(2, Math.ceil(limit / componentRoots.length));
  for (const rootId of componentRoots) {
    const fileId = storage.getEntity(rootId)?.file.id;
    if (!fileId) continue;
    for (const dependency of graph.importedSymbols([fileId], perRootLimit)) {
      if (!storage.getEntity(dependency.id)) continue;
      nodeIds.push(dependency.id);
      rankingLinks.push({ src: rootId, dst: dependency.id, weight });
      if (rankingLinks.length >= limit) return { nodeIds, rankingLinks };
    }
  }
  return { nodeIds, rankingLinks };
}
