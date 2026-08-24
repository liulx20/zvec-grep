import type { Range } from "../../types.js";
import type { GraphReader } from "../types.js";
import { isLowValuePath, isTestPath } from "../path-policy.js";
import type {
  ExploreEdge,
  ExploreCallPath,
  ExploreFileBundle,
  ExploreNode,
  ExploreSymbolSnippet,
} from "./types.js";
import {
  isTypeishKind,
  queryTargetsPath,
  queryTerms,
  semanticTermCoverage,
} from "./policy.js";
import { polymorphicSiblingSkeletonNodeIds } from "./adaptive-sizing.js";
import { isCounterpartSourcePath } from "./counterpart-policy.js";
import { selectExploreFiles } from "./file-selection.js";

export function assembleExploreFiles(input: {
  query: string;
  storage: GraphReader;
  nodes: readonly ExploreNode[];
  edges: readonly ExploreEdge[];
  callPaths: readonly ExploreCallPath[];
  fileScores: Map<string, number>;
  nodeScores: ReadonlyMap<string, number>;
  maxFiles: number;
  maxChars: number;
  rootFileIds: ReadonlySet<string>;
  changeSurfaceFileIds: ReadonlySet<string>;
  structuralChangeSurfaceFileIds: ReadonlySet<string>;
  dynamicBoundaryFileIds: ReadonlySet<string>;
  semanticCounterpartFileIds: ReadonlySet<string>;
  collaboratorFileIds: ReadonlySet<string>;
}): ExploreFileBundle[] {
  const pathNodeIds = new Set(input.callPaths.flatMap((path) => path.nodes));
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

  const allCandidates = [...input.fileScores.entries()].filter(([fileId]) =>
    byFile.has(fileId),
  );
  const allowLowValue =
    /\b(test|tests|testing|spec|verify|docs?|documentation|example|benchmark|vendor|third[- ]party)\b/i.test(
      input.query,
    );
  const productionCandidates = allCandidates.filter(([fileId]) => {
    const path = byFile.get(fileId)?.[0]?.entity?.file.relativePath;
    return path ? !isLowValuePath(path) : false;
  });
  const explicitlyTargetedLowValue = allCandidates.filter(([fileId]) => {
    const path = byFile.get(fileId)?.[0]?.entity?.file.relativePath;
    return path
      ? isLowValuePath(path) &&
          !isTestPath(path) &&
          queryTargetsPath(input.query, path)
      : false;
  });
  const candidates =
    !allowLowValue &&
    productionCandidates.length >= 1 &&
    explicitlyTargetedLowValue.length === 0
      ? productionCandidates
      : !allowLowValue && explicitlyTargetedLowValue.length > 0
        ? [...productionCandidates, ...explicitlyTargetedLowValue]
        : allCandidates;

  const orderedCandidates = candidates.sort((a, b) => {
    const priority = (id: string): number =>
      input.rootFileIds.has(id) ? 0 : 1;
    const priorityDiff = priority(a[0]) - priority(b[0]);
    if (priorityDiff !== 0) return priorityDiff;
    if (b[1] !== a[1]) {
      return b[1] - a[1];
    }
    return a[0].localeCompare(b[0]);
  });
  const pathFileIds = new Set(
    input.nodes
      .filter((node) => pathNodeIds.has(node.id))
      .map((node) => node.entity?.file.id)
      .filter((fileId): fileId is string => Boolean(fileId)),
  );
  const integrationFiles = directIntegrationFiles(
    input.nodes,
    input.edges,
    input.rootFileIds,
  );
  const integrationFileWeights = integrationFiles.weights;
  for (const fileId of input.dynamicBoundaryFileIds)
    integrationFileWeights.set(
      fileId,
      Math.max(1, integrationFileWeights.get(fileId) ?? 0),
    );
  const integrationFileIds = new Set(integrationFileWeights.keys());
  const hierarchyFileIds = representativeHierarchyFileIds(
    orderedCandidates,
    input.nodes,
    input.edges,
    input.rootFileIds,
    Math.min(4, Math.max(1, input.maxFiles - 1)),
  );
  const definitionEvidence = definitionFileEvidence(
    input.nodes,
    input.rootFileIds,
  );
  const definitionFileIds = definitionEvidence.logical;
  const counterpartFileIds = new Set([
    ...definitionEvidence.counterparts,
    ...input.semanticCounterpartFileIds,
  ]);
  const alignedChangeSurfaceFileIds = queryAlignedFileIds(
    byFile,
    input.changeSurfaceFileIds,
    input.query,
  );
  const alignedFileIds = queryAlignedFileIds(
    byFile,
    [...byFile.keys()].filter((fileId) => !input.rootFileIds.has(fileId)),
    input.query,
  );
  const alignedChangeSurfaceWeights = queryAlignmentWeights(
    byFile,
    alignedChangeSurfaceFileIds,
    input.query,
    integrationFileWeights,
  );
  const rankedFileIds = selectExploreFiles({
    ordered: orderedCandidates,
    maxFiles: input.maxFiles,
    rootFileIds: input.rootFileIds,
    changeSurfaceFileIds: input.changeSurfaceFileIds,
    alignedChangeSurfaceFileIds,
    alignedFileIds,
    structuralChangeSurfaceFileIds: input.structuralChangeSurfaceFileIds,
    pathFileIds,
    integrationFileIds,
    hierarchyFileIds,
    counterpartFileIds,
    integrationFileWeights,
    alignedChangeSurfaceWeights,
    entrypointFileIds: integrationFiles.entrypointFileIds,
    collaboratorFileIds: input.collaboratorFileIds,
  }).map((candidate) => candidate.fileId);
  const skeletonNodeIds = polymorphicSiblingSkeletonNodeIds(
    rankedFileIds,
    input.nodes,
    input.edges,
    pathNodeIds,
  );

  if (rankedFileIds.length === 0) {
    return [];
  }

  // Centrality is role-aware: keep the declaration root, prefer its matching
  // implementation unit, then fall back to the strongest integration file.
  const central = new Set<string>();
  for (const fileId of rankedFileIds) {
    if (input.rootFileIds.has(fileId)) central.add(fileId);
  }
  const coCentral =
    rankedFileIds.find((fileId) => counterpartFileIds.has(fileId)) ??
    rankedFileIds.find(
      (fileId) =>
        definitionFileIds.has(fileId) || integrationFileIds.has(fileId),
    );
  if (coCentral && central.size < 2) central.add(coCentral);

  const prepared = rankedFileIds.flatMap((fileId) => {
    const nodes = byFile.get(fileId) ?? [];
    const file = nodes[0]?.entity?.file;
    if (!file) {
      return [];
    }
    const symbols = nodes
      .map((node) => toSymbolSnippet(node))
      .filter((s): s is ExploreSymbolSnippet => s !== null);
    const sourceLines =
      input.storage.readFileText?.(file)?.split(/\r?\n/) ?? null;
    const retained = sourceLines
      ? preferNestedSourceSymbols(symbols)
      : removeContainedSymbols(symbols);
    const ranked = rankSymbols(
      retained,
      input.nodes,
      input.edges,
      input.nodeScores,
      pathNodeIds,
      skeletonNodeIds,
    );
    const clustered = clusterSymbols(ranked);
    return [
      {
        fileId,
        file,
        nodes,
        clustered,
        sourceLines,
      },
    ];
  });
  const capacities = new Map(
    prepared.map(({ fileId, clustered, sourceLines }) => [
      fileId,
      Math.min(
        renderFileText(clustered, input.maxChars, sourceLines).text.length +
          clustered.reduce(
            (count, cluster) => count + cluster.symbols.length,
            0,
          ) *
            64,
        input.maxChars,
        // Large API types often need several representative methods to convey
        // their usable surface. The global maxChars budget is still hard; this
        // only avoids an artificial 7k per-file ceiling leaving budget unused.
        central.has(fileId) ? 9_000 : 4_000,
      ),
    ]),
  );
  const budgets = allocateCharBudgets(
    rankedFileIds,
    central,
    input.maxChars,
    capacities,
  );

  const bundles: ExploreFileBundle[] = [];
  for (const { fileId, file, nodes, clustered, sourceLines } of prepared) {
    const budget =
      budgets.get(fileId) ?? Math.floor(input.maxChars / rankedFileIds.length);
    const rendered = renderFileText(clustered, budget, sourceLines);
    const text = rendered.text;
    if (!text.trim()) {
      continue;
    }
    bundles.push({
      file,
      score: input.fileScores.get(fileId) ?? 0,
      isCentral: central.has(fileId),
      isChangeSurface: input.changeSurfaceFileIds.has(fileId),
      reasons: fileReasons(fileId, nodes, input.edges, input.rootFileIds),
      symbols: rendered.symbols,
      text,
    });
  }
  return bundles;
}

