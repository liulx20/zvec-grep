import process from "node:process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SqliteGraphStorage,
  exploreGraph,
} from "../../dist/engine/graph/index.js";

const cases = [
  flowCase("typescript", "src/controller.ts", {
    query: "Controller handle validate",
    container: "Controller",
    first: "handle",
    second: "validate",
    source: `export class Controller {
  handle() {
    return this.validate();
  }
  validate() {
    return true;
  }
}`,
  }),
  flowCase("python", "src/loader.py", {
    query: "DatasetLoader download extract",
    container: "DatasetLoader",
    first: "download",
    second: "extract",
    source: `class DatasetLoader:
    def download(self):
        return self.extract()

    def extract(self):
        return True`,
  }),
  flowCase("java", "src/main/java/InternalSession.java", {
    query: "InternalSession beginTransaction close",
    container: "InternalSession",
    first: "beginTransaction",
    second: "close",
    source: `public class InternalSession {
  public Transaction beginTransaction() {
    return close();
  }
  public Transaction close() {
    return null;
  }
}`,
  }),
  flowCase("go", "cmd/installer/main.go", {
    query: "ensureBinary download verifyCandidate",
    container: null,
    first: "ensureBinary",
    second: "download",
    third: "verifyCandidate",
    source: `package main

func ensureBinary() error {
  if err := download(); err != nil { return err }
  return nil
}

func download() error {
  return verifyCandidate()
}

func verifyCandidate() error {
  return nil
}`,
  }),
  flowCase("rust", "crate_b/src/lib.rs", {
    query: "Server run start",
    container: "Server",
    first: "run",
    second: "start",
    source: `pub struct Server;

impl Server {
    pub fn run(&self) {
        let _ = Server::start();
    }

    fn start() -> bool {
        false
    }
}`,
    distractor: {
      path: "crate_a/src/lib.rs",
      name: "start",
      source: "pub fn start() -> bool { true }",
    },
  }),
  flowCase("cpp", "src/neug_db.cc", {
    query: "NeugDB registerService unregisterService",
    container: "NeugDB",
    first: "registerService",
    second: "unregisterService",
    source: `class NeugDB {
 public:
  void registerService() {
    unregisterService();
  }
  void unregisterService() {}
};`,
  }),
];

export function runExploreQualityBenchmark() {
  const reports = cases.map(runCase);
  const totals = reports.reduce(
    (sum, report) => ({
      roots: sum.roots + report.rootRecall,
      paths: sum.paths + report.pathRecall,
      fileRecall: sum.fileRecall + report.fileRecall,
      filePrecision: sum.filePrecision + report.filePrecision,
      concepts: sum.concepts + report.conceptCoverage,
      body: sum.body + report.bodyCoverage,
      redundancy: sum.redundancy + report.redundancy,
      chars: sum.chars + report.chars,
      elapsedMs: sum.elapsedMs + report.elapsedMs,
    }),
    {
      roots: 0,
      paths: 0,
      fileRecall: 0,
      filePrecision: 0,
      concepts: 0,
      body: 0,
      redundancy: 0,
      chars: 0,
      elapsedMs: 0,
    },
  );
  const divisor = Math.max(1, reports.length);
  return {
    summary: {
      cases: reports.length,
      rootRecall: totals.roots / divisor,
      pathRecall: totals.paths / divisor,
      fileRecall: totals.fileRecall / divisor,
      filePrecision: totals.filePrecision / divisor,
      conceptCoverage: totals.concepts / divisor,
      bodyCoverage: totals.body / divisor,
      sourceCoverage: totals.body / divisor,
      redundancy: totals.redundancy / divisor,
      averageChars: totals.chars / divisor,
      averageElapsedMs: totals.elapsedMs / divisor,
    },
    cases: reports,
  };
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  const report = runExploreQualityBenchmark();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log("Explore quality benchmark");
    for (const item of report.cases) {
      console.log(
        `${item.language.padEnd(10)} roots=${percent(item.rootRecall)} paths=${percent(item.pathRecall)} files=${percent(item.fileRecall)}/${percent(item.filePrecision)} concepts=${percent(item.conceptCoverage)} body=${percent(item.bodyCoverage)} duplicate=${percent(item.redundancy)} chars=${item.chars} time=${item.elapsedMs.toFixed(1)}ms`,
      );
    }
    console.log(
      `overall    roots=${percent(report.summary.rootRecall)} paths=${percent(report.summary.pathRecall)} files=${percent(report.summary.fileRecall)}/${percent(report.summary.filePrecision)} concepts=${percent(report.summary.conceptCoverage)} body=${percent(report.summary.bodyCoverage)} duplicate=${percent(report.summary.redundancy)} chars=${report.summary.averageChars.toFixed(0)} time=${report.summary.averageElapsedMs.toFixed(1)}ms`,
    );
  }

  if (report.cases.some((item) => item.failures.length > 0)) {
    for (const item of report.cases) {
      for (const failure of item.failures) {
        console.error(`${item.language}: ${failure}`);
      }
    }
    process.exitCode = 1;
  }
}

