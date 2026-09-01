import type { StoredEntity } from "../../storage/index.js";
import type { Range } from "../../types.js";
import type { ExploreSymbolSnippet } from "./types.js";

export type RankedSymbol = {
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

export type SymbolCluster = {
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

export const ENVELOPE_KINDS = new Set([
  "class",
  "struct",
  "interface",
  "trait",
  "protocol",
  "namespace",
  "module",
]);

const MIN_FOCUSED_EXCERPT_CHARS = 700;

export function clusterSymbols(
  symbols: readonly RankedSymbol[],
): SymbolCluster[] {
  const ordered = [...symbols].sort(
    (a, b) => startLine(a.symbol.range) - startLine(b.symbol.range),
  );
  const clusters: SymbolCluster[] = [];
  for (const item of ordered) {
    const start = startLine(item.symbol.range);
    const end = endLine(item.symbol.range);
    const current = clusters.at(-1);
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

export function renderFileText(
  clusters: readonly SymbolCluster[],
  budget: number,
  sourceLines: readonly string[] | null,
  owner?: StoredEntity,
): { text: string; symbols: ExploreSymbolSnippet[] } {
  if (budget <= 0 || clusters.length === 0) return { text: "", symbols: [] };
  const gap = "\n\n... (gap) ...\n\n";
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
  const firstMemberLine = owner
    ? clusters
        .flatMap((cluster) => cluster.symbols.map(({ symbol }) => symbol))
        .filter(
          (symbol) =>
            symbol.id !== owner.entity.id &&
            containsRange(owner.entity.range, symbol.range),
        )
        .reduce(
          (first, symbol) => Math.min(first, startLine(symbol.range)),
          Infinity,
        )
    : Infinity;
  const ownerContext = renderOwnerContext(
    owner,
    sourceLines,
    budget,
    firstMemberLine,
  );
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
  const parts: string[] = ownerContext ? [ownerContext] : [];
  const selected: ExploreSymbolSnippet[] = [];
  for (const cluster of chosen) {
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
  firstMemberLine: number,
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
  end = Math.min(end + 4, firstMemberLine - 1, sourceLines.length);
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

function sourceForSymbol(
  symbol: ExploreSymbolSnippet,
  sourceLines: readonly string[] | null,
): { text: string; startLine: number } {
  const symbolStartLine = startLine(symbol.range);
  if (!sourceLines || ENVELOPE_KINDS.has(symbol.kind ?? ""))
    return { text: symbol.content.trimEnd(), startLine: symbolStartLine };
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

export function allocateCharBudgets(
  fileIds: readonly string[],
  central: ReadonlySet<string>,
  maxChars: number,
  capacities: ReadonlyMap<string, number>,
): Map<string, number> {
  const budgets = new Map<string, number>();
  if (fileIds.length === 0) return budgets;
  const centralIds = fileIds.filter((id) => central.has(id));
  const otherIds = fileIds.filter((id) => !central.has(id));
  if (centralIds.length === 0 || otherIds.length === 0) {
    for (const id of fileIds)
      budgets.set(id, Math.floor(maxChars / fileIds.length));
    return redistributeUnusedBudget(fileIds, budgets, capacities, maxChars);
  }
  const centralBudget = Math.floor(maxChars * 0.55);
  const otherBudget = maxChars - centralBudget;
  for (const id of centralIds)
    budgets.set(id, Math.floor(centralBudget / centralIds.length));
  for (const id of otherIds)
    budgets.set(id, Math.floor(otherBudget / Math.max(1, otherIds.length)));
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

function containsRange(parent: Range, child: Range): boolean {
  return (
    startOffset(child) >= startOffset(parent) &&
    endOffset(child) <= endOffset(parent)
  );
}

export function startLine(range: Range): number {
  return range.kind === "text" ? range.startLine : 1;
}

export function endLine(range: Range): number {
  return range.kind === "text" ? range.endLine : startLine(range);
}

export function startOffset(range: Range): number {
  return range.kind === "text" ? range.startOffset : 0;
}

export function endOffset(range: Range): number {
  return range.kind === "text" ? range.endOffset : startOffset(range);
}
