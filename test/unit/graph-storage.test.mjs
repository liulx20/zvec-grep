import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SqliteGraphStorage,
  fileGraphFromFragments,
  makeRefId,
  openGraphStorage,
  rawRef,
} from "../../dist/engine/graph/index.js";
import { SemanticCandidateRepository } from "../../dist/engine/graph/persistence/sqlite/candidate-repository.js";
import { DirectSemanticCandidateIndex } from "../../dist/engine/graph/persistence/sqlite/direct-candidate-index.js";

function edge(src, dst, kind, rel) {
  return {
    src,
    dst,
    kind,
    rel,
    count: 1,
    first_line: 1,
    ref_name: dst,
  };
}

test("graph open reports corruption and writable mode fails loudly", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "zvec-grep-broken-graph-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(join(dir, "graph.sqlite"), "not a sqlite database");

  const readGraph = openGraphStorage(dir, { readOnly: true });
  assert.equal(readGraph.available, false);
  assert.match(readGraph.unavailableReason, /failed to open graph/);
  assert.match(readGraph.unavailableReason, /graph\.sqlite|database/);

  assert.throws(
    () => openGraphStorage(dir, { readOnly: false }),
    (error) => {
      assert.equal(error.code, "ZVEC_GREP.ENGINE.GRAPH.OPEN_FAILED");
      assert.match(error.message, /Failed to open writable graph storage/);
      assert.ok(error.cause);
      return true;
    },
  );
});

test("read-only graph open rejects an empty SQLite file", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "zvec-grep-empty-graph-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(join(dir, "graph.sqlite"), "");

  const graph = openGraphStorage(dir, { readOnly: true });
  assert.equal(graph.available, false);
  assert.match(graph.unavailableReason, /graph schema is missing/);
});

test("read-only graph open does not create a missing directory", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "zvec-grep-readonly-graph-"));
  const dir = join(parent, "missing", "code-graph");
  t.after(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  const graph = openGraphStorage(dir, { readOnly: true });
  assert.equal(graph.available, false);
  await assert.rejects(access(dir));
});

test("graph symbol-name lookup is exact and case-insensitive", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "component-file",
    [
      {
        id: "counter-component",
        kind: "component",
        is_exported: true,
        name: "CounterStore",
      },
      {
        id: "counter-helper",
        kind: "function",
        is_exported: false,
        name: "CounterStoreHelper",
      },
    ],
    [],
    [],
  );

  assert.deepEqual(graph.findSymbolIdsByName("counterstore", 10), [
    "counter-component",
  ]);
  assert.deepEqual(graph.findSymbolIdsByName("Counter", 10), []);
  graph.close();
});

test("SQLite graph projects current source entities without opening vector storage", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "zvec-grep-graph-entity-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sourcePath = join(dir, "service.ts");
  const source = "export function run() {\n  return 1;\n}\n";
  await writeFile(sourcePath, source);
  const file = {
    id: "service-file",
    absolutePath: sourcePath,
    relativePath: "src/service.ts",
    rootPath: dir,
    sizeBytes: Buffer.byteLength(source),
    lastModifiedTime: 1,
    kind: "code",
    format: "typescript",
  };
  const graph = new SqliteGraphStorage(dir);
  graph.upsertFileGraph(
    file.id,
    [
      {
        id: "run-symbol",
        kind: "function",
        is_exported: true,
        name: "run",
        signature: "function run()",
        arity: 0,
        scope: "Service",
        nodeType: "method_definition",
        modifiers: ["exported", "public"],
        range: {
          kind: "text",
          startLine: 1,
          endLine: 3,
          startOffset: 0,
          endOffset: source.length,
        },
      },
    ],
    [],
    [],
    file,
  );
  graph.close();

  const reopened = new SqliteGraphStorage(dir, { readOnly: true });
  const entity = reopened.getEntity("run-symbol");
  assert.equal(entity?.file.relativePath, "src/service.ts");
  assert.equal(entity?.entity.metadata?.kind, "code");
  assert.equal(entity?.entity.metadata?.symbolName, "run");
  assert.equal(entity?.entity.metadata?.scope, "Service");
  assert.equal(entity?.entity.metadata?.nodeType, "method_definition");
  assert.equal(entity?.entity.metadata?.arity, 0);
  assert.deepEqual(entity?.entity.metadata?.modifiers, ["exported", "public"]);
  assert.equal(entity?.entity.content.kind, "text");
  assert.equal(entity?.entity.content.text, source);
  assert.deepEqual(
    reopened
      .findSymbolsByQuery("service run", 10)
      .map((item) => item.entity.id),
    ["run-symbol"],
  );
  reopened.close();
});

test("SQLite graph query ranks compound semantic matches above single-term exports", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "recovery-file",
    [
      {
        id: "compound-recovery",
        kind: "function",
        is_exported: false,
        name: "checkpointRecoveryWal",
        qualifiedName: "Storage.checkpointRecoveryWal",
        signature: "checkpointRecoveryWal()",
      },
      {
        id: "generic-recovery",
        kind: "function",
        is_exported: true,
        name: "recovery",
      },
    ],
    [],
    [],
  );

  assert.deepEqual(
    graph
      .findSymbolsByQuery("checkpoint recovery wal", 2)
      .map((item) => item.entity.id),
    ["compound-recovery", "generic-recovery"],
  );
  graph.close();
});

test("SQLite graph batches counterpart file-stem lookups", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  const upsert = (id, relativePath, node) =>
    graph.upsertFileGraph(id, [node], [], [], {
      id,
      absolutePath: `/workspace/${relativePath}`,
      relativePath,
      rootPath: "/workspace",
      sizeBytes: 0,
      lastModifiedTime: 1,
      kind: "code",
      format: "cpp",
    });
  upsert("header", "include/catalog.h", {
    id: "decl",
    kind: "class",
    is_exported: true,
    name: "Catalog",
  });
  upsert("source", "src/catalog.cpp", {
    id: "definition",
    kind: "function",
    is_exported: true,
    name: "open",
  });
  upsert("unrelated", "src/catalogue.cpp", {
    id: "other",
    kind: "function",
    is_exported: true,
    name: "catalogue",
  });

  assert.deepEqual(
    graph
      .findSymbolsByFileStems(["catalog"], 8)
      .get("catalog")
      ?.map((item) => item.entity.id),
    ["decl", "definition"],
  );
  graph.close();
});

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

  // Reindex target file with a new symbol id; its durable source fact is reprojected.
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

test("qualified unresolved calls become explicit dynamic boundaries", async () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "file-a",
    [
      { id: "type-a", kind: "class", is_exported: true, name: "TypeA" },
      { id: "run", kind: "function", is_exported: true, name: "run" },
      { id: "helper", kind: "function", is_exported: true, name: "helper" },
    ],
    [edge("type-a", "helper", "CONTAINS", "contains")],
    [rawRef({ owner: "run", refName: "value.helper", line: 3 })],
  );
  await graph.resolvePending();

  assert.equal(graph.edges(["run", "helper"], ["CALLS"], 10).edges.length, 0);
  const boundaries = graph.dynamicBoundaries(["run"], 10);
  assert.equal(boundaries.length, 1);
  assert.equal(boundaries[0].sourceId, "run");
  assert.equal(boundaries[0].target.raw, "value.helper");
  assert.equal(boundaries[0].target.member, "helper");
  assert.equal(boundaries[0].target.receiver?.name, "value");
  assert.equal(boundaries[0].reason, "unknown_receiver_type");
  assert.deepEqual(boundaries[0].candidates, []);

  graph.upsertFileGraph(
    "file-b",
    [
      { id: "type-b", kind: "class", is_exported: true, name: "TypeB" },
      { id: "run-2", kind: "function", is_exported: true, name: "run2" },
      { id: "helper-a", kind: "function", is_exported: true, name: "helper" },
      { id: "helper-b", kind: "function", is_exported: true, name: "helper" },
    ],
    [
      edge("type-b", "helper-a", "CONTAINS", "contains"),
      edge("type-b", "helper-b", "CONTAINS", "contains"),
    ],
    [rawRef({ owner: "run-2", refName: "value.helper", line: 7 })],
  );
  await graph.resolvePending();

  assert.deepEqual(graph.dynamicBoundaries(["run-2"], 10), [
    {
      sourceId: "run-2",
      target: {
        raw: "value.helper",
        member: "helper",
        receiver: { kind: "qualified", name: "value" },
      },
      reason: "unknown_receiver_type",
      candidates: [],
      candidatesTruncated: false,
      candidateDetails: [],
    },
  ]);
  graph.close();
});

test("dynamic boundary limits apply after repeated occurrences are grouped", async () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "boundary-occurrences",
    [
      { id: "route", kind: "function", is_exported: true, name: "route" },
      { id: "helper", kind: "function", is_exported: true, name: "helper" },
      { id: "work", kind: "function", is_exported: true, name: "work" },
    ],
    [],
    [
      ...Array.from({ length: 40 }, (_, index) =>
        rawRef({
          owner: "route",
          refName: "value.helper",
          line: index + 1,
        }),
      ),
      rawRef({ owner: "route", refName: "other.work", line: 100 }),
    ],
  );
  await graph.resolvePending();

  const boundaries = graph.dynamicBoundaries(["route"], 2);
  assert.equal(boundaries.length, 2);
  assert.equal(
    boundaries.find((item) => item.target.raw === "value.helper")
      ?.occurrenceCount,
    40,
  );
  assert.ok(boundaries.some((item) => item.target.raw === "other.work"));
  graph.close();
});

