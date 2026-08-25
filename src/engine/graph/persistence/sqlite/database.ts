import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync as NodeDatabaseSync } from "node:sqlite";
import { loadNodeSqlite } from "./runtime.js";
import {
  SQLITE_GRAPH_INDEXES,
  SQLITE_GRAPH_SCHEMA,
  SQLITE_GRAPH_SCHEMA_VERSION,
} from "./schema.js";

const BULK_LOAD_INDEXES = [
  "symbols_file_id_idx",
  "symbols_name_idx",
  "symbols_qualified_name_idx",
  "edges_src_kind_idx",
  "edges_dst_kind_idx",
  "edges_member_idx",
  "contains_child_idx",
  "unresolved_refs_name_idx",
  "unresolved_refs_owner_idx",
  "unresolved_refs_retry_idx",
  "unresolved_refs_member_idx",
  "edge_candidates_target_idx",
] as const;
const STATEMENT_CACHE_SIZE = 512;

export class SqliteGraphDatabase {
  readonly db: NodeDatabaseSync;
  readonly readOnly: boolean;
  private closed = false;
  private resolvedProjections: boolean;
  private bulkLoad = false;
  private readonly statements = new Map<
    string,
    ReturnType<NodeDatabaseSync["prepare"]>
  >();

  constructor(
    directory: string,
    options: { readOnly?: boolean; inMemory?: boolean } = {},
  ) {
    const opened = openDatabase(directory, options);
    this.db = opened.db;
    this.readOnly = opened.readOnly;
    this.resolvedProjections = this.detectResolvedProjections();
    if (!this.readOnly && this.isEmpty()) this.beginBulkLoad();
  }

  hasResolvedProjections(): boolean {
    // Legacy resolver marks this eagerly by inserting heuristic edges. The
    // kernel schema does not use a separate 'dynamic' status.
    if (!this.resolvedProjections) {
      this.resolvedProjections = Boolean(
        this.db
          .prepare(
            "SELECT 1 FROM edges WHERE provenance = 'heuristic' LIMIT 1",
          )
          .get(),
      );
    }
    return this.resolvedProjections;
  }

  markResolvedProjections(): void {
    this.resolvedProjections = true;
  }

  isBulkLoad(): boolean {
    return this.bulkLoad;
  }

  endBulkLoad(): void {
    if (!this.bulkLoad) return;
    this.db.exec(SQLITE_GRAPH_INDEXES);
    this.db.exec("PRAGMA synchronous=NORMAL");
    this.db.exec("PRAGMA journal_mode=WAL");
    this.statements.clear();
    this.bulkLoad = false;
  }

  close(): void {
    if (!this.closed) {
      this.statements.clear();
      this.db.close();
      this.closed = true;
    }
  }

  all<T>(sql: string, ...params: Array<string | number>): T[] {
    this.assertOpen();
    return this.prepare(sql).all(...params) as T[];
  }

  one<T>(sql: string, ...params: Array<string | number>): T | undefined {
    this.assertOpen();
    return this.prepare(sql).get(...params) as T | undefined;
  }

  prepare(sql: string): ReturnType<NodeDatabaseSync["prepare"]> {
    this.assertOpen();
    const cached = this.statements.get(sql);
    if (cached) {
      this.statements.delete(sql);
      this.statements.set(sql, cached);
      return cached;
    }
    const statement = this.db.prepare(sql);
    if (this.statements.size >= STATEMENT_CACHE_SIZE) {
      const oldest = this.statements.keys().next().value;
      if (oldest !== undefined) this.statements.delete(oldest);
    }
    this.statements.set(sql, statement);
    return statement;
  }

