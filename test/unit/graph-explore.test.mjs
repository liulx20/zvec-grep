import assert from "node:assert/strict";
import test from "node:test";
import {
  SqliteGraphStorage,
  exploreGraph,
  exploreSubgraph,
  queryGraphNeighborhood,
} from "../../dist/engine/graph/index.js";
import { isLowValuePath } from "../../dist/engine/graph/path-policy.js";
import {
  matchesExactSymbolQuery,
  preferExactSymbolCase,
} from "../../dist/engine/graph/symbol-lookup.js";
import {
  queryTargetsPath,
  resolveExactExploreSeedGroups,
  resolveExploreSeeds,
} from "../../dist/engine/graph/explore/policy.js";
import { includeBlastRadiusNodes } from "../../dist/engine/graph/explore/impact.js";
test("low-value path policy covers common test layouts across languages", () => {
  for (const path of [
    "test_worker.py",
    "conftest.py",
    "pkg/worker_test.go",
    "testdata/worker.go",
    "tests/worker.rs",
    "benches/worker.rs",
    "src/test/java/WorkerTest.java",
    "src/worker.spec.ts",
    "tests/worker_test.cc",
    "CHANGELOG.md",
    "_examples/router/README.md",
    "docs/router.rst",
  ]) {
    assert.equal(isLowValuePath(path), true, path);
  }
  for (const path of [
    "worker.py",
    "pkg/worker.go",
    "src/worker.rs",
    "src/main/java/Worker.java",
    "src/worker.ts",
    "src/worker.cc",
  ]) {
    assert.equal(isLowValuePath(path), false, path);
  }
});

test("explicit module queries can target a low-value subtree without opening unrelated noise", () => {
  assert.equal(
    queryTargetsPath("bthread", "third_party/brpc/src/bthread/mutex.cpp"),
    true,
  );
  assert.equal(
    queryTargetsPath("bthread", "third_party/brpc/tools/gdb_bthread_stack.py"),
    false,
  );
  assert.equal(
    queryTargetsPath("database runtime", "third_party/re2/re2.cc"),
    false,
  );
});

test("exploreSubgraph expands and RWR-scores multiple seeds without context assembly", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "flow",
    [
      { id: "left", kind: "function", is_exported: true, name: "left" },
      { id: "bridge", kind: "function", is_exported: false, name: "bridge" },
      { id: "right", kind: "function", is_exported: true, name: "right" },
    ],
    [
      {
        src: "left",
        dst: "bridge",
        rel: "call",
        count: 1,
        first_line: 1,
        ref_name: "bridge",
        kind: "CALLS",
      },
      {
        src: "bridge",
        dst: "right",
        rel: "call",
        count: 1,
        first_line: 2,
        ref_name: "right",
        kind: "CALLS",
      },
    ],
    [],
  );
  const storage = storageFrom([
    entity("left", "left", "flow.ts"),
    entity("bridge", "bridge", "flow.ts"),
    entity("right", "right", "flow.ts"),
  ]);

  const result = exploreSubgraph(graph, storage, {
    seedIds: ["left", "right"],
    seedWeights: new Map([
      ["left", 9],
      ["right", 1],
    ]),
    traversalDepth: 2,
    maxNodes: 32,
    includeCallPaths: false,
  });

  assert.deepEqual(result.rootIds, ["left", "right"]);
  assert.ok(result.nodes.some((node) => node.id === "bridge"));
  assert.equal(result.callPaths.length, 0);
  assert.ok((result.nodeScores.get("bridge") ?? 0) > 0);
  assert.ok(
    (result.nodeScores.get("left") ?? 0) >
      (result.nodeScores.get("right") ?? 0),
  );
  graph.close();
});

test("exploreSubgraph bounds failed call-path attempts and edge reads", () => {
  class TrackingGraph extends SqliteGraphStorage {
    pathAttempts = 0;
    edgeBudget = 0;
    pathBetween(_from, _to, _depth, edgeLimit) {
      this.pathAttempts += 1;
      this.edgeBudget += edgeLimit;
      return null;
    }
  }
  const graph = new TrackingGraph("", { inMemory: true });
  const rootIds = Array.from({ length: 32 }, (_, index) => `isolated-${index}`);
  const storage = storageFrom(rootIds.map((id) => entity(id, id, `${id}.ts`)));

  const result = exploreSubgraph(graph, storage, {
    seedIds: rootIds,
    traversalDepth: 3,
    maxNodes: 16,
    includeCallPaths: true,
  });

  assert.equal(result.rootIds.length, 16);
  assert.ok(
    result.rootIds.every((id) => result.nodes.some((node) => node.id === id)),
  );
  assert.equal(graph.pathAttempts, 32);
  assert.ok(graph.edgeBudget <= 20_000);
  graph.close();
});

test("exploreSubgraph retains direct callers ahead of deep traversal nodes", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  const members = Array.from({ length: 5 }, (_, index) => `member-${index}`);
  const deep = Array.from({ length: 24 }, (_, index) => `deep-${index}`);
  const ids = ["root", "direct-caller", ...members, ...deep];
  graph.upsertFileGraph(
    "graph.ts",
    ids.map((id) => ({ id, kind: "function", is_exported: true, name: id })),
    [
      ...members.map((id) => ({
        src: "root",
        dst: id,
        rel: "contains",
        count: 1,
        first_line: 1,
        ref_name: id,
        kind: "CONTAINS",
      })),
      {
        src: "direct-caller",
        dst: "root",
        rel: "call",
        count: 1,
        first_line: 1,
        ref_name: "root",
        kind: "CALLS",
      },
      ...deep.map((id, index) => ({
        src: index === 0 ? "root" : deep[index - 1],
        dst: id,
        rel: "call",
        count: 1,
        first_line: 1,
        ref_name: id,
        kind: "CALLS",
      })),
    ],
    [],
  );
  const storage = storageFrom(
    ids.map((id) => entity(id, id, "graph.ts", { symbolType: "function" })),
  );

  const result = exploreSubgraph(graph, storage, {
    seedIds: ["root"],
    traversalDepth: 3,
    maxNodes: 16,
    includeCallPaths: false,
  });

  assert.ok(result.nodes.some((node) => node.id === "direct-caller"));
  assert.ok(result.nodes.length <= 16);
  graph.close();
});

test("type exploration retains structurally representative members instead of storage-order members", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  const accessors = Array.from(
    { length: 24 },
    (_, index) => `accessor-${index}`,
  );
  const helpers = Array.from({ length: 5 }, (_, index) => `helper-${index}`);
  graph.upsertFileGraph(
    "command.ts",
    [
      { id: "Command", kind: "class", is_exported: true, name: "Command" },
      {
        id: "orchestrate",
        kind: "function",
        is_exported: true,
        name: "orchestrate",
      },
      ...accessors.map((id) => ({
        id,
        kind: "function",
        is_exported: true,
        name: id,
      })),
      ...helpers.map((id) => ({
        id,
        kind: "function",
        is_exported: false,
        name: id,
      })),
    ],
    [
      ...["orchestrate", ...accessors].map((id) => ({
        src: "Command",
        dst: id,
        rel: "contains",
        count: 1,
        first_line: 1,
        ref_name: id,
        kind: "CONTAINS",
      })),
      ...helpers.map((id, index) => ({
        src: "orchestrate",
        dst: id,
        rel: "call",
        count: 1,
        first_line: index + 2,
        ref_name: id,
        kind: "CALLS",
      })),
    ],
    [],
  );
  const storage = storageFrom([
    entity("Command", "Command", "command.ts", { symbolType: "class" }),
    entity("orchestrate", "orchestrate", "command.ts", {
      symbolType: "function",
      startLine: 10,
      endLine: 90,
    }),
    ...accessors.map((id, index) =>
      entity(id, id, "command.ts", {
        symbolType: "function",
        startLine: 100 + index * 2,
        endLine: 100 + index * 2,
      }),
    ),
    ...helpers.map((id, index) =>
      entity(id, id, "command.ts", {
        symbolType: "function",
        startLine: 200 + index * 2,
        endLine: 200 + index * 2,
      }),
    ),
  ]);

  const result = exploreSubgraph(graph, storage, {
    seedIds: ["Command"],
    traversalDepth: 2,
    maxNodes: 16,
    includeCallPaths: false,
  });

  assert.ok(result.nodes.some((node) => node.id === "orchestrate"));
  graph.close();
});

test("exploreSubgraph samples derived types across files", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  const derived = Array.from({ length: 80 }, (_, index) => `derived-${index}`);
  const testConsumers = Array.from(
    { length: 40 },
    (_, index) => `test-consumer-${index}`,
  );
  graph.upsertFileGraph(
    "types",
    [{ id: "root-type", kind: "interface", is_exported: true, name: "Root" }],
    [],
    [],
  );
  for (const [fileId, ids] of [
    ["crowded", derived.slice(0, 78)],
    ["impl-78", [derived[78]]],
    ["impl-79", [derived[79]]],
  ]) {
    graph.upsertFileGraph(
      fileId,
      ids.map((id) => ({
        id,
        kind: "class",
        is_exported: true,
        name: id,
      })),
      ids.map((id) => ({
        src: id,
        dst: "root-type",
        rel: "implements",
        count: 1,
        first_line: 1,
        ref_name: "Root",
        kind: "INHERITS",
      })),
      [],
    );
  }
  graph.upsertFileGraph(
    "consumer",
    [
      {
        id: "root-consumer",
        kind: "class",
        is_exported: true,
        name: "RootConsumer",
      },
    ],
    [
      {
        src: "root-consumer",
        dst: "root-type",
        rel: "type",
        count: 1,
        first_line: 1,
        ref_name: "Root",
        kind: "REFS",
      },
    ],
    [],
  );
  graph.upsertFileGraph(
    "tests",
    testConsumers.map((id) => ({
      id,
      kind: "function",
      is_exported: false,
      name: id,
    })),
    testConsumers.map((id) => ({
      src: id,
      dst: "root-type",
      rel: "type",
      count: 1,
      first_line: 1,
      ref_name: "Root",
      kind: "REFS",
    })),
    [],
  );
  const storage = storageFrom([
    entity("root-type", "Root", "root.ts", { symbolType: "interface" }),
    entity("root-consumer", "RootConsumer", "consumer.ts", {
      symbolType: "class",
    }),
    ...testConsumers.map((id) =>
      entity(id, id, `tests/${id}.test.ts`, { symbolType: "function" }),
    ),
    ...derived.map((id, index) =>
      entity(id, id, index < 78 ? "crowded.ts" : `impl-${index}.ts`, {
        symbolType: "class",
      }),
    ),
  ]);

  const result = exploreSubgraph(graph, storage, {
    seedIds: ["root-type"],
    maxNodes: 32,
    includeCallPaths: false,
  });
  const files = new Set(
    result.nodes.map((node) => node.entity?.file.relativePath),
  );
  assert.ok(files.has("impl-78.ts"));
  assert.ok(files.has("impl-79.ts"));
  assert.ok(files.has("consumer.ts"));
  graph.close();
});

