import type {
  ZvecGrepExploreResult,
  ZvecGrepGraphEntity,
  ZvecGrepGraphNeighborhoodResult,
} from "../engine/service/index.js";

type ExploreOutput = Omit<ZvecGrepExploreResult, "root"> & { root?: string };
type NeighborhoodOutput = Omit<ZvecGrepGraphNeighborhoodResult, "root"> & {
  root?: string;
};

const DISPLAY_RELATIONSHIP_KINDS = [
  "CALLS",
  "INHERITS",
  "REFS",
  "INSTANTIATES",
] as const;
const MAX_RELATIONSHIPS_PER_KIND = 6;
const MAX_RELATIONSHIP_CALL_DEPTH = 6;
const MAX_DYNAMIC_BOUNDARIES = 8;
const MAX_DYNAMIC_CANDIDATES = 5;

export function printExploreResult(result: ExploreOutput): void {
  for (const line of exploreLines(result)) {
    console.log(line);
  }
}

export function formatExploreResult(result: ExploreOutput): string {
  return exploreLines(result).join("\n");
}

function exploreLines(result: ExploreOutput): string[] {
  if (!result.available) {
    return [
      result.unavailableReason
        ? `graph unavailable: ${result.unavailableReason}`
        : "graph unavailable",
    ];
  }
  if (result.emptyReason === "no_seeds") {
    return [`no seeds for query: ${result.query}`];
  }
  if (result.ambiguous) {
    const lines = [`ambiguous seeds for ${result.query}:`];
    for (const candidate of result.seedCandidates ?? []) {
      lines.push(
        `- ${symbolLabel(candidate.id, candidate.entity)} kind=${candidate.kind ?? "symbol"} id=${candidate.id}`,
      );
    }
    lines.push("re-run with a qualified name or --seed-id <id>");
    return lines;
  }
  if (result.files.length === 0) {
    return [`no explore context for query: ${result.query}`];
  }

  const lines: string[] = [];
  lines.push(`explore: ${result.query}`);
  if (result.root) {
    lines.push(`root: ${result.root}`);
  }
  lines.push(
    `roots: ${result.roots.map((r) => symbolLabel(r.id, r.entity)).join(", ")}`,
  );
  lines.push(
    `subgraph: ${result.nodes.length} nodes, ${result.edges.length} edges${result.edgesTruncated ? " (truncated)" : ""}, ${result.files.length} files`,
  );
  if (result.files.some((file) => file.sourceOrigin === "current_disk")) {
    lines.push(
      "source note: current blocks are verbatim, line-numbered disk reads, not summaries; do not re-read displayed ranges unless marked indexed.",
    );
  }

  if (result.callPaths.length > 0) {
    lines.push("", "flow:");
    for (const [index, path] of visibleCallPaths(result).entries())
      lines.push(`${index + 1}. ${path}`);
  }

  const blast = blastRadiusLines(result);
  if (blast.length > 0) {
    lines.push("", "blast radius:", ...blast);
  }

  if (result.changeSurface.length > 0) {
    lines.push("", "change surface:");
    for (const item of result.changeSurface) {
      lines.push(
        `- ${shortName(result, item.rootId)} ${item.rel} -> ${symbolLabel(item.id, item.entity)}${item.rescued ? " (rescued)" : ""}`,
      );
    }
  }

  if ((result.dynamicBoundaries?.length ?? 0) > 0) {
    const displayedBoundaries = result.dynamicBoundaries.slice(
      0,
      MAX_DYNAMIC_BOUNDARIES,
    );
    const hiddenBoundaries =
      result.dynamicBoundaries.length - displayedBoundaries.length;
    lines.push(
      "",
      `dynamic boundaries:${result.dynamicBoundariesTruncated || hiddenBoundaries > 0 ? " (truncated)" : ""}`,
    );
    for (const boundary of displayedBoundaries) {
      const occurrences = boundary.occurrenceCount ?? 1;
      const details = boundary.candidateDetails ?? [];
      lines.push(
        `- ${shortName(result, boundary.sourceId)}${boundary.line ? `@L${boundary.line}` : ""} -> ${boundary.target.raw}`,
      );
      lines.push(
        `  reason: ${boundary.reason.replaceAll("_", " ")}${occurrences > 1 ? `; occurrences: ${occurrences}` : ""}`,
      );
      const dispatch = boundary.target.hints?.dynamicDispatch;
      if (dispatch) {
        lines.push(
          `  dispatch: ${dispatch.form.replaceAll("_", " ")}${dispatch.key ? `; key: ${dispatch.key}` : "; key: runtime"}`,
        );
      }
      if (details.length === 0) continue;
      lines.push(
        `  candidates: ${details.length}${boundary.candidatesTruncated ? "+" : ""}`,
      );
      for (const candidate of details.slice(0, MAX_DYNAMIC_CANDIDATES)) {
        lines.push(
          `  - ${candidate.displayName ?? shortName(result, candidate.targetId)}${candidate.filePath ? ` (${candidate.filePath})` : ""}; confidence=${candidate.confidence.toFixed(2)}; via=${candidate.reason.replaceAll("_", " ")}`,
        );
      }
      const hidden = details.length - MAX_DYNAMIC_CANDIDATES;
      if (hidden > 0 || boundary.candidatesTruncated) {
        lines.push(
          `  - ... ${hidden > 0 ? `${hidden} more` : "more"}${boundary.candidatesTruncated ? " (truncated)" : ""}`,
        );
      }
    }
    if (hiddenBoundaries > 0) {
      lines.push(`- ... ${hiddenBoundaries} more dynamic boundaries`);
    }
  }

  const relationships = relationshipLines(result);
  if (relationships.length > 0) {
    lines.push("", "relationships:", ...relationships);
  }

  for (const file of result.files) {
    lines.push("");
    const tag = file.isCentral
      ? "central"
      : file.isChangeSurface
        ? "change-surface"
        : "related";
    lines.push(
      `${file.file.relativePath} (${tag}, score=${file.score.toFixed(4)})`,
    );
    if ((file.reasons?.length ?? 0) > 0) {
      lines.push(`selected: ${file.reasons!.join(", ")}`);
    }
    lines.push(
      file.sourceOrigin === "indexed_fragment"
        ? "source (indexed fragment):"
        : "source:",
    );
    for (const textLine of file.text.split(/\r?\n/)) {
      lines.push(textLine);
    }
  }
  return lines;
}

