import assert from "node:assert/strict";
import test from "node:test";
import { querySymbolRelationships } from "../../dist/engine/pipeline/relationships/index.js";

function definition(id, name, scope = null) {
  return {
    id,
    fileId: "file",
    content: { kind: "text", text: "mentions helper" },
    range: { kind: "text", startLine: 1, endLine: 2 },
    metadata: { kind: "code", symbolName: name, scope, language: "typescript" },
  };
}
function storageFor(definitions) {
  const file = {
    id: "file",
    relativePath: "src/a.ts",
    indexStatus: { indexedTime: 1 },
  };
  return {
    listFiles: () => {
      throw new Error("must not scan all files");
    },
    listEntitiesByFile: () => {
      throw new Error("must not scan file entities");
    },
    getEntity: (id) => {
      const entity = definitions.find((entity) => entity.id === id);
      return entity ? { entity, file } : null;
    },
    searchFts: () => [],
    findSymbols: (name, scope) =>
      definitions
        .filter(
          (entity) =>
            entity.metadata.symbolName === name &&
            (scope === undefined || entity.metadata.scope === scope),
        )
        .map((entity) => ({ entity, file })),
  };
}

test("symbol resolution groups same-name definitions and excludes content-only mentions", async () => {
  const queried = [];
  const definitions = [
    definition("a", "helper", "A"),
    definition("b", "helper", "B"),
    definition("c", "other"),
  ];
  const groups = await querySymbolRelationships(
    " helper ",
    storageFor(definitions),
    async (id) => {
      queried.push(id);
      return [];
    },
  );
  assert.deepEqual(queried, ["a", "b"]);
  assert.deepEqual(
    groups.map((group) => [group.name, group.filePath, group.edges]),
    [
      ["A::helper", "src/a.ts", []],
      ["B::helper", "src/a.ts", []],
    ],
  );
  assert.deepEqual(
    (
      await querySymbolRelationships(
        "B::helper",
        storageFor(definitions),
        async () => [],
      )
    ).map((group) => group.name),
    ["B::helper"],
  );
  assert.deepEqual(
    await querySymbolRelationships(
      "Helper",
      storageFor(definitions),
      async () => {
        throw new Error("unexpected edge lookup");
      },
    ),
    [],
  );
  await assert.rejects(
    querySymbolRelationships(" ", storageFor([]), async () => []),
    /must not be empty/,
  );
});

test("symbol lookup returns every storage candidate, deduplicates IDs, and preserves call sites", async () => {
  const definitions = Array.from({ length: 600 }, (_, i) =>
    definition(`id-${i}`, "helper", `Scope${i}`),
  );
  definitions.push(definitions[0]);
  const groups = await querySymbolRelationships(
    "helper",
    storageFor(definitions),
    async (id) => [
      { source: id, target: "target", line: 1 },
      { source: id, target: "target", line: 2 },
    ],
  );
  assert.equal(groups.length, 600);
  assert.equal(new Set(groups.map((group) => group.name)).size, 600);
  assert.ok(groups.every((group) => group.edges.length === 2));
});

test("limit caps edges per symbol while preserving all matches and storage results", async () => {
  const storage = storageFor([
    definition("a", "helper", "A"),
    definition("b", "helper", "B"),
    definition("empty", "helper"),
  ]);
  const edges = [1, 2, 3].map((line) => ({ source: "a", target: "b", line }));
  const query = async (id) => (id === "empty" ? [] : edges);
  const limited = await querySymbolRelationships("helper", storage, query, 1);
  assert.deepEqual(
    limited.map(({ name, edges }) => [
      name,
      edges.map(({ line }) => ({ line })),
    ]),
    [
      ["A::helper", [{ line: 1 }]],
      ["B::helper", [{ line: 1 }]],
      ["helper", []],
    ],
  );
  assert.equal(edges.length, 3);
  for (const limit of [undefined, 10]) {
    const groups = await querySymbolRelationships(
      "helper",
      storage,
      query,
      limit,
    );
    assert.deepEqual(
      groups.map((group) => group.edges.length),
      [3, 3, 0],
    );
  }
  for (const limit of [0, -1, 1.5, NaN, Infinity]) {
    await assert.rejects(
      querySymbolRelationships("helper", storage, query, limit),
      /positive safe integer/,
    );
  }
});

