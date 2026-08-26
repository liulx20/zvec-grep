import assert from "node:assert/strict";
import test from "node:test";
import {
  formatExploreResult,
  formatNeighborhoodResult,
} from "../../dist/presentation/graph.js";

test("ambiguous neighborhood output includes usable seed ids and locations", () => {
  const entity = (entityId, kind, startLine) => ({
    entityId,
    name: "Service",
    kind,
    file: { id: "file-a", relativePath: "src/service.ts" },
    range: {
      kind: "text",
      startLine,
      endLine: startLine,
      startOffset: 0,
      endOffset: 10,
    },
  });
  const output = formatNeighborhoodResult({
    available: true,
    direction: "impact",
    query: "Service",
    depth: 1,
    limit: 20,
    ambiguous: true,
    seeds: [
      { id: "class-id", entity: entity("class-id", "class", 10) },
      {
        id: "constructor-id",
        entity: entity("constructor-id", "function", 12),
      },
    ],
    neighbors: [],
  });

  assert.match(
    output,
    /Service \(src\/service\.ts:10\) kind=class id=class-id/,
  );
  assert.match(output, /kind=function id=constructor-id/);
  assert.match(output, /--seed-id <id>/);
});

test("same-named neighborhood definitions render as isolated result groups", () => {
  const makeEntity = (entityId, path, name) => ({
    entityId,
    name,
    kind: "class",
    file: { id: `file-${entityId}`, relativePath: path },
    range: { kind: "file" },
  });
  const left = makeEntity("left", "apps/left/service.ts", "Service");
  const right = makeEntity("right", "apps/right/service.ts", "Service");
  const output = formatNeighborhoodResult({
    available: true,
    direction: "callers",
    query: "Service",
    depth: 1,
    limit: 20,
    ambiguous: true,
    seeds: [
      { id: "left", entity: left },
      { id: "right", entity: right },
    ],
    groups: [
      {
        seed: { id: "left", entity: left },
        members: [{ id: "left", entity: left }],
        neighbors: [
          {
            id: "left-caller",
            entity: makeEntity(
              "left-caller",
              "apps/left/main.ts",
              "leftCaller",
            ),
          },
        ],
      },
      {
        seed: { id: "right", entity: right },
        members: [{ id: "right", entity: right }],
        neighbors: [
          {
            id: "right-caller",
            entity: makeEntity(
              "right-caller",
              "apps/right/main.ts",
              "rightCaller",
            ),
          },
        ],
      },
    ],
    fileFilterMismatch: "apps/missing/service.ts",
    neighbors: [],
  });

  assert.match(output, /definitions=2 depth=1 limit=20 per definition/);
  assert.match(output, /definition: Service \(apps\/left\/service\.ts\)/);
  assert.match(output, /leftCaller \(apps\/left\/main\.ts\)/);
  assert.match(output, /definition: Service \(apps\/right\/service\.ts\)/);
  assert.match(output, /rightCaller \(apps\/right\/main\.ts\)/);
  assert.match(output, /--definition-file <path>/);
  assert.match(
    output,
    /no definition of Service matches file apps\/missing\/service\.ts; showing all definitions/,
  );
});

test("neighborhood output reports truncation", () => {
  const output = formatNeighborhoodResult({
    available: true,
    direction: "impact",
    query: "Service",
    depth: 2,
    limit: 1,
    seeds: [],
    seed: {
      id: "service",
      entity: {
        entityId: "service",
        name: "Service",
        kind: "class",
        file: { id: "file-a", relativePath: "src/service.ts" },
        range: { kind: "file" },
      },
    },
    truncated: true,
    neighbors: [
      {
        id: "caller",
        kind: "function",
        entity: null,
      },
    ],
  });
  assert.match(output, /results=1 \(truncated; increase --limit above 1\)/);
});

