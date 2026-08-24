import assert from "node:assert/strict";
import test from "node:test";
import {
  SqliteGraphStorage,
  queryGraphNeighborhood,
} from "../../dist/engine/graph/index.js";
import { isTestPath } from "../../dist/engine/graph/path-policy.js";
import {
  searchWorkspaceIndex,
  selectVisibleCandidates,
} from "../../dist/engine/pipeline/search/index.js";

function entity(id, name, path = "a.ts") {
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
        startLine: 1,
        endLine: 3,
        startOffset: 0,
        endOffset: 10,
      },
      content: { kind: "text", text: `function ${name}() {\n  return 1;\n}` },
      metadata: {
        kind: "code",
        symbolType: "function",
        symbolName: name,
        scope: null,
        nodeType: "function_declaration",
        signature: `function ${name}()`,
        doc: null,
        modifiers: ["exported"],
      },
    },
  };
}

test("query reserves one direct graph neighbor from a new file", () => {
  const seed = entity("seed", "seed", "feature.ts");
  const duplicate = entity("duplicate", "duplicate", "feature.ts");
  const neighbor = entity("neighbor", "neighbor", "store.ts");
  const candidate = (stored, rank, sources) => ({
    id: stored.entity.id,
    entity: stored.entity,
    file: stored.file,
    sources: new Set(sources),
    recall: [],
    evidence: [],
    score: 1 / rank,
    rank,
    forced: false,
  });
  const visible = selectVisibleCandidates(
    [
      candidate(seed, 1, ["fts"]),
      candidate(duplicate, 2, ["vector"]),
      candidate(neighbor, 3, ["graph"]),
    ],
    2,
    [
      {
        srcId: "seed",
        dstId: "neighbor",
        srcLabel: "seed",
        dstLabel: "neighbor",
        kind: "REFS",
        scope: "symbol",
      },
    ],
    ["seed"],
  );

  assert.deepEqual(
    visible.map((item) => item.id),
    ["seed", "neighbor"],
  );
  assert.equal(visible[1].selectionRank, 2);
  assert.equal(visible[1].forced, true);
});

test("query promotes a direct graph neighbor beyond the lexical cutoff window", () => {
  const seed = entity("seed-deep", "Graphiti", "graphiti.py");
  const duplicate = entity("duplicate-deep", "initialize", "graphiti.py");
  const neighbor = entity("neighbor-deep", "ZepGraphiti", "zep_graphiti.py");
  const candidate = (stored, rank, sources) => ({
    id: stored.entity.id,
    entity: stored.entity,
    file: stored.file,
    sources: new Set(sources),
    recall: [],
    evidence: [],
    score: 1 / rank,
    rank,
    forced: false,
  });
  const lexicalFillers = Array.from({ length: 20 }, (_, index) =>
    candidate(
      entity(`filler-${index}`, `filler${index}`, `filler-${index}.py`),
      index + 3,
      ["vector"],
    ),
  );
  const visible = selectVisibleCandidates(
    [
      candidate(seed, 1, ["fts", "vector"]),
      candidate(duplicate, 2, ["vector"]),
      ...lexicalFillers,
      candidate(neighbor, 30, ["graph"]),
    ],
    2,
    [
      {
        srcId: "neighbor-deep",
        dstId: "seed-deep",
        srcLabel: "ZepGraphiti",
        dstLabel: "Graphiti",
        kind: "INHERITS",
        scope: "symbol",
      },
    ],
    ["seed-deep"],
    "Graphiti",
  );

  assert.deepEqual(
    visible.map((item) => item.id),
    ["seed-deep", "neighbor-deep"],
  );
  assert.equal(visible[1].forced, true);
});

test("query prefers a structural neighbor of the strongest seed", () => {
  const primary = entity("primary", "Graphiti", "graphiti.py");
  const secondary = entity("secondary", "initialize", "server.py");
  const duplicate = entity("duplicate-primary", "close", "graphiti.py");
  const primaryNeighbor = entity("primary-neighbor", "ZepGraphiti", "zep.py");
  const secondaryNeighbor = entity("secondary-neighbor", "Config", "config.py");
  const candidate = (stored, rank, sources) => ({
    id: stored.entity.id,
    entity: stored.entity,
    file: stored.file,
    sources: new Set(sources),
    recall: [],
    evidence: [],
    score: 1 / rank,
    rank,
    forced: false,
  });
  const visible = selectVisibleCandidates(
    [
      candidate(primary, 1, ["fts", "vector"]),
      candidate(duplicate, 2, ["vector"]),
      candidate(secondary, 3, ["vector"]),
      candidate(secondaryNeighbor, 4, ["graph"]),
      candidate(primaryNeighbor, 30, ["graph"]),
    ],
    2,
    [
      {
        srcId: "primary-neighbor",
        dstId: "primary",
        srcLabel: "ZepGraphiti",
        dstLabel: "Graphiti",
        kind: "INHERITS",
        scope: "symbol",
      },
      {
        srcId: "secondary",
        dstId: "secondary-neighbor",
        srcLabel: "initialize",
        dstLabel: "Config",
        kind: "REFS",
        scope: "symbol",
      },
    ],
    ["primary", "secondary"],
    "Graphiti",
  );

  assert.deepEqual(
    visible.map((item) => item.id),
    ["primary", "primary-neighbor"],
  );
});