function definitionFileEvidence(
  nodes: readonly ExploreNode[],
  rootFileIds: ReadonlySet<string>,
): { logical: Set<string>; counterparts: Set<string> } {
  const rootNames = new Set(
    nodes
      .filter((node) => node.isRoot)
      .map((node) => node.entity?.entity.metadata)
      .filter((metadata) => metadata?.kind === "code")
      .map((metadata) => metadata.symbolName?.toLowerCase())
      .filter((name): name is string => Boolean(name)),
  );
  const rootPaths = nodes
    .filter((node) => node.isRoot)
    .map((node) => node.entity?.file.relativePath)
    .filter((path): path is string => Boolean(path));
  const logical = new Set<string>();
  const counterparts = new Set<string>();
  for (const node of nodes) {
    const fileId = node.entity?.file.id;
    const metadata = node.entity?.entity.metadata;
    if (!fileId || rootFileIds.has(fileId) || metadata?.kind !== "code")
      continue;
    const scopeParts = (metadata.scope ?? "").toLowerCase().split("::");
    const path = node.entity?.file.relativePath ?? "";
    const counterpart = rootPaths.some((rootPath) =>
      isCounterpartSourcePath(rootPath, path),
    );
    if (counterpart) counterparts.add(fileId);
    if (counterpart || [...rootNames].some((name) => scopeParts.includes(name)))
      logical.add(fileId);
  }
  return { logical, counterparts };
}

