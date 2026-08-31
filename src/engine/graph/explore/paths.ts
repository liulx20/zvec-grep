import type { GraphReader, SymRef } from "../types.js";
import { isLowValuePath } from "../path-policy.js";
import { semanticTermsCovered } from "./policy.js";
import type { ExploreCallPath, ExploreEdge } from "./types.js";

const MAX_PATH_SEEDS = 8;
const MAX_PATH_ATTEMPTS = 32;
const MAX_PATH_EDGE_READS = 20_000;

export function collectCallPaths(
  graph: GraphReader,
  rootIds: readonly string[],
  maxDepth: number,
  limit: number,
  terms: readonly string[] = [],
  focusNames: readonly string[] = [],
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
  for (let i = 0; i < pathSeeds.length; i++) {
    for (let j = i + 1; j < pathSeeds.length; j++) {
      if (attempts >= MAX_PATH_ATTEMPTS || edgeReadsRemaining <= 0) break;
      const semanticForward =
        terms.length > 0
          ? semanticPathBetween(
              graph,
              pathSeeds[i]!,
              pathSeeds[j]!,
              maxDepth,
              768,
              terms,
              focusNames,
            )
          : null;
      const semanticReverse =
        terms.length > 0 && !semanticForward
          ? semanticPathBetween(
              graph,
              pathSeeds[j]!,
              pathSeeds[i]!,
              maxDepth,
              768,
              terms,
              focusNames,
            )
          : null;
      const semantic = semanticForward ?? semanticReverse;
      const forward = semantic ? null : tryPath(pathSeeds[i]!, pathSeeds[j]!);
      const reverse =
        semantic || forward ? null : tryPath(pathSeeds[j]!, pathSeeds[i]!);
      const path = semantic ?? forward ?? reverse;
      if (!path || path.length < 2) continue;
      const ids = path.map((ref) => ref.id);
      const key = ids.join("\0");
      if (seen.has(key)) continue;
      seen.add(key);
      paths.push({ from: ids[0]!, to: ids[ids.length - 1]!, nodes: ids });
    }
  }
  paths.sort(
    (left, right) =>
      right.nodes.length - left.nodes.length ||
      left.nodes.join("\0").localeCompare(right.nodes.join("\0")),
  );
  const selected = paths.slice(0, limit);
  const selectedIds = new Set(selected.flatMap((path) => path.nodes));
  for (const id of selectedIds) refs.push({ id });
  return { paths: selected, refs };
}

type SemanticPathState = {
  nodes: string[];
  terms: Set<string>;
  terminalFocus: number;
  focus: number;
  calls: number;
  nonCalls: number;
  lineOrder: number;
};

