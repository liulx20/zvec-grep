import type { EntityFragment } from "../types.js";
import {
  referenceTargetFromRaw,
  type ReferenceTarget,
} from "../reference-target.js";
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
      ...(metadata?.kind === "code" && metadata.signature
        ? {
            signature: metadata.signature,
            ...(metadata.arity === null || metadata.arity === undefined
              ? {}
              : { arity: metadata.arity }),
            returnType: signatureReturnType(metadata.signature),
          }
        : {}),
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
    const parentFragments = publicFragments
      .filter((candidate) =>
        candidate.metadata?.kind === "code" &&
        candidate.metadata.symbolName === parentName &&
        candidate.range.kind === "text" &&
        fragment.range.kind === "text" &&
        candidate.range.startOffset <= fragment.range.startOffset &&
        candidate.range.endOffset >= fragment.range.endOffset &&
        publicEntityId(candidate) !== publicEntityId(fragment)
      )
      .sort((left, right) => {
        if (left.range.kind !== "text" || right.range.kind !== "text") return 0;
        return (left.range.endOffset - left.range.startOffset) -
          (right.range.endOffset - right.range.startOffset);
      });
    const containingParent = parentFragments[0];
    const parents = byName.get(parentName);
    const parentId = containingParent
      ? publicEntityId(containingParent)
      : parents?.length === 1 ? parents[0] : undefined;
    if (!parentId) {
      continue;
    }
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

function signatureReturnType(signature: string): string | undefined {
  const match = signature.match(/\)\s*(?::|->)?\s*([A-Za-z_][^\s{]*)\s*(?:\{|$)/);
  return match?.[1];
}

/** Test / extractor helper for pending cross-file refs. */
export function rawRef(
  input:
    | {
        type?: "symbol";
        owner: string;
        refName: string;
        refKind?: string;
        line: number;
        occurrence?: number;
        sourceLanguage?: string;
        target?: ReferenceTarget;
      }
    | {
        type: "import";
        owner: string;
        refName: string;
        line: number;
        occurrence?: number;
      }
    | {
        type: "import_binding";
        owner: string;
        refName: string;
        line: number;
        occurrence?: number;
        importedName: string;
        localName: string;
        sourceLanguage: string;
      },
): RawRef {
  const refKind =
    input.type === "symbol" || !input.type
      ? (input.refKind ?? "call")
      : "import";
  const base = {
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
  };
  if (input.type === "import_binding")
    return {
      ...base,
      type: "import_binding",
      ref_kind: "import",
      imported_name: input.importedName,
      local_name: input.localName,
      source_language: input.sourceLanguage,
    };
  if (input.type === "import")
    return { ...base, type: "import", ref_kind: "import" };
  return {
    ...base,
    type: "symbol",
    source_language: input.sourceLanguage,
    target: input.target ?? referenceTargetFromRaw(input.refName),
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