test("exploreSubgraph includes callers represented by dynamic dispatch candidates", () => {
  class DispatchGraph extends SqliteGraphStorage {
    dynamicBoundarySources(targetIds) {
      return targetIds.includes("impl-run") ? [{ id: "pipeline" }] : [];
    }
  }
  const graph = new DispatchGraph("", { inMemory: true });
  graph.upsertFileGraph(
    "graph",
    [
      { id: "contract", kind: "interface", is_exported: true, name: "Runner" },
      { id: "contract-run", kind: "method", is_exported: true, name: "run" },
      { id: "impl", kind: "class", is_exported: true, name: "Worker" },
      { id: "impl-run", kind: "method", is_exported: true, name: "run" },
      { id: "pipeline", kind: "method", is_exported: true, name: "execute" },
    ],
    [
      {
        src: "contract",
        dst: "contract-run",
        rel: "contains",
        count: 1,
        first_line: 1,
        ref_name: "run",
        kind: "CONTAINS",
      },
      {
        src: "impl",
        dst: "contract",
        rel: "implements",
        count: 1,
        first_line: 1,
        ref_name: "Runner",
        kind: "INHERITS",
      },
      {
        src: "impl",
        dst: "impl-run",
        rel: "contains",
        count: 1,
        first_line: 1,
        ref_name: "run",
        kind: "CONTAINS",
      },
    ],
    [],
  );
  const storage = storageFrom([
    entity("contract", "Runner", "runner.ts", { symbolType: "interface" }),
    entity("contract-run", "run", "runner.ts", { symbolType: "method" }),
    entity("impl", "Worker", "worker.ts", { symbolType: "class" }),
    entity("impl-run", "run", "worker.ts", { symbolType: "method" }),
    entity("pipeline", "execute", "pipeline.ts", { symbolType: "method" }),
  ]);

  const result = exploreSubgraph(graph, storage, {
    seedIds: ["contract"],
    maxNodes: 32,
    includeCallPaths: false,
  });
  assert.ok(result.nodes.some((node) => node.id === "pipeline"));
  graph.close();
});

test("explore reports truncated dynamic boundary output", () => {
  class BoundaryGraph extends SqliteGraphStorage {
    dynamicBoundaries(_ids, limit) {
      return Array.from({ length: limit }, (_, index) => ({
        sourceId: "root",
        target: { raw: `value.run${index}`, member: `run${index}` },
        reason: "polymorphic_dispatch",
        candidates: [`candidate-${index}`],
        candidatesTruncated: false,
        candidateDetails: [
          {
            targetId: `candidate-${index}`,
            reason: "hierarchy",
            confidence: 0.5,
          },
        ],
      }));
    }
  }
  const graph = new BoundaryGraph("", { inMemory: true });
  graph.upsertFileGraph(
    "root-file",
    [{ id: "root", kind: "function", is_exported: true, name: "root" }],
    [],
    [],
  );
  const storage = storageFrom([entity("root", "root", "root.ts")]);

  const result = exploreGraph(graph, storage, {
    query: "root",
    maxNodes: 16,
  });

  assert.equal(result.dynamicBoundaries.length, 16);
  assert.equal(result.dynamicBoundariesTruncated, true);
  graph.close();
});

test("explore aggregates repeated dynamic boundary occurrences", () => {
  class BoundaryGraph extends SqliteGraphStorage {
    dynamicBoundaries() {
      return Array.from({ length: 3 }, () => ({
        sourceId: "root",
        target: { raw: "value.run", member: "run" },
        reason: "polymorphic_dispatch",
        candidates: ["candidate"],
        candidatesTruncated: false,
        candidateDetails: [
          {
            targetId: "candidate",
            displayName: "Runner::run",
            reason: "hierarchy",
            confidence: 0.65,
          },
        ],
      }));
    }
  }
  const graph = new BoundaryGraph("", { inMemory: true });
  graph.upsertFileGraph(
    "root-file",
    [{ id: "root", kind: "function", is_exported: true, name: "root" }],
    [],
    [],
  );
  const result = exploreGraph(
    graph,
    storageFrom([entity("root", "root", "root.ts")]),
    { query: "root" },
  );
  assert.equal(result.dynamicBoundaries.length, 1);
  assert.equal(result.dynamicBoundaries[0]?.occurrenceCount, 3);
  graph.close();
});

test("explore only presents dynamic boundaries from selected source files", () => {
  class BoundaryGraph extends SqliteGraphStorage {
    dynamicBoundaries() {
      return [
        {
          sourceId: "peripheral",
          target: { raw: "value.run", member: "run" },
          reason: "polymorphic_dispatch",
          candidates: ["candidate"],
          candidatesTruncated: false,
          candidateDetails: [
            {
              targetId: "candidate",
              reason: "hierarchy",
              confidence: 0.65,
            },
          ],
        },
      ];
    }
  }
  const graph = new BoundaryGraph("", { inMemory: true });
  graph.upsertFileGraph(
    "root-file",
    [{ id: "root", kind: "function", is_exported: true, name: "root" }],
    [
      {
        src: "root",
        dst: "peripheral",
        kind: "CALLS",
        rel: "calls",
        count: 1,
        first_line: 1,
        ref_name: "peripheral",
      },
    ],
    [],
  );
  graph.upsertFileGraph(
    "peripheral-file",
    [
      {
        id: "peripheral",
        kind: "function",
        is_exported: true,
        name: "peripheral",
      },
      {
        id: "candidate",
        kind: "method",
        is_exported: true,
        name: "run",
      },
    ],
    [],
    [],
  );
  const result = exploreGraph(
    graph,
    storageFrom([
      entity("root", "root", "root.ts"),
      entity("peripheral", "peripheral", "peripheral.ts"),
      entity("candidate", "run", "candidate.ts", { symbolType: "method" }),
    ]),
    { query: "root", maxFiles: 1 },
  );

  assert.deepEqual(
    result.files.map((file) => file.file.relativePath),
    ["root.ts"],
  );
  assert.equal(result.dynamicBoundaries.length, 0);
  assert.equal(result.dynamicBoundariesTruncated, true);
  graph.close();
});

test("explore hides candidate-less receiver boundaries", () => {
  class BoundaryGraph extends SqliteGraphStorage {
    dynamicBoundaries(_ids, limit) {
      return Array.from({ length: limit }, (_, index) => ({
        sourceId: "root",
        target: { raw: `value.run${index}`, member: `run${index}` },
        reason:
          index === limit - 1
            ? "polymorphic_dispatch"
            : "unknown_receiver_type",
        candidates: index === limit - 1 ? ["implementation"] : [],
        candidatesTruncated: false,
        candidateDetails:
          index === limit - 1
            ? [
                {
                  targetId: "implementation",
                  reason: "hierarchy",
                  confidence: 0.5,
                },
              ]
            : [],
      }));
    }
  }
  const graph = new BoundaryGraph("", { inMemory: true });
  graph.upsertFileGraph(
    "root-file",
    [{ id: "root", kind: "function", is_exported: true, name: "root" }],
    [],
    [],
  );
  const result = exploreGraph(
    graph,
    storageFrom([entity("root", "root", "root.ts")]),
    { query: "root", maxNodes: 16 },
  );

  assert.equal(
    result.dynamicBoundaries.some(
      (boundary) => boundary.reason === "unknown_receiver_type",
    ),
    false,
  );
  assert.equal(
    result.dynamicBoundaries.some(
      (boundary) => boundary.reason === "polymorphic_dispatch",
    ),
    true,
  );
  assert.equal(result.dynamicBoundariesTruncated, true);
  graph.close();
});

test("exploreSubgraph drops call paths that exceed the retained node budget", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  const rootIds = Array.from({ length: 16 }, (_, index) => `root-${index}`);
  graph.upsertFileGraph(
    "paths",
    [
      ...rootIds.map((id) => ({
        id,
        kind: "function",
        is_exported: true,
        name: id,
      })),
      { id: "bridge", kind: "function", is_exported: false, name: "bridge" },
    ],
    [
      {
        src: rootIds[0],
        dst: "bridge",
        rel: "call",
        count: 1,
        first_line: 1,
        ref_name: "bridge",
        kind: "CALLS",
      },
      {
        src: "bridge",
        dst: rootIds[1],
        rel: "call",
        count: 1,
        first_line: 2,
        ref_name: rootIds[1],
        kind: "CALLS",
      },
    ],
    [],
  );
  const storage = storageFrom([
    ...rootIds.map((id) => entity(id, id, "paths.ts")),
    entity("bridge", "bridge", "paths.ts"),
  ]);
  const result = exploreSubgraph(graph, storage, {
    seedIds: rootIds,
    maxNodes: 16,
    includeCallPaths: true,
  });
  const retained = new Set(result.nodes.map((node) => node.id));
  assert.equal(result.nodes.length, 16);
  assert.equal(retained.has("bridge"), false);
  assert.equal(result.callPaths.length, 0);
  assert.ok(
    result.callPaths.every((path) =>
      path.nodes.every((id) => retained.has(id)),
    ),
  );
  graph.close();
});

test("explore maxChars is a hard source-text budget", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "large",
    [
      {
        id: "large-symbol",
        kind: "function",
        is_exported: true,
        name: "large",
      },
    ],
    [],
    [],
  );
  const storage = storageFrom([
    entity("large-symbol", "large", "large.ts", {
      symbolType: "function",
      text: `export function large() {\n${"x".repeat(8_000)}\n}`,
    }),
  ]);
  const result = exploreGraph(graph, storage, {
    query: "large",
    maxChars: 1_000,
    maxFiles: 1,
  });
  assert.ok(result.files.length > 0);
  assert.ok(
    result.files.reduce((sum, file) => sum + file.text.length, 0) <= 1_000,
  );
  assert.equal(result.files[0].text.length, 1_000);
  assert.match(result.files[0].text, /truncated/);
  graph.close();
});

test("exploreSubgraph gives CALLS more RWR weight than REFS", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "weighted",
    [
      { id: "root", kind: "function", is_exported: true, name: "root" },
      { id: "called", kind: "function", is_exported: true, name: "called" },
      {
        id: "referenced",
        kind: "class",
        is_exported: true,
        name: "referenced",
      },
    ],
    [
      {
        src: "root",
        dst: "called",
        rel: "call",
        count: 1,
        first_line: 1,
        ref_name: "called",
        kind: "CALLS",
      },
      {
        src: "root",
        dst: "referenced",
        rel: "type",
        count: 1,
        first_line: 2,
        ref_name: "referenced",
        kind: "REFS",
      },
    ],
    [],
  );
  const storage = storageFrom([
    entity("root", "root", "weighted.ts"),
    entity("called", "called", "weighted.ts"),
    entity("referenced", "referenced", "weighted.ts", {
      symbolType: "class",
    }),
  ]);

  const result = exploreSubgraph(graph, storage, {
    seedIds: ["root"],
    maxNodes: 16,
  });
  assert.ok(
    (result.nodeScores.get("called") ?? 0) >
      (result.nodeScores.get("referenced") ?? 0),
  );
  graph.close();
});

