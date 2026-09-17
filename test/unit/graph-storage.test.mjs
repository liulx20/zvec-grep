import assert from "node:assert/strict";
import { writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { openGraphStorage } from "../../dist/engine/graph/persistence/index.js";
import { GraphDatabase } from "../../dist/engine/graph/persistence/sqlite/database.js";
import { SqliteGraphWriter } from "../../dist/engine/graph/persistence/sqlite/writer.js";
import { createTemporaryDirectory } from "../helpers/fixtures.mjs";
import { localGraph } from "../helpers/graph-fixtures.mjs";

test("graph storage requires a ready index and owns its query connection", async (t) => {
  const path = await createTemporaryDirectory(t);
  const dbPath = join(path, "graph.sqlite");
  assert.throws(() => openGraphStorage(path), /run zg --index/);
  await assert.rejects(access(dbPath), { code: "ENOENT" });
  const edge = {
    kind: "calls",
    source: "source",
    target: "target",
    line: 1,
    column: 0,
    provenance: "file_local",
    metadata: {},
  };
  const database = GraphDatabase.open(dbPath);
  try {
    await new SqliteGraphWriter(database).writeFileGraph(
      "file",
      localGraph([edge]),
      [],
    );
  } finally {
    database.close();
  }
  assert.throws(() => openGraphStorage(path), /run zg --index/);
  await writeFile(join(path, "graph.ready"), "1");
  const storage = openGraphStorage(path);
  try {
    assert.deepEqual(await storage.getCallers("target"), [edge]);
    assert.deepEqual(await storage.getCallees("source"), [edge]);
  } finally {
    storage.close();
  }
  storage.close();
  await assert.rejects(storage.getCallers("target"), /closed/);
  await writeFile(join(path, "graph.pending.json"), "{}");
  assert.throws(() => openGraphStorage(path), /requires recovery/);
});
