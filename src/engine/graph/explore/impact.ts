import type { StoredEntity } from "../../storage/index.js";
import { isLowValuePath, isTestPath } from "../path-policy.js";
import { includeSameFileGenericTypeFragments } from "../symbol-lookup.js";
import type { GraphReader } from "../types.js";
import type {
  ExploreBlastRadius,
  ExploreChangeSurfaceRef,
  ExploreImpactRef,
  ExploreNode,
} from "./types.js";
import { isTypeishKind, symbolName } from "./policy.js";

export function collectBlastRadius(
  graph: GraphReader,
  rootIds: readonly string[],
  limit: number,
): ExploreBlastRadius[] {
  const groups = new Map<string, string[]>();
  for (const rootId of rootIds) {
    const entity = graph.getEntity(rootId);
    const key = entity ? `${entity.file.id}\0${symbolName(entity)}` : rootId;
    const ids = groups.get(key) ?? [];
    ids.push(rootId);
    groups.set(key, ids);
  }
  return [...groups.values()].map((groupRootIds) => {
    const rootId = groupRootIds[0]!;
    const rootEntity = graph.getEntity(rootId);
    const rootKind =
      rootEntity?.entity.metadata?.kind === "code"
        ? rootEntity.entity.metadata.symbolType
        : undefined;
    const typeRoot = isTypeishKind(rootKind ?? "");
    const members = typeRoot
      ? groupRootIds.flatMap((id) => graph.members(id)).slice(0, 64)
      : [];
    const ownedIds = new Set([
      ...groupRootIds,
      ...members.map((member) => member.id),
    ]);
    const ownedFileIds = new Set(
      [...ownedIds]
        .map((id) => graph.getEntity(id)?.file.id)
        .filter((id): id is string => Boolean(id)),
    );
    // Direct callers/constructors are the strongest impact evidence. Put them
    // ahead of passive references and deeper transitive dependents so the
    // bounded per-file representative preserves the executable integration
    // point when a file contains both kinds.
    const directCallers = graph
      .incomingEdges(groupRootIds, ["CALLS", "INSTANTIATES"], limit * 3)
      .map((edge) => ({ id: edge.src }))
      .sort((left, right) => {
        const leftPath = graph.getEntity(left.id)?.file.relativePath ?? "";
        const rightPath = graph.getEntity(right.id)?.file.relativePath ?? "";
        return (
          Number(isLowValuePath(leftPath)) -
            Number(isLowValuePath(rightPath)) ||
          pathDepth(leftPath) - pathDepth(rightPath) ||
          leftPath.localeCompare(rightPath) ||
          left.id.localeCompare(right.id)
        );
      });
    const directCallerSet = new Set(directCallers.map((ref) => ref.id));
    const refs = [
      ...directCallers,
      ...groupRootIds.flatMap((id) => graph.impact(id, 3, limit * 3)),
    ];
    const dependents: ExploreImpactRef[] = [];
    const tests: ExploreImpactRef[] = [];
    const seen = new Set<string>();
    for (const ref of refs) {
      if (seen.has(ref.id)) {
        continue;
      }
      seen.add(ref.id);
      const item = {
        id: ref.id,
        entity: graph.getEntity(ref.id),
        directCall: directCallerSet.has(ref.id) || undefined,
      };
      if (item.entity && ownedFileIds.has(item.entity.file.id)) continue;
      if (item.entity && isTestPath(item.entity.file.relativePath)) {
        if (tests.length < limit) tests.push(item);
      } else if (dependents.length < limit) {
        dependents.push(item);
      }
    }
    return { rootId, dependents, tests };
  });
}

/**
 * Add a tiny, file-diverse integration spine from direct impact evidence.
 * Repeated dependents across independent roots are stronger context than a
 * remote traversal node, but remain bounded so blast radius cannot flood the
 * source bundle.
 */
