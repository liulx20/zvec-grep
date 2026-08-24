import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodeExtractor } from "../../dist/engine/extraction/code/extractor.js";
import {
  FilePathIndex,
  SqliteGraphStorage,
  collectImportSpecs,
  extractFileGraph,
  isExternalImportSpec,
  rawRef,
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

test("expandFileNeighbors applies limit independently to every seed", async () => {
  const first = codeFile("a-seed", "src/a.ts");
  const second = codeFile("z-seed", "src/z.ts");
  const targets = Array.from({ length: 4 }, (_, index) =>
    codeFile(`target-${index}`, `src/t${index}.ts`),
  );
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    first.id,
    [],
    [],
    targets.slice(0, 3).map((_, index) =>
      rawRef({
        type: "import",
        owner: first.id,
        refName: `./t${index}`,
        line: index + 1,
      }),
    ),
  );
  graph.upsertFileGraph(
    second.id,
    [],
    [],
    [
      rawRef({
        type: "import",
        owner: second.id,
        refName: "./t3",
        line: 1,
      }),
    ],
  );
  for (const target of targets) graph.upsertFileGraph(target.id, [], [], []);
  await graph.resolvePending({ files: [first, second, ...targets] });

  const neighbors = graph.expandFileNeighbors([first.id, second.id], 1);
  assert.deepEqual(
    neighbors.map((item) => item.fid),
    [first.id, second.id],
  );
  assert.equal(neighbors.length, 2);
  graph.close();
});

test("isExternalImportSpec drops npm / node / stdlib", () => {
  assert.equal(isExternalImportSpec("lodash", "typescript"), true);
  assert.equal(isExternalImportSpec("node:fs", "javascript"), true);
  assert.equal(isExternalImportSpec("./utils", "typescript"), false);
  assert.equal(isExternalImportSpec("$lib/Widget.svelte", "javascript"), false);
  assert.equal(isExternalImportSpec("os", "python"), true);
  assert.equal(isExternalImportSpec(".utils", "python"), false);
  assert.equal(isExternalImportSpec("stdio.h", "c"), true);
});