test("exploreSubgraph preserves parallel edge kinds between the same nodes", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "parallel",
    [
      { id: "root", kind: "function", is_exported: true, name: "root" },
      { id: "target", kind: "class", is_exported: true, name: "target" },
    ],
    [
      {
        src: "root",
        dst: "target",
        rel: "call",
        count: 1,
        first_line: 1,
        ref_name: "target",
        kind: "CALLS",
      },
      {
        src: "root",
        dst: "target",
        rel: "type",
        count: 1,
        first_line: 2,
        ref_name: "target",
        kind: "REFS",
      },
    ],
    [],
  );
  const storage = storageFrom([
    entity("root", "root", "parallel.ts"),
    entity("target", "target", "parallel.ts"),
  ]);

  const result = exploreSubgraph(graph, storage, {
    seedIds: ["root"],
    maxNodes: 16,
  });

  assert.deepEqual(result.edges.map((edge) => edge.kind).sort(), [
    "CALLS",
    "REFS",
  ]);
  assert.deepEqual(result.edges.map((edge) => edge.rel).sort(), [
    "call",
    "type",
  ]);
  graph.close();
});

function entity(id, name, path, opts = {}) {
  const startLine = opts.startLine ?? 1;
  const endLine = opts.endLine ?? 3;
  return {
    file: {
      id: `file-${path}`,
      collectionId: "c",
      absolutePath: `/repo/${path}`,
      relativePath: path,
      rootPath: "/repo",
      sizeBytes: 1,
      lastModifiedTime: 1,
      kind: "code",
      format: "typescript",
    },
    entity: {
      id,
      fileId: `file-${path}`,
      range: {
        kind: "text",
        startLine,
        endLine,
        startOffset: opts.startOffset ?? 0,
        endOffset: opts.endOffset ?? 10,
      },
      content: {
        kind: "text",
        text: opts.text ?? `export class ${name} {\n  run() {}\n}`,
      },
      metadata: {
        kind: "code",
        symbolType: opts.symbolType ?? "class",
        symbolName: name,
        scope: opts.scope ?? null,
        nodeType: opts.nodeType ?? "class_declaration",
        signature: opts.signature ?? `class ${name}`,
        doc: null,
        modifiers: ["exported"],
      },
    },
  };
}

test("component roots include symbols named by resolved script imports", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "file-view.vue",
    [{ id: "view", kind: "component", is_exported: true, name: "CounterView" }],
    [],
    [],
  );
  graph.upsertFileGraph(
    "file-store.ts",
    [{ id: "store", kind: "value", is_exported: true, name: "useCounter" }],
    [],
    [],
  );
  graph.importedSymbols = (fileIds) =>
    fileIds.includes("file-view.vue") ? [{ id: "store", kind: "value" }] : [];
  const view = entity("view", "CounterView", "view.vue", {
    symbolType: "component",
    text: "<script setup>const counter = useCounter()</script>",
  });
  view.file.id = "file-view.vue";
  view.entity.fileId = "file-view.vue";
  const store = entity("store", "useCounter", "stores/counter.ts", {
    symbolType: "value",
    text: "export const useCounter = defineStore('counter', {})",
  });
  store.file.id = "file-store.ts";
  store.entity.fileId = "file-store.ts";

  const result = exploreGraph(graph, storageFrom([view, store]), {
    query: "CounterView",
    maxFiles: 3,
    maxChars: 8_000,
  });

  assert.ok(result.nodes.some((node) => node.id === "store"));
  assert.ok(
    result.edges.some(
      (edge) =>
        edge.src === "view" &&
        edge.dst === "store" &&
        edge.evidence === "component_import",
    ),
  );
  assert.ok(
    result.files.some((file) => file.file.relativePath === "stores/counter.ts"),
  );
  graph.close();
});

test("qualified module API queries retain a production importer entrypoint", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "file-app",
    [
      { id: "app", kind: "value", is_exported: true, name: "app" },
      { id: "listen", kind: "function", is_exported: true, name: "listen" },
      { id: "use", kind: "function", is_exported: true, name: "use" },
    ],
    [],
    [],
  );
  graph.upsertFileGraph(
    "file-entry",
    [
      {
        id: "create-application",
        kind: "function",
        is_exported: true,
        name: "createApplication",
      },
    ],
    [],
    [],
  );
  graph.expandFileNeighbors = (fileIds) =>
    fileIds.includes("file-app")
      ? [{ fid: "file-app", id: "file-entry", direction: "in" }]
      : [];
  const outgoingEdges = graph.outgoingEdges.bind(graph);
  graph.outgoingEdges = (ids, kinds, limit) =>
    ids.includes("file-entry") && kinds.includes("DEFINES")
      ? [
          {
            src: "file-entry",
            dst: "create-application",
            kind: "DEFINES",
            rel: "defines",
            count: 1,
            firstLine: 1,
            refName: "createApplication",
            provenance: "static",
            confidence: 1,
          },
        ]
      : outgoingEdges(ids, kinds, limit);

  const app = entity("app", "app", "lib/application.js", {
    symbolType: "value",
    text: "const app = {};",
  });
  const listen = entity("listen", "listen", "lib/application.js", {
    symbolType: "function",
    text: "app.listen = function listen() {};",
  });
  const use = entity("use", "use", "lib/application.js", {
    symbolType: "function",
    text: "app.use = function use() {};",
  });
  for (const item of [app, listen, use]) {
    item.file.id = "file-app";
    item.entity.fileId = "file-app";
  }
  const entry = entity(
    "create-application",
    "createApplication",
    "lib/express.js",
    {
      symbolType: "function",
      text: "module.exports = function createApplication() {};",
    },
  );
  entry.file.id = "file-entry";
  entry.entity.fileId = "file-entry";

  const result = exploreGraph(graph, storageFrom([app, listen, use, entry]), {
    query: "app.listen app.use",
    maxFiles: 3,
    maxChars: 8_000,
  });
  assert.ok(
    result.files.some((file) => file.file.relativePath === "lib/express.js"),
  );
  graph.close();
});

test("conceptual exploration retains a query-aligned direct call collaborator", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "file-src/dedupe-edge.ts",
    [
      {
        id: "edge-duplicate",
        kind: "class",
        is_exported: true,
        name: "EdgeDuplicate",
      },
    ],
    [],
    [],
  );
  graph.upsertFileGraph(
    "file-src/telemetry.ts",
    [
      {
        id: "telemetry",
        kind: "function",
        is_exported: true,
        name: "recordTelemetry",
      },
    ],
    [],
    [],
  );
  graph.upsertFileGraph(
    "file-src/resolve.ts",
    [
      {
        id: "resolve-root",
        kind: "function",
        is_exported: true,
        name: "resolveContradictions",
      },
      {
        id: "resolve-helper",
        kind: "function",
        is_exported: false,
        name: "resolveEdge",
      },
    ],
    [
      {
        src: "resolve-root",
        dst: "resolve-helper",
        rel: "call",
        count: 1,
        first_line: 2,
        ref_name: "resolveEdge",
        kind: "CALLS",
      },
      {
        src: "resolve-helper",
        dst: "edge-duplicate",
        rel: "call",
        count: 1,
        first_line: 3,
        ref_name: "EdgeDuplicate",
        kind: "CALLS",
      },
      {
        src: "resolve-helper",
        dst: "telemetry",
        rel: "call",
        count: 1,
        first_line: 4,
        ref_name: "recordTelemetry",
        kind: "CALLS",
      },
    ],
    [],
  );
  const storage = storageFrom([
    entity("resolve-root", "resolveContradictions", "src/resolve.ts", {
      symbolType: "function",
    }),
    entity("resolve-helper", "resolveEdge", "src/resolve.ts", {
      symbolType: "function",
    }),
    entity("edge-duplicate", "EdgeDuplicate", "src/dedupe-edge.ts"),
    entity("telemetry", "recordTelemetry", "src/telemetry.ts", {
      symbolType: "function",
    }),
  ]);

  const result = exploreGraph(graph, storage, {
    query: "resolve edge contradictions",
    seedId: "resolve-root",
    traversalDepth: 1,
    maxFiles: 2,
  });

  assert.ok(
    result.files.some(
      (file) => file.file.relativePath === "src/dedupe-edge.ts",
    ),
  );
  assert.equal(
    result.files.some((file) => file.file.relativePath === "src/telemetry.ts"),
    false,
  );
  graph.close();
});

test("explore includes a declaration implementation counterpart with a different file stem", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "file-core.c",
    [{ id: "run", kind: "function", is_exported: true, name: "run" }],
    [
      {
        src: "run",
        dst: "timer-declaration",
        rel: "calls",
        count: 1,
        first_line: 4,
        ref_name: "run_timers",
        kind: "CALLS",
      },
    ],
    [],
  );
  graph.upsertFileGraph(
    "file-common.h",
    [
      {
        id: "timer-declaration",
        kind: "function",
        is_exported: true,
        name: "run_timers",
      },
    ],
    [],
    [],
  );
  graph.upsertFileGraph(
    "file-timer.c",
    [
      {
        id: "timer-definition",
        kind: "function",
        is_exported: true,
        name: "run_timers",
      },
    ],
    [],
    [],
  );
  const storage = storageFrom([
    entity("run", "run", "src/core.c", {
      symbolType: "function",
      text: "int run(void) { run_timers(); }",
    }),
    entity("timer-declaration", "run_timers", "src/common.h", {
      symbolType: "function",
      text: "void run_timers(void);",
    }),
    entity("timer-definition", "run_timers", "src/timer.c", {
      symbolType: "function",
      text: "void run_timers(void) { tick(); }",
    }),
  ]);

  const result = exploreGraph(graph, storage, { query: "run", maxFiles: 4 });
  assert.ok(
    result.files.some((file) => file.file.relativePath === "src/timer.c"),
  );
  graph.close();
});

test("explore reserves an implementation counterpart for a related header", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "operator-header",
    [
      {
        id: "operator",
        kind: "interface",
        is_exported: true,
        name: "IOperator",
      },
    ],
    [],
    [],
  );
  graph.upsertFileGraph(
    "pipeline-header",
    [{ id: "pipeline", kind: "class", is_exported: true, name: "Pipeline" }],
    [
      {
        src: "pipeline",
        dst: "operator",
        rel: "ref",
        count: 1,
        first_line: 1,
        ref_name: "IOperator",
        kind: "REFS",
      },
    ],
    [],
  );
  graph.upsertFileGraph(
    "pipeline-source",
    [{ id: "execute", kind: "function", is_exported: true, name: "Execute" }],
    [],
    [],
  );
  const storage = storageFrom([
    entity("operator", "IOperator", "include/execute/operator.h", {
      symbolType: "interface",
    }),
    entity("pipeline", "Pipeline", "include/execute/pipeline.h", {
      symbolType: "class",
    }),
    entity("execute", "Execute", "src/execute/pipeline.cc", {
      symbolType: "function",
      text: "void Pipeline::Execute() {}",
    }),
  ]);

  const result = exploreGraph(graph, storage, {
    query: "IOperator",
    seedId: "operator",
    maxFiles: 3,
  });
  assert.ok(
    result.files.some(
      (file) => file.file.relativePath === "src/execute/pipeline.cc",
    ),
  );
  graph.close();
});

