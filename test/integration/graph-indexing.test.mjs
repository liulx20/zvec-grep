import { withWorkspaceGraphRead } from "../../dist/engine/storage/index.js";
import { acquireReadWriteLock } from "../../dist/engine/utils/lock.js";
import { openWorkspaceReadSession } from "../../dist/engine/service/zvec-grep.js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { DaemonBackend } from "../../dist/daemon/backend.js";
import { createZvecGrepMcpServer } from "../../dist/mcp/tools.js";
import assert from "node:assert/strict";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createZvecGrep } from "../../dist/index.js";
import { GraphDatabase } from "../../dist/engine/graph/persistence/sqlite/database.js";
import { createTemporaryDirectory } from "../helpers/fixtures.mjs";
import { FakeEmbeddingModel } from "../helpers/fake-embedding.mjs";

async function queryCallers(root, symbol, limit) {
  const backend = new DaemonBackend({ version: "test" });
  try {
    return await backend.getCallers({ root, symbol, limit });
  } finally {
    await backend.close();
  }
}
async function queryCallees(root, symbol, limit) {
  const backend = new DaemonBackend({ version: "test" });
  try {
    return await backend.getCallees({ root, symbol, limit });
  } finally {
    await backend.close();
  }
}

function calls(root) {
  const db = GraphDatabase.open(join(root, ".zvec-grep", "graph.sqlite"), true);
  try {
    return db.connection
      .prepare("SELECT * FROM edges WHERE kind = 'calls'")
      .all();
  } finally {
    db.close();
  }
}

