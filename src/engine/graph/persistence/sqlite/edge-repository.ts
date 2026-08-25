import type {
  GraphEdge,
  GraphEdgeKind,
  InducedEdgesResult,
} from "../../types.js";
import type { SqliteGraphDatabase } from "./database.js";

export type EdgeRow = {
  src_id: string;
  dst_id: string;
  kind:
    "CALLS" | "REFS" | "INHERITS" | "IMPORTS" | "COUNTERPART" | "INSTANTIATES";
  rel: string;
  count: number;
  first_line: number;
  ref_name: string;
  provenance: "static" | "heuristic";
  confidence: number;
  evidence: string | null;
};

export const EDGE_AGGREGATE_COLUMNS = `src_id,dst_id,kind,rel,SUM(count) AS count,
  MIN(first_line) AS first_line,MIN(ref_name) AS ref_name,
  CASE WHEN MAX(provenance)='static' THEN 'static' ELSE 'heuristic' END AS provenance,
  MAX(confidence) AS confidence,
  CASE WHEN MAX(provenance)='static' THEN NULL
       ELSE substr(MAX(printf('%020.12f:%s',confidence,COALESCE(evidence,''))),22)
  END AS evidence`;

const PERSISTED_EDGE_KINDS = new Set<GraphEdgeKind>([
  "CALLS",
  "REFS",
  "INHERITS",
  "COUNTERPART",
  "INSTANTIATES",
  "IMPORTS",
]);
const RELATION_EDGE_KINDS = new Set<GraphEdgeKind>([
  "CALLS",
  "REFS",
  "INHERITS",
  "COUNTERPART",
]);
const GRAPH_EDGE_AGGREGATE_COLUMNS = EDGE_AGGREGATE_COLUMNS.replace(
  "src_id,dst_id",
  "src_id AS src,dst_id AS dst",
);

export class SqliteEdgeRepository {
  constructor(private readonly database: SqliteGraphDatabase) {}

