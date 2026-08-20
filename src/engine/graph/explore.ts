import type { StoredEntity } from "../storage/index.js";
import type { FileInfo, Range } from "../types.js";
import type { GraphQueryStorage } from "./query.js";
import type { GraphEdgeKind, GraphReader, SymRef } from "./types.js";
import { personalizedPageRank } from "./application/ranking.js";

const DEFAULT_SEARCH_LIMIT = 8;
const DEFAULT_TRAVERSAL_DEPTH = 3;
const DEFAULT_MAX_NODES = 200;
const DEFAULT_MAX_FILES = 8;
const DEFAULT_MAX_CHARS = 24_000;
const DEFAULT_GLUE_LIMIT = 60;
const DEFAULT_CONTAINER_GLUE_LIMIT = 40;
const DEFAULT_PATH_LIMIT = 8;
const MAX_PATH_SEEDS = 8;
const MAX_PATH_ATTEMPTS = 32;
const MAX_PATH_EDGE_READS = 20_000;
const DEFAULT_BLAST_LIMIT = 20;
const HIERARCHY_BUDGET_RATIO = 0.25;
const RWR_EDGE_WEIGHTS: Readonly<Record<GraphEdgeKind, number>> = {
  CALLS: 1,
  INHERITS: 0.9,
  CONTAINS: 0.7,
  REFS: 0.5,
  DEFINES: 0.4,
  IMPORTS: 0.4,
};
const CLUSTER_GAP_LINES = 3;

const TRAVERSE_EDGE_KINDS: readonly GraphEdgeKind[] = [
  "CALLS",
  "REFS",
  "INHERITS",
  "CONTAINS",
];

const TYPEISH_KINDS = new Set([
  "class",
  "interface",
  "struct",
  "trait",
  "enum",
  "type",
  "typealias",
]);

const QUERY_STOP_WORDS = new Set([
  "about",
  "after",
  "before",
  "does",
  "from",
  "have",
  "how",
  "into",
  "reach",
  "that",
  "their",
  "then",
  "this",
  "through",
  "what",
  "when",
  "where",
  "which",
  "with",
  "work",
  "works",
]);

export type ExploreOptions = {
  query: string;
  seedId?: string;
  searchLimit?: number;
  traversalDepth?: number;
  maxNodes?: number;
  maxFiles?: number;
  maxChars?: number;
};

export type ExploreSubgraphOptions = {
  seedIds: readonly string[];
  seedWeights?: ReadonlyMap<string, number>;
  traversalDepth?: number;
  maxNodes?: number;
  includeCallPaths?: boolean;
};

export type ExploreSubgraphStorage = Pick<GraphQueryStorage, "getEntity">;

export type ExploreNode = {
  id: string;
  kind?: string;
  isRoot: boolean;
  entity: StoredEntity | null;
};

export type ExploreEdge = {
  src: string;
  dst: string;
  kind: GraphEdgeKind;
  rel: string;
  count: number;
  firstLine: number;
  refName: string;
};

export type ExploreCallPath = {
  from: string;
  to: string;
  nodes: string[];
};

export type ExploreImpactRef = {
  id: string;
  entity: StoredEntity | null;
};

export type ExploreBlastRadius = {
  rootId: string;
  dependents: ExploreImpactRef[];
  tests: ExploreImpactRef[];
};

export type ExploreChangeSurfaceRef = {
  rootId: string;
  id: string;
  rel: "type" | "return";
  entity: StoredEntity;
  rescued: boolean;
};

export type ExploreFileBundle = {
  file: FileInfo;
  score: number;
  isCentral: boolean;
  isChangeSurface: boolean;
  symbols: ExploreSymbolSnippet[];
  /** Zvec-layer assembled text for this file (entity content, clustered). */
  text: string;
};

export type ExploreSymbolSnippet = {
  id: string;
  name: string;
  kind?: string;
  range: Range;
  content: string;
};

export type ExploreResult = {
  available: boolean;
  query: string;
  roots: ExploreNode[];
  nodes: ExploreNode[];
  edges: ExploreEdge[];
  edgesTruncated: boolean;
  callPaths: ExploreCallPath[];
  blastRadius: ExploreBlastRadius[];
  changeSurface: ExploreChangeSurfaceRef[];
  files: ExploreFileBundle[];
  emptyReason?: "graph_unavailable" | "no_seeds" | "no_context";
};