function runCase(spec) {
  const graph = new SqliteGraphStorage("", { inMemory: true });
  try {
    for (const file of spec.files) {
      graph.upsertFileGraph(file.id, file.nodes, file.edges, []);
    }
    const storage = fixtureStorage(spec.files);
    Object.assign(graph, storage);
    const started = performance.now();
    const result = exploreGraph(graph, {
      query: spec.query,
      searchLimit: 8,
      traversalDepth: 2,
      maxNodes: 64,
      maxFiles: 4,
      maxChars: 8_000,
    });
    const elapsedMs = performance.now() - started;
    const roots = new Set(result.roots.map((root) => root.id));
    const paths = result.callPaths.map((path) => path.nodes.join(" -> "));
    const files = new Set(result.files.map((file) => file.file.relativePath));
    const source = result.files.map((file) => file.text).join("\n");
    const rootHits = spec.expectedRoots.filter((id) => roots.has(id)).length;
    const pathHits = spec.expectedPaths.filter((path) =>
      paths.includes(path.join(" -> ")),
    ).length;
    const sourceHits = spec.expectedSource.filter((text) =>
      source.includes(text),
    ).length;
    const missingSource = spec.expectedSource.filter(
      (text) => !source.includes(text),
    );
    const forbiddenHits = spec.forbiddenFiles.filter((path) => files.has(path));
    const expectedFiles = new Set(spec.expectedFiles);
    const relevantFileHits = [...files].filter((path) =>
      expectedFiles.has(path),
    ).length;
    const concepts = queryConcepts(spec.query);
    const conceptText = [
      source,
      ...result.roots.map((root) => symbolName(root.entity)),
      ...result.files.flatMap((file) =>
        file.symbols.map((symbol) => symbol.name ?? ""),
      ),
    ]
      .join(" ")
      .toLowerCase();
    const conceptHits = concepts.filter((term) =>
      conceptText.includes(term),
    ).length;
    const failures = [];
    if (rootHits !== spec.expectedRoots.length)
      failures.push(`roots=${[...roots].join(",")}`);
    if (pathHits !== spec.expectedPaths.length)
      failures.push(`paths=${paths.join(" | ") || "none"}`);
    if (forbiddenHits.length > 0)
      failures.push(`forbidden files=${forbiddenHits.join(",")}`);
    if (missingSource.length > 0)
      failures.push(`missing source=${missingSource.join(",")}`);
    return {
      language: spec.language,
      query: spec.query,
      rootRecall: ratio(rootHits, spec.expectedRoots.length),
      pathRecall: ratio(pathHits, spec.expectedPaths.length),
      fileRecall: ratio(relevantFileHits, expectedFiles.size),
      filePrecision: precision(relevantFileHits, files.size),
      conceptCoverage: ratio(conceptHits, concepts.length),
      bodyCoverage: ratio(sourceHits, spec.expectedSource.length),
      sourceCoverage: ratio(sourceHits, spec.expectedSource.length),
      redundancy: duplicateLineRatio(result.files.map((file) => file.text)),
      chars: source.length,
      elapsedMs,
      ...(process.argv.includes("--debug") ? { source } : {}),
      failures,
    };
  } finally {
    graph.close();
  }
}

