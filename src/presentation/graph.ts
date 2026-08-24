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

  if (result.callPaths.length > 0) {
    lines.push("", "call paths:");
    for (const path of result.callPaths) {
      lines.push(
        `- ${path.nodes.map((id) => shortName(result, id)).join(" -> ")}`,
      );
    }
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
    lines.push(
      "",
      `dynamic boundaries:${result.dynamicBoundariesTruncated ? " (truncated)" : ""}`,
    );
    for (const boundary of result.dynamicBoundaries ?? []) {
      const occurrences = boundary.occurrenceCount ?? 1;
      const details = boundary.candidateDetails ?? [];
      lines.push(
        `- ${shortName(result, boundary.sourceId)} -> ${boundary.target.raw}`,
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
    lines.push("source:");
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
      lines.push("", "narrow with --file <relative-path> or --seed-id <id>");
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
        endpointIsRepresented(
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
        ),
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
      selectedNodeIds,
      containerOwners,
      nodeFileIds,
      MAX_RELATIONSHIPS_PER_KIND,
      new Set([...rootIds, ...rootContext.equivalents]),
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
  selectedNodeIds: ReadonlySet<string>,
  containerOwners: ReadonlyMap<string, string>,
  nodeFileIds: ReadonlyMap<string, string | undefined>,
  limit: number,
  preferredNodeIds: ReadonlySet<string> = new Set(),
): T[] {
  let displayed = ranked.slice(0, limit);
  if (displayed.length < limit) return displayed;
  const roleEdges: T[] = [];
  const roleSources = new Set<string>();
  const roleTargets = new Set<string>();
  const selectedEdge =
    ranked.find(
      (edge) =>
        (preferredNodeIds.has(edge.src) || preferredNodeIds.has(edge.dst)) &&
        selectedNodeIds.has(edge.src) &&
        selectedNodeIds.has(edge.dst) &&
        nodeFileIds.get(edge.src) !== nodeFileIds.get(edge.dst),
    ) ??
    ranked.find(
      (edge) =>
        selectedNodeIds.has(edge.src) &&
        selectedNodeIds.has(edge.dst) &&
        nodeFileIds.get(edge.src) !== nodeFileIds.get(edge.dst),
    ) ??
    ranked.find(
      (edge) => selectedNodeIds.has(edge.src) && selectedNodeIds.has(edge.dst),
    );
  if (selectedEdge) {
    roleEdges.push(selectedEdge);
    roleSources.add(selectedEdge.src);
    roleTargets.add(selectedEdge.dst);
  }
  for (const edge of ranked) {
    if (
      !selectedNodeIds.has(edge.src) ||
      containerOwners.get(edge.src) === undefined ||
      containerOwners.get(edge.src) !== containerOwners.get(edge.dst) ||
      roleSources.has(edge.src) ||
      roleTargets.has(edge.dst)
    )
      continue;
    roleEdges.push(edge);
    roleSources.add(edge.src);
    roleTargets.add(edge.dst);
    // Preserve a short execution chain rather than only its cross-file entry
    // and first implementation hop. Distinct source/target guards keep this
    // bounded reserve diverse; the global per-kind limit still applies.
    if (roleEdges.length >= Math.min(3, limit)) break;
  }
  if (roleEdges.length === 0) {
    const fallback = ranked.find(
      (edge) => selectedNodeIds.has(edge.src) && selectedNodeIds.has(edge.dst),
    );
    if (fallback) roleEdges.push(fallback);
  }
  const protectedEdges = new Set(roleEdges);
  for (const roleEdge of roleEdges) {
    if (displayed.includes(roleEdge)) continue;
    let replacement = -1;
    for (let index = displayed.length - 1; index >= 0; index--) {
      if (!protectedEdges.has(displayed[index]!)) {
        replacement = index;
        break;
      }
    }
    if (replacement < 0) break;
    displayed = [...displayed];
    displayed[replacement] = roleEdge;
  }
  const rank = new Map(ranked.map((edge, index) => [edge, index]));
  return displayed.sort(
    (left, right) => (rank.get(left) ?? 0) - (rank.get(right) ?? 0),
  );
}

/**
 * Associate declaration and implementation members with a queried container.
 *
 * Some language adapters produce distinct nodes for a member declaration and
 * its out-of-line definition. C/C++ definitions can also be attached to a
 * constructor-shaped implementation container. Direct CONTAINS traversal
 * therefore misses relationships originating in the implementation file.
 * Propagate root ownership through equivalent member identities and then
 * through their containment descendants. This is language-neutral and keeps
 * presentation ranking independent from source-file layout conventions.
 */
function rootSemanticMemberOwners(
  result: ExploreOutput,
  rootIds: ReadonlySet<string>,
): {
  owners: Map<string, string>;
  equivalents: Set<string>;
} {
  const owners = new Map<string, string>();
  const equivalents = new Set<string>();
  const contains = result.edges.filter((edge) => edge.kind === "CONTAINS");
  const nodes = new Map(result.nodes.map((node) => [node.id, node]));
  const identity = (id: string): string | undefined => {
    const entity = nodes.get(id)?.entity;
    return entity?.name ? `${entity.kind ?? ""}\0${entity.name}` : undefined;
  };

  const rootIdentities = new Map<string, { owner: string; path: string }[]>();
  for (const rootId of rootIds) {
    const key = identity(rootId);
    const path = nodes.get(rootId)?.entity?.file.relativePath;
    if (!key || !path) continue;
    const candidates = rootIdentities.get(key) ?? [];
    candidates.push({ owner: rootId, path });
    rootIdentities.set(key, candidates);
  }
  for (const node of result.nodes) {
    if (rootIds.has(node.id)) continue;
    const key = identity(node.id);
    const path = node.entity?.file.relativePath;
    const match =
      key && path
        ? rootIdentities
            .get(key)
            ?.find((candidate) =>
              semanticCounterpartPaths(candidate.path, path),
            )
        : undefined;
    if (match) {
      owners.set(node.id, match.owner);
      equivalents.add(node.id);
    }
  }

  for (const edge of contains) {
    if (rootIds.has(edge.src)) owners.set(edge.dst, edge.src);
  }

  let changed = true;
  while (changed) {
    changed = false;
    const identityOwners = new Map<string, { owner: string; path: string }[]>();
    for (const [id, owner] of owners) {
      const key = identity(id);
      const path = nodes.get(id)?.entity?.file.relativePath;
      if (!key || !path) continue;
      const candidates = identityOwners.get(key) ?? [];
      candidates.push({ owner, path });
      identityOwners.set(key, candidates);
    }
    for (const node of result.nodes) {
      if (owners.has(node.id) || rootIds.has(node.id)) continue;
      const key = identity(node.id);
      const path = node.entity?.file.relativePath;
      const match =
        key && path
          ? identityOwners
              .get(key)
              ?.find((candidate) =>
                semanticCounterpartPaths(candidate.path, path),
              )
          : undefined;
      if (match) {
        owners.set(node.id, match.owner);
        changed = true;
      }
    }
    for (const edge of contains) {
      if (owners.has(edge.dst)) continue;
      const owner = owners.get(edge.src);
      if (owner) {
        owners.set(edge.dst, owner);
        changed = true;
      }
    }
  }
  return { owners, equivalents };
}

function semanticCounterpartPaths(left: string, right: string): boolean {
  if (left === right) return true;
  const normalize = (path: string) =>
    path
      .toLowerCase()
      .replaceAll("\\", "/")
      .replace(/\.d\.[^.]+$/, "");
  const leftNormalized = normalize(left);
  const rightNormalized = normalize(right);
  const stem = (path: string) =>
    path
      .split("/")
      .at(-1)
      ?.replace(/\.[^.]+$/, "") ?? "";
  if (stem(leftNormalized) !== stem(rightNormalized)) return false;
  const ignored = new Set(["include", "src", "source", "lib"]);
  const directories = (path: string) =>
    new Set(
      path
        .split("/")
        .slice(0, -1)
        .filter((part) => part && !ignored.has(part)),
    );
  const leftDirectories = directories(leftNormalized);
  return [...directories(rightNormalized)].some((part) =>
    leftDirectories.has(part),
  );
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

function symbolLabel(
  id: string,
  entity: ZvecGrepGraphEntity | null | undefined,
  short = false,
): string {
  const name = entity?.name ?? id.slice(0, 10);
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