test("exact type query does not spend hit budget on a nested duplicate", () => {
  const owner = entity("owner", "Widget", "widget.ts");
  owner.entity.metadata.symbolType = "class";
  owner.entity.range.endOffset = 100;
  const constructor = entity("constructor", "Widget", "widget.ts");
  constructor.entity.range = {
    kind: "text",
    startLine: 2,
    endLine: 2,
    startOffset: 20,
    endOffset: 40,
  };
  const implementation = entity("implementation", "WidgetImpl", "impl.ts");
  implementation.entity.metadata.symbolType = "class";
  const candidate = (stored, rank, sources) => ({
    id: stored.entity.id,
    entity: stored.entity,
    file: stored.file,
    sources: new Set(sources),
    recall: [],
    evidence: [],
    score: 1 / rank,
    rank,
    forced: false,
  });

  const visible = selectVisibleCandidates(
    [
      candidate(owner, 1, ["fts", "vector"]),
      candidate(constructor, 2, ["fts"]),
      candidate(implementation, 3, ["graph"]),
    ],
    2,
    [],
    ["owner"],
    "Widget",
  );

  assert.deepEqual(
    visible.map((item) => item.id),
    ["owner", "implementation"],
  );
});

test("query may replace a secondary seed when its file is already represented", () => {
  const root = entity("root", "CounterStore", "view.vue");
  root.entity.metadata.symbolType = "component";
  const duplicateSeed = entity("duplicate-seed", "counterStore", "view.vue");
  const neighbor = entity("neighbor", "useCounter", "store.ts");
  const candidate = (stored, rank, sources) => ({
    id: stored.entity.id,
    entity: stored.entity,
    file: stored.file,
    sources: new Set(sources),
    recall: [],
    evidence: [],
    score: 1 / rank,
    rank,
    forced: false,
  });

  const visible = selectVisibleCandidates(
    [
      candidate(root, 1, ["fts", "vector"]),
      candidate(duplicateSeed, 2, ["fts"]),
      candidate(neighbor, 3, ["graph"]),
    ],
    2,
    [
      {
        srcId: "root",
        dstId: "neighbor",
        srcLabel: "CounterStore",
        dstLabel: "useCounter",
        kind: "REFS",
        scope: "symbol",
      },
    ],
    ["root", "duplicate-seed"],
    "CounterStore",
  );

  assert.deepEqual(
    visible.map((item) => item.id),
    ["root", "neighbor"],
  );
  assert.equal(visible[1].forced, true);
});

test("shared graph path policy recognizes language test conventions without substring false positives", () => {
  for (const path of [
    "src/foo.test.ts",
    "pkg/bar_test.go",
    "src/test/java/Foo.java",
    "src/FooTest.java",
    "src/jvmTest/kotlin/Foo.kt",
    "Tests/SessionTests.swift",
    "packages/pinia/test-dts/mapHelpers.test-d.ts",
  ]) {
    assert.equal(isTestPath(path), true, path);
  }
  for (const path of [
    "src/latest/loader.ts",
    "lib/manifest.go",
    "src/contestEntry.ts",
    "src/RealCall.java",
  ]) {
    assert.equal(isTestPath(path), false, path);
  }
});

test("queryGraphNeighborhood enriches callers from storage", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "fa",
    [
      { id: "caller", kind: "function", is_exported: true, name: "caller" },
      { id: "target", kind: "function", is_exported: true, name: "target" },
    ],
    [
      {
        src: "caller",
        dst: "target",
        rel: "call",
        count: 2,
        first_line: 2,
        ref_name: "target",
        kind: "CALLS",
      },
    ],
    [],
  );

  const entities = new Map([
    ["caller", entity("caller", "caller")],
    ["target", entity("target", "target")],
  ]);
  const storage = {
    findSymbolsByName(name) {
      return [...entities.values()].filter(
        (item) => item.entity.metadata.symbolName === name,
      );
    },
    getEntity(id) {
      return entities.get(id) ?? null;
    },
  };

  const result = queryGraphNeighborhood(graph, storage, {
    direction: "callers",
    query: "target",
  });

  assert.equal(result.available, true);
  assert.equal(result.seed?.id, "target");
  assert.equal(result.neighbors.length, 1);
  assert.equal(result.neighbors[0].id, "caller");
  assert.equal(
    result.neighbors[0].entity?.entity.metadata.symbolName,
    "caller",
  );

  const callees = queryGraphNeighborhood(graph, storage, {
    direction: "callees",
    query: "caller",
  });
  assert.equal(callees.neighbors[0]?.id, "target");
  assert.equal(callees.neighbors[0]?.count, 2);
  graph.close();
});

test("graph neighborhood rejects fuzzy seeds and resolves qualified names", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "fa",
    [
      { id: "service", kind: "class", is_exported: true, name: "Service" },
      { id: "noise", kind: "function", is_exported: true, name: "Noise" },
    ],
    [],
    [],
  );
  const service = entity("service", "Service");
  service.entity.metadata.scope = "app";
  const noise = entity("noise", "Noise");
  const entities = new Map([
    ["service", service],
    ["noise", noise],
  ]);
  const storage = {
    findSymbolsByName() {
      // Model an FTS backend returning a semantically similar false positive.
      return [noise, service];
    },
    getEntity(id) {
      return entities.get(id) ?? null;
    },
  };

  const missing = queryGraphNeighborhood(graph, storage, {
    direction: "impact",
    query: "MissingService",
  });
  assert.equal(missing.seeds.length, 0);

  const qualified = queryGraphNeighborhood(graph, storage, {
    direction: "impact",
    query: "app::Service",
  });
  assert.equal(qualified.seed?.id, "service");
  assert.equal(qualified.ambiguous, undefined);
  graph.close();
});