test("explore pairs a directly related source integration with its declaration header", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "root-header",
    [{ id: "database", kind: "class", is_exported: true, name: "Database" }],
    [],
    [],
  );
  graph.upsertFileGraph(
    "service-source",
    [
      {
        id: "serve-definition",
        kind: "function",
        is_exported: true,
        name: "serve",
      },
    ],
    [
      {
        src: "serve-definition",
        dst: "database",
        rel: "call",
        count: 1,
        first_line: 8,
        ref_name: "Database",
        kind: "CALLS",
      },
    ],
    [],
  );
  graph.upsertFileGraph(
    "service-header",
    [
      {
        id: "serve-declaration",
        kind: "function",
        is_exported: true,
        name: "serve",
      },
    ],
    [],
    [],
  );
  const storage = storageFrom([
    entity("database", "Database", "include/main/database.h", {
      symbolType: "class",
    }),
    entity("serve-definition", "serve", "src/server/database_service.cc", {
      symbolType: "function",
      text: "void serve() { Database db; }",
    }),
    entity("serve-declaration", "serve", "include/server/database_service.h", {
      symbolType: "function",
      text: "void serve();",
    }),
  ]);

  const result = exploreGraph(graph, storage, {
    query: "Database",
    seedId: "database",
    maxFiles: 3,
  });
  assert.ok(
    result.files.some(
      (file) => file.file.relativePath === "include/server/database_service.h",
    ),
  );
  graph.close();
});

test("blast integration retains the declaration of a source constructor", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "root-header",
    [{ id: "database", kind: "class", is_exported: true, name: "Database" }],
    [],
    [],
  );
  graph.upsertFileGraph(
    "service-source",
    [
      {
        id: "service-constructor",
        kind: "function",
        is_exported: true,
        name: "DatabaseService",
      },
    ],
    [
      {
        src: "service-constructor",
        dst: "database",
        rel: "call",
        count: 1,
        first_line: 8,
        ref_name: "Database",
        kind: "CALLS",
      },
    ],
    [],
  );
  graph.upsertFileGraph(
    "service-header",
    [
      {
        id: "service-type",
        kind: "class",
        is_exported: true,
        name: "DatabaseService",
      },
    ],
    [],
    [],
  );
  const storage = storageFrom([
    entity("database", "Database", "include/main/database.h", {
      symbolType: "class",
    }),
    entity(
      "service-constructor",
      "DatabaseService",
      "src/server/database_service.cc",
      { symbolType: "function", text: "DatabaseService::DatabaseService() {}" },
    ),
    entity(
      "service-type",
      "DatabaseService",
      "include/server/database_service.h",
      { symbolType: "class", text: "class DatabaseService {};" },
    ),
  ]);

  const result = exploreGraph(graph, storage, {
    query: "Database",
    seedId: "database",
    maxFiles: 3,
  });
  assert.ok(
    result.files.some(
      (file) => file.file.relativePath === "include/server/database_service.h",
    ),
  );
  graph.close();
});

test("explore pairs a directly called platform declaration with its matching source definition", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "file-win-handle.c",
    [{ id: "close", kind: "function", is_exported: true, name: "close" }],
    [
      {
        src: "close",
        dst: "win-close-declaration",
        rel: "calls",
        count: 1,
        first_line: 8,
        ref_name: "platform_close",
        kind: "CALLS",
      },
    ],
    [],
  );
  for (const [fileId, id, arity] of [
    ["file-win-internal.h", "win-close-declaration", 2],
    ["file-win-tcp.c", "win-close-definition", 2],
    ["file-unix-tcp.c", "unix-close-definition", 1],
  ])
    graph.upsertFileGraph(
      fileId,
      [
        {
          id,
          kind: "function",
          is_exported: true,
          name: "platform_close",
          arity,
        },
      ],
      [],
      [],
    );

  const close = entity("close", "close", "src/win/handle.c", {
    symbolType: "function",
    text: "void close(void) { platform_close(loop, handle); }",
  });
  const declaration = entity(
    "win-close-declaration",
    "platform_close",
    "src/win/internal.h",
    { symbolType: "function", text: "void platform_close(Loop*, Handle*);" },
  );
  const winDefinition = entity(
    "win-close-definition",
    "platform_close",
    "src/win/tcp.c",
    {
      symbolType: "function",
      text: "void platform_close(Loop* loop, Handle* handle) { finish(handle); }",
    },
  );
  const unixDefinition = entity(
    "unix-close-definition",
    "platform_close",
    "src/unix/tcp.c",
    {
      symbolType: "function",
      text: "void platform_close(Handle* handle) { finish(handle); }",
    },
  );
  for (const [stored, arity] of [
    [close, 0],
    [declaration, 2],
    [winDefinition, 2],
    [unixDefinition, 1],
  ]) {
    stored.file.format = "c";
    stored.entity.metadata.arity = arity;
  }
  const result = exploreGraph(
    graph,
    storageFrom([close, declaration, winDefinition, unixDefinition]),
    { query: "close", maxFiles: 4 },
  );
  assert.ok(
    result.files.some((file) => file.file.relativePath === "src/win/tcp.c"),
  );
  assert.ok(
    !result.files.some((file) => file.file.relativePath === "src/unix/tcp.c"),
  );
  graph.close();
});

test("exact type seeds discard constructors and C++ forward declarations", () => {
  const storage = storageFrom([
    entity("definition", "NeugDB", "include/neug_db.h", {
      symbolType: "class",
      nodeType: "class_specifier",
      text: "class NeugDB { public: void Open(); };",
    }),
    entity("forward", "NeugDB", "include/consumer.h", {
      symbolType: "class",
      nodeType: "class_specifier",
      text: "class NeugDB",
    }),
    entity("constructor", "NeugDB", "src/neug_db.cc", {
      symbolType: "function",
      nodeType: "function_definition",
      signature: "NeugDB::NeugDB()",
      text: "NeugDB::NeugDB() {}",
    }),
  ]);

  assert.deepEqual(resolveExploreSeeds(storage, "NeugDB", undefined, 8), [
    "definition",
  ]);
});

test("exact type seed groups include same-file generic implementation fragments", () => {
  const storage = storageFrom([
    entity("router-struct", "Router", "src/router.rs", {
      symbolType: "class",
      signature: "pub struct Router<S>",
    }),
    entity("router-impl", "Router<S>", "src/router.rs", {
      symbolType: "class",
      signature: "impl<S> Router<S>",
    }),
    entity("other-router", "Router", "other/router.rs", {
      symbolType: "class",
      signature: "pub struct Router",
    }),
  ]);

  const groups = resolveExactExploreSeedGroups(storage, "Router", 8);

  assert.equal(groups.length, 2);
  assert.deepEqual(
    new Set(groups.find((group) => group.ids.includes("router-struct")).ids),
    new Set(["router-struct", "router-impl"]),
  );
});

test("exact method seeds group declarations and implementations by owner", () => {
  const storage = storageFrom([
    entity("pipeline-decl", "Execute", "include/pipeline.h", {
      symbolType: "function",
      scope: "neug::execution::Pipeline",
      text: "void Execute();",
    }),
    entity("pipeline-impl", "Execute", "src/pipeline.cc", {
      symbolType: "function",
      scope: "neug::execution::Pipeline",
      text: "void Pipeline::Execute() { run(); }",
    }),
    entity("binding-impl", "Execute", "src/node_connection.cc", {
      symbolType: "function",
      scope: "NodeConnection",
      text: "Value NodeConnection::Execute() { return Query(); }",
    }),
  ]);

  const groups = resolveExactExploreSeedGroups(storage, "Execute", 8);
  assert.equal(groups.length, 2);
  const pipeline = groups.find((group) => group.ids.includes("pipeline-impl"));
  assert.deepEqual(
    new Set(pipeline.ids),
    new Set(["pipeline-decl", "pipeline-impl"]),
  );
  assert.equal(pipeline.representative.entity.id, "pipeline-impl");

  const qualified = resolveExactExploreSeedGroups(
    storage,
    "Pipeline::Execute",
    8,
  );
  assert.equal(qualified.length, 1);
  assert.deepEqual(
    new Set(qualified[0].ids),
    new Set(["pipeline-decl", "pipeline-impl"]),
  );
});

test("explore reports independent exact owner groups as ambiguous", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  const storage = storageFrom([
    entity("pipeline-decl", "Execute", "include/pipeline.h", {
      symbolType: "function",
      scope: "Pipeline",
      text: "void Execute();",
    }),
    entity("pipeline-impl", "Execute", "src/pipeline.cc", {
      symbolType: "function",
      scope: "Pipeline",
      text: "void Pipeline::Execute() { run(); }",
    }),
    entity("binding-impl", "Execute", "src/node_connection.cc", {
      symbolType: "function",
      scope: "NodeConnection",
      text: "Value NodeConnection::Execute() { return Query(); }",
    }),
  ]);

  const result = exploreGraph(graph, storage, { query: "Execute" });
  assert.equal(result.ambiguous, true);
  assert.equal(result.seedCandidates.length, 2);
  assert.deepEqual(result.files, []);
  graph.close();
});

test("natural-language seed lookup preserves symbol case and excludes documentation noise", () => {
  const baseStorage = storageFrom([
    entity("open-source", "Open", "src/database.cc", {
      symbolType: "function",
      text: "bool Database::Open() { return true; }",
    }),
    entity("open-doc", "`Open(...)`", "docs/database.md", {
      symbolType: "heading",
      text: "Open a database and recover its checkpoint.",
    }),
    entity("recovery-test", "TEST", "tests/recovery_test.cc", {
      symbolType: "function",
      text: "TEST(Database, recovery) {}",
    }),
  ]);
  const storage = {
    ...baseStorage,
    findSymbolsByName(name, limit) {
      // The real index returns ranked name-search candidates, not only strict
      // equality matches. A phrase lookup must not be mistaken for an exact
      // symbol hit and short-circuit token-level seed discovery.
      if (name.includes(" ")) {
        return [
          baseStorage.getEntity("open-doc"),
          baseStorage.getEntity("recovery-test"),
        ].filter(Boolean);
      }
      return baseStorage.findSymbolsByName(name, limit);
    },
  };

  assert.deepEqual(
    resolveExploreSeeds(storage, "checkpoint recovery Open", undefined, 8),
    ["open-source"],
  );
});

