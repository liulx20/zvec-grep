import type {
  ContainerNeighbor,
  FileNeighbor,
  GraphEdge,
  GraphStats,
  GraphStorage,
  LocalEdge,
  RawRef,
  ResolvePendingOptions,
  SeedNeighbor,
  SymContext,
  SymNode,
  SymRef,
  UsageRef,
} from "./types.js";

/** Stub when graph backend is disabled or failed to open. */
export class UnavailableGraphStorage implements GraphStorage {
  readonly available = false;

  async checkpoint(): Promise<void> {}
  close(): void {}

  upsertFileGraph(
    _fileId: string,
    _nodes: readonly SymNode[],
    _edges: readonly LocalEdge[],
    _refs: readonly RawRef[],
  ): void {}

  deleteFileGraph(_fileId: string): void {}
  async resolvePending(_options?: ResolvePendingOptions): Promise<void> {}

  symbolScope(): string[] {
    return [];
  }
  fileScope(): string[] {
    return [];
  }
  expandSeeds(): SeedNeighbor[] {
    return [];
  }
  expandContainers(): ContainerNeighbor[] {
    return [];
  }
  expandFileNeighbors(): FileNeighbor[] {
    return [];
  }
  callers(): SymRef[] {
    return [];
  }
  callees(): SymRef[] {
    return [];
  }
  impact(): SymRef[] {
    return [];
  }
  usages(): UsageRef[] {
    return [];
  }
  pathBetween(): SymRef[] | null {
    return null;
  }
  hierarchy(): SymRef[] {
    return [];
  }
  members(): SymRef[] {
    return [];
  }
  deadCode(): SymRef[] {
    return [];
  }
  context(symId: string): SymContext {
    return {
      focal: { id: symId },
      containers: [],
      members: [],
      incoming: [],
      outgoing: [],
    };
  }
  traverse(): SymRef[] {
    return [];
  }
  outgoingEdges(): GraphEdge[] {
    return [];
  }
  incomingEdges(): GraphEdge[] {
    return [];
  }
  edges(): GraphEdge[] {
    return [];
  }
  stats(): GraphStats {
    return {
      symCount: 0,
      fileCount: 0,
      refCount: 0,
      callsCount: 0,
      refsCount: 0,
      inheritsCount: 0,
    };
  }
}
