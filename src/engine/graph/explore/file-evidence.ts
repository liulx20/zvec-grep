import { semanticPathTokens } from "../counterpart-policy.js";
import { isLowValuePath } from "../path-policy.js";
import {
  isTypeishKind,
  queryTargetsPath,
  queryTerms,
  semanticTermsCovered,
} from "./policy.js";
import type { ExploreCandidatePool } from "./candidate-pool.js";
import type { ExploreCallPath, ExploreEdge, ExploreNode } from "./types.js";

export function collectExploreFileEvidence(input: {
  pool: ExploreCandidatePool;
  edges: readonly ExploreEdge[];
  callPaths: readonly ExploreCallPath[];
  rootFileIds: ReadonlySet<string>;
  query: string;
}): void {
  const nodes = input.pool.nodes;
  const byFile = new Map<string, ExploreNode[]>();
  for (const node of nodes) {
    const fileId = node.entity?.file.id;
    if (!fileId) continue;
    const fileNodes = byFile.get(fileId) ?? [];
    fileNodes.push(node);
    byFile.set(fileId, fileNodes);
  }
  const nodeFiles = new Map(
    nodes.map((node) => [node.id, node.entity?.file.id] as const),
  );
  for (const path of input.callPaths) {
    if (path.derived) continue;
    for (const id of path.nodes) {
      const fileId = nodeFiles.get(id);
      if (fileId) input.pool.addFileEvidence(fileId, "call_path");
    }
  }
  const integration = directIntegrationFiles(
    nodes,
    input.edges,
    input.rootFileIds,
  );
  for (const [fileId, strength] of integration.weights)
    input.pool.addFileEvidence(fileId, "integration", strength);
  for (const fileId of integration.entrypointFileIds)
    input.pool.addFileEvidence(fileId, "entrypoint");
  for (const fileId of hierarchyEvidenceFileIds(
    nodes,
    input.edges,
    input.rootFileIds,
  ))
    input.pool.addFileEvidence(fileId, "hierarchy");

  const terms = queryTerms(input.query);
  const changeSurface = new Set(input.pool.fileIds("change_surface"));
  for (const [fileId, fileNodes] of byFile) {
    const path = fileNodes[0]?.entity?.file.relativePath;
    for (const node of fileNodes) {
      const identity = symbolIdentity(node);
      if (identity) input.pool.addFileEvidence(fileId, `symbol:${identity}`);
    }
    for (const token of semanticPathTokens(path ?? ""))
      input.pool.addFileEvidence(fileId, `path:${token}`);
    if (path && isLowValuePath(path) && !queryTargetsPath(input.query, path))
      input.pool.addFileEvidence(fileId, "low_value_path");
    const coveredTerms = fileSemanticTerms(fileNodes, terms);
    if (coveredTerms.size <= 0) continue;
    const pathTerms = semanticTermsCovered(path ?? "", terms);
    input.pool.addFileEvidence(
      fileId,
      "query_alignment",
      (coveredTerms.size + pathTerms.size) / terms.length,
    );
    for (const term of coveredTerms)
      input.pool.addFileEvidence(fileId, `concept:${term}`);
    if (changeSurface.has(fileId) && coveredTerms.size >= 2)
      input.pool.addFileEvidence(
        fileId,
        "aligned_change_surface",
        coveredTerms.size,
      );
  }
}

function symbolIdentity(node: ExploreNode): string | undefined {
  const metadata = node.entity?.entity.metadata;
  if (metadata?.kind !== "code" || !metadata.symbolName) return undefined;
  return `${metadata.symbolType}:${metadata.scope ?? ""}:${metadata.symbolName}:${metadata.arity ?? ""}`;
}

function fileSemanticTerms(
  nodes: readonly ExploreNode[],
  terms: readonly string[],
): Set<string> {
  const identity = nodes
    .flatMap((node) => {
      const metadata = node.entity?.entity.metadata;
      return [
        metadata?.kind === "code" ? metadata.symbolName : "",
        metadata?.kind === "code" ? metadata.scope : "",
        node.entity?.file.relativePath ?? "",
      ];
    })
    .join(" ");
  return semanticTermsCovered(identity, terms);
}

