import type { DatabaseSync as NodeDatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
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
import {
  EDGE_AGGREGATE_COLUMNS,
  type EdgeRow,
  SqliteEdgeRepository,
} from "./edge-repository.js";
import { symbolLookupLeaf } from "../../symbol-lookup.js";
import type {
  ContainerNeighbor,
  FileNeighbor,
  GraphEdge,
  GraphEdgeKind,
  DynamicBoundary,
  GraphStats,
  InducedEdgesResult,
  SymContext,
  SymRef,
  TraverseOpts,
  UsageRef,
} from "../../types.js";

const MAX_TRAVERSAL_EDGE_READ = 10_000;
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
  symbol.id,symbol.file_id,symbol.name,symbol.qualified_name,symbol.signature,
  symbol.kind,symbol.is_exported,symbol.arity,symbol.range_json,symbol.scope,
  symbol.node_type,symbol.modifiers_json,
  file.absolute_path,file.relative_path,file.root_path,file.size_bytes,
  file.last_modified_time,file.kind AS file_kind,file.format
 FROM symbols symbol
 JOIN files file ON file.id=symbol.file_id
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

/** Indexed SQLite graph reader without a full-memory mirror. */
export class SqliteGraphReader {
  private readonly candidates: SemanticCandidateRepository;
  private readonly edgeRepository: SqliteEdgeRepository;
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
    this.edgeRepository = new SqliteEdgeRepository(this.database);
  }
  close(): void {
    this.database.close();
  }

  getEntity(entityId: string): StoredEntity | null {
    const row = this.database.one<EntityProjectionRow>(
      `${ENTITY_PROJECTION_SELECT} WHERE symbol.id=?`,
      entityId,
    );
    return row ? this.projectEntity(row) : null;
  }

  findSymbolsByName(name: string, limit: number): StoredEntity[] {
    const input = name.trim();
    const trimmed = symbolLookupLeaf(input);
    if (!trimmed || limit <= 0) return [];
    const qualified =
      /^[A-Za-z_$#][A-Za-z0-9_$#]*(?:(?:::|\.|->)#?[A-Za-z_$][A-Za-z0-9_$]*)+$/.test(
        input,
      )
        ? input.replace(/(?:\.|->)/g, "::")
        : undefined;
    return this.database
      .all<EntityProjectionRow>(
        `${ENTITY_PROJECTION_SELECT}
         WHERE symbol.name=? COLLATE NOCASE${
           qualified
             ? " AND (symbol.qualified_name=? COLLATE NOCASE OR symbol.qualified_name LIKE ? COLLATE NOCASE)"
             : ""
         }
         ORDER BY symbol.is_exported DESC,symbol.id
         LIMIT ?`,
        trimmed,
        ...(qualified ? [qualified, `%::${qualified}`] : []),
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
       SELECT requested.stem,file.id AS file_id
       FROM requested
       JOIN files file ON
         lower(file.relative_path) LIKE lower(requested.stem) || '.%' OR
         lower(file.relative_path) LIKE '%/' || lower(requested.stem) || '.%'
       ORDER BY requested.stem,file.id`,
      JSON.stringify(requested),
    );
    const fileIds = [...new Set(matches.map((match) => match.file_id))];
    if (fileIds.length === 0) return result;
    const entitiesByFile = new Map<string, StoredEntity[]>();
    for (const row of this.database.all<EntityProjectionRow>(
      `${ENTITY_PROJECTION_SELECT}
       WHERE symbol.file_id IN (SELECT value FROM json_each(?))
       ORDER BY symbol.is_exported DESC,symbol.id`,
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
      .slice(0, 16);
    if (limit <= 0 || terms.length === 0) return [];
    const clauses = terms.map(
      () =>
        `(symbol.name LIKE ? ESCAPE '\\' COLLATE NOCASE OR
          symbol.qualified_name LIKE ? ESCAPE '\\' COLLATE NOCASE OR
          symbol.signature LIKE ? ESCAPE '\\' COLLATE NOCASE OR
          file.relative_path LIKE ? ESCAPE '\\' COLLATE NOCASE)`,
    );
    const whereParams = terms.flatMap((term) => {
      const pattern = `%${escapeLike(term)}%`;
      return [pattern, pattern, pattern, pattern];
    });
    const coverageClauses = terms.map(
      () => `(CASE WHEN
        symbol.name LIKE ? ESCAPE '\\' COLLATE NOCASE OR
        symbol.qualified_name LIKE ? ESCAPE '\\' COLLATE NOCASE OR
        symbol.signature LIKE ? ESCAPE '\\' COLLATE NOCASE OR
        file.relative_path LIKE ? ESCAPE '\\' COLLATE NOCASE
       THEN 1 ELSE 0 END)`,
    );
    const scoreClauses = terms.map(
      () => `(CASE
        WHEN symbol.name=? COLLATE NOCASE THEN 240
        WHEN symbol.name LIKE ? ESCAPE '\\' COLLATE NOCASE THEN 120
        WHEN symbol.name LIKE ? ESCAPE '\\' COLLATE NOCASE THEN 80
        ELSE 0 END
       + CASE WHEN symbol.qualified_name LIKE ? ESCAPE '\\' COLLATE NOCASE THEN 35 ELSE 0 END
       + CASE WHEN symbol.signature LIKE ? ESCAPE '\\' COLLATE NOCASE THEN 18 ELSE 0 END
       + CASE WHEN file.relative_path LIKE ? ESCAPE '\\' COLLATE NOCASE THEN 24 ELSE 0 END)`,
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
         ORDER BY (${coverageClauses.join(" + ")}) DESC,
                  (${scoreClauses.join(" + ")}) DESC,
                  symbol.is_exported DESC,
                  symbol.id
         LIMIT ?`,
        ...whereParams,
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
       FROM symbols
       WHERE name = ?
       ORDER BY is_exported DESC, id
       LIMIT ?`,
      trimmed,
      limit,
    );
    if (exact.length > 0) return exact.map((row) => row.id);
    return this.all<{ id: string }>(
      `SELECT id
       FROM symbols
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
      id: string;
      owner_id: string;
      ref_name: string;
      member_name: string;
      receiver_kind: "owner" | "super" | "qualified" | null;
      receiver_name: string | null;
      resolution_hints: string | null;
      line: number;
      reason:
        | "polymorphic_dispatch"
        | "unknown_receiver_type"
        | "lexical_dispatch"
        | "runtime_dispatch";
      occurrence_count: number;
    }>(
      `WITH ranked AS (
         SELECT id,owner_id,ref_name,member_name,receiver_kind,receiver_name,
                resolution_hints,dynamic_reason AS reason,line,
                EXISTS(
                  SELECT 1 FROM edge_candidates candidate
                  WHERE candidate.edge_id=unresolved.id
                ) AS has_candidates,
                COUNT(*) OVER (
                  PARTITION BY owner_id,ref_name,member_name,receiver_kind,
                               receiver_name,resolution_hints,dynamic_reason
                ) AS occurrence_count,
                ROW_NUMBER() OVER (
                  PARTITION BY owner_id,ref_name,member_name,receiver_kind,
                               receiver_name,resolution_hints,dynamic_reason
                  ORDER BY EXISTS(
                    SELECT 1 FROM edge_candidates candidate
                    WHERE candidate.edge_id=unresolved.id
                  ) DESC,line,id
                ) AS occurrence_rank
         FROM unresolved_refs unresolved
         WHERE status='dynamic' AND ref_kind IN ('call','new')
           AND owner_id IN (${placeholders})
       ), fair AS (
         SELECT *,ROW_NUMBER() OVER (
           PARTITION BY owner_id
           ORDER BY has_candidates DESC,line,id
         ) AS owner_rank
         FROM ranked WHERE occurrence_rank=1
       )
       SELECT id,owner_id,ref_name,member_name,receiver_kind,receiver_name,
              resolution_hints,reason,line,occurrence_count
       FROM fair
       ORDER BY owner_rank,has_candidates DESC,owner_id,line,id LIMIT ?`,
      ...ids,
      limit,
    );
    type CandidateRow = {
      edge_id: string;
      target_id: string;
      target_name: string;
      file_path: string;
      reason:
        | "hierarchy"
        | "generic_bound"
        | "method_set"
        | "function_pointer"
        | "namespace_export";
      confidence: number;
    };
    const candidatesByEdge = new Map<string, CandidateRow[]>();
    if (persistedRows.length > 0) {
      const candidateRows = this.all<CandidateRow>(
        `WITH enriched AS (
           SELECT candidate.edge_id,candidate.target_id,candidate.reason,
                  candidate.confidence,
                  CASE WHEN container.id IS NOT NULL
                       THEN COALESCE(container.qualified_name,container.name)
                            || '::' || target.name
                       ELSE COALESCE(target.qualified_name,target.name)
                  END AS target_name,
                  target.file_id AS file_path
           FROM edge_candidates candidate
           JOIN symbols target ON target.id=candidate.target_id
           LEFT JOIN contains ownership ON ownership.child_id=target.id
           LEFT JOIN symbols container ON container.id=ownership.parent_id
           WHERE candidate.edge_id IN (
             SELECT value FROM json_each(?)
           )
         ), ranked AS (
           SELECT *,ROW_NUMBER() OVER (
             PARTITION BY edge_id
             ORDER BY confidence DESC,target_name,file_path,target_id
           ) AS candidate_rank
           FROM enriched
         )
         SELECT edge_id,target_id,target_name,file_path,reason,confidence
         FROM ranked WHERE candidate_rank<=129
         ORDER BY edge_id,candidate_rank`,
        JSON.stringify(persistedRows.map((row) => row.id)),
      );
      for (const candidate of candidateRows) {
        const group = candidatesByEdge.get(candidate.edge_id) ?? [];
        group.push(candidate);
        candidatesByEdge.set(candidate.edge_id, group);
      }
    }
    const persisted = persistedRows.map((row): DynamicBoundary => {
      const candidateRows = candidatesByEdge.get(row.id) ?? [];
      const uniqueCandidates = new Map<
        string,
        (typeof candidateRows)[number]
      >();
      for (const candidate of candidateRows) {
        // A header declaration and its source definition have different IDs,
        // but are one logical dispatch choice for an Explore consumer.
        const key = canonicalLogicalSymbolName(candidate.target_name);
        if (!uniqueCandidates.has(key))
          uniqueCandidates.set(key, { ...candidate, target_name: key });
      }
      const details = [...uniqueCandidates.values()]
        .slice(0, 64)
        .map((candidate) => ({
          targetId: candidate.target_id,
          displayName: candidate.target_name,
          filePath: candidate.file_path,
          reason: candidate.reason,
          confidence: candidate.confidence,
        }));
      return {
        sourceId: row.owner_id,
        line: row.line,
        target: {
          raw: row.ref_name,
          member: row.member_name,
          receiver:
            row.receiver_kind && row.receiver_name
              ? { kind: row.receiver_kind, name: row.receiver_name }
              : undefined,
          ...resolutionHintsField(row.resolution_hints),
        },
        reason: row.reason,
        candidates: details.map((candidate) => candidate.targetId),
        candidatesTruncated: uniqueCandidates.size > 64,
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
         SELECT id,owner_id,owner_is_file,ref_name,ref_kind,line,status,
                imported_name,local_name,source_language,receiver_kind,
                receiver_name,member_name,resolution_hints,last_attempt,
                COUNT(*) OVER (
                  PARTITION BY owner_id,ref_name,member_name,receiver_kind,
                               receiver_name,resolution_hints
                ) AS occurrence_count,
                ROW_NUMBER() OVER (
                  PARTITION BY owner_id,ref_name,member_name,receiver_kind,
                               receiver_name,resolution_hints
                  ORDER BY line,id
                ) AS occurrence_rank
         FROM unresolved_refs
         WHERE owner_is_file=0 AND status='failed' AND ref_kind='call'
           AND receiver_kind IS NOT NULL
           AND owner_id IN (${placeholders})
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
        // Visibility is source-dependent, so only identical occurrences owned
        // by the same symbol may share a candidate lookup.
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
        line: row.line,
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
      `WITH target_names(name) AS (
         SELECT name FROM symbols WHERE id IN (${placeholders})
         UNION
         SELECT qualified_name FROM symbols
         WHERE id IN (${placeholders}) AND qualified_name IS NOT NULL
       ), sources(id) AS (
         SELECT unresolved.owner_id
         FROM edge_candidates candidate
         JOIN unresolved_refs unresolved ON unresolved.id=candidate.edge_id
         WHERE unresolved.status='dynamic'
           AND unresolved.ref_kind IN ('call','new')
           AND unresolved.owner_is_file=0
           AND candidate.target_id IN (${placeholders})
         UNION
         SELECT unresolved.owner_id
         FROM unresolved_refs unresolved
         WHERE unresolved.status='dynamic'
           AND unresolved.ref_kind IN ('call','new')
           AND unresolved.owner_is_file=0
           AND json_extract(unresolved.resolution_hints,'$.receiverType')
               IN (SELECT name FROM target_names)
       )
       SELECT id FROM sources ORDER BY id LIMIT ?`,
      ...ids,
      ...ids,
      ...ids,
      limit,
    );
  }

  expandContainers(
    symIds: readonly string[],
    limit: number,
  ): ContainerNeighbor[] {
    const out: ContainerNeighbor[] = [];
    for (const sid of symIds) {
      const parent = this.one<{ parent_id: string }>(
        `SELECT parent_id FROM (
           SELECT parent_id,0 AS priority FROM contains WHERE child_id=?
           UNION ALL
           SELECT parent.id AS parent_id,1 AS priority
           FROM symbols child JOIN symbols parent
             ON child.qualified_name=parent.qualified_name || '::' || child.name
            AND parent.qualified_name=substr(
              child.qualified_name,1,
              length(child.qualified_name)-length(child.name)-2
            )
           WHERE child.id=? AND child.id<>parent.id
         ) ORDER BY priority,parent_id LIMIT 1`,
        sid,
        sid,
      )?.parent_id;
      if (!parent) continue;
      const sibs = this.all<{ child_id: string }>(
        `SELECT DISTINCT child_id FROM (
           SELECT child_id FROM contains WHERE parent_id=?
           UNION ALL
           SELECT child.id AS child_id FROM symbols parent JOIN symbols child
             ON child.qualified_name=parent.qualified_name || '::' || child.name
            AND child.qualified_name>=parent.qualified_name || '::'
            AND child.qualified_name<parent.qualified_name || ';'
           WHERE parent.id=? AND child.id<>parent.id
         ) WHERE child_id<>? ORDER BY child_id LIMIT ?`,
        parent,
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
      `SELECT DISTINCT symbol.id,symbol.kind
       FROM edges binding
       JOIN symbols symbol
         ON symbol.file_id=binding.dst_id
        AND symbol.name=binding.imported_name
       WHERE binding.kind='IMPORTS'
         AND binding.src_is_file=1
         AND binding.dst_is_file=1
         AND binding.imported_name IS NOT NULL
         AND binding.imported_name NOT IN ('*','default')
         AND binding.src_id IN (SELECT value FROM json_each(?))
       ORDER BY symbol.id
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
        dst_id: string;
        kind: string | null;
        count: number;
      }>(
        `SELECT edge.dst_id,MAX(symbol.kind) AS kind,SUM(edge.count) AS count
         FROM edges edge
         LEFT JOIN symbols symbol ON symbol.id=edge.dst_id
         WHERE edge.src_id=? AND edge.src_is_file=0
           AND edge.kind IN('CALLS','INSTANTIATES')
         GROUP BY edge.dst_id ORDER BY count DESC,edge.dst_id LIMIT ?`,
        id,
        limit,
      ).map((e) => ({
        id: e.dst_id,
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
      // Members participate in the lookup scope so callers/references to a
      // method are still dependents of its container. They are not themselves
      // impact results merely because the container owns them: ownership is
      // structural, not evidence that changing the type affects every method.
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
      // Candidate-backed dynamic dispatch is deliberately not materialized as
      // a definitive CALLS edge, but it still represents a potential impact
      // dependency. Keep impact honest by traversing those sources alongside
      // static incoming edges, under the same node budget.
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
       FROM edges WHERE dst_id=? AND dst_is_file=0
       GROUP BY src_id,dst_id,kind,rel ORDER BY first_line LIMIT ?`,
      id,
      limit,
    ).map((e) => ({
      id: e.src_id,
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
    const source = direction === "bases" ? "src_id" : "dst_id";
    const target = direction === "bases" ? "dst_id" : "src_id";
    return this.all<{ id: string; kind: string }>(
      `WITH RECURSIVE walk(id,depth) AS (
         SELECT ${target},1
         FROM edges
         WHERE kind='INHERITS' AND src_is_file=0 AND dst_is_file=0
           AND ${source}=?
         UNION
         SELECT edge.${target},walk.depth+1
         FROM walk
         JOIN edges edge ON edge.${source}=walk.id
         WHERE edge.kind='INHERITS'
           AND edge.src_is_file=0 AND edge.dst_is_file=0
           AND walk.depth<10
           AND edge.${target}<>?
       ), nearest AS (
         SELECT id,MIN(depth) AS depth FROM walk GROUP BY id
       ), ranked AS (
         SELECT symbol.id,symbol.kind,nearest.depth,symbol.file_id,
                ROW_NUMBER() OVER (
                  PARTITION BY symbol.file_id
                  ORDER BY nearest.depth,symbol.id
                ) AS file_rank
         FROM nearest JOIN symbols symbol ON symbol.id=nearest.id
       )
       SELECT id,kind FROM ranked
       ORDER BY file_rank,depth,file_id,id LIMIT ?`,
      id,
      id,
      limit,
    );
  }
  members(id: string): SymRef[] {
    return this.all<{ id: string; kind: string }>(
      `SELECT DISTINCT member.id,member.kind FROM symbols member
       WHERE member.id IN (
         SELECT child_id FROM contains WHERE parent_id=?
         UNION
         SELECT child.id FROM symbols parent JOIN symbols child
           ON child.qualified_name=parent.qualified_name || '::' || child.name
          AND child.qualified_name>=parent.qualified_name || '::'
          AND child.qualified_name<parent.qualified_name || ';'
         WHERE parent.id=? AND child.id<>parent.id
       ) ORDER BY member.id`,
      id,
      id,
    );
  }
  context(id: string): SymContext {
    const containers: SymRef[] = [];
    let current = id;
    for (let i = 0; i < 5; i++) {
      const p = this.one<{ parent_id: string }>(
        "SELECT parent_id FROM contains WHERE child_id=?",
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
    return this.edgeRepository.directional(
      nodeIds,
      edgeKinds,
      "outgoing",
      limit,
    );
  }

  incomingEdges(
    nodeIds: readonly string[],
    edgeKinds: readonly GraphEdgeKind[] = ALL_EDGE_KINDS,
    limit = 1_000,
  ): GraphEdge[] {
    return this.edgeRepository.directional(
      nodeIds,
      edgeKinds,
      "incoming",
      limit,
    );
  }

  edges(
    nodeIds: readonly string[],
    edgeKinds: readonly GraphEdgeKind[],
    limit: number,
  ): InducedEdgesResult {
    return this.edgeRepository.induced(nodeIds, edgeKinds, limit);
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
      symCount: count("symbols"),
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
    // A declaration and definition are separate indexed entities but one
    // language-level symbol. Include exact qualified/signature counterparts so
    // impact works whether the caller edge landed on a header prototype or on
    // the body-bearing definition.
    if (roots.length > 0) {
      for (const counterpart of this.all<{ id: string }>(
        `WITH seeds AS (
           SELECT id,name,qualified_name,signature
           FROM symbols
           WHERE id IN(SELECT value FROM json_each(?))
             AND signature IS NOT NULL
         ), matches AS (
           SELECT seed.id AS seed_id,peer.id,
                  ROW_NUMBER() OVER(PARTITION BY seed.id ORDER BY peer.id) AS peer_rank
           FROM seeds seed
           JOIN symbols peer
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

  private edgeOccurrenceCount(kind: "CALLS" | "REFS" | "INHERITS"): number {
    return Number(
      this.one<{ count: number }>(
        "SELECT COALESCE(SUM(count),0) AS count FROM edges WHERE kind=?",
        kind,
      )?.count ?? 0,
    );
  }

  private refsForIds(ids: readonly string[]): SymRef[] {
    if (!ids.length) return [];
    const kinds = new Map(
      this.all<{ id: string; kind: string }>(
        "SELECT id,kind FROM symbols WHERE id IN(SELECT value FROM json_each(?))",
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
    return this.one<{ kind: string }>("SELECT kind FROM symbols WHERE id=?", id)
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
function dedupeEdges(edges: readonly GraphEdge[]): GraphEdge[] {
  const seen = new Set<string>();
  return edges.filter((e) => {
    const k = `${e.src}\0${e.dst}\0${e.kind}\0${e.rel}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
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
