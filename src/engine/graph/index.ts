export type {
  EdgeProvenance,
  FileEdge,
  FileGraphNode,
  FileGraphResult,
  GraphEdgeKind,
  GraphRefKind,
  PendingRef,
  PendingRefStatus,
} from "./types.js";

export type { NameIndex, NameIndexEntry } from "./name-index.js";

export type { ReferenceResolver, ResolvedBatch } from "./resolve.js";

export type { LanguageExtensionTable } from "./imports/extension-table.js";

export type { ModuleResolutionOptions } from "./imports/resolve-path.js";

export type {
  GraphStorage,
  StoredPendingRef,
  PendingRefPage,
  ReferenceResolution,
  NeighborhoodOptions,
  ResolveStats,
} from "./persistence/storage.js";
