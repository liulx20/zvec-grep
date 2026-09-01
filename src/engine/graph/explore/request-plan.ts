import type { StoredEntity } from "../../storage/index.js";
import type { GraphReader } from "../types.js";
import { resolveExploreIntent, type ExploreIntent } from "./intent.js";
import {
  EXPLORE_POLICY,
  hasExplicitQualifiedSymbolReference,
  queryEvidenceTerms,
  resolveExactExploreSeedGroups,
  resolveExploreSeeds,
  semanticTermsCovered,
} from "./policy.js";
import type { ExploreNode, ExploreOptions } from "./types.js";

export type ExploreRequestPlan = {
  query: string;
  searchLimit: number;
  traversalDepth: number;
  maxFiles: number;
  maxChars: number;
  maxNodes: number;
  rootIds: string[];
  rootRepresentativeId?: string;
  intent: ExploreIntent;
};

export type ExploreRequestResolution =
  | { kind: "graph_unavailable"; query: string }
  | { kind: "no_seeds"; query: string }
  | { kind: "ambiguous"; query: string; candidates: ExploreNode[] }
  | { kind: "ready"; plan: ExploreRequestPlan };

type SymbolSearch = (query: string, limit: number) => StoredEntity[];

export function resolveExploreRequest(
  graph: GraphReader,
  options: ExploreOptions,
  symbolSearch?: SymbolSearch,
): ExploreRequestResolution {
  const query = options.query.trim();
  if (!graph.available) return { kind: "graph_unavailable", query };
  if (!query && !options.seedId)
    throw new Error("explore requires a query or seedId");

  const searchLimit = clamp(
    options.searchLimit ?? EXPLORE_POLICY.searchLimit,
    1,
    32,
  );
  const seedEntity = options.seedId ? graph.getEntity(options.seedId) : null;
  const exactGroups = seedEntity
    ? null
    : resolveExactExploreSeedGroups(
        graph,
        options.seedId ?? query,
        searchLimit,
      );
  if (exactGroups && exactGroups.length > 1)
    return {
      kind: "ambiguous",
      query,
      candidates: exactGroups.map(({ representative }) => ({
        id: representative.entity.id,
        kind:
          representative.entity.metadata?.kind === "code"
            ? representative.entity.metadata.symbolType
            : undefined,
        isRoot: true,
        entity: representative,
      })),
    };

  const contextualSeedIds =
    seedEntity && hasExplicitQualifiedSymbolReference(query)
      ? resolveExploreSeeds(graph, query, undefined, searchLimit)
      : [];
  const graphSeedIds =
    seedEntity || exactGroups?.[0]
      ? []
      : resolveExploreSeeds(graph, query, undefined, searchLimit);
  const rootIds =
    exactGroups?.[0]?.ids ??
    (seedEntity
      ? [...new Set([seedEntity.entity.id, ...contextualSeedIds])]
      : !symbolSearch || hasQueryAlignedIdentity(graph, graphSeedIds, query)
        ? graphSeedIds
        : resolveExploreSeeds(
            graph,
            query,
            undefined,
            searchLimit,
            symbolSearch,
          ));
  if (rootIds.length === 0) return { kind: "no_seeds", query };

  const intent = resolveExploreIntent({
    seedId: options.seedId,
    hasExactSymbolGroup: Boolean(exactGroups?.[0]),
  });
  const maxNodes = clamp(
    options.maxNodes ??
      (intent === "concept" || contextualSeedIds.length > 0
        ? EXPLORE_POLICY.maxNodes
        : adaptiveNodeBudget(rootIds.length)),
    16,
    2_000,
  );
  return {
    kind: "ready",
    plan: {
      query,
      searchLimit,
      traversalDepth: clamp(
        options.traversalDepth ?? EXPLORE_POLICY.traversalDepth,
        1,
        8,
      ),
      maxFiles: clamp(options.maxFiles ?? EXPLORE_POLICY.maxFiles, 1, 32),
      maxChars: clamp(
        options.maxChars ?? EXPLORE_POLICY.maxChars,
        1_000,
        200_000,
      ),
      maxNodes,
      rootIds,
      rootRepresentativeId: exactGroups?.[0]?.representative.entity.id,
      intent,
    },
  };
}

function hasQueryAlignedIdentity(
  graph: GraphReader,
  seedIds: readonly string[],
  query: string,
): boolean {
  const terms = queryEvidenceTerms(query);
  return seedIds.some((id) => {
    const metadata = graph.getEntity(id)?.entity.metadata;
    return (
      metadata?.kind === "code" &&
      semanticTermsCovered(
        `${metadata.symbolName ?? ""} ${metadata.scope ?? ""}`,
        terms,
      ).size >= 2
    );
  });
}

function adaptiveNodeBudget(rootCount: number): number {
  return Math.min(EXPLORE_POLICY.maxNodes, Math.max(64, rootCount * 16));
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
