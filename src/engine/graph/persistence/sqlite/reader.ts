import { readFileSync } from "node:fs";
import type { DatabaseSync as NodeDatabaseSync } from "node:sqlite";
import type { ReferenceResolutionHints } from "../../../reference-target.js";
import type { StoredEntity } from "../../../storage/index.js";
import type {
  CodeSymbolType,
  CodeEntityModifier,
  FileInfo,
  FileKind,
  Range,
} from "../../../types.js";
import { SqliteGraphDatabase } from "./database.js";
import { SemanticCandidateRepository } from "./candidate-repository.js";
import { symbolLookupLeaf } from "../../symbol-lookup.js";
import type {
  ContainerNeighbor,
  FileNeighbor,
  GraphEdge,
  GraphEdgeKind,
  DynamicBoundary,
  GraphStats,
  InducedEdgesResult,
  SeedNeighbor,
  SymContext,
  SymRef,
  TraverseOpts,
  UsageRef,
} from "../../types.js";

export type EdgeRow = {
  source: string;
  target: string;
  kind: "CALLS" | "REFS" | "INHERITS" | "IMPORTS" | "INSTANTIATES";
  rel: string;
  count: number;
  first_line: number;
  ref_name: string;
  provenance: "static" | "heuristic";
  metadata: string | null;
};

const MAX_TRAVERSAL_EDGE_READ = 10_000;
const EDGE_AGGREGATE_COLUMNS = `source,target,kind,
  COALESCE(json_extract(metadata,'$.rel'),kind) AS rel,
  COALESCE(json_extract(metadata,'$.count'),1) AS count,
  COALESCE(line,0) AS first_line,
  COALESCE(json_extract(metadata,'$.refName'),'') AS ref_name,
  CASE WHEN provenance='static' OR provenance='tree-sitter' THEN 'static' ELSE 'heuristic' END AS provenance,
  metadata`;
const GRAPH_EDGE_AGGREGATE_COLUMNS = `source,target,kind,
  COALESCE(json_extract(metadata,'$.rel'),kind) AS rel,
  COALESCE(json_extract(metadata,'$.count'),1) AS count,
  COALESCE(line,0) AS first_line,
  COALESCE(json_extract(metadata,'$.refName'),'') AS ref_name,
  CASE WHEN provenance='static' OR provenance='tree-sitter' THEN 'static' ELSE 'heuristic' END AS provenance,
  metadata`;

const IMPACT_CONTAINER_KINDS = new Set([
  "class",
  "interface",
  "struct",
  "trait",
  "protocol",
  "module",
  "enum",
]);

export type RefRow = {
  id: string;
  owner_id: string;
  owner_is_file: number;
  ref_name: string;
  ref_kind: string;
  line: number;
  status: "pending" | "failed" | "external";
  imported_name: string | null;
  local_name: string | null;
  source_language: string | null;
  receiver_kind: "owner" | "super" | "qualified" | null;
  receiver_name: string | null;
  member_name: string | null;
  resolution_hints: string | null;
  last_attempt: number;
};

export type SymbolRow = {
  id: string;
  file_id: string;
  name: string | null;
  qualified_name?: string | null;
  signature?: string | null;
  kind: string;
  is_exported: number;
};

type EntityProjectionRow = SymbolRow & {
  arity: number | null;
  range_json: string | null;
  scope: string | null;
  node_type: string | null;
  modifiers_json: string | null;
  absolute_path: string;
  relative_path: string;
  root_path: string;
  size_bytes: number;
  last_modified_time: number;
  file_kind: string;
  format: string;
};

type StemFileRow = { stem: string; file_id: string };

const REL_KINDS = new Set<GraphEdgeKind>(["CALLS", "REFS", "INHERITS"]);
const ALL_EDGE_KINDS: readonly GraphEdgeKind[] = [
  "CALLS",
  "REFS",
  "INHERITS",
  "CONTAINS",
  "DEFINES",
  "IMPORTS",
  "INSTANTIATES",
];

const ENTITY_PROJECTION_SELECT = `SELECT
  n.id,n.file_path AS file_id,n.name,n.qualified_name,n.signature,
  n.kind,n.is_exported,
  n.arity AS arity,
  json_object('kind','text','startLine',n.start_line,'endLine',n.end_line,
              'startColumn',n.start_column,'endColumn',n.end_column,
              'startOffset',-1,'endOffset',-1) AS range_json,
  NULL AS scope,
  n.kind AS node_type,
  n.decorators AS modifiers_json,
  n.file_path AS absolute_path,
  n.file_path AS relative_path,
  n.file_path AS root_path,
  COALESCE(f.size,0) AS size_bytes,
  COALESCE(f.modified_at,0) AS last_modified_time,
  'file' AS file_kind,
  n.language AS format
 FROM nodes n
 JOIN files f ON f.path=n.file_path
`;

function escapeLike(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}

function parseRange(json: string | null): Range {
  if (!json) return { kind: "file" };
  try {
    const parsed = JSON.parse(json) as Range;
    return parsed && typeof parsed === "object" && "kind" in parsed
      ? parsed
      : { kind: "file" };
  } catch {
    return { kind: "file" };
  }
}

function parseModifiers(
  json: string | null,
  isExported: number,
): readonly CodeEntityModifier[] {
  if (json) {
    try {
      const parsed = JSON.parse(json) as unknown;
      if (Array.isArray(parsed)) return parsed as CodeEntityModifier[];
    } catch {
      // Fall through to the minimal projection for malformed legacy data.
    }
  }
  return isExported ? ["exported"] : [];
}

function sourceForRange(source: string, range: Range): string {
  if (
    (range.kind === "text" || range.kind === "byte") &&
    range.startOffset >= 0 &&
    range.endOffset >= range.startOffset
  )
    return source.slice(range.startOffset, range.endOffset);
  return source;
}

function publicSymbolType(kind: string): CodeSymbolType {
  switch (kind) {
    case "class":
    case "abstract_class":
      return "class";
    case "interface":
    case "trait":
    case "protocol":
      return "interface";
    case "module":
    case "namespace":
      return "module";
    case "component":
      return "component";
    case "alias":
      return "alias";
    case "value":
    case "field":
    case "property":
    case "variable":
      return "value";
    default:
      return "function";
  }
}

function dbKind(kind: GraphEdgeKind): string {
  switch (kind) {
    case "CALLS":
      return "calls";
    case "REFS":
      return "references";
    case "INHERITS":
      return "extends";
    case "CONTAINS":
      return "contains";
    case "DEFINES":
      return "defines";
    case "IMPORTS":
      return "imports";
    case "INSTANTIATES":
      return "instantiates";
  }
}

