import type { DatabaseSync } from "node:sqlite";

/** Callback must be synchronous; never hold a write lock across async matching. */
export function graphTransaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Graph transaction and rollback failed",
        { cause: rollbackError },
      );
    }
    throw error;
  }
}
