import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { WorkspaceIndexStorage } from "../storage/index.js";
import type { FileInfo } from "../types.js";
import type { FileGraphResult } from "./types.js";
import type {
  ReferenceResolution,
  StoredPendingRef,
} from "./persistence/storage.js";
import { graphTransaction } from "./persistence/sqlite/transaction.js";
import { GraphDatabase } from "./persistence/sqlite/database.js";
import { SqliteGraphWriter } from "./persistence/sqlite/writer.js";
import { SqlitePendingRefStore } from "./persistence/sqlite/pending-ref-resolver.js";

/** Called under the workspace write lock, after all file updates finish. */
export type WorkspaceGraphResolver = (
  ref: StoredPendingRef,
  lookup: Pick<
    WorkspaceIndexStorage,
    "getEntity" | "listFiles" | "listEntitiesByFile"
  >,
) => Promise<Pick<ReferenceResolution, "targetId" | "provenance"> | null>;

type Journal = { file: FileInfo; entityIds: string[]; deletion: boolean };

/** Coordinates two stores. Interrupted writes are discarded and retried on the next index pass. */
export class WorkspaceGraph {
  readonly database: GraphDatabase;
  private readonly writer: SqliteGraphWriter;
  private readonly journalPath: string;
  private readonly readyPath: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    path: string,
    private readonly storage: WorkspaceIndexStorage,
  ) {
    this.journalPath = join(path, "graph.pending.json");
    this.readyPath = join(path, "graph.ready");
    if (!existsSync(join(path, "graph.sqlite")))
      rmSync(this.readyPath, { force: true });
    this.database = GraphDatabase.open(join(path, "graph.sqlite"));
    this.writer = new SqliteGraphWriter(this.database);
  }

  get needsRebuild(): boolean {
    return !existsSync(this.readyPath);
  }

  async recover(): Promise<void> {
    if (!existsSync(this.journalPath)) return;
    const journal = JSON.parse(
      readFileSync(this.journalPath, "utf8"),
    ) as Journal;
    await this.writer.deleteFileGraph(journal.file.id, journal.entityIds);
    if (journal.deletion) this.storage.deleteFile(journal.file.id);
    else
      this.storage.markFileFailed(
        journal.file,
        "Interrupted graph/index update; retry required",
      );
    await this.storage.finalizeWrites();
    rmSync(this.journalPath);
  }

  update(
    file: FileInfo,
    graph: FileGraphResult | undefined,
    mutation: () => void,
    deletion = false,
  ): Promise<void> {
    const task = this.queue.then(async () => {
      // Never overwrite an earlier operation that still needs recovery.
      await this.recover();
      const oldIds = this.storage
        .listEntitiesByFile(file.id)
        .map(({ entity }) => entity.id);
      const journal: Journal = {
        file,
        deletion,
        entityIds: [
          ...new Set([
            ...oldIds,
            ...(graph?.nodes.map((node) => node.id) ?? []),
          ]),
        ],
      };
      writeFileSync(`${this.journalPath}.tmp`, JSON.stringify(journal), {
        flush: true,
      });
      renameSync(`${this.journalPath}.tmp`, this.journalPath);
      try {
        // A new or changed candidate can invalidate a previously unique match,
        // even when neither endpoint changed. Re-resolve cross-file evidence.
        graphTransaction(this.database.connection, () => {
          this.database.connection.exec(`
            DELETE FROM edges WHERE ref_id IS NOT NULL;
            UPDATE pending_refs SET status = 'pending', token = lower(hex(randomblob(16)))
            WHERE status = 'resolved';
          `);
        });
        await this.writer.deleteFileGraph(file.id, oldIds);
        mutation();
        if (graph) await this.writer.writeFileGraph(file.id, graph, []);
        // zvec writes must be flushed before retiring the recovery record.
        await this.storage.finalizeWrites();
        rmSync(this.journalPath);
      } catch (error) {
        try {
          await this.recover();
        } catch (recoveryError) {
          throw new AggregateError(
            [error, recoveryError],
            "Graph/index update and recovery failed",
            { cause: recoveryError },
          );
        }
        throw error;
      }
    });
    this.queue = task.catch(() => undefined);
    return task;
  }

  async finish(
    resolver?: WorkspaceGraphResolver,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.queue;
    await this.recover();
    if (resolver) {
      const refs = new SqlitePendingRefStore(this.database);
      const lookup = {
        getEntity: this.storage.getEntity.bind(this.storage),
        listFiles: this.storage.listFiles.bind(this.storage),
        listEntitiesByFile: this.storage.listEntitiesByFile.bind(this.storage),
      };
      let cursor: number | undefined;
      do {
        const page = await refs.listPendingRefs({ cursor });
        for (const ref of page.refs) {
          signal?.throwIfAborted();
          const resolution = await resolver(ref, lookup);
          signal?.throwIfAborted();
          if (!resolution) continue;
          const target = this.storage.getEntity(resolution.targetId);
          const targetExists =
            target?.entity.id === resolution.targetId &&
            target.file.indexStatus?.indexedTime != null;
          const fileExists =
            ref.refKind === "imports" &&
            this.storage
              .listFiles()
              .some(
                (file) =>
                  file.id === resolution.targetId &&
                  file.indexStatus?.indexedTime != null,
              );
          if (targetExists || fileExists)
            await refs.applyResolutions([
              { ...resolution, refId: ref.id, refToken: ref.token },
            ]);
        }
        cursor = page.nextCursor;
      } while (cursor !== undefined);
    }
    signal?.throwIfAborted();
    writeFileSync(this.readyPath, "1", { flush: true });
  }

  close(): void {
    this.database.close();
  }
}