function upperKind(kind: string): GraphEdgeKind | undefined {
  switch (kind) {
    case "calls":
      return "CALLS";
    case "references":
      return "REFS";
    case "extends":
      return "INHERITS";
    case "contains":
      return "CONTAINS";
    case "defines":
      return "DEFINES";
    case "imports":
      return "IMPORTS";
    case "instantiates":
      return "INSTANTIATES";
  }
  return undefined;
}

/** Indexed SQLite graph reader without a full-memory mirror. */
export class SqliteGraphReader {
  private readonly candidates: SemanticCandidateRepository;
  readonly available = true;
  protected readonly db: NodeDatabaseSync;
  protected readonly readOnly: boolean;
  protected readonly database: SqliteGraphDatabase;
  private readonly sourceText = new Map<string, string | null>();

  constructor(
    directory: string | SqliteGraphDatabase,
    options: { readOnly?: boolean; inMemory?: boolean } = {},
  ) {
    this.database =
      directory instanceof SqliteGraphDatabase
        ? directory
        : new SqliteGraphDatabase(directory, options);
    this.db = this.database.db;
    this.readOnly = this.database.readOnly;
    this.candidates = new SemanticCandidateRepository(this.database);
  }

  close(): void {
    this.database.close();
  }

  getEntity(entityId: string): StoredEntity | null {
    const row = this.database.one<EntityProjectionRow>(
      `${ENTITY_PROJECTION_SELECT} WHERE n.id=?`,
      entityId,
    );
    return row ? this.projectEntity(row) : null;
  }

  findSymbolsByName(name: string, limit: number): StoredEntity[] {
    const trimmed = symbolLookupLeaf(name.trim());
    if (!trimmed || limit <= 0) return [];
    return this.database
      .all<EntityProjectionRow>(
        `${ENTITY_PROJECTION_SELECT}
         WHERE n.name=? COLLATE NOCASE
         ORDER BY n.is_exported DESC,n.id
         LIMIT ?`,
        trimmed,
        limit,
      )
      .map((row) => this.projectEntity(row));
  }

  findSymbolsByFileStems(
    stems: readonly string[],
    limitPerStem: number,
  ): ReadonlyMap<string, readonly StoredEntity[]> {
    const requested = [
      ...new Map(
        stems
          .map((stem) => stem.trim())
          .filter(Boolean)
          .map((stem) => [stem.toLowerCase(), stem]),
      ).values(),
    ];
    const result = new Map<string, StoredEntity[]>();
    for (const stem of requested) result.set(stem.toLowerCase(), []);
    if (requested.length === 0 || limitPerStem <= 0) return result;

    const matches = this.database.all<StemFileRow>(
      `WITH requested(stem) AS (SELECT value FROM json_each(?))
       SELECT requested.stem,f.path AS file_id
       FROM requested
       JOIN files f ON
         lower(f.path) LIKE lower(requested.stem) || '.%' OR
         lower(f.path) LIKE '%/' || lower(requested.stem) || '.%'
       ORDER BY requested.stem,f.path`,
      JSON.stringify(requested),
    );
    const fileIds = [...new Set(matches.map((match) => match.file_id))];
    if (fileIds.length === 0) return result;
    const entitiesByFile = new Map<string, StoredEntity[]>();
    for (const row of this.database.all<EntityProjectionRow>(
      `${ENTITY_PROJECTION_SELECT}
       WHERE n.file_path IN (SELECT value FROM json_each(?))
       ORDER BY n.is_exported DESC,n.id`,
      JSON.stringify(fileIds),
    )) {
      const entity = this.projectEntity(row);
      const group = entitiesByFile.get(entity.file.id) ?? [];
      group.push(entity);
      entitiesByFile.set(entity.file.id, group);
    }
    for (const match of matches) {
      const key = match.stem.toLowerCase();
      const group = result.get(key)!;
      for (const entity of entitiesByFile.get(match.file_id) ?? []) {
        if (group.length >= limitPerStem) break;
        group.push(entity);
      }
    }
    return result;
  }

  findSymbolsByQuery(query: string, limit: number): StoredEntity[] {
    const terms = [...new Set(query.match(/[\p{L}\p{N}_$]+/gu) ?? [])]
      .filter((term) => term.length > 1)
      .slice(0, 8);
    if (limit <= 0 || terms.length === 0) return [];
    const clauses = terms.map(
      () =>
        `(n.name LIKE ? ESCAPE '\\' COLLATE NOCASE OR
          n.qualified_name LIKE ? ESCAPE '\\' COLLATE NOCASE OR
          n.signature LIKE ? ESCAPE '\\' COLLATE NOCASE OR
          f.path LIKE ? ESCAPE '\\' COLLATE NOCASE)`,
    );
    const whereParams = terms.flatMap((term) => {
      const pattern = `%${escapeLike(term)}%`;
      return [pattern, pattern, pattern, pattern];
    });
    const scoreClauses = terms.map(
      () => `(CASE
        WHEN n.name=? COLLATE NOCASE THEN 240
        WHEN n.name LIKE ? ESCAPE '\\' COLLATE NOCASE THEN 120
        WHEN n.name LIKE ? ESCAPE '\\' COLLATE NOCASE THEN 80
        ELSE 0 END
       + CASE WHEN n.qualified_name LIKE ? ESCAPE '\\' COLLATE NOCASE THEN 35 ELSE 0 END
       + CASE WHEN n.signature LIKE ? ESCAPE '\\' COLLATE NOCASE THEN 18 ELSE 0 END
       + CASE WHEN f.path LIKE ? ESCAPE '\\' COLLATE NOCASE THEN 24 ELSE 0 END)`,
    );
    const scoreParams = terms.flatMap((term) => {
      const escaped = escapeLike(term);
      return [
        term,
        `${escaped}%`,
        `%${escaped}%`,
        `%${escaped}%`,
        `%${escaped}%`,
        `%${escaped}%`,
      ];
    });
    return this.database
      .all<EntityProjectionRow>(
        `${ENTITY_PROJECTION_SELECT}
         WHERE ${clauses.join(" OR ")}
         ORDER BY (${scoreClauses.join(" + ")}) DESC,
                  n.is_exported DESC,
                  n.id
         LIMIT ?`,
        ...whereParams,
        ...scoreParams,
        limit,
      )
      .map((row) => this.projectEntity(row));
  }

  readFileText(file: FileInfo): string | null {
    if (this.sourceText.has(file.absolutePath))
      return this.sourceText.get(file.absolutePath)!;
    let text: string | null = null;
    try {
      text = readFileSync(file.absolutePath, "utf8");
    } catch {
      // Current source is optional; callers retain indexed-fragment fallback.
    }
    this.sourceText.set(file.absolutePath, text);
    return text;
  }

