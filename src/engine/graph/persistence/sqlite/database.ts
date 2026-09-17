import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { initializeGraphSchema, GRAPH_SCHEMA_VERSION } from "./schema.js";

const require = createRequire(import.meta.url);

/** Owns one SQLite connection. Closing more than once is safe. */
export class GraphDatabase {
  private closed = false;

  private constructor(private readonly database: DatabaseSync) {}

  /**
   * Opens a graph database, creating its parent directory and schema as needed.
   * Requires an available node:sqlite module (Node 22.13+ without flags).
   * Use :memory: for an isolated in-memory database.
   */
  static open(path: string, readOnly = false): GraphDatabase {
    if (path.trim().length === 0) {
      throw new Error("Graph database path must not be empty");
    }
    // Load SQLite only for graph operations.
    const { DatabaseSync: SQLiteDatabase } = require("node:sqlite") as {
      DatabaseSync: typeof DatabaseSync;
    };
    if (!readOnly && path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    const database = new SQLiteDatabase(path, { readOnly });
    try {
      database.exec("PRAGMA busy_timeout = 5000");
      if (!readOnly) {
        initializeGraphSchema(database);
        database.exec("PRAGMA journal_mode = WAL");
      } else if (
        database.prepare("PRAGMA user_version").get()?.user_version !==
          GRAPH_SCHEMA_VERSION ||
        database.prepare("PRAGMA application_id").get()?.application_id !==
          0x5a475250
      ) {
        throw new Error("Unsupported graph database; run zg --index --rebuild");
      }
      return new GraphDatabase(database);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  /** Internal SQL access for the graph reader, writer and resolver. */
  get connection(): DatabaseSync {
    if (this.closed) {
      throw new Error("Graph database is closed");
    }
    return this.database;
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.database.close();
    this.closed = true;
  }
}
