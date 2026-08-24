import type { StoredEntity } from "../storage/index.js";
import { isLowValuePath } from "./path-policy.js";
import {
  collapseConstructorOverloads,
  groupSemanticSymbols,
  includeSameFileGenericTypeFragments,
  matchesExactSymbolQuery,
  preferExactSymbolCase,
  symbolLookupLeaf,
} from "./symbol-lookup.js";
import type { GraphReader, SymRef } from "./types.js";
import { TYPE_SYMBOL_KIND_SET } from "./symbol-kinds.js";
export type GraphQueryDirection = "callers" | "callees" | "impact";

export type GraphSeedMatch = {
  id: string;
  entity: StoredEntity;
};

export type EnrichedSymRef = SymRef & {
  entity: StoredEntity | null;
};

export type GraphNeighborhoodGroup = {
  /** Representative declaration/definition for this semantic symbol. */
  seed: GraphSeedMatch;
  /** All declaration/definition entities traversed for this symbol. */
  members: GraphSeedMatch[];
  truncated?: boolean;
  neighbors: EnrichedSymRef[];
};

export type GraphNeighborhoodResult = {
  available: boolean;
  direction: GraphQueryDirection;
  query: string;
  depth: number;
  limit: number;
  seeds: GraphSeedMatch[];
  /** Set when multiple seeds match and none was disambiguated. */
  ambiguous?: boolean;
  /** Independent results for same-named definitions in different scopes/files. */
  groups?: GraphNeighborhoodGroup[];
  groupsTruncated?: boolean;
  /** Requested file matched no definition; results fall back to all definitions. */
  fileFilterMismatch?: string;
  truncated?: boolean;
  seed?: GraphSeedMatch;
  neighbors: EnrichedSymRef[];
};

export type GraphNeighborhoodOptions = {
  direction: GraphQueryDirection;
  query: string;
  depth?: number;
  limit?: number;
  /** When multiple name matches, pick this entity id. */
  seedId?: string;
  /** Narrow same-named definitions to this relative or absolute source path. */
  definitionFile?: string;
};

const DEFAULT_DEPTH = 1;
const DEFAULT_IMPACT_DEPTH = 2;
const DEFAULT_LIMIT = 20;
const SEED_LOOKUP_LIMIT = 20;
const MAX_NEIGHBORHOOD_GROUPS = 8;
const NEIGHBOR_CANDIDATE_MULTIPLIER = 8;

export function queryGraphNeighborhood(
  graph: GraphReader,
  options: GraphNeighborhoodOptions,
): GraphNeighborhoodResult {
  const storage = graph;
  const defaultDepth =
    options.direction === "impact" ? DEFAULT_IMPACT_DEPTH : DEFAULT_DEPTH;
  const depth = clampInt(options.depth ?? defaultDepth, 1, 10);
  const limit = clampInt(options.limit ?? DEFAULT_LIMIT, 1, 200);
  const query = options.query.trim();

  if (!graph.available) {
    return {
      available: false,
      direction: options.direction,
      query,
      depth,
      limit,
      seeds: [],
      neighbors: [],
    };
  }

  if (!query) {
    throw new Error("graph query requires a symbol name or id");
  }

  const resolvedSeeds = resolveSeeds(
    storage,
    query,
    options.seedId,
    options.definitionFile,
  );
  const seeds = resolvedSeeds.seeds;
  if (seeds.length === 0) {
    return {
      available: true,
      direction: options.direction,
      query,
      depth,
      limit,
      seeds: [],
      neighbors: [],
    };
  }

  if (resolvedSeeds.ambiguous) {
    const selectedGroups = resolvedSeeds.groups.slice(
      0,
      MAX_NEIGHBORHOOD_GROUPS,
    );
    return {
      available: true,
      direction: options.direction,
      query,
      depth,
      limit,
      seeds,
      ambiguous: true,
      groups: selectedGroups.map((group) =>
        queryNeighborhoodGroup(graph, storage, options.direction, group, {
          depth,
          limit,
        }),
      ),
      groupsTruncated:
        resolvedSeeds.groups.length > MAX_NEIGHBORHOOD_GROUPS || undefined,
      fileFilterMismatch: resolvedSeeds.fileFilterMismatch,
      neighbors: [],
    };
  }

  const group = queryNeighborhoodGroup(
    graph,
    storage,
    options.direction,
    resolvedSeeds.groups[0]!,
    { depth, limit },
  );
  const seed = group.seed;
  return {
    available: true,
    direction: options.direction,
    query,
    depth,
    limit,
    seeds,
    seed,
    truncated: group.truncated,
    neighbors: group.neighbors,
    fileFilterMismatch: resolvedSeeds.fileFilterMismatch,
  };
}