test("batched dynamic candidate reads keep candidates isolated by boundary", async () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "batched-boundaries",
    [
      { id: "runner", kind: "interface", is_exported: true, name: "Runner" },
      { id: "runner-run", kind: "method", is_exported: true, name: "run" },
      { id: "worker", kind: "class", is_exported: true, name: "Worker" },
      { id: "worker-run", kind: "method", is_exported: true, name: "run" },
      { id: "stopper", kind: "interface", is_exported: true, name: "Stopper" },
      { id: "stopper-stop", kind: "method", is_exported: true, name: "stop" },
      { id: "closer", kind: "class", is_exported: true, name: "Closer" },
      { id: "closer-stop", kind: "method", is_exported: true, name: "stop" },
      { id: "invoke", kind: "function", is_exported: true, name: "invoke" },
    ],
    [
      edge("runner", "runner-run", "CONTAINS", "contains"),
      edge("worker", "worker-run", "CONTAINS", "contains"),
      edge("worker", "runner", "INHERITS", "implements"),
      edge("stopper", "stopper-stop", "CONTAINS", "contains"),
      edge("closer", "closer-stop", "CONTAINS", "contains"),
      edge("closer", "stopper", "INHERITS", "implements"),
    ],
    [
      rawRef({
        owner: "invoke",
        refName: "runner.run",
        line: 1,
        sourceLanguage: "java",
        target: {
          raw: "runner.run",
          member: "run",
          receiver: { kind: "qualified", name: "runner" },
          hints: {
            receiverType: "Runner",
            candidateTypes: ["Runner"],
            dispatch: "virtual",
          },
        },
      }),
      rawRef({
        owner: "invoke",
        refName: "stopper.stop",
        line: 2,
        sourceLanguage: "java",
        target: {
          raw: "stopper.stop",
          member: "stop",
          receiver: { kind: "qualified", name: "stopper" },
          hints: {
            receiverType: "Stopper",
            candidateTypes: ["Stopper"],
            dispatch: "virtual",
          },
        },
      }),
    ],
  );
  await graph.resolvePending();

  const boundaries = graph.dynamicBoundaries(["invoke"], 10);
  assert.equal(boundaries.length, 2);
  assert.deepEqual(
    boundaries.find((item) => item.target.member === "run")?.candidates,
    ["worker-run"],
  );
  assert.deepEqual(
    boundaries.find((item) => item.target.member === "stop")?.candidates,
    ["closer-stop"],
  );
  graph.close();
});

test("failed receiver boundaries are grouped before their limit is applied", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "failed-boundaries",
    [
      {
        id: "route-failed",
        kind: "function",
        is_exported: true,
        name: "route",
      },
    ],
    [],
    [],
  );
  const insert = graph.database.db.prepare(
    `INSERT INTO unresolved_refs(
       id,owner_id,owner_is_file,ref_name,ref_kind,line,source_language,
       receiver_kind,receiver_name,member_name,status,last_attempt
     ) VALUES(?,?,0,?,'call',?,'typescript','qualified',?,?,'failed',0)`,
  );
  for (let index = 0; index < 40; index += 1) {
    insert.run(
      `failed-helper-${index}`,
      "route-failed",
      "value.helper",
      index + 1,
      "value",
      "helper",
    );
  }
  insert.run("failed-work", "route-failed", "other.work", 100, "other", "work");

  const boundaries = graph.dynamicBoundaries(["route-failed"], 2);
  assert.equal(boundaries.length, 2);
  assert.equal(
    boundaries.find((item) => item.target.raw === "value.helper")
      ?.occurrenceCount,
    40,
  );
  assert.ok(boundaries.some((item) => item.target.raw === "other.work"));
  graph.close();
});

test("dead-code candidates exclude function references and dynamic targets", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "file-a",
    [
      { id: "wire", kind: "function", is_exported: false, name: "wire" },
      {
        id: "callback",
        kind: "function",
        is_exported: false,
        name: "callback",
      },
      {
        id: "dispatcher",
        kind: "function",
        is_exported: false,
        name: "dispatcher",
      },
      {
        id: "implementation",
        kind: "method",
        is_exported: false,
        name: "run",
      },
      { id: "unused", kind: "function", is_exported: false, name: "unused" },
    ],
    [edge("wire", "callback", "REFS", "function")],
    [],
  );
  graph.database.db
    .prepare(
      `INSERT INTO unresolved_refs(
       id,owner_id,owner_is_file,ref_name,ref_kind,line,source_language,
       receiver_kind,receiver_name,member_name,status,last_attempt,dynamic_reason
     ) VALUES('dispatch','dispatcher',0,'value.run','call',1,'typescript',
       'qualified','value','run','dynamic',0,'polymorphic_dispatch')`,
    )
    .run();
  graph.database.db
    .prepare(
      "INSERT INTO edge_candidates(edge_id,target_id,reason,confidence) VALUES('dispatch','implementation','hierarchy',0.65)",
    )
    .run();

  const ids = new Set(graph.deadCode(20).map((candidate) => candidate.id));
  assert.equal(ids.has("callback"), false);
  assert.equal(ids.has("implementation"), false);
  assert.equal(ids.has("unused"), true);
  graph.close();
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
  assert.equal(graph.stats().externalRefCount, 1);
  graph.close();
});

test("C-family macro-shaped calls are external only without a real symbol", async () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "macro-call.c",
    [
      { id: "macro-owner", kind: "function", is_exported: true, name: "run" },
      {
        id: "uppercase-function",
        kind: "function",
        is_exported: true,
        name: "REAL_UPPERCASE",
      },
    ],
    [],
    [
      rawRef({
        owner: "macro-owner",
        refName: "EXPECT_EQ",
        refKind: "call",
        line: 1,
        sourceLanguage: "c",
      }),
      rawRef({
        owner: "macro-owner",
        refName: "REAL_UPPERCASE",
        refKind: "call",
        line: 2,
        sourceLanguage: "c",
      }),
    ],
  );

  await graph.resolvePending();

  assert.equal(graph.stats().externalRefCount, 1);
  assert.deepEqual(
    graph.callees("macro-owner", 1, 10).map((candidate) => candidate.id),
    ["uppercase-function"],
  );
  graph.close();
});

test("workspace-unique fallback never binds to an unrelated container member", async () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "cpp-db",
    [
      { id: "cpp-db-type", kind: "class", is_exported: true, name: "NeugDB" },
      { id: "cpp-version", kind: "method", is_exported: true, name: "Version" },
    ],
    [edge("cpp-db-type", "cpp-version", "CONTAINS", "contains")],
    [],
  );
  graph.upsertFileGraph(
    "python-guard",
    [
      {
        id: "python-guard-owner",
        kind: "function",
        is_exported: false,
        name: "guard",
      },
    ],
    [],
    [
      rawRef({
        owner: "python-guard-owner",
        refName: "Version",
        line: 1,
        sourceLanguage: "python",
      }),
    ],
  );

  await graph.resolvePending();

  assert.deepEqual(graph.callees("python-guard-owner", 1, 10), []);
  assert.equal(graph.stats().callsCount, 0);
  graph.close();
});

test("builtin receiver calls become language-aware external refs", async () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  const cases = [
    ["typescript", "Array", "push"],
    ["python", "list", "append"],
    ["java", "List", "add"],
    ["rust", "Vec", "push"],
    ["cpp", "std::vector<int>", "push_back"],
  ];
  const callers = cases.map(([language], index) => ({
    id: `builtin-caller-${index}`,
    kind: "function",
    is_exported: false,
    name: `call_${language}`,
  }));
  graph.upsertFileGraph(
    "builtin-receivers",
    callers,
    [],
    cases.map(([language, receiverType, member], index) =>
      rawRef({
        owner: callers[index].id,
        refName: `value.${member}`,
        line: index + 1,
        sourceLanguage: language,
        target: {
          raw: `value.${member}`,
          member,
          receiver: { kind: "qualified", name: "value" },
          hints: { receiverType, candidateTypes: [receiverType] },
        },
      }),
    ),
  );

  await graph.resolvePending();

  assert.equal(graph.stats().externalRefCount, cases.length);
  assert.equal(graph.stats().callsCount, 0);
  assert.equal(graph.stats().dynamicBoundaryCount, 0);
  graph.close();
});

test("C++ std namespace calls become external refs", async () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "cpp-stdlib",
    [
      {
        id: "cpp-stdlib-caller",
        kind: "function",
        is_exported: false,
        name: "run",
      },
    ],
    [],
    [
      rawRef({
        owner: "cpp-stdlib-caller",
        refName: "std::to_string",
        line: 1,
        sourceLanguage: "cpp",
      }),
      rawRef({
        owner: "cpp-stdlib-caller",
        refName: "std::filesystem::exists",
        line: 2,
        sourceLanguage: "cpp",
        target: {
          raw: "std::filesystem::exists",
          member: "exists",
          receiver: { kind: "qualified", name: "std.filesystem" },
        },
      }),
      rawRef({
        owner: "cpp-stdlib-caller",
        refName: "static_cast",
        line: 3,
        sourceLanguage: "cpp",
      }),
    ],
  );

  await graph.resolvePending();

  assert.equal(graph.stats().externalRefCount, 3);
  assert.equal(graph.stats().dynamicBoundaryCount, 0);
  graph.close();
});

