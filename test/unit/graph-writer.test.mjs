import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GraphDatabase } from "../../dist/engine/graph/persistence/sqlite/database.js";
import { SqliteGraphWriter } from "../../dist/engine/graph/persistence/sqlite/writer.js";

import { localGraph } from "../helpers/graph-fixtures.mjs";

function edge(overrides = {}) {
  return {
    kind: "calls",
    source: "a:caller",
    target: "a:callee",
    line: 3,
    column: 2,
    provenance: "file_local",
    metadata: { rawText: "callee", arity: 0 },
    ...overrides,
  };
}

function ref(overrides = {}) {
  return {
    ownerId: "a:caller",
    refName: "run",
    receiverName: "obj",
    refKind: "calls",
    arity: 0,
    line: 4,
    column: 2,
    status: "pending",
    metadata: { rawText: "obj.run", evidence: ["调用", "quote'?"] },
    ...overrides,
  };
}

function result(edges = [edge()], pendingRefs = [ref()]) {
  return localGraph(edges, pendingRefs);
}

function setup(t) {
  const graph = GraphDatabase.open(":memory:");
  t.after(() => graph.close());
  return { graph, writer: new SqliteGraphWriter(graph) };
}

function rows(graph, table) {
  // table is a test-controlled name, never a file ID or user input.
  return graph.connection
    .prepare(`SELECT * FROM ${table} ORDER BY id`)
    .all()
    .map((row) => ({ ...row }));
}

test("writer stores graph fields, nullable values and JSON metadata", async (t) => {
  const { graph, writer } = setup(t);
  const fileId = "file'with?quotes";
  await writer.writeFileGraph(
    fileId,
    result(
      [edge({ line: null, column: null, provenance: "file_local" })],
      [ref({ receiverName: null, arity: null })],
    ),
    [],
  );
  const [{ id: edgeId, ...storedEdge }] = rows(graph, "edges");
  assert.equal(typeof edgeId, "number");
  assert.deepEqual(storedEdge, {
    file_id: fileId,
    ref_id: null,
    kind: "calls",
    source: "a:caller",
    target: "a:callee",
    line: null,
    column: null,
    provenance: "file_local",
    metadata: JSON.stringify(edge().metadata),
  });
  const [{ id: refId, token, ...storedRef }] = rows(graph, "pending_refs");
  assert.equal(typeof refId, "number");
  assert.equal(typeof token, "string");
  assert.deepEqual(storedRef, {
    file_id: fileId,
    owner_id: "a:caller",
    ref_name: "run",
    receiver_name: null,
    ref_kind: "calls",
    arity: null,
    line: 4,
    column: 2,
    status: "pending",
    metadata: JSON.stringify(ref().metadata),
  });
});

test("replacement removes stale rows, preserves other owners and does not accumulate", async (t) => {
  const { graph, writer } = setup(t);
  await writer.writeFileGraph("a", result(), []);
  await writer.writeFileGraph(
    "b",
    result(
      [edge({ source: "b:caller", target: "b:callee" })],
      [ref({ ownerId: "b:caller" })],
    ),
    [],
  );
  const otherEdges = rows(graph, "edges").filter((row) => row.file_id === "b");
  const otherRefs = rows(graph, "pending_refs").filter(
    (row) => row.file_id === "b",
  );
  const next = result(
    [edge({ target: "a:new", line: 8 }), edge({ target: "a:new", line: 9 })],
    [ref({ receiverName: "left" }), ref({ receiverName: "right" })],
  );
  await writer.writeFileGraph("a", next, []);
  await writer.writeFileGraph("a", next, []);
  assert.deepEqual(
    rows(graph, "edges").filter((row) => row.file_id === "b"),
    otherEdges,
  );
  assert.deepEqual(
    rows(graph, "pending_refs").filter((row) => row.file_id === "b"),
    otherRefs,
  );
  assert.deepEqual(
    rows(graph, "edges")
      .filter((row) => row.file_id === "a")
      .map((row) => [row.target, row.line]),
    [
      ["a:new", 8],
      ["a:new", 9],
    ],
  );
  assert.deepEqual(
    rows(graph, "pending_refs")
      .filter((row) => row.file_id === "a")
      .map((row) => row.receiver_name),
    ["left", "right"],
  );
  await writer.writeFileGraph("a", result([], []), []);
  assert.deepEqual(rows(graph, "edges"), otherEdges);
  assert.deepEqual(rows(graph, "pending_refs"), otherRefs);
});

