import type { Range } from "../../types.js";
import type { StoredEntity } from "../../storage/index.js";
import type { DynamicBoundary, GraphReader } from "../types.js";
import { isCallableSymbolKind } from "../symbol-kinds.js";
import type {
  ExploreEdge,
  ExploreCallPath,
  ExploreFileBundle,
  ExploreNode,
  ExploreSymbolSnippet,
} from "./types.js";
import { polymorphicSiblingSkeletonNodeIds } from "./adaptive-sizing.js";
import type { ExploreCandidatePool } from "./candidate-pool.js";
import { selectExploreFiles } from "./file-selection.js";
import type { ExploreIntent } from "./intent.js";
import { queryTerms, semanticTermsCovered } from "./policy.js";

export function assembleExploreFiles(input: {
  intent: ExploreIntent;
  storage: GraphReader;
  pool: ExploreCandidatePool;
  edges: readonly ExploreEdge[];
  callPaths: readonly ExploreCallPath[];
  dynamicBoundaries: readonly DynamicBoundary[];
  fileScores: Map<string, number>;
  nodeScores: ReadonlyMap<string, number>;
  maxFiles: number;
  maxChars: number;
  rootFileIds: ReadonlySet<string>;
  query: string;
  structuralBridgeIds: readonly string[];
}): ExploreFileBundle[] {
  const nodes = input.pool.nodes;
  const fileEvidence = input.pool.fileEvidence;
  const callPathNodeIds = new Set(
    input.callPaths.flatMap((path) => path.nodes),
  );
  const pathNodeIds = new Set([
    ...callPathNodeIds,
    ...input.structuralBridgeIds,
  ]);
  const pathPriority = new Map<string, number>();
  for (const [index, path] of input.callPaths.entries())
    for (const id of path.nodes)
      if (!pathPriority.has(id)) pathPriority.set(id, index);
  const terms = queryTerms(input.query);
  const flowFocusLines = collectFlowFocusLines(
    input.callPaths,
    input.edges,
    input.dynamicBoundaries,
    terms,
  );
  const byFile = new Map<string, ExploreNode[]>();
  for (const node of nodes) {
    const file = node.entity?.file;
    if (!file || !input.fileScores.has(file.id)) {
      continue;
    }
    const list = byFile.get(file.id) ?? [];
    list.push(node);
    byFile.set(file.id, list);
  }

  const orderedCandidates = [...input.fileScores.entries()]
    .filter(([fileId]) => byFile.has(fileId))
    .sort((a, b) => {
      if (b[1] !== a[1]) {
        return b[1] - a[1];
      }
      return a[0].localeCompare(b[0]);
    });
  const counterpartFileIds = new Set(input.pool.fileIds("counterpart"));
  const rootCounterpartFileIds = new Set(
    input.pool.fileIds("root_counterpart"),
  );
  const changeSurfaceFileIds = new Set(input.pool.fileIds("change_surface"));
  const rankedFileIds = selectExploreFiles({
    ordered: orderedCandidates,
    maxFiles: input.maxFiles,
    intent: input.intent,
    evidence: fileEvidence,
  }).map((candidate) => candidate.fileId);
  const skeletonNodeIds = polymorphicSiblingSkeletonNodeIds(
    rankedFileIds,
    nodes,
    input.edges,
    callPathNodeIds,
  );

  if (rankedFileIds.length === 0) {
    return [];
  }

  // Centrality is role-aware: keep the declaration root, prefer its matching
  // implementation unit, then fall back to the strongest integration file.
  const central = new Set<string>();
  const rootFileRank = new Map(
    [...input.rootFileIds].map((fileId, index) => [fileId, index]),
  );
  const centralSeeds = rankedFileIds.filter((fileId) =>
    fileEvidence
      .get(fileId)
      ?.has(input.intent === "exact_symbol" ? "root" : "semantic_seed"),
  );
  centralSeeds.sort(
    (left, right) =>
      (rootFileRank.get(left) ?? Number.MAX_SAFE_INTEGER) -
      (rootFileRank.get(right) ?? Number.MAX_SAFE_INTEGER),
  );
  for (const fileId of centralSeeds.slice(
    0,
    input.intent === "concept" ? 1 : 2,
  ))
    central.add(fileId);
  const coCentral =
    rankedFileIds.find(
      (fileId) => !central.has(fileId) && rootCounterpartFileIds.has(fileId),
    ) ??
    rankedFileIds.find(
      (fileId) => !central.has(fileId) && counterpartFileIds.has(fileId),
    ) ??
    rankedFileIds.find(
      (fileId) =>
        !central.has(fileId) &&
        (fileEvidence.get(fileId)?.has("direct_caller") ||
          fileEvidence.get(fileId)?.has("direct_call")),
    ) ??
    rankedFileIds.find(
      (fileId) =>
        !central.has(fileId) && fileEvidence.get(fileId)?.has("integration"),
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
      ? preferNestedSourceSymbols(
          symbols,
          new Set(
            nodes
              .filter((node) => node.isRoot || pathNodeIds.has(node.id))
              .map((node) => node.id),
          ),
          terms,
        )
      : removeContainedSymbols(symbols);
    const ranked = rankSymbols(
      retained,
      input.pool.nodes,
      input.edges,
      input.nodeScores,
      pathNodeIds,
      pathPriority,
      skeletonNodeIds,
      flowFocusLines,
      terms,
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
  const ownerByFile = enclosingOwners(input.storage, prepared);
  const capacities = new Map(
    prepared.map(({ fileId, clustered, sourceLines }) => [
      fileId,
      Math.min(
        renderFileText(
          clustered,
          input.maxChars,
          sourceLines,
          ownerByFile.get(fileId),
        ).text.length +
          clustered.reduce(
            (count, cluster) => count + cluster.symbols.length,
            0,
          ) *
            64,
        input.maxChars,
        // Large API types often need several representative methods to convey
        // their usable surface. The global maxChars budget is still hard; this
        // only avoids an artificial 7k per-file ceiling leaving budget unused.
        central.has(fileId) || fileEvidence.get(fileId)?.has("call_path")
          ? input.intent === "exact_symbol"
            ? rankedFileIds.length === 1
              ? input.maxChars
              : Math.floor(input.maxChars / 2)
            : 9_000
          : 4_000,
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
    const rendered = renderFileText(
      clustered,
      budget,
      sourceLines,
      ownerByFile.get(fileId),
    );
    const text = rendered.text;
    if (!text.trim()) {
      continue;
    }
    bundles.push({
      file,
      score: input.fileScores.get(fileId) ?? 0,
      isCentral: central.has(fileId),
      isChangeSurface: changeSurfaceFileIds.has(fileId),
      reasons: fileReasons(
        fileId,
        nodes,
        rendered.symbols,
        input.edges,
        input.rootFileIds,
      ),
      symbols: rendered.symbols,
      sourceOrigin: sourceLines ? "current_disk" : "indexed_fragment",
      text,
    });
  }
  return bundles;
}

function preferNestedSourceSymbols(
  symbols: readonly ExploreSymbolSnippet[],
  preferredIds: ReadonlySet<string>,
  terms: readonly string[],
): ExploreSymbolSnippet[] {
  const replacements = new Set<string>();
  const replaced = new Set<string>();
  for (const parent of symbols) {
    if (!preferredIds.has(parent.id) || symbolLineCount(parent) < 80) continue;
    const covered = semanticTermsCovered(symbolIdentity(parent), terms);
    const children = symbols.filter(
      (candidate) =>
        candidate.id !== parent.id &&
        containsRange(parent.range, candidate.range) &&
        [...semanticTermsCovered(symbolIdentity(candidate), terms)].some(
          (term) => !covered.has(term),
        ),
    );
    if (children.length === 0) continue;
    replaced.add(parent.id);
    for (const child of children) replacements.add(child.id);
  }
  const withoutEnvelopes = symbols.filter((symbol) => {
    if (replaced.has(symbol.id)) return false;
    const replacedParent = symbols.find(
      (parent) =>
        replaced.has(parent.id) && containsRange(parent.range, symbol.range),
    );
    if (replacedParent) return replacements.has(symbol.id);
    const children = symbols.filter(
      (candidate) =>
        candidate.id !== symbol.id &&
        containsRange(symbol.range, candidate.range),
    );
    if (ENVELOPE_KINDS.has(symbol.kind ?? "")) return children.length === 0;
    return (
      preferredIds.has(symbol.id) ||
      !children.some((candidate) => preferredIds.has(candidate.id))
    );
  });
  return removeContainedSymbols(withoutEnvelopes);
}

function symbolIdentity(symbol: ExploreSymbolSnippet): string {
  return `${symbol.scope ?? ""} ${symbol.name} ${symbol.signature ?? ""}`;
}

function symbolLineCount(symbol: ExploreSymbolSnippet): number {
  return endLine(symbol.range) - startLine(symbol.range) + 1;
}

function fileReasons(
  fileId: string,
  nodes: readonly ExploreNode[],
  renderedSymbols: readonly ExploreSymbolSnippet[],
  edges: readonly ExploreEdge[],
  rootFileIds: ReadonlySet<string>,
): string[] {
  const renderedIds = new Set(renderedSymbols.map((symbol) => symbol.id));
  const fileNodes = nodes.filter(
    (node) => node.entity?.file.id === fileId && renderedIds.has(node.id),
  );
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
    COUNTERPART: "counterpart",
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
    scope: meta?.kind === "code" ? (meta.scope ?? undefined) : undefined,
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
  flowFocus: boolean;
  queryCoverage: number;
  pathPriority: number;
};

type SymbolCluster = {
  start: number;
  end: number;
  symbols: RankedSymbol[];
  score: number;
  maxImportance: number;
  spine: boolean;
  flowFocus: boolean;
  maxQueryCoverage: number;
  minPathPriority: number;
};

const MIN_FOCUSED_EXCERPT_CHARS = 700;

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
      current.maxQueryCoverage = Math.max(
        current.maxQueryCoverage,
        item.queryCoverage,
      );
      current.minPathPriority = Math.min(
        current.minPathPriority,
        item.pathPriority,
      );
      current.spine ||= item.spine;
      current.flowFocus ||= item.flowFocus;
    } else {
      clusters.push({
        start,
        end,
        symbols: [item],
        score: item.score,
        maxImportance: item.importance,
        spine: item.spine,
        flowFocus: item.flowFocus,
        maxQueryCoverage: item.queryCoverage,
        minPathPriority: item.pathPriority,
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
  pathPriority: ReadonlyMap<string, number>,
  skeletonNodeIds: ReadonlySet<string>,
  flowFocusLines: ReadonlyMap<string, readonly number[]>,
  terms: readonly string[],
): RankedSymbol[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const fileById = new Map(
    nodes.map((node) => [node.id, node.entity?.file.id ?? ""]),
  );
  return symbols.map((symbol) => {
    const node = nodeById.get(symbol.id);
    const queryFocusLine = bestQueryFocusLine(symbol, terms);
    const flowLines = flowFocusLines.get(symbol.id) ?? [];
    const edgeFocusLines: number[] = [];
    let importance = 1;
    let directRootFlow = false;
    if (node?.isRoot) importance = 10;
    else if (pathNodeIds.has(symbol.id)) importance = 9;
    let relationScore = 0;
    const queryCoverage = semanticTermsCovered(
      `${symbol.name} ${symbol.signature ?? ""}`,
      terms,
    ).size;
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
        edgeFocusLines.push(edge.firstLine);
      }
      if (crossFile && edge.kind === "CALLS" && edge.dst === symbol.id)
        importance = Math.max(importance, 6);
      else if (edge.kind !== "CONTAINS") importance = Math.max(importance, 3);
      if (
        edge.kind === "REFS" &&
        nodeById.get(other)?.isRoot &&
        !isCallableSymbolKind(symbol.kind ?? "")
      )
        importance = Math.max(importance, 7);
      if (
        edge.dst === symbol.id &&
        nodeById.get(other)?.isRoot &&
        (edge.kind === "CALLS" ||
          (edge.kind === "REFS" && edge.rel === "function"))
      ) {
        directRootFlow = true;
        importance = Math.max(importance, 9);
      }
    }
    return {
      symbol,
      importance,
      score:
        importance * 100 +
        relationScore +
        (nodeScores.get(symbol.id) ?? 0) * 100,
      focusLines: rankFocusLines(
        symbol,
        flowLines,
        queryFocusLine,
        edgeFocusLines,
        terms,
      ),
      spine: pathNodeIds.has(symbol.id) || directRootFlow,
      skeleton: skeletonNodeIds.has(symbol.id),
      flowFocus: flowFocusLines.has(symbol.id),
      queryCoverage,
      pathPriority: pathPriority.get(symbol.id) ?? Number.POSITIVE_INFINITY,
    };
  });
}

function rankFocusLines(
  symbol: ExploreSymbolSnippet,
  flowLines: readonly number[],
  queryLine: number | undefined,
  edgeLines: readonly number[],
  terms: readonly string[],
): number[] {
  const content = symbol.content.split(/\r?\n/);
  const firstLine = startLine(symbol.range);
  const concepts = (line: number) => {
    const index = line - firstLine;
    return semanticTermsCovered(
      content
        .slice(Math.max(0, index - 2), Math.min(content.length, index + 3))
        .join(" "),
      terms,
    );
  };
  const flow = new Set(flowLines);
  const ordered: number[] = [];
  const covered = new Set<string>();
  const candidates = [
    ...new Set([...flowLines, ...edgeLines, ...(queryLine ? [queryLine] : [])]),
  ];
  while (candidates.length > 0) {
    candidates.sort((left, right) => {
      const leftTerms = concepts(left);
      const rightTerms = concepts(right);
      const leftNovel = [...leftTerms].filter(
        (term) => !covered.has(term),
      ).length;
      const rightNovel = [...rightTerms].filter(
        (term) => !covered.has(term),
      ).length;
      return (
        rightNovel - leftNovel ||
        rightTerms.size - leftTerms.size ||
        Number(right === queryLine) - Number(left === queryLine) ||
        Number(flow.has(right)) - Number(flow.has(left)) ||
        left - right
      );
    });
    const line = candidates.shift()!;
    ordered.push(line);
    for (const term of concepts(line)) covered.add(term);
  }
  return ordered;
}

function bestQueryFocusLine(
  symbol: ExploreSymbolSnippet,
  terms: readonly string[],
): number | undefined {
  const rows = symbol.content.split(/\r?\n/).map((line, index) => ({
    index,
    terms: semanticTermsCovered(line, terms),
  }));
  const frequency = new Map<string, number>();
  for (const row of rows)
    for (const term of row.terms)
      frequency.set(term, (frequency.get(term) ?? 0) + 1);
  const best = rows
    .filter((row) => row.terms.size > 0)
    .map((row) => ({
      ...row,
      score: [...row.terms].reduce(
        (sum, term) => sum + 1 / (frequency.get(term) ?? 1),
        0,
      ),
    }))
    .sort(
      (left, right) =>
        right.terms.size - left.terms.size ||
        right.score - left.score ||
        left.index - right.index,
    )[0];
  return best ? startLine(symbol.range) + best.index : undefined;
}

function collectFlowFocusLines(
  paths: readonly ExploreCallPath[],
  edges: readonly ExploreEdge[],
  boundaries: readonly DynamicBoundary[],
  terms: readonly string[],
): Map<string, number[]> {
  const transitions = new Set<string>();
  for (const path of paths)
    for (let index = 0; index < path.nodes.length; index += 1) {
      if (index + 1 >= path.nodes.length) continue;
      transitions.add(`${path.nodes[index]}\0${path.nodes[index + 1]}`);
    }
  const lines = new Map<string, number[]>();
  const add = (id: string, line: number | undefined) => {
    if (!line || line <= 0) return;
    const values = lines.get(id) ?? [];
    if (!values.includes(line)) values.push(line);
    lines.set(id, values);
  };
  for (const edge of edges)
    if (transitions.has(`${edge.src}\0${edge.dst}`))
      add(edge.src, edge.firstLine);
  for (const boundary of [...boundaries].sort(
    (left, right) =>
      semanticTermsCovered(right.target.raw, terms).size -
        semanticTermsCovered(left.target.raw, terms).size ||
      Number(right.candidateDetails.length > 0) -
        Number(left.candidateDetails.length > 0) ||
      (left.line ?? Number.MAX_SAFE_INTEGER) -
        (right.line ?? Number.MAX_SAFE_INTEGER),
  ))
    add(boundary.sourceId, boundary.line);
  return lines;
}

function enclosingOwners(
  storage: GraphReader,
  files: readonly {
    fileId: string;
    clustered: readonly SymbolCluster[];
  }[],
): Map<string, StoredEntity> {
  const fileBySymbol = new Map<string, string>();
  for (const file of files) {
    const representative = file.clustered
      .flatMap((cluster) => cluster.symbols)
      .filter(({ symbol }) => Boolean(symbol.scope))
      .sort((left, right) => right.score - left.score)[0]?.symbol;
    if (representative) fileBySymbol.set(representative.id, file.fileId);
  }
  const owners = new Map<string, StoredEntity>();
  for (const neighbor of storage.expandContainers(
    [...fileBySymbol.keys()],
    1,
  )) {
    const fileId = fileBySymbol.get(neighbor.sid);
    const owner = storage.getEntity(neighbor.parent_id);
    if (fileId && owner?.file.id === fileId) owners.set(fileId, owner);
  }
  return owners;
}

function renderFileText(
  clusters: readonly SymbolCluster[],
  budget: number,
  sourceLines: readonly string[] | null,
  owner?: StoredEntity,
): { text: string; symbols: ExploreSymbolSnippet[] } {
  if (budget <= 0 || clusters.length === 0) return { text: "", symbols: [] };
  const gap = "\n\n... (gap) ...\n\n";
  // Rank the complete pool. Previously, finding two high-importance symbols
  // discarded every lower tier before budgeting, which left large context
  // budgets unused and hid useful implementation details from dense files.
  const ranked = [...clusters].sort((a, b) => {
    const rootDifference =
      Number(b.maxImportance >= 10) - Number(a.maxImportance >= 10);
    if (rootDifference !== 0) return rootDifference;
    if (a.spine !== b.spine) return Number(b.spine) - Number(a.spine);
    if (a.minPathPriority !== b.minPathPriority)
      return a.minPathPriority - b.minPathPriority;
    if (b.maxQueryCoverage !== a.maxQueryCoverage)
      return b.maxQueryCoverage - a.maxQueryCoverage;
    if (b.maxImportance !== a.maxImportance)
      return b.maxImportance - a.maxImportance;
    if (b.score !== a.score) return b.score - a.score;
    const densityA = a.score / Math.max(1, a.end - a.start + 1);
    const densityB = b.score / Math.max(1, b.end - b.start + 1);
    if (densityB !== densityA) return densityB - densityA;
    return a.end - a.start - (b.end - b.start);
  });
  const completeBlocks = new Map(
    ranked.map((cluster) => [
      cluster,
      cluster.symbols.length === 1
        ? renderCluster(cluster, budget, false, sourceLines)
        : "",
    ]),
  );
  const ownerContext = renderOwnerContext(owner, sourceLines, budget);
  const chosen = new Set<SymbolCluster>();
  const renderedByCluster = new Map<SymbolCluster, string>();
  let projected = ownerContext.length;
  for (const [index, cluster] of ranked.entries()) {
    const remaining = Math.max(
      0,
      budget - projected - (chosen.size || ownerContext ? gap.length : 0),
    );
    if (remaining <= 0) continue;
    const complete = completeBlocks.get(cluster) ?? "";
    const reserve =
      !complete || complete.length > remaining
        ? laterCompleteBodyCost(
            ranked,
            completeBlocks,
            index,
            remaining,
            gap.length,
            cluster.maxImportance,
          )
        : 0;
    const block =
      complete && complete.length <= remaining
        ? complete
        : renderCluster(cluster, remaining - reserve, true, sourceLines);
    if (!block) continue;
    if (chosen.size === 0 || projected + gap.length + block.length <= budget) {
      chosen.add(cluster);
      renderedByCluster.set(cluster, block);
      projected +=
        block.length + (chosen.size > 1 || ownerContext ? gap.length : 0);
    }
  }
  const ordered = [...chosen];
  const parts: string[] = ownerContext ? [ownerContext] : [];
  const selected: ExploreSymbolSnippet[] = [];
  for (const cluster of ordered) {
    const remaining =
      budget - parts.join(gap).length - (parts.length ? gap.length : 0);
    if (remaining <= 0) break;
    const block = truncateSource(
      renderedByCluster.get(cluster) ?? "",
      remaining,
    );
    if (!block) continue;
    parts.push(block);
    selected.push(...cluster.symbols.map((item) => item.symbol));
  }
  return { text: parts.join(gap), symbols: selected };
}

function renderOwnerContext(
  owner: StoredEntity | undefined,
  sourceLines: readonly string[] | null,
  budget: number,
): string {
  if (!owner || !sourceLines || budget < 80) return "";
  const line = startLine(owner.entity.range) - 1;
  const start = leadingAnnotationStart(sourceLines, line);
  let end = line + 1;
  while (end < Math.min(sourceLines.length, line + 5)) {
    const declaration = sourceLines.slice(line, end).join("\n");
    if (declaration.includes("{") || declaration.trimEnd().endsWith(":")) break;
    end += 1;
  }
  const annotations = sourceLines.slice(start, line);
  const declaration = sourceLines.slice(line, end).join("\n");
  const brace = declaration.indexOf("{");
  const headerSource = [
    ...annotations,
    brace >= 0 ? declaration.slice(0, brace + 1) : declaration,
  ].join("\n");
  const metadata = owner.entity.metadata;
  const name = metadata?.kind === "code" ? metadata.symbolName : "container";
  const header = `// enclosing ${name} L${start + 1}-${end}`;
  const source = numberSourceLines(headerSource, start + 1, end);
  return truncateSource(`${header}\n${source}`, Math.min(700, budget));
}

function laterCompleteBodyCost(
  ranked: readonly SymbolCluster[],
  completeBlocks: ReadonlyMap<SymbolCluster, string>,
  index: number,
  remaining: number,
  gapLength: number,
  currentImportance: number,
): number {
  for (const candidate of ranked.slice(index + 1)) {
    if (candidate.maxImportance < currentImportance) continue;
    const cost = (completeBlocks.get(candidate)?.length ?? 0) + gapLength;
    if (cost > gapLength && cost + MIN_FOCUSED_EXCERPT_CHARS <= remaining)
      return cost;
  }
  return 0;
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
    const label =
      symbol.scope && symbol.scope !== symbol.name
        ? `${symbol.scope}::${symbol.name}`
        : symbol.name;
    const header = `// ${symbol.kind ?? "sym"} ${label} L${start}-${end}`;
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
  return blocks.join("\n");
}

function renderSymbolSource(
  symbol: ExploreSymbolSnippet,
  budget: number,
  focusLines: readonly number[],
  allowTruncate: boolean,
  sourceLines: readonly string[] | null,
): string {
  const source = sourceForSymbol(symbol, sourceLines);
  const content = source.text;
  const numbered = numberSourceLines(
    content,
    source.startLine,
    endLine(symbol.range),
  );
  if (numbered.length <= budget) return numbered;
  if (!allowTruncate) return "";

  const lines = content.split(/\r?\n/);
  const symbolStart = source.startLine;
  const hasFocusedCall = focusLines.some(
    (line) => line >= symbolStart && line <= endLine(symbol.range),
  );
  const headCount = Math.min(
    hasFocusedCall ? 24 : 18,
    Math.max(hasFocusedCall ? 8 : 6, Math.floor(lines.length / 3)),
  );
  const head = numberSourceLines(
    lines.slice(0, headCount).join("\n"),
    symbolStart,
    symbolStart + headCount - 1,
  );
  const marker = "\n... (focused call-site window) ...\n";
  const windows: Array<{ start: number; end: number }> = [];
  const focusIndexes = focusLines
    .filter((line) => line >= symbolStart && line <= endLine(symbol.range))
    .map((line) => line - symbolStart)
    .filter((index) => index >= headCount);
  const indexes =
    focusIndexes.length > 0
      ? [...new Set([...focusIndexes, lines.length - 1])]
      : [lines.length - 1];
  for (const index of indexes) {
    const contextBefore = index === lines.length - 1 ? 10 : 8;
    const start = Math.max(headCount, index - contextBefore);
    const end = Math.min(lines.length, index + 12);
    if (windows.some((window) => start < window.end && end > window.start))
      continue;
    windows.push({ start, end });
  }
  const excerpts: Array<{ start: number; text: string }> = [];
  let remaining = budget - head.length;
  for (const window of windows) {
    const block = numberSourceLines(
      lines.slice(window.start, window.end).join("\n"),
      symbolStart + window.start,
      symbolStart + window.end - 1,
    );
    if (remaining <= marker.length) break;
    const excerpt =
      window.end === lines.length
        ? sourceSuffix(block, remaining - marker.length)
        : sourcePrefix(block, remaining - marker.length);
    if (!excerpt) break;
    excerpts.push({ start: window.start, text: excerpt });
    remaining -= marker.length + excerpt.length;
    if (excerpt.length < block.length) break;
  }
  excerpts.sort((left, right) => left.start - right.start);
  return truncateSource(
    [head, ...excerpts.map((excerpt) => excerpt.text)].join(marker),
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
  const rendered = `${numbered}${marker}`;
  return rendered.length <= budget
    ? rendered
    : truncateSource(numbered, budget, marker);
}

function sourcePrefix(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const prefix = text.slice(0, budget);
  const newline = prefix.lastIndexOf("\n");
  return (newline > 0 ? prefix.slice(0, newline) : "").trimEnd();
}

function sourceSuffix(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const suffix = text.slice(-budget);
  const newline = suffix.indexOf("\n");
  return (newline >= 0 ? suffix.slice(newline + 1) : "").trimStart();
}

function truncateSource(
  text: string,
  budget: number,
  marker = "\n// ... truncated",
): string {
  if (text.length <= budget) return text;
  if (budget <= marker.length) return marker.slice(0, budget);
  const prefix = sourcePrefix(text, budget - marker.length);
  return `${prefix}${marker}`;
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
): { text: string; startLine: number } {
  const symbolStartLine = startLine(symbol.range);
  if (!sourceLines || ENVELOPE_KINDS.has(symbol.kind ?? "")) {
    return { text: symbol.content.trimEnd(), startLine: symbolStartLine };
  }
  const start = leadingAnnotationStart(sourceLines, symbolStartLine - 1);
  const end = Math.min(sourceLines.length, endLine(symbol.range));
  if (end <= start)
    return { text: symbol.content.trimEnd(), startLine: symbolStartLine };
  return {
    text: sourceLines.slice(start, end).join("\n").trimEnd(),
    startLine: start + 1,
  };
}

function leadingAnnotationStart(
  lines: readonly string[],
  declarationIndex: number,
): number {
  let start = declarationIndex;
  while (start > 0) {
    let balance = 0;
    let annotation = -1;
    for (let cursor = start - 1; cursor >= Math.max(0, start - 12); cursor--) {
      const line = lines[cursor].trim();
      balance +=
        (line.match(/[)\]}]/g)?.length ?? 0) -
        (line.match(/[([{]/g)?.length ?? 0);
      if (line.startsWith("@") && balance <= 0) {
        annotation = cursor;
        break;
      }
      if (balance <= 0) break;
    }
    if (annotation < 0) break;
    start = annotation;
  }
  return start;
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
