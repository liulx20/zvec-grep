import type { StoredEntity } from "../../storage/index.js";
import type { GraphQueryStorage } from "../ports.js";
import { isLowValuePath, isTestPath } from "../path-policy.js";
import { groupSemanticSymbols } from "../symbol-lookup.js";
import { isCallableSymbolKind } from "../symbol-kinds.js";
import type {
  DynamicBoundary,
  GraphEdgeKind,
  GraphReader,
  SymRef,
} from "../types.js";
import { collectCallPaths } from "./paths.js";
import { assembleExploreFiles } from "./assembly.js";
import {
  fileStem,
  isCounterpartSourcePath,
  isHeaderPath,
  isSourcePath,
  platformDeclarationCounterparts,
  semanticPathAffinity,
} from "./counterpart-policy.js";
import {
  collectBlastRadius,
  collectChangeSurface,
  fileIdsForRoots,
  includeBlastRadiusNodes,
  includeChangeSurfaceNodes,
} from "./impact.js";
import {
  EXPLORE_POLICY,
  isTypeishKind,
  queryTerms,
  semanticTermsCovered,
  resolveExactExploreSeedGroups,
  resolveExploreSeeds,
} from "./policy.js";
import { rankExploreFiles, rankExploreNodes } from "./ranking.js";
import type {
  ExploreEdge,
  ExploreNode,
  ExploreOptions,
  ExploreResult,
  ExploreSubgraphOptions,
  ExploreSubgraphResult,
  ExploreSubgraphStorage,
} from "./types.js";

const DEFAULT_SEARCH_LIMIT = EXPLORE_POLICY.searchLimit;
const DEFAULT_TRAVERSAL_DEPTH = EXPLORE_POLICY.traversalDepth;
const DEFAULT_MAX_NODES = EXPLORE_POLICY.maxNodes;
const DEFAULT_MAX_FILES = EXPLORE_POLICY.maxFiles;
const DEFAULT_MAX_CHARS = EXPLORE_POLICY.maxChars;
const DEFAULT_GLUE_LIMIT = EXPLORE_POLICY.glueLimit;
const DEFAULT_CONTAINER_GLUE_LIMIT = EXPLORE_POLICY.containerGlueLimit;
const DEFAULT_PATH_LIMIT = EXPLORE_POLICY.pathLimit;
const DEFAULT_BLAST_LIMIT = EXPLORE_POLICY.blastLimit;
const HIERARCHY_BUDGET_RATIO = EXPLORE_POLICY.hierarchyBudgetRatio;
const TRAVERSE_EDGE_KINDS: readonly GraphEdgeKind[] =
  EXPLORE_POLICY.traverseEdgeKinds;

type ScoredNode = {
  id: string;
  kind?: string;
  isRoot: boolean;
  depth: number;
};

type ComponentDependency = { src: string; dst: string };

type ExploreHierarchyReader = GraphReader & {
  hierarchyDiverse?: (
    id: string,
    direction: "bases" | "derived",
    limit: number,
  ) => SymRef[];
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
  const requestedMaxNodes = options.maxNodes;
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

  const exactGroups = options.seedId
    ? null
    : resolveExactExploreSeedGroups(storage, query, searchLimit);
  if (exactGroups && exactGroups.length > 1) {
    return {
      ...emptyResult(query, "no_context"),
      ambiguous: true,
      seedCandidates: exactGroups.map(({ representative }) => ({
        id: representative.entity.id,
        kind:
          representative.entity.metadata?.kind === "code"
            ? representative.entity.metadata.symbolType
            : undefined,
        isRoot: true,
        entity: representative,
      })),
      emptyReason: undefined,
    };
  }
  const rootIds =
    exactGroups?.[0]?.ids ??
    resolveExploreSeeds(storage, query, options.seedId, searchLimit);
  if (rootIds.length === 0) {
    return emptyResult(query, "no_seeds");
  }

  // A single exact root in a high-degree graph should not automatically
  // consume the same 200-node budget as a multi-concept query. Conversely,
  // several independently relevant roots need enough room to connect. Keep
  // explicit caller budgets unchanged and adapt only the default.
  const maxNodes = clampInt(
    requestedMaxNodes ?? adaptiveNodeBudget(rootIds.length),
    16,
    2_000,
  );

  const subgraph = exploreSubgraph(graph, storage, {
    seedIds: rootIds,
    traversalDepth,
    maxNodes,
    includeCallPaths: true,
  });
  const { callPaths } = subgraph;
  const nodeScores = new Map(subgraph.nodeScores);
  const counterpartExpansion = includeCounterpartSourceNodes(
    subgraph.nodes,
    graph,
    storage,
    nodeScores,
    rootIds,
    maxFiles,
  );
  const counterpartCallSpine = includeCounterpartCallSpine(
    counterpartExpansion.nodes,
    graph,
    storage,
    nodeScores,
    new Set([
      ...rootSemanticCounterpartNodeIds(
        counterpartExpansion.nodes,
        storage,
        rootIds,
      ),
      ...counterpartExpansion.directCounterpartNodeIds,
    ]),
    24,
  );
  const moduleEntrypoints = includeModuleEntrypointNodes(
    counterpartCallSpine,
    graph,
    storage,
    nodeScores,
    rootIds,
    query,
    16,
  );
  const collaborators = includeDirectCallCollaborators(
    moduleEntrypoints.nodes,
    graph,
    storage,
    nodeScores,
    rootIds,
    query,
    8,
  );
  const nodes = collaborators.nodes;
  const counterpartEdges =
    nodes.length === subgraph.nodes.length
      ? null
      : graph.edges(
          nodes.map((node) => node.id),
          TRAVERSE_EDGE_KINDS,
          Math.min(20_000, Math.max(128, nodes.length * 8)),
        );
  let edges = counterpartEdges
    ? counterpartEdges.edges.map(toExploreEdge)
    : subgraph.edges;
  let edgesTruncated = counterpartEdges?.truncated ?? subgraph.edgesTruncated;
  const roots = exactGroups?.[0]
    ? nodes.filter(
        (node) => node.id === exactGroups[0]!.representative.entity.id,
      )
    : nodes.filter((node) => node.isRoot);
  const dynamicBoundaryLimit = Math.min(16, maxNodes);
  const dynamicBoundaryFetchLimit = Math.min(256, dynamicBoundaryLimit * 8);
  const dynamicBoundaryRows =
    graph.dynamicBoundaries?.(
      nodes.map((node) => node.id),
      dynamicBoundaryFetchLimit + 1,
    ) ?? [];
  const dynamicBoundaries = selectDynamicBoundaries(
    dynamicBoundaryRows,
    dynamicBoundaryLimit,
    nodes,
    nodeScores,
  );
  const dynamicBoundariesTruncated =
    dynamicBoundaryRows.length > dynamicBoundaries.length;
  const blastRadius = collectBlastRadius(
    graph,
    storage,
    rootIds,
    DEFAULT_BLAST_LIMIT,
  );
  const impactAssembly = includeBlastRadiusNodes(
    nodes,
    blastRadius,
    exactGroups?.[0]
      ? Math.min(2, Math.max(0, maxFiles - 1))
      : Math.min(2, Math.max(1, maxFiles - 1)),
  );
  const impactCounterparts = includeImpactSourceDeclarations(
    impactAssembly.nodes,
    nodes,
    storage,
    nodeScores,
    4,
  );
  const contextNodes = impactCounterparts.nodes;
  if (contextNodes.length !== nodes.length) {
    const impactEdges = graph.edges(
      contextNodes.map((node) => node.id),
      TRAVERSE_EDGE_KINDS,
      Math.min(20_000, Math.max(128, contextNodes.length * 8)),
    );
    edges = impactEdges.edges.map(toExploreEdge);
    const impactNodeIds = new Set(contextNodes.map((node) => node.id));
    const incidentRootEdges = graph
      .incomingEdges(
        rootIds,
        ["CALLS", "REFS", "INHERITS", "INSTANTIATES"],
        Math.min(1_024, Math.max(64, rootIds.length * 32)),
      )
      .filter((edge) => impactNodeIds.has(edge.src))
      .map(toExploreEdge);
    const edgeKeys = new Set(
      edges.map(
        (edge) => `${edge.src}\0${edge.dst}\0${edge.kind}\0${edge.rel}`,
      ),
    );
    for (const edge of incidentRootEdges) {
      const key = `${edge.src}\0${edge.dst}\0${edge.kind}\0${edge.rel}`;
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);
      edges.push(edge);
    }
    edgesTruncated = impactEdges.truncated;
  }
  const fileScores = rankExploreFiles(contextNodes, rootIds, query, nodeScores);
  for (const fileId of collaborators.fileIds) {
    if (fileScores.has(fileId)) continue;
    const score = contextNodes
      .filter((node) => node.entity?.file.id === fileId)
      .reduce(
        (maximum, node) => Math.max(maximum, nodeScores.get(node.id) ?? 0),
        0,
      );
    fileScores.set(fileId, Math.max(0.02, score));
  }
  boostImpactFiles(fileScores, impactAssembly.fileHits);
  const dynamicBoundaryFileIds = relevantDynamicBoundaryFileIds(
    dynamicBoundaries,
    nodes,
    nodeScores,
    edges,
    rootIds,
  );
  boostDynamicBoundaryFiles(
    fileScores,
    nodes,
    dynamicBoundaries,
    dynamicBoundaryFileIds,
  );
  const changeSurface = collectChangeSurface({
    graph,
    storage,
    rootIds,
    nodes,
    nodeScores,
    fileScores,
    maxFiles,
  });
  const assemblyNodes = includeChangeSurfaceNodes(
    contextNodes,
    changeSurface,
    graph,
    storage,
  );
  const assemblyRootFileIds = exactGroups?.[0]
    ? fileIdsForRoots(nodes, rootIds)
    : primaryConceptualRootFileIds(nodes, rootIds, query, nodeScores, maxFiles);
  const files = assembleExploreFiles({
    query,
    storage,
    nodes: assemblyNodes,
    edges,
    callPaths,
    fileScores,
    nodeScores,
    maxFiles,
    maxChars,
    rootFileIds: assemblyRootFileIds,
    changeSurfaceFileIds: new Set(
      changeSurface.map((item) => item.entity.file.id),
    ),
    structuralChangeSurfaceFileIds: new Set(
      changeSurface
        .filter((item) => item.structural)
        .map((item) => item.entity.file.id),
    ),
    dynamicBoundaryFileIds,
    semanticCounterpartFileIds: new Set([
      ...counterpartExpansion.directCounterpartFileIds,
      ...impactCounterparts.fileIds,
      ...moduleEntrypoints.fileIds,
    ]),
    collaboratorFileIds: collaborators.fileIds,
  });
  const visibleFileIds = new Set(files.map((file) => file.file.id));
  const visibleDynamicBoundaries = dynamicBoundaries.filter((boundary) => {
    const source = assemblyNodes.find((node) => node.id === boundary.sourceId);
    return Boolean(source?.entity && visibleFileIds.has(source.entity.file.id));
  });
  const visibleDynamicBoundariesTruncated =
    dynamicBoundariesTruncated ||
    visibleDynamicBoundaries.length < dynamicBoundaries.length;

  if (files.length === 0) {
    return {
      available: true,
      query,
      roots,
      nodes: assemblyNodes,
      edges,
      edgesTruncated,
      callPaths,
      blastRadius,
      changeSurface,
      dynamicBoundaries: visibleDynamicBoundaries,
      dynamicBoundariesTruncated: visibleDynamicBoundariesTruncated,
      files: [],
      emptyReason: "no_context",
    };
  }

  return {
    available: true,
    query,
    roots,
    nodes: assemblyNodes,
    edges,
    edgesTruncated,
    callPaths,
    blastRadius,
    changeSurface,
    dynamicBoundaries: visibleDynamicBoundaries,
    dynamicBoundariesTruncated: visibleDynamicBoundariesTruncated,
    files,
  };
}