test("writer preserves local edge and pending reference kinds", async (t) => {
  const { graph, writer } = setup(t);
  const kinds = ["contains", "calls", "imports", "extends", "implements"];
  await writer.writeFileGraph(
    "a",
    result(
      kinds.map((kind) => edge({ kind })),
      kinds.slice(1).map((refKind) => ref({ refKind })),
    ),
    [],
  );
  assert.deepEqual(
    rows(graph, "edges").map((row) => row.kind),
    kinds,
  );
  assert.deepEqual(
    rows(graph, "pending_refs").map((row) => row.ref_kind),
    kinds.slice(1),
  );
});

test("failed pending-ref insertion rolls back deletes and partially inserted rows", async (t) => {
  const { graph, writer } = setup(t);
  await writer.writeFileGraph("a", result(), []);
  const beforeEdges = rows(graph, "edges");
  const beforeRefs = rows(graph, "pending_refs");
  await assert.rejects(
    writer.writeFileGraph(
      "a",
      result([edge({ target: "replacement" })], [ref(), ref({ line: 0 })]),
      [],
    ),
    /constraint/i,
  );
  assert.deepEqual(rows(graph, "edges"), beforeEdges);
  assert.deepEqual(rows(graph, "pending_refs"), beforeRefs);
  await writer.writeFileGraph("a", result([], []), []);
  assert.deepEqual(rows(graph, "edges"), []);
  assert.deepEqual(rows(graph, "pending_refs"), []);
});

test("metadata serialization failure restores the previous graph", async (t) => {
  const { graph, writer } = setup(t);
  await writer.writeFileGraph("a", result(), []);
  const beforeEdges = rows(graph, "edges");
  const beforeRefs = rows(graph, "pending_refs");
  const circular = {};
  circular.self = circular;
  await assert.rejects(
    writer.writeFileGraph(
      "a",
      result([edge({ target: "new" })], [ref({ metadata: circular })]),
      [],
    ),
    /circular/i,
  );
  assert.deepEqual(rows(graph, "edges"), beforeEdges);
  assert.deepEqual(rows(graph, "pending_refs"), beforeRefs);
});

test("invalid file IDs and nested transactions do not change existing work", async (t) => {
  const { graph, writer } = setup(t);
  await writer.writeFileGraph("a", result(), []);
  await assert.rejects(
    writer.writeFileGraph("  ", result(), []),
    /must not be empty/,
  );
  graph.connection.exec("BEGIN; UPDATE edges SET target = 'uncommitted'");
  await assert.rejects(
    writer.writeFileGraph("a", result(), []),
    /transaction/i,
  );
  assert.equal(rows(graph, "edges")[0].target, "uncommitted");
  graph.connection.exec("ROLLBACK");
  assert.equal(rows(graph, "edges")[0].target, "a:callee");
  graph.close();
  await assert.rejects(writer.writeFileGraph("a", result(), []), /closed/);
});

test("written graph survives closing and reopening the database", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "zvec-graph-writer-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const path = join(parent, "graph.sqlite");
  const graph = GraphDatabase.open(path);
  t.after(() => graph.close());
  await new SqliteGraphWriter(graph).writeFileGraph("a", result(), []);
  const expectedEdges = rows(graph, "edges");
  const expectedRefs = rows(graph, "pending_refs");
  graph.close();
  const reopened = GraphDatabase.open(path);
  t.after(() => reopened.close());
  assert.deepEqual(rows(reopened, "edges"), expectedEdges);
  assert.deepEqual(rows(reopened, "pending_refs"), expectedRefs);
  await new SqliteGraphWriter(reopened).deleteFileGraph("a", []);
  reopened.close();
  const afterDelete = GraphDatabase.open(path);
  t.after(() => afterDelete.close());
  assert.deepEqual(rows(afterDelete, "edges"), []);
  assert.deepEqual(rows(afterDelete, "pending_refs"), []);
});