  private projectEntity(row: EntityProjectionRow): StoredEntity {
    const file: FileInfo = {
      id: row.file_id,
      absolutePath: row.absolute_path,
      relativePath: row.relative_path,
      rootPath: row.root_path,
      sizeBytes: row.size_bytes,
      lastModifiedTime: row.last_modified_time,
      kind: row.file_kind as FileKind,
      format: row.format,
    };
    const range = parseRange(row.range_json);
    const source = this.readFileText(file);
    const contentText = source === null ? "" : sourceForRange(source, range);
    const qualified = row.qualified_name ?? row.name ?? "";
    const separator = qualified.lastIndexOf("::");
    const modifiers = parseModifiers(row.modifiers_json, row.is_exported);
    return {
      file,
      entity: {
        id: row.id,
        fileId: row.file_id,
        range,
        content: { kind: "text", text: contentText },
        metadata: {
          kind: "code",
          symbolType: publicSymbolType(row.kind),
          symbolName: row.name,
          scope:
            row.scope ??
            (separator >= 0 ? qualified.slice(0, separator) : null),
          nodeType: row.node_type ?? row.kind,
          signature: row.signature ?? null,
          arity: row.arity,
          doc: null,
          modifiers,
        },
      },
    };
  }

  findSymbolIdsByName(name: string, limit: number): string[] {
    const trimmed = name.trim();
    if (!trimmed || limit <= 0) return [];
    const exact = this.all<{ id: string }>(
      `SELECT id
       FROM nodes
       WHERE name = ?
       ORDER BY is_exported DESC, id
       LIMIT ?`,
      trimmed,
      limit,
    );
    if (exact.length > 0) return exact.map((row) => row.id);
    return this.all<{ id: string }>(
      `SELECT id
       FROM nodes
       WHERE name = ? COLLATE NOCASE
       ORDER BY is_exported DESC, id
       LIMIT ?`,
      trimmed,
      limit,
    ).map((row) => row.id);
  }

  dynamicBoundaries(
    nodeIds: readonly string[],
    limit: number,
  ): DynamicBoundary[] {
    if (nodeIds.length === 0 || limit <= 0) return [];
    const ids = [...new Set(nodeIds)];
    const placeholders = ids.map(() => "?").join(",");
    const persistedRows = this.all<{
      id: number;
      owner_id: string;
      ref_name: string;
      member_name: string | null;
      receiver_kind: "owner" | "super" | "qualified" | null;
      receiver_name: string | null;
      resolution_hints: string | null;
      reason: string;
      occurrence_count: number;
    }>(
      `WITH ranked AS (
         SELECT CAST(id AS TEXT) AS id,from_node_id AS owner_id,reference_name AS ref_name,
                json_extract(metadata,'$.member') AS member_name,
                json_extract(metadata,'$.receiverKind') AS receiver_kind,
                json_extract(metadata,'$.receiverName') AS receiver_name,
                json_extract(metadata,'$.resolutionHints') AS resolution_hints,
                'polymorphic_dispatch' AS reason,
                line,
                json_type(candidates) AS has_candidates,
                COUNT(*) OVER (
                  PARTITION BY from_node_id,reference_name,
                               json_extract(metadata,'$.member'),
                               json_extract(metadata,'$.receiverKind'),
                               json_extract(metadata,'$.receiverName')
                ) AS occurrence_count,
                ROW_NUMBER() OVER (
                  PARTITION BY from_node_id,reference_name,
                               json_extract(metadata,'$.member'),
                               json_extract(metadata,'$.receiverKind'),
                               json_extract(metadata,'$.receiverName')
                  ORDER BY line,id
                ) AS occurrence_rank
         FROM unresolved_refs
         WHERE status='dynamic' AND reference_kind='calls'
           AND from_node_id IN (${placeholders})
       )
       SELECT id,owner_id,ref_name,member_name,receiver_kind,receiver_name,
              resolution_hints,reason,occurrence_count
       FROM ranked WHERE occurrence_rank=1
       ORDER BY has_candidates DESC,owner_id,line,id LIMIT ?`,
      ...ids,
      limit,
    );
    const persisted = persistedRows.map((row): DynamicBoundary => {
      const candidateRows: string[] = [];
      try {
        const parsed = JSON.parse(
          this.one<{ candidates: string }>(
            "SELECT candidates FROM unresolved_refs WHERE id=?",
            row.id,
          )?.candidates ?? "[]",
        ) as unknown;
        if (Array.isArray(parsed)) candidateRows.push(...parsed);
      } catch {
        // ignore
      }
      const uniqueCandidates = [...new Set(candidateRows)];
      const details = uniqueCandidates.slice(0, 64).map((targetId) => ({
        targetId,
        reason: "hierarchy" as const,
        confidence: 0.5,
      }));
      const target = {
        raw: row.ref_name,
        member: row.member_name ?? undefined,
        receiver:
          row.receiver_kind && row.receiver_name
            ? { kind: row.receiver_kind, name: row.receiver_name }
            : undefined,
        ...resolutionHintsField(row.resolution_hints),
      } as DynamicBoundary["target"];
      return {
        sourceId: row.owner_id,
        target,
        reason: row.reason as DynamicBoundary["reason"],
        candidates: details.map((d) => d.targetId),
        candidatesTruncated: uniqueCandidates.length > 64,
        ...(row.occurrence_count > 1
          ? { occurrenceCount: row.occurrence_count }
          : {}),
        candidateDetails: details,
      };
    });
    const remaining = Math.max(0, limit - persisted.length);
    if (remaining === 0) return persisted;
    const failedRows = this.all<RefRow & { occurrence_count: number }>(
      `WITH ranked AS (
         SELECT CAST(unresolved_refs.id AS TEXT) AS id,from_node_id AS owner_id,
                CASE WHEN files.path IS NOT NULL THEN 1 ELSE 0 END AS owner_is_file,
                reference_name AS ref_name,reference_kind AS ref_kind,line,status,
                json_extract(metadata,'$.importedName') AS imported_name,
                json_extract(metadata,'$.localName') AS local_name,
                unresolved_refs.language AS source_language,
                json_extract(metadata,'$.receiverKind') AS receiver_kind,
                json_extract(metadata,'$.receiverName') AS receiver_name,
                json_extract(metadata,'$.member') AS member_name,
                json_extract(metadata,'$.resolutionHints') AS resolution_hints,
                0 AS last_attempt,
                COUNT(*) OVER (
                  PARTITION BY from_node_id,reference_name,
                               json_extract(metadata,'$.member'),
                               json_extract(metadata,'$.receiverKind'),
                               json_extract(metadata,'$.receiverName')
                ) AS occurrence_count,
                ROW_NUMBER() OVER (
                  PARTITION BY from_node_id,reference_name,
                               json_extract(metadata,'$.member'),
                               json_extract(metadata,'$.receiverKind'),
                               json_extract(metadata,'$.receiverName')
                  ORDER BY line,id
                ) AS occurrence_rank
         FROM unresolved_refs
         LEFT JOIN files ON files.path=from_node_id
         WHERE status='failed' AND reference_kind='calls'
           AND json_extract(metadata,'$.receiverKind') IS NOT NULL
           AND from_node_id IN (${placeholders})
       )
       SELECT id,owner_id,owner_is_file,ref_name,ref_kind,line,status,
              imported_name,local_name,source_language,receiver_kind,
              receiver_name,member_name,resolution_hints,last_attempt,
              occurrence_count
       FROM ranked WHERE occurrence_rank=1
       ORDER BY owner_id,line,id LIMIT ?`,
      ...ids,
      remaining,
    );
    const failedCandidateCache = new Map<string, string[]>();
    const unresolved = failedRows.map((row): DynamicBoundary => {
      const hints = parseResolutionHints(row.resolution_hints);
      const target = {
        raw: row.ref_name,
        member: row.member_name ?? row.ref_name,
        receiver:
          row.receiver_kind && row.receiver_name
            ? { kind: row.receiver_kind, name: row.receiver_name }
            : undefined,
        ...resolutionHintsField(row.resolution_hints),
      } as DynamicBoundary["target"];
      let candidateRows: string[] = [];
      if (hints?.receiverType) {
        const typeNames = hints.candidateTypes ?? [hints.receiverType];
        const cacheKey = JSON.stringify([
          row.owner_id,
          row.source_language,
          typeNames,
          target.member,
          hints.callArity ?? null,
        ]);
        const cached = failedCandidateCache.get(cacheKey);
        if (cached) {
          candidateRows = cached;
        } else {
          candidateRows = this.candidates.findConcrete({
            sourceId: row.owner_id,
            sourceLanguage: row.source_language ?? undefined,
            typeNames,
            memberName: target.member,
            callArity: hints.callArity,
            limit: 65,
          });
          failedCandidateCache.set(cacheKey, candidateRows);
        }
      }
      const candidates = candidateRows.slice(0, 64);
      return {
        sourceId: row.owner_id,
        target,
        reason: hints?.lexicallyBound
          ? "lexical_dispatch"
          : candidates.length > 1 || hints?.dispatch
            ? "polymorphic_dispatch"
            : row.receiver_kind === "owner" || row.receiver_kind === "super"
              ? "polymorphic_dispatch"
              : "unknown_receiver_type",
        candidates,
        candidatesTruncated: candidateRows.length > 64,
        ...(row.occurrence_count > 1
          ? { occurrenceCount: row.occurrence_count }
          : {}),
        candidateDetails: candidates.map((targetId) => ({
          targetId,
          reason: hints?.genericBounds?.length
            ? ("generic_bound" as const)
            : ("hierarchy" as const),
          confidence: 0.5,
        })),
      };
    });
    return [...persisted, ...unresolved];
  }

