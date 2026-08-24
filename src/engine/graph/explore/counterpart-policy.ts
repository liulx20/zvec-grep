import type { StoredEntity } from "../../storage/index.js";
import { isCallableSymbolKind } from "../symbol-kinds.js";

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

export function isHeaderPath(path: string): boolean {
  return /\.(?:h|hh|hpp|hxx)$/i.test(path);
}

export function isSourcePath(path: string): boolean {
  return /\.(?:c|cc|cpp|cxx|m|mm)$/i.test(path);
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
  const ignored = new Set(["include", "src", "source", "lib", "neug"]);
  const directories = (path: string): Set<string> =>
    new Set(
      path
        .toLowerCase()
        .replaceAll("\\", "/")
        .split("/")
        .slice(0, -1)
        .filter((part) => part && !ignored.has(part)),
    );
  const declarationDirectories = directories(declaration);
  for (const part of directories(candidate))
    if (declarationDirectories.has(part)) return true;
  return false;
}

function platformPathSegment(path: string): string | undefined {
  return path
    .replaceAll("\\", "/")
    .toLowerCase()
    .split("/")
    .find((part) =>
      /^(?:aix|android|bsd|darwin|freebsd|haiku|hurd|ibmi|linux|netbsd|openbsd|os390|posix|qnx|solaris|sunos|unix|win|windows)$/.test(
        part,
      ),
    );
}
