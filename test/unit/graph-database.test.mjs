import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { GraphDatabase } from "../../dist/engine/graph/persistence/sqlite/database.js";
import {
  GRAPH_SCHEMA_VERSION,
  initializeGraphSchema,
} from "../../dist/engine/graph/persistence/sqlite/schema.js";

async function databasePath(t) {
  const parent = await mkdtemp(join(tmpdir(), "zvec-graph-db-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  return join(parent, "nested", "graph.sqlite");
}

const INSERT_EDGE = `INSERT INTO edges
  (file_id, kind, source, target, line, column, provenance, metadata)
  VALUES (?, 'calls', ?, ?, ?, 0, 'file_local', ?)`;

test("graph database initializes memory schema, constraints and indexes", (t) => {
  const graph = GraphDatabase.open(":memory:");
  t.after(() => graph.close());
  const db = graph.connection;
  assert.equal(
    db.prepare("PRAGMA user_version").get().user_version,
    GRAPH_SCHEMA_VERSION,
  );
  assert.deepEqual(
    db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map((row) => row.name),
    ["edges", "pending_refs"],
  );
  assert.deepEqual(
    db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => row.name),
    [
      "edges_file",
      "edges_ref",
      "edges_source_kind",
      "edges_target_kind",
      "pending_refs_file",
      "pending_refs_status_id",
      "pending_refs_token",
    ],
  );
  assert.equal(db.prepare("PRAGMA busy_timeout").get().timeout, 5000);
  assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "memory");
  const insert = db.prepare(INSERT_EDGE);
  insert.run("file", "caller", "callee", 1, '{"evidence":"first"}');
  insert.run("file", "caller", "callee", 2, "{}");
  assert.equal(
    db.prepare("SELECT count(*) AS count FROM edges").get().count,
    2,
  );
  assert.throws(
    () => insert.run("file", "caller", "callee", 0, "{}"),
    /constraint/i,
  );
  assert.throws(
    () => insert.run("file", "caller", "callee", 1, "[]"),
    /constraint/i,
  );
  assert.throws(
    () => insert.run("file", "caller", "callee", 1, "invalid"),
    /constraint|JSON/i,
  );
  db.exec(`INSERT INTO pending_refs (file_id, owner_id, ref_name, ref_kind, line, column)
    VALUES ('file', 'caller', 'callee', 'calls', 1, 0)`);
  assert.equal(
    db.prepare("SELECT status FROM pending_refs").get().status,
    "pending",
  );
  assert.throws(
    () => db.exec("UPDATE pending_refs SET status = 'unknown'"),
    /constraint/i,
  );
  assert.throws(
    () => db.exec("UPDATE pending_refs SET arity = -1"),
    /constraint/i,
  );
});

test("file schema and data survive a second connection and reopen", async (t) => {
  const path = await databasePath(t);
  const first = GraphDatabase.open(path);
  t.after(() => first.close());
  first.connection
    .prepare(INSERT_EDGE)
    .run("file", "caller", "callee", 1, "{}");
  assert.equal(
    first.connection.prepare("PRAGMA journal_mode").get().journal_mode,
    "wal",
  );
  const second = GraphDatabase.open(path);
  t.after(() => second.close());
  assert.equal(
    second.connection.prepare("SELECT target FROM edges").get().target,
    "callee",
  );
  first.close();
  second.close();
  const reopened = GraphDatabase.open(path);
  t.after(() => reopened.close());
  assert.equal(
    reopened.connection.prepare("SELECT count(*) AS count FROM edges").get()
      .count,
    1,
  );
});

test("closing is idempotent and rejects subsequent connection access", () => {
  const graph = GraphDatabase.open(":memory:");
  assert.equal(graph.isOpen, true);
  graph.close();
  graph.close();
  assert.equal(graph.isOpen, false);
  assert.throws(() => graph.connection, /closed/);
  assert.throws(() => GraphDatabase.open(""), /must not be empty/);
});

test("newer schema is rejected without downgrading or deleting data", async (t) => {
  const path = await databasePath(t);
  const graph = GraphDatabase.open(path);
  graph.connection
    .prepare(INSERT_EDGE)
    .run("file", "caller", "callee", 1, "{}");
  graph.connection.exec(`PRAGMA user_version = ${GRAPH_SCHEMA_VERSION + 1}`);
  graph.close();
  assert.throws(() => GraphDatabase.open(path), /newer than supported/);
  const raw = new DatabaseSync(path);
  t.after(() => raw.close());
  assert.equal(
    raw.prepare("PRAGMA user_version").get().user_version,
    GRAPH_SCHEMA_VERSION + 1,
  );
  assert.equal(
    raw.prepare("SELECT count(*) AS count FROM edges").get().count,
    1,
  );
  // A rejected open must release its schema transaction and connection.
  raw.exec("BEGIN EXCLUSIVE; COMMIT");
});

test("unrelated SQLite databases are not adopted", (t) => {
  const raw = new DatabaseSync(":memory:");
  t.after(() => raw.close());
  raw.exec(
    "CREATE TABLE unrelated (value TEXT); INSERT INTO unrelated VALUES ('keep')",
  );
  assert.throws(() => initializeGraphSchema(raw), /non-empty/);
  assert.equal(raw.prepare("SELECT value FROM unrelated").get().value, "keep");
  assert.equal(raw.prepare("PRAGMA user_version").get().user_version, 0);
  raw.exec("PRAGMA user_version = 1");
  assert.throws(
    () => initializeGraphSchema(raw),
    /not a supported graph database/,
  );
});

test("migration failure rolls back DDL and version and allows retry", (t) => {
  const raw = new DatabaseSync(":memory:");
  t.after(() => raw.close());
  const failing = new Proxy(raw, {
    get(target, property) {
      if (property === "exec") {
        return (sql) => {
          if (sql.startsWith("PRAGMA application_id =")) {
            throw new Error("injected migration failure");
          }
          target.exec(sql);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  assert.throws(
    () => initializeGraphSchema(failing),
    /injected migration failure/,
  );
  assert.equal(raw.prepare("PRAGMA user_version").get().user_version, 0);
  assert.equal(
    raw.prepare("SELECT count(*) AS count FROM sqlite_schema").get().count,
    0,
  );
  initializeGraphSchema(raw);
  assert.equal(
    raw.prepare("PRAGMA user_version").get().user_version,
    GRAPH_SCHEMA_VERSION,
  );
});

test("read-only graph connections query without allowing mutations or creating missing databases", async (t) => {
  const path = await databasePath(t);
  assert.throws(() => GraphDatabase.open(path, true));
  const writer = GraphDatabase.open(path);
  writer.connection
    .prepare(INSERT_EDGE)
    .run("file", "source", "target", 1, "{}");
  writer.close();
  const reader = GraphDatabase.open(path, true);
  try {
    assert.equal(
      reader.connection.prepare("SELECT count(*) AS count FROM edges").get()
        .count,
      1,
    );
    assert.throws(
      () => reader.connection.exec("DELETE FROM edges"),
      /readonly/,
    );
  } finally {
    reader.close();
  }
});
