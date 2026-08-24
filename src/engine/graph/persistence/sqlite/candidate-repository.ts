import type { SqliteGraphDatabase } from "./database.js";
import { CALLABLE_SYMBOL_KINDS_SQL } from "../../symbol-kinds.js";

export type SemanticCandidateQuery = {
  sourceId: string;
  sourceLanguage?: string;
  typeNames: readonly string[];
  memberName: string;
  callArity?: number;
  limit?: number;
  /** C++ inferred receiver types may be declared in include-root headers. */
  workspaceVisible?: boolean;
  /** Additional files in the same language-level visibility unit (Go package). */
  visibleFileIds?: readonly string[];
  /** False when the caller already supplied the complete import closure. */
  expandImports?: boolean;
  /** Precomputed visibility-aware abstract-root result for batch resolvers. */
  abstractRootHint?: boolean;
};

export type SemanticCandidate = {
  id: string;
  logicalKey: string;
  containerKind: string;
  abstractDispatch: boolean;
  rtaActive: boolean;
};

export type SemanticCandidateResolution = {
  candidates: string[];
  abstractDispatch: boolean;
  rtaActive: boolean;
};

export type CallableReturnCandidate = {
  id: string;
  fileId: string;
  returnType: string;
  containerName?: string;
};

/** Shared semantic-member lookup used by projection and read models. */
export class SemanticCandidateRepository {
  constructor(private readonly database: SqliteGraphDatabase) {}

  find(query: SemanticCandidateQuery): string[] {
    return uniqueLogicalCandidates(
      this.findDetailed(query),
      query.sourceLanguage,
    ).map((candidate) => candidate.id);
  }

  findConcrete(query: SemanticCandidateQuery): string[] {
    return this.resolve(query).candidates;
  }

  /**
   * Invocation-level callable return index. Resolution touches many distinct
   * factory names in large workspaces; one bounded table scan is substantially
   * cheaper than issuing one SQLite statement per unique receiver expression.
   */
  loadCallableReturns(): Map<string, CallableReturnCandidate[]> {
    const result = new Map<string, CallableReturnCandidate[]>();
    for (const row of this.database.all<{
      name: string;
      id: string;
      file_id: string;
      return_type: string;
      container_name: string | null;
    }>(
      `SELECT s.name,s.id,s.file_id,s.return_type,p.name AS container_name
       FROM symbols s
       LEFT JOIN contains c ON c.child_id=s.id
       LEFT JOIN symbols p ON p.id=c.parent_id
       WHERE s.name IS NOT NULL AND s.return_type IS NOT NULL
         AND s.kind IN (${CALLABLE_SYMBOL_KINDS_SQL})
       ORDER BY s.name,s.file_id,s.id`,
    )) {
      const candidates = result.get(row.name) ?? [];
      if (candidates.length < 100)
        candidates.push({
          id: row.id,
          fileId: row.file_id,
          returnType: row.return_type,
          ...(row.container_name ? { containerName: row.container_name } : {}),
        });
      result.set(row.name, candidates);
    }
    return result;
  }

  /** Concrete functions registered into the exact C/C++ `(type, field)` slot. */
  findFunctionPointerTargets(query: SemanticCandidateQuery): string[] {
    if (query.sourceLanguage !== "c" && query.sourceLanguage !== "cpp")
      return [];
    return this.database
      .all<{ id: string }>(
        `WITH RECURSIVE visible(file_id) AS (
           SELECT file_id FROM symbols WHERE id=?
           UNION SELECT value FROM json_each(?)
           UNION SELECT file_id FROM symbols WHERE ?=1
           UNION SELECT imports.dst_id FROM edges imports
           JOIN visible source_file ON source_file.file_id=imports.src_id
           WHERE imports.kind='IMPORTS'
             AND imports.src_is_file=1 AND imports.dst_is_file=1
             AND ?=1
         )
         SELECT DISTINCT registration.dst_id AS id
         FROM edges registration
         JOIN symbols owner ON owner.id=registration.src_id
         JOIN symbols target ON target.id=registration.dst_id
         WHERE registration.kind='REFS' AND registration.rel='function'
           AND registration.source_language IN ('c','cpp')
           AND owner.file_id IN (SELECT file_id FROM visible)
           AND target.kind IN (${CALLABLE_SYMBOL_KINDS_SQL})
           AND json_extract(registration.resolution_hints,
                            '$.functionPointerRegistration.field')=?
           AND json_extract(registration.resolution_hints,
                            '$.functionPointerRegistration.containerType')
               IN (SELECT value FROM json_each(?))
         ORDER BY target.qualified_name,target.name,target.file_id,target.id
         LIMIT ?`,
        query.sourceId,
        JSON.stringify(query.visibleFileIds ?? []),
        query.workspaceVisible ? 1 : 0,
        query.expandImports === false ? 0 : 1,
        query.memberName,
        JSON.stringify([...new Set(query.typeNames)]),
        query.limit ?? 300,
      )
      .map((row) => row.id);
  }