test("explore formats one bounded global relationships section", () => {
  const file = { id: "file-a", relativePath: "src/a.ts" };
  const nodes = ["root", "a", "b", "c", "d", "e", "f", "g"].map((id) => ({
    id,
    isRoot: id === "root",
    entity: {
      name: id,
      kind: id === "root" ? "function" : "value",
      file,
    },
  }));
  const edge = (dst, kind = "CALLS") => ({
    src: "root",
    dst,
    kind,
    rel: kind.toLowerCase(),
    count: 1,
    firstLine: 1,
    refName: dst,
    provenance: "static",
    confidence: 1,
  });
  const output = formatExploreResult({
    available: true,
    query: "root",
    roots: [nodes[0]],
    nodes,
    edges: [
      edge("a"),
      edge("b"),
      edge("c"),
      edge("d"),
      edge("e"),
      edge("f"),
      edge("g"),
      edge("a", "CONTAINS"),
    ],
    edgesTruncated: false,
    callPaths: [],
    blastRadius: [],
    changeSurface: [],
    dynamicBoundaries: [],
    dynamicBoundariesTruncated: false,
    files: [
      {
        file,
        score: 1,
        isCentral: true,
        isChangeSurface: false,
        reasons: ["root(root)"],
        symbols: [],
        sourceOrigin: "current_disk",
        text: "export const a = 1;",
      },
    ],
  });

  assert.equal(output.match(/^relationships:$/gm)?.length, 1);
  assert.equal(output.includes("relations:"), false);
  assert.equal(output.includes("CONTAINS:"), false);
  assert.match(output, /do not re-read displayed ranges unless marked indexed/);
  assert.match(output, /CALLS:\n(?:- .*\n){6}- \.\.\. and 1 more/);
  assert.match(
    output,
    /src\/a\.ts \(central, score=1\.0000\)\nselected: root\(root\)\nsource:/,
  );
});

test("relationship summary retains edges between selected source snippets", () => {
  const file = { id: "flow", relativePath: "src/flow.ts" };
  const node = (id, isRoot = false) => ({
    id,
    isRoot,
    entity: { name: id, kind: "function", file },
  });
  const nodes = [
    node("root", true),
    node("execute"),
    node("activate"),
    ...Array.from({ length: 7 }, (_, index) => node(`noise-${index}`)),
  ];
  const call = (src, dst, firstLine) => ({
    src,
    dst,
    kind: "CALLS",
    rel: "call",
    count: 1,
    firstLine,
    refName: dst,
    provenance: "static",
    confidence: 1,
  });
  const output = formatExploreResult({
    available: true,
    query: "flow",
    roots: [nodes[0]],
    nodes,
    edges: [
      ...Array.from({ length: 7 }, (_, index) =>
        call(`noise-${index}`, `noise-${(index + 1) % 7}`, index + 1),
      ),
      call("execute", "activate", 100),
    ],
    edgesTruncated: false,
    callPaths: [],
    blastRadius: [],
    changeSurface: [],
    dynamicBoundaries: [],
    dynamicBoundariesTruncated: false,
    files: [
      {
        file,
        score: 1,
        isCentral: true,
        isChangeSurface: false,
        reasons: [],
        symbols: [
          {
            id: "execute",
            name: "execute",
            range: { kind: "file" },
            content: "function execute() {}",
          },
          {
            id: "activate",
            name: "activate",
            range: { kind: "file" },
            content: "function activate() {}",
          },
        ],
        text: "function execute() {}\nfunction activate() {}",
      },
    ],
  });

  assert.match(output, /execute -CALLS-> activate/);
});