export function includeBlastRadiusNodes(
  nodes: readonly ExploreNode[],
  blastRadius: readonly ExploreBlastRadius[],
  limit: number,
): { nodes: ExploreNode[]; fileHits: ReadonlyMap<string, number> } {
  if (limit <= 0) return { nodes: [...nodes], fileHits: new Map() };
  const existingIds = new Set(nodes.map((node) => node.id));
  const existingFileIds = new Set(
    nodes
      .map((node) => node.entity?.file.id)
      .filter((id): id is string => typeof id === "string"),
  );
  const byFile = new Map<
    string,
    { roots: Set<string>; refs: ExploreImpactRef[] }
  >();
  for (const radius of blastRadius) {
    const seenForRoot = new Set<string>();
    for (const ref of radius.dependents) {
      const entity = ref.entity;
      if (!entity || isLowValuePath(entity.file.relativePath)) continue;
      const fileId = entity.file.id;
      const entry = byFile.get(fileId) ?? { roots: new Set(), refs: [] };
      if (!seenForRoot.has(fileId)) entry.roots.add(radius.rootId);
      seenForRoot.add(fileId);
      entry.refs.push(ref);
      byFile.set(fileId, entry);
    }
  }
  const result = [...nodes];
  const fileHits = new Map<string, number>();
  // If traversal already selected an integration file through a passive
  // reference, enrich that file with its direct caller at no additional file
  // cost. This preserves the executable entrypoint without increasing the
  // context-pack breadth.
  for (const [fileId, entry] of byFile) {
    if (!existingFileIds.has(fileId)) continue;
    // collectBlastRadius orders direct CALLS/INSTANTIATES before passive and
    // transitive impact refs, so the first novel item is the strongest role.
    const caller = entry.refs.find((ref) => !existingIds.has(ref.id));
    if (!caller?.entity) continue;
    existingIds.add(caller.id);
    fileHits.set(fileId, entry.roots.size);
    result.push({
      id: caller.id,
      kind:
        caller.entity.entity.metadata?.kind === "code"
          ? caller.entity.entity.metadata.symbolType
          : undefined,
      isRoot: false,
      entity: caller.entity,
    });
  }
  const selected = [...byFile]
    .filter(([, entry]) => entry.refs.some((ref) => !existingIds.has(ref.id)))
    .sort(
      (left, right) =>
        Number(
          right[1].refs.some(
            (ref) => ref.directCall && !existingIds.has(ref.id),
          ),
        ) -
          Number(
            left[1].refs.some(
              (ref) => ref.directCall && !existingIds.has(ref.id),
            ),
          ) ||
        right[1].roots.size - left[1].roots.size ||
        novelRefCount(right[1].refs, existingIds) -
          novelRefCount(left[1].refs, existingIds) ||
        uniqueRefCount(right[1].refs) - uniqueRefCount(left[1].refs) ||
        pathDepth(left[1].refs[0]!.entity!.file.relativePath) -
          pathDepth(right[1].refs[0]!.entity!.file.relativePath) ||
        left[1].refs[0]!.entity!.file.relativePath.localeCompare(
          right[1].refs[0]!.entity!.file.relativePath,
        ),
    )
    .slice(0, limit);
  for (const [fileId, entry] of selected) {
    fileHits.set(fileId, entry.roots.size);
    // A file can reach the same root through both a CALLS occurrence and a
    // passive REFS occurrence. Prefer the executable integration point; it is
    // the stronger explanation of how the root is used and avoids spending
    // the single per-file representative on a type annotation/import.
    const representative =
      entry.refs.find((ref) => ref.directCall && !existingIds.has(ref.id)) ??
      entry.refs.find((ref) => !existingIds.has(ref.id));
    if (!representative?.entity) continue;
    existingIds.add(representative.id);
    result.push({
      id: representative.id,
      kind:
        representative.entity.entity.metadata?.kind === "code"
          ? representative.entity.entity.metadata.symbolType
          : undefined,
      isRoot: false,
      entity: representative.entity,
    });
  }
  return { nodes: result, fileHits };
}