test("impact defaults to two dependency levels", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "fa",
    [
      { id: "root", kind: "function", is_exported: true, name: "root" },
      { id: "middle", kind: "function", is_exported: true, name: "middle" },
      { id: "outer", kind: "function", is_exported: true, name: "outer" },
    ],
    [
      {
        src: "middle",
        dst: "root",
        rel: "call",
        count: 1,
        first_line: 2,
        ref_name: "root",
        kind: "CALLS",
      },
      {
        src: "outer",
        dst: "middle",
        rel: "call",
        count: 1,
        first_line: 3,
        ref_name: "middle",
        kind: "CALLS",
      },
    ],
    [],
  );
  const entities = new Map(
    ["root", "middle", "outer"].map((name) => [name, entity(name, name)]),
  );
  const storage = {
    findSymbolsByName(name) {
      const match = entities.get(name);
      return match ? [match] : [];
    },
    getEntity(id) {
      return entities.get(id) ?? null;
    },
  };

  const result = queryGraphNeighborhood(graph, storage, {
    direction: "impact",
    query: "root",
    limit: 1,
  });
  assert.equal(result.depth, 2);
  assert.equal(result.truncated, true);
  assert.deepEqual(
    result.neighbors.map((item) => item.id),
    ["middle"],
  );
  graph.close();
});

test("impact keeps production dependents ahead of tests within the result limit", () => {
  const root = entity("root", "root", "src/root.ts");
  const production = entity("production", "production", "src/use.ts");
  const tests = Array.from({ length: 24 }, (_, index) =>
    entity(`test-${index}`, `test${index}`, `test/use-${index}.test.ts`),
  );
  const entities = new Map(
    [root, production, ...tests].map((item) => [item.entity.id, item]),
  );
  const graph = {
    available: true,
    impact(_id, _depth, limit) {
      return [
        ...tests.map((item) => ({ id: item.entity.id })),
        { id: production.entity.id },
      ].slice(0, limit);
    },
  };
  const storage = {
    findSymbolsByName(name) {
      return name === "root" ? [root] : [];
    },
    getEntity(id) {
      return entities.get(id) ?? null;
    },
  };

  const result = queryGraphNeighborhood(graph, storage, {
    direction: "impact",
    query: "root",
    limit: 5,
  });

  assert.equal(result.truncated, true);
  assert.equal(result.neighbors[0]?.id, "production");
  assert.equal(result.neighbors.length, 5);
});

test("a type and its constructor overloads resolve to the type seed", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "fa",
    [
      { id: "pipeline", kind: "class", is_exported: true, name: "Pipeline" },
      { id: "ctor-a", kind: "function", is_exported: true, name: "Pipeline" },
      { id: "ctor-b", kind: "function", is_exported: true, name: "Pipeline" },
    ],
    [],
    [],
  );
  const pipeline = entity("pipeline", "Pipeline");
  pipeline.entity.metadata.symbolType = "class";
  pipeline.entity.metadata.scope = "app";
  const constructor = (id) => {
    const result = entity(id, "Pipeline");
    result.entity.metadata.scope = "app::Pipeline";
    return result;
  };
  const entities = [pipeline, constructor("ctor-a"), constructor("ctor-b")];
  const storage = {
    findSymbolsByName() {
      return entities;
    },
    getEntity(id) {
      return entities.find((item) => item.entity.id === id) ?? null;
    },
  };

  const result = queryGraphNeighborhood(graph, storage, {
    direction: "impact",
    query: "Pipeline",
  });
  assert.equal(result.ambiguous, undefined);
  assert.equal(result.seed?.id, "pipeline");
  assert.deepEqual(
    result.seeds.map((seed) => seed.id),
    ["pipeline"],
  );
  graph.close();
});

test("declaration and implementation form one neighborhood seed", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "fa",
    [
      { id: "decl", kind: "function", is_exported: true, name: "Open" },
      { id: "impl", kind: "function", is_exported: true, name: "Open" },
      { id: "from-decl", kind: "function", is_exported: true, name: "header" },
      { id: "from-impl", kind: "function", is_exported: true, name: "body" },
    ],
    [
      {
        src: "from-decl",
        dst: "decl",
        rel: "call",
        count: 1,
        first_line: 1,
        ref_name: "header",
        kind: "CALLS",
      },
      {
        src: "from-impl",
        dst: "impl",
        rel: "call",
        count: 1,
        first_line: 2,
        ref_name: "body",
        kind: "CALLS",
      },
    ],
    [],
  );
  const declaration = entity("decl", "Open", "thing.h");
  declaration.entity.metadata.scope = "Thing";
  declaration.entity.content.text = "void Open();";
  const implementation = entity("impl", "Open", "thing.cc");
  implementation.entity.metadata.scope = "Thing";
  implementation.entity.content.text = "void Thing::Open() { body(); }";
  const header = entity("from-decl", "header");
  const body = entity("from-impl", "body");
  const entities = new Map(
    [declaration, implementation, header, body].map((item) => [
      item.entity.id,
      item,
    ]),
  );
  const storage = {
    findSymbolsByName(name) {
      return [...entities.values()].filter(
        (item) => item.entity.metadata.symbolName === name,
      );
    },
    getEntity(id) {
      return entities.get(id) ?? null;
    },
  };

  const result = queryGraphNeighborhood(graph, storage, {
    direction: "callers",
    query: "Thing::Open",
  });
  assert.equal(result.ambiguous, undefined);
  assert.equal(result.seed?.id, "impl");
  assert.deepEqual(
    result.neighbors.map((neighbor) => neighbor.id),
    ["from-decl", "from-impl"],
  );
  graph.close();
});

