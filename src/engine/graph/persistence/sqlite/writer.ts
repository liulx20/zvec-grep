import { makeRefId } from "../../ref-id.js";
import type { LocalEdge, RawRef, SymNode } from "../../types.js";
import type { SqliteGraphDatabase } from "./database.js";

type StoredEdgeFact = {
  id: string; src_id: string; kind: string; rel: string; first_line: number;
  ref_name: string; source_language: string | null; imported_name: string | null;
  local_name: string | null; receiver_kind: string | null;
  receiver_name: string | null; member_name: string | null;
  resolution_hints: string | null;
};

/** File-scoped graph mutations and resolved-edge invalidation. */
export class SqliteGraphWriter {
  constructor(private readonly database: SqliteGraphDatabase) {}

  private get db() { return this.database.db; }
  private get readOnly(): boolean { return this.database.readOnly; }
  private all<T>(sql: string, ...params: Array<string | number>): T[] {
    return this.database.all<T>(sql, ...params);
  }

  async checkpoint(): Promise<void> {
    this.database.assertOpen();
    if (!this.readOnly) this.db.exec("PRAGMA wal_checkpoint(PASSIVE)");
  }

  upsertFileGraph(
    fileId: string,
    nodes: readonly SymNode[],
    edges: readonly LocalEdge[],
    refs: readonly RawRef[],
  ): void {
    this.database.assertWritable();
    const oldIds = this.symbolIdsForFile(fileId);
    const affected = this.affectedResolvedEdgeIds(
      fileId,
      this.changedSemanticNames(nodes, refs),
    );
    this.database.transaction(() => {
      this.restoreEdgesToUnresolved(affected);
      this.deleteOwnedFacts(fileId, oldIds);
      this.db.prepare("INSERT OR IGNORE INTO files(id) VALUES(?)").run(fileId);
      this.db.prepare("DELETE FROM symbols WHERE file_id=?").run(fileId);
      const insert = this.db.prepare(
        "INSERT INTO symbols(id,file_id,name,kind,is_exported,signature,arity,return_type) VALUES(?,?,?,?,?,?,?,?)",
      );
      for (const node of nodes) {
        insert.run(node.id, fileId, node.name ?? null, node.kind,
          node.is_exported ? 1 : 0, node.signature ?? null, node.arity ?? null,
          node.returnType ?? null);
      }
      for (const edge of edges) this.insertLocalEdge(edge);
      for (const ref of refs) this.insertRef(ref, fileId);
    });
  }

  deleteFileGraph(fileId: string): void {
    this.database.assertWritable();
    const oldIds = this.symbolIdsForFile(fileId);
    const affected = this.affectedResolvedEdgeIds(
      fileId,
      this.symbolNamesForFile(fileId),
    );
    this.database.transaction(() => {
      this.restoreEdgesToUnresolved(affected);
      this.deleteOwnedFacts(fileId, oldIds);
      this.db.prepare("DELETE FROM files WHERE id=?").run(fileId);
    });
  }