/**
 * Pair the strongest retained source symbols with their public declaration
 * file after blast-radius expansion. This is intentionally narrower than
 * normal counterpart discovery: names must match exactly, C-family
 * stem/directory affinity remains mandatory, and only four files can be
 * reserved.
 */
function includeImpactSourceDeclarations(
  impactNodes: readonly ExploreNode[],
  originalNodes: readonly ExploreNode[],
  storage: GraphQueryStorage,
  nodeScores: Map<string, number>,
  limit: number,
): { nodes: ExploreNode[]; fileIds: ReadonlySet<string> } {
  if (limit <= 0) return { nodes: [...impactNodes], fileIds: new Set() };
  const originalIds = new Set(originalNodes.map((node) => node.id));
  const existingIds = new Set(impactNodes.map((node) => node.id));
  const additions: ExploreNode[] = [];
  const fileIds = new Set<string>();
  const candidatesByName = new Map<string, StoredEntity[]>();

  const sources = impactNodes
    .filter((node) => {
      const metadata = node.entity?.entity.metadata;
      return (
        isSourcePath(node.entity?.file.relativePath ?? "") &&
        metadata?.kind === "code" &&
        isCallableSymbolKind(metadata.symbolType ?? "") &&
        Boolean(metadata.symbolName)
      );
    })
    .sort(
      (left, right) =>
        Number(!originalIds.has(right.id)) -
          Number(!originalIds.has(left.id)) ||
        (nodeScores.get(right.id) ?? 0) - (nodeScores.get(left.id) ?? 0) ||
        left.id.localeCompare(right.id),
    )
    .slice(0, 24);

  for (const source of sources) {
    if (additions.length >= limit) break;
    const metadata = source.entity!.entity.metadata;
    if (metadata?.kind !== "code" || !metadata.symbolName) continue;
    const sourcePath = source.entity!.file.relativePath;
    let candidates = candidatesByName.get(metadata.symbolName);
    if (!candidates) {
      candidates = storage.findSymbolsByName(metadata.symbolName, 64);
      candidatesByName.set(metadata.symbolName, candidates);
    }
    for (const candidate of candidates) {
      const candidateMetadata = candidate.entity.metadata;
      if (
        existingIds.has(candidate.entity.id) ||
        !isHeaderPath(candidate.file.relativePath) ||
        !isCounterpartSourcePath(candidate.file.relativePath, sourcePath) ||
        candidateMetadata?.kind !== "code" ||
        candidateMetadata.symbolName !== metadata.symbolName ||
        (candidateMetadata.symbolType !== metadata.symbolType &&
          !isTypeishKind(candidateMetadata.symbolType ?? ""))
      )
        continue;
      existingIds.add(candidate.entity.id);
      fileIds.add(candidate.file.id);
      additions.push({
        id: candidate.entity.id,
        kind: candidateMetadata.symbolType,
        isRoot: false,
        entity: candidate,
      });
      nodeScores.set(
        candidate.entity.id,
        Math.max(0.02, (nodeScores.get(source.id) ?? 0) * 0.45),
      );
      break;
    }
  }
  return {
    nodes:
      additions.length > 0 ? [...impactNodes, ...additions] : [...impactNodes],
    fileIds,
  };
}

function rootSemanticCounterpartNodeIds(
  nodes: readonly ExploreNode[],
  storage: GraphQueryStorage,
  rootIds: readonly string[],
): Set<string> {
  const roots = rootIds
    .map((id) => storage.getEntity(id))
    .filter((entity): entity is StoredEntity => Boolean(entity));
  const result = new Set<string>();
  for (const node of nodes) {
    if (!node.entity || rootIds.includes(node.id)) continue;
    const metadata = node.entity.entity.metadata;
    if (metadata?.kind !== "code") continue;
    if (
      roots.some((root) => {
        const rootMetadata = root.entity.metadata;
        return (
          rootMetadata?.kind === "code" &&
          rootMetadata.symbolName === metadata.symbolName &&
          rootMetadata.scope === metadata.scope &&
          isCounterpartSourcePath(
            root.file.relativePath,
            node.entity!.file.relativePath,
          )
        );
      })
    )
      result.add(node.id);
  }
  return result;
}

/**
 * Explicit member queries describe a module API (`app.listen app.use`). When
 * another production file imports that API's defining file, keep a bounded
 * set of its top-level definitions as the public entrypoint counterpart.
 * IMPORTS is durable evidence; no filename or framework convention is used.
 */
