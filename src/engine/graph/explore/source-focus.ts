import type { DynamicBoundary } from "../types.js";
import { semanticTermsCovered } from "./policy.js";
import type { ExploreCallPath, ExploreEdge } from "./types.js";

export type SourceFocus = {
  symbolId: string;
  line: number;
};

export function collectSourceFocus(
  paths: readonly ExploreCallPath[],
  edges: readonly ExploreEdge[],
  boundaries: readonly DynamicBoundary[],
  terms: readonly string[],
): SourceFocus[] {
  const transitions = new Set<string>();
  for (const path of paths)
    for (let index = 0; index + 1 < path.nodes.length; index += 1)
      transitions.add(`${path.nodes[index]}\0${path.nodes[index + 1]}`);

  const focus: SourceFocus[] = [];
  const seen = new Set<string>();
  const add = (symbolId: string, line: number | undefined) => {
    if (!line || line <= 0 || seen.has(`${symbolId}\0${line}`)) return;
    seen.add(`${symbolId}\0${line}`);
    focus.push({ symbolId, line });
  };
  for (const edge of edges)
    if (transitions.has(`${edge.src}\0${edge.dst}`))
      add(edge.src, edge.firstLine);
  for (const boundary of [...boundaries].sort(
    (left, right) =>
      semanticTermsCovered(right.target.raw, terms).size -
        semanticTermsCovered(left.target.raw, terms).size ||
      Number(right.candidateDetails.length > 0) -
        Number(left.candidateDetails.length > 0) ||
      (left.line ?? Number.MAX_SAFE_INTEGER) -
        (right.line ?? Number.MAX_SAFE_INTEGER),
  ))
    add(boundary.sourceId, boundary.line);
  return focus;
}

export function sourceFocusLines(
  focus: readonly SourceFocus[],
): ReadonlyMap<string, readonly number[]> {
  const lines = new Map<string, number[]>();
  for (const item of focus) {
    const values = lines.get(item.symbolId) ?? [];
    if (!values.includes(item.line)) values.push(item.line);
    lines.set(item.symbolId, values);
  }
  return lines;
}