function blastRadiusLines(result: ExploreOutput): string[] {
  const lines: string[] = [];
  for (const blast of result.blastRadius) {
    if (blast.dependents.length === 0 && blast.tests.length === 0) continue;
    lines.push(`- ${shortName(result, blast.rootId)}:`);
    if (blast.dependents.length > 0) {
      lines.push(`  dependents: ${impactSummary(blast.dependents)}`);
    }
    if (blast.tests.length > 0) {
      lines.push(`  tests: ${impactSummary(blast.tests)}`);
    }
  }
  return lines;
}

function impactSummary(
  items: ExploreOutput["blastRadius"][number]["dependents"],
): string {
  const locations = [
    ...new Set(
      items.map((item) => item.entity?.file.relativePath).filter(Boolean),
    ),
  ] as string[];
  const shown = locations.slice(0, 4).join(", ");
  const more = locations.length > 4 ? ` +${locations.length - 4} files` : "";
  return `${items.length} symbols${shown ? ` in ${shown}${more}` : ""}`;
}

export function printNeighborhoodResult(result: NeighborhoodOutput): void {
  for (const line of neighborhoodLines(result)) {
    console.log(line);
  }
}

export function formatNeighborhoodResult(result: NeighborhoodOutput): string {
  return neighborhoodLines(result).join("\n");
}