export type ExploreSubgraphResult = {
  available: boolean;
  rootIds: string[];
  nodes: ExploreNode[];
  edges: ExploreEdge[];
  edgesTruncated: boolean;
  callPaths: ExploreCallPath[];
  nodeScores: ReadonlyMap<string, number>;
};

type ScoredNode = {
  id: string;
  kind?: string;
  isRoot: boolean;
  depth: number;
};

/**
 * CodeGraph-style explore: seed → hierarchy → deep traverse → RWR file rank →
 * zvec entity-content assembly (no graph-layer disk reads).
 */
export function exploreGraph(
  graph: GraphReader,
  storage: GraphQueryStorage,
  options: ExploreOptions,
): ExploreResult {
  const query = options.query.trim();
  const searchLimit = clampInt(
    options.searchLimit ?? DEFAULT_SEARCH_LIMIT,
    1,
    32,
  );
  const traversalDepth = clampInt(
    options.traversalDepth ?? DEFAULT_TRAVERSAL_DEPTH,
    1,
    8,
  );
  const maxNodes = clampInt(options.maxNodes ?? DEFAULT_MAX_NODES, 16, 2_000);
  const maxFiles = clampInt(options.maxFiles ?? DEFAULT_MAX_FILES, 1, 32);
  const maxChars = clampInt(
    options.maxChars ?? DEFAULT_MAX_CHARS,
    1_000,
    200_000,
  );

  if (!graph.available) {
    return emptyResult(query, "graph_unavailable");
  }
  if (!query && !options.seedId) {
    throw new Error("explore requires a query or seedId");
  }

  const rootIds = resolveExploreSeeds(
    storage,
    query,
    options.seedId,
    searchLimit,
  );
  if (rootIds.length === 0) {
    return emptyResult(query, "no_seeds");
  }

  const subgraph = exploreSubgraph(graph, storage, {
    seedIds: rootIds,
    traversalDepth,
    maxNodes,
    includeCallPaths: true,
  });
  const { nodes, edges, edgesTruncated, callPaths } = subgraph;
  const blastRadius = collectBlastRadius(
    graph,
    storage,
    rootIds,
    DEFAULT_BLAST_LIMIT,
  );
  const fileScores = rankFilesWithRwr(
    nodes,
    rootIds,
    query,
    subgraph.nodeScores,
  );
  const changeSurface = collectChangeSurface({
    graph,
    storage,
    rootIds,
    nodes,
    nodeScores: subgraph.nodeScores,
    fileScores,
    query,
    maxFiles,
  });
  const assemblyNodes = includeChangeSurfaceNodes(nodes, changeSurface);
  const files = assembleExploreFiles({
    storage,
    nodes: assemblyNodes,
    fileScores,
    maxFiles,
    maxChars,
    rootFileIds: fileIdsForRoots(nodes, rootIds),
    changeSurfaceFileIds: new Set(
      changeSurface
        .filter((item) => item.rescued)
        .map((item) => item.entity.file.id),
    ),
  });

  if (files.length === 0) {
    return {
      available: true,
      query,
      roots: nodes.filter((n) => n.isRoot),
      nodes,
      edges,
      edgesTruncated,
      callPaths,
      blastRadius,
      changeSurface,
      files: [],
      emptyReason: "no_context",
    };
  }

  return {
    available: true,
    query,
    roots: nodes.filter((n) => n.isRoot),
    nodes,
    edges,
    edgesTruncated,
    callPaths,
    blastRadius,
    changeSurface,
    files,
  };
}

/**
 * Shared graph expansion used by both explore and ordinary search. It builds
 * and scores a bounded multi-seed subgraph without assembling source bundles
 * or calculating blast radius.
 */
