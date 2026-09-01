import type { Range } from "../../types.js";
import type { StoredEntity } from "../../storage/index.js";
import type { GraphReader } from "../types.js";
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
import {
  selectExploreFiles,
  type SelectedExploreFile,
} from "./file-selection.js";
import type { ExploreIntent } from "./intent.js";
import { queryTerms, semanticTermsCovered } from "./policy.js";
import { sourceFocusLines, type SourceFocus } from "./source-focus.js";
import {
  allocateCharBudgets,
  clusterSymbols,
  endLine,
  endOffset,
  ENVELOPE_KINDS,
  renderFileText,
  startLine,
  startOffset,
  type RankedSymbol,
  type SymbolCluster,
} from "./source-renderer.js";

export function assembleExploreFiles(input: {
  intent: ExploreIntent;
  storage: GraphReader;
  pool: ExploreCandidatePool;
  edges: readonly ExploreEdge[];
  callPaths: readonly ExploreCallPath[];
  sourceFocus: readonly SourceFocus[];
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
  const flowFocusLines = sourceFocusLines(input.sourceFocus);
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
  const changeSurfaceFileIds = new Set(input.pool.fileIds("change_surface"));
  const selectedFiles = selectExploreFiles({
    ordered: orderedCandidates,
    maxFiles: input.maxFiles,
    intent: input.intent,
    evidence: fileEvidence,
    rootFileIds: [...input.rootFileIds],
  });
  const rankedFileIds = selectedFiles.map((candidate) => candidate.fileId);
  const skeletonNodeIds = polymorphicSiblingSkeletonNodeIds(
    rankedFileIds,
    nodes,
    input.edges,
    callPathNodeIds,
  );

  if (rankedFileIds.length === 0) {
    return [];
  }

  const central = new Set(
    selectedFiles
      .filter((candidate) => candidate.role === "central")
      .map((candidate) => candidate.fileId),
  );
  const prepared = selectedFiles.flatMap((selection) => {
    const file = prepareExploreFile({
      selection,
      nodes: byFile.get(selection.fileId) ?? [],
      storage: input.storage,
      allNodes: input.pool.nodes,
      edges: input.edges,
      nodeScores: input.nodeScores,
      pathNodeIds,
      pathPriority,
      skeletonNodeIds,
      flowFocusLines,
      terms,
    });
    return file ? [file] : [];
  });
  const ownerByFile = enclosingOwners(input.storage, prepared);
  const plans = prepared.map((file) =>
    createRenderPlan(file, ownerByFile.get(file.fileId)),
  );
  const capacities = new Map(
    plans.map((plan) => [
      plan.fileId,
      fileRenderCapacity(
        plan,
        input.intent,
        rankedFileIds.length,
        input.maxChars,
      ),
    ]),
  );
  const budgets = allocateCharBudgets(
    rankedFileIds,
    central,
    input.maxChars,
    capacities,
  );
  const renderedPlans = plans.map((plan) => ({
    plan,
    rendered: plan.render(budgets.get(plan.fileId) ?? 0),
  }));

  const bundles: ExploreFileBundle[] = [];
  for (const { plan, rendered } of renderedPlans) {
    const { fileId, file, nodes, sourceLines, selection } = plan;
    const text = rendered.text;
    if (!text.trim()) {
      continue;
    }
    bundles.push({
      file,
      score: input.fileScores.get(fileId) ?? 0,
      isCentral: selection.role === "central",
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

type PreparedExploreFile = {
  selection: SelectedExploreFile;
  fileId: string;
  file: StoredEntity["file"];
  nodes: readonly ExploreNode[];
  clustered: readonly SymbolCluster[];
  sourceLines: readonly string[] | null;
};

type ExploreRenderPlan = PreparedExploreFile & {
  render: (budget: number) => ReturnType<typeof renderFileText>;
};

function prepareExploreFile(input: {
  selection: SelectedExploreFile;
  nodes: readonly ExploreNode[];
  storage: GraphReader;
  allNodes: readonly ExploreNode[];
  edges: readonly ExploreEdge[];
  nodeScores: ReadonlyMap<string, number>;
  pathNodeIds: ReadonlySet<string>;
  pathPriority: ReadonlyMap<string, number>;
  skeletonNodeIds: ReadonlySet<string>;
  flowFocusLines: ReadonlyMap<string, readonly number[]>;
  terms: readonly string[];
}): PreparedExploreFile | null {
  const file = input.nodes[0]?.entity?.file;
  if (!file) return null;

  const sourceText = input.storage.readFileText?.(file);
  const sourceLines = sourceText == null ? null : sourceText.split(/\r?\n/);
  const symbols = input.nodes
    .map((node) => toSymbolSnippet(node))
    .filter((symbol): symbol is ExploreSymbolSnippet => symbol !== null);
  const preferredIds = new Set(
    input.nodes
      .filter((node) => node.isRoot || input.pathNodeIds.has(node.id))
      .map((node) => node.id),
  );
  const retained = sourceLines
    ? preferNestedSourceSymbols(symbols, preferredIds, input.terms)
    : removeContainedSymbols(symbols);
  const ranked = rankSymbols(
    retained,
    input.allNodes,
    input.edges,
    input.nodeScores,
    input.pathNodeIds,
    input.pathPriority,
    input.skeletonNodeIds,
    input.flowFocusLines,
    input.terms,
  );
  return {
    selection: input.selection,
    fileId: input.selection.fileId,
    file,
    nodes: input.nodes,
    clustered: clusterSymbols(ranked),
    sourceLines,
  };
}

function fileRenderCapacity(
  plan: ExploreRenderPlan,
  intent: ExploreIntent,
  fileCount: number,
  maxChars: number,
): number {
  const renderedChars =
    plan.render(maxChars).text.length +
    plan.clustered.reduce(
      (count, cluster) => count + cluster.symbols.length,
      0,
    ) *
      64;
  if (
    plan.selection.role === "supporting" &&
    !plan.selection.evidence.has("call_path")
  )
    return Math.min(renderedChars, maxChars, 4_000);
  if (intent === "concept") return Math.min(renderedChars, maxChars, 9_000);
  return Math.min(
    renderedChars,
    maxChars,
    fileCount === 1 ? maxChars : Math.floor(maxChars / 2),
  );
}

function createRenderPlan(
  file: PreparedExploreFile,
  owner: StoredEntity | undefined,
): ExploreRenderPlan {
  const cache = new Map<number, ReturnType<typeof renderFileText>>();
  return {
    ...file,
    render(budget) {
      const bounded = Math.max(0, budget);
      const cached = cache.get(bounded);
      if (cached) return cached;
      const rendered = renderFileText(
        file.clustered,
        bounded,
        file.sourceLines,
        owner,
      );
      cache.set(bounded, rendered);
      return rendered;
    },
  };
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

function enclosingOwners(
  storage: GraphReader,
  files: readonly {
    fileId: string;
    nodes: readonly ExploreNode[];
    clustered: readonly SymbolCluster[];
  }[],
): Map<string, StoredEntity> {
  const fileBySymbol = new Map<string, string>();
  const owners = new Map<string, StoredEntity>();
  for (const file of files) {
    const rootOwner = file.nodes.find(
      (node) =>
        node.isRoot && node.entity && ENVELOPE_KINDS.has(node.kind ?? ""),
    )?.entity;
    if (rootOwner) {
      owners.set(file.fileId, rootOwner);
      continue;
    }
    const representative = file.clustered
      .flatMap((cluster) => cluster.symbols)
      .filter(({ symbol }) => Boolean(symbol.scope))
      .sort((left, right) => right.score - left.score)[0]?.symbol;
    if (representative) fileBySymbol.set(representative.id, file.fileId);
  }
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
