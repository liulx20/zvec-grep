import type { GraphStorage } from "./types.js";
import { SqlitePendingRefResolver } from "./persistence/sqlite/pending-ref-resolver.js";

/** Public SQLite graph facade composed from reader, writer and resolver units. */
export class SqliteGraphStorage
  extends SqlitePendingRefResolver
  implements GraphStorage {}