  dynamicBoundarySources(
    targetIds: readonly string[],
    limit: number,
  ): SymRef[] {
    if (targetIds.length === 0 || limit <= 0) return [];
    const ids = [...new Set(targetIds)];
    const placeholders = ids.map(() => "?").join(",");
    return this.all<{ id: string }>(
      `SELECT DISTINCT from_node_id AS id
       FROM unresolved_refs
       WHERE status='dynamic' AND reference_kind='calls'
         AND EXISTS(
           SELECT 1 FROM json_each(candidates)
           WHERE value IN (${placeholders})
         )
       ORDER BY from_node_id
       LIMIT ?`,
      ...ids,
      limit,
    );
  }

  symbolScope(root: string, depth: number, limit: number): string[] {
    return this.traverse(root, {
      edgeKinds: ["CALLS", "REFS"],
      direction: "both",
      maxDepth: depth,
      limit,
    }).map((r) => r.id);
  }

  fileScope(fileId: string, depth: number, limit: number): string[] {
    return this.bfs(fileId, ["IMPORTS"], "both", depth, limit).map((r) => r.id);
  }

  expandSeeds(symIds: readonly string[], limit: number): SeedNeighbor[] {
    const out: SeedNeighbor[] = [];
    for (const sid of symIds) {
      for (const edge of this.adjacentEdges([sid], ["CALLS"], "both", limit)) {
        out.push({
          sid,
          id: edge.src === sid ? edge.dst : edge.src,
          count: edge.count,
          direction: edge.src === sid ? "out" : "in",
        });
      }
    }
    return out;
  }

  expandContainers(
    symIds: readonly string[],
    limit: number,
  ): ContainerNeighbor[] {
    const out: ContainerNeighbor[] = [];
    for (const sid of symIds) {
      const parent = this.one<{ parent_id: string }>(
        `SELECT source AS parent_id FROM edges
         WHERE kind='contains' AND target=?
         ORDER BY source LIMIT 1`,
        sid,
      )?.parent_id;
      if (!parent) continue;
      const sibs = this.all<{ child_id: string }>(
        `SELECT target AS child_id FROM edges
         WHERE kind='contains' AND source=?
           AND target<>?
         ORDER BY target LIMIT ?`,
        parent,
        sid,
        limit,
      );
      if (sibs.length === 0) out.push({ sid, parent_id: parent, sib_id: null });
      else
        for (const s of sibs)
          out.push({ sid, parent_id: parent, sib_id: s.child_id });
    }
    return out;
  }

  expandFileNeighbors(
    fileIds: readonly string[],
    limit: number,
  ): FileNeighbor[] {
    const out: FileNeighbor[] = [];
    for (const fid of fileIds) {
      for (const edge of this.adjacentEdges(
        [fid],
        ["IMPORTS"],
        "both",
        limit,
      )) {
        out.push({
          fid,
          id: edge.src === fid ? edge.dst : edge.src,
          direction: edge.src === fid ? "out" : "in",
        });
      }
    }
    return out;
  }

  importedSymbols(fileIds: readonly string[], limit: number): SymRef[] {
    const ids = [...new Set(fileIds)];
    const budget = Math.max(0, Math.floor(limit));
    if (ids.length === 0 || budget === 0) return [];
    return this.all<SymRef>(
      `SELECT DISTINCT n.id,n.kind
       FROM edges binding
       JOIN nodes n ON n.file_path=binding.target
       WHERE binding.kind='imports'
         AND json_extract(binding.metadata,'$.importedName') IS NOT NULL
         AND json_extract(binding.metadata,'$.importedName') NOT IN ('*','default')
         AND binding.source IN (SELECT value FROM json_each(?))
       ORDER BY n.id
       LIMIT ?`,
      JSON.stringify(ids),
      budget,
    );
  }

