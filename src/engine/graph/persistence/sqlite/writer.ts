import type { LocalEdge, RawRef, SymNode } from "../../types.js";
import type { SqliteGraphDatabase } from "./database.js";
import type { FileInfo } from "../../../types.js";

/** Graph edge kind mapping from the legacy upper-case enum to CodeGraph kinds. */
const EDGE_KIND_MAP: Record<string, string> = {
  CALLS: "calls",
  REFS: "references",
  INHERITS: "extends",
  CONTAINS: "contains",
  DEFINES: "defines",
  IMPORTS: "imports",
  INSTANTIATES: "instantiates",
};

function edgeKindToDb(kind: string): string {
  return EDGE_KIND_MAP[kind] ?? kind.toLowerCase();
}

function refKindToDb(refKind: string): string {
  switch (refKind) {
    case "call":
      return "calls";
    case "ref":
      return "references";
    case "inherit":
      return "extends";
    case "import":
      return "imports";
    case "instantiate":
      return "instantiates";
    default:
      return refKind;
  }
}

function filePathFor(fileId: string, file?: FileInfo): string {
  return file?.absolutePath ?? fileId;
}

function languageFor(file?: FileInfo): string {
  return file?.format ?? "unknown";
}

/** File-scoped graph mutations for the CodeGraph SQLite schema. */
export class SqliteGraphWriter {
  constructor(private readonly database: SqliteGraphDatabase) {}

