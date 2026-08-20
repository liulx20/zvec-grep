import type { FileInfo } from "../types.js";

/** Graph layer types. SymRef here is a symbol handle, not the Ref node table. */

export type SymRef = {
  id: string;
  kind?: string;
  count?: number;
};

export type UsageRef = {
  id: string;
  rel: string;
  first_line?: number;
  count?: number;
};

export type SeedNeighbor = {
  sid: string;
  id: string;
  count: number;
  direction: "out" | "in";
};

export type ContainerNeighbor = {
  sid: string;
  parent_id: string;
  sib_id: string | null;
};

export type FileNeighbor = {
  fid: string;
  id: string;
};

export type SymContext = {
  focal: SymRef;
  containers: SymRef[];
  members: SymRef[];
  incoming: UsageRef[];
  outgoing: UsageRef[];
};

export type GraphEdgeKind =
  "CALLS" | "REFS" | "INHERITS" | "CONTAINS" | "DEFINES" | "IMPORTS";

/** A persisted graph edge with its original relation metadata intact. */
export type GraphEdge = {
  src: string;
  dst: string;
  kind: GraphEdgeKind;
  rel: string;
  count: number;
  first_line: number;
  ref_name: string;
};

export type TraverseOpts = {
  edgeKinds: readonly GraphEdgeKind[];
  direction: "outgoing" | "incoming" | "both";
  maxDepth: number;
  limit: number;
  includeStart?: boolean;
};

export type GraphStats = {
  symCount: number;
  fileCount: number;
  refCount: number;
  callsCount: number;
  refsCount: number;
  inheritsCount: number;
};

export type SymNode = {
  id: string;
  kind: string;
  is_exported: boolean;
  /** Resolve-only symbol name used by the graph name index. */
  name?: string;
};

export type LocalEdge = {
  src: string;
  dst: string;
  rel: string;
  count: number;
  first_line: number;
  ref_name: string;
  kind: "CALLS" | "REFS" | "INHERITS" | "CONTAINS";
};

export type RawRef = {
  /** Sym.id，或 import 时为 File.id（配合 owner_is_file）。 */
  owner: string;
  id: string;
  ref_name: string;
  ref_kind: string;
  line: number;
  /** true → HAS_REF 挂在 File 上（import/include）。 */
  owner_is_file?: boolean;
};

export type PendingRef = {
  src: string;
  src_file: string;
  ref_id: string;
  ref_name: string;
  ref_kind: string;
  line: number;
  status: "pending" | "failed";
};

export type RefResolveResult =
  | { status: "resolved"; dst: string; edgeKind: "CALLS" | "REFS" | "INHERITS" }
  | { status: "resolved_import"; dstFileId: string }
  | { status: "external" }
  | { status: "failed" };

export type ResolvePendingOptions = {
  /** Indexed files used for import path resolution. */
  files?: readonly FileInfo[];
};

export interface GraphReader {
  readonly available: boolean;

  symbolScope(rootSymId: string, depth: number, limit: number): string[];
  fileScope(fileId: string, depth: number, limit: number): string[];

  expandSeeds(symIds: readonly string[], limit: number): SeedNeighbor[];
  expandContainers(
    symIds: readonly string[],
    limit: number,
  ): ContainerNeighbor[];
  expandFileNeighbors(
    fileIds: readonly string[],
    limit: number,
  ): FileNeighbor[];

  callers(symId: string, depth: number, limit: number): SymRef[];
  callees(symId: string, depth: number, limit: number): SymRef[];
  impact(symId: string, depth: number, limit: number): SymRef[];
  usages(symId: string, limit: number): UsageRef[];
  pathBetween(
    fromSymId: string,
    toSymId: string,
    maxDepth: number,
  ): SymRef[] | null;
  hierarchy(
    symId: string,
    direction: "bases" | "derived",
    limit: number,
  ): SymRef[];
  members(symId: string): SymRef[];
  deadCode(limit: number): SymRef[];
  context(symId: string): SymContext;
  traverse(startSymId: string, opts: TraverseOpts): SymRef[];
  outgoingEdges(
    nodeIds: readonly string[],
    edgeKinds?: readonly GraphEdgeKind[],
    limit?: number,
  ): GraphEdge[];
  incomingEdges(
    nodeIds: readonly string[],
    edgeKinds?: readonly GraphEdgeKind[],
    limit?: number,
  ): GraphEdge[];
  /** Return the induced edges whose two endpoints are both in nodeIds. */
  edges(
    nodeIds: readonly string[],
    edgeKinds: readonly GraphEdgeKind[],
  ): GraphEdge[];

  stats(): GraphStats;
}

export interface GraphStorage extends GraphReader {
  checkpoint(): Promise<void>;
  close(): void;

  upsertFileGraph(
    fileId: string,
    nodes: readonly SymNode[],
    edges: readonly LocalEdge[],
    refs: readonly RawRef[],
  ): void;
  deleteFileGraph(fileId: string): void;
  resolvePending(options?: ResolvePendingOptions): Promise<void>;
}