function flowCase(language, path, options) {
  const main = fixtureFile(language, path, options);
  const files = [main];
  const forbiddenFiles = [testPath(language, path)];
  files.push(
    fixtureFile(language, forbiddenFiles[0], {
      query: options.query,
      container: null,
      first: options.first,
      second: null,
      source: testSource(language, options.first),
      idPrefix: "test-",
    }),
  );
  if (options.distractor) {
    forbiddenFiles.push(options.distractor.path);
    files.push(
      fixtureFile(language, options.distractor.path, {
        query: options.query,
        container: null,
        first: options.distractor.name,
        second: null,
        source: options.distractor.source,
        idPrefix: "distractor-",
      }),
    );
  }
  const expectedRoots = [
    options.container,
    options.first,
    options.second,
    options.third,
  ]
    .filter(Boolean)
    .map((name) => `${main.id}:${name}`);
  const pathNames = [options.first, options.second, options.third].filter(
    Boolean,
  );
  return {
    language,
    query: options.query,
    files,
    expectedRoots,
    expectedPaths:
      pathNames.length >= 2
        ? [
            [
              `${main.id}:${pathNames[0]}`,
              ...pathNames.slice(1).map((name) => `${main.id}:${name}`),
            ],
          ]
        : [],
    expectedFiles: [path],
    forbiddenFiles,
    expectedSource: pathNames.map((name) => sourceNeedle(language, name)),
  };
}

function fixtureFile(language, path, options) {
  const id = `${options.idPrefix ?? "main-"}${language}-${path}`;
  const symbols = [
    options.container,
    options.first,
    options.second,
    options.third,
  ].filter(Boolean);
  const nodes = symbols.map((name, index) => ({
    id: `${id}:${name}`,
    kind:
      index === 0 && options.container ? containerKind(language) : "function",
    is_exported: true,
    name,
  }));
  const edges = [];
  if (options.container) {
    for (const name of symbols.slice(1)) {
      edges.push(
        edge(`${id}:${options.container}`, `${id}:${name}`, "CONTAINS"),
      );
    }
  }
  const calls = [options.first, options.second, options.third].filter(Boolean);
  for (let index = 0; index + 1 < calls.length; index += 1) {
    edges.push(
      edge(`${id}:${calls[index]}`, `${id}:${calls[index + 1]}`, "CALLS"),
    );
  }
  return {
    id,
    language,
    path,
    source: options.source,
    nodes,
    edges,
    entities: symbols.map((name, index) =>
      storedEntity({
        id: `${id}:${name}`,
        fileId: id,
        language,
        path,
        source: options.source,
        name,
        kind:
          index === 0 && options.container
            ? containerKind(language)
            : "function",
      }),
    ),
  };
}

function fixtureStorage(files) {
  const entities = files.flatMap((file) => file.entities);
  const byId = new Map(entities.map((entity) => [entity.entity.id, entity]));
  const sourceByFile = new Map(files.map((file) => [file.id, file.source]));
  return {
    findSymbolsByName(name, limit) {
      const normalized = name.trim().toLowerCase();
      return entities
        .filter((entity) =>
          symbolName(entity).toLowerCase().includes(normalized),
        )
        .slice(0, limit);
    },
    findSymbolsByQuery(query, limit) {
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      return entities
        .filter((entity) => {
          const hay =
            `${symbolName(entity)} ${entity.file.relativePath} ${entity.entity.content.text}`.toLowerCase();
          return terms.some((term) => hay.includes(term));
        })
        .slice(0, limit);
    },
    getEntity(id) {
      return byId.get(id) ?? null;
    },
    readFileText(file) {
      return sourceByFile.get(file.id) ?? null;
    },
  };
}

function storedEntity({ id, fileId, language, path, source, name, kind }) {
  const lines = source.split(/\r?\n/);
  const match = definitionLine(lines, language, name, kind);
  const startLine = Math.max(1, match + 1);
  const endLine =
    kind === containerKind(language)
      ? lines.length
      : methodEnd(lines, startLine);
  const offsets = lineOffsets(lines);
  return {
    file: {
      id: fileId,
      absolutePath: `/fixture/${path}`,
      relativePath: path,
      rootPath: "/fixture",
      sizeBytes: source.length,
      lastModifiedTime: 1,
      contentHash: fileId,
      kind: "code",
      format: language,
      indexStatus: { indexedTime: 1, entityCount: 1 },
    },
    entity: {
      id,
      fileId,
      range: {
        kind: "text",
        startLine,
        endLine,
        startOffset: offsets[startLine - 1] ?? 0,
        endOffset: offsets[endLine] ?? source.length,
      },
      content: {
        kind: "text",
        text: lines.slice(startLine - 1, endLine).join("\n"),
      },
      metadata: {
        kind: "code",
        symbolType: kind,
        symbolName: name,
        scope: null,
        nodeType: kind,
        signature: name,
        arity: 0,
        doc: null,
        modifiers: [],
      },
    },
  };
}

