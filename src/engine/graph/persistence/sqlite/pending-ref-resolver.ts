import { FilePathIndex } from "../../imports/path-index.js";
import { resolveImportPath } from "../../imports/resolve-path.js";
import { NameIndex } from "../../name-index.js";
import { referenceResolutionPolicy } from "../../reference-resolution-policy.js";
import { referenceTargetFromRaw } from "../../../reference-target.js";
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
      this.all<
        SymbolRow & {
          container_id: string | null;
          container_name: string | null;
        }
      >(
        `SELECT s.id,s.file_id,s.name,s.kind,s.is_exported,
                p.id AS container_id,p.name AS container_name
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
        containerId: row.container_id ?? undefined,
      })),
    );
    const paths = new FilePathIndex(options.files ?? []);
    const attempt = this.nextAttempt();
    const rounds = this.retryRounds(attempt);
    const hierarchyCache = new Map<string, readonly string[]>();
    for (let round = 0; round < rounds; round++) {
      this.transaction(() => {
        const refs = this.retryableRefs(attempt);
        for (const ref of refs.filter(
          (item) => item.owner_is_file || item.ref_kind === "import",
        )) {
          this.resolveImport(ref, paths, attempt);
        }
        const symbolRefs = refs.filter(
          (item) => !item.owner_is_file && item.ref_kind !== "import",
        );
        for (const ref of symbolRefs.filter(isInheritanceRef)) {
          this.resolveSymbol(ref, names, attempt, hierarchyCache);
        }
        for (const ref of symbolRefs.filter((ref) => !isInheritanceRef(ref))) {
          this.resolveSymbol(ref, names, attempt, hierarchyCache);
        }
      });
    }
  }

  private resolveSymbol(
    ref: RefRow,
    names: NameIndex,
    attempt: number,
    hierarchyCache: Map<string, readonly string[]>,
  ): void {
    const owner = this.one<{
      file_id: string;
      container_id: string | null;
      container_name: string | null;
    }>(
      `SELECT s.file_id,p.id AS container_id,p.name AS container_name FROM symbols s
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
      target: {
        raw: ref.ref_name,
        member: ref.member_name ?? referenceTargetFromRaw(ref.ref_name).member,
        receiver:
          ref.receiver_kind && ref.receiver_name
            ? { kind: ref.receiver_kind, name: ref.receiver_name }
            : undefined,
      },
    };
    const reference = referenceResolutionPolicy.analyzeReference(
      pending.target ?? ref.ref_name,
      ref.source_language ?? undefined,
    );
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
            kind: binding.local_name === ref.ref_name ? "exact" : "receiver",
          }
        : undefined,
      owner.container_name ?? undefined,
      owner.container_id ?? undefined,
      reference.receiver.kind === "owner" && owner.container_id
        ? this.cachedInheritanceContainers(
            hierarchyCache,
            owner.container_id,
            reference.receiver.includeOwner,
          )
        : [],
      reference,
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

  private retryableRefs(attemptWatermark: number): RefRow[] {
    return this.all<RefRow>(
      `SELECT id,owner_id,owner_is_file,ref_name,ref_kind,line,status,imported_name,local_name,source_language,receiver_kind,receiver_name,member_name,last_attempt
       FROM (
         SELECT pending_refs.*,
                row_number() OVER (PARTITION BY ref_name ORDER BY last_attempt,id) AS retry_rank
         FROM pending_refs
         WHERE status='failed' AND last_attempt<?
       )
       WHERE retry_rank<=?
       UNION ALL
       SELECT id,owner_id,owner_is_file,ref_name,ref_kind,line,status,imported_name,local_name,source_language,receiver_kind,receiver_name,member_name,last_attempt
       FROM pending_refs
       WHERE status='pending' AND last_attempt<?
       ORDER BY ref_name,id`,
      attemptWatermark,
      PER_NAME_CEILING,
      attemptWatermark,
    );
  }

  private inheritanceContainers(
    containerId: string,
    includeOwner: boolean,
  ): string[] {
    return this.all<{ id: string; depth: number }>(
      `WITH RECURSIVE hierarchy(id,depth) AS (
         SELECT ?,0
         UNION
         SELECT e.dst_id,h.depth+1
         FROM symbol_edges e JOIN hierarchy h ON e.src_id=h.id
         WHERE e.kind='INHERITS'
           AND e.rel IN ('extends','implements')
           AND h.depth<32
       )
       SELECT id,depth FROM hierarchy WHERE depth>=? ORDER BY depth,id`,
      containerId,
      includeOwner ? 0 : 1,
    ).map((row) => row.id);
  }

  private cachedInheritanceContainers(
    cache: Map<string, readonly string[]>,
    containerId: string,
    includeOwner: boolean,
  ): readonly string[] {
    const key = `${containerId}\0${includeOwner ? "with-owner" : "bases-only"}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const containers = this.inheritanceContainers(containerId, includeOwner);
    cache.set(key, containers);
    return containers;
  }

  private retryRounds(attemptWatermark: number): number {
    const row = this.one<{ max_count: number }>(
      `SELECT COALESCE(MAX(ref_count),0) AS max_count FROM (
         SELECT COUNT(*) AS ref_count FROM pending_refs
         WHERE status='failed' AND last_attempt<? GROUP BY ref_name
       )`,
      attemptWatermark,
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

function isInheritanceRef(ref: RefRow): boolean {
  return (
    ref.ref_kind === "extends" ||
    ref.ref_kind === "implements" ||
    ref.ref_kind === "overrides"
  );
}