  transaction(work: () => void): void {
    this.assertWritable();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      work();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  assertOpen(): void {
    if (this.closed) throw new Error("SqliteGraphStorage is closed");
  }

  assertWritable(): void {
    this.assertOpen();
    if (this.readOnly) throw new Error("SqliteGraphStorage is read-only");
  }

  private detectResolvedProjections(): boolean {
    // Kernel-generated edges may carry a 'heuristic' provenance; resolved
    // projections are only relevant when the legacy resolver has run.
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 AS present FROM edges
           WHERE provenance = 'heuristic'
           LIMIT 1`,
        )
        .get(),
    );
  }

  private isEmpty(): boolean {
    return !this.db.prepare("SELECT 1 FROM nodes LIMIT 1").get();
  }

  private beginBulkLoad(): void {
    this.db.exec("PRAGMA journal_mode=MEMORY");
    this.db.exec("PRAGMA synchronous=OFF");
    for (const index of BULK_LOAD_INDEXES) {
      this.db.exec(`DROP INDEX IF EXISTS ${index}`);
    }
    this.bulkLoad = true;
  }
}

function openDatabase(
  directory: string,
  options: { readOnly?: boolean; inMemory?: boolean } = {},
): { db: NodeDatabaseSync; readOnly: boolean } {
  const readOnly = options.readOnly ?? false;
  if (!options.inMemory && !readOnly) mkdirSync(directory, { recursive: true });
  const { DatabaseSync } = loadNodeSqlite();
  const db = new DatabaseSync(
    options.inMemory ? ":memory:" : join(directory, "graph.sqlite"),
    {
      readOnly,
      allowExtension: false,
      enableForeignKeyConstraints: true,
    },
  );
  try {
    if (readOnly) {
      if (!hasSchema(db)) {
        throw new Error("SQLite graph schema is missing");
      }
      ensureVersion(db, true);
    } else {
      db.exec("PRAGMA journal_mode=WAL");
      db.exec("PRAGMA synchronous=NORMAL");
      const existingSchema = hasSchema(db);
      if (existingSchema) {
        ensureVersion(db, false);
      } else {
        // A stale database (pre-migration schema with src_id/dst_id columns
        // or legacy symbols/contains tables) was detected. Drop everything
        // so CREATE TABLE IF NOT EXISTS creates the new schema cleanly.
        dropAllTables(db);
      }
      db.exec(SQLITE_GRAPH_SCHEMA);
      if (!existingSchema) ensureVersion(db, false);
    }
    return { db, readOnly };
  } catch (error) {
    try {
      db.close();
    } catch {
      // Preserve the initialization error; the handle is already unusable.
    }
    throw error;
  }
}

/**
 * Drop every user table so the schema can be recreated from scratch.
 * Used when a stale pre-migration database is detected.
 */
function dropAllTables(db: NodeDatabaseSync): void {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )
    .all() as { name: string }[];
  db.exec("PRAGMA foreign_keys=OFF");
  for (const { name } of tables) {
    // name is a validated table name from sqlite_master; safe to interpolate.
    db.exec(`DROP TABLE IF EXISTS "${name}"`);
  }
  db.exec("PRAGMA foreign_keys=ON");
}

/**
 * A stale database that predates the migration (symbols / contains /
 * edge_candidates tables, or an edges table with src_id instead of
 * source) is detected and rejected so the caller can recreate it.
 */
function hasSchema(db: NodeDatabaseSync): boolean {
  const hasVersionTable =
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_versions'",
      )
      .get() !== undefined;
  if (!hasVersionTable) return false;
  // Reject legacy schemas that have the version table but still use the
  // old column names (src_id / dst_id instead of source / target).
  const edgeColumns = db.prepare("PRAGMA table_info(edges)").all() as {
    name: string;
  }[];
  if (edgeColumns.length === 0) return false;
  return edgeColumns.some((col) => col.name === "source");
}

function ensureVersion(db: NodeDatabaseSync, readOnly: boolean): void {
  const row = db
    .prepare("SELECT version FROM schema_versions ORDER BY version DESC LIMIT 1")
    .get() as { version: number } | undefined;
  if (!row) {
    if (readOnly) throw new Error("SQLite graph schema version is missing");
    db.prepare(
      "INSERT INTO schema_versions(version, applied_at, description) VALUES(?, ?, ?)",
    ).run(
      SQLITE_GRAPH_SCHEMA_VERSION,
      Date.now(),
      "Initial schema",
    );
  } else if (row.version !== SQLITE_GRAPH_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported SQLite graph schema version: ${row.version}; expected ${SQLITE_GRAPH_SCHEMA_VERSION}`,
    );
  }
}
