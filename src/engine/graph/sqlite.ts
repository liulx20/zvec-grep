import type {
  GraphStorage,
  LocalEdge,
  RawRef,
  ResolvePendingOptions,
  SymNode,
} from "./types.js";
import type { FileInfo } from "../types.js";
import type { ExtractionResult } from "../extraction/kernel/types.js";
import { SqlitePendingRefResolver } from "./persistence/sqlite/pending-ref-resolver.js";
import { SqliteGraphReader } from "./persistence/sqlite/reader.js";
import { SqliteGraphWriter } from "./persistence/sqlite/writer.js";
import { KernelGraphWriter } from "./persistence/sqlite/kernel-graph-writer.js";

/** Public SQLite graph facade composed from reader, writer and resolver units. */
export class SqliteGraphStorage
  extends SqliteGraphReader
  implements GraphStorage
{
  private readonly writer: SqliteGraphWriter;
  private readonly resolver: SqlitePendingRefResolver;
  private readonly kernelWriter: KernelGraphWriter;

  constructor(
    directory: string,
    options: { readOnly?: boolean; inMemory?: boolean } = {},
  ) {
    super(directory, options);
    this.writer = new SqliteGraphWriter(this.database);
    this.resolver = new SqlitePendingRefResolver(this.database);
    this.kernelWriter = new KernelGraphWriter(this.database);
  }

  checkpoint(): Promise<void> {
    return this.writer.checkpoint();
  }

  upsertFileGraph(
    fileId: string,
    nodes: readonly SymNode[],
    edges: readonly LocalEdge[],
    refs: readonly RawRef[],
    file?: FileInfo,
  ): void {
    this.writer.upsertFileGraph(fileId, nodes, edges, refs, file);
  }

  deleteFileGraph(fileId: string): void {
    this.writer.deleteFileGraph(fileId);
  }

  resolvePending(options?: ResolvePendingOptions): Promise<void> {
    return this.resolver.resolvePending(options);
  }

  writeKernelResult(
    filePath: string,
    language: string,
    contentHash: string,
    size: number,
    result: ExtractionResult,
  ): void {
    this.kernelWriter.writeFileGraph(
      filePath,
      language,
      contentHash,
      size,
      result,
    );
  }
}