  callers(id: string, depth: number, limit: number): SymRef[] {
    return this.bfs(id, ["CALLS", "INSTANTIATES"], "incoming", depth, limit);
  }

  callees(id: string, depth: number, limit: number): SymRef[] {
    if (depth <= 1)
      return this.all<{
        target: string;
        kind: string | null;
        count: number;
      }>(
        `SELECT edge.target AS target,MAX(n.kind) AS kind,
                SUM(COALESCE(json_extract(edge.metadata,'$.count'),1)) AS count
         FROM edges edge
         LEFT JOIN nodes n ON n.id=edge.target
         WHERE edge.source=? AND edge.kind IN('calls','instantiates')
         GROUP BY edge.target ORDER BY count DESC,edge.target LIMIT ?`,
        id,
        limit,
      ).map((e) => ({
        id: e.target,
        kind: e.kind ?? undefined,
        count: e.count,
      }));
    return this.bfs(id, ["CALLS", "INSTANTIATES"], "outgoing", depth, limit);
  }

  impact(id: string, depth: number, limit: number): SymRef[] {
    if (limit <= 0) return [];
    const seen = new Set([id]);
    const expanded = new Set<string>();
    const ordered: string[] = [];
    let frontier = [id];

    for (
      let currentDepth = 0;
      currentDepth < clampDepth(depth) && frontier.length > 0;
      currentDepth++
    ) {
      const scope = this.expandImpactScope(frontier, expanded);
      for (const memberId of scope.members) {
        if (seen.has(memberId)) continue;
        seen.add(memberId);
      }
      const active = new Set(scope.ids);
      const next: string[] = [];
      const remaining = limit - ordered.length;
      if (remaining <= 0) return this.refsForIds(ordered);
      let edgeBudget = Math.min(
        MAX_TRAVERSAL_EDGE_READ,
        Math.max(1, remaining),
      );

      while (next.length < remaining) {
        const incoming = this.incomingEdges(
          scope.ids,
          ["CALLS", "REFS", "INHERITS", "INSTANTIATES"],
          edgeBudget,
        );
        for (const edge of incoming) {
          if (!active.has(edge.dst) || seen.has(edge.src)) continue;
          seen.add(edge.src);
          ordered.push(edge.src);
          next.push(edge.src);
          if (ordered.length >= limit) return this.refsForIds(ordered);
        }
        if (
          incoming.length < edgeBudget ||
          edgeBudget >= MAX_TRAVERSAL_EDGE_READ
        ) {
          break;
        }
        edgeBudget = Math.min(MAX_TRAVERSAL_EDGE_READ, edgeBudget * 2);
      }
      if (next.length < remaining) {
        const dynamicSources = this.dynamicBoundarySources(
          scope.ids,
          remaining - next.length,
        );
        for (const source of dynamicSources) {
          if (seen.has(source.id)) continue;
          seen.add(source.id);
          ordered.push(source.id);
          next.push(source.id);
          if (ordered.length >= limit) return this.refsForIds(ordered);
        }
      }
      frontier = next;
    }
    return this.refsForIds(ordered);
  }

  usages(id: string, limit: number): UsageRef[] {
    return this.all<EdgeRow>(
      `SELECT ${EDGE_AGGREGATE_COLUMNS}
       FROM edges WHERE target=?
       GROUP BY source,target,kind,COALESCE(json_extract(metadata,'$.rel'),kind)
       ORDER BY first_line LIMIT ?`,
      id,
      limit,
    ).map((e) => ({
      id: e.source,
      rel: e.rel,
      first_line: e.first_line,
      count: e.count,
    }));
  }

  pathBetween(
    from: string,
    to: string,
    maxDepth: number,
    edgeLimit = 10_000,
  ): SymRef[] | null {
    if (from === to) return [{ id: from, kind: this.symbolKind(from) }];
    let remainingEdges = Math.max(0, Math.floor(edgeLimit));
    if (remainingEdges === 0) return null;
    const parent = new Map<string, string | null>([[from, null]]);
    let frontier = [from];
    for (
      let depth = 0;
      depth < clampDepth(maxDepth) && frontier.length;
      depth++
    ) {
      const next: string[] = [];
      const edges = this.adjacentEdges(
        frontier,
        ["CALLS"],
        "outgoing",
        remainingEdges,
      );
      remainingEdges -= edges.length;
      for (const edge of edges) {
        if (parent.has(edge.dst)) continue;
        parent.set(edge.dst, edge.src);
        if (edge.dst === to) return this.reconstructPath(parent, to);
        next.push(edge.dst);
      }
      if (remainingEdges <= 0) return null;
      frontier = next;
    }
    return null;
  }

  hierarchy(
    id: string,
    direction: "bases" | "derived",
    limit: number,
  ): SymRef[] {
    return this.bfs(
      id,
      ["INHERITS"],
      direction === "bases" ? "outgoing" : "incoming",
      10,
      limit,
    );
  }

  hierarchyDiverse(
    id: string,
    direction: "bases" | "derived",
    limit: number,
  ): SymRef[] {
    if (limit <= 0) return [];
    const source = direction === "bases" ? "source" : "target";
    const target = direction === "bases" ? "target" : "source";
    return this.all<{ id: string; kind: string }>(
      `WITH RECURSIVE walk(id,depth) AS (
         SELECT ${target},1
         FROM edges
         WHERE kind='extends'
           AND ${source}=?
         UNION
         SELECT edge.${target},walk.depth+1
         FROM walk
         JOIN edges edge ON edge.${source}=walk.id
         WHERE edge.kind='extends'
           AND walk.depth<10
           AND edge.${target}<>?
       ), nearest AS (
         SELECT id,MIN(depth) AS depth FROM walk GROUP BY id
       ), ranked AS (
         SELECT n.id,n.kind,nearest.depth,n.file_path,
                ROW_NUMBER() OVER (
                  PARTITION BY n.file_path
                  ORDER BY nearest.depth,n.id
                ) AS file_rank
         FROM nearest JOIN nodes n ON n.id=nearest.id
       )
       SELECT id,kind FROM ranked
       ORDER BY file_rank,depth,file_path,id LIMIT ?`,
      id,
      id,
      limit,
    );
  }

  members(id: string): SymRef[] {
    return this.all<{ id: string; kind: string }>(
      `SELECT n.id,n.kind FROM nodes n
       JOIN edges e ON e.target=n.id
       WHERE e.kind='contains' AND e.source=?
       ORDER BY n.id`,
      id,
    );
  }

