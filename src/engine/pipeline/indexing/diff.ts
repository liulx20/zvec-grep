import { readFile } from "node:fs/promises";

import { EngineError, isEngineError } from "../../errors.js";
import type { FileInfo } from "../../types.js";
import { sha256Bytes } from "../../utils/hash.js";

export type IndexDiffResult = {
  added: FileInfo[];
  modified: FileInfo[];
  pending: FileInfo[];
  deleted: FileInfo[];
  unchanged: FileInfo[];
};

export async function computeIndexDiff(
  scannedFiles: readonly FileInfo[],
  existingFiles: readonly FileInfo[],
): Promise<IndexDiffResult> {
  const existingById = new Map(existingFiles.map((file) => [file.id, file]));
  const seen = new Set<string>();
  const added: FileInfo[] = [];
  const modified: FileInfo[] = [];
  const pending: FileInfo[] = [];
  const unchanged: FileInfo[] = [];

  for (const file of scannedFiles) {
    seen.add(file.id);
    const existing = existingById.get(file.id);
    if (!existing) {
      added.push(await withContentHash(file));
      continue;
    }
    if (existing.indexStatus?.indexedTime === null) {
      pending.push(await withContentHash(file));
      continue;
    }
    if (
      existing.sizeBytes === file.sizeBytes &&
      existing.lastModifiedTime === file.lastModifiedTime &&
      existing.contentHash
    ) {
      unchanged.push(existing);
      continue;
    }
    const hashed = await withContentHash(file);
    if (
      existing.sizeBytes === hashed.sizeBytes &&
      existing.contentHash === hashed.contentHash
    ) {
      unchanged.push(existing);
      continue;
    }
    modified.push(hashed);
  }

  const deleted = [...existingById.values()].filter(
    (file) => !seen.has(file.id),
  );
  return { added, modified, pending, deleted, unchanged };
}

async function withContentHash(file: FileInfo): Promise<FileInfo> {
  try {
    return {
      ...file,
      contentHash: sha256Bytes(await readFile(file.absolutePath)),
    };
  } catch (error) {
    if (isEngineError(error)) throw error;
    throw new EngineError("Indexing failed to compute file content hash", {
      code: "ZVEC_GREP.ENGINE.INDEXING.CONTENT_HASH_FAILED",
      context: `fileId=${file.id} path=${file.relativePath}`,
      cause: error,
    });
  }
}
