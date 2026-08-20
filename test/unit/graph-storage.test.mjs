import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SqliteGraphStorage,
  fileGraphFromFragments,
  makeRefId,
  rawRef,
} from "../../dist/engine/graph/index.js";

test("SQLite graph upsert resolves callers and reattaches incoming edges", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "zvec-grep-graph-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const graph = new SqliteGraphStorage(dir);

  graph.upsertFileGraph(
    "file-a",
    [{ id: "sym-a", kind: "function", is_exported: true, name: "caller" }],
    [],
    [rawRef({ owner: "sym-a", refName: "callee", line: 10 })],
  );
  graph.upsertFileGraph(
    "file-b",
    [{ id: "sym-b", kind: "function", is_exported: true, name: "callee" }],
    [],
    [],
  );

  await graph.resolvePending();

  assert.deepEqual(
    graph.callees("sym-a", 1, 10).map((s) => s.id),
    ["sym-b"],
  );
  assert.deepEqual(
    graph.callers("sym-b", 1, 10).map((s) => s.id),
    ["sym-a"],
  );
  assert.equal(graph.stats().refCount, 0);
  assert.equal(graph.stats().callsCount, 1);

  // Reindex target file with a new symbol id; incoming edge must revive via ref_name.
  graph.upsertFileGraph(
    "file-b",
    [{ id: "sym-b2", kind: "function", is_exported: true, name: "callee" }],
    [],
    [],
  );
  assert.equal(graph.stats().callsCount, 0);
  assert.ok(graph.stats().refCount >= 1);

  await graph.resolvePending();
  assert.deepEqual(
    graph.callers("sym-b2", 1, 10).map((s) => s.id),
    ["sym-a"],
  );

  graph.close();

  const reopened = new SqliteGraphStorage(dir, { readOnly: true });
  assert.deepEqual(
    reopened.callers("sym-b2", 1, 10).map((s) => s.id),
    ["sym-a"],
  );
  reopened.close();
});

test("external refs are dropped without creating edges", async () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "file-a",
    [{ id: "sym-a", kind: "function", is_exported: true, name: "run" }],
    [],
    [rawRef({ owner: "sym-a", refName: "console", line: 1 })],
  );
  await graph.resolvePending();
  assert.equal(graph.stats().callsCount, 0);
  assert.equal(graph.stats().refCount, 0);
  graph.close();
});

test("raw incoming/outgoing edge queries are batch-capable and drive traversal", () => {
  class TrackingGraph extends SqliteGraphStorage {
    outgoingCalls = 0;
    incomingCalls = 0;
    outgoingEdges(...args) {
      this.outgoingCalls++;
      return super.outgoingEdges(...args);
    }
    incomingEdges(...args) {
      this.incomingCalls++;
      return super.incomingEdges(...args);
    }
  }
  const graph = new TrackingGraph("", { inMemory: true });
  graph.upsertFileGraph(
    "f",
    [
      { id: "a", kind: "function", is_exported: true, name: "a" },
      { id: "b", kind: "function", is_exported: true, name: "b" },
      { id: "c", kind: "class", is_exported: true, name: "c" },
    ],
    [
      {
        src: "a",
        dst: "b",
        kind: "CALLS",
        rel: "call",
        count: 2,
        first_line: 3,
        ref_name: "b",
      },
      {
        src: "b",
        dst: "c",
        kind: "REFS",
        rel: "type",
        count: 1,
        first_line: 5,
        ref_name: "c",
      },
    ],
    [],
  );

  assert.deepEqual(
    graph
      .outgoingEdges(["a", "b"], ["CALLS", "REFS"])
      .map((edge) => [edge.src, edge.dst, edge.kind]),
    [
      ["a", "b", "CALLS"],
      ["b", "c", "REFS"],
    ],
  );
  assert.deepEqual(graph.incomingEdges(["b"], ["CALLS"])[0], {
    src: "a",
    dst: "b",
    kind: "CALLS",
    rel: "call",
    count: 2,
    first_line: 3,
    ref_name: "b",
  });

  const outgoingBefore = graph.outgoingCalls;
  const incomingBefore = graph.incomingCalls;
  assert.deepEqual(
    graph
      .traverse("a", {
        edgeKinds: ["CALLS", "REFS"],
        direction: "both",
        maxDepth: 2,
        limit: 10,
      })
      .map((item) => item.id),
    ["b", "c"],
  );
  assert.ok(graph.outgoingCalls > outgoingBefore);
  assert.ok(graph.incomingCalls > incomingBefore);
  graph.close();
});

test("openGraphStorage respects the off backend", async () => {
  const { openGraphStorage } = await import("../../dist/engine/graph/index.js");
  const off = openGraphStorage("/tmp/unused-graph-off", { backend: "off" });
  assert.equal(off.available, false);
  assert.deepEqual(off.callers("x", 1, 10), []);
});

