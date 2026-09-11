import type { CodeSymbolType } from "../../types.js";

/**
 * Intermediate representations for graph extraction.
 *
 * The extraction layer (walk-time collection) is intentionally pure: it turns
 * an AST walk into plain data (edges + buffered name references) and never
 * touches storage. The pipeline layer later assembles these into a
 * {@link FileGraphResult} and hands them to the graph persistence layer.
 */

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

/**
 * An edge whose both endpoints are known at walk time. Only `contains`
 * qualifies: the target entity is created during the same walk, so its ID is
 * available from the scope stack.
 */
export type WalkEdge = {
  kind: "contains";
  sourceId: string;
  targetId: string;
  line: number;
  column: number;
};

/**
 * A name-based edge buffered during the walk. The target is only a name at
 * this point (the definition may live in another file, later in this file,
 * or not exist at all), so these are partitioned after the walk: in-file
 * resolvable ones become edges, the rest become pending refs.
 */
export type NameEdge = {
  refKind: GraphRefKind;
  /** Entity ID owning the reference (or the file ID for imports). */
  ownerId: string;
  /** Short name of the referenced symbol (last segment for `a.b()`). */
  refName: string;
  /** Receiver text for member calls (`a.b()` → `"a"`). */
  receiverName?: string;
  /** Original reference text as written in the source. */
  rawText?: string;
  /** Argument count at the call site, when the reference is a call. */
  arity?: number;
  line: number;
  column: number;
};

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

/** Status of a persisted unresolved reference. */
export type PendingRefStatus = "pending" | "resolved" | "failed";

/** A reference that could not be resolved within its own file. */
export type PendingRefInput = {
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
  unresolvedRefs: readonly PendingRefInput[];
};
