import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GraphDatabase } from "../../dist/engine/graph/persistence/sqlite/database.js";
import { SqliteGraphWriter } from "../../dist/engine/graph/persistence/sqlite/writer.js";
import { SqliteGraphReader } from "../../dist/engine/graph/persistence/sqlite/reader.js";
import { SqlitePendingRefStore } from "../../dist/engine/graph/persistence/sqlite/pending-ref-resolver.js";
import { graphNode } from "../helpers/graph-fixtures.mjs";

const localEdge = {
  kind: "calls",
  source: "a:foo",
  target: "a:helper",
  line: 1,
  column: 0,
  provenance: "file_local",
  metadata: {},
};
function reference(overrides = {}) {
  return {
    ownerId: "a:foo",
    refName: "bar",
    receiverName: null,
    refKind: "calls",
    arity: 0,
    line: 2,
    column: 4,
    status: "pending",
    metadata: { rawText: "bar", evidence: ["source"] },
    ...overrides,
  };
}
function source(refs = [reference()]) {
  return {
    nodes: ["a:foo", "a:helper"].map(graphNode),
    edges: [localEdge],
    pendingRefs: refs,
  };
}
function target(id = "b:bar") {
  return { nodes: [graphNode(id)], edges: [], pendingRefs: [] };
}
function services(db) {
  return {
    db,
    writer: new SqliteGraphWriter(db),
    reader: new SqliteGraphReader(db),
    refs: new SqlitePendingRefStore(db),
  };
}
async function setup(t) {
  const state = services(GraphDatabase.open(":memory:"));
  t.after(() => state.db.close());
  await state.writer.writeFileGraph("a", source(), []);
  await state.writer.writeFileGraph("b", target(), ["b:bar"]);
  return state;
}
function resolution(ref, targetId = "b:bar") {
  return {
    refId: ref.id,
    refToken: ref.token,
    targetId,
    provenance: "import_scoped",
  };
}
async function resolveOne(state) {
  const [pending] = (await state.refs.listPendingRefs()).refs;
  const match = await resolution(pending);
  assert.deepEqual(await state.refs.applyResolutions([match]), {
    resolved: 1,
    stale: 0,
  });
  return { pending, match };
}
function storedRefs(db) {
  return db.connection
    .prepare("SELECT * FROM pending_refs ORDER BY id")
    .all()
    .map((row) => ({ ...row }));
}

test("cross-file resolution appends a linked edge, preserves local edges and is replay-safe", async (t) => {
  const state = await setup(t);
  const { pending, match } = await resolveOne(state);
  const page = await state.reader.neighborhood({
    id: "a:foo",
    direction: "out",
  });
  assert.equal(page.length, 2);
  assert.deepEqual(page[0], localEdge);
  assert.deepEqual(page[1], {
    kind: "calls",
    source: "a:foo",
    target: "b:bar",
    line: 2,
    column: 4,
    provenance: "import_scoped",
    metadata: pending.metadata,
  });
  const stored = storedRefs(state.db)[0];
  assert.equal(stored.status, "resolved");
  assert.equal(stored.ref_name, "bar");
  assert.deepEqual(await state.refs.listPendingRefs(), { refs: [] });
  assert.deepEqual(await state.refs.applyResolutions([match]), {
    resolved: 0,
    stale: 1,
  });
  assert.equal((await state.reader.neighborhood({ id: "a:foo" })).length, 2);
});