function includeModuleEntrypointNodes(
  nodes: readonly ExploreNode[],
  graph: GraphReader,
  storage: GraphQueryStorage,
  nodeScores: Map<string, number>,
  rootIds: readonly string[],
  query: string,
  limit: number,
): { nodes: ExploreNode[]; fileIds: ReadonlySet<string> } {
  if (!/(?:\.|::|->|#)/.test(query) || limit <= 0)
    return { nodes: [...nodes], fileIds: new Set() };
  const rootFiles = new Set(
    rootIds
      .map((id) => storage.getEntity(id)?.file.id)
      .filter((id): id is string => Boolean(id)),
  );
  const importerFiles = graph
    .expandFileNeighbors([...rootFiles], 16)
    .filter((neighbor) => neighbor.direction === "in")
    .map((neighbor) => neighbor.id);
  const result = [...nodes];
  const seen = new Set(nodes.map((node) => node.id));
  const fileIds = new Set<string>();
  let added = 0;
  for (const fileId of importerFiles) {
    if (added >= limit || fileIds.size >= 2) break;
    let fileAdded = false;
    for (const edge of graph.outgoingEdges([fileId], ["DEFINES"], 32)) {
      const entity = storage.getEntity(edge.dst);
      const metadata = entity?.entity.metadata;
      if (!entity || metadata?.kind !== "code" || seen.has(edge.dst)) continue;
      if (isLowValuePath(entity.file.relativePath)) continue;
      seen.add(edge.dst);
      result.push({
        id: edge.dst,
        kind: metadata.symbolType,
        isRoot: false,
        entity,
      });
      nodeScores.set(edge.dst, Math.max(nodeScores.get(edge.dst) ?? 0, 0.04));
      added += 1;
      fileAdded = true;
      if (added >= limit) break;
    }
    if (fileAdded) fileIds.add(fileId);
  }
  return { nodes: result, fileIds };
}

/**
 * Retrieval seeds provide recall; protected root files consume scarce source
 * slots. For a natural-language query these are deliberately different sets:
 * retain a bounded group of strongest semantic anchors and let RWR decide
 * whether weaker lexical seeds deserve source. Exact symbol families bypass
 * this policy and preserve every declaration/implementation root file.
 */
function primaryConceptualRootFileIds(
  nodes: readonly ExploreNode[],
  rootIds: readonly string[],
  query: string,
  nodeScores: ReadonlyMap<string, number>,
  maxFiles: number,
): Set<string> {
  const roots = new Set(rootIds);
  const terms = queryTerms(query);
  const byFile = new Map<
    string,
    { coveredTerms: Set<string>; score: number; id: string }
  >();
  for (const node of nodes) {
    if (!roots.has(node.id) || !node.entity) continue;
    const metadata = node.entity.entity.metadata;
    const identity = [
      metadata?.kind === "code" ? metadata.symbolName : "",
      metadata?.kind === "code" ? metadata.scope : "",
      node.entity.file.relativePath,
    ].join(" ");
    const candidate = {
      coveredTerms: semanticTermsCovered(identity, terms),
      score: nodeScores.get(node.id) ?? 0,
      id: node.id,
    };
    const existing = byFile.get(node.entity.file.id);
    if (
      !existing ||
      candidate.coveredTerms.size > existing.coveredTerms.size ||
      (candidate.coveredTerms.size === existing.coveredTerms.size &&
        (candidate.score > existing.score ||
          (candidate.score === existing.score && candidate.id < existing.id)))
    )
      byFile.set(node.entity.file.id, candidate);
  }
  // Keep two additional anchors beyond the query's distinct concepts when the
  // file budget permits it. That slot preserves the primary domain type next
  // to its controller/repository/validator collaborators instead of treating
  // lexical concept coverage as a replacement for graph centrality.
  const cap = Math.max(
    2,
    Math.min(6, Math.max(terms.length + 2, 2), maxFiles, byFile.size),
  );
  const remaining = [...byFile];
  const selected = new Set<string>();
  const covered = new Set<string>();
  let postCoverageSlots = 2;
  while (selected.size < cap && remaining.length > 0) {
    if (terms.length > 0 && terms.every((term) => covered.has(term))) {
      if (postCoverageSlots === 0) break;
      postCoverageSlots -= 1;
    }
    remaining.sort((left, right) => {
      const leftGain = [...left[1].coveredTerms].filter(
        (term) => !covered.has(term),
      ).length;
      const rightGain = [...right[1].coveredTerms].filter(
        (term) => !covered.has(term),
      ).length;
      return (
        rightGain - leftGain ||
        right[1].coveredTerms.size - left[1].coveredTerms.size ||
        right[1].score - left[1].score ||
        left[1].id.localeCompare(right[1].id)
      );
    });
    const [fileId, candidate] = remaining.shift()!;
    selected.add(fileId);
    for (const term of candidate.coveredTerms) covered.add(term);
  }
  return selected;
}

/**
 * Extend a conceptual query by one executable collaborator hop from callables
 * already retained in root files. The target must independently match a query
 * term, which keeps this narrower than generic import or dependency expansion.
 */
function includeDirectCallCollaborators(
  nodes: readonly ExploreNode[],
  graph: GraphReader,
  storage: GraphQueryStorage,
  nodeScores: Map<string, number>,
  rootIds: readonly string[],
  query: string,
  limit: number,
): { nodes: ExploreNode[]; fileIds: Set<string> } {
  const terms = queryTerms(query);
  if (limit <= 0 || terms.length === 0)
    return { nodes: [...nodes], fileIds: new Set() };
  const rootFileIds = fileIdsForRoots(nodes, rootIds);
  const sources = nodes
    .filter((node) => {
      const entity = node.entity;
      const metadata = entity?.entity.metadata;
      if (
        !entity ||
        metadata?.kind !== "code" ||
        !rootFileIds.has(entity.file.id) ||
        !isCallableSymbolKind(metadata.symbolType ?? "")
      )
        return false;
      return (
        semanticTermsCovered(
          `${metadata.symbolName ?? ""} ${metadata.scope ?? ""} ${entity.file.relativePath}`,
          terms,
        ).size > 0
      );
    })
    .sort(
      (left, right) =>
        (nodeScores.get(right.id) ?? 0) - (nodeScores.get(left.id) ?? 0) ||
        left.id.localeCompare(right.id),
    )
    .slice(0, 32);
  if (sources.length === 0) return { nodes: [...nodes], fileIds: new Set() };

  const existingIds = new Set(nodes.map((node) => node.id));
  const candidates = graph
    .outgoingEdges(
      sources.map((source) => source.id),
      ["CALLS"],
      Math.min(512, Math.max(64, sources.length * 8)),
    )
    .filter((edge) => !existingIds.has(edge.dst) && edge.confidence >= 0.5)
    .map((edge) => ({ edge, entity: storage.getEntity(edge.dst) }))
    .filter(({ entity }) => {
      const metadata = entity?.entity.metadata;
      if (
        !entity ||
        metadata?.kind !== "code" ||
        rootFileIds.has(entity.file.id) ||
        isLowValuePath(entity.file.relativePath)
      )
        return false;
      return (
        semanticTermsCovered(
          `${metadata.symbolName ?? ""} ${metadata.scope ?? ""} ${entity.file.relativePath}`,
          terms,
        ).size > 0
      );
    })
    .sort(
      (left, right) =>
        (nodeScores.get(right.edge.src) ?? 0) -
          (nodeScores.get(left.edge.src) ?? 0) ||
        right.edge.confidence - left.edge.confidence ||
        left.entity!.file.relativePath.localeCompare(
          right.entity!.file.relativePath,
        ) ||
        left.edge.dst.localeCompare(right.edge.dst),
    );

  const result = [...nodes];
  const fileIds = new Set<string>();
  for (const { edge, entity } of candidates) {
    if (!entity || existingIds.has(edge.dst)) continue;
    if (fileIds.size >= 2 && !fileIds.has(entity.file.id)) continue;
    existingIds.add(edge.dst);
    fileIds.add(entity.file.id);
    const metadata = entity.entity.metadata;
    result.push({
      id: edge.dst,
      kind: metadata?.kind === "code" ? metadata.symbolType : undefined,
      isRoot: false,
      entity,
    });
    nodeScores.set(
      edge.dst,
      Math.max(0.02, (nodeScores.get(edge.src) ?? 0) * 0.65),
    );
    if (result.length - nodes.length >= limit) break;
  }
  return { nodes: result, fileIds };
}

/**
 * Add a small number of declaration/implementation counterpart entities.
 * C/C++ headers commonly have no graph edge to their translation unit; path
 * identity is the durable language-neutral evidence available at query time.
 * Search is bounded by high-ranked files and every result must pass an exact
 * stem plus directory-affinity check.
 */
function includeCounterpartSourceNodes(
  nodes: readonly ExploreNode[],
  graph: GraphReader,
  storage: GraphQueryStorage,
  nodeScores: Map<string, number>,
  rootIds: readonly string[],
  maxFiles: number,
): {
  nodes: ExploreNode[];
  directCounterpartFileIds: ReadonlySet<string>;
  directCounterpartNodeIds: ReadonlySet<string>;
} {
  const existing = new Set(nodes.map((node) => node.id));
  const paths = new Set<string>();
  const additions: ExploreNode[] = [];
  const addedFiles = new Set<string>();
  const maxAdditions = 64;
  const maxCounterpartFiles = Math.min(8, maxFiles);
  const directCounterpartFileIds = new Set<string>();
  const directCounterpartNodeIds = new Set<string>();
  const symbolsByName = new Map<string, StoredEntity[]>();
  const findSymbolsByName = (name: string): StoredEntity[] => {
    const key = name.toLowerCase();
    let entities = symbolsByName.get(key);
    if (!entities) {
      entities = storage.findSymbolsByName(name, 128);
      symbolsByName.set(key, entities);
    }
    return entities;
  };
  const hasCounterpartBudget = (): boolean =>
    additions.length < maxAdditions && addedFiles.size < maxCounterpartFiles;
  const stemCandidatesFor = (
    candidates: readonly ExploreNode[],
  ): ((node: ExploreNode) => readonly StoredEntity[]) => {
    const byStem = storage.findSymbolsByFileStems?.(
      candidates.flatMap((node) => {
        const stem = fileStem(node.entity?.file.relativePath ?? "");
        return stem ? [stem] : [];
      }),
      128,
    );
    return (node) => {
      const stem = fileStem(node.entity?.file.relativePath ?? "");
      if (!stem) return [];
      return (
        byStem?.get(stem.toLowerCase()) ??
        storage.findSymbolsByQuery?.(stem, 128) ??
        []
      );
    };
  };
  const addCandidate = (
    entity: StoredEntity,
    score: number,
    options: {
      direct: boolean;
      scoreFactor: number;
      headerPath?: string;
      directLine?: number;
    },
  ): void => {
    if (
      options.headerPath &&
      !isCounterpartSourcePath(options.headerPath, entity.file.relativePath)
    )
      return;
    const reserve = options.direct && !isHeaderPath(entity.file.relativePath);
    if (existing.has(entity.entity.id)) {
      if (reserve) {
        directCounterpartFileIds.add(entity.file.id);
        directCounterpartNodeIds.add(entity.entity.id);
      }
      return;
    }
    if (
      !addedFiles.has(entity.file.id) &&
      addedFiles.size >= maxCounterpartFiles
    )
      return;
    existing.add(entity.entity.id);
    addedFiles.add(entity.file.id);
    additions.push({
      id: entity.entity.id,
      kind:
        entity.entity.metadata?.kind === "code"
          ? entity.entity.metadata.symbolType
          : undefined,
      isRoot: false,
      entity,
    });
    if (reserve) {
      directCounterpartFileIds.add(entity.file.id);
      directCounterpartNodeIds.add(entity.entity.id);
    }
    const callSiteBoost =
      reserve && options.directLine !== undefined
        ? 0.08 / (1 + options.directLine / 50)
        : 0;
    nodeScores.set(
      entity.entity.id,
      Math.max(0.025, score * options.scoreFactor + callSiteBoost),
    );
  };
  const addCounterpart = (
    entity: StoredEntity,
    headerPath: string,
    score: number,
    direct: boolean,
  ): void => {
    addCandidate(entity, score, {
      direct,
      scoreFactor: 0.35,
      headerPath,
    });
  };
  const addSemanticCounterpart = (
    entity: StoredEntity,
    score: number,
    direct: boolean,
    directLine?: number,
  ): void => {
    addCandidate(entity, score, {
      direct,
      scoreFactor: 0.45,
      directLine,
    });
  };

  // Resolve declaration/definition counterparts by semantic identity before
  // falling back to filename conventions. Public C APIs and internal helpers
  // are commonly declared in a shared header whose stem has no relationship
  // to the implementation file (`uv-common.h` -> `timer.c`). The shared
  // grouping policy already separates unrelated same-name definitions and
  // intentionally joins platform implementation families, so reusing it here
  // keeps Explore consistent with callers/callees seed resolution.
  const directCallTargetLines = new Map<string, number>();
  for (const edge of graph.outgoingEdges(rootIds, ["CALLS"], 256))
    directCallTargetLines.set(
      edge.dst,
      Math.min(
        directCallTargetLines.get(edge.dst) ?? Infinity,
        edge.first_line,
      ),
    );
  const rootAdjacentIds = new Set([
    ...graph
      .incomingEdges(rootIds, ["CALLS", "REFS", "INHERITS"], 256)
      .map((edge) => edge.src),
    ...graph
      .outgoingEdges(rootIds, ["CALLS", "REFS", "INHERITS"], 256)
      .map((edge) => edge.dst),
  ]);
  const rootAdjacentHeaderTypeIds = [...rootAdjacentIds].filter((id) => {
    const entity = storage.getEntity(id);
    const metadata = entity?.entity.metadata;
    return (
      isHeaderPath(entity?.file.relativePath ?? "") &&
      metadata?.kind === "code" &&
      isTypeishKind(metadata.symbolType ?? "")
    );
  });
  const containerVariants = (id: string): string[] => {
    const container = storage.getEntity(id);
    const metadata = container?.entity.metadata;
    const name = metadata?.kind === "code" ? metadata.symbolName : undefined;
    if (!container || !name) return [id];
    const variants = findSymbolsByName(name)
      .filter(
        (entity) =>
          entity.file.id === container.file.id &&
          entity.entity.metadata?.kind === "code" &&
          isTypeishKind(entity.entity.metadata.symbolType ?? ""),
      )
      .map((entity) => entity.entity.id);
    return variants.length > 0 ? variants : [id];
  };
  const rootAdjacentMemberIds = new Set<string>();
  for (const id of rootAdjacentHeaderTypeIds) {
    for (const variant of containerVariants(id))
      for (const member of graph.members(variant))
        rootAdjacentMemberIds.add(member.id);
  }
  const addContainerMemberCounterparts = (
    containerId: string,
    reserve: (entity: StoredEntity) => boolean,
    includeVariants = false,
  ): void => {
    const container = storage.getEntity(containerId);
    const headerPath = container?.file.relativePath;
    if (!headerPath || !isHeaderPath(headerPath)) return;
    const members = [
      ...new Map(
        (includeVariants ? containerVariants(containerId) : [containerId])
          .flatMap((id) => graph.members(id))
          .map((member) => [member.id, member]),
      ).values(),
    ].slice(0, 64);
    for (const member of members) {
      const metadata = storage.getEntity(member.id)?.entity.metadata;
      const name = metadata?.kind === "code" ? metadata.symbolName : undefined;
      if (!name) continue;
      for (const entity of findSymbolsByName(name)) {
        addCounterpart(
          entity,
          headerPath,
          nodeScores.get(containerId) ?? 0,
          reserve(entity),
        );
        if (additions.length >= maxAdditions) return;
      }
    }
  };
  const semanticCandidates = [...nodes]
    .filter(
      (node) =>
        isHeaderPath(node.entity?.file.relativePath ?? "") &&
        isCallableSymbolKind(node.kind),
    )
    .sort(
      (left, right) =>
        Number(directCallTargetLines.has(right.id)) -
          Number(directCallTargetLines.has(left.id)) ||
        (directCallTargetLines.get(left.id) ?? Infinity) -
          (directCallTargetLines.get(right.id) ?? Infinity) ||
        (nodeScores.get(right.id) ?? 0) - (nodeScores.get(left.id) ?? 0) ||
        left.id.localeCompare(right.id),
    )
    .slice(0, 48);
  const semanticGroupsByName = new Map<
    string,
    ReturnType<typeof groupSemanticSymbols>
  >();
  const semanticEntitiesByName = new Map<string, StoredEntity[]>();
  for (const node of semanticCandidates) {
    if (!hasCounterpartBudget()) break;
    const metadata = node.entity?.entity.metadata;
    const name = metadata?.kind === "code" ? metadata.symbolName : undefined;
    if (!name) continue;
    let groups = semanticGroupsByName.get(name);
    if (!groups) {
      const entities = findSymbolsByName(name);
      semanticEntitiesByName.set(name, entities);
      groups = groupSemanticSymbols(entities);
      semanticGroupsByName.set(name, groups);
    }
    const group = groups.find((candidate) =>
      candidate.entities.some((entity) => entity.entity.id === node.id),
    );
    if (group && group.entities.length >= 2)
      for (const entity of group.entities) {
        const reserve =
          directCallTargetLines.has(node.id) ||
          rootAdjacentMemberIds.has(node.id);
        addSemanticCounterpart(
          entity,
          nodeScores.get(node.id) ?? 0,
          reserve,
          directCallTargetLines.get(node.id),
        );
        if (additions.length >= maxAdditions) break;
      }
    if (directCallTargetLines.has(node.id)) {
      for (const entity of platformDeclarationCounterparts(
        node.entity!,
        semanticEntitiesByName.get(name) ?? [],
      )) {
        addSemanticCounterpart(
          entity,
          nodeScores.get(node.id) ?? 0,
          true,
          directCallTargetLines.get(node.id),
        );
        if (additions.length >= maxAdditions) break;
      }
    }
  }

  // Prefer exact member identity. This joins a declaration container to its
  // out-of-line method definitions without inventing a broad filename-only
  // graph relationship. The path check still prevents same-named APIs in
  // unrelated modules from being merged.
  for (const rootId of rootIds) {
    if (additions.length >= maxAdditions) break;
    addContainerMemberCounterparts(rootId, () => true);
  }

  // A directly related header type can be as important as the root itself.
  // Pair its declared members with out-of-line definitions before the
  // filename/FTS fallback, using the same bounded policy as root containers.
  const adjacentHeaderIds = nodes
    .filter((node) => rootAdjacentHeaderTypeIds.includes(node.id))
    .sort(
      (left, right) =>
        (nodeScores.get(right.id) ?? 0) - (nodeScores.get(left.id) ?? 0) ||
        left.id.localeCompare(right.id),
    )
    .map((node) => node.id);
  for (const adjacentId of adjacentHeaderIds.slice(0, 8)) {
    if (additions.length >= maxAdditions) break;
    addContainerMemberCounterparts(
      adjacentId,
      () => directCounterpartFileIds.size < 2,
      true,
    );
  }

  if (!storage.findSymbolsByQuery)
    return {
      nodes: additions.length > 0 ? [...nodes, ...additions] : [...nodes],
      directCounterpartFileIds,
      directCounterpartNodeIds,
    };

  const ranked = [...nodes]
    .filter((node) => isHeaderPath(node.entity?.file.relativePath ?? ""))
    .sort(
      (left, right) =>
        Number(rootAdjacentIds.has(right.id)) -
          Number(rootAdjacentIds.has(left.id)) ||
        (nodeScores.get(right.id) ?? 0) - (nodeScores.get(left.id) ?? 0) ||
        left.id.localeCompare(right.id),
    );
  const rankedCounterparts = ranked
    .filter((node) => {
      const path = node.entity?.file.relativePath;
      if (!path || paths.has(path)) return false;
      const stem = fileStem(path);
      return Boolean(stem);
    })
    .slice(0, 12);
  const forwardStemCandidates = stemCandidatesFor(rankedCounterparts);
  for (const node of ranked) {
    if (paths.size >= 12 || !hasCounterpartBudget()) break;
    const path = node.entity?.file.relativePath;
    if (!path || paths.has(path)) continue;
    paths.add(path);
    const stem = fileStem(path);
    if (!stem) continue;
    for (const entity of forwardStemCandidates(node)) {
      // Reserve at most two of the strongest exact-stem counterparts without
      // allowing incidental headers to consume the complete file budget.
      const reserve =
        rootAdjacentIds.has(node.id) && directCounterpartFileIds.size < 2;
      addCounterpart(entity, path, nodeScores.get(node.id) ?? 0, reserve);
      if (additions.length >= maxAdditions) break;
    }
  }

  // Graph expansion often reaches a service/orchestration implementation
  // before its public declaration. Pair a bounded set of retained source
  // symbols back to a same-stem header using semantic identity and directory
  // affinity. Direct root neighbors rank first; non-adjacent sources still
  // require an exact symbol match (including constructor -> owner type), so
  // filename similarity alone cannot create a counterpart.
  const adjacentSources = nodes
    .filter(
      (node) =>
        rootAdjacentIds.has(node.id) &&
        isSourcePath(node.entity?.file.relativePath ?? ""),
    )
    .sort(
      (left, right) =>
        Number(rootAdjacentIds.has(right.id)) -
          Number(rootAdjacentIds.has(left.id)) ||
        (nodeScores.get(right.id) ?? 0) - (nodeScores.get(left.id) ?? 0) ||
        left.id.localeCompare(right.id),
    )
    .slice(0, 12);
  const reverseStemCandidates = stemCandidatesFor(adjacentSources);
  for (const sourceNode of adjacentSources) {
    if (!hasCounterpartBudget()) break;
    const sourcePath = sourceNode.entity?.file.relativePath;
    const sourceMetadata = sourceNode.entity?.entity.metadata;
    const stem = sourcePath ? fileStem(sourcePath) : "";
    if (!sourcePath || !stem || sourceMetadata?.kind !== "code") continue;
    for (const entity of reverseStemCandidates(sourceNode)) {
      const candidateMetadata = entity.entity.metadata;
      if (
        !isHeaderPath(entity.file.relativePath) ||
        !isCounterpartSourcePath(entity.file.relativePath, sourcePath) ||
        candidateMetadata?.kind !== "code" ||
        candidateMetadata.symbolName !== sourceMetadata.symbolName ||
        candidateMetadata.symbolType !== sourceMetadata.symbolType
      )
        continue;
      addSemanticCounterpart(
        entity,
        nodeScores.get(sourceNode.id) ?? 0,
        directCounterpartFileIds.size < 3,
      );
    }
  }

  return {
    nodes: additions.length > 0 ? [...nodes, ...additions] : [...nodes],
    directCounterpartFileIds,
    directCounterpartNodeIds,
  };
}

function includeCounterpartCallSpine(
  nodes: readonly ExploreNode[],
  graph: GraphReader,
  storage: GraphQueryStorage,
  nodeScores: Map<string, number>,
  counterpartNodeIds: ReadonlySet<string>,
  limit: number,
): ExploreNode[] {
  if (counterpartNodeIds.size === 0 || limit <= 0) return [...nodes];
  const result = [...nodes];
  const seen = new Set(nodes.map((node) => node.id));
  const add = (id: string): boolean => {
    if (seen.has(id)) return false;
    const entity = storage.getEntity(id);
    if (!entity) return false;
    seen.add(id);
    result.push({
      id,
      kind:
        entity.entity.metadata?.kind === "code"
          ? entity.entity.metadata.symbolType
          : undefined,
      isRoot: false,
      entity,
    });
    nodeScores.set(id, Math.max(nodeScores.get(id) ?? 0, 0.02));
    return true;
  };
  let added = 0;
  for (const sourceId of counterpartNodeIds) {
    if (added >= limit) break;
    const sourceFile = storage.getEntity(sourceId)?.file.id;
    const direct = graph
      .outgoingEdges([sourceId], ["CALLS"], 32)
      .sort(
        (left, right) =>
          Number(storage.getEntity(right.dst)?.file.id === sourceFile) -
            Number(storage.getEntity(left.dst)?.file.id === sourceFile) ||
          left.dst.localeCompare(right.dst),
      );
    const directIds: string[] = [];
    for (const edge of direct) {
      directIds.push(edge.dst);
      if (add(edge.dst)) added += 1;
      if (added >= limit) break;
    }
    if (added >= limit || directIds.length === 0) continue;
    for (const edge of graph.outgoingEdges(
      directIds,
      ["CALLS"],
      Math.min(32, limit - added),
    )) {
      if (add(edge.dst)) added += 1;
      if (added >= limit) break;
    }
  }
  return result;
}

function boostDynamicBoundaryFiles(
  fileScores: Map<string, number>,
  nodes: readonly ExploreNode[],
  boundaries: readonly DynamicBoundary[],
  eligibleFileIds: ReadonlySet<string>,
): void {
  const strongest = Math.max(...fileScores.values(), 0);
  if (strongest <= 0) return;
  const nodeFiles = new Map(
    nodes.map((node) => [node.id, node.entity?.file.id] as const),
  );
  const counts = new Map<string, number>();
  for (const boundary of boundaries) {
    const fileId = nodeFiles.get(boundary.sourceId);
    if (!fileId || !eligibleFileIds.has(fileId)) continue;
    counts.set(
      fileId,
      (counts.get(fileId) ?? 0) + (boundary.occurrenceCount ?? 1),
    );
  }
  for (const [fileId, count] of counts) {
    const boost = strongest * Math.min(0.14, 0.06 + count * 0.015);
    fileScores.set(fileId, Math.max(fileScores.get(fileId) ?? 0, boost));
  }
}

function boostImpactFiles(
  fileScores: Map<string, number>,
  fileHits: ReadonlyMap<string, number>,
): void {
  const strongest = Math.max(...fileScores.values(), 0);
  if (strongest <= 0) return;
  for (const [fileId, hits] of fileHits) {
    const floor = strongest * Math.min(0.22, 0.08 + hits * 0.04);
    fileScores.set(fileId, Math.max(fileScores.get(fileId) ?? 0, floor));
  }
}

function adaptiveNodeBudget(rootCount: number): number {
  return Math.min(DEFAULT_MAX_NODES, Math.max(64, rootCount * 16));
}

/** Explore surfaces actionable dispatch choices; raw unknowns remain queryable from the graph. */
function selectDynamicBoundaries(
  boundaries: readonly DynamicBoundary[],
  limit: number,
  nodes: readonly ExploreNode[],
  nodeScores: ReadonlyMap<string, number>,
): DynamicBoundary[] {
  const testNodeIds = new Set(
    nodes
      .filter(
        (node) => node.entity && isTestPath(node.entity.file.relativePath),
      )
      .map((node) => node.id),
  );
  const ordered = [...boundaries].sort(
    (a, b) =>
      Number(testNodeIds.has(a.sourceId)) -
        Number(testNodeIds.has(b.sourceId)) ||
      (nodeScores.get(b.sourceId) ?? 0) - (nodeScores.get(a.sourceId) ?? 0) ||
      a.sourceId.localeCompare(b.sourceId),
  );
  const selected: DynamicBoundary[] = [];
  const selectedByKey = new Map<string, DynamicBoundary>();
  const nodeNames = new Map(
    nodes.map((node) => {
      const metadata = node.entity?.entity.metadata;
      const name = metadata?.kind === "code" ? metadata.symbolName : undefined;
      return [node.id, name ?? node.id] as const;
    }),
  );
  for (const boundary of ordered) {
    if (boundary.candidateDetails.length === 0) continue;
    const candidateKey = boundary.candidateDetails
      .map((candidate) => candidate.displayName ?? candidate.targetId)
      .sort()
      .join("\0");
    const key = `${nodeNames.get(boundary.sourceId) ?? boundary.sourceId}\0${boundary.target.raw}\0${boundary.reason}\0${candidateKey}`;
    const existing = selectedByKey.get(key);
    if (existing) {
      existing.occurrenceCount =
        (existing.occurrenceCount ?? 1) + (boundary.occurrenceCount ?? 1);
      existing.candidatesTruncated ||= boundary.candidatesTruncated;
      continue;
    }
    const aggregated = {
      ...boundary,
      occurrenceCount: boundary.occurrenceCount ?? 1,
    };
    selectedByKey.set(key, aggregated);
    selected.push(aggregated);
    if (selected.length >= limit) break;
  }
  return selected;
}

/**
 * Boundary source is useful context only when it is already near the query
 * spine. Merely discovering a candidate-rich dynamic call must not grant an
 * arbitrary peripheral file protected integration status and displace direct
 * callers, paths, or implementations from a bounded context pack.
 */
function relevantDynamicBoundaryFileIds(
  boundaries: readonly DynamicBoundary[],
  nodes: readonly ExploreNode[],
  nodeScores: ReadonlyMap<string, number>,
  edges: readonly ExploreEdge[],
  rootIds: readonly string[],
): Set<string> {
  if (boundaries.length === 0) return new Set();
  const strongest = Math.max(...nodeScores.values(), 0);
  const roots = new Set(rootIds);
  const rootNeighborhood = new Set(rootIds);
  for (const edge of edges) {
    if (roots.has(edge.src)) rootNeighborhood.add(edge.dst);
    if (roots.has(edge.dst)) rootNeighborhood.add(edge.src);
  }
  const nodesById = new Map(nodes.map((node) => [node.id, node] as const));
  const adjacentOwnerScopes = new Set<string>();
  for (const id of rootNeighborhood) {
    const metadata = nodesById.get(id)?.entity?.entity.metadata;
    if (metadata?.kind !== "code" || !isTypeishKind(metadata.symbolType ?? ""))
      continue;
    if (metadata.symbolName) adjacentOwnerScopes.add(metadata.symbolName);
    if (metadata.scope && metadata.symbolName)
      adjacentOwnerScopes.add(`${metadata.scope}::${metadata.symbolName}`);
  }
  const nodeFiles = new Map(
    nodes.map((node) => [node.id, node.entity?.file.id] as const),
  );
  const scored = boundaries
    .map((boundary) => ({
      fileId: nodeFiles.get(boundary.sourceId),
      sourceId: boundary.sourceId,
      sourceScope: (() => {
        const metadata = nodesById.get(boundary.sourceId)?.entity?.entity
          .metadata;
        return metadata?.kind === "code" ? metadata.scope : null;
      })(),
      // A dispatch site can be central even when its caller has a modest RWR
      // score: interface roots often reach the site through the candidate
      // implementations. Account for both ends of that semantic bridge.
      score: Math.max(
        nodeScores.get(boundary.sourceId) ?? 0,
        ...boundary.candidateDetails.map(
          (candidate) => (nodeScores.get(candidate.targetId) ?? 0) * 0.8,
        ),
      ),
    }))
    .filter(
      (
        item,
      ): item is {
        fileId: string;
        sourceId: string;
        sourceScope: string | null;
        score: number;
      } =>
        Boolean(item.fileId) &&
        (rootNeighborhood.has(item.sourceId) ||
          Boolean(
            item.sourceScope && adjacentOwnerScopes.has(item.sourceScope),
          ) ||
          item.score >= strongest * 0.6),
    );
  const byFile = new Map<string, number>();
  for (const item of scored)
    byFile.set(item.fileId, Math.max(byFile.get(item.fileId) ?? 0, item.score));
  const ranked = [...byFile]
    .map(([fileId, score]) => ({ fileId, score }))
    .sort(
      (left, right) =>
        right.score - left.score || left.fileId.localeCompare(right.fileId),
    );
  return new Set(ranked.slice(0, 2).map((item) => item.fileId));
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
  const rootIds = [...new Set(options.seedIds)]
    .filter((id) => Boolean(storage.getEntity(id)))
    .slice(0, maxNodes);
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
  const hierarchyGlueIds = expandHierarchy(
    graph,
    storage,
    selected,
    rootIds,
    hierarchyBudget,
  );
  glueContainers(
    graph,
    selected,
    rootIds,
    Math.min(DEFAULT_CONTAINER_GLUE_LIMIT, maxNodes),
  );

  // CONTAINS fan-out is usually much larger than the useful context budget.
  // Letting generic BFS consume that edge list makes the selected methods
  // depend on persistence order (and can hide a type's execution entrypoints).
  // Select a bounded, structurally representative member set first, then let
  // the ordinary traversal expand from the type without CONTAINS edges.
  const representativeSelectionEnabled = shouldSelectRepresentativeMembers(
    storage,
    rootIds,
  );
  const representativeMemberIds = representativeSelectionEnabled
    ? glueRepresentativeMembers(
        graph,
        storage,
        selected,
        rootIds,
        Math.max(8, Math.min(32, Math.floor(maxNodes * 0.3))),
      )
    : [];
  const representativeDependencies = glueRepresentativeMemberDependencies(
    graph,
    storage,
    selected,
    representativeMemberIds,
    Math.max(8, Math.min(24, Math.floor(maxNodes * 0.12))),
  );
  const componentDependencies = glueComponentImportDependencies(
    graph,
    storage,
    selected,
    rootIds,
    Math.max(4, Math.min(24, Math.floor(maxNodes * 0.2))),
  );

  const perRootBudget = Math.max(
    8,
    Math.ceil(maxNodes / Math.max(1, rootIds.length)),
  );
  for (const rootId of [...selected.keys()].filter(
    (id) => selected.get(id)?.isRoot,
  )) {
    const rootMetadata = storage.getEntity(rootId)?.entity.metadata;
    const rootKind =
      rootMetadata?.kind === "code" ? rootMetadata.symbolType : undefined;
    // Hierarchy has its own file-diverse budget above. Feeding INHERITS into
    // the generic traversal as well lets high-cardinality interfaces consume
    // the whole node budget before callers and collaborators are considered.
    const traversalKinds = isTypeishKind(rootKind ?? "")
      ? TRAVERSE_EDGE_KINDS.filter(
          (kind) =>
            kind !== "INHERITS" &&
            (!representativeSelectionEnabled || kind !== "CONTAINS"),
        )
      : TRAVERSE_EDGE_KINDS;
    // Preserve structural distance for pruning. GraphReader.traverse returns a
    // flat list, so first materialize depth-1 neighbors explicitly; otherwise
    // deep traversal nodes and direct callers all receive the same priority and
    // the maxNodes cutoff degenerates to ID ordering.
    const direct = graph.traverse(rootId, {
      edgeKinds: traversalKinds,
      direction: "both",
      maxDepth: 1,
      limit: perRootBudget,
      includeStart: true,
    });
    for (const ref of direct) {
      absorb(selected, ref, false, ref.id === rootId ? 0 : 1);
    }
    const walked = graph.traverse(rootId, {
      edgeKinds: traversalKinds,
      // For a precise callable root, two-way deep traversal creates a noisy
      // co-caller fan-out: root -> shared helper <- every unrelated caller.
      // Direct callers are already retained above and by glueCallNeighbors;
      // deeper context should follow the callable's own execution flow.
      direction: isCallableSymbolKind(rootKind) ? "outgoing" : "both",
      maxDepth: traversalDepth,
      limit: perRootBudget,
      includeStart: true,
    });
    for (const ref of walked) {
      absorb(selected, ref, false, ref.id === rootId ? 0 : traversalDepth);
    }
  }

  glueCallNeighbors(graph, storage, selected, rootIds, DEFAULT_GLUE_LIMIT);
  const impactGlueIds = glueImpactNeighbors(
    graph,
    storage,
    selected,
    rootIds,
    DEFAULT_GLUE_LIMIT,
  );

  const pathResult =
    options.includeCallPaths === false
      ? { paths: [], refs: [] }
      : collectCallPaths(
          graph,
          rootIds,
          Math.max(4, traversalDepth * 2),
          DEFAULT_PATH_LIMIT,
        );
  for (const ref of pathResult.refs) absorb(selected, ref, false, 1);
  const callPaths = pathResult.paths;

  const protectedIds = new Set([
    ...rootIds,
    ...representativeMemberIds,
    ...representativeDependencies.slice(0, 12),
    ...callPaths.flatMap((path) => path.nodes),
    ...hierarchyGlueIds,
    ...componentDependencies.slice(0, 8).map((dependency) => dependency.dst),
    // Preserve only a small integration spine. The rest remains subject to
    // the ordinary node budget so high fan-in roots cannot flood Explore.
    ...impactGlueIds.slice(0, Math.min(8, maxNodes - rootIds.length)),
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
  const edges = [
    ...induced.edges,
    ...componentDependencies
      .filter(
        (dependency) =>
          selected.has(dependency.src) && selected.has(dependency.dst),
      )
      .map((dependency): ExploreEdge => ({
        src: dependency.src,
        dst: dependency.dst,
        kind: "REFS",
        rel: "import_binding",
        count: 1,
        firstLine: 0,
        refName: "",
        provenance: "static",
        confidence: 1,
        evidence: "component_import",
      })),
  ];
  return {
    available: true,
    rootIds,
    nodes,
    edges,
    edgesTruncated: induced.truncated,
    callPaths: retainedCallPaths,
    nodeScores: rankExploreNodes(nodes, edges, rootIds, options.seedWeights),
  };
}

/**
 * Component files own their script imports, while Explore starts from the
 * component symbol. Bridge only exact resolved import bindings so Vue/Svelte
 * roots can reach stores, composables and helpers without pulling every
 * symbol from every imported module into the context pack.
 */
function glueComponentImportDependencies(
  graph: GraphReader,
  storage: ExploreSubgraphStorage,
  selected: Map<string, ScoredNode>,
  rootIds: readonly string[],
  limit: number,
): ComponentDependency[] {
  if (!graph.importedSymbols || limit <= 0) return [];
  const componentRoots = rootIds.filter((id) => {
    const metadata = storage.getEntity(id)?.entity.metadata;
    return metadata?.kind === "code" && metadata.symbolType === "component";
  });
  if (componentRoots.length === 0) return [];

  const dependencies: ComponentDependency[] = [];
  const perRootLimit = Math.max(2, Math.ceil(limit / componentRoots.length));
  for (const rootId of componentRoots) {
    const fileId = storage.getEntity(rootId)?.file.id;
    if (!fileId) continue;
    for (const dependency of graph.importedSymbols([fileId], perRootLimit)) {
      if (!storage.getEntity(dependency.id)) continue;
      absorb(selected, dependency, false, 1);
      dependencies.push({ src: rootId, dst: dependency.id });
      if (dependencies.length >= limit) return dependencies;
    }
  }
  return dependencies;
}

function shouldSelectRepresentativeMembers(
  storage: ExploreSubgraphStorage,
  rootIds: readonly string[],
): boolean {
  if (rootIds.length === 0) return false;
  const files = new Set<string>();
  for (const id of rootIds) {
    const entity = storage.getEntity(id);
    const metadata = entity?.entity.metadata;
    if (
      !entity ||
      metadata?.kind !== "code" ||
      !isTypeishKind(metadata.symbolType ?? "")
    )
      return false;
    files.add(entity.file.id);
  }
  // Exact generic families may contain several declaration/impl fragments,
  // but conceptual multi-root queries should not receive a member expansion
  // for every incidental type seed.
  return files.size === 1;
}

function glueRepresentativeMembers(
  graph: GraphReader,
  storage: ExploreSubgraphStorage,
  selected: Map<string, ScoredNode>,
  rootIds: readonly string[],
  limit: number,
): string[] {
  const addedIds: string[] = [];
  const typeRoots = rootIds.filter((id) => {
    const metadata = storage.getEntity(id)?.entity.metadata;
    return (
      metadata?.kind === "code" && isTypeishKind(metadata.symbolType ?? "")
    );
  });
  if (typeRoots.length === 0 || limit <= 0) return addedIds;

  const perRootLimit = Math.max(4, Math.ceil(limit / typeRoots.length));
  for (const rootId of typeRoots) {
    const members = graph.members(rootId);
    if (members.length === 0) continue;
    const memberIds = new Set(members.map((member) => member.id));
    const edgeLimit = Math.min(4_096, Math.max(128, members.length * 8));
    const scores = new Map(
      members.map((member) => {
        const range = storage.getEntity(member.id)?.entity.range;
        const lines =
          range?.kind === "text"
            ? Math.max(1, range.endLine - range.startLine + 1)
            : 1;
        // A small complexity prior keeps orchestration methods competitive
        // with tiny accessors that happen to have hundreds of callers.
        return [member.id, Math.min(24, Math.log2(lines + 1) * 5)];
      }),
    );
    for (const edge of [
      ...graph.incomingEdges(
        [...memberIds],
        ["CALLS", "REFS", "INSTANTIATES"],
        edgeLimit,
      ),
      ...graph.outgoingEdges(
        [...memberIds],
        ["CALLS", "REFS", "INSTANTIATES"],
        edgeLimit,
      ),
    ]) {
      const memberId = memberIds.has(edge.dst)
        ? edge.dst
        : memberIds.has(edge.src)
          ? edge.src
          : null;
      if (!memberId) continue;
      const directionWeight = edge.src === memberId ? 3 : 0.75;
      const kindWeight =
        edge.kind === "INSTANTIATES" ? 4 : edge.kind === "CALLS" ? 3 : 1;
      scores.set(
        memberId,
        (scores.get(memberId) ?? 0) +
          Math.log2(Math.max(1, edge.count) + 1) * directionWeight * kindWeight,
      );
    }
    const ranked = [...members].sort(
      (left, right) =>
        (scores.get(right.id) ?? 0) - (scores.get(left.id) ?? 0) ||
        left.id.localeCompare(right.id),
    );
    // First represent distinct API operations. Dense types often expose many
    // overloads of `toJson`/`fromJson`; allowing those to consume every member
    // slot hides other important entrypoints such as factories and adapters.
    // Exact method queries use their own seed path, so type exploration can
    // safely prefer name diversity and use leftover slots for overloads.
    const representative: typeof ranked = [];
    const memberNames = new Set<string>();
    for (const member of ranked) {
      const name = symbolName(storage, member.id) ?? member.id;
      if (memberNames.has(name)) continue;
      memberNames.add(name);
      representative.push(member);
      if (representative.length >= perRootLimit) break;
    }
    if (representative.length < perRootLimit) {
      const chosen = new Set(representative.map((member) => member.id));
      for (const member of ranked) {
        if (chosen.has(member.id)) continue;
        representative.push(member);
        if (representative.length >= perRootLimit) break;
      }
    }
    for (const member of representative) {
      absorb(selected, member, false, 1);
      addedIds.push(member.id);
    }
  }
  return addedIds;
}

function glueRepresentativeMemberDependencies(
  graph: GraphReader,
  storage: ExploreSubgraphStorage,
  selected: Map<string, ScoredNode>,
  memberIds: readonly string[],
  limit: number,
): string[] {
  if (memberIds.length === 0 || limit <= 0) return [];
  const memberSet = new Set(memberIds);
  // Directional storage queries round-robin their result window by seed, so a
  // single batched read preserves member coverage without N per-member SQL
  // round trips.
  const candidates = graph
    .outgoingEdges(
      memberIds,
      ["INSTANTIATES", "CALLS", "REFS"],
      Math.min(2_048, Math.max(64, memberIds.length * 8)),
    )
    .filter((edge) => !memberSet.has(edge.dst))
    .sort((left, right) => {
      const leftPath = storage.getEntity(left.dst)?.file.relativePath ?? "";
      const rightPath = storage.getEntity(right.dst)?.file.relativePath ?? "";
      const edgePriority = (kind: GraphEdgeKind): number =>
        kind === "INSTANTIATES" ? 0 : kind === "CALLS" ? 1 : 2;
      return (
        edgePriority(left.kind) - edgePriority(right.kind) ||
        Number(isLowValuePath(leftPath)) - Number(isLowValuePath(rightPath)) ||
        leftPath.localeCompare(rightPath) ||
        left.dst.localeCompare(right.dst)
      );
    });
  const added: string[] = [];
  const seen = new Set<string>();
  for (const edge of candidates) {
    if (seen.has(edge.dst)) continue;
    seen.add(edge.dst);
    if (absorb(selected, { id: edge.dst, kind: undefined }, false, 2))
      added.push(edge.dst);
    if (added.length >= limit) break;
  }
  return added;
}

function glueImpactNeighbors(
  graph: GraphReader,
  storage: ExploreSubgraphStorage,
  selected: Map<string, ScoredNode>,
  rootIds: readonly string[],
  limit: number,
): string[] {
  let added = 0;
  const addedIds: string[] = [];
  for (const rootId of rootIds) {
    if (added >= limit) break;
    const metadata = storage.getEntity(rootId)?.entity.metadata;
    const kind = metadata?.kind === "code" ? metadata.symbolType : undefined;
    if (isTypeishKind(kind ?? "")) {
      // The hierarchy stage already owns INHERITS fan-in. Type roots still
      // need their direct consumers: constructors, services and controllers
      // commonly depend on a type through CALLS/REFS/INSTANTIATES. Query those
      // edge kinds explicitly so a high-cardinality interface cannot crowd
      // real integration points out with derived types.
      const remaining = Math.max(1, limit - added);
      const edges = graph.incomingEdges(
        [rootId],
        ["CALLS", "REFS", "INSTANTIATES"],
        Math.min(256, remaining * 8),
      );
      const rootPath = storage.getEntity(rootId)?.file.relativePath ?? "";
      const sources = rankDirectImpactSources(
        edges.map((edge) => ({ id: edge.src })),
        storage,
        rootPath,
      );
      for (const source of sources) {
        if (absorb(selected, source, false, 1)) {
          added += 1;
          addedIds.push(source.id);
        }
        if (added >= limit) break;
      }
      continue;
    }
    // Reverse dependents are ordinary subgraph candidates, not presentation
    // exceptions. Once selected, their real CALLS/REFS/INHERITS edges feed the
    // same RWR and marginal-file ranking as every other node.
    for (const ref of graph.impact(rootId, 2, Math.max(1, limit - added))) {
      if (absorb(selected, ref, false, 2)) {
        added += 1;
        addedIds.push(ref.id);
      }
      if (added >= limit) break;
    }
  }
  return addedIds;
}

function rankDirectImpactSources(
  refs: readonly SymRef[],
  storage: ExploreSubgraphStorage,
  rootPath: string,
): SymRef[] {
  const unique = [...new Map(refs.map((ref) => [ref.id, ref])).values()];
  return unique.sort((left, right) => {
    const leftPath = storage.getEntity(left.id)?.file.relativePath ?? "";
    const rightPath = storage.getEntity(right.id)?.file.relativePath ?? "";
    return (
      Number(isLowValuePath(leftPath)) - Number(isLowValuePath(rightPath)) ||
      semanticPathAffinity(rootPath, rightPath) -
        semanticPathAffinity(rootPath, leftPath) ||
      leftPath.localeCompare(rightPath) ||
      left.id.localeCompare(right.id)
    );
  });
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
  storage: ExploreSubgraphStorage,
  selected: Map<string, ScoredNode>,
  rootIds: readonly string[],
  budget: number,
): string[] {
  let remaining = budget;
  const addedIds: string[] = [];

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
        addedIds.push(ref.id);
      }
    }
    const derivedLimit = Math.min(10, remaining);
    const derived = hierarchySample(
      graph,
      storage,
      rootId,
      "derived",
      derivedLimit,
    );
    for (const ref of derived) {
      if (absorb(selected, ref, false, 1)) {
        remaining -= 1;
        addedIds.push(ref.id);
      }
    }
  }

  // Sibling types: other derived types of the same bases.
  const baseIds = new Set<string>();
  for (const id of [...selected.keys()]) {
    for (const base of graph.hierarchy(id, "bases", 5)) {
      baseIds.add(base.id);
      if (absorb(selected, base, false, 1)) addedIds.push(base.id);
    }
  }
  for (const baseId of baseIds) {
    if (remaining <= 0) {
      break;
    }
    const siblings = hierarchySample(
      graph,
      storage,
      baseId,
      "derived",
      Math.min(12, remaining),
    );
    for (const sib of siblings) {
      if (absorb(selected, sib, false, 2)) {
        remaining -= 1;
        addedIds.push(sib.id);
        if (remaining <= 0) {
          break;
        }
      }
    }
  }
  return addedIds.slice(0, budget);
}

function hierarchySample(
  graph: ExploreHierarchyReader,
  storage: ExploreSubgraphStorage,
  id: string,
  direction: "bases" | "derived",
  limit: number,
): SymRef[] {
  if (limit <= 0) return [];
  if (graph.hierarchyDiverse) {
    const wider = graph.hierarchyDiverse(
      id,
      direction,
      Math.min(512, Math.max(64, limit * 16)),
    );
    const production = wider.filter((ref) => {
      const path = storage.getEntity(ref.id)?.file.relativePath;
      return path ? !isLowValuePath(path) : true;
    });
    return diverseRefsByFile(
      production.length > 0 ? production : wider,
      storage,
      limit,
    );
  }
  // Compatibility fallback for alternate GraphReader implementations. Fetch a
  // bounded wider window, then round-robin by file in the application layer.
  return diverseRefsByFile(
    graph.hierarchy(id, direction, Math.min(512, limit * 32)),
    storage,
    limit,
  );
}

/**
 * Hierarchy queries are ordered for deterministic storage access, not context
 * diversity. Round-robin by file so a header with many sibling declarations
 * cannot consume the entire hierarchy budget before other implementations are
 * considered.
 */
function diverseRefsByFile(
  refs: readonly SymRef[],
  storage: ExploreSubgraphStorage,
  limit: number,
): SymRef[] {
  if (limit <= 0) return [];
  const groups = new Map<string, SymRef[]>();
  for (const ref of refs) {
    const fileId = storage.getEntity(ref.id)?.file.id ?? `unknown:${ref.id}`;
    const group = groups.get(fileId) ?? [];
    group.push(ref);
    groups.set(fileId, group);
  }
  const orderedGroups = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, group]) => group);
  const selected: SymRef[] = [];
  for (let offset = 0; selected.length < limit; offset += 1) {
    let found = false;
    for (const group of orderedGroups) {
      const ref = group[offset];
      if (!ref) continue;
      selected.push(ref);
      found = true;
      if (selected.length >= limit) break;
    }
    if (!found) break;
  }
  return selected;
}

