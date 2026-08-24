import type { StoredEntity } from "../../storage/index.js";
import {
  isHeaderPath,
  isSourcePath,
  platformPathSegment,
} from "../path-policy.js";
import { isCallableSymbolKind } from "../symbol-kinds.js";

export { isHeaderPath, isSourcePath } from "../path-policy.js";

const NON_SEMANTIC_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  "include",
  "src",
  "source",
  "lib",
  "main",
]);

export function platformDeclarationCounterparts(
  declaration: StoredEntity,
  candidates: readonly StoredEntity[],
): StoredEntity[] {
  const declarationPath = declaration.file.relativePath;
  const platform = platformPathSegment(declarationPath);
  const metadata = declaration.entity.metadata;
  if (
    !platform ||
    !isHeaderPath(declarationPath) ||
    metadata?.kind !== "code" ||
    !isCallableSymbolKind(metadata.symbolType)
  )
    return [];
  return candidates.filter((candidate) => {
    const candidateMetadata = candidate.entity.metadata;
    return (
      candidate.entity.id !== declaration.entity.id &&
      /\.(?:c|cc|cpp|cxx|m|mm)$/i.test(candidate.file.relativePath) &&
      platformPathSegment(candidate.file.relativePath) === platform &&
      candidateMetadata?.kind === "code" &&
      candidateMetadata.symbolType === metadata.symbolType &&
      candidateMetadata.symbolName === metadata.symbolName &&
      (metadata.arity == null ||
        candidateMetadata.arity == null ||
        candidateMetadata.arity === metadata.arity)
    );
  });
}

export function fileStem(path: string): string {
  return (
    path
      .replaceAll("\\", "/")
      .split("/")
      .at(-1)
      ?.replace(/\.[^.]+$/, "") ?? ""
  );
}

export function isCounterpartSourcePath(
  declaration: string,
  candidate: string,
): boolean {
  if (!isSourcePath(candidate)) return false;
  if (fileStem(declaration).toLowerCase() !== fileStem(candidate).toLowerCase())
    return false;
  return semanticPathAffinity(declaration, candidate) > 0;
}

/** Count meaningful directory segments shared by two source paths. */
export function semanticPathAffinity(
  left: string,
  right: string,
  additionallyIgnored: ReadonlySet<string> = new Set(),
): number {
  const parts = (path: string): Set<string> =>
    new Set(
      path
        .toLowerCase()
        .replaceAll("\\", "/")
        .split("/")
        .slice(0, -1)
        .filter(
          (part) =>
            part &&
            !NON_SEMANTIC_PATH_SEGMENTS.has(part) &&
            !additionallyIgnored.has(part),
        ),
    );
  const leftParts = parts(left);
  let score = 0;
  for (const part of parts(right)) if (leftParts.has(part)) score += 1;
  return score;
}
