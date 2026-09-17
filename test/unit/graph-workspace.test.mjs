import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { WorkspaceGraph } from "../../dist/engine/graph/workspace.js";
import { SqliteGraphReader } from "../../dist/engine/graph/persistence/sqlite/reader.js";
import { SqlitePendingRefStore } from "../../dist/engine/graph/persistence/sqlite/pending-ref-resolver.js";
import { createTemporaryDirectory } from "../helpers/fixtures.mjs";
import { localGraph } from "../helpers/graph-fixtures.mjs";

const file = { id: "file", absolutePath: "/test.ts", relativePath: "test.ts" };
const edge = {
  kind: "calls",
  source: "caller",
  target: "helper",
  line: 1,
  column: 0,
  provenance: "file_local",
  metadata: {},
};
async function fixture(t) {
  const path = await createTemporaryDirectory(t);
  const state = { ids: [], failed: [], deleted: [] };
  const storage = {
    listEntitiesByFile() {
      return state.ids.map((id) => ({ entity: { id }, file }));
    },
    markFileFailed(file, error) {
      state.ids = [];
      state.failed.push([file.id, error]);
    },
    deleteFile(id) {
      state.ids = [];
      state.deleted.push(id);
    },
    async finalizeWrites() {},
    getEntity() {
      return null;
    },
    listFiles() {
      return [];
    },
  };
  const graph = new WorkspaceGraph(path, storage);
  t.after(() => graph.close());
  return {
    path,
    graph,
    storage,
    state,
    reader: new SqliteGraphReader(graph.database),
  };
}

test("failed zvec write clears old graph and marks file for retry", async (t) => {
  const { graph, state, reader, path } = await fixture(t);
  await graph.update(file, localGraph([edge]), () => {
    state.ids = ["caller", "helper"];
  });
  await graph.finish();
  await assert.rejects(
    graph.update(file, localGraph([edge]), () => {
      state.ids = [];
      throw new Error("partial zvec write");
    }),
    /partial zvec write/,
  );
  assert.deepEqual(await reader.getCallees("caller"), []);
  assert.equal(state.failed.length, 1);
  assert.equal(existsSync(join(path, "graph.pending.json")), false);
});

test("restart replays journal using captured old IDs even when zvec has lost them", async (t) => {
  const { graph, state, path } = await fixture(t);
  await graph.update(file, localGraph([edge]), () => {
    state.ids = ["caller", "helper"];
  });
  writeFileSync(
    join(path, "graph.pending.json"),
    JSON.stringify({ file, entityIds: ["caller", "helper"], deletion: false }),
  );
  state.ids = [];
  graph.close();
  const reopened = new WorkspaceGraph(path, {
    listEntitiesByFile: () => [],
    markFileFailed: () => state.failed.push("recovered"),
    finalizeWrites: async () => {},
  });
  t.after(() => reopened.close());
  await reopened.recover();
  assert.equal(state.failed.length, 1);
  assert.deepEqual(
    await new SqliteGraphReader(reopened.database).getCallees("caller"),
    [],
  );
  assert.equal(existsSync(join(path, "graph.pending.json")), false);
});

test("failed recovery keeps journal and serializes subsequent writes behind recovery", async (t) => {
  const { graph, state, storage, path } = await fixture(t);
  storage.markFileFailed = () => {
    throw new Error("storage unavailable");
  };
  await assert.rejects(
    graph.update(file, localGraph([edge]), () => {
      throw new Error("write failed");
    }),
    AggregateError,
  );
  assert.equal(existsSync(join(path, "graph.pending.json")), true);
  let mutated = false;
  await assert.rejects(
    graph.update(file, undefined, () => {
      mutated = true;
    }),
    /storage unavailable/,
  );
  assert.equal(mutated, false);
  storage.markFileFailed = () => {
    state.ids = [];
  };
  await graph.recover();
  assert.equal(existsSync(join(path, "graph.pending.json")), false);
});

test("resolver skips missing targets and leaves references pending", async (t) => {
  const { graph, state } = await fixture(t);
  const ref = {
    ownerId: "caller",
    refName: "missing",
    receiverName: null,
    refKind: "calls",
    arity: 0,
    line: 1,
    column: 0,
    status: "pending",
    metadata: {},
  };
  await graph.update(file, localGraph([], [ref]), () => {
    state.ids = ["caller"];
  });
  await graph.finish(async () => ({
    targetId: "missing",
    provenance: "workspace_unique",
  }));
  assert.equal(
    (await new SqlitePendingRefStore(graph.database).listPendingRefs()).refs
      .length,
    1,
  );
});

test("SQLite graph failure after zvec replacement discards both outputs", async (t) => {
  const { graph, state, reader } = await fixture(t);
  graph.database.connection.exec(
    "CREATE TRIGGER fail_edge BEFORE INSERT ON edges BEGIN SELECT RAISE(ABORT, 'injected graph failure'); END",
  );
  await assert.rejects(
    graph.update(file, localGraph([edge]), () => {
      state.ids = ["caller", "helper"];
    }),
    /injected graph failure/,
  );
  assert.deepEqual(state.ids, []);
  assert.equal(state.failed.length, 1);
  assert.deepEqual(await reader.getCallees("caller"), []);
});

test("adding unrelated file invalidates resolved candidates before another resolution pass", async (t) => {
  const { graph, state } = await fixture(t);
  const ref = {
    ownerId: "caller",
    refName: "remote",
    receiverName: null,
    refKind: "calls",
    arity: 0,
    line: 1,
    column: 0,
    status: "pending",
    metadata: {},
  };
  await graph.update(file, localGraph([], [ref]), () => {
    state.ids = ["caller"];
  });
  const store = new SqlitePendingRefStore(graph.database);
  const [pending] = (await store.listPendingRefs()).refs;
  await store.applyResolutions([
    {
      refId: pending.id,
      refToken: pending.token,
      targetId: "remote",
      provenance: "workspace_unique",
    },
  ]);
  await graph.update({ ...file, id: "another" }, undefined, () => {});
  const [requeued] = (await store.listPendingRefs()).refs;
  assert.equal(requeued.id, pending.id);
  assert.notEqual(requeued.token, pending.token);
});

test("interrupted deletion is replayed as deletion without creating a failed file", async (t) => {
  const { graph, state, reader, path } = await fixture(t);
  await graph.update(file, localGraph([edge]), () => {
    state.ids = ["caller", "helper"];
  });
  writeFileSync(
    join(path, "graph.pending.json"),
    JSON.stringify({
      file,
      entityIds: ["caller", "helper"],
      deletion: true,
    }),
  );
  await graph.recover();
  assert.deepEqual(state.deleted, [file.id]);
  assert.deepEqual(state.failed, []);
  assert.deepEqual(await reader.getCallees("caller"), []);
});
