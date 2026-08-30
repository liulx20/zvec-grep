import type { StoredEntity } from "../../storage/index.js";
import {
  fileStem,
  isLowValuePath,
  isTestPath,
  queryTargetsPath as queryTargetsPathTerms,
} from "../path-policy.js";
import {
  groupSemanticSymbols,
  includeSameFileGenericTypeFragments,
  matchesExactSymbolQuery,
  preferExactSymbolCase,
  symbolLookupLeaf,
} from "../symbol-lookup.js";
import type { GraphEdgeKind, GraphReader } from "../types.js";
import { isCallableSymbolKind, TYPE_SYMBOL_KIND_SET } from "../symbol-kinds.js";

const TYPEISH_KINDS = TYPE_SYMBOL_KIND_SET;
type ScoredSeed = {
  entity: StoredEntity;
  id: string;
  score: number;
  coverage: number;
  coveredTerms: Set<string>;
  exact: boolean;
  retrievalRank: number | undefined;
  nameMatch: boolean;
  callable: boolean;
  structural: boolean;
};
const QUERY_STOP_WORDS = new Set([
  "about",
  "after",
  "and",
  "before",
  "between",
  "call",
  "calling",
  "class",
  "code",
  "concrete",
  "different",
  "does",
  "explain",
  "find",
  "flow",
  "from",
  "function",
  "get",
  "gets",
  "have",
  "high",
  "how",
  "include",
  "including",
  "implementation",
  "interface",
  "into",
  "level",
  "method",
  "name",
  "only",
  "one",
  "over",
  "path",
  "reach",
  "specific",
  "sent",
  "struct",
  "the",
  "that",
  "their",
  "then",
  "this",
  "through",
  "trace",
  "trait",
  "type",
  "using",
  "via",
  "what",
  "when",
  "where",
  "which",
  "with",
  "work",
  "works",
]);

export const EXPLORE_POLICY = {
  searchLimit: 8,
  traversalDepth: 3,
  maxNodes: 200,
  maxFiles: 8,
  maxChars: 24_000,
  glueLimit: 60,
  containerGlueLimit: 40,
  pathLimit: 8,
  blastLimit: 20,
  hierarchyBudgetRatio: 0.25,
  edgeBudget: { minimum: 128, maximum: 20_000, perNode: 8 },
  dynamicBoundaryBudget: { maximum: 16, fetchMaximum: 256, fetchRatio: 8 },
  componentImport: { protectedNodes: 8, rankingWeight: 0.25 },
  traverseEdgeKinds: [
    "CALLS",
    "REFS",
    "INHERITS",
    "CONTAINS",
    "COUNTERPART",
    "INSTANTIATES",
  ] as const,
  rwrEdgeWeights: {
    CALLS: 1,
    INHERITS: 0.9,
    // Containment expands a type into its members, but it is weak relevance
    // evidence. Giving it call-like weight traps RWR mass inside large classes
    // and suppresses the cross-file callers/references Explore is meant to find.
    CONTAINS: 0.15,
    REFS: 0.5,
    DEFINES: 0.4,
    IMPORTS: 0.4,
    COUNTERPART: 0.7,
    INSTANTIATES: 0.6,
  } satisfies Readonly<Record<GraphEdgeKind, number>>,
};

export function exploreEdgeBudget(nodeCount: number): number {
  const policy = EXPLORE_POLICY.edgeBudget;
  return Math.min(
    policy.maximum,
    Math.max(policy.minimum, nodeCount * policy.perNode),
  );
}

/**
 * Low-value paths are noise by default, not an access-control boundary. When
 * the user explicitly names a module represented by a path segment, keep that
 * module eligible without opening every vendor/test/doc candidate.
 */
