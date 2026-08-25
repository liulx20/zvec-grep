import {
  counterpartPathDomainsCompatible,
  counterpartPathsRelated,
} from "../../counterpart-policy.js";
import { fileStem, isHeaderPath, isSourcePath } from "../../path-policy.js";
import type { SqliteGraphDatabase } from "./database.js";

type CounterpartCandidate = {
  left_id: string;
  left_file_id: string;
  left_path: string;
  left_qualified_name: string | null;
  right_id: string;
  right_file_id: string;
  right_path: string;
  right_qualified_name: string | null;
  directly_imported: number;
};

type CounterpartMatch = {
  confidence: number;
  evidence: "declaration_definition" | "direct_import";
};

/** Projects query-independent declaration/definition identity into graph edges. */
export class SqliteCounterpartProjector {
  constructor(private readonly database: SqliteGraphDatabase) {}

  refresh(rebuild: boolean): void {
    const dirtyFiles = this.database.counterpartDirtyFileSnapshot();
    const rebuildAll = rebuild || dirtyFiles === null;
    if (!rebuildAll && dirtyFiles?.length === 0) return;
    const dirtyJson = JSON.stringify(dirtyFiles ?? []);
    this.database.transaction(() => {
      if (rebuildAll) {
        this.database
          .prepare("DELETE FROM edges WHERE kind='COUNTERPART'")
          .run();
      } else {
        this.database
          .prepare(
            `DELETE FROM edges
             WHERE kind='COUNTERPART'
               AND (src_id IN (SELECT id FROM symbols
                                WHERE file_id IN (SELECT value FROM json_each(?)))
                 OR dst_id IN (SELECT id FROM symbols
                                WHERE file_id IN (SELECT value FROM json_each(?))))`,
          )
          .run(dirtyJson, dirtyJson);
      }

      const candidates = this.database.all<CounterpartCandidate>(
        `SELECT left_symbol.id AS left_id,
                left_symbol.file_id AS left_file_id,
                left_file.relative_path AS left_path,
                left_symbol.qualified_name AS left_qualified_name,
                right_symbol.id AS right_id,
                right_symbol.file_id AS right_file_id,
                right_file.relative_path AS right_path,
                right_symbol.qualified_name AS right_qualified_name,
                EXISTS(
                  SELECT 1 FROM edges import_edge
                   WHERE import_edge.kind='IMPORTS'
                     AND import_edge.src_is_file=1
                     AND import_edge.dst_is_file=1
                     AND ((import_edge.src_id=left_symbol.file_id
                           AND import_edge.dst_id=right_symbol.file_id)
                       OR (import_edge.src_id=right_symbol.file_id
                           AND import_edge.dst_id=left_symbol.file_id))
                ) AS directly_imported
           FROM symbols left_symbol
           JOIN files left_file ON left_file.id=left_symbol.file_id
           JOIN symbols right_symbol
             ON right_symbol.id>left_symbol.id
            AND right_symbol.file_id<>left_symbol.file_id
            AND right_symbol.name=left_symbol.name
            AND right_symbol.kind=left_symbol.kind
            AND (left_symbol.arity IS NULL OR right_symbol.arity IS NULL
                 OR left_symbol.arity=right_symbol.arity)
           JOIN files right_file ON right_file.id=right_symbol.file_id
          WHERE left_symbol.name IS NOT NULL
            AND left_file.relative_path IS NOT NULL
            AND right_file.relative_path IS NOT NULL
            AND left_file.format IN ('c','cpp')
            AND right_file.format IN ('c','cpp')
            AND (?=1 OR left_symbol.file_id IN (SELECT value FROM json_each(?))
                     OR right_symbol.file_id IN (SELECT value FROM json_each(?)))`,
        rebuildAll ? 1 : 0,
        dirtyJson,
        dirtyJson,
      );
      const insert = this.database.prepare(
        `INSERT OR REPLACE INTO edges(
           id,src_id,dst_id,src_is_file,dst_is_file,kind,rel,count,first_line,
           ref_name,provenance,confidence,evidence
         ) VALUES(?,?,?,0,0,'COUNTERPART','counterpart',1,0,'counterpart',
                  'heuristic',?,?)`,
      );
      for (const candidate of candidates) {
        const match = counterpartMatch(candidate);
        if (!match) continue;
        insert.run(
          `counterpart:${candidate.left_id}:${candidate.right_id}`,
          candidate.left_id,
          candidate.right_id,
          match.confidence,
          match.evidence,
        );
      }
      this.database.clearCounterpartProjectionDirty();
    });
    this.database.acknowledgeCounterpartProjection(dirtyFiles);
  }
}

function counterpartMatch(
  candidate: CounterpartCandidate,
): CounterpartMatch | undefined {
  const [headerPath, sourcePath] = isHeaderPath(candidate.left_path)
    ? [candidate.left_path, candidate.right_path]
    : [candidate.right_path, candidate.left_path];
  if (!isHeaderPath(headerPath) || !isSourcePath(sourcePath)) return undefined;
  const sameIdentity =
    candidate.left_qualified_name !== null &&
    candidate.left_qualified_name === candidate.right_qualified_name;
  if (!sameIdentity) return undefined;
  if (!counterpartPathDomainsCompatible(headerPath, sourcePath))
    return undefined;
  if (sameIdentity && candidate.directly_imported === 1)
    return { confidence: 0.98, evidence: "direct_import" };
  if (fileStem(headerPath) !== fileStem(sourcePath)) return undefined;
  const pathRelated = counterpartPathsRelated(headerPath, sourcePath);
  if (!pathRelated) return undefined;
  return {
    confidence: 0.95,
    evidence: "declaration_definition",
  };
}