function neighborhoodLines(result: NeighborhoodOutput): string[] {
  if (!result.available) {
    return [
      result.unavailableReason
        ? `graph unavailable: ${result.unavailableReason}`
        : "graph unavailable",
    ];
  }
  if (result.ambiguous) {
    if (result.groups?.length) {
      const lines = [
        `${result.direction}: ${result.query}`,
        ...(result.root ? [`root: ${result.root}`] : []),
        ...(result.fileFilterMismatch
          ? [
              `warning: no definition of ${result.query} matches file ${result.fileFilterMismatch}; showing all definitions`,
            ]
          : []),
        `definitions=${result.groups.length}${result.groupsTruncated ? " (truncated)" : ""} depth=${result.depth} limit=${result.limit} per definition`,
      ];
      for (const group of result.groups) {
        lines.push(
          "",
          `definition: ${symbolLabel(group.seed.id, group.seed.entity)}`,
          `results=${group.neighbors.length}${group.truncated ? " (truncated)" : ""}`,
        );
        appendNeighborhoodEntries(lines, group.neighbors);
      }
      lines.push("", "narrow with --definition-file <path> or --seed-id <id>");
      return lines;
    }
    const lines = [`ambiguous seeds for ${result.query}:`];
    for (const seed of result.seeds) {
      const kind = seed.entity.kind ? ` kind=${seed.entity.kind}` : "";
      lines.push(`- ${symbolLabel(seed.id, seed.entity)}${kind} id=${seed.id}`);
    }
    lines.push("re-run with a unique name or --seed-id <id>");
    return lines;
  }
  if (!result.seed) {
    return [`no seeds for query: ${result.query}`];
  }

  const lines: string[] = [
    `${result.direction}: ${symbolLabel(result.seed.id, result.seed.entity)}`,
  ];
  if (result.root) {
    lines.push(`root: ${result.root}`);
  }
  if (result.fileFilterMismatch) {
    lines.push(
      `warning: no definition of ${result.query} matches file ${result.fileFilterMismatch}; showing all definitions`,
    );
  }
  lines.push(`depth=${result.depth} limit=${result.limit}`);
  lines.push(
    `results=${result.neighbors.length}${result.truncated ? ` (truncated; increase --limit above ${result.limit})` : ""}`,
  );
  if (result.neighbors.length === 0) {
    lines.push("(no neighbors)");
    return lines;
  }
  appendNeighborhoodEntries(lines, result.neighbors);
  return lines;
}

function appendNeighborhoodEntries(
  lines: string[],
  neighbors: NeighborhoodOutput["neighbors"],
): void {
  if (neighbors.length === 0) {
    lines.push("(no neighbors)");
    return;
  }
  for (const neighbor of neighbors) {
    const count =
      neighbor.count !== undefined ? ` count=${neighbor.count}` : "";
    const kind = neighbor.kind ? ` ${neighbor.kind}` : "";
    lines.push(`- ${symbolLabel(neighbor.id, neighbor.entity)}${kind}${count}`);
  }
}

