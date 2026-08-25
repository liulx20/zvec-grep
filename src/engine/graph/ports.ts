import type { StoredEntity } from "../storage/index.js";
import type { FileInfo } from "../types.js";

/** Read-only entity lookup port shared by graph application use cases. */
export type GraphQueryStorage = {
  findSymbolsByName(name: string, limit: number): StoredEntity[];
  /**
   * Find symbols whose file basename matches one of the requested stems.
   * This is an optional performance port for declaration/implementation
   * pairing; callers still apply the language-neutral counterpart policy.
   */
  findSymbolsByFileStems?(
    stems: readonly string[],
    limitPerStem: number,
  ): ReadonlyMap<string, readonly StoredEntity[]>;
  findSymbolsByQuery?(query: string, limit: number): StoredEntity[];
  getEntity(entityId: string): StoredEntity | null;
  /** Current on-disk source for presentation; null keeps indexed-fragment fallback. */
  readFileText?(file: FileInfo): string | null;
};
