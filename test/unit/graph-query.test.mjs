import assert from "node:assert/strict";
import test from "node:test";
import {
  SqliteGraphStorage,
  queryGraphNeighborhood,
} from "../../dist/engine/graph/index.js";
import { graphEntity } from "../helpers/graph.mjs";

const entity = (id, name, path = "a.ts") =>
  graphEntity(id, name, path, { symbolType: "function" });

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

  Object.assign(graph, storage);
  const result = queryGraphNeighborhood(graph, {
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

  const callees = queryGraphNeighborhood(graph, {
    direction: "callees",
    query: "caller",
  });
  assert.equal(callees.neighbors[0]?.id, "target");
  assert.equal(callees.neighbors[0]?.count, 2);
  graph.close();
});