test("Rust stdlib and non-workspace crates resolve as external imports", () => {
  assert.equal(isExternalImportSpec("std::collections::HashMap", "rust"), true);
  assert.equal(isExternalImportSpec("core::fmt", "rust"), true);
  assert.equal(isExternalImportSpec("alloc::vec::Vec", "rust"), true);

  const files = [
    codeFile("rust-lib", "crate/src/lib.rs", "rust"),
    codeFile("rust-local", "crate/src/local.rs", "rust"),
  ];
  const index = new FilePathIndex(files);
  assert.equal(
    resolveImportPath("local", files[0].id, "rust", index).status,
    "resolved",
  );
  assert.equal(
    resolveImportPath("tokio::runtime::Runtime", files[0].id, "rust", index)
      .status,
    "external",
  );
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

test("resolveImportPath maps NodeNext emitted extensions back to TypeScript sources", () => {
  const files = [
    codeFile("entry", "src/entry.ts"),
    codeFile("ts", "src/module.ts"),
    codeFile("tsx", "src/view.tsx", "tsx"),
    codeFile("literal", "src/literal.js", "javascript"),
    codeFile("shadow", "src/literal.ts"),
  ];
  const index = new FilePathIndex(files);

  assert.equal(
    resolveImportPath("./module.js", "entry", "typescript", index).fileId,
    "ts",
  );
  assert.equal(
    resolveImportPath("./view.jsx", "entry", "typescript", index).fileId,
    "tsx",
  );
  assert.equal(
    resolveImportPath("./literal.js", "entry", "typescript", index).fileId,
    "literal",
  );
  assert.equal(
    resolveImportPath("./module.js", "entry", "javascript", index).status,
    "failed",
  );
});

test("resolveImportPath resolves Vue and Svelte component modules", () => {
  const files = [
    codeFile("entry", "src/entry.ts"),
    codeFile("vue", "src/Widget.vue", "vue"),
    codeFile("svelte", "src/Panel.svelte", "svelte"),
  ];
  const index = new FilePathIndex(files);

  assert.equal(
    resolveImportPath("./Widget", "entry", "typescript", index).fileId,
    "vue",
  );
  assert.equal(
    resolveImportPath("./Panel", "entry", "typescript", index).fileId,
    "svelte",
  );
  assert.equal(
    resolveImportPath("./Widget.vue", "entry", "javascript", index).fileId,
    "vue",
  );
});

test("resolveImportPath resolves the SvelteKit $lib project alias", () => {
  const files = [
    codeFile("page", "src/routes/+page.svelte", "svelte"),
    codeFile("component", "src/lib/ArticleList/index.svelte", "svelte"),
  ];
  const index = new FilePathIndex(files);

  for (const language of ["javascript", "typescript", "svelte"]) {
    assert.deepEqual(
      resolveImportPath(
        "$lib/ArticleList/index.svelte",
        "page",
        language,
        index,
      ),
      {
        status: "resolved",
        fileId: "component",
        absolutePath: "/repo/src/lib/ArticleList/index.svelte",
      },
    );
  }
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

test("C and C++ include-root paths resolve only when their suffix is unique", () => {
  const app = codeFile("app", "src/main/app.cc", "cpp");
  const header = codeFile("service", "include/neug/main/service.h", "cpp");
  const index = new FilePathIndex([app, header]);

  assert.deepEqual(
    resolveImportPath("neug/main/service.h", app.id, "cpp", index),
    {
      status: "resolved",
      fileId: header.id,
      absolutePath: header.absolutePath,
    },
  );

  const ambiguous = new FilePathIndex([
    app,
    header,
    codeFile("vendored-service", "vendor/include/neug/main/service.h", "cpp"),
  ]);
  assert.equal(
    resolveImportPath("neug/main/service.h", app.id, "cpp", ambiguous).status,
    "failed",
    "duplicate include-root suffixes must not resolve by insertion order",
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

test("CommonJS require calls preserve namespace, member, and destructured bindings", async () => {
  const file = codeFile("commonjs", "lib/express.js", "javascript");
  const specs = await collectImportSpecs({
    kind: "text",
    file,
    text: `
var proto = require('./application');
const compile = require('./utils').compile;
const { Router, route: makeRoute } = require('./router');
require('./side-effect');
const dynamic = require(chooseModule());
const left = require('./shared'), right = require('./shared').right;
`,
  });
  assert.deepEqual(specs, [
    {
      spec: "./application",
      line: 2,
      bindings: [{ imported: "*", local: "proto" }],
    },
    {
      spec: "./utils",
      line: 3,
      bindings: [{ imported: "compile", local: "compile" }],
    },
    {
      spec: "./router",
      line: 4,
      bindings: [
        { imported: "Router", local: "Router" },
        { imported: "route", local: "makeRoute" },
      ],
    },
    { spec: "./side-effect", line: 5, bindings: [] },
    {
      spec: "./shared",
      line: 7,
      bindings: [{ imported: "*", local: "left" }],
    },
    {
      spec: "./shared",
      line: 7,
      bindings: [{ imported: "right", local: "right" }],
    },
  ]);
});

test("Java imports retain class and static-member bindings", async () => {
  const file = codeFile("java-main", "src/app/Main.java", "java");
  const specs = await collectImportSpecs({
    kind: "text",
    file,
    text: `package app;
import com.alpha.Service;
import static com.alpha.Helpers.run;
import com.beta.*;
`,
  });
  assert.deepEqual(specs, [
    {
      spec: "com.alpha.Service",
      line: 2,
      bindings: [{ imported: "Service", local: "Service" }],
    },
    {
      spec: "com.alpha.Helpers",
      line: 3,
      bindings: [{ imported: "run", local: "run" }],
    },
    {
      spec: "com.beta.*",
      line: 4,
      bindings: [],
    },
  ]);
});

test("Java FQN imports resolve by a unique source-relative suffix", () => {
  const files = [
    codeFile("main", "module/src/main/java/app/Main.java", "java"),
    codeFile("alpha", "module/src/main/java/com/alpha/Service.java", "java"),
    codeFile("beta", "module/src/main/java/com/beta/Service.java", "java"),
  ];
  const index = new FilePathIndex(files);
  assert.equal(
    resolveImportPath("com.alpha.Service", "main", "java", index).fileId,
    "alpha",
  );
  assert.equal(
    resolveImportPath("com.beta.Service", "main", "java", index).fileId,
    "beta",
  );
  assert.equal(
    resolveImportPath("com.beta.*", "main", "java", index).fileId,
    "beta",
  );
  const ambiguous = new FilePathIndex([
    ...files,
    codeFile(
      "duplicate-alpha",
      "other/src/main/java/com/alpha/Service.java",
      "java",
    ),
  ]);
  assert.equal(
    resolveImportPath("com.alpha.Service", "main", "java", ambiguous).status,
    "failed",
    "duplicate FQNs must not resolve by insertion order",
  );
  assert.equal(
    resolveImportPath("com.alpha.*", "main", "java", ambiguous).status,
    "failed",
    "duplicate packages in separate roots must remain ambiguous",
  );
});

test("pure re-export files retain import IR when they have no symbol entities", async () => {
  const file = codeFile("facade", "src/facade.ts");
  const source = {
    kind: "text",
    file,
    text: 'export { Runner } from "./api";\nexport { Worker } from "./impl";\n',
  };
  const analysis = await new CodeExtractor().analyzeForIndexing(source);
  assert.deepEqual(
    analysis.imports.map((item) => item.spec),
    ["./api", "./impl"],
  );
  assert.ok(analysis.fragments.length > 0, "the file remains searchable text");
});

test("collectImportSpecs reads commented Python bindings from the AST", async () => {
  const file = codeFile("python-comments", "pkg/app.py", "python");
  const text = `from .codec import (
  foo,
  # a comma here, must not become a binding
  bar as baz,
)
`;
  const specs = await collectImportSpecs({ kind: "text", text, file });
  assert.deepEqual(specs, [
    {
      spec: ".codec",
      line: 1,
      bindings: [
        { imported: "foo", local: "foo" },
        { imported: "bar", local: "baz" },
      ],
    },
  ]);
});

test("Python sibling-module imports retain a resolver fallback candidate", async () => {
  const file = codeFile("python-sibling", "pkg/app.py", "python");
  const specs = await collectImportSpecs({
    kind: "text",
    file,
    text: "from . import util\n",
  });
  assert.deepEqual(specs, [
    {
      spec: ".",
      line: 1,
      bindings: [{ imported: "util", local: "util" }],
    },
  ]);
});

test("Python qualified from-imports retain a child-module binding", async () => {
  const file = codeFile("python-absolute", "app/main.py", "python");
  const specs = await collectImportSpecs({
    kind: "text",
    file,
    text: "from pkg import util\nutil.help()\n",
  });
  assert.deepEqual(specs, [
    {
      spec: "pkg",
      line: 1,
      bindings: [{ imported: "util", local: "util" }],
    },
    {
      spec: "pkg.util",
      line: 1,
      bindings: [{ imported: "*", local: "util" }],
    },
  ]);

  const files = [
    file,
    codeFile("python-package", "src/pkg/__init__.py", "python"),
    codeFile("python-util", "src/pkg/util.py", "python"),
  ];
  const index = new FilePathIndex(files);
  assert.equal(
    resolveImportPath("pkg.util", file.id, "python", index).fileId,
    "python-util",
  );
});

test("Rust mod and aliased use declarations produce resolvable bindings", async () => {
  const file = codeFile("rust-imports", "src/lib.rs", "rust");
  const specs = await collectImportSpecs({
    kind: "text",
    file,
    text: "mod helper;\nuse codec::decode as parse;\n",
  });
  assert.deepEqual(specs, [
    {
      spec: "./helper",
      line: 1,
      bindings: [{ imported: "*", local: "helper" }],
    },
    {
      spec: "codec",
      line: 2,
      bindings: [{ imported: "decode", local: "parse" }],
    },
    {
      spec: "codec::decode",
      line: 2,
      bindings: [{ imported: "*", local: "parse" }],
    },
  ]);
});

test("Rust grouped uses preserve item and module bindings", async () => {
  const file = codeFile("rust-grouped", "src/bin/server.rs", "rust");
  const specs = await collectImportSpecs({
    kind: "text",
    file,
    text: "use mini_redis::{server, DEFAULT_PORT};\n",
  });
  assert.deepEqual(specs, [
    {
      spec: "mini_redis",
      line: 1,
      bindings: [
        { imported: "server", local: "server" },
        { imported: "DEFAULT_PORT", local: "DEFAULT_PORT" },
      ],
    },
    {
      spec: "mini_redis::server",
      line: 1,
      bindings: [{ imported: "*", local: "server" }],
    },
    {
      spec: "mini_redis::DEFAULT_PORT",
      line: 1,
      bindings: [{ imported: "*", local: "DEFAULT_PORT" }],
    },
  ]);
});

test("Rust imports retain inline-module depth and resolve super to the same file", async () => {
  const file = codeFile("rust-inline", "src/lib.rs", "rust");
  const specs = await collectImportSpecs({
    kind: "text",
    file,
    text: [
      "fn helper() {}",
      "mod tests {",
      "    use super::helper;",
      "    fn check() { helper(); }",
      "}",
      "",
    ].join("\n"),
  });
  assert.deepEqual(specs, [
    {
      spec: "super",
      line: 3,
      bindings: [{ imported: "helper", local: "helper" }],
      rustInlineModuleDepth: 1,
    },
    {
      spec: "super::helper",
      line: 3,
      bindings: [{ imported: "*", local: "helper" }],
      rustInlineModuleDepth: 1,
    },
  ]);

  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    file.id,
    [],
    [],
    specs.flatMap((spec, occurrence) => [
      rawRef({
        type: "import",
        owner: file.id,
        refName: spec.spec,
        line: spec.line,
        occurrence,
        sourceLanguage: "rust",
        rustInlineModuleDepth: spec.rustInlineModuleDepth,
      }),
      ...(spec.bindings ?? []).map((binding, bindingIndex) =>
        rawRef({
          type: "import_binding",
          owner: file.id,
          refName: spec.spec,
          line: spec.line,
          occurrence: occurrence * 1000 + bindingIndex + 1,
          importedName: binding.imported,
          localName: binding.local,
          sourceLanguage: "rust",
          rustInlineModuleDepth: spec.rustInlineModuleDepth,
        }),
      ),
    ]),
  );
  await graph.resolvePending({ files: [file] });
  assert.equal(graph.stats().failedRefCount, 0);
  assert.equal(
    graph
      .outgoingEdges([file.id], ["IMPORTS"], 10)
      .every((edge) => edge.dst === file.id),
    true,
  );
  graph.close();
});

test("resolveImportPath maps the current Rust crate to src modules", () => {
  const root = mkdtempSync(join(tmpdir(), "zvec-rust-import-"));
  try {
    writeFileSync(
      join(root, "Cargo.toml"),
      '[package]\nname = "mini-redis"\nversion = "0.1.0"\n',
    );
    const files = [
      {
        ...codeFile("main", "src/bin/server.rs", "rust"),
        rootPath: root,
        absolutePath: join(root, "src/bin/server.rs"),
      },
      {
        ...codeFile("lib", "src/lib.rs", "rust"),
        rootPath: root,
        absolutePath: join(root, "src/lib.rs"),
      },
      {
        ...codeFile("server", "src/server.rs", "rust"),
        rootPath: root,
        absolutePath: join(root, "src/server.rs"),
      },
    ];
    const index = new FilePathIndex(files);
    assert.equal(
      resolveImportPath("mini_redis", "main", "rust", index).fileId,
      "lib",
    );
    assert.equal(
      resolveImportPath("mini_redis::server", "main", "rust", index).fileId,
      "server",
    );
    assert.equal(
      resolveImportPath("crate::Router", "lib", "rust", index).fileId,
      "lib",
    );
    assert.equal(
      resolveImportPath("crate::server::*", "lib", "rust", index).fileId,
      "server",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveImportPath follows Rust self and super module semantics", () => {
  const files = [
    codeFile("rust-lib", "src/lib.rs", "rust"),
    codeFile("rust-parent", "src/parent.rs", "rust"),
    codeFile("rust-child", "src/parent/child.rs", "rust"),
    codeFile("rust-nested", "src/parent/child/nested.rs", "rust"),
  ];
  const index = new FilePathIndex(files);
  assert.equal(
    resolveImportPath("super::ParentItem", "rust-child", "rust", index).fileId,
    "rust-parent",
  );
  assert.equal(
    resolveImportPath("self::nested::NestedItem", "rust-child", "rust", index)
      .fileId,
    "rust-nested",
  );
});

test("resolveImportPath maps Cargo workspace crates and symbol tails to modules", () => {
  const root = mkdtempSync(join(tmpdir(), "zvec-rust-workspace-"));
  try {
    for (const packageName of ["core-lib", "extension"]) {
      const directory = join(root, packageName);
      mkdirSync(join(directory, "src/routing"), { recursive: true });
      writeFileSync(
        join(directory, "Cargo.toml"),
        `[package]\nname = "${packageName}"\nversion = "0.1.0"\n`,
      );
      writeFileSync(join(directory, "src/lib.rs"), "");
    }
    writeFileSync(join(root, "core-lib/src/routing/mod.rs"), "");
    const rustFile = (id, relativePath) => ({
      ...codeFile(id, relativePath, "rust"),
      rootPath: root,
      absolutePath: join(root, relativePath),
    });
    const files = [
      rustFile("core-lib", "core-lib/src/lib.rs"),
      rustFile("routing", "core-lib/src/routing/mod.rs"),
      rustFile("extension", "extension/src/lib.rs"),
    ];
    const index = new FilePathIndex(files);

    assert.equal(
      resolveImportPath("core_lib::routing", "extension", "rust", index).fileId,
      "routing",
    );
    assert.equal(
      resolveImportPath("core_lib::routing::Router", "extension", "rust", index)
        .fileId,
      "routing",
    );
    assert.equal(
      resolveImportPath("extension", "extension", "rust", index).fileId,
      "extension",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Rust workspace re-exports resolve foreign extension impl targets", async () => {
  const root = mkdtempSync(join(tmpdir(), "zvec-rust-reexport-"));
  try {
    const specs = [
      [
        "core",
        "core-lib/src/lib.rs",
        "pub mod routing; pub use self::routing::Router;",
      ],
      ["routing", "core-lib/src/routing/mod.rs", "pub struct Router<S>(S);"],
      [
        "extension",
        "extension/src/lib.rs",
        "use core_lib::Router; pub trait RouterExt {} impl<S> RouterExt for Router<S> {}",
      ],
    ];
    for (const [directory, packageName] of [
      ["core-lib", "core-lib"],
      ["extension", "extension"],
    ]) {
      mkdirSync(join(root, directory, "src/routing"), { recursive: true });
      writeFileSync(
        join(root, directory, "Cargo.toml"),
        `[package]\nname = "${packageName}"\nversion = "0.1.0"\n`,
      );
    }
    const graph = new SqliteGraphStorage("", { inMemory: true });
    const files = [];
    const extractedRefs = [];
    let router;
    let extensionImpl;
    for (const [id, relativePath, text] of specs) {
      const file = {
        ...codeFile(id, relativePath, "rust"),
        rootPath: root,
        absolutePath: join(root, relativePath),
      };
      writeFileSync(file.absolutePath, text);
      files.push(file);
      const source = { kind: "text", file, text };
      const analysis = await new CodeExtractor().analyzeForIndexing(source);
      const input = await extractFileGraph(
        source,
        analysis.fragments.map((item) => item.fragment),
        analysis,
      );
      router ??= input.nodes.find((node) => node.name === "Router");
      extensionImpl ??= input.nodes.find((node) =>
        node.signature?.includes("RouterExt for Router"),
      );
      extractedRefs.push(...input.refs);
      graph.upsertFileGraph(file.id, input.nodes, input.edges, input.refs);
    }
    await graph.resolvePending({ files });
    assert.ok(router && extensionImpl);
    const resolved = graph
      .edges([extensionImpl.id, router.id], ["REFS"], 10)
      .edges.some(
        (edge) => edge.src === extensionImpl.id && edge.dst === router.id,
      );
    assert.ok(
      resolved,
      JSON.stringify({
        router,
        extensionImpl,
        extractedRefs,
        stats: graph.stats(),
      }),
    );
    graph.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectImportSpecs ignores commas inside JS comments", async () => {
  const file = codeFile("js-comments", "src/app.ts");
  const text = `import {
  foo,
  /* misleading, comma */
  bar as baz,
} from "./codec";
`;
  const specs = await collectImportSpecs({ kind: "text", text, file });
  assert.deepEqual(specs, [
    {
      spec: "./codec",
      line: 1,
      bindings: [
        { imported: "foo", local: "foo" },
        { imported: "bar", local: "baz" },
      ],
    },
  ]);
});

test("Go grouped imports preserve package bindings including semantic versions", async () => {
  const file = codeFile("go-middleware", "middleware/clean_path.go", "go");
  const text = `package middleware
import (
  "net/http"
  "github.com/go-chi/chi/v5"
)
`;
  assert.deepEqual(await collectImportSpecs({ kind: "text", text, file }), [
    {
      spec: "net/http",
      line: 3,
      bindings: [{ imported: "*", local: "http" }],
    },
    {
      spec: "github.com/go-chi/chi/v5",
      line: 4,
      bindings: [{ imported: "*", local: "chi" }],
    },
  ]);
});

test("Go module package selector resolves across files in the imported package", async () => {
  const root = mkdtempSync(join(tmpdir(), "zvec-go-import-"));
  try {
    writeFileSync(join(root, "go.mod"), "module github.com/go-chi/chi/v5\n");
    const goFile = (id, relativePath) => ({
      ...codeFile(id, relativePath, "go"),
      rootPath: root,
      absolutePath: join(root, relativePath),
    });
    const middleware = goFile("middleware", "middleware/clean_path.go");
    const context = goFile("context", "context.go");
    const other = goFile("other", "chain.go");
    const middlewareSource = {
      kind: "text",
      file: middleware,
      text: `package middleware
import "github.com/go-chi/chi/v5"
func CleanPath() { chi.RouteContext() }
func BuildRouter() { router := chi.NewRouter(); router.Use() }
`,
    };
    const contextSource = {
      kind: "text",
      file: context,
      text: `package chi
func RouteContext() {}
type Router struct{}
func NewRouter() *Router { return &Router{} }
func (*Router) Use() {}
`,
    };
    const inputs = await Promise.all(
      [middlewareSource, contextSource].map(async (source) =>
        extractFileGraph(source, await new CodeExtractor().extract(source)),
      ),
    );
    const graph = new SqliteGraphStorage("", { inMemory: true });
    graph.upsertFileGraph(
      middleware.id,
      inputs[0].nodes,
      inputs[0].edges,
      inputs[0].refs,
    );
    graph.upsertFileGraph(
      context.id,
      inputs[1].nodes,
      inputs[1].edges,
      inputs[1].refs,
    );
    graph.upsertFileGraph(other.id, [], [], []);
    await graph.resolvePending({ files: [middleware, context, other] });
    const cleanPath = inputs[0].nodes.find((node) => node.name === "CleanPath");
    const routeContext = inputs[1].nodes.find(
      (node) => node.name === "RouteContext",
    );
    const buildRouter = inputs[0].nodes.find(
      (node) => node.name === "BuildRouter",
    );
    const use = inputs[1].nodes.find(
      (node) => node.qualifiedName === "Router::Use",
    );
    assert.ok(cleanPath && routeContext && buildRouter && use);
    assert.deepEqual(
      graph.callees(cleanPath.id, 1, 10).map((ref) => ref.id),
      [routeContext.id],
    );
    assert.ok(
      graph
        .callees(buildRouter.id, 1, 10)
        .some((candidate) => candidate.id === use.id),
      "a Go package import must expose receiver members from sibling files",
    );
    graph.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveImportPath discovers nested Go workspace modules", () => {
  const root = mkdtempSync(join(tmpdir(), "zvec-go-workspace-"));
  try {
    for (const [directory, modulePath] of [
      ["service", "example.com/service"],
      ["shared", "example.com/shared"],
    ]) {
      mkdirSync(join(root, directory), { recursive: true });
      writeFileSync(
        join(root, directory, "go.mod"),
        `module ${modulePath}\n\ngo 1.22\n`,
      );
    }
    mkdirSync(join(root, "shared/model"), { recursive: true });
    const goFile = (id, relativePath) => ({
      ...codeFile(id, relativePath, "go"),
      rootPath: root,
      absolutePath: join(root, relativePath),
    });
    const files = [
      goFile("service", "service/main.go"),
      goFile("shared", "shared/model/model.go"),
    ];
    const index = new FilePathIndex(files);
    assert.equal(
      resolveImportPath("example.com/shared/model", "service", "go", index)
        .fileId,
      "shared",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Rust grouped module imports resolve qualified calls to top-level exports", async () => {
  const root = mkdtempSync(join(tmpdir(), "zvec-rust-call-"));
  try {
    writeFileSync(
      join(root, "Cargo.toml"),
      '[package]\nname = "mini-redis"\nversion = "0.1.0"\n',
    );
    const rustFile = (id, relativePath) => ({
      ...codeFile(id, relativePath, "rust"),
      rootPath: root,
      absolutePath: join(root, relativePath),
    });
    const main = rustFile("main", "src/bin/main.rs");
    const library = rustFile("lib", "src/lib.rs");
    const server = rustFile("server", "src/server.rs");
    const helper = rustFile("helper", "src/helper.rs");
    const sources = [
      {
        kind: "text",
        file: main,
        text: `use mini_redis::{server, DEFAULT_PORT};
fn main() { server::run(); }
`,
      },
      {
        kind: "text",
        file: library,
        text: 'pub mod helper;\npub mod server;\npub const DEFAULT_PORT: &str = "6379";\n',
      },
      {
        kind: "text",
        file: server,
        text: "use crate::helper;\npub fn run() { helper::prepare(); }\nstruct Listener;\nimpl Listener { fn run(&self) {} }\n",
      },
      {
        kind: "text",
        file: helper,
        text: "pub fn prepare() {}\n",
      },
    ];
    const inputs = await Promise.all(
      sources.map(async (source) =>
        extractFileGraph(source, await new CodeExtractor().extract(source)),
      ),
    );
    const graph = new SqliteGraphStorage("", { inMemory: true });
    for (let index = 0; index < sources.length; index++) {
      const input = inputs[index];
      graph.upsertFileGraph(
        sources[index].file.id,
        input.nodes,
        input.edges,
        input.refs,
      );
    }
    await graph.resolvePending({ files: [main, library, server, helper] });
    const mainSymbol = inputs[0].nodes.find((node) => node.name === "main");
    const topLevelRun = inputs[2].nodes.find(
      (node) => node.name === "run" && node.qualifiedName === "run",
    );
    assert.ok(mainSymbol && topLevelRun);
    assert.deepEqual(
      graph.callees(mainSymbol.id, 1, 10).map((ref) => ref.id),
      [topLevelRun.id],
    );
    assert.deepEqual(
      graph.database.db
        .prepare(
          "SELECT ref_name,line,local_name FROM unresolved_refs WHERE status='failed' AND ref_kind='import'",
        )
        .all(),
      [],
      "the rejected item/module alternative must not remain retryable",
    );
    graph.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
        (r.type === "import" || r.type === "import_binding") &&
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
  assert.deepEqual(
    graph.importedSymbols([a.id], 10).map((symbol) => symbol.id),
    [graphB.nodes.find((node) => node.name === "formatDate").id],
  );

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

test("NodeNext .js imports project TypeScript source bindings and calls", async () => {
  const caller = codeFile("node-next-caller", "src/caller.ts");
  const target = codeFile("node-next-target", "src/service.ts");
  const callerText = `
import { execute } from "./service.js";
export function run() { return execute(); }
`;
  const targetText = `export function execute() { return "ok"; }`;
  const extractor = new CodeExtractor();
  const callerSource = { kind: "text", text: callerText, file: caller };
  const targetSource = { kind: "text", text: targetText, file: target };
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
    caller.id,
    callerGraph.nodes,
    callerGraph.edges,
    callerGraph.refs,
  );
  graph.upsertFileGraph(
    target.id,
    targetGraph.nodes,
    targetGraph.edges,
    targetGraph.refs,
  );
  await graph.resolvePending({ files: [caller, target] });

  const run = callerGraph.nodes.find((node) => node.name === "run");
  const execute = targetGraph.nodes.find((node) => node.name === "execute");
  assert.ok(run && execute);
  assert.deepEqual(graph.fileScope(caller.id, 1, 10), [target.id]);
  assert.deepEqual(
    graph.callees(run.id, 1, 10).map((symbol) => symbol.id),
    [execute.id],
  );
  graph.close();
});

test("deleted and re-added import targets are reprojected from source facts", async () => {
  const caller = codeFile("caller", "src/caller.ts");
  const target = codeFile("target", "src/target.ts");
  const graph = new SqliteGraphStorage("", { inMemory: true });
  graph.upsertFileGraph(
    caller.id,
    [],
    [],
    [
      rawRef({
        type: "import",
        owner: caller.id,
        refName: "./target",
        line: 1,
      }),
    ],
  );
  graph.upsertFileGraph(target.id, [], [], []);
  await graph.resolvePending({ files: [caller, target] });
  assert.deepEqual(graph.expandFileNeighbors([caller.id], 10), [
    { fid: caller.id, id: target.id, direction: "out" },
  ]);

  graph.deleteFileGraph(target.id);
  assert.deepEqual(graph.expandFileNeighbors([caller.id], 10), []);
  assert.equal(graph.stats().refCount, 1);

  graph.upsertFileGraph(target.id, [], [], []);
  await graph.resolvePending({ files: [caller, target] });
  assert.deepEqual(graph.expandFileNeighbors([caller.id], 10), [
    { fid: caller.id, id: target.id, direction: "out" },
  ]);
  graph.close();
});
