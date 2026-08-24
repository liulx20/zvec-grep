import { CALLABLE_SYMBOL_KINDS_SQL } from "../../symbol-kinds.js";
import type { SemanticCandidateResolution } from "./candidate-repository.js";
import type { SqliteGraphDatabase } from "./database.js";

type TypeRoot = {
  id: string;
  ids: readonly string[];
  fileId: string;
  qualifiedName: string;
  kind: string;
};

type DirectMember = {
  id: string;
  fileId: string;
  qualifiedName: string;
  signature?: string;
  arity?: number;
  kind: string;
};

type InheritanceLink = { id: string; rel: string };

export type DirectCandidateQuery = {
  sourceLanguage?: string;
  typeNames: readonly string[];
  memberName: string;
  callArity?: number;
  visibleFiles: ReadonlySet<string>;
};

/**
 * Invocation-local fast path for an unambiguous method directly owned by a
 * concrete, non-polymorphic receiver type. Anything requiring hierarchy,
 * method-set, or RTA reasoning deliberately falls back to the SQL repository.
 */
export class DirectSemanticCandidateIndex {
  private readonly rootsByName = new Map<string, TypeRoot[]>();
  private readonly membersByOwner = new Map<string, DirectMember[]>();
  private readonly allMembersByOwner = new Map<string, DirectMember[]>();
  private readonly rootsById = new Map<string, TypeRoot>();
  private readonly basesByDerived = new Map<string, InheritanceLink[]>();
  private readonly derivedByBase = new Map<string, InheritanceLink[]>();
  private readonly instantiatedContainers = new Set<string>();
  private readonly resolutionCache = new Map<
    string,
    SemanticCandidateResolution | null
  >();

  constructor(database: SqliteGraphDatabase) {
    for (const row of database.all<{
      id: string;
      name: string;
      qualified_name: string | null;
      file_id: string;
      kind: string;
    }>(
      `SELECT id,name,qualified_name,file_id,kind FROM symbols
       WHERE name IS NOT NULL
         AND kind IN ('class','interface','trait','abstract_class')`,
    )) {
      const roots = this.rootsByName.get(row.name) ?? [];
      const root = {
        id: row.id,
        ids: [row.id],
        fileId: row.file_id,
        qualifiedName: canonicalTypeOwner(row.qualified_name ?? row.name),
        kind: row.kind,
      };
      roots.push(root);
      this.rootsByName.set(row.name, roots);
      this.rootsById.set(row.id, root);
    }

    for (const row of database.all<{
      id: string;
      file_id: string;
      name: string;
      qualified_name: string | null;
      signature: string | null;
      arity: number | null;
      member_kind: string;
      parent_name: string | null;
      parent_qualified_name: string | null;
      parent_kind: string | null;
    }>(
      `SELECT member.id,member.file_id,member.name,member.qualified_name,member.signature,
              member.arity,member.kind AS member_kind,parent.name AS parent_name,
              parent.qualified_name AS parent_qualified_name,
              parent.kind AS parent_kind
       FROM symbols member
       LEFT JOIN contains ownership ON ownership.child_id=member.id
       LEFT JOIN symbols parent ON parent.id=ownership.parent_id
       WHERE member.name IS NOT NULL
         AND member.kind IN (${CALLABLE_SYMBOL_KINDS_SQL})`,
    )) {
      const storedQualifiedName = row.qualified_name ?? row.name;
      const qualifiedOwner = ownerQualifiedName(storedQualifiedName, row.name);
      const owner =
        qualifiedOwner ??
        (isTypeKind(row.parent_kind)
          ? (row.parent_qualified_name ?? row.parent_name ?? undefined)
          : undefined);
      if (!owner) continue;
      const canonicalOwner = canonicalTypeOwner(owner);
      const qualifiedName = `${canonicalOwner}::${row.name}`;
      const key = memberKey(canonicalOwner, row.name);
      const members = this.membersByOwner.get(key) ?? [];
      const member = {
        id: row.id,
        fileId: row.file_id,
        qualifiedName,
        kind: row.member_kind,
        ...(row.signature ? { signature: row.signature } : {}),
        ...(row.arity !== null ? { arity: row.arity } : {}),
      };
      members.push(member);
      this.membersByOwner.set(key, members);
      const ownerMembers = this.allMembersByOwner.get(canonicalOwner) ?? [];
      ownerMembers.push(member);
      this.allMembersByOwner.set(canonicalOwner, ownerMembers);
    }

    for (const row of database.all<{
      src_id: string;
      dst_id: string;
      rel: string;
    }>(
      `SELECT DISTINCT src_id,dst_id,rel FROM edges
       WHERE kind='INHERITS' AND src_is_file=0 AND dst_is_file=0`,
    )) {
      appendLink(this.basesByDerived, row.src_id, {
        id: row.dst_id,
        rel: row.rel,
      });
      appendLink(this.derivedByBase, row.dst_id, {
        id: row.src_id,
        rel: row.rel,
      });
    }
    for (const row of database.all<{ dst_id: string }>(
      `SELECT DISTINCT dst_id FROM edges
       WHERE kind='INSTANTIATES' AND dst_is_file=0`,
    ))
      this.instantiatedContainers.add(row.dst_id);
  }