export function exploreSubgraph(
  graph: GraphReader,
  storage: ExploreSubgraphStorage,
  options: ExploreSubgraphOptions,
): ExploreSubgraphResult {
  if (!graph.available) {
    return emptySubgraph(false);
  }
  const traversalDepth = clampInt(
    options.traversalDepth ?? DEFAULT_TRAVERSAL_DEPTH,
    1,
    8,
  );
  const maxNodes = clampInt(options.maxNodes ?? DEFAULT_MAX_NODES, 16, 2_000);
  const rootIds = [...new Set(options.seedIds)].filter((id) =>
    Boolean(storage.getEntity(id)),
  );
  if (rootIds.length === 0) {
    return emptySubgraph(true);
  }

  const selected = new Map<string, ScoredNode>();
  for (const id of rootIds) {
    selected.set(id, {
      id,
      kind: undefined,
      isRoot: true,
      depth: 0,
    });
  }

  const hierarchyBudget = Math.max(
    8,
    Math.floor(maxNodes * HIERARCHY_BUDGET_RATIO),
  );
  expandHierarchy(graph, selected, rootIds, hierarchyBudget);
  glueContainers(
    graph,
    selected,
    rootIds,
    Math.min(DEFAULT_CONTAINER_GLUE_LIMIT, maxNodes),
  );

  const perRootBudget = Math.max(
    8,
    Math.ceil(maxNodes / Math.max(1, rootIds.length)),
  );
  for (const rootId of [...selected.keys()].filter(
    (id) => selected.get(id)?.isRoot,
  )) {
    const walked = graph.traverse(rootId, {
      edgeKinds: TRAVERSE_EDGE_KINDS,
      direction: "both",
      maxDepth: traversalDepth,
      limit: perRootBudget,
      includeStart: true,
    });
    for (const ref of walked) {
      absorb(selected, ref, false, 1);
    }
  }

  glueCallNeighbors(graph, selected, rootIds, DEFAULT_GLUE_LIMIT);

  const callPaths =
    options.includeCallPaths === false
      ? []
      : collectCallPaths(
          graph,
          selected,
          rootIds,
          Math.max(4, traversalDepth * 2),
          DEFAULT_PATH_LIMIT,
        );

  const protectedIds = new Set([
    ...rootIds,
    ...callPaths.flatMap((path) => path.nodes),
  ]);
  trimToMaxNodes(selected, protectedIds, maxNodes);
  const retainedCallPaths = callPaths.filter((path) =>
    path.nodes.every((id) => selected.has(id)),
  );

  const nodes: ExploreNode[] = [];
  for (const scored of selected.values()) {
    const entity = storage.getEntity(scored.id);
    const metaKind =
      entity?.entity.metadata?.kind === "code"
        ? entity.entity.metadata.symbolType
        : undefined;
    nodes.push({
      id: scored.id,
      kind: scored.kind ?? metaKind,
      isRoot: scored.isRoot,
      entity,
    });
  }

  const edgeBudget = Math.min(20_000, Math.max(128, maxNodes * 8));
  const induced = collectExploreEdges(graph, selected, edgeBudget);
  const edges = induced.edges;
  return {
    available: true,
    rootIds,
    nodes,
    edges,
    edgesTruncated: induced.truncated,
    callPaths: retainedCallPaths,
    nodeScores: rankNodesWithRwr(nodes, edges, rootIds, options.seedWeights),
  };
}

function emptySubgraph(available: boolean): ExploreSubgraphResult {
  return {
    available,
    rootIds: [],
    nodes: [],
    edges: [],
    edgesTruncated: false,
    callPaths: [],
    nodeScores: new Map(),
  };
}

function expandHierarchy(
  graph: GraphReader,
  selected: Map<string, ScoredNode>,
  rootIds: readonly string[],
  budget: number,
): void {
  let remaining = budget;

  for (const rootId of rootIds) {
    if (remaining <= 0) {
      break;
    }
    for (const ref of graph.hierarchy(
      rootId,
      "bases",
      Math.min(10, remaining),
    )) {
      if (absorb(selected, ref, false, 1)) {
        remaining -= 1;
      }
    }
    for (const ref of graph.hierarchy(
      rootId,
      "derived",
      Math.min(10, remaining),
    )) {
      if (absorb(selected, ref, false, 1)) {
        remaining -= 1;
      }
    }
  }

  // Sibling types: other derived types of the same bases.
  const baseIds = new Set<string>();
  for (const id of [...selected.keys()]) {
    for (const base of graph.hierarchy(id, "bases", 5)) {
      baseIds.add(base.id);
      absorb(selected, base, false, 1);
    }
  }
  for (const baseId of baseIds) {
    if (remaining <= 0) {
      break;
    }
    for (const sib of graph.hierarchy(baseId, "derived", 12)) {
      if (absorb(selected, sib, false, 2)) {
        remaining -= 1;
        if (remaining <= 0) {
          break;
        }
      }
    }
  }
}

