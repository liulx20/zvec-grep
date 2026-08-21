import { makeRefId } from "../../ref-id.js";
import { referenceTargetFromRaw } from "../../../reference-target.js";
import type { LocalEdge, RawRef, SymNode } from "../../types.js";
import type { EdgeRow } from "./reader.js";
import type { SqliteGraphDatabase } from "./database.js";

type IncomingImport = { src_file_id: string; spec: string };

/** File-scoped graph mutations and transaction handling. */
export class SqliteGraphWriter {
  constructor(private readonly database: SqliteGraphDatabase) {}

  private get db() {
    return this.database.db;
  }

  private get readOnly(): boolean {
    return this.database.readOnly;
  }

  private assertOpen(): void {
    this.database.assertOpen();
  }

  private assertWritable(): void {
    this.database.assertWritable();
  }

  private transaction(work: () => void): void {
    this.database.transaction(work);
  }

  private all<T>(sql: string, ...params: Array<string | number>): T[] {
    return this.database.all<T>(sql, ...params);
  }
  async checkpoint(): Promise<void> {
    this.assertOpen();
    if (!this.readOnly) this.db.exec("PRAGMA wal_checkpoint(PASSIVE)");
  }

  upsertFileGraph(
    fileId: string,
    nodes: readonly SymNode[],
    edges: readonly LocalEdge[],
    refs: readonly RawRef[],
  ): void {
    this.assertWritable();
    const oldIds = this.symbolIdsForFile(fileId);
    const incomingRefIds = this.incomingSymbolRefIds(fileId);
    const receiverAffectedRefIds = this.receiverAffectedRefIds(
      fileId,
      this.changedSemanticNames(nodes, refs),
    );
    const incoming = this.incomingSnapshots(fileId);
    this.transaction(() => {
      this.invalidateSymbolProjections([
        ...incomingRefIds,
        ...receiverAffectedRefIds,
      ]);
      this.deletePendingOwners(fileId, oldIds);
      this.db.prepare("INSERT OR IGNORE INTO files(id) VALUES (?)").run(fileId);
      this.db.prepare("DELETE FROM symbols WHERE file_id=?").run(fileId);
      this.db
        .prepare("DELETE FROM file_imports WHERE src_file_id=?")
        .run(fileId);
      const insert = this.db.prepare(
        "INSERT INTO symbols(id,file_id,name,kind,is_exported,signature,arity,return_type) VALUES (?,?,?,?,?,?,?,?)",
      );
      for (const node of nodes) {
        insert.run(
          node.id,
          fileId,
          node.name ?? null,
          node.kind,
          node.is_exported ? 1 : 0,
          node.signature ?? null,
          node.arity ?? null,
          node.returnType ?? null,
        );
      }
      for (const edge of edges) this.insertLocalEdge(edge);
      for (const ref of refs) this.insertRef(ref, fileId);
      let occurrence = 0;
      for (const snap of incoming) {
        for (let i = 0; i < Math.max(1, snap.count); i++) {
          this.insertRef(this.snapshotRef(snap, occurrence++), fileId);
        }
      }
      this.requeueSourceRefs([...incomingRefIds, ...receiverAffectedRefIds]);
    });
  }

  deleteFileGraph(fileId: string): void {
    this.assertWritable();
    const oldIds = this.symbolIdsForFile(fileId);
    const receiverAffectedRefIds = this.receiverAffectedRefIds(
      fileId,
      this.symbolNamesForFile(fileId),
    );
    const incomingRefIds = [
      ...this.incomingSymbolRefIds(fileId),
      ...this.incomingImportRefIds(fileId),
      ...receiverAffectedRefIds,
    ];
    const incoming = this.incomingSnapshots(fileId);
    const incomingImports = this.incomingImportSnapshots(fileId);
    this.transaction(() => {
      this.invalidateSymbolProjections(incomingRefIds);
      this.deletePendingOwners(fileId, oldIds);
      this.db.prepare("DELETE FROM files WHERE id=?").run(fileId);
      let occurrence = 0;
      for (const snap of incoming) {
        for (let i = 0; i < Math.max(1, snap.count); i++) {
          this.insertRef(this.snapshotRef(snap, occurrence++), fileId);
        }
      }
      for (const snapshot of incomingImports) {
        this.insertRef(
          this.importSnapshotRef(snapshot, occurrence++),
          snapshot.src_file_id,
        );
      }
      this.requeueSourceRefs(incomingRefIds);
    });
  }