test("user symbol lookup is case-insensitive without collapsing candidates", () => {
  const upper = entity("frame-upper", "Frame", "src/frame.rs", {
    symbolType: "enum",
  });
  const lower = entity("frame-lower", "frame", "src/frame_fn.rs", {
    symbolType: "function",
  });
  assert.equal(matchesExactSymbolQuery(upper, "frame"), true);
  assert.equal(matchesExactSymbolQuery(lower, "Frame"), true);
  assert.deepEqual(
    preferExactSymbolCase([upper, lower], "frame").map(
      (item) => item.entity.id,
    ),
    ["frame-lower"],
  );
});

test("conceptual seed lookup fills across coherent source files without duplicate names", () => {
  const storage = storageFrom([
    entity("route", "Route", "middleware/route_headers.go", {
      symbolType: "function",
      text: "func Route() { Handler() }",
    }),
    entity("handler", "Handler", "middleware/route_headers.go", {
      symbolType: "function",
      text: "func Handler() { Route() }",
    }),
    entity("router", "Router", "chi.go", {
      symbolType: "interface",
      text: "type Router interface { Match(); Middlewares() }",
    }),
    entity("find-route", "findRoute", "tree.go", {
      symbolType: "function",
      text: "func findRoute() { /* route matching */ }",
    }),
    entity("duplicate-route", "Route", "tree.go", {
      symbolType: "class",
      text: "type Route struct{}",
    }),
    entity("release", "v3.0 route middleware", "CHANGELOG.md", {
      symbolType: "heading",
      text: "route matching middleware release notes",
    }),
  ]);

  const seeds = resolveExploreSeeds(
    storage,
    "route matching middleware",
    undefined,
    8,
  );
  assert.ok(seeds.includes("router"));
  assert.ok(seeds.includes("find-route"));
  assert.equal(seeds.includes("release"), false);
  assert.equal(
    seeds.filter((id) => ["route", "duplicate-route"].includes(id)).length,
    1,
  );
});

test("multi-concept seed lookup preserves exact tokens outside the first anchor", () => {
  const storage = storageFrom([
    entity("server", "Server", "src/server.rs", {
      symbolType: "class",
      text: "struct Server;",
    }),
    entity("frame", "Frame", "src/frame.rs", {
      symbolType: "enum",
      text: "enum Frame { Data }",
    }),
    entity("connection", "Connection", "src/connection.rs", {
      symbolType: "class",
      text: "struct Connection;",
    }),
  ]);

  const seeds = resolveExploreSeeds(
    storage,
    "Server connection Frame",
    undefined,
    8,
  );
  assert.ok(seeds.includes("server"));
  assert.ok(
    seeds.includes("frame"),
    "an exact user-named concept must not require prior graph coherence",
  );
});

test("explicit same-file symbols are not displaced by the per-file seed cap", () => {
  const storage = storageFrom([
    entity("app", "app", "src/application.js", {
      symbolType: "value",
      text: "const app = {};",
    }),
    entity("listen", "listen", "src/application.js", {
      symbolType: "function",
      text: "app.listen = function listen() {};",
    }),
    entity("handle", "handle", "src/application.js", {
      symbolType: "function",
      text: "app.handle = function handle() {};",
    }),
    entity("use", "use", "src/application.js", {
      symbolType: "function",
      text: "app.use = function use() {};",
    }),
    entity("factory", "createApplication", "src/index.js", {
      symbolType: "function",
      text: "function createApplication() { app.listen(); app.handle(); app.use(); }",
    }),
  ]);

  const seeds = resolveExploreSeeds(
    storage,
    "app.listen app.handle app.use",
    undefined,
    8,
  );
  assert.deepEqual(seeds.slice(0, 4), ["app", "listen", "handle", "use"]);
});

test("multi-concept seed lookup anchors on a distinctive acronym before a generic name", () => {
  const storage = storageFrom([
    entity("generic-checkpoint", "checkpoint", "src/compiler/planner.ts", {
      symbolType: "function",
      text: "function checkpoint() { return planGraph(); }",
    }),
    entity("wal-writers", "WalWriterSet", "include/main/wal_writer_set.h", {
      symbolType: "class",
      text: "class WalWriterSet {};",
    }),
    entity(
      "checkpoint-coordinator",
      "CheckpointCoordinator",
      "include/main/checkpoint_coordinator.h",
      {
        symbolType: "class",
        text: "class CheckpointCoordinator { /* WAL recovery */ };",
      },
    ),
  ]);

  const seeds = resolveExploreSeeds(
    storage,
    "checkpoint recovery WAL",
    undefined,
    8,
  );
  assert.ok(seeds.includes("wal-writers"));
  assert.ok(seeds.includes("checkpoint-coordinator"));
  assert.equal(seeds.includes("generic-checkpoint"), false);
});

test("conceptual lookup prefers a top-level API over an equally named method", () => {
  const storage = storageFrom([
    entity("server", "Server", "src/server.rs", { symbolType: "class" }),
    entity("a-listener-run", "run", "src/server.rs", {
      symbolType: "function",
      scope: "Listener",
      text: "impl Listener { fn run(&mut self) {} }",
    }),
    entity("z-module-run", "run", "src/server.rs", {
      symbolType: "function",
      text: "pub async fn run() {}",
    }),
    entity("connection", "Connection", "src/connection.rs", {
      symbolType: "class",
    }),
  ]);

  const seeds = resolveExploreSeeds(
    storage,
    "Server run connection",
    undefined,
    8,
  );
  assert.ok(seeds.includes("z-module-run"));
  assert.equal(seeds.includes("a-listener-run"), false);
});

test("natural-language stopword collisions do not outrank a corroborated module", () => {
  const storage = storageFrom([
    entity("check", "check", "src/db/valve.ts", {
      symbolType: "function",
      scope: "Valve",
      text: "check() { this.fire(); }",
    }),
    entity("fire", "fire", "src/db/valve.ts", {
      symbolType: "function",
      scope: "Valve",
      text: "fire() { this.drain(); }",
    }),
    entity("drain", "drain", "src/db/valve.ts", {
      symbolType: "function",
      scope: "Valve",
      text: "drain() {}",
    }),
    entity("latest", "resolveLatestVersion", "src/upgrade/updater.ts", {
      symbolType: "function",
      text: "function resolveLatestVersion() { return normalizeVersion(); }",
    }),
    entity("upgrade", "runUpgrade", "src/upgrade/updater.ts", {
      symbolType: "function",
      text: "function runUpgrade() { return resolveLatestVersion(); }",
    }),
  ]);

  const naturalLanguage = resolveExploreSeeds(
    storage,
    "how does the upgrade flow check the latest version",
    undefined,
    8,
  );
  assert.ok(naturalLanguage.includes("latest"));
  assert.ok(naturalLanguage.includes("upgrade"));
  const checkIndex = naturalLanguage.indexOf("check");
  assert.ok(
    checkIndex === -1 || naturalLanguage.indexOf("latest") < checkIndex,
    `incidental check() ranked too highly: ${naturalLanguage.join(", ")}`,
  );

  const symbolBag = resolveExploreSeeds(
    storage,
    "check drain fire",
    undefined,
    8,
  );
  assert.deepEqual(
    new Set(symbolBag.slice(0, 3)),
    new Set(["check", "drain", "fire"]),
  );
});

function storageFrom(entities) {
  const map = new Map(entities.map((item) => [item.entity.id, item]));
  return {
    findSymbolsByName(name) {
      return [...map.values()].filter(
        (item) => item.entity.metadata.symbolName === name,
      );
    },
    findSymbolsByQuery(query) {
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      return [...map.values()].filter((item) => {
        const hay =
          `${item.entity.metadata.symbolName} ${item.file.relativePath} ${item.entity.content.text}`.toLowerCase();
        return terms.some((term) => hay.includes(term));
      });
    },
    getEntity(id) {
      return map.get(id) ?? null;
    },
  };
}

test("exploreGraph expands hierarchy, ranks files, assembles zvec content", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "file-base.ts",
    [{ id: "Base", kind: "class", is_exported: true, name: "Base" }],
    [],
    [],
  );
  graph.upsertFileGraph(
    "file-child.ts",
    [
      { id: "Child", kind: "class", is_exported: true, name: "Child" },
      { id: "helper", kind: "function", is_exported: true, name: "helper" },
    ],
    [
      {
        src: "Child",
        dst: "Base",
        rel: "extends",
        count: 1,
        first_line: 1,
        ref_name: "Base",
        kind: "INHERITS",
      },
      {
        src: "helper",
        dst: "Child",
        rel: "call",
        count: 2,
        first_line: 8,
        ref_name: "Child",
        kind: "CALLS",
      },
    ],
    [],
  );
  graph.upsertFileGraph(
    "file-sib.ts",
    [{ id: "Other", kind: "class", is_exported: true, name: "Other" }],
    [
      {
        src: "Other",
        dst: "Base",
        rel: "extends",
        count: 1,
        first_line: 1,
        ref_name: "Base",
        kind: "INHERITS",
      },
    ],
    [],
  );

  const storage = storageFrom([
    entity("Base", "Base", "base.ts"),
    entity("Child", "Child", "child.ts"),
    entity("helper", "helper", "child.ts", {
      symbolType: "function",
      startLine: 8,
      endLine: 12,
      text: "export function helper() {\n  return Child;\n}",
    }),
    entity("Other", "Other", "sib.ts"),
  ]);

  const result = exploreGraph(graph, storage, {
    query: "Child",
    maxFiles: 2,
    traversalDepth: 2,
  });

  assert.equal(result.available, true);
  assert.deepEqual(
    result.roots.map((root) => root.id),
    ["Child"],
  );
  assert.ok(
    result.nodes.some((n) => n.id === "Base"),
    "hierarchy base",
  );
  assert.ok(
    result.nodes.some((n) => n.id === "Other"),
    "sibling type",
  );
  assert.ok(
    result.nodes.some((n) => n.id === "helper"),
    "call neighbor",
  );
  assert.ok(result.files.length >= 1);
  assert.ok(
    result.files.some(
      (f) => f.text.includes("class Child") || f.text.includes("Child"),
    ),
  );
  assert.ok(result.files.every((f) => f.text.length > 0));
  assert.equal(result.files[0]?.file.relativePath, "child.ts");
  assert.equal(result.files[0]?.isCentral, true);
  assert.ok(
    result.files.some((file) => file.file.relativePath === "base.ts"),
    "the direct base/interface file is retained under a tight file budget",
  );
  assert.ok(
    result.files[0]?.reasons.some((reason) => reason.endsWith("(root)")),
  );
  assert.match(result.files[0]?.text ?? "", /^\/\/ .* L\d+-\d+\n\s*\d+ {2}/);
  graph.close();
});