test("index persists local graph, exposes workspace queries, updates and deletes it", async (t) => {
  const root = await createTemporaryDirectory(t);
  const path = join(root, "example.ts");
  await writeFile(
    path,
    "export function helper() { return 1; }\nexport function caller() { return helper(); }\n",
  );
  const service = await createZvecGrep({
    root,
    embeddingModel: new FakeEmbeddingModel(),
  });
  t.after(() => service.close());
  await service.index();
  for (const method of [
    "getCallers",
    "getCallees",
    "getImports",
    "getInheritance",
    "getSubclasses",
    "getImplementations",
  ]) {
    assert.equal(method in service, false);
  }
  const closedSession = openWorkspaceReadSession(root);
  await closedSession.close();
  assert.equal("getCallers" in closedSession, false);
  assert.equal("getCallees" in closedSession, false);
  const [edge] = calls(root);
  assert.ok(edge);
  assert.equal(
    (await queryCallers(root, "helper"))[0].edges[0].symbol.name,
    "caller",
  );
  assert.equal(
    (await queryCallees(root, "caller"))[0].edges[0].symbol.name,
    "helper",
  );
  const writeLock = acquireReadWriteLock(
    join(root, ".zvec-grep", "locks", "home"),
    "write",
    { operation: "test" },
  );
  try {
    await assert.rejects(
      queryCallers(root, "helper"),
      (error) => error.code === "ZVEC_GREP.ENGINE.LOCK.BUSY",
    );
  } finally {
    writeLock.release();
  }
  assert.equal((await queryCallers(root, "helper"))[0].edges.length, 1);
  await assert.rejects(
    withWorkspaceGraphRead(root, async (entities, graph) => {
      assert.ok(entities.listFiles().length);
      await Promise.resolve();
      assert.throws(
        () =>
          acquireReadWriteLock(
            join(root, ".zvec-grep", "locks", "home"),
            "write",
            { operation: "test writer" },
          ),
        (error) => error.code === "ZVEC_GREP.ENGINE.LOCK.BUSY",
      );
      assert.equal((await graph.getCallers(edge.target)).length, 1);
      throw new Error("injected read failure");
    }),
    /injected read failure/,
  );
  const afterFailure = acquireReadWriteLock(
    join(root, ".zvec-grep", "locks", "home"),
    "write",
    { operation: "test after failure" },
  );
  afterFailure.release();
  const backend = new DaemonBackend({
    version: "test",
    createService: async () => {
      throw new Error("Graph queries must not create ZvecGrep services");
    },
  });
  const server = createZvecGrepMcpServer(backend, "test");
  const client = new Client({ name: "graph-integration", version: "test" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const result = await client.callTool({
      name: "callers",
      arguments: { root, symbol: "helper" },
    });
    const returnedEdge = result.structuredContent.matches[0].edges[0];
    assert.deepEqual(returnedEdge.symbol, {
      name: "caller",
      filePath: "example.ts",
      startLine: 2,
      endLine: 2,
    });
    assert.deepEqual(Object.keys(returnedEdge).sort(), [
      "column",
      "line",
      "symbol",
    ]);
    assert.deepEqual(Object.keys(result.structuredContent.matches[0]).sort(), [
      "edges",
      "endLine",
      "filePath",
      "name",
      "startLine",
      "totalEdges",
    ]);
    assert.equal(backend.modelPool.snapshot().activeLeases, 0);
  } finally {
    await client.close();
    await server.close();
    await backend.close();
  }
  // Missing graph readiness forces a complete backfill even for unchanged files.
  await rm(join(root, ".zvec-grep", "graph.ready"));
  await assert.rejects(queryCallers(root, "helper"), /run zg --index/);
  await service.index({ changedPaths: [path] });
  assert.equal(calls(root).length, 1);
  await writeFile(path, "export function caller() { return 42; }\n");
  await service.index();
  assert.deepEqual(await queryCallers(root, "helper"), []);
  await rm(path);
  await service.index();
  assert.deepEqual(await queryCallees(root, "caller"), []);
  await service.dropIndex();
  await assert.rejects(readFile(join(root, ".zvec-grep", "graph.sqlite")), {
    code: "ENOENT",
  });
});

test("resolver runs after indexing; deleted cross-file targets invalidate incoming edges", async (t) => {
  const root = await createTemporaryDirectory(t);
  await writeFile(
    join(root, "caller.ts"),
    "export function caller() { return remote(); }\n",
  );
  const targetPath = join(root, "target.ts");
  await writeFile(targetPath, "export function remote() { return 1; }\n");
  let resolved = 0;
  const service = await createZvecGrep({
    root,
    embeddingModel: new FakeEmbeddingModel(),
    async graphResolver(ref, lookup) {
      if (ref.refName !== "remote") return null;
      const file = lookup
        .listFiles()
        .find((file) => file.absolutePath === targetPath);
      if (!file) return null;
      const [target] = lookup.listEntitiesByFile(file.id);
      if (!target) return null;
      resolved++;
      return { targetId: target.entity.id, provenance: "workspace_unique" };
    },
  });
  t.after(() => service.close());
  await service.index();
  assert.equal(resolved, 1);
  const [edge] = calls(root);
  assert.ok(edge);
  assert.equal((await queryCallers(root, "remote")).length, 1);
  await rm(targetPath);
  await service.index();
  const fallback = await queryCallers(root, "remote");
  assert.deepEqual(
    fallback.map((match) => [match.name, match.totalEdges, match.edges]),
    [["caller", 0, []]],
  );
  assert.deepEqual(calls(root), []);
  const db = GraphDatabase.open(join(root, ".zvec-grep", "graph.sqlite"), true);
  try {
    assert.equal(
      db.connection
        .prepare("SELECT status FROM pending_refs WHERE ref_name = 'remote'")
        .get().status,
      "pending",
    );
  } finally {
    db.close();
  }
});

test("embedding failure removes previously indexed relationships and subsequent retry restores them", async (t) => {
  const root = await createTemporaryDirectory(t);
  const path = join(root, "failure.ts");
  const source =
    "export function helper() { return 1; }\nexport function caller() { return helper(); }\n";
  await writeFile(path, source);
  class Model extends FakeEmbeddingModel {
    fail = false;
    async doEmbed(contents) {
      if (this.fail) throw new Error("injected embedding failure");
      return super.doEmbed(contents);
    }
  }
  const model = new Model();
  const service = await createZvecGrep({ root, embeddingModel: model });
  t.after(() => service.close());
  await service.index();
  model.fail = true;
  await writeFile(path, source + "// updated\n");
  await assert.rejects(service.index());
  assert.deepEqual(await queryCallees(root, "caller"), []);
  model.fail = false;
  await service.index();
  assert.equal((await queryCallees(root, "caller"))[0].edges.length, 1);
});

test("same-name symbols in different files produce separate relationship groups", async (t) => {
  const root = await createTemporaryDirectory(t);
  for (const name of ["a", "b"]) {
    await writeFile(
      join(root, `${name}.ts`),
      `export function helper() { return 1; }\nexport function other() { return 2; }\nexport function ${name}Caller() { helper(); return other(); }\nexport function secondCaller() { return helper(); }\n`,
    );
  }
  const service = await createZvecGrep({
    root,
    embeddingModel: new FakeEmbeddingModel(),
  });
  t.after(() => service.close());
  await service.index();
  const matches = await queryCallers(root, "helper");
  assert.deepEqual(
    matches.map((match) => match.filePath),
    ["a.ts", "b.ts"],
  );
  assert.equal(new Set(matches.map((match) => match.filePath)).size, 2);
  assert.ok(
    matches.every(
      (match) =>
        match.edges.length === 2 &&
        match.edges.every((edge) => edge.symbol.filePath === match.filePath),
    ),
  );
  const fallback = await queryCallers(root, "HELPER");
  assert.equal(fallback.filter((match) => match.name === "helper").length, 2);
  assert.ok(fallback.some((match) => match.name === "aCaller"));
  const limited = await queryCallers(root, "helper", 1);
  assert.ok(limited.every((match) => match.totalEdges === 2));
  assert.deepEqual(
    limited,
    matches.map((match) => ({ ...match, edges: match.edges.slice(0, 1) })),
  );
  const outgoing = await queryCallees(root, "aCaller");
  assert.ok(outgoing[0].edges.some((edge) => edge.symbol.name === "helper"));
  assert.equal(outgoing[0].edges.length, 2);
  assert.deepEqual(outgoing[0].edges.map((edge) => edge.symbol.name).sort(), [
    "helper",
    "other",
  ]);
  assert.ok(outgoing[0].edges.every((edge) => edge.symbol.filePath === "a.ts"));
  assert.deepEqual(
    await queryCallees(root, "aCaller", 1),
    outgoing.map((match) => ({ ...match, edges: match.edges.slice(0, 1) })),
  );
  assert.deepEqual(await queryCallers(root, "nonexistent"), []);
  const noEdges = await queryCallers(root, "aCaller");
  assert.equal(noEdges.length, 1);
  assert.deepEqual(noEdges[0].edges, []);
  assert.equal(noEdges[0].totalEdges, 0);
});
