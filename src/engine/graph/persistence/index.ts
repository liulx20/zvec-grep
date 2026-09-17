import { existsSync } from "node:fs";
import { join } from "node:path";
import type { GraphReadStorage } from "./storage.js";
import { GraphDatabase } from "./sqlite/database.js";
import { SqliteGraphReader } from "./sqlite/reader.js";

export type { GraphReadStorage } from "./storage.js";

/** Open an existing, ready graph under the caller's workspace read lock. */
export function openGraphStorage(storagePath: string): GraphReadStorage {
  const path = join(storagePath, "graph.sqlite");
  if (
    !existsSync(path) ||
    !existsSync(join(storagePath, "graph.ready")) ||
    existsSync(join(storagePath, "graph.pending.json"))
  ) {
    throw new Error(
      "Workspace graph is missing or requires recovery; run zg --index",
    );
  }
  return new SqliteGraphReader(GraphDatabase.open(path, true));
}
