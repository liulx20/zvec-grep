import assert from "node:assert/strict";
import test from "node:test";
import { CodeExtractor } from "../../dist/engine/extraction/code/extractor.js";
import {
  SqliteGraphStorage,
  extractFileGraph,
} from "../../dist/engine/graph/index.js";
import { NameIndex } from "../../dist/engine/graph/name-index.js";
import {
  codeFile,
  extractGraph,
  extractSourceGraph,
  resolveGraph,
  upsertGraph,
} from "../helpers/graph.mjs";

function containerName(input, memberId) {
  const containerId = input.edges.find(
    (edge) => edge.kind === "CONTAINS" && edge.dst === memberId,
  )?.src;
  return input.nodes.find((node) => node.id === containerId)?.name;
}

function memberIn(input, container, name) {
  return input.nodes.find(
    (node) => node.name === name && containerName(input, node.id) === container,
  );
}

function candidateContainers(input, boundary) {
  return boundary.candidates.map((id) => containerName(input, id));
}

async function javaRtaTypes(path, id) {
  const file = codeFile(path, { id, format: "java" });
  const input = await extractGraph(
    file,
    `interface Runner { void run(); }
class Alpha implements Runner { public void run() {} }
class Beta implements Runner { public void run() {} }
class Use { void invoke(Runner value) { value.run(); } }`,
  );
  return {
    file,
    input,
    invoke: input.nodes.find((node) => node.name === "invoke"),
    alphaRun: memberIn(input, "Alpha", "run"),
    betaRun: memberIn(input, "Beta", "run"),
  };
}

test("equivalent declarations resolve independently of load order", () => {
  const entry = (id, startLine) => ({
    id,
    fileId: "source",
    name: "run",
    qualifiedName: "Worker::run",
    kind: "function",
    signature: "void run()",
    startLine,
  });
  for (const entries of [
    [entry("declaration", 3), entry("definition", 20)],
    [entry("definition", 20), entry("declaration", 3)],
  ]) {
    const names = new NameIndex();
    names.load(entries);
    assert.equal(names.lookup("run", "source")?.id, "definition");
  }
});

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
  const graphInput = await extractGraph(file, text);

  assert.ok(graphInput.nodes.some((n) => n.name === "run"));
  assert.ok(graphInput.nodes.some((n) => n.name === "helper"));

  const localCalls = graphInput.edges.filter((e) => e.kind === "CALLS");
  assert.equal(localCalls.length, 2);
  assert.equal(new Set(localCalls.map((edge) => edge.id)).size, 2);
  assert.deepEqual(
    localCalls.map((edge) => edge.count),
    [1, 1],
  );
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

  const graph = await resolveGraph(file, graphInput);

  const run = graphInput.nodes.find((n) => n.name === "run");
  const helper = graphInput.nodes.find((n) => n.name === "helper");
  assert.ok(run && helper);
  assert.deepEqual(
    graph.callees(run.id, 1, 10).map((s) => s.id),
    [helper.id],
  );
  assert.equal(graph.callees(run.id, 1, 10)[0].count, 2);

  graph.upsertFileGraph(
    "other-file",
    [
      {
        id: "other-helper",
        kind: "function",
        is_exported: true,
        name: "helper",
      },
    ],
    [],
    [],
  );
  await graph.resolvePending();
  assert.equal(
    graph.callees(run.id, 1, 10).find((item) => item.id === helper.id)?.count,
    2,
    "reprojection must preserve every local call occurrence",
  );
  graph.close();
});

