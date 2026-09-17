import type {
  EdgeProvenance,
  FileEdge,
  FileGraphResult,
  GraphEdgeKind,
  PendingRef,
} from "../types.js";

export type StoredPendingRef = PendingRef & {
  id: number;
  /** Changes whenever the reference is invalidated; prevents stale writeback. */
  token: string;
  fileId: string;
};

export type PendingRefPage = {
  refs: StoredPendingRef[];
  nextCursor?: number;
};

export type ReferenceResolution = {
  refId: number;
  refToken: string;
  /** Target existence/version must be validated by the coordinating pipeline. */
  targetId: string;
  provenance: Exclude<EdgeProvenance, "file_local">;
};

export type NeighborhoodOptions = {
  /** Entity or file endpoint ID, not a filter on the owning file. */
  id: string;
  /** Defaults to both incoming and outgoing edges. */
  direction?: "in" | "out" | "both";
  /** Omitted means all kinds; an empty list matches nothing. */
  kinds?: readonly GraphEdgeKind[];
};

/**
 * Statistics returned by a pending-reference resolution pass.
 */
export type ResolveStats = {
  examined: number;
  resolved: number;
  failed: number;
};

/**
 * Storage backend for code-graph edges and pending references.
 *
 * Implementations own exactly two concerns: persisting per-file graph output
 * and answering relationship queries. Node and file metadata live in the zvec
 * stores (`index.zvec` and `files.zvec`), so this interface does not model
 * them.
 */
export interface GraphStorage {
  /**
   * Replaces the persisted graph for a single file. Callers must ensure that
   * `replaceFile` into the zvec store and `writeFileGraph` into graph storage
   * are committed together (or that failures roll back both).
   * Pass complete pre-update entity IDs from zvec; use [] for a new file.
   */
  writeFileGraph(
    fileId: string,
    result: FileGraphResult,
    oldEntityIds: readonly string[],
  ): Promise<void>;

  /** Removes owned rows and invalidates incoming cross-file edges. */
  deleteFileGraph(
    fileId: string,
    oldEntityIds: readonly string[],
  ): Promise<void>;

  /** Only pending refs; restart after file changes. */
  listPendingRefs(options?: {
    limit?: number;
    cursor?: number;
  }): Promise<PendingRefPage>;

  /** Adds resolved edges without replacing local edges; skips stale reference tokens.
   * Caller must serialize target validation/writeback with file updates and deletes. */
  applyResolutions(
    results: readonly ReferenceResolution[],
  ): Promise<{ resolved: number; stale: number }>;

  /**
   * Runs a pass over currently pending references and attempts to resolve
   * them against the current workspace symbol index.
   *
   * Newly resolved edges are written; refs that remain pending are left in
   * the pending table with status `"pending"`.
   */
  resolvePendingRefs(options?: { batchSize?: number }): Promise<ResolveStats>;

  // ---------------------------------------------------------------------------
  // Reader queries
  // ---------------------------------------------------------------------------

  /** One-hop edges only; pending refs and zvec node metadata are excluded. */
  neighborhood(options: NeighborhoodOptions): Promise<FileEdge[]>;

  /** Incoming calls. Returns all matching edges. */
  getCallers(targetId: string): Promise<FileEdge[]>;

  /** Outgoing calls. Returns all matching edges. */
  getCallees(sourceId: string): Promise<FileEdge[]>;

  /** Import edges owned by the file (not an endpoint filter). Returns all matching edges. */
  getImports(fileId: string): Promise<FileEdge[]>;

  /** Outgoing extends edges. Returns all matching edges. */
  getInheritance(typeId: string): Promise<FileEdge[]>;

  /** Incoming extends edges. Returns all matching edges. */
  getSubclasses(typeId: string): Promise<FileEdge[]>;

  /** Incoming implements edges. Returns all matching edges. */
  getImplementations(typeId: string): Promise<FileEdge[]>;
}

/** Read-only graph storage. The caller closes it after the workspace read. */
export type GraphReadStorage = Pick<
  GraphStorage,
  | "neighborhood"
  | "getCallers"
  | "getCallees"
  | "getImports"
  | "getInheritance"
  | "getSubclasses"
  | "getImplementations"
> & { close(): void };
