import assert from "node:assert/strict";
import test from "node:test";
import { GraphDatabase } from "../../dist/engine/graph/persistence/sqlite/database.js";
import { SqliteGraphReader } from "../../dist/engine/graph/persistence/sqlite/reader.js";
import { SqliteGraphWriter } from "../../dist/engine/graph/persistence/sqlite/writer.js";

import { localGraph, graphNode } from "../helpers/graph-fixtures.mjs";

function edge(source, target, kind = "calls", extra = {}) {
  return {
    kind,
    source,
    target,
    line: 1,
    column: 0,
    provenance: "file_local",
    metadata: {},
    ...extra,
  };
}

async function setup(t, edges = []) {
  const database = GraphDatabase.open(":memory:");
  t.after(() => database.close());
  const writer = new SqliteGraphWriter(database);
  await writer.writeFileGraph("owner", localGraph(edges, [], "owner"), []);
  return { database, writer, reader: new SqliteGraphReader(database) };
}

test("neighborhood honors direction, stays one hop and emits self edges once", async (t) => {
  const outgoing = edge("focus", "child");
  const incoming = edge("parent", "focus");
  const self = edge("focus", "focus");
  const secondHop = edge("child", "grandchild");
  const { reader } = await setup(t, [outgoing, incoming, self, secondHop]);
  assert.deepEqual(
    await reader.neighborhood({ id: "focus", direction: "out" }),
    [outgoing, self],
  );
  assert.deepEqual(
    await reader.neighborhood({ id: "focus", direction: "in" }),
    [incoming, self],
  );
  assert.deepEqual(await reader.neighborhood({ id: "focus" }), [
    outgoing,
    incoming,
    self,
  ]);
  assert.deepEqual(await reader.neighborhood({ id: "unknown" }), []);
});

test("kind filters support all, multiple, duplicate and empty kinds", async (t) => {
  const kinds = ["contains", "calls", "imports", "extends", "implements"];
  const edges = kinds.map((kind) => edge("focus", "target", kind));
  const { reader } = await setup(t, edges);
  assert.deepEqual(await reader.neighborhood({ id: "focus" }), edges);
  assert.deepEqual(
    await reader.neighborhood({
      id: "focus",
      kinds: ["calls", "contains", "calls"],
    }),
    edges.slice(0, 2),
  );
  assert.deepEqual(await reader.neighborhood({ id: "focus", kinds: [] }), []);
});

test("reader preserves metadata, nulls, provenance and distinct call sites", async (t) => {
  const id = "file' OR 1=1 -- ?";
  const edges = [
    edge(id, "target", "calls", {
      line: null,
      column: null,
      provenance: "file_local",
      metadata: { text: "调用", nested: { args: [1, null] } },
    }),
    edge(id, "target", "calls", {
      line: 10,
      metadata: { receiverName: "other" },
    }),
  ];
  const { reader } = await setup(t, [...edges, edge("unrelated", "elsewhere")]);
  assert.deepEqual(await reader.neighborhood({ id }), edges);
});

test("endpoint queries exclude file-owned entity edges and pending references", async (t) => {
  const { writer, reader } = await setup(t);
  const imported = edge("file", "dependency", "imports");
  const called = edge("file:function", "target");
  await writer.writeFileGraph(
    "file",
    {
      nodes: ["dependency", "file:function", "target"].map(graphNode),
      edges: [imported, called],
      pendingRefs: [
        {
          ownerId: "file",
          refName: "unresolved",
          receiverName: null,
          refKind: "imports",
          arity: null,
          line: 1,
          column: 0,
          status: "pending",
          metadata: {},
        },
      ],
    },
    [],
  );
  assert.deepEqual(await reader.neighborhood({ id: "file" }), [imported]);
  assert.deepEqual(await reader.neighborhood({ id: "file:function" }), [
    called,
  ]);
});

test("queries validate directions, kinds, IDs and connection lifetime", async (t) => {
  const { database, reader } = await setup(t);
  await assert.rejects(
    reader.neighborhood({ id: "focus", direction: "sideways" }),
    /direction/,
  );
  await assert.rejects(
    reader.neighborhood({ id: "focus", kinds: ["unknown"] }),
    /edge kind/,
  );
  await assert.rejects(reader.neighborhood({ id: "  " }), /must not be empty/);
  database.close();
  await assert.rejects(reader.neighborhood({ id: "focus" }), /closed/);
});

test("neighborhood returns all matches without truncation", async (t) => {
  const edges = Array.from({ length: 1002 }, (_, index) =>
    edge("focus", `target:${index}`),
  );
  const { reader } = await setup(t, edges);
  assert.deepEqual(await reader.neighborhood({ id: "focus" }), edges);
});

const specializedQueries = [
  ["getCallers", "in", "calls"],
  ["getCallees", "out", "calls"],
  ["getImports", "owner", "imports"],
  ["getInheritance", "out", "extends"],
  ["getSubclasses", "in", "extends"],
  ["getImplementations", "in", "implements"],
];

for (const [method, direction, kind] of specializedQueries) {
  test(`${method} filters relations and returns all matches without truncation`, async (t) => {
    const expected = Array.from({ length: 1002 }, (_, index) =>
      direction === "in"
        ? edge(`caller:${index}`, "focus", kind)
        : edge("focus", `target:${index}`, kind),
    );
    const wrongKind = edge("focus", "focus", "contains");
    const reverse =
      direction === "in"
        ? edge("focus", "reverse", kind)
        : edge("reverse", "focus", kind);
    const { reader, writer } = await setup(t, [
      ...expected,
      wrongKind,
      ...(direction === "owner" ? [] : [reverse]),
    ]);
    const id = direction === "owner" ? "owner" : "focus";
    if (direction === "owner") {
      // Matching the file ID as source must not include another file's rows.
      await writer.writeFileGraph(
        "other-file",
        localGraph([edge("owner", "foreign", "imports")], [], "other-file"),
        [],
      );
    }
    assert.deepEqual(await reader[method](id), expected);
    assert.deepEqual(await reader[method]("missing"), []);
    await assert.rejects(reader[method]("  "), /must not be empty/);
  });
}
