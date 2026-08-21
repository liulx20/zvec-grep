import assert from "node:assert/strict";
import test from "node:test";
import { CodeExtractor } from "../../dist/engine/extraction/code/extractor.js";
import {
  SqliteGraphStorage,
  extractFileGraph,
} from "../../dist/engine/graph/index.js";

function codeFile(relativePath = "mod.ts") {
  return {
    id: "file-1",
    collectionId: "collection-1",
    absolutePath: `/repo/${relativePath}`,
    relativePath,
    rootPath: "/repo",
    sizeBytes: 100,
    lastModifiedTime: 1,
    kind: "code",
    format: "typescript",
  };
}

test("extractFileGraph builds local CALLS and pending cross-file refs", async () => {
  const file = codeFile("local.ts");
  const text = `
export function helper() {
  return 1;
}

export function run() {
  helper();
  helper();
  missingElsewhere();
  console.log("x");
}
`;
  const source = { kind: "text", text, file };
  const fragments = await new CodeExtractor().extract(source);
  const graphInput = await extractFileGraph(source, fragments);

  assert.ok(graphInput.nodes.some((n) => n.name === "run"));
  assert.ok(graphInput.nodes.some((n) => n.name === "helper"));

  const localCalls = graphInput.edges.filter((e) => e.kind === "CALLS");
  assert.equal(localCalls.length, 1);
  assert.equal(localCalls[0].count, 2);
  assert.equal(localCalls[0].rel, "call");

  assert.ok(
    graphInput.refs.some((r) => r.ref_name === "missingElsewhere"),
    "cross-file call should be pending",
  );
  assert.equal(
    graphInput.refs.some(
      (r) => r.ref_name === "console" || r.ref_name === "console.log",
    ),
    false,
    "builtin console should be dropped early",
  );

  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    file.id,
    graphInput.nodes,
    graphInput.edges,
    graphInput.refs,
  );
  await graph.resolvePending();

  const run = graphInput.nodes.find((n) => n.name === "run");
  const helper = graphInput.nodes.find((n) => n.name === "helper");
  assert.ok(run && helper);
  assert.deepEqual(
    graph.callees(run.id, 1, 10).map((s) => s.id),
    [helper.id],
  );
  assert.equal(graph.callees(run.id, 1, 10)[0].count, 2);
  graph.close();
});

test("language builtins do not hide a locally defined symbol", async () => {
  const file = codeFile("local-builtin-name.ts");
  const source = {
    kind: "text",
    file,
    text: `
export function map() { return 1; }
export function run() { return map(); }
`,
  };
  const fragments = await new CodeExtractor().extract(source);
  const graphInput = await extractFileGraph(source, fragments);
  const map = graphInput.nodes.find((node) => node.name === "map");
  const run = graphInput.nodes.find((node) => node.name === "run");
  assert.ok(map && run);
  assert.ok(
    graphInput.edges.some(
      (edge) =>
        edge.kind === "CALLS" && edge.src === run.id && edge.dst === map.id,
    ),
  );
});

test("qualified builtin calls do not fall back to a local bare name", async () => {
  const file = codeFile("qualified-builtin.ts");
  const source = {
    kind: "text",
    file,
    text: `
export function log() { return 1; }
export function run() { console.log("external"); }
`,
  };
  const fragments = await new CodeExtractor().extract(source);
  const graphInput = await extractFileGraph(source, fragments);
  const log = graphInput.nodes.find((node) => node.name === "log");
  const run = graphInput.nodes.find((node) => node.name === "run");
  assert.ok(log && run);
  assert.equal(
    graphInput.edges.some(
      (edge) =>
        edge.kind === "CALLS" && edge.src === run.id && edge.dst === log.id,
    ),
    false,
  );
  assert.equal(
    graphInput.refs.some((ref) => ref.ref_name === "console.log"),
    false,
  );
});

for (const fixture of [
  {
    name: "TypeScript this receiver",
    path: "this-call.ts",
    format: "typescript",
    text: `class Demo {
  helper() { return 1; }
  run() { return this.helper(); }
}`,
  },
  {
    name: "Python self receiver",
    path: "self_call.py",
    format: "python",
    text: `class Demo:
    def helper(self):
        return 1
    def run(self):
        return self.helper()
`,
  },
]) {
  test(`${fixture.name} resolves to the local method`, async () => {
    const file = { ...codeFile(fixture.path), format: fixture.format };
    const source = { kind: "text", file, text: fixture.text };
    const fragments = await new CodeExtractor().extract(source);
    const graphInput = await extractFileGraph(source, fragments);
    const helper = graphInput.nodes.find((node) => node.name === "helper");
    const run = graphInput.nodes.find((node) => node.name === "run");
    assert.ok(helper && run);
    assert.ok(
      graphInput.edges.some(
        (edge) =>
          edge.kind === "CALLS" &&
          edge.src === run.id &&
          edge.dst === helper.id,
      ),
    );
  });
}