  resolve(query: SemanticCandidateQuery): SemanticCandidateResolution {
    const detailed = uniqueLogicalCandidates(
      this.findDetailed(query),
      query.sourceLanguage,
    );
    const abstractDispatch =
      detailed.some((candidate) => candidate.abstractDispatch) ||
      (detailed.length === 0 &&
        (query.abstractRootHint ?? this.hasVisibleAbstractRoot(query)));
    return {
      candidates: [
        ...new Set(
          detailed
            .filter(
              (candidate) => !isAbstractContainerKind(candidate.containerKind),
            )
            .map((candidate) => candidate.id),
        ),
      ],
      abstractDispatch,
      rtaActive: detailed.some((candidate) => candidate.rtaActive),
    };
  }

  private hasVisibleAbstractRoot(query: SemanticCandidateQuery): boolean {
    return (
      this.database.one<{ present: number }>(
        `WITH RECURSIVE visible(file_id) AS (
           SELECT file_id FROM symbols WHERE id=?
           UNION SELECT value FROM json_each(?)
           UNION SELECT file_id FROM symbols WHERE ?=1
           UNION SELECT imports.dst_id FROM edges imports
           JOIN visible source_file ON source_file.file_id=imports.src_id
           WHERE imports.kind='IMPORTS'
             AND imports.src_is_file=1 AND imports.dst_is_file=1
             AND ?=1
         )
         SELECT 1 AS present FROM symbols
         WHERE name IN (SELECT value FROM json_each(?))
           AND kind IN ('interface','trait','abstract_class')
           AND file_id IN (SELECT file_id FROM visible)
         LIMIT 1`,
        query.sourceId,
        JSON.stringify(query.visibleFileIds ?? []),
        query.workspaceVisible ? 1 : 0,
        query.expandImports === false ? 0 : 1,
        JSON.stringify([...new Set(query.typeNames)]),
      ) !== undefined
    );
  }

