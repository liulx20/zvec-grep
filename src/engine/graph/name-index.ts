import type { FileGraphNode } from "./types.js";

/**
 * A single entry in the workspace symbol name index.
 */
export type NameIndexEntry = {
  /** Short symbol name (last identifier segment). */
  name: string;
  /** Entity ID in `index.zvec`. */
  entityId: string;
  /** Owning file ID. */
  fileId: string;
  /** Whether the symbol is exported from its module. */
  isExported: boolean;
  /** Qualified name, e.g. `scope::Nested::symbol`. */
  qualifiedName: string;
};

/**
 * Workspace-wide index of symbol names used by the reference resolver.
 *
 * Implementations may be backed by a scan of `index.zvec`, an in-memory map,
 * or a combination. The interface is intentionally read-only from the
 * resolver's perspective.
 */
export interface NameIndex {
  /** Adds or replaces nodes for a single file. */
  addNodes(nodes: readonly FileGraphNode[], fileId: string): void;

  /** Removes all entries belonging to the given file. */
  removeFile(fileId: string): void;

  /** Looks up every symbol that declares `name` anywhere in the workspace. */
  lookup(name: string): readonly NameIndexEntry[];

  /**
   * Returns the unique workspace entry for `name`, or `undefined` if there is
   * not exactly one match.
   */
  lookupUnique(name: string): NameIndexEntry | undefined;

  /** Clears the entire index. */
  clear(): void;
}