test("qualified names resolve cross-file C++ methods without name guessing", async () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "caller.cc",
    [
      {
        id: "caller",
        kind: "function",
        is_exported: false,
        name: "invoke",
        qualifiedName: "invoke",
      },
      {
        id: "neug-db",
        kind: "class",
        is_exported: true,
        name: "NeugDB",
        qualifiedName: "NeugDB",
      },
    ],
    [],
    [
      rawRef({
        owner: "caller",
        refName: "db.Open",
        line: 1,
        sourceLanguage: "cpp",
        target: {
          raw: "db.Open",
          member: "Open",
          receiver: { kind: "qualified", name: "db" },
          hints: {
            receiverType: "NeugDB",
            candidateTypes: ["NeugDB"],
            callArity: 0,
          },
        },
      }),
    ],
  );
  graph.upsertFileGraph(
    "neug_db.cc",
    [
      {
        id: "neug-open",
        kind: "function",
        is_exported: false,
        name: "Open",
        qualifiedName: "NeugDB::Open",
        arity: 0,
      },
      {
        id: "other-open",
        kind: "function",
        is_exported: false,
        name: "Open",
        qualifiedName: "Other::Open",
        arity: 0,
      },
    ],
    [],
    [],
  );

  await graph.resolvePending();

  assert.deepEqual(
    graph.callees("caller", 1, 10).map((candidate) => candidate.id),
    ["neug-open"],
  );
  assert.deepEqual(
    graph.members("neug-db").map((member) => member.id),
    ["neug-open"],
  );
  assert.ok(
    graph
      .traverse("neug-db", {
        edgeKinds: ["CONTAINS"],
        direction: "outgoing",
        maxDepth: 1,
        limit: 10,
      })
      .some((member) => member.id === "neug-open"),
  );
  assert.equal(
    graph.edges(["caller", "neug-open"], ["CALLS"], 10).edges[0]?.evidence,
    "receiver_type_member",
  );
  graph.close();
});

test("dynamic boundaries collapse duplicated C++ declaration scopes", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "caller.cc",
    [{ id: "caller", kind: "function", is_exported: false, name: "caller" }],
    [],
    [],
  );
  graph.upsertFileGraph(
    "thing.h",
    [
      {
        id: "thing-decl",
        kind: "class",
        is_exported: true,
        name: "Thing",
        qualifiedName: "neug::Thing",
      },
      { id: "open-decl", kind: "method", is_exported: true, name: "Open" },
    ],
    [edge("thing-decl", "open-decl", "CONTAINS", "contains")],
    [],
  );
  graph.upsertFileGraph(
    "thing.cc",
    [
      {
        id: "thing-def",
        kind: "class",
        is_exported: true,
        name: "Thing",
        qualifiedName: "neug::Thing::Thing",
      },
      { id: "open-def", kind: "method", is_exported: true, name: "Open" },
    ],
    [edge("thing-def", "open-def", "CONTAINS", "contains")],
    [],
  );
  graph.database.db
    .prepare(
      `INSERT INTO unresolved_refs(
       id,owner_id,owner_is_file,ref_name,ref_kind,line,source_language,
       receiver_kind,receiver_name,member_name,status,last_attempt,dynamic_reason
     ) VALUES('call','caller',0,'thing.Open','call',1,'cpp','qualified',
       'thing','Open','dynamic',0,'polymorphic_dispatch')`,
    )
    .run();
  const insert = graph.database.db.prepare(
    "INSERT INTO edge_candidates(edge_id,target_id,reason,confidence) VALUES('call',?,'hierarchy',0.65)",
  );
  insert.run("open-decl");
  insert.run("open-def");
  const boundary = graph.dynamicBoundaries(["caller"], 10)[0];
  assert.equal(boundary.candidateDetails.length, 1);
  assert.equal(boundary.candidateDetails[0].displayName, "neug::Thing::Open");
  graph.close();
});

test("C++ declaration and out-of-line definition project as one call target", async () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "caller.cc",
    [{ id: "caller", kind: "function", is_exported: false, name: "caller" }],
    [],
    [],
  );
  graph.upsertFileGraph(
    "thing.h",
    [
      {
        id: "thing-decl",
        kind: "class",
        is_exported: true,
        name: "Thing",
        qualifiedName: "neug::Thing",
      },
      { id: "open-decl", kind: "method", is_exported: true, name: "Open" },
    ],
    [edge("thing-decl", "open-decl", "CONTAINS", "contains")],
    [],
  );
  graph.upsertFileGraph(
    "thing.cc",
    [
      {
        id: "thing-def",
        kind: "class",
        is_exported: true,
        name: "Thing",
        qualifiedName: "neug::Thing::Thing",
      },
      { id: "open-def", kind: "method", is_exported: true, name: "Open" },
    ],
    [edge("thing-def", "open-def", "CONTAINS", "contains")],
    [],
  );

  const candidates = new SemanticCandidateRepository(graph.database).resolve({
    sourceId: "caller",
    sourceLanguage: "cpp",
    typeNames: ["Thing"],
    memberName: "Open",
    workspaceVisible: true,
  });
  assert.deepEqual(candidates.candidates, ["open-def"]);
  graph.close();
});

test("C++ direct candidate selection does not mistake a qualified return type for a definition", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "thing.h",
    [
      {
        id: "thing",
        kind: "class",
        is_exported: true,
        name: "Thing",
        qualifiedName: "neug::Thing",
      },
      {
        id: "name-decl",
        kind: "method",
        is_exported: true,
        name: "name",
        qualifiedName: "neug::Thing::name",
        signature: "std::string name() const",
        arity: 0,
      },
    ],
    [edge("thing", "name-decl", "CONTAINS", "contains")],
    [],
  );
  graph.upsertFileGraph(
    "thing.cc",
    [
      {
        id: "name-def",
        kind: "method",
        is_exported: true,
        name: "name",
        qualifiedName: "neug::Thing::name",
        signature: "std::string Thing::name() const",
        arity: 0,
      },
    ],
    [],
    [],
  );

  const result = new DirectSemanticCandidateIndex(graph.database).resolve({
    sourceLanguage: "cpp",
    typeNames: ["Thing"],
    memberName: "name",
    callArity: 0,
    visibleFiles: new Set(["thing.h"]),
  });

  assert.deepEqual(result?.candidates, ["name-def"]);
  graph.close();
});

test("direct candidate selection resolves an empty visible nominal member set", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "visible.java",
    [
      {
        id: "visible-service",
        kind: "class",
        is_exported: true,
        name: "Service",
        qualifiedName: "Service",
      },
    ],
    [],
    [],
  );
  graph.upsertFileGraph(
    "hidden.java",
    [
      {
        id: "hidden-service",
        kind: "class",
        is_exported: true,
        name: "Service",
        qualifiedName: "Service",
      },
      {
        id: "hidden-run",
        kind: "method",
        is_exported: true,
        name: "run",
        qualifiedName: "Service::run",
        signature: "void run()",
        arity: 0,
      },
    ],
    [edge("hidden-service", "hidden-run", "CONTAINS", "contains")],
    [],
  );

  const result = new DirectSemanticCandidateIndex(graph.database).resolve({
    sourceLanguage: "java",
    typeNames: ["Service"],
    memberName: "run",
    callArity: 0,
    visibleFiles: new Set(["visible.java"]),
  });

  assert.deepEqual(result, {
    candidates: [],
    abstractDispatch: false,
    rtaActive: false,
  });
  graph.close();
});

test("direct candidate selection defers visible same-name type roots to complete resolution", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  for (const suffix of ["a", "b"]) {
    graph.upsertFileGraph(
      `${suffix}.java`,
      [
        {
          id: `service-${suffix}`,
          kind: "class",
          is_exported: true,
          name: "Service",
          qualifiedName: "Service",
        },
        {
          id: `run-${suffix}`,
          kind: "method",
          is_exported: true,
          name: "run",
          qualifiedName: "Service::run",
          signature: "void run()",
          arity: 0,
        },
      ],
      [edge(`service-${suffix}`, `run-${suffix}`, "CONTAINS", "contains")],
      [],
    );
  }

  const result = new DirectSemanticCandidateIndex(graph.database).resolve({
    sourceLanguage: "java",
    typeNames: ["Service"],
    memberName: "run",
    callArity: 0,
    visibleFiles: new Set(["a.java", "b.java"]),
  });

  assert.equal(result, null);
  graph.close();
});

test("a user-defined type wins over builtin receiver classification", async () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "custom-map",
    [
      { id: "custom-map-type", kind: "class", is_exported: true, name: "Map" },
      { id: "custom-map-get", kind: "method", is_exported: true, name: "get" },
      {
        id: "custom-map-caller",
        kind: "function",
        is_exported: true,
        name: "run",
      },
    ],
    [edge("custom-map-type", "custom-map-get", "CONTAINS", "contains")],
    [
      rawRef({
        owner: "custom-map-caller",
        refName: "value.get",
        line: 1,
        sourceLanguage: "typescript",
        target: {
          raw: "value.get",
          member: "get",
          receiver: { kind: "qualified", name: "value" },
          hints: { receiverType: "Map", candidateTypes: ["Map"] },
        },
      }),
    ],
  );

  await graph.resolvePending();

  assert.deepEqual(
    graph.callees("custom-map-caller", 1, 10).map((symbol) => symbol.id),
    ["custom-map-get"],
  );
  assert.equal(graph.stats().externalRefCount, 0);
  graph.close();
});