test("public C declarations group platform-specific implementations", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "platform",
    [
      { id: "decl", kind: "function", is_exported: true, name: "uv_run" },
      { id: "unix", kind: "function", is_exported: true, name: "uv_run" },
      { id: "win", kind: "function", is_exported: true, name: "uv_run" },
      {
        id: "unix-user",
        kind: "function",
        is_exported: true,
        name: "unix_user",
      },
      { id: "win-user", kind: "function", is_exported: true, name: "win_user" },
    ],
    [
      {
        src: "unix-user",
        dst: "unix",
        rel: "call",
        count: 1,
        first_line: 1,
        ref_name: "uv_run",
        kind: "CALLS",
      },
      {
        src: "win-user",
        dst: "win",
        rel: "call",
        count: 1,
        first_line: 2,
        ref_name: "uv_run",
        kind: "CALLS",
      },
    ],
    [],
  );
  const declaration = entity("decl", "uv_run", "include/uv.h");
  declaration.file.format = "c";
  declaration.entity.content.text = "int uv_run(void);";
  const unix = entity("unix", "uv_run", "src/unix/core.c");
  unix.file.format = "c";
  unix.entity.content.text = "int uv_run(void) { return 1; }";
  const win = entity("win", "uv_run", "src/win/core.c");
  win.file.format = "c";
  win.entity.content.text = "int uv_run(void) { return 2; }";
  const entities = new Map(
    [
      declaration,
      unix,
      win,
      entity("unix-user", "unix_user", "src/unix/user.c"),
      entity("win-user", "win_user", "src/win/user.c"),
    ].map((item) => [item.entity.id, item]),
  );
  const storage = {
    findSymbolsByName(name) {
      return [...entities.values()].filter(
        (item) => item.entity.metadata.symbolName === name,
      );
    },
    getEntity(id) {
      return entities.get(id) ?? null;
    },
  };

  const result = queryGraphNeighborhood(graph, storage, {
    direction: "callers",
    query: "uv_run",
  });

  assert.equal(result.ambiguous, undefined);
  assert.deepEqual(
    new Set(result.neighbors.map((neighbor) => neighbor.id)),
    new Set(["unix-user", "win-user"]),
  );
  graph.close();
});

test("platform directories do not collapse overloads with different arity", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  const declaration = entity("decl", "open_api", "include/api.h");
  declaration.file.format = "cpp";
  declaration.entity.content.text = "void open_api(int value);";
  declaration.entity.metadata.arity = 1;
  const unix = entity("unix", "open_api", "src/unix/api.cc");
  unix.file.format = "cpp";
  unix.entity.content.text = "void open_api(int value) { use(value); }";
  unix.entity.metadata.arity = 1;
  const win = entity("win", "open_api", "src/win/api.cc");
  win.file.format = "cpp";
  win.entity.content.text =
    "void open_api(int value, int flags) { use(value); }";
  win.entity.metadata.arity = 2;
  const entities = new Map(
    [declaration, unix, win].map((item) => [item.entity.id, item]),
  );
  const storage = {
    findSymbolsByName(name) {
      return [...entities.values()].filter(
        (item) => item.entity.metadata.symbolName === name,
      );
    },
    getEntity(id) {
      return entities.get(id) ?? null;
    },
  };

  const result = queryGraphNeighborhood(graph, storage, {
    direction: "callers",
    query: "open_api",
  });

  assert.equal(result.ambiguous, true);
  graph.close();
});

test("generic type implementation fragments form one neighborhood seed", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "router.rs",
    [
      { id: "router", kind: "class", is_exported: true, name: "Router" },
      {
        id: "router-generic",
        kind: "class",
        is_exported: true,
        name: "Router<S>",
      },
      { id: "route", kind: "function", is_exported: true, name: "route" },
      {
        id: "decl-user",
        kind: "function",
        is_exported: true,
        name: "declUser",
      },
      {
        id: "impl-user",
        kind: "function",
        is_exported: true,
        name: "implUser",
      },
    ],
    [
      {
        src: "decl-user",
        dst: "router",
        rel: "ref",
        count: 1,
        first_line: 1,
        ref_name: "Router",
        kind: "REFS",
      },
      {
        src: "router-generic",
        dst: "route",
        rel: "contains",
        count: 1,
        first_line: 2,
        ref_name: "route",
        kind: "CONTAINS",
      },
      {
        src: "impl-user",
        dst: "route",
        rel: "call",
        count: 1,
        first_line: 3,
        ref_name: "route",
        kind: "CALLS",
      },
    ],
    [],
  );
  const declaration = entity("router", "Router", "router.rs");
  declaration.entity.metadata.symbolType = "class";
  declaration.entity.metadata.signature = "pub struct Router<S>";
  const implementation = entity("router-generic", "Router<S>", "router.rs");
  implementation.entity.metadata.symbolType = "class";
  implementation.entity.metadata.signature = "impl<S> Router<S>";
  const entities = new Map(
    [
      declaration,
      implementation,
      entity("route", "route", "router.rs"),
      entity("decl-user", "declUser", "router.rs"),
      entity("impl-user", "implUser", "router.rs"),
    ].map((item) => [item.entity.id, item]),
  );
  const storage = {
    findSymbolsByName(name) {
      return [...entities.values()].filter(
        (item) => item.entity.metadata.symbolName === name,
      );
    },
    findSymbolsByQuery(query) {
      return [...entities.values()].filter((item) =>
        item.entity.metadata.symbolName.includes(query),
      );
    },
    getEntity(id) {
      return entities.get(id) ?? null;
    },
  };

  const result = queryGraphNeighborhood(graph, storage, {
    direction: "impact",
    query: "Router",
  });

  assert.equal(result.ambiguous, undefined);
  assert.deepEqual(
    new Set(result.neighbors.map((neighbor) => neighbor.id)),
    new Set(["decl-user", "impl-user"]),
  );
  graph.close();
});