function queryAlignedFileIds(
  byFile: ReadonlyMap<string, readonly ExploreNode[]>,
  fileIds: Iterable<string>,
  query: string,
): Set<string> {
  const terms = queryTerms(query);
  if (terms.length < 2) return new Set();
  const aligned = new Set<string>();
  for (const fileId of fileIds) {
    const nodes = byFile.get(fileId) ?? [];
    if (fileSemanticCoverage(nodes, terms) >= 2) aligned.add(fileId);
  }
  return aligned;
}

/**
 * Rank an aligned surface by independent evidence, not PPR alone. Query-term
 * coverage identifies semantic fit, while integration weight distinguishes a
 * runtime collaborator from a passive signature/base type with the same
 * words. The multiplier keeps coverage as the primary tier.
 */
function queryAlignmentWeights(
  byFile: ReadonlyMap<string, readonly ExploreNode[]>,
  fileIds: ReadonlySet<string>,
  query: string,
  integrationWeights: ReadonlyMap<string, number>,
): Map<string, number> {
  const terms = queryTerms(query);
  const weights = new Map<string, number>();
  for (const fileId of fileIds) {
    const nodes = byFile.get(fileId) ?? [];
    weights.set(
      fileId,
      fileSemanticCoverage(nodes, terms) * 100 +
        (integrationWeights.get(fileId) ?? 0),
    );
  }
  return weights;
}

function fileSemanticCoverage(
  nodes: readonly ExploreNode[],
  terms: readonly string[],
): number {
  const identity = nodes
    .flatMap((node) => {
      const metadata = node.entity?.entity.metadata;
      return [
        metadata?.kind === "code" ? metadata.symbolName : "",
        metadata?.kind === "code" ? metadata.scope : "",
        node.entity?.file.relativePath ?? "",
      ];
    })
    .join(" ");
  return semanticTermCoverage(identity, terms);
}

