import { makeRefId } from "../../ref-id.js";
import { referenceTargetFromRaw } from "../../../reference-target.js";
import type { LocalEdge, RawRef, SymNode } from "../../types.js";
import type { EdgeRow } from "./reader.js";
import type { SqliteGraphDatabase } from "./database.js";

type IncomingImport = { src_file_id: string; spec: string };
type IncomingImportBinding = IncomingImport & {
  local_name: string;
  imported_name: string;
};

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
    const incoming = this.incomingSnapshots(fileId);
    this.transaction(() => {
      this.deletePendingOwners(fileId, oldIds);
      this.db.prepare("INSERT OR IGNORE INTO files(id) VALUES (?)").run(fileId);
      this.db.prepare("DELETE FROM symbols WHERE file_id=?").run(fileId);
      this.db
        .prepare("DELETE FROM file_imports WHERE src_file_id=?")
        .run(fileId);
      this.db
        .prepare("DELETE FROM file_import_bindings WHERE src_file_id=?")
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
    });
  }

  deleteFileGraph(fileId: string): void {
    this.assertWritable();
    const oldIds = this.symbolIdsForFile(fileId);
    const incoming = this.incomingSnapshots(fileId);
    const incomingImports = this.incomingImportSnapshots(fileId);
    const incomingBindings = this.incomingBindingSnapshots(fileId);
    this.transaction(() => {
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
      for (const snapshot of incomingBindings) {
        this.insertRef(
          this.importSnapshotRef(snapshot, occurrence++),
          snapshot.src_file_id,
        );
      }
    });
  }

  protected insertRef(ref: RawRef, fallbackOwner: string): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO source_refs(
         id,owner_id,owner_is_file,ref_name,ref_kind,member_name,line,
         source_language,imported_name,local_name,receiver_kind,receiver_name,
         resolution_hints
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
    this.db
      .prepare(
        "INSERT OR REPLACE INTO pending_refs(id,owner_id,owner_is_file,ref_name,ref_kind,line,imported_name,local_name,source_language,receiver_kind,receiver_name,member_name,resolution_hints,status,last_attempt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',0)",
      )
      .run(
        ref.id,
        ref.owner || fallbackOwner,
        ref.type === "symbol" ? 0 : 1,
        ref.ref_name,
        ref.ref_kind,
        ref.line,
        ref.type === "import_binding" ? ref.imported_name : null,
        ref.type === "import_binding" ? ref.local_name : null,
        ref.type === "symbol" || ref.type === "import_binding"
          ? (ref.source_language ?? null)
          : null,
        ref.type === "symbol" ? (ref.target.receiver?.kind ?? null) : null,
        ref.type === "symbol" ? (ref.target.receiver?.name ?? null) : null,
        ref.type === "symbol" ? ref.target.member : null,
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
              e.count-(SELECT COUNT(*) FROM resolved_source_refs r
                       WHERE r.src_id=e.src_id AND r.dst_id=e.dst_id
                         AND r.kind=e.kind AND r.rel=e.rel) AS count,
              e.first_line,e.ref_name,e.provenance,e.confidence,e.evidence
       FROM symbol_edges e
       JOIN symbols d ON d.id=e.dst_id
       JOIN symbols s ON s.id=e.src_id
       WHERE d.file_id=? AND s.file_id<>?
         AND e.count>(SELECT COUNT(*) FROM resolved_source_refs r
                     WHERE r.src_id=e.src_id AND r.dst_id=e.dst_id
                       AND r.kind=e.kind AND r.rel=e.rel)`,
      fileId,
      fileId,
    );
  }

  private incomingImportSnapshots(fileId: string): IncomingImport[] {
    return this.all<IncomingImport>(
      "SELECT src_file_id,spec FROM file_imports WHERE dst_file_id=? ORDER BY src_file_id,spec",
      fileId,
    );
  }

  private incomingBindingSnapshots(fileId: string): IncomingImportBinding[] {
    return this.all<IncomingImportBinding>(
      "SELECT src_file_id,spec,local_name,imported_name FROM file_import_bindings WHERE dst_file_id=? ORDER BY src_file_id,spec,local_name,imported_name",
      fileId,
    ).filter((row) => row.spec.length > 0);
  }

  private importSnapshotRef(
    snapshot: IncomingImport | IncomingImportBinding,
    occurrence: number,
  ): RawRef {
    const binding = "local_name" in snapshot ? snapshot : undefined;
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
    if (binding)
      return {
        ...base,
        type: "import_binding",
        ref_kind: "import",
        imported_name: binding.imported_name,
        local_name: binding.local_name,
        source_language: "unknown",
      };
    return { ...base, type: "import", ref_kind: "import" };
  }

  private symbolIdsForFile(fileId: string): string[] {
    return this.all<{ id: string }>(
      "SELECT id FROM symbols WHERE file_id=?",
      fileId,
    ).map((row) => row.id);
  }

  private deletePendingOwners(fileId: string, ids: readonly string[]): void {
    this.db
      .prepare("DELETE FROM pending_refs WHERE owner_is_file=1 AND owner_id=?")
      .run(fileId);
    if (ids.length > 0) {
      this.db
        .prepare(
          "DELETE FROM pending_refs WHERE owner_id IN(SELECT value FROM json_each(?))",
        )
        .run(JSON.stringify(ids));
      this.db
        .prepare(
          "DELETE FROM source_refs WHERE owner_is_file=0 AND owner_id IN(SELECT value FROM json_each(?))",
        )
        .run(JSON.stringify(ids));
    }
    this.db
      .prepare("DELETE FROM source_refs WHERE owner_is_file=1 AND owner_id=?")
      .run(fileId);
  }
}
