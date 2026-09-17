import { randomUUID } from "node:crypto";
import type { FileGraphResult } from "../../types.js";
import type { GraphStorage } from "../storage.js";
import type { GraphDatabase } from "./database.js";
import { graphTransaction } from "./transaction.js";

/** Replaces extraction snapshots and invalidates dependent cross-file edges. */
export class SqliteGraphWriter implements Pick<
  GraphStorage,
  "writeFileGraph" | "deleteFileGraph"
> {
  constructor(private readonly database: GraphDatabase) {}

  async deleteFileGraph(
    fileId: string,
    oldEntityIds: readonly string[],
  ): Promise<void> {
    this.replace(
      fileId,
      { nodes: [], edges: [], pendingRefs: [] },
      oldEntityIds,
    );
  }

  /**
   * Accepts file-local extraction output only. Cross-file matches must use
   * applyResolutions(), which retains the original reference. Callers serialize target validation
   * and resolution writeback with file changes.
   * Atomic within SQLite; zvec coordination belongs to the indexing pipeline.
   */
  async writeFileGraph(
    fileId: string,
    result: FileGraphResult,
    oldEntityIds: readonly string[],
  ): Promise<void> {
    this.replace(fileId, result, oldEntityIds);
  }

  private replace(
    fileId: string,
    result: FileGraphResult,
    oldEntityIds: readonly string[],
  ): void {
    if (fileId.trim().length === 0) {
      throw new Error("Graph file ID must not be empty");
    }
    if (
      !Array.isArray(oldEntityIds) ||
      oldEntityIds.some(
        (id) => typeof id !== "string" || id.trim().length === 0,
      )
    ) {
      throw new Error(
        "A complete oldEntityIds array is required; use [] for a new file",
      );
    }
    const targets = [...new Set([fileId, ...oldEntityIds])];
    const localIds = new Set(result.nodes.map((node) => node.id));
    if (
      localIds.size !== result.nodes.length ||
      [...localIds].some((id) => id.trim().length === 0 || id === fileId)
    ) {
      throw new Error(
        "Graph nodes must have unique, non-empty entity IDs distinct from the file ID",
      );
    }
    const owns = (id: string): boolean => id === fileId || localIds.has(id);
    for (const edge of result.edges) {
      if (
        edge.provenance !== "file_local" ||
        !owns(edge.source) ||
        !owns(edge.target)
      ) {
        throw new Error(
          "File snapshots accept only local edges; use applyResolutions for cross-file edges",
        );
      }
    }
    for (const ref of result.pendingRefs) {
      if (!owns(ref.ownerId) || ref.status !== "pending") {
        throw new Error(
          "File snapshots require locally owned pending references",
        );
      }
    }
    const db = this.database.connection;
    graphTransaction(db, () => {
      // Include fileId for file-level imports. Chunk to stay below SQLite's
      // parameter limit for large files; every chunk shares this transaction.
      for (let offset = 0; offset < targets.length; offset += 500) {
        const batch = targets.slice(offset, offset + 500);
        const placeholders = batch.map(() => "?").join(", ");
        db.prepare(
          `UPDATE pending_refs
          SET status = 'pending', token = lower(hex(randomblob(16)))
          WHERE id IN (SELECT ref_id FROM edges WHERE target IN (${placeholders}) AND file_id <> ?)
        `,
        ).run(...batch, fileId);
        db.prepare(`DELETE FROM edges WHERE target IN (${placeholders})`).run(
          ...batch,
        );
      }
      db.prepare("DELETE FROM edges WHERE file_id = ?").run(fileId);
      db.prepare("DELETE FROM pending_refs WHERE file_id = ?").run(fileId);
      const insertEdge = db.prepare(`INSERT INTO edges
        (file_id, kind, source, target, line, column, provenance, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const edge of result.edges) {
        insertEdge.run(
          fileId,
          edge.kind,
          edge.source,
          edge.target,
          edge.line,
          edge.column,
          edge.provenance,
          JSON.stringify(edge.metadata),
        );
      }
      const insertRef = db.prepare(`INSERT INTO pending_refs
        (file_id, token, owner_id, ref_name, receiver_name, ref_kind, arity, line, column, status, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const ref of result.pendingRefs) {
        insertRef.run(
          fileId,
          randomUUID(),
          ref.ownerId,
          ref.refName,
          ref.receiverName,
          ref.refKind,
          ref.arity,
          ref.line,
          ref.column,
          ref.status,
          JSON.stringify(ref.metadata),
        );
      }
    });
  }
}
