export type ExploreFileEvidenceKind =
  | "root"
  | "root_counterpart"
  | "counterpart"
  | "collaborator"
  | "aligned_change_surface"
  | "entrypoint"
  | "hierarchy"
  | "query_alignment"
  | "structural_change_surface"
  | "change_surface"
  | "integration"
  | "dynamic_boundary"
  | "call_path";

export type ExploreFileCandidate = {
  fileId: string;
  baseScore: number;
  score: number;
  evidence: ReadonlyMap<ExploreFileEvidenceKind, number>;
};

export type ExploreFileSelectionInput = {
  ordered: readonly [string, number][];
  maxFiles: number;
  evidence: ReadonlyMap<string, ReadonlyMap<ExploreFileEvidenceKind, number>>;
};

const EVIDENCE_WEIGHTS: Readonly<Record<ExploreFileEvidenceKind, number>> = {
  root: 4,
  root_counterpart: 2,
  counterpart: 1.5,
  collaborator: 1.35,
  aligned_change_surface: 1.25,
  entrypoint: 1.2,
  hierarchy: 0.9,
  query_alignment: 0.85,
  structural_change_surface: 0.8,
  change_surface: 0.65,
  integration: 0.75,
  dynamic_boundary: 0.75,
  call_path: 0.45,
};

const SCALED_EVIDENCE = new Set<ExploreFileEvidenceKind>([
  "aligned_change_surface",
  "integration",
]);

/**
 * Rank every eligible file once from its accumulated evidence. Only roots and
 * one declaration/implementation counterpart are hard constraints; all other
 * roles compete in the same score space instead of consuming ordered quotas.
 */
export function selectExploreFiles(
  input: ExploreFileSelectionInput,
): ExploreFileCandidate[] {
  if (input.maxFiles <= 0 || input.ordered.length === 0) return [];
  const strongestBase = Math.max(...input.ordered.map(([, score]) => score), 0);
  const maxima = evidenceMaxima(input.evidence);
  const candidates = input.ordered.map(([fileId, rawBaseScore]) => {
    const evidence = normalizedEvidence(input.evidence.get(fileId), maxima);

    const baseScore = strongestBase > 0 ? rawBaseScore / strongestBase : 0;
    const score =
      baseScore +
      [...evidence].reduce(
        (total, [kind, strength]) => total + EVIDENCE_WEIGHTS[kind] * strength,
        0,
      );
    return { fileId, baseScore, score, evidence };
  });
  candidates.sort(compareCandidates);

  const selected: ExploreFileCandidate[] = [];
  const selectedIds = new Set<string>();
  const take = (candidate: ExploreFileCandidate | undefined) => {
    if (!candidate || selected.length >= input.maxFiles) return;
    if (selectedIds.has(candidate.fileId)) return;
    selected.push(candidate);
    selectedIds.add(candidate.fileId);
  };

  for (const candidate of candidates.filter((item) =>
    item.evidence.has("root"),
  ))
    take(candidate);
  take(
    candidates.find(
      (candidate) =>
        (candidate.evidence.has("root_counterpart") ||
          candidate.evidence.has("counterpart")) &&
        !selectedIds.has(candidate.fileId),
    ),
  );
  for (const candidate of candidates) take(candidate);
  return selected;
}

function evidenceMaxima(
  evidence: ExploreFileSelectionInput["evidence"],
): ReadonlyMap<ExploreFileEvidenceKind, number> {
  const maxima = new Map<ExploreFileEvidenceKind, number>();
  for (const values of evidence.values()) {
    for (const [kind, strength] of values) {
      maxima.set(kind, Math.max(maxima.get(kind) ?? 0, strength));
    }
  }
  return maxima;
}

function normalizedEvidence(
  evidence: ReadonlyMap<ExploreFileEvidenceKind, number> | undefined,
  maxima: ReadonlyMap<ExploreFileEvidenceKind, number>,
): Map<ExploreFileEvidenceKind, number> {
  const normalized = new Map<ExploreFileEvidenceKind, number>();
  for (const [kind, strength] of evidence ?? []) {
    const maximum = maxima.get(kind) ?? 0;
    normalized.set(
      kind,
      SCALED_EVIDENCE.has(kind) && maximum > 0
        ? Math.min(1, strength / maximum)
        : Math.min(1, strength),
    );
  }
  return normalized;
}

function compareCandidates(
  left: ExploreFileCandidate,
  right: ExploreFileCandidate,
): number {
  return (
    right.score - left.score ||
    right.baseScore - left.baseScore ||
    left.fileId.localeCompare(right.fileId)
  );
}