test("delete removes only file-owned rows of every kind and status and is idempotent", async (t) => {
  const { graph, writer } = setup(t);
  const fileId = "a'quoted?";
  await writer.writeFileGraph(
    fileId,
    result(
      ["contains", "calls", "imports", "extends", "implements"].map((kind) =>
        edge({ kind }),
      ),
      [ref(), ref(), ref()],
    ),
    [],
  );
  await writer.writeFileGraph(
    "b",
    result(
      [edge({ source: "b:caller", target: "b:callee" })],
      [ref({ ownerId: "b:caller", refName: "callee" })],
    ),
    [],
  );
  const otherEdges = rows(graph, "edges").filter((row) => row.file_id === "b");
  const otherRefs = rows(graph, "pending_refs").filter(
    (row) => row.file_id === "b",
  );
  graph.connection
    .prepare(
      "UPDATE pending_refs SET status = CASE id % 3 WHEN 0 THEN 'resolved' WHEN 1 THEN 'failed' ELSE 'pending' END WHERE file_id = ?",
    )
    .run(fileId);
  await writer.deleteFileGraph(fileId, []);
  assert.deepEqual(rows(graph, "edges"), otherEdges);
  assert.deepEqual(rows(graph, "pending_refs"), otherRefs);
  await writer.deleteFileGraph(fileId, []);
  await writer.deleteFileGraph("never-indexed", []);
  assert.deepEqual(rows(graph, "edges"), otherEdges);
  assert.deepEqual(rows(graph, "pending_refs"), otherRefs);
});

test("failed reference deletion restores previously deleted edges and permits retry", async (t) => {
  const { graph, writer } = setup(t);
  await writer.writeFileGraph("a", result(), []);
  const beforeEdges = rows(graph, "edges");
  const beforeRefs = rows(graph, "pending_refs");
  graph.connection.exec(`
    CREATE TRIGGER fail_ref_delete BEFORE DELETE ON pending_refs
    BEGIN SELECT RAISE(ABORT, 'injected delete failure'); END;
  `);
  await assert.rejects(
    writer.deleteFileGraph("a", []),
    /injected delete failure/,
  );
  assert.deepEqual(rows(graph, "edges"), beforeEdges);
  assert.deepEqual(rows(graph, "pending_refs"), beforeRefs);
  graph.connection.exec("DROP TRIGGER fail_ref_delete");
  await writer.deleteFileGraph("a", []);
  assert.deepEqual(rows(graph, "edges"), []);
  assert.deepEqual(rows(graph, "pending_refs"), []);
});

test("delete rejects invalid IDs, caller transactions and closed connections", async (t) => {
  const { graph, writer } = setup(t);
  await writer.writeFileGraph("a", result(), []);
  await assert.rejects(writer.deleteFileGraph("", []), /must not be empty/);
  await assert.rejects(writer.deleteFileGraph("  ", []), /must not be empty/);
  assert.equal(rows(graph, "edges").length, 1);
  assert.equal(rows(graph, "pending_refs").length, 1);
  graph.connection.exec("BEGIN; UPDATE edges SET target = 'uncommitted'");
  await assert.rejects(writer.deleteFileGraph("a", []), /transaction/i);
  assert.equal(rows(graph, "edges")[0].target, "uncommitted");
  graph.connection.exec("ROLLBACK");
  assert.equal(rows(graph, "edges")[0].target, "a:callee");
  graph.close();
  await assert.rejects(writer.deleteFileGraph("a", []), /closed/);
});
