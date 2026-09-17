import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ZVecCollectionSchema,
  ZVecCreateAndOpen,
  ZVecDataType,
  ZVecIndexType,
} from "@zvec/zvec";
import { createWorkspaceIndexStorage } from "../../dist/engine/storage/index.js";
import {
  queryFileMetadataDocs,
  querySymbolDocs,
} from "../../dist/engine/storage/zvec.js";

function doc(id) {
  return {
    id,
    fields: { file_id: id },
    vectors: {},
    score: 0,
  };
}

test("file metadata queries partition beyond zvec's top-k limit", () => {
  const documents = [
    doc(`${"0".repeat(64)}`),
    doc(`0${"f".repeat(63)}`),
    doc(`1${"0".repeat(63)}`),
    doc(`a${"5".repeat(63)}`),
    doc(`f${"f".repeat(63)}`),
    doc(`b${"0".repeat(63)}`),
  ];
  const queries = [];
  const collection = {
    stats: { docCount: documents.length, indexCompleteness: {} },
    querySync(query) {
      queries.push(query);
      const lower = /file_id >= '([^']+)'/.exec(query.filter)?.[1];
      const upper = /file_id < '([^']+)'/.exec(query.filter)?.[1];
      return documents
        .filter((item) => lower === undefined || item.id >= lower)
        .filter((item) => upper === undefined || item.id < upper)
        .slice(0, query.topk);
    },
  };

  const result = queryFileMetadataDocs(collection, 2);

  assert.deepEqual(
    result.map((item) => item.id).sort(),
    documents.map((item) => item.id).sort(),
  );
  assert.ok(queries.length > 16);
  assert.ok(queries.every((query) => query.topk <= 2));
});

test("file metadata queries use one request below zvec's top-k limit", () => {
  const queries = [];
  const collection = {
    stats: { docCount: 2, indexCompleteness: {} },
    querySync(query) {
      queries.push(query);
      return [doc(`0${"0".repeat(63)}`), doc(`f${"f".repeat(63)}`)];
    },
  };

  const result = queryFileMetadataDocs(collection, 2);

  assert.equal(result.length, 2);
  assert.equal(queries.length, 1);
  assert.equal(queries[0].topk, 2);
});

test("file metadata partitions use zvec string range semantics", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "zvec-grep-file-meta-range-"));
  const collection = ZVecCreateAndOpen(
    join(parent, "collection"),
    new ZVecCollectionSchema({
      name: "file_metadata_range",
      fields: [{ name: "file_id", dataType: ZVecDataType.STRING }],
    }),
  );
  t.after(async () => {
    collection.closeSync();
    await rm(parent, { recursive: true, force: true });
  });

  const documents = [
    doc(`${"0".repeat(64)}`),
    doc(`0${"f".repeat(63)}`),
    doc(`1${"0".repeat(63)}`),
    doc(`a${"5".repeat(63)}`),
    doc(`f${"f".repeat(63)}`),
    doc(`b${"0".repeat(63)}`),
  ];
  collection.insertSync(
    documents.map((item) => ({ id: item.id, fields: item.fields })),
  );

  const result = queryFileMetadataDocs(collection, 2);

  assert.deepEqual(
    result.map((item) => item.id).sort(),
    documents.map((item) => item.id).sort(),
  );
});

test("file metadata supports one batched path-prefix lookup", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "zvec-grep-file-prefixes-"));
  const root = join(parent, "repo");
  const storage = createWorkspaceIndexStorage({
    storagePath: join(parent, "storage"),
    readOnly: false,
    embedding: {
      provider: "local",
      model: "test",
      dimension: 2,
      metric: "cosine",
    },
  });
  t.after(async () => {
    storage.close();
    await rm(parent, { recursive: true, force: true });
  });
  const files = [
    fileInfo("a", root, "src/a.ts"),
    fileInfo("b", root, "src/nested/b.ts"),
    fileInfo("c", root, "docs/c.md"),
  ];
  for (const file of files) storage.replaceFile(file, []);

  const matches = storage.listFilesByPathPrefixes([
    join(root, "src"),
    join(root, "docs", "c.md"),
  ]);

  assert.deepEqual(matches.map((file) => file.relativePath).sort(), [
    "docs/c.md",
    "src/a.ts",
    "src/nested/b.ts",
  ]);
});

function fileInfo(id, root, relativePath) {
  return {
    id: id.repeat(64),
    absolutePath: join(root, relativePath),
    relativePath,
    rootPath: root,
    sizeBytes: 1,
    lastModifiedTime: 1,
    kind: relativePath.endsWith(".md") ? "markdown" : "code",
    format: relativePath.endsWith(".md") ? "markdown" : "typescript",
  };
}

