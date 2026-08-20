import type { DatabaseSync as NodeDatabaseSync } from "node:sqlite";
import { SqliteGraphDatabase } from "./database.js";
import type {
  ContainerNeighbor,
  FileNeighbor,
  GraphEdge,
  GraphEdgeKind,
  GraphStats,
  InducedEdgesResult,
  SeedNeighbor,
  SymContext,
  SymRef,
  TraverseOpts,
  UsageRef,
} from "../../types.js";

export type EdgeRow = {
  src_id: string;
  dst_id: string;
  kind: "CALLS" | "REFS" | "INHERITS";
  rel: string;
  count: number;
  first_line: number;
  ref_name: string;
};
export type RefRow = {
  id: string;
  owner_id: string;
  owner_is_file: number;
  ref_name: string;
  ref_kind: string;
  line: number;
  status: "pending" | "failed";
  imported_name: string | null;
  local_name: string | null;
  source_language: string | null;
  last_attempt: number;
};
export type SymbolRow = {
  id: string;
  file_id: string;
  name: string | null;
  kind: string;
  is_exported: number;
};
const REL_KINDS = new Set<GraphEdgeKind>(["CALLS", "REFS", "INHERITS"]);
const ALL_EDGE_KINDS: readonly GraphEdgeKind[] = [
  "CALLS",
  "REFS",
  "INHERITS",
  "CONTAINS",
  "DEFINES",
  "IMPORTS",
];

