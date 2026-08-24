import { dirname, relative, resolve, sep } from "node:path";
import type { FileInfo } from "../../types.js";
import { normalizePath, toDisplayPath } from "../../utils/path.js";

export type IndexedFile = {
  id: string;
  absolutePath: string;
  relativePath: string;
  rootPath: string;
  format: string;
};

/** Lookup table for import path → fileId within an indexed collection. */
export class FilePathIndex {
  private readonly byAbsolute = new Map<string, IndexedFile>();
  /** rootPath\0relativePath → file */
  private readonly byRootRelative = new Map<string, IndexedFile>();
  private readonly byId = new Map<string, IndexedFile>();
  /** Path suffix → unique file; null marks an ambiguous suffix. */
  private readonly byRelativeSuffix = new Map<string, IndexedFile | null>();
  /** Directory suffix → files in one physical directory; null is ambiguous. */
  private readonly byDirectorySuffix = new Map<
    string,
    { absoluteDirectory: string; files: IndexedFile[] } | null
  >();

  constructor(files: readonly FileInfo[] = []) {
    this.addFiles(files);
  }

  addFiles(files: readonly FileInfo[]): void {
    for (const file of files) {
      const entry: IndexedFile = {
        id: file.id,
        absolutePath: normalizePath(file.absolutePath),
        relativePath: toDisplayPath(file.relativePath),
        rootPath: normalizePath(file.rootPath),
        format: file.format,
      };
      this.byAbsolute.set(entry.absolutePath, entry);
      this.byRootRelative.set(
        `${entry.rootPath}\0${entry.relativePath}`,
        entry,
      );
      this.byId.set(entry.id, entry);
      const segments = entry.relativePath.split("/").filter(Boolean);
      for (let index = 0; index < segments.length; index++) {
        const suffix = segments.slice(index).join("/");
        this.addRelativeSuffix(suffix, entry);
        this.addRelativeSuffix(`${entry.format}\0${suffix}`, entry);
      }
      const directory = dirname(entry.relativePath).replace(/^\.$/, "");
      const directorySegments = directory.split("/").filter(Boolean);
      for (let index = 0; index < directorySegments.length; index++) {
        const suffix = directorySegments.slice(index).join("/");
        this.addDirectorySuffix(suffix, entry);
        this.addDirectorySuffix(`${entry.format}\0${suffix}`, entry);
      }
    }
  }

  getById(fileId: string): IndexedFile | undefined {
    return this.byId.get(fileId);
  }

  /** True if an absolute path (any extension variant already applied) is indexed. */
  hasAbsolute(absolutePath: string): boolean {
    return this.byAbsolute.has(normalizePath(absolutePath));
  }

  getByAbsolute(absolutePath: string): IndexedFile | undefined {
    return this.byAbsolute.get(normalizePath(absolutePath));
  }

  /**
   * Try candidate absolute paths (with extensions); return first indexed hit.
   */
  findAbsolute(candidates: readonly string[]): IndexedFile | undefined {
    for (const candidate of candidates) {
      const hit = this.getByAbsolute(candidate);
      if (hit) {
        return hit;
      }
    }
    return undefined;
  }

  /** Return a unique indexed file whose root-relative path has this suffix. */
  findUniqueRelativeSuffix(
    relativeSuffix: string,
    format?: string,
  ): IndexedFile | undefined {
    const suffix = toDisplayPath(relativeSuffix).replace(/^\/+/, "");
    return (
      this.byRelativeSuffix.get(format ? `${format}\0${suffix}` : suffix) ??
      undefined
    );
  }

  private addRelativeSuffix(key: string, entry: IndexedFile): void {
    const existing = this.byRelativeSuffix.get(key);
    if (existing === undefined) this.byRelativeSuffix.set(key, entry);
    else if (existing?.id !== entry.id) this.byRelativeSuffix.set(key, null);
  }

  private addDirectorySuffix(key: string, entry: IndexedFile): void {
    const absoluteDirectory = dirname(entry.absolutePath);
    const existing = this.byDirectorySuffix.get(key);
    if (existing === undefined) {
      this.byDirectorySuffix.set(key, {
        absoluteDirectory,
        files: [entry],
      });
      return;
    }
    if (existing === null) return;
    if (existing.absoluteDirectory !== absoluteDirectory) {
      this.byDirectorySuffix.set(key, null);
      return;
    }
    if (!existing.files.some((file) => file.id === entry.id))
      existing.files.push(entry);
  }

  /** Files in one uniquely identifiable package/source directory suffix. */
  filesInUniqueRelativeDirectorySuffix(
    relativeSuffix: string,
    format?: string,
  ): IndexedFile[] {
    const suffix = toDisplayPath(relativeSuffix).replace(/^\/+|\/$/g, "");
    const bucket = this.byDirectorySuffix.get(
      format ? `${format}\0${suffix}` : suffix,
    );
    return bucket
      ? [...bucket.files].sort((left, right) =>
          left.relativePath.localeCompare(right.relativePath),
        )
      : [];
  }

  dirOf(fileId: string): string | undefined {
    const file = this.byId.get(fileId);
    return file ? dirname(file.absolutePath) : undefined;
  }

  relativeToRoot(fileId: string, absolutePath: string): string | undefined {
    const file = this.byId.get(fileId);
    if (!file) {
      return undefined;
    }
    return toDisplayPath(relative(file.rootPath, normalizePath(absolutePath)));
  }

  /** All indexed absolute paths (for debugging / tests). */
  absolutePaths(): string[] {
    return [...this.byAbsolute.keys()];
  }

  /** Immutable snapshots used by language-aware workspace resolvers. */
  entries(): IndexedFile[] {
    return [...this.byId.values()];
  }

  filesInDirectory(
    rootPath: string,
    relativeDirectory: string,
    format?: string,
  ): IndexedFile[] {
    const normalizedRoot = normalizePath(rootPath);
    const normalizedDirectory = toDisplayPath(relativeDirectory).replace(
      /^\.\/?$/,
      "",
    );
    return [...this.byId.values()]
      .filter(
        (file) =>
          file.rootPath === normalizedRoot &&
          dirname(file.relativePath).replace(/^\.$/, "") ===
            normalizedDirectory &&
          (!format || file.format === format),
      )
      .sort((left, right) => {
        const testWeight = (path: string): number =>
          /(?:^|\/)(?:tests?|testdata)(?:\/|$)|_test\.go$/i.test(path) ? 1 : 0;
        return (
          testWeight(left.relativePath) - testWeight(right.relativePath) ||
          left.relativePath.localeCompare(right.relativePath)
        );
      });
  }

  filesInAbsoluteDirectory(
    absoluteDirectory: string,
    format?: string,
  ): IndexedFile[] {
    const normalizedDirectory = normalizePath(absoluteDirectory);
    return [...this.byId.values()]
      .filter(
        (file) =>
          dirname(file.absolutePath) === normalizedDirectory &&
          (!format || file.format === format),
      )
      .sort((left, right) =>
        left.relativePath.localeCompare(right.relativePath),
      );
  }
}

export function joinDisplay(...parts: string[]): string {
  return parts.join("/").replace(/\\/g, "/").replace(/\/+/g, "/");
}

export function toPosix(path: string): string {
  return path.split(sep).join("/");
}

export function resolveAbsolute(fromDir: string, spec: string): string {
  return normalizePath(resolve(fromDir, spec));
}
