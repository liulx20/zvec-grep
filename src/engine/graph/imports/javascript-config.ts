import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { FilePathIndex, IndexedFile } from "./path-index.js";

type PathRule = { pattern: string; targets: readonly string[] };
type JavaScriptConfig = {
  baseUrl?: string;
  paths: readonly PathRule[];
};

const configCache = new Map<string, JavaScriptConfig | null>();
const nearestCache = new Map<string, JavaScriptConfig | null>();
const packageCache = new Map<string, PackageManifest | null>();
let workspaceCache = new WeakMap<
  FilePathIndex,
  ReadonlyMap<string, JavaScriptPackage>
>();

type JavaScriptPackage = {
  directory: string;
  manifest: PackageManifest;
};

type PackageManifest = {
  name?: string;
  source?: string;
  module?: string;
  main?: string;
  browser?: string | Record<string, string>;
  exports?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

/** Absolute path candidates contributed by the nearest tsconfig/jsconfig. */
export function configuredJavaScriptImport(
  spec: string,
  from: IndexedFile,
): { candidates: string[]; pathAlias: boolean } {
  const config = nearestJavaScriptConfig(from);
  if (!config) return { candidates: [], pathAlias: false };
  for (const rule of config.paths) {
    const wildcard = matchPathPattern(rule.pattern, spec);
    if (wildcard === undefined) continue;
    return {
      candidates: rule.targets.map((target) =>
        target.includes("*") ? target.replaceAll("*", wildcard) : target,
      ),
      pathAlias: true,
    };
  }
  return {
    candidates: config.baseUrl ? [resolve(config.baseUrl, spec)] : [],
    pathAlias: false,
  };
}

/** Indexed workspace-package candidates for an npm-style import specifier. */
export function workspaceJavaScriptImport(
  spec: string,
  index: FilePathIndex,
): { candidates: string[]; workspace: boolean } {
  const packageName = importPackageName(spec);
  const pkg = packageName
    ? workspacePackages(index).get(packageName)
    : undefined;
  if (!pkg) return { candidates: [], workspace: false };
  const subpath = spec.slice(packageName!.length).replace(/^\//, "");
  const entries = subpath
    ? [
        exportEntry(pkg.manifest.exports, `./${subpath}`),
        subpath,
        `src/${subpath}`,
      ]
    : packageEntries(pkg.manifest);
  return {
    candidates: entries
      .flatMap(stringEntries)
      .map((entry) => resolve(pkg.directory, entry)),
    workspace: true,
  };
}

/** True only for aliases or dependencies explicitly declared as workspace-local. */
export function isConfiguredJavaScriptImport(
  spec: string,
  from: IndexedFile,
): boolean {
  if (configuredJavaScriptImport(spec, from).pathAlias) return true;
  const packageName = importPackageName(spec);
  if (!packageName) return false;
  const manifest = nearestPackageManifest(from);
  return [
    manifest?.dependencies,
    manifest?.devDependencies,
    manifest?.peerDependencies,
    manifest?.optionalDependencies,
  ].some((dependencies) =>
    dependencies?.[packageName]?.startsWith("workspace:"),
  );
}

export function resetJavaScriptConfigCache(): void {
  configCache.clear();
  nearestCache.clear();
  packageCache.clear();
  workspaceCache = new WeakMap();
}

function nearestJavaScriptConfig(from: IndexedFile): JavaScriptConfig | null {
  const cacheKey = `${from.rootPath}\0${dirname(from.absolutePath)}`;
  if (nearestCache.has(cacheKey)) return nearestCache.get(cacheKey) ?? null;
  let directory = dirname(from.absolutePath);
  let result: JavaScriptConfig | null = null;
  while (
    directory === from.rootPath ||
    directory.startsWith(`${from.rootPath}/`)
  ) {
    for (const name of ["tsconfig.json", "jsconfig.json"]) {
      const config = readConfig(join(directory, name));
      if (config) {
        result = config;
        break;
      }
    }
    if (result || directory === from.rootPath) break;
    directory = dirname(directory);
  }
  nearestCache.set(cacheKey, result);
  return result;
}

function readConfig(
  path: string,
  seen = new Set<string>(),
): JavaScriptConfig | null {
  if (configCache.has(path)) return configCache.get(path) ?? null;
  if (seen.has(path)) return null;
  seen.add(path);
  try {
    const value = JSON.parse(stripJsonComments(readFileSync(path, "utf8"))) as {
      extends?: string;
      compilerOptions?: {
        baseUrl?: string;
        paths?: Record<string, string[]>;
      };
    };
    const directory = dirname(path);
    const parent = value.extends
      ? readConfig(resolveExtendedConfig(value.extends, directory), seen)
      : null;
    const options = value.compilerOptions ?? {};
    const baseUrl = options.baseUrl
      ? resolve(directory, options.baseUrl)
      : parent?.baseUrl;
    const paths = options.paths
      ? Object.entries(options.paths).map(([pattern, targets]) => ({
          pattern,
          targets: targets.map((target) =>
            resolve(baseUrl ?? directory, target),
          ),
        }))
      : (parent?.paths ?? []);
    const config = { ...(baseUrl ? { baseUrl } : {}), paths };
    configCache.set(path, config);
    return config;
  } catch {
    configCache.set(path, null);
    return null;
  }
}

function workspacePackages(
  index: FilePathIndex,
): ReadonlyMap<string, JavaScriptPackage> {
  const cached = workspaceCache.get(index);
  if (cached) return cached;
  const packages = new Map<string, JavaScriptPackage>();
  const ambiguous = new Set<string>();
  for (const file of index.entries()) {
    if (!file.relativePath.endsWith("package.json")) continue;
    const manifest = readPackageManifest(file.absolutePath);
    const name = manifest?.name;
    if (!name || ambiguous.has(name)) continue;
    const existing = packages.get(name);
    const directory = dirname(file.absolutePath);
    if (existing && existing.directory !== directory) {
      packages.delete(name);
      ambiguous.add(name);
    } else packages.set(name, { directory, manifest });
  }
  workspaceCache.set(index, packages);
  return packages;
}

function nearestPackageManifest(from: IndexedFile): PackageManifest | null {
  let directory = dirname(from.absolutePath);
  while (
    directory === from.rootPath ||
    directory.startsWith(`${from.rootPath}/`)
  ) {
    const manifest = readPackageManifest(join(directory, "package.json"));
    if (manifest) return manifest;
    if (directory === from.rootPath) break;
    directory = dirname(directory);
  }
  return null;
}

function readPackageManifest(path: string): PackageManifest | null {
  if (packageCache.has(path)) return packageCache.get(path) ?? null;
  try {
    const manifest = JSON.parse(readFileSync(path, "utf8")) as PackageManifest;
    packageCache.set(path, manifest);
    return manifest;
  } catch {
    packageCache.set(path, null);
    return null;
  }
}

function importPackageName(spec: string): string | undefined {
  const parts = spec.split("/");
  return spec.startsWith("@")
    ? parts.length >= 2
      ? parts.slice(0, 2).join("/")
      : undefined
    : parts[0];
}

function packageEntries(manifest: PackageManifest): unknown[] {
  const main = manifest.source ?? manifest.module ?? manifest.main;
  const browser =
    typeof manifest.browser === "string"
      ? manifest.browser
      : main
        ? manifest.browser?.[`./${main.replace(/^\.\//, "")}`]
        : undefined;
  return [
    browser,
    manifest.source,
    manifest.module,
    manifest.main,
    exportEntry(manifest.exports, "."),
    "src/index",
    "index",
  ];
}

function exportEntry(exports: unknown, key: string): unknown {
  if (!exports || typeof exports !== "object" || Array.isArray(exports))
    return key === "." ? exports : undefined;
  const record = exports as Record<string, unknown>;
  return (
    record[key] ??
    (key === "." && !Object.keys(record).some((item) => item.startsWith("."))
      ? record
      : undefined)
  );
}

function stringEntries(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringEntries);
  if (value && typeof value === "object")
    return Object.values(value as Record<string, unknown>).flatMap(
      stringEntries,
    );
  return [];
}

function resolveExtendedConfig(spec: string, directory: string): string {
  const path = isAbsolute(spec) ? spec : resolve(directory, spec);
  return path.endsWith(".json") ? path : `${path}.json`;
}

function matchPathPattern(pattern: string, spec: string): string | undefined {
  const marker = pattern.indexOf("*");
  if (marker < 0) return pattern === spec ? "" : undefined;
  const prefix = pattern.slice(0, marker);
  const suffix = pattern.slice(marker + 1);
  return spec.startsWith(prefix) && spec.endsWith(suffix)
    ? spec.slice(prefix.length, spec.length - suffix.length)
    : undefined;
}

/** Remove JSONC comments and trailing commas without changing string content. */
function stripJsonComments(text: string): string {
  let output = "";
  let string = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    const next = text[index + 1];
    if (string) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') string = false;
      continue;
    }
    if (char === '"') string = true;
    if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index++;
      output += "\n";
    } else if (char === "/" && next === "*") {
      index += 2;
      while (
        index < text.length &&
        !(text[index] === "*" && text[index + 1] === "/")
      )
        index++;
      index++;
    } else output += char;
  }
  return output.replace(/,\s*([}\]])/g, "$1");
}