test("same-named definitions are traversed as isolated neighborhood groups", () => {
  const left = entity("left-service", "Service", "apps/left/service.ts");
  const right = entity("right-service", "Service", "apps/right/service.ts");
  left.entity.metadata.scope = "app";
  right.entity.metadata.scope = "app";
  left.entity.metadata.symbolType = "class";
  right.entity.metadata.symbolType = "class";
  left.entity.content.text = "class Service { run() {} }";
  right.entity.content.text = "class Service { run() {} }";
  const leftCaller = entity("left-caller", "leftCaller", "apps/left/main.ts");
  const rightCaller = entity(
    "right-caller",
    "rightCaller",
    "apps/right/main.ts",
  );
  const entities = new Map(
    [left, right, leftCaller, rightCaller].map((item) => [
      item.entity.id,
      item,
    ]),
  );
  const graph = {
    available: true,
    callers(id) {
      if (id === "left-service") return [{ id: "left-caller" }];
      if (id === "right-service") return [{ id: "right-caller" }];
      return [];
    },
  };
  const storage = {
    findSymbolsByName(name) {
      return name === "Service" ? [left, right] : [];
    },
    getEntity(id) {
      return entities.get(id) ?? null;
    },
  };

  const grouped = queryGraphNeighborhood(graph, storage, {
    direction: "callers",
    query: "Service",
  });
  assert.equal(grouped.ambiguous, true);
  assert.deepEqual(
    grouped.groups?.map((group) => ({
      seed: group.seed.id,
      neighbors: group.neighbors.map((neighbor) => neighbor.id),
    })),
    [
      { seed: "left-service", neighbors: ["left-caller"] },
      { seed: "right-service", neighbors: ["right-caller"] },
    ],
  );
  assert.deepEqual(grouped.neighbors, []);

  const narrowed = queryGraphNeighborhood(graph, storage, {
    direction: "callers",
    query: "Service",
    file: "apps/right/service.ts",
  });
  assert.equal(narrowed.ambiguous, undefined);
  assert.equal(narrowed.seed?.id, "right-service");
  assert.deepEqual(
    narrowed.neighbors.map((neighbor) => neighbor.id),
    ["right-caller"],
  );

  const fallback = queryGraphNeighborhood(graph, storage, {
    direction: "callers",
    query: "Service",
    file: "apps/missing/service.ts",
  });
  assert.equal(fallback.fileFilterMismatch, "apps/missing/service.ts");
  assert.equal(fallback.groups?.length, 2);
});

function indexedFile(id, relativePath) {
  return {
    id,
    collectionId: "c",
    absolutePath: `/repo/${relativePath}`,
    relativePath,
    rootPath: "/repo",
    sizeBytes: 1,
    lastModifiedTime: 1,
    kind: "code",
    format: "typescript",
  };
}

test("searchWorkspaceIndex does not graph-boost an isolated seed", async () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "file-a.ts",
    [{ id: "seed", kind: "function", is_exported: true, name: "seed" }],
    [],
    [],
  );
  const seed = entity("seed", "seed", "a.ts");
  const storage = {
    getEntity(id) {
      return id === "seed" ? seed : null;
    },
    listEntitiesByFile() {
      return [seed];
    },
    searchFts(_query, limit) {
      return [
        {
          path: "fts",
          score: 1,
          file: seed.file,
          fragment: {
            id: seed.entity.id,
            fileId: seed.entity.fileId,
            range: seed.entity.range,
            content: seed.entity.content,
            metadata: seed.entity.metadata,
          },
        },
      ].slice(0, limit);
    },
    searchVector() {
      return [];
    },
    getFileById() {
      return null;
    },
    getFileByPath() {
      return null;
    },
    listFilesByPathPrefix() {
      return [];
    },
    listFiles() {
      return [];
    },
    upsertFile() {},
    markFileFailed() {},
    deleteFile() {},
    async optimize() {},
    close() {},
  };

  const result = await searchWorkspaceIndex(
    { routes: [{ mode: "fts", query: "seed" }], limit: 10, trace: true },
    {
      workspaceIndex: { id: "c", name: "c", path: "/tmp/c" },
      storage,
      graph,
    },
  );

  assert.equal(result.graphExpand?.neighborsAdded, 0);
  assert.equal(
    result.hits[0].trace.recall.some(
      (recall) => recall.routeId === "graph.explore",
    ),
    false,
  );
  graph.close();
});

test("searchWorkspaceIndex silently expands IMPORTS file neighbors into hits", async () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  const fileA = indexedFile("file-a.ts", "a.ts");
  const fileB = indexedFile("file-b.ts", "b.ts");

  graph.upsertFileGraph(
    fileA.id,
    [{ id: "seed", kind: "function", is_exported: true, name: "seed" }],
    [],
    [
      {
        owner: fileA.id,
        id: "ref-import-b",
        ref_name: "./b",
        ref_kind: "import",
        line: 1,
        owner_is_file: true,
      },
    ],
  );
  graph.upsertFileGraph(
    fileB.id,
    [{ id: "utilFn", kind: "function", is_exported: true, name: "utilFn" }],
    [],
    [],
  );
  await graph.resolvePending({ files: [fileA, fileB] });
  assert.deepEqual(
    graph.expandFileNeighbors([fileA.id], 10).map((n) => n.id),
    [fileB.id],
  );

  const seed = entity("seed", "seed", "a.ts");
  const util = entity("utilFn", "utilFn", "b.ts");
  const byId = new Map([
    ["seed", seed],
    ["utilFn", util],
  ]);
  const byFile = new Map([
    [fileA.id, [seed]],
    [fileB.id, [util]],
  ]);

  const storage = {
    getEntity(id) {
      return byId.get(id) ?? null;
    },
    listEntitiesByFile(fileId) {
      return byFile.get(fileId) ?? [];
    },
    searchFts(query, limit) {
      if (query.includes("seed") || query === "seedFn") {
        return [
          {
            path: "fts",
            score: 1,
            file: seed.file,
            fragment: {
              id: seed.entity.id,
              fileId: seed.entity.fileId,
              range: seed.entity.range,
              content: seed.entity.content,
              metadata: seed.entity.metadata,
            },
          },
        ].slice(0, limit);
      }
      return [];
    },
    searchVector() {
      return [];
    },
    getFileById() {
      return null;
    },
    getFileByPath() {
      return null;
    },
    listFilesByPathPrefix() {
      return [];
    },
    listFiles() {
      return [];
    },
    upsertFile() {},
    markFileFailed() {},
    deleteFile() {},
    async optimize() {},
    close() {},
  };

  const result = await searchWorkspaceIndex(
    { routes: [{ mode: "fts", query: "seedFn" }], limit: 10 },
    {
      workspaceIndex: { id: "c", name: "c", path: "/tmp/c" },
      storage,
      graph,
    },
  );

  assert.equal(result.graphExpand?.available, true);
  assert.ok(result.graphExpand?.neighborsAdded >= 1);
  const neighborHit = result.hits.find((hit) => hit.entity.id === "utilFn");
  assert.ok(neighborHit, "IMPORTS neighbor entity should appear in hits");
  assert.equal(neighborHit.matchedBy, "graph");
  assert.ok(
    result.relationships.some((relation) => relation.kind === "IMPORTS"),
  );
  const importRelation = result.relationships.find(
    (relation) => relation.kind === "IMPORTS",
  );
  assert.equal(importRelation.srcId, fileA.id);
  assert.equal(importRelation.dstId, fileB.id);
  graph.close();
});

