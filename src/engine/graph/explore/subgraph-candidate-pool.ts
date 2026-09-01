import type { SymRef } from "../types.js";
import type { ExploreNodeEvidence, ExploreNodeEvidenceKind } from "./types.js";

export type SubgraphCandidate = {
  id: string;
  kind?: string;
  isRoot: boolean;
  minDepth: number;
};

type MutableEvidence = Omit<ExploreNodeEvidence, "sources"> & {
  sources: Set<string>;
};

type MutableCandidate = SubgraphCandidate & {
  evidence: Map<ExploreNodeEvidenceKind, MutableEvidence>;
};

type CandidateEvidenceInput = {
  depth: number;
  strength?: number;
  sourceId?: string;
  isRoot?: boolean;
  protect?: boolean;
};

/** Accumulates node candidates without letting collectors select final nodes. */
export class SubgraphCandidatePool {
  private readonly candidates = new Map<string, MutableCandidate>();

  get size(): number {
    return this.candidates.size;
  }

  has(id: string): boolean {
    return this.candidates.has(id);
  }

  get(id: string): SubgraphCandidate | undefined {
    return this.candidates.get(id);
  }

  keys(): IterableIterator<string> {
    return this.candidates.keys();
  }

  values(): IterableIterator<SubgraphCandidate> {
    return this.candidates.values();
  }

  add(
    ref: SymRef,
    kind: ExploreNodeEvidenceKind,
    input: CandidateEvidenceInput,
  ): boolean {
    const existing = this.candidates.get(ref.id);
    const candidate =
      existing ??
      ({
        id: ref.id,
        kind: ref.kind,
        isRoot: false,
        minDepth: input.depth,
        evidence: new Map(),
      } satisfies MutableCandidate);
    candidate.isRoot ||= input.isRoot ?? false;
    candidate.minDepth = Math.min(candidate.minDepth, input.depth);
    if (ref.kind) candidate.kind = ref.kind;

    const evidence = candidate.evidence.get(kind) ?? {
      strength: 0,
      minDepth: input.depth,
      protected: false,
      sources: new Set<string>(),
    };
    evidence.strength = Math.max(evidence.strength, input.strength ?? 1);
    evidence.minDepth = Math.min(evidence.minDepth, input.depth);
    evidence.protected ||= input.protect ?? false;
    if (input.sourceId) evidence.sources.add(input.sourceId);
    candidate.evidence.set(kind, evidence);
    this.candidates.set(ref.id, candidate);
    return !existing;
  }

  protect(ids: Iterable<string>, kind: ExploreNodeEvidenceKind): void {
    for (const id of ids) {
      const candidate = this.candidates.get(id);
      if (!candidate) continue;
      const evidence = candidate.evidence.get(kind) ?? {
        strength: 1,
        minDepth: candidate.minDepth,
        protected: false,
        sources: new Set<string>(),
      };
      evidence.protected = true;
      candidate.evidence.set(kind, evidence);
    }
  }

  isProtected(id: string): boolean {
    const candidate = this.candidates.get(id);
    return Boolean(
      candidate?.isRoot ||
      [...(candidate?.evidence.values() ?? [])].some(
        (evidence) => evidence.protected,
      ),
    );
  }

  evidenceStrength(id: string): number {
    return [...(this.candidates.get(id)?.evidence.values() ?? [])].reduce(
      (total, evidence) => total + evidence.strength,
      0,
    );
  }

  retain(ids: ReadonlySet<string>): void {
    for (const id of this.candidates.keys())
      if (!ids.has(id)) this.candidates.delete(id);
  }

  evidence(): ReadonlyMap<
    string,
    ReadonlyMap<ExploreNodeEvidenceKind, ExploreNodeEvidence>
  > {
    return new Map(
      [...this.candidates].map(([id, candidate]) => [
        id,
        new Map(
          [...candidate.evidence].map(([kind, evidence]) => [
            kind,
            { ...evidence, sources: new Set(evidence.sources) },
          ]),
        ),
      ]),
    );
  }
}
