import {
  workspaceIndexDetail,
  detail,
  EngineError,
  errorDetails,
  isEngineError,
} from "../../errors.js";
import type {
  FileInfo,
  WorkspaceIndexInfo,
  WorkspaceIndexStatus,
} from "../../types.js";
import { computeIndexDiff } from "./diff.js";
import { scanRootPaths } from "./scanner/index.js";

/** Read-side freshness inspection kept independent from the indexing runtime. */
export async function getWorkspaceIndexStatus(
  workspaceIndex: WorkspaceIndexInfo,
  storedFiles: readonly FileInfo[],
): Promise<WorkspaceIndexStatus> {
  try {
    const scan = await scanRootPaths(
      workspaceIndex.id,
      workspaceIndex.rootPaths,
      { knownFiles: storedFiles },
    );
    const diff = await computeIndexDiff(scan.files, storedFiles);
    const pendingFiles = storedFiles.filter(
      (file) => file.indexStatus?.indexedTime === null,
    );
    const failedFiles = pendingFiles.filter(
      (file) => file.indexStatus?.error !== undefined,
    );
    const indexedFiles = storedFiles.filter(
      (file) =>
        file.indexStatus?.indexedTime !== undefined &&
        file.indexStatus.indexedTime !== null,
    );
    return {
      filesScanned: scan.files.length,
      filesStored: storedFiles.length,
      filesIndexed: indexedFiles.length,
      entitiesIndexed: indexedFiles.reduce(
        (count, file) => count + (file.indexStatus?.entityCount ?? 0),
        0,
      ),
      fragmentsTruncated: indexedFiles.reduce(
        (count, file) =>
          count + (file.indexStatus?.truncatedFragmentCount ?? 0),
        0,
      ),
      filesPending: pendingFiles.length,
      filesFailed: failedFiles.length,
      filesAdded: diff.added.length,
      filesModified: diff.modified.length,
      filesDeleted: diff.deleted.length,
      filesUnchanged: diff.unchanged.length,
      pendingFiles,
      failedFiles,
      addedFiles: diff.added,
      modifiedFiles: diff.modified,
      deletedFiles: diff.deleted,
    };
  } catch (error) {
    if (isEngineError(error)) throw error;
    throw new EngineError("Inspecting workspace index status failed", {
      code: "ZVEC_GREP.ENGINE.INDEXING.STATUS_FAILED",
      context:
        errorDetails([
          detail("workspace_index_id", workspaceIndex.id),
          workspaceIndexDetail(workspaceIndex.name),
        ]) ?? "",
      cause: error,
    });
  }
}