function semanticPathBetween(
  graph: GraphReader,
  from: string,
  to: string,
  maxDepth: number,
  edgeLimit: number,
  terms: readonly string[],
  focusNames: readonly string[],
): SymRef[] | null {
  let frontier: SemanticPathState[] = [
    {
      nodes: [from],
      terms: new Set(),
      terminalFocus: 0,
      focus: 0,
      calls: 0,
      nonCalls: 0,
      lineOrder: 0,
    },
  ];
  const matches: SemanticPathState[] = [];
  let remaining = edgeLimit;
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
    const sources = [...new Set(frontier.map((state) => state.nodes.at(-1)!))];
    const allowance = Math.min(remaining, Math.max(64, sources.length * 16));
    if (allowance <= 0) break;
    const edges = graph.outgoingEdges(
      sources,
      ["CALLS", "REFS", "INSTANTIATES", "COUNTERPART"],
      allowance,
    );
    remaining -= edges.length;
    const bySource = new Map<string, typeof edges>();
    for (const edge of edges) {
      if (
        edge.kind === "REFS" &&
        edge.rel !== "function" &&
        edge.rel !== "value" &&
        edge.dst !== to
      )
        continue;
      const values = bySource.get(edge.src) ?? [];
      values.push(edge);
      bySource.set(edge.src, values);
    }
    const terminalSources = [
      ...new Set(
        edges.filter((edge) => edge.dst === to).map((edge) => edge.src),
      ),
    ];
    const focusedTerminalSources = new Set(
      (
        graph.dynamicBoundaries?.(
          terminalSources,
          Math.min(128, Math.max(1, terminalSources.length * 8)),
        ) ?? []
      )
        .filter((boundary) =>
          focusNames.some(
            (name) =>
              normalizedName(boundary.target.member) === normalizedName(name),
          ),
        )
        .map((boundary) => boundary.sourceId),
    );
    const next: SemanticPathState[] = [];
    for (const state of frontier) {
      for (const edge of bySource.get(state.nodes.at(-1)!) ?? []) {
        if (state.nodes.includes(edge.dst)) continue;
        const entity = graph.getEntity(edge.dst);
        if (
          !entity ||
          (edge.dst !== to && isLowValuePath(entity.file.relativePath))
        )
          continue;
        const metadata = entity.entity.metadata;
        const symbolName =
          metadata?.kind === "code" ? (metadata.symbolName ?? "") : "";
        const identity =
          metadata?.kind === "code"
            ? `${symbolName} ${metadata.scope ?? ""} ${entity.file.relativePath}`
            : entity.file.relativePath;
        const coveredTerms = new Set(state.terms);
        for (const term of semanticTermsCovered(identity, terms))
          coveredTerms.add(term);
        const candidate: SemanticPathState = {
          nodes: [...state.nodes, edge.dst],
          terms: coveredTerms,
          terminalFocus: Math.max(
            state.terminalFocus,
            Number(edge.dst === to && focusedTerminalSources.has(edge.src)),
          ),
          focus: Math.max(
            state.focus,
            focusNames.some((name) =>
              symbolName
                .replace(/[^A-Za-z0-9_$#]/g, "")
                .toLowerCase()
                .includes(name.replace(/[^A-Za-z0-9_$#]/g, "").toLowerCase()),
            )
              ? 1
              : 0,
          ),
          calls: state.calls + Number(edge.kind === "CALLS"),
          nonCalls: state.nonCalls + Number(edge.kind !== "CALLS"),
          lineOrder: state.lineOrder + edge.first_line,
        };
        (edge.dst === to ? matches : next).push(candidate);
      }
    }
    const bestByTarget = new Map<string, SemanticPathState>();
    for (const state of next.sort(compareSemanticPaths)) {
      const target = state.nodes.at(-1)!;
      if (!bestByTarget.has(target)) bestByTarget.set(target, state);
    }
    frontier = [...bestByTarget.values()]
      .sort(compareSemanticPaths)
      .slice(0, 64);
  }
  const best = matches.sort(compareSemanticPaths)[0];
  return best?.nodes.map((id) => ({ id })) ?? null;
}

function normalizedName(value: string): string {
  return value.replace(/[^A-Za-z0-9_$#]/g, "").toLowerCase();
}

function compareSemanticPaths(
  left: SemanticPathState,
  right: SemanticPathState,
): number {
  return (
    right.terminalFocus - left.terminalFocus ||
    right.focus - left.focus ||
    left.nodes.length - right.nodes.length ||
    right.terms.size - left.terms.size ||
    right.calls - left.calls ||
    left.nonCalls - right.nonCalls ||
    left.lineOrder - right.lineOrder ||
    left.nodes.join("\0").localeCompare(right.nodes.join("\0"))
  );
}

type PathState = {
  nodes: string[];
  terms: Set<string>;
  roles: Set<string>;
  staticEdges: number;
  confidence: number;
  nodeScore: number;
};

/**
 * Derive a compact execution spine from the already bounded subgraph. Pairwise
 * paths above connect explicit roots; this fills the complementary case where
 * a type root contributes representative methods. Selection is evidence based:
 * after the best path, another path survives only when it covers a new query
 * concept or a new execution role (construction or dynamic dispatch).
 */
export function deriveExecutionPaths(
  paths: readonly ExploreCallPath[],
  edges: readonly ExploreEdge[],
  startIds: readonly string[],
  nodeTerms: ReadonlyMap<string, ReadonlySet<string>>,
  nodeScores: ReadonlyMap<string, number>,
  maxDepth: number,
  limit: number,
  continuationStartIds: ReadonlySet<string> = new Set(),
): ExploreCallPath[] {
  if (limit <= paths.length || maxDepth <= 0) return [...paths];
  const outgoing = callAdjacency(edges);
  let frontier = [...new Set(startIds)]
    .filter((id) => outgoing.has(id))
    .map((id) => stateForStart(id, nodeTerms, nodeScores));
  const candidates: PathState[] = [];
  const bestByTarget = new Map<string, PathState>();

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
    const next = new Map<string, PathState>();
    for (const state of frontier) {
      for (const edge of outgoing.get(state.nodes.at(-1)!) ?? []) {
        if (state.nodes.includes(edge.dst)) continue;
        const candidate = extendState(state, edge, nodeTerms, nodeScores);
        const existing = next.get(edge.dst);
        if (!existing || compareStates(candidate, existing) < 0)
          next.set(edge.dst, candidate);
      }
    }
    frontier = [...next.values()];
    for (const state of frontier) {
      const target = state.nodes.at(-1)!;
      const existing = bestByTarget.get(target);
      if (!existing || compareStates(state, existing) < 0) {
        bestByTarget.set(target, state);
        candidates.push(state);
      }
    }
  }

  const result = [...paths];
  const seen = new Set(result.map((path) => path.nodes.join("\0")));
  const coveredTerms = new Set<string>();
  const coveredRoles = new Set<string>();
  const coveredContinuations = new Set<string>();
  const connectedPathIds = new Set(result.flatMap((path) => path.nodes));
  for (const path of result) {
    for (const id of path.nodes)
      for (const term of nodeTerms.get(id) ?? []) coveredTerms.add(term);
    for (const role of rolesForPath(path.nodes, edges)) coveredRoles.add(role);
    for (const source of path.nodes.slice(0, -1))
      if (continuationStartIds.has(source)) coveredContinuations.add(source);
  }
  candidates.sort(compareStates);
  for (const state of candidates) {
    if (result.length >= limit) break;
    const key = state.nodes.join("\0");
    if (seen.has(key) || state.nodes.length < 2) continue;
    const addsTerm = [...state.terms].some((term) => !coveredTerms.has(term));
    const addsRole = [...state.roles].some((role) => !coveredRoles.has(role));
    const start = state.nodes[0]!;
    const addsContinuation =
      connectedPathIds.has(start) &&
      continuationStartIds.has(start) &&
      !coveredContinuations.has(start);
    if (result.length > 0 && !addsTerm && !addsRole && !addsContinuation)
      continue;
    result.push({
      from: state.nodes[0]!,
      to: state.nodes.at(-1)!,
      nodes: state.nodes,
      derived: true,
    });
    seen.add(key);
    for (const term of state.terms) coveredTerms.add(term);
    for (const role of state.roles) coveredRoles.add(role);
    if (addsContinuation) coveredContinuations.add(start);
  }
  return mergeConnectedPaths(result);
}

function mergeConnectedPaths(
  paths: readonly ExploreCallPath[],
): ExploreCallPath[] {
  const result = paths.map((path) => ({ ...path, nodes: [...path.nodes] }));
  for (let left = 0; left < result.length; left += 1) {
    for (let right = 0; right < result.length; right += 1) {
      if (left === right) continue;
      const prefix = result[left]!;
      const suffix = result[right]!;
      if (prefix.nodes.at(-1) !== suffix.nodes[0]) continue;
      const tail = suffix.nodes.slice(1);
      if (tail.some((id) => prefix.nodes.includes(id))) continue;
      result[left] = {
        from: prefix.from,
        to: suffix.to,
        nodes: [...prefix.nodes, ...tail],
        derived: prefix.derived || suffix.derived,
      };
      result.splice(right, 1);
      if (right < left) left -= 1;
      right = -1;
    }
  }
  return result;
}

function callAdjacency(
  edges: readonly ExploreEdge[],
): Map<string, ExploreEdge[]> {
  const executableValues = new Set<string>();
  for (const edge of edges) {
    if (
      edge.kind === "CALLS" ||
      (edge.kind === "REFS" && edge.rel === "function")
    ) {
      executableValues.add(edge.src);
      executableValues.add(edge.dst);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges) {
      if (
        edge.kind === "REFS" &&
        edge.rel === "value" &&
        executableValues.has(edge.dst) &&
        !executableValues.has(edge.src)
      ) {
        executableValues.add(edge.src);
        changed = true;
      }
    }
  }
  const outgoing = new Map<string, Map<string, ExploreEdge>>();
  for (const edge of edges) {
    const callableAlias = edge.kind === "REFS" && edge.rel === "function";
    const callableValue =
      edge.kind === "REFS" &&
      edge.rel === "value" &&
      executableValues.has(edge.dst);
    if (
      (edge.kind !== "CALLS" && !callableAlias && !callableValue) ||
      edge.src === edge.dst
    )
      continue;
    const targets = outgoing.get(edge.src) ?? new Map<string, ExploreEdge>();
    const existing = targets.get(edge.dst);
    if (!existing || compareEdges(edge, existing) < 0)
      targets.set(edge.dst, edge);
    outgoing.set(edge.src, targets);
  }
  return new Map(
    [...outgoing].map(([source, targets]) => [
      source,
      [...targets.values()].sort(compareEdges),
    ]),
  );
}

function stateForStart(
  id: string,
  nodeTerms: ReadonlyMap<string, ReadonlySet<string>>,
  nodeScores: ReadonlyMap<string, number>,
): PathState {
  return {
    nodes: [id],
    terms: new Set(nodeTerms.get(id) ?? []),
    roles: new Set(),
    staticEdges: 0,
    confidence: 0,
    nodeScore: nodeScores.get(id) ?? 0,
  };
}

function extendState(
  state: PathState,
  edge: ExploreEdge,
  nodeTerms: ReadonlyMap<string, ReadonlySet<string>>,
  nodeScores: ReadonlyMap<string, number>,
): PathState {
  const terms = new Set(state.terms);
  for (const term of nodeTerms.get(edge.dst) ?? []) terms.add(term);
  const roles = new Set(state.roles);
  addEdgeRoles(roles, edge);
  return {
    nodes: [...state.nodes, edge.dst],
    terms,
    roles,
    staticEdges: state.staticEdges + Number(edge.provenance === "static"),
    confidence: state.confidence + edge.confidence,
    nodeScore: state.nodeScore + (nodeScores.get(edge.dst) ?? 0),
  };
}

function compareStates(left: PathState, right: PathState): number {
  const leftHops = Math.max(1, left.nodes.length - 1);
  const rightHops = Math.max(1, right.nodes.length - 1);
  return (
    right.terms.size - left.terms.size ||
    right.roles.size - left.roles.size ||
    right.staticEdges / rightHops - left.staticEdges / leftHops ||
    right.confidence / rightHops - left.confidence / leftHops ||
    right.nodeScore / right.nodes.length - left.nodeScore / left.nodes.length ||
    left.nodes.length - right.nodes.length ||
    left.nodes.join("\0").localeCompare(right.nodes.join("\0"))
  );
}

function compareEdges(left: ExploreEdge, right: ExploreEdge): number {
  return (
    Number(right.provenance === "static") -
      Number(left.provenance === "static") ||
    right.confidence - left.confidence ||
    left.firstLine - right.firstLine ||
    left.dst.localeCompare(right.dst)
  );
}

function rolesForPath(
  nodes: readonly string[],
  edges: readonly ExploreEdge[],
): Set<string> {
  const roles = new Set<string>();
  for (let index = 1; index < nodes.length; index += 1) {
    const edge = edges.find(
      (candidate) =>
        candidate.src === nodes[index - 1] &&
        candidate.dst === nodes[index] &&
        (candidate.kind === "CALLS" ||
          (candidate.kind === "REFS" && candidate.rel === "function")),
    );
    if (edge) addEdgeRoles(roles, edge);
  }
  return roles;
}

function addEdgeRoles(roles: Set<string>, edge: ExploreEdge): void {
  if (edge.kind === "CALLS") roles.add("invocation");
  if (edge.kind === "REFS" && edge.rel === "function")
    roles.add("callable_reference");
  if (edge.rel === "new") roles.add("construction");
  if (edge.provenance === "heuristic")
    roles.add(`dynamic_dispatch:${edge.evidence ?? edge.rel}`);
}