function novelRefCount(
  refs: readonly ExploreImpactRef[],
  existingIds: ReadonlySet<string>,
): number {
  return new Set(
    refs.filter((ref) => !existingIds.has(ref.id)).map((ref) => ref.id),
  ).size;
}

function uniqueRefCount(refs: readonly ExploreImpactRef[]): number {
  return new Set(refs.map((ref) => ref.id)).size;
}

function pathDepth(path: string): number {
  return path.replaceAll("\\", "/").split("/").length;
}

export function collectChangeSurface(input: {
  graph: GraphReader;
  rootIds: readonly string[];
  nodes: readonly ExploreNode[];
  nodeScores: ReadonlyMap<string, number>;
  fileScores: Map<string, number>;
  maxFiles: number;
}): ExploreChangeSurfaceRef[] {
  const rootIds = new Set(input.rootIds);
  const callableRoots = input.rootIds.filter((id) => {
    const entity = input.graph.getEntity(id);
    const kind =
      entity?.entity.metadata?.kind === "code"
        ? entity.entity.metadata.symbolType
        : "";
    // Extractors normalize free functions, methods and constructors to function.
    return kind === "function";
  });
  const candidates: Omit<ExploreChangeSurfaceRef, "rescued">[] = [];
  const seen = new Set<string>();
  for (const rootId of callableRoots.slice(0, 5)) {
    const rootPath = input.graph.getEntity(rootId)?.file.relativePath ?? "";
    for (const ref of input.graph.context(rootId).outgoing) {
      if (ref.rel !== "type" && ref.rel !== "return") continue;
      const entity = input.graph.getEntity(ref.id);
      const kind =
        entity?.entity.metadata?.kind === "code"
          ? entity.entity.metadata.symbolType
          : "";
      if (!entity || !isTypeishKind(kind)) continue;
      if (entity.file.relativePath === rootPath) continue;
      if (
        isStubDeclarationPath(entity.file.relativePath) &&
        !isStubDeclarationPath(rootPath)
      )
        continue;
      const key = `${ref.rel}\0${ref.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ rootId, id: ref.id, rel: ref.rel, entity });
    }
  }

  // A type root's useful change surface is usually expressed by its members:
  // field types, method parameters and return types. Traversing only from the
  // container finds callers and subclasses but misses those direct domain
  // collaborators (for example Controller -> Repository / Model). Read the
  // already-resolved type references in one bounded batch instead of issuing a
  // context query per member. These are presentation candidates only; ordinary
  // graph traversal and impact semantics remain unchanged.
  const typeRoots = input.rootIds.filter((id) => {
    const entity = input.graph.getEntity(id);
    const kind =
      entity?.entity.metadata?.kind === "code"
        ? entity.entity.metadata.symbolType
        : "";
    return isTypeishKind(kind);
  });
  const hasConcreteTypeRoot = typeRoots.some((id) => {
    const path = input.graph.getEntity(id)?.file.relativePath ?? "";
    return !isStubDeclarationPath(path);
  });
  const semanticTypeRootGroups = new Map<string, string[]>();
  for (const id of typeRoots) {
    const entity = input.graph.getEntity(id);
    const metadata = entity?.entity.metadata;
    const name = metadata?.kind === "code" ? (metadata.symbolName ?? id) : id;
    const key = `${entity?.file.id ?? ""}\0${eraseTypeArguments(name).toLowerCase()}`;
    const ids = semanticTypeRootGroups.get(key) ?? [];
    ids.push(id);
    semanticTypeRootGroups.set(key, ids);
  }
  for (const rootGroup of [...semanticTypeRootGroups.values()].slice(0, 5)) {
    const rootId = rootGroup[0]!;
    const rootPath = input.graph.getEntity(rootId)?.file.relativePath ?? "";
    const ownerIds = [
      ...rootGroup,
      ...rootGroup.flatMap((id) =>
        input.graph
          .members(id)
          .slice(0, 64)
          .map((member) => member.id),
      ),
    ];
    const directRefs = input.graph.outgoingEdges(ownerIds, ["REFS"], 192);
    const structuralOwnerIds = [
      ...new Set(
        directRefs
          // Only types referenced by the root container itself describe an
          // internal state holder. Method return/parameter types are ordinary
          // API surface and must not recursively promote their dependencies.
          .filter(
            (ref) =>
              rootGroup.includes(ref.src) &&
              (ref.rel === "type" || ref.rel === "return"),
          )
          .map((ref) => ref.dst)
          .filter((id) => {
            const entity = input.graph.getEntity(id);
            const metadata = entity?.entity.metadata;
            return (
              entity?.file.relativePath === rootPath &&
              metadata?.kind === "code" &&
              isTypeishKind(metadata.symbolType ?? "") &&
              !rootIds.has(id)
            );
          }),
      ),
    ].slice(0, 16);
    const structuralRefRows =
      structuralOwnerIds.length > 0
        ? input.graph.outgoingEdges(structuralOwnerIds, ["REFS"], 96)
        : [];
    const refs = [...directRefs, ...structuralRefRows];
    const structuralRefs = new Set(
      structuralRefRows
        .filter((ref) => ref.rel === "type" || ref.rel === "return")
        .map((ref) => ref.dst),
    );
    const grouped = new Map<
      string,
      {
        ref: (typeof refs)[number];
        entity: NonNullable<ReturnType<GraphReader["getEntity"]>>;
        count: number;
        structural: boolean;
      }
    >();
    for (const ref of refs) {
      if (ref.rel !== "type" && ref.rel !== "return") continue;
      // Recursive/self-typed APIs (for example Go's `Router.With() Router`)
      // describe the root itself, not an additional change-surface file. The
      // edge remains in the graph; only suppress the redundant presentation
      // candidate here. This also covers duplicate member occurrences whose
      // resolved target is one of the selected declaration/definition roots.
      if (rootIds.has(ref.dst)) continue;
      const entity = input.graph.getEntity(ref.dst);
      const kind =
        entity?.entity.metadata?.kind === "code"
          ? entity.entity.metadata.symbolType
          : "";
      if (!entity || !isTypeishKind(kind)) continue;
      if (entity.file.relativePath === rootPath) continue;
      if (
        isStubDeclarationPath(entity.file.relativePath) &&
        (hasConcreteTypeRoot || !isStubDeclarationPath(rootPath))
      )
        continue;
      const current = grouped.get(ref.dst);
      if (current) {
        current.count += ref.count;
        current.structural ||= structuralRefs.has(ref.dst);
      } else {
        grouped.set(ref.dst, {
          ref,
          entity,
          count: ref.count,
          structural: structuralRefs.has(ref.dst),
        });
      }
    }
    const ranked = [...grouped.values()].sort(
      (left, right) =>
        Number(isLowValuePath(left.entity.file.relativePath)) -
          Number(isLowValuePath(right.entity.file.relativePath)) ||
        Number(isErrorLikeType(left.entity)) -
          Number(isErrorLikeType(right.entity)) ||
        Number(right.structural) - Number(left.structural) ||
        pathDistance(rootPath, left.entity.file.relativePath) -
          pathDistance(rootPath, right.entity.file.relativePath) ||
        right.count - left.count ||
        left.ref.dst.localeCompare(right.ref.dst),
    );
    let addedForRoot = 0;
    for (const { ref, entity } of ranked) {
      const key = `${ref.rel === "return" ? "return" : "type"}\0${ref.dst}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        rootId,
        id: ref.dst,
        rel: ref.rel === "return" ? "return" : "type",
        entity,
        structural: structuralRefs.has(ref.dst),
      });
      addedForRoot += 1;
      if (addedForRoot >= 6) break;
    }
  }

  const rankedFileIds = [...input.fileScores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, input.maxFiles)
    .map(([id]) => id);
  const visibleFiles = new Set(rankedFileIds);
  const maxFileScore = Math.max(...input.fileScores.values(), 0);
  const maxNodeScore = Math.max(...input.nodeScores.values(), 0);
  const result = candidates.map((candidate) => {
    const fileId = candidate.entity.file.id;
    const fileScore = input.fileScores.get(fileId) ?? 0;
    const nodeScore = input.nodeScores.get(candidate.id) ?? 0;
    const weakGraph =
      !visibleFiles.has(fileId) ||
      (fileScore < maxFileScore * 0.06 && nodeScore < maxNodeScore * 0.06);
    // File assembly applies a 5% marginal-score floor. Keep the change-surface
    // decision aligned with that actual visibility rule: a single high-scored
    // type node must not make its otherwise sub-threshold file look visible.
    const belowAssemblyFloor =
      maxFileScore > 0 && fileScore < maxFileScore * 0.05;
    // Lexical overlap must not veto a graph rescue. Camel-case decomposition
    // makes OwnerController and Owner share a token, but that does not make the
    // Owner file visible or replace its source. The bounded type/return edge is
    // the authoritative evidence here.
    const rescued = weakGraph || belowAssemblyFloor;
    if (rescued && !input.fileScores.has(fileId)) {
      input.fileScores.set(fileId, 0);
    }
    return { ...candidate, rescued };
  });
  return result;
}