function relationshipLines(result: ExploreOutput): string[] {
  const lines: string[] = [];
  const rootIds = new Set(result.roots.map((root) => root.id));
  const rootContext = rootSemanticMemberOwners(result, rootIds);
  const containerOwners = directContainerOwners(result);
  const pathNodeIds = new Set(result.callPaths.flatMap((path) => path.nodes));
  const callDistance = callDistancesFromRoots(
    result,
    new Set([...rootIds, ...rootContext.equivalents]),
    MAX_RELATIONSHIP_CALL_DEPTH,
  );
  const displayedFileIds = new Set(result.files.map((file) => file.file.id));
  const selectedNodeIds = new Set([
    ...rootIds,
    ...result.files.flatMap((file) => file.symbols.map((symbol) => symbol.id)),
  ]);
  const nodeFileIds = new Map(
    result.nodes.map((node) => [node.id, node.entity?.file.id]),
  );
  for (const kind of DISPLAY_RELATIONSHIP_KINDS) {
    const grouped = new Map<string, ExploreOutput["edges"][number]>();
    for (const edge of result.edges.filter(
      (edge) =>
        edge.kind === kind &&
        (rootIds.has(edge.src) ||
          rootIds.has(edge.dst) ||
          (endpointIsRepresented(
            edge.src,
            rootIds,
            pathNodeIds,
            displayedFileIds,
            nodeFileIds,
          ) &&
            endpointIsRepresented(
              edge.dst,
              rootIds,
              pathNodeIds,
              displayedFileIds,
              nodeFileIds,
            ))),
    )) {
      const key = [
        edge.src,
        edge.dst,
        edge.kind,
        edge.provenance,
        edge.confidence,
      ].join("\0");
      const existing = grouped.get(key);
      grouped.set(
        key,
        existing ? { ...existing, count: existing.count + edge.count } : edge,
      );
    }
    const edges = [...grouped.values()].sort(
      (left, right) =>
        relationshipRelevance(
          right,
          rootIds,
          rootContext,
          containerOwners,
          pathNodeIds,
          callDistance,
          selectedNodeIds,
          displayedFileIds,
          nodeFileIds,
        ) -
          relationshipRelevance(
            left,
            rootIds,
            rootContext,
            containerOwners,
            pathNodeIds,
            callDistance,
            selectedNodeIds,
            displayedFileIds,
            nodeFileIds,
          ) ||
        relationshipTestWeight(result, left) -
          relationshipTestWeight(result, right) ||
        left.firstLine - right.firstLine ||
        left.src.localeCompare(right.src) ||
        left.dst.localeCompare(right.dst),
    );
    if (edges.length === 0) continue;
    const displayedEdges = selectBoundedRelationships(
      edges,
      MAX_RELATIONSHIPS_PER_KIND,
    );
    lines.push(`${kind}:`);
    for (const edge of displayedEdges) {
      lines.push(`- ${relationNote(result, edge)}`);
    }
    if (edges.length > MAX_RELATIONSHIPS_PER_KIND) {
      lines.push(`- ... and ${edges.length - MAX_RELATIONSHIPS_PER_KIND} more`);
    }
  }
  return lines;
}

function directContainerOwners(result: ExploreOutput): Map<string, string> {
  const owners = new Map<string, string>();
  for (const edge of result.edges)
    if (edge.kind === "CONTAINS") owners.set(edge.dst, edge.src);
  const scopeCounts = new Map<string, number>();
  for (const node of result.nodes) {
    const scope = node.entity?.scope;
    const fileId = node.entity?.file.id;
    if (!scope || !fileId) continue;
    const key = `${fileId}\0${scope}`;
    scopeCounts.set(key, (scopeCounts.get(key) ?? 0) + 1);
  }
  for (const node of result.nodes) {
    if (owners.has(node.id)) continue;
    const scope = node.entity?.scope;
    const fileId = node.entity?.file.id;
    const key = scope && fileId ? `${fileId}\0${scope}` : undefined;
    if (key && (scopeCounts.get(key) ?? 0) >= 2)
      owners.set(node.id, `scope:${key}`);
  }
  return owners;
}

function selectBoundedRelationships<T extends { src: string; dst: string }>(
  ranked: readonly T[],
  limit: number,
): T[] {
  const selected: T[] = [];
  const sources = new Set<string>();
  const targets = new Set<string>();
  for (const edge of ranked) {
    if (sources.has(edge.src) || targets.has(edge.dst)) continue;
    selected.push(edge);
    sources.add(edge.src);
    targets.add(edge.dst);
    if (selected.length === limit) return selected;
  }
  for (const edge of ranked) {
    if (selected.includes(edge)) continue;
    selected.push(edge);
    if (selected.length === limit) break;
  }
  return selected;
}