function representativeHierarchyFileIds(
  ordered: readonly [string, number][],
  nodes: readonly ExploreNode[],
  edges: readonly ExploreEdge[],
  rootFileIds: ReadonlySet<string>,
  limit: number,
): Set<string> {
  const nodeFiles = new Map(
    nodes.map((node) => [node.id, node.entity?.file.id] as const),
  );
  const rootIds = new Set(
    nodes.filter((node) => node.isRoot).map((node) => node.id),
  );
  const candidates = new Set<string>();
  const candidatesByRoot = new Map<string, Set<string>>();
  const hierarchy = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.kind !== "INHERITS") continue;
    const src = hierarchy.get(edge.src) ?? new Set<string>();
    const dst = hierarchy.get(edge.dst) ?? new Set<string>();
    src.add(edge.dst);
    dst.add(edge.src);
    hierarchy.set(edge.src, src);
    hierarchy.set(edge.dst, dst);
  }
  for (const rootId of rootIds) {
    const seen = new Set([rootId]);
    let frontier = [rootId];
    const rootCandidates = new Set<string>();
    for (let depth = 0; depth < 2 && frontier.length > 0; depth += 1) {
      const next: string[] = [];
      for (const current of frontier) {
        for (const relatedId of hierarchy.get(current) ?? []) {
          if (seen.has(relatedId)) continue;
          seen.add(relatedId);
          next.push(relatedId);
          const fileId = nodeFiles.get(relatedId);
          if (fileId && !rootFileIds.has(fileId)) {
            candidates.add(fileId);
            rootCandidates.add(fileId);
          }
        }
      }
      frontier = next;
    }
    if (rootCandidates.size > 0) candidatesByRoot.set(rootId, rootCandidates);
  }
  const position = new Map(
    ordered.map(([fileId], index) => [fileId, index] as const),
  );
  const selected = new Set<string>();
  // Give each independently selected hierarchy root one representative before
  // a high-degree root can consume the complete family budget.
  for (const rootId of rootIds) {
    const best = [...(candidatesByRoot.get(rootId) ?? [])]
      .filter((fileId) => !selected.has(fileId))
      .sort(
        (left, right) =>
          (position.get(left) ?? Number.MAX_SAFE_INTEGER) -
            (position.get(right) ?? Number.MAX_SAFE_INTEGER) ||
          left.localeCompare(right),
      )[0];
    if (best) selected.add(best);
    if (selected.size >= limit) return selected;
  }
  for (const [fileId] of ordered) {
    if (!candidates.has(fileId)) continue;
    selected.add(fileId);
    if (selected.size >= limit) break;
  }
  return selected;
}

function directIntegrationFiles(
  nodes: readonly ExploreNode[],
  edges: readonly ExploreEdge[],
  rootFileIds: ReadonlySet<string>,
): {
  weights: Map<string, number>;
  entrypointFileIds: Set<string>;
} {
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  const nodeFiles = new Map(
    nodes.map((node) => [node.id, node.entity?.file.id] as const),
  );
  const roots = new Set(
    nodes.filter((node) => node.isRoot).map((node) => node.id),
  );
  const scopeOwners = rootSemanticOwners(nodes, roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges) {
      if (
        edge.kind === "CONTAINS" &&
        scopeOwners.has(edge.src) &&
        !scopeOwners.has(edge.dst)
      ) {
        scopeOwners.set(edge.dst, scopeOwners.get(edge.src)!);
        changed = true;
      }
    }
  }
  const rootsByFile = new Map<string, Set<string>>();
  const entrypointFileIds = new Set<string>();
  for (const edge of edges) {
    if (!["CALLS", "REFS", "INSTANTIATES"].includes(edge.kind)) continue;
    // Integration points use the root/type scope. Outgoing dependencies are
    // ordinary RWR candidates, but should not receive protected file status.
    const rootOwner = scopeOwners.get(edge.dst);
    if (!rootOwner || scopeOwners.has(edge.src)) continue;
    const fileId = nodeFiles.get(edge.src);
    if (!fileId || rootFileIds.has(fileId)) continue;
    const connectedRoots = rootsByFile.get(fileId) ?? new Set<string>();
    connectedRoots.add(rootOwner);
    rootsByFile.set(fileId, connectedRoots);
    const metadata = nodeById.get(edge.src)?.entity?.entity.metadata;
    const rootMetadata = nodeById.get(rootOwner)?.entity?.entity.metadata;
    if (
      metadata?.kind === "code" &&
      !isTypeishKind(
        rootMetadata?.kind === "code" ? (rootMetadata.symbolType ?? "") : "",
      ) &&
      /^(?:main|__main__|application)$/i.test(metadata.symbolName ?? "")
    )
      entrypointFileIds.add(fileId);
  }
  return {
    weights: new Map(
      [...rootsByFile].map(([fileId, connectedRoots]) => [
        fileId,
        connectedRoots.size,
      ]),
    ),
    entrypointFileIds,
  };
}

/**
 * Treat declaration/implementation counterparts as one root scope before
 * measuring integration files. Otherwise a caller of a source definition is
 * invisible when the selected root is the matching header declaration.
 */