test("explore skeletonizes off-spine siblings in a large implementation family", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  const implementations = ["Alpha", "Beta", "Gamma", "Delta"];
  graph.upsertFileGraph(
    "family",
    [
      { id: "Base", kind: "interface", is_exported: true, name: "Base" },
      ...implementations.map((name) => ({
        id: name,
        kind: "class",
        is_exported: true,
        name,
      })),
    ],
    implementations.map((name) => ({
      src: name,
      dst: "Base",
      rel: "implements",
      count: 1,
      first_line: 1,
      ref_name: "Base",
      kind: "INHERITS",
    })),
    [],
  );
  const storage = storageFrom([
    entity("Base", "Base", "base.ts", {
      symbolType: "interface",
      text: "export interface Base { run(): void; }",
      signature: "interface Base",
    }),
    ...implementations.map((name) =>
      entity(name, name, `${name.toLowerCase()}.ts`, {
        text: `export class ${name} implements Base { run() { return "${name}_BODY"; } }`,
        signature: `class ${name} implements Base`,
      }),
    ),
  ]);

  const result = exploreGraph(graph, storage, {
    query: "Base",
    traversalDepth: 2,
    maxFiles: 5,
    maxChars: 12_000,
  });
  const implementationFiles = result.files.filter((file) =>
    /^(?:alpha|beta|gamma|delta)\.ts$/.test(file.file.relativePath),
  );
  assert.equal(implementationFiles.length, 4);
  assert.equal(
    implementationFiles.filter((file) =>
      file.text.includes("implementation body elided"),
    ).length,
    3,
  );
  assert.equal(
    implementationFiles.filter((file) => /_BODY/.test(file.text)).length,
    1,
    "one ranked exemplar must retain its implementation body",
  );
  graph.close();
});

test("hierarchy sampling preserves file diversity beyond a crowded 512-row prefix", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "base-file",
    [{ id: "base", kind: "interface", is_exported: true, name: "Base" }],
    [],
    [],
  );
  const crowded = Array.from({ length: 520 }, (_, index) => ({
    id: `a-crowded-${String(index).padStart(3, "0")}`,
    kind: "class",
    is_exported: true,
    name: `Crowded${index}`,
  }));
  graph.upsertFileGraph(
    "crowded-file",
    crowded,
    crowded.map((node) => ({
      src: node.id,
      dst: "base",
      rel: "implements",
      count: 1,
      first_line: 1,
      ref_name: "Base",
      kind: "INHERITS",
    })),
    [],
  );
  graph.upsertFileGraph(
    "rare-file",
    [{ id: "z-rare", kind: "class", is_exported: true, name: "Rare" }],
    [
      {
        src: "z-rare",
        dst: "base",
        rel: "implements",
        count: 1,
        first_line: 1,
        ref_name: "Base",
        kind: "INHERITS",
      },
    ],
    [],
  );
  const storage = storageFrom([
    entity("base", "Base", "base.ts", { symbolType: "interface" }),
    ...crowded.map((node) =>
      entity(node.id, node.name, "generated/all.ts", { symbolType: "class" }),
    ),
    entity("z-rare", "Rare", "feature/rare.ts", { symbolType: "class" }),
  ]);

  const result = exploreSubgraph(graph, storage, {
    seedIds: ["base"],
    maxNodes: 16,
    traversalDepth: 1,
    includeCallPaths: false,
  });

  assert.ok(
    result.nodes.some((node) => node.id === "z-rare"),
    "a second implementation file must not be hidden by 520 earlier IDs",
  );
  graph.close();
});

test("explore prefers production neighbors and removes nested source duplicates", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "root-file",
    [
      { id: "Service", kind: "class", is_exported: true, name: "Service" },
      { id: "run", kind: "method", is_exported: true, name: "run" },
    ],
    [
      {
        src: "Service",
        dst: "run",
        rel: "contains",
        count: 1,
        first_line: 2,
        ref_name: "run",
        kind: "CONTAINS",
      },
    ],
    [],
  );
  graph.upsertFileGraph(
    "prod-file",
    [
      {
        id: "production",
        kind: "function",
        is_exported: true,
        name: "production",
      },
    ],
    [
      {
        src: "production",
        dst: "Service",
        rel: "call",
        count: 1,
        first_line: 1,
        ref_name: "Service",
        kind: "CALLS",
      },
    ],
    [],
  );
  graph.upsertFileGraph(
    "test-file",
    [
      {
        id: "test-user",
        kind: "function",
        is_exported: true,
        name: "testUser",
      },
    ],
    [
      {
        src: "test-user",
        dst: "Service",
        rel: "call",
        count: 1,
        first_line: 1,
        ref_name: "Service",
        kind: "CALLS",
      },
    ],
    [],
  );
  graph.upsertFileGraph(
    "docs-file",
    [
      {
        id: "docs-user",
        kind: "function",
        is_exported: true,
        name: "docsUser",
      },
    ],
    [
      {
        src: "docs-user",
        dst: "Service",
        rel: "call",
        count: 1,
        first_line: 1,
        ref_name: "Service",
        kind: "CALLS",
      },
    ],
    [],
  );
  const storage = storageFrom([
    entity("Service", "Service", "service.ts", {
      startLine: 1,
      endLine: 10,
      startOffset: 0,
      endOffset: 100,
      text: "export class Service {\n  run() {}\n}",
    }),
    entity("run", "run", "service.ts", {
      symbolType: "function",
      startLine: 2,
      endLine: 4,
      startOffset: 25,
      endOffset: 50,
      text: "run() {}",
    }),
    entity("production", "production", "consumer.ts", {
      symbolType: "function",
    }),
    entity("test-user", "testUser", "test/service.test.ts", {
      symbolType: "function",
    }),
    entity("docs-user", "docsUser", "docs/guide.ts", {
      symbolType: "function",
    }),
  ]);

  const result = exploreGraph(graph, storage, {
    query: "Service",
    maxFiles: 3,
    traversalDepth: 1,
  });

  assert.deepEqual(
    result.roots.map((root) => root.id),
    ["Service"],
  );
  assert.equal(result.files[0]?.file.relativePath, "service.ts");
  assert.equal(result.files[0]?.isCentral, true);
  assert.equal(result.files[0]?.symbols.length, 1);
  assert.ok(
    result.files.some((file) => file.file.relativePath === "consumer.ts"),
  );
  assert.equal(
    result.files.some(
      (file) => file.file.relativePath === "test/service.test.ts",
    ),
    false,
  );
  assert.equal(
    result.files.some((file) => file.file.relativePath === "docs/guide.ts"),
    false,
  );
  graph.close();
});

test("on-disk assembly prefers nested method bodies over container summaries", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "controller-file",
    [
      {
        id: "Controller",
        kind: "class",
        is_exported: true,
        name: "Controller",
      },
      { id: "handle", kind: "method", is_exported: true, name: "handle" },
      { id: "helper", kind: "method", is_exported: false, name: "helper" },
    ],
    [
      {
        src: "Controller",
        dst: "handle",
        rel: "contains",
        count: 1,
        first_line: 2,
        ref_name: "handle",
        kind: "CONTAINS",
      },
      {
        src: "Controller",
        dst: "helper",
        rel: "contains",
        count: 1,
        first_line: 5,
        ref_name: "helper",
        kind: "CONTAINS",
      },
      {
        src: "handle",
        dst: "helper",
        rel: "call",
        count: 1,
        first_line: 3,
        ref_name: "helper",
        kind: "CALLS",
      },
    ],
    [],
  );
  const source = [
    "class Controller {",
    "  handle() {",
    "    return this.helper();",
    "  }",
    "  helper() {",
    "    return 42;",
    "  }",
    "}",
  ].join("\n");
  const baseStorage = storageFrom([
    entity("Controller", "Controller", "controller.ts", {
      startLine: 1,
      endLine: 8,
      startOffset: 0,
      endOffset: source.length,
      text: "class Controller { members: handle, helper }",
    }),
    entity("handle", "handle", "controller.ts", {
      symbolType: "method",
      startLine: 2,
      endLine: 4,
      startOffset: source.indexOf("  handle"),
      endOffset: source.indexOf("  helper") - 1,
      text: "handle() { return this.helper(); }",
    }),
    entity("helper", "helper", "controller.ts", {
      symbolType: "method",
      startLine: 5,
      endLine: 7,
      startOffset: source.indexOf("  helper"),
      endOffset: source.lastIndexOf("}"),
      text: "helper() { return 42; }",
    }),
  ]);
  const storage = { ...baseStorage, readFileText: () => source };

  const result = exploreGraph(graph, storage, {
    query: "Controller handle helper",
    maxFiles: 2,
    traversalDepth: 1,
  });

  const text = result.files[0]?.text ?? "";
  assert.deepEqual(
    result.roots.map((root) => root.id),
    ["Controller", "handle", "helper"],
  );
  assert.deepEqual(
    result.files[0]?.symbols.map((symbol) => symbol.id),
    ["handle", "helper"],
  );
  assert.match(text, /return this\.helper\(\)/);
  assert.match(text, /return 42/);
  assert.doesNotMatch(text, /members: handle/);
  graph.close();
});

test("explore prioritizes qualified definitions over third-party neighbors", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "header",
    [
      {
        id: "NeugDB",
        kind: "class",
        is_exported: true,
        name: "NeugDB",
        qualifiedName: "NeugDB",
      },
    ],
    [],
    [],
  );
  graph.upsertFileGraph(
    "definition",
    [
      {
        id: "NeugDB::Open",
        kind: "function",
        is_exported: false,
        name: "Open",
        qualifiedName: "NeugDB::Open",
      },
    ],
    [],
    [],
  );
  graph.upsertFileGraph(
    "third-party",
    [
      {
        id: "third-party-user",
        kind: "function",
        is_exported: true,
        name: "useDb",
      },
    ],
    [
      {
        src: "third-party-user",
        dst: "NeugDB",
        rel: "call",
        count: 1,
        first_line: 1,
        ref_name: "NeugDB",
        kind: "CALLS",
      },
    ],
    [],
  );
  const storage = storageFrom([
    entity("NeugDB", "NeugDB", "include/neug_db.h"),
    entity("NeugDB::Open", "Open", "src/neug_db.cc", {
      symbolType: "function",
      scope: "NeugDB",
      text: "void NeugDB::Open() {}",
    }),
    entity("third-party-user", "useDb", "third_party/lib/use.cc", {
      symbolType: "function",
    }),
  ]);

  const result = exploreGraph(graph, storage, {
    query: "NeugDB",
    maxFiles: 2,
    traversalDepth: 1,
  });

  assert.deepEqual(
    result.files.map((file) => file.file.relativePath),
    ["include/neug_db.h", "src/neug_db.cc"],
  );
  assert.deepEqual(
    result.files.map((file) => file.isCentral),
    [true, true],
  );
  assert.ok(
    result.files[1]?.reasons.some((reason) => reason === "Open(definition)"),
  );
  assert.equal(
    result.files[0]?.reasons.some((reason) => reason.endsWith("(definition)")),
    false,
  );
  graph.close();
});