test("relationship summary retains an outgoing call from selected source", () => {
  const file = { id: "flow", relativePath: "src/flow.ts" };
  const node = (id, isRoot = false) => ({
    id,
    isRoot,
    entity: {
      name: id,
      kind: "function",
      scope: "Flow",
      file,
    },
  });
  const root = node("root", true);
  const execute = node("execute");
  const activate = node("activate");
  const noise = Array.from({ length: 8 }, (_, index) => node(`noise-${index}`));
  const call = (src, dst, firstLine) => ({
    src,
    dst,
    kind: "CALLS",
    rel: "call",
    count: 1,
    firstLine,
    refName: dst,
    provenance: "static",
    confidence: 1,
  });
  const output = formatExploreResult({
    available: true,
    query: "flow",
    roots: [root],
    nodes: [root, execute, activate, ...noise],
    edges: [
      ...noise.map((item, index) =>
        call(item.id, noise[(index + 1) % noise.length].id, index + 1),
      ),
      call("execute", "activate", 100),
    ],
    edgesTruncated: false,
    callPaths: [],
    blastRadius: [],
    changeSurface: [],
    dynamicBoundaries: [],
    dynamicBoundariesTruncated: false,
    files: [
      {
        file,
        score: 1,
        isCentral: true,
        isChangeSurface: false,
        reasons: ["execute(definition)"],
        symbols: [
          {
            id: "execute",
            name: "execute",
            range: { kind: "file" },
            content: "function execute() { activate(); }",
          },
        ],
        text: "function execute() { activate(); }",
      },
    ],
  });

  assert.match(output, /execute -CALLS-> activate/);
});

test("relationship summary treats a root envelope as displayed", () => {
  const apiFile = { id: "api", relativePath: "src/api.py" };
  const appFile = { id: "app", relativePath: "src/app.py" };
  const root = {
    id: "Service",
    isRoot: true,
    entity: { name: "Service", kind: "class", file: apiFile },
  };
  const initialize = {
    id: "initialize",
    isRoot: false,
    entity: { name: "initialize", kind: "function", file: appFile },
  };
  const noise = Array.from({ length: 7 }, (_, index) => ({
    id: `noise-${index}`,
    isRoot: false,
    entity: { name: `noise-${index}`, kind: "function", file: apiFile },
  }));
  const call = (src, dst, firstLine) => ({
    src,
    dst,
    kind: "CALLS",
    rel: "call",
    count: 1,
    firstLine,
    refName: dst,
    provenance: "static",
    confidence: 1,
  });
  const output = formatExploreResult({
    available: true,
    query: "Service",
    roots: [root],
    nodes: [root, initialize, ...noise],
    edges: [
      ...noise.map((node, index) =>
        call(node.id, noise[(index + 1) % noise.length].id, index + 1),
      ),
      call("initialize", "Service", 100),
    ],
    edgesTruncated: false,
    callPaths: [],
    blastRadius: [],
    changeSurface: [],
    dynamicBoundaries: [],
    dynamicBoundariesTruncated: false,
    files: [
      {
        file: apiFile,
        score: 1,
        isCentral: true,
        isChangeSurface: false,
        reasons: ["Service(root)"],
        symbols: [],
        text: "class Service: pass",
      },
      {
        file: appFile,
        score: 0.5,
        isCentral: false,
        isChangeSurface: false,
        reasons: [],
        symbols: [
          {
            id: "initialize",
            name: "initialize",
            range: { kind: "file" },
            content: "def initialize(): return Service()",
          },
        ],
        text: "def initialize(): return Service()",
      },
    ],
  });

  assert.match(output, /initialize -CALLS-> Service/);
});

test("relationship summary prioritizes calls within one semantic container", () => {
  const file = { id: "flow", relativePath: "src/flow.ts" };
  const nodes = ["root", "Flow", "execute", "activate"]
    .concat(Array.from({ length: 7 }, (_, index) => `noise-${index}`))
    .map((id) => ({
      id,
      isRoot: id === "root",
      entity: {
        name: id,
        kind: id === "Flow" ? "class" : "function",
        file,
      },
    }));
  const edge = (src, dst, kind, firstLine) => ({
    src,
    dst,
    kind,
    rel: kind.toLowerCase(),
    count: 1,
    firstLine,
    refName: dst,
    provenance: "static",
    confidence: 1,
  });
  const output = formatExploreResult({
    available: true,
    query: "flow",
    roots: [nodes[0]],
    nodes,
    edges: [
      edge("Flow", "execute", "CONTAINS", 1),
      edge("Flow", "activate", "CONTAINS", 2),
      ...Array.from({ length: 7 }, (_, index) =>
        edge(`noise-${index}`, `noise-${(index + 1) % 7}`, "CALLS", index + 1),
      ),
      edge("execute", "activate", "CALLS", 100),
    ],
    edgesTruncated: false,
    callPaths: [],
    blastRadius: [],
    changeSurface: [],
    dynamicBoundaries: [],
    dynamicBoundariesTruncated: false,
    files: [
      {
        file,
        score: 1,
        isCentral: true,
        isChangeSurface: false,
        reasons: [],
        symbols: [],
        text: "class Flow {}",
      },
    ],
  });

  assert.match(output, /execute -CALLS-> activate/);
});

