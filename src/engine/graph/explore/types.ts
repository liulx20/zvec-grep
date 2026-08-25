import type { StoredEntity } from "../../storage/index.js";
import type { FileInfo, Range } from "../../types.js";
import type { DynamicBoundary, GraphEdgeKind } from "../types.js";

export type ExploreOptions = {
  query: string;
  seedId?: string;
  searchLimit?: number;
  traversalDepth?: number;
  maxNodes?: number;
  maxFiles?: number;
  maxChars?: number;
};

export type ExploreSubgraphOptions = {
  seedIds: readonly string[];
  seedWeights?: ReadonlyMap<string, number>;
  traversalDepth?: number;
  traversalDirection?: "outgoing" | "both";
  maxNodes?: number;
  includeCallPaths?: boolean;
};

export type ExploreNode = {
  id: string;
  kind?: string;
  isRoot: boolean;
  entity: StoredEntity | null;
};

export type ExploreEdge = {
  src: string;
  dst: string;
  kind: GraphEdgeKind;
  rel: string;
  count: number;
  firstLine: number;
  refName: string;
  provenance: "static" | "heuristic";
  confidence: number;
  evidence?: string;
};

export type ExploreCallPath = {
  from: string;
  to: string;
  nodes: string[];
};

export type ExploreImpactRef = {
  id: string;
  entity: StoredEntity | null;
  /** Direct executable dependency on the root, rather than transitive impact. */
  directCall?: boolean;
};

export type ExploreBlastRadius = {
  rootId: string;
  dependents: ExploreImpactRef[];
  tests: ExploreImpactRef[];
};

export type ExploreChangeSurfaceRef = {
  rootId: string;
  id: string;
  rel: "type" | "return";
  entity: StoredEntity;
  rescued: boolean;
  /** Reached through a root container's internal state/type holder. */
  structural?: boolean;
};

export type ExploreFileBundle = {
  file: FileInfo;
  score: number;
  isCentral: boolean;
  isChangeSurface: boolean;
  /** Compact explanation of why this file survived graph ranking. */
  reasons: string[];
  symbols: ExploreSymbolSnippet[];
  /** Zvec-layer assembled text for this file (entity content, clustered). */
  text: string;
};

export type ExploreSymbolSnippet = {
  id: string;
  name: string;
  kind?: string;
  range: Range;
  content: string;
  signature?: string;
};

export type ExploreResult = {
  available: boolean;
  query: string;
  /** Exact query matched multiple independent owner-qualified symbols. */
  ambiguous?: boolean;
  seedCandidates?: ExploreNode[];
  roots: ExploreNode[];
  nodes: ExploreNode[];
  edges: ExploreEdge[];
  edgesTruncated: boolean;
  callPaths: ExploreCallPath[];
  blastRadius: ExploreBlastRadius[];
  changeSurface: ExploreChangeSurfaceRef[];
  dynamicBoundaries: DynamicBoundary[];
  dynamicBoundariesTruncated: boolean;
  files: ExploreFileBundle[];
  emptyReason?: "graph_unavailable" | "no_seeds" | "no_context";
};

export type ExploreSubgraphResult = {
  available: boolean;
  rootIds: string[];
  nodes: ExploreNode[];
  /** Files represented only by reverse impact expansion. */
  impactExpansionFileIds: string[];
  edges: ExploreEdge[];
  edgesTruncated: boolean;
  callPaths: ExploreCallPath[];
  nodeScores: ReadonlyMap<string, number>;
};