test("type-root blast radius includes external callers of its members", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "db",
    [
      { id: "Db", kind: "class", is_exported: true, name: "Db" },
      { id: "Db.open", kind: "function", is_exported: true, name: "open" },
    ],
    [
      {
        src: "Db",
        dst: "Db.open",
        rel: "contains",
        count: 1,
        first_line: 2,
        ref_name: "open",
        kind: "CONTAINS",
      },
    ],
    [],
  );
  graph.upsertFileGraph(
    "service",
    [{ id: "service", kind: "function", is_exported: true, name: "serve" }],
    [
      {
        src: "service",
        dst: "Db.open",
        rel: "call",
        count: 1,
        first_line: 4,
        ref_name: "open",
        kind: "CALLS",
      },
    ],
    [],
  );
  graph.upsertFileGraph(
    "test",
    [{ id: "test", kind: "function", is_exported: true, name: "opensDb" }],
    [
      {
        src: "test",
        dst: "Db.open",
        rel: "call",
        count: 1,
        first_line: 3,
        ref_name: "open",
        kind: "CALLS",
      },
    ],
    [],
  );
  const storage = storageFrom([
    entity("Db", "Db", "db.ts"),
    entity("Db.open", "open", "db.ts", { symbolType: "function" }),
    entity("service", "serve", "service.ts", { symbolType: "function" }),
    entity("test", "opensDb", "test/db.test.ts", { symbolType: "function" }),
  ]);

  const result = exploreGraph(graph, storage, { query: "Db" });
  const blast = result.blastRadius[0];
  assert.deepEqual(
    blast?.dependents.map((item) => item.id),
    ["service"],
  );
  assert.deepEqual(
    blast?.tests.map((item) => item.id),
    ["test"],
  );
  assert.ok(result.nodes.some((node) => node.id === "service"));
  assert.ok(
    result.files.some((file) => file.file.relativePath === "service.ts"),
  );
  graph.close();
});

test("blast integration selects novel, information-rich shallow files", () => {
  const root = entity("root", "Root", "src/root.ts");
  const alreadyPresent = entity("existing", "existing", "src/a-existing.ts", {
    symbolType: "function",
  });
  const serverA = entity("server-a", "serve", "src/server.ts", {
    symbolType: "function",
  });
  const serverB = entity("server-b", "accept", "src/server.ts", {
    symbolType: "function",
  });
  const nestedA = entity("nested-a", "send", "src/client/nested.ts", {
    symbolType: "function",
  });
  const nestedB = entity("nested-b", "receive", "src/client/nested.ts", {
    symbolType: "function",
  });

  const result = includeBlastRadiusNodes(
    [
      { id: "root", isRoot: true, entity: root },
      { id: "existing", isRoot: false, entity: alreadyPresent },
    ],
    [
      {
        rootId: "root",
        dependents: [
          { id: "existing", entity: alreadyPresent },
          { id: "nested-a", entity: nestedA },
          { id: "nested-b", entity: nestedB },
          { id: "server-a", entity: serverA },
          { id: "server-b", entity: serverB },
        ],
        tests: [],
      },
    ],
    1,
  );

  assert.ok(result.nodes.some((node) => node.id === "server-a"));
  assert.equal(
    result.nodes.some((node) => node.id === "nested-a"),
    false,
  );
  assert.equal(result.fileHits.has(serverA.file.id), true);
  assert.equal(result.fileHits.has(alreadyPresent.file.id), false);
});

test("blast integration preserves a direct caller beside a passive ref in the same file", () => {
  const root = entity("root", "Root", "src/root.ts");
  const passive = entity("passive", "getRoot", "src/service.ts", {
    symbolType: "function",
  });
  const caller = entity("caller", "initialize", "src/service.ts", {
    symbolType: "function",
  });

  const result = includeBlastRadiusNodes(
    [
      { id: "root", isRoot: true, entity: root },
      { id: "passive", isRoot: false, entity: passive },
    ],
    [
      {
        rootId: "root",
        dependents: [
          { id: "caller", entity: caller, directCall: true },
          { id: "passive", entity: passive },
        ],
        tests: [],
      },
    ],
    1,
  );

  assert.ok(result.nodes.some((node) => node.id === "caller"));
});

test("blast radius merges declaration and implementation roots for one logical type", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "connection",
    [
      {
        id: "Connection.struct",
        kind: "class",
        is_exported: true,
        name: "Connection",
      },
      {
        id: "Connection.impl",
        kind: "impl_container",
        is_exported: true,
        name: "Connection",
      },
    ],
    [],
    [],
  );
  graph.upsertFileGraph(
    "users",
    [
      {
        id: "use-struct",
        kind: "function",
        is_exported: true,
        name: "useStruct",
      },
      { id: "use-impl", kind: "function", is_exported: true, name: "useImpl" },
    ],
    [
      {
        src: "use-struct",
        dst: "Connection.struct",
        rel: "ref",
        count: 1,
        first_line: 1,
        ref_name: "Connection",
        kind: "REFS",
      },
      {
        src: "use-impl",
        dst: "Connection.impl",
        rel: "ref",
        count: 1,
        first_line: 2,
        ref_name: "Connection",
        kind: "REFS",
      },
    ],
    [],
  );
  const storage = storageFrom([
    entity("Connection.struct", "Connection", "src/connection.rs", {
      symbolType: "class",
    }),
    entity("Connection.impl", "Connection", "src/connection.rs", {
      symbolType: "class",
    }),
    entity("use-struct", "useStruct", "src/a.rs", { symbolType: "function" }),
    entity("use-impl", "useImpl", "src/b.rs", { symbolType: "function" }),
  ]);

  const result = exploreGraph(graph, storage, { query: "Connection" });
  assert.equal(result.blastRadius.length, 1);
  assert.deepEqual(
    result.blastRadius[0]?.dependents.map((item) => item.id).sort(),
    ["use-impl", "use-struct"],
  );
  graph.close();
});

test("exploreGraph rescues a buried callable signature type as change surface", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "request-file",
    [
      {
        id: "request",
        kind: "class",
        is_exported: true,
        name: "CreateRequest",
      },
    ],
    [],
    [],
  );
  graph.upsertFileGraph(
    "helpers-file",
    [
      { id: "helper-a", kind: "function", is_exported: false, name: "helperA" },
      { id: "helper-b", kind: "function", is_exported: false, name: "helperB" },
    ],
    [],
    [],
  );
  graph.upsertFileGraph(
    "root-file",
    [{ id: "create", kind: "function", is_exported: true, name: "create" }],
    [
      {
        src: "create",
        dst: "request",
        rel: "type",
        count: 1,
        first_line: 1,
        ref_name: "CreateRequest",
        kind: "REFS",
      },
      {
        src: "create",
        dst: "helper-a",
        rel: "call",
        count: 1,
        first_line: 2,
        ref_name: "helperA",
        kind: "CALLS",
      },
      {
        src: "create",
        dst: "helper-b",
        rel: "call",
        count: 1,
        first_line: 3,
        ref_name: "helperB",
        kind: "CALLS",
      },
    ],
    [],
  );
  const storage = storageFrom([
    entity("create", "create", "service.ts", { symbolType: "function" }),
    entity("request", "CreateRequest", "model/request.ts", {
      symbolType: "class",
    }),
    entity("helper-a", "helperA", "service/helpers.ts", {
      symbolType: "function",
    }),
    entity("helper-b", "helperB", "service/helpers.ts", {
      symbolType: "function",
    }),
  ]);

  const result = exploreGraph(graph, storage, {
    query: "execute workflow",
    seedId: "create",
    searchLimit: 1,
    maxFiles: 2,
  });

  const surface = result.changeSurface.find((item) => item.id === "request");
  assert.ok(surface);
  assert.equal(surface.rel, "type");
  assert.equal(surface.rescued, true);
  assert.ok(
    result.files.some(
      (file) =>
        file.file.relativePath === "model/request.ts" && file.isChangeSurface,
    ),
  );
  graph.close();
});

test("query-aligned change surface prefers a runtime collaborator over a passive type", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "root-file",
    [{ id: "root", kind: "class", is_exported: true, name: "ReflectiveFlow" }],
    [
      {
        src: "root",
        dst: "passive",
        rel: "type",
        count: 10,
        first_line: 1,
        ref_name: "ReflectiveAdapter",
        kind: "REFS",
      },
      {
        src: "root",
        dst: "runtime",
        rel: "type",
        count: 1,
        first_line: 2,
        ref_name: "SerializationAdapter",
        kind: "REFS",
      },
    ],
    [],
  );
  graph.upsertFileGraph(
    "passive-file",
    [
      {
        id: "passive",
        kind: "class",
        is_exported: true,
        name: "ReflectiveAdapter",
      },
    ],
    [],
    [],
  );
  graph.upsertFileGraph(
    "runtime-file",
    [
      {
        id: "runtime",
        kind: "class",
        is_exported: true,
        name: "SerializationAdapter",
      },
      { id: "invoke", kind: "function", is_exported: true, name: "invoke" },
    ],
    [
      {
        src: "runtime",
        dst: "invoke",
        rel: "contains",
        count: 1,
        first_line: 1,
        ref_name: "invoke",
        kind: "CONTAINS",
      },
      {
        src: "invoke",
        dst: "root",
        rel: "call",
        count: 1,
        first_line: 2,
        ref_name: "ReflectiveFlow",
        kind: "CALLS",
      },
    ],
    [],
  );
  const storage = storageFrom([
    entity("root", "ReflectiveFlow", "src/root.ts", { symbolType: "class" }),
    entity("passive", "ReflectiveAdapter", "src/passive.ts", {
      symbolType: "class",
    }),
    entity("runtime", "SerializationAdapter", "src/runtime.ts", {
      symbolType: "class",
    }),
    entity("invoke", "invoke", "src/runtime.ts", { symbolType: "function" }),
  ]);

  const result = exploreGraph(graph, storage, {
    query: "reflective adapter serialization",
    seedId: "root",
    maxFiles: 2,
  });

  assert.ok(
    result.files.some((file) => file.file.relativePath === "src/root.ts"),
  );
  assert.ok(
    result.files.some((file) => file.file.relativePath === "src/runtime.ts"),
    "a query-aligned type with independent integration evidence should win the surface slot",
  );
  assert.equal(
    result.files.some((file) => file.file.relativePath === "src/passive.ts"),
    false,
  );
  graph.close();
});

