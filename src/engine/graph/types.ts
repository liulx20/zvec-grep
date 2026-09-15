import type { CodeSymbolType } from "../types.js";

/** Edge kinds produced by the extraction layer. */
export type GraphEdgeKind =
  | "contains"
  | "calls"
  | "imports"
  | "extends"
  | "implements";

/**
 * Kinds of buffered name references. Each pending ref is resolved into the
 * {@link GraphEdgeKind} with the same name.
 */
export type GraphRefKind = Exclude<GraphEdgeKind, "contains">;

/** Evidence provenance recorded on persisted edges. */
export type EdgeProvenance =
  | "file_local"
  | "import_scoped"
  | "preferred_file"
  | "workspace_unique";

/** An edge ready for persistence after partition. */
export type FileEdge = {
  kind: GraphEdgeKind;
  source: string;
  target: string;
  line: number | null;
  column: number | null;
  provenance: EdgeProvenance;
  metadata: Record<string, unknown>;
};

/** Status of a persisted pending reference. */
export type PendingRefStatus = "pending" | "resolved" | "failed";

/** A reference that could not be resolved within its own file. */
export type PendingRef = {
  ownerId: string;
  refName: string;
  receiverName: string | null;
  refKind: GraphRefKind;
  arity: number | null;
  line: number;
  column: number;
  status: PendingRefStatus;
  metadata: Record<string, unknown>;
};

/**
 * A graph node derived from an indexed entity fragment. The pipeline layer
 * builds these from the existing `EntityFragment` results; the extraction
 * graph layer only defines the shape.
 */
export type FileGraphNode = {
  id: string;
  kind: CodeSymbolType;
  name: string | null;
  /** `scope::name` breadcrumb joined with `::`, or the bare name. */
  qualifiedName: string;
  language: string;
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
  signature: string | null;
  doc: string | null;
  arity: number | null;
  visibility: string | null;
  isExported: boolean;
};

/** Per-file graph extraction output, assembled after the walk and partition. */
export type FileGraphResult = {
  nodes: readonly FileGraphNode[];
  edges: readonly FileEdge[];
  pendingRefs: readonly PendingRef[];
};
