import type { StoredEntity } from "../../storage/index.js";
import type { ExploreFileEvidenceKind } from "./file-selection.js";
import type { ExploreNode } from "./types.js";

/** Shared candidate accumulator for independent Explore evidence collectors. */
export class ExploreCandidatePool {
  private readonly candidates = new Map<string, ExploreNode>();
  private readonly evidence = new Map<
    string,
    Map<ExploreFileEvidenceKind, number>
  >();

  constructor(
    nodes: readonly ExploreNode[],
    private readonly scores: Map<string, number>,
    fileEvidence?: ReadonlyMap<
      string,
      ReadonlyMap<ExploreFileEvidenceKind, number>
    >,
  ) {
    for (const node of nodes) this.addNode(node);
    for (const [fileId, evidence] of fileEvidence ?? []) {
      for (const [kind, strength] of evidence)
        this.addFileEvidence(fileId, kind, strength);
    }
  }

  get nodes(): ExploreNode[] {
    return [...this.candidates.values()];
  }

  get size(): number {
    return this.candidates.size;
  }

  get fileEvidence(): ReadonlyMap<
    string,
    ReadonlyMap<ExploreFileEvidenceKind, number>
  > {
    return this.evidence;
  }

  has(id: string): boolean {
    return this.candidates.has(id);
  }

  add(entity: StoredEntity, score: number): boolean {
    if (this.candidates.has(entity.entity.id)) return false;
    this.candidates.set(entity.entity.id, {
      id: entity.entity.id,
      kind:
        entity.entity.metadata?.kind === "code"
          ? entity.entity.metadata.symbolType
          : undefined,
      isRoot: false,
      entity,
    });
    this.scores.set(
      entity.entity.id,
      Math.max(this.scores.get(entity.entity.id) ?? 0, score),
    );
    return true;
  }

  addFileEvidence(
    fileId: string,
    kind: ExploreFileEvidenceKind,
    strength = 1,
  ): void {
    if (strength <= 0) return;
    const evidence = this.evidence.get(fileId) ?? new Map();
    evidence.set(kind, Math.max(evidence.get(kind) ?? 0, strength));
    this.evidence.set(fileId, evidence);
  }

  addNode(node: ExploreNode): void {
    const existing = this.candidates.get(node.id);
    this.candidates.set(
      node.id,
      existing && node.isRoot && !existing.isRoot
        ? { ...existing, isRoot: true }
        : (existing ?? node),
    );
  }
}