test("SQLite is the default persistent backend and reopens read-only", async (t) => {
  const { openGraphStorage } = await import("../../dist/engine/graph/index.js");
  const dir = await mkdtemp(join(tmpdir(), "zvec-grep-graph-sqlite-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const graph = openGraphStorage(dir);
  assert.equal(graph.constructor.name, "SqliteGraphStorage");
  assert.equal(graph instanceof SqliteGraphStorage, true);
  graph.upsertFileGraph(
    "f",
    [
      { id: "a", kind: "function", is_exported: true, name: "a" },
      { id: "b", kind: "function", is_exported: true, name: "b" },
    ],
    [
      {
        src: "a",
        dst: "b",
        kind: "CALLS",
        rel: "call",
        count: 2,
        first_line: 4,
        ref_name: "b",
      },
    ],
    [],
  );
  graph.close();
  await access(join(dir, "graph.sqlite"));

  const reopened = openGraphStorage(dir, { readOnly: true });
  assert.equal(reopened.constructor.name, "SqliteGraphStorage");
  assert.equal(reopened.stats().callsCount, 1);
  assert.deepEqual(reopened.callees("a", 1, 10), [
    { id: "b", kind: "function", count: 2 },
  ]);
  reopened.close();
});

test("SQLite queries and incrementally rebuilds graph data without a full-memory mirror", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "zvec-grep-graph-direct-sqlite-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const graph = new SqliteGraphStorage(dir);
  graph.upsertFileGraph(
    "file-a",
    [{ id: "caller", kind: "function", is_exported: true, name: "caller" }],
    [],
    [rawRef({ owner: "caller", refName: "target", line: 4 })],
  );
  graph.upsertFileGraph(
    "file-b",
    [
      { id: "target", kind: "function", is_exported: true, name: "target" },
      { id: "leaf", kind: "function", is_exported: false, name: "leaf" },
    ],
    [
      {
        src: "target",
        dst: "leaf",
        kind: "CALLS",
        rel: "call",
        count: 1,
        first_line: 8,
        ref_name: "leaf",
      },
    ],
    [],
  );
  await graph.resolvePending();

  assert.deepEqual(
    graph.callees("caller", 2, 10).map((item) => item.id),
    ["target", "leaf"],
  );
  assert.deepEqual(
    graph
      .edges(["caller", "target", "leaf"], ["CALLS"])
      .map((edge) => [edge.src, edge.dst]),
    [
      ["caller", "target"],
      ["target", "leaf"],
    ],
  );
  assert.deepEqual(
    graph.outgoingEdges(["caller"], ["CALLS"]).map((edge) => edge.dst),
    ["target"],
  );
  assert.deepEqual(
    graph.incomingEdges(["leaf"], ["CALLS"]).map((edge) => edge.src),
    ["target"],
  );

  graph.upsertFileGraph(
    "file-b",
    [{ id: "target-v2", kind: "function", is_exported: true, name: "target" }],
    [],
    [],
  );
  assert.equal(graph.stats().callsCount, 0);
  await graph.resolvePending();
  assert.deepEqual(graph.callers("target-v2", 1, 10), [
    { id: "caller", kind: "function" },
  ]);
  await graph.checkpoint();
  graph.close();

  const reopened = new SqliteGraphStorage(dir, { readOnly: true });
  assert.deepEqual(reopened.callers("target-v2", 1, 10), [
    { id: "caller", kind: "function" },
  ]);
  reopened.close();
});

test("fileGraphFromFragments builds symbols and contains edges", () => {
  const input = fileGraphFromFragments("f1", [
    {
      id: "class-1",
      fileId: "f1",
      range: {
        kind: "text",
        startLine: 1,
        endLine: 20,
        startOffset: 0,
        endOffset: 20,
      },
      content: { kind: "text", text: "class Foo {}" },
      metadata: {
        kind: "code",
        symbolType: "class",
        symbolName: "Foo",
        scope: null,
        nodeType: "class_declaration",
        signature: "class Foo",
        doc: null,
        modifiers: ["exported"],
      },
    },
    {
      id: "method-1",
      fileId: "f1",
      range: {
        kind: "text",
        startLine: 3,
        endLine: 5,
        startOffset: 30,
        endOffset: 40,
      },
      content: { kind: "text", text: "bar() {}" },
      metadata: {
        kind: "code",
        symbolType: "function",
        symbolName: "bar",
        scope: "Foo",
        nodeType: "method_definition",
        signature: "bar()",
        doc: null,
        modifiers: [],
      },
    },
  ]);

  assert.equal(input.nodes.length, 2);
  assert.equal(input.edges.length, 1);
  assert.equal(input.edges[0].kind, "CONTAINS");
  assert.equal(input.edges[0].src, "class-1");
  assert.equal(input.edges[0].dst, "method-1");
  assert.equal(makeRefId("a", "b", "call", 1).includes("#"), true);
  assert.notEqual(
    makeRefId("a", "b", "call", 1, 0),
    makeRefId("a", "b", "call", 1, 1),
  );
});