  directional(
    idsInput: readonly string[],
    kinds: readonly GraphEdgeKind[],
    direction: "outgoing" | "incoming",
    limit: number,
  ): GraphEdge[] {
    if (idsInput.length === 0 || limit <= 0) return [];
    const ids = JSON.stringify([...new Set(idsInput)]);
    const requested = [...new Set(kinds)];
    if (requested.length === 0) return [];
    const quota = Math.max(1, Math.ceil(limit / requested.length));
    const buckets = new Map<GraphEdgeKind, GraphEdge[]>();
    const exhausted = new Set<GraphEdgeKind>();
    for (const kind of requested) {
      const rows = this.directionalKind(ids, kind, direction, quota, 0);
      buckets.set(kind, rows);
      if (rows.length < quota) exhausted.add(kind);
    }
    let result = roundRobinEdges(requested, buckets, limit);
    while (result.length < limit) {
      let progressed = false;
      for (const kind of requested) {
        if (exhausted.has(kind)) continue;
        const bucket = buckets.get(kind)!;
        const rows = this.directionalKind(
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
      result = roundRobinEdges(requested, buckets, limit);
      if (!progressed) break;
    }
    return result;
  }

  induced(
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
    const relations = edgeKinds.filter((kind) => RELATION_EDGE_KINDS.has(kind));
    if (relations.length > 0) {
      const placeholders = relations.map(() => "?").join(",");
      selects.push(
        `SELECT ${GRAPH_EDGE_AGGREGATE_COLUMNS}
         FROM edges
         WHERE src_id IN(SELECT value FROM json_each(?))
           AND dst_id IN(SELECT value FROM json_each(?))
           AND kind IN(${placeholders})
         GROUP BY src_id,dst_id,kind,rel`,
      );
      params.push(ids, ids, ...relations);
    }
    this.addStructuralInducedQueries(selects, params, ids, edgeKinds);
    if (selects.length === 0) return { edges: [], truncated: false };
    const rows = this.database.all<GraphEdge>(
      `WITH induced AS (${selects.join(" UNION ALL ")}),
            ranked AS (
              SELECT *,ROW_NUMBER() OVER (
                PARTITION BY kind ORDER BY src,dst,rel
              ) AS edge_rank
              FROM induced
            )
       SELECT src,dst,kind,rel,count,first_line,ref_name,
              provenance,confidence,evidence
       FROM ranked
       ORDER BY edge_rank,kind,src,dst,rel LIMIT ?`,
      ...params,
      budget + 1,
    );
    return { edges: rows.slice(0, budget), truncated: rows.length > budget };
  }

  private addStructuralInducedQueries(
    selects: string[],
    params: (string | number)[],
    ids: string,
    kinds: readonly GraphEdgeKind[],
  ): void {
    if (kinds.includes("CONTAINS")) {
      selects.push(
        `SELECT src,dst,'CONTAINS' AS kind,
                'contains' AS rel,1 AS count,0 AS first_line,'' AS ref_name,
                'static' AS provenance,1.0 AS confidence,NULL AS evidence
         FROM (
           SELECT parent_id AS src,child_id AS dst FROM contains
           WHERE parent_id IN(SELECT value FROM json_each(?))
             AND child_id IN(SELECT value FROM json_each(?))
           UNION
           SELECT parent.id AS src,child.id AS dst
           FROM symbols parent JOIN symbols child
             ON child.qualified_name=parent.qualified_name || '::' || child.name
            AND child.qualified_name>=parent.qualified_name || '::'
            AND child.qualified_name<parent.qualified_name || ';'
           WHERE child.id<>parent.id
             AND parent.id IN(SELECT value FROM json_each(?))
             AND child.id IN(SELECT value FROM json_each(?))
         )`,
      );
      params.push(ids, ids, ids, ids);
    }
    if (kinds.includes("DEFINES")) {
      selects.push(
        `SELECT file_id AS src,id AS dst,'DEFINES' AS kind,
                'defines' AS rel,1 AS count,0 AS first_line,'' AS ref_name,
                'static' AS provenance,1.0 AS confidence,NULL AS evidence
         FROM symbols
         WHERE file_id IN(SELECT value FROM json_each(?))
           AND id IN(SELECT value FROM json_each(?))`,
      );
      params.push(ids, ids);
    }
    for (const kind of ["IMPORTS", "INSTANTIATES"] as const) {
      if (!kinds.includes(kind)) continue;
      const fileFlags =
        kind === "IMPORTS"
          ? "src_is_file=1 AND dst_is_file=1"
          : "src_is_file=0 AND dst_is_file=0";
      selects.push(
        `SELECT ${GRAPH_EDGE_AGGREGATE_COLUMNS}
         FROM edges WHERE kind='${kind}' AND ${fileFlags}
           AND src_id IN(SELECT value FROM json_each(?))
           AND dst_id IN(SELECT value FROM json_each(?))
         GROUP BY src_id,dst_id,kind,rel`,
      );
      params.push(ids, ids);
    }
  }

  private directionalKind(
    ids: string,
    kind: GraphEdgeKind,
    direction: "outgoing" | "incoming",
    limit: number,
    offset: number,
  ): GraphEdge[] {
    if (PERSISTED_EDGE_KINDS.has(kind))
      return this.persistedEdges(ids, kind, direction, limit, offset);
    if (kind === "CONTAINS")
      return this.containsEdges(ids, direction, limit, offset);
    return this.definesEdges(ids, direction, limit, offset);
  }

  private persistedEdges(
    ids: string,
    kind: GraphEdgeKind,
    direction: "outgoing" | "incoming",
    limit: number,
    offset: number,
  ): GraphEdge[] {
    const side = direction === "outgoing" ? "src_id" : "dst_id";
    const fileFlags =
      kind === "IMPORTS"
        ? "src_is_file=1 AND dst_is_file=1"
        : "src_is_file=0 AND dst_is_file=0";
    return this.database
      .all<EdgeRow>(
        `WITH aggregated AS (
           SELECT ${EDGE_AGGREGATE_COLUMNS}
           FROM edges WHERE kind=? AND ${fileFlags}
             AND ${side} IN(SELECT value FROM json_each(?))
           GROUP BY src_id,dst_id,kind,rel
         ), ranked AS (
           SELECT *,ROW_NUMBER() OVER (
             PARTITION BY ${side} ORDER BY src_id,dst_id,rel
           ) AS fair_rank
           FROM aggregated
         )
         SELECT src_id,dst_id,kind,rel,count,first_line,ref_name,
                provenance,confidence,evidence
         FROM ranked
         ORDER BY fair_rank,${side},src_id,dst_id,rel LIMIT ? OFFSET ?`,
        kind,
        ids,
        limit,
        offset,
      )
      .map(toGraphEdge);
  }

  private containsEdges(
    ids: string,
    direction: "outgoing" | "incoming",
    limit: number,
    offset: number,
  ): GraphEdge[] {
    const side = direction === "outgoing" ? "parent_id" : "child_id";
    return this.database
      .all<{ parent_id: string; child_id: string }>(
        `SELECT parent_id,child_id FROM (
           SELECT parent_id,child_id FROM contains
           WHERE ${side} IN(SELECT value FROM json_each(?))
           UNION
           SELECT parent.id AS parent_id,child.id AS child_id
           FROM symbols parent JOIN symbols child
             ON child.qualified_name=parent.qualified_name || '::' || child.name
            ${
              direction === "outgoing"
                ? `AND child.qualified_name>=parent.qualified_name || '::'
                   AND child.qualified_name<parent.qualified_name || ';'`
                : `AND parent.qualified_name=substr(
                     child.qualified_name,1,
                     length(child.qualified_name)-length(child.name)-2
                   )`
            }
           WHERE child.id<>parent.id
             AND ${direction === "outgoing" ? "parent.id" : "child.id"}
                 IN(SELECT value FROM json_each(?))
         )
         ORDER BY ${side},parent_id,child_id LIMIT ? OFFSET ?`,
        ids,
        ids,
        limit,
        offset,
      )
      .map((row) =>
        structuralEdge(row.parent_id, row.child_id, "CONTAINS", "contains"),
      );
  }

  private definesEdges(
    ids: string,
    direction: "outgoing" | "incoming",
    limit: number,
    offset: number,
  ): GraphEdge[] {
    const side = direction === "outgoing" ? "file_id" : "id";
    return this.database
      .all<{ file_id: string; id: string }>(
        `SELECT file_id,id FROM symbols
         WHERE ${side} IN(SELECT value FROM json_each(?))
         ORDER BY ${side},file_id,id LIMIT ? OFFSET ?`,
        ids,
        limit,
        offset,
      )
      .map((row) => structuralEdge(row.file_id, row.id, "DEFINES", "defines"));
  }
}

function toGraphEdge(row: EdgeRow): GraphEdge {
  return {
    src: row.src_id,
    dst: row.dst_id,
    kind: row.kind,
    rel: row.rel,
    count: row.count,
    first_line: row.first_line,
    ref_name: row.ref_name,
    provenance: row.provenance ?? "static",
    confidence: row.confidence ?? 1,
    evidence: row.evidence ?? undefined,
  };
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

function roundRobinEdges(
  kinds: readonly GraphEdgeKind[],
  buckets: ReadonlyMap<GraphEdgeKind, readonly GraphEdge[]>,
  limit: number,
): GraphEdge[] {
  const result: GraphEdge[] = [];
  for (let index = 0; result.length < limit; index++) {
    let added = false;
    for (const kind of kinds) {
      const edge = buckets.get(kind)?.[index];
      if (!edge) continue;
      result.push(edge);
      added = true;
      if (result.length >= limit) break;
    }
    if (!added) break;
  }
  return result;
}