test("language-aware pending refs resolve cross-file builtin names", async () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  const callerFile = { ...codeFile("caller.ts"), id: "caller-file" };
  const targetFile = { ...codeFile("target.ts"), id: "target-file" };
  const callerSource = {
    kind: "text",
    file: callerFile,
    text: `export function run() { return map(); }`,
  };
  const targetSource = {
    kind: "text",
    file: targetFile,
    text: `export function map() { return 1; }`,
  };
  const callerInput = await extractFileGraph(
    callerSource,
    await new CodeExtractor().extract(callerSource),
  );
  const targetInput = await extractFileGraph(
    targetSource,
    await new CodeExtractor().extract(targetSource),
  );
  graph.upsertFileGraph(
    callerFile.id,
    callerInput.nodes,
    callerInput.edges,
    callerInput.refs,
  );
  graph.upsertFileGraph(
    targetFile.id,
    targetInput.nodes,
    targetInput.edges,
    targetInput.refs,
  );
  await graph.resolvePending();

  const run = callerInput.nodes.find((node) => node.name === "run");
  const map = targetInput.nodes.find((node) => node.name === "map");
  assert.ok(run && map);
  assert.deepEqual(
    graph.callees(run.id, 1, 10).map((item) => item.id),
    [map.id],
  );
  graph.close();
});

test("extractFileGraph resolves cross-file calls after second file indexed", async () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });

  const aFile = {
    ...codeFile("a.ts"),
    id: "file-a",
    absolutePath: "/repo/a.ts",
    relativePath: "a.ts",
  };
  const bFile = {
    ...codeFile("b.ts"),
    id: "file-b",
    absolutePath: "/repo/b.ts",
    relativePath: "b.ts",
  };

  const aSource = {
    kind: "text",
    file: aFile,
    text: `export function caller() { target(); target(); }\n`,
  };
  const bSource = {
    kind: "text",
    file: bFile,
    text: `export function target() { return 1; }\n`,
  };

  const aFrags = await new CodeExtractor().extract(aSource);
  const bFrags = await new CodeExtractor().extract(bSource);
  const aGraph = await extractFileGraph(aSource, aFrags);
  const bGraph = await extractFileGraph(bSource, bFrags);

  assert.equal(aGraph.refs.filter((r) => r.ref_name === "target").length, 2);

  graph.upsertFileGraph(aFile.id, aGraph.nodes, aGraph.edges, aGraph.refs);
  graph.upsertFileGraph(bFile.id, bGraph.nodes, bGraph.edges, bGraph.refs);
  await graph.resolvePending();

  const caller = aGraph.nodes.find((n) => n.name === "caller");
  const target = bGraph.nodes.find((n) => n.name === "target");
  assert.ok(caller && target);
  assert.deepEqual(
    graph.callees(caller.id, 1, 10).map((s) => s.id),
    [target.id],
  );
  assert.equal(graph.callees(caller.id, 1, 10)[0].count, 2);
  graph.close();
});