test("a missing receiver type does not fall back to an unrelated same-name method", async () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "missing-receiver",
    [
      { id: "unrelated", kind: "class", is_exported: true, name: "Unrelated" },
      { id: "unrelated-run", kind: "method", is_exported: true, name: "run" },
      {
        id: "missing-caller",
        kind: "method",
        is_exported: true,
        name: "invoke",
      },
    ],
    [edge("unrelated", "unrelated-run", "CONTAINS", "contains")],
    [
      rawRef({
        owner: "missing-caller",
        refName: "value.run",
        line: 1,
        sourceLanguage: "java",
        target: {
          raw: "value.run",
          member: "run",
          receiver: { kind: "qualified", name: "value" },
          hints: {
            receiverType: "Missing",
            candidateTypes: ["Missing"],
            dispatch: "virtual",
          },
        },
      }),
    ],
  );

  await graph.resolvePending();

  assert.deepEqual(graph.callees("missing-caller", 1, 10), []);
  assert.deepEqual(graph.dynamicBoundaries(["missing-caller"], 10), [
    {
      sourceId: "missing-caller",
      target: {
        raw: "value.run",
        member: "run",
        receiver: { kind: "qualified", name: "value" },
        hints: {
          receiverType: "Missing",
          candidateTypes: ["Missing"],
          dispatch: "virtual",
        },
      },
      reason: "unknown_receiver_type",
      candidates: [],
      candidatesTruncated: false,
      candidateDetails: [],
    },
  ]);
  graph.close();
});

for (const language of ["typescript", "java"]) {
  test(`${language} dispatch selects nearest concrete inherited providers`, async () => {
    const graph = new SqliteGraphStorage("", { inMemory: true });
    graph.upsertFileGraph(
      `${language}-providers`,
      [
        {
          id: `${language}-runner`,
          kind: "interface",
          is_exported: true,
          name: "Runner",
        },
        {
          id: `${language}-runner-run`,
          kind: "abstract_method",
          is_exported: true,
          name: "run",
        },
        {
          id: `${language}-base`,
          kind: "abstract_class",
          is_exported: true,
          name: "Base",
        },
        {
          id: `${language}-base-run`,
          kind: "method",
          is_exported: true,
          name: "run",
        },
        {
          id: `${language}-child`,
          kind: "class",
          is_exported: true,
          name: "Child",
        },
        {
          id: `${language}-child-run`,
          kind: "method",
          is_exported: true,
          name: "run",
        },
        {
          id: `${language}-other`,
          kind: "class",
          is_exported: true,
          name: "Other",
        },
        {
          id: `${language}-other-run`,
          kind: "method",
          is_exported: true,
          name: "run",
        },
        {
          id: `${language}-caller`,
          kind: "method",
          is_exported: true,
          name: "invoke",
        },
      ],
      [
        edge(
          `${language}-runner`,
          `${language}-runner-run`,
          "CONTAINS",
          "contains",
        ),
        edge(
          `${language}-base`,
          `${language}-base-run`,
          "CONTAINS",
          "contains",
        ),
        edge(
          `${language}-child`,
          `${language}-child-run`,
          "CONTAINS",
          "contains",
        ),
        edge(
          `${language}-other`,
          `${language}-other-run`,
          "CONTAINS",
          "contains",
        ),
        edge(
          `${language}-base`,
          `${language}-runner`,
          "INHERITS",
          "implements",
        ),
        edge(`${language}-child`, `${language}-base`, "INHERITS", "extends"),
        edge(
          `${language}-other`,
          `${language}-runner`,
          "INHERITS",
          "implements",
        ),
        edge(
          `${language}-caller`,
          `${language}-child`,
          "INSTANTIATES",
          "instantiates",
        ),
        edge(
          `${language}-caller`,
          `${language}-other`,
          "INSTANTIATES",
          "instantiates",
        ),
      ],
      [
        rawRef({
          owner: `${language}-caller`,
          refName: "value.run",
          line: 1,
          sourceLanguage: language,
          target: {
            raw: "value.run",
            member: "run",
            receiver: { kind: "qualified", name: "value" },
            hints: {
              receiverType: "Runner",
              candidateTypes: ["Runner"],
              dispatch: "virtual",
            },
          },
        }),
      ],
    );

    await graph.resolvePending();

    const boundary = graph.dynamicBoundaries([`${language}-caller`], 10)[0];
    assert.deepEqual(boundary?.candidates.sort(), [
      `${language}-child-run`,
      `${language}-other-run`,
    ]);
    assert.ok(!boundary?.candidates.includes(`${language}-base-run`));
    assert.ok(!boundary?.candidates.includes(`${language}-runner-run`));
    graph.close();
  });
}

test("a concrete method inherited from an abstract class remains a dispatch provider", async () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "abstract-provider",
    [
      {
        id: "provider-runner",
        kind: "interface",
        is_exported: true,
        name: "Runner",
      },
      {
        id: "provider-declaration",
        kind: "abstract_method",
        is_exported: true,
        name: "run",
      },
      {
        id: "provider-base",
        kind: "abstract_class",
        is_exported: true,
        name: "Base",
      },
      {
        id: "provider-base-run",
        kind: "method",
        is_exported: true,
        name: "run",
      },
      { id: "provider-child", kind: "class", is_exported: true, name: "Child" },
      { id: "provider-other", kind: "class", is_exported: true, name: "Other" },
      {
        id: "provider-other-run",
        kind: "method",
        is_exported: true,
        name: "run",
      },
      {
        id: "provider-caller",
        kind: "method",
        is_exported: true,
        name: "invoke",
      },
    ],
    [
      edge("provider-runner", "provider-declaration", "CONTAINS", "contains"),
      edge("provider-base", "provider-base-run", "CONTAINS", "contains"),
      edge("provider-other", "provider-other-run", "CONTAINS", "contains"),
      edge("provider-base", "provider-runner", "INHERITS", "implements"),
      edge("provider-child", "provider-base", "INHERITS", "extends"),
      edge("provider-other", "provider-runner", "INHERITS", "implements"),
      edge("provider-caller", "provider-child", "INSTANTIATES", "instantiates"),
      edge("provider-caller", "provider-other", "INSTANTIATES", "instantiates"),
    ],
    [
      rawRef({
        owner: "provider-caller",
        refName: "value.run",
        line: 1,
        sourceLanguage: "java",
        target: {
          raw: "value.run",
          member: "run",
          receiver: { kind: "qualified", name: "value" },
          hints: {
            receiverType: "Runner",
            candidateTypes: ["Runner"],
            dispatch: "virtual",
          },
        },
      }),
    ],
  );

  await graph.resolvePending();

  assert.deepEqual(
    graph.dynamicBoundaries(["provider-caller"], 10)[0]?.candidates.sort(),
    ["provider-base-run", "provider-other-run"],
  );
  graph.close();
});

test("failed member references are not reported as dynamic call boundaries", async () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "member-file",
    [{ id: "member-owner", kind: "function", is_exported: true, name: "read" }],
    [],
    [
      rawRef({
        owner: "member-owner",
        refName: "value.length",
        refKind: "member",
        line: 1,
      }),
    ],
  );
  await graph.resolvePending();

  assert.equal(graph.stats().failedRefCount, 1);
  assert.deepEqual(graph.dynamicBoundaries(["member-owner"], 10), []);
  graph.close();
});

test("resolved references move their durable source facts onto edges", async () => {
  class InspectableGraph extends SqliteGraphStorage {
    resolvedOccurrenceCount() {
      return this.database.db
        .prepare("SELECT COUNT(*) AS count FROM edges WHERE kind='CALLS'")
        .get().count;
    }
    graphTableNames() {
      return this.database.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all()
        .map((row) => row.name);
    }
  }
  const graph = new InspectableGraph("", { inMemory: true });
  graph.upsertFileGraph(
    "source-facts",
    [
      { id: "caller", kind: "function", is_exported: false, name: "caller" },
      { id: "target", kind: "function", is_exported: false, name: "target" },
    ],
    [],
    [rawRef({ owner: "caller", refName: "target", line: 1 })],
  );
  await graph.resolvePending();

  assert.equal(graph.stats().callsCount, 1);
  assert.equal(graph.stats().refCount, 0);
  assert.equal(graph.resolvedOccurrenceCount(), 1);
  assert.deepEqual(graph.graphTableNames(), [
    "contains",
    "edge_candidates",
    "edges",
    "files",
    "graph_meta",
    "symbols",
    "unresolved_refs",
  ]);
  graph.close();
});