test("target replacement invalidates unchanged IDs and permits rematching to a new entity", async (t) => {
  const state = await setup(t);
  const { pending, match } = await resolveOne(state);
  await state.writer.writeFileGraph(
    "c",
    {
      nodes: [graphNode("c:keep")],
      edges: [],
      pendingRefs: [],
    },
    [],
  );
  const cBefore = await state.reader.neighborhood({ id: "c:keep" });
  await state.writer.writeFileGraph("b", target(), ["b:bar"]);
  assert.deepEqual(await state.reader.neighborhood({ id: "a:foo" }), [
    localEdge,
  ]);
  const [requeued] = (await state.refs.listPendingRefs()).refs;
  assert.equal(requeued.id, pending.id);
  assert.notEqual(requeued.token, pending.token);
  assert.deepEqual(requeued, { ...pending, token: requeued.token });
  assert.deepEqual(await state.refs.applyResolutions([match]), {
    resolved: 0,
    stale: 1,
  });
  assert.deepEqual(await state.reader.neighborhood({ id: "c:keep" }), cBefore);
  await state.writer.writeFileGraph("b", target("b:new"), ["b:bar"]);
  const newMatch = await resolution(requeued, "b:new");
  assert.deepEqual(await state.refs.applyResolutions([newMatch]), {
    resolved: 1,
    stale: 0,
  });
  assert.equal(
    (await state.reader.neighborhood({ id: "b:new", direction: "in" }))[0]
      .source,
    "a:foo",
  );
});

test("target deletion removes incoming edges, retains evidence and rejects old results after recreation", async (t) => {
  const state = await setup(t);
  const { match } = await resolveOne(state);
  await state.writer.deleteFileGraph("b", ["b:bar"]);
  assert.deepEqual(await state.reader.neighborhood({ id: "b:bar" }), []);
  assert.equal((await state.refs.listPendingRefs()).refs[0].refName, "bar");
  await state.writer.writeFileGraph("b", target(), ["b:bar"]);
  assert.deepEqual(await state.refs.applyResolutions([match]), {
    resolved: 0,
    stale: 1,
  });
  await resolveOne(state);
});

test("source replacement cannot accept stale resolutions even when SQLite reuses reference IDs", async (t) => {
  const state = await setup(t);
  const [oldRef] = (await state.refs.listPendingRefs()).refs;
  const oldMatch = await resolution(oldRef);
  const bBefore = await state.reader.neighborhood({ id: "b:bar" });
  await state.writer.writeFileGraph(
    "a",
    source([reference({ refName: "different" })]),
    [],
  );
  const [newRef] = (await state.refs.listPendingRefs()).refs;
  assert.notEqual(newRef.token, oldRef.token);
  assert.deepEqual(await state.refs.applyResolutions([oldMatch]), {
    resolved: 0,
    stale: 1,
  });
  await resolveOne(state);
  await state.writer.deleteFileGraph("a", ["a:foo", "a:helper"]);
  assert.deepEqual(await state.reader.neighborhood({ id: "b:bar" }), []);
  assert.deepEqual(await state.reader.neighborhood({ id: "b:bar" }), bBefore);
  assert.deepEqual(await state.refs.listPendingRefs(), { refs: [] });
});

test("resolution accepts caller-validated target IDs without storing node metadata", async (t) => {
  const state = await setup(t);
  const [ref] = (await state.refs.listPendingRefs()).refs;
  // Target validation is a pipeline responsibility; SQLite holds no node catalog.
  assert.deepEqual(
    await state.refs.applyResolutions([resolution(ref, "external:entity")]),
    { resolved: 1, stale: 0 },
  );
  assert.equal(
    (await state.reader.neighborhood({ id: "external:entity" }))[0].source,
    "a:foo",
  );
  await state.writer.deleteFileGraph("external-file", ["external:entity"]);
  assert.equal((await state.refs.listPendingRefs()).refs.length, 1);
});

test("distinct call sites and file imports resolve without losing evidence", async (t) => {
  const state = await setup(t);
  await state.writer.writeFileGraph(
    "a",
    source([
      reference(),
      reference({ line: 7, receiverName: "obj" }),
      reference({
        ownerId: "a",
        refKind: "imports",
        refName: "./b",
        arity: null,
      }),
    ]),
    [],
  );
  const pending = (await state.refs.listPendingRefs()).refs;
  const matches = await Promise.all(
    pending.map((ref, i) => resolution(ref, i === 2 ? "b" : "b:bar")),
  );
  matches[1].provenance = "workspace_unique";
  matches[2].provenance = "preferred_file";
  assert.deepEqual(await state.refs.applyResolutions(matches), {
    resolved: 3,
    stale: 0,
  });
  assert.equal(
    (await state.reader.neighborhood({ id: "b:bar", direction: "in" })).length,
    2,
  );
  assert.equal(
    (await state.reader.neighborhood({ id: "a", kinds: ["imports"] }))[0]
      .target,
    "b",
  );
  await state.writer.deleteFileGraph("b", ["b:bar"]);
  assert.equal((await state.refs.listPendingRefs()).refs.length, 3);
  assert.deepEqual(
    await state.reader.neighborhood({ id: "a", kinds: ["imports"] }),
    [],
  );
});