function glueCallNeighbors(
  graph: GraphReader,
  storage: ExploreSubgraphStorage,
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

    // A type's integration points normally call its methods, not the type node
    // itself. Preserve those two-hop callers as candidates so RWR can decide
    // whether they belong in the final context (NeugDB → member ← Service).
    // This mirrors CodeGraph's bidirectional relevant-context expansion; it
    // does not force the caller file into the rendered result.
    const entity = storage.getEntity(rootId);
    const kind =
      entity?.entity.metadata?.kind === "code"
        ? entity.entity.metadata.symbolType
        : "";
    if (!isTypeishKind(kind) || added >= limit) continue;
    const members = graph.members(rootId).slice(0, 64);
    const memberIds = members.map((member) => member.id);
    if (memberIds.length === 0) continue;
    for (const edge of graph.incomingEdges(
      memberIds,
      ["CALLS"],
      Math.max(1, limit - added),
    )) {
      if (absorb(selected, { id: edge.src }, false, 2)) added += 1;
      if (added >= limit) break;
    }
    if (added >= limit) continue;

    // Dynamic dispatch has no concrete CALLS edge by definition. Candidate
    // links still tell us which integration methods may invoke this type's
    // contract, so surface those sources as ordinary RWR candidates.
    const contractNames = new Set(
      members
        .map((member) => symbolName(storage, member.id))
        .filter((name): name is string => Boolean(name)),
    );
    const dispatchTargetIds = new Set(memberIds);
    const derivedTypes = diverseRefsByFile(
      graph.hierarchy(rootId, "derived", 96),
      storage,
      32,
    );
    for (const derived of derivedTypes) {
      for (const member of graph.members(derived.id)) {
        if (contractNames.has(symbolName(storage, member.id) ?? ""))
          dispatchTargetIds.add(member.id);
      }
    }
    const rootPath = entity?.file.relativePath ?? "";
    const dynamicSources = selectRelevantDynamicSources(
      graph.dynamicBoundarySources([...dispatchTargetIds], 256),
      storage,
      rootPath,
      Math.min(8, Math.max(1, limit - added)),
      2,
    );
    for (const source of dynamicSources) {
      if (absorb(selected, source, false, 2)) added += 1;
      if (added >= limit) break;
    }
  }
}