type ResolvedSeedGroup = {
  seed: GraphSeedMatch;
  members: GraphSeedMatch[];
};

function queryNeighborhoodGroup(
  graph: GraphReader,
  storage: GraphReader,
  direction: GraphQueryDirection,
  group: ResolvedSeedGroup,
  budget: { depth: number; limit: number },
): GraphNeighborhoodGroup {
  // Storage traversal limits protect SQLite from high-degree nodes. Query
  // presentation needs a slightly wider, still bounded window so test and
  // generated-code dependents do not randomly crowd production callers out
  // merely because their ids sort first.
  const candidateLimit = Math.min(
    800,
    Math.max(
      budget.limit + 1,
      (budget.limit + 1) * NEIGHBOR_CANDIDATE_MULTIPLIER,
    ),
  );
  const directRefs = group.members.flatMap(({ id }) =>
    direction === "callers"
      ? graph.callers(id, budget.depth, candidateLimit)
      : direction === "impact"
        ? graph.impact(id, budget.depth, candidateLimit)
        : graph.callees(id, budget.depth, candidateLimit),
  );
  const refs = mergeSymRefs([
    ...directRefs,
    ...(direction === "impact" && isTypeSeedGroup(group)
      ? impactTypeMembers(graph, group, budget.depth, candidateLimit)
      : []),
  ]);
  const truncated = refs.length > budget.limit;
  const neighbors = rankNeighborhoodRefs(enrichSymRefs(storage, refs));

  return {
    seed: group.seed,
    members: group.members,
    truncated: truncated || undefined,
    neighbors: neighbors.slice(0, budget.limit),
  };
}

function isTypeSeedGroup(group: ResolvedSeedGroup): boolean {
  return group.members.some(({ entity }) => {
    const metadata = entity.entity.metadata;
    return (
      metadata?.kind === "code" &&
      TYPE_SYMBOL_KIND_SET.has(metadata.symbolType ?? "")
    );
  });
}

/**
 * A type's dependents normally call or reference its members rather than the
 * container node. Traverse those incoming edges in batches so impact remains
 * useful for classes/interfaces without issuing one recursive SQL query per
 * method.
 */
function impactTypeMembers(
  graph: GraphReader,
  group: ResolvedSeedGroup,
  depth: number,
  limit: number,
): SymRef[] {
  const containerIds = new Set(group.members.map(({ id }) => id));
  const memberIds = [
    ...new Set(
      group.members.flatMap(({ id }) =>
        graph.members(id).map((member) => member.id),
      ),
    ),
  ].slice(0, 512);
  if (memberIds.length === 0) return [];

  const visited = new Set([...containerIds, ...memberIds]);
  let frontier = memberIds;
  const refs: SymRef[] = [];
  for (let level = 0; level < depth && frontier.length > 0; level += 1) {
    const remaining = Math.max(1, limit - refs.length);
    const edges = graph.incomingEdges(
      frontier,
      ["CALLS", "REFS"],
      Math.min(4_000, remaining * 4),
    );
    const next: string[] = [];
    for (const edge of edges) {
      if (visited.has(edge.src)) continue;
      visited.add(edge.src);
      refs.push({ id: edge.src, count: edge.count });
      next.push(edge.src);
      if (refs.length >= limit) break;
    }
    frontier = next;
    if (refs.length >= limit) break;
  }
  return refs;
}

