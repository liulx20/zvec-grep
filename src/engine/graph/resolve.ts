import type { FileEdge, FileGraphResult, PendingRefInput } from "./types.js";

/**
 * Result of resolving a batch of file-local graph outputs.
 */
export type ResolvedBatch = {
  /** Newly resolved edges, ready for persistence. */
  edges: readonly FileEdge[];
  /** References that could not be resolved. */
  unresolvedRefs: readonly PendingRefInput[];
};

/**
 * Resolves name-based references across files.
 *
 * The resolver does not write to storage itself; it consumes the per-file
 * graph results produced by extraction and returns edges + still-pending
 * refs for the storage layer to persist.
 */
export interface ReferenceResolver {
  /**
   * Resolves cross-file references for the given file results.
   *
   * Callers typically invoke this once per indexing pass after all files
   * have been extracted and the workspace {@link NameIndex} is up to date.
   */
  resolve(fileResults: readonly FileGraphResult[]): Promise<ResolvedBatch>;
}
