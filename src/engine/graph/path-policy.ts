import { basename, extname } from "node:path";

/** Shared path-value policy for graph retrieval and presentation. */
export function isTestPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return (
    /(^|\/)(?:__)?(?:tests?|specs?|test-?dts?|type-tests?|testdata|fixtures?|mocks?)(?:__)?(\/|$)|(^|\/)test_[^/]+\.[^/]+$|(^|\/)conftest\.py$|(?:\.|_|-)(?:test|spec|fixture|mock)(?:-d)?\.[^/]+$|_test\.[^/]+$/i.test(
      normalized,
    ) ||
    /(^|\/)(?:[a-z][a-z0-9]*)?(?:Test|Tests)(\/|$)/.test(normalized) ||
    /(?:Test|Tests|TestCase|Spec)\.(?:java|kt|kts|swift)$/.test(normalized)
  );
}

export function isLowValuePath(path: string): boolean {
  const normalized = path.toLowerCase().replaceAll("\\", "/");
  return (
    isTestPath(normalized) ||
    /(^|\/)readme(?:\.[^/]+)?$/.test(normalized) ||
    /(?:^|\/)(?:changelog|changes|history|release-notes?)(?:\.[^/]+)?$/.test(
      normalized,
    ) ||
    /\.(?:md|mdx|rst|adoc)$/.test(normalized) ||
    /(^|\/)_?(docs?|documentation|examples?|benchmarks?|benches|third_party|vendor|node_modules)(\/|$)/.test(
      normalized,
    )
  );
}

const PLATFORM_PATH_SEGMENTS = new Set(
  "aix android bsd darwin freebsd haiku hurd ibmi linux netbsd openbsd os390 posix qnx solaris sunos unix win windows".split(
    " ",
  ),
);

export function isHeaderPath(path: string | undefined): boolean {
  return Boolean(path && /\.(?:h|hh|hpp|hxx)$/i.test(path));
}

export function isSourcePath(path: string): boolean {
  return /\.(?:c|cc|cpp|cxx|m|mm)$/i.test(path);
}

export function fileStem(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  return basename(normalized, extname(normalized)).toLowerCase();
}

export function platformPathSegment(path: string): string | undefined {
  return path
    .replaceAll("\\", "/")
    .toLowerCase()
    .split("/")
    .find((part) => PLATFORM_PATH_SEGMENTS.has(part));
}

/**
 * Low-value paths are noise by default, not an access-control boundary. When
 * the user explicitly names a module represented by a path segment, keep that
 * module eligible without opening every vendor/test/doc candidate.
 */
export function queryTargetsPath(
  path: string,
  queryTerms: readonly string[],
): boolean {
  const segments = path.toLowerCase().replaceAll("\\", "/").split("/");
  const pathTerms = segments
    .slice(0, -1)
    .flatMap((segment) => segment.replace(/\.[^.]+$/, "").split(/[^a-z0-9]+/))
    .filter((term) => term.length >= 3);
  const requested = queryTerms
    .map((term) => term.toLowerCase())
    .filter((term) => term.length >= 3);
  return requested.some((term) => pathTerms.includes(term));
}