  private findDetailed(query: SemanticCandidateQuery): SemanticCandidate[] {
    const policy = candidatePolicy(query.sourceLanguage);
    return this.database
      .all<{
        id: string;
        logical_key: string;
        container_kind: string;
        abstract_dispatch: number;
        rta_active: number;
      }>(
        `WITH RECURSIVE visible(file_id) AS (
         SELECT file_id FROM symbols WHERE id=?
         UNION SELECT value FROM json_each(?)
         UNION SELECT file_id FROM symbols WHERE ?=1
         UNION SELECT imports.dst_id FROM edges imports
         JOIN visible source_file ON source_file.file_id=imports.src_id
         WHERE imports.kind='IMPORTS'
           AND imports.src_is_file=1 AND imports.dst_is_file=1
           AND ?=1
       ), roots(id,kind) AS (
         SELECT id,kind FROM symbols
         WHERE name IN (SELECT value FROM json_each(?))
           AND file_id IN (SELECT file_id FROM visible)
       ), required_interfaces(id) AS (
         SELECT id FROM roots WHERE kind IN (SELECT value FROM json_each(?))
         UNION
         SELECT inheritance.dst_id FROM edges inheritance
         JOIN required_interfaces required ON required.id=inheritance.src_id
         JOIN symbols inherited ON inherited.id=inheritance.dst_id
         WHERE inheritance.kind='INHERITS'
           AND inheritance.rel IN (SELECT value FROM json_each(?))
           AND inherited.kind IN (SELECT value FROM json_each(?))
       ), containers(id) AS (
         SELECT id FROM roots
         UNION
         SELECT e.src_id FROM edges e JOIN containers c ON c.id=e.dst_id
         WHERE e.kind='INHERITS'
           AND e.rel IN (SELECT value FROM json_each(?))
       ), provider_roots(id) AS (
         SELECT id FROM containers
         UNION
         SELECT id FROM symbols
         WHERE file_id IN (SELECT file_id FROM visible)
           AND kind IN ('class','interface','trait','abstract_class')
           AND ?=0
           AND EXISTS(
             SELECT 1 FROM roots
             WHERE kind IN (SELECT value FROM json_each(?))
           )
       ), provider_closure(container_id,provider_id,depth,path) AS (
         SELECT id,id,0,',' || id || ',' FROM provider_roots
         UNION ALL
         SELECT provider.container_id,inheritance.dst_id,provider.depth+1,
                provider.path || inheritance.dst_id || ','
         FROM provider_closure provider
         JOIN edges inheritance ON inheritance.src_id=provider.provider_id
         WHERE inheritance.kind='INHERITS'
           AND inheritance.rel IN (SELECT value FROM json_each(?))
           AND provider.depth<32
           AND instr(provider.path,',' || inheritance.dst_id || ',')=0
       ), candidate_containers(id) AS (
         SELECT id FROM containers
         UNION
         SELECT DISTINCT candidate.id
         FROM symbols candidate
         WHERE candidate.file_id IN (SELECT file_id FROM visible)
           AND candidate.kind NOT IN ('interface','trait')
           AND EXISTS(
             SELECT 1 FROM roots
             WHERE kind IN (SELECT value FROM json_each(?))
           )
           AND NOT EXISTS(
             SELECT 1 FROM required_interfaces required_interface
             JOIN contains required_owned
               ON required_owned.parent_id=required_interface.id
             JOIN symbols required ON required.id=required_owned.child_id
             WHERE NOT EXISTS(
                 SELECT 1 FROM provider_closure provider
                 JOIN contains provided_owned
                   ON provided_owned.parent_id=provider.provider_id
                 JOIN symbols provided ON provided.id=provided_owned.child_id
                 WHERE provider.container_id=candidate.id
                   AND provided.name=required.name
                   AND (required.arity IS NULL OR provided.arity IS NULL
                        OR provided.arity=required.arity)
               )
           )
       ), provider_members(id,container_id,container_kind,depth,member_kind) AS (
         SELECT DISTINCT member.id,scope.id,scope_symbol.kind,provider.depth,member.kind
         FROM candidate_containers scope
         JOIN symbols scope_symbol ON scope_symbol.id=scope.id
         JOIN provider_closure provider ON provider.container_id=scope.id
         JOIN contains owned ON owned.parent_id=provider.provider_id
         JOIN symbols member ON member.id=owned.child_id
         WHERE member.name=?
           AND member.kind IN (${CALLABLE_SYMBOL_KINDS_SQL})
           AND (?<0 OR member.arity IS NULL OR member.arity=?)
         UNION
         SELECT DISTINCT member.id,scope.id,scope_symbol.kind,provider.depth,member.kind
         FROM candidate_containers scope
         JOIN symbols scope_symbol ON scope_symbol.id=scope.id
         JOIN provider_closure provider ON provider.container_id=scope.id
         JOIN symbols provider_symbol ON provider_symbol.id=provider.provider_id
         JOIN symbols member
           ON member.qualified_name=provider_symbol.qualified_name || '::' || ?
          AND member.kind IN (${CALLABLE_SYMBOL_KINDS_SQL})
         WHERE (?<0 OR member.arity IS NULL OR member.arity=?)
       ), nearest_depths(container_id,depth) AS (
         SELECT container_id,MIN(depth)
         FROM provider_members
         GROUP BY container_id
       ), candidate_members(id,container_id,container_kind) AS (
         SELECT member.id,member.container_id,member.container_kind
         FROM provider_members member
         JOIN nearest_depths nearest
           ON nearest.container_id=member.container_id
          AND nearest.depth=member.depth
         WHERE member.member_kind<>'abstract_method'
       ), instantiated_containers(id) AS (
         SELECT DISTINCT made.dst_id
         FROM edges made
         JOIN candidate_members candidate ON candidate.container_id=made.dst_id
         WHERE made.kind='INSTANTIATES' AND made.dst_is_file=0
       ), rta_state(active) AS (
         SELECT EXISTS(SELECT 1 FROM instantiated_containers)
       ), resolved_candidates AS (
       SELECT candidate.id,candidate.container_kind,
         CASE WHEN owner.id IS NOT NULL
              THEN COALESCE(owner.qualified_name,owner.name)
                   || '::' || member.name
              ELSE COALESCE(member.qualified_name,member.name,candidate.id)
         END AS logical_key,
         EXISTS(SELECT 1 FROM roots
           WHERE kind IN ('interface','trait','abstract_class'))
           AS abstract_dispatch,
         rta.active AS rta_active
       FROM candidate_members candidate
       CROSS JOIN rta_state rta
       JOIN symbols member ON member.id=candidate.id
       LEFT JOIN contains ownership ON ownership.child_id=member.id
       LEFT JOIN symbols owner ON owner.id=ownership.parent_id
       WHERE rta.active=0 OR candidate.container_id IN (
         SELECT id FROM instantiated_containers
       )
       )
       SELECT MIN(id) AS id,logical_key,
              MIN(container_kind) AS container_kind,
              MAX(abstract_dispatch) AS abstract_dispatch,
              MAX(rta_active) AS rta_active
       FROM resolved_candidates
       GROUP BY logical_key
       ORDER BY logical_key
       LIMIT ?`,
        query.sourceId,
        JSON.stringify(query.visibleFileIds ?? []),
        query.workspaceVisible ? 1 : 0,
        query.expandImports === false ? 0 : 1,
        JSON.stringify([...new Set(query.typeNames)]),
        JSON.stringify(policy.structuralRootKinds),
        JSON.stringify(policy.inheritanceRelations),
        JSON.stringify(policy.structuralRootKinds),
        JSON.stringify(policy.inheritanceRelations),
        query.workspaceVisible ? 1 : 0,
        JSON.stringify(policy.structuralRootKinds),
        JSON.stringify(policy.providerRelations),
        JSON.stringify(policy.structuralRootKinds),
        query.memberName,
        query.callArity ?? -1,
        query.callArity ?? -1,
        query.memberName,
        query.callArity ?? -1,
        query.callArity ?? -1,
        query.limit ?? 64,
      )
      .map((row) => ({
        id: row.id,
        logicalKey: row.logical_key,
        containerKind: row.container_kind,
        abstractDispatch: row.abstract_dispatch === 1,
        rtaActive: row.rta_active === 1,
      }));
  }
}