test("unchanged resolve does not replay stable receiver facts", async () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  const callers = Array.from({ length: 1_000 }, (_, index) => ({
    id: `receiver-caller-${index}`,
    kind: "function",
    is_exported: false,
    name: `caller${index}`,
  }));
  graph.upsertFileGraph(
    "stable-receivers",
    [
      ...callers,
      {
        id: "receiver-type",
        kind: "class",
        is_exported: false,
        name: "Receiver",
      },
      {
        id: "receiver-helper",
        kind: "method",
        is_exported: false,
        name: "helper",
      },
    ],
    [edge("receiver-type", "receiver-helper", "CONTAINS", "contains")],
    callers.map((caller, occurrence) =>
      rawRef({
        owner: caller.id,
        refName: "value.helper",
        line: 1,
        occurrence,
        sourceLanguage: "typescript",
      }),
    ),
  );
  await graph.resolvePending();

  let resolutions = 0;
  const resolver = graph.resolver;
  const original = resolver.resolveSymbol.bind(resolver);
  resolver.resolveSymbol = (...args) => {
    resolutions += 1;
    return original(...args);
  };
  await graph.resolvePending();

  assert.equal(resolutions, 0);
  assert.equal(graph.stats().callsCount, 0);
  assert.equal(graph.stats().dynamicBoundaryCount, 1_000);
  graph.close();
});

test("new same-name symbols invalidate ordinary resolved projections", async () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "caller-file",
    [{ id: "caller", kind: "function", is_exported: false, name: "caller" }],
    [],
    [rawRef({ owner: "caller", refName: "target", line: 1 })],
  );
  graph.upsertFileGraph(
    "first-target",
    [{ id: "target-a", kind: "function", is_exported: true, name: "target" }],
    [],
    [],
  );
  await graph.resolvePending();
  assert.deepEqual(
    graph.callees("caller", 1, 10).map((item) => item.id),
    ["target-a"],
  );
  assert.equal(
    graph.database.db
      .prepare(
        "SELECT evidence FROM edges WHERE src_id='caller' AND kind='CALLS'",
      )
      .get().evidence,
    "workspace_unique",
  );

  graph.upsertFileGraph(
    "second-target",
    [{ id: "target-b", kind: "function", is_exported: true, name: "target" }],
    [],
    [],
  );
  await graph.resolvePending();

  assert.deepEqual(graph.callees("caller", 1, 10), []);
  assert.equal(graph.stats().refCount, 1);
  graph.close();
});

test("new same-name symbols preserve same-file resolved projections", async () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "local-file",
    [
      {
        id: "local-caller",
        kind: "function",
        is_exported: false,
        name: "caller",
      },
      {
        id: "local-target",
        kind: "function",
        is_exported: false,
        name: "target",
      },
    ],
    [edge("local-caller", "local-target", "CALLS", "call")],
    [],
  );

  assert.equal(
    graph.database.db
      .prepare(
        "SELECT evidence FROM edges WHERE src_id='local-caller' AND kind='CALLS'",
      )
      .get().evidence,
    null,
  );

  graph.upsertFileGraph(
    "unrelated-file",
    [
      {
        id: "unrelated-target",
        kind: "function",
        is_exported: true,
        name: "target",
      },
    ],
    [],
    [],
  );
  await graph.resolvePending();

  assert.deepEqual(
    graph.callees("local-caller", 1, 10).map((item) => item.id),
    ["local-target"],
  );
  assert.equal(graph.stats().refCount, 0);
  graph.close();
});

test("new symbols in an imported file invalidate preferred-file projections", async () => {
  const sourceFiles = [
    { id: "caller-file", relativePath: "src/caller.ts" },
    { id: "preferred-a", relativePath: "src/a.ts" },
    { id: "preferred-b", relativePath: "src/b.ts" },
  ].map((item) => ({
    ...item,
    collectionId: "collection-1",
    absolutePath: `/repo/${item.relativePath}`,
    rootPath: "/repo",
    sizeBytes: 1,
    lastModifiedTime: 1,
    kind: "code",
    format: "typescript",
  }));
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "caller-file",
    [
      {
        id: "preferred-caller",
        kind: "function",
        is_exported: true,
        name: "caller",
      },
    ],
    [],
    [
      rawRef({ owner: "preferred-caller", refName: "target", line: 1 }),
      rawRef({ type: "import", owner: "caller-file", refName: "./a", line: 1 }),
      rawRef({ type: "import", owner: "caller-file", refName: "./b", line: 2 }),
    ],
  );
  graph.upsertFileGraph(
    "preferred-a",
    [
      {
        id: "preferred-target-a",
        kind: "function",
        is_exported: true,
        name: "target",
      },
    ],
    [],
    [],
  );
  graph.upsertFileGraph("preferred-b", [], [], []);
  await graph.resolvePending({ files: sourceFiles });

  assert.deepEqual(
    graph.callees("preferred-caller", 1, 10).map((item) => item.id),
    ["preferred-target-a"],
  );
  assert.equal(
    graph.database.db
      .prepare(
        "SELECT evidence FROM edges WHERE src_id='preferred-caller' AND kind='CALLS'",
      )
      .get().evidence,
    "preferred_file",
  );
  graph.upsertFileGraph(
    "preferred-b",
    [
      {
        id: "preferred-target-b",
        kind: "function",
        is_exported: true,
        name: "target",
      },
    ],
    [],
    [],
  );
  await graph.resolvePending({ files: sourceFiles });

  assert.deepEqual(graph.callees("preferred-caller", 1, 10), []);
  assert.equal(graph.stats().failedRefCount, 1);
  graph.close();
});

test("preferred-file invalidation ignores unrelated names in another import", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "caller-file",
    [{ id: "caller", kind: "function", is_exported: true, name: "caller" }],
    [],
    [],
  );
  graph.upsertFileGraph(
    "file-a",
    [{ id: "foo", kind: "function", is_exported: true, name: "foo" }],
    [],
    [],
  );
  graph.upsertFileGraph(
    "file-b",
    [{ id: "bar", kind: "function", is_exported: true, name: "bar" }],
    [],
    [],
  );
  const insert = graph.database.db.prepare(
    `INSERT INTO edges(
       id,src_id,dst_id,src_is_file,dst_is_file,kind,rel,count,first_line,
       ref_name,member_name,provenance,confidence,evidence
     ) VALUES(?,?,?,0,0,'CALLS','call',1,1,?,?,'static',1,'preferred_file')`,
  );
  insert.run("call-foo", "caller", "foo", "foo", "foo");
  insert.run("call-bar", "caller", "bar", "bar", "bar");
  const insertImport = graph.database.db.prepare(
    `INSERT INTO edges(
       id,src_id,dst_id,src_is_file,dst_is_file,kind,rel,count,first_line,
       ref_name,provenance,confidence
     ) VALUES(?,?,?,1,1,'IMPORTS','import',1,1,'*','static',1)`,
  );
  insertImport.run("import-a", "caller-file", "file-a");
  insertImport.run("import-b", "caller-file", "file-b");

  const affected = graph.writer.affectedResolvedEdgeIds("file-b", ["baz"]);
  assert.equal(affected.includes("call-foo"), false);
  assert.equal(affected.includes("call-bar"), true);
  graph.close();
});

test("renaming a receiver type invalidates existing dynamic candidates", async () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  // This test injects a projection directly, bypassing resolvePending(), which
  // normally closes the fresh-index bulk-load window first.
  graph.database.endBulkLoad();
  graph.upsertFileGraph(
    "contract",
    [
      {
        id: "old-contract",
        kind: "interface",
        is_exported: true,
        name: "OldContract",
      },
    ],
    [],
    [],
  );
  graph.upsertFileGraph(
    "implementations",
    [
      { id: "impl-a", kind: "class", is_exported: true, name: "ImplA" },
      { id: "impl-b", kind: "class", is_exported: true, name: "ImplB" },
      { id: "helper-a", kind: "method", is_exported: true, name: "helper" },
      { id: "helper-b", kind: "method", is_exported: true, name: "helper" },
    ],
    [
      edge("impl-a", "helper-a", "CONTAINS", "contains"),
      edge("impl-b", "helper-b", "CONTAINS", "contains"),
      {
        ...edge("impl-a", "old-contract", "INHERITS", "implements"),
        ref_name: "OldContract",
      },
      {
        ...edge("impl-b", "old-contract", "INHERITS", "implements"),
        ref_name: "OldContract",
      },
    ],
    [],
  );
  graph.upsertFileGraph(
    "caller-file",
    [{ id: "caller", kind: "function", is_exported: true, name: "caller" }],
    [],
    [],
  );
  graph.database.db
    .prepare(
      `INSERT INTO unresolved_refs(
       id,owner_id,owner_is_file,ref_name,ref_kind,line,source_language,
       receiver_kind,receiver_name,member_name,resolution_hints,status,
       last_attempt,dynamic_reason
     ) VALUES('dynamic-call','caller',0,'value.helper','call',1,'typescript',
       'qualified','value','helper',?,'dynamic',0,'polymorphic_dispatch')`,
    )
    .run(
      JSON.stringify({
        receiverType: "OldContract",
        candidateTypes: ["OldContract"],
        dispatch: "interface",
      }),
    );
  const insertCandidate = graph.database.db.prepare(
    "INSERT INTO edge_candidates(edge_id,target_id,reason,confidence) VALUES('dynamic-call',?,'hierarchy',0.65)",
  );
  insertCandidate.run("helper-a");
  insertCandidate.run("helper-b");
  assert.equal(graph.dynamicBoundaries(["caller"], 10).length, 1);
  assert.ok(
    graph.writer
      .affectedResolvedEdgeIds("contract", ["OldContract", "NewContract"])
      .includes("dynamic-call"),
  );

  graph.upsertFileGraph(
    "contract",
    [
      {
        id: "new-contract",
        kind: "interface",
        is_exported: true,
        name: "NewContract",
      },
    ],
    [],
    [],
  );

  assert.equal(graph.dynamicBoundaries(["caller"], 10).length, 0);
  assert.ok(graph.stats().pendingRefCount >= 1);
  graph.close();
});