  resolve(query: DirectCandidateQuery): SemanticCandidateResolution | null {
    const roots = collapseLogicalRoots(
      query.typeNames
        .flatMap((name) => this.rootsByName.get(name) ?? [])
        .filter((root) => query.visibleFiles.has(root.fileId)),
    );
    if (roots.length === 0) return null;
    const key = [
      query.sourceLanguage ?? "",
      roots
        .map((root) => root.id)
        .sort()
        .join("\0"),
      query.memberName,
      query.callArity ?? -1,
    ].join("\x01");
    if (this.resolutionCache.has(key)) return this.resolutionCache.get(key)!;
    const resolved = this.resolveUncached(query, roots);
    this.resolutionCache.set(key, resolved);
    return resolved;
  }

  private resolveUncached(
    query: DirectCandidateQuery,
    roots: readonly TypeRoot[],
  ): SemanticCandidateResolution | null {
    // A qualified name is not guaranteed to encode the language package
    // (notably for Java and several extractor fallbacks). Two visible root
    // rows with the same apparent identity can therefore be unrelated types.
    // Let the complete repository apply import/package/counterpart policy
    // instead of collapsing them into an arbitrary direct hit.
    if (roots.length !== 1) return null;
    if (query.sourceLanguage === "go" && roots[0]!.kind === "interface")
      return this.resolveGoStructural(query, roots[0]!);
    if (roots.some((root) => isAbstractKind(root.kind)))
      return this.resolveNominalHierarchy(query, roots[0]!);
    const owners = [...new Set(roots.map((root) => root.qualifiedName))];
    if (owners.length !== 1) return null;
    if (
      this.hasRelevantDerivedRoot(roots[0]!, query.sourceLanguage) ||
      this.hasRelevantBaseRoot(roots[0]!, query.sourceLanguage)
    )
      return this.resolveNominalHierarchy(query, roots[0]!);

    const allCandidates =
      this.membersByOwner.get(memberKey(owners[0]!, query.memberName)) ?? [];
    const arityCandidates = allCandidates.filter(
      (member) =>
        query.callArity === undefined ||
        member.arity === undefined ||
        member.arity === query.callArity,
    );
    const visibleCandidates = arityCandidates.filter((candidate) =>
      query.visibleFiles.has(candidate.fileId),
    );
    const candidates =
      query.sourceLanguage === "cpp" ? arityCandidates : visibleCandidates;
    // For a single visible nominal root this index has the complete member,
    // inheritance and RTA facts needed by the SQL repository. An empty member
    // set is therefore a resolved negative, not an invitation to repeat the
    // same lookup with a recursive CTE. Go is excluded by nominalPolicy()
    // because structural method sets still require the repository fallback.
    if (candidates.length === 0 && query.sourceLanguage === "go") return null;
    if (candidates.length === 0)
      return {
        candidates: [],
        abstractDispatch: false,
        rtaActive: false,
      };
    const logicalNames = new Set(candidates.map((item) => item.qualifiedName));
    if (logicalNames.size !== 1) return null;

    const selected =
      query.sourceLanguage === "cpp"
        ? (candidates.find((candidate) =>
            isCppOutOfLineDefinition(
              candidate.signature,
              owners[0]!,
              query.memberName,
            ),
          ) ?? candidates[0]!)
        : candidates[0]!;
    return {
      candidates: [selected.id],
      abstractDispatch: false,
      rtaActive: false,
    };
  }