test("indexed symbol queries cap candidates in one query and preserve exact filters", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "zvec-symbol-candidates-"));
  const collection = ZVecCreateAndOpen(
    join(parent, "data"),
    new ZVecCollectionSchema({
      name: "symbol_candidates",
      fields: [
        {
          name: "symbol_name",
          dataType: ZVecDataType.STRING,
          indexParams: { indexType: ZVecIndexType.INVERT },
        },
        { name: "symbol_scope", dataType: ZVecDataType.STRING },
        {
          name: "file_id",
          dataType: ZVecDataType.STRING,
          indexParams: { indexType: ZVecIndexType.INVERT },
        },
        { name: "fragment_index", dataType: ZVecDataType.INT32 },
        { name: "group", dataType: ZVecDataType.STRING, nullable: true },
      ],
    }),
  );
  t.after(async () => {
    collection.closeSync();
    await rm(parent, { recursive: true, force: true });
  });
  const name = "helper'\\name";
  const docs = ["a", "b", "z"].flatMap((file) =>
    Array.from({ length: file === "b" ? 107 : 2 }, (_, index) => ({
      id: `${file}-${index}`,
      fields: {
        file_id: file,
        fragment_index: index,
        symbol_name: name,
        symbol_scope: index % 2 ? "Class" : "Other",
      },
    })),
  );
  docs.push({
    id: "unrelated",
    fields: {
      file_id: "b",
      fragment_index: 8,
      symbol_name: "other",
      symbol_scope: "Class",
    },
  });
  for (const status of collection.insertSync(docs))
    assert.equal(status.ok, true);
  const queries = [];
  const traced = {
    querySync(query) {
      queries.push(query);
      return collection.querySync(query);
    },
  };
  const candidates = querySymbolDocs(traced, name);
  assert.equal(candidates.length, 100);
  assert.equal(queries.length, 1);
  assert.ok(candidates.every((doc) => doc.id !== "unrelated"));
  assert.deepEqual(
    querySymbolDocs(traced, name, "Class")
      .map((doc) => doc.id)
      .sort(),
    docs
      .filter(
        (doc) =>
          doc.fields.symbol_name === name &&
          doc.fields.symbol_scope === "Class",
      )
      .map((doc) => doc.id)
      .sort(),
  );
  assert.deepEqual(querySymbolDocs(traced, "' OR symbol_name != '"), []);
  for (const unsupported of ["trailing\\", "slash\\'quote", 'slash\\"quote']) {
    assert.throws(
      () => querySymbolDocs(traced, unsupported),
      /Cannot represent this string in a zvec filter/,
    );
  }
  assert.ok(
    queries.every(
      (query) =>
        query.filter.startsWith("symbol_name = ") &&
        query.topk === 100 &&
        query.includeVector === false,
    ),
  );
  assert.equal(queries.length, 3);
});

test("findSymbols returns public entities once and filters exact names and scopes", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "zvec-symbol-storage-"));
  const storage = createWorkspaceIndexStorage({
    storagePath: join(parent, "storage"),
    readOnly: false,
    embedding: {
      provider: "local",
      model: "test",
      dimension: 2,
      metric: "cosine",
    },
  });
  t.after(async () => {
    storage.close();
    await rm(parent, { recursive: true, force: true });
  });
  const name = "helper'\\name";
  function fragment(file, id, scope, group, symbolName = name) {
    return {
      fragment: {
        id,
        fileId: file.id,
        group,
        range: {
          kind: "text",
          startLine: 1,
          endLine: 2,
          startOffset: 0,
          endOffset: 10,
        },
        content: { kind: "text", text: "helper content" },
        metadata: {
          kind: "code",
          symbolName,
          symbolType: "function",
          scope,
          modifiers: [],
          nodeType: "function_declaration",
          signature: null,
          doc: null,
          language: "typescript",
        },
      },
      vector: [1, 0],
    };
  }
  const a = fileInfo("a", parent, "a.ts");
  const b = fileInfo("b", parent, "b.ts");
  storage.replaceFile(a, [
    fragment(a, "major", "Class", "major"),
    ...Array.from({ length: 5 }, (_, i) =>
      fragment(a, `chunk-${i}`, "Class", "major"),
    ),
    fragment(a, "mention", null, undefined, "other"),
  ]);
  storage.replaceFile(b, [fragment(b, "standalone", "Other")]);
  await storage.finalizeWrites();
  assert.deepEqual(
    storage
      .findSymbols(name)
      .map((row) => row.entity.id)
      .sort(),
    ["major", "standalone"],
  );
  assert.deepEqual(
    storage.findSymbols(name, "Class").map((row) => row.entity.id),
    ["major"],
  );
  assert.deepEqual(storage.findSymbols(name, "missing"), []);
  assert.deepEqual(storage.findSymbols("HELPER"), []);
  assert.deepEqual(storage.findSymbols("HELPER", "Class"), []);
  const originalFts = storage.searchFts;
  storage.searchFts = () => {
    throw new Error("Exact matches must not invoke FTS");
  };
  assert.equal(storage.findSymbols(name).length, 2);
  storage.searchFts = originalFts;
  assert.deepEqual(storage.findSymbols("zznonexistenttoken"), []);
  storage.markFileFailed(a, "failed update");
  assert.deepEqual(
    storage.findSymbols(name).map((row) => row.entity.id),
    ["standalone"],
  );
});