test("new implementations invalidate dynamic boundaries with no candidates", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.database.endBulkLoad();
  graph.upsertFileGraph(
    "contract-file",
    [
      { id: "runner", kind: "interface", is_exported: true, name: "Runner" },
      { id: "invoke", kind: "function", is_exported: true, name: "invoke" },
    ],
    [],
    [],
  );
  graph.upsertFileGraph("implementation-file", [], [], []);
  graph.database.db
    .prepare(
      `INSERT INTO unresolved_refs(
       id,owner_id,owner_is_file,ref_name,ref_kind,line,source_language,
       receiver_kind,receiver_name,member_name,resolution_hints,status,
       last_attempt,dynamic_reason
     ) VALUES('empty-boundary','invoke',0,'value.run','call',1,'java',
       'qualified','value','run',?,'dynamic',0,'polymorphic_dispatch')`,
    )
    .run(
      JSON.stringify({
        receiverType: "Runner",
        candidateTypes: ["Runner"],
        dispatch: "virtual",
      }),
    );

  graph.upsertFileGraph(
    "implementation-file",
    [
      { id: "worker", kind: "class", is_exported: true, name: "Worker" },
      { id: "worker-run", kind: "method", is_exported: true, name: "run" },
    ],
    [
      edge("worker", "worker-run", "CONTAINS", "contains"),
      {
        ...edge("worker", "runner", "INHERITS", "implements"),
        ref_name: "Runner",
      },
    ],
    [],
  );

  assert.equal(
    graph.database.db
      .prepare("SELECT status FROM unresolved_refs WHERE id='empty-boundary'")
      .get().status,
    "pending",
  );
  graph.close();
});

test("an unrelated same-name member does not invalidate an invisible empty boundary", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "boundary-source",
    [
      {
        id: "boundary-caller",
        kind: "function",
        is_exported: true,
        name: "invoke",
      },
    ],
    [],
    [],
  );
  graph.database.db
    .prepare(
      `INSERT INTO unresolved_refs(
       id,owner_id,owner_is_file,ref_name,ref_kind,line,source_language,
       receiver_kind,receiver_name,member_name,resolution_hints,status,
       last_attempt,dynamic_reason
     ) VALUES('invisible-boundary','boundary-caller',0,'value.run','call',1,'java',
       'qualified','value','run',?,'dynamic',0,'unknown_receiver_type')`,
    )
    .run(
      JSON.stringify({
        receiverType: "Missing",
        candidateTypes: ["Missing"],
        dispatch: "virtual",
      }),
    );

  graph.upsertFileGraph(
    "unrelated-file",
    [
      {
        id: "invisible-unrelated",
        kind: "class",
        is_exported: true,
        name: "Unrelated",
      },
      { id: "invisible-run", kind: "method", is_exported: true, name: "run" },
    ],
    [edge("invisible-unrelated", "invisible-run", "CONTAINS", "contains")],
    [],
  );

  assert.equal(
    graph.database.db
      .prepare(
        "SELECT status FROM unresolved_refs WHERE id='invisible-boundary'",
      )
      .get().status,
    "dynamic",
  );
  graph.close();
});

test("RTA invalidation expands concrete types to receiver interfaces", async () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "types",
    [
      { id: "runner", kind: "interface", is_exported: true, name: "Runner" },
      { id: "alpha", kind: "class", is_exported: true, name: "Alpha" },
      { id: "alpha-run", kind: "method", is_exported: true, name: "run" },
      { id: "fallback", kind: "class", is_exported: true, name: "Fallback" },
      { id: "fallback-run", kind: "method", is_exported: true, name: "run" },
    ],
    [
      edge("alpha", "alpha-run", "CONTAINS", "contains"),
      edge("fallback", "fallback-run", "CONTAINS", "contains"),
      edge("alpha", "runner", "INHERITS", "implements"),
    ],
    [],
  );
  graph.upsertFileGraph(
    "caller-file",
    [{ id: "caller", kind: "function", is_exported: true, name: "caller" }],
    [],
    [],
  );
  graph.upsertFileGraph(
    "maker-file",
    [{ id: "maker", kind: "function", is_exported: true, name: "maker" }],
    [edge("maker", "alpha", "INSTANTIATES", "new")],
    [],
  );
  graph.database.db
    .prepare(
      `INSERT INTO edges(
       id,src_id,dst_id,src_is_file,dst_is_file,kind,rel,count,first_line,
       ref_name,source_language,receiver_kind,receiver_name,member_name,
       resolution_hints,provenance,confidence,evidence
     ) VALUES('dispatch','caller','fallback-run',0,0,'CALLS','call',1,1,
       'value.run','java','qualified','value','run',?,'heuristic',0.75,
       'receiver_type_member')`,
    )
    .run(
      JSON.stringify({
        receiverType: "Runner",
        candidateTypes: ["Runner"],
        dispatch: "interface",
      }),
    );

  graph.deleteFileGraph("maker-file");

  assert.equal(
    graph.edges(["caller", "fallback-run"], ["CALLS"], 10).edges.length,
    0,
  );
  assert.equal(graph.stats().pendingRefCount, 1);
  graph.close();
});

test("RTA distinguishes unrelated same-name concrete type identities", async () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "types",
    [
      {
        id: "runner-one",
        kind: "interface",
        is_exported: true,
        name: "RunnerOne",
      },
      { id: "alpha-one", kind: "class", is_exported: true, name: "Alpha" },
      { id: "run-one", kind: "method", is_exported: true, name: "run" },
      {
        id: "runner-two",
        kind: "interface",
        is_exported: true,
        name: "RunnerTwo",
      },
      { id: "alpha-two", kind: "class", is_exported: true, name: "Alpha" },
      { id: "run-two", kind: "method", is_exported: true, name: "run" },
      {
        id: "same-name-caller",
        kind: "function",
        is_exported: true,
        name: "caller",
      },
    ],
    [
      edge("alpha-one", "run-one", "CONTAINS", "contains"),
      edge("alpha-two", "run-two", "CONTAINS", "contains"),
      edge("alpha-one", "runner-one", "INHERITS", "implements"),
      edge("alpha-two", "runner-two", "INHERITS", "implements"),
    ],
    [],
  );
  graph.upsertFileGraph(
    "maker-one-file",
    [
      {
        id: "maker-one",
        kind: "function",
        is_exported: true,
        name: "makerOne",
      },
    ],
    [edge("maker-one", "alpha-one", "INSTANTIATES", "new")],
    [],
  );
  graph.upsertFileGraph(
    "maker-two-file",
    [
      {
        id: "maker-two",
        kind: "function",
        is_exported: true,
        name: "makerTwo",
      },
    ],
    [edge("maker-two", "alpha-two", "INSTANTIATES", "new")],
    [],
  );
  graph.database.db
    .prepare(
      `INSERT INTO edges(
       id,src_id,dst_id,src_is_file,dst_is_file,kind,rel,count,first_line,
       ref_name,source_language,receiver_kind,receiver_name,member_name,
       resolution_hints,provenance,confidence,evidence
     ) VALUES('same-name-dispatch','same-name-caller','run-one',0,0,
       'CALLS','call',1,1,'value.run','java','qualified','value','run',?,
       'heuristic',0.75,'receiver_type_member')`,
    )
    .run(
      JSON.stringify({
        receiverType: "RunnerOne",
        candidateTypes: ["RunnerOne"],
        dispatch: "interface",
      }),
    );

  graph.deleteFileGraph("maker-one-file");

  assert.equal(
    graph.edges(["same-name-caller", "run-one"], ["CALLS"], 10).edges.length,
    0,
  );
  assert.equal(graph.stats().pendingRefCount, 1);
  assert.equal(
    graph.edges(["maker-two", "alpha-two"], ["INSTANTIATES"], 10).edges.length,
    1,
  );
  graph.close();
});

test("failed refs retry in deterministic per-name batches", async () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  const nodes = Array.from({ length: 501 }, (_, index) => ({
    id: `caller-${String(index).padStart(3, "0")}`,
    kind: "function",
    is_exported: false,
    name: `caller${index}`,
  }));
  const refs = nodes.map((node, occurrence) =>
    rawRef({
      owner: node.id,
      refName: "lateTarget",
      line: 1,
      occurrence,
      sourceLanguage: "typescript",
    }),
  );
  graph.upsertFileGraph("callers", nodes, [], refs);
  await graph.resolvePending();
  assert.equal(graph.stats().refCount, 501);

  graph.upsertFileGraph(
    "target",
    [
      {
        id: "late-target",
        kind: "function",
        is_exported: true,
        name: "lateTarget",
      },
    ],
    [],
    [],
  );
  await graph.resolvePending();
  assert.equal(graph.stats().callsCount, 501);
  assert.equal(graph.stats().refCount, 0);
  graph.close();
});

