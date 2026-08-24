import type { StoredEntity } from "../../storage/index.js";
import type { ExploreNode } from "./types.js";

/** Shared candidate accumulator for independent Explore evidence collectors. */
export class ExploreCandidatePool {
  private readonly candidates = new Map<string, ExploreNode>();

  constructor(
    nodes: readonly ExploreNode[],
    private readonly scores: Map<string, number>,
  ) {
    for (const node of nodes) this.addNode(node);
  }

  get nodes(): ExploreNode[] {
    return [...this.candidates.values()];
  }

  get size(): number {
    return this.candidates.size;
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

  private addNode(node: ExploreNode): void {
    const existing = this.candidates.get(node.id);
    this.candidates.set(
      node.id,
      existing && node.isRoot && !existing.isRoot
        ? { ...existing, isRoot: true }
        : (existing ?? node),
    );
  }
}
