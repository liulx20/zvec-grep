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
  | "impact_summary"
  | "low_value_path"
  | "direct_caller"
  | "direct_call"
  | "call_path";

export type ExploreFileEvidenceKind =
  | ExploreFileRoleEvidenceKind
  | `concept:${string}`
  | `family:${string}`
  | `symbol:${string}`
  | `path:${string}`;

export type ExploreFileCandidate = {
  fileId: string;
  baseScore: number;
  score: number;
  evidence: ReadonlyMap<ExploreFileEvidenceKind, number>;
};

export type ExploreFileRole = "central" | "supporting";

export type SelectedExploreFile = ExploreFileCandidate & {
  role: ExploreFileRole;
};

export type ExploreFileSelectionInput = {
  ordered: readonly [string, number][];
  maxFiles: number;
  intent: ExploreIntent;
  evidence: ReadonlyMap<string, ReadonlyMap<ExploreFileEvidenceKind, number>>;
  rootFileIds?: readonly string[];
};

const EXACT_WEIGHTS: Readonly<Record<ExploreFileRoleEvidenceKind, number>> = {
  root: 4,
  semantic_seed: 0.5,
  root_counterpart: 2.2,
  counterpart: 0.5,
  collaborator: 0.8,
  aligned_change_surface: 0.8,
  entrypoint: 0.7,
  hierarchy: 0.65,
  query_alignment: 0.8,
  structural_change_surface: 0.55,
  change_surface: 0.4,
  integration: 0.8,
  dynamic_boundary: 0.6,
  impact_summary: 0,
  low_value_path: -2.5,
  direct_caller: 1.2,
  direct_call: 0.1,
  call_path: 0.5,
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
  impact_summary: 0,
  low_value_path: -3,
  direct_caller: 1,
  direct_call: 0.45,
  call_path: 0.65,
};

const SCALED_EVIDENCE = new Set<ExploreFileEvidenceKind>([
  "aligned_change_surface",
  "direct_call",
  "integration",
]);

const NOVELTY_EVIDENCE = new Set<ExploreFileRoleEvidenceKind>([
  "entrypoint",
  "hierarchy",
  "call_path",
  "root_counterpart",
]);

/**
 * Rank every eligible file once from its accumulated evidence. Roots, one
 * declaration/implementation counterpart, and the primary call path are
 * consistency constraints; all remaining roles compete in one score space.
 */
export function selectExploreFiles(
  input: ExploreFileSelectionInput,
): SelectedExploreFile[] {
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
  const eligible = candidates.filter(isEligibleSourceCandidate);
  eligible.sort(compareCandidates);
  const selected: ExploreFileCandidate[] = [];
  const selectedIds = new Set<string>();
  const take = (candidate: ExploreFileCandidate | undefined) => {
    if (!candidate || selected.length >= input.maxFiles) return;
    if (selectedIds.has(candidate.fileId)) return;
    selected.push(candidate);
    selectedIds.add(candidate.fileId);
  };

  const exactRoots = eligible.filter((item) => item.evidence.has("root"));
  for (const candidate of exactRoots.length > 0
    ? exactRoots
    : eligible.filter((item) => item.evidence.has("semantic_seed")))
    take(candidate);
  take(
    eligible.find(
      (candidate) =>
        candidate.evidence.has("root_counterpart") &&
        !selectedIds.has(candidate.fileId),
    ),
  );
  while (selected.length < input.maxFiles) {
    const next = eligible
      .filter((candidate) => !selectedIds.has(candidate.fileId))
      .sort((left, right) =>
        compareMarginal(left, right, selected, input.intent),
      )[0];
    if (!next || marginalGain(next, selected, input.intent) <= 0) break;
    take(next);
  }
  return assignFileRoles(selected, input);
}

function assignFileRoles(
  selected: readonly ExploreFileCandidate[],
  input: ExploreFileSelectionInput,
): SelectedExploreFile[] {
  const central = new Set<string>();
  const rootRank = new Map(
    (input.rootFileIds ?? []).map((fileId, index) => [fileId, index]),
  );
  const seedKind = input.intent === "exact_symbol" ? "root" : "semantic_seed";
  const seeds = selected
    .filter((candidate) => candidate.evidence.has(seedKind))
    .sort(
      (left, right) =>
        (rootRank.get(left.fileId) ?? Number.MAX_SAFE_INTEGER) -
        (rootRank.get(right.fileId) ?? Number.MAX_SAFE_INTEGER),
    );
  for (const candidate of seeds.slice(0, input.intent === "concept" ? 1 : 2))
    central.add(candidate.fileId);

  const coCentral = (
    [
      ["root_counterpart"],
      ["counterpart"],
      ["direct_caller", "direct_call"],
      ["integration"],
    ] as const
  )
    .map((kinds) =>
      selected.find(
        (candidate) =>
          !central.has(candidate.fileId) &&
          kinds.some((kind) => candidate.evidence.has(kind)),
      ),
    )
    .find((candidate) => candidate !== undefined);
  if (coCentral && central.size < 2) central.add(coCentral.fileId);

  return selected.map((candidate) => ({
    ...candidate,
    role: central.has(candidate.fileId) ? "central" : "supporting",
  }));
}

