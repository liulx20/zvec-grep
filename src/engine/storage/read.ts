import { dirname, join, resolve } from "node:path";
import { EngineError } from "../errors.js";
import { readWorkspaceManifest } from "../manifest.js";
import { CURRENT_INDEX_VERSION } from "../types.js";
import {
  findNearestWorkspace,
  hasWorkspaceIndex,
  workspaceHome,
} from "../workspace-path.js";
import { acquireReadWriteLock, assertNoWriteLock } from "../utils/lock.js";
import {
  openGraphStorage,
  type GraphReadStorage,
} from "../graph/persistence/index.js";
import { createWorkspaceIndexStorage } from "./zvec.js";
import type { WorkspaceIndexStorage } from "./index.js";

/** Keep entity lookup and graph reads in one locked workspace read scope. */
export async function withWorkspaceGraphRead<T>(
  root: string,
  read: (
    entities: WorkspaceIndexStorage,
    graph: GraphReadStorage,
  ) => Promise<T>,
): Promise<T> {
  // A nearer index being rebuilt must not silently fall back to a parent index.
  for (let current = resolve(root); ; current = dirname(current)) {
    assertNoWriteLock(
      join(workspaceHome(current), "locks", "home"),
      "relationships",
    );
    if (dirname(current) === current) break;
  }
  const location = findNearestWorkspace(root);
  if (!location) throw missingIndex();
  const lock = acquireReadWriteLock(
    join(location.home, "locks", "home"),
    "read",
    { operation: "relationships" },
  );
  try {
    const manifest = readWorkspaceManifest(location.home);
    if (
      !manifest ||
      manifest.indexPolicy === "disabled" ||
      !manifest.embedding ||
      manifest.indexVersion !== CURRENT_INDEX_VERSION ||
      !hasWorkspaceIndex(location)
    ) {
      throw missingIndex();
    }
    const graph = openGraphStorage(manifest.path);
    try {
      const entities = createWorkspaceIndexStorage({
        storagePath: manifest.path,
        readOnly: true,
      });
      try {
        return await read(entities, graph);
      } finally {
        entities.close();
      }
    } finally {
      graph.close();
    }
  } finally {
    lock.release();
  }
}

function missingIndex(): EngineError {
  return new EngineError("Workspace index is unavailable; run zg --index.", {
    code: "ZVEC_GREP.ENGINE.STORAGE.INDEX_MISSING",
  });
}
