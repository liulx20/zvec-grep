import type { EntityFragment } from "../types.js";
import { makeRefId } from "./ref-id.js";
import type { LocalEdge, RawRef, SymNode } from "./types.js";

export type FileGraphInput = {
  nodes: SymNode[];
  edges: LocalEdge[];
  refs: RawRef[];
};

/**
 * Build Phase-A graph skeleton from zvec fragments (symbols + CONTAINS).
 * CALLS come from {@link extractFileGraph}.
 */
export function fileGraphFromFragments(
  _fileId: string,
  fragments: readonly EntityFragment[],
): FileGraphInput {
  const publicFragments = uniquePublicCodeFragments(fragments);
  const nodes: SymNode[] = publicFragments.map((fragment) => {
    const metadata = fragment.metadata;
    const kind =
      metadata?.kind === "code"
        ? metadata.symbolType
        : (metadata?.kind ?? "unknown");
    const name =
      metadata?.kind === "code"
        ? metadata.symbolName
        : metadata?.kind === "markdown"
          ? metadata.heading
          : null;
    const isExported =
      metadata?.kind === "code"
        ? metadata.modifiers.includes("exported")
        : false;
    return {
      id: publicEntityId(fragment),
      kind,
      is_exported: isExported,
      name: name ?? undefined,
    };
  });

  const byName = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node.name) {
      continue;
    }
    const list = byName.get(node.name) ?? [];
    list.push(node.id);
    byName.set(node.name, list);
  }

  const edges: LocalEdge[] = [];
  for (const fragment of publicFragments) {
    if (fragment.metadata?.kind !== "code") {
      continue;
    }
    const scope = fragment.metadata.scope?.trim();
    if (!scope) {
      continue;
    }
    // scope breadcrumb is "Outer::Inner"; take the nearest container name.
    const parts = scope.split("::").filter(Boolean);
    const parentName = parts[parts.length - 1];
    if (!parentName) {
      continue;
    }
    const parents = byName.get(parentName);
    if (!parents || parents.length !== 1) {
      continue;
    }
    const parentId = parents[0]!;
    const childId = publicEntityId(fragment);
    if (parentId === childId) {
      continue;
    }
    edges.push({
      src: parentId,
      dst: childId,
      rel: "contains",
      count: 1,
      first_line: 0,
      ref_name: fragment.metadata.symbolName ?? childId,
      kind: "CONTAINS",
    });
  }

  return { nodes, edges, refs: [] };
}

/** Test / extractor helper for pending cross-file refs. */
export function rawRef(input: {
  owner: string;
  refName: string;
  refKind?: string;
  line: number;
  occurrence?: number;
  ownerIsFile?: boolean;
}): RawRef {
  const refKind = input.refKind ?? "call";
  return {
    owner: input.owner,
    id: makeRefId(
      input.owner,
      input.refName,
      refKind,
      input.line,
      input.occurrence,
    ),
    ref_name: input.refName,
    ref_kind: refKind,
    line: input.line,
    owner_is_file: input.ownerIsFile,
  };
}

function uniquePublicCodeFragments(
  fragments: readonly EntityFragment[],
): EntityFragment[] {
  const seen = new Set<string>();
  const out: EntityFragment[] = [];
  for (const fragment of fragments) {
    if (fragment.group && fragment.group !== fragment.id) {
      continue;
    }
    const id = publicEntityId(fragment);
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push(fragment);
  }
  return out;
}

function publicEntityId(fragment: EntityFragment): string {
  return fragment.group ?? fragment.id;
}