test("relationship ordering treats direct members as root context", () => {
  const file = { id: "app-file", relativePath: "src/app.ts" };
  const routerFile = { id: "router-file", relativePath: "src/router.ts" };
  const node = (id, root = false, targetFile = file) => ({
    id,
    isRoot: root,
    entity: { name: id, kind: root ? "class" : "function", file: targetFile },
  });
  const nodes = [
    node("App", true),
    node("render"),
    node("Router", true, routerFile),
    ...Array.from({ length: 7 }, (_, index) =>
      node(`noise-${index}`, false, routerFile),
    ),
  ];
  const refs = Array.from({ length: 7 }, (_, index) => ({
    src: "Router",
    dst: `noise-${index}`,
    kind: "REFS",
    rel: "type",
    count: 1,
    firstLine: index + 1,
    refName: `noise-${index}`,
    provenance: "static",
    confidence: 1,
  }));
  const output = formatExploreResult({
    available: true,
    query: "App Router",
    roots: [nodes[0], nodes[2]],
    nodes,
    edges: [
      {
        src: "App",
        dst: "render",
        kind: "CONTAINS",
        rel: "contains",
        count: 1,
        firstLine: 1,
        refName: "render",
        provenance: "static",
        confidence: 1,
      },
      {
        src: "render",
        dst: "Router",
        kind: "REFS",
        rel: "member",
        count: 1,
        firstLine: 2,
        refName: "Router",
        provenance: "static",
        confidence: 1,
      },
      ...refs,
    ],
    edgesTruncated: false,
    callPaths: [],
    blastRadius: [],
    changeSurface: [],
    dynamicBoundaries: [],
    dynamicBoundariesTruncated: false,
    files: [
      {
        file,
        score: 1,
        isCentral: true,
        isChangeSurface: false,
        reasons: [],
        symbols: [],
        text: "class App {}",
      },
      {
        file: routerFile,
        score: 0.5,
        isCentral: false,
        isChangeSurface: false,
        reasons: [],
        symbols: [],
        text: "class Router {}",
      },
    ],
  });

  assert.match(output, /render -REFS-> Router/);
});

test("relationship ordering groups out-of-line member definitions with the root", () => {
  const header = { id: "header", relativePath: "include/app/store.h" };
  const source = { id: "source", relativePath: "src/app/store.cc" };
  const entity = (id, name, kind, file) => ({
    entityId: id,
    name,
    kind,
    file,
    range: { kind: "file" },
  });
  const nodes = [
    {
      id: "Store",
      isRoot: true,
      entity: entity("Store", "Store", "class", header),
    },
    {
      id: "decl-dtor",
      isRoot: false,
      entity: entity("decl-dtor", "~Store", "function", header),
    },
    {
      id: "impl-container",
      isRoot: false,
      entity: entity("impl-container", "Store", "function", source),
    },
    {
      id: "impl-dtor",
      isRoot: false,
      entity: entity("impl-dtor", "~Store", "function", source),
    },
    {
      id: "close",
      isRoot: false,
      entity: entity("close", "Close", "function", source),
    },
    ...Array.from({ length: 7 }, (_, index) => ({
      id: `noise-${index}`,
      isRoot: false,
      entity: entity(`noise-${index}`, `noise${index}`, "function", source),
    })),
  ];
  const staticEdge = (src, dst, kind) => ({
    src,
    dst,
    kind,
    rel: kind.toLowerCase(),
    count: 1,
    firstLine: 1,
    refName: dst,
    provenance: "static",
    confidence: 1,
  });
  const output = formatExploreResult({
    available: true,
    query: "Store",
    roots: [nodes[0]],
    nodes,
    edges: [
      staticEdge("Store", "decl-dtor", "CONTAINS"),
      staticEdge("impl-container", "impl-dtor", "CONTAINS"),
      staticEdge("impl-dtor", "close", "CALLS"),
      ...Array.from({ length: 7 }, (_, index) =>
        staticEdge(`noise-${index}`, "close", "CALLS"),
      ),
    ],
    edgesTruncated: false,
    callPaths: [],
    blastRadius: [],
    changeSurface: [],
    dynamicBoundaries: [],
    dynamicBoundariesTruncated: false,
    files: [
      {
        file: header,
        score: 1,
        isCentral: true,
        isChangeSurface: false,
        reasons: [],
        symbols: [],
        text: "class Store {};",
      },
      {
        file: source,
        score: 0.5,
        isCentral: true,
        isChangeSurface: false,
        reasons: [],
        symbols: [],
        text: "Store::~Store() { Close(); }",
      },
    ],
  });

  assert.match(output, /~Store -CALLS-> Close/);
});

