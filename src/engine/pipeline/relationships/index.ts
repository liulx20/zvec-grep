import {
  publicEntityId,
  resolveStoredFragment,
} from "../../storage/entities.js";
import type { FileEdge } from "../../graph/types.js";
import {
  withWorkspaceGraphRead,
  type WorkspaceIndexStorage,
} from "../../storage/index.js";

export type RelationshipSymbol = {
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
};

export type SymbolRelationships = RelationshipSymbol & {
  totalEdges: number;
  edges: {
    symbol: RelationshipSymbol | null;
    line: number | null;
    column: number | null;
  }[];
};

export function getCallers(
  root: string,
  symbol: string,
  limit?: number,
): Promise<SymbolRelationships[]> {
  return withWorkspaceGraphRead(root, (entities, graph) =>
    querySymbolRelationships(
      symbol,
      entities,
      (id) => graph.getCallers(id),
      limit,
    ),
  );
}

export function getCallees(
  root: string,
  symbol: string,
  limit?: number,
): Promise<SymbolRelationships[]> {
  return withWorkspaceGraphRead(root, (entities, graph) =>
    querySymbolRelationships(
      symbol,
      entities,
      (id) => graph.getCallees(id),
      limit,
    ),
  );
}

/** Prefer exact definitions, then use full-text recall; keep candidates in separate groups. */
export async function querySymbolRelationships(
  symbol: string,
  storage: WorkspaceIndexStorage,
  queryEdges: (entityId: string) => Promise<FileEdge[]>,
  limit = 20,
): Promise<SymbolRelationships[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("Relationship limit must be a positive safe integer");
  }
  const name = symbol.trim();
  if (!name) throw new Error("Symbol name must not be empty");
  const symbols = new Map<string, RelationshipSymbol | null>();
  const describe = (
    stored: ReturnType<WorkspaceIndexStorage["getEntity"]>,
  ): RelationshipSymbol | null => {
    if (!stored) return null;
    const { entity, file } = stored;
    const metadata = entity.metadata;
    if (
      metadata?.kind !== "code" ||
      !metadata.symbolName ||
      entity.range.kind !== "text"
    )
      return null;
    return {
      name: metadata.scope
        ? `${metadata.scope}::${metadata.symbolName}`
        : metadata.symbolName,
      filePath: file.relativePath,
      startLine: entity.range.startLine,
      endLine: entity.range.endLine,
    };
  };
  const resolve = (id: string): RelationshipSymbol | null => {
    if (!symbols.has(id)) symbols.set(id, describe(storage.getEntity(id)));
    return symbols.get(id) ?? null;
  };
  const matches: SymbolRelationships[] = [];
  const seen = new Set<string>();
  const separator = name.lastIndexOf("::");
  const symbolName = separator < 0 ? name : name.slice(separator + 2);
  const scope = separator < 0 ? undefined : name.slice(0, separator);
  if (!symbolName) throw new Error("Symbol name must not be empty");
  const definitions = storage.findSymbols(symbolName, scope);
  if (definitions.length === 0) {
    const recalled = new Set<string>();
    for (const hit of storage.searchFts(symbolName.toLowerCase(), 100)) {
      const id = publicEntityId(hit.fragment);
      if (recalled.has(id)) continue;
      recalled.add(id);
      const stored = resolveStoredFragment(hit, storage);
      if (
        stored &&
        stored.file.indexStatus?.indexedTime != null &&
        stored.entity.metadata?.kind === "code" &&
        (scope === undefined || stored.entity.metadata.scope === scope)
      )
        definitions.push(stored);
    }
  }
  for (const stored of definitions) {
    symbols.set(stored.entity.id, describe(stored));
  }
  for (const { entity } of definitions) {
    const description = symbols.get(entity.id);
    if (!description || seen.has(entity.id)) continue;
    seen.add(entity.id);
    const allEdges = await queryEdges(entity.id);
    const edges = allEdges.slice(0, limit);
    matches.push({
      ...description,
      totalEdges: allEdges.length,
      edges: edges.map((edge) => ({
        symbol: resolve(edge.source === entity.id ? edge.target : edge.source),
        line: edge.line,
        column: edge.column,
      })),
    });
  }
  return matches.sort(
    (a, b) =>
      a.filePath.localeCompare(b.filePath) ||
      a.startLine - b.startLine ||
      a.name.localeCompare(b.name),
  );
}
