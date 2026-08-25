import type { SqliteGraphDatabase } from "./database.js";

export type BufferedEdge = {
  id: string;
  src_id: string;
  dst_id: string;
  src_is_file: number;
  dst_is_file: number;
  kind: string;
  rel: string;
  count: number;
  first_line: number;
  ref_name: string;
  source_language: string | null;
  imported_name: string | null;
  local_name: string | null;
  receiver_kind: string | null;
  receiver_name: string | null;
  member_name: string | null;
  resolution_hints: string | null;
  provenance: string;
  confidence: number;
  evidence: string | null;
};

export type BufferedDynamicRef = {
  id: string;
  reason: string;
  member_name: string;
  receiver_kind: string | null;
  receiver_name: string | null;
  resolution_hints: string | null;
};

export type BufferedCandidate = {
  edge_id: string;
  target_id: string;
  reason: string;
  confidence: number;
};

/** Invocation-local projection writes, flushed atomically with ref status. */
export class SqliteProjectionBuffer {
  private readonly edges: BufferedEdge[] = [];
  private readonly dynamicRefs: BufferedDynamicRef[] = [];
  private readonly candidates: BufferedCandidate[] = [];
  private readonly externalRefIds = new Set<string>();
  private readonly resolvedRefIds = new Set<string>();

  constructor(private readonly database: SqliteGraphDatabase) {}

  begin(): void {
    this.edges.length = 0;
    this.dynamicRefs.length = 0;
    this.candidates.length = 0;
    this.externalRefIds.clear();
    this.resolvedRefIds.clear();
  }

  addEdge(edge: BufferedEdge): void {
    this.edges.push(edge);
  }

  addDynamicRef(ref: BufferedDynamicRef): void {
    this.dynamicRefs.push(ref);
  }

  addCandidate(candidate: BufferedCandidate): void {
    this.candidates.push(candidate);
  }

  markExternal(id: string): void {
    this.externalRefIds.add(id);
  }

  markResolved(id: string): void {
    this.resolvedRefIds.add(id);
  }

  flush(): void {
    this.flushEdges();
    this.flushDynamicRefs();
    this.flushCandidates();
    this.updateRefStatus("external", this.externalRefIds);
    if (this.resolvedRefIds.size > 0)
      this.database
        .prepare(
          `DELETE FROM unresolved_refs
           WHERE id IN (SELECT value FROM json_each(?))`,
        )
        .run(JSON.stringify([...this.resolvedRefIds]));
    this.begin();
  }

  private flushEdges(): void {
    if (this.edges.length === 0) return;
    this.database
      .prepare(
        `INSERT OR REPLACE INTO edges(
           id,src_id,dst_id,src_is_file,dst_is_file,kind,rel,count,first_line,
           ref_name,source_language,imported_name,local_name,receiver_kind,
           receiver_name,member_name,resolution_hints,provenance,confidence,evidence
         )
         SELECT json_extract(value,'$.id'),json_extract(value,'$.src_id'),
                json_extract(value,'$.dst_id'),json_extract(value,'$.src_is_file'),
                json_extract(value,'$.dst_is_file'),json_extract(value,'$.kind'),
                json_extract(value,'$.rel'),json_extract(value,'$.count'),
                json_extract(value,'$.first_line'),json_extract(value,'$.ref_name'),
                json_extract(value,'$.source_language'),json_extract(value,'$.imported_name'),
                json_extract(value,'$.local_name'),json_extract(value,'$.receiver_kind'),
                json_extract(value,'$.receiver_name'),json_extract(value,'$.member_name'),
                json_extract(value,'$.resolution_hints'),json_extract(value,'$.provenance'),
                json_extract(value,'$.confidence'),json_extract(value,'$.evidence')
         FROM json_each(?)`,
      )
      .run(JSON.stringify(this.edges));
  }

  private flushDynamicRefs(): void {
    if (this.dynamicRefs.length === 0) return;
    const rows = JSON.stringify(this.dynamicRefs);
    this.database
      .prepare(
        `UPDATE unresolved_refs AS unresolved
         SET status='dynamic',
             dynamic_reason=json_extract(item.value,'$.reason'),
             member_name=json_extract(item.value,'$.member_name'),
             receiver_kind=json_extract(item.value,'$.receiver_kind'),
             receiver_name=json_extract(item.value,'$.receiver_name'),
             resolution_hints=json_extract(item.value,'$.resolution_hints')
         FROM json_each(?) AS item
         WHERE unresolved.id=json_extract(item.value,'$.id')`,
      )
      .run(rows);
    this.database
      .prepare(
        `DELETE FROM edge_candidates
         WHERE edge_id IN (
           SELECT json_extract(value,'$.id') FROM json_each(?)
         )`,
      )
      .run(rows);
  }

  private flushCandidates(): void {
    if (this.candidates.length === 0) return;
    this.database
      .prepare(
        `INSERT INTO edge_candidates(edge_id,target_id,reason,confidence)
         SELECT json_extract(value,'$.edge_id'),json_extract(value,'$.target_id'),
                json_extract(value,'$.reason'),json_extract(value,'$.confidence')
         FROM json_each(?)`,
      )
      .run(JSON.stringify(this.candidates));
  }

  private updateRefStatus(status: "external", ids: ReadonlySet<string>): void {
    if (ids.size === 0) return;
    this.database
      .prepare(
        `UPDATE unresolved_refs SET status=?
         WHERE id IN (SELECT value FROM json_each(?))`,
      )
      .run(status, JSON.stringify([...ids]));
  }
}
