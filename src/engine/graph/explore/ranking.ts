import { personalizedPageRank } from "../application/ranking.js";
import { isTestPath } from "../path-policy.js";
import { EXPLORE_POLICY, queryTerms } from "./policy.js";
import type { ExploreEdge, ExploreNode } from "./types.js";

const RWR_EDGE_WEIGHTS = EXPLORE_POLICY.rwrEdgeWeights;

export function rankExploreNodes(
  nodes: readonly ExploreNode[],
  edges: readonly ExploreEdge[],
  rootIds: readonly string[],
  seedWeights?: ReadonlyMap<string, number>,
  evidenceLinks: readonly {
    src: string;
    dst: string;
    weight: number;
  }[] = [],
): Map<string, number> {
  const adjacency = new Map<string, Map<string, number>>();
  for (const node of nodes) adjacency.set(node.id, new Map());
  for (const edge of edges) {
    if (!adjacency.has(edge.src) || !adjacency.has(edge.dst)) continue;
    const weight = RWR_EDGE_WEIGHTS[edge.kind] * edge.confidence;
    addWeightedNeighbor(adjacency.get(edge.src)!, edge.dst, weight);
    addWeightedNeighbor(adjacency.get(edge.dst)!, edge.src, weight);
  }
  for (const link of evidenceLinks) {
    if (!adjacency.has(link.src) || !adjacency.has(link.dst)) continue;
    addWeightedNeighbor(adjacency.get(link.src)!, link.dst, link.weight);
    addWeightedNeighbor(adjacency.get(link.dst)!, link.src, link.weight);
  }
  return personalizedPageRank(
    [...adjacency.keys()],
    adjacency,
    rootIds.filter((id) => adjacency.has(id)),
    seedWeights,
  );
}

export function rankExploreFiles(
  nodes: readonly ExploreNode[],
  rootIds: readonly string[],
  query: string,
  nodeScores: ReadonlyMap<string, number>,
): Map<string, number> {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const terms = queryTerms(query);
  const fileScores = new Map<string, number>();
  const nodeScoresByFile = new Map<string, number[]>();
  const rootBoosts = new Map<string, number>();
  const fileTermHits = new Map<string, number>();
  const rootNames = new Set(
    rootIds
      .map((id) => nodeById.get(id)?.entity)
      .map((entity) =>
        entity?.entity.metadata?.kind === "code"
          ? entity.entity.metadata.symbolName?.toLowerCase()
          : undefined,
      )
      .filter((name): name is string => Boolean(name)),
  );
  const definitionFiles = new Set<string>();

  for (const node of nodes) {
    const fileId = node.entity?.file.id;
    if (!fileId) continue;
    const scores = nodeScoresByFile.get(fileId) ?? [];
    scores.push(nodeScores.get(node.id) ?? 0);
    nodeScoresByFile.set(fileId, scores);
    if (node.isRoot)
      rootBoosts.set(fileId, (rootBoosts.get(fileId) ?? 0) + 0.15);

    if (terms.length > 0) {
      const metadata = node.entity?.entity.metadata;
      const hay = [
        metadata?.kind === "code" ? metadata.symbolName : "",
        metadata?.kind === "code" ? metadata.scope : "",
        node.entity?.file.relativePath ?? "",
      ]
        .join(" ")
        .toLowerCase();
      const hits = terms.filter((term) => hay.includes(term)).length;
      if (hits > 0)
        fileTermHits.set(fileId, Math.max(fileTermHits.get(fileId) ?? 0, hits));
    }

    const metadata = node.entity?.entity.metadata;
    if (
      metadata?.kind === "code" &&
      metadata.scope &&
      [...rootNames].some((name) =>
        metadata.scope!.toLowerCase().split("::").includes(name),
      ) &&
      !node.isRoot
    )
      definitionFiles.add(fileId);
  }

  // Aggregate evidence with diminishing returns so files containing many
  // siblings do not win solely through graph-node cardinality.
  for (const [fileId, scores] of nodeScoresByFile) {
    scores.sort((left, right) => right - left);
    let aggregate = 0;
    for (let index = 0; index < scores.length; index += 1) {
      const weight = index === 0 ? 1 : Math.max(0.08, 0.45 ** index);
      aggregate += scores[index]! * weight;
    }
    fileScores.set(fileId, aggregate + (rootBoosts.get(fileId) ?? 0));
  }

  for (const [fileId, hits] of fileTermHits)
    fileScores.set(fileId, (fileScores.get(fileId) ?? 0) * (1 + 0.35 * hits));
  for (const fileId of definitionFiles)
    if (fileScores.has(fileId))
      fileScores.set(fileId, (fileScores.get(fileId) ?? 0) * 1.75 + 0.05);

  const rootFiles = new Set(
    rootIds
      .map((id) => nodeById.get(id)?.entity?.file.id)
      .filter((id): id is string => typeof id === "string"),
  );
  const asksForTests = /\b(?:test|tests|testing|spec|specs)\b/i.test(query);
  if (!asksForTests)
    for (const node of nodes) {
      const file = node.entity?.file;
      if (
        file &&
        !rootFiles.has(file.id) &&
        isTestPath(file.relativePath) &&
        fileScores.has(file.id)
      )
        fileScores.set(file.id, (fileScores.get(file.id) ?? 0) * 0.2);
    }
  for (const node of nodes) {
    const file = node.entity?.file;
    if (!file || rootFiles.has(file.id) || !fileScores.has(file.id)) continue;
    fileScores.set(
      file.id,
      (fileScores.get(file.id) ?? 0) *
        lowPriorityPathFactor(file.relativePath, query),
    );
  }
  return fileScores;
}

function lowPriorityPathFactor(path: string, query: string): number {
  const normalized = path.toLowerCase();
  const queryLower = query.toLowerCase();
  const groups: readonly [RegExp, number][] = [
    [/(^|\/)(third_party|vendor|vendors|node_modules)(\/|$)/, 0.15],
    [/(^|\/)(examples?|samples?|benchmarks?)(\/|$)/, 0.35],
    [/(^|\/)(tools?|scripts?)(\/|$)/, 0.55],
  ];
  for (const [pattern, factor] of groups) {
    const segment = normalized.match(pattern)?.[2];
    if (segment && !queryLower.includes(segment)) return factor;
  }
  return 1;
}

function addWeightedNeighbor(
  neighbors: Map<string, number>,
  id: string,
  weight: number,
): void {
  neighbors.set(id, (neighbors.get(id) ?? 0) + weight);
}
