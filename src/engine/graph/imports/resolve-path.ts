import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  resolveAbsolute,
  type FilePathIndex,
  type IndexedFile,
} from "./path-index.js";

const EXTENSION_RESOLUTION: Record<string, readonly string[]> = {
  typescript: [
    ".ts",
    ".tsx",
    ".d.ts",
    ".js",
    ".jsx",
    ".vue",
    ".svelte",
    "/index.ts",
    "/index.tsx",
    "/index.js",
  ],
  tsx: [
    ".tsx",
    ".ts",
    ".d.ts",
    ".js",
    ".jsx",
    ".vue",
    ".svelte",
    "/index.tsx",
    "/index.ts",
    "/index.js",
  ],
  javascript: [
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".vue",
    ".svelte",
    "/index.js",
    "/index.jsx",
  ],
  jsx: [".jsx", ".js", ".vue", ".svelte", "/index.jsx", "/index.js"],
  vue: [
    ".ts",
    ".js",
    ".vue",
    ".tsx",
    ".jsx",
    "/index.ts",
    "/index.js",
    "/index.vue",
  ],
  svelte: [
    ".ts",
    ".js",
    ".svelte",
    ".tsx",
    ".jsx",
    "/index.ts",
    "/index.js",
    "/index.svelte",
  ],
  python: [".py", "/__init__.py"],
  c: [".h", ".c"],
  cpp: [".h", ".hpp", ".hxx", ".cpp", ".cc", ".cxx"],
  rust: [".rs", "/mod.rs"],
  java: [".java"],
};

const NODE_BUILTINS = new Set([
  "assert",
  "buffer",
  "child_process",
  "crypto",
  "events",
  "fs",
  "http",
  "https",
  "os",
  "path",
  "stream",
  "url",
  "util",
  "node:fs",
  "node:path",
  "node:os",
  "node:util",
  "node:http",
  "node:crypto",
]);

const PYTHON_STDLIB = new Set([
  "os",
  "sys",
  "re",
  "json",
  "typing",
  "collections",
  "pathlib",
  "asyncio",
  "functools",
  "itertools",
  "datetime",
  "logging",
  "unittest",
  "pytest",
]);

const C_STD_HEADERS = new Set([
  "stdio.h",
  "stdlib.h",
  "string.h",
  "math.h",
  "stdint.h",
  "stddef.h",
  "stdbool.h",
  "assert.h",
  "ctype.h",
  "errno.h",
  "time.h",
  "unistd.h",
]);

export type ImportResolveResult =
  | { status: "resolved"; fileId: string; absolutePath: string }
  | { status: "external" }
  | { status: "failed" };

/**
 * Resolve an import/include specifier to an indexed file id.
 * v1: relative paths + language extension table; bare/stdlib → external.
 */
