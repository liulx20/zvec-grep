import type { ExploreIntent } from "./intent.js";

export type ExploreFileRoleEvidenceKind =
  | "root"
  | "semantic_seed"
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
  | "low_value_path"
  | "call_path";

export type ExploreFileEvidenceKind =
  ExploreFileRoleEvidenceKind | `concept:${string}`;

export type ExploreFileCandidate = {
  fileId: string;
  baseScore: number;
  score: number;
  evidence: ReadonlyMap<ExploreFileEvidenceKind, number>;
};

export type ExploreFileSelectionInput = {
  ordered: readonly [string, number][];
  maxFiles: number;
  intent: ExploreIntent;
  evidence: ReadonlyMap<string, ReadonlyMap<ExploreFileEvidenceKind, number>>;
};

const EXACT_WEIGHTS: Readonly<Record<ExploreFileRoleEvidenceKind, number>> = {
  root: 4,
  semantic_seed: 0.5,
  root_counterpart: 2.2,
  counterpart: 1.4,
  collaborator: 0.8,
  aligned_change_surface: 0.8,
  entrypoint: 0.7,
  hierarchy: 0.65,
  query_alignment: 0.8,
  structural_change_surface: 0.55,
  change_surface: 0.4,
  integration: 0.8,
  dynamic_boundary: 0.6,
  low_value_path: -2.5,
  call_path: 1.1,
};

const CONCEPT_WEIGHTS: Readonly<Record<ExploreFileRoleEvidenceKind, number>> = {
  ...EXACT_WEIGHTS,
  root: 2,
  semantic_seed: 1.8,
  root_counterpart: 1.4,
  collaborator: 1.25,
  aligned_change_surface: 1.25,
  entrypoint: 1.1,
  hierarchy: 0.8,
  query_alignment: 1.3,
  integration: 1,
  low_value_path: -3,
  call_path: 0.65,
};

const SCALED_EVIDENCE = new Set<ExploreFileEvidenceKind>([
  "aligned_change_surface",
  "integration",
  "query_alignment",
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
  const weights = evidenceWeights(input.intent);
  const maxima = evidenceMaxima(input.evidence);
  const candidates = input.ordered.map(([fileId, rawBaseScore]) => {
    const evidence = normalizedEvidence(input.evidence.get(fileId), maxima);

    const baseScore = strongestBase > 0 ? rawBaseScore / strongestBase : 0;
    const score =
      baseScore +
      [...evidence].reduce(
        (total, [kind, strength]) =>
          total + evidenceWeight(weights, kind, input.intent) * strength,
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
        candidate.evidence.has("root_counterpart") &&
        !selectedIds.has(candidate.fileId),
    ),
  );
  while (selected.length < input.maxFiles) {
    const next = candidates
      .filter((candidate) => !selectedIds.has(candidate.fileId))
      .sort((left, right) => compareMarginal(left, right, selected))[0];
    if (!next || marginalGain(next, selected) <= 0) break;
    take(next);
  }
  return selected;
}

function evidenceWeights(
  intent: ExploreIntent,
): Readonly<Record<ExploreFileRoleEvidenceKind, number>> {
  if (intent === "concept") return CONCEPT_WEIGHTS;
  return EXACT_WEIGHTS;
}

function evidenceWeight(
  weights: Readonly<Record<ExploreFileRoleEvidenceKind, number>>,
  kind: ExploreFileEvidenceKind,
  intent: ExploreIntent,
): number {
  if (kind.startsWith("concept:")) return intent === "concept" ? 0.35 : 0.2;
  return weights[kind as ExploreFileRoleEvidenceKind];
}

function compareMarginal(
  left: ExploreFileCandidate,
  right: ExploreFileCandidate,
  selected: readonly ExploreFileCandidate[],
): number {
  return (
    marginalGain(right, selected) - marginalGain(left, selected) ||
    compareCandidates(left, right)
  );
}

function marginalGain(
  candidate: ExploreFileCandidate,
  selected: readonly ExploreFileCandidate[],
): number {
  if (selected.length === 0) return candidate.score;
  const covered = new Set(
    selected.flatMap((item) => [...item.evidence.keys()]),
  );
  const roles = [...candidate.evidence.keys()];
  const novelty = roles.filter((role) => !covered.has(role)).length;
  const redundancy = Math.max(
    ...selected.map((item) =>
      evidenceOverlap(candidate.evidence, item.evidence),
    ),
    0,
  );
  return candidate.score + novelty * 0.18 - redundancy * 0.2;
}

function evidenceOverlap(
  left: ReadonlyMap<ExploreFileEvidenceKind, number>,
  right: ReadonlyMap<ExploreFileEvidenceKind, number>,
): number {
  const union = new Set([...left.keys(), ...right.keys()]);
  if (union.size === 0) return 0;
  let intersection = 0;
  for (const role of left.keys()) if (right.has(role)) intersection += 1;
  return intersection / union.size;
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
