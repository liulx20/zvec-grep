import { semanticPathTokens } from "../counterpart-policy.js";
import { isLowValuePath } from "../path-policy.js";
import { escapeRegExp } from "../../utils/regex.js";
import {
  isTypeishKind,
  queryEvidenceTerms,
  queryTargetsPath,
  semanticTermsCovered,
} from "./policy.js";
import type { ExploreCandidatePool } from "./candidate-pool.js";
import type { GraphReader } from "../types.js";
import type { ExploreCallPath, ExploreEdge, ExploreNode } from "./types.js";

export function collectExploreFileEvidence(input: {
  graph: GraphReader;
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
  const rootIds = new Set(
    nodes.filter((node) => node.isRoot).map((node) => node.id),
  );
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  const callPathNodeIds = new Set(
    input.callPaths.flatMap((path) => path.nodes),
  );
  const directCalls = new Map<string, number>();
  const familyFileIds = new Set<string>();
  const familySourcesByFile = new Map<string, Set<string>>();
  const familyValueIds = new Set<string>();
  for (const edge of input.edges) {
    if (!rootIds.has(edge.dst) || edge.kind === "CONTAINS") continue;
    const fileId = nodeFiles.get(edge.src);
    if (fileId && !input.rootFileIds.has(fileId)) {
      input.pool.addFileEvidence(fileId, `family:${edge.dst}`);
      if (edge.kind === "CALLS")
        directCalls.set(fileId, (directCalls.get(fileId) ?? 0) + edge.count);
      familyFileIds.add(fileId);
      const sources = familySourcesByFile.get(fileId) ?? new Set<string>();
      sources.add(edge.src);
      familySourcesByFile.set(fileId, sources);
      const metadata = nodeById.get(edge.src)?.entity?.entity.metadata;
      if (metadata?.kind === "code" && metadata.symbolType === "value")
        familyValueIds.add(edge.src);
      if (
        metadata?.kind === "code" &&
        /^(?:main|__main__|application)$/i.test(metadata.symbolName ?? "")
      )
        input.pool.addFileEvidence(fileId, "entrypoint");
    }
  }
  for (const edge of input.edges) {
    if (!familyValueIds.has(edge.dst) || edge.kind !== "REFS") continue;
    const fileId = nodeFiles.get(edge.src);
    if (fileId && !input.rootFileIds.has(fileId))
      input.pool.addFileEvidence(fileId, "collaborator");
  }
  const importsByFile = new Map<string, Set<string>>();
  for (const edge of input.graph.outgoingEdges(
    [...familyFileIds],
    ["IMPORTS"],
    Math.min(4_096, Math.max(64, familyFileIds.size * 16)),
  )) {
    const targets = importsByFile.get(edge.src) ?? new Set<string>();
    targets.add(edge.dst);
    importsByFile.set(edge.src, targets);
  }
  for (const [fileId, imports] of importsByFile)
    input.pool.addFileEvidence(fileId, "integration", imports.size);
  for (const [fileId, sources] of familySourcesByFile)
    input.pool.addFileEvidence(fileId, "integration", sources.size);
  for (const path of input.callPaths) {
    // A derived one-hop path is already represented by direct-call evidence.
    // Reserving its target file as well would let any helper call bypass the
    // shared selector and displace stronger structural context.
    if (path.derived && path.nodes.length < 3) continue;
    for (const id of path.nodes) {
      const fileId = nodeFiles.get(id);
      if (fileId) input.pool.addFileEvidence(fileId, "call_path");
    }
  }
  for (const edge of input.edges) {
    if (edge.kind === "INSTANTIATES" && callPathNodeIds.has(edge.src)) {
      const fileId = nodeFiles.get(edge.dst);
      if (fileId) input.pool.addFileEvidence(fileId, "call_path");
    }
    if (!rootIds.has(edge.src)) continue;
    const fileId = nodeFiles.get(edge.dst);
    const targetMetadata = nodeById.get(edge.dst)?.entity?.entity.metadata;
    if (!fileId || input.rootFileIds.has(fileId)) continue;
    if (edge.kind === "INSTANTIATES")
      input.pool.addFileEvidence(fileId, "collaborator");
    else if (
      edge.kind === "REFS" &&
      targetMetadata?.kind === "code" &&
      targetMetadata.symbolType === "value"
    )
      input.pool.addFileEvidence(fileId, "collaborator");
    else if (edge.kind === "CALLS")
      directCalls.set(fileId, (directCalls.get(fileId) ?? 0) + edge.count);
  }
  for (const [fileId, count] of directCalls)
    input.pool.addFileEvidence(fileId, "direct_call", count);
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

  const terms = queryEvidenceTerms(input.query);
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
    input.pool.addFileEvidence(
      fileId,
      "query_alignment",
      coveredTerms.size / terms.length,
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
        metadata?.kind === "code" ? metadata.signature : "",
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
  const rootSet = new Set(roots);
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  const related = new Map<string, Set<string>>();
  const files = new Set<string>();
  for (const edge of edges) {
    if (edge.kind === "REFS" && rootSet.has(edge.dst)) {
      const source = nodeById.get(edge.src);
      const metadata = source?.entity?.entity.metadata;
      const targetMetadata = nodeById.get(edge.dst)?.entity?.entity.metadata;
      const targetName =
        targetMetadata?.kind === "code" ? targetMetadata.symbolName : undefined;
      const fileId = source?.entity?.file.id;
      if (
        fileId &&
        !rootFileIds.has(fileId) &&
        metadata?.kind === "code" &&
        ["field", "value"].includes(metadata.symbolType ?? "") &&
        targetMetadata?.kind === "code" &&
        targetName &&
        !targetMetadata.nodeType?.includes("enum") &&
        new RegExp(`:\\s*${escapeRegExp(targetName)}\\b`).test(
          metadata.signature ?? "",
        )
      )
        files.add(fileId);
    }
    if (edge.kind !== "INHERITS") continue;
    const src = related.get(edge.src) ?? new Set<string>();
    const dst = related.get(edge.dst) ?? new Set<string>();
    src.add(edge.dst);
    dst.add(edge.src);
    related.set(edge.src, src);
    related.set(edge.dst, dst);
  }
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