test("inheritance batches are fully drained before receiver calls", async () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  const children = Array.from({ length: 501 }, (_, index) => ({
    id: `child-${String(index).padStart(3, "0")}`,
    kind: "class",
    is_exported: false,
    name: `Child${index}`,
  }));
  const run = {
    id: "child-run",
    kind: "method",
    is_exported: false,
    name: "run",
  };
  graph.upsertFileGraph(
    "children",
    [...children, run],
    [edge(children[500].id, run.id, "CONTAINS", "contains")],
    [
      ...children.map((child, occurrence) =>
        rawRef({
          owner: child.id,
          refName: "Base",
          refKind: "extends",
          line: 1,
          occurrence,
          sourceLanguage: "typescript",
        }),
      ),
      rawRef({
        owner: run.id,
        refName: "this.helper",
        line: 2,
        sourceLanguage: "typescript",
      }),
    ],
  );
  await graph.resolvePending();

  graph.upsertFileGraph(
    "base-file",
    [
      { id: "base", kind: "class", is_exported: true, name: "Base" },
      { id: "base-helper", kind: "method", is_exported: false, name: "helper" },
    ],
    [edge("base", "base-helper", "CONTAINS", "contains")],
    [],
  );
  await graph.resolvePending();

  assert.equal(graph.stats().inheritsCount, 501);
  assert.deepEqual(
    graph.callees(run.id, 1, 10).map((candidate) => candidate.id),
    ["base-helper"],
  );
  graph.close();
});

test("failed ref retry batches rotate instead of starving later rows", async () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  const file = (id, absolutePath) => ({
    id,
    absolutePath,
    relativePath: absolutePath.slice("/repo/".length),
    rootPath: "/repo",
    sizeBytes: 1,
    lastModifiedTime: 1,
    kind: "code",
    format: "typescript",
  });
  const blockedFiles = Array.from({ length: 500 }, (_, index) =>
    file(`blocked-${index}`, `/repo/bad-${index}/caller.ts`),
  );
  const validFile = file("valid", "/repo/good/caller.ts");
  for (const [index, caller] of blockedFiles.entries()) {
    graph.upsertFileGraph(
      caller.id,
      [],
      [],
      [
        {
          ...rawRef({
            type: "import",
            owner: caller.id,
            refName: "./target",
            line: 1,
          }),
          id: `aaa-${String(index).padStart(3, "0")}`,
        },
      ],
    );
  }
  graph.upsertFileGraph(
    validFile.id,
    [],
    [],
    [
      {
        ...rawRef({
          type: "import",
          owner: validFile.id,
          refName: "./target",
          line: 1,
        }),
        id: "zzz-valid",
      },
    ],
  );
  const callers = [...blockedFiles, validFile];
  await graph.resolvePending({ files: callers });
  assert.equal(graph.stats().refCount, 501);

  const targetFile = file("target", "/repo/good/target.ts");
  graph.upsertFileGraph(targetFile.id, [], [], []);
  await graph.resolvePending({ files: [...callers, targetFile] });
  assert.equal(graph.stats().refCount, 500);
  assert.deepEqual(graph.expandFileNeighbors([validFile.id], 10), [
    { fid: validFile.id, id: targetFile.id, direction: "out" },
  ]);
  graph.close();
});

test("retry batches process unrelated names only once per invocation", async () => {
  class InspectableGraph extends SqliteGraphStorage {
    pendingAttempts() {
      return this.database.db
        .prepare(
          "SELECT ref_name,last_attempt,COUNT(*) AS count FROM unresolved_refs WHERE status='failed' GROUP BY ref_name,last_attempt ORDER BY ref_name,last_attempt",
        )
        .all()
        .map((row) => ({ ...row }));
    }
  }
  const graph = new InspectableGraph("", { inMemory: true });
  const hotNodes = Array.from({ length: 1_001 }, (_, index) => ({
    id: `hot-${index}`,
    kind: "function",
    is_exported: false,
    name: `hot${index}`,
  }));
  const coldNode = {
    id: "cold",
    kind: "function",
    is_exported: false,
    name: "cold",
  };
  graph.upsertFileGraph(
    "retry-work",
    [...hotNodes, coldNode],
    [],
    [
      ...hotNodes.map((node, occurrence) =>
        rawRef({
          owner: node.id,
          refName: "missingHot",
          line: 1,
          occurrence,
          sourceLanguage: "typescript",
        }),
      ),
      rawRef({
        owner: coldNode.id,
        refName: "missingCold",
        line: 1,
        sourceLanguage: "typescript",
      }),
    ],
  );

  await graph.resolvePending();
  await graph.resolvePending();

  assert.deepEqual(graph.pendingAttempts(), [
    { ref_name: "missingCold", last_attempt: 2, count: 1 },
    { ref_name: "missingHot", last_attempt: 2, count: 1_001 },
  ]);
  graph.close();
});

test("failed refs can be skipped while newly pending refs still resolve", async () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "stable-failed",
    [{ id: "stable-owner", kind: "function", name: "stable" }],
    [],
    [
      rawRef({
        owner: "stable-owner",
        refName: "missingStable",
        refKind: "call",
        line: 1,
      }),
    ],
  );
  await graph.resolvePending();
  const before = graph.database.one(
    "SELECT last_attempt FROM unresolved_refs WHERE ref_name='missingStable'",
  ).last_attempt;

  graph.upsertFileGraph(
    "new-pending",
    [{ id: "new-owner", kind: "function", name: "newOwner" }],
    [],
    [
      rawRef({
        owner: "new-owner",
        refName: "missingNew",
        refKind: "call",
        line: 1,
      }),
    ],
  );
  await graph.resolvePending({ retryFailed: false });

  const rows = graph.database
    .all(
      "SELECT ref_name,status,last_attempt FROM unresolved_refs ORDER BY ref_name",
    )
    .map((row) => ({ ...row }));
  assert.deepEqual(rows, [
    { ref_name: "missingNew", status: "failed", last_attempt: before + 1 },
    { ref_name: "missingStable", status: "failed", last_attempt: before },
  ]);
  graph.close();
});

test("owner receiver refs reuse inheritance lookup within an invocation", async () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "scoped",
    [
      { id: "base", kind: "class", is_exported: false, name: "Base" },
      { id: "helper-a", kind: "method", is_exported: false, name: "helperA" },
      { id: "helper-b", kind: "method", is_exported: false, name: "helperB" },
      { id: "child", kind: "class", is_exported: false, name: "Child" },
      { id: "run", kind: "method", is_exported: false, name: "run" },
    ],
    [
      edge("base", "helper-a", "CONTAINS", "contains"),
      edge("base", "helper-b", "CONTAINS", "contains"),
      edge("child", "run", "CONTAINS", "contains"),
      edge("child", "base", "INHERITS", "extends"),
    ],
    [
      rawRef({ owner: "run", refName: "this.helperA", line: 1 }),
      rawRef({ owner: "run", refName: "this.helperB", line: 2 }),
      rawRef({ owner: "run", refName: "ordinaryMissing", line: 3 }),
    ],
  );
  let hierarchyQueries = 0;
  const resolver = graph.resolver;
  const original = resolver.inheritanceContainers.bind(resolver);
  resolver.inheritanceContainers = (...args) => {
    hierarchyQueries += 1;
    return original(...args);
  };

  await graph.resolvePending();

  assert.equal(hierarchyQueries, 1);
  assert.deepEqual(
    graph.callees("run", 1, 10).map((item) => item.id),
    ["helper-a", "helper-b"],
  );
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
    provenance: "static",
    confidence: 1,
    evidence: undefined,
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

test("occurrence edges are grouped before traversal limits are applied", async () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "source",
    [{ id: "caller", kind: "function", is_exported: true, name: "caller" }],
    [],
    [
      rawRef({ owner: "caller", refName: "targetB", line: 1, occurrence: 0 }),
      rawRef({ owner: "caller", refName: "targetB", line: 2, occurrence: 1 }),
      rawRef({ owner: "caller", refName: "targetB", line: 3, occurrence: 2 }),
      rawRef({ owner: "caller", refName: "targetC", line: 4, occurrence: 3 }),
    ],
  );
  graph.upsertFileGraph(
    "targets",
    [
      { id: "b", kind: "function", is_exported: true, name: "targetB" },
      { id: "c", kind: "function", is_exported: true, name: "targetC" },
    ],
    [],
    [],
  );
  await graph.resolvePending();

  assert.deepEqual(
    graph
      .outgoingEdges(["caller"], ["CALLS"], 2)
      .map((edge) => [edge.dst, edge.count]),
    [
      ["b", 3],
      ["c", 1],
    ],
  );
  assert.deepEqual(
    graph.context("caller").outgoing.map((edge) => edge.id),
    ["b", "c"],
  );
  assert.equal(graph.stats().callsCount, 4);
  graph.close();
});