test("edge endpoints include cross-file definitions, cache lookups, and respect limit", async () => {
  const storage = storageFor([definition("helper", "helper")]);
  const lookups = [];
  storage.getEntity = (id) => {
    lookups.push(id);
    if (id !== "caller") return null;
    return {
      entity: {
        ...definition("caller", "run", "Worker"),
        range: { kind: "text", startLine: 10, endLine: 20 },
      },
      file: { relativePath: "src/worker.ts" },
    };
  };
  const edges = [
    { source: "caller", target: "helper", line: 12 },
    { source: "caller", target: "helper", line: 15 },
    { source: "missing", target: "helper", line: 18 },
    { source: "truncated", target: "helper", line: 19 },
  ];
  const [match] = await querySymbolRelationships(
    "helper",
    storage,
    async () => edges,
    3,
  );
  assert.deepEqual(lookups, ["caller", "missing"]);
  assert.deepEqual(match.edges[0].symbol, {
    name: "Worker::run",
    filePath: "src/worker.ts",
    startLine: 10,
    endLine: 20,
  });
  assert.deepEqual(
    Object.keys(match).sort(),
    ["name", "filePath", "startLine", "endLine", "edges", "totalEdges"].sort(),
  );
  assert.deepEqual(
    Object.keys(match.edges[0]).sort(),
    ["symbol", "line", "column"].sort(),
  );
  assert.equal(match.edges[0].line, 12);
  assert.equal(match.edges[2].symbol, null);
  assert.equal(edges[0].symbol, undefined);
});

test("default limit is 20 per match and totalEdges reports the full count", async () => {
  const storage = storageFor([
    definition("a", "helper", "A"),
    definition("b", "helper", "B"),
    definition("empty", "helper"),
  ]);
  const query = async (id) =>
    id === "empty"
      ? []
      : Array.from({ length: 25 }, (_, i) => ({
          source: id,
          target: id,
          line: i + 1,
          column: 0,
        }));
  for (const [limit, expected] of [
    [undefined, 20],
    [5, 5],
    [30, 25],
  ]) {
    const matches = await querySymbolRelationships(
      "helper",
      storage,
      query,
      limit,
    );
    assert.deepEqual(
      matches.map((match) => [
        match.name,
        match.totalEdges,
        match.edges.length,
      ]),
      [
        ["A::helper", 25, expected],
        ["B::helper", 25, expected],
        ["helper", 0, 0],
      ],
    );
  }
});

test("relationship pipeline owns FTS fallback, scope filtering, and fragment deduplication", async () => {
  const defs = [definition("a", "helper", "A"), definition("b", "caller", "B")];
  const storage = storageFor(defs);
  const queries = [];
  storage.searchFts = (query, limit) => {
    queries.push([query, limit]);
    return [defs[0], defs[0], defs[1]].map((entity, index) => ({
      fragment: { ...entity, id: `chunk-${index}`, group: entity.id },
      file: { relativePath: "src/a.ts", indexStatus: { indexedTime: 1 } },
    }));
  };
  const exact = await querySymbolRelationships(
    "helper",
    storage,
    async () => [],
  );
  assert.equal(exact.length, 1);
  assert.deepEqual(queries, []);
  const fallback = await querySymbolRelationships(
    "HELPER",
    storage,
    async () => [],
  );
  assert.deepEqual(
    fallback.map((match) => match.name),
    ["A::helper", "B::caller"],
  );
  assert.deepEqual(queries, [["helper", 100]]);
  const scoped = await querySymbolRelationships(
    "B::HELPER",
    storage,
    async () => [],
  );
  assert.deepEqual(
    scoped.map((match) => match.name),
    ["B::caller"],
  );
});
