import type {
  ExploreResult,
  GraphNeighborhoodResult,
} from "../../engine/graph/index.js";
import type { StoredEntity } from "../../engine/storage/index.js";

export function printExploreResult(
  result: ExploreResult & { root?: string },
): void {
  for (const line of exploreLines(result)) {
    console.log(line);
  }
}

export function formatExploreResult(
  result: ExploreResult & { root?: string },
): string {
  return exploreLines(result).join("\n");
}

function exploreLines(result: ExploreResult & { root?: string }): string[] {
  if (!result.available) {
    return ["graph unavailable"];
  }
  if (result.emptyReason === "no_seeds") {
    return [`no seeds for query: ${result.query}`];
  }
  if (result.files.length === 0) {
    return [`no explore context for query: ${result.query}`];
  }

  const lines: string[] = [];
  lines.push(`explore: ${result.query}`);
  if (result.root) {
    lines.push(`root: ${result.root}`);
  }
  lines.push(
    `roots: ${result.roots.map((r) => symbolLabel(r.id, r.entity)).join(", ")}`,
  );
  lines.push(
    `subgraph: ${result.nodes.length} nodes, ${result.edges.length} edges, ${result.files.length} files`,
  );

  if (result.callPaths.length > 0) {
    lines.push("", "call paths:");
    for (const path of result.callPaths) {
      lines.push(
        `- ${path.nodes.map((id) => shortName(result, id)).join(" -> ")}`,
      );
    }
  }

  const blast = blastRadiusLines(result);
  if (blast.length > 0) {
    lines.push("", "blast radius:", ...blast);
  }

  if (result.changeSurface.length > 0) {
    lines.push("", "change surface:");
    for (const item of result.changeSurface) {
      lines.push(
        `- ${shortName(result, item.rootId)} ${item.rel} -> ${symbolLabel(item.id, item.entity)}${item.rescued ? " (rescued)" : ""}`,
      );
    }
  }

  for (const file of result.files) {
    lines.push("");
    const tag = file.isCentral
      ? "central"
      : file.isChangeSurface
        ? "change-surface"
        : "related";
    lines.push(
      `${file.file.relativePath} (${tag}, score=${file.score.toFixed(4)})`,
    );
    const relations = relationNotes(result, file.file.id);
    if (relations.length > 0) {
      lines.push(`relations: ${relations.join("; ")}`);
    }
    lines.push("source:");
    for (const textLine of file.text.split(/\r?\n/)) {
      lines.push(textLine);
    }
  }
  return lines;
}

function blastRadiusLines(result: ExploreResult): string[] {
  const lines: string[] = [];
  for (const blast of result.blastRadius) {
    if (blast.dependents.length === 0 && blast.tests.length === 0) continue;
    lines.push(`- ${shortName(result, blast.rootId)}:`);
    if (blast.dependents.length > 0) {
      lines.push(
        `  dependents: ${blast.dependents
          .slice(0, 10)
          .map((item) => symbolLabel(item.id, item.entity))
          .join(", ")}`,
      );
    }
    if (blast.tests.length > 0) {
      lines.push(
        `  tests: ${blast.tests
          .slice(0, 10)
          .map((item) => symbolLabel(item.id, item.entity))
          .join(", ")}`,
      );
    }
  }
  return lines;
}

export function printNeighborhoodResult(
  result: GraphNeighborhoodResult & { root?: string },
): void {
  for (const line of neighborhoodLines(result)) {
    console.log(line);
  }
}

export function formatNeighborhoodResult(
  result: GraphNeighborhoodResult & { root?: string },
): string {
  return neighborhoodLines(result).join("\n");
}

function neighborhoodLines(
  result: GraphNeighborhoodResult & { root?: string },
): string[] {
  if (!result.available) {
    return ["graph unavailable"];
  }
  if (result.ambiguous) {
    const lines = [`ambiguous seeds for ${result.query}:`];
    for (const seed of result.seeds) {
      lines.push(`- ${symbolLabel(seed.id, seed.entity)}`);
    }
    lines.push("re-run with a unique name or --seed-id <id>");
    return lines;
  }
  if (!result.seed) {
    return [`no seeds for query: ${result.query}`];
  }

  const lines: string[] = [
    `${result.direction}: ${symbolLabel(result.seed.id, result.seed.entity)}`,
  ];
  if (result.root) {
    lines.push(`root: ${result.root}`);
  }
  lines.push(`depth=${result.depth} limit=${result.limit}`);
  if (result.neighbors.length === 0) {
    lines.push("(no neighbors)");
    return lines;
  }
  for (const neighbor of result.neighbors) {
    const count =
      neighbor.count !== undefined ? ` count=${neighbor.count}` : "";
    const kind = neighbor.kind ? ` ${neighbor.kind}` : "";
    lines.push(`- ${symbolLabel(neighbor.id, neighbor.entity)}${kind}${count}`);
  }
  return lines;
}

function relationNotes(result: ExploreResult, fileId: string): string[] {
  const idsInFile = new Set(
    result.nodes.filter((n) => n.entity?.file.id === fileId).map((n) => n.id),
  );
  const notes: string[] = [];
  for (const edge of result.edges) {
    const srcIn = idsInFile.has(edge.src);
    const dstIn = idsInFile.has(edge.dst);
    if (!srcIn && !dstIn) {
      continue;
    }
    if (srcIn && dstIn) {
      notes.push(
        `${shortName(result, edge.src)} -${edge.kind}-> ${shortName(result, edge.dst)}`,
      );
    } else if (srcIn) {
      notes.push(
        `${shortName(result, edge.src)} -${edge.kind}-> ${shortName(result, edge.dst)}`,
      );
    } else {
      notes.push(
        `${shortName(result, edge.src)} -${edge.kind}-> ${shortName(result, edge.dst)}`,
      );
    }
    if (notes.length >= 8) {
      break;
    }
  }
  return notes;
}

function shortName(result: ExploreResult, id: string): string {
  const node = result.nodes.find((n) => n.id === id);
  return symbolLabel(id, node?.entity ?? null, true);
}

function symbolLabel(
  id: string,
  entity: StoredEntity | null | undefined,
  short = false,
): string {
  const meta = entity?.entity.metadata;
  const name =
    meta?.kind === "code" && meta.symbolName
      ? meta.symbolName
      : id.slice(0, 10);
  if (short) {
    return name;
  }
  const path = entity?.file.relativePath;
  return path ? `${name} (${path})` : name;
}