function isErrorLikeType(entity: StoredEntity): boolean {
  const metadata = entity.entity.metadata;
  if (metadata?.kind !== "code") return false;
  return /(?:error|exception|throwable)$/i.test(metadata.symbolName ?? "");
}

function eraseTypeArguments(value: string): string {
  let depth = 0;
  let output = "";
  for (const character of value) {
    if (character === "<") depth += 1;
    else if (character === ">") depth = Math.max(0, depth - 1);
    else if (depth === 0) output += character;
  }
  return output;
}

function isStubDeclarationPath(path: string): boolean {
  return /(?:\.d\.ts|\.pyi)$/i.test(path);
}

function pathDistance(left: string, right: string): number {
  const leftParts = left.replaceAll("\\", "/").split("/").slice(0, -1);
  const rightParts = right.replaceAll("\\", "/").split("/").slice(0, -1);
  let shared = 0;
  while (
    shared < leftParts.length &&
    shared < rightParts.length &&
    leftParts[shared] === rightParts[shared]
  )
    shared += 1;
  return leftParts.length + rightParts.length - shared * 2;
}

export function includeChangeSurfaceNodes(
  nodes: readonly ExploreNode[],
  changeSurface: readonly ExploreChangeSurfaceRef[],
  graph: GraphReader,
): ExploreNode[] {
  const out = [...nodes];
  const seen = new Set(nodes.map((node) => node.id));
  let additions = 0;
  const addEntity = (
    entity: NonNullable<ReturnType<GraphReader["getEntity"]>>,
  ): void => {
    if (seen.has(entity.entity.id) || additions >= 64) return;
    seen.add(entity.entity.id);
    additions += 1;
    out.push({
      id: entity.entity.id,
      kind:
        entity.entity.metadata?.kind === "code"
          ? entity.entity.metadata.symbolType
          : undefined,
      isRoot: false,
      entity,
    });
  };
  for (const item of changeSurface) {
    if (!item.rescued) continue;
    const metadata = item.entity.entity.metadata;
    const name = metadata?.kind === "code" ? (metadata.symbolName ?? "") : "";
    const family =
      name && graph.findSymbolsByQuery
        ? includeSameFileGenericTypeFragments(
            [item.entity],
            graph.findSymbolsByQuery(name, 128),
            name,
          )
        : [item.entity];
    for (const entity of family) {
      addEntity(entity);
      for (const member of graph.members(entity.entity.id).slice(0, 24)) {
        const memberEntity = graph.getEntity(member.id);
        if (memberEntity) addEntity(memberEntity);
      }
    }
  }
  return out;
}

export function fileIdsForRoots(
  nodes: readonly ExploreNode[],
  rootIds: readonly string[],
): Set<string> {
  const roots = new Set(rootIds);
  return new Set(
    nodes
      .filter((node) => roots.has(node.id))
      .map((node) => node.entity?.file.id)
      .filter((id): id is string => Boolean(id)),
  );
}
