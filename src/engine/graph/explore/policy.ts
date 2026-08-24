import type { StoredEntity } from "../../storage/index.js";
import { escapeRegExp } from "../../utils/regex.js";
import type { GraphQueryStorage } from "../ports.js";
import {
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
import type { GraphEdgeKind } from "../types.js";
import { TYPE_SYMBOL_KIND_SET } from "../symbol-kinds.js";

const TYPEISH_KINDS = TYPE_SYMBOL_KIND_SET;
const QUERY_STOP_WORDS = new Set([
  "about",
  "after",
  "before",
  "does",
  "from",
  "have",
  "how",
  "into",
  "reach",
  "that",
  "their",
  "then",
  "this",
  "through",
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
  dynamicBoundaryFiles: { maximum: 2, relevanceFloor: 0.6 },
  scoreBoosts: {
    dynamicBoundary: { maximum: 0.14, base: 0.06, perOccurrence: 0.015 },
    impact: { maximum: 0.22, base: 0.08, perHit: 0.04 },
  },
  traverseEdgeKinds: [
    "CALLS",
    "REFS",
    "INHERITS",
    "CONTAINS",
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
  return queryTargetsPathTerms(path, queryNameTerms(query));
}

export function resolveExploreSeeds(
  storage: GraphQueryStorage,
  query: string,
  seedId: string | undefined,
  limit: number,
): string[] {
  if (seedId) {
    return storage.getEntity(seedId) ? [seedId] : [];
  }

  const candidates = new Map<
    string,
    { entity: StoredEntity; exact: boolean; fullQuery: boolean }
  >();
  const seen = new Set<string>();
  const pushEntity = (
    entity: StoredEntity,
    exact = false,
    fullQuery = false,
  ) => {
    if (seen.has(entity.entity.id)) {
      const existing = candidates.get(entity.entity.id)!;
      if (exact) existing.exact = true;
      if (fullQuery) existing.fullQuery = true;
      return;
    }
    seen.add(entity.entity.id);
    candidates.set(entity.entity.id, { entity, exact, fullQuery });
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
  const canonicalTypeFamily = resolveCanonicalTypeFamily(storage, query, limit);
  if (canonicalTypeFamily.length > 0) return canonicalTypeFamily;
  if (candidates.size < limit && storage.findSymbolsByQuery) {
    for (const entity of storage.findSymbolsByQuery(query, limit * 4)) {
      pushEntity(entity, false, true);
    }
  }

  const nameTerms = queryNameTerms(query);
  for (const rawTerm of nameTerms) {
    const term = rawTerm.toLowerCase();
    const explicitAcronym = /^[A-Z][A-Z0-9_]{1,}$/.test(rawTerm);
    if (term.length < 2) {
      continue;
    }
    for (const entity of storage.findSymbolsByName(rawTerm, limit * 8)) {
      pushEntity(entity, symbolName(entity).toLowerCase() === term);
    }
    if (storage.findSymbolsByQuery && term.length >= 3) {
      // Per-term retrieval must be broader than the final seed budget. Common
      // concepts such as `repository`, `connection`, or `WAL` otherwise return
      // only the globally strongest matches and never give co-named symbols
      // (OwnerRepository, WalWriterSet) a chance to be scored for coherence.
      const termLimit = limit * (explicitAcronym ? 32 : 8);
      for (const entity of storage.findSymbolsByQuery(rawTerm, termLimit)) {
        pushEntity(entity);
      }
      // Morphology fallback is only useful when direct retrieval has not
      // already supplied enough identity-level evidence for this concept.
      if (term.length >= 7 && !retrievalCandidatesCoverTerm(candidates, term)) {
        for (const entity of storage.findSymbolsByQuery(
          term.slice(0, 6),
          termLimit,
        )) {
          pushEntity(entity);
        }
      }
    }
  }

  const terms = queryTerms(query);
  const asksForLowValue =
    /\b(?:test|tests|testing|spec|specs|docs?|documentation|example|benchmark|vendor|third[- ]party)\b/i.test(
      query,
    );
  const candidateValues = [...candidates.values()];
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
  const scored = valuesToScore.map(({ entity, exact, fullQuery }) => {
    const meta = entity.entity.metadata;
    const kind = meta?.kind === "code" ? meta.symbolType : "";
    const content =
      entity.entity.content.kind === "text"
        ? entity.entity.content.text.slice(0, 4_000)
        : "";
    const identityHay =
      `${symbolName(entity)} ${entity.file.relativePath}`.toLowerCase();
    const contentHay = content.toLowerCase();
    const identityHits = semanticTermCoverage(identityHay, terms);
    const contentHits = semanticTermCoverage(contentHay, terms);
    const lowValuePenalty =
      !asksForLowValue && isLowValuePath(entity.file.relativePath) ? 40 : 0;
    const preciseName = /[._$]|::|[a-z][A-Z]|^[A-Z]/.test(symbolName(entity));
    const score =
      (exact ? (preciseName ? 100 : 30) : 0) +
      (fullQuery ? 16 : 0) +
      identityHits * 12 +
      (identityHits >= 2 ? 20 : 0) +
      contentHits * 3 +
      (contentHits >= 2 ? 4 : 0) +
      (TYPEISH_KINDS.has(kind) ? 4 : 0) -
      lowValuePenalty;
    return {
      entity,
      id: entity.entity.id,
      score,
      coverage: semanticTermsCovered(`${identityHay} ${contentHay}`, terms)
        .size,
    };
  });
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  // A phrase such as "checkpoint recovery Open" describes several concepts.
  // Do not let many overloads of one exact token consume every seed slot:
  // reserve the best strict symbol match for each query token, then fill the
  // remaining budget from the global ranking.
  const selected: string[] = [];
  const selectedIds = new Set<string>();
  const selectedFileCounts = new Map<string, number>();
  // Lexical candidates are restart seeds, not the final context. One seed per
  // query concept gives graph propagation room to recover implementations and
  // collaborators; doubling this count made declarations, constructors and
  // overloads consume the complete file budget before traversal could rank
  // their neighbours.
  const seedTarget = Math.min(limit, Math.max(2, nameTerms.length + 1));
  const selectedNameCounts = new Map<string, number>();
  const explicitSymbolSequence = /(?:\.|::|->|#)/.test(query);
  const perFileSeedCap = explicitSymbolSequence ? 4 : 1;
  const orderedSeedTerms = [...nameTerms].sort((left, right) => {
    const acronym = (value: string): number =>
      Number(/^[A-Z][A-Z0-9_]{1,}$/.test(value));
    return (
      acronym(right) - acronym(left) ||
      nameTerms.indexOf(left) - nameTerms.indexOf(right)
    );
  });
  for (const rawTerm of orderedSeedTerms) {
    const normalizedTerm = rawTerm.toLowerCase();
    const explicitAcronym = /^[A-Z][A-Z0-9_]{1,}$/.test(rawTerm);
    const matches = scored.filter(({ entity }) =>
      semanticTermsCovered(symbolName(entity), [normalizedTerm]).has(
        normalizedTerm,
      ),
    );
    const rankedMatches = matches
      .map((candidate) => {
        const strict =
          symbolName(candidate.entity).trim().toLowerCase() === normalizedTerm;
        const typeish =
          candidate.entity.entity.metadata?.kind === "code" &&
          TYPEISH_KINDS.has(candidate.entity.entity.metadata.symbolType ?? "");
        const coherence = anchorCoherence(candidate.entity, selected, scored);
        return {
          ...candidate,
          strict,
          strictType: strict && typeish,
          acronymType: explicitAcronym && typeish,
          topLevelApi: strict ? topLevelCallableScore(candidate.entity) : 0,
          coherence,
          // Sharing only a language or a top-level `src` directory is weak
          // evidence in a monorepo. Require package-level proximity before a
          // generic exact token can outrank a semantically coherent symbol.
          anchored: selected.length === 0 || coherence >= 36,
        };
      })
      .sort(
        (left, right) =>
          // An explicit identifier term is stronger evidence than arbitrary
          // occurrences of that word in another symbol's body. Keep this as
          // a lexicographic tier rather than a numeric bonus: long API bodies
          // can otherwise accumulate enough content/coherence score to evict
          // an exact seed (`app.use` used to select createApplication).
          Number(right.acronymType) - Number(left.acronymType) ||
          Number(right.strictType) - Number(left.strictType) ||
          Number(right.anchored) - Number(left.anchored) ||
          Number(right.strict) - Number(left.strict) ||
          right.topLevelApi - left.topLevelApi ||
          right.coherence - left.coherence ||
          right.score - left.score ||
          left.id.localeCompare(right.id),
      );
    const best = rankedMatches.find(
      (candidate) =>
        !selectedIds.has(candidate.id) &&
        (selectedNameCounts.get(
          symbolName(candidate.entity).trim().toLowerCase(),
        ) ?? 0) < 1 &&
        (candidate.strict ||
          (selectedFileCounts.get(candidate.entity.file.id) ?? 0) <
            perFileSeedCap) &&
        (selected.length === 0 ||
          (candidate.strict &&
            candidate.entity.entity.metadata?.kind === "code" &&
            TYPEISH_KINDS.has(
              candidate.entity.entity.metadata.symbolType ?? "",
            )) ||
          terms.length < 3 ||
          explicitAcronym ||
          candidate.coverage >= 2 ||
          candidate.coherence >= 36),
    );
    if (best && !best.strict && selected.length > 0 && best.coherence < 12) {
      continue;
    }
    if (best && !selectedIds.has(best.id)) {
      selected.push(best.id);
      selectedIds.add(best.id);
      selectedFileCounts.set(
        best.entity.file.id,
        (selectedFileCounts.get(best.entity.file.id) ?? 0) + 1,
      );
      const selectedName = symbolName(best.entity).trim().toLowerCase();
      if (selectedName)
        selectedNameCounts.set(
          selectedName,
          (selectedNameCounts.get(selectedName) ?? 0) + 1,
        );
      if (selected.length >= seedTarget) break;
    }
  }
  // Fill the remaining slots from the broad text ranking. This is both the
  // fallback for conceptual queries and the second half of token-diverse seed
  // selection: a single matching token must not terminate phrase resolution.
  for (const candidate of scored) {
    if (selected.length >= seedTarget) break;
    if (selectedIds.has(candidate.id)) continue;
    if (
      terms.length >= 3 &&
      candidate.coverage < 2 &&
      anchorCoherence(candidate.entity, selected, scored) < 50
    )
      continue;
    const name = symbolName(candidate.entity).trim().toLowerCase();
    // Conceptual queries need one representative per symbol name. Exact-name
    // queries take the dedicated branch above and may still return overloads.
    if (name && (selectedNameCounts.get(name) ?? 0) >= 1) continue;
    const fileId = candidate.entity.file.id;
    if (
      (selectedFileCounts.get(fileId) ?? 0) >= perFileSeedCap &&
      candidate.coverage < 2
    )
      continue;
    selected.push(candidate.id);
    selectedIds.add(candidate.id);
    if (name)
      selectedNameCounts.set(name, (selectedNameCounts.get(name) ?? 0) + 1);
    selectedFileCounts.set(fileId, (selectedFileCounts.get(fileId) ?? 0) + 1);
  }
  return explicitSymbolSequence
    ? selected
    : diversifyConceptualSeedFiles(selected, scored, seedTarget);
}

/**
 * The original term lookup remains mandatory for recall. The full-query and
 * term windows can, however, already contain enough direct evidence to avoid
 * an additional broad morphology-prefix scan.
 */
function retrievalCandidatesCoverTerm(
  candidates: ReadonlyMap<string, { entity: StoredEntity }>,
  term: string,
): boolean {
  let hits = 0;
  for (const { entity } of candidates.values()) {
    const metadata = entity.entity.metadata;
    const identity = [
      metadata?.kind === "code" ? metadata.symbolName : "",
      metadata?.kind === "code" ? metadata.scope : "",
      entity.file.relativePath,
    ]
      .join(" ")
      .toLowerCase();
    if (!identity.includes(term)) continue;
    hits += 1;
    if (hits >= 2) return true;
  }
  return false;
}

function diversifyConceptualSeedFiles(
  selected: readonly string[],
  scored: readonly {
    id: string;
    entity: StoredEntity;
    coverage: number;
  }[],
  seedTarget: number,
): string[] {
  const result = [...selected];
  const byId = new Map(scored.map((candidate) => [candidate.id, candidate]));
  const selectedIds = new Set(result);
  const fileCounts = new Map<string, number>();
  for (const id of result) {
    const fileId = byId.get(id)?.entity.file.id;
    if (fileId) fileCounts.set(fileId, (fileCounts.get(fileId) ?? 0) + 1);
  }
  const desiredFiles = Math.min(seedTarget, 4);
  for (const replacement of scored) {
    if (fileCounts.size >= desiredFiles) break;
    if (selectedIds.has(replacement.id) || replacement.coverage < 2) continue;
    const replacementName = symbolName(replacement.entity).trim().toLowerCase();
    if (
      replacementName &&
      result.some((id) => {
        const candidate = byId.get(id);
        return (
          candidate &&
          symbolName(candidate.entity).trim().toLowerCase() === replacementName
        );
      })
    )
      continue;
    const replacementFile = replacement.entity.file.id;
    if (fileCounts.has(replacementFile)) continue;
    let replaceAt = -1;
    for (let index = result.length - 1; index >= 0; index -= 1) {
      const fileId = byId.get(result[index]!)?.entity.file.id;
      if (fileId && (fileCounts.get(fileId) ?? 0) > 1) {
        replaceAt = index;
        break;
      }
    }
    if (replaceAt < 0) break;
    const removedId = result[replaceAt]!;
    const removedFile = byId.get(removedId)?.entity.file.id;
    result[replaceAt] = replacement.id;
    selectedIds.delete(removedId);
    selectedIds.add(replacement.id);
    if (removedFile) {
      const next = (fileCounts.get(removedFile) ?? 1) - 1;
      if (next === 0) fileCounts.delete(removedFile);
      else fileCounts.set(removedFile, next);
    }
    fileCounts.set(replacementFile, 1);
  }
  return result;
}

/**
 * A short PascalCase query often names a type family rather than the literal
 * declaration (`Expr` -> `ExprBase`, `Syntax` -> `SyntaxNode`). Prefer the
 * shortest production type whose name starts with that family token. This is
 * deliberately limited to identifier-like PascalCase queries so lowercase
 * module/path searches keep their broad multi-seed behavior.
 */
function resolveCanonicalTypeFamily(
  storage: GraphQueryStorage,
  query: string,
  limit: number,
): string[] {
  const token = query.trim();
  if (!/^[A-Z][A-Za-z0-9_]{2,}$/.test(token) || !storage.findSymbolsByQuery)
    return [];
  const normalized = token.toLowerCase();
  const candidates = storage
    .findSymbolsByQuery(token, Math.max(2_048, limit * 32))
    .filter((entity) => {
      const metadata = entity.entity.metadata;
      return (
        metadata?.kind === "code" &&
        TYPEISH_KINDS.has(metadata.symbolType ?? "") &&
        symbolName(entity).toLowerCase().startsWith(normalized) &&
        !isLowValuePath(entity.file.relativePath)
      );
    })
    .sort((left, right) => {
      const leftName = symbolName(left);
      const rightName = symbolName(right);
      const conventional = (name: string): number =>
        new RegExp(
          `^${escapeRegExp(token)}(?:Base|Interface|Trait)$`,
          "i",
        ).test(name)
          ? 0
          : 1;
      return (
        conventional(leftName) - conventional(rightName) ||
        leftName.length - rightName.length ||
        leftName.localeCompare(rightName) ||
        left.entity.id.localeCompare(right.entity.id)
      );
    });
  const canonicalName = candidates[0]
    ? symbolName(candidates[0]).toLowerCase()
    : undefined;
  return candidates
    .filter((entity) => symbolName(entity).toLowerCase() === canonicalName)
    .slice(0, limit)
    .map((entity) => entity.entity.id);
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
  storage: GraphQueryStorage,
  query: string,
  limit: number,
): ExploreSeedGroup[] | null {
  const lookupName = symbolLookupLeaf(query);
  let exact = preferExactSymbolCase(
    storage
      .findSymbolsByName(lookupName, limit * 8)
      .filter((entity) => matchesExactSymbolQuery(entity, query)),
    query,
  );
  if (exact.length === 0) return null;

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

function anchorCoherence(
  entity: StoredEntity,
  selectedIds: readonly string[],
  candidates: readonly { id: string; entity: StoredEntity }[],
): number {
  if (selectedIds.length === 0) return 0;
  const selected = selectedIds
    .map((id) => candidates.find((candidate) => candidate.id === id)?.entity)
    .filter((candidate): candidate is StoredEntity => Boolean(candidate));
  let best = 0;
  for (const anchor of selected) {
    if (anchor.file.id === entity.file.id) return 100;
    const sharedSegments = sharedPathPrefix(
      anchor.file.relativePath,
      entity.file.relativePath,
    );
    const languageBonus =
      anchor.file.format === entity.file.format && entity.file.format ? 12 : 0;
    best = Math.max(best, Math.min(36, sharedSegments * 9) + languageBonus);
  }
  return best;
}

function topLevelCallableScore(entity: StoredEntity): number {
  const metadata = entity.entity.metadata;
  if (
    metadata?.kind !== "code" ||
    metadata.symbolType !== "function" ||
    metadata.scope
  )
    return 0;
  return metadata.modifiers.includes("public") ? 30 : 18;
}

function sharedPathPrefix(left: string, right: string): number {
  const leftParts = left.replaceAll("\\", "/").split("/").slice(0, -1);
  const rightParts = right.replaceAll("\\", "/").split("/").slice(0, -1);
  let count = 0;
  while (
    count < leftParts.length &&
    count < rightParts.length &&
    leftParts[count] === rightParts[count]
  ) {
    count += 1;
  }
  return count;
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
    if (normalized.length >= 3 && !QUERY_STOP_WORDS.has(normalized)) {
      terms.add(normalized);
    }
    for (const piece of token.split(/(?=[A-Z])|_+/)) {
      const normalizedPiece = piece.toLowerCase();
      if (
        normalizedPiece.length >= 3 &&
        !QUERY_STOP_WORDS.has(normalizedPiece)
      ) {
        terms.add(normalizedPiece);
      }
    }
  }
  return [...terms].slice(0, 16);
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
          candidate.includes(term) ||
          term.includes(candidate) ||
          hasLongSharedStem(candidate, term),
      ),
    ),
  );
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
