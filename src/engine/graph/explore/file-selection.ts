export type ExploreFileEvidenceKind =
  | "root"
  | "counterpart"
  | "collaborator"
  | "aligned_change_surface"
  | "entrypoint"
  | "hierarchy"
  | "query_alignment"
  | "structural_change_surface"
  | "change_surface"
  | "integration"
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
  rootFileIds: ReadonlySet<string>;
  counterpartFileIds: ReadonlySet<string>;
  collaboratorFileIds: ReadonlySet<string>;
  alignedChangeSurfaceFileIds: ReadonlySet<string>;
  entrypointFileIds: ReadonlySet<string>;
  hierarchyFileIds: ReadonlySet<string>;
  alignedFileIds: ReadonlySet<string>;
  structuralChangeSurfaceFileIds: ReadonlySet<string>;
  changeSurfaceFileIds: ReadonlySet<string>;
  integrationFileIds: ReadonlySet<string>;
  pathFileIds: ReadonlySet<string>;
  integrationFileWeights: ReadonlyMap<string, number>;
  alignedChangeSurfaceWeights: ReadonlyMap<string, number>;
};

const EVIDENCE_WEIGHTS: Readonly<Record<ExploreFileEvidenceKind, number>> = {
  root: 4,
  counterpart: 1.5,
  collaborator: 1.35,
  aligned_change_surface: 1.25,
  entrypoint: 1.2,
  hierarchy: 0.9,
  query_alignment: 0.85,
  structural_change_surface: 0.8,
  change_surface: 0.65,
  integration: 0.75,
  call_path: 0.45,
};

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
  const strongestIntegration = maximumValue(input.integrationFileWeights);
  const strongestAlignedChange = maximumValue(
    input.alignedChangeSurfaceWeights,
  );
  const candidates = input.ordered.map(([fileId, rawBaseScore]) => {
    const evidence = new Map<ExploreFileEvidenceKind, number>();
    addBooleanEvidence(evidence, "root", input.rootFileIds.has(fileId));
    addBooleanEvidence(
      evidence,
      "counterpart",
      input.counterpartFileIds.has(fileId),
    );
    addBooleanEvidence(
      evidence,
      "collaborator",
      input.collaboratorFileIds.has(fileId),
    );
    addScaledEvidence(
      evidence,
      "aligned_change_surface",
      input.alignedChangeSurfaceFileIds.has(fileId)
        ? (input.alignedChangeSurfaceWeights.get(fileId) ?? 1)
        : 0,
      strongestAlignedChange,
    );
    addBooleanEvidence(
      evidence,
      "entrypoint",
      input.entrypointFileIds.has(fileId),
    );
    addBooleanEvidence(
      evidence,
      "hierarchy",
      input.hierarchyFileIds.has(fileId),
    );
    addBooleanEvidence(
      evidence,
      "query_alignment",
      input.alignedFileIds.has(fileId),
    );
    addBooleanEvidence(
      evidence,
      "structural_change_surface",
      input.structuralChangeSurfaceFileIds.has(fileId),
    );
    addBooleanEvidence(
      evidence,
      "change_surface",
      input.changeSurfaceFileIds.has(fileId),
    );
    addScaledEvidence(
      evidence,
      "integration",
      input.integrationFileIds.has(fileId)
        ? (input.integrationFileWeights.get(fileId) ?? 1)
        : 0,
      strongestIntegration,
    );
    addBooleanEvidence(evidence, "call_path", input.pathFileIds.has(fileId));

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
    input.rootFileIds.has(item.fileId),
  ))
    take(candidate);
  take(
    candidates.find(
      (candidate) =>
        input.counterpartFileIds.has(candidate.fileId) &&
        !selectedIds.has(candidate.fileId),
    ),
  );
  for (const candidate of candidates) take(candidate);
  return selected;
}

function addBooleanEvidence(
  evidence: Map<ExploreFileEvidenceKind, number>,
  kind: ExploreFileEvidenceKind,
  present: boolean,
): void {
  if (present) evidence.set(kind, 1);
}

function addScaledEvidence(
  evidence: Map<ExploreFileEvidenceKind, number>,
  kind: ExploreFileEvidenceKind,
  value: number,
  maximum: number,
): void {
  if (value <= 0) return;
  evidence.set(kind, maximum > 0 ? Math.min(1, value / maximum) : 1);
}

function maximumValue(values: ReadonlyMap<string, number>): number {
  return Math.max(...values.values(), 0);
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
