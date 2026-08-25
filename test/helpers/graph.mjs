import { CodeExtractor } from "../../dist/engine/extraction/code/extractor.js";
import {
  extractFileGraph,
  SqliteGraphStorage,
} from "../../dist/engine/graph/index.js";

export function codeFile(
  relativePath = "mod.ts",
  { id = "file-1", format = "typescript" } = {},
) {
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

export async function extractGraph(file, text) {
  const source = { kind: "text", file, text };
  return extractSourceGraph(source);
}

export async function extractSourceGraph(source) {
  return extractFileGraph(source, await new CodeExtractor().extract(source));
}

export async function resolveGraph(file, input) {
  const storage = new SqliteGraphStorage("", { inMemory: true });
  storage.upsertFileGraph(file.id, input.nodes, input.edges, input.refs, file);
  await storage.resolvePending();
  return storage;
}