function rootSemanticMemberOwners(
  result: ExploreOutput,
  rootIds: ReadonlySet<string>,
): {
  owners: Map<string, string>;
  equivalents: Set<string>;
} {
  const owners = new Map<string, string>();
  const equivalents = new Set<string>();
  const relations = new Map<string, { id: string; counterpart: boolean }[]>();
  const append = (src: string, id: string, counterpart: boolean) => {
    const targets = relations.get(src) ?? [];
    targets.push({ id, counterpart });
    relations.set(src, targets);
  };
  for (const edge of result.edges) {
    if (edge.kind === "CONTAINS") append(edge.src, edge.dst, false);
    if (edge.kind === "COUNTERPART") {
      append(edge.src, edge.dst, true);
      append(edge.dst, edge.src, true);
    }
  }

  const queue = [...rootIds].map((id) => ({ id, owner: id, rootPeer: true }));
  for (const root of queue) owners.set(root.id, root.owner);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const relation of relations.get(current.id) ?? []) {
      if (owners.has(relation.id)) continue;
      owners.set(relation.id, current.owner);
      const rootPeer = current.rootPeer && relation.counterpart;
      if (rootPeer) equivalents.add(relation.id);
      queue.push({ id: relation.id, owner: current.owner, rootPeer });
    }
  }
  for (const rootId of rootIds) owners.delete(rootId);
  return { owners, equivalents };
}

function endpointIsRepresented(
  id: string,
  rootIds: ReadonlySet<string>,
  pathNodeIds: ReadonlySet<string>,
  displayedFileIds: ReadonlySet<string>,
  nodeFileIds: ReadonlyMap<string, string | undefined>,
): boolean {
  if (rootIds.has(id) || pathNodeIds.has(id)) return true;
  const fileId = nodeFileIds.get(id);
  return Boolean(fileId && displayedFileIds.has(fileId));
}

function relationshipRelevance(
  edge: ExploreOutput["edges"][number],
  rootIds: ReadonlySet<string>,
  rootContext: {
    owners: ReadonlyMap<string, string>;
    equivalents: ReadonlySet<string>;
  },
  containerOwners: ReadonlyMap<string, string>,
  pathNodeIds: ReadonlySet<string>,
  callDistance: ReadonlyMap<string, number>,
  selectedNodeIds: ReadonlySet<string>,
  displayedFileIds: ReadonlySet<string>,
  nodeFileIds: ReadonlyMap<string, string | undefined>,
): number {
  const endpointScore = (id: string): number => {
    if (rootIds.has(id) || rootContext.equivalents.has(id)) return 100;
    if (pathNodeIds.has(id)) return 60;
    if (rootContext.owners.has(id)) return 50;
    if (selectedNodeIds.has(id)) return 40;
    const fileId = nodeFileIds.get(id);
    return fileId && displayedFileIds.has(fileId) ? 20 : 0;
  };
  const owner = (id: string): string | undefined =>
    rootIds.has(id) ? id : rootContext.owners.get(id);
  const srcOwner = owner(edge.src);
  const dstOwner = owner(edge.dst);
  const staysWithinRootContext =
    srcOwner !== undefined && srcOwner === dstOwner;
  const srcContainer = containerOwners.get(edge.src);
  const staysWithinContainer =
    srcContainer !== undefined &&
    srcContainer === containerOwners.get(edge.dst);
  const crossesRootBoundary =
    srcOwner && dstOwner
      ? srcOwner !== dstOwner
      : Boolean(
          (srcOwner || dstOwner) &&
          nodeFileIds.get(edge.src) !== nodeFileIds.get(edge.dst),
        );
  const srcDistance = callDistance.get(edge.src);
  const dstDistance = callDistance.get(edge.dst);
  const executionSpine =
    edge.kind === "CALLS" &&
    srcDistance !== undefined &&
    dstDistance !== undefined &&
    dstDistance === srcDistance + 1
      ? Math.max(0, 160 - srcDistance * 20)
      : 0;
  return (
    endpointScore(edge.src) +
    endpointScore(edge.dst) +
    (staysWithinRootContext ? 60 : 0) +
    (staysWithinContainer ? 70 : 0) +
    (crossesRootBoundary ? 80 : 0) +
    executionSpine
  );
}

function callDistancesFromRoots(
  result: ExploreOutput,
  rootIds: ReadonlySet<string>,
  maxDepth: number,
): Map<string, number> {
  const outgoing = new Map<string, string[]>();
  for (const edge of result.edges) {
    if (edge.kind !== "CALLS") continue;
    const targets = outgoing.get(edge.src) ?? [];
    targets.push(edge.dst);
    outgoing.set(edge.src, targets);
  }
  const distances = new Map([...rootIds].map((id) => [id, 0]));
  let frontier = [...rootIds];
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const source of frontier) {
      for (const target of outgoing.get(source) ?? []) {
        if (distances.has(target)) continue;
        distances.set(target, depth);
        next.push(target);
      }
    }
    frontier = next;
  }
  return distances;
}