  private get db() {
    return this.database.db;
  }
  private get readOnly(): boolean {
    return this.database.readOnly;
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
    file?: FileInfo,
  ): void {
    this.database.assertWritable();
    const filePath = filePathFor(fileId, file);
    const language = languageFor(file);
    const now = Date.now();

    // Collect names that may invalidate existing resolved projections.
    // When a file is re-indexed with new same-name symbols, previously
    // workspace_unique / preferred_file edges must be invalidated so the
    // resolver can re-evaluate against the updated symbol set.
    const skipInvalidation =
      this.database.isBulkLoad() ||
      !this.database.hasResolvedProjections();
    const newNames = nodes.flatMap((n) => (n.name ? [n.name] : []));
    const oldNames = skipInvalidation ? [] : this.symbolNamesForFile(filePath);
    const changedNames = [...new Set([...oldNames, ...newNames])];
    const affected = skipInvalidation
      ? []
      : this.affectedResolvedEdgeIds(filePath, changedNames);

    this.database.transaction(() => {
      // Delete affected resolved edges so the trigger restores their source
      // refs to pending for re-resolution.
      if (affected.length > 0) {
        const ids = JSON.stringify([...new Set(affected)]);
        this.database
          .prepare(
            "DELETE FROM edges WHERE id IN (SELECT value FROM json_each(?))",
          )
          .run(ids);
      }
      this.deleteOwnedFacts(filePath);

      this.database
        .prepare(
          `INSERT INTO files(
             path, content_hash, language, size, modified_at, indexed_at,
             node_count, errors, generated
           ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(path) DO UPDATE SET
             content_hash=excluded.content_hash,
             language=excluded.language,
             size=excluded.size,
             modified_at=excluded.modified_at,
             indexed_at=excluded.indexed_at,
             node_count=excluded.node_count,
             errors=excluded.errors,
             generated=excluded.generated`,
        )
        .run(
          filePath,
          "",
          language,
          file?.sizeBytes ?? 0,
          file?.lastModifiedTime ?? now,
          now,
          nodes.length,
          null,
          0,
        );

      const insertNode = this.database.prepare(
        `INSERT INTO nodes(
           id, kind, name, qualified_name, file_path, language,
           start_line, end_line, start_column, end_column,
           docstring, signature, arity, visibility,
           is_exported, is_async, is_static, is_abstract,
           decorators, type_parameters, return_type, updated_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const node of nodes) {
        const range =
          node.range?.kind === "text" ? node.range : undefined;
        insertNode.run(
          node.id,
          node.kind,
          node.name ?? "",
          node.qualifiedName ?? node.name ?? "",
          filePath,
          language,
          range?.startLine ?? 0,
          range?.endLine ?? (range?.startLine ?? 0),
          0,
          0,
          null,
          node.signature ?? null,
          node.arity ?? null,
          null,
          node.is_exported ? 1 : 0,
          0,
          0,
          0,
          node.modifiers ? JSON.stringify(node.modifiers) : null,
          null,
          node.returnType ?? null,
          now,
        );
      }

      const insertEdge = this.database.prepare(
        `INSERT OR IGNORE INTO edges(source, target, kind, metadata, line, col, provenance)
         VALUES(?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const edge of edges) {
        const metadata: Record<string, unknown> = {};
        if (edge.rel && edge.rel !== edgeKindToDb(edge.kind)) {
          metadata.rel = edge.rel;
        }
        if (edge.count && edge.count !== 1) metadata.count = edge.count;
        if (edge.ref_name) metadata.refName = edge.ref_name;
        if (edge.source_language) metadata.sourceLanguage = edge.source_language;
        if (edge.target?.receiver) metadata.receiver = edge.target.receiver;
        if (edge.target?.member) metadata.member = edge.target.member;
        if (edge.target?.hints) metadata.hints = edge.target.hints;
        insertEdge.run(
          edge.src,
          edge.dst,
          edgeKindToDb(edge.kind),
          Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null,
          edge.first_line ?? null,
          null,
          "static",
        );
      }

      const insertRef = this.database.prepare(
        `INSERT INTO unresolved_refs(
           from_node_id, reference_name, reference_kind,
           line, col, candidates, file_path, language, status, name_tail, metadata
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const ref of refs) {
        const metadata: Record<string, unknown> = {};
        if (ref.type === "import_binding") {
          metadata.importedName = ref.imported_name;
          metadata.localName = ref.local_name;
        }
        if ("rust_inline_module_depth" in ref && ref.rust_inline_module_depth !== undefined) {
          metadata.rustInlineModuleDepth = ref.rust_inline_module_depth;
        }
        if (ref.type === "symbol" && ref.target) {
          if (ref.target.receiver) {
            metadata.receiverKind = ref.target.receiver.kind;
            metadata.receiverName = ref.target.receiver.name;
          }
          if (ref.target.member) metadata.member = ref.target.member;
          if (ref.target.hints) metadata.resolutionHints = ref.target.hints;
        }
        const referenceKind =
          ref.ref_kind === "call"
            ? "calls"
            : ref.ref_kind === "ref"
              ? "references"
              : refKindToDb(ref.ref_kind);
        insertRef.run(
          ref.owner || fileId,
          ref.ref_name,
          referenceKind,
          ref.line,
          0,
          null,
          filePath,
          ref.source_language ?? language,
          "pending",
          "",
          Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null,
        );
      }
    });
  }

  deleteFileGraph(fileId: string): void {
    this.database.assertWritable();
    this.deleteOwnedFacts(fileId);
    this.database.prepare("DELETE FROM files WHERE path = ?").run(fileId);
  }

  /**
   * Returns resolved call-edge ids that should be invalidated when a file is
   * (re-)indexed with *fileId*.  Three categories are covered:
   *
   * 1. Edges whose target node lives in *fileId* — the target may be gone or
   *    changed.
   * 2. Edges resolved as `workspace_unique` whose refName / member matches one
   *    of *changedNames* — the name is no longer globally unique.
   * 3. Edges resolved as `preferred_file` whose refName / member matches one of
   *    *changedNames* **and** whose source file transitively imports *fileId*
   *    — the import chain may now surface a different symbol.
   */
  affectedResolvedEdgeIds(fileId: string, names?: string[]): string[] {
    const changedNames = JSON.stringify([...new Set(names ?? [])]);
    return this.database
      .all<{ id: number }>(
        `WITH RECURSIVE affected_importers(file_id) AS (
           SELECT ? AS file_id
           UNION
           SELECT e.source AS file_id FROM edges e
           JOIN affected_importers ai ON e.target = ai.file_id
           WHERE e.kind='imports'
         )
         SELECT DISTINCT e.id FROM edges e
         JOIN nodes target ON target.id = e.target
         LEFT JOIN nodes source ON source.id = e.source
         WHERE e.kind = 'calls'
           AND json_extract(e.metadata, '$.evidence') IS NOT NULL
           AND (
             target.file_path = ?
             OR (? <> '[]' AND (
               (json_extract(e.metadata, '$.evidence') = 'workspace_unique' AND (
                 COALESCE(json_extract(e.metadata, '$.refName'), '')
                   IN (SELECT value FROM json_each(?))
                 OR COALESCE(json_extract(e.metadata, '$.member'), '')
                   IN (SELECT value FROM json_each(?))
               ))
               OR (json_extract(e.metadata, '$.evidence') = 'preferred_file' AND (
                 COALESCE(json_extract(e.metadata, '$.refName'), '')
                   IN (SELECT value FROM json_each(?))
                 OR COALESCE(json_extract(e.metadata, '$.member'), '')
                   IN (SELECT value FROM json_each(?))
               ) AND source.file_path
                   IN (SELECT file_id FROM affected_importers))
             ))
           )`,
        fileId,
        fileId,
        changedNames,
        changedNames,
        changedNames,
        changedNames,
      )
      .map((row) => String(row.id));
  }

  private symbolNamesForFile(filePath: string): string[] {
    return this.database
      .all<{ name: string }>(
        "SELECT DISTINCT name FROM nodes WHERE file_path=? AND name IS NOT NULL AND name<>''",
        filePath,
      )
      .map((row) => row.name);
  }

  private deleteOwnedFacts(filePath: string): void {
    // When deleting edges, the trigger restore_resolved_ref_on_edge_delete
    // will automatically restore status='resolved' refs to pending.
    this.database
      .prepare("DELETE FROM unresolved_refs WHERE file_path = ?")
      .run(filePath);
    // Symbol-level edges: source or target is a node whose file_path matches.
    this.database
      .prepare(
        "DELETE FROM edges WHERE source IN (SELECT id FROM nodes WHERE file_path = ?)",
      )
      .run(filePath);
    this.database
      .prepare(
        "DELETE FROM edges WHERE target IN (SELECT id FROM nodes WHERE file_path = ?)",
      )
      .run(filePath);
    // File-level edges (e.g. IMPORTS): source or target is the file path
    // itself, which is not present as a node id when the file is empty.
    this.database.prepare("DELETE FROM edges WHERE source = ?").run(filePath);
    this.database.prepare("DELETE FROM edges WHERE target = ?").run(filePath);
    // Heuristic projections may depend on symbols in the re-indexed file.
    // The trigger restores their source refs to pending for re-resolution.
    this.database
      .prepare("DELETE FROM edges WHERE provenance='heuristic'")
      .run();
    // Dynamic boundaries also depend on RTA state that may change when
    // a file is re-indexed (e.g., new/removed instantiations). Restore
    // them to pending so the resolver can re-evaluate dispatch.
    this.database
      .prepare(
        "UPDATE unresolved_refs SET status='pending' WHERE status='dynamic'",
      )
      .run();
    this.database.prepare("DELETE FROM nodes WHERE file_path = ?").run(filePath);
    this.database.prepare("DELETE FROM files WHERE path = ?").run(filePath);
  }
}