function selectRelevantDynamicSources(
  refs: readonly SymRef[],
  storage: ExploreSubgraphStorage,
  rootPath: string,
  limit: number,
  maxFiles: number,
): SymRef[] {
  const ranked = [...refs].sort((left, right) => {
    const leftPath = storage.getEntity(left.id)?.file.relativePath ?? "";
    const rightPath = storage.getEntity(right.id)?.file.relativePath ?? "";
    return (
      semanticPathAffinity(rootPath, rightPath) -
        semanticPathAffinity(rootPath, leftPath) ||
      leftPath.localeCompare(rightPath) ||
      left.id.localeCompare(right.id)
    );
  });
  const selected: SymRef[] = [];
  const files = new Set<string>();
  for (const ref of ranked) {
    const fileId = storage.getEntity(ref.id)?.file.id;
    if (!fileId) continue;
    if (!files.has(fileId) && files.size >= maxFiles) continue;
    files.add(fileId);
    selected.push(ref);
    if (selected.length >= limit) break;
  }
  return selected;
}

function symbolName(
  storage: ExploreSubgraphStorage,
  id: string,
): string | undefined {
  const metadata = storage.getEntity(id)?.entity.metadata;
  return metadata?.kind === "code"
    ? (metadata.symbolName ?? undefined)
    : undefined;
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

function collectExploreEdges(
  graph: GraphReader,
  selected: Map<string, ScoredNode>,
  limit: number,
): { edges: ExploreEdge[]; truncated: boolean } {
  const ids = [...selected.keys()];
  const result = graph.edges(ids, TRAVERSE_EDGE_KINDS, limit);
  return {
    edges: result.edges.map(toExploreEdge),
    truncated: result.truncated,
  };
}

function toExploreEdge(
  edge: ReturnType<GraphReader["edges"]>["edges"][number],
): ExploreEdge {
  return {
    src: edge.src,
    dst: edge.dst,
    kind: edge.kind,
    rel: edge.rel,
    count: edge.count,
    firstLine: edge.first_line,
    refName: edge.ref_name,
    provenance: edge.provenance ?? "static",
    confidence: edge.confidence ?? 1,
    evidence: edge.evidence,
  };
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
    dynamicBoundaries: [],
    dynamicBoundariesTruncated: false,
    files: [],
    emptyReason,
  };
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}
