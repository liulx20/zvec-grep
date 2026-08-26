import type { Range } from "../../types.js";
import type { GraphReader } from "../types.js";
import type { DynamicBoundary } from "../types.js";
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
}): ExploreFileBundle[] {
  const nodes = input.pool.nodes;
  const fileEvidence = input.pool.fileEvidence;
  const pathNodeIds = new Set(input.callPaths.flatMap((path) => path.nodes));
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
    pathNodeIds,
  );

  if (rankedFileIds.length === 0) {
    return [];
  }

  // Centrality is role-aware: keep the declaration root, prefer its matching
  // implementation unit, then fall back to the strongest integration file.
  const central = new Set<string>();
  const centralSeeds = rankedFileIds.filter((fileId) =>
    fileEvidence
      .get(fileId)
      ?.has(input.intent === "exact_symbol" ? "root" : "semantic_seed"),
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
      ? preferNestedSourceSymbols(symbols)
      : removeContainedSymbols(symbols);
    const ranked = rankSymbols(
      retained,
      nodes,
      input.edges,
      input.nodeScores,
      pathNodeIds,
      skeletonNodeIds,
      input.dynamicBoundaries,
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
      isChangeSurface: changeSurfaceFileIds.has(fileId),
      reasons: fileReasons(fileId, nodes, input.edges, input.rootFileIds),
      symbols: rendered.symbols,
      sourceOrigin: sourceLines ? "current_disk" : "indexed_fragment",
      text,
    });
  }
  return bundles;
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
  dynamicBoundaries: readonly DynamicBoundary[],
): RankedSymbol[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const fileById = new Map(
    nodes.map((node) => [node.id, node.entity?.file.id ?? ""]),
  );
  return symbols.map((symbol) => {
    const node = nodeById.get(symbol.id);
    const focusLines: number[] = [];
    for (const boundary of dynamicBoundaries) {
      if (boundary.sourceId === symbol.id && boundary.line)
        focusLines.push(boundary.line);
    }
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
        if (edge.kind === "CALLS" && pathNodeIds.has(edge.dst))
          focusLines.unshift(edge.firstLine);
        else focusLines.push(edge.firstLine);
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
      focusLines: [...new Set(focusLines)],
      spine: pathNodeIds.has(symbol.id),
      skeleton:
        skeletonNodeIds.has(symbol.id) &&
        !node?.isRoot &&
        !pathNodeIds.has(symbol.id),
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
    if (b.maxImportance !== a.maxImportance)
      return b.maxImportance - a.maxImportance;
    if (a.spine !== b.spine) return Number(b.spine) - Number(a.spine);
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
  const chosen = new Set<SymbolCluster>();
  const renderedByCluster = new Map<SymbolCluster, string>();
  let projected = 0;
  for (const [index, cluster] of ranked.entries()) {
    const remaining = Math.max(
      0,
      budget - projected - (chosen.size ? gap.length : 0),
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

function laterCompleteBodyCost(
  ranked: readonly SymbolCluster[],
  completeBlocks: ReadonlyMap<SymbolCluster, string>,
  index: number,
  remaining: number,
  gapLength: number,
): number {
  for (const candidate of ranked.slice(index + 1)) {
    if (!candidate.spine && candidate.maxImportance < 3) continue;
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
  return blocks.join("\n").slice(0, budget);
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
