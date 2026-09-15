/**
 * Intermediate representations for graph extraction.
 *
 * The extraction layer (walk-time collection) is intentionally pure: it turns
 * an AST walk into plain data (edges + buffered name references) and never
 * touches storage. The pipeline layer later assembles these into a
 * {@link FileGraphResult} and hands them to the graph persistence layer.
 *
 * Shared graph contract types (edges, nodes, unresolved refs) live in
 * {@link ../../graph/types.ts} so that the persistence and resolution layers
 * can import them without creating a dependency on extraction internals.
 */

import type {
  EdgeProvenance,
  FileEdge,
  FileGraphNode,
  FileGraphResult,
  GraphEdgeKind,
  GraphRefKind,
  PendingRefInput,
  PendingRefStatus,
} from "../../graph/types.js";

export type {
  EdgeProvenance,
  FileEdge,
  FileGraphNode,
  FileGraphResult,
  GraphEdgeKind,
  GraphRefKind,
  PendingRefInput,
  PendingRefStatus,
} from "../../graph/types.js";

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
