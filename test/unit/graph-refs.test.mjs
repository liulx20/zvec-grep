import assert from "node:assert/strict";
import test from "node:test";
import { CodeExtractor } from "../../dist/engine/extraction/code/extractor.js";
import {
  SqliteGraphStorage,
  extractFileGraph,
} from "../../dist/engine/graph/index.js";

function codeFile(relativePath = "mod.ts", format = "typescript") {
  return {
    id: "file-1",
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

test("extractFileGraph builds local REFS for type annotations", async () => {
  const file = codeFile("types.ts");
  const text = `
export class Helper {}
export type Result = { ok: true };

export function run(x: Helper): Result {
  const z: Helper = x;
  return { ok: true };
}
`;
  const source = { kind: "text", text, file };
  const fragments = await new CodeExtractor().extract(source);
  const graphInput = await extractFileGraph(source, fragments);

  const refs = graphInput.edges.filter((e) => e.kind === "REFS");
  assert.ok(
    refs.some((e) => e.rel === "type" && e.ref_name === "Helper"),
    "param/local type Helper should be REFS",
  );
  assert.ok(
    refs.some((e) => e.rel === "return" && e.ref_name === "Result"),
    "return type Result should be REFS",
  );
  assert.equal(
    refs.some((e) => e.ref_name === "string" || e.ref_name === "true"),
    false,
    "predefined / literal types should be dropped",
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
  const helper = graphInput.nodes.find((n) => n.name === "Helper");
  assert.ok(run && helper);
  const usages = graph.usages(helper.id, 20);
  assert.ok(
    usages.some((u) => u.id === run.id && u.rel === "type"),
    "Helper should have REFS usage from run",
  );
  graph.close();
});

test("same-line reference occurrences remain distinct graph facts", async () => {
  const file = codeFile("occurrences.ts");
  const text = `
function target() {}
function consume(...values: unknown[]) {}
class Model {}
function wire(obj: { field: number }) {
  consume(target, target); const total = obj.field + obj.field;
  return total;
}
function typed(left: Model, right: Model) { return left ?? right; }
`;
  const source = { kind: "text", text, file };
  const fragments = await new CodeExtractor().extract(source);
  const graphInput = await extractFileGraph(source, fragments);
  const wire = graphInput.nodes.find((node) => node.name === "wire");
  const target = graphInput.nodes.find((node) => node.name === "target");
  assert.ok(wire && target);

  assert.equal(
    graphInput.edges.filter(
      (edge) =>
        edge.kind === "REFS" &&
        edge.src === wire.id &&
        edge.dst === target.id &&
        edge.rel === "function",
    ).length,
    2,
  );
  assert.equal(
    graphInput.refs.filter(
      (ref) => ref.ref_kind === "member" && ref.ref_name === "obj.field",
    ).length,
    2,
  );
  const typed = graphInput.nodes.find((node) => node.name === "typed");
  const model = graphInput.nodes.find((node) => node.name === "Model");
  assert.ok(typed && model);
  assert.equal(
    graphInput.edges.filter(
      (edge) =>
        edge.kind === "REFS" &&
        edge.src === typed.id &&
        edge.dst === model.id &&
        edge.rel === "type",
    ).length,
    2,
  );
});

test("C++ field declarations create qualified type references", async () => {
  const file = codeFile("pipeline.h", "cpp");
  const text = `
namespace app {
class Pipeline {};
class Holder {
 private:
  app::Pipeline pipeline_;
};
}
`;
  const source = { kind: "text", text, file };
  const fragments = await new CodeExtractor().extract(source);
  const graphInput = await extractFileGraph(source, fragments);
  const holder = graphInput.nodes.find((node) => node.name === "Holder");
  const pipeline = graphInput.nodes.find((node) => node.name === "Pipeline");
  assert.ok(holder && pipeline);
  assert.ok(
    graphInput.edges.some(
      (edge) =>
        edge.kind === "REFS" &&
        edge.src === holder.id &&
        edge.dst === pipeline.id &&
        edge.rel === "type" &&
        edge.ref_name === "app::Pipeline",
    ),
  );
});

test("Java field types are type references rather than return references", async () => {
  const file = codeFile("Controller.java", "java");
  const text = `
interface Repository {}
class Controller {
  private final Repository repository;
  Controller(Repository repository) { this.repository = repository; }
  Repository current() { return repository; }
}
`;
  const source = { kind: "text", text, file };
  const fragments = await new CodeExtractor().extract(source);
  const graphInput = await extractFileGraph(source, fragments);
  const controller = graphInput.nodes.find(
    (node) => node.name === "Controller",
  );
  const current = graphInput.nodes.find((node) => node.name === "current");
  const repository = graphInput.nodes.find(
    (node) => node.name === "Repository",
  );
  assert.ok(controller && current && repository);
  assert.ok(
    graphInput.edges.some(
      (edge) =>
        edge.kind === "REFS" &&
        edge.src === controller.id &&
        edge.dst === repository.id &&
        edge.rel === "type",
    ),
  );
  assert.equal(
    graphInput.edges.some(
      (edge) =>
        edge.kind === "REFS" &&
        edge.src === controller.id &&
        edge.dst === repository.id &&
        edge.rel === "return",
    ),
    false,
  );
  assert.ok(
    graphInput.edges.some(
      (edge) =>
        edge.kind === "REFS" &&
        edge.src === current.id &&
        edge.dst === repository.id &&
        edge.rel === "return",
    ),
  );
});

test("extractFileGraph collects member refs and skips call callees", async () => {
  const file = codeFile("members.ts");
  const text = `
export function field() { return 1; }
export function callTarget() { return 2; }

export function run(obj: { field: number }) {
  const a = obj.field;
  callTarget();
}
`;
  const source = { kind: "text", text, file };
  const fragments = await new CodeExtractor().extract(source);
  const graphInput = await extractFileGraph(source, fragments);

  const memberRef = graphInput.refs.find(
    (ref) => ref.ref_kind === "member" && ref.ref_name === "obj.field",
  );
  assert.ok(memberRef);
  assert.deepEqual(memberRef.target, {
    raw: "obj.field",
    member: "field",
    receiver: { kind: "qualified", name: "obj" },
  });
  // callTarget should be CALLS, not member REFS
  assert.ok(
    graphInput.edges.some(
      (e) => e.kind === "CALLS" && e.ref_name === "callTarget",
    ),
  );
});

test("qualified call callees do not emit detached bare member refs", async () => {
  const file = codeFile("qualified-call.ts");
  const source = {
    kind: "text",
    file,
    text: `class Base {
  helper() { return 1; }
}
class Child extends Base {
  run() { return this.helper(); }
}
class Override {
  helper() { return 2; }
}`,
  };
  const graphInput = await extractFileGraph(
    source,
    await new CodeExtractor().extract(source),
  );
  const run = graphInput.nodes.find((node) => node.name === "run");
  assert.ok(run);
  assert.ok(
    graphInput.edges.some(
      (edge) =>
        edge.src === run.id &&
        edge.kind === "CALLS" &&
        edge.ref_name === "this.helper",
    ),
  );
  assert.equal(
    graphInput.edges.some(
      (edge) =>
        edge.src === run.id &&
        edge.kind === "REFS" &&
        edge.ref_name === "helper",
    ),
    false,
  );
  assert.equal(
    graphInput.refs.some(
      (ref) =>
        ref.owner === run.id &&
        ref.ref_kind === "member" &&
        ref.ref_name === "helper",
    ),
    false,
  );
});

test("extractFileGraph resolves cross-file type REFS", async () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  const a = {
    ...codeFile("a.ts"),
    id: "file-a",
  };
  const b = {
    ...codeFile("b.ts"),
    id: "file-b",
  };
  const textA = `export function run(x: Helper) { return x; }`;
  const textB = `export class Helper {}`;

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
    gA.refs.some((r) => r.ref_kind === "type" && r.ref_name === "Helper"),
  );

  graph.upsertFileGraph(a.id, gA.nodes, gA.edges, gA.refs);
  graph.upsertFileGraph(b.id, gB.nodes, gB.edges, gB.refs);
  await graph.resolvePending();

  const run = gA.nodes.find((n) => n.name === "run");
  const helper = gB.nodes.find((n) => n.name === "Helper");
  assert.ok(run && helper);
  assert.ok(graph.usages(helper.id, 10).some((u) => u.id === run.id));
  graph.close();
});

test("module values create scope-aware REFS across supported languages", async () => {
  const fixtures = [
    [
      "typescript",
      "const CONFIG = { rows: 10 }; function reads() { return CONFIG.rows; } function shadows(CONFIG: { rows: number }) { return CONFIG.rows; }",
    ],
    [
      "go",
      "package fixture\nconst CONFIG = 10\nfunc reads() int { return CONFIG }\nfunc shadows(CONFIG int) int { return CONFIG }\n",
    ],
    [
      "rust",
      "const CONFIG: u32 = 10; fn reads() -> u32 { CONFIG } fn shadows(CONFIG: u32) -> u32 { CONFIG }",
    ],
    [
      "python",
      "CONFIG = 10\ndef reads(): return CONFIG\ndef shadows(CONFIG): return CONFIG\n",
    ],
  ];

  for (const [format, text] of fixtures) {
    const file = codeFile(`values.${format}`, format);
    const source = { kind: "text", file, text };
    const analysis = await new CodeExtractor().analyzeForIndexing(source);
    const input = await extractFileGraph(
      source,
      analysis.fragments.map((item) => item.fragment),
      analysis,
    );
    const value = input.nodes.find((node) => node.name === "CONFIG");
    const reads = input.nodes.find((node) => node.name === "reads");
    const shadows = input.nodes.find((node) => node.name === "shadows");
    assert.ok(value && reads && shadows, format);
    assert.ok(
      input.edges.some(
        (edge) =>
          edge.kind === "REFS" &&
          edge.rel === "value" &&
          edge.src === reads.id &&
          edge.dst === value.id,
      ),
      `${format}: reader should reference its module value`,
    );
    assert.equal(
      input.edges.some(
        (edge) =>
          edge.kind === "REFS" &&
          edge.src === shadows.id &&
          edge.dst === value.id,
      ),
      false,
      `${format}: parameter shadow must suppress the outer value edge`,
    );

    const graph = new SqliteGraphStorage("", { inMemory: true });
    graph.upsertFileGraph(file.id, input.nodes, input.edges, input.refs);
    await graph.resolvePending();
    assert.ok(
      graph.impact(value.id, 1, 10).some((node) => node.id === reads.id),
    );
    assert.equal(
      graph.impact(value.id, 1, 10).some((node) => node.id === shadows.id),
      false,
    );
    graph.close();
  }
});

test("module value initializers retain value-to-value impact dependencies", async () => {
  const fixtures = [
    [
      "typescript",
      "const BASE = 10; const DERIVED = BASE + 1; function reads() { return DERIVED; }",
    ],
    [
      "go",
      "package fixture\nconst BASE = 10\nconst DERIVED = BASE + 1\nfunc reads() int { return DERIVED }\n",
    ],
    [
      "rust",
      "const BASE: u32 = 10; const DERIVED: u32 = BASE + 1; fn reads() -> u32 { DERIVED }",
    ],
    ["python", "BASE = 10\nDERIVED = BASE + 1\ndef reads(): return DERIVED\n"],
  ];

  for (const [format, text] of fixtures) {
    const file = codeFile(`value-chain.${format}`, format);
    const source = { kind: "text", file, text };
    const analysis = await new CodeExtractor().analyzeForIndexing(source);
    const input = await extractFileGraph(
      source,
      analysis.fragments.map((item) => item.fragment),
      analysis,
    );
    const base = input.nodes.find((node) => node.name === "BASE");
    const derived = input.nodes.find((node) => node.name === "DERIVED");
    const reads = input.nodes.find((node) => node.name === "reads");
    assert.ok(base && derived && reads, format);
    assert.ok(
      input.edges.some(
        (edge) =>
          edge.kind === "REFS" &&
          edge.rel === "value" &&
          edge.src === derived.id &&
          edge.dst === base.id,
      ),
      `${format}: derived value should depend on its initializer input`,
    );
    assert.ok(
      input.edges.some(
        (edge) =>
          edge.kind === "REFS" &&
          edge.rel === "value" &&
          edge.src === reads.id &&
          edge.dst === derived.id,
      ),
      `${format}: reader should depend on the derived value`,
    );
  }
});

test("conditional Python module values retain impact edges for every branch", async () => {
  const file = codeFile("conditional.py", "python");
  const text = `try:
    HAS_SSL = True
except ImportError:
    HAS_SSL = False

def reads_ssl():
    return HAS_SSL
`;
  const source = { kind: "text", file, text };
  const analysis = await new CodeExtractor().analyzeForIndexing(source);
  const input = await extractFileGraph(
    source,
    analysis.fragments.map((item) => item.fragment),
    analysis,
  );
  const values = input.nodes.filter((node) => node.name === "HAS_SSL");
  const reads = input.nodes.find((node) => node.name === "reads_ssl");
  assert.equal(values.length, 2);
  assert.ok(reads);
  assert.deepEqual(
    new Set(
      input.edges
        .filter(
          (edge) =>
            edge.kind === "REFS" &&
            edge.rel === "value" &&
            edge.src === reads.id,
        )
        .map((edge) => edge.dst),
    ),
    new Set(values.map((node) => node.id)),
  );
});

test("Java static final fields create owner-scoped value dependencies", async () => {
  const file = codeFile("Limits.java", "java");
  const text = `class Limits {
  static final int TIMEOUT = 30;
  final int instanceId = 1;
  int reads() { return TIMEOUT; }
  int shadows() { int TIMEOUT = 5; return TIMEOUT; }
  int readsInstance() { return instanceId; }
}
class OtherLimits {
  static final int TIMEOUT = 60;
  int reads() { return TIMEOUT; }
}`;
  const source = { kind: "text", file, text };
  const analysis = await new CodeExtractor().analyzeForIndexing(source);
  const input = await extractFileGraph(
    source,
    analysis.fragments.map((item) => item.fragment),
    analysis,
  );
  const values = input.nodes.filter((node) => node.name === "TIMEOUT");
  assert.equal(values.length, 2);
  assert.equal(
    input.nodes.some((node) => node.name === "instanceId"),
    false,
    "instance final fields are mutable per object and are not value targets",
  );
  const containers = new Map(
    input.edges
      .filter((edge) => edge.kind === "CONTAINS")
      .map((edge) => [edge.dst, edge.src]),
  );
  const readers = input.nodes.filter((node) => node.name === "reads");
  assert.equal(readers.length, 2);
  for (const reader of readers) {
    const owner = containers.get(reader.id);
    const expected = values.find((value) => containers.get(value.id) === owner);
    assert.ok(expected);
    assert.deepEqual(
      input.edges
        .filter(
          (edge) =>
            edge.kind === "REFS" &&
            edge.rel === "value" &&
            edge.src === reader.id,
        )
        .map((edge) => edge.dst),
      [expected.id],
    );
  }
  const shadows = input.nodes.find((node) => node.name === "shadows");
  assert.ok(shadows);
  assert.equal(
    input.edges.some((edge) => edge.kind === "REFS" && edge.src === shadows.id),
    false,
  );
});

test("function values create REFS without confusing calls, classes, or shadows", async () => {
  const file = codeFile("callbacks.ts", "typescript");
  const text = `function targetCb() {}
class Strategy {}
function consume(value: unknown) {}
function direct() { targetCb(); }
function wire() { consume(targetCb); consume(Strategy); }
function shadow(targetCb: unknown) { consume(targetCb); }
function self() { consume(self); }`;
  const source = { kind: "text", file, text };
  const analysis = await new CodeExtractor().analyzeForIndexing(source);
  const input = await extractFileGraph(
    source,
    analysis.fragments.map((item) => item.fragment),
    analysis,
  );
  const id = (name) => input.nodes.find((node) => node.name === name)?.id;
  assert.ok(id("targetCb") && id("wire") && id("direct") && id("shadow"));
  assert.ok(
    input.edges.some(
      (edge) =>
        edge.kind === "REFS" &&
        edge.rel === "function" &&
        edge.src === id("wire") &&
        edge.dst === id("targetCb"),
    ),
  );
  assert.ok(
    input.edges.some(
      (edge) =>
        edge.kind === "CALLS" &&
        edge.src === id("direct") &&
        edge.dst === id("targetCb"),
    ),
  );
  assert.equal(
    input.edges.some(
      (edge) =>
        edge.kind === "REFS" &&
        (edge.src === id("shadow") || edge.src === id("self")),
    ),
    false,
  );
  assert.equal(
    input.edges.some(
      (edge) => edge.kind === "REFS" && edge.dst === id("Strategy"),
    ),
    false,
  );
});

test("callback registration forms retain precise function-value dependencies", async () => {
  const cases = [
    {
      file: codeFile("callbacks.c", "c"),
      text: `
struct ops { void (*recv_cb)(int); };
static void target_cb(int x) { (void)x; }
void consume_cb(void (*cb)(int)) { cb(1); }
void arg_registrar(void) { consume_cb(target_cb); }
void addr_registrar(void) { consume_cb(&target_cb); }
void assign_registrar(struct ops *o) { o->recv_cb = target_cb; }
static struct ops global_ops = { .recv_cb = target_cb };
`,
      owners: [
        "arg_registrar",
        "addr_registrar",
        "assign_registrar",
        "global_ops",
      ],
      target: "target_cb",
    },
    {
      file: codeFile("callbacks.ts", "typescript"),
      text: `
function targetCb(x: number): void {}
function consumeCb(cb: (x: number) => void): void {}
function argRegistrar(): void { consumeCb(targetCb); }
function objectRegistrar(): unknown { return { recv: targetCb }; }
function arrayRegistrar(): unknown { return [targetCb]; }
class Comp {
  handleClick(): void {}
  wire(btn: { on(cb: () => void): void }): void { btn.on(this.handleClick); }
}
`,
      owners: ["argRegistrar", "objectRegistrar", "arrayRegistrar"],
      target: "targetCb",
      methodOwner: "wire",
      methodTarget: "handleClick",
    },
    {
      file: codeFile("callbacks.py", "python"),
      text: `
def consume_cb(cb): pass
class Worker:
    def handle(self): pass
    def wire(self): consume_cb(self.handle)
`,
      owners: [],
      target: "handle",
      methodOwner: "wire",
      methodTarget: "handle",
    },
    {
      file: codeFile("callbacks.go", "go"),
      text: `
package fixture
type Worker struct{}
func (w *Worker) Handle() {}
func Consume(cb func()) {}
func Wire(w *Worker) { Consume(w.Handle) }
`,
      owners: [],
      target: "Handle",
      methodOwner: "Wire",
      methodTarget: "Handle",
    },
    {
      file: codeFile("callbacks.rs", "rust"),
      text: `
struct Worker;
impl Worker { fn handle(&self) {} }
fn consume(cb: fn(&Worker)) {}
fn wire() { consume(Worker::handle); }
`,
      owners: [],
      target: "handle",
      methodOwner: "wire",
      methodTarget: "handle",
    },
    {
      file: codeFile("Callbacks.java", "java"),
      text: `
class Callbacks {
  void consume(Runnable cb) {}
  void handle() {}
  void wire() { consume(this::handle); }
}
`,
      owners: [],
      target: "handle",
      methodOwner: "wire",
      methodTarget: "handle",
    },
  ];

  for (const fixture of cases) {
    const source = { kind: "text", file: fixture.file, text: fixture.text };
    const analysis = await new CodeExtractor().analyzeForIndexing(source);
    const input = await extractFileGraph(
      source,
      analysis.fragments.map((item) => item.fragment),
      analysis,
    );
    const node = (name) => input.nodes.find((item) => item.name === name);
    const target = node(fixture.target);
    assert.ok(target, fixture.file.format);
    for (const ownerName of fixture.owners) {
      const owner = node(ownerName);
      assert.ok(owner, `${fixture.file.format}: ${ownerName}`);
      assert.ok(
        input.edges.some(
          (edge) =>
            edge.kind === "REFS" &&
            edge.rel === "function" &&
            edge.src === owner.id &&
            edge.dst === target.id,
        ),
        `${fixture.file.format}: ${ownerName} -> ${fixture.target}`,
      );
    }
    if (fixture.methodOwner && fixture.methodTarget) {
      const owner = node(fixture.methodOwner);
      const method = node(fixture.methodTarget);
      assert.ok(owner && method);
      assert.ok(
        input.edges.some(
          (edge) =>
            edge.kind === "REFS" &&
            edge.rel === "function" &&
            edge.src === owner.id &&
            edge.dst === method.id,
        ),
        `${fixture.file.format}: ${fixture.methodOwner} -> ${fixture.methodTarget}`,
      );
    }
  }
});

test("imported function values resolve only to callable symbols", async () => {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  const handlerFile = { ...codeFile("handlers.ts"), id: "handlers" };
  const wiringFile = { ...codeFile("wiring.ts"), id: "wiring" };
  const handlerSource = {
    kind: "text",
    file: handlerFile,
    text: "export function onMessage() {} export class Strategy {}",
  };
  const wiringSource = {
    kind: "text",
    file: wiringFile,
    text: `import { onMessage, Strategy } from "./handlers";
function consume(value: unknown) {}
export function wire() { consume(onMessage); consume(Strategy); }`,
  };
  const nodes = [];
  for (const source of [handlerSource, wiringSource]) {
    const analysis = await new CodeExtractor().analyzeForIndexing(source);
    const input = await extractFileGraph(
      source,
      analysis.fragments.map((item) => item.fragment),
      analysis,
    );
    nodes.push(...input.nodes);
    graph.upsertFileGraph(source.file.id, input.nodes, input.edges, input.refs);
  }
  await graph.resolvePending({ files: [handlerFile, wiringFile] });
  const onMessage = nodes.find((node) => node.name === "onMessage");
  const strategy = nodes.find((node) => node.name === "Strategy");
  const wire = nodes.find((node) => node.name === "wire");
  assert.ok(onMessage && strategy && wire);
  assert.ok(
    graph
      .outgoingEdges([wire.id], ["REFS"], 20)
      .some((edge) => edge.dst === onMessage.id && edge.rel === "function"),
  );
  assert.equal(
    graph
      .outgoingEdges([wire.id], ["REFS"], 20)
      .some((edge) => edge.dst === strategy.id),
    false,
  );
  assert.equal(graph.stats().failedRefCount, 0);
  graph.close();
});
