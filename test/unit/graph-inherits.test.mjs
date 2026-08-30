import assert from "node:assert/strict";
import test from "node:test";
import { CodeExtractor } from "../../dist/engine/extraction/code/extractor.js";
import {
  SqliteGraphStorage,
  extractFileGraph,
} from "../../dist/engine/graph/index.js";
import {
  codeFile as makeCodeFile,
  extractGraph,
  resolveGraph,
} from "../helpers/graph.mjs";

const codeFile = (id, relativePath, format = "typescript") =>
  makeCodeFile(relativePath, { id, format });

test("extractFileGraph builds local INHERITS for TS class/interface", async () => {
  const file = codeFile("f1", "types.ts");
  const text = `
export class Base {}
export interface IFace {}
export class Child extends Base implements IFace {}
export interface IChild extends IFace {}
`;
  const graphInput = await extractGraph(file, text);

  const inherits = graphInput.edges.filter((e) => e.kind === "INHERITS");
  assert.equal(inherits.length, 3);
  assert.ok(inherits.some((e) => e.rel === "extends" && e.ref_name === "Base"));
  assert.ok(
    inherits.some((e) => e.rel === "implements" && e.ref_name === "IFace"),
  );
  assert.ok(
    inherits.some(
      (e) =>
        e.rel === "extends" &&
        e.ref_name === "IFace" &&
        e.src !== inherits.find((x) => x.rel === "implements")?.src,
    ),
  );

  const graph = await resolveGraph(file, graphInput);

  const child = graphInput.nodes.find((n) => n.name === "Child");
  const base = graphInput.nodes.find((n) => n.name === "Base");
  const iface = graphInput.nodes.find((n) => n.name === "IFace");
  assert.ok(child && base && iface);
  const bases = graph.hierarchy(child.id, "bases", 10).map((s) => s.id);
  assert.ok(bases.includes(base.id));
  assert.ok(bases.includes(iface.id));
  assert.deepEqual(
    graph.hierarchy(base.id, "derived", 10).map((s) => s.id),
    [child.id],
  );
  graph.close();
});

test("extractFileGraph resolves cross-file extends after second file indexed", async () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  const a = codeFile("file-a", "child.ts");
  const b = codeFile("file-b", "base.ts");
  const textA = `export class Child extends Base {}`;
  const textB = `export class Base {}`;

  const fragsA = await new CodeExtractor().extract({
    kind: "text",
    text: textA,
    file: a,
  });
  const fragsB = await new CodeExtractor().extract({
    kind: "text",
    text: textB,
    file: b,
  });
  const gA = await extractFileGraph(
    { kind: "text", text: textA, file: a },
    fragsA,
  );
  const gB = await extractFileGraph(
    { kind: "text", text: textB, file: b },
    fragsB,
  );

  assert.ok(
    gA.refs.some((r) => r.ref_kind === "extends" && r.ref_name === "Base"),
  );

  graph.upsertFileGraph(a.id, gA.nodes, gA.edges, gA.refs);
  graph.upsertFileGraph(b.id, gB.nodes, gB.edges, gB.refs);
  await graph.resolvePending();

  const child = gA.nodes.find((n) => n.name === "Child");
  const base = gB.nodes.find((n) => n.name === "Base");
  assert.ok(child && base);
  assert.deepEqual(
    graph.hierarchy(child.id, "bases", 10).map((s) => s.id),
    [base.id],
  );
  graph.close();
});

test("import aliases outrank same-file names in inheritance", async () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  const baseFile = codeFile("base-file", "base.ts");
  const childFile = codeFile("child-file", "child.ts");
  const baseInput = await extractGraph(
    baseFile,
    "export interface Context { invoke(): void }",
  );
  const childInput = await extractGraph(
    childFile,
    'import type { Context as BaseContext } from "./base";\ninterface Context extends BaseContext {}',
  );

  graph.upsertFileGraph(
    baseFile.id,
    baseInput.nodes,
    baseInput.edges,
    baseInput.refs,
    baseFile,
  );
  graph.upsertFileGraph(
    childFile.id,
    childInput.nodes,
    childInput.edges,
    childInput.refs,
    childFile,
  );
  await graph.resolvePending({ files: [baseFile, childFile] });

  const base = baseInput.nodes.find((node) => node.name === "Context");
  const child = childInput.nodes.find((node) => node.name === "Context");
  assert.ok(base && child);
  assert.deepEqual(
    graph.hierarchy(child.id, "bases", 10).map((symbol) => symbol.id),
    [base.id],
  );
  graph.close();
});

