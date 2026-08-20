import { EngineError } from "../errors.js";
import { readWorkspaceManifest } from "../manifest.js";
import {
  findNearestWorkspace,
  hasWorkspaceIndex,
  resolveZvecGrepRoot,
} from "../service/root.js";
import {
  WorkspaceIndex,
  isWorkspaceIndexed,
} from "../service/workspace-index.js";
import {
  exploreGraph,
  type ExploreOptions,
  type ExploreResult,
} from "./explore.js";
import {
  queryGraphNeighborhood,
  type GraphNeighborhoodOptions,
  type GraphNeighborhoodResult,
} from "./query.js";

export type WorkspaceGraphQueryOptions = GraphNeighborhoodOptions & {
  root?: string;
};

export type WorkspaceExploreOptions = ExploreOptions & {
  root?: string;
};

/**
 * Open the nearest workspace collection read-only and run callers/callees/impact.
 */
export function queryWorkspaceGraph(
  options: WorkspaceGraphQueryOptions,
): GraphNeighborhoodResult & { root: string } {
  return withWorkspaceIndex(options.root, (workspaceIndex, root) => {
    const result = queryGraphNeighborhood(
      workspaceIndex.graph,
      workspaceIndex,
      {
        direction: options.direction,
        query: options.query,
        depth: options.depth,
        limit: options.limit,
        seedId: options.seedId,
      },
    );
    return { ...result, root };
  });
}

/**
 * Open the nearest workspace collection read-only and run explore.
 */
export function exploreWorkspaceGraph(
  options: WorkspaceExploreOptions,
): ExploreResult & { root: string } {
  return withWorkspaceIndex(options.root, (workspaceIndex, root) => {
    const result = exploreGraph(workspaceIndex.graph, workspaceIndex, {
      query: options.query,
      seedId: options.seedId,
      searchLimit: options.searchLimit,
      traversalDepth: options.traversalDepth,
      maxNodes: options.maxNodes,
      maxFiles: options.maxFiles,
      maxChars: options.maxChars,
    });
    return { ...result, root };
  });
}

function withWorkspaceIndex<T>(
  rootOption: string | undefined,
  fn: (workspaceIndex: WorkspaceIndex, root: string) => T,
): T {
  const start = resolveZvecGrepRoot(rootOption ?? process.cwd());
  const location = findNearestWorkspace(start);
  if (!location) {
    throw new EngineError("No workspace index found near this path", {
      code: "ZVEC_GREP.ENGINE.SERVICE.INDEX_MISSING",
      context: `root=${start}`,
    });
  }

  const info = readWorkspaceManifest(location.home);
  if (!info) {
    throw new EngineError("Workspace index manifest not found", {
      code: "ZVEC_GREP.ENGINE.MANIFEST.NOT_FOUND",
      context: `root=${location.root}`,
    });
  }
  if (info.indexPolicy === "disabled") {
    throw new EngineError("Workspace index is disabled", {
      code: "ZVEC_GREP.ENGINE.SERVICE.INDEX_DISABLED",
      context: `root=${location.root}`,
    });
  }
  if (!isWorkspaceIndexed(info) || !hasWorkspaceIndex(location)) {
    throw new EngineError("Workspace index has not been built", {
      code: "ZVEC_GREP.ENGINE.SERVICE.INDEX_MISSING",
      context: `root=${location.root}`,
    });
  }

  const workspaceIndex = new WorkspaceIndex(info, { mode: "read" });
  try {
    return fn(workspaceIndex, location.root);
  } finally {
    workspaceIndex.close();
  }
}
