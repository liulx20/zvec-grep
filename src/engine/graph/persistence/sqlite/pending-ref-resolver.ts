import type {
  GraphStorage,
  PendingRefPage,
  ReferenceResolution,
  StoredPendingRef,
} from "../storage.js";
import type { PendingRef } from "../../types.js";
import type { GraphDatabase } from "./database.js";
import { graphTransaction } from "./transaction.js";

/** Persistence protocol for a language resolver; does not guess symbol targets. */
export class SqlitePendingRefStore implements Pick<
  GraphStorage,
  "listPendingRefs" | "applyResolutions"
> {
  constructor(private readonly database: GraphDatabase) {}

  async listPendingRefs(
    options: { limit?: number; cursor?: number } = {},
  ): Promise<PendingRefPage> {
    const limit = options.limit ?? 100;
    const cursor = options.cursor ?? 0;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 1000 ||
      !Number.isSafeInteger(cursor) ||
      cursor < 0
    ) {
      throw new Error(
        "Pending query requires limit 1..1000 and a non-negative integer cursor",
      );
    }
    const rows = this.database.connection
      .prepare(
        `SELECT p.* FROM pending_refs p
      WHERE p.status = 'pending' AND p.id > ? ORDER BY p.id LIMIT ?`,
      )
      .all(cursor, limit + 1);
    const refs = rows.slice(0, limit).map((row): StoredPendingRef => ({
      id: row.id as number,
      token: row.token as string,
      fileId: row.file_id as string,
      ownerId: row.owner_id as string,
      refName: row.ref_name as string,
      receiverName: row.receiver_name as string | null,
      refKind: row.ref_kind as PendingRef["refKind"],
      arity: row.arity as number | null,
      line: row.line as number,
      column: row.column as number,
      status: "pending",
      metadata: JSON.parse(row.metadata as string) as Record<string, unknown>,
    }));
    return {
      refs,
      ...(rows.length > limit ? { nextCursor: refs[refs.length - 1].id } : {}),
    };
  }

  async applyResolutions(
    results: readonly ReferenceResolution[],
  ): Promise<{ resolved: number; stale: number }> {
    const db = this.database.connection;
    return graphTransaction(db, () => {
      const stats = { resolved: 0, stale: 0 };
      const findRef = db.prepare(`SELECT p.* FROM pending_refs p
          WHERE p.id = ? AND p.token = ? AND p.status = 'pending'`);
      const insert = db.prepare(`INSERT INTO edges
        (file_id, ref_id, kind, source, target, line, column, provenance, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const mark = db.prepare(
        "UPDATE pending_refs SET status = 'resolved' WHERE id = ?",
      );
      for (const result of results) {
        if (
          !Number.isSafeInteger(result.refId) ||
          result.refId < 1 ||
          !result.refToken ||
          typeof result.targetId !== "string" ||
          result.targetId.trim().length === 0 ||
          !["import_scoped", "preferred_file", "workspace_unique"].includes(
            result.provenance,
          )
        ) {
          throw new Error("Invalid reference resolution");
        }
        const ref = findRef.get(result.refId, result.refToken);
        if (!ref) {
          stats.stale++;
          continue;
        }
        insert.run(
          ref.file_id,
          ref.id,
          ref.ref_kind,
          ref.owner_id,
          result.targetId,
          ref.line,
          ref.column,
          result.provenance,
          ref.metadata,
        );
        mark.run(ref.id);
        stats.resolved++;
      }
      return stats;
    });
  }
}