for (const fixture of [
  {
    name: "TypeScript import alias",
    format: "typescript",
    callerPath: "caller.ts",
    targetPath: "codec.ts",
    callerText:
      'import { decode as parse } from "./codec";\nexport function run() { parse(); }\n',
    targetText: "export function decode() { return 1; }\n",
  },
  {
    name: "Python import alias",
    format: "python",
    callerPath: "caller.py",
    targetPath: "codec.py",
    callerText: "from .codec import decode as parse\ndef run():\n    parse()\n",
    targetText: "def decode():\n    return 1\n",
  },
  {
    name: "TypeScript namespace import",
    format: "typescript",
    callerPath: "namespace-caller.ts",
    targetPath: "codec.ts",
    callerText:
      'import * as utils from "./codec";\nexport function run() { utils.decode(); }\n',
    targetText: "export function decode() { return 1; }\n",
  },
]) {
  test(`${fixture.name} resolves calls to the exported symbol`, async () => {
    const callerFile = {
      ...codeFile(fixture.callerPath),
      id: `caller-${fixture.format}`,
      format: fixture.format,
      absolutePath: `/repo/${fixture.callerPath}`,
    };
    const targetFile = {
      ...codeFile(fixture.targetPath),
      id: `target-${fixture.format}`,
      format: fixture.format,
      absolutePath: `/repo/${fixture.targetPath}`,
    };
    const callerSource = {
      kind: "text",
      file: callerFile,
      text: fixture.callerText,
    };
    const targetSource = {
      kind: "text",
      file: targetFile,
      text: fixture.targetText,
    };
    const extractor = new CodeExtractor();
    const callerGraph = await extractFileGraph(
      callerSource,
      await extractor.extract(callerSource),
    );
    const targetGraph = await extractFileGraph(
      targetSource,
      await extractor.extract(targetSource),
    );
    const graph = new SqliteGraphStorage("", { inMemory: true });
    graph.upsertFileGraph(
      callerFile.id,
      callerGraph.nodes,
      callerGraph.edges,
      callerGraph.refs,
    );
    graph.upsertFileGraph(
      targetFile.id,
      targetGraph.nodes,
      targetGraph.edges,
      targetGraph.refs,
    );
    await graph.resolvePending({ files: [callerFile, targetFile] });

    const caller = callerGraph.nodes.find((node) => node.name === "run");
    const target = targetGraph.nodes.find((node) => node.name === "decode");
    assert.ok(caller && target);
    assert.deepEqual(
      graph.callees(caller.id, 1, 10).map((item) => item.id),
      [target.id],
    );

    graph.deleteFileGraph(targetFile.id);
    graph.upsertFileGraph(
      targetFile.id,
      targetGraph.nodes,
      targetGraph.edges,
      targetGraph.refs,
    );
    await graph.resolvePending({ files: [callerFile, targetFile] });
    assert.deepEqual(
      graph.expandFileNeighbors([callerFile.id], 10).map((item) => item.id),
      [targetFile.id],
    );
    assert.deepEqual(
      graph.callees(caller.id, 1, 10).map((item) => item.id),
      [target.id],
    );
    graph.close();
  });
}

test("named import receiver calls resolve to the imported member", async () => {
  const callerFile = {
    ...codeFile("caller.ts"),
    id: "named-import-caller",
  };
  const targetFile = {
    ...codeFile("codec.ts"),
    id: "named-import-target",
  };
  const callerSource = {
    kind: "text",
    file: callerFile,
    text: `import { Demo } from "./codec";
export function run() { return Demo.helper(); }`,
  };
  const targetSource = {
    kind: "text",
    file: targetFile,
    text: `export class Demo { static helper() { return 1; } }`,
  };
  const extractor = new CodeExtractor();
  const callerInput = await extractFileGraph(
    callerSource,
    await extractor.extract(callerSource),
  );
  const targetInput = await extractFileGraph(
    targetSource,
    await extractor.extract(targetSource),
  );
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    callerFile.id,
    callerInput.nodes,
    callerInput.edges,
    callerInput.refs,
  );
  graph.upsertFileGraph(
    targetFile.id,
    targetInput.nodes,
    targetInput.edges,
    targetInput.refs,
  );
  await graph.resolvePending({ files: [callerFile, targetFile] });

  const run = callerInput.nodes.find((node) => node.name === "run");
  const demo = targetInput.nodes.find((node) => node.name === "Demo");
  const helper = targetInput.nodes.find((node) => node.name === "helper");
  assert.ok(run && demo && helper);
  assert.deepEqual(
    graph.callees(run.id, 1, 10).map((item) => item.id),
    [helper.id],
  );
  assert.notEqual(helper.id, demo.id);
  graph.close();
});