  deadCode(limit: number): SymRef[] {
    return this.all<{ id: string; kind: string }>(
      `SELECT n.id,n.kind FROM nodes n
       WHERE n.is_exported=0 AND n.kind IN ('function','method')
         AND NOT EXISTS(
           SELECT 1 FROM edges edge
           WHERE edge.target=n.id
             AND edge.kind IN ('calls','references','instantiates')
         )
       ORDER BY n.id LIMIT ?`,
      limit,
    );
  }

  context(id: string): SymContext {
    const containers: SymRef[] = [];
    let current = id;
    for (let i = 0; i < 5; i++) {
      const p = this.one<{ parent_id: string }>(
        "SELECT source AS parent_id FROM edges WHERE kind='contains' AND target=?",
        current,
      );
      if (!p) break;
      containers.push({ id: p.parent_id, kind: this.symbolKind(p.parent_id) });
      current = p.parent_id;
    }
    const outgoing = this.outgoingEdges(
      [id],
      ["CALLS", "REFS", "INHERITS", "INSTANTIATES"],
      100,
    ).map((edge) => ({ id: edge.dst, rel: edge.rel }));
    return {
      focal: { id, kind: this.symbolKind(id) },
      containers,
      members: this.members(id),
      incoming: this.usages(id, 100),
      outgoing,
    };
  }

  traverse(id: string, opts: TraverseOpts): SymRef[] {
    const found = this.bfs(
      id,
      opts.edgeKinds,
      opts.direction,
      opts.maxDepth,
      opts.limit,
    );
    return opts.includeStart
      ? [{ id, kind: this.symbolKind(id) }, ...found].slice(0, opts.limit)
      : found;
  }

  outgoingEdges(
    nodeIds: readonly string[],
    edgeKinds: readonly GraphEdgeKind[] = ALL_EDGE_KINDS,
    limit = 1_000,
  ): GraphEdge[] {
    return this.queryDirectionalEdges(nodeIds, edgeKinds, "outgoing", limit);
  }

  incomingEdges(
    nodeIds: readonly string[],
    edgeKinds: readonly GraphEdgeKind[] = ALL_EDGE_KINDS,
    limit = 1_000,
  ): GraphEdge[] {
    return this.queryDirectionalEdges(nodeIds, edgeKinds, "incoming", limit);
  }

  edges(
    nodeIds: readonly string[],
    edgeKinds: readonly GraphEdgeKind[],
    limit: number,
  ): InducedEdgesResult {
    const budget = Math.max(0, Math.floor(limit));
    if (nodeIds.length === 0 || budget === 0)
      return { edges: [], truncated: false };
    const ids = JSON.stringify([...new Set(nodeIds)]);
    const selects: string[] = [];
    const params: (string | number)[] = [];
    const rel = edgeKinds.filter((k) => REL_KINDS.has(k));
    if (rel.length) {
      const p = rel.map(() => "?").join(",");
      selects.push(
        `SELECT ${GRAPH_EDGE_AGGREGATE_COLUMNS}
         FROM edges
         WHERE source IN(SELECT value FROM json_each(?))
           AND target IN(SELECT value FROM json_each(?)) AND kind IN(${p})
         GROUP BY source,target,kind,COALESCE(json_extract(metadata,'$.rel'),kind)`,
      );
      params.push(ids, ids, ...rel.map(dbKind));
    }
    if (edgeKinds.includes("CONTAINS")) {
      selects.push(
        `SELECT source,target,'CONTAINS' AS kind,
                'contains' AS rel,1 AS count,0 AS first_line,'' AS ref_name,
                'static' AS provenance,NULL AS metadata
         FROM edges
         WHERE kind='contains'
           AND source IN(SELECT value FROM json_each(?))
           AND target IN(SELECT value FROM json_each(?))`,
      );
      params.push(ids, ids);
    }
    if (edgeKinds.includes("DEFINES")) {
      selects.push(
        `SELECT file_path AS source,id AS target,'DEFINES' AS kind,
                'defines' AS rel,1 AS count,0 AS first_line,'' AS ref_name,
                'static' AS provenance,NULL AS metadata
         FROM nodes
         WHERE file_path IN(SELECT value FROM json_each(?))
           AND id IN(SELECT value FROM json_each(?))`,
      );
      params.push(ids, ids);
    }
    if (edgeKinds.includes("IMPORTS")) {
      selects.push(
        `SELECT ${GRAPH_EDGE_AGGREGATE_COLUMNS}
         FROM edges
         WHERE kind='imports'
           AND source IN(SELECT value FROM json_each(?))
           AND target IN(SELECT value FROM json_each(?))
         GROUP BY source,target,kind,COALESCE(json_extract(metadata,'$.rel'),kind)`,
      );
      params.push(ids, ids);
    }
    if (edgeKinds.includes("INSTANTIATES")) {
      selects.push(
        `SELECT ${GRAPH_EDGE_AGGREGATE_COLUMNS}
         FROM edges
         WHERE kind='instantiates'
           AND source IN(SELECT value FROM json_each(?))
           AND target IN(SELECT value FROM json_each(?))
         GROUP BY source,target,kind,COALESCE(json_extract(metadata,'$.rel'),kind)`,
      );
      params.push(ids, ids);
    }
    if (selects.length === 0) return { edges: [], truncated: false };

    const rows = this.all<EdgeRow>(
      `WITH induced AS (${selects.join(" UNION ALL ")}),
            ranked AS (
              SELECT *,ROW_NUMBER() OVER (
                PARTITION BY kind ORDER BY source,target,rel
              ) AS edge_rank
              FROM induced
            )
       SELECT source,target,kind,rel,count,first_line,ref_name,
              provenance,metadata
       FROM ranked
       ORDER BY edge_rank,kind,source,target,rel LIMIT ?`,
      ...params,
      budget + 1,
    );
    return {
      edges: rows.slice(0, budget).map(toGraphEdge),
      truncated: rows.length > budget,
    };
  }

  stats(): GraphStats {
    const count = (table: string, where = "") =>
      Number(
        this.one<{ count: number }>(
          `SELECT count(*) count FROM ${table} ${where}`,
        )?.count ?? 0,
      );
    const unresolvedCounts = new Map(
      this.all<{ status: string; count: number }>(
        "SELECT status,COUNT(*) AS count FROM unresolved_refs GROUP BY status",
      ).map((row) => [row.status, Number(row.count)]),
    );
    const pendingRefCount = unresolvedCounts.get("pending") ?? 0;
    const failedRefCount = unresolvedCounts.get("failed") ?? 0;
    return {
      symCount: count("nodes"),
      fileCount: count("files"),
      refCount: pendingRefCount + failedRefCount,
      pendingRefCount,
      failedRefCount,
      dynamicBoundaryCount: unresolvedCounts.get("dynamic") ?? 0,
      externalRefCount: unresolvedCounts.get("external") ?? 0,
      callsCount: this.edgeOccurrenceCount("CALLS"),
      refsCount: this.edgeOccurrenceCount("REFS"),
      inheritsCount: this.edgeOccurrenceCount("INHERITS"),
    };
  }