test("searchWorkspaceIndex preserves incoming IMPORTS direction", async () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  const fileA = indexedFile("file-a.ts", "a.ts");
  const fileB = indexedFile("file-b.ts", "b.ts");
  graph.upsertFileGraph(
    fileA.id,
    [{ id: "seed", kind: "function", is_exported: true, name: "seed" }],
    [],
    [],
  );
  graph.upsertFileGraph(
    fileB.id,
    [{ id: "caller", kind: "function", is_exported: true, name: "caller" }],
    [],
    [
      {
        owner: fileB.id,
        id: "ref-import-a",
        ref_name: "./a",
        ref_kind: "import",
        line: 1,
        owner_is_file: true,
      },
    ],
  );
  await graph.resolvePending({ files: [fileA, fileB] });

  const seed = entity("seed", "seed", "a.ts");
  const caller = entity("caller", "caller", "b.ts");
  const byId = new Map([
    ["seed", seed],
    ["caller", caller],
  ]);
  const storage = {
    getEntity(id) {
      return byId.get(id) ?? null;
    },
    listEntitiesByFile(fileId) {
      return fileId === fileB.id ? [caller] : [seed];
    },
    searchFts() {
      return [
        {
          path: "fts",
          score: 1,
          file: seed.file,
          fragment: {
            id: seed.entity.id,
            fileId: seed.entity.fileId,
            range: seed.entity.range,
            content: seed.entity.content,
            metadata: seed.entity.metadata,
          },
        },
      ];
    },
    searchVector() {
      return [];
    },
    listFiles() {
      return [fileA, fileB];
    },
  };
  const result = await searchWorkspaceIndex(
    { routes: [{ mode: "fts", query: "seed" }], limit: 10 },
    { workspaceIndex: { id: "c", name: "c", path: "/tmp/c" }, storage, graph },
  );
  const relation = result.relationships.find((item) => item.kind === "IMPORTS");
  assert.equal(relation.srcId, fileB.id);
  assert.equal(relation.dstId, fileA.id);
  graph.close();
});

test("searchWorkspaceIndex silently expands CONTAINS container neighbors into hits", async () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "fa",
    [
      { id: "Parent", kind: "class", is_exported: true, name: "Parent" },
      { id: "seed", kind: "function", is_exported: true, name: "seed" },
      { id: "sib", kind: "function", is_exported: true, name: "sib" },
    ],
    [
      {
        src: "Parent",
        dst: "seed",
        rel: "contains",
        count: 1,
        first_line: 0,
        ref_name: "seed",
        kind: "CONTAINS",
      },
      {
        src: "Parent",
        dst: "sib",
        rel: "contains",
        count: 1,
        first_line: 0,
        ref_name: "sib",
        kind: "CONTAINS",
      },
    ],
    [],
  );

  const seed = entity("seed", "seed");
  const parent = entity("Parent", "Parent");
  parent.entity.metadata.symbolType = "class";
  const sib = entity("sib", "sib");
  const byId = new Map([
    ["seed", seed],
    ["Parent", parent],
    ["sib", sib],
  ]);

  const storage = {
    getEntity(id) {
      return byId.get(id) ?? null;
    },
    listEntitiesByFile() {
      return [];
    },
    searchFts(query, limit) {
      if (query.includes("seed") || query === "seedFn") {
        return [
          {
            path: "fts",
            score: 1,
            file: seed.file,
            fragment: {
              id: seed.entity.id,
              fileId: seed.entity.fileId,
              range: seed.entity.range,
              content: seed.entity.content,
              metadata: seed.entity.metadata,
            },
          },
        ].slice(0, limit);
      }
      return [];
    },
    searchVector() {
      return [];
    },
    getFileById() {
      return null;
    },
    getFileByPath() {
      return null;
    },
    listFilesByPathPrefix() {
      return [];
    },
    listFiles() {
      return [];
    },
    upsertFile() {},
    markFileFailed() {},
    deleteFile() {},
    async optimize() {},
    close() {},
  };

  const result = await searchWorkspaceIndex(
    { routes: [{ mode: "fts", query: "seedFn" }], limit: 10 },
    {
      workspaceIndex: { id: "c", name: "c", path: "/tmp/c" },
      storage,
      graph,
    },
  );

  assert.ok(result.hits.some((hit) => hit.entity.id === "Parent"));
  assert.ok(result.hits.some((hit) => hit.entity.id === "sib"));
  assert.equal(
    result.hits.find((hit) => hit.entity.id === "Parent")?.matchedBy,
    "graph",
  );
  graph.close();
});