test("failed target replacement rolls back incoming edges and reference evidence", async (t) => {
  const state = await setup(t);
  await resolveOne(state);
  const refsBefore = storedRefs(state.db);
  const edgesBefore = await state.reader.neighborhood({ id: "a:foo" });
  const invalid = target("b:new");
  const circular = {};
  circular.self = circular;
  invalid.edges.push({
    ...localEdge,
    source: "b:new",
    target: "b:new",
    metadata: circular,
  });
  await assert.rejects(
    state.writer.writeFileGraph("b", invalid, ["b:bar"]),
    /circular/i,
  );
  assert.deepEqual(storedRefs(state.db), refsBefore);
  assert.deepEqual(
    await state.reader.neighborhood({ id: "a:foo" }),
    edgesBefore,
  );
  // Failure during deletion must restore the inbound edge and its resolved status too.
  state.db.connection
    .exec(`CREATE TRIGGER fail_graph_delete BEFORE DELETE ON edges
    WHEN old.target = 'b:bar' BEGIN SELECT RAISE(ABORT, 'delete failed'); END`);
  await assert.rejects(
    state.writer.deleteFileGraph("b", ["b:bar"]),
    /delete failed/,
  );
  assert.deepEqual(storedRefs(state.db), refsBefore);
  assert.deepEqual(
    await state.reader.neighborhood({ id: "a:foo" }),
    edgesBefore,
  );
});

test("resolution batches roll back both inserted edges and reference states on failure", async (t) => {
  const state = await setup(t);
  await state.writer.writeFileGraph(
    "a",
    source([reference(), reference({ line: 8 })]),
    [],
  );
  const pending = (await state.refs.listPendingRefs()).refs;
  const matches = await Promise.all(pending.map((ref) => resolution(ref)));
  state.db.connection
    .exec(`CREATE TRIGGER fail_second_resolution BEFORE INSERT ON edges
    WHEN new.ref_id IS NOT NULL AND new.line = 8 BEGIN SELECT RAISE(ABORT, 'resolution failed'); END`);
  await assert.rejects(
    state.refs.applyResolutions(matches),
    /resolution failed/,
  );
  assert.deepEqual(await state.reader.neighborhood({ id: "a:foo" }), [
    localEdge,
  ]);
  assert.deepEqual((await state.refs.listPendingRefs()).refs, pending);
  state.db.connection.exec("DROP TRIGGER fail_second_resolution");
  assert.deepEqual(await state.refs.applyResolutions(matches), {
    resolved: 2,
    stale: 0,
  });
});

test("pending reference pages are bounded and file snapshots reject unsafe direct edges", async (t) => {
  const state = await setup(t);
  await state.writer.writeFileGraph(
    "a",
    source([reference(), reference({ line: 5 }), reference({ line: 6 })]),
    [],
  );
  const first = await state.refs.listPendingRefs({ limit: 2 });
  const last = await state.refs.listPendingRefs({
    limit: 2,
    cursor: first.nextCursor,
  });
  assert.equal(first.refs.length, 2);
  assert.equal(last.refs.length, 1);
  assert.equal(last.nextCursor, undefined);
  await assert.rejects(state.refs.listPendingRefs({ limit: 1001 }), /limit/);
  await assert.rejects(state.refs.listPendingRefs({ cursor: -1 }), /cursor/);
  const bad = source();
  bad.edges = [{ ...localEdge, target: "b:bar" }];
  await assert.rejects(
    state.writer.writeFileGraph("a", bad, []),
    /only local edges/,
  );
  bad.edges = [{ ...localEdge, provenance: "import_scoped" }];
  await assert.rejects(
    state.writer.writeFileGraph("a", bad, []),
    /only local edges/,
  );
  await assert.rejects(
    state.writer.writeFileGraph(
      "a",
      source([reference({ status: "resolved" })]),
      [],
    ),
    /pending references/,
  );
});