function rootSemanticOwners(
  nodes: readonly ExploreNode[],
  roots: ReadonlySet<string>,
): Map<string, string> {
  const owners = new Map([...roots].map((id) => [id, id]));
  const rootNodes = nodes.filter((node) => roots.has(node.id));
  for (const node of nodes) {
    if (roots.has(node.id) || !node.entity) continue;
    const path = node.entity.file.relativePath;
    const identity = exploreNodeSymbolIdentity(node);
    if (!identity) continue;
    const counterpart = rootNodes.find((root) => {
      const rootIdentity = exploreNodeSymbolIdentity(root);
      return (
        rootIdentity === identity &&
        Boolean(
          root.entity &&
          isCounterpartSourcePath(root.entity.file.relativePath, path),
        )
      );
    });
    if (counterpart) owners.set(node.id, counterpart.id);
  }
  return owners;
}

function exploreNodeSymbolIdentity(node: ExploreNode): string | undefined {
  const metadata = node.entity?.entity.metadata;
  if (metadata?.kind !== "code" || !metadata.symbolName) return undefined;
  return `${metadata.symbolType}\0${metadata.symbolName}`;
}

function preferNestedSourceSymbols(
  symbols: readonly ExploreSymbolSnippet[],
): ExploreSymbolSnippet[] {
  const withoutEnvelopes = symbols.filter((symbol) => {
    if (!ENVELOPE_KINDS.has(symbol.kind ?? "")) return true;
    return !symbols.some(
      (candidate) =>
        candidate.id !== symbol.id &&
        containsRange(symbol.range, candidate.range),
    );
  });
  return removeContainedSymbols(withoutEnvelopes);
}

function fileReasons(
  fileId: string,
  nodes: readonly ExploreNode[],
  edges: readonly ExploreEdge[],
  rootFileIds: ReadonlySet<string>,
): string[] {
  const fileNodes = nodes.filter((node) => node.entity?.file.id === fileId);
  const ids = new Set(fileNodes.map((node) => node.id));
  const reasons: string[] = [];
  const add = (value: string) => {
    if (!reasons.includes(value) && reasons.length < 6) reasons.push(value);
  };
  for (const node of fileNodes) {
    const metadata = node.entity?.entity.metadata;
    const name = metadata?.kind === "code" ? metadata.symbolName : undefined;
    if (!name) continue;
    if (node.isRoot) add(`${name}(root)`);
    else if (
      metadata?.kind === "code" &&
      metadata.scope &&
      !rootFileIds.has(fileId)
    )
      add(`${name}(definition)`);
  }
  const labels: Partial<Record<ExploreEdge["kind"], string>> = {
    CALLS: "calls",
    INHERITS: "inherits",
    REFS: "references",
    INSTANTIATES: "instantiates",
  };
  for (const edge of edges) {
    const id = ids.has(edge.src)
      ? edge.src
      : ids.has(edge.dst)
        ? edge.dst
        : null;
    const label = labels[edge.kind];
    if (!id || !label) continue;
    const node = fileNodes.find((candidate) => candidate.id === id);
    const metadata = node?.entity?.entity.metadata;
    const name = metadata?.kind === "code" ? metadata.symbolName : undefined;
    if (name) add(`${name}(${label})`);
  }
  return reasons;
}

function removeContainedSymbols(
  symbols: readonly ExploreSymbolSnippet[],
): ExploreSymbolSnippet[] {
  const ordered = [...symbols].sort(
    (a, b) =>
      startOffset(a.range) - startOffset(b.range) ||
      endOffset(b.range) - endOffset(a.range),
  );
  const retained: ExploreSymbolSnippet[] = [];
  for (const symbol of ordered) {
    if (retained.some((parent) => containsRange(parent.range, symbol.range)))
      continue;
    retained.push(symbol);
  }
  return retained;
}

function containsRange(parent: Range, child: Range): boolean {
  return (
    parent.kind === "text" &&
    child.kind === "text" &&
    parent.startOffset <= child.startOffset &&
    parent.endOffset >= child.endOffset &&
    (parent.startOffset < child.startOffset ||
      parent.endOffset > child.endOffset)
  );
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
    signature:
      meta?.kind === "code" ? (meta.signature ?? undefined) : undefined,
  };
}

type RankedSymbol = {
  symbol: ExploreSymbolSnippet;
  importance: number;
  score: number;
  focusLines: number[];
  spine: boolean;
  skeleton: boolean;
};

type SymbolCluster = {
  start: number;
  end: number;
  symbols: RankedSymbol[];
  score: number;
  maxImportance: number;
  spine: boolean;
};