  protected insertRef(ref: RawRef, fallbackOwner: string): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO unresolved_refs(
         id,owner_id,owner_is_file,ref_name,ref_kind,member_name,line,
         source_language,imported_name,local_name,receiver_kind,receiver_name,
         resolution_hints,status,last_attempt,dynamic_reason
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',0,NULL)`,
    ).run(
      ref.id, ref.owner || fallbackOwner, ref.type === "symbol" ? 0 : 1,
      ref.ref_name, ref.ref_kind,
      ref.type === "symbol" ? ref.target.member : null, ref.line,
      ref.type === "symbol" || ref.type === "import_binding"
        ? (ref.source_language ?? null) : null,
      ref.type === "import_binding" ? ref.imported_name : null,
      ref.type === "import_binding" ? ref.local_name : null,
      ref.type === "symbol" ? (ref.target.receiver?.kind ?? null) : null,
      ref.type === "symbol" ? (ref.target.receiver?.name ?? null) : null,
      ref.type === "symbol" && ref.target.hints
        ? JSON.stringify(ref.target.hints) : null,
    );
  }

  private insertLocalEdge(edge: LocalEdge): void {
    if (edge.kind === "CONTAINS") {
      this.db.prepare(
        "INSERT OR REPLACE INTO contains(parent_id,child_id) VALUES(?,?)",
      ).run(edge.src, edge.dst);
      return;
    }
    const sourceEdgeId = `local:${makeRefId(
      edge.src,
      edge.ref_name,
      edge.kind === "INSTANTIATES" ? "new" : edge.rel,
      edge.first_line,
    )}`;
    this.db.prepare(
      `INSERT OR REPLACE INTO edges(
         id,src_id,dst_id,src_is_file,dst_is_file,kind,rel,count,first_line,
         ref_name,provenance,confidence
       ) VALUES(?,?,?,0,0,?,?,?,?,?,'static',1)`,
    ).run(
      edge.kind === "INSTANTIATES"
        ? `${sourceEdgeId}:instantiates`
        : sourceEdgeId,
      edge.src, edge.dst, edge.kind, edge.rel, edge.count, edge.first_line,
      edge.ref_name,
    );
  }

  private affectedResolvedEdgeIds(
    fileId: string,
    changedNames: readonly string[],
  ): string[] {
    const names = JSON.stringify([...new Set(changedNames)]);
    return this.all<{ id: string }>(
      `SELECT DISTINCT edge.id FROM edges edge
       LEFT JOIN symbols source ON source.id=edge.src_id AND edge.src_is_file=0
       LEFT JOIN symbols target ON target.id=edge.dst_id AND edge.dst_is_file=0
       WHERE edge.kind<>'INSTANTIATES' AND (
         (target.file_id=? AND (source.file_id IS NULL OR source.file_id<>?))
         OR (edge.dst_is_file=1 AND edge.dst_id=? AND edge.src_id<>?)
         OR ((source.file_id IS NULL OR source.file_id<>?) AND ?<>'[]' AND (
           edge.member_name IN (SELECT value FROM json_each(?))
           OR edge.ref_name IN (SELECT value FROM json_each(?))
           OR json_extract(edge.resolution_hints,'$.receiverType')
                IN (SELECT value FROM json_each(?))
           OR EXISTS(
             SELECT 1 FROM json_each(COALESCE(
               json_extract(edge.resolution_hints,'$.candidateTypes'),'[]'
             )) candidate_type
             WHERE candidate_type.value IN (SELECT value FROM json_each(?))
           )
           )
         )
       )
       UNION
       SELECT DISTINCT unresolved.id FROM unresolved_refs unresolved
       JOIN edge_candidates candidate ON candidate.edge_id=unresolved.id
       JOIN symbols target ON target.id=candidate.target_id
       LEFT JOIN contains ownership ON ownership.child_id=candidate.target_id
       LEFT JOIN symbols container ON container.id=ownership.parent_id
       WHERE target.file_id=? OR (?<>'[]' AND
         container.name IN (SELECT value FROM json_each(?)))`,
      fileId, fileId, fileId, fileId, fileId, names, names, names, names, names,
      fileId, names, names,
    ).map((row) => row.id);
  }

  private restoreEdgesToUnresolved(edgeIds: readonly string[]): void {
    if (edgeIds.length === 0) return;
    const ids = JSON.stringify([...new Set(edgeIds)]);
    const facts = this.all<StoredEdgeFact>(
      `SELECT id,src_id,kind,rel,first_line,ref_name,source_language,
              imported_name,local_name,receiver_kind,receiver_name,member_name,
              resolution_hints
       FROM edges WHERE id IN(SELECT value FROM json_each(?))`, ids,
    );
    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO unresolved_refs(
         id,owner_id,owner_is_file,ref_name,ref_kind,member_name,line,
         source_language,imported_name,local_name,receiver_kind,receiver_name,
         resolution_hints,status,last_attempt,dynamic_reason
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',0,NULL)`,
    );
    for (const fact of facts) {
      insert.run(fact.id, fact.src_id, fact.kind === "IMPORTS" ? 1 : 0,
        fact.ref_name, fact.rel, fact.member_name, fact.first_line,
        fact.source_language, fact.imported_name, fact.local_name,
        fact.receiver_kind, fact.receiver_name, fact.resolution_hints);
      this.db.prepare("DELETE FROM edges WHERE id IN (?,?)").run(
        fact.id, `${fact.id}:instantiates`,
      );
    }
    this.db.prepare(
      `UPDATE unresolved_refs SET status='pending',last_attempt=0,dynamic_reason=NULL
       WHERE id IN(SELECT value FROM json_each(?))`,
    ).run(ids);
    this.db.prepare(
      "DELETE FROM edge_candidates WHERE edge_id IN(SELECT value FROM json_each(?))",
    ).run(ids);
  }

  private deleteOwnedFacts(fileId: string, symbolIds: readonly string[]): void {
    this.db.prepare(
      "DELETE FROM unresolved_refs WHERE owner_is_file=1 AND owner_id=?",
    ).run(fileId);
    this.db.prepare("DELETE FROM edges WHERE src_is_file=1 AND src_id=?").run(fileId);
    if (symbolIds.length === 0) return;
    const ids = JSON.stringify(symbolIds);
    this.db.prepare(
      "DELETE FROM unresolved_refs WHERE owner_is_file=0 AND owner_id IN(SELECT value FROM json_each(?))",
    ).run(ids);
    this.db.prepare(
      "DELETE FROM edges WHERE src_is_file=0 AND src_id IN(SELECT value FROM json_each(?))",
    ).run(ids);
  }

  private changedSemanticNames(nodes: readonly SymNode[], refs: readonly RawRef[]): string[] {
    return [...new Set([
      ...nodes.flatMap((node) => node.name ? [node.name] : []),
      ...refs.flatMap((ref) => ref.type === "symbol" &&
          ["new", "extends", "implements", "overrides", "type"].includes(ref.ref_kind)
        ? [ref.ref_name, ref.target.member] : []),
    ])];
  }

  private symbolIdsForFile(fileId: string): string[] {
    return this.all<{ id: string }>("SELECT id FROM symbols WHERE file_id=?", fileId)
      .map((row) => row.id);
  }

  private symbolNamesForFile(fileId: string): string[] {
    return this.all<{ name: string }>(
      "SELECT DISTINCT name FROM symbols WHERE file_id=? AND name IS NOT NULL",
      fileId,
    ).map((row) => row.name);
  }
}
