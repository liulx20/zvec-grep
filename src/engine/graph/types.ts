import type { CodeEntityModifier, FileInfo, Range } from "../types.js";
import type { StoredEntity } from "../storage/index.js";
import type { ReferenceTarget } from "../reference-target.js";

/** Graph layer types. SymRef here is a symbol handle, not the Ref node table. */

export type SymRef = {
  id: string;
  kind?: string;
  count?: number;
  /** Exact BFS distance when requested by a traversal consumer. */
  depth?: number;
};

export type UsageRef = {
  id: string;
  rel: string;
  first_line?: number;
  count?: number;
};

export type ContainerNeighbor = {
  sid: string;
  parent_id: string;
  sib_id: string | null;
};

export type FileNeighbor = {
  fid: string;
  id: string;
  direction: "out" | "in";
};

export type SymContext = {
  focal: SymRef;
  containers: SymRef[];
  members: SymRef[];
  incoming: UsageRef[];
  outgoing: UsageRef[];
};

export type GraphEdgeKind =
  | "CALLS"
  | "REFS"
  | "INHERITS"
  | "CONTAINS"
  | "DEFINES"
  | "IMPORTS"
  | "COUNTERPART"
  | "INSTANTIATES";

export type ResolutionEvidence =
  "same_file" | "preferred_file" | "container_scope" | "workspace_unique";

/** A persisted graph edge with its original relation metadata intact. */
export type GraphEdge = {
  src: string;
  dst: string;
  kind: GraphEdgeKind;
  rel: string;
  count: number;
  first_line: number;
  ref_name: string;
  provenance: "static" | "heuristic";
  confidence: number;
  evidence?: string;
};

export type DynamicBoundary = {
  sourceId: string;
  line?: number;
  target: ReferenceTarget;
  reason:
    | "unknown_receiver_type"
    | "polymorphic_dispatch"
    | "lexical_dispatch"
    | "runtime_dispatch";
  candidates: string[];
  candidatesTruncated: boolean;
  occurrenceCount?: number;
  candidateDetails: {
    targetId: string;
    displayName?: string;
    filePath?: string;
    reason:
      | "hierarchy"
      | "generic_bound"
      | "method_set"
      | "function_pointer"
      | "namespace_export";
    confidence: number;
  }[];
};

export type InducedEdgesResult = {
  edges: GraphEdge[];
  truncated: boolean;
};

export type TraverseOpts = {
  edgeKinds: readonly GraphEdgeKind[];
  direction: "outgoing" | "incoming" | "both";
  maxDepth: number;
  limit: number;
  includeStart?: boolean;
  includeDepth?: boolean;
};

export type GraphStats = {
  symCount: number;
  fileCount: number;
  /** Pending and failed references retained for backward compatibility. */
  refCount: number;
  pendingRefCount: number;
  failedRefCount: number;
  dynamicBoundaryCount: number;
  externalRefCount: number;
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
  /** Language-level identity such as `Namespace::Type::member`. */
  qualifiedName?: string;
  signature?: string;
  arity?: number;
  returnType?: string;
  /** Source location retained for graph-only presentation queries. */
  range?: Range;
  scope?: string;
  nodeType?: string;
  modifiers?: readonly CodeEntityModifier[];
};

export type LocalEdge = {
  /** Stable source occurrence id; structural/legacy callers may omit it. */
  id?: string;
  src: string;
  dst: string;
  rel: string;
  count: number;
  first_line: number;
  ref_name: string;
  kind:
    "CALLS" | "REFS" | "INHERITS" | "CONTAINS" | "COUNTERPART" | "INSTANTIATES";
  source_language?: string;
  target?: ReferenceTarget;
};

type RawRefBase = {
  owner: string;
  id: string;
  ref_name: string;
  ref_kind: string;
  line: number;
};

export type SymbolRawRef = RawRefBase & {
  type: "symbol";
  source_language?: string;
  target: ReferenceTarget;
};

export type ImportRawRef = RawRefBase & {
  type: "import";
  ref_kind: "import";
  source_language?: string;
  rust_inline_module_depth?: number;
  reexport?: boolean;
};

export type ImportBindingRawRef = RawRefBase & {
  type: "import_binding";
  ref_kind: "import";
  imported_name: string;
  local_name: string;
  source_language: string;
  rust_inline_module_depth?: number;
  reexport?: boolean;
};

export type RawRef = SymbolRawRef | ImportRawRef | ImportBindingRawRef;

export type PendingRef = {
  src: string;
  src_file: string;
  ref_id: string;
  ref_name: string;
  ref_kind: string;
  line: number;
  status: "pending" | "failed" | "external";
  source_language?: string;
  target?: ReferenceTarget;
};

export type RefResolveResult =
  | {
      status: "resolved";
      dst: string;
      edgeKind: "CALLS" | "REFS" | "INHERITS";
      evidence: ResolutionEvidence;
    }
  | { status: "resolved_import"; dstFileId: string }
  | { status: "external" }
  | { status: "failed" };

export type ResolvePendingOptions = {
  /** Indexed files used for import path resolution. */
  files?: readonly FileInfo[];
  /** Retry previously failed refs; pending refs are always processed. */
  retryFailed?: boolean;
  onTiming?: (name: string, durationMs: number, count?: number) => void;
};

export interface GraphReader {
  readonly available: boolean;
  readonly unavailableReason?: string;
  /** Lightweight entity projection; does not open the vector collection. */
  getEntity(entityId: string): StoredEntity | null;
  findSymbolsByName(name: string, limit: number): StoredEntity[];
  /** Optional accelerated lookup for declaration/implementation pairing. */
  findSymbolsByFileStems?(
    stems: readonly string[],
    limitPerStem: number,
  ): ReadonlyMap<string, readonly StoredEntity[]>;
  findSymbolsByQuery?(query: string, limit: number): StoredEntity[];
  readFileText?(file: FileInfo): string | null;

  /** Case-insensitive exact lookup over the indexed symbol name column. */
  findSymbolIdsByName(name: string, limit: number): string[];

  expandContainers(
    symIds: readonly string[],
    limit: number,
  ): ContainerNeighbor[];
  expandFileNeighbors(
    fileIds: readonly string[],
    limit: number,
  ): FileNeighbor[];
  /** Exact symbols named by resolved import bindings from the given files. */
  importedSymbols?(fileIds: readonly string[], limit: number): SymRef[];

  callers(symId: string, depth: number, limit: number): SymRef[];
  callees(symId: string, depth: number, limit: number): SymRef[];
  impact(symId: string, depth: number, limit: number): SymRef[];
  usages(symId: string, limit: number): UsageRef[];
  pathBetween(
    fromSymId: string,
    toSymId: string,
    maxDepth: number,
    edgeLimit?: number,
  ): SymRef[] | null;
  hierarchy(
    symId: string,
    direction: "bases" | "derived",
    limit: number,
  ): SymRef[];
  members(symId: string): SymRef[];
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
    limit: number,
  ): InducedEdgesResult;
  dynamicBoundaries(
    nodeIds: readonly string[],
    limit: number,
  ): DynamicBoundary[];
  /** Sources of unresolved dynamic calls that may dispatch to targetIds. */
  dynamicBoundarySources(targetIds: readonly string[], limit: number): SymRef[];

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
    file?: FileInfo,
  ): void;
  deleteFileGraph(fileId: string): void;
  resolvePending(options?: ResolvePendingOptions): Promise<void>;
}
