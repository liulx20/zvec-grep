import { FilePathIndex } from "../../imports/path-index.js";
import { resolveImportPath } from "../../imports/resolve-path.js";
import { NameIndex } from "../../name-index.js";
import { resolveRef } from "../../resolve.js";
import type { PendingRef, ResolvePendingOptions } from "../../types.js";
import { type RefRow, type SymbolRow } from "./reader.js";
import { SqliteGraphWriter } from "./writer.js";

const PER_NAME_CEILING = 500;

/** Converts pending call/ref/import sites into persisted graph edges. */
export class SqlitePendingRefResolver extends SqliteGraphWriter {
  async resolvePending(options: ResolvePendingOptions = {}): Promise<void> {
    this.assertWritable();
    const names = new NameIndex();
    names.load(
      this.all<SymbolRow>(
        "SELECT id,file_id,name,kind,is_exported FROM symbols WHERE name IS NOT NULL",
      ).map((row) => ({
        id: row.id,
        fileId: row.file_id,
        name: row.name!,
        kind: row.kind,
      })),
    );
    const paths = new FilePathIndex(options.files ?? []);
    this.transaction(() => {
      const refs = this.retryableRefs();
      for (const ref of refs.filter(
        (item) => item.owner_is_file || item.ref_kind === "import",
      )) {
        this.resolveImport(ref, paths);
      }
      for (const ref of refs.filter(
        (item) => !item.owner_is_file && item.ref_kind !== "import",
      )) {
        this.resolveSymbol(ref, names);
      }
    });
  }

  private resolveSymbol(ref: RefRow, names: NameIndex): void {
    const owner = this.one<{ file_id: string }>(
      "SELECT file_id FROM symbols WHERE id=?",
      ref.owner_id,
    );
    if (!owner) return this.failRef(ref.id);
    const pending: PendingRef = {
      src: ref.owner_id,
      src_file: owner.file_id,
      ref_id: ref.id,
      ref_name: ref.ref_name,
      ref_kind: ref.ref_kind,
      line: ref.line,
      status: ref.status,
      source_language: ref.source_language ?? undefined,
    };
    const preferred = this.all<{ dst_file_id: string }>(
      "SELECT dst_file_id FROM file_imports WHERE src_file_id=?",
      owner.file_id,
    ).map((row) => row.dst_file_id);
    const binding = this.one<{
      imported_name: string;
      dst_file_id: string;
    }>(
      "SELECT imported_name,dst_file_id FROM file_import_bindings WHERE src_file_id=? AND local_name=? ORDER BY dst_file_id,imported_name LIMIT 1",
      owner.file_id,
      ref.ref_name,
    );
    const result = resolveRef(
      pending,
      names,
      binding ? [binding.dst_file_id] : preferred,
      binding?.imported_name,
    );
    if (result.status === "external") return this.deleteRef(ref.id);
    if (result.status !== "resolved") return this.failRef(ref.id);
    this.db
      .prepare(
        "INSERT INTO symbol_edges(src_id,dst_id,kind,rel,count,first_line,ref_name) VALUES(?,?,?,?,1,?,?) ON CONFLICT(src_id,dst_id,kind,rel) DO UPDATE SET count=count+1,first_line=min(first_line,excluded.first_line)",
      )
      .run(
        ref.owner_id,
        result.dst,
        result.edgeKind,
        ref.ref_kind,
        ref.line,
        ref.ref_name,
      );
    this.deleteRef(ref.id);
  }

  private resolveImport(ref: RefRow, paths: FilePathIndex): void {
    const from = paths.getById(ref.owner_id);
    if (!from) return this.failRef(ref.id);
    const result = resolveImportPath(
      ref.ref_name,
      ref.owner_id,
      from.format,
      paths,
    );
    if (result.status === "external") return this.deleteRef(ref.id);
    if (result.status !== "resolved") return this.failRef(ref.id);
    this.db
      .prepare(
        "INSERT OR IGNORE INTO file_imports(src_file_id,dst_file_id,spec) VALUES(?,?,?)",
      )
      .run(ref.owner_id, result.fileId, ref.ref_name);
    if (ref.imported_name && ref.local_name) {
      this.db
        .prepare(
          "INSERT OR REPLACE INTO file_import_bindings(src_file_id,dst_file_id,local_name,imported_name,spec) VALUES(?,?,?,?,?)",
        )
        .run(
          ref.owner_id,
          result.fileId,
          ref.local_name,
          ref.imported_name,
          ref.ref_name,
        );
    }
    this.deleteRef(ref.id);
  }

  private retryableRefs(): RefRow[] {
    const refs = this.all<RefRow>("SELECT * FROM pending_refs");
    const counts = new Map<string, number>();
    for (const ref of refs) {
      if (ref.status === "failed") {
        counts.set(ref.ref_name, (counts.get(ref.ref_name) ?? 0) + 1);
      }
    }
    return refs.filter(
      (ref) =>
        ref.status === "pending" ||
        (counts.get(ref.ref_name) ?? 0) <= PER_NAME_CEILING,
    );
  }

  private failRef(id: string): void {
    this.db
      .prepare("UPDATE pending_refs SET status='failed' WHERE id=?")
      .run(id);
  }

  private deleteRef(id: string): void {
    this.db.prepare("DELETE FROM pending_refs WHERE id=?").run(id);
  }
}