  private resolveNominalHierarchy(
    query: DirectCandidateQuery,
    root: TypeRoot,
  ): SemanticCandidateResolution | null {
    const policy = nominalPolicy(query.sourceLanguage);
    if (!policy) return null;
    const containers = this.walkHierarchy(
      root.ids,
      this.derivedByBase,
      policy.candidateRelations,
    );
    const resolved = containers.flatMap((containerId) => {
      const container = this.rootsById.get(containerId);
      if (!container) return [];
      const providers = this.walkProviders(
        containerId,
        policy.providerRelations,
      );
      const nearest = providers
        .flatMap(({ id, depth }) => {
          const owner = this.rootsById.get(id)?.qualifiedName;
          if (!owner) return [];
          return (
            this.membersByOwner.get(memberKey(owner, query.memberName)) ?? []
          )
            .filter(
              (member) =>
                member.kind !== "abstract_method" &&
                (query.callArity === undefined ||
                  member.arity === undefined ||
                  member.arity === query.callArity),
            )
            .map((member) => ({ member, depth }));
        })
        .sort(
          (left, right) =>
            left.depth - right.depth ||
            left.member.qualifiedName.localeCompare(
              right.member.qualifiedName,
            ) ||
            left.member.id.localeCompare(right.member.id),
        );
      if (nearest.length === 0) return [];
      const depth = nearest[0]!.depth;
      return nearest
        .filter((candidate) => candidate.depth === depth)
        .map(({ member }) => ({ containerId, container, member }));
    });
    const rtaActive = resolved.some(({ containerId }) =>
      this.instantiatedContainers.has(containerId),
    );
    const active = rtaActive
      ? resolved.filter(({ containerId }) =>
          this.instantiatedContainers.has(containerId),
        )
      : resolved;
    const concrete = active.filter(
      ({ container }) => !isAbstractKind(container.kind),
    );
    const candidates = uniqueMembers(
      concrete.map(({ member }) => member),
      query.sourceLanguage,
    );
    return {
      candidates: candidates.map((member) => member.id),
      abstractDispatch: isAbstractKind(root.kind),
      rtaActive,
    };
  }

  /**
   * Resolve a Go interface from its complete structural method set in memory.
   * Go imports expose whole package directories, and interface satisfaction is
   * implicit; repeatedly running the recursive SQL repository for every call
   * dominated graph finalization on real router packages.
   */
  private resolveGoStructural(
    query: DirectCandidateQuery,
    root: TypeRoot,
  ): SemanticCandidateResolution {
    const relations = GO_PROVIDER_RELATIONS;
    const required = root.ids.flatMap((id) => this.goMethodSet(id, relations));
    const candidates: DirectMember[] = [];
    if (required.length > 0) {
      for (const candidateRoot of collapseLogicalRoots(
        this.rootsById.values(),
      )) {
        if (
          isAbstractKind(candidateRoot.kind) ||
          !query.visibleFiles.has(candidateRoot.fileId)
        )
          continue;
        const methods = candidateRoot.ids.flatMap((id) =>
          this.goMethodSet(id, relations),
        );
        if (!required.every((method) => hasCompatibleMethod(methods, method)))
          continue;
        const selected = nearestMember(
          candidateRoot.ids.flatMap((id) => this.walkProviders(id, relations)),
          this.rootsById,
          this.membersByOwner,
          query.memberName,
          query.callArity,
        );
        if (selected) candidates.push(selected);
      }
    }
    return {
      candidates: uniqueMembers(candidates, "go").map((member) => member.id),
      abstractDispatch: true,
      rtaActive: false,
    };
  }

  private goMethodSet(
    rootId: string,
    relations: ReadonlySet<string>,
  ): DirectMember[] {
    return this.walkProviders(rootId, relations).flatMap(({ id }) => {
      const owner = this.rootsById.get(id)?.qualifiedName;
      return owner ? (this.allMembersByOwner.get(owner) ?? []) : [];
    });
  }

  private hasRelevantDerivedRoot(root: TypeRoot, language?: string): boolean {
    const policy = nominalPolicy(language);
    return Boolean(
      policy &&
      root.ids.some((id) =>
        (this.derivedByBase.get(id) ?? []).some((link) =>
          policy.candidateRelations.has(link.rel),
        ),
      ),
    );
  }

  private hasRelevantBaseRoot(root: TypeRoot, language?: string): boolean {
    const policy = nominalPolicy(language);
    return Boolean(
      policy &&
      root.ids.some((id) =>
        (this.basesByDerived.get(id) ?? []).some((link) =>
          policy.providerRelations.has(link.rel),
        ),
      ),
    );
  }

  private walkProviders(
    startId: string,
    relations: ReadonlySet<string>,
  ): Array<{ id: string; depth: number }> {
    const result: Array<{ id: string; depth: number }> = [];
    const visited = new Set<string>();
    const pending = [{ id: startId, depth: 0 }];
    while (pending.length > 0) {
      const current = pending.shift()!;
      if (visited.has(current.id) || current.depth > 32) continue;
      visited.add(current.id);
      result.push(current);
      for (const link of this.basesByDerived.get(current.id) ?? [])
        if (relations.has(link.rel))
          pending.push({ id: link.id, depth: current.depth + 1 });
    }
    return result;
  }

  private walkHierarchy(
    starts: readonly string[],
    adjacency: ReadonlyMap<string, readonly InheritanceLink[]>,
    relations: ReadonlySet<string>,
  ): string[] {
    const visited = new Set<string>();
    const pending = [...starts];
    while (pending.length > 0) {
      const id = pending.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      for (const link of adjacency.get(id) ?? [])
        if (relations.has(link.rel)) pending.push(link.id);
    }
    return [...visited];
  }
}

const GO_PROVIDER_RELATIONS = new Set(["extends", "implements"]);