function glueCallNeighbors(
  graph: GraphReader,
  selected: Map<string, ScoredNode>,
  rootIds: readonly string[],
  limit: number,
): void {
  let added = 0;
  for (const rootId of rootIds) {
    if (added >= limit) {
      break;
    }
    for (const ref of [
      ...graph.callers(rootId, 1, 20),
      ...graph.callees(rootId, 1, 20),
    ]) {
      if (absorb(selected, ref, false, 1)) {
        added += 1;
        if (added >= limit) {
          break;
        }
      }
    }
  }
}

function glueContainers(
  graph: GraphReader,
  selected: Map<string, ScoredNode>,
  rootIds: readonly string[],
  limit: number,
): void {
  let added = 0;
  for (const neighbor of graph.expandContainers(rootIds, limit)) {
    for (const id of [neighbor.parent_id, neighbor.sib_id]) {
      if (!id || added >= limit) continue;
      if (absorb(selected, { id }, false, 1)) added += 1;
    }
  }
}

function trimToMaxNodes(
  selected: Map<string, ScoredNode>,
  protectedIds: ReadonlySet<string>,
  maxNodes: number,
): void {
  if (selected.size <= maxNodes) {
    return;
  }
  const ranked = [...selected.values()].sort((a, b) => {
    const ar = protectedIds.has(a.id) ? 0 : 1;
    const br = protectedIds.has(b.id) ? 0 : 1;
    if (ar !== br) {
      return ar - br;
    }
    if (a.depth !== b.depth) {
      return a.depth - b.depth;
    }
    return a.id.localeCompare(b.id);
  });
  selected.clear();
  for (const node of ranked.slice(0, maxNodes)) {
    selected.set(node.id, node);
  }
}

function collectCallPaths(
  graph: GraphReader,
  selected: Map<string, ScoredNode>,
  rootIds: readonly string[],
  maxDepth: number,
  limit: number,
): ExploreCallPath[] {
  const paths: ExploreCallPath[] = [];
  const seen = new Set<string>();
  const pathSeeds = rootIds.slice(0, MAX_PATH_SEEDS);
  let attempts = 0;
  let edgeReadsRemaining = MAX_PATH_EDGE_READS;
  const tryPath = (from: string, to: string): SymRef[] | null => {
    if (attempts >= MAX_PATH_ATTEMPTS || edgeReadsRemaining <= 0) return null;
    const attemptsRemaining = MAX_PATH_ATTEMPTS - attempts;
    const edgeAllowance = Math.max(
      1,
      Math.floor(edgeReadsRemaining / attemptsRemaining),
    );
    attempts += 1;
    edgeReadsRemaining -= edgeAllowance;
    return graph.pathBetween(from, to, maxDepth, edgeAllowance);
  };
  for (let i = 0; i < pathSeeds.length && paths.length < limit; i++) {
    for (let j = i + 1; j < pathSeeds.length && paths.length < limit; j++) {
      if (attempts >= MAX_PATH_ATTEMPTS || edgeReadsRemaining <= 0) break;
      const left = pathSeeds[i]!;
      const right = pathSeeds[j]!;
      const forward = tryPath(left, right);
      const reverse = forward ? null : tryPath(right, left);
      const path = forward ?? reverse;
      if (!path || path.length < 2) {
        continue;
      }
      const ids = path.map((ref) => ref.id);
      const key = ids.join("\0");
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      for (let depth = 0; depth < path.length; depth++) {
        absorb(selected, path[depth]!, false, depth);
      }
      paths.push({
        from: ids[0]!,
        to: ids[ids.length - 1]!,
        nodes: ids,
      });
    }
  }
  return paths;
}

function collectBlastRadius(
  graph: GraphReader,
  storage: GraphQueryStorage,
  rootIds: readonly string[],
  limit: number,
): ExploreBlastRadius[] {
  return rootIds.map((rootId) => {
    const refs = graph.impact(rootId, 3, limit * 3);
    const dependents: ExploreImpactRef[] = [];
    const tests: ExploreImpactRef[] = [];
    const seen = new Set<string>();
    for (const ref of refs) {
      if (seen.has(ref.id)) {
        continue;
      }
      seen.add(ref.id);
      const item = { id: ref.id, entity: storage.getEntity(ref.id) };
      if (item.entity && isTestPath(item.entity.file.relativePath)) {
        if (tests.length < limit) tests.push(item);
      } else if (dependents.length < limit) {
        dependents.push(item);
      }
    }
    return { rootId, dependents, tests };
  });
}

