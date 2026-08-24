import { makeRefId } from "../../ref-id.js";
import type { LocalEdge, RawRef, SymNode } from "../../types.js";
import type { SqliteGraphDatabase } from "./database.js";
import { FUNCTION_POINTER_ARRAY_CONTAINER } from "../../../reference-target.js";
import type { FileInfo } from "../../../types.js";

type StoredEdgeFact = {
  id: string;
  src_id: string;
  kind: string;
  rel: string;
  first_line: number;
  ref_name: string;
  source_language: string | null;
  imported_name: string | null;
  local_name: string | null;
  receiver_kind: string | null;
  receiver_name: string | null;
  member_name: string | null;
  resolution_hints: string | null;
};

type InstantiationChanges = {
  symbolIds: string[];
  unresolvedNames: string[];
};

type DispatchDependencyTypes = {
  symbolIds: string[];
  names: string[];
};

type FunctionPointerRegistrationKey = {
  containerType: string;
  field: string;
};

/** File-scoped graph mutations and resolved-edge invalidation. */
export class SqliteGraphWriter {
  constructor(private readonly database: SqliteGraphDatabase) {}

  private get db() {
    return this.database.db;
  }
  private get readOnly(): boolean {
    return this.database.readOnly;
  }
  private all<T>(sql: string, ...params: Array<string | number>): T[] {
    return this.database.all<T>(sql, ...params);
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
    const oldIds = this.database.isBulkLoad()
      ? []
      : this.symbolIdsForFile(fileId);
    const oldNames = this.database.isBulkLoad()
      ? []
      : this.symbolNamesForFile(fileId);
    const affected =
      !this.database.isBulkLoad() && this.database.hasResolvedProjections()
        ? this.affectedProjectionIds(fileId, oldNames, nodes, edges, refs)
        : [];
    this.database.transaction(() => {
      if (!this.database.isBulkLoad()) {
        this.restoreEdgesToUnresolved(affected);
        this.deleteOwnedFacts(fileId, oldIds);
      }
      this.database
        .prepare(
          `INSERT INTO files(
             id,absolute_path,relative_path,root_path,size_bytes,
             last_modified_time,kind,format
           ) VALUES(?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             absolute_path=excluded.absolute_path,
             relative_path=excluded.relative_path,
             root_path=excluded.root_path,
             size_bytes=excluded.size_bytes,
             last_modified_time=excluded.last_modified_time,
             kind=excluded.kind,
             format=excluded.format`,
        )
        .run(
          fileId,
          file?.absolutePath ?? null,
          file?.relativePath ?? null,
          file?.rootPath ?? null,
          file?.sizeBytes ?? null,
          file?.lastModifiedTime ?? null,
          file?.kind ?? null,
          file?.format ?? null,
        );
      if (!this.database.isBulkLoad()) {
        this.database
          .prepare("DELETE FROM symbols WHERE file_id=?")
          .run(fileId);
      }
      const insert = this.database.prepare(
        `INSERT INTO symbols(
           id,file_id,name,qualified_name,kind,is_exported,signature,arity,
           return_type,range_json,scope,node_type,modifiers_json
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      for (const node of nodes) {
        insert.run(
          node.id,
          fileId,
          node.name ?? null,
          node.qualifiedName ?? node.name ?? null,
          node.kind,
          node.is_exported ? 1 : 0,
          node.signature ?? null,
          node.arity ?? null,
          node.returnType ?? null,
          node.range ? JSON.stringify(node.range) : null,
          node.scope ?? null,
          node.nodeType ?? null,
          node.modifiers ? JSON.stringify(node.modifiers) : null,
        );
      }
      for (const edge of edges) this.insertLocalEdge(edge);
      for (const ref of refs) this.insertRef(ref, fileId);
    });
  }

  private affectedProjectionIds(
    fileId: string,
    oldNames: readonly string[],
    nodes: readonly SymNode[],
    edges: readonly LocalEdge[],
    refs: readonly RawRef[],
  ): string[] {
    const changedInstantiationTypes = this.changedInstantiationTypes(
      fileId,
      nodes,
      edges,
      refs,
    );
    const affectedDispatchTypes = this.inheritanceDependencyTypes(
      changedInstantiationTypes,
    );
    const affected = this.affectedResolvedEdgeIds(fileId, [
      ...oldNames,
      ...this.changedSemanticNames(nodes, edges, refs),
    ]);
    affected.push(
      ...this.affectedFunctionPointerProjectionIds(
        [
          ...this.functionPointerRegistrationKeysForFile(fileId),
          ...this.functionPointerRegistrationKeysForRefs(refs),
        ],
        fileId,
      ),
    );
    affected.push(
      ...this.affectedInstantiationProjectionIds(affectedDispatchTypes),
    );
    return affected;
  }

  deleteFileGraph(fileId: string): void {
    this.database.assertWritable();
    const oldIds = this.symbolIdsForFile(fileId);
    const changedInstantiationTypes = this.changedInstantiationTypes(
      fileId,
      [],
      [],
      [],
    );
    const affectedDispatchTypes = this.inheritanceDependencyTypes(
      changedInstantiationTypes,
    );
    const affected = this.affectedResolvedEdgeIds(
      fileId,
      this.symbolNamesForFile(fileId),
    );
    affected.push(
      ...this.affectedFunctionPointerProjectionIds(
        this.functionPointerRegistrationKeysForFile(fileId),
        fileId,
      ),
    );
    affected.push(
      ...this.affectedInstantiationProjectionIds(affectedDispatchTypes),
    );
    this.database.transaction(() => {
      this.restoreEdgesToUnresolved(affected);
      this.deleteOwnedFacts(fileId, oldIds);
      this.database.prepare("DELETE FROM files WHERE id=?").run(fileId);
    });
  }

  protected insertRef(ref: RawRef, fallbackOwner: string): void {
    this.database
      .prepare(
        `INSERT OR REPLACE INTO unresolved_refs(
         id,owner_id,owner_is_file,ref_name,ref_kind,member_name,line,
         source_language,imported_name,local_name,receiver_kind,receiver_name,
         resolution_hints,status,last_attempt,dynamic_reason
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',0,NULL)`,
      )
      .run(
        ref.id,
        ref.owner || fallbackOwner,
        ref.type === "symbol" ? 0 : 1,
        ref.ref_name,
        ref.ref_kind,
        ref.type === "symbol" ? ref.target.member : null,
        ref.line,
        ref.source_language ?? null,
        ref.type === "import_binding" ? ref.imported_name : null,
        ref.type === "import_binding" ? ref.local_name : null,
        ref.type === "symbol" ? (ref.target.receiver?.kind ?? null) : null,
        ref.type === "symbol" ? (ref.target.receiver?.name ?? null) : null,
        ref.type === "symbol" && ref.target.hints
          ? JSON.stringify(ref.target.hints)
          : ref.type !== "symbol" && ref.rust_inline_module_depth
            ? JSON.stringify({
                rustInlineModuleDepth: ref.rust_inline_module_depth,
              })
            : null,
      );
  }

  private insertLocalEdge(edge: LocalEdge): void {
    if (edge.kind === "CONTAINS") {
      this.database
        .prepare(
          "INSERT OR REPLACE INTO contains(parent_id,child_id) VALUES(?,?)",
        )
        .run(edge.src, edge.dst);
      return;
    }
    const sourceEdgeId =
      edge.id ??
      `local:${makeRefId(
        edge.src,
        edge.ref_name,
        edge.kind === "INSTANTIATES" ? "new" : edge.rel,
        edge.first_line,
      )}`;
    this.database
      .prepare(
        `INSERT OR REPLACE INTO edges(
         id,src_id,dst_id,src_is_file,dst_is_file,kind,rel,count,first_line,
         ref_name,source_language,receiver_kind,receiver_name,member_name,
         resolution_hints,provenance,confidence,evidence
       ) VALUES(?,?,?,0,0,?,?,?,?,?,?,?,?,?,?,'static',1,NULL)`,
      )
      .run(
        edge.id ??
          (edge.kind === "INSTANTIATES"
            ? `${sourceEdgeId}:instantiates`
            : sourceEdgeId),
        edge.src,
        edge.dst,
        edge.kind,
        edge.rel,
        edge.count,
        edge.first_line,
        edge.ref_name,
        edge.source_language ?? null,
        edge.target?.receiver?.kind ?? null,
        edge.target?.receiver?.name ?? null,
        edge.target?.member ?? null,
        edge.target?.hints ? JSON.stringify(edge.target.hints) : null,
      );
  }

  private affectedResolvedEdgeIds(
    fileId: string,
    changedNames: readonly string[],
  ): string[] {
    const names = JSON.stringify([...new Set(changedNames)]);
    return this.all<{ id: string }>(
      `WITH RECURSIVE affected_importers(file_id) AS (
         SELECT ?
         UNION
         SELECT imported_file.src_id FROM edges imported_file
         JOIN affected_importers imported
           ON imported.file_id=imported_file.dst_id
         WHERE imported_file.kind='IMPORTS'
           AND imported_file.src_is_file=1
           AND imported_file.dst_is_file=1
       )
       SELECT DISTINCT edge.id FROM edges edge
       LEFT JOIN symbols source ON source.id=edge.src_id AND edge.src_is_file=0
       LEFT JOIN symbols target ON target.id=edge.dst_id AND edge.dst_is_file=0
       WHERE edge.kind<>'INSTANTIATES' AND (
         (target.file_id=? AND (source.file_id IS NULL OR source.file_id<>?))
         OR (edge.dst_is_file=1 AND edge.dst_id=? AND edge.src_id<>?)
         OR ((source.file_id IS NULL OR source.file_id<>?)
           AND ?<>'[]' AND (
           (edge.evidence='workspace_unique' AND (
             edge.member_name IN (SELECT value FROM json_each(?))
             OR edge.ref_name IN (SELECT value FROM json_each(?))
           ))
           OR (edge.evidence='preferred_file' AND (
             edge.member_name IN (SELECT value FROM json_each(?))
             OR edge.ref_name IN (SELECT value FROM json_each(?))
           ) AND source.file_id IN (SELECT file_id FROM affected_importers))
           OR json_extract(edge.resolution_hints,'$.receiverType')
                IN (SELECT value FROM json_each(?))
           OR EXISTS(
             SELECT 1 FROM json_each(COALESCE(
               json_extract(edge.resolution_hints,'$.candidateTypes'),'[]'
             )) candidate_type
             WHERE candidate_type.value IN (SELECT value FROM json_each(?))
           )
           )
         )
       )
       UNION
       SELECT DISTINCT unresolved.id FROM unresolved_refs unresolved
       LEFT JOIN edge_candidates candidate ON candidate.edge_id=unresolved.id
       LEFT JOIN symbols target ON target.id=candidate.target_id
       LEFT JOIN symbols unresolved_source
         ON unresolved_source.id=unresolved.owner_id AND unresolved.owner_is_file=0
       LEFT JOIN contains ownership ON ownership.child_id=candidate.target_id
       LEFT JOIN symbols container ON container.id=ownership.parent_id
       WHERE target.file_id=? OR (?<>'[]' AND (
         container.name IN (SELECT value FROM json_each(?))
         OR ((unresolved.member_name IN (SELECT value FROM json_each(?))
              OR unresolved.ref_name IN (SELECT value FROM json_each(?)))
             AND unresolved_source.file_id IN (
               SELECT file_id FROM affected_importers
             ))
         OR json_extract(unresolved.resolution_hints,'$.receiverType')
              IN (SELECT value FROM json_each(?))
         OR EXISTS(
           SELECT 1 FROM json_each(COALESCE(
             json_extract(unresolved.resolution_hints,'$.candidateTypes'),'[]'
           )) candidate_type
           WHERE candidate_type.value IN (SELECT value FROM json_each(?))
         )
       ))`,
      fileId,
      fileId,
      fileId,
      fileId,
      fileId,
      fileId,
      names,
      names,
      names,
      names,
      names,
      names,
      names,
      fileId,
      names,
      names,
      names,
      names,
      names,
      names,
    ).map((row) => row.id);
  }

  /**
   * Return dispatch projections whose result depends on whether one of the
   * supplied concrete types is instantiated anywhere in the workspace.
   */
  private affectedInstantiationProjectionIds(
    types: DispatchDependencyTypes,
  ): string[] {
    if (types.symbolIds.length === 0 && types.names.length === 0) return [];
    const ids = JSON.stringify([...new Set(types.symbolIds)]);
    const names = JSON.stringify([...new Set(types.names)]);
    return this.all<{ id: string }>(
      `SELECT DISTINCT edge.id FROM edges edge
       LEFT JOIN contains ownership ON ownership.child_id=edge.dst_id
       LEFT JOIN symbols container ON container.id=ownership.parent_id
       WHERE edge.kind='CALLS' AND edge.provenance='heuristic' AND (
         container.id IN (SELECT value FROM json_each(?))
         OR container.name IN (SELECT value FROM json_each(?))
         OR json_extract(edge.resolution_hints,'$.receiverType')
              IN (SELECT value FROM json_each(?))
         OR EXISTS(
           SELECT 1 FROM json_each(COALESCE(
             json_extract(edge.resolution_hints,'$.candidateTypes'),'[]'
           )) candidate_type
           WHERE candidate_type.value IN (SELECT value FROM json_each(?))
         )
       )
       UNION
       SELECT DISTINCT unresolved.id FROM unresolved_refs unresolved
       LEFT JOIN edge_candidates candidate ON candidate.edge_id=unresolved.id
       LEFT JOIN contains ownership ON ownership.child_id=candidate.target_id
       LEFT JOIN symbols container ON container.id=ownership.parent_id
       WHERE unresolved.status='dynamic' AND (
         container.id IN (SELECT value FROM json_each(?))
         OR container.name IN (SELECT value FROM json_each(?))
         OR json_extract(unresolved.resolution_hints,'$.receiverType')
              IN (SELECT value FROM json_each(?))
         OR EXISTS(
           SELECT 1 FROM json_each(COALESCE(
             json_extract(unresolved.resolution_hints,'$.candidateTypes'),'[]'
           )) candidate_type
           WHERE candidate_type.value IN (SELECT value FROM json_each(?))
         )
       )`,
      ids,
      names,
      names,
      names,
      ids,
      names,
      names,
      names,
    ).map((row) => row.id);
  }

  /**
   * Function-pointer dispatch depends on an exact `(container type, field)`
   * registration slot. Requeue only projections for slots whose registration
   * facts were replaced; changing an unrelated handler or field must not fan
   * out to every indirect call in the workspace.
   */
  private affectedFunctionPointerProjectionIds(
    keys: readonly FunctionPointerRegistrationKey[],
    changedFileId: string,
  ): string[] {
    const unique = [
      ...new Map(
        keys.map((key) => [`${key.containerType}\0${key.field}`, key]),
      ).values(),
    ];
    if (unique.length === 0) return [];
    const encoded = JSON.stringify(unique);
    return this.all<{ id: string }>(
      `WITH changed AS (
         SELECT json_extract(value,'$.containerType') AS container_type,
                json_extract(value,'$.field') AS field
         FROM json_each(?)
       ), projections AS (
         SELECT id,owner_id,member_name,receiver_name,resolution_hints
         FROM unresolved_refs
         WHERE status='dynamic'
         UNION ALL
         SELECT id,src_id,member_name,receiver_name,resolution_hints FROM edges
         WHERE kind='CALLS' AND provenance='heuristic'
       )
       SELECT DISTINCT projection.id
       FROM projections projection
       JOIN symbols owner ON owner.id=projection.owner_id
       JOIN changed slot ON (
         (slot.container_type='${FUNCTION_POINTER_ARRAY_CONTAINER}'
          AND projection.receiver_name=slot.field
          AND owner.file_id=?)
         OR slot.field=projection.member_name
       )
       WHERE (slot.container_type='${FUNCTION_POINTER_ARRAY_CONTAINER}'
              AND projection.receiver_name=slot.field)
          OR json_extract(projection.resolution_hints,'$.receiverType')
               =slot.container_type
          OR EXISTS(
            SELECT 1 FROM json_each(COALESCE(
              json_extract(projection.resolution_hints,'$.candidateTypes'),'[]'
            )) candidate_type
            WHERE candidate_type.value=slot.container_type
          )`,
      encoded,
      changedFileId,
    ).map((row) => row.id);
  }

  private functionPointerRegistrationKeysForFile(
    fileId: string,
  ): FunctionPointerRegistrationKey[] {
    return this.all<FunctionPointerRegistrationKey>(
      `SELECT DISTINCT
         json_extract(edge.resolution_hints,
                      '$.functionPointerRegistration.containerType')
           AS containerType,
         json_extract(edge.resolution_hints,
                      '$.functionPointerRegistration.field') AS field
       FROM edges edge
       JOIN symbols source ON source.id=edge.src_id AND edge.src_is_file=0
       WHERE source.file_id=?
         AND json_type(edge.resolution_hints,
                       '$.functionPointerRegistration')='object'`,
      fileId,
    );
  }

  private functionPointerRegistrationKeysForRefs(
    refs: readonly RawRef[],
  ): FunctionPointerRegistrationKey[] {
    return refs.flatMap((ref) => {
      if (ref.type !== "symbol") return [];
      const registration = ref.target.hints?.functionPointerRegistration;
      return registration ? [registration] : [];
    });
  }

  /** Include every nominal base/interface whose dispatch can depend on RTA. */
  private inheritanceDependencyTypes(
    changes: InstantiationChanges,
  ): DispatchDependencyTypes {
    if (changes.symbolIds.length === 0 && changes.unresolvedNames.length === 0)
      return { symbolIds: [], names: [] };
    const rows = this.all<{ id: string; name: string }>(
      `WITH RECURSIVE hierarchy(id,name) AS (
         SELECT id,name FROM symbols
         WHERE id IN (SELECT value FROM json_each(?))
            OR name IN (SELECT value FROM json_each(?))
         UNION
         SELECT parent.id,parent.name
         FROM hierarchy child
         JOIN edges relation ON relation.src_id=child.id
           AND relation.src_is_file=0 AND relation.dst_is_file=0
           AND relation.kind='INHERITS'
         JOIN symbols parent ON parent.id=relation.dst_id
       )
       SELECT DISTINCT id,name FROM hierarchy WHERE name IS NOT NULL`,
      JSON.stringify([...new Set(changes.symbolIds)]),
      JSON.stringify([...new Set(changes.unresolvedNames)]),
    );
    return {
      symbolIds: rows.map((row) => row.id),
      names: [
        ...new Set([
          ...rows.map((row) => row.name),
          ...changes.unresolvedNames,
        ]),
      ],
    };
  }

  /**
   * Compare the global boolean presence of instantiated types before and
   * after replacing one file. Multiple makers of the same type collapse to
   * one fact, so removing one maker does not invalidate stable projections.
   */
  private changedInstantiationTypes(
    fileId: string,
    nodes: readonly SymNode[],
    edges: readonly LocalEdge[],
    refs: readonly RawRef[],
  ): InstantiationChanges {
    const oldTypeIds = new Set(this.instantiationTypeIdsForFile(fileId));
    const nodeNames = new Map(nodes.map((node) => [node.id, node.name]));
    const newTypeIds = new Set<string>();
    const newTypeNames = new Set<string>();
    for (const edge of edges) {
      if (edge.kind !== "INSTANTIATES") continue;
      newTypeIds.add(edge.dst);
      const name = nodeNames.get(edge.dst);
      if (name) newTypeNames.add(name);
    }
    for (const ref of refs) {
      if (ref.type !== "symbol" || ref.ref_kind !== "new") continue;
      if (ref.target.member) newTypeNames.add(ref.target.member);
      if (ref.ref_name) newTypeNames.add(ref.ref_name);
    }
    const namedCandidates =
      newTypeNames.size === 0
        ? []
        : this.all<{ id: string }>(
            `SELECT id FROM symbols
       WHERE name IN (SELECT value FROM json_each(?))`,
            JSON.stringify([...newTypeNames]),
          ).map((row) => row.id);
    for (const id of namedCandidates) newTypeIds.add(id);
    const relevantIds = [...new Set([...oldTypeIds, ...newTypeIds])];
    if (relevantIds.length === 0)
      return { symbolIds: [], unresolvedNames: [...newTypeNames] };
    const otherTypeIds = new Set(
      this.all<{ id: string }>(
        `SELECT DISTINCT target.id FROM edges edge
       JOIN symbols source ON source.id=edge.src_id AND edge.src_is_file=0
       JOIN symbols target ON target.id=edge.dst_id AND edge.dst_is_file=0
       WHERE edge.kind='INSTANTIATES' AND source.file_id<>?
         AND target.id IN (SELECT value FROM json_each(?))`,
        fileId,
        JSON.stringify(relevantIds),
      ).map((row) => row.id),
    );
    const changedIds = relevantIds.filter(
      (id) =>
        (otherTypeIds.has(id) || oldTypeIds.has(id)) !==
        (otherTypeIds.has(id) || newTypeIds.has(id)),
    );
    const resolvedNames = new Set(
      this.all<{ name: string }>(
        `SELECT DISTINCT name FROM symbols
       WHERE id IN (SELECT value FROM json_each(?)) AND name IS NOT NULL`,
        JSON.stringify([...newTypeIds]),
      ).map((row) => row.name),
    );
    return {
      symbolIds: changedIds,
      unresolvedNames: [...newTypeNames].filter(
        (name) => !resolvedNames.has(name),
      ),
    };
  }

  private instantiationTypeIdsForFile(fileId: string): string[] {
    return this.all<{ id: string }>(
      `SELECT DISTINCT target.id FROM edges edge
       JOIN symbols source ON source.id=edge.src_id AND edge.src_is_file=0
       JOIN symbols target ON target.id=edge.dst_id AND edge.dst_is_file=0
       WHERE edge.kind='INSTANTIATES' AND source.file_id=?`,
      fileId,
    ).map((row) => row.id);
  }

  private restoreEdgesToUnresolved(edgeIds: readonly string[]): void {
    if (edgeIds.length === 0) return;
    const ids = JSON.stringify([...new Set(edgeIds)]);
    const facts = this.all<StoredEdgeFact>(
      `SELECT id,src_id,kind,rel,first_line,ref_name,source_language,
              imported_name,local_name,receiver_kind,receiver_name,member_name,
              resolution_hints
       FROM edges WHERE id IN(SELECT value FROM json_each(?))`,
      ids,
    );
    const insert = this.database.prepare(
      `INSERT OR REPLACE INTO unresolved_refs(
         id,owner_id,owner_is_file,ref_name,ref_kind,member_name,line,
         source_language,imported_name,local_name,receiver_kind,receiver_name,
         resolution_hints,status,last_attempt,dynamic_reason
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',0,NULL)`,
    );
    for (const fact of facts) {
      insert.run(
        fact.id,
        fact.src_id,
        fact.kind === "IMPORTS" ? 1 : 0,
        fact.ref_name,
        fact.rel,
        fact.member_name,
        fact.first_line,
        fact.source_language,
        fact.imported_name,
        fact.local_name,
        fact.receiver_kind,
        fact.receiver_name,
        fact.resolution_hints,
      );
      this.database
        .prepare("DELETE FROM edges WHERE id IN (?,?)")
        .run(fact.id, `${fact.id}:instantiates`);
    }
    this.database
      .prepare(
        `UPDATE unresolved_refs SET status='pending',last_attempt=0,dynamic_reason=NULL
       WHERE id IN(SELECT value FROM json_each(?))`,
      )
      .run(ids);
    this.database
      .prepare(
        "DELETE FROM edge_candidates WHERE edge_id IN(SELECT value FROM json_each(?))",
      )
      .run(ids);
  }

  private deleteOwnedFacts(fileId: string, symbolIds: readonly string[]): void {
    this.database
      .prepare(
        "DELETE FROM unresolved_refs WHERE owner_is_file=1 AND owner_id=?",
      )
      .run(fileId);
    this.database
      .prepare("DELETE FROM edges WHERE src_is_file=1 AND src_id=?")
      .run(fileId);
    if (symbolIds.length === 0) return;
    const ids = JSON.stringify(symbolIds);
    this.database
      .prepare(
        "DELETE FROM unresolved_refs WHERE owner_is_file=0 AND owner_id IN(SELECT value FROM json_each(?))",
      )
      .run(ids);
    this.database
      .prepare(
        "DELETE FROM edges WHERE src_is_file=0 AND src_id IN(SELECT value FROM json_each(?))",
      )
      .run(ids);
  }

  private changedSemanticNames(
    nodes: readonly SymNode[],
    edges: readonly LocalEdge[],
    refs: readonly RawRef[],
  ): string[] {
    return [
      ...new Set([
        ...nodes.flatMap((node) => (node.name ? [node.name] : [])),
        ...edges.flatMap((edge) =>
          edge.kind === "INHERITS" ? [edge.ref_name] : [],
        ),
        ...refs.flatMap((ref) =>
          ref.type === "symbol" &&
          ["extends", "implements", "overrides", "type"].includes(ref.ref_kind)
            ? [ref.ref_name, ref.target.member]
            : [],
        ),
      ]),
    ];
  }

  private symbolIdsForFile(fileId: string): string[] {
    return this.all<{ id: string }>(
      "SELECT id FROM symbols WHERE file_id=?",
      fileId,
    ).map((row) => row.id);
  }

  private symbolNamesForFile(fileId: string): string[] {
    return this.all<{ name: string }>(
      "SELECT DISTINCT name FROM symbols WHERE file_id=? AND name IS NOT NULL",
      fileId,
    ).map((row) => row.name);
  }
}