test("searchWorkspaceIndex silently expands call neighbors into hits", async () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "fa",
    [
      { id: "seed", kind: "function", is_exported: true, name: "seed" },
      { id: "nbr", kind: "function", is_exported: true, name: "nbr" },
      {
        id: "existing",
        kind: "function",
        is_exported: true,
        name: "existing",
      },
      { id: "excluded", kind: "class", is_exported: true, name: "excluded" },
    ],
    [
      {
        src: "seed",
        dst: "nbr",
        rel: "call",
        count: 3,
        first_line: 2,
        ref_name: "nbr",
        kind: "CALLS",
      },
      {
        src: "seed",
        dst: "existing",
        rel: "call",
        count: 1,
        first_line: 3,
        ref_name: "existing",
        kind: "CALLS",
      },
      {
        src: "seed",
        dst: "excluded",
        rel: "type",
        count: 1,
        first_line: 4,
        ref_name: "excluded",
        kind: "REFS",
      },
    ],
    [],
  );

  const seed = entity("seed", "seed");
  const nbr = entity("nbr", "nbr", "b.ts");
  const existing = entity("existing", "existing", "existing.ts");
  const excluded = entity("excluded", "excluded", "model.ts");
  excluded.entity.metadata.symbolType = "class";
  const byId = new Map([
    ["seed", seed],
    ["nbr", nbr],
    ["existing", existing],
    ["excluded", excluded],
  ]);

  const storage = {
    getEntity(id) {
      return byId.get(id) ?? null;
    },
    searchFts(query, limit) {
      if (query.includes("seed") || query === "seedFn") {
        return [
          {
            path: "fts",
            score: 1,
            file: seed.file,
            fragment: {
              id: seed.entity.id,
              fileId: seed.entity.fileId,
              range: seed.entity.range,
              content: seed.entity.content,
              metadata: seed.entity.metadata,
            },
          },
          {
            path: "fts",
            score: 0.8,
            file: existing.file,
            fragment: {
              id: existing.entity.id,
              fileId: existing.entity.fileId,
              range: existing.entity.range,
              content: existing.entity.content,
              metadata: existing.entity.metadata,
            },
          },
        ].slice(0, limit);
      }
      return [];
    },
    searchVector() {
      return [];
    },
    getFileById() {
      return null;
    },
    getFileByPath() {
      return null;
    },
    listFilesByPathPrefix() {
      return [];
    },
    listFiles() {
      return [];
    },
    listEntitiesByFile() {
      return [];
    },
    upsertFile() {},
    markFileFailed() {},
    deleteFile() {},
    async optimize() {},
    close() {},
  };

  const result = await searchWorkspaceIndex(
    {
      routes: [{ mode: "fts", query: "seedFn" }],
      limit: 10,
      symbolTypes: ["function"],
    },
    {
      workspaceIndex: { id: "c", name: "c", path: "/tmp/c" },
      storage,
      graph,
    },
  );

  assert.equal(result.graphExpand?.available, true);
  assert.ok(result.graphExpand?.neighborsAdded >= 1);
  const neighborHit = result.hits.find((hit) => hit.entity.id === "nbr");
  assert.ok(neighborHit);
  assert.equal(neighborHit.matchedBy, "graph");
  assert.ok(
    result.relationships.some(
      (relation) =>
        relation.kind === "CALLS" &&
        relation.srcLabel === "seed" &&
        relation.dstLabel === "nbr",
    ),
  );
  const callRelationship = result.relationships.find(
    (relation) =>
      relation.kind === "CALLS" &&
      relation.srcId === "seed" &&
      relation.dstId === "nbr",
  );
  assert.equal(callRelationship?.srcKind, "function");
  assert.equal(callRelationship?.dstFile, "b.ts");
  assert.equal(callRelationship?.rel, "call");
  assert.equal(callRelationship?.count, 3);
  assert.equal(callRelationship?.provenance, "static");
  assert.equal(
    result.relationships.some((relation) => relation.dstId === "excluded"),
    false,
    "structure must respect the same symbol-type filter as source hits",
  );
  const existingHit = result.hits.find((hit) => hit.entity.id === "existing");
  assert.ok(
    existingHit?.evidence.some((evidence) => evidence.path === "graph"),
  );
  assert.equal(
    result.hits.some((hit) => hit.entity.id === "excluded"),
    false,
  );

  const bounded = await searchWorkspaceIndex(
    {
      routes: [{ mode: "fts", query: "seedFn" }],
      limit: 1,
      symbolTypes: ["function"],
    },
    {
      workspaceIndex: { id: "c", name: "c", path: "/tmp/c" },
      storage,
      graph,
    },
  );
  assert.deepEqual(
    bounded.hits.map((hit) => hit.entity.id),
    ["seed"],
  );
  assert.ok(
    bounded.relationships.some(
      (relation) => relation.srcId === "seed" && relation.dstId === "nbr",
    ),
    "a bounded query should retain structure to an eligible non-text endpoint",
  );
  graph.close();
});