test("relationship ordering treats an out-of-line root definition as the root", () => {
  const header = { id: "header", relativePath: "include/app/coordinator.h" };
  const source = { id: "source", relativePath: "src/app/coordinator.cc" };
  const entity = (id, name, file) => ({
    entityId: id,
    name,
    kind: "function",
    file,
    range: { kind: "file" },
  });
  const nodes = [
    {
      id: "invoke-decl",
      isRoot: true,
      entity: entity("invoke-decl", "invoke", header),
    },
    {
      id: "invoke-def",
      isRoot: false,
      entity: entity("invoke-def", "invoke", source),
    },
    {
      id: "execute",
      isRoot: false,
      entity: entity("execute", "execute", source),
    },
    ...Array.from({ length: 7 }, (_, index) => ({
      id: `noise-${index}`,
      isRoot: false,
      entity: entity(`noise-${index}`, `noise${index}`, source),
    })),
  ];
  const edge = (src, dst, firstLine = 1) => ({
    src,
    dst,
    kind: "CALLS",
    rel: "calls",
    count: 1,
    firstLine,
    refName: dst,
    provenance: "static",
    confidence: 1,
  });
  const output = formatExploreResult({
    available: true,
    query: "invoke",
    roots: [nodes[0]],
    nodes,
    edges: [
      {
        ...edge("invoke-decl", "invoke-def"),
        kind: "COUNTERPART",
        rel: "counterpart",
      },
      edge("execute", "invoke-def", 100),
      ...Array.from({ length: 7 }, (_, index) =>
        edge(`noise-${index}`, "execute", index + 1),
      ),
    ],
    edgesTruncated: false,
    callPaths: [],
    blastRadius: [],
    changeSurface: [],
    dynamicBoundaries: [],
    dynamicBoundariesTruncated: false,
    files: [
      {
        file: header,
        score: 1,
        isCentral: true,
        isChangeSurface: false,
        reasons: [],
        symbols: [],
        text: "void invoke();",
      },
      {
        file: source,
        score: 0.5,
        isCentral: true,
        isChangeSurface: false,
        reasons: [],
        symbols: [],
        text: "void execute() { invoke(); }",
      },
    ],
  });

  assert.match(output, /execute -CALLS-> invoke/);
});

test("explore displays aggregated dynamic-boundary occurrences", () => {
  const output = formatExploreResult({
    available: true,
    query: "root",
    roots: [],
    nodes: [{ id: "root", isRoot: true, entity: null }],
    edges: [],
    edgesTruncated: false,
    callPaths: [],
    blastRadius: [],
    changeSurface: [],
    dynamicBoundaries: [
      {
        sourceId: "root",
        line: 12,
        target: { raw: "value.run", member: "run" },
        reason: "polymorphic_dispatch",
        candidates: ["candidate"],
        candidatesTruncated: false,
        occurrenceCount: 3,
        candidateDetails: [
          {
            targetId: "candidate",
            displayName: "Runner::run",
            reason: "hierarchy",
            confidence: 0.65,
          },
        ],
      },
    ],
    dynamicBoundariesTruncated: false,
    files: [
      {
        file: { id: "root-file", relativePath: "root.ts" },
        score: 1,
        isCentral: true,
        isChangeSurface: false,
        reasons: ["root(root)"],
        symbols: [],
        text: "function root() {}",
      },
    ],
  });
  assert.match(output, /- root@L12 -> value\.run/);
  assert.match(output, /reason: polymorphic dispatch; occurrences: 3/);
  assert.match(output, /candidates: 1/);
  assert.match(output, /Runner::run; confidence=0\.65; via=hierarchy/);
});