test("extractFileGraph handles C++ export macros between class keyword and name", async () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  const baseFile = codeFile("cpp-base", "catalog.h", "cpp");
  const childFile = codeFile("cpp-child", "g_catalog.h", "cpp");
  const baseSource = {
    kind: "text",
    file: baseFile,
    text: "class NEUG_API Catalog { public: virtual ~Catalog() = default; };",
  };
  const implementationFile = codeFile(
    "cpp-base-implementation",
    "catalog.cpp",
    "cpp",
  );
  const implementationSource = {
    kind: "text",
    file: implementationFile,
    text: "Catalog::Catalog() {}",
  };
  const childSource = {
    kind: "text",
    file: childFile,
    text: "class GCatalog : public Catalog { public: GCatalog(); };",
  };
  const baseInput = await extractFileGraph(
    baseSource,
    await new CodeExtractor().extract(baseSource),
  );
  const childInput = await extractFileGraph(
    childSource,
    await new CodeExtractor().extract(childSource),
  );
  const implementationInput = await extractFileGraph(
    implementationSource,
    await new CodeExtractor().extract(implementationSource),
  );
  const base = baseInput.nodes.find(
    (node) => node.name === "Catalog" && node.kind === "class",
  );
  const child = childInput.nodes.find((node) => node.name === "GCatalog");
  assert.ok(base && child);
  graph.upsertFileGraph(
    baseFile.id,
    baseInput.nodes,
    baseInput.edges,
    baseInput.refs,
  );
  graph.upsertFileGraph(
    implementationFile.id,
    implementationInput.nodes,
    implementationInput.edges,
    implementationInput.refs,
  );
  graph.upsertFileGraph(
    childFile.id,
    childInput.nodes,
    childInput.edges,
    childInput.refs,
  );
  await graph.resolvePending();
  assert.deepEqual(
    graph.hierarchy(child.id, "bases", 10).map((ref) => ref.id),
    [base.id],
  );
  graph.close();
});

test("cross-file C++ inheritance resolves a pure-virtual abstract base", async () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  const baseFile = codeFile("cpp-abstract-base", "runner.h", "cpp");
  const childFile = codeFile("cpp-abstract-child", "worker.h", "cpp");
  const baseSource = {
    kind: "text",
    file: baseFile,
    text: "class Runner { public: virtual const char* run() = 0; };",
  };
  const childSource = {
    kind: "text",
    file: childFile,
    text: '#include "runner.h"\nclass Worker : public Runner { public: const char* run() override { return "ok"; } };',
  };
  const baseInput = await extractFileGraph(
    baseSource,
    await new CodeExtractor().extract(baseSource),
  );
  const childInput = await extractFileGraph(
    childSource,
    await new CodeExtractor().extract(childSource),
  );
  const base = baseInput.nodes.find((node) => node.name === "Runner");
  const child = childInput.nodes.find((node) => node.name === "Worker");
  assert.equal(base?.kind, "abstract_class");
  assert.ok(child);
  graph.upsertFileGraph(
    baseFile.id,
    baseInput.nodes,
    baseInput.edges,
    baseInput.refs,
  );
  graph.upsertFileGraph(
    childFile.id,
    childInput.nodes,
    childInput.edges,
    childInput.refs,
  );
  await graph.resolvePending({ files: [baseFile, childFile] });
  assert.deepEqual(
    graph.hierarchy(child.id, "bases", 10).map((ref) => ref.id),
    [base.id],
  );
  graph.close();
});

test("extractFileGraph collects python bases and drops object", async () => {
  const file = codeFile("py", "mod.py", "python");
  const text = `
class Base:
    pass

class Child(Base, object):
    pass
`;
  const graphInput = await extractGraph(file, text);
  const inherits = graphInput.edges.filter((e) => e.kind === "INHERITS");
  assert.equal(inherits.length, 1);
  assert.equal(inherits[0].ref_name, "Base");
  assert.equal(
    graphInput.refs.some((r) => r.ref_name === "object"),
    false,
  );
});

test("extractFileGraph drops JS builtin base Object", async () => {
  const file = codeFile("js", "a.ts");
  const text = `export class A extends Object {}`;
  const graphInput = await extractGraph(file, text);
  assert.equal(graphInput.edges.filter((e) => e.kind === "INHERITS").length, 0);
  assert.equal(
    graphInput.refs.some((r) => r.ref_name === "Object"),
    false,
  );
});