function definitionLine(lines, language, name, kind) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns =
    kind === containerKind(language)
      ? [
          new RegExp(
            `\\b(?:class|struct|interface|trait|impl)\\s+${escaped}\\b`,
          ),
        ]
      : language === "python"
        ? [new RegExp(`\\bdef\\s+${escaped}\\b`)]
        : language === "go"
          ? [new RegExp(`\\bfunc\\s+(?:\\([^)]*\\)\\s*)?${escaped}\\b`)]
          : language === "rust"
            ? [new RegExp(`\\bfn\\s+${escaped}\\b`)]
            : [new RegExp(`\\b${escaped}\\s*\\(`)];
  const index = lines.findIndex((line) =>
    patterns.some((pattern) => pattern.test(line)),
  );
  return index >= 0 ? index : lines.findIndex((line) => line.includes(name));
}

function edge(src, dst, kind) {
  return {
    src,
    dst,
    rel: kind.toLowerCase(),
    count: 1,
    first_line: 1,
    ref_name: dst,
    kind,
  };
}

function containerKind(language) {
  return language === "rust" ? "struct" : "class";
}

function methodEnd(lines, startLine) {
  let depth = 0;
  for (let index = startLine - 1; index < lines.length; index += 1) {
    for (const character of lines[index]) {
      if (character === "{") depth += 1;
      if (character === "}") depth -= 1;
    }
    if (index > startLine - 1 && depth <= 0) return index + 1;
  }
  return Math.min(lines.length, startLine + 2);
}

function lineOffsets(lines) {
  const offsets = [0];
  for (const line of lines) offsets.push(offsets.at(-1) + line.length + 1);
  return offsets;
}

function symbolName(entity) {
  return entity.entity.metadata.symbolName ?? "";
}

function testPath(language, path) {
  const file = path.split("/").at(-1);
  if (language === "python") return `tests/test_${file}`;
  if (language === "go") return path.replace(/\.go$/, "_test.go");
  if (language === "rust") return `tests/${file}`;
  if (language === "java") return `src/test/java/${file}`;
  if (language === "typescript") return path.replace(/\.ts$/, ".test.ts");
  return `tests/${file}`;
}

function testSource(language, name) {
  if (language === "python") return `def ${name}():\n    return False`;
  if (language === "go") return `package main\nfunc ${name}() {}`;
  if (language === "rust") return `fn ${name}() {}`;
  if (language === "java") return `class Test { void ${name}() {} }`;
  if (language === "typescript") return `function ${name}() {}`;
  return `void ${name}() {}`;
}

function sourceNeedle(language, name) {
  if (language === "python") return `def ${name}`;
  if (language === "go") return `func ${name}`;
  if (language === "rust") return `fn ${name}`;
  return name;
}

function ratio(value, total) {
  return total === 0 ? 1 : value / total;
}

function precision(value, total) {
  return total === 0 ? 0 : value / total;
}

function queryConcepts(query) {
  return [...new Set(query.toLowerCase().match(/[a-z][a-z0-9_]*/g) ?? [])];
}

function duplicateLineRatio(texts) {
  const linesByFile = texts.map(
    (text) =>
      new Set(
        text
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length >= 8),
      ),
  );
  const occurrences = new Map();
  for (const lines of linesByFile) {
    for (const line of lines)
      occurrences.set(line, (occurrences.get(line) ?? 0) + 1);
  }
  const total = [...occurrences.values()].reduce(
    (sum, count) => sum + count,
    0,
  );
  const duplicates = [...occurrences.values()].reduce(
    (sum, count) => sum + Math.max(0, count - 1),
    0,
  );
  return ratio(duplicates, total);
}

function percent(value) {
  return `${(value * 100).toFixed(0)}%`;
}