function clusterSymbols(symbols: readonly RankedSymbol[]): SymbolCluster[] {
  const ordered = [...symbols].sort(
    (a, b) => startLine(a.symbol.range) - startLine(b.symbol.range),
  );
  const clusters: SymbolCluster[] = [];
  for (const item of ordered) {
    const start = startLine(item.symbol.range);
    const end = endLine(item.symbol.range);
    const current = clusters.at(-1);
    // Stored fragments already contain complete symbol bodies. Merging merely
    // adjacent methods would turn a dense class into one unselectable god-block;
    // only co-located or overlapping fragments belong to the same cluster.
    if (current && start <= current.end) {
      current.end = Math.max(current.end, end);
      current.symbols.push(item);
      current.score += item.score;
      current.maxImportance = Math.max(current.maxImportance, item.importance);
      current.spine ||= item.spine;
    } else {
      clusters.push({
        start,
        end,
        symbols: [item],
        score: item.score,
        maxImportance: item.importance,
        spine: item.spine,
      });
    }
  }
  return clusters;
}

function rankSymbols(
  symbols: readonly ExploreSymbolSnippet[],
  nodes: readonly ExploreNode[],
  edges: readonly ExploreEdge[],
  nodeScores: ReadonlyMap<string, number>,
  pathNodeIds: ReadonlySet<string>,
  skeletonNodeIds: ReadonlySet<string>,
): RankedSymbol[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const fileById = new Map(
    nodes.map((node) => [node.id, node.entity?.file.id ?? ""]),
  );
  return symbols.map((symbol) => {
    const node = nodeById.get(symbol.id);
    const focusLines: number[] = [];
    let importance = 1;
    if (node?.isRoot) importance = 10;
    else if (pathNodeIds.has(symbol.id)) importance = 9;
    let relationScore = 0;
    for (const edge of edges) {
      if (edge.src !== symbol.id && edge.dst !== symbol.id) continue;
      const other = edge.src === symbol.id ? edge.dst : edge.src;
      const crossFile = fileById.get(other) !== fileById.get(symbol.id);
      const kindWeight =
        edge.kind === "CALLS"
          ? 40
          : edge.kind === "INHERITS"
            ? 32
            : edge.kind === "INSTANTIATES"
              ? 24
              : edge.kind === "REFS"
                ? 12
                : 2;
      relationScore += kindWeight * (crossFile ? 2 : 1);
      if (edge.provenance === "static") relationScore += 4;
      if (edge.src === symbol.id && edge.firstLine > 0) {
        focusLines.push(edge.firstLine);
      }
      if (crossFile && edge.kind === "CALLS" && edge.dst === symbol.id)
        importance = Math.max(importance, 6);
      else if (edge.kind !== "CONTAINS") importance = Math.max(importance, 3);
    }
    return {
      symbol,
      importance,
      score:
        importance * 100 +
        relationScore +
        (nodeScores.get(symbol.id) ?? 0) * 100,
      focusLines: [...new Set(focusLines)].sort((a, b) => a - b),
      spine: pathNodeIds.has(symbol.id),
      skeleton: skeletonNodeIds.has(symbol.id),
    };
  });
}

