import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  collectFunctionCallSites,
  collectTypeInheritanceSites,
} from "../../dist/engine/extraction/index.js";
import { CppReceiverTypeInference } from "../../dist/engine/graph/cpp-receiver-inference.js";

test("C++ receiver inference scans source and matching indexed headers", () => {
  const root = mkdtempSync(join(tmpdir(), "zvec-cpp-receiver-"));
  try {
    const sourcePath = join(root, "src", "service.cc");
    const headerPath = join(root, "include", "service.h");
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "include"), { recursive: true });
    const sourceText =
      "void Service::check() { db_->IsClosed(); operators_[0]->Eval(); operators_.at(1)->Eval(); }\n";
    const headerText =
      "class Service { neug::NeugDB& db_; std::vector<std::unique_ptr<IOperator>> operators_; };\n";
    writeFileSync(sourcePath, sourceText);
    writeFileSync(headerPath, headerText);
    const files = [
      {
        id: "source",
        absolutePath: sourcePath,
        relativePath: "src/service.cc",
        rootPath: root,
        sizeBytes: sourceText.length,
        lastModifiedTime: 1,
        kind: "code",
        format: "cpp",
      },
      {
        id: "header",
        absolutePath: headerPath,
        relativePath: "include/service.h",
        rootPath: root,
        sizeBytes: headerText.length,
        lastModifiedTime: 1,
        kind: "code",
        format: "cpp",
      },
    ];
    const inference = new CppReceiverTypeInference(files);
    assert.equal(inference.infer("db_", 1, "source"), "NeugDB");
    assert.equal(inference.infer("operators_[0]", 1, "source"), "IOperator");
    assert.equal(inference.infer("operators_.at(1)", 1, "source"), "IOperator");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function source(format, relativePath, text) {
  return {
    kind: "text",
    text,
    file: {
      id: `${format}-file`,
      collectionId: "collection",
      absolutePath: `/repo/${relativePath}`,
      relativePath,
      rootPath: "/repo",
      sizeBytes: text.length,
      lastModifiedTime: 1,
      kind: "code",
      format,
    },
  };
}

for (const fixture of [
  [
    "typescript",
    "a.ts",
    "class A { run(){ this.helper(); } }",
    "this.helper",
    "owner",
    "this",
  ],
  [
    "python",
    "a.py",
    "class A:\n def run(self):\n  super().helper()\n",
    "super().helper",
    "super",
    "super",
  ],
  [
    "java",
    "A.java",
    "class A { void run(){ this.helper(); } }",
    "this.helper",
    "owner",
    "this",
  ],
  [
    "cpp",
    "a.cpp",
    "class A { int run(){ return this->helper(); } };",
    "this->helper",
    "owner",
    "this",
  ],
  [
    "rust",
    "a.rs",
    "impl A { fn run(&self){ self.helper(); } }",
    "self.helper",
    "owner",
    "self",
  ],
  [
    "go",
    "a.go",
    "package p\nfunc (a A) run(){ a.helper() }",
    "a.helper",
    "qualified",
    "a",
    { receiverType: "A", callArity: 0, candidateTypes: ["A"] },
  ],
  [
    "cpp",
    "static.cpp",
    "struct Base { static void helper(); }; void run(){ Base::helper(); }",
    "Base::helper",
    "qualified",
    "Base",
  ],
  [
    "rust",
    "static.rs",
    "struct Base; impl Base { fn helper() {} } fn run(){ Base::helper(); }",
    "Base::helper",
    "qualified",
    "Base",
  ],
]) {
  test(`${fixture[0]} call target IR`, async () => {
    const calls = await collectFunctionCallSites(
      source(fixture[0], fixture[1], fixture[2]),
    );
    const site = calls
      .flatMap((owner) => owner.sites)
      .find((item) => item.name === fixture[3]);
    assert.ok(site);
    assert.deepEqual(site.target, {
      raw: fixture[3],
      member: "helper",
      receiver: { kind: fixture[4], name: fixture[5] },
      ...(fixture[6] ? { hints: fixture[6] } : {}),
    });
  });
}

test("nested entity parameters do not overwrite outer receiver types", async () => {
  const calls = await collectFunctionCallSites(
    source(
      "java",
      "Nested.java",
      `class Use {
        void invoke(Runner value) {
          Object nested = new Object() { void nested(Other value) {} };
          value.run();
        }
      }`,
    ),
  );
  const invoke = calls.find((owner) =>
    owner.sites.some((site) => site.name === "value.run"),
  );
  const site = invoke?.sites.find((item) => item.name === "value.run");
  assert.ok(site);
  assert.equal(site.target.hints?.receiverType, "Runner");
});

test("receiver type hints follow block scope and call position", async () => {
  const calls = await collectFunctionCallSites(
    source(
      "typescript",
      "Scopes.ts",
      `function invoke() {
        {
          const value: Runner = makeRunner();
          value.run();
        }
        {
          const value: Other = makeOther();
          value.run();
        }
      }`,
    ),
  );
  const runSites = calls
    .flatMap((owner) => owner.sites)
    .filter((site) => site.name === "value.run");
  assert.equal(runSites.length, 2);
  assert.deepEqual(
    runSites.map((site) => site.target.hints?.receiverType),
    ["Runner", "Other"],
  );
});

test("receiver facts infer arrays, map values, fields, getters, and owner return types", async () => {
  const calls = await collectFunctionCallSites(
    source(
      "typescript",
      "Inference.ts",
      `class Use {
        private readonly database: SqliteGraphDatabase;
        private get db(): DatabaseSync { return this.database.db; }
        private affectedResolvedEdgeIds(): string[] { return []; }
        invoke() {
          const typed: GraphEdge[] = [];
          typed.push(edge);
          const inferred = [];
          inferred.push(edge);
          const buckets = new Map<string, GraphEdge[]>();
          const bucket = buckets.get("calls")!;
          bucket.push(edge);
          const affected = this.affectedResolvedEdgeIds();
          affected.push("id");
          this.database.all("select 1");
          this.db.exec("BEGIN");
          const insert = this.db.prepare("insert");
          insert.run("id");
          this.database.db.prepare("select").all().map(row => row);
        }
      }`,
    ),
  );
  const sites = calls.flatMap((owner) => owner.sites);
  const receiverTypes = new Map(
    sites.map((site) => [site.name, site.target.hints?.receiverType]),
  );
  assert.equal(receiverTypes.get("typed.push"), "Array");
  assert.equal(receiverTypes.get("inferred.push"), "Array");
  assert.equal(receiverTypes.get("bucket.push"), "Array");
  assert.equal(receiverTypes.get("affected.push"), "Array");
  assert.equal(receiverTypes.get("this.database.all"), "SqliteGraphDatabase");
  assert.equal(receiverTypes.get("this.db.exec"), "DatabaseSync");
  assert.equal(receiverTypes.get("insert.run"), "StatementSync");
  const mapSite = sites.find((site) => site.name.endsWith(".map"));
  assert.equal(mapSite?.target.hints?.receiverType, "Array");
});

test("C++ reference parameters feed receiver type hints", async () => {
  const calls = await collectFunctionCallSites(
    source(
      "cpp",
      "wal.cc",
      `void ingest(const IWalParser& parser, PropertyGraph& graph,
                   std::vector<int>& allocators) {
         parser.last_ts();
         graph.Compact();
         allocators.size();
       }`,
    ),
  );
  const receiverTypes = new Map(
    calls
      .flatMap((owner) => owner.sites)
      .map((site) => [site.name, site.target.hints?.receiverType]),
  );
  assert.equal(receiverTypes.get("parser.last_ts"), "IWalParser");
  assert.equal(receiverTypes.get("graph.Compact"), "PropertyGraph");
  assert.equal(receiverTypes.get("allocators.size"), "std::vector");
});

for (const fixture of [
  {
    name: "local variable type",
    text: "function invoke() { const value: Runner = make(); value.run(); }",
    raw: "value.run",
  },
  {
    name: "field type",
    text: "class Use { value: Runner; invoke() { this.value.run(); } }",
    raw: "this.value.run",
  },
]) {
  test(`TypeScript ${fixture.name} feeds receiver type hints`, async () => {
    const calls = await collectFunctionCallSites(
      source("typescript", "facts.ts", fixture.text),
    );
    const site = calls
      .flatMap((owner) => owner.sites)
      .find((item) => item.name === fixture.raw);
    assert.ok(site);
    assert.equal(site.target.hints?.receiverType, "Runner");
  });
}

test("inheritance target IR is structured", async () => {
  const sites = await collectTypeInheritanceSites(
    source("typescript", "types.ts", "class Child extends ns.Base {}"),
  );
  assert.deepEqual(sites[0].sites[0].target, {
    raw: "ns.Base",
    member: "Base",
    receiver: { kind: "qualified", name: "ns" },
  });
});

for (const fixture of [
  {
    name: "Go interface constraint",
    format: "go",
    path: "generic.go",
    text: "package p\nfunc invoke[T Runner](value T) { value.Run() }",
    raw: "value.Run",
    hints: {
      receiverType: "T",
      callArity: 0,
      candidateTypes: ["T", "Runner"],
      genericBounds: ["Runner"],
      dispatch: "interface",
    },
  },
  {
    name: "Rust trait bound",
    format: "rust",
    path: "generic.rs",
    text: "fn invoke<T: Runner>(value: T) { value.run(); }",
    raw: "value.run",
    hints: {
      receiverType: "T",
      callArity: 0,
      candidateTypes: ["T", "Runner"],
      genericBounds: ["Runner"],
      dispatch: "trait",
    },
  },
  {
    name: "C++ constrained template",
    format: "cpp",
    path: "generic.cpp",
    text: "template<Runner T> void invoke(T value) { value.run(); }",
    raw: "value.run",
    hints: {
      receiverType: "T",
      callArity: 0,
      candidateTypes: ["T", "Runner"],
      genericBounds: ["Runner"],
      dispatch: "virtual",
    },
  },
  {
    name: "Java interface parameter",
    format: "java",
    path: "Generic.java",
    text: "class Generic { void invoke(Runner value) { value.run(); } }",
    raw: "value.run",
    hints: {
      receiverType: "Runner",
      callArity: 0,
      candidateTypes: ["Runner"],
      dispatch: "virtual",
    },
  },
]) {
  test(`${fixture.name} adds semantic resolution hints`, async () => {
    const calls = await collectFunctionCallSites(
      source(fixture.format, fixture.path, fixture.text),
    );
    const site = calls
      .flatMap((owner) => owner.sites)
      .find((item) => item.name === fixture.raw);
    assert.ok(site);
    assert.deepEqual(site.target.hints, fixture.hints);
  });
}
