import assert from "node:assert/strict";
import test from "node:test";
import { CodeExtractor } from "../../dist/engine/extraction/code/extractor.js";
import {
  FilePathIndex,
  SqliteGraphStorage,
  collectImportSpecs,
  extractFileGraph,
  isExternalImportSpec,
  resolveImportPath,
} from "../../dist/engine/graph/index.js";

function codeFile(id, relativePath, format = "typescript") {
  return {
    id,
    collectionId: "collection-1",
    absolutePath: `/repo/${relativePath}`,
    relativePath,
    rootPath: "/repo",
    sizeBytes: 100,
    lastModifiedTime: 1,
    kind: "code",
    format,
  };
}

test("isExternalImportSpec drops npm / node / stdlib", () => {
  assert.equal(isExternalImportSpec("lodash", "typescript"), true);
  assert.equal(isExternalImportSpec("node:fs", "javascript"), true);
  assert.equal(isExternalImportSpec("./utils", "typescript"), false);
  assert.equal(isExternalImportSpec("os", "python"), true);
  assert.equal(isExternalImportSpec(".utils", "python"), false);
  assert.equal(isExternalImportSpec("stdio.h", "c"), true);
});

test("resolveImportPath resolves JS/TS relative + extension table", () => {
  const files = [
    codeFile("a", "src/a.ts"),
    codeFile("b", "src/utils.ts"),
    codeFile("c", "src/lib/index.ts"),
  ];
  const index = new FilePathIndex(files);

  assert.deepEqual(resolveImportPath("./utils", "a", "typescript", index), {
    status: "resolved",
    fileId: "b",
    absolutePath: "/repo/src/utils.ts",
  });
  assert.deepEqual(resolveImportPath("./lib", "a", "typescript", index), {
    status: "resolved",
    fileId: "c",
    absolutePath: "/repo/src/lib/index.ts",
  });
  assert.equal(
    resolveImportPath("lodash", "a", "typescript", index).status,
    "external",
  );
  assert.equal(
    resolveImportPath("./missing", "a", "typescript", index).status,
    "failed",
  );
});

test("resolveImportPath resolves python dotted-relative", () => {
  const files = [
    codeFile("pkg", "pkg/mod.py", "python"),
    codeFile("util", "pkg/util.py", "python"),
    codeFile("sib", "sib.py", "python"),
  ];
  const index = new FilePathIndex(files);
  assert.equal(
    resolveImportPath(".util", "pkg", "python", index).fileId,
    "util",
  );
  assert.equal(
    resolveImportPath("..sib", "pkg", "python", index).fileId,
    "sib",
  );
});

test("collectImportSpecs extracts relative JS imports and drops lodash", async () => {
  const file = codeFile("f1", "src/app.ts");
  const text = `
import { formatDate } from "./utils";
import map from "lodash";
export { helper } from "./helper";
`;
  const specs = await collectImportSpecs({ kind: "text", text, file });
  assert.deepEqual(specs.map((s) => s.spec).sort(), ["./helper", "./utils"]);
});

test("extractFileGraph + resolvePending builds IMPORTS edges", async () => {
  const a = codeFile("file-a", "src/a.ts");
  const b = codeFile("file-b", "src/utils.ts");
  const textA = `
import { formatDate } from "./utils";
export function run() {
  return formatDate();
}
`;
  const textB = `
export function formatDate() {
  return "ok";
}
`;

  const fragmentsA = await new CodeExtractor().extract({
    kind: "text",
    text: textA,
    file: a,
  });
  const fragmentsB = await new CodeExtractor().extract({
    kind: "text",
    text: textB,
    file: b,
  });
  const graphA = await extractFileGraph(
    { kind: "text", text: textA, file: a },
    fragmentsA,
  );
  const graphB = await extractFileGraph(
    { kind: "text", text: textB, file: b },
    fragmentsB,
  );

  assert.ok(
    graphA.refs.some(
      (r) =>
        r.ref_kind === "import" &&
        r.ref_name === "./utils" &&
        r.owner_is_file === true &&
        r.owner === a.id,
    ),
  );

  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(a.id, graphA.nodes, graphA.edges, graphA.refs);
  graph.upsertFileGraph(b.id, graphB.nodes, graphB.edges, graphB.refs);
  await graph.resolvePending({ files: [a, b] });

  const neighbors = graph.expandFileNeighbors([a.id], 10);
  assert.deepEqual(
    neighbors.map((n) => n.id),
    [b.id],
  );
  assert.deepEqual(graph.fileScope(a.id, 1, 10), [b.id]);

  // Imported file disambiguates call target when multiple formatDate exist.
  const c = codeFile("file-c", "src/other.ts");
  graph.upsertFileGraph(
    c.id,
    [
      {
        id: "sym-other",
        kind: "function",
        is_exported: true,
        name: "formatDate",
      },
    ],
    [],
    [],
  );
  // Re-upsert A so pending call to formatDate can resolve with import preference.
  graph.upsertFileGraph(a.id, graphA.nodes, graphA.edges, graphA.refs);
  await graph.resolvePending({ files: [a, b, c] });

  const run = graphA.nodes.find((n) => n.name === "run");
  const fmt = graphB.nodes.find((n) => n.name === "formatDate");
  assert.ok(run && fmt);
  assert.deepEqual(
    graph.callees(run.id, 1, 10).map((s) => s.id),
    [fmt.id],
  );
  graph.close();
});