export function queryTargetsPath(query: string, path: string): boolean {
  if (
    isTestPath(path) &&
    !/\b(?:test|tests|testing|spec|specs|fixture|fixtures|mock|mocks)\b/i.test(
      query,
    )
  )
    return false;
  const packageReference = query.match(
    /@[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/,
  )?.[0];
  if (packageReference)
    return packageReference
      .slice(1)
      .split("/")
      .every((term) => queryTargetsPathTerms(path, [term]));
  return queryTargetsPathTerms(path, queryNameTerms(query));
}

export function resolveExploreSeeds(
  storage: GraphReader,
  query: string,
  seedId: string | undefined,
  limit: number,
): string[] {
  if (seedId) {
    return storage.getEntity(seedId) ? [seedId] : [];
  }

  const candidates = new Map<
    string,
    { entity: StoredEntity; exact: boolean; retrievalRank?: number }
  >();
  const anchorGroups: string[][] = [];
  const softAnchorGroups: string[][] = [];
  const nameMatchedIds = new Set<string>();
  const scopeMismatchIds = new Set<string>();
  const seen = new Set<string>();
  const pushEntity = (
    entity: StoredEntity,
    exact = false,
    retrievalRank?: number,
  ) => {
    if (seen.has(entity.entity.id)) {
      const existing = candidates.get(entity.entity.id)!;
      if (exact) existing.exact = true;
      if (
        retrievalRank !== undefined &&
        (existing.retrievalRank === undefined ||
          retrievalRank < existing.retrievalRank)
      )
        existing.retrievalRank = retrievalRank;
      return;
    }
    seen.add(entity.entity.id);
    candidates.set(entity.entity.id, { entity, exact, retrievalRank });
  };

  const normalizedQuery = query.trim().toLowerCase();
  const exact = preferExactSymbolCase(
    storage
      .findSymbolsByName(query, limit * 4)
      .filter(
        (entity) => symbolName(entity).trim().toLowerCase() === normalizedQuery,
      ),
    query,
  );
  if (exact.length > 0) {
    const completeTypes = exact.filter(isCompleteTypeDefinition);
    const definitions = completeTypes.length > 0 ? completeTypes : exact;
    const production = definitions.filter(
      (entity) => !isLowValuePath(entity.file.relativePath),
    );
    const preferred = production.length > 0 ? production : definitions;
    return [...preferred]
      .sort((a, b) => {
        const testDiff =
          Number(isTestPath(a.file.relativePath)) -
          Number(isTestPath(b.file.relativePath));
        return testDiff || a.entity.id.localeCompare(b.entity.id);
      })
      .slice(0, limit)
      .map((entity) => entity.entity.id);
  }

  const retrievalTerms = queryTerms(query);
  let terms = queryEvidenceTerms(query);
  const explicitReferences = explicitSymbolReferences(query);
  const combinedRetrieval =
    storage.findSymbolsByQuery?.(
      retrievalTerms.join(" ") || query,
      limit * 4,
    ) ?? [];
  const workspaceNames = new Set(
    combinedRetrieval.map((entity) =>
      (entity.file.rootPath.replaceAll("\\", "/").split("/").at(-1) ?? "")
        .replace(/[^a-z0-9]/gi, "")
        .toLowerCase(),
    ),
  );
  const workspaceTerms = new Set<string>();
  const qualifiedAnchorTerms = new Set<string>();
  let hasQualifiedAnchor = false;
  for (const reference of explicitReferences) {
    const leaf = symbolLookupLeaf(reference);
    const named = storage.findSymbolsByName(leaf, limit * 8);
    const qualified = /(?:\.|::|->|#)/.test(reference);
    const referenceTerms = queryEvidenceTerms(reference);
    if (
      !qualified &&
      workspaceNames.has(reference.replace(/[^a-z0-9]/gi, "").toLowerCase())
    ) {
      for (const term of referenceTerms) workspaceTerms.add(term);
      continue;
    }
    const matched = qualified
      ? named.filter((entity) => matchesExactSymbolQuery(entity, reference))
      : preferExactSymbolCase(
          named.filter(
            (entity) => lower(symbolName(entity)) === lower(reference),
          ),
          reference,
        );
    const hardReference = qualified || matched.length === 1;
    const qualifiedFallbacks =
      matched.length === 0 && qualified
        ? qualifiedCallableReferences(named, reference)
        : [];
    const qualifiedOwners =
      matched.length === 0 && qualifiedFallbacks.length === 0 && qualified
        ? qualifiedOwnerCandidates(storage, reference, query, limit * 8)
        : [];
    const approximate =
      matched.length === 0 && !qualified && /^[a-z]/.test(reference)
        ? closestCallableReference(storage, reference, limit)
        : undefined;
    const resolvedQualifiedAnchor =
      qualified &&
      (matched.length > 0 ||
        qualifiedOwners.length > 0 ||
        qualifiedFallbacks.length > 0);
    if (resolvedQualifiedAnchor) {
      hasQualifiedAnchor = true;
      for (const term of referenceTerms) qualifiedAnchorTerms.add(term);
    }
    if (hardReference && matched.length > 0)
      anchorGroups.push(matched.map((entity) => entity.entity.id));
    else if (qualified) {
      if (qualifiedFallbacks.length > 0)
        softAnchorGroups.push(
          qualifiedFallbacks.map((entity) => entity.entity.id),
        );
      else if (qualifiedOwners.length > 0)
        softAnchorGroups.push(
          qualifiedOwners.map((entity) => entity.entity.id),
        );
    } else if (approximate && hardReference)
      anchorGroups.push([approximate.entity.id]);
    if (
      qualified &&
      matched.length === 0 &&
      qualifiedOwners.length === 0 &&
      qualifiedFallbacks.length === 0
    )
      for (const entity of named) {
        const metadata = entity.entity.metadata;
        if (metadata?.kind === "code" && metadata.scope)
          scopeMismatchIds.add(entity.entity.id);
      }
    for (const entity of matched.length > 0
      ? matched
      : qualifiedFallbacks.length > 0
        ? qualifiedFallbacks
        : qualifiedOwners.length > 0
          ? qualifiedOwners
          : approximate
            ? [approximate]
            : named)
      pushEntity(
        entity,
        matched.length === 1 ||
          (hardReference && (matched.length > 0 || entity === approximate)),
      );
  }
  for (const reference of explicitTypeReferences(query)) {
    const matched = storage
      .findSymbolsByName(reference, limit * 8)
      .filter((entity) => {
        const metadata = entity.entity.metadata;
        return (
          metadata?.kind === "code" &&
          TYPEISH_KINDS.has(metadata.symbolType) &&
          lower(symbolName(entity)) === lower(reference)
        );
      });
    if (matched.length === 0) continue;
    anchorGroups.push(matched.map((entity) => entity.entity.id));
    for (const entity of matched) pushEntity(entity, true);
  }
  for (const [rank, entity] of combinedRetrieval.entries())
    pushEntity(entity, false, rank);

  const qualifiedComponents = new Set(
    explicitReferences
      .filter((reference) => /(?:\.|::|->|#)/.test(reference))
      .flatMap((reference) => reference.split(/::|\.|->|#/).map(lower)),
  );
  const nameTerms = queryNameTerms(query).filter(
    (term) => !qualifiedComponents.has(lower(term)),
  );
  const acronymTerms = new Set(
    nameTerms.filter((term) => /^[A-Z][A-Z0-9_]{1,}$/.test(term)).map(lower),
  );
  for (const rawTerm of nameTerms) {
    const term = rawTerm.toLowerCase();
    if (term.length < 2) {
      continue;
    }
    for (const entity of storage.findSymbolsByName(rawTerm, limit * 8)) {
      if (semanticIdentityTerms(symbolName(entity)).includes(term))
        nameMatchedIds.add(entity.entity.id);
      pushEntity(entity);
    }
  }
  if (storage.findSymbolsByQuery) {
    for (const term of retrievalTerms) {
      const termLimit = limit * (acronymTerms.has(term) ? 32 : 8);
      for (const variant of semanticTermVariants(term))
        for (const entity of storage.findSymbolsByQuery(variant, termLimit)) {
          if (
            semanticIdentityTerms(symbolName(entity)).includes(lower(variant))
          )
            nameMatchedIds.add(entity.entity.id);
          pushEntity(entity);
        }
    }
  }

  const asksForLowValue =
    /\b(?:test|tests|testing|spec|specs|docs?|documentation|example|benchmark|vendor|third[- ]party)\b/i.test(
      query,
    );
  const candidateValues = [...candidates.values()].filter(
    ({ entity, exact }) => exact || !scopeMismatchIds.has(entity.entity.id),
  );
  const productionValues = candidateValues.filter(
    ({ entity }) => !isLowValuePath(entity.file.relativePath),
  );
  const explicitlyTargetedLowValue = candidateValues.filter(
    ({ entity }) =>
      isLowValuePath(entity.file.relativePath) &&
      !isTestPath(entity.file.relativePath) &&
      queryTargetsPath(query, entity.file.relativePath),
  );
  const valuesToScore =
    !asksForLowValue &&
    productionValues.length >= 1 &&
    explicitlyTargetedLowValue.length === 0
      ? productionValues
      : !asksForLowValue && explicitlyTargetedLowValue.length > 0
        ? [...productionValues, ...explicitlyTargetedLowValue]
        : candidateValues;
  terms = terms.filter(
    (term) =>
      !workspaceTerms.has(term) &&
      !(hasQualifiedAnchor && qualifiedAnchorTerms.has(term)),
  );
  const namedTypeIds = valuesToScore
    .filter(({ entity }) => {
      const metadata = entity.entity.metadata;
      return (
        nameMatchedIds.has(entity.entity.id) &&
        metadata?.kind === "code" &&
        TYPEISH_KINDS.has(metadata.symbolType ?? "")
      );
    })
    .map(({ entity }) => entity.entity.id);
  const structuralIds = new Set<string>();
  if (namedTypeIds.length > 0) {
    const edgeLimit = Math.max(32, namedTypeIds.length * 4);
    for (const edge of [
      ...(storage.incomingEdges?.(namedTypeIds, ["INHERITS"], edgeLimit) ?? []),
      ...(storage.outgoingEdges?.(namedTypeIds, ["INHERITS"], edgeLimit) ?? []),
    ]) {
      structuralIds.add(edge.src);
      structuralIds.add(edge.dst);
    }
  }
  const scored = valuesToScore.map(({ entity, exact, retrievalRank }) => {
    const meta = entity.entity.metadata;
    const kind = meta?.kind === "code" ? meta.symbolType : "";
    const content =
      entity.entity.content.kind === "text"
        ? entity.entity.content.text.slice(0, 4_000)
        : "";
    const symbolHay = `${symbolName(entity)} ${meta?.kind === "code" ? (meta.scope ?? "") : ""}`;
    const identityHay = `${symbolHay} ${entity.file.relativePath}`;
    const contentHay = content;
    const identityHits = semanticTermCoverage(identityHay, terms);
    const contentHits = semanticTermCoverage(contentHay, terms);
    const nameAffinity = terms.reduce(
      (total, term) =>
        total + identifierPrefixAffinity(symbolName(entity), term),
      0,
    );
    const lowValuePenalty =
      !asksForLowValue && isLowValuePath(entity.file.relativePath) ? 40 : 0;
    const preciseName = /[._$]|::|[a-z][A-Z]|^[A-Z]/.test(symbolName(entity));
    const nameMatch = nameMatchedIds.has(entity.entity.id);
    const retrievalScore =
      retrievalRank === undefined
        ? 0
        : 16 * Math.max(0, 1 - retrievalRank / Math.max(1, limit * 4));
    const score =
      (exact ? (preciseName ? 100 : 30) : 0) +
      retrievalScore +
      identityHits * 12 +
      nameAffinity * 18 +
      (identityHits >= 2 ? 20 : 0) +
      contentHits * 3 +
      (contentHits >= 2 ? 4 : 0) +
      (TYPEISH_KINDS.has(kind) ? 4 : 0) -
      lowValuePenalty;
    // Paths remain weak retrieval evidence above, but only symbol identity may
    // consume a concept slot. Otherwise every symbol below a directory named
    // after the query appears equally novel and crowds out the actual API.
    const coveredTerms = semanticTermsCovered(symbolHay, terms);
    const callable = isCallableSymbolKind(kind);
    return {
      entity,
      id: entity.entity.id,
      score,
      exact,
      retrievalRank,
      nameMatch,
      callable,
      structural: structuralIds.has(entity.entity.id),
      coverage: coveredTerms.size,
      coveredTerms,
    };
  });
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  // Explicit code-shaped identifiers are stable anchors. Natural-language
  // words remain retrieval evidence; they do not each reserve a graph root.
  const selected: string[] = [];
  const selectedIds = new Set<string>();
  const byId = new Map(scored.map((candidate) => [candidate.id, candidate]));
  const softAnchorIds = new Set(softAnchorGroups.flat());
  anchorGroups.sort(
    (left, right) =>
      Number(!left.some((id) => byId.get(id)?.callable)) -
      Number(!right.some((id) => byId.get(id)?.callable)),
  );
  for (const group of anchorGroups) {
    const anchor = group
      .map((id) => byId.get(id))
      .filter((candidate): candidate is ScoredSeed => Boolean(candidate))
      .sort(
        (left, right) =>
          right.score - left.score || left.id.localeCompare(right.id),
      )
      .find((candidate) => !selectedIds.has(candidate.id));
    if (!anchor) continue;
    selected.push(anchor.id);
    selectedIds.add(anchor.id);
  }
  const hardAnchorCount = selected.length;

  const structuralAnchor =
    hardAnchorCount === 0 && !hasQualifiedAnchor
      ? scored.find(
          (candidate) =>
            candidate.nameMatch &&
            candidate.structural &&
            candidate.coverage > 0 &&
            (explicitReferences.length === 0 ||
              explicitReferences.some((reference) =>
                semanticIdentityTerms(symbolName(candidate.entity)).includes(
                  lower(symbolLookupLeaf(reference)),
                ),
              )) &&
            !selectedIds.has(candidate.id),
        )
      : undefined;
  if (structuralAnchor) {
    selected.push(structuralAnchor.id);
    selectedIds.add(structuralAnchor.id);
  }

  // Seeds restart graph propagation; they are not the final context. A long
  // prose question therefore receives only a bounded number of concept roots.
  const matchedQueryTerms = new Set(
    [...nameMatchedIds]
      .map((id) => candidates.get(id)?.entity)
      .filter((entity): entity is StoredEntity => Boolean(entity))
      .map((entity) => lower(symbolName(entity)))
      .filter((name) => terms.includes(name)),
  );
  const terseSymbolList =
    (explicitReferences.length >= 2 &&
      nameTerms.length <= explicitReferences.length + 2) ||
    (nameTerms.length <= 4 && matchedQueryTerms.size >= 2);
  const structuralFamilyQuery =
    Boolean(structuralAnchor) && nameTerms.length === 1;
  if (
    !terseSymbolList &&
    !structuralFamilyQuery &&
    !selected.some((id) => byId.get(id)?.callable)
  ) {
    const available = (candidate: ScoredSeed) =>
      !selectedIds.has(candidate.id) && !softAnchorIds.has(candidate.id);
    const anchorFiles = new Set(
      selected.map((id) => byId.get(id)?.entity.file.id).filter(Boolean),
    );
    const anchorFileCallable = scored.find(
      (candidate) =>
        available(candidate) &&
        candidate.callable &&
        (candidate.nameMatch || candidate.retrievalRank !== undefined) &&
        anchorFiles.has(candidate.entity.file.id),
    );
    const retrieved =
      scored.find(
        (candidate) => available(candidate) && candidate.retrievalRank === 0,
      ) ?? scored.find(available);
    const sameFileCallable =
      retrieved && !retrieved.callable
        ? scored
            .filter(
              (candidate) =>
                candidate.callable &&
                (candidate.nameMatch ||
                  candidate.retrievalRank !== undefined) &&
                candidate.entity.file.id === retrieved.entity.file.id &&
                !softAnchorIds.has(candidate.id),
            )
            .sort(
              (left, right) =>
                Number(right.nameMatch) - Number(left.nameMatch) ||
                (left.retrievalRank ?? Number.MAX_SAFE_INTEGER) -
                  (right.retrievalRank ?? Number.MAX_SAFE_INTEGER) ||
                right.score - left.score ||
                left.id.localeCompare(right.id),
            )[0]
        : undefined;
    const primary =
      anchorFileCallable ??
      sameFileCallable ??
      scored.find(
        (candidate) =>
          available(candidate) &&
          candidate.callable &&
          candidate.coverage >= 2 &&
          candidate.retrievalRank !== undefined,
      ) ??
      retrieved;
    if (primary) {
      selected.push(primary.id);
      selectedIds.add(primary.id);
    }
  }
  const flowSeedIds = [...selected];
  for (const group of softAnchorGroups) {
    const id = connectedSoftAnchor(storage, group, byId, selectedIds, limit);
    if (!id || selectedIds.has(id)) continue;
    selected.push(id);
    selectedIds.add(id);
  }
  const connectedSeedIds = incomingExecutionCandidates(
    storage,
    flowSeedIds,
    new Set(scored.map(({ id }) => id)),
    limit,
  );
  if (terseSymbolList) {
    for (const term of nameTerms) {
      if (
        selected.some(
          (id) => lower(symbolName(byId.get(id)!.entity)) === lower(term),
        )
      )
        continue;
      const candidate = scored.find(
        (item) =>
          !selectedIds.has(item.id) &&
          item.nameMatch &&
          lower(symbolName(item.entity)) === lower(term),
      );
      if (!candidate) continue;
      selected.push(candidate.id);
      selectedIds.add(candidate.id);
      if (selected.length >= limit) break;
    }
    return selected.slice(0, limit);
  }
  const conceptSlots = Math.min(
    hasQualifiedAnchor ? 4 : limit,
    Math.max(1, terms.length),
  );
  const exactNameTarget = Math.min(
    limit,
    new Set(
      scored
        .filter((candidate) => candidate.exact)
        .map((candidate) => lower(symbolName(candidate.entity))),
    ).size,
  );
  const selectedNonExactCount = selected.filter(
    (id) => !byId.get(id)?.exact,
  ).length;
  const seedTarget = Math.min(
    limit,
    Math.max(
      1,
      exactNameTarget + selectedNonExactCount,
      hasQualifiedAnchor
        ? Math.max(
            selected.length,
            hardAnchorCount + 2,
            Math.min(3, conceptSlots),
          )
        : terseSymbolList
          ? Math.max(selected.length, nameTerms.length)
          : Math.max(
              selected.length,
              conceptSlots + Number(hardAnchorCount > 0),
            ),
    ),
  );
  while (selected.length < seedTarget) {
    const coveredTerms = new Set(
      selected.flatMap((id) => [...(byId.get(id)?.coveredTerms ?? [])]),
    );
    const remaining = scored.filter(
      (item) =>
        !selectedIds.has(item.id) &&
        (item.exact ||
          (item.coverage >= 2 && item.retrievalRank !== undefined) ||
          (item.coverage > 0 &&
            item.callable &&
            item.retrievalRank !== undefined) ||
          (item.coverage > 0 &&
            item.nameMatch &&
            (item.callable || item.structural)) ||
          (item.coverage > 0 && connectedSeedIds.has(item.id))),
    );
    const novel = remaining.filter(
      (item) =>
        item.exact ||
        [...item.coveredTerms].some((term) => !coveredTerms.has(term)),
    );
    const candidate = novel.sort(
      (left, right) =>
        Number(right.exact) - Number(left.exact) ||
        Number(connectedSeedIds.has(right.id)) -
          Number(connectedSeedIds.has(left.id)) ||
        seedMarginalScore(right, coveredTerms) -
          seedMarginalScore(left, coveredTerms) ||
        Number(right.nameMatch) - Number(left.nameMatch) ||
        right.score - left.score ||
        left.id.localeCompare(right.id),
    )[0];
    if (!candidate) break;
    if (selected.length >= seedTarget) break;
    const name = symbolName(candidate.entity).trim().toLowerCase();
    const sameNamePreferred = name
      ? scored
          .filter(
            (item) =>
              !selectedIds.has(item.id) &&
              lower(symbolName(item.entity)) === name,
          )
          .sort(
            (left, right) =>
              Number(
                selected.some(
                  (id) => byId.get(id)?.entity.file.id === right.entity.file.id,
                ),
              ) -
                Number(
                  selected.some(
                    (id) =>
                      byId.get(id)?.entity.file.id === left.entity.file.id,
                  ),
                ) ||
              right.score - left.score ||
              left.id.localeCompare(right.id),
          )[0]
      : undefined;
    if (sameNamePreferred && sameNamePreferred.id !== candidate.id) {
      selectedIds.add(candidate.id);
      continue;
    }
    if (
      name &&
      selected.some((id) => lower(symbolName(byId.get(id)!.entity)) === name)
    ) {
      selectedIds.add(candidate.id);
      continue;
    }
    selected.push(candidate.id);
    selectedIds.add(candidate.id);
  }
  return [
    ...new Set(
      selected.map((id) => {
        const candidate = byId.get(id);
        if (!candidate || candidate.callable || candidate.exact) return id;
        return (
          scored.find(
            (item) =>
              item.callable &&
              item.nameMatch &&
              item.entity.file.id === candidate.entity.file.id,
          )?.id ?? id
        );
      }),
    ),
  ];
}

function seedMarginalScore(
  candidate: ScoredSeed,
  covered: ReadonlySet<string>,
): number {
  const novel = [...candidate.coveredTerms].filter(
    (term) => !covered.has(term),
  ).length;
  return candidate.score + novel * 12 + Number(candidate.callable) * 8;
}

function incomingExecutionCandidates(
  storage: GraphReader,
  roots: readonly string[],
  candidateIds: ReadonlySet<string>,
  limit: number,
): Set<string> {
  const found = new Set<string>();
  const seen = new Set(roots);
  let frontier = [...roots];
  for (let depth = 0; depth < 3 && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const edge of storage.incomingEdges?.(
      frontier,
      ["CALLS", "REFS"],
      Math.max(64, limit * 16),
    ) ?? []) {
      if (edge.kind === "REFS" && edge.rel !== "function") continue;
      if (seen.has(edge.src)) continue;
      seen.add(edge.src);
      next.push(edge.src);
      if (candidateIds.has(edge.src)) found.add(edge.src);
    }
    frontier = next;
  }
  return found;
}

function connectedSoftAnchor(
  storage: GraphReader,
  group: readonly string[],
  candidates: ReadonlyMap<string, ScoredSeed>,
  selectedIds: ReadonlySet<string>,
  limit: number,
): string | undefined {
  const ids = group.filter((id) => candidates.has(id));
  if (ids.length <= 1) return ids[0];
  const groupIds = new Set(ids);
  const directlyConnected = new Set<string>();
  const connectedScore = new Map(ids.map((id) => [id, 0]));
  const edgeLimit = Math.min(2_048, Math.max(64, ids.length * limit * 4));
  const contextIds = [
    ...new Set([
      ...selectedIds,
      ...[...candidates.values()]
        .filter((candidate) => candidate.exact)
        .map((candidate) => candidate.id),
    ]),
  ];
  for (const edge of storage.incomingEdges?.(
    ids,
    ["CALLS", "REFS", "INSTANTIATES"],
    edgeLimit,
  ) ?? []) {
    if (!groupIds.has(edge.dst)) continue;
    const source = candidates.get(edge.src);
    if (!source) continue;
    if (selectedIds.has(edge.src)) directlyConnected.add(edge.dst);
    connectedScore.set(
      edge.dst,
      Math.max(
        connectedScore.get(edge.dst) ?? 0,
        source.score + Number(selectedIds.has(edge.src)) * 1_000,
      ),
    );
  }
  for (const boundary of storage.dynamicBoundaries?.(contextIds, edgeLimit) ??
    [])
    for (const candidate of boundary.candidateDetails)
      if (groupIds.has(candidate.targetId))
        directlyConnected.add(candidate.targetId);
  return ids.sort(
    (left, right) =>
      Number(directlyConnected.has(right)) -
        Number(directlyConnected.has(left)) ||
      (connectedScore.get(right) ?? 0) - (connectedScore.get(left) ?? 0),
  )[0];
}

/**
 * Generic identifier-prefix evidence used only for candidate ranking. It
 * operates on language-neutral identifier components and does not assume
 * suffixes such as Base, Interface, or Trait.
 */
function identifierPrefixAffinity(name: string, rawTerm: string): number {
  const term = rawTerm.trim().toLowerCase();
  if (term.length < 2) return 0;
  const components = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((part) => part.toLowerCase())
    .filter(Boolean);
  let best = 0;
  for (const component of components) {
    if (!component.startsWith(term)) continue;
    best = Math.max(best, term.length / component.length);
  }
  return best;
}

export type ExploreSeedGroup = {
  key: string;
  ids: string[];
  representative: StoredEntity;
};

/**
 * Resolve an exact symbol query into semantic owner groups. A declaration and
 * its implementation normally have the same qualified identity and therefore
 * remain a single exploration concept, while unrelated co-named methods do
 * not get merged into one graph walk.
 *
 * `null` means the query is conceptual rather than an exact symbol lookup and
 * should continue through the ordinary multi-seed relevance path.
 */
export function resolveExactExploreSeedGroups(
  storage: GraphReader,
  query: string,
  limit: number,
): ExploreSeedGroup[] | null {
  const pathHint = explicitSourcePath(query);
  const lookupName = symbolLookupLeaf(query);
  const referencedMatches = pathHint
    ? explicitSymbolReferences(query)
        .filter((reference) => /(?:\.|::|->|#)/.test(reference))
        .map((reference) =>
          symbolsMatchingReferenceInPath(storage, reference, pathHint, limit),
        )
        .filter((matches) => matches.length > 0)
    : undefined;
  if ((referencedMatches?.length ?? 0) > 1) return null;
  let exact = pathHint
    ? (referencedMatches?.[0] ??
      symbolsNamedInPath(storage, query, pathHint, limit))
    : preferExactSymbolCase(
        storage
          .findSymbolsByName(query, limit * 8)
          .filter((entity) => matchesExactSymbolQuery(entity, query)),
        query,
      );
  if (exact.length === 0) return null;
  if (
    pathHint &&
    !referencedMatches?.[0] &&
    !isBarePathLookup(query, pathHint, exact)
  )
    return null;
  if (
    pathHint &&
    !referencedMatches?.[0] &&
    new Set(exact.map((entity) => lower(symbolName(entity)))).size > 1
  )
    return null;

  // Generic impl/container fragments commonly retain their type arguments in
  // the extracted name (`Router<S>`, `List<T>`), while the declaration and
  // user query use the erased name. Include only same-file type fragments with
  // the same erased identity; this joins a type to its implementation blocks
  // without merging unrelated co-named types from other packages.
  if (storage.findSymbolsByQuery) {
    exact = includeSameFileGenericTypeFragments(
      exact,
      storage.findSymbolsByQuery(lookupName, Math.max(512, limit * 32)),
      lookupName,
    );
  }

  const completeTypes = exact.filter(isCompleteTypeDefinition);
  const definitions = completeTypes.length > 0 ? completeTypes : exact;
  const production = definitions.filter(
    (entity) => !isLowValuePath(entity.file.relativePath),
  );
  const preferred = production.length > 0 ? production : definitions;
  return groupSemanticSymbols(preferred)
    .map((group) => ({
      key: group.key,
      ids: group.entities.map((entity) => entity.entity.id),
      representative: group.representative,
    }))
    .slice(0, limit);
}

function isBarePathLookup(
  query: string,
  pathHint: string,
  matches: readonly StoredEntity[],
): boolean {
  let residual = query.replace(pathHint, " ");
  for (const name of new Set(matches.map(symbolName)))
    residual = residual.replace(
      new RegExp(`\\b${escapeRegExp(name)}\\b`, "gi"),
      " ",
    );
  return !/[A-Za-z_][A-Za-z0-9_]{1,}/.test(residual);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function explicitSourcePath(query: string): string | undefined {
  return query
    .split(/\s+/)
    .map((part) => part.replace(/^[`'"([{]+|[`'"\])},;:]+$/g, ""))
    .find((part) => part.includes("/") && /\.[A-Za-z0-9]+$/.test(part));
}

function symbolsNamedInPath(
  storage: GraphReader,
  query: string,
  pathHint: string,
  limit: number,
): StoredEntity[] {
  const normalizedPath = pathHint.replaceAll("\\", "/").replace(/^\.\//, "");
  const pathTerms = new Set(queryNameTerms(normalizedPath).map(lower));
  const stem = fileStem(normalizedPath);
  const queryNames = queryNameTerms(query);
  const namesOutsidePath = queryNames.filter(
    (name) => !pathTerms.has(lower(name)),
  );
  const names =
    namesOutsidePath.length > 0
      ? namesOutsidePath
      : queryNames.filter((name) => lower(name) === stem);
  const byId = new Map<string, StoredEntity>();
  for (const name of names) {
    for (const entity of storage.findSymbolsByName(name, limit * 8)) {
      const path = entity.file.relativePath.replaceAll("\\", "/");
      if (
        lower(symbolName(entity)) === lower(name) &&
        (path === normalizedPath || path.endsWith(`/${normalizedPath}`))
      )
        byId.set(entity.entity.id, entity);
    }
  }
  return [...byId.values()];
}

function symbolsMatchingReferenceInPath(
  storage: GraphReader,
  reference: string,
  pathHint: string,
  limit: number,
): StoredEntity[] {
  const normalizedPath = pathHint.replaceAll("\\", "/").replace(/^\.\//, "");
  return storage
    .findSymbolsByName(reference, limit * 8)
    .filter(
      (entity) =>
        matchesExactSymbolQuery(entity, reference) &&
        (entity.file.relativePath === normalizedPath ||
          entity.file.relativePath.endsWith(`/${normalizedPath}`)),
    );
}

function lower(value: string): string {
  return value.toLowerCase();
}

function queryNameTerms(query: string): string[] {
  const raw = query.match(/[A-Za-z_][A-Za-z0-9_]{1,}/g) ?? [];
  const terms = new Map<string, string>();
  for (const token of raw) {
    const normalized = token.toLowerCase();
    if (normalized.length < 3 || QUERY_STOP_WORDS.has(normalized)) continue;
    if (!terms.has(normalized)) terms.set(normalized, token);
  }
  return [...terms.values()].slice(0, 16);
}

function explicitSymbolReferences(query: string): string[] {
  const qualified = [
    ...query.matchAll(
      /[A-Za-z_$][A-Za-z0-9_$]*(?:(?:::|\.|->)#?[A-Za-z_$][A-Za-z0-9_$]*)+/g,
    ),
  ];
  const qualifiedComponents = new Set(
    qualified.flatMap((match) =>
      match[0].split(/::|\.|->|#/).map(normalizeSymbolReference),
    ),
  );
  const privateNames = [...query.matchAll(/#[A-Za-z_$][A-Za-z0-9_$]*/g)].filter(
    (match) =>
      !qualifiedComponents.has(normalizeSymbolReference(match[0].slice(1))),
  );
  const codeShaped = [
    ...query.matchAll(
      /\b(?:[A-Z][A-Za-z0-9_$]*|[A-Za-z_$]*[a-z][A-Z][A-Za-z0-9_$]*)\b/g,
    ),
  ].filter(
    (match) =>
      !qualifiedComponents.has(normalizeSymbolReference(match[0])) &&
      !QUERY_STOP_WORDS.has(match[0].toLowerCase()) &&
      isCompoundIdentifier(match[0]),
  );
  return [
    ...new Map(
      [...qualified, ...privateNames, ...codeShaped]
        .sort((left, right) => left.index - right.index)
        .map((match) => [normalizeSymbolReference(match[0]), match[0]]),
    ).values(),
  ];
}

export function hasExplicitQualifiedSymbolReference(query: string): boolean {
  return explicitSymbolReferences(query).some((reference) =>
    /(?:\.|::|->|#)/.test(reference),
  );
}

export function qualifiedReferenceNames(query: string): string[] {
  return explicitSymbolReferences(query)
    .filter((reference) => /(?:\.|::|->|#)/.test(reference))
    .map(symbolLookupLeaf);
}

function isCompoundIdentifier(value: string): boolean {
  return /[a-z0-9][A-Z]|[_$]/.test(value) || /^[A-Z][A-Z0-9_]{1,}$/.test(value);
}

function explicitTypeReferences(query: string): string[] {
  return [
    ...query.matchAll(
      /\b([A-Za-z_$][A-Za-z0-9_$]*)\s+(?:class|interface|struct|trait|type)\b/gi,
    ),
  ].map((match) => match[1]!);
}

function normalizeSymbolReference(reference: string): string {
  const privatePrefix = reference.startsWith("#") ? "#" : "";
  return `${privatePrefix}${reference
    .slice(privatePrefix.length)
    .replace(/(?:\.|->|#)/g, "::")}`.toLowerCase();
}

function closestCallableReference(
  storage: GraphReader,
  reference: string,
  limit: number,
): StoredEntity | undefined {
  if (!storage.findSymbolsByQuery) return undefined;
  const terms = queryTerms(reference);
  if (terms.length < 2) return undefined;
  const retrieval = terms
    .map((term) => (term.length >= 7 ? term.slice(0, 6) : term))
    .join(" ");
  return storage
    .findSymbolsByQuery(retrieval, limit * 8)
    .filter((entity) => {
      const metadata = entity.entity.metadata;
      const nameCoverage = semanticTermsCovered(symbolName(entity), terms);
      return (
        metadata?.kind === "code" &&
        isCallableSymbolKind(metadata.symbolType) &&
        nameCoverage.size * 4 >= terms.length * 3 &&
        semanticTermsCovered(
          `${symbolName(entity)} ${entity.file.relativePath}`,
          terms,
        ).size === terms.length
      );
    })
    .sort(
      (left, right) =>
        symbolName(left).length - symbolName(right).length ||
        left.entity.id.localeCompare(right.entity.id),
    )[0];
}

function qualifiedCallableReferences(
  candidates: readonly StoredEntity[],
  reference: string,
): StoredEntity[] {
  const components = reference.split(/::|\.|->|#/).filter(Boolean);
  const ownerTerms = queryTerms(components.slice(0, -1).join(" "));
  if (ownerTerms.length === 0) return [];
  return candidates
    .filter((entity) => {
      const metadata = entity.entity.metadata;
      return (
        !isLowValuePath(entity.file.relativePath) &&
        metadata?.kind === "code" &&
        isCallableSymbolKind(metadata.symbolType)
      );
    })
    .map((entity) => ({
      entity,
      ownerCoverage: semanticTermsCovered(
        `${entity.file.relativePath} ${entity.entity.metadata?.kind === "code" ? (entity.entity.metadata.scope ?? "") : ""}`,
        ownerTerms,
      ).size,
    }))
    .filter(({ ownerCoverage }) => ownerCoverage > 0)
    .sort(
      (left, right) =>
        right.ownerCoverage - left.ownerCoverage ||
        left.entity.entity.id.localeCompare(right.entity.entity.id),
    )
    .map(({ entity }) => entity);
}

function qualifiedOwnerCandidates(
  storage: GraphReader,
  reference: string,
  query: string,
  limit: number,
): StoredEntity[] {
  const components = reference.split(/::|\.|->|#/).filter(Boolean);
  const owner = components.at(-2);
  if (!owner) return [];
  const candidates = storage
    .findSymbolsByName(owner, limit)
    .filter((entity) => {
      const metadata = entity.entity.metadata;
      return (
        metadata?.kind === "code" &&
        !isCallableSymbolKind(metadata.symbolType) &&
        lower(symbolName(entity)) === lower(owner)
      );
    });
  const production = candidates.filter(
    (entity) => !isLowValuePath(entity.file.relativePath),
  );
  const packageName = query.match(/@[A-Za-z0-9_.-]+\/([A-Za-z0-9_.-]+)/)?.[1];
  return preferExactSymbolCase(
    [...(production.length > 0 ? production : candidates)].sort(
      (left, right) =>
        Number(
          Boolean(
            packageName &&
            right.file.relativePath
              .replaceAll("\\", "/")
              .toLowerCase()
              .split("/")
              .includes(packageName.toLowerCase()),
          ),
        ) -
          Number(
            Boolean(
              packageName &&
              left.file.relativePath
                .replaceAll("\\", "/")
                .toLowerCase()
                .split("/")
                .includes(packageName.toLowerCase()),
            ),
          ) || left.entity.id.localeCompare(right.entity.id),
    ),
    owner,
  );
}

function isCompleteTypeDefinition(entity: StoredEntity): boolean {
  const metadata = entity.entity.metadata;
  if (metadata?.kind !== "code" || !TYPEISH_KINDS.has(metadata.symbolType))
    return false;
  const text =
    entity.entity.content.kind === "text"
      ? entity.entity.content.text.trim()
      : "";
  // C/C++ forward declarations share the type name with the real definition.
  if (
    ["class_specifier", "struct_specifier", "union_specifier"].includes(
      metadata.nodeType ?? "",
    )
  )
    return text.includes("{");
  return !/^(?:class|struct|union)\s+[A-Za-z_]\w*(?:\s*<[^;]+>)?\s*;$/.test(
    text,
  );
}

export function isTypeishKind(kind: string): boolean {
  return TYPEISH_KINDS.has(kind);
}

export function symbolName(entity: StoredEntity): string {
  const meta = entity.entity.metadata;
  return meta?.kind === "code" ? (meta.symbolName ?? "") : "";
}

export function queryTerms(query: string): string[] {
  const raw = query.match(/[A-Za-z_][A-Za-z0-9_]{1,}/g) ?? [];
  const terms = new Set<string>();
  for (const token of raw) {
    const normalized = token.toLowerCase();
    const pieces = token
      .split(/(?=[A-Z])|_+/)
      .map((piece) => piece.toLowerCase())
      .filter((piece) => piece.length >= 3 && !QUERY_STOP_WORDS.has(piece));
    if (
      pieces.length < 2 &&
      normalized.length >= 3 &&
      !QUERY_STOP_WORDS.has(normalized)
    )
      terms.add(normalized);
    else for (const piece of pieces) terms.add(piece);
  }
  return [...terms].slice(0, 16);
}

const EVIDENCE_STOP_WORDS = new Set(["action", "actions", "final", "use"]);

/** Stable concepts for ranking; retrieval keeps the broader query vocabulary. */
export function queryEvidenceTerms(query: string): string[] {
  const result: string[] = [];
  for (const term of queryTerms(query)) {
    if (EVIDENCE_STOP_WORDS.has(term)) continue;
    const equivalent = result.findIndex((existing) =>
      equivalentSemanticTerms(existing, term),
    );
    if (equivalent < 0) result.push(term);
    else if (term.length < result[equivalent]!.length)
      result[equivalent] = term;
  }
  return result;
}

function equivalentSemanticTerms(left: string, right: string): boolean {
  return semanticTermVariants(left).some((leftVariant) =>
    semanticTermVariants(right).some(
      (rightVariant) =>
        Math.min(leftVariant.length, rightVariant.length) >= 4 &&
        (leftVariant.startsWith(rightVariant) ||
          rightVariant.startsWith(leftVariant)),
    ),
  );
}

/**
 * Counts query concepts represented by a symbol identity. Besides exact token
 * containment this accepts a conservative shared stem for long words, so
 * natural-language forms such as "validation" can match `PetValidator`
 * without making short identifiers such as `run` broadly ambiguous.
 */
export function semanticTermCoverage(
  identity: string,
  terms: readonly string[],
): number {
  return semanticTermsCovered(identity, terms).size;
}

export function semanticTermsCovered(
  identity: string,
  terms: readonly string[],
): Set<string> {
  const identityTerms = semanticIdentityTerms(identity);
  return new Set(
    terms.filter((term) =>
      identityTerms.some(
        (candidate) =>
          semanticTermVariants(term).some(
            (variant) =>
              candidate.startsWith(variant) || variant.startsWith(candidate),
          ) || hasLongSharedStem(candidate, term),
      ),
    ),
  );
}

function semanticTermVariants(term: string): string[] {
  const variants = new Set([term]);
  const addInflectionBase = (suffixLength: number) => {
    const base = term.slice(0, -suffixLength);
    if (base.length < 4) return;
    variants.add(base);
    variants.add(`${base}e`);
    if (base.at(-1) === base.at(-2)) variants.add(base.slice(0, -1));
  };
  if (term.length >= 7 && term.endsWith("ing")) addInflectionBase(3);
  if (term.length >= 6 && term.endsWith("ed")) addInflectionBase(2);
  if (term.length >= 6 && term.endsWith("ies"))
    variants.add(`${term.slice(0, -3)}y`);
  else if (term.length >= 5 && /(?:ches|shes|sses|xes|zes)$/.test(term))
    variants.add(term.slice(0, -2));
  else if (term.length >= 5 && /s$/.test(term) && !/(?:ss|us|is)$/.test(term))
    variants.add(term.slice(0, -1));
  // Let long derivational noun forms retrieve their related code identities.
  // A five-character minimum keeps short identifiers from becoming broad
  // workspace scans.
  for (const suffix of ["ization", "isation", "ation", "ition", "ment"]) {
    if (!term.endsWith(suffix)) continue;
    const base = term.slice(0, -suffix.length);
    if (base.length >= 5) variants.add(base);
    if (suffix === "ation" && base.length >= 3) variants.add(`${base}ate`);
  }
  return [...variants];
}

function semanticIdentityTerms(value: string): string[] {
  const raw = value.match(/[A-Za-z_][A-Za-z0-9_]{1,}/g) ?? [];
  const terms = new Set<string>();
  for (const token of raw) {
    const normalized = token.toLowerCase();
    if (normalized.length >= 3 && !QUERY_STOP_WORDS.has(normalized))
      terms.add(normalized);
    for (const piece of token.split(/(?=[A-Z])|_+/)) {
      const normalizedPiece = piece.toLowerCase();
      if (normalizedPiece.length >= 3 && !QUERY_STOP_WORDS.has(normalizedPiece))
        terms.add(normalizedPiece);
    }
  }
  return [...terms];
}

function hasLongSharedStem(left: string, right: string): boolean {
  if (left.length < 7 || right.length < 7) return false;
  let shared = 0;
  const limit = Math.min(left.length, right.length);
  while (shared < limit && left[shared] === right[shared]) shared += 1;
  return shared >= 6;
}
