import type { GraphReader, SymRef } from "../types.js";
import type { ExploreCallPath, ExploreEdge } from "./types.js";

const MAX_PATH_SEEDS = 8;
const MAX_PATH_ATTEMPTS = 32;
const MAX_PATH_EDGE_READS = 20_000;

export function collectCallPaths(
  graph: GraphReader,
  rootIds: readonly string[],
  maxDepth: number,
  limit: number,
): { paths: ExploreCallPath[]; refs: SymRef[] } {
  const paths: ExploreCallPath[] = [];
  const refs: SymRef[] = [];
  const seen = new Set<string>();
  const pathSeeds = rootIds.slice(0, MAX_PATH_SEEDS);
  let attempts = 0;
  let edgeReadsRemaining = MAX_PATH_EDGE_READS;
  const tryPath = (from: string, to: string): SymRef[] | null => {
    if (attempts >= MAX_PATH_ATTEMPTS || edgeReadsRemaining <= 0) return null;
    const allowance = Math.max(
      1,
      Math.floor(edgeReadsRemaining / (MAX_PATH_ATTEMPTS - attempts)),
    );
    attempts += 1;
    edgeReadsRemaining -= allowance;
    return graph.pathBetween(from, to, maxDepth, allowance);
  };
  for (let i = 0; i < pathSeeds.length && paths.length < limit; i++) {
    for (let j = i + 1; j < pathSeeds.length && paths.length < limit; j++) {
      if (attempts >= MAX_PATH_ATTEMPTS || edgeReadsRemaining <= 0) break;
      const forward = tryPath(pathSeeds[i]!, pathSeeds[j]!);
      const path = forward ?? tryPath(pathSeeds[j]!, pathSeeds[i]!);
      if (!path || path.length < 2) continue;
      const ids = path.map((ref) => ref.id);
      const key = ids.join("\0");
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push(...path);
      paths.push({ from: ids[0]!, to: ids[ids.length - 1]!, nodes: ids });
    }
  }
  return { paths, refs };
}

/** Add a compact execution spine for single-root and type-member queries. */
export function extendCallPaths(
  paths: readonly ExploreCallPath[],
  edges: readonly ExploreEdge[],
  seedIds: readonly string[],
  nodeScores: ReadonlyMap<string, number>,
  queryAffinity: ReadonlyMap<string, number>,
  maxDepth: number,
  limit: number,
): ExploreCallPath[] {
  const result = [...paths];
  const seen = new Set(result.map((path) => path.nodes.join("\0")));
  const outgoing = new Map<string, ExploreEdge[]>();
  for (const edge of edges) {
    if (edge.kind !== "CALLS" || edge.src === edge.dst) continue;
    const list = outgoing.get(edge.src) ?? [];
    list.push(edge);
    outgoing.set(edge.src, list);
  }
  for (const list of outgoing.values())
    list.sort(
      (left, right) =>
        Number(right.provenance === "static") -
          Number(left.provenance === "static") ||
        right.confidence - left.confidence ||
        (queryAffinity.get(right.dst) ?? 0) -
          (queryAffinity.get(left.dst) ?? 0) ||
        Number(outgoing.has(right.dst)) - Number(outgoing.has(left.dst)) ||
        left.firstLine - right.firstLine ||
        (nodeScores.get(right.dst) ?? 0) - (nodeScores.get(left.dst) ?? 0) ||
        left.dst.localeCompare(right.dst),
    );

  for (const start of [...new Set(seedIds)]) {
    if (result.length >= limit) break;
    if (result.some((path) => path.nodes.includes(start))) continue;
    const nodes = [start];
    const visited = new Set(nodes);
    while (nodes.length <= maxDepth) {
      const edge = outgoing
        .get(nodes.at(-1)!)
        ?.find((candidate) => !visited.has(candidate.dst));
      if (!edge) break;
      nodes.push(edge.dst);
      visited.add(edge.dst);
    }
    if (nodes.length < 2) continue;
    const key = nodes.join("\0");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ from: nodes[0]!, to: nodes.at(-1)!, nodes, derived: true });
  }
  return result.slice(0, limit);
}