test("type-root state holders outrank incidental API signature files", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "state-file",
    [
      {
        id: "path-router",
        kind: "class",
        is_exported: false,
        name: "PathRouter",
      },
    ],
    [],
    [],
  );
  graph.upsertFileGraph(
    "api-file",
    [{ id: "response", kind: "class", is_exported: true, name: "Response" }],
    [],
    [],
  );
  graph.upsertFileGraph(
    "router-file",
    [
      { id: "router", kind: "class", is_exported: true, name: "Router" },
      {
        id: "router-inner",
        kind: "class",
        is_exported: false,
        name: "RouterInner",
      },
      { id: "route", kind: "function", is_exported: true, name: "route" },
    ],
    [
      {
        src: "router",
        dst: "router-inner",
        rel: "return",
        count: 1,
        first_line: 1,
        ref_name: "RouterInner",
        kind: "REFS",
      },
      {
        src: "router-inner",
        dst: "path-router",
        rel: "return",
        count: 1,
        first_line: 2,
        ref_name: "PathRouter",
        kind: "REFS",
      },
      {
        src: "router",
        dst: "route",
        rel: "contains",
        count: 1,
        first_line: 3,
        ref_name: "route",
        kind: "CONTAINS",
      },
      {
        src: "route",
        dst: "response",
        rel: "return",
        count: 8,
        first_line: 4,
        ref_name: "Response",
        kind: "REFS",
      },
    ],
    [],
  );
  const storage = storageFrom([
    entity("router", "Router", "routing/mod.rs", { symbolType: "class" }),
    entity("router-inner", "RouterInner", "routing/mod.rs", {
      symbolType: "class",
    }),
    entity("route", "route", "routing/mod.rs", { symbolType: "function" }),
    entity("path-router", "PathRouter", "routing/path_router.rs", {
      symbolType: "class",
    }),
    entity("response", "Response", "response.rs", { symbolType: "class" }),
  ]);

  const result = exploreGraph(graph, storage, {
    query: "Router",
    seedId: "router",
    maxFiles: 2,
  });
  assert.ok(
    result.files.some(
      (file) => file.file.relativePath === "routing/path_router.rs",
    ),
    result.files.map((file) => file.file.relativePath).join(", "),
  );
  graph.close();
});

test("exploreGraph omits a type root's self references from change surface", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "router-file",
    [
      { id: "router", kind: "interface", is_exported: true, name: "Router" },
      { id: "with", kind: "function", is_exported: true, name: "With" },
    ],
    [
      {
        src: "with",
        dst: "router",
        rel: "return",
        count: 1,
        first_line: 2,
        ref_name: "Router",
        kind: "REFS",
      },
    ],
    [],
    [{ parent_id: "router", child_id: "with" }],
  );
  const storage = storageFrom([
    entity("router", "Router", "router.go", { symbolType: "interface" }),
    entity("with", "With", "router.go", { symbolType: "function" }),
  ]);

  const result = exploreGraph(graph, storage, {
    query: "Router",
    seedId: "router",
  });

  assert.deepEqual(result.changeSurface, []);
  graph.close();
});

test("generic type fragments contribute one deduplicated change surface", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "router-file",
    [
      { id: "router", kind: "class", is_exported: true, name: "Router" },
      {
        id: "router-generic",
        kind: "class",
        is_exported: true,
        name: "Router<S>",
      },
      { id: "route", kind: "function", is_exported: true, name: "route" },
      { id: "layer", kind: "function", is_exported: true, name: "layer" },
      { id: "service", kind: "class", is_exported: true, name: "Service" },
    ],
    [
      {
        src: "router",
        dst: "route",
        rel: "contains",
        count: 1,
        first_line: 2,
        ref_name: "route",
        kind: "CONTAINS",
      },
      {
        src: "router-generic",
        dst: "layer",
        rel: "contains",
        count: 1,
        first_line: 3,
        ref_name: "layer",
        kind: "CONTAINS",
      },
      ...["route", "layer"].map((src, index) => ({
        src,
        dst: "service",
        rel: "return",
        count: 1,
        first_line: index + 4,
        ref_name: "Service",
        kind: "REFS",
      })),
    ],
    [],
  );
  const storage = storageFrom([
    entity("router", "Router", "router.rs", { symbolType: "class" }),
    entity("router-generic", "Router<S>", "router.rs", {
      symbolType: "class",
    }),
    entity("route", "route", "router.rs", { symbolType: "function" }),
    entity("layer", "layer", "router.rs", { symbolType: "function" }),
    entity("service", "Service", "service.rs", { symbolType: "class" }),
  ]);

  const result = exploreGraph(graph, storage, { query: "Router" });

  assert.deepEqual(
    result.changeSurface.map((item) => item.id),
    ["service"],
  );
  graph.close();
});

test("exploreGraph rescues domain types referenced by members of a type root", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "model-file",
    [{ id: "owner", kind: "class", is_exported: true, name: "Owner" }],
    [],
    [],
  );
  graph.upsertFileGraph(
    "repository-file",
    [
      {
        id: "repository",
        kind: "interface",
        is_exported: true,
        name: "OwnerRepository",
      },
    ],
    [],
    [],
  );
  graph.upsertFileGraph(
    "controller-file",
    [
      {
        id: "controller",
        kind: "class",
        is_exported: true,
        name: "OwnerController",
      },
      {
        id: "create",
        kind: "function",
        is_exported: false,
        name: "create",
      },
    ],
    [
      {
        src: "controller",
        dst: "create",
        rel: "contains",
        count: 1,
        first_line: 3,
        ref_name: "create",
        kind: "CONTAINS",
      },
      {
        src: "controller",
        dst: "repository",
        rel: "type",
        count: 1,
        first_line: 2,
        ref_name: "OwnerRepository",
        kind: "REFS",
      },
      {
        src: "create",
        dst: "owner",
        rel: "return",
        count: 1,
        first_line: 4,
        ref_name: "Owner",
        kind: "REFS",
      },
    ],
    [],
  );
  const storage = storageFrom([
    entity("controller", "OwnerController", "controller.ts", {
      symbolType: "class",
    }),
    entity("create", "create", "controller.ts", { symbolType: "function" }),
    entity("owner", "Owner", "domain/owner.ts", { symbolType: "class" }),
    entity("repository", "OwnerRepository", "domain/repository.ts", {
      symbolType: "interface",
    }),
  ]);

  const result = exploreGraph(graph, storage, {
    query: "OwnerController",
    maxFiles: 3,
  });

  assert.deepEqual(
    new Set(result.changeSurface.map((item) => item.id)),
    new Set(["owner", "repository"]),
  );
  assert.deepEqual(
    new Set(result.files.map((file) => file.file.relativePath)),
    new Set(["controller.ts", "domain/owner.ts", "domain/repository.ts"]),
  );
  graph.close();
});

test("queryGraphNeighborhood supports impact direction", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "fa",
    [
      { id: "user", kind: "function", is_exported: true, name: "user" },
      { id: "target", kind: "function", is_exported: true, name: "target" },
    ],
    [
      {
        src: "user",
        dst: "target",
        rel: "type",
        count: 1,
        first_line: 2,
        ref_name: "target",
        kind: "REFS",
      },
    ],
    [],
  );
  const storage = storageFrom([
    entity("user", "user", "a.ts", { symbolType: "function" }),
    entity("target", "target", "a.ts", { symbolType: "function" }),
  ]);

  const result = queryGraphNeighborhood(graph, storage, {
    direction: "impact",
    query: "target",
  });
  assert.equal(result.neighbors[0]?.id, "user");
  graph.close();
});

test("exploreGraph reports graph_unavailable", () => {
  const graph = {
    available: false,
    symbolScope() {
      return [];
    },
    fileScope() {
      return [];
    },
    expandSeeds() {
      return [];
    },
    expandContainers() {
      return [];
    },
    expandFileNeighbors() {
      return [];
    },
    callers() {
      return [];
    },
    callees() {
      return [];
    },
    impact() {
      return [];
    },
    usages() {
      return [];
    },
    pathBetween() {
      return null;
    },
    hierarchy() {
      return [];
    },
    members() {
      return [];
    },
    deadCode() {
      return [];
    },
    context() {
      return {
        focal: { id: "" },
        containers: [],
        members: [],
        incoming: [],
        outgoing: [],
      };
    },
    traverse() {
      return [];
    },
    stats() {
      return {
        symCount: 0,
        fileCount: 0,
        refCount: 0,
        pendingRefCount: 0,
        failedRefCount: 0,
        dynamicBoundaryCount: 0,
        externalRefCount: 0,
        callsCount: 0,
        refsCount: 0,
        inheritsCount: 0,
      };
    },
  };
  const result = exploreGraph(graph, storageFrom([]), { query: "X" });
  assert.equal(result.available, false);
  assert.equal(result.emptyReason, "graph_unavailable");
});

test("exploreGraph recalls natural-language seeds, preserves call paths, and reports blast radius", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "production",
    [
      { id: "login", kind: "function", is_exported: true, name: "login" },
      { id: "bridge", kind: "function", is_exported: false, name: "bridge" },
      {
        id: "validate",
        kind: "function",
        is_exported: true,
        name: "validateToken",
      },
      {
        id: "caller",
        kind: "function",
        is_exported: true,
        name: "requestHandler",
      },
    ],
    [
      {
        src: "login",
        dst: "bridge",
        rel: "call",
        count: 1,
        first_line: 2,
        ref_name: "bridge",
        kind: "CALLS",
      },
      {
        src: "bridge",
        dst: "validate",
        rel: "call",
        count: 1,
        first_line: 6,
        ref_name: "validateToken",
        kind: "CALLS",
      },
      {
        src: "caller",
        dst: "login",
        rel: "call",
        count: 1,
        first_line: 10,
        ref_name: "login",
        kind: "CALLS",
      },
    ],
    [],
  );
  graph.upsertFileGraph(
    "tests",
    [
      {
        id: "login-test",
        kind: "function",
        is_exported: false,
        name: "loginTest",
      },
    ],
    [
      {
        src: "login-test",
        dst: "login",
        rel: "call",
        count: 1,
        first_line: 3,
        ref_name: "login",
        kind: "CALLS",
      },
    ],
    [],
  );

  const storage = storageFrom([
    entity("login", "login", "src/auth.ts", {
      symbolType: "function",
      text: "export function login() {}",
    }),
    entity("bridge", "bridge", "src/auth.ts", {
      symbolType: "function",
      text: "function bridge() {}",
    }),
    entity("validate", "validateToken", "src/token.ts", {
      symbolType: "function",
      text: "export function validateToken() {}",
    }),
    entity("caller", "requestHandler", "src/http.ts", {
      symbolType: "function",
    }),
    entity("login-test", "loginTest", "test/auth.test.ts", {
      symbolType: "function",
    }),
  ]);

  const result = exploreGraph(graph, storage, {
    query: "how does login reach validateToken",
    searchLimit: 2,
    maxNodes: 16,
  });

  assert.deepEqual(
    new Set(result.roots.map((root) => root.id)),
    new Set(["login", "validate"]),
  );
  assert.ok(
    result.callPaths.some(
      (path) => path.nodes.join(",") === "login,bridge,validate",
    ),
  );
  assert.ok(
    result.nodes.some((node) => node.id === "bridge"),
    "path bridge is retained",
  );
  const loginBlast = result.blastRadius.find((item) => item.rootId === "login");
  assert.ok(loginBlast?.dependents.some((item) => item.id === "caller"));
  assert.ok(loginBlast?.tests.some((item) => item.id === "login-test"));
  graph.close();
});