  private bfs(
    start: string,
    kinds: readonly GraphEdgeKind[],
    direction: "outgoing" | "incoming" | "both",
    maxDepth: number,
    limit: number,
  ): SymRef[] {
    if (limit <= 0) return [];
    const seen = new Set([start]),
      ordered: string[] = [];
    let frontier = [start];
    for (
      let depth = 0;
      depth < clampDepth(maxDepth) && frontier.length;
      depth++
    ) {
      const next: string[] = [];
      const active = new Set(frontier);
      const remaining = Math.max(0, limit - ordered.length);
      let edgeBudget = Math.min(
        MAX_TRAVERSAL_EDGE_READ,
        Math.max(1, remaining),
      );
      let previousAdjacentCount = -1;
      while (next.length < remaining) {
        const adjacent = this.adjacentEdges(
          frontier,
          kinds,
          direction,
          edgeBudget,
        );
        for (const edge of adjacent)
          for (const id of adjacentTargets(edge, active, direction)) {
            if (seen.has(id)) continue;
            seen.add(id);
            ordered.push(id);
            next.push(id);
            if (ordered.length >= Math.max(0, limit))
              return this.refsForIds(ordered);
          }
        const exhausted =
          direction === "both"
            ? adjacent.length === previousAdjacentCount
            : adjacent.length < edgeBudget;
        if (exhausted || edgeBudget >= MAX_TRAVERSAL_EDGE_READ) break;
        previousAdjacentCount = adjacent.length;
        edgeBudget = Math.min(MAX_TRAVERSAL_EDGE_READ, edgeBudget * 2);
      }
      frontier = next;
    }
    return this.refsForIds(ordered);
  }

  private expandImpactScope(
    roots: readonly string[],
    expanded: Set<string>,
  ): { ids: string[]; members: string[] } {
    const scope = [...new Set(roots)];
    if (roots.length > 0) {
      for (const counterpart of this.all<{ id: string }>(
        `WITH seeds AS (
           SELECT id,name,qualified_name,signature
           FROM nodes
           WHERE id IN(SELECT value FROM json_each(?))
             AND signature IS NOT NULL
         ), matches AS (
           SELECT seed.id AS seed_id,peer.id,
                  ROW_NUMBER() OVER(PARTITION BY seed.id ORDER BY peer.id) AS peer_rank
           FROM seeds seed
           JOIN nodes peer
             ON peer.id<>seed.id
            AND peer.signature=seed.signature
            AND (
              (seed.qualified_name IS NOT NULL
               AND peer.qualified_name=seed.qualified_name)
              OR
              (seed.qualified_name IS NULL
               AND peer.qualified_name IS NULL
               AND peer.name=seed.name)
            )
         )
         SELECT DISTINCT id FROM matches
         WHERE peer_rank<=64
         ORDER BY id
         LIMIT ?`,
        JSON.stringify(roots),
        MAX_TRAVERSAL_EDGE_READ,
      )) {
        scope.push(counterpart.id);
      }
    }
    const uniqueScope = [...new Set(scope)];
    scope.length = 0;
    scope.push(...uniqueScope);
    const queued = new Set(scope);
    const members: string[] = [];
    let pending = scope.filter((id) => !expanded.has(id));
    while (pending.length > 0 && scope.length < MAX_TRAVERSAL_EDGE_READ) {
      for (const id of pending) expanded.add(id);
      const containers = this.refsForIds(pending)
        .filter((item) => IMPACT_CONTAINER_KINDS.has(item.kind ?? ""))
        .map((item) => item.id);
      if (containers.length === 0) break;
      const remaining = MAX_TRAVERSAL_EDGE_READ - scope.length;
      const discovered: string[] = [];
      for (const edge of this.outgoingEdges(
        containers,
        ["CONTAINS"],
        remaining,
      )) {
        if (queued.has(edge.dst)) continue;
        queued.add(edge.dst);
        scope.push(edge.dst);
        members.push(edge.dst);
        discovered.push(edge.dst);
      }
      pending = discovered.filter((id) => !expanded.has(id));
    }
    return { ids: scope, members };
  }

  private adjacentEdges(
    idsInput: readonly string[],
    kinds: readonly GraphEdgeKind[],
    direction: "outgoing" | "incoming" | "both",
    limit: number,
  ): GraphEdge[] {
    if (direction === "outgoing") {
      return this.outgoingEdges(idsInput, kinds, limit);
    }
    if (direction === "incoming") {
      return this.incomingEdges(idsInput, kinds, limit);
    }
    const outgoing = this.outgoingEdges(idsInput, kinds, Math.ceil(limit / 2));
    const incoming = this.incomingEdges(
      idsInput,
      kinds,
      Math.max(0, limit - outgoing.length),
    );
    return dedupeEdges([...outgoing, ...incoming]).slice(0, limit);
  }

  private queryDirectionalEdges(
    idsInput: readonly string[],
    kinds: readonly GraphEdgeKind[],
    direction: "outgoing" | "incoming",
    limit: number,
  ): GraphEdge[] {
    if (!idsInput.length || limit <= 0) return [];
    const ids = JSON.stringify([...new Set(idsInput)]);
    const requested = [...new Set(kinds)];
    if (requested.length === 0) return [];
    const quota = Math.max(1, Math.ceil(limit / requested.length));
    const buckets = new Map<GraphEdgeKind, GraphEdge[]>();
    const exhausted = new Set<GraphEdgeKind>();
    for (const kind of requested) {
      const rows = this.queryDirectionalEdgeKind(
        ids,
        kind,
        direction,
        quota,
        0,
      );
      buckets.set(kind, rows);
      if (rows.length < quota) exhausted.add(kind);
    }
    let out = roundRobinEdges(requested, buckets, limit);
    while (out.length < limit) {
      let progressed = false;
      for (const kind of requested) {
        if (exhausted.has(kind)) continue;
        const bucket = buckets.get(kind)!;
        const rows = this.queryDirectionalEdgeKind(
          ids,
          kind,
          direction,
          quota,
          bucket.length,
        );
        bucket.push(...rows);
        progressed ||= rows.length > 0;
        if (rows.length < quota) exhausted.add(kind);
      }
      out = roundRobinEdges(requested, buckets, limit);
      if (!progressed) break;
    }
    return out;
  }