test("runtime dispatch boundaries show their form and key clearly", () => {
  const output = formatExploreResult({
    available: true,
    query: "route",
    roots: [],
    nodes: [{ id: "route", isRoot: true, entity: null }],
    edges: [],
    edgesTruncated: false,
    callPaths: [],
    blastRadius: [],
    changeSurface: [],
    dynamicBoundaries: [
      {
        sourceId: "route",
        target: {
          raw: 'handlers["save"]',
          member: "save",
          hints: {
            dynamicDispatch: { form: "computed_member", key: "save" },
          },
        },
        reason: "runtime_dispatch",
        candidates: [],
        candidatesTruncated: false,
        candidateDetails: [],
      },
    ],
    dynamicBoundariesTruncated: false,
    files: [
      {
        file: { id: "root-file", relativePath: "route.ts" },
        score: 1,
        isCentral: true,
        isChangeSurface: false,
        reasons: ["root(route)"],
        symbols: [],
        text: "function route() {}",
      },
    ],
  });
  assert.match(output, /reason: runtime dispatch/);
  assert.match(output, /dispatch: computed member; key: save/);
});

test("dynamic-boundary candidates are readable and bounded", () => {
  const candidateDetails = Array.from({ length: 7 }, (_, index) => ({
    targetId: `candidate-${index}`,
    displayName: `Impl${index}::run`,
    filePath: `src/impl-${index}.ts`,
    reason: "method_set",
    confidence: 0.65,
  }));
  const output = formatExploreResult({
    available: true,
    query: "root",
    roots: [],
    nodes: [{ id: "root", isRoot: true, entity: null }],
    edges: [],
    edgesTruncated: false,
    callPaths: [],
    blastRadius: [],
    changeSurface: [],
    dynamicBoundaries: [
      {
        sourceId: "root",
        target: { raw: "value.run", member: "run" },
        reason: "polymorphic_dispatch",
        candidates: candidateDetails.map((candidate) => candidate.targetId),
        candidatesTruncated: true,
        candidateDetails,
      },
    ],
    dynamicBoundariesTruncated: false,
    files: [
      {
        file: { id: "root-file", relativePath: "root.ts" },
        score: 1,
        isCentral: true,
        isChangeSurface: false,
        reasons: ["root(root)"],
        symbols: [],
        text: "function root() {}",
      },
    ],
  });
  assert.match(output, /candidates: 7\+/);
  assert.match(output, /Impl4::run \(src\/impl-4\.ts\)/);
  assert.equal(output.includes("Impl5::run"), false);
  assert.match(output, /\.\.\. 2 more \(truncated\)/);
});

test("relationship summary prioritizes root and call-path edges", () => {
  const node = (id, fileId) => ({
    id,
    isRoot: id === "root",
    entity: fileId
      ? { file: { id: fileId, relativePath: `${fileId}.ts` } }
      : null,
  });
  const edge = (src, dst) => ({
    src,
    dst,
    kind: "CALLS",
    rel: "calls",
    count: 1,
    firstLine: 1,
    refName: dst,
    provenance: "static",
    confidence: 1,
  });
  const nodes = [
    node("root", "root-file"),
    node("path", "path-file"),
    ...Array.from({ length: 7 }, (_, index) => node(`noise-${index}`, null)),
  ];
  const output = formatExploreResult({
    available: true,
    query: "root flow",
    roots: [nodes[0]],
    nodes,
    edges: [
      ...Array.from({ length: 7 }, (_, index) =>
        edge(`noise-${index}`, `noise-${(index + 1) % 7}`),
      ),
      edge("root", "path"),
    ],
    edgesTruncated: false,
    callPaths: [{ from: "root", to: "path", nodes: ["root", "path"] }],
    blastRadius: [],
    changeSurface: [],
    dynamicBoundaries: [],
    dynamicBoundariesTruncated: false,
    files: [
      {
        file: { id: "root-file", relativePath: "root-file.ts" },
        score: 1,
        isCentral: true,
        isChangeSurface: false,
        reasons: ["root(root)"],
        symbols: [],
        text: "function root() {}",
      },
    ],
  });

  assert.match(output, /flow:\n1\. root -CALLS-> path/);
  assert.match(output, /CALLS:\n- root -CALLS-> path/);
});

