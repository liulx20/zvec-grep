import type { CodeEntity } from "../code/extractor.js";
import type {
  FileEdge,
  FileGraphNode,
  FileGraphResult,
  PendingRef,
} from "../../graph/types.js";
import type { NameEdge } from "./types.js";
import type { WalkContext } from "./walk-context.js";

const VISIBILITY_MODIFIERS = new Set([
  "public",
  "private",
  "protected",
  "internal",
]);

/**
 * Options controlling how a per-file walk is partitioned into graph output.
 */
export type PartitionOptions = {
  /** File ID that owns the entities being partitioned. */
  fileId: string;
  /** Language tag, used for language-specific edge semantics. */
  language: string;
};

/**
 * Converts walk-time buffers into a {@link FileGraphResult}.
 *
 * Responsibilities:
 * - Build {@link FileGraphNode}s from the collected entities.
 * - Emit `contains` edges from `ctx.resolvedEdges`.
 * - Resolve in-file name references (`calls`/`extends`/`implements`) using
 *   `ctx.symbolTable`; uniquely resolvable ones become `file_local` edges,
 *   everything else becomes a `pendingRefs` entry.
 * - Convert top-level `imports` name edges directly into pending refs
 *   (their target lives in another file).
 */
export function partition(
  ctx: WalkContext,
  entities: readonly CodeEntity[],
  options: PartitionOptions,
): FileGraphResult {
  const nodes = buildNodes(entities, options.language);
  const { edges, unresolved } = partitionEdges(ctx, options.fileId);

  return {
    nodes,
    edges,
    pendingRefs: unresolved.map((edge) => nameEdgeToPendingRef(edge)),
  };
}

function buildNodes(
  entities: readonly CodeEntity[],
  language: string,
): FileGraphNode[] {
  return entities.map((entity): FileGraphNode => {
    const name = entity.name ?? null;
    const qualifiedName =
      name && entity.breadcrumb.length > 0
        ? `${entity.breadcrumb.join("::")}::${name}`
        : (name ?? "");

    return {
      id: entity.id,
      kind: entity.symbolType,
      name,
      qualifiedName,
      language,
      startLine: entity.node.startPosition.row + 1,
      endLine: entity.node.endPosition.row + 1,
      startColumn: entity.node.startPosition.column,
      endColumn: entity.node.endPosition.column,
      signature: entity.signature ?? null,
      doc: entity.doc ?? null,
      arity: null,
      visibility: extractVisibility(entity),
      isExported: entity.modifiers.includes("exported"),
    };
  });
}

function extractVisibility(entity: CodeEntity): string | null {
  for (const modifier of entity.modifiers) {
    if (VISIBILITY_MODIFIERS.has(modifier)) {
      return modifier;
    }
  }
  return null;
}

function partitionEdges(
  ctx: WalkContext,
  fileId: string,
): { edges: FileEdge[]; unresolved: NameEdge[] } {
  const edges: FileEdge[] = [];
  const unresolved: NameEdge[] = [];

  for (const walkEdge of ctx.resolvedEdges) {
    edges.push({
      kind: "contains",
      source: walkEdge.sourceId,
      target: walkEdge.targetId,
      line: walkEdge.line,
      column: walkEdge.column,
      provenance: "file_local",
      metadata: {},
    });
  }

  for (const nameEdge of ctx.nameEdges) {
    if (nameEdge.refKind === "imports") {
      unresolved.push(nameEdge);
      continue;
    }

    // Member calls require receiver-type inference; defer to cross-file
    // resolution where the type index is available.
    if (nameEdge.refKind === "calls" && nameEdge.receiverName) {
      unresolved.push(nameEdge);
      continue;
    }

    const candidates = ctx.lookupSymbol(nameEdge.refName);
    if (candidates?.length === 1) {
      edges.push({
        kind: nameEdge.refKind,
        source: nameEdge.ownerId,
        target: candidates[0],
        line: nameEdge.line,
        column: nameEdge.column,
        provenance: "file_local",
        metadata: buildEdgeMetadata(nameEdge),
      });
    } else {
      unresolved.push(nameEdge);
    }
  }

  return { edges, unresolved };
}

function buildEdgeMetadata(nameEdge: NameEdge): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  if (nameEdge.rawText !== undefined) {
    metadata.rawText = nameEdge.rawText;
  }
  if (nameEdge.arity !== undefined) {
    metadata.arity = nameEdge.arity;
  }
  if (nameEdge.receiverName !== undefined) {
    metadata.receiverName = nameEdge.receiverName;
  }
  return metadata;
}

function nameEdgeToPendingRef(nameEdge: NameEdge): PendingRef {
  return {
    ownerId: nameEdge.ownerId,
    refName: nameEdge.refName,
    receiverName: nameEdge.receiverName ?? null,
    refKind: nameEdge.refKind,
    arity: nameEdge.arity ?? null,
    line: nameEdge.line,
    column: nameEdge.column,
    status: "pending",
    metadata: buildEdgeMetadata(nameEdge),
  };
}
