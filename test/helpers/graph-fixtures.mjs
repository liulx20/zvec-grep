export function graphNode(id) {
  return {
    id,
    kind: "function",
    name: id,
    qualifiedName: id,
    language: "typescript",
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 1,
    signature: null,
    doc: null,
    arity: null,
    visibility: null,
    isExported: true,
  };
}

export function localGraph(edges = [], pendingRefs = [], fileId) {
  const ids = new Set([
    ...edges.flatMap((edge) => [edge.source, edge.target]),
    ...pendingRefs.map((ref) => ref.ownerId),
  ]);
  ids.delete(fileId);
  return { nodes: [...ids].map(graphNode), edges, pendingRefs };
}