function hierarchyEvidenceFileIds(
  nodes: readonly ExploreNode[],
  edges: readonly ExploreEdge[],
  rootFileIds: ReadonlySet<string>,
): Set<string> {
  const nodeFiles = new Map(
    nodes.map((node) => [node.id, node.entity?.file.id] as const),
  );
  const roots = nodes.filter((node) => node.isRoot).map((node) => node.id);
  const related = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.kind !== "INHERITS") continue;
    const src = related.get(edge.src) ?? new Set<string>();
    const dst = related.get(edge.dst) ?? new Set<string>();
    src.add(edge.dst);
    dst.add(edge.src);
    related.set(edge.src, src);
    related.set(edge.dst, dst);
  }
  const files = new Set<string>();
  for (const root of roots) {
    const seen = new Set([root]);
    let frontier = [root];
    for (let depth = 0; depth < 2 && frontier.length > 0; depth += 1) {
      const next: string[] = [];
      for (const current of frontier) {
        for (const id of related.get(current) ?? []) {
          if (seen.has(id)) continue;
          seen.add(id);
          next.push(id);
          const fileId = nodeFiles.get(id);
          if (fileId && !rootFileIds.has(fileId)) files.add(fileId);
        }
      }
      frontier = next;
    }
  }
  return files;
}

function directIntegrationFiles(
  nodes: readonly ExploreNode[],
  edges: readonly ExploreEdge[],
  rootFileIds: ReadonlySet<string>,
): { weights: Map<string, number>; entrypointFileIds: Set<string> } {
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  const nodeFiles = new Map(
    nodes.map((node) => [node.id, node.entity?.file.id] as const),
  );
  const roots = new Set(
    nodes.filter((node) => node.isRoot).map((node) => node.id),
  );
  const scopeOwners = rootSemanticOwners(edges, roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges) {
      if (
        edge.kind === "CONTAINS" &&
        scopeOwners.has(edge.src) &&
        !scopeOwners.has(edge.dst)
      ) {
        scopeOwners.set(edge.dst, scopeOwners.get(edge.src)!);
        changed = true;
      }
    }
  }
  const rootsByFile = new Map<string, Set<string>>();
  const entrypoints = new Set<string>();
  for (const edge of edges) {
    if (edge.kind !== "CALLS" && edge.kind !== "INSTANTIATES") continue;
    const rootOwner = scopeOwners.get(edge.dst);
    if (!rootOwner || scopeOwners.has(edge.src)) continue;
    const fileId = nodeFiles.get(edge.src);
    if (!fileId || rootFileIds.has(fileId)) continue;
    const connected = rootsByFile.get(fileId) ?? new Set<string>();
    connected.add(rootOwner);
    rootsByFile.set(fileId, connected);
    const metadata = nodeById.get(edge.src)?.entity?.entity.metadata;
    const rootMetadata = nodeById.get(rootOwner)?.entity?.entity.metadata;
    if (
      metadata?.kind === "code" &&
      !isTypeishKind(
        rootMetadata?.kind === "code" ? (rootMetadata.symbolType ?? "") : "",
      ) &&
      /^(?:main|__main__|application)$/i.test(metadata.symbolName ?? "")
    )
      entrypoints.add(fileId);
  }
  return {
    weights: new Map(
      [...rootsByFile].map(([fileId, roots]) => [fileId, roots.size]),
    ),
    entrypointFileIds: entrypoints,
  };
}

function rootSemanticOwners(
  edges: readonly ExploreEdge[],
  roots: ReadonlySet<string>,
): Map<string, string> {
  const owners = new Map([...roots].map((id) => [id, id]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges) {
      if (edge.rel !== "counterpart") continue;
      const owner = owners.get(edge.src) ?? owners.get(edge.dst);
      if (!owner) continue;
      for (const id of [edge.src, edge.dst]) {
        if (owners.has(id)) continue;
        owners.set(id, owner);
        changed = true;
      }
    }
  }
  return owners;
}
