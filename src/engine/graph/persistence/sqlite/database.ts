import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync as NodeDatabaseSync } from "node:sqlite";
import { loadNodeSqlite } from "./runtime.js";
import { SQLITE_GRAPH_SCHEMA, SQLITE_GRAPH_SCHEMA_VERSION } from "./schema.js";

export function openSqliteGraphDatabase(
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
      db.exec(SQLITE_GRAPH_SCHEMA);
      ensureOptionalColumns(db);
      ensureVersion(db, false);
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

function ensureOptionalColumns(db: NodeDatabaseSync): void {
  const columns = tableColumns(db, "pending_refs");
  if (!columns.has("imported_name"))
    db.exec("ALTER TABLE pending_refs ADD COLUMN imported_name TEXT");
  if (!columns.has("local_name"))
    db.exec("ALTER TABLE pending_refs ADD COLUMN local_name TEXT");
  if (!columns.has("source_language"))
    db.exec("ALTER TABLE pending_refs ADD COLUMN source_language TEXT");
  if (!columns.has("last_attempt"))
    db.exec(
      "ALTER TABLE pending_refs ADD COLUMN last_attempt INTEGER NOT NULL DEFAULT 0",
    );
  db.exec(
    "CREATE INDEX IF NOT EXISTS pending_refs_retry_idx ON pending_refs(ref_name,status,last_attempt,id)",
  );

  const bindingColumns = tableColumns(db, "file_import_bindings");
  if (!bindingColumns.has("spec")) {
    db.exec(
      "ALTER TABLE file_import_bindings ADD COLUMN spec TEXT NOT NULL DEFAULT ''",
    );
  }
}

function tableColumns(db: NodeDatabaseSync, table: string): Set<string> {
  return new Set(
    (
      db.prepare(`PRAGMA table_info(${table})`).all() as unknown as {
        name: string;
      }[]
    ).map((row) => row.name),
  );
}