test("edge aggregation keeps evidence from the highest-confidence occurrence", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "evidence",
    [
      { id: "source", kind: "function", is_exported: true, name: "source" },
      { id: "target", kind: "method", is_exported: true, name: "target" },
    ],
    [],
    [],
  );
  const insert = graph.database.db.prepare(
    `INSERT INTO edges(
       id,src_id,dst_id,src_is_file,dst_is_file,kind,rel,count,first_line,
       ref_name,provenance,confidence,evidence
     ) VALUES(?,?,?,0,0,'CALLS','call',1,?,?,'heuristic',?,?)`,
  );
  insert.run("low", "source", "target", 1, "target", 0.35, "hierarchy");
  insert.run(
    "high",
    "source",
    "target",
    2,
    "target",
    0.75,
    "receiver_type_member",
  );

  const aggregated = graph.outgoingEdges(["source"], ["CALLS"], 10)[0];
  assert.equal(aggregated.confidence, 0.75);
  assert.equal(aggregated.evidence, "receiver_type_member");
  assert.equal(aggregated.count, 2);
  graph.close();
});

test("mixed directional queries reserve budget per edge kind and refill unused quota", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "mixed",
    [
      { id: "a", kind: "class", is_exported: true, name: "A" },
      { id: "b", kind: "function", is_exported: true, name: "b" },
      { id: "c", kind: "function", is_exported: true, name: "c" },
      { id: "d", kind: "function", is_exported: true, name: "d" },
      { id: "member", kind: "method", is_exported: true, name: "member" },
    ],
    [
      edge("a", "b", "CALLS", "call"),
      edge("a", "c", "CALLS", "call"),
      edge("a", "d", "CALLS", "call"),
      edge("a", "member", "CONTAINS", "contains"),
    ],
    [],
  );

  assert.deepEqual(
    graph
      .outgoingEdges(["a"], ["CALLS", "CONTAINS"], 2)
      .map((item) => item.kind),
    ["CALLS", "CONTAINS"],
  );
  assert.equal(
    graph.outgoingEdges(["a"], ["CALLS", "REFS"], 3).length,
    3,
    "unused REFS quota should be refilled from CALLS",
  );
  graph.close();
});

test("induced edge budgets retain each requested relation kind", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "induced",
    [
      { id: "root", kind: "class", is_exported: true, name: "Root" },
      { id: "base", kind: "class", is_exported: true, name: "Base" },
      { id: "member", kind: "method", is_exported: true, name: "member" },
      ...Array.from({ length: 4 }, (_, index) => ({
        id: `call-${index}`,
        kind: "function",
        is_exported: true,
        name: `call${index}`,
      })),
    ],
    [
      ...Array.from({ length: 4 }, (_, index) =>
        edge("root", `call-${index}`, "CALLS", "call"),
      ),
      edge("root", "base", "INHERITS", "extends"),
      edge("root", "member", "CONTAINS", "contains"),
    ],
    [],
  );

  const result = graph.edges(
    ["root", "base", "member", "call-0", "call-1", "call-2", "call-3"],
    ["CALLS", "INHERITS", "CONTAINS"],
    3,
  );
  assert.deepEqual(
    new Set(result.edges.map((item) => item.kind)),
    new Set(["CALLS", "INHERITS", "CONTAINS"]),
  );
  assert.equal(result.truncated, true);
  graph.close();
});

test("bidirectional BFS pages past a frontier-internal edge", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "both-file",
    ["A", "B", "C", "D", "E"].map((id) => ({
      id,
      kind: "function",
      is_exported: false,
      name: id,
    })),
    [
      edge("A", "B", "CALLS", "call"),
      edge("A", "C", "CALLS", "call"),
      edge("C", "B", "CALLS", "call"),
      edge("C", "E", "CALLS", "call"),
      edge("D", "C", "CALLS", "call"),
    ],
    [],
  );

  const reached = new Set(
    graph
      .traverse("A", {
        edgeKinds: ["CALLS"],
        direction: "both",
        maxDepth: 2,
        limit: 4,
      })
      .map((node) => node.id),
  );
  assert.deepEqual(reached, new Set(["B", "C", "D", "E"]));
  graph.close();
});

test("traversal node limits refill edges that point to an already seen node", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "duplicate-neighbors",
    [
      { id: "a", kind: "function", is_exported: true, name: "a" },
      { id: "b", kind: "function", is_exported: true, name: "b" },
      { id: "c", kind: "function", is_exported: true, name: "c" },
    ],
    [
      edge("a", "b", "CALLS", "call"),
      edge("a", "b", "REFS", "ref"),
      edge("a", "c", "CALLS", "call"),
    ],
    [],
  );

  assert.deepEqual(
    graph
      .traverse("a", {
        edgeKinds: ["CALLS", "REFS"],
        direction: "outgoing",
        maxDepth: 1,
        limit: 2,
      })
      .map((item) => item.id),
    ["b", "c"],
  );
  graph.close();
});

test("reprojecting a local constructor keeps one instantiation fact", async () => {
  class InspectableGraph extends SqliteGraphStorage {
    instantiationRows() {
      return this.database.db
        .prepare(
          "SELECT COUNT(*) AS count FROM edges WHERE kind='INSTANTIATES'",
        )
        .get().count;
    }
  }
  const graph = new InspectableGraph("", { inMemory: true });
  graph.upsertFileGraph(
    "source",
    [
      { id: "make", kind: "function", is_exported: true, name: "make" },
      { id: "local-widget", kind: "class", is_exported: true, name: "Widget" },
    ],
    [
      edge("make", "local-widget", "CALLS", "new"),
      edge("make", "local-widget", "INSTANTIATES", "instantiates"),
    ],
    [],
  );
  graph.upsertFileGraph(
    "other",
    [{ id: "other-widget", kind: "class", is_exported: true, name: "Widget" }],
    [],
    [],
  );
  await graph.resolvePending();

  assert.equal(graph.instantiationRows(), 1);
  assert.equal(
    graph.outgoingEdges(["make"], ["INSTANTIATES"], 10)[0]?.count,
    1,
  );
  assert.deepEqual(
    graph.callees("make", 1, 10).map((item) => item.id),
    ["local-widget"],
  );
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
  assert.equal(reopened.stats().callsCount, 2);
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
      .edges(["caller", "target", "leaf"], ["CALLS"], 10)
      .edges.map((edge) => [edge.src, edge.dst]),
    [
      ["caller", "target"],
      ["target", "leaf"],
    ],
  );
  const bounded = graph.edges(["caller", "target", "leaf"], ["CALLS"], 1);
  assert.equal(bounded.edges.length, 1);
  assert.equal(bounded.truncated, true);
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

test("SQLite traversal applies a stable SQL edge limit before materialization", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  const leaves = Array.from(
    { length: 100 },
    (_, index) => `leaf-${String(index).padStart(3, "0")}`,
  );
  graph.upsertFileGraph(
    "fanout",
    [
      { id: "root", kind: "function", is_exported: true, name: "root" },
      ...leaves.map((id) => ({
        id,
        kind: "function",
        is_exported: false,
        name: id,
      })),
    ],
    leaves.map((id) => ({
      src: "root",
      dst: id,
      kind: "CALLS",
      rel: "call",
      count: 1,
      first_line: 1,
      ref_name: id,
    })),
    [],
  );
  assert.deepEqual(
    graph
      .traverse("root", {
        edgeKinds: ["CALLS"],
        direction: "outgoing",
        maxDepth: 1,
        limit: 3,
      })
      .map((item) => item.id),
    leaves.slice(0, 3),
  );
  graph.close();
});

test("directional edge limits are shared fairly across seed nodes", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "fair-seeds",
    ["a", "b", "a1", "a2", "a3", "b1"].map((id) => ({
      id,
      kind: "function",
      is_exported: true,
      name: id,
    })),
    [
      ["a", "a1"],
      ["a", "a2"],
      ["a", "a3"],
      ["b", "b1"],
    ].map(([src, dst]) => ({
      src,
      dst,
      kind: "CALLS",
      rel: "call",
      count: 1,
      first_line: 1,
      ref_name: dst,
    })),
    [],
  );

  assert.deepEqual(
    graph
      .outgoingEdges(["a", "b"], ["CALLS"], 2)
      .map((edge) => [edge.src, edge.dst]),
    [
      ["a", "a1"],
      ["b", "b1"],
    ],
  );
  graph.close();
});

test("impact follows type dependencies and callers of container members", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "types",
    [
      { id: "base", kind: "class", is_exported: true, name: "Base" },
      { id: "method", kind: "function", is_exported: true, name: "run" },
      { id: "derived", kind: "class", is_exported: true, name: "Derived" },
      { id: "maker", kind: "function", is_exported: true, name: "make" },
      { id: "caller", kind: "function", is_exported: true, name: "invoke" },
    ],
    [
      edge("base", "method", "CONTAINS", "contains"),
      edge("derived", "base", "INHERITS", "extends"),
      edge("maker", "base", "INSTANTIATES", "instantiate"),
      edge("caller", "method", "CALLS", "call"),
    ],
    [],
  );

  assert.deepEqual(
    new Set(graph.impact("base", 1, 10).map((item) => item.id)),
    new Set(["derived", "maker", "caller"]),
  );
  graph.close();
});

test("callers and callees treat instantiation as a constructor call", () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    "constructors",
    [
      { id: "maker", kind: "function", is_exported: true, name: "make" },
      { id: "service", kind: "class", is_exported: true, name: "Service" },
    ],
    [edge("maker", "service", "INSTANTIATES", "instantiate")],
    [],
  );

  assert.deepEqual(
    graph.callers("service", 1, 10).map((item) => item.id),
    ["maker"],
  );
  assert.deepEqual(
    graph.callees("maker", 1, 10).map((item) => item.id),
    ["service"],
  );
  graph.close();
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