function relationshipTestWeight(
  result: ExploreOutput,
  edge: ExploreOutput["edges"][number],
): number {
  const isTestNode = (id: string): boolean => {
    const path = result.nodes.find((node) => node.id === id)?.entity?.file
      .relativePath;
    return path
      ? /(^|\/)(tests?|specs?|__tests__)(\/|$)|(?:\.|_)(?:test|spec)\.[^/]+$|_test\.[^/]+$/i.test(
          path,
        )
      : false;
  };
  return Number(isTestNode(edge.src)) + Number(isTestNode(edge.dst));
}

function relationNote(
  result: ExploreOutput,
  edge: ExploreOutput["edges"][number],
): string {
  const certainty =
    edge.provenance === "heuristic"
      ? `? confidence=${edge.confidence.toFixed(2)}`
      : "";
  const source = relationshipName(result, edge.src);
  const target = relationshipName(result, edge.dst);
  if (edge.src === edge.dst) {
    return `${locatedName(result, edge.src)} -${edge.kind}${certainty}-> self (recursive)`;
  }
  const sameName = source === target;
  return `${sameName ? locatedName(result, edge.src) : source} -${edge.kind}${certainty}-> ${sameName ? locatedName(result, edge.dst) : target}`;
}

function relationshipName(result: ExploreOutput, id: string): string {
  const node = result.nodes.find((candidate) => candidate.id === id);
  const name = symbolLabel(id, node?.entity ?? null, true);
  const constructorOf = result.nodes.find(
    (candidate) =>
      candidate.id !== id &&
      candidate.entity?.kind === "class" &&
      candidate.entity.name === name,
  );
  return node?.entity?.kind === "function" && constructorOf
    ? `${name}::${name}`
    : name;
}

function locatedName(result: ExploreOutput, id: string): string {
  const node = result.nodes.find((candidate) => candidate.id === id);
  const name = symbolLabel(id, node?.entity ?? null, true);
  const line =
    node?.entity?.range.kind === "text"
      ? node.entity.range.startLine
      : undefined;
  return line === undefined ? name : `${name}@L${line}`;
}

function shortName(result: ExploreOutput, id: string): string {
  const node = result.nodes.find((n) => n.id === id);
  return symbolLabel(id, node?.entity ?? null, true);
}

function formatCallPath(
  result: ExploreOutput,
  nodeIds: readonly string[],
): string {
  let text = shortName(result, nodeIds[0]!);
  for (let index = 1; index < nodeIds.length; index++) {
    const source = nodeIds[index - 1]!;
    const target = nodeIds[index]!;
    const edge = result.edges.find(
      (candidate) => candidate.src === source && candidate.dst === target,
    );
    text += ` -${edge?.kind ?? "CALLS"}${edge?.provenance === "heuristic" ? "?" : ""}-> ${shortName(result, target)}`;
  }
  return text;
}

function visibleCallPaths(result: ExploreOutput): string[] {
  const paths = [
    ...new Set(
      result.callPaths.map((path) => formatCallPath(result, path.nodes)),
    ),
  ];
  return paths.filter(
    (path) => !paths.some((other) => other !== path && other.includes(path)),
  );
}

function symbolLabel(
  id: string,
  entity: ZvecGrepGraphEntity | null | undefined,
  short = false,
): string {
  const rawName = entity?.name ?? id.slice(0, 10);
  const name =
    !short && entity?.scope ? `${entity.scope}::${rawName}` : rawName;
  if (short) {
    return name;
  }
  const path = entity?.file.relativePath;
  const line =
    entity?.range && "startLine" in entity.range
      ? entity.range.startLine
      : undefined;
  return path ? `${name} (${path}${line ? `:${line}` : ""})` : name;
}