function collectChangeSurface(input: {
  graph: GraphReader;
  storage: GraphQueryStorage;
  rootIds: readonly string[];
  nodes: readonly ExploreNode[];
  nodeScores: ReadonlyMap<string, number>;
  fileScores: Map<string, number>;
  query: string;
  maxFiles: number;
}): ExploreChangeSurfaceRef[] {
  const callableRoots = input.rootIds.filter((id) => {
    const entity = input.storage.getEntity(id);
    const kind =
      entity?.entity.metadata?.kind === "code"
        ? entity.entity.metadata.symbolType
        : "";
    // Extractors normalize free functions, methods and constructors to function.
    return kind === "function";
  });
  const candidates: Omit<ExploreChangeSurfaceRef, "rescued">[] = [];
  const seen = new Set<string>();
  for (const rootId of callableRoots.slice(0, 5)) {
    for (const ref of input.graph.context(rootId).outgoing) {
      if (ref.rel !== "type" && ref.rel !== "return") continue;
      const entity = input.storage.getEntity(ref.id);
      const kind =
        entity?.entity.metadata?.kind === "code"
          ? entity.entity.metadata.symbolType
          : "";
      if (!entity || !TYPEISH_KINDS.has(kind)) continue;
      const key = `${rootId}\0${ref.id}\0${ref.rel}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ rootId, id: ref.id, rel: ref.rel, entity });
    }
  }

  const rankedFileIds = [...input.fileScores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, input.maxFiles)
    .map(([id]) => id);
  const visibleFiles = new Set(rankedFileIds);
  const maxFileScore = Math.max(...input.fileScores.values(), 0);
  const maxNodeScore = Math.max(...input.nodeScores.values(), 0);
  const terms = queryTerms(input.query);

  return candidates.map((candidate) => {
    const fileId = candidate.entity.file.id;
    const fileScore = input.fileScores.get(fileId) ?? 0;
    const nodeScore = input.nodeScores.get(candidate.id) ?? 0;
    const hay =
      `${symbolName(candidate.entity)} ${candidate.entity.file.relativePath}`.toLowerCase();
    const weakText = terms.every((term) => !hay.includes(term));
    const weakGraph =
      !visibleFiles.has(fileId) ||
      (fileScore < maxFileScore * 0.06 && nodeScore < maxNodeScore * 0.06);
    const rescued = weakText && weakGraph;
    if (rescued && !input.fileScores.has(fileId)) {
      input.fileScores.set(fileId, 0);
    }
    return { ...candidate, rescued };
  });
}

function includeChangeSurfaceNodes(
  nodes: readonly ExploreNode[],
  changeSurface: readonly ExploreChangeSurfaceRef[],
): ExploreNode[] {
  const out = [...nodes];
  const seen = new Set(nodes.map((node) => node.id));
  for (const item of changeSurface) {
    if (!item.rescued || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push({
      id: item.id,
      kind:
        item.entity.entity.metadata?.kind === "code"
          ? item.entity.entity.metadata.symbolType
          : undefined,
      isRoot: false,
      entity: item.entity,
    });
  }
  return out;
}

function fileIdsForRoots(
  nodes: readonly ExploreNode[],
  rootIds: readonly string[],
): Set<string> {
  const roots = new Set(rootIds);
  return new Set(
    nodes
      .filter((node) => roots.has(node.id))
      .map((node) => node.entity?.file.id)
      .filter((id): id is string => Boolean(id)),
  );
}

function isTestPath(path: string): boolean {
  return /(^|\/)(tests?|specs?|__tests__)(\/|$)|(?:\.|_)(?:test|spec)\.[^/]+$|_test\.[^/]+$/i.test(
    path,
  );
}

function collectExploreEdges(
  graph: GraphReader,
  selected: Map<string, ScoredNode>,
  limit: number,
): { edges: ExploreEdge[]; truncated: boolean } {
  const ids = [...selected.keys()];
  const result = graph.edges(ids, TRAVERSE_EDGE_KINDS, limit);
  return {
    edges: result.edges.map((edge) => ({
      src: edge.src,
      dst: edge.dst,
      kind: edge.kind,
      rel: edge.rel,
      count: edge.count,
      firstLine: edge.first_line,
      refName: edge.ref_name,
    })),
    truncated: result.truncated,
  };
}

function rankFilesWithRwr(
  nodes: readonly ExploreNode[],
  rootIds: readonly string[],
  query: string,
  nodeScores: ReadonlyMap<string, number>,
): Map<string, number> {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  const terms = queryTerms(query);
  const fileScores = new Map<string, number>();
  const fileTermHits = new Map<string, number>();

  for (const node of nodes) {
    const fileId = node.entity?.file.id;
    if (!fileId) {
      continue;
    }
    const nodeScore = nodeScores.get(node.id) ?? 0;
    const rootBoost = node.isRoot ? 0.15 : 0;
    fileScores.set(
      fileId,
      (fileScores.get(fileId) ?? 0) + nodeScore + rootBoost,
    );

    if (terms.length > 0) {
      const hay = [
        node.entity?.entity.metadata?.kind === "code"
          ? node.entity.entity.metadata.symbolName
          : "",
        node.entity?.file.relativePath ?? "",
      ]
        .join(" ")
        .toLowerCase();
      let hits = 0;
      for (const term of terms) {
        if (hay.includes(term)) {
          hits += 1;
        }
      }
      if (hits > 0) {
        fileTermHits.set(fileId, Math.max(fileTermHits.get(fileId) ?? 0, hits));
      }
    }
  }

  for (const [fileId, hits] of fileTermHits) {
    fileScores.set(fileId, (fileScores.get(fileId) ?? 0) * (1 + 0.35 * hits));
  }

  // Drop files with no term hits when query has identifiers, unless root file.
  const rootFiles = new Set(
    rootIds
      .map((id) => nodeById.get(id)?.entity?.file.id)
      .filter((id): id is string => typeof id === "string"),
  );
  if (terms.length > 0) {
    for (const fileId of [...fileScores.keys()]) {
      if (rootFiles.has(fileId)) {
        continue;
      }
      if ((fileTermHits.get(fileId) ?? 0) === 0) {
        const score = fileScores.get(fileId) ?? 0;
        const max = Math.max(...fileScores.values(), 0);
        if (score < max * 0.06) {
          fileScores.delete(fileId);
        }
      }
    }
  }

  return fileScores;
}

function rankNodesWithRwr(
  nodes: readonly ExploreNode[],
  edges: readonly ExploreEdge[],
  rootIds: readonly string[],
  seedWeights?: ReadonlyMap<string, number>,
): Map<string, number> {
  const adj = new Map<string, Map<string, number>>();
  for (const node of nodes) {
    adj.set(node.id, new Map());
  }
  for (const edge of edges) {
    if (!adj.has(edge.src) || !adj.has(edge.dst)) {
      continue;
    }
    const weight = RWR_EDGE_WEIGHTS[edge.kind];
    addWeightedNeighbor(adj.get(edge.src)!, edge.dst, weight);
    addWeightedNeighbor(adj.get(edge.dst)!, edge.src, weight);
  }
  return personalizedPageRank(
    [...adj.keys()],
    adj,
    rootIds.filter((id) => adj.has(id)),
    seedWeights,
  );
}

function addWeightedNeighbor(
  neighbors: Map<string, number>,
  id: string,
  weight: number,
): void {
  neighbors.set(id, (neighbors.get(id) ?? 0) + weight);
}

function assembleExploreFiles(input: {
  storage: GraphQueryStorage;
  nodes: readonly ExploreNode[];
  fileScores: Map<string, number>;
  maxFiles: number;
  maxChars: number;
  rootFileIds: ReadonlySet<string>;
  changeSurfaceFileIds: ReadonlySet<string>;
}): ExploreFileBundle[] {
  const byFile = new Map<string, ExploreNode[]>();
  for (const node of input.nodes) {
    const file = node.entity?.file;
    if (!file || !input.fileScores.has(file.id)) {
      continue;
    }
    const list = byFile.get(file.id) ?? [];
    list.push(node);
    byFile.set(file.id, list);
  }

  const rankedFileIds = [...input.fileScores.entries()]
    .filter(([fileId]) => byFile.has(fileId))
    .sort((a, b) => {
      const priority = (id: string): number =>
        input.rootFileIds.has(id)
          ? 0
          : input.changeSurfaceFileIds.has(id)
            ? 1
            : 2;
      const priorityDiff = priority(a[0]) - priority(b[0]);
      if (priorityDiff !== 0) return priorityDiff;
      if (b[1] !== a[1]) {
        return b[1] - a[1];
      }
      return a[0].localeCompare(b[0]);
    })
    .slice(0, input.maxFiles)
    .map(([fileId]) => fileId);

  if (rankedFileIds.length === 0) {
    return [];
  }

  const topScore = input.fileScores.get(rankedFileIds[0]!) ?? 0;
  const central = new Set(
    rankedFileIds
      .filter((id) => (input.fileScores.get(id) ?? 0) >= topScore * 0.85)
      .slice(0, 2),
  );

  const budgets = allocateCharBudgets(rankedFileIds, central, input.maxChars);

  const bundles: ExploreFileBundle[] = [];
  for (const fileId of rankedFileIds) {
    const nodes = byFile.get(fileId) ?? [];
    const file = nodes[0]?.entity?.file;
    if (!file) {
      continue;
    }
    const symbols = nodes
      .map((node) => toSymbolSnippet(node))
      .filter((s): s is ExploreSymbolSnippet => s !== null)
      .sort((a, b) => startLine(a.range) - startLine(b.range));

    const clustered = clusterSymbols(symbols);
    const budget =
      budgets.get(fileId) ?? Math.floor(input.maxChars / rankedFileIds.length);
    const text = renderFileText(clustered, budget);
    if (!text.trim()) {
      continue;
    }
    bundles.push({
      file,
      score: input.fileScores.get(fileId) ?? 0,
      isCentral: central.has(fileId),
      isChangeSurface: input.changeSurfaceFileIds.has(fileId),
      symbols: clustered,
      text,
    });
  }
  return bundles;
}

function toSymbolSnippet(node: ExploreNode): ExploreSymbolSnippet | null {
  const entity = node.entity;
  if (!entity || entity.entity.content.kind !== "text") {
    return null;
  }
  const meta = entity.entity.metadata;
  const name =
    meta?.kind === "code" && meta.symbolName
      ? meta.symbolName
      : node.id.slice(0, 12);
  return {
    id: node.id,
    name,
    kind: meta?.kind === "code" ? meta.symbolType : node.kind,
    range: entity.entity.range,
    content: entity.entity.content.text,
  };
}

function clusterSymbols(
  symbols: readonly ExploreSymbolSnippet[],
): ExploreSymbolSnippet[] {
  // Keep symbol identity; clustering only affects render adjacency.
  // Nearby symbols stay in order — merge is representational in renderFileText.
  return [...symbols];
}

function renderFileText(
  symbols: readonly ExploreSymbolSnippet[],
  budget: number,
): string {
  if (budget <= 0) return "";
  const parts: string[] = [];
  let used = 0;
  let prevEnd = -1;

  for (const sym of symbols) {
    const start = startLine(sym.range);
    const end = endLine(sym.range);
    const header = `// ${sym.kind ?? "sym"} ${sym.name} L${start}-${end}`;
    const gap =
      prevEnd >= 0 && start > prevEnd + CLUSTER_GAP_LINES ? "\n// ...\n" : "\n";
    const block = `${parts.length === 0 ? "" : gap}${header}\n${sym.content.trimEnd()}\n`;
    if (used + block.length > budget) {
      const remaining = budget - used;
      if (remaining > 0) {
        const marker = "\n// ... truncated\n";
        const contentLength = Math.max(0, remaining - marker.length);
        parts.push(
          `${block.slice(0, contentLength)}${marker.slice(0, remaining - contentLength)}`,
        );
      }
      break;
    }
    parts.push(block);
    used += block.length;
    prevEnd = end;
  }
  return parts.join("").slice(0, budget);
}

function allocateCharBudgets(
  fileIds: readonly string[],
  central: ReadonlySet<string>,
  maxChars: number,
): Map<string, number> {
  const budgets = new Map<string, number>();
  if (fileIds.length === 0) {
    return budgets;
  }
  const centralIds = fileIds.filter((id) => central.has(id));
  const otherIds = fileIds.filter((id) => !central.has(id));
  const centralShare = centralIds.length > 0 ? 0.55 : 0;
  const centralBudget = Math.floor(maxChars * centralShare);
  const otherBudget = maxChars - centralBudget;

  for (const id of centralIds) {
    budgets.set(id, Math.floor(centralBudget / centralIds.length));
  }
  for (const id of otherIds) {
    budgets.set(id, Math.floor(otherBudget / Math.max(1, otherIds.length)));
  }
  if (centralIds.length === 0) {
    for (const id of fileIds) {
      budgets.set(id, Math.floor(maxChars / fileIds.length));
    }
  }
  return budgets;
}

export function resolveExploreSeeds(
  storage: GraphQueryStorage,
  query: string,
  seedId: string | undefined,
  limit: number,
): string[] {
  if (seedId) {
    return storage.getEntity(seedId) ? [seedId] : [];
  }

  const candidates = new Map<
    string,
    { entity: StoredEntity; exact: boolean }
  >();
  const seen = new Set<string>();
  const pushEntity = (entity: StoredEntity, exact = false) => {
    if (seen.has(entity.entity.id)) {
      if (exact) candidates.get(entity.entity.id)!.exact = true;
      return;
    }
    seen.add(entity.entity.id);
    candidates.set(entity.entity.id, { entity, exact });
  };

  const exact = storage.findSymbolsByName(query, limit);
  for (const entity of exact) {
    pushEntity(entity, true);
  }

  if (candidates.size < limit && storage.findSymbolsByQuery) {
    for (const entity of storage.findSymbolsByQuery(query, limit * 4)) {
      pushEntity(entity);
    }
  }

  for (const term of queryTerms(query)) {
    if (term.length < 2) {
      continue;
    }
    for (const entity of storage.findSymbolsByName(term, limit)) {
      pushEntity(entity, symbolName(entity).toLowerCase() === term);
    }
    if (storage.findSymbolsByQuery && term.length >= 3) {
      for (const entity of storage.findSymbolsByQuery(term, limit)) {
        pushEntity(entity);
      }
    }
  }

  const terms = queryTerms(query);
  const asksForTests = /\b(?:test|tests|testing|spec|specs)\b/i.test(query);
  const scored = [...candidates.values()].map(({ entity, exact }) => {
    const meta = entity.entity.metadata;
    const kind = meta?.kind === "code" ? meta.symbolType : "";
    const hay =
      `${symbolName(entity)} ${entity.file.relativePath}`.toLowerCase();
    const termHits = terms.filter((term) => hay.includes(term)).length;
    const testPenalty =
      !asksForTests && isTestPath(entity.file.relativePath) ? 20 : 0;
    const score =
      (exact ? 100 : 0) +
      termHits * 12 +
      (termHits >= 2 ? 20 : 0) +
      (TYPEISH_KINDS.has(kind) ? 4 : 0) -
      testPenalty;
    return { id: entity.entity.id, score };
  });
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return scored.map((s) => s.id).slice(0, limit);
}

function symbolName(entity: StoredEntity): string {
  const meta = entity.entity.metadata;
  return meta?.kind === "code" ? (meta.symbolName ?? "") : "";
}

function queryTerms(query: string): string[] {
  const raw = query.match(/[A-Za-z_][A-Za-z0-9_]{1,}/g) ?? [];
  const terms = new Set<string>();
  for (const token of raw) {
    const normalized = token.toLowerCase();
    if (normalized.length >= 3 && !QUERY_STOP_WORDS.has(normalized)) {
      terms.add(normalized);
    }
    for (const piece of token.split(/(?=[A-Z])|_+/)) {
      const normalizedPiece = piece.toLowerCase();
      if (
        normalizedPiece.length >= 3 &&
        !QUERY_STOP_WORDS.has(normalizedPiece)
      ) {
        terms.add(normalizedPiece);
      }
    }
  }
  return [...terms].slice(0, 16);
}

function absorb(
  selected: Map<string, ScoredNode>,
  ref: SymRef,
  isRoot: boolean,
  depth: number,
): boolean {
  const existing = selected.get(ref.id);
  if (existing) {
    if (isRoot) {
      existing.isRoot = true;
    }
    existing.depth = Math.min(existing.depth, depth);
    if (ref.kind) {
      existing.kind = ref.kind;
    }
    return false;
  }
  selected.set(ref.id, {
    id: ref.id,
    kind: ref.kind,
    isRoot,
    depth,
  });
  return true;
}

function emptyResult(
  query: string,
  emptyReason: NonNullable<ExploreResult["emptyReason"]>,
): ExploreResult {
  return {
    available: emptyReason !== "graph_unavailable",
    query,
    roots: [],
    nodes: [],
    edges: [],
    edgesTruncated: false,
    callPaths: [],
    blastRadius: [],
    changeSurface: [],
    files: [],
    emptyReason,
  };
}

function startLine(range: Range): number {
  return range.kind === "text" ? range.startLine : 1;
}

function endLine(range: Range): number {
  return range.kind === "text" ? range.endLine : startLine(range);
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}
