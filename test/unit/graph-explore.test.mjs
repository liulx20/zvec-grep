import assert from "node:assert/strict";
import test from "node:test";
import {
  SqliteGraphStorage,
  UnavailableGraphStorage,
  exploreGraph,
  exploreSubgraph,
  queryGraphNeighborhood,
} from "../../dist/engine/graph/index.js";
import { entityStorage, graphEntity as entity } from "../helpers/graph.mjs";

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
  const storage = entityStorage([
    entity("left", "left", "flow.ts"),
    entity("bridge", "bridge", "flow.ts"),
    entity("right", "right", "flow.ts"),
  ]);

  Object.assign(graph, storage);
  const result = exploreSubgraph(graph, {
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
  const storage = entityStorage(
    rootIds.map((id) => entity(id, id, `${id}.ts`)),
  );

  Object.assign(graph, storage);
  const result = exploreSubgraph(graph, {
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
  const storage = entityStorage([entity("root", "root", "root.ts")]);

  Object.assign(graph, storage);
  const result = exploreGraph(graph, {
    query: "root",
    maxNodes: 16,
  });

  assert.equal(result.dynamicBoundaries.length, 16);
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
  const storage = entityStorage([
    ...rootIds.map((id) => entity(id, id, "paths.ts")),
    entity("bridge", "bridge", "paths.ts"),
  ]);
  Object.assign(graph, storage);
  const result = exploreSubgraph(graph, {
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
  const storage = entityStorage([
    entity("large-symbol", "large", "large.ts", {
      symbolType: "function",
      text: `export function large() {\n${"x".repeat(8_000)}\n}`,
    }),
  ]);
  Object.assign(graph, storage);
  const result = exploreGraph(graph, {
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
  const storage = entityStorage([
    entity("root", "root", "weighted.ts"),
    entity("called", "called", "weighted.ts"),
    entity("referenced", "referenced", "weighted.ts", {
      symbolType: "class",
    }),
  ]);

  Object.assign(graph, storage);
  const result = exploreSubgraph(graph, {
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
  const storage = entityStorage([
    entity("root", "root", "parallel.ts"),
    entity("target", "target", "parallel.ts"),
  ]);

  Object.assign(graph, storage);
  const result = exploreSubgraph(graph, {
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

  const storage = entityStorage([
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

  Object.assign(graph, storage);
  const result = exploreGraph(graph, {
    query: "Child",
    maxFiles: 4,
    traversalDepth: 2,
  });

  assert.equal(result.available, true);
  assert.ok(result.roots.some((r) => r.id === "Child"));
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
  const storage = entityStorage([
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

  Object.assign(graph, storage);
  const result = exploreGraph(graph, {
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
  const storage = entityStorage([
    entity("user", "user", "a.ts", { symbolType: "function" }),
    entity("target", "target", "a.ts", { symbolType: "function" }),
  ]);

  Object.assign(graph, storage);
  const result = queryGraphNeighborhood(graph, {
    direction: "impact",
    query: "target",
  });
  assert.equal(result.neighbors[0]?.id, "user");
  graph.close();
});

test("exploreGraph reports graph_unavailable", () => {
  const graph = new UnavailableGraphStorage();
  const result = exploreGraph(graph, { query: "X" });
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

  const storage = entityStorage([
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

  Object.assign(graph, storage);
  const result = exploreGraph(graph, {
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