  protected insertRef(ref: RawRef, fallbackOwner: string): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO reference_edges(
         id,owner_id,owner_is_file,ref_name,ref_kind,member_name,line,
         source_language,imported_name,local_name,receiver_kind,receiver_name,
         resolution_hints,status,last_attempt
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',0)`,
    ).run(
      ref.id,
      ref.owner || fallbackOwner,
      ref.type === "symbol" ? 0 : 1,
      ref.ref_name,
      ref.ref_kind,
      ref.type === "symbol" ? ref.target.member : null,
      ref.line,
      ref.type === "symbol" || ref.type === "import_binding"
        ? (ref.source_language ?? null)
        : null,
      ref.type === "import_binding" ? ref.imported_name : null,
      ref.type === "import_binding" ? ref.local_name : null,
      ref.type === "symbol" ? (ref.target.receiver?.kind ?? null) : null,
      ref.type === "symbol" ? (ref.target.receiver?.name ?? null) : null,
      ref.type === "symbol" && ref.target.hints
        ? JSON.stringify(ref.target.hints)
        : null,
    );
  }

  private insertLocalEdge(edge: LocalEdge): void {
    if (edge.kind === "CONTAINS") {
      this.db
        .prepare(
          "INSERT OR REPLACE INTO contains(parent_id,child_id) VALUES(?,?)",
        )
        .run(edge.src, edge.dst);
      return;
    }
    if (edge.kind === "INSTANTIATES") {
      this.db
        .prepare(
          "INSERT OR REPLACE INTO instantiates(src_id,type_id,first_line) VALUES(?,?,?)",
        )
        .run(edge.src, edge.dst, edge.first_line);
      return;
    }
    this.db
      .prepare(
        "INSERT OR REPLACE INTO symbol_edges(src_id,dst_id,kind,rel,count,first_line,ref_name) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        edge.src,
        edge.dst,
        edge.kind,
        edge.rel,
        edge.count,
        edge.first_line,
        edge.ref_name,
      );
  }

  private snapshotRef(snapshot: EdgeRow, occurrence: number): RawRef {
    return {
      type: "symbol",
      owner: snapshot.src_id,
      id: makeRefId(
        snapshot.src_id,
        snapshot.ref_name,
        snapshot.rel,
        snapshot.first_line,
        occurrence,
      ),
      ref_name: snapshot.ref_name,
      ref_kind: snapshot.rel,
      line: snapshot.first_line,
      target: referenceTargetFromRaw(snapshot.ref_name),
    };
  }

  private incomingSnapshots(fileId: string): EdgeRow[] {
    return this.all<EdgeRow>(
      `SELECT e.src_id,e.dst_id,e.kind,e.rel,
              e.count-(SELECT COUNT(*) FROM reference_edges r
                       WHERE r.owner_id=e.src_id AND r.target_symbol_id=e.dst_id
                         AND r.edge_kind=e.kind AND r.edge_rel=e.rel
                         AND r.status='resolved') AS count,
              e.first_line,e.ref_name,e.provenance,e.confidence,e.evidence
       FROM symbol_edges e
       JOIN symbols d ON d.id=e.dst_id
       JOIN symbols s ON s.id=e.src_id
       WHERE d.file_id=? AND s.file_id<>?
         AND e.count>(SELECT COUNT(*) FROM reference_edges r
                     WHERE r.owner_id=e.src_id AND r.target_symbol_id=e.dst_id
                       AND r.edge_kind=e.kind AND r.edge_rel=e.rel
                       AND r.status='resolved')`,
      fileId,
      fileId,
    );
  }

  private incomingSymbolRefIds(fileId: string): string[] {
    return this.all<{ ref_id: string }>(
      `SELECT r.id AS ref_id FROM reference_edges r
       JOIN symbols target ON target.id=r.target_symbol_id
       JOIN symbols source ON source.id=r.owner_id
       WHERE target.file_id=? AND source.file_id<>?
         AND r.status='resolved' ORDER BY r.id`,
      fileId,
      fileId,
    ).map((row) => row.ref_id);
  }

  private incomingImportRefIds(fileId: string): string[] {
    return this.all<{ ref_id: string }>(
      `SELECT id AS ref_id FROM reference_edges
       WHERE target_file_id=? AND owner_id<>? AND owner_is_file=1
         AND status='resolved' ORDER BY id`,
      fileId,
      fileId,
    ).map((row) => row.ref_id);
  }

  private receiverAffectedRefIds(
    fileId: string,
    names: readonly string[],
  ): string[] {
    const encodedNames = JSON.stringify([...new Set(names)]);
    return this.all<{ ref_id: string }>(
      `WITH RECURSIVE changed_types(id) AS (
         SELECT id FROM symbols
         WHERE name IN (SELECT value FROM json_each(?))
       ), related_types(id) AS (
         SELECT id FROM changed_types
         UNION
         SELECT edge.dst_id FROM symbol_edges edge
         JOIN related_types changed ON changed.id=edge.src_id
         WHERE edge.kind='INHERITS'
           AND edge.rel IN ('extends','implements','trait')
       )
       SELECT DISTINCT fact.id AS ref_id
       FROM reference_edges fact
       JOIN symbols source ON source.id=fact.owner_id
       WHERE fact.owner_is_file=0
         AND source.file_id<>?
         AND (
           fact.id IN (
             SELECT call.id FROM reference_edges call
             JOIN edge_candidates candidate ON candidate.edge_id=call.id
             JOIN symbols target ON target.id=candidate.target_id
             WHERE target.file_id=?
           )
           OR (?<>'[]' AND (
             fact.member_name IN (SELECT value FROM json_each(?))
             OR fact.ref_name IN (SELECT value FROM json_each(?))
             OR json_extract(fact.resolution_hints,'$.receiverType')
                  IN (SELECT value FROM json_each(?))
             OR EXISTS(
               SELECT 1 FROM json_each(
                 COALESCE(json_extract(fact.resolution_hints,'$.candidateTypes'),'[]')
               ) candidate_type
               WHERE candidate_type.value IN (SELECT value FROM json_each(?))
             )
             OR json_extract(fact.resolution_hints,'$.receiverType') IN (
               SELECT name FROM symbols
               WHERE id IN (SELECT id FROM related_types) AND name IS NOT NULL
             )
             OR fact.id IN (
               SELECT call.id FROM reference_edges call
               JOIN edge_candidates candidate ON candidate.edge_id=call.id
               JOIN contains ownership ON ownership.child_id=candidate.target_id
               JOIN symbols container ON container.id=ownership.parent_id
               WHERE container.name IN (SELECT value FROM json_each(?))
             )
           ))
         )
       ORDER BY fact.id`,
      encodedNames,
      fileId,
      fileId,
      encodedNames,
      encodedNames,
      encodedNames,
      encodedNames,
      encodedNames,
      encodedNames,
    ).map((row) => row.ref_id);
  }

  private changedSemanticNames(
    nodes: readonly SymNode[],
    refs: readonly RawRef[],
  ): string[] {
    return [...new Set([
      ...nodes.flatMap((node) => node.name ? [node.name] : []),
      ...refs.flatMap((ref) =>
        ref.type === "symbol" && [
          "new",
          "extends",
          "implements",
          "overrides",
          "type",
        ].includes(ref.ref_kind)
          ? [ref.ref_name, ref.target.member]
          : []
      ),
    ])];
  }

  private incomingImportSnapshots(fileId: string): IncomingImport[] {
    return this.all<IncomingImport>(
      `SELECT i.src_file_id,i.spec FROM file_imports i
       WHERE i.dst_file_id=? AND NOT EXISTS(
         SELECT 1 FROM reference_edges r
         WHERE r.owner_id=i.src_file_id AND r.target_file_id=i.dst_file_id
           AND r.ref_name=i.spec AND r.local_name IS NULL AND r.status='resolved'
       ) ORDER BY i.src_file_id,i.spec`,
      fileId,
    );
  }

  private importSnapshotRef(
    snapshot: IncomingImport,
    occurrence: number,
  ): RawRef {
    const base = {
      owner: snapshot.src_file_id,
      id: makeRefId(
        snapshot.src_file_id,
        snapshot.spec,
        "import",
        0,
        occurrence,
      ),
      ref_name: snapshot.spec,
      ref_kind: "import",
      line: 0,
    };
    return { ...base, type: "import", ref_kind: "import" };
  }

  private symbolIdsForFile(fileId: string): string[] {
    return this.all<{ id: string }>(
      "SELECT id FROM symbols WHERE file_id=?",
      fileId,
    ).map((row) => row.id);
  }

  private symbolNamesForFile(fileId: string): string[] {
    return this.all<{ name: string }>(
      "SELECT DISTINCT name FROM symbols WHERE file_id=? AND name IS NOT NULL",
      fileId,
    ).map((row) => row.name);
  }

  private requeueSourceRefs(refIds: readonly string[]): void {
    if (refIds.length === 0) return;
    const ids = JSON.stringify([...new Set(refIds)]);
    this.db
      .prepare(
        "DELETE FROM edge_candidates WHERE edge_id IN(SELECT value FROM json_each(?))",
      )
      .run(ids);
    this.db.prepare(
      `UPDATE reference_edges
       SET status='pending',last_attempt=0,target_symbol_id=NULL,target_file_id=NULL,
           edge_kind=NULL,edge_rel=NULL,dynamic_reason=NULL,
           provenance=NULL,confidence=NULL,evidence=NULL
       WHERE id IN(SELECT value FROM json_each(?))`,
    ).run(ids);
  }

  private invalidateSymbolProjections(refIds: readonly string[]): void {
    if (refIds.length === 0) return;
    const ids = JSON.stringify([...new Set(refIds)]);
    const projections = this.all<{
      src_id: string;
      dst_id: string;
      kind: string;
      rel: string;
    }>(
      `SELECT owner_id AS src_id,target_symbol_id AS dst_id,
              edge_kind AS kind,edge_rel AS rel
       FROM reference_edges
       WHERE id IN(SELECT value FROM json_each(?))
         AND status='resolved' AND target_symbol_id IS NOT NULL`,
      ids,
    );
    const count = this.db.prepare(
      `SELECT count FROM symbol_edges
       WHERE src_id=? AND dst_id=? AND kind=? AND rel=?`,
    );
    const remove = this.db.prepare(
      `DELETE FROM symbol_edges
       WHERE src_id=? AND dst_id=? AND kind=? AND rel=?`,
    );
    const decrement = this.db.prepare(
      `UPDATE symbol_edges SET count=count-1
       WHERE src_id=? AND dst_id=? AND kind=? AND rel=?`,
    );
    for (const projection of projections) {
      const row = count.get(
        projection.src_id,
        projection.dst_id,
        projection.kind,
        projection.rel,
      ) as { count: number } | undefined;
      if (row) {
        const statement = row.count <= 1 ? remove : decrement;
        statement.run(
          projection.src_id,
          projection.dst_id,
          projection.kind,
          projection.rel,
        );
      }
      if (projection.rel === "new") {
        this.db.prepare(
          "DELETE FROM instantiates WHERE src_id=? AND type_id=?",
        ).run(projection.src_id, projection.dst_id);
      }
    }
  }

  private deletePendingOwners(fileId: string, ids: readonly string[]): void {
    this.db
      .prepare("DELETE FROM reference_edges WHERE owner_is_file=1 AND owner_id=?")
      .run(fileId);
    if (ids.length > 0) {
      this.db
        .prepare(
          "DELETE FROM reference_edges WHERE owner_is_file=0 AND owner_id IN(SELECT value FROM json_each(?))",
        )
        .run(JSON.stringify(ids));
    }
  }
}
