import type { SqliteGraphDatabase } from "./database.js";

export type SemanticCandidateQuery = {
  sourceId: string;
  sourceLanguage?: string;
  typeNames: readonly string[];
  memberName: string;
  callArity?: number;
  limit?: number;
};

/** Shared semantic-member lookup used by projection and read models. */
export class SemanticCandidateRepository {
  constructor(private readonly database: SqliteGraphDatabase) {}

  find(query: SemanticCandidateQuery): string[] {
    const policy = candidatePolicy(query.sourceLanguage);
    return this.database.all<{ id: string }>(
      `WITH RECURSIVE visible(file_id) AS (
         SELECT file_id FROM symbols WHERE id=?
         UNION SELECT imports.dst_file_id FROM file_imports imports
         JOIN symbols source ON source.file_id=imports.src_file_id WHERE source.id=?
       ), roots(id,kind) AS (
         SELECT id,kind FROM symbols
         WHERE name IN (SELECT value FROM json_each(?))
           AND file_id IN (SELECT file_id FROM visible)
       ), containers(id) AS (
         SELECT id FROM roots
         UNION
         SELECT e.src_id FROM symbol_edges e JOIN containers c ON c.id=e.dst_id
         WHERE e.kind='INHERITS'
           AND e.rel IN (SELECT value FROM json_each(?))
       ), candidate_containers(id) AS (
         SELECT id FROM containers
         UNION
         SELECT DISTINCT owned.parent_id
         FROM contains owned JOIN symbols member ON member.id=owned.child_id
         WHERE member.name=?
           AND EXISTS(
             SELECT 1 FROM roots
             WHERE kind IN (SELECT value FROM json_each(?))
           )
           AND member.file_id IN (SELECT file_id FROM visible)
       ), candidate_members(id,container_id) AS (
         SELECT DISTINCT member.id,scope.id
         FROM candidate_containers scope
         JOIN contains owned ON owned.parent_id=scope.id
         JOIN symbols member ON member.id=owned.child_id
         WHERE member.name=? AND (?<0 OR member.arity IS NULL OR member.arity=?)
       )
       SELECT id FROM candidate_members
       WHERE NOT EXISTS(
         SELECT 1 FROM candidate_members candidate
         JOIN instantiates made ON made.type_id=candidate.container_id
       ) OR container_id IN (SELECT type_id FROM instantiates)
       ORDER BY id LIMIT ?`,
      query.sourceId,
      query.sourceId,
      JSON.stringify([...new Set(query.typeNames)]),
      JSON.stringify(policy.inheritanceRelations),
      query.memberName,
      JSON.stringify(policy.structuralRootKinds),
      query.memberName,
      query.callArity ?? -1,
      query.callArity ?? -1,
      query.limit ?? 64,
    ).map((row) => row.id);
  }
}

function candidatePolicy(language?: string): {
  inheritanceRelations: readonly string[];
  structuralRootKinds: readonly string[];
} {
  if (language === "go")
    return { inheritanceRelations: ["implements"], structuralRootKinds: ["interface"] };
  if (language === "rust")
    return {
      inheritanceRelations: ["trait", "implements"],
      structuralRootKinds: ["trait", "interface"],
    };
  if (language === "java")
    return {
      inheritanceRelations: ["extends", "implements"],
      structuralRootKinds: ["interface"],
    };
  return {
    inheritanceRelations: ["extends", "implements", "trait"],
    structuralRootKinds: [],
  };
}
