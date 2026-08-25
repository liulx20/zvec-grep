import type {
  Edge,
  ExtractionResult,
  Node,
  UnresolvedReference,
} from "../../../extraction/kernel/types.js";
import type { SqliteGraphDatabase } from "./database.js";

/**
 * Write CodeGraph kernel extraction results directly into the CodeGraph-style
 * SQLite schema (nodes / edges / files / unresolved_refs).
 */
export class KernelGraphWriter {
  constructor(private readonly database: SqliteGraphDatabase) {}

  private get db() {
    return this.database.db;
  }

  private assertWritable(): void {
    this.database.assertWritable();
  }

  writeFileGraph(
    filePath: string,
    language: string,
    contentHash: string,
    size: number,
    result: ExtractionResult,
  ): void {
    this.assertWritable();
    const now = Date.now();

    this.database.transaction(() => {
      // Delete stale data for this file
      this.db.prepare("DELETE FROM unresolved_refs WHERE file_path = ?").run(filePath);
      this.db.prepare("DELETE FROM edges WHERE source IN (SELECT id FROM nodes WHERE file_path = ?)").run(filePath);
      this.db.prepare("DELETE FROM edges WHERE target IN (SELECT id FROM nodes WHERE file_path = ?)").run(filePath);
      this.db.prepare("DELETE FROM nodes WHERE file_path = ?").run(filePath);
      this.db.prepare("DELETE FROM files WHERE path = ?").run(filePath);

      // Insert file record
      this.db.prepare(
        `INSERT INTO files(path, content_hash, language, size, modified_at, indexed_at, node_count, generated)
         VALUES(?, ?, ?, ?, ?, ?, ?, 0)`,
      ).run(
        filePath,
        contentHash,
        language,
        size,
        now,
        now,
        result.nodes.length,
      );

      // Insert nodes
      const insertNode = this.db.prepare(
        `INSERT INTO nodes(
          id, kind, name, qualified_name, file_path, language,
          start_line, end_line, start_column, end_column,
          docstring, signature, visibility,
          is_exported, is_async, is_static, is_abstract,
          decorators, type_parameters, return_type, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const node of result.nodes) {
        insertNode.run(
          node.id,
          node.kind,
          node.name,
          node.qualifiedName,
          filePath,
          language,
          node.startLine,
          node.endLine,
          node.startColumn,
          node.endColumn,
          node.docstring ?? null,
          node.signature ?? null,
          node.visibility ?? null,
          node.isExported ? 1 : 0,
          node.isAsync ? 1 : 0,
          node.isStatic ? 1 : 0,
          node.isAbstract ? 1 : 0,
          node.decorators ? JSON.stringify(node.decorators) : null,
          node.typeParameters ? JSON.stringify(node.typeParameters) : null,
          node.returnType ?? null,
          node.updatedAt,
        );
      }

      // Insert edges
      const insertEdge = this.db.prepare(
        `INSERT OR IGNORE INTO edges(source, target, kind, metadata, line, col, provenance)
         VALUES(?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const edge of result.edges) {
        insertEdge.run(
          edge.source,
          edge.target,
          edge.kind,
          edge.metadata ? JSON.stringify(edge.metadata) : null,
          edge.line ?? null,
          edge.col ?? null,
          edge.provenance ?? null,
        );
      }

      // Insert unresolved refs
      const insertRef = this.db.prepare(
        `INSERT INTO unresolved_refs(
          from_node_id, reference_name, reference_kind,
          line, col, candidates, file_path, language, status, name_tail, metadata
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const ref of result.unresolvedReferences) {
        insertRef.run(
          ref.fromNodeId,
          ref.referenceName,
          ref.referenceKind,
          ref.line,
          ref.col,
          ref.candidates ? JSON.stringify(ref.candidates) : null,
          ref.filePath ?? filePath,
          ref.language ?? language,
          "pending",
          "",
          null,
        );
      }
    });
  }
}