test("resolves methods chained from JS and TS constructors", async () => {
  const file = codeFile("constructor-chain.ts");
  const input = await extractGraph(
    file,
    `class Writer { writeObject(value: unknown) { return value; } }
function serialize(value: unknown) { return new Writer().writeObject(value); }`,
  );
  const serialize = input.nodes.find((node) => node.name === "serialize");
  const writeObject = input.nodes.find((node) => node.name === "writeObject");
  assert.ok(serialize && writeObject);

  const graph = await resolveGraph(file, input);
  const [boundary] = graph.dynamicBoundaries([serialize.id], 10);
  assert.equal(boundary.target.hints.receiverType, "Writer");
  assert.deepEqual(boundary.candidates, [writeObject.id]);
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
    const file = codeFile(fixture.path, { format: fixture.format });
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
  const callerFile = codeFile("caller.ts", { id: "caller-file" });
  const targetFile = codeFile("target.ts", { id: "target-file" });
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

  upsertGraph(graph, aFile, aGraph);
  upsertGraph(graph, bFile, bGraph);
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

test("imported destructured values remain valid call targets", async () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  const apiFile = codeFile("api.ts", { id: "api-file" });
  const callerFile = codeFile("caller.ts", { id: "caller-file" });
  const api = await extractGraph(
    apiFile,
    "export const { useFooQuery, useBarQuery } = api;",
  );
  const caller = await extractGraph(
    callerFile,
    'import { useFooQuery } from "./api"; export function run() { return useFooQuery(); }',
  );

  upsertGraph(graph, apiFile, api);
  upsertGraph(graph, callerFile, caller);
  await graph.resolvePending({ files: [apiFile, callerFile] });

  const run = caller.nodes.find((node) => node.name === "run");
  const hook = api.nodes.find((node) => node.name === "useFooQuery");
  assert.ok(run && hook);
  assert.deepEqual(
    graph.callees(run.id, 1, 10).map((item) => item.id),
    [hook.id],
  );

  const factoryFile = codeFile("factory.ts", { id: "factory-file" });
  const consumerFile = codeFile("consumer.ts", { id: "consumer-file" });
  const factory = await extractGraph(
    factoryFile,
    "export const useActions = () => { const execute = () => 1; return { perform: execute }; };",
  );
  const consumer = await extractGraph(
    consumerFile,
    'import { useActions } from "./factory"; export function consume() { const { perform } = useActions(); return perform(); }',
  );
  upsertGraph(graph, factoryFile, factory);
  upsertGraph(graph, consumerFile, consumer);
  await graph.resolvePending({ files: [factoryFile, consumerFile] });

  const consume = consumer.nodes.find((node) => node.name === "consume");
  const perform = factory.nodes.find((node) => node.name === "perform");
  assert.ok(consume && perform);
  assert.ok(
    graph.callees(consume.id, 1, 10).some((item) => item.id === perform.id),
  );
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

test("TypeScript namespace re-exports resolve through a barrel", async () => {
  const callerFile = codeFile("caller.ts", { id: "reexport-caller" });
  const barrelFile = codeFile("barrel.ts", { id: "reexport-barrel" });
  const targetFile = codeFile("codec.ts", { id: "reexport-target" });
  const [caller, barrel, target] = await Promise.all([
    extractGraph(
      callerFile,
      'import { Api } from "./barrel";\nexport function run() { return Api.decode(); }\n',
    ),
    extractGraph(barrelFile, 'export * as Api from "./codec";\n'),
    extractGraph(targetFile, "export function decode() { return 1; }\n"),
  ]);
  const graph = new SqliteGraphStorage("", { inMemory: true });
  for (const [file, input] of [
    [callerFile, caller],
    [barrelFile, barrel],
    [targetFile, target],
  ])
    upsertGraph(graph, file, input);
  await graph.resolvePending({ files: [callerFile, barrelFile, targetFile] });

  const run = caller.nodes.find((node) => node.name === "run");
  const decode = target.nodes.find((node) => node.name === "decode");
  assert.ok(run && decode);
  assert.deepEqual(
    graph.callees(run.id, 1, 10).map((item) => item.id),
    [decode.id],
  );
  graph.close();
});

test("named import receiver calls resolve to the imported member", async () => {
  const callerFile = codeFile("caller.ts", { id: "named-import-caller" });
  const targetFile = codeFile("codec.ts", { id: "named-import-target" });
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

test("default import receivers retain their value dependency", async () => {
  const targetFile = codeFile("client.ts", { id: "default-import-target" });
  const callerFile = codeFile("caller.ts", { id: "default-import-caller" });
  const target = await extractGraph(
    targetFile,
    "const Client = makeClient(); export default Client;",
  );
  const caller = await extractGraph(
    callerFile,
    'import Client from "./client"; export function run() { return Client.send(); }',
  );
  const graph = new SqliteGraphStorage("", { inMemory: true });
  upsertGraph(graph, targetFile, target);
  upsertGraph(graph, callerFile, caller);
  await graph.resolvePending({ files: [targetFile, callerFile] });

  const run = caller.nodes.find((node) => node.name === "run");
  const client = target.nodes.find((node) => node.name === "Client");
  assert.ok(run && client);
  assert.equal(graph.outgoingEdges([run.id], ["REFS"], 10)[0]?.dst, client.id);
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
  const input = await extractSourceGraph(source);
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

test("bound private methods are recorded as callback references", async () => {
  const input = await extractGraph(
    codeFile("bound-callback.ts", { format: "typescript" }),
    `class Loop { constructor(callback: () => void) {} }
class Session {
  #sendLoopBody() {}
  #sendLoop = new Loop(this.#sendLoopBody.bind(this));
}`,
  );
  const session = input.nodes.find((node) => node.name === "Session");
  const body = input.nodes.find((node) => node.name === "#sendLoopBody");
  assert.ok(session && body);
  assert.ok(
    input.edges.some(
      (edge) =>
        edge.src === session.id &&
        edge.dst === body.id &&
        edge.kind === "REFS" &&
        edge.rel === "function",
    ),
  );
});

test("computed handler bindings preserve their dynamic dispatch boundary", async () => {
  const file = codeFile("computed-handler.ts", { format: "typescript" });
  const input = await extractGraph(
    file,
    `export function invoke(registry: Record<string, () => void>, key: string) {
  const handler = registry[key];
  handler();
}
export function construct(registry: Record<string, new () => object>, key: string) {
  const Handler = registry[key];
  return new Handler();
}`,
  );
  const invoke = input.nodes.find((node) => node.name === "invoke");
  const construct = input.nodes.find((node) => node.name === "construct");
  assert.ok(invoke && construct);

  const graph = await resolveGraph(file, input);
  const boundary = graph.dynamicBoundaries([invoke.id], 10)[0];
  assert.equal(boundary?.target.raw, "registry[key]");
  assert.equal(
    boundary?.target.hints?.dynamicDispatch?.form,
    "computed_member",
  );
  assert.equal(boundary?.reason, "runtime_dispatch");
  assert.equal(
    graph.dynamicBoundaries([construct.id], 10)[0]?.target.raw,
    "registry[key]",
  );
  graph.close();

  const callerFile = codeFile("caller.ts", { id: "dynamic-namespace-caller" });
  const barrelFile = codeFile("handlers.ts", {
    id: "dynamic-namespace-barrel",
  });
  const alphaFile = codeFile("alpha.ts", { id: "dynamic-namespace-alpha" });
  const betaFile = codeFile("beta.ts", { id: "dynamic-namespace-beta" });
  const [callerInput, alphaInput, betaInput] = await Promise.all([
    extractGraph(
      callerFile,
      `import * as Handlers from "./handlers";
export function construct(fallback: boolean, key: string) {
  const choices = fallback ? {} : Handlers;
  const Handler = choices[key];
  return new Handler();
}`,
    ),
    extractGraph(alphaFile, "export class Alpha { run() {} }"),
    extractGraph(betaFile, "export class Beta { run() {} }"),
  ]);
  const initialBarrel = await extractGraph(
    barrelFile,
    'export * from "./alpha";',
  );
  const namespaceGraph = new SqliteGraphStorage("", { inMemory: true });
  for (const [namespaceFile, namespaceInput] of [
    [callerFile, callerInput],
    [barrelFile, initialBarrel],
    [alphaFile, alphaInput],
    [betaFile, betaInput],
  ])
    upsertGraph(namespaceGraph, namespaceFile, namespaceInput);
  await namespaceGraph.resolvePending({
    files: [callerFile, barrelFile, alphaFile, betaFile],
  });

  const namespaceConstruct = callerInput.nodes.find(
    (node) => node.name === "construct",
  );
  const alpha = alphaInput.nodes.find((node) => node.name === "Alpha");
  const beta = betaInput.nodes.find((node) => node.name === "Beta");
  assert.ok(namespaceConstruct && alpha && beta);
  let namespaceBoundary = namespaceGraph.dynamicBoundaries(
    [namespaceConstruct.id],
    10,
  )[0];
  assert.ok(
    namespaceBoundary?.target.hints?.dynamicDispatch?.receiverSources?.includes(
      "Handlers",
    ),
  );
  assert.deepEqual(namespaceBoundary?.candidates, [alpha.id]);
  assert.equal(
    namespaceBoundary?.candidateDetails[0]?.reason,
    "namespace_export",
  );
  assert.deepEqual(namespaceGraph.callees(namespaceConstruct.id, 1, 10), []);

  const expandedBarrel = await extractGraph(
    barrelFile,
    'export * from "./alpha";\nexport * from "./beta";',
  );
  upsertGraph(namespaceGraph, barrelFile, expandedBarrel);
  await namespaceGraph.resolvePending({
    files: [callerFile, barrelFile, alphaFile, betaFile],
  });
  namespaceBoundary = namespaceGraph.dynamicBoundaries(
    [namespaceConstruct.id],
    10,
  )[0];
  assert.deepEqual(
    new Set(namespaceBoundary?.candidates),
    new Set([alpha.id, beta.id]),
  );
  namespaceGraph.close();
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
  const input = await extractSourceGraph(source);
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

  const graph = await resolveGraph(file, input);
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
    const file = codeFile(fixture.path, { format: fixture.format });
    const input = await extractGraph(file, fixture.text);
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

    const graph = await resolveGraph(file, input);
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
  const file = codeFile("dispatch.go", { format: "go" });
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
  const input = await extractSourceGraph(source);
  const invoke = input.nodes.find((node) => node.name === "invoke");
  assert.ok(invoke);

  const graph = await resolveGraph(file, input);

  const boundaries = graph.dynamicBoundaries([invoke.id], 10);
  assert.equal(boundaries.length, 1);
  assert.equal(boundaries[0].reason, "polymorphic_dispatch");
  assert.deepEqual(boundaries[0].target.hints, {
    receiverType: "T",
    callArity: 0,
    candidateTypes: ["T", "Runner"],
    genericBounds: ["Runner"],
    dispatch: "interface",
  });
  const candidateNames = boundaries[0].candidates
    .map((id) => input.nodes.find((node) => node.id === id)?.name)
    .filter(Boolean);
  assert.deepEqual(candidateNames, ["Run", "Run"]);
  assert.equal(graph.stats().refCount, 0);
  assert.equal(graph.stats().pendingRefCount, 0);
  assert.equal(graph.stats().failedRefCount, 0);
  assert.equal(graph.stats().dynamicBoundaryCount, 1);
  assert.equal(boundaries[0].candidateDetails.length, 2);
  await graph.resolvePending();
  assert.equal(graph.dynamicBoundaries([invoke.id], 10).length, 1);
  graph.close();
});

test("TypeScript generic bounds drive dynamic call candidates", async () => {
  const file = codeFile("generic.ts", { format: "typescript" });
  const input = await extractGraph(
    file,
    `interface Client { call(value: number): void; }
class Impl implements Client { call(_value: number) {} }
const invoke = <C extends Client>(core: C) => { core.call(1); };
new Impl();`,
  );
  const invoke = input.nodes.find((node) => node.name === "invoke");
  assert.ok(invoke);

  const graph = await resolveGraph(file, input);
  const [boundary] = graph.dynamicBoundaries([invoke.id], 10);
  assert.deepEqual(boundary?.target.hints?.genericBounds, ["Client"]);
  assert.deepEqual(boundary?.target.hints?.candidateTypes, ["C", "Client"]);
  graph.close();
});

test("TypeScript interface dispatch checks structural method sets", async () => {
  const typesFile = codeFile("types.ts", {
    id: "structural-types",
    format: "typescript",
  });
  const managerFile = codeFile("manager.ts", {
    id: "structural-manager",
    format: "typescript",
  });
  const types = await extractGraph(
    typesFile,
    `export interface C { invoke(): void; close(): void; }
export class Client { invoke() {} close() {} file(): void {} }
export class Partial { invoke() {} }`,
  );
  const manager = await extractGraph(
    managerFile,
    `import type { C as BaseC } from "./types";
interface C extends BaseC { file(): void; }
export function send(client: C) { client.invoke(); }`,
  );
  const send = manager.nodes.find((node) => node.name === "send");
  const invoke = memberIn(types, "Client", "invoke");
  const partial = memberIn(types, "Partial", "invoke");
  assert.ok(send && invoke && partial);

  const graph = new SqliteGraphStorage("", { inMemory: true });
  upsertGraph(graph, typesFile, types);
  upsertGraph(graph, managerFile, manager);
  await graph.resolvePending({ files: [typesFile, managerFile] });
  const boundary = graph.dynamicBoundaries([send.id], 10)[0];
  assert.ok(boundary);
  assert.deepEqual(boundary.candidates, [invoke.id]);
  assert.ok(!boundary.candidates.includes(partial.id));
  graph.close();
});

test("TypeScript object aliases resolve typed object implementations", async () => {
  const file = codeFile("typed-object.ts", { format: "typescript" });
  const input = await extractGraph(
    file,
    `type Runner = { run(): void };
type Tracer = { trace(): void };
function run() {}
function trace() {}
const implementation: Runner & Tracer = { run, trace };
function invoke(value: Runner & Tracer) { value.run(); }`,
  );
  const invoke = input.nodes.find((node) => node.name === "invoke");
  const run = input.nodes.find(
    (node) => node.name === "run" && node.kind === "function",
  );
  assert.ok(invoke && run);
  assert.deepEqual(
    input.refs.find((ref) => ref.owner === invoke.id)?.target.hints
      ?.candidateTypes,
    ["Runner", "Tracer"],
  );

  const graph = await resolveGraph(file, input);
  assert.deepEqual(
    graph.callees(invoke.id, 1, 10).map((item) => item.id),
    [run.id],
  );
  assert.deepEqual(graph.dynamicBoundaries([invoke.id], 10), []);
  graph.close();
});

test("Go concrete receiver type resolves a method call in its container", async () => {
  const file = codeFile("receiver.go", { format: "go" });
  const source = {
    kind: "text",
    file,
    text: `package p
type Worker struct{}
func (worker Worker) helper() {}
func (worker Worker) run() { worker.helper() }
`,
  };
  const input = await extractSourceGraph(source);
  const run = input.nodes.find((node) => node.name === "run");
  const helper = input.nodes.find((node) => node.name === "helper");
  assert.ok(run && helper);
  assert.ok(
    input.edges.some(
      (edge) =>
        edge.kind === "CALLS" && edge.src === run.id && edge.dst === helper.id,
    ),
  );
});

for (const fixture of [
  {
    language: "Rust",
    format: "rust",
    path: "arity.rs",
    text: `use std::collections::HashMap;
struct Value;
impl Value {
  fn run(&self, values: HashMap<String, i32>) {}
}
`,
  },
  {
    language: "Python",
    format: "python",
    path: "arity.py",
    text: `class Value:
  def run(self, values: dict[str, int]):
    pass
`,
  },
]) {
  test(`${fixture.language} AST arity excludes the implicit receiver`, async () => {
    const file = codeFile(fixture.path, { format: fixture.format });
    const input = await extractGraph(file, fixture.text);
    assert.equal(input.nodes.find((node) => node.name === "run")?.arity, 1);
  });
}

test("Rust trait dispatch owns impl methods and exposes implementations", async () => {
  const file = codeFile("dispatch.rs", { format: "rust" });
  const source = {
    kind: "text",
    file,
    text: `trait Runner { fn run(&self); }
struct Alpha;
impl Runner for Alpha { fn run(&self) {} }
fn invoke(value: &dyn Runner) { value.run(); }
`,
  };
  const input = await extractSourceGraph(source);
  const invoke = input.nodes.find((node) => node.name === "invoke");
  const runMethods = input.nodes.filter((node) => node.name === "run");
  assert.ok(invoke);
  assert.equal(runMethods.length, 2);
  assert.deepEqual(
    runMethods.map((node) => node.arity),
    [0, 0],
  );
  const alphaContainers = input.nodes.filter(
    (node) => node.name === "Alpha" && node.kind === "class",
  );
  assert.equal(alphaContainers.length, 2);
  const implContainer = alphaContainers.find((node) =>
    node.signature?.startsWith("impl "),
  );
  assert.ok(implContainer);
  const implRun = runMethods.find((node) =>
    input.edges.some(
      (edge) =>
        edge.kind === "CONTAINS" &&
        edge.src === implContainer.id &&
        edge.dst === node.id,
    ),
  );
  assert.ok(
    implRun,
    "the impl block, not the same-name struct, must own its method",
  );

  const graph = await resolveGraph(file, input);
  const boundary = graph.dynamicBoundaries([invoke.id], 10)[0];
  assert.ok(boundary);
  assert.ok(boundary.candidates.includes(implRun.id));
  graph.close();
});

test("this.field receiver uses the owner field type, not a later local", async () => {
  const file = codeFile("OwnerField.ts", { format: "typescript" });
  const source = {
    kind: "text",
    file,
    text: `interface Runner { run(): void; }
interface Other { run(): void; }
declare function makeOther(): Other;
class Use {
  value: Runner;
  invoke() {
    this.value.run();
    { const value: Other = makeOther(); value.run(); }
  }
}`,
  };
  const input = await extractSourceGraph(source);
  const invoke = input.nodes.find((node) => node.name === "invoke");
  assert.ok(invoke);
  const calls = input.refs.filter(
    (ref) =>
      ref.type === "symbol" &&
      ref.owner === invoke.id &&
      ref.target.member === "run",
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0].target.receiver?.name, "this.value");
  assert.equal(calls[0].target.hints?.receiverType, "Runner");
  assert.equal(calls[1].target.hints?.receiverType, "Other");
});

test("TypeScript constructor parameter properties retain receiver types", async () => {
  const input = await extractGraph(
    codeFile("service.ts", { format: "typescript" }),
    `class Provider { lookup() {} }
class Service {
  constructor(private readonly provider: Provider) {}
  run() { this.provider.lookup(); }
}`,
  );
  const call = input.refs.find(
    (ref) => ref.type === "symbol" && ref.target.member === "lookup",
  );
  assert.equal(call?.target.hints?.receiverType, "Provider");
});

test("TypeScript private fields retain their declared receiver type", async () => {
  const input = await extractGraph(
    codeFile("private-field.ts", { format: "typescript" }),
    `interface ClientPort { invoke(value: unknown): Promise<unknown>; }
class Manager {
  #client: ClientPort;
  constructor(client: ClientPort) { this.#client = client; }
  async send(value: unknown) { return await this.#client.invoke(value); }
}`,
  );
  const call = input.refs.find(
    (ref) => ref.type === "symbol" && ref.target.member === "invoke",
  );
  assert.equal(call?.target.receiver?.name, "this.#client");
  assert.equal(call?.target.hints?.receiverType, "ClientPort");
});

test("TypeScript private getters retain receiver types through non-null assertions", async () => {
  const input = await extractGraph(
    codeFile("private-getter.ts", { format: "typescript" }),
    `interface ClientPort { invoke(value: unknown): Promise<unknown>; }
class Manager {
  #clients: ClientPort[] = [];
  get #client(): ClientPort | undefined { return this.#clients[0]; }
  async send(value: unknown) { return await this.#client!.invoke(value); }
}`,
  );
  const call = input.refs.find(
    (ref) => ref.type === "symbol" && ref.target.member === "invoke",
  );
  assert.equal(call?.target.receiver?.name, "this.#client!");
  assert.equal(call?.target.hints?.receiverType, "ClientPort");
});

test("TypeScript inherited field chains follow imported return-type aliases", async () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  const files = {
    types: codeFile("types.ts", { id: "types", format: "typescript" }),
    base: codeFile("base.ts", { id: "base", format: "typescript" }),
    use: codeFile("use.ts", { id: "use", format: "typescript" }),
  };
  const types = (transport) => `
export abstract class Transport { abstract send(): void; }
export class Tcp extends Transport { send() {} }
export abstract class OtherTransport { abstract send(): void; }
export class Udp extends OtherTransport { send() {} }
export type Provider = () => { transport: ${transport} };`;
  const inputs = {
    types: await extractGraph(files.types, types("Transport")),
    base: await extractGraph(
      files.base,
      `import type { Provider } from "./types";
       export abstract class Session {
         protected channel: ReturnType<Provider>;
       }`,
    ),
    use: await extractGraph(
      files.use,
      `import { Session } from "./base";
       export class Encrypted extends Session {
         flush() { this.channel.transport.send(); }
       }`,
    ),
  };
  for (const key of ["types", "base", "use"])
    upsertGraph(graph, files[key], inputs[key]);
  await graph.resolvePending({ files: Object.values(files) });
  const flush = inputs.use.nodes.find((node) => node.name === "flush");
  assert.ok(flush);
  const candidates = () =>
    graph
      .dynamicBoundaries([flush.id], 10)[0]
      ?.candidateDetails.map((candidate) => candidate.displayName);
  assert.deepEqual(candidates(), ["Tcp::send"]);

  inputs.types = await extractGraph(files.types, types("OtherTransport"));
  upsertGraph(graph, files.types, inputs.types);
  await graph.resolvePending({ files: Object.values(files) });
  assert.deepEqual(candidates(), ["Udp::send"]);
  graph.close();
});

test("untyped local receivers use a unique member from a directly imported module", async () => {
  const files = {
    caller: codeFile("caller.ts", { id: "caller" }),
    runtime: codeFile("runtime.ts", { id: "runtime" }),
    unrelated: codeFile("unrelated.ts", { id: "unrelated" }),
  };
  const inputs = {
    caller: await extractGraph(
      files.caller,
      `import { createManager } from "./runtime";
       export function invoke(manager = createManager()) {
         const runtime = manager.get();
         runtime.handleMessage();
       }`,
    ),
    runtime: await extractGraph(
      files.runtime,
      `export function createManager() { return {}; }
       export class Runtime { handleMessage() {} }`,
    ),
    unrelated: await extractGraph(
      files.unrelated,
      `export class Unrelated { handleMessage() {} }`,
    ),
  };
  const graph = new SqliteGraphStorage("", { inMemory: true });
  for (const key of Object.keys(files))
    upsertGraph(graph, files[key], inputs[key]);
  await graph.resolvePending({ files: Object.values(files) });

  const invoke = inputs.caller.nodes.find((node) => node.name === "invoke");
  const runtimeHandler = memberIn(inputs.runtime, "Runtime", "handleMessage");
  assert.ok(invoke && runtimeHandler);
  const callees = graph.callees(invoke.id, 1, 10).map((item) => item.id);
  assert.ok(callees.includes(runtimeHandler.id));
  const unrelatedHandler = memberIn(
    inputs.unrelated,
    "Unrelated",
    "handleMessage",
  );
  assert.ok(unrelatedHandler && !callees.includes(unrelatedHandler.id));
  graph.close();
});

test("construction selects a class over its same-name interface", async () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  const posterFile = codeFile("poster.ts", { id: "poster-file" });
  const serviceFile = codeFile("service.ts", { id: "service-file" });
  const poster = await extractGraph(
    posterFile,
    `export interface Poster { ready: boolean }
export class Poster {
  constructor() { setTimeout(this.post.bind(this), 0); }
  post() {}
}`,
  );
  const service = await extractGraph(
    serviceFile,
    'import { Poster } from "./poster"; export function create() { return new Poster(); }',
  );
  upsertGraph(graph, posterFile, poster);
  upsertGraph(graph, serviceFile, service);
  await graph.resolvePending({ files: [posterFile, serviceFile] });

  const create = service.nodes.find((node) => node.name === "create");
  const posterClass = poster.nodes.find(
    (node) => node.name === "Poster" && node.kind === "class",
  );
  assert.ok(create && posterClass);
  const constructor = memberIn(poster, "Poster", "constructor");
  const post = memberIn(poster, "Poster", "post");
  assert.ok(constructor && post);
  assert.equal(
    graph.edges([create.id, posterClass.id], ["INSTANTIATES"], 10).edges.length,
    1,
  );
  assert.equal(
    graph.edges([create.id, constructor.id], ["CALLS"], 10).edges.length,
    1,
  );
  assert.ok(
    graph.edges([constructor.id, post.id], ["REFS"], 10).edges.length >= 1,
  );
  graph.close();
});

for (const fixture of [
  {
    name: "complete interface method set",
    path: "method-set.go",
    declarations: `type Runner interface { Run(); Stop() }`,
  },
  {
    name: "embedded interface method set",
    path: "embedded-method-set.go",
    declarations: `type Base interface { Stop() }
type Runner interface { Base; Run() }`,
  },
]) {
  test(`Go structural dispatch checks the ${fixture.name}`, async () => {
    const file = codeFile(fixture.path, { format: "go" });
    const input = await extractGraph(
      file,
      `package p
${fixture.declarations}
type Alpha struct{}
func (a Alpha) Run() {}
func (a Alpha) Stop() {}
type Unrelated struct{}
func (u Unrelated) Run() {}
func invoke[T Runner](value T) { value.Run() }
`,
    );
    const invoke = input.nodes.find((node) => node.name === "invoke");
    assert.ok(invoke);
    const graph = await resolveGraph(file, input);
    const boundary = graph.dynamicBoundaries([invoke.id], 10)[0];
    assert.ok(boundary);
    const containers = candidateContainers(input, boundary);
    assert.ok(containers.includes("Alpha"));
    assert.equal(containers.includes("Unrelated"), false);
    graph.close();
  });
}

test("Go structural dispatch includes methods promoted from embedded providers", async () => {
  const file = codeFile("promoted-method-set.go", { format: "go" });
  const source = {
    kind: "text",
    file,
    text: `package p
type Runner interface { Run(); Stop() }
type RunBase struct{}
func (RunBase) Run() {}
type Wrapper struct { RunBase }
func (Wrapper) Stop() {}
type Unrelated struct{}
func (Unrelated) Run() {}
func invoke[T Runner](value T) { value.Run() }
`,
  };
  const input = await extractSourceGraph(source);
  const invoke = input.nodes.find((node) => node.name === "invoke");
  const runBase = input.nodes.find((node) => node.name === "RunBase");
  const promotedRun = input.nodes.find(
    (node) =>
      node.name === "Run" &&
      input.edges.some(
        (edge) =>
          edge.kind === "CONTAINS" &&
          edge.src === runBase?.id &&
          edge.dst === node.id,
      ),
  );
  assert.ok(invoke && runBase && promotedRun);

  const graph = await resolveGraph(file, input);

  const boundary = graph.dynamicBoundaries([invoke.id], 10)[0];
  assert.ok(boundary);
  assert.ok(boundary.candidates.includes(promotedRun.id));
  assert.equal(boundary.candidates.length, 1);
  graph.close();
});

test("Rust wrapped trait objects retain the inner dynamic trait", async () => {
  const file = codeFile("wrapped-dispatch.rs", { format: "rust" });
  const source = {
    kind: "text",
    file,
    text: `trait Runner { fn run(&self); }
struct Alpha;
impl Runner for Alpha { fn run(&self) {} }
fn invoke(value: Box<dyn Runner>) { value.run(); }
`,
  };
  const input = await extractSourceGraph(source);
  const invoke = input.nodes.find((node) => node.name === "invoke");
  assert.ok(invoke);
  const call = input.refs.find(
    (ref) =>
      ref.type === "symbol" &&
      ref.owner === invoke.id &&
      ref.target.member === "run",
  );
  assert.equal(call?.target.hints?.receiverType, "Runner");
  assert.deepEqual(call?.target.hints?.candidateTypes, ["Runner"]);
  assert.equal(call?.target.hints?.dispatch, "trait");

  const graph = await resolveGraph(file, input);
  const boundary = graph.dynamicBoundaries([invoke.id], 10)[0];
  assert.ok(boundary);
  assert.ok(boundary.candidates.length > 0);
  graph.close();
});

test("Java interface receiver keeps virtual implementations as candidates", async () => {
  const file = codeFile("Dispatch.java", { format: "java" });
  const source = {
    kind: "text",
    file,
    text: `interface Runner { void run(); }
class Alpha implements Runner { public void run() {} }
class Use { void invoke(Runner value) { value.run(); } }
`,
  };
  const input = await extractSourceGraph(source);
  const invoke = input.nodes.find((node) => node.name === "invoke");
  assert.ok(invoke);
  const graph = await resolveGraph(file, input);

  const boundary = graph.dynamicBoundaries([invoke.id], 10)[0];
  assert.ok(boundary);
  assert.equal(boundary.reason, "polymorphic_dispatch");
  assert.equal(boundary.target.hints?.receiverType, "Runner");
  assert.equal(boundary.target.hints?.dispatch, "virtual");
  assert.equal(boundary.candidates.length, 1);
  graph.close();
});

test("abstract interface targets remain dynamic without concrete implementations", async () => {
  const file = codeFile("AbstractDispatch.java", { format: "java" });
  const source = {
    kind: "text",
    file,
    text: `interface Runner { void run(); }
class Use { void invoke(Runner value) { value.run(); } }
`,
  };
  const input = await extractSourceGraph(source);
  const invoke = input.nodes.find((node) => node.name === "invoke");
  assert.ok(invoke);
  const graph = await resolveGraph(file, input);

  assert.deepEqual(graph.callees(invoke.id, 1, 10), []);
  const boundary = graph.dynamicBoundaries([invoke.id], 10)[0];
  assert.ok(boundary);
  assert.equal(boundary.reason, "polymorphic_dispatch");
  assert.deepEqual(boundary.candidates, []);
  assert.equal(boundary.candidatesTruncated, false);
  const runner = input.nodes.find((node) => node.name === "Runner");
  assert.ok(runner);
  assert.ok(graph.impact(runner.id, 1, 10).some((ref) => ref.id === invoke.id));
  graph.close();
});

test("Java RTA retains methods inherited by instantiated subclasses", async () => {
  const file = codeFile("InheritedRta.java", { format: "java" });
  const source = {
    kind: "text",
    file,
    text: `interface Runner { void run(); }
class Base implements Runner { public void run() {} }
class Child extends Base {}
class Other implements Runner { public void run() {} }
class Use {
  void invoke(Runner value) { value.run(); }
  void create() { new Child(); new Other(); }
}
`,
  };
  const input = await extractSourceGraph(source);
  const invoke = input.nodes.find((node) => node.name === "invoke");
  const baseRun = memberIn(input, "Base", "run");
  const otherRun = memberIn(input, "Other", "run");
  assert.ok(invoke && baseRun && otherRun);

  const graph = await resolveGraph(file, input);

  assert.deepEqual(graph.callees(invoke.id, 1, 10), []);
  const boundary = graph.dynamicBoundaries([invoke.id], 10)[0];
  assert.ok(boundary);
  assert.deepEqual(
    new Set(boundary.candidates),
    new Set([baseRun.id, otherRun.id]),
  );
  graph.close();
});

test("Java abstract class methods remain dynamic targets", async () => {
  const file = codeFile("AbstractClass.java", { format: "java" });
  const source = {
    kind: "text",
    file,
    text: `abstract class Runner { abstract void run(); }
class Use { void invoke(Runner value) { value.run(); } }
`,
  };
  const input = await extractSourceGraph(source);
  const runner = input.nodes.find((node) => node.name === "Runner");
  const invoke = input.nodes.find((node) => node.name === "invoke");
  assert.ok(runner && invoke);
  assert.equal(runner.kind, "abstract_class");

  const graph = await resolveGraph(file, input);

  assert.deepEqual(graph.callees(invoke.id, 1, 10), []);
  const boundary = graph.dynamicBoundaries([invoke.id], 10)[0];
  assert.ok(boundary);
  assert.equal(boundary.reason, "polymorphic_dispatch");
  assert.deepEqual(boundary.candidates, []);
  graph.close();
});

test("RTA narrows virtual candidates to instantiated implementations", async () => {
  const file = codeFile("Rta.java", { format: "java" });
  const source = {
    kind: "text",
    file,
    text: `interface Runner { void run(); }
class Alpha implements Runner { public void run() {} }
class Beta implements Runner { public void run() {} }
class Use {
  void invoke(Runner value) { value.run(); }
  void create() { new Alpha(); }
}
`,
  };
  const input = await extractSourceGraph(source);
  const invoke = input.nodes.find((node) => node.name === "invoke");
  const create = input.nodes.find((node) => node.name === "create");
  const alphaType = input.nodes.find((node) => node.name === "Alpha");
  const alphaRun = memberIn(input, "Alpha", "run");
  assert.ok(invoke && create && alphaType && alphaRun);
  assert.ok(input.edges.some((edge) => edge.kind === "INSTANTIATES"));

  const graph = await resolveGraph(file, input);
  assert.equal(
    graph.edges([create.id, alphaType.id], ["INSTANTIATES"], 10).edges.length,
    1,
  );
  assert.equal(graph.dynamicBoundaries([invoke.id], 10).length, 0);
  assert.deepEqual(
    graph.callees(invoke.id, 1, 10).map((candidate) => candidate.id),
    [alphaRun.id],
  );
  const edge = graph.edges([invoke.id, alphaRun.id], ["CALLS"], 10).edges[0];
  assert.equal(edge?.provenance, "heuristic");
  assert.equal(edge?.evidence, "receiver_type_member");
  graph.close();
});

test("production dispatch is not narrowed by test-only instantiations", async () => {
  const sourceFile = codeFile("src/dispatch.ts", {
    id: "dispatch-source",
  });
  const testFile = codeFile("test/dispatch.test.ts", {
    id: "dispatch-test",
  });
  const source = await extractGraph(
    sourceFile,
    `export abstract class Runner { abstract run(): void; }
export class ProductionRunner extends Runner { run() {} }
export class Use { invoke(value: Runner) { value.run(); } }`,
  );
  const testInput = await extractGraph(
    testFile,
    `import { Runner } from "../src/dispatch";
class TestRunner extends Runner { run() {} }
export function makeTestRunner() { return new TestRunner(); }`,
  );
  const invoke = source.nodes.find((node) => node.name === "invoke");
  const productionRun = memberIn(source, "ProductionRunner", "run");
  assert.ok(invoke && productionRun);

  const graph = new SqliteGraphStorage("", { inMemory: true });
  upsertGraph(graph, sourceFile, source);
  upsertGraph(graph, testFile, testInput);
  await graph.resolvePending({ files: [sourceFile, testFile] });

  assert.deepEqual(graph.callees(invoke.id, 1, 10), []);
  const boundary = graph.dynamicBoundaries([invoke.id], 10)[0];
  assert.ok(boundary);
  assert.equal(boundary.reason, "polymorphic_dispatch");
  assert.ok(boundary.candidates.includes(productionRun.id));
  graph.close();
});

test("changing the only maker from Alpha to Beta reprojects virtual dispatch", async () => {
  const {
    file: typesFile,
    input: types,
    invoke,
    alphaRun,
    betaRun,
  } = await javaRtaTypes("IncrementalTypes.java", "types");
  const makerFile = codeFile("Maker.java", { id: "maker", format: "java" });
  assert.ok(invoke && alphaRun && betaRun);
  const graph = new SqliteGraphStorage("", { inMemory: true });
  upsertGraph(graph, typesFile, types);
  await graph.resolvePending();
  assert.ok(graph.dynamicBoundaries([invoke.id], 10)[0]);

  const maker = await extractGraph(
    makerFile,
    "class Maker { void make() { new Alpha(); } }",
  );
  upsertGraph(graph, makerFile, maker);
  await graph.resolvePending();

  assert.equal(graph.dynamicBoundaries([invoke.id], 10).length, 0);
  assert.deepEqual(
    graph.callees(invoke.id, 1, 10).map((candidate) => candidate.id),
    [alphaRun.id],
  );

  const changedMaker = await extractGraph(
    makerFile,
    "class Maker { void make() { new Beta(); } }",
  );
  graph.upsertFileGraph(
    makerFile.id,
    changedMaker.nodes,
    changedMaker.edges,
    changedMaker.refs,
  );
  await graph.resolvePending();

  assert.deepEqual(
    graph.callees(invoke.id, 1, 10).map((candidate) => candidate.id),
    [betaRun.id],
  );
  graph.close();
});

test("deleting the only maker removes the stale RTA projection", async () => {
  const {
    file: typesFile,
    input: types,
    invoke,
  } = await javaRtaTypes("DeleteMakerTypes.java", "delete-types");
  const makerFile = codeFile("DeleteMaker.java", {
    id: "delete-maker",
    format: "java",
  });
  assert.ok(invoke);
  const maker = await extractGraph(
    makerFile,
    "class Maker { void make() { new Alpha(); } }",
  );
  const graph = new SqliteGraphStorage("", { inMemory: true });
  upsertGraph(graph, typesFile, types);
  upsertGraph(graph, makerFile, maker);
  await graph.resolvePending();
  assert.equal(graph.dynamicBoundaries([invoke.id], 10).length, 0);

  graph.deleteFileGraph(makerFile.id);
  await graph.resolvePending();

  assert.equal(graph.callees(invoke.id, 1, 10).length, 0);
  assert.equal(
    graph.dynamicBoundaries([invoke.id], 10)[0]?.reason,
    "polymorphic_dispatch",
  );
  graph.close();
});

test("removing one of multiple Alpha makers keeps the stable RTA projection", async () => {
  const {
    file: typesFile,
    input: types,
    invoke,
    alphaRun,
  } = await javaRtaTypes("MultiMakerTypes.java", "multi-types");
  const makerAFile = codeFile("MakerA.java", { id: "maker-a", format: "java" });
  const makerBFile = codeFile("MakerB.java", { id: "maker-b", format: "java" });
  assert.ok(invoke && alphaRun);
  const makerA = await extractGraph(
    makerAFile,
    "class MakerA { void make() { new Alpha(); } }",
  );
  const makerB = await extractGraph(
    makerBFile,
    "class MakerB { void make() { new Alpha(); } }",
  );
  const graph = new SqliteGraphStorage("", { inMemory: true });
  upsertGraph(graph, typesFile, types);
  upsertGraph(graph, makerAFile, makerA);
  upsertGraph(graph, makerBFile, makerB);
  await graph.resolvePending();

  graph.deleteFileGraph(makerAFile.id);
  await graph.resolvePending();

  assert.equal(graph.dynamicBoundaries([invoke.id], 10).length, 0);
  assert.deepEqual(
    graph.callees(invoke.id, 1, 10).map((candidate) => candidate.id),
    [alphaRun.id],
  );
  graph.close();
});

test("Java RTA never promotes instantiated unrelated same-name methods", async () => {
  const file = codeFile("NominalRta.java", { format: "java" });
  const source = {
    kind: "text",
    file,
    text: `interface Runner { void run(); void stop(); }
class Alpha implements Runner { public void run() {} public void stop() {} }
class Unrelated { public void run() {} }
class Use {
  void invoke(Runner value) { value.run(); }
  void make() { new Unrelated(); }
}
`,
  };
  const input = await extractSourceGraph(source);
  const invoke = input.nodes.find((node) => node.name === "invoke");
  const unrelatedRun = input.nodes.find((node) => {
    if (node.name !== "run") return false;
    const parent = input.edges.find(
      (edge) => edge.kind === "CONTAINS" && edge.dst === node.id,
    )?.src;
    return (
      input.nodes.find((candidate) => candidate.id === parent)?.name ===
      "Unrelated"
    );
  });
  assert.ok(invoke && unrelatedRun);

  const graph = await resolveGraph(file, input);

  assert.equal(
    graph
      .callees(invoke.id, 1, 10)
      .some((candidate) => candidate.id === unrelatedRun.id),
    false,
  );
  const boundary = graph.dynamicBoundaries([invoke.id], 10)[0];
  assert.ok(boundary);
  assert.equal(boundary.candidates.includes(unrelatedRun.id), false);
  graph.close();
});

test("dynamic candidate selection filters overloads by call arity", async () => {
  const file = codeFile("Overload.java", { format: "java" });
  const source = {
    kind: "text",
    file,
    text: `class Target {
  void run() {}
  void run(int value) {}
}
class Use { void invoke(Target value) { value.run(1); } }
`,
  };
  const input = await extractSourceGraph(source);
  const invoke = input.nodes.find((node) => node.name === "invoke");
  const oneArg = input.nodes.find(
    (node) => node.name === "run" && node.arity === 1,
  );
  assert.ok(invoke && oneArg);
  const graph = await resolveGraph(file, input);
  assert.deepEqual(
    graph.callees(invoke.id, 1, 10).map((candidate) => candidate.id),
    [oneArg.id],
  );
  graph.close();
});

test("resolved dispatch facts are recomputed when a later override is indexed", async () => {
  const workerFile = codeFile("worker.ts", { id: "worker-file" });
  const callerFile = codeFile("caller.ts", { id: "caller-file" });
  const specialFile = codeFile("special.ts", { id: "special-file" });
  const worker = await extractGraph(
    workerFile,
    "export class Worker { help() {} }",
  );
  const caller = await extractGraph(
    callerFile,
    'import { Worker } from "./worker"; export function invoke(value: Worker) { value.help(); }',
  );
  const invoke = caller.nodes.find((node) => node.name === "invoke");
  const workerHelp = worker.nodes.find((node) => node.name === "help");
  assert.ok(invoke && workerHelp);

  const graph = new SqliteGraphStorage("", { inMemory: true });
  upsertGraph(graph, workerFile, worker);
  upsertGraph(graph, callerFile, caller);
  await graph.resolvePending({ files: [workerFile, callerFile] });
  assert.deepEqual(
    graph.callees(invoke.id, 1, 10).map((candidate) => candidate.id),
    [workerHelp.id],
  );

  const special = await extractGraph(
    specialFile,
    'import { Worker } from "./worker"; export class Special extends Worker { help() {} }',
  );
  graph.upsertFileGraph(
    specialFile.id,
    special.nodes,
    special.edges,
    special.refs,
  );
  await graph.resolvePending({ files: [workerFile, callerFile, specialFile] });

  const boundary = graph.dynamicBoundaries([invoke.id], 10)[0];
  assert.ok(boundary);
  assert.equal(boundary.reason, "polymorphic_dispatch");
  assert.equal(boundary.candidates.length, 2);
  assert.equal(graph.callees(invoke.id, 1, 10).length, 0);
  graph.close();
});

test("target file rebuild preserves structured dispatch facts", async () => {
  const workerFile = codeFile("worker.ts", { id: "worker-file" });
  const otherFile = codeFile("other.ts", { id: "other-file" });
  const callerFile = codeFile("caller.ts", { id: "caller-file" });
  const worker = await extractGraph(
    workerFile,
    "export class Worker { help() {} }",
  );
  const other = await extractGraph(
    otherFile,
    "export class Other { help() {} }",
  );
  const caller = await extractGraph(
    callerFile,
    'import { Worker } from "./worker"; export function invoke(value: Worker) { value.help(); }',
  );
  const invoke = caller.nodes.find((node) => node.name === "invoke");
  const workerHelp = worker.nodes.find((node) => node.name === "help");
  assert.ok(invoke && workerHelp);

  const graph = new SqliteGraphStorage("", { inMemory: true });
  upsertGraph(graph, workerFile, worker);
  upsertGraph(graph, otherFile, other);
  upsertGraph(graph, callerFile, caller);
  await graph.resolvePending({ files: [workerFile, otherFile, callerFile] });

  upsertGraph(graph, workerFile, worker);
  await graph.resolvePending({ files: [workerFile, otherFile, callerFile] });

  assert.deepEqual(
    graph.callees(invoke.id, 1, 10).map((candidate) => candidate.id),
    [workerHelp.id],
  );
  const edge = graph.edges([invoke.id, workerHelp.id], ["CALLS"], 10).edges[0];
  assert.equal(edge?.provenance, "heuristic");
  assert.equal(edge?.confidence, 0.75);
  assert.equal(edge?.evidence, "receiver_type_member");
  graph.close();
});
