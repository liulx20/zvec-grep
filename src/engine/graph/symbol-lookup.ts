import type { StoredEntity } from "../storage/index.js";
import { platformPathSegment } from "./path-policy.js";
import { TYPE_SYMBOL_KIND_SET } from "./symbol-kinds.js";

export function symbolLookupLeaf(query: string): string {
  return normalizeQualifiedSymbolName(query).split("::").at(-1) ?? query;
}

export function matchesExactSymbolQuery(
  entity: StoredEntity,
  query: string,
): boolean {
  // This is a user-facing lookup predicate, not a language resolver. Search
  // should find `Frame` when the user writes `frame`; if a case-sensitive
  // language contains both spellings they remain separate semantic groups and
  // the caller can surface the ambiguity instead of silently choosing one.
  return matchesSymbolQuery(entity, query, true);
}

/** Prefer language-exact casing, falling back to user-friendly folded case. */
export function preferExactSymbolCase(
  entities: readonly StoredEntity[],
  query: string,
): StoredEntity[] {
  const exact = entities.filter((entity) =>
    matchesSymbolQuery(entity, query, false),
  );
  return exact.length > 0 ? exact : [...entities];
}

export function collapseConstructorOverloads(
  entities: readonly StoredEntity[],
): StoredEntity[] {
  const typeCandidates = entities.filter((entity) => {
    const metadata = entity.entity.metadata;
    return (
      metadata?.kind === "code" &&
      (metadata.symbolType === "class" || metadata.symbolType === "interface")
    );
  });
  if (typeCandidates.length !== 1 || entities.length === 1)
    return [...entities];
  const type = typeCandidates[0]!;
  const typeMetadata = type.entity.metadata;
  if (typeMetadata?.kind !== "code" || !typeMetadata.symbolName)
    return [...entities];
  const typeQualifiedName = normalizeQualifiedSymbolName(
    typeMetadata.scope
      ? `${typeMetadata.scope}::${typeMetadata.symbolName}`
      : typeMetadata.symbolName,
  );
  const allBelongToType = entities.every((entity) => {
    if (entity.entity.id === type.entity.id) return true;
    const metadata = entity.entity.metadata;
    return (
      metadata?.kind === "code" &&
      metadata.symbolType === "function" &&
      metadata.symbolName === typeMetadata.symbolName &&
      normalizeQualifiedSymbolName(metadata.scope ?? "") === typeQualifiedName
    );
  });
  return allBelongToType ? [type] : [...entities];
}

export type SemanticSymbolGroup = {
  key: string;
  entities: StoredEntity[];
  representative: StoredEntity;
};

/**
 * Join generic implementation fragments to exact type matches using erased
 * source identity. The same-file guard is important: `Router<T>` in another
 * package remains an independent query seed.
 */
export function includeSameFileGenericTypeFragments(
  exact: readonly StoredEntity[],
  candidates: readonly StoredEntity[],
  lookupName: string,
): StoredEntity[] {
  if (!exact.some(isTypeEntity)) return [...exact];
  const fileIds = new Set(exact.map((entity) => entity.file.id));
  const erasedLookup = eraseGenericTypeName(lookupName).toLowerCase();
  return [
    ...new Map(
      [...exact, ...candidates]
        .filter(
          (entity) =>
            exact.includes(entity) ||
            (fileIds.has(entity.file.id) &&
              isTypeEntity(entity) &&
              eraseGenericTypeName(symbolName(entity)).toLowerCase() ===
                erasedLookup),
        )
        .map((entity) => [entity.entity.id, entity]),
    ).values(),
  ];
}

/**
 * Group declaration/definition fragments that describe one qualified symbol.
 * This is deliberately independent of graph traversal so Explore and the
 * callers/callees/impact endpoints cannot disagree about seed ambiguity.
 */
export function groupSemanticSymbols(
  entities: readonly StoredEntity[],
): SemanticSymbolGroup[] {
  const coarseGroups = new Map<string, StoredEntity[]>();
  for (const entity of entities) {
    const key = semanticSymbolKey(entity);
    const members = coarseGroups.get(key) ?? [];
    members.push(entity);
    coarseGroups.set(key, members);
  }
  const groups = [...coarseGroups.entries()].flatMap(([key, members]) =>
    splitIndependentDefinitions(key, members),
  );
  return groups
    .map(([key, members]) => ({
      key,
      entities: members,
      representative: [...members].sort(compareRepresentatives)[0]!,
    }))
    .sort((left, right) =>
      left.representative.entity.id.localeCompare(
        right.representative.entity.id,
      ),
    );
}

/**
 * A qualified name is not workspace-global in a monorepo. Keep a conventional
 * declaration + implementation pair together, but never collapse two concrete
 * definitions from different files into one query seed.
 */
function splitIndependentDefinitions(
  key: string,
  members: StoredEntity[],
): [string, StoredEntity[]][] {
  const definitionsByFile = new Map<string, StoredEntity[]>();
  for (const entity of members) {
    if (isDeclarationOnly(entity)) continue;
    const definitions = definitionsByFile.get(entity.file.id) ?? [];
    definitions.push(entity);
    definitionsByFile.set(entity.file.id, definitions);
  }
  if (
    definitionsByFile.size <= 1 ||
    isPlatformImplementationFamily(members, definitionsByFile)
  )
    return [[key, members]];

  const declarations = members.filter(isDeclarationOnly);
  const groups = [...definitionsByFile.entries()].map(
    ([fileId, definitions]): [string, StoredEntity[]] => [
      `${key}\0${fileId}`,
      [...definitions],
    ],
  );
  for (const declaration of declarations) {
    const target = groups
      .map((group) => ({
        group,
        score: pathAffinity(
          declaration.file.relativePath,
          group[1][0]!.file.relativePath,
        ),
      }))
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.group[0].localeCompare(right.group[0]),
      )[0];
    if (target && target.score > 0) target.group[1].push(declaration);
    else groups.push([`${key}\0${declaration.file.id}`, [declaration]]);
  }
  return groups;
}

