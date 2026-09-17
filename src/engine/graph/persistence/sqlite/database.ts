import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { initializeGraphSchema } from "./schema.js";

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
  static open(path: string): GraphDatabase {
    if (path.trim().length === 0) {
      throw new Error("Graph database path must not be empty");
    }
    // Keep SQLite optional until graph storage is used, preserving existing
    // search entry points on earlier Node 22 releases.
    const { DatabaseSync: SQLiteDatabase } = require("node:sqlite") as {
      DatabaseSync: typeof DatabaseSync;
    };
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    const database = new SQLiteDatabase(path);
    try {
      database.exec("PRAGMA busy_timeout = 5000");
      initializeGraphSchema(database);
      database.exec("PRAGMA journal_mode = WAL");
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