function uniqueLogicalCandidates(
  candidates: readonly SemanticCandidate[],
  language?: string,
): SemanticCandidate[] {
  const unique = new Map<string, SemanticCandidate>();
  for (const candidate of candidates) {
    const logicalKey = canonicalLogicalKey(candidate.logicalKey, language);
    const existing = unique.get(logicalKey);
    if (!existing) {
      unique.set(logicalKey, candidate);
      continue;
    }
    existing.abstractDispatch ||= candidate.abstractDispatch;
    existing.rtaActive ||= candidate.rtaActive;
    // C++ out-of-line definitions can be owned by a synthetic duplicated
    // container (`Thing::Thing::Open`). Prefer that body-bearing definition
    // over its header declaration after both collapse to the same logical key.
    if (
      language === "cpp" &&
      candidate.logicalKey !== logicalKey &&
      existing.logicalKey === logicalKey
    ) {
      unique.set(logicalKey, {
        ...candidate,
        abstractDispatch: existing.abstractDispatch,
        rtaActive: existing.rtaActive,
      });
    }
  }
  return [...unique.values()];
}

function canonicalLogicalKey(key: string, language?: string): string {
  if (language !== "cpp") return key;
  const parts = key.split("::");
  return parts
    .filter((part, index) => index === 0 || part !== parts[index - 1])
    .join("::");
}

function isAbstractContainerKind(kind: string): boolean {
  return kind === "interface" || kind === "trait" || kind === "abstract_class";
}

function candidatePolicy(language?: string): {
  inheritanceRelations: readonly string[];
  structuralRootKinds: readonly string[];
  providerRelations: readonly string[];
} {
  if (language === "go")
    return {
      inheritanceRelations: ["implements", "extends"],
      structuralRootKinds: ["interface"],
      providerRelations: ["extends"],
    };
  if (language === "rust")
    return {
      inheritanceRelations: ["trait", "implements"],
      structuralRootKinds: [],
      providerRelations: [],
    };
  if (language === "java")
    return {
      inheritanceRelations: ["extends", "implements"],
      structuralRootKinds: [],
      providerRelations: ["extends"],
    };
  return {
    inheritanceRelations: ["extends", "implements", "trait"],
    structuralRootKinds: [],
    providerRelations: ["extends"],
  };
}