test("receiver calls use the owning or explicitly named container", async () => {
  const file = codeFile("scoped-receivers.ts");
  const source = {
    kind: "text",
    file,
    text: `class First {
  helper() { return 1; }
  run() { return this.helper(); }
}
class Demo {
  static helper() { return 2; }
}
class Second {
  helper() { return 3; }
  run() { return Demo.helper(); }
}`,
  };
  const input = await extractFileGraph(
    source,
    await new CodeExtractor().extract(source),
  );
  const nodesByName = (name) =>
    input.nodes.filter((node) => node.name === name);
  const helpers = nodesByName("helper");
  const runs = nodesByName("run");
  assert.equal(helpers.length, 3);
  assert.equal(runs.length, 2);

  const contains = input.edges.filter((edge) => edge.kind === "CONTAINS");
  const containerFor = (id) =>
    input.nodes.find(
      (node) => contains.find((edge) => edge.dst === id)?.src === node.id,
    )?.name;
  const callTargetFor = (id) =>
    input.edges.find((edge) => edge.kind === "CALLS" && edge.src === id)?.dst;
  const firstRun = runs.find((node) => containerFor(node.id) === "First");
  const secondRun = runs.find((node) => containerFor(node.id) === "Second");
  const firstHelper = helpers.find((node) => containerFor(node.id) === "First");
  const demoHelper = helpers.find((node) => containerFor(node.id) === "Demo");
  assert.ok(firstRun && secondRun && firstHelper && demoHelper);
  assert.equal(callTargetFor(firstRun.id), firstHelper.id);
  assert.equal(callTargetFor(secondRun.id), demoHelper.id);
});

test("owner receivers resolve through the inheritance chain", async () => {
  const file = codeFile("inherited-receivers.ts");
  const source = {
    kind: "text",
    file,
    text: `class Base {
  helper() { return 1; }
}
class ChildWithoutOverride extends Base {
  run() { return this.helper(); }
}
class ChildWithOverride extends Base {
  helper() { return super.helper(); }
  other() { return super.helper(); }
  own() { return this.helper(); }
}`,
  };
  const input = await extractFileGraph(
    source,
    await new CodeExtractor().extract(source),
  );
  const contains = input.edges.filter((edge) => edge.kind === "CONTAINS");
  const containerFor = (id) =>
    input.nodes.find(
      (node) => contains.find((edge) => edge.dst === id)?.src === node.id,
    )?.name;
  const findMember = (container, name) =>
    input.nodes.find(
      (node) => node.name === name && containerFor(node.id) === container,
    );
  const baseHelper = findMember("Base", "helper");
  const inheritedRun = findMember("ChildWithoutOverride", "run");
  const overridingHelper = findMember("ChildWithOverride", "helper");
  const other = findMember("ChildWithOverride", "other");
  const own = findMember("ChildWithOverride", "own");
  assert.ok(baseHelper && inheritedRun && overridingHelper && other && own);

  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(file.id, input.nodes, input.edges, input.refs);
  await graph.resolvePending();
  for (const caller of [inheritedRun, overridingHelper, other]) {
    assert.deepEqual(
      graph.callees(caller.id, 1, 10).map((item) => item.id),
      [baseHelper.id],
    );
  }
  assert.deepEqual(
    graph.callees(own.id, 1, 10).map((item) => item.id),
    [overridingHelper.id],
  );
  assert.equal(
    graph
      .callees(overridingHelper.id, 1, 10)
      .some((item) => item.id === overridingHelper.id),
    false,
  );
  graph.close();
});

for (const fixture of [
  {
    name: "Python super()",
    format: "python",
    path: "super_call.py",
    base: "Base",
    child: "Child",
    caller: "helper",
    text: `class Base:
    def helper(self):
        return 1

class Child(Base):
    def helper(self):
        return super().helper()
`,
  },
  {
    name: "Java this with interface default method",
    format: "java",
    path: "InheritedCall.java",
    base: "Base",
    child: "Child",
    caller: "run",
    text: `interface Base {
  default int helper() { return 1; }
}
class Child implements Base {
  int run() { return this.helper(); }
}`,
  },
  {
    name: "JavaScript super",
    format: "javascript",
    path: "super-call.js",
    base: "Base",
    child: "Child",
    caller: "run",
    text: `class Base {
  helper() { return 1; }
}
class Child extends Base {
  run() { return super.helper(); }
}`,
  },
  {
    name: "C++ this pointer",
    format: "cpp",
    path: "inherited_call.cpp",
    base: "Base",
    child: "Child",
    caller: "run",
    text: `class Base {
 public:
  int helper() { return 1; }
};
class Child : public Base {
 public:
  int run() { return this->helper(); }
};`,
  },
]) {
  test(`${fixture.name} preserves receiver and resolves inherited method`, async () => {
    const file = {
      ...codeFile(fixture.path),
      format: fixture.format,
    };
    const source = { kind: "text", file, text: fixture.text };
    const input = await extractFileGraph(
      source,
      await new CodeExtractor().extract(source),
    );
    const contains = input.edges.filter((edge) => edge.kind === "CONTAINS");
    const containerFor = (id) =>
      input.nodes.find(
        (node) => contains.find((edge) => edge.dst === id)?.src === node.id,
      )?.name;
    const member = (container, name) =>
      input.nodes.find(
        (node) => node.name === name && containerFor(node.id) === container,
      );
    const target = member(fixture.base, "helper");
    const caller = member(fixture.child, fixture.caller);
    assert.ok(target && caller);

    const graph = new SqliteGraphStorage("", { inMemory: true });
    graph.upsertFileGraph(file.id, input.nodes, input.edges, input.refs);
    await graph.resolvePending();
    assert.deepEqual(
      graph.callees(caller.id, 1, 10).map((item) => item.id),
      [target.id],
    );
    graph.close();
  });
}