function renderFileText(
  clusters: readonly SymbolCluster[],
  budget: number,
  sourceLines: readonly string[] | null,
): { text: string; symbols: ExploreSymbolSnippet[] } {
  if (budget <= 0 || clusters.length === 0) return { text: "", symbols: [] };
  const gap = "\n\n... (gap) ...\n\n";
  // Rank the complete pool. Previously, finding two high-importance symbols
  // discarded every lower tier before budgeting, which left large context
  // budgets unused and hid useful implementation details from dense files.
  const ranked = [...clusters].sort((a, b) => {
    if (a.spine !== b.spine) return Number(b.spine) - Number(a.spine);
    if (b.maxImportance !== a.maxImportance)
      return b.maxImportance - a.maxImportance;
    if (b.score !== a.score) return b.score - a.score;
    const densityA = a.score / Math.max(1, a.end - a.start + 1);
    const densityB = b.score / Math.max(1, b.end - b.start + 1);
    if (densityB !== densityA) return densityB - densityA;
    return a.end - a.start - (b.end - b.start);
  });
  const chosen = new Set<SymbolCluster>();
  const renderedByCluster = new Map<SymbolCluster, string>();
  let projected = 0;
  for (const cluster of ranked) {
    const remaining = Math.max(
      0,
      budget - projected - (chosen.size ? gap.length : 0),
    );
    if (remaining <= 0) continue;
    // Keep one large symbol from consuming the complete file allowance. Every
    // chosen cluster may still be truncated, so later relevant methods can use
    // the remaining budget instead of being silently skipped.
    const fairShare =
      ranked.length === 1
        ? remaining
        : Math.min(remaining, Math.max(700, Math.floor(budget * 0.38)));
    const block = renderCluster(cluster, fairShare, true, sourceLines);
    if (!block) continue;
    if (chosen.size === 0 || projected + gap.length + block.length <= budget) {
      chosen.add(cluster);
      renderedByCluster.set(cluster, block);
      projected += block.length + (chosen.size > 1 ? gap.length : 0);
    }
  }
  const ordered = [...chosen].sort((a, b) => a.start - b.start);
  const parts: string[] = [];
  const selected: ExploreSymbolSnippet[] = [];
  for (const cluster of ordered) {
    const remaining =
      budget - parts.join(gap).length - (parts.length ? gap.length : 0);
    if (remaining <= 0) break;
    const block = (renderedByCluster.get(cluster) ?? "").slice(0, remaining);
    if (!block) continue;
    parts.push(block);
    selected.push(...cluster.symbols.map((item) => item.symbol));
  }
  return { text: parts.join(gap).slice(0, budget), symbols: selected };
}

function renderCluster(
  cluster: SymbolCluster,
  budget: number,
  allowTruncate: boolean,
  sourceLines: readonly string[] | null,
): string {
  const blocks: string[] = [];
  for (const item of [...cluster.symbols].sort(
    (a, b) => startLine(a.symbol.range) - startLine(b.symbol.range),
  )) {
    const symbol = item.symbol;
    const start = startLine(symbol.range);
    const end = endLine(symbol.range);
    const header = `// ${symbol.kind ?? "sym"} ${symbol.name} L${start}-${end}`;
    const remaining = budget - blocks.join("\n").length - header.length - 2;
    if (remaining <= 8) continue;
    const body = item.skeleton
      ? renderSymbolSkeleton(symbol, remaining)
      : renderSymbolSource(
          symbol,
          remaining,
          item.focusLines,
          allowTruncate && blocks.length === 0,
          sourceLines,
        );
    if (!body) continue;
    const block = `${header}\n${body}`;
    if (
      blocks.length > 0 &&
      blocks.join("\n").length + block.length + 1 > budget
    )
      continue;
    blocks.push(block);
  }
  const rendered = blocks.join("\n").slice(0, budget);
  return allowTruncate && rendered.includes("// ... truncated")
    ? rendered.padEnd(budget)
    : rendered;
}

function renderSymbolSource(
  symbol: ExploreSymbolSnippet,
  budget: number,
  focusLines: readonly number[],
  allowTruncate: boolean,
  sourceLines: readonly string[] | null,
): string {
  const content = sourceForSymbol(symbol, sourceLines);
  const numbered = numberSourceLines(
    content,
    startLine(symbol.range),
    endLine(symbol.range),
  );
  if (numbered.length <= budget) return numbered;
  if (!allowTruncate) return "";

  const lines = content.split(/\r?\n/);
  const focus = focusLines.find(
    (line) => line >= startLine(symbol.range) && line <= endLine(symbol.range),
  );
  const headCount = Math.min(18, Math.max(6, Math.floor(lines.length / 3)));
  const head = numberSourceLines(
    lines.slice(0, headCount).join("\n"),
    startLine(symbol.range),
    startLine(symbol.range) + headCount - 1,
  );
  const focusIndex = focus ? focus - startLine(symbol.range) : lines.length - 1;
  const windowStart = Math.max(headCount, focusIndex - 14);
  const windowEnd = Math.min(lines.length, focusIndex + 15);
  const window = numberSourceLines(
    lines.slice(windowStart, windowEnd).join("\n"),
    startLine(symbol.range) + windowStart,
    startLine(symbol.range) + windowEnd - 1,
  );
  const marker = "\n... (focused call-site window) ...\n";
  const combined = window ? `${head}${marker}${window}` : head;
  if (combined.length <= budget) return combined;
  const truncated = "// ... truncated";
  return `${combined.slice(0, Math.max(0, budget - truncated.length))}${truncated}`.slice(
    0,
    budget,
  );
}

