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
  /** null means a prior process left an unknown set of files dirty. */
  private counterpartDirtyFiles: Set<string> | null;
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
    this.counterpartDirtyFiles = this.db
      .prepare(
        `SELECT 1 FROM graph_meta
         WHERE key='counterpart_projection_dirty' AND value='1'`,
      )
      .get()
      ? null
      : new Set();
    if (!this.readOnly && this.isEmpty()) this.beginBulkLoad();
  }

  hasResolvedProjections(): boolean {
    // Resolver marks this eagerly. The indexed fallback also covers tools and
    // tests that insert a dynamic projection directly on the same connection.
    if (!this.resolvedProjections) {
      this.resolvedProjections = Boolean(
        this.db
          .prepare(
            "SELECT 1 FROM unresolved_refs WHERE status='dynamic' LIMIT 1",
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

  markCounterpartDirty(fileId: string): void {
    this.counterpartDirtyFiles?.add(fileId);
    this.prepare(
      `INSERT INTO graph_meta(key,value) VALUES('counterpart_projection_dirty','1')
       ON CONFLICT(key) DO UPDATE SET value='1'`,
    ).run();
  }

  counterpartDirtyFileSnapshot(): string[] | null {
    return this.counterpartDirtyFiles ? [...this.counterpartDirtyFiles] : null;
  }

  clearCounterpartProjectionDirty(): void {
    this.prepare(
      "DELETE FROM graph_meta WHERE key='counterpart_projection_dirty'",
    ).run();
  }

  acknowledgeCounterpartProjection(files: readonly string[] | null): void {
    if (files === null) this.counterpartDirtyFiles = new Set();
    else for (const file of files) this.counterpartDirtyFiles?.delete(file);
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
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 AS present FROM edges
           WHERE provenance='heuristic' OR evidence IS NOT NULL
           UNION ALL
           SELECT 1 AS present FROM unresolved_refs WHERE status='dynamic'
           LIMIT 1`,
        )
        .get(),
    );
  }

  private isEmpty(): boolean {
    return !this.db.prepare("SELECT 1 FROM symbols LIMIT 1").get();
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
      if (existingSchema) ensureVersion(db, false);
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

function hasSchema(db: NodeDatabaseSync): boolean {
  return (
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='graph_meta'",
      )
      .get() !== undefined
  );
}

function ensureVersion(db: NodeDatabaseSync, readOnly: boolean): void {
  const row = db
    .prepare("SELECT value FROM graph_meta WHERE key='schema_version'")
    .get() as { value: string } | undefined;
  if (!row) {
    if (readOnly) throw new Error("SQLite graph schema version is missing");
    db.prepare(
      "INSERT INTO graph_meta(key,value) VALUES('schema_version',?)",
    ).run(String(SQLITE_GRAPH_SCHEMA_VERSION));
  } else if (Number(row.value) !== SQLITE_GRAPH_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported SQLite graph schema version: ${row.value}; expected ${SQLITE_GRAPH_SCHEMA_VERSION}`,
    );
  }
}