function isEligibleSourceCandidate(candidate: ExploreFileCandidate): boolean {
  const conceptCount = [...candidate.evidence.keys()].filter((kind) =>
    kind.startsWith("concept:"),
  ).length;
  const sourceUpgrade = (
    [
      "integration",
      "collaborator",
      "counterpart",
      "root_counterpart",
      "hierarchy",
      "direct_caller",
      "direct_call",
      "call_path",
      "semantic_seed",
    ] as const
  ).some((kind) => candidate.evidence.has(kind));
  return (
    !candidate.evidence.has("impact_summary") ||
    sourceUpgrade ||
    (!candidate.evidence.has("low_value_path") &&
      ((candidate.evidence.get("query_alignment") ?? 0) >= 1 ||
        conceptCount >= 2))
  );
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
  if (kind.startsWith("family:")) return intent === "concept" ? 0.8 : 0.3;
  if (kind.startsWith("symbol:") || kind.startsWith("path:")) return 0;
  return weights[kind as ExploreFileRoleEvidenceKind];
}

function compareMarginal(
  left: ExploreFileCandidate,
  right: ExploreFileCandidate,
  selected: readonly ExploreFileCandidate[],
  intent: ExploreIntent,
): number {
  return (
    marginalGain(right, selected, intent) -
      marginalGain(left, selected, intent) || compareCandidates(left, right)
  );
}

function marginalGain(
  candidate: ExploreFileCandidate,
  selected: readonly ExploreFileCandidate[],
  intent: ExploreIntent,
): number {
  if (selected.length === 0) return candidate.score;
  const covered = new Set(
    selected.flatMap((item) => noveltyEvidence(item.evidence)),
  );
  const novelty = noveltyEvidence(candidate.evidence).filter(
    (role) => !covered.has(role),
  ).length;
  const redundancy = Math.max(
    ...selected.map((item) => fileSimilarity(candidate, item)),
    0,
  );
  return (
    candidate.score -
    repeatedFamilySemanticScore(candidate, selected, intent) +
    novelty * 0.18 -
    redundancy * 0.2
  );
}

function repeatedFamilySemanticScore(
  candidate: ExploreFileCandidate,
  selected: readonly ExploreFileCandidate[],
  intent: ExploreIntent,
): number {
  // Family overlap suppresses interchangeable semantic hits, not files with
  // independent structural evidence. A direct caller or call-path file is a
  // distinct execution role even when it shares every query term with a root.
  if (
    candidate.evidence.has("call_path") ||
    candidate.evidence.has("direct_caller") ||
    candidate.evidence.has("entrypoint") ||
    candidate.evidence.has("root_counterpart") ||
    (candidate.evidence.has("direct_call") &&
      !candidate.evidence.has("hierarchy"))
  )
    return 0;
  const families = features(candidate.evidence, "family:");
  if (
    families.size === 0 ||
    !selected.some(
      (item) => setOverlap(families, features(item.evidence, "family:")) > 0,
    )
  )
    return 0;
  const repeatedConcepts = new Set(
    selected
      .filter(
        (item) => setOverlap(families, features(item.evidence, "family:")) > 0,
      )
      .flatMap((item) => [...features(item.evidence, "concept:")]),
  );
  const candidateConcepts = features(candidate.evidence, "concept:");
  const repeatedRatio =
    candidateConcepts.size === 0
      ? 0
      : [...candidateConcepts].filter((kind) => repeatedConcepts.has(kind))
          .length / candidateConcepts.size;
  const weights = evidenceWeights(intent);
  return [...candidate.evidence].reduce((total, [kind, strength]) => {
    if (kind === "query_alignment")
      return (
        total + evidenceWeight(weights, kind, intent) * strength * repeatedRatio
      );
    if (!kind.startsWith("concept:") || !repeatedConcepts.has(kind))
      return total;
    return total + evidenceWeight(weights, kind, intent) * strength;
  }, 0);
}

function noveltyEvidence(
  evidence: ReadonlyMap<ExploreFileEvidenceKind, number>,
): ExploreFileEvidenceKind[] {
  return [...evidence.keys()].filter(
    (kind) =>
      kind.startsWith("concept:") ||
      NOVELTY_EVIDENCE.has(kind as ExploreFileRoleEvidenceKind),
  );
}

function fileSimilarity(
  left: ExploreFileCandidate,
  right: ExploreFileCandidate,
): number {
  return (
    setOverlap(
      features(left.evidence, "family:"),
      features(right.evidence, "family:"),
    ) *
      0.4 +
    setOverlap(
      features(left.evidence, "symbol:"),
      features(right.evidence, "symbol:"),
    ) *
      0.35 +
    setOverlap(
      features(left.evidence, "concept:"),
      features(right.evidence, "concept:"),
    ) *
      0.15 +
    setOverlap(
      features(left.evidence, "path:"),
      features(right.evidence, "path:"),
    ) *
      0.1
  );
}

function features(
  evidence: ReadonlyMap<ExploreFileEvidenceKind, number>,
  prefix: "concept:" | "family:" | "symbol:" | "path:",
): Set<string> {
  return new Set(
    [...evidence.keys()].filter((kind) => kind.startsWith(prefix)),
  );
}

function setOverlap(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): number {
  const union = new Set([...left, ...right]);
  if (union.size === 0) return 0;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
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