test("query relationship budgets preserve structural kinds beside high-fanout calls", async () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  const callTargets = Array.from({ length: 24 }, (_, index) => ({
    id: `call-${index}`,
    kind: "function",
    is_exported: true,
    name: `call${index}`,
  }));
  graph.upsertFileGraph(
    "fa",
    [
      { id: "seed", kind: "function", is_exported: true, name: "seed" },
      { id: "state", kind: "value", is_exported: true, name: "state" },
      {
        id: "aaa-test-caller",
        kind: "function",
        is_exported: true,
        name: "testCaller",
      },
      ...callTargets,
    ],
    [
      ...callTargets.map((target, index) => ({
        src: "seed",
        dst: target.id,
        rel: "call",
        count: 1,
        first_line: index + 1,
        ref_name: target.name,
        kind: "CALLS",
      })),
      {
        src: "seed",
        dst: "state",
        rel: "read",
        count: 1,
        first_line: 30,
        ref_name: "state",
        kind: "REFS",
      },
      {
        src: "aaa-test-caller",
        dst: "seed",
        rel: "call",
        count: 1,
        first_line: 31,
        ref_name: "seed",
        kind: "CALLS",
      },
    ],
    [],
  );

  const stored = [
    entity("seed", "seed"),
    entity("state", "state"),
    entity("aaa-test-caller", "testCaller", "tests/seed.test.ts"),
    ...callTargets.map((target) => entity(target.id, target.name)),
  ];
  stored[1].entity.metadata.symbolType = "value";
  const byId = new Map(stored.map((item) => [item.entity.id, item]));
  const seed = byId.get("seed");
  const storage = {
    getEntity(id) {
      return byId.get(id) ?? null;
    },
    searchFts() {
      return [
        {
          path: "fts",
          score: 1,
          file: seed.file,
          fragment: seed.entity,
        },
      ];
    },
    searchVector() {
      return [];
    },
    getFileById() {
      return null;
    },
    getFileByPath() {
      return null;
    },
    listFilesByPathPrefix() {
      return [];
    },
    listFiles() {
      return [];
    },
    listEntitiesByFile() {
      return [];
    },
    upsertFile() {},
    markFileFailed() {},
    deleteFile() {},
    async optimize() {},
    close() {},
  };

  const result = await searchWorkspaceIndex(
    { routes: [{ mode: "fts", query: "seed" }], limit: 20 },
    {
      workspaceIndex: { id: "c", name: "c", path: "/tmp/c" },
      storage,
      graph,
    },
  );
  assert.equal(result.relationships.length, 20);
  assert.ok(
    result.relationships.some(
      (relation) => relation.kind === "REFS" && relation.dstId === "state",
    ),
    "CALLS must not consume the entire relationship budget",
  );
  assert.equal(
    result.relationships.some(
      (relation) => relation.srcId === "aaa-test-caller",
    ),
    false,
    "an undisplayed test helper must not leak into production structure",
  );
  graph.close();
});

test("query fusion prefers production paths unless low-value content is requested", async () => {
  const testWorker = entity("test-worker", "Worker", "tests/worker.test.ts");
  const productionWorker = entity("worker", "Worker", "src/worker.ts");
  const storage = searchStorageFrom([testWorker, productionWorker]);
  const context = {
    workspaceIndex: { id: "c", name: "c", path: "/tmp/c" },
    storage,
  };

  const production = await searchWorkspaceIndex(
    { routes: [{ mode: "fts", query: "Worker" }], limit: 2 },
    context,
  );
  assert.deepEqual(
    production.hits.map((hit) => hit.entity.id),
    ["worker", "test-worker"],
  );

  const explicitTest = await searchWorkspaceIndex(
    { routes: [{ mode: "fts", query: "test Worker" }], limit: 2 },
    context,
  );
  assert.deepEqual(
    explicitTest.hits.map((hit) => hit.entity.id),
    ["test-worker", "worker"],
  );

  const destructor = entity("destructor", "~Worker", "src/worker.ts");
  const exactType = entity("worker-type", "Worker", "src/worker.ts");
  exactType.entity.metadata.symbolType = "class";
  const exact = await searchWorkspaceIndex(
    {
      routes: [
        { mode: "fts", query: "Worker" },
        { mode: "fts", query: "Worker" },
      ],
      limit: 2,
    },
    {
      ...context,
      storage: searchStorageFrom([destructor, exactType]),
    },
  );
  assert.deepEqual(
    exact.hits.map((hit) => hit.entity.id),
    ["worker-type", "destructor"],
  );

  const similarlyCasedValue = entity(
    "counter-value",
    "counterStore",
    "src/all-stores.ts",
  );
  const exactComponent = entity(
    "counter-component",
    "CounterStore",
    "src/CounterStore.vue",
  );
  exactComponent.entity.metadata.symbolType = "component";
  const caseSensitive = await searchWorkspaceIndex(
    { routes: [{ mode: "fts", query: "CounterStore" }], limit: 2 },
    {
      ...context,
      storage: searchStorageFrom([similarlyCasedValue, exactComponent]),
    },
  );
  assert.deepEqual(
    caseSensitive.hits.map((hit) => hit.entity.id),
    ["counter-component", "counter-value"],
  );
});

test("an exact graph declaration seeds query structure when text recall misses it", async () => {
  const declaration = entity("graphiti", "Graphiti", "src/graphiti.py");
  declaration.entity.metadata.symbolType = "class";
  const baseStorage = searchStorageFrom([declaration]);
  const storage = {
    ...baseStorage,
    searchFts() {
      return [];
    },
  };
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    declaration.file.id,
    [
      {
        id: declaration.entity.id,
        kind: "class",
        is_exported: true,
        name: "Graphiti",
        file: declaration.file,
        entity: declaration.entity,
      },
    ],
    [],
    [],
  );

  const result = await searchWorkspaceIndex(
    { routes: [{ mode: "fts", query: "Graphiti" }], limit: 3 },
    {
      workspaceIndex: { id: "c", name: "c", path: "/tmp/c" },
      storage,
      graph,
    },
  );
  assert.equal(result.hits[0]?.entity.id, "graphiti");
  assert.equal(result.hits[0]?.matchedBy, "graph");
  graph.close();
});

function searchStorageFrom(items) {
  const byId = new Map(items.map((item) => [item.entity.id, item]));
  return {
    getEntity(id) {
      return byId.get(id) ?? null;
    },
    searchFts() {
      return items.map((item, index) => ({
        path: "fts",
        score: 1 - index * 0.1,
        file: item.file,
        fragment: item.entity,
      }));
    },
    searchVector() {
      return [];
    },
    getFileById() {
      return null;
    },
    getFileByPath() {
      return null;
    },
    listFilesByPathPrefix() {
      return [];
    },
    listFiles() {
      return [];
    },
    listEntitiesByFile(fileId) {
      return [...byId.values()].filter((item) => item.file.id === fileId);
    },
    upsertFile() {},
    markFileFailed() {},
    deleteFile() {},
    async optimize() {},
    close() {},
  };
}