test("cross-file ownership and invalidation survive restart and another connection", async (t) => {
  const path = await mkdtemp(join(tmpdir(), "zvec-cross-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  const dbPath = join(path, "graph.sqlite");
  const first = services(GraphDatabase.open(dbPath));
  t.after(() => first.db.close());
  await first.writer.writeFileGraph("a", source(), []);
  await first.writer.writeFileGraph("b", target(), []);
  await resolveOne(first);
  first.db.close();
  const reopened = services(GraphDatabase.open(dbPath));
  t.after(() => reopened.db.close());
  const other = services(GraphDatabase.open(dbPath));
  t.after(() => other.db.close());
  await other.writer.deleteFileGraph("b", ["b:bar"]);
  assert.equal((await reopened.refs.listPendingRefs()).refs.length, 1);
  assert.deepEqual(await reopened.reader.neighborhood({ id: "a:foo" }), [
    localEdge,
  ]);
});

test("large old-ID lists invalidate entity and file targets atomically across batches", async (t) => {
  const state = await setup(t);
  const oldEntityIds = Array.from({ length: 1501 }, (_, i) => `b:old:${i}`);
  await state.writer.writeFileGraph(
    "a",
    source([
      reference(),
      reference({ line: 3 }),
      reference({ line: 4 }),
      reference({ ownerId: "a", refKind: "imports", refName: "./b" }),
    ]),
    ["a:foo", "a:helper"],
  );
  const pending = (await state.refs.listPendingRefs()).refs;
  const targets = [oldEntityIds[0], oldEntityIds[500], oldEntityIds[1500], "b"];
  await state.refs.applyResolutions(
    pending.map((ref, i) => resolution(ref, targets[i])),
  );
  const beforeEdges = state.db.connection
    .prepare("SELECT * FROM edges ORDER BY id")
    .all();
  const beforeRefs = storedRefs(state.db);
  state.db.connection
    .exec(`CREATE TRIGGER fail_last_batch BEFORE DELETE ON edges
    WHEN old.target = 'b:old:1500' BEGIN SELECT RAISE(ABORT, 'late batch failure'); END`);
  await assert.rejects(
    state.writer.deleteFileGraph("b", oldEntityIds),
    /late batch failure/,
  );
  assert.deepEqual(
    state.db.connection.prepare("SELECT * FROM edges ORDER BY id").all(),
    beforeEdges,
  );
  assert.deepEqual(storedRefs(state.db), beforeRefs);
  state.db.connection.exec("DROP TRIGGER fail_last_batch");
  await state.writer.deleteFileGraph("b", [
    ...oldEntityIds,
    ...oldEntityIds,
    "b",
  ]);
  assert.deepEqual(await state.reader.neighborhood({ id: "a:foo" }), [
    localEdge,
  ]);
  assert.deepEqual(
    await state.reader.neighborhood({ id: "a", kinds: ["imports"] }),
    [],
  );
  assert.equal((await state.refs.listPendingRefs()).refs.length, 4);
});

test("file operations require an explicit old-ID list before modifying any rows", async (t) => {
  const state = await setup(t);
  await resolveOne(state);
  const before = await state.reader.neighborhood({ id: "a:foo" });
  for (const ids of [undefined, null, "b:bar", [""], [42]]) {
    await assert.rejects(
      state.writer.deleteFileGraph("b", ids),
      /oldEntityIds/,
    );
    await assert.rejects(
      state.writer.writeFileGraph("b", target(), ids),
      /oldEntityIds/,
    );
  }
  await assert.rejects(
    state.writer.writeFileGraph("b", target()),
    /oldEntityIds/,
  );
  assert.deepEqual(await state.reader.neighborhood({ id: "a:foo" }), before);
});