  private queryDirectionalEdgeKind(
    ids: string,
    kind: GraphEdgeKind,
    direction: "outgoing" | "incoming",
    limit: number,
    offset: number,
  ): GraphEdge[] {
    if (REL_KINDS.has(kind) || kind === "INSTANTIATES" || kind === "IMPORTS") {
      const side = direction === "outgoing" ? "source" : "target";
      const dbk = dbKind(kind);
      return this.all<EdgeRow>(
        `WITH aggregated AS (
           SELECT ${EDGE_AGGREGATE_COLUMNS}
           FROM edges WHERE kind=? AND ${side} IN(SELECT value FROM json_each(?))
           GROUP BY source,target,kind,COALESCE(json_extract(metadata,'$.rel'),kind)
         ), ranked AS (
           SELECT *,ROW_NUMBER() OVER (
             PARTITION BY ${side} ORDER BY source,target,rel
           ) AS fair_rank
           FROM aggregated
         )
         SELECT source,target,kind,rel,count,first_line,ref_name,
                provenance,metadata
         FROM ranked
         ORDER BY fair_rank,${side},source,target,rel LIMIT ? OFFSET ?`,
        dbk,
        ids,
        limit,
        offset,
      ).map(toGraphEdge);
    }
    if (kind === "CONTAINS") {
      const side = direction === "outgoing" ? "source" : "target";
      return this.all<{ source: string; target: string }>(
        `SELECT source,target FROM edges
         WHERE kind='contains' AND ${side} IN(SELECT value FROM json_each(?))
         ORDER BY ${side},source,target LIMIT ? OFFSET ?`,
        ids,
        limit,
        offset,
      ).map((row) =>
        structuralEdge(row.source, row.target, "CONTAINS", "contains"),
      );
    }
    const side = direction === "outgoing" ? "file_path" : "id";
    return this.all<{ file_path: string; id: string }>(
      `SELECT file_path,id FROM nodes
       WHERE ${side} IN(SELECT value FROM json_each(?))
       ORDER BY ${side},file_path,id LIMIT ? OFFSET ?`,
      ids,
      limit,
      offset,
    ).map((row) => structuralEdge(row.file_path, row.id, "DEFINES", "defines"));
  }

  private edgeOccurrenceCount(kind: "CALLS" | "REFS" | "INHERITS"): number {
    return Number(
      this.one<{ count: number }>(
        `SELECT COALESCE(SUM(COALESCE(json_extract(metadata,'$.count'),1)),0) AS count
         FROM edges WHERE kind=?`,
        dbKind(kind),
      )?.count ?? 0,
    );
  }

  private refsForIds(ids: readonly string[]): SymRef[] {
    if (!ids.length) return [];
    const kinds = new Map(
      this.all<{ id: string; kind: string }>(
        "SELECT id,kind FROM nodes WHERE id IN(SELECT value FROM json_each(?))",
        JSON.stringify(ids),
      ).map((r) => [r.id, r.kind]),
    );
    return ids.map((id) => ({ id, kind: kinds.get(id) }));
  }

  private reconstructPath(
    parent: Map<string, string | null>,
    end: string,
  ): SymRef[] {
    const ids: string[] = [];
    let cur: string | null = end;
    while (cur) {
      ids.push(cur);
      cur = parent.get(cur) ?? null;
    }
    return this.refsForIds(ids.reverse());
  }

  private symbolKind(id: string): string | undefined {
    return this.one<{ kind: string }>("SELECT kind FROM nodes WHERE id=?", id)
      ?.kind;
  }

  protected transaction(work: () => void): void {
    this.database.transaction(work);
  }

  protected all<T>(sql: string, ...params: Array<string | number>): T[] {
    return this.database.all<T>(sql, ...params);
  }

  protected one<T>(
    sql: string,
    ...params: Array<string | number>
  ): T | undefined {
    return this.database.one<T>(sql, ...params);
  }

  protected assertOpen(): void {
    this.database.assertOpen();
  }

  protected assertWritable(): void {
    this.database.assertWritable();
  }
}

function canonicalLogicalSymbolName(value: string): string {
  const parts = value.split("::");
  if (parts.length >= 3 && parts.at(-2) === parts.at(-3))
    parts.splice(parts.length - 2, 1);
  return parts.join("::");
}

function toGraphEdge(r: EdgeRow): GraphEdge {
  const metadata = r.metadata ? (JSON.parse(r.metadata) as Record<string, unknown>) : {};
  return {
    src: r.source,
    dst: r.target,
    kind: upperKind(r.kind) ?? (r.kind as GraphEdgeKind),
    rel: r.rel,
    count: r.count,
    first_line: r.first_line,
    ref_name: r.ref_name,
    provenance: r.provenance ?? "static",
    confidence:
      (metadata.confidence as number | undefined) ??
      (r.provenance === "heuristic" ? 0.5 : 1),
    evidence: metadata.evidence as string | undefined,
  };
}

function parseResolutionHints(
  value: string | null,
): ReferenceResolutionHints | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as ReferenceResolutionHints;
  } catch {
    return undefined;
  }
}

function resolutionHintsField(value: string | null): {
  hints?: ReferenceResolutionHints;
} {
  const hints = parseResolutionHints(value);
  return hints ? { hints } : {};
}

function structuralEdge(
  src: string,
  dst: string,
  kind: GraphEdgeKind,
  rel: string,
): GraphEdge {
  return {
    src,
    dst,
    kind,
    rel,
    count: 1,
    first_line: 0,
    ref_name: rel,
    provenance: "static",
    confidence: 1,
  };
}

function dedupeEdges(edges: readonly GraphEdge[]): GraphEdge[] {
  const seen = new Set<string>();
  return edges.filter((e) => {
    const k = `${e.src}\0${e.dst}\0${e.kind}\0${e.rel}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function roundRobinEdges(
  kinds: readonly GraphEdgeKind[],
  buckets: ReadonlyMap<GraphEdgeKind, readonly GraphEdge[]>,
  limit: number,
): GraphEdge[] {
  const out: GraphEdge[] = [];
  for (let index = 0; out.length < limit; index++) {
    let added = false;
    for (const kind of kinds) {
      const edge = buckets.get(kind)?.[index];
      if (!edge) continue;
      out.push(edge);
      added = true;
      if (out.length >= limit) break;
    }
    if (!added) break;
  }
  return out;
}

function adjacentTargets(
  edge: GraphEdge,
  active: ReadonlySet<string>,
  direction: "outgoing" | "incoming" | "both",
): string[] {
  const out: string[] = [];
  if (direction !== "incoming" && active.has(edge.src)) out.push(edge.dst);
  if (direction !== "outgoing" && active.has(edge.dst)) out.push(edge.src);
  return out;
}

function clampDepth(n: number): number {
  return Math.max(0, Math.min(32, Math.floor(n)));
}
