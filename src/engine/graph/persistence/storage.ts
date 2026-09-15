import type { FileEdge, FileGraphResult } from "../types.js";

/**
 * Statistics returned by a pending-reference resolution pass.
 */
export type ResolveStats = {
  examined: number;
  resolved: number;
  failed: number;
};

/**
 * Storage backend for code-graph edges and unresolved references.
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
   */
  writeFileGraph(fileId: string, result: FileGraphResult): Promise<void>;

  /** Removes all edges and unresolved refs owned by the given file. */
  deleteFileGraph(fileId: string): Promise<void>;

  /**
   * Runs a pass over currently pending references and attempts to resolve
   * them against the current workspace symbol index.
   *
   * Newly resolved edges are written; refs that remain unresolved are left
   * in the pending table with status `"pending"`.
   */
  resolvePendingRefs(options?: { batchSize?: number }): Promise<ResolveStats>;

  // ---------------------------------------------------------------------------
  // Reader queries
  // ---------------------------------------------------------------------------

  /** Edges where `target` is the given entity ID and kind is `calls`. */
  getCallers(targetId: string): Promise<FileEdge[]>;

  /** Edges where `source` is the given entity ID and kind is `calls`. */
  getCallees(sourceId: string): Promise<FileEdge[]>;

  /** `imports` edges owned by the given file ID. */
  getImports(fileId: string): Promise<FileEdge[]>;

  /** `extends` edges where `source` is the given type ID. */
  getInheritance(typeId: string): Promise<FileEdge[]>;

  /** `extends` edges where `target` is the given type ID. */
  getSubclasses(typeId: string): Promise<FileEdge[]>;

  /** `implements` edges where `target` is the given interface ID. */
  getImplementations(typeId: string): Promise<FileEdge[]>;
}
