import { isLowValuePath } from "./path-policy.js";

const NON_SEMANTIC_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  "include",
  "src",
  "source",
  "lib",
  "main",
]);

const COUNTERPART_LAYOUT_SEGMENTS: ReadonlySet<string> = new Set([
  "include",
  "src",
  "source",
  "lib",
]);

/**
 * Match declaration/definition layouts without treating a shared basename as
 * sufficient evidence. Layout markers are ignored, while the remaining module
 * suffix must agree. One leading project namespace is allowed for layouts such
 * as `include/project/api/x.h` paired with `src/api/x.cc`.
 */
export function counterpartPathsRelated(left: string, right: string): boolean {
  if (!counterpartPathDomainsCompatible(left, right)) return false;
  const leftDirectory = counterpartDirectory(left);
  const rightDirectory = counterpartDirectory(right);
  const [longer, shorter] =
    leftDirectory.length >= rightDirectory.length
      ? [leftDirectory, rightDirectory]
      : [rightDirectory, leftDirectory];
  const offset = longer.length - shorter.length;
  return (
    offset <= 1 &&
    shorter.every((part, index) => part === longer[index + offset])
  );
}

/** Keep production and low-value/vendor declarations in separate domains. */
export function counterpartPathDomainsCompatible(
  left: string,
  right: string,
): boolean {
  return isLowValuePath(left) === isLowValuePath(right);
}

function counterpartDirectory(path: string): string[] {
  return path
    .toLowerCase()
    .replaceAll("\\", "/")
    .split("/")
    .slice(0, -1)
    .filter((part) => part && !COUNTERPART_LAYOUT_SEGMENTS.has(part));
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