function renderSymbolSkeleton(
  symbol: ExploreSymbolSnippet,
  budget: number,
): string {
  const raw =
    symbol.signature?.trim() || symbol.content.trim().split(/\r?\n/)[0];
  if (!raw || budget <= 0) return "";
  const signature = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .join(" ")
    .replace(/\s*\{.*$/, "")
    .trim();
  const numbered = numberSourceLines(
    signature,
    startLine(symbol.range),
    startLine(symbol.range),
  );
  const marker = "\n// ... implementation body elided (polymorphic sibling)";
  return `${numbered}${marker}`.slice(0, budget);
}

const ENVELOPE_KINDS = new Set([
  "class",
  "struct",
  "interface",
  "trait",
  "protocol",
  "namespace",
  "module",
]);

function sourceForSymbol(
  symbol: ExploreSymbolSnippet,
  sourceLines: readonly string[] | null,
): string {
  if (!sourceLines || ENVELOPE_KINDS.has(symbol.kind ?? "")) {
    return symbol.content.trimEnd();
  }
  const start = Math.max(0, startLine(symbol.range) - 1);
  const end = Math.min(sourceLines.length, endLine(symbol.range));
  if (end <= start) return symbol.content.trimEnd();
  return sourceLines.slice(start, end).join("\n").trimEnd();
}

function numberSourceLines(
  content: string,
  start: number,
  end: number,
): string {
  const lines = content.split(/\r?\n/);
  const width = String(Math.max(end, start + lines.length - 1)).length;
  return lines
    .map((line, index) => `${String(start + index).padStart(width)}  ${line}`)
    .join("\n");
}

function allocateCharBudgets(
  fileIds: readonly string[],
  central: ReadonlySet<string>,
  maxChars: number,
  capacities: ReadonlyMap<string, number>,
): Map<string, number> {
  const budgets = new Map<string, number>();
  if (fileIds.length === 0) {
    return budgets;
  }
  const centralIds = fileIds.filter((id) => central.has(id));
  const otherIds = fileIds.filter((id) => !central.has(id));
  if (centralIds.length === 0 || otherIds.length === 0) {
    for (const id of fileIds) {
      budgets.set(id, Math.floor(maxChars / fileIds.length));
    }
    return redistributeUnusedBudget(fileIds, budgets, capacities, maxChars);
  }
  const centralShare = centralIds.length > 0 ? 0.55 : 0;
  const centralBudget = Math.floor(maxChars * centralShare);
  const otherBudget = maxChars - centralBudget;

  for (const id of centralIds) {
    budgets.set(id, Math.floor(centralBudget / centralIds.length));
  }
  for (const id of otherIds) {
    budgets.set(id, Math.floor(otherBudget / Math.max(1, otherIds.length)));
  }
  return redistributeUnusedBudget(fileIds, budgets, capacities, maxChars);
}

function redistributeUnusedBudget(
  fileIds: readonly string[],
  budgets: Map<string, number>,
  capacities: ReadonlyMap<string, number>,
  maxChars: number,
): Map<string, number> {
  let used = 0;
  for (const id of fileIds) {
    const budget = Math.min(budgets.get(id) ?? 0, capacities.get(id) ?? 0);
    budgets.set(id, budget);
    used += budget;
  }
  let remaining = Math.max(0, maxChars - used);
  while (remaining > 0) {
    const expandable = fileIds.filter(
      (id) => (budgets.get(id) ?? 0) < (capacities.get(id) ?? 0),
    );
    if (expandable.length === 0) break;
    const share = Math.max(1, Math.floor(remaining / expandable.length));
    let added = 0;
    for (const id of expandable) {
      const room = (capacities.get(id) ?? 0) - (budgets.get(id) ?? 0);
      const amount = Math.min(room, share, remaining - added);
      budgets.set(id, (budgets.get(id) ?? 0) + amount);
      added += amount;
      if (added >= remaining) break;
    }
    if (added === 0) break;
    remaining -= added;
  }
  return budgets;
}

function startLine(range: Range): number {
  return range.kind === "text" ? range.startLine : 1;
}

function endLine(range: Range): number {
  return range.kind === "text" ? range.endLine : startLine(range);
}

function startOffset(range: Range): number {
  return range.kind === "text" ? range.startOffset : 0;
}

function endOffset(range: Range): number {
  return range.kind === "text" ? range.endOffset : startOffset(range);
}
