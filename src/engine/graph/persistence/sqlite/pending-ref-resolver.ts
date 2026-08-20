import { FilePathIndex } from "../../imports/path-index.js";
import { resolveImportPath } from "../../imports/resolve-path.js";
import { NameIndex } from "../../name-index.js";
import { resolveRef } from "../../resolve.js";
import type { PendingRef, ResolvePendingOptions } from "../../types.js";
import { type RefRow, type SymbolRow } from "./reader.js";
import type { SqliteGraphDatabase } from "./database.js";

const PER_NAME_CEILING = 500;

/** Converts pending call/ref/import sites into persisted graph edges. */
export class SqlitePendingRefResolver {
  constructor(private readonly database: SqliteGraphDatabase) {}

  private get db() {
    return this.database.db;
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

  private one<T>(
    sql: string,
    ...params: Array<string | number>
  ): T | undefined {
    return this.database.one<T>(sql, ...params);
  }
  async resolvePending(options: ResolvePendingOptions = {}): Promise<void> {
    this.assertWritable();
    const names = new NameIndex();
    names.load(
      this.all<SymbolRow & { container_name: string | null }>(
        `SELECT s.id,s.file_id,s.name,s.kind,s.is_exported,p.name AS container_name
         FROM symbols s
         LEFT JOIN contains c ON c.child_id=s.id
         LEFT JOIN symbols p ON p.id=c.parent_id
         WHERE s.name IS NOT NULL`,
      ).map((row) => ({
        id: row.id,
        fileId: row.file_id,
        name: row.name!,
        kind: row.kind,
        containerName: row.container_name ?? undefined,
      })),
    );
    const paths = new FilePathIndex(options.files ?? []);
    const rounds = this.retryRounds();
    for (let round = 0; round < rounds; round++) {
      this.transaction(() => {
        const attempt = this.nextAttempt();
        const refs = this.retryableRefs();
        for (const ref of refs.filter(
          (item) => item.owner_is_file || item.ref_kind === "import",
        )) {
          this.resolveImport(ref, paths, attempt);
        }
        for (const ref of refs.filter(
          (item) => !item.owner_is_file && item.ref_kind !== "import",
        )) {
          this.resolveSymbol(ref, names, attempt);
        }
      });
    }
  }

  private resolveSymbol(ref: RefRow, names: NameIndex, attempt: number): void {
    const owner = this.one<{ file_id: string; container_name: string | null }>(
      `SELECT s.file_id,p.name AS container_name FROM symbols s
       LEFT JOIN contains c ON c.child_id=s.id
       LEFT JOIN symbols p ON p.id=c.parent_id
       WHERE s.id=?`,
      ref.owner_id,
    );
    if (!owner) return this.failRef(ref.id, attempt);
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
      local_name: string;
    }>(
      `SELECT imported_name,dst_file_id,local_name FROM file_import_bindings
       WHERE src_file_id=? AND local_name IN (?,?)
       ORDER BY CASE WHEN local_name=? THEN 0 ELSE 1 END,dst_file_id,imported_name LIMIT 1`,
      owner.file_id,
      ref.ref_name,
      refReceiver(ref.ref_name),
      ref.ref_name,
    );
    const result = resolveRef(
      pending,
      names,
      binding ? [binding.dst_file_id] : preferred,
      binding
        ? {
            importedName: binding.imported_name,
            fileId: binding.dst_file_id,
            match: binding.local_name === ref.ref_name ? "exact" : "receiver",
          }
        : undefined,
      owner.container_name ?? undefined,
    );
    if (result.status === "external") return this.deleteRef(ref.id);
    if (result.status !== "resolved") return this.failRef(ref.id, attempt);
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

  private resolveImport(
    ref: RefRow,
    paths: FilePathIndex,
    attempt: number,
  ): void {
    const from = paths.getById(ref.owner_id);
    if (!from) return this.failRef(ref.id, attempt);
    const result = resolveImportPath(
      ref.ref_name,
      ref.owner_id,
      from.format,
      paths,
    );
    if (result.status === "external") return this.deleteRef(ref.id);
    if (result.status !== "resolved") return this.failRef(ref.id, attempt);
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
    return this.all<RefRow>(
      `SELECT id,owner_id,owner_is_file,ref_name,ref_kind,line,status,imported_name,local_name,source_language,last_attempt
       FROM (
         SELECT pending_refs.*,
                row_number() OVER (PARTITION BY ref_name ORDER BY last_attempt,id) AS retry_rank
         FROM pending_refs
         WHERE status='failed'
       )
       WHERE retry_rank<=?
       UNION ALL
       SELECT id,owner_id,owner_is_file,ref_name,ref_kind,line,status,imported_name,local_name,source_language,last_attempt
       FROM pending_refs
       WHERE status='pending'
       ORDER BY ref_name,id`,
      PER_NAME_CEILING,
    );
  }

  private retryRounds(): number {
    const row = this.one<{ max_count: number }>(
      `SELECT COALESCE(MAX(ref_count),0) AS max_count FROM (
         SELECT COUNT(*) AS ref_count FROM pending_refs
         WHERE status='failed' GROUP BY ref_name
       )`,
    );
    return Math.max(1, Math.ceil((row?.max_count ?? 0) / PER_NAME_CEILING));
  }

  private failRef(id: string, attempt: number): void {
    this.db
      .prepare(
        "UPDATE pending_refs SET status='failed',last_attempt=? WHERE id=?",
      )
      .run(attempt, id);
  }

  private deleteRef(id: string): void {
    this.db.prepare("DELETE FROM pending_refs WHERE id=?").run(id);
  }

  private nextAttempt(): number {
    const row = this.db
      .prepare(
        `INSERT INTO graph_meta(key,value) VALUES('pending_ref_attempt','1')
         ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1
         RETURNING value`,
      )
      .get() as { value: string };
    return Number(row.value);
  }
}

function refReceiver(name: string): string {
  return name.split(/[./]/, 1)[0] ?? name;
}