test("relationship summary qualifies constructors and omits hidden-file edges", () => {
  const file = { id: "catalog-h", relativePath: "catalog.h" };
  const root = {
    id: "type",
    isRoot: true,
    entity: { name: "Catalog", kind: "class", file },
  };
  const ctor = {
    id: "ctor",
    isRoot: false,
    entity: {
      name: "Catalog",
      kind: "function",
      file: { id: "catalog-cc", relativePath: "catalog.cc" },
      range: { kind: "text", startLine: 3, endLine: 3 },
    },
  };
  const init = {
    id: "init",
    isRoot: false,
    entity: { name: "init", kind: "function", file },
  };
  const hiddenTest = {
    id: "test",
    isRoot: false,
    entity: {
      name: "TEST_F",
      kind: "function",
      file: { id: "test-file", relativePath: "tests/catalog_test.cc" },
    },
  };
  const result = {
    available: true,
    query: "Catalog",
    roots: [root],
    nodes: [root, ctor, init, hiddenTest],
    edges: [
      { src: "ctor", dst: "init", kind: "CALLS" },
      { src: "test", dst: "init", kind: "CALLS" },
    ].map((edge) => ({
      ...edge,
      rel: "call",
      count: 1,
      firstLine: 1,
      refName: "init",
      provenance: "static",
      confidence: 1,
    })),
    edgesTruncated: false,
    callPaths: [],
    blastRadius: [],
    changeSurface: [],
    dynamicBoundaries: [],
    dynamicBoundariesTruncated: false,
    files: [
      {
        file,
        score: 1,
        isCentral: true,
        isChangeSurface: false,
        reasons: ["Catalog(root)"],
        symbols: [],
        text: "class Catalog {};",
      },
      {
        file: { id: "catalog-cc", relativePath: "catalog.cc" },
        score: 0.5,
        isCentral: true,
        isChangeSurface: false,
        reasons: ["Catalog(definition)"],
        symbols: [],
        text: "Catalog::Catalog() { init(); }",
      },
    ],
  };
  const output = formatExploreResult(result);
  assert.match(output, /Catalog::Catalog -CALLS-> init/);
  assert.doesNotMatch(output, /TEST_F/);
});

test("relationship summary labels true self edges as recursion", () => {
  const output = formatExploreResult({
    available: true,
    query: "walk",
    roots: [],
    nodes: [
      {
        id: "walk",
        isRoot: true,
        entity: {
          id: "walk",
          name: "walk",
          kind: "function",
          file: { id: "tree", relativePath: "tree.go" },
          range: { kind: "text", startLine: 42, endLine: 45 },
        },
      },
    ],
    edges: [
      {
        id: "recursive",
        src: "walk",
        dst: "walk",
        kind: "CALLS",
        rel: "call",
        count: 1,
        firstLine: 43,
        provenance: "static",
        confidence: 1,
      },
    ],
    edgesTruncated: false,
    callPaths: [],
    blastRadius: [],
    changeSurface: [],
    dynamicBoundaries: [],
    dynamicBoundariesTruncated: false,
    files: [
      {
        file: { id: "tree", relativePath: "tree.go" },
        score: 1,
        isCentral: true,
        isChangeSurface: false,
        reasons: ["walk(root)"],
        symbols: [],
        text: "func walk() { walk() }",
      },
    ],
  });
  assert.match(output, /walk@L42 -CALLS-> self \(recursive\)/);
});
