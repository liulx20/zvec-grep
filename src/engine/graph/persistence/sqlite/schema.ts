import type { DatabaseSync } from "node:sqlite";

export const GRAPH_SCHEMA_VERSION = 1;
// ASCII "ZGRP" distinguishes this database from unrelated SQLite files.
const GRAPH_APPLICATION_ID = 0x5a475250;

const MIGRATIONS: readonly string[] = [
  `
    CREATE TABLE pending_refs (
      id INTEGER PRIMARY KEY,
      file_id TEXT NOT NULL,
      token TEXT NOT NULL DEFAULT '',
      owner_id TEXT NOT NULL,
      ref_name TEXT NOT NULL,
      receiver_name TEXT,
      ref_kind TEXT NOT NULL CHECK (ref_kind IN ('calls', 'imports', 'extends', 'implements')),
      arity INTEGER CHECK (arity >= 0),
      line INTEGER NOT NULL CHECK (line >= 1),
      column INTEGER NOT NULL CHECK (column >= 0),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'failed')),
      metadata TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata) AND json_type(metadata) = 'object')
    ) STRICT;
    CREATE INDEX pending_refs_file ON pending_refs(file_id);
    CREATE INDEX pending_refs_status_id ON pending_refs(status, id);
    CREATE UNIQUE INDEX pending_refs_token ON pending_refs(token);

    CREATE TABLE edges (
      id INTEGER PRIMARY KEY,
      file_id TEXT NOT NULL,
      ref_id INTEGER REFERENCES pending_refs(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('contains', 'calls', 'imports', 'extends', 'implements')),
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      line INTEGER CHECK (line >= 1),
      column INTEGER CHECK (column >= 0),
      provenance TEXT NOT NULL CHECK (provenance IN ('file_local', 'import_scoped', 'preferred_file', 'workspace_unique')),
      metadata TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata) AND json_type(metadata) = 'object')
    ) STRICT;
    CREATE INDEX edges_file ON edges(file_id);
    CREATE INDEX edges_source_kind ON edges(source, kind);
    CREATE INDEX edges_target_kind ON edges(target, kind);

    CREATE UNIQUE INDEX edges_ref ON edges(ref_id) WHERE ref_id IS NOT NULL;
  `,
];

/** Applies ordered migrations atomically; never downgrades or adopts another DB. */
export function initializeGraphSchema(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    const version = Number(
      database.prepare("PRAGMA user_version").get()?.user_version,
    );
    const applicationId = Number(
      database.prepare("PRAGMA application_id").get()?.application_id,
    );
    if (version > GRAPH_SCHEMA_VERSION) {
      throw new Error(
        `Graph schema version ${version} is newer than supported version ${GRAPH_SCHEMA_VERSION}`,
      );
    }
    if (version === 0 && applicationId === 0) {
      const existing = database
        .prepare(
          "SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1",
        )
        .get();
      if (existing) {
        throw new Error(
          "Cannot initialize graph schema in a non-empty SQLite database",
        );
      }
    } else if (applicationId !== GRAPH_APPLICATION_ID || version < 1) {
      throw new Error("SQLite database is not a supported graph database");
    }

    for (let index = version; index < GRAPH_SCHEMA_VERSION; index++) {
      database.exec(MIGRATIONS[index]);
      database.exec(`PRAGMA user_version = ${index + 1}`);
    }
    database.exec(`PRAGMA application_id = ${GRAPH_APPLICATION_ID}`);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