export function resolveImportPath(
  spec: string,
  fromFileId: string,
  language: string,
  index: FilePathIndex,
  options: { rustInlineModuleDepth?: number } = {},
): ImportResolveResult {
  const trimmed = spec.trim();
  if (!trimmed) {
    return { status: "failed" };
  }

  const from = index.getById(fromFileId);
  if (!from) {
    return { status: "failed" };
  }

  const fromDir = dirname(from.absolutePath);
  const extensions = EXTENSION_RESOLUTION[language] ?? [];

  if (
    ["javascript", "jsx", "typescript", "tsx", "svelte"].includes(language) &&
    trimmed.startsWith("$lib/")
  ) {
    const base = resolveAbsolute(
      from.rootPath,
      `src/lib/${trimmed.slice("$lib/".length)}`,
    );
    const hit = tryImportExtensions(base, index, extensions, language);
    return hit
      ? { status: "resolved", fileId: hit.id, absolutePath: hit.absolutePath }
      : { status: "failed" };
  }

  if (isExternalImportSpec(trimmed, language)) {
    return { status: "external" };
  }

  if (language === "go") {
    const modules = goWorkspaceModules(index);
    const targetModule = [...modules.values()]
      .filter(
        (module) =>
          trimmed === module.path || trimmed.startsWith(`${module.path}/`),
      )
      .sort((left, right) => right.path.length - left.path.length)[0];
    if (targetModule) {
      const packageDir =
        trimmed === targetModule.path
          ? ""
          : trimmed.slice(targetModule.path.length + 1);
      const hit = index.filesInAbsoluteDirectory(
        resolveAbsolute(targetModule.directory, packageDir),
        "go",
      )[0];
      return hit
        ? { status: "resolved", fileId: hit.id, absolutePath: hit.absolutePath }
        : { status: "failed" };
    }
    if (!trimmed.split("/")[0]?.includes(".")) return { status: "external" };
  }

  if (language === "java") {
    if (trimmed.endsWith(".*")) {
      const packagePath = trimmed.slice(0, -2).replaceAll(".", "/");
      const representative = index.filesInUniqueRelativeDirectorySuffix(
        packagePath,
        "java",
      )[0];
      return representative
        ? {
            status: "resolved",
            fileId: representative.id,
            absolutePath: representative.absolutePath,
          }
        : { status: "failed" };
    }
    const relativeClass = `${trimmed.replaceAll(".", "/")}.java`;
    const hit = index.findUniqueRelativeSuffix(relativeClass, "java");
    return hit
      ? { status: "resolved", fileId: hit.id, absolutePath: hit.absolutePath }
      : { status: "failed" };
  }

  if (language === "python" && trimmed.startsWith(".")) {
    const hit = resolvePythonRelative(trimmed, fromDir, index, extensions);
    return hit
      ? { status: "resolved", fileId: hit.id, absolutePath: hit.absolutePath }
      : { status: "failed" };
  }

  if (language === "python") {
    const modulePath = trimmed.replaceAll(".", "/");
    const hit =
      index.findUniqueRelativeSuffix(`${modulePath}.py`, "python") ??
      index.findUniqueRelativeSuffix(`${modulePath}/__init__.py`, "python");
    return hit
      ? { status: "resolved", fileId: hit.id, absolutePath: hit.absolutePath }
      : { status: "failed" };
  }

  if (language === "rust") {
    const workspacePackages = rustWorkspacePackages(index);
    const ownerPackage = rustOwnerPackage(from, workspacePackages);
    const crateName = ownerPackage?.name ?? readRustPackageName(from.rootPath);
    const cratePrefix = crateName
      ? trimmed === crateName
        ? ""
        : trimmed.startsWith(`${crateName}::`)
          ? trimmed.slice(crateName.length + 2)
          : null
      : null;
    const packageDirectory = ownerPackage?.directory ?? from.rootPath;
    let hit =
      cratePrefix !== null
        ? resolveRustCratePath(cratePrefix, packageDirectory, index)
        : trimmed.startsWith("crate::")
          ? resolveRustCratePath(
              trimmed.slice("crate::".length),
              packageDirectory,
              index,
            )
          : undefined;
    if (!hit && /^(?:self|super)::/.test(trimmed))
      hit = resolveRustLexicalPath(
        trimmed,
        from,
        packageDirectory,
        options.rustInlineModuleDepth ?? 0,
        index,
      );
    const rustBase =
      cratePrefix !== null || trimmed.startsWith("crate::")
        ? undefined
        : /^(?:self|super)::/.test(trimmed)
          ? undefined
          : trimmed.startsWith(".")
            ? resolveAbsolute(fromDir, trimmed)
            : resolveAbsolute(fromDir, trimmed.replaceAll("::", "/"));
    if (!hit && rustBase) hit = tryExtensions(rustBase, index, extensions);
    if (!hit && !/^(?:crate|self|super)::/.test(trimmed)) {
      hit = resolveRustWorkspaceImport(trimmed, workspacePackages, index);
    }
    if (hit)
      return {
        status: "resolved",
        fileId: hit.id,
        absolutePath: hit.absolutePath,
      };
    // Rust 2018+ permits external crates at the start of a use path without
    // `extern crate`. Local modules and indexed workspace packages have
    // already been tried above; an unresolved bare crate root is therefore an
    // external dependency, not a durable retry candidate.
    return /^(?:crate|self|super)::/.test(trimmed)
      ? { status: "failed" }
      : { status: "external" };
  }

  if (trimmed.startsWith(".")) {
    const base = resolveAbsolute(fromDir, trimmed);
    const hit = tryImportExtensions(base, index, extensions, language);
    return hit
      ? { status: "resolved", fileId: hit.id, absolutePath: hit.absolutePath }
      : { status: "failed" };
  }

  // C/C++ quoted include without ./ — try relative to including file.
  if ((language === "c" || language === "cpp") && !trimmed.includes("://")) {
    const base = resolveAbsolute(fromDir, trimmed);
    const hit = tryExtensions(base, index, extensions);
    if (hit) {
      return {
        status: "resolved",
        fileId: hit.id,
        absolutePath: hit.absolutePath,
      };
    }

    // Build systems commonly add include roots (for example `-Iinclude`) that
    // are not visible to the source parser. Resolve those includes only when
    // the indexed workspace contains one unique matching path suffix. This
    // models include-root lookup without guessing between duplicate vendored
    // headers or depending on file insertion order.
    const includeRootHit = tryRelativeSuffixes(trimmed, index, extensions);
    if (includeRootHit) {
      return {
        status: "resolved",
        fileId: includeRootHit.id,
        absolutePath: includeRootHit.absolutePath,
      };
    }
  }

  // Absolute-ish project paths like src/foo (no leading .)
  if (
    trimmed.startsWith("src/") ||
    trimmed.startsWith("@/") ||
    trimmed.startsWith("~/")
  ) {
    const rewritten = trimmed.replace(/^@\//, "src/").replace(/^~\//, "src/");
    const base = resolveAbsolute(from.rootPath, rewritten);
    const hit = tryImportExtensions(base, index, extensions, language);
    if (hit) {
      return {
        status: "resolved",
        fileId: hit.id,
        absolutePath: hit.absolutePath,
      };
    }
  }

  return { status: "failed" };
}

function resolveRustLexicalPath(
  spec: string,
  from: IndexedFile,
  packageDirectory: string,
  inlineModuleDepth: number,
  index: FilePathIndex,
): IndexedFile | undefined {
  const segments = spec.split("::").filter(Boolean);
  const moduleSegments = rustFileModuleSegments(from, packageDirectory);
  if (!moduleSegments) return undefined;
  if (segments[0] === "self") segments.shift();
  else {
    let parentCount = 0;
    while (segments[parentCount] === "super") parentCount++;
    segments.splice(0, parentCount);
    const fileParents = Math.max(0, parentCount - inlineModuleDepth);
    if (fileParents > moduleSegments.length) return undefined;
    moduleSegments.splice(moduleSegments.length - fileParents, fileParents);
  }
  return resolveRustModuleBoundary(
    [...moduleSegments, ...segments],
    packageDirectory,
    index,
  );
}

function rustFileModuleSegments(
  from: IndexedFile,
  packageDirectory: string,
): string[] | undefined {
  const absolute = from.absolutePath.replaceAll("\\", "/");
  const sourceRoot = `${packageDirectory.replaceAll("\\", "/")}/src/`;
  if (!absolute.startsWith(sourceRoot) || !absolute.endsWith(".rs"))
    return undefined;
  const relative = absolute.slice(sourceRoot.length);
  // Every file directly below src/bin is a separate crate root rather than a
  // module below the package library crate.
  if (/^bin\/[^/]+\.rs$/.test(relative)) return [];
  const parts = relative.split("/");
  const fileName = parts.pop();
  if (!fileName || fileName === "lib.rs" || fileName === "main.rs") return [];
  if (fileName !== "mod.rs") parts.push(fileName.slice(0, -3));
  return parts.filter(Boolean);
}

function tryRelativeSuffixes(
  spec: string,
  index: FilePathIndex,
  extensions: readonly string[],
): IndexedFile | undefined {
  const candidates = [spec];
  for (const extension of extensions) {
    candidates.push(`${spec}${extension}`);
  }
  for (const candidate of candidates) {
    const hit = index.findUniqueRelativeSuffix(candidate);
    if (hit) return hit;
  }
  return undefined;
}

const GO_MODULE_CACHE = new Map<string, string | null>();
const GO_WORKSPACE_CACHE = new WeakMap<
  FilePathIndex,
  ReadonlyMap<string, GoModule>
>();
const RUST_PACKAGE_CACHE = new Map<string, string | null>();
const RUST_WORKSPACE_CACHE = new WeakMap<
  FilePathIndex,
  ReadonlyMap<string, RustPackage>
>();

type RustPackage = { name: string; directory: string };
type GoModule = { path: string; directory: string };

function goWorkspaceModules(
  index: FilePathIndex,
): ReadonlyMap<string, GoModule> {
  const cached = GO_WORKSPACE_CACHE.get(index);
  if (cached) return cached;
  const candidateDirectories = new Set<string>();
  for (const file of index.entries()) {
    if (file.format !== "go") continue;
    let directory = dirname(file.absolutePath);
    while (
      directory === file.rootPath ||
      directory.startsWith(`${file.rootPath}/`)
    ) {
      candidateDirectories.add(directory);
      if (directory === file.rootPath) break;
      directory = dirname(directory);
    }
  }
  const modules = new Map<string, GoModule>();
  const ambiguous = new Set<string>();
  for (const directory of candidateDirectories) {
    const path = readGoModulePath(directory);
    if (!path || ambiguous.has(path)) continue;
    const existing = modules.get(path);
    if (existing && existing.directory !== directory) {
      modules.delete(path);
      ambiguous.add(path);
    } else if (!existing) modules.set(path, { path, directory });
  }
  GO_WORKSPACE_CACHE.set(index, modules);
  return modules;
}

function rustWorkspacePackages(
  index: FilePathIndex,
): ReadonlyMap<string, RustPackage> {
  const cached = RUST_WORKSPACE_CACHE.get(index);
  if (cached) return cached;
  const directories = new Set<string>();
  for (const file of index.entries()) {
    if (file.format !== "rust") continue;
    const normalized = file.absolutePath.replaceAll("\\", "/");
    const marker = normalized.lastIndexOf("/src/");
    if (marker > 0) directories.add(normalized.slice(0, marker));
  }
  const packages = new Map<string, RustPackage>();
  const ambiguous = new Set<string>();
  for (const directory of directories) {
    const name = readRustPackageName(directory);
    if (!name || ambiguous.has(name)) continue;
    // Duplicate Cargo package names are invalid within one workspace. Keep a
    // missing entry on conflict rather than resolving by insertion order.
    const existing = packages.get(name);
    if (existing && existing.directory !== directory) {
      packages.delete(name);
      ambiguous.add(name);
    } else if (!existing) packages.set(name, { name, directory });
  }
  RUST_WORKSPACE_CACHE.set(index, packages);
  return packages;
}

function rustOwnerPackage(
  from: IndexedFile,
  packages: ReadonlyMap<string, RustPackage>,
): RustPackage | undefined {
  const absolute = from.absolutePath.replaceAll("\\", "/");
  return [...packages.values()]
    .filter(
      (item) =>
        absolute === item.directory ||
        absolute.startsWith(`${item.directory}/`),
    )
    .sort((left, right) => right.directory.length - left.directory.length)[0];
}

function resolveRustWorkspaceImport(
  spec: string,
  packages: ReadonlyMap<string, RustPackage>,
  index: FilePathIndex,
): IndexedFile | undefined {
  const [crate, ...segments] = spec.split("::");
  const pkg = crate ? packages.get(crate.replaceAll("-", "_")) : undefined;
  if (!pkg) return undefined;
  return resolveRustModuleBoundary(segments, pkg.directory, index);
}

function resolveRustCratePath(
  spec: string,
  packageDirectory: string,
  index: FilePathIndex,
): IndexedFile | undefined {
  return resolveRustModuleBoundary(spec.split("::"), packageDirectory, index);
}

function resolveRustModuleBoundary(
  segments: readonly string[],
  packageDirectory: string,
  index: FilePathIndex,
): IndexedFile | undefined {
  const pathSegments = segments.filter(
    (segment) => segment.length > 0 && segment !== "*",
  );
  // The final use-path components may be symbols or re-exports rather than
  // modules. Prefer the deepest indexed module, then fall back to the crate
  // root where top-level re-exports live.
  for (let length = pathSegments.length; length > 0; length -= 1) {
    const base = resolveAbsolute(
      packageDirectory,
      `src/${pathSegments.slice(0, length).join("/")}`,
    );
    const hit = tryExtensions(base, index, EXTENSION_RESOLUTION.rust!);
    if (hit) return hit;
  }
  return index.findAbsolute([
    resolveAbsolute(packageDirectory, "src/lib.rs"),
    resolveAbsolute(packageDirectory, "src/main.rs"),
  ]);
}

function readGoModulePath(rootPath: string): string | null {
  if (GO_MODULE_CACHE.has(rootPath))
    return GO_MODULE_CACHE.get(rootPath) ?? null;
  let modulePath: string | null = null;
  try {
    const text = readFileSync(join(rootPath, "go.mod"), "utf8");
    modulePath = text.match(/^\s*module\s+([^\s]+)\s*$/m)?.[1] ?? null;
  } catch {
    modulePath = null;
  }
  GO_MODULE_CACHE.set(rootPath, modulePath);
  return modulePath;
}

function readRustPackageName(rootPath: string): string | null {
  if (RUST_PACKAGE_CACHE.has(rootPath))
    return RUST_PACKAGE_CACHE.get(rootPath) ?? null;
  let packageName: string | null = null;
  try {
    const text = readFileSync(join(rootPath, "Cargo.toml"), "utf8");
    const packageSection = text.match(
      /(?:^|\n)\s*\[package\]\s*\n([\s\S]*?)(?=\n\s*\[|$)/,
    )?.[1];
    packageName =
      packageSection
        ?.match(/^\s*name\s*=\s*["']([^"']+)["']\s*$/m)?.[1]
        ?.replaceAll("-", "_") ?? null;
  } catch {
    packageName = null;
  }
  RUST_PACKAGE_CACHE.set(rootPath, packageName);
  return packageName;
}

export function isExternalImportSpec(spec: string, language: string): boolean {
  if (spec.startsWith(".")) {
    return false;
  }

  if (
    language === "typescript" ||
    language === "tsx" ||
    language === "javascript" ||
    language === "jsx"
  ) {
    if (
      NODE_BUILTINS.has(spec) ||
      NODE_BUILTINS.has(spec.split("/")[0] ?? "")
    ) {
      return true;
    }
    if (
      spec.startsWith("@/") ||
      spec.startsWith("~/") ||
      spec.startsWith("src/") ||
      spec.startsWith("$lib/")
    ) {
      return false;
    }
    // Bare npm / scoped packages
    return true;
  }

  if (language === "python") {
    const root = spec.split(".")[0] ?? spec;
    return PYTHON_STDLIB.has(root);
  }

  if (language === "c" || language === "cpp") {
    return C_STD_HEADERS.has(spec);
  }

  if (language === "rust") {
    const root = spec.split("::", 1)[0];
    return root === "std" || root === "core" || root === "alloc";
  }

  return false;
}

function resolvePythonRelative(
  spec: string,
  fromDir: string,
  index: FilePathIndex,
  extensions: readonly string[],
): IndexedFile | undefined {
  const dots = spec.length - spec.replace(/^\.+/, "").length;
  const up = "../".repeat(Math.max(0, dots - 1));
  const rest = spec.slice(dots).replace(/\./g, "/");
  const base = resolveAbsolute(fromDir, up + rest);
  return tryExtensions(base, index, extensions);
}

function tryExtensions(
  baseAbsolute: string,
  index: FilePathIndex,
  extensions: readonly string[],
): IndexedFile | undefined {
  const candidates = [
    baseAbsolute,
    ...extensions.map((ext) =>
      ext.startsWith("/") ? `${baseAbsolute}${ext}` : `${baseAbsolute}${ext}`,
    ),
  ];
  return index.findAbsolute(candidates);
}

/**
 * TypeScript's NodeNext-style source commonly imports `./module.js` even
 * though the indexed source file is `module.ts` (the emitted file is the
 * `.js` target). Resolve the literal path first, then apply only the source
 * substitutions defined by TypeScript. Keeping the literal candidate first
 * prevents a mixed JS/TS tree from silently preferring a source sibling over
 * the file the import actually names.
 */
function tryImportExtensions(
  baseAbsolute: string,
  index: FilePathIndex,
  extensions: readonly string[],
  language: string,
): IndexedFile | undefined {
  if (
    language === "typescript" ||
    language === "tsx" ||
    language === "vue" ||
    language === "svelte"
  ) {
    const sourceCandidates = nodeNextSourceCandidates(baseAbsolute);
    if (sourceCandidates.length > 1) {
      const hit = index.findAbsolute(sourceCandidates);
      if (hit) return hit;
    }
  }
  return tryExtensions(baseAbsolute, index, extensions);
}

function nodeNextSourceCandidates(path: string): string[] {
  if (path.endsWith(".jsx")) {
    const stem = path.slice(0, -4);
    return [path, `${stem}.tsx`, `${stem}.ts`, `${stem}.d.ts`];
  }
  if (path.endsWith(".js")) {
    const stem = path.slice(0, -3);
    return [path, `${stem}.ts`, `${stem}.tsx`, `${stem}.d.ts`];
  }
  return [path];
}