/** Indexed SQLite graph reader without a full-memory mirror. */
export class SqliteGraphReader {
  readonly available = true;
  protected readonly db: NodeDatabaseSync;
  protected readonly readOnly: boolean;
  protected readonly database: SqliteGraphDatabase;

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
  }
  close(): void {
    this.database.close();
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
        "SELECT parent_id FROM contains WHERE child_id=?",
        sid,
      )?.parent_id;
      if (!parent) continue;
      const sibs = this.all<{ child_id: string }>(
        "SELECT child_id FROM contains WHERE parent_id=? AND child_id<>? LIMIT ?",
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

  callers(id: string, depth: number, limit: number): SymRef[] {
    return this.bfs(id, ["CALLS"], "incoming", depth, limit);
  }
  callees(id: string, depth: number, limit: number): SymRef[] {
    if (depth <= 1)
      return this.all<EdgeRow>(
        "SELECT * FROM symbol_edges WHERE src_id=? AND kind='CALLS' ORDER BY count DESC LIMIT ?",
        id,
        limit,
      ).map((e) => ({
        id: e.dst_id,
        kind: this.symbolKind(e.dst_id),
        count: e.count,
      }));
    return this.bfs(id, ["CALLS"], "outgoing", depth, limit);
  }
  impact(id: string, depth: number, limit: number): SymRef[] {
    return this.bfs(id, ["CALLS", "REFS"], "incoming", depth, limit);
  }
  usages(id: string, limit: number): UsageRef[] {
    return this.all<EdgeRow>(
      "SELECT * FROM symbol_edges WHERE dst_id=? ORDER BY first_line LIMIT ?",
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
  members(id: string): SymRef[] {
    return this.all<{ id: string; kind: string }>(
      "SELECT s.id,s.kind FROM contains c JOIN symbols s ON s.id=c.child_id WHERE c.parent_id=?",
      id,
    );
  }
  deadCode(limit: number): SymRef[] {
    return this.all<{ id: string; kind: string }>(
      `SELECT s.id,s.kind FROM symbols s WHERE s.is_exported=0 AND s.kind IN ('function','method') AND NOT EXISTS(SELECT 1 FROM symbol_edges e WHERE e.dst_id=s.id AND e.kind='CALLS') LIMIT ?`,
      limit,
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
    const outgoing = this.all<EdgeRow>(
      "SELECT * FROM symbol_edges WHERE src_id=? LIMIT 100",
      id,
    ).map((e) => ({ id: e.dst_id, rel: e.rel }));
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
        `SELECT src_id AS src,dst_id AS dst,kind,rel,count,first_line,ref_name
         FROM symbol_edges
         WHERE src_id IN(SELECT value FROM json_each(?))
           AND dst_id IN(SELECT value FROM json_each(?)) AND kind IN(${p})`,
      );
      params.push(ids, ids, ...rel);
    }
    if (edgeKinds.includes("CONTAINS")) {
      selects.push(
        `SELECT parent_id AS src,child_id AS dst,'CONTAINS' AS kind,
                'contains' AS rel,1 AS count,0 AS first_line,'' AS ref_name
         FROM contains
         WHERE parent_id IN(SELECT value FROM json_each(?))
           AND child_id IN(SELECT value FROM json_each(?))`,
      );
      params.push(ids, ids);
    }
    if (edgeKinds.includes("DEFINES")) {
      selects.push(
        `SELECT file_id AS src,id AS dst,'DEFINES' AS kind,
                'defines' AS rel,1 AS count,0 AS first_line,'' AS ref_name
         FROM symbols
         WHERE file_id IN(SELECT value FROM json_each(?))
           AND id IN(SELECT value FROM json_each(?))`,
      );
      params.push(ids, ids);
    }
    if (edgeKinds.includes("IMPORTS")) {
      selects.push(
        `SELECT src_file_id AS src,dst_file_id AS dst,'IMPORTS' AS kind,
                spec AS rel,1 AS count,0 AS first_line,'' AS ref_name
         FROM file_imports
         WHERE src_file_id IN(SELECT value FROM json_each(?))
           AND dst_file_id IN(SELECT value FROM json_each(?))`,
      );
      params.push(ids, ids);
    }
    if (selects.length === 0) return { edges: [], truncated: false };

    const rows = this.all<{
      src: string;
      dst: string;
      kind: GraphEdgeKind;
      rel: string;
      count: number;
      first_line: number;
      ref_name: string;
    }>(
      `SELECT * FROM (${selects.join(" UNION ALL ")})
       ORDER BY kind,src,dst,rel LIMIT ?`,
      ...params,
      budget + 1,
    );
    return {
      edges: rows.slice(0, budget),
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
    return {
      symCount: count("symbols"),
      fileCount: count("files"),
      refCount: count("pending_refs"),
      callsCount: count("symbol_edges", "WHERE kind='CALLS'"),
      refsCount: count("symbol_edges", "WHERE kind='REFS'"),
      inheritsCount: count("symbol_edges", "WHERE kind='INHERITS'"),
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
      for (const edge of this.adjacentEdges(
        frontier,
        kinds,
        direction,
        remaining,
      ))
        for (const id of adjacentTargets(edge, active, direction)) {
          if (seen.has(id)) continue;
          seen.add(id);
          ordered.push(id);
          next.push(id);
          if (ordered.length >= Math.max(0, limit))
            return this.refsForIds(ordered);
        }
      frontier = next;
    }
    return this.refsForIds(ordered);
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
    const ids = JSON.stringify([...new Set(idsInput)]),
      out: GraphEdge[] = [];
    const rel = kinds.filter((k) => REL_KINDS.has(k));
    if (rel.length) {
      const p = rel.map(() => "?").join(",");
      const sides = [direction === "outgoing" ? "src_id" : "dst_id"];
      for (const side of sides) {
        const remaining = limit - out.length;
        if (remaining <= 0) break;
        out.push(
          ...this.all<EdgeRow>(
            `SELECT * FROM symbol_edges WHERE ${side} IN(SELECT value FROM json_each(?)) AND kind IN(${p}) ORDER BY ${side},kind,src_id,dst_id,rel LIMIT ?`,
            ids,
            ...rel,
            remaining,
          ).map(toGraphEdge),
        );
      }
    }
    if (kinds.includes("CONTAINS")) {
      const sides = [direction === "outgoing" ? "parent_id" : "child_id"];
      for (const side of sides) {
        const remaining = limit - out.length;
        if (remaining <= 0) break;
        out.push(
          ...this.all<{ parent_id: string; child_id: string }>(
            `SELECT * FROM contains WHERE ${side} IN(SELECT value FROM json_each(?)) ORDER BY ${side},parent_id,child_id LIMIT ?`,
            ids,
            remaining,
          ).map((r) =>
            structuralEdge(r.parent_id, r.child_id, "CONTAINS", "contains"),
          ),
        );
      }
    }
    if (kinds.includes("DEFINES")) {
      const sides = [direction === "outgoing" ? "file_id" : "id"];
      for (const side of sides) {
        const remaining = limit - out.length;
        if (remaining <= 0) break;
        out.push(
          ...this.all<{ file_id: string; id: string }>(
            `SELECT file_id,id FROM symbols WHERE ${side} IN(SELECT value FROM json_each(?)) ORDER BY ${side},file_id,id LIMIT ?`,
            ids,
            remaining,
          ).map((r) => structuralEdge(r.file_id, r.id, "DEFINES", "defines")),
        );
      }
    }
    if (kinds.includes("IMPORTS")) {
      const sides = [direction === "outgoing" ? "src_file_id" : "dst_file_id"];
      for (const side of sides) {
        const remaining = limit - out.length;
        if (remaining <= 0) break;
        out.push(
          ...this.all<{
            src_file_id: string;
            dst_file_id: string;
            spec: string;
          }>(
            `SELECT * FROM file_imports WHERE ${side} IN(SELECT value FROM json_each(?)) ORDER BY ${side},src_file_id,dst_file_id,spec LIMIT ?`,
            ids,
            remaining,
          ).map((r) =>
            structuralEdge(r.src_file_id, r.dst_file_id, "IMPORTS", r.spec),
          ),
        );
      }
    }
    return dedupeEdges(out).slice(0, limit);
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

function toGraphEdge(r: EdgeRow): GraphEdge {
  return {
    src: r.src_id,
    dst: r.dst_id,
    kind: r.kind,
    rel: r.rel,
    count: r.count,
    first_line: r.first_line,
    ref_name: r.ref_name,
  };
}
function structuralEdge(
  src: string,
  dst: string,
  kind: GraphEdgeKind,
  rel: string,
): GraphEdge {
  return { src, dst, kind, rel, count: 1, first_line: 0, ref_name: rel };
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