function collapseLogicalRoots(roots: Iterable<TypeRoot>): TypeRoot[] {
  const groups = new Map<string, TypeRoot>();
  for (const root of roots) {
    const key = `${root.fileId}\0${root.qualifiedName}\0${root.kind}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, root);
      continue;
    }
    groups.set(key, {
      ...existing,
      ids: [...new Set([...existing.ids, ...root.ids])],
    });
  }
  return [...groups.values()];
}

/** Remove balanced generic arguments while preserving namespace ownership. */
function canonicalTypeOwner(value: string): string {
  let depth = 0;
  let result = "";
  for (const char of value) {
    if (char === "<") {
      depth += 1;
      continue;
    }
    if (char === ">" && depth > 0) {
      depth -= 1;
      continue;
    }
    if (depth === 0) result += char;
  }
  return result.replace(/\s+/g, "").replace(/:+$/, "");
}

function hasCompatibleMethod(
  methods: readonly DirectMember[],
  required: DirectMember,
): boolean {
  const name = required.qualifiedName.split("::").at(-1);
  return methods.some((method) => {
    const candidateName = method.qualifiedName.split("::").at(-1);
    return (
      candidateName === name &&
      (required.arity === undefined ||
        method.arity === undefined ||
        required.arity === method.arity)
    );
  });
}

function nearestMember(
  providers: readonly { id: string; depth: number }[],
  rootsById: ReadonlyMap<string, TypeRoot>,
  membersByOwner: ReadonlyMap<string, readonly DirectMember[]>,
  memberName: string,
  callArity: number | undefined,
): DirectMember | undefined {
  return providers
    .flatMap(({ id, depth }) => {
      const owner = rootsById.get(id)?.qualifiedName;
      if (!owner) return [];
      return (membersByOwner.get(memberKey(owner, memberName)) ?? [])
        .filter(
          (member) =>
            callArity === undefined ||
            member.arity === undefined ||
            member.arity === callArity,
        )
        .map((member) => ({ member, depth }));
    })
    .sort(
      (left, right) =>
        left.depth - right.depth ||
        left.member.qualifiedName.localeCompare(right.member.qualifiedName) ||
        left.member.id.localeCompare(right.member.id),
    )[0]?.member;
}

function appendLink(
  map: Map<string, InheritanceLink[]>,
  id: string,
  link: InheritanceLink,
): void {
  const links = map.get(id) ?? [];
  links.push(link);
  map.set(id, links);
}

function nominalPolicy(language?: string): {
  candidateRelations: ReadonlySet<string>;
  providerRelations: ReadonlySet<string>;
} | null {
  if (language === "go") return null;
  if (language === "rust")
    return {
      candidateRelations: new Set(["trait", "implements"]),
      providerRelations: new Set(),
    };
  if (language === "java")
    return {
      candidateRelations: new Set(["extends", "implements"]),
      providerRelations: new Set(["extends"]),
    };
  return {
    candidateRelations: new Set(["extends", "implements", "trait"]),
    providerRelations: new Set(["extends"]),
  };
}

function uniqueMembers(
  members: readonly DirectMember[],
  language?: string,
): DirectMember[] {
  const unique = new Map<string, DirectMember>();
  for (const member of members) {
    const key =
      language === "cpp"
        ? canonicalCppQualifiedName(member.qualifiedName)
        : member.qualifiedName;
    const existing = unique.get(key);
    if (
      !existing ||
      (language === "cpp" &&
        isCppOutOfLineDefinition(
          member.signature,
          ownerQualifiedName(key, key.split("::").at(-1) ?? "") ?? "",
          key.split("::").at(-1) ?? "",
        ))
    )
      unique.set(key, member);
  }
  return [...unique.values()];
}

function canonicalCppQualifiedName(value: string): string {
  const parts = value.split("::");
  return parts
    .filter((part, index) => index === 0 || part !== parts[index - 1])
    .join("::");
}

function isCppOutOfLineDefinition(
  signature: string | undefined,
  owner: string,
  member: string,
): boolean {
  if (!signature) return false;
  const ownerLeaf = owner.split("::").at(-1);
  return (
    ownerLeaf !== undefined && signature.includes(`${ownerLeaf}::${member}`)
  );
}

function memberKey(owner: string, member: string): string {
  return `${owner}\0${member}`;
}

function ownerQualifiedName(
  qualifiedName: string,
  memberName: string,
): string | undefined {
  const suffix = `::${memberName}`;
  return qualifiedName.endsWith(suffix)
    ? qualifiedName.slice(0, -suffix.length)
    : undefined;
}

function isTypeKind(kind: string | null): boolean {
  return ["class", "interface", "trait", "abstract_class"].includes(kind ?? "");
}

function isAbstractKind(kind: string): boolean {
  return ["interface", "trait", "abstract_class"].includes(kind);
}