function isPlatformImplementationFamily(
  members: readonly StoredEntity[],
  definitionsByFile: ReadonlyMap<string, readonly StoredEntity[]>,
): boolean {
  if (definitionsByFile.size < 2) return false;
  const declarations = members.filter(isDeclarationOnly);
  if (
    declarations.length === 0 ||
    !declarations.some((entity) =>
      /\.(?:h|hh|hpp|hxx)$/i.test(entity.file.relativePath),
    )
  )
    return false;
  const definitions = [...definitionsByFile.values()].flat();
  if (
    !definitions.every((entity) => {
      const metadata = entity.entity.metadata;
      return (
        metadata?.kind === "code" &&
        metadata.symbolType === "function" &&
        (entity.file.format === "c" || entity.file.format === "cpp")
      );
    })
  )
    return false;
  const arities = new Set(
    members
      .map((entity) => {
        const metadata = entity.entity.metadata;
        return metadata?.kind === "code" ? metadata.arity : null;
      })
      .filter((arity): arity is number => typeof arity === "number"),
  );
  if (arities.size > 1) return false;
  return definitions.every((entity) =>
    Boolean(platformPathSegment(entity.file.relativePath)),
  );
}

function isDeclarationOnly(entity: StoredEntity): boolean {
  const text =
    entity.entity.content.kind === "text"
      ? entity.entity.content.text.trim()
      : "";
  if (!text || text.includes("{")) return false;
  return /;\s*$/.test(text) || /^extern\b/.test(text);
}

function pathAffinity(leftPath: string, rightPath: string): number {
  const normalize = (path: string) =>
    path
      .replaceAll("\\", "/")
      .replace(/\.[^./]+$/, "")
      .split("/")
      .filter((part) => !["src", "include", "lib"].includes(part));
  const left = normalize(leftPath);
  const right = normalize(rightPath);
  let score = 0;
  while (
    score < left.length &&
    score < right.length &&
    left[left.length - 1 - score] === right[right.length - 1 - score]
  ) {
    score += 1;
  }
  return score;
}

function semanticSymbolKey(entity: StoredEntity): string {
  const metadata = entity.entity.metadata;
  if (metadata?.kind !== "code") return entity.entity.id;
  const scope = eraseGenericTypeName(
    normalizeQualifiedSymbolName(metadata.scope ?? ""),
  ).toLowerCase();
  const rawName = normalizeQualifiedSymbolName(metadata.symbolName ?? "");
  const name = (
    TYPE_SYMBOL_KIND_SET.has(metadata.symbolType ?? "")
      ? eraseGenericTypeName(rawName)
      : rawName
  ).toLowerCase();
  return `${metadata.symbolType ?? "symbol"}\0${scope}\0${name}`;
}

function isTypeEntity(entity: StoredEntity): boolean {
  const metadata = entity.entity.metadata;
  return (
    metadata?.kind === "code" &&
    TYPE_SYMBOL_KIND_SET.has(metadata.symbolType ?? "")
  );
}

function symbolName(entity: StoredEntity): string {
  const metadata = entity.entity.metadata;
  return metadata?.kind === "code" ? (metadata.symbolName ?? "") : "";
}

function eraseGenericTypeName(name: string): string {
  let depth = 0;
  let result = "";
  for (const character of name.trim()) {
    if (character === "<") {
      depth += 1;
      continue;
    }
    if (character === ">") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0) result += character;
  }
  return result.trim();
}

function compareRepresentatives(
  left: StoredEntity,
  right: StoredEntity,
): number {
  const implementationScore = (entity: StoredEntity): number => {
    const text =
      entity.entity.content.kind === "text"
        ? entity.entity.content.text.trim()
        : "";
    return Number(text.includes("{")) * 1_000 + text.length;
  };
  return (
    implementationScore(right) - implementationScore(left) ||
    left.entity.id.localeCompare(right.entity.id)
  );
}

function normalizeQualifiedSymbolName(value: string): string {
  return value.trim().replace(/(?:\.|::)+/g, "::");
}

function matchesSymbolQuery(
  entity: StoredEntity,
  query: string,
  foldCase: boolean,
): boolean {
  const metadata = entity.entity.metadata;
  if (metadata?.kind !== "code" || !metadata.symbolName) return false;
  const normalize = (value: string): string => {
    const normalized = normalizeQualifiedSymbolName(value);
    return foldCase ? normalized.toLowerCase() : normalized;
  };
  const normalizedQuery = normalize(query);
  const name = normalize(metadata.symbolName);
  if (!normalizedQuery.includes("::")) return name === normalizedQuery;
  const qualified = metadata.scope
    ? normalize(`${metadata.scope}::${metadata.symbolName}`)
    : name;
  return (
    qualified === normalizedQuery || qualified.endsWith(`::${normalizedQuery}`)
  );
}