test("CONTAINS uses :: scope breadcrumbs", async () => {
  const file = codeFile("cls.ts");
  const source = {
    kind: "text",
    file,
    text: `
export class Foo {
  bar() {
    return 1;
  }
}
`,
  };
  const fragments = await new CodeExtractor().extract(source);
  const method = fragments.find(
    (f) => f.metadata?.kind === "code" && f.metadata.symbolName === "bar",
  );
  assert.ok(method);
  assert.equal(method.metadata.scope, "Foo");

  const graphInput = await extractFileGraph(source, fragments);
  const contains = graphInput.edges.filter((e) => e.kind === "CONTAINS");
  assert.equal(contains.length, 1);
});

test("Go interface dispatch exposes implementation candidates as a dynamic boundary", async () => {
  const file = { ...codeFile("dispatch.go"), format: "go" };
  const source = {
    kind: "text",
    file,
    text: `package p
type Runner interface { Run() }
type Alpha struct{}
func (Alpha) Run() {}
type Beta struct{}
func (Beta) Run() {}
func invoke[T Runner](value T) { value.Run() }
`,
  };
  const input = await extractFileGraph(
    source,
    await new CodeExtractor().extract(source),
  );
  const invoke = input.nodes.find((node) => node.name === "invoke");
  assert.ok(invoke);

  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(file.id, input.nodes, input.edges, input.refs);
  await graph.resolvePending();

  const boundaries = graph.dynamicBoundaries([invoke.id], 10);
  assert.equal(boundaries.length, 1);
  assert.equal(boundaries[0].reason, "polymorphic_dispatch");
  assert.deepEqual(boundaries[0].target.hints, {
    receiverType: "T",
    candidateTypes: ["T", "Runner"],
    genericBounds: ["Runner"],
    dispatch: "interface",
  });
  const candidateNames = boundaries[0].candidates
    .map((id) => input.nodes.find((node) => node.id === id)?.name)
    .filter(Boolean);
  assert.deepEqual(candidateNames, ["Run", "Run", "Run"]);
  graph.close();
});

test("Go concrete receiver type resolves a method call in its container", async () => {
  const file = { ...codeFile("receiver.go"), format: "go" };
  const source = {
    kind: "text",
    file,
    text: `package p
type Worker struct{}
func (worker Worker) helper() {}
func (worker Worker) run() { worker.helper() }
`,
  };
  const input = await extractFileGraph(
    source,
    await new CodeExtractor().extract(source),
  );
  const run = input.nodes.find((node) => node.name === "run");
  const helper = input.nodes.find((node) => node.name === "helper");
  assert.ok(run && helper);
  assert.ok(
    input.edges.some(
      (edge) => edge.kind === "CALLS" && edge.src === run.id && edge.dst === helper.id,
    ),
  );
});

test("Java interface receiver keeps virtual implementations as candidates", async () => {
  const file = { ...codeFile("Dispatch.java"), format: "java" };
  const source = {
    kind: "text",
    file,
    text: `interface Runner { void run(); }
class Alpha implements Runner { public void run() {} }
class Use { void invoke(Runner value) { value.run(); } }
`,
  };
  const input = await extractFileGraph(
    source,
    await new CodeExtractor().extract(source),
  );
  const invoke = input.nodes.find((node) => node.name === "invoke");
  assert.ok(invoke);
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(file.id, input.nodes, input.edges, input.refs);
  await graph.resolvePending();

  const boundary = graph.dynamicBoundaries([invoke.id], 10)[0];
  assert.ok(boundary);
  assert.equal(boundary.reason, "polymorphic_dispatch");
  assert.equal(boundary.target.hints?.receiverType, "Runner");
  assert.equal(boundary.target.hints?.dispatch, "virtual");
  assert.equal(boundary.candidates.length, 2);
  graph.close();
});