function resolveSeeds(
  storage: GraphReader,
  query: string,
  seedId: string | undefined,
  file: string | undefined,
): {
  seeds: GraphSeedMatch[];
  groups: ResolvedSeedGroup[];
  ambiguous: boolean;
  fileFilterMismatch?: string;
} {
  if (seedId) {
    const entity = storage.getEntity(seedId);
    return entity
      ? {
          seeds: [{ id: seedId, entity }],
          groups: [
            {
              seed: { id: seedId, entity },
              members: [{ id: seedId, entity }],
            },
          ],
          ambiguous: false,
        }
      : { seeds: [], groups: [], ambiguous: false };
  }

  const byId = storage.getEntity(query);
  if (byId) {
    return {
      seeds: [{ id: query, entity: byId }],
      groups: [
        {
          seed: { id: query, entity: byId },
          members: [{ id: query, entity: byId }],
        },
      ],
      ambiguous: false,
    };
  }

  const lookupName = symbolLookupLeaf(query);
  let matches = preferExactSymbolCase(
    storage
      .findSymbolsByName(lookupName, SEED_LOOKUP_LIMIT * 4)
      .filter((entity) => matchesExactSymbolQuery(entity, query)),
    query,
  );
  if (storage.findSymbolsByQuery && matches.length > 0)
    matches = includeSameFileGenericTypeFragments(
      matches,
      storage.findSymbolsByQuery(lookupName, SEED_LOOKUP_LIMIT * 16),
      lookupName,
    );
  const allUnique = [
    ...new Map(matches.map((entity) => [entity.entity.id, entity])).values(),
  ];
  const fileMatches = allUnique.filter((entity) =>
    matchesFileFilter(entity, file),
  );
  const fileFilterMismatch =
    file?.trim() && fileMatches.length === 0 && allUnique.length > 0
      ? file.trim()
      : undefined;
  const unique = (fileFilterMismatch ? allUnique : fileMatches).slice(
    0,
    SEED_LOOKUP_LIMIT,
  );
  const groups = groupSemanticSymbols(collapseConstructorOverloads(unique));
  const resolvedGroups = groups.map(({ representative, entities }) => ({
    seed: { id: representative.entity.id, entity: representative },
    members: entities.map((entity) => ({ id: entity.entity.id, entity })),
  }));
  return {
    seeds: resolvedGroups.map(({ seed }) => seed),
    groups: resolvedGroups,
    ambiguous: groups.length > 1,
    fileFilterMismatch,
  };
}

function matchesFileFilter(entity: StoredEntity, file: string | undefined) {
  if (!file?.trim()) return true;
  const expected = normalizePath(file.trim());
  const relative = normalizePath(entity.file.relativePath);
  const absolute = normalizePath(entity.file.absolutePath);
  return (
    relative === expected ||
    absolute === expected ||
    relative.endsWith(`/${expected}`) ||
    absolute.endsWith(`/${expected}`)
  );
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function mergeSymRefs(refs: readonly SymRef[]): SymRef[] {
  const merged = new Map<string, SymRef>();
  for (const ref of refs) {
    const existing = merged.get(ref.id);
    if (!existing) {
      merged.set(ref.id, { ...ref });
      continue;
    }
    existing.kind ??= ref.kind;
    existing.count = Math.max(existing.count ?? 0, ref.count ?? 0) || undefined;
  }
  return [...merged.values()];
}

function rankNeighborhoodRefs(
  refs: readonly EnrichedSymRef[],
): EnrichedSymRef[] {
  return refs
    .map((ref, index) => ({ ref, index }))
    .sort((left, right) => {
      const leftLowValue = isLowValuePath(
        left.ref.entity?.file.relativePath ?? "",
      );
      const rightLowValue = isLowValuePath(
        right.ref.entity?.file.relativePath ?? "",
      );
      return (
        Number(leftLowValue) - Number(rightLowValue) ||
        left.index - right.index ||
        left.ref.id.localeCompare(right.ref.id)
      );
    })
    .map(({ ref }) => ref);
}

function enrichSymRefs(
  storage: GraphReader,
  refs: readonly SymRef[],
): EnrichedSymRef[] {
  return refs.map((ref) => ({
    ...ref,
    entity: storage.getEntity(ref.id),
  }));
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}
