import { CodeExtractor } from "../../dist/engine/extraction/code/extractor.js";
import {
  extractFileGraph,
  SqliteGraphStorage,
} from "../../dist/engine/graph/index.js";

export function codeFile(
  relativePath = "mod.ts",
  { id = "file-1", format = "typescript", collectionId = "collection-1" } = {},
) {
  return {
    id,
    collectionId,
    absolutePath: `/repo/${relativePath}`,
    relativePath,
    rootPath: "/repo",
    sizeBytes: 100,
    lastModifiedTime: 1,
    kind: "code",
    format,
  };
}

export function graphEntity(id, name, path = "a.ts", options = {}) {
  const symbolType = options.symbolType ?? "class";
  const startLine = options.startLine ?? 1;
  const endLine = options.endLine ?? 3;
  const file = codeFile(path, {
    id: `file-${path}`,
    collectionId: "c",
    format: options.format ?? "typescript",
  });
  return {
    file,
    entity: {
      id,
      fileId: file.id,
      range: {
        kind: "text",
        startLine,
        endLine,
        startOffset: 0,
        endOffset: 10,
      },
      content: {
        kind: "text",
        text:
          options.text ??
          (symbolType === "class"
            ? `export class ${name} {\n  run() {}\n}`
            : `function ${name}() {\n  return 1;\n}`),
      },
      metadata: {
        kind: "code",
        symbolType,
        symbolName: name,
        scope: null,
        nodeType:
          options.nodeType ??
          (symbolType === "class"
            ? "class_declaration"
            : "function_declaration"),
        signature:
          options.signature ??
          (symbolType === "class" ? `class ${name}` : `function ${name}()`),
        doc: null,
        modifiers: ["exported"],
      },
    },
  };
}

export function entityStorage(entities) {
  const byId = new Map(entities.map((item) => [item.entity.id, item]));
  return {
    findSymbolsByName(name) {
      const leaf = name
        .replace(/(?:\.|->)/g, "::")
        .split("::")
        .at(-1);
      return [...byId.values()].filter(
        (item) =>
          item.entity.metadata.symbolName?.toLowerCase() === leaf.toLowerCase(),
      );
    },
    findSymbolsByQuery(query) {
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      return [...byId.values()].filter((item) => {
        const text = `${item.entity.metadata.symbolName} ${item.file.relativePath} ${item.entity.content.text}`;
        return terms.some((term) => text.toLowerCase().includes(term));
      });
    },
    getEntity(id) {
      return byId.get(id) ?? null;
    },
  };
}

export async function extractGraph(file, text) {
  const source = { kind: "text", file, text };
  return extractSourceGraph(source);
}

export async function extractSourceGraph(source) {
  return extractFileGraph(source, await new CodeExtractor().extract(source));
}

export async function resolveGraph(file, input) {
  const storage = new SqliteGraphStorage("", { inMemory: true });
  upsertGraph(storage, file, input);
  await storage.resolvePending();
  return storage;
}

export function upsertGraph(storage, file, input) {
  storage.upsertFileGraph(file.id, input.nodes, input.edges, input.refs, file);
}
